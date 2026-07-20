import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  backtestFeeObservations,
  backtestMetrics,
  RISK_BUDGET_TOLERANCE_RATIO,
} from './backtest-metrics.mjs';
import { reconcileSignalBacktest } from './backtest-reconciliation.mjs';
import { firstStrategySummary, readBacktestPayload } from './backtest-result.mjs';
import { verifyExecutionRuntimeArchive } from './execution-runtime-evidence.mjs';
import { verifyHistoricalRiskTrace } from './historical-risk.mjs';
import { marketDatasetHash, marketTimeframeMilliseconds, verifyMarketDataset } from './market-dataset.mjs';
import { verifySignalArtifact } from './signal-artifact.mjs';
import { assertOkxForwardSource } from './forward-target.mjs';

export const WALK_FORWARD_PLAN_SCHEMA_VERSION = 'helix.walk-forward-plan/v1';
export const WALK_FORWARD_RUN_SCHEMA_VERSION = 'helix.walk-forward-run/v1';
export const WALK_FORWARD_REPORT_SCHEMA_VERSION = 'helix.walk-forward-report/v3';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const TIMEFRAME_PATTERN = /^(\d+)([mhdw])$/;
const TIMEFRAME_UNITS_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const LIFECYCLES = new Set(['proposal', 'backtested', 'shadow', 'canary', 'production', 'deprecated']);
const OBJECT_MODELS = new Set(['PRICE_EVENT', 'TRADE_THESIS']);
const STRATEGY_SEGMENT_DIMENSIONS = {
  helix_scalp_hunter: new Set(['scalp.event_type', 'scalp.grade', 'scalp.regime.type']),
  helix_swing_hunter: new Set(['swing.stage', 'swing.context.state', 'swing.context.bias']),
};

function exactRecord(value, name, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${fields.join(', ')}`);
  }
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function hash(value, name) {
  const normalized = text(value, name);
  if (!HASH_PATTERN.test(normalized)) throw new Error(`${name} must be a SHA-256 hash`);
  return normalized;
}

function commit(value, name) {
  const normalized = text(value, name);
  if (!COMMIT_PATTERN.test(normalized)) throw new Error(`${name} must be a full Git commit`);
  return normalized;
}

function timeframeMilliseconds(value, name) {
  const timeframe = text(value, name);
  const match = TIMEFRAME_PATTERN.exec(timeframe);
  if (!match || Number(match[1]) < 1) throw new Error(`${name} is invalid`);
  const duration = Number(match[1]) * TIMEFRAME_UNITS_MS[match[2]];
  if (!Number.isSafeInteger(duration)) throw new Error(`${name} is too large`);
  return { timeframe, duration };
}

function source(value, name) {
  const record = exactRecord(value, name, ['provider', 'market', 'instrumentId', 'symbol']);
  return {
    provider: text(record.provider, `${name}.provider`),
    market: text(record.market, `${name}.market`),
    instrumentId: text(record.instrumentId, `${name}.instrumentId`),
    symbol: text(record.symbol, `${name}.symbol`),
  };
}

export function canonicalWalkForwardJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('walk-forward canonical numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalWalkForwardJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalWalkForwardJson(value[key])}`
    )).join(',')}}`;
  }
  throw new Error(`unsupported walk-forward value ${typeof value}`);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(canonicalWalkForwardJson(value)).digest('hex')}`;
}

export function walkForwardEvidenceHash(value) {
  return sha256(value);
}

export function walkForwardPlanHash(payload) {
  return sha256(payload);
}

export function walkForwardRunHash(payload) {
  return sha256(payload);
}

export function walkForwardReportHash(payload) {
  return sha256(payload);
}

function normalizeCandidate(value) {
  const candidate = exactRecord(value, 'candidate', [
    'strategyId', 'strategyVersion', 'strategyRepoCommit', 'strategyConfigHash',
    'engineCommit', 'lifecycle', 'objectModel',
  ]);
  const lifecycle = text(candidate.lifecycle, 'candidate.lifecycle');
  const objectModel = text(candidate.objectModel, 'candidate.objectModel');
  if (!LIFECYCLES.has(lifecycle)) throw new Error('candidate.lifecycle is invalid');
  if (!OBJECT_MODELS.has(objectModel)) throw new Error('candidate.objectModel is invalid');
  return {
    strategyId: text(candidate.strategyId, 'candidate.strategyId'),
    strategyVersion: text(candidate.strategyVersion, 'candidate.strategyVersion'),
    strategyRepoCommit: commit(candidate.strategyRepoCommit, 'candidate.strategyRepoCommit'),
    strategyConfigHash: hash(candidate.strategyConfigHash, 'candidate.strategyConfigHash'),
    engineCommit: commit(candidate.engineCommit, 'candidate.engineCommit'),
    lifecycle,
    objectModel,
  };
}

function normalizeSourceDataset(value) {
  const dataset = exactRecord(value, 'sourceDataset', ['datasetHash', 'source', 'capturedThrough']);
  return {
    datasetHash: hash(dataset.datasetHash, 'sourceDataset.datasetHash'),
    source: source(dataset.source, 'sourceDataset.source'),
    capturedThrough: integer(dataset.capturedThrough, 'sourceDataset.capturedThrough'),
  };
}

function normalizeScenarios(value) {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error('executionScenarios must contain at least base and stressed fee scenarios');
  }
  const ids = new Set();
  const scenarios = value.map((item, index) => {
    const scenario = exactRecord(item, `executionScenarios[${index}]`, ['id', 'fee']);
    const id = text(scenario.id, `executionScenarios[${index}].id`);
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) throw new Error(`executionScenarios[${index}].id is invalid`);
    if (ids.has(id)) throw new Error(`duplicate execution scenario ${id}`);
    ids.add(id);
    const fee = finite(scenario.fee, `executionScenarios[${index}].fee`);
    if (fee < 0) throw new Error(`executionScenarios[${index}].fee must be non-negative`);
    return { id, fee };
  });
  const fees = scenarios.map(({ fee }) => fee);
  if (Math.max(...fees) <= Math.min(...fees)) {
    throw new Error('executionScenarios must include a higher stressed fee');
  }
  return scenarios;
}

function policyInteger(value, name, minimum) {
  const normalized = integer(value, name);
  if (normalized < minimum) throw new Error(`${name} must be at least ${minimum}`);
  return normalized;
}

function policyNumber(value, name, minimum, maximum) {
  const normalized = finite(value, name);
  if (minimum !== undefined && normalized < minimum) throw new Error(`${name} must be at least ${minimum}`);
  if (maximum !== undefined && normalized > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return normalized;
}

function normalizeWalkForwardPolicy(value) {
  const policy = exactRecord(value, 'walkForwardPolicy', [
    'schemaVersion', 'id', 'version', 'strategyId', 'strategyVersion', 'policyPath', 'policyHash', 'plan', 'gates',
  ]);
  const schemaVersion = text(policy.schemaVersion, 'walkForwardPolicy.schemaVersion');
  if (schemaVersion !== 'helix.walk-forward-policy/v1'
    && schemaVersion !== 'helix.walk-forward-policy/v2') {
    throw new Error('walkForwardPolicy.schemaVersion is unsupported');
  }
  const hasSymbolStability = schemaVersion === 'helix.walk-forward-policy/v2';
  const id = text(policy.id, 'walkForwardPolicy.id');
  const version = text(policy.version, 'walkForwardPolicy.version');
  if (!/^[a-z][a-z0-9_]*_v[0-9]+$/.test(id)) throw new Error('walkForwardPolicy.id is invalid');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('walkForwardPolicy.version is invalid');
  }
  const policyPath = text(policy.policyPath, 'walkForwardPolicy.policyPath');
  if (!/^strategies\/[^/]+\/validation\/[a-z][a-z0-9-]*\.yaml$/.test(policyPath)) {
    throw new Error('walkForwardPolicy.policyPath is invalid');
  }
  const plan = exactRecord(policy.plan, 'walkForwardPolicy.plan', [
    'foldCount', 'entryWindowMs', 'observationTailMs', 'riskUnitRatio', 'referenceAccountEquity',
    'executionScenarios',
  ]);
  const executionScenarios = normalizeScenarios(plan.executionScenarios);
  const gates = exactRecord(policy.gates, 'walkForwardPolicy.gates', [
    'censoredEntries', 'minimumTotalTrades', 'minimumActiveFoldRatio', 'minimumPositiveFoldRatio',
    'minimumExpectancyR', 'minimumProfitFactor', 'maximumDrawdownR', 'segmentStability',
    ...(hasSymbolStability ? ['symbolStability'] : []),
  ]);
  if (gates.censoredEntries !== 'reject') throw new Error('walkForwardPolicy.gates.censoredEntries must be reject');
  const segment = exactRecord(gates.segmentStability, 'walkForwardPolicy.gates.segmentStability', [
    'dimensions', 'minimumTradesPerSegment', 'minimumStableSegmentRatio',
  ]);
  if (!Array.isArray(segment.dimensions) || !segment.dimensions.length) {
    throw new Error('walkForwardPolicy.gates.segmentStability.dimensions must be non-empty');
  }
  const dimensions = segment.dimensions.map((dimension, index) => {
    const normalized = text(dimension, `walkForwardPolicy.gates.segmentStability.dimensions[${index}]`);
    const strategyId = text(policy.strategyId, 'walkForwardPolicy.strategyId');
    if (!STRATEGY_SEGMENT_DIMENSIONS[strategyId]?.has(normalized)) {
      throw new Error(`walkForwardPolicy.gates.segmentStability.dimensions[${index}] is invalid`);
    }
    return normalized;
  });
  if (new Set(dimensions).size !== dimensions.length) {
    throw new Error('walkForwardPolicy.gates.segmentStability.dimensions contains duplicates');
  }
  let symbolStability;
  if (hasSymbolStability) {
    const symbolGate = exactRecord(
      gates.symbolStability,
      'walkForwardPolicy.gates.symbolStability',
      ['members', 'minimumStableSymbolRatio'],
    );
    if (!Array.isArray(symbolGate.members) || symbolGate.members.length < 2) {
      throw new Error('walkForwardPolicy.gates.symbolStability.members must contain at least two symbols');
    }
    const members = symbolGate.members.map((member, index) => (
      source(member, `walkForwardPolicy.gates.symbolStability.members[${index}]`)
    ));
    if (new Set(members.map(({ symbol }) => symbol)).size !== members.length) {
      throw new Error('walkForwardPolicy.gates.symbolStability.members contains duplicate symbols');
    }
    if (new Set(members.map(({ instrumentId }) => instrumentId)).size !== members.length) {
      throw new Error('walkForwardPolicy.gates.symbolStability.members contains duplicate instrument ids');
    }
    const ordered = [...members].sort((left, right) => (
      left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1
        : left.instrumentId < right.instrumentId ? -1 : left.instrumentId > right.instrumentId ? 1 : 0
    ));
    if (!isDeepStrictEqual(members, ordered)) {
      throw new Error('walkForwardPolicy.gates.symbolStability.members must be ordered by symbol and instrumentId');
    }
    symbolStability = {
      members,
      minimumStableSymbolRatio: policyNumber(
        symbolGate.minimumStableSymbolRatio,
        'walkForwardPolicy.gates.symbolStability.minimumStableSymbolRatio',
        0,
        1,
      ),
    };
  }
  return {
    schemaVersion,
    id,
    version,
    strategyId: text(policy.strategyId, 'walkForwardPolicy.strategyId'),
    strategyVersion: text(policy.strategyVersion, 'walkForwardPolicy.strategyVersion'),
    policyPath,
    policyHash: hash(policy.policyHash, 'walkForwardPolicy.policyHash'),
    plan: {
      foldCount: policyInteger(plan.foldCount, 'walkForwardPolicy.plan.foldCount', 2),
      entryWindowMs: policyInteger(plan.entryWindowMs, 'walkForwardPolicy.plan.entryWindowMs', 1),
      observationTailMs: policyInteger(plan.observationTailMs, 'walkForwardPolicy.plan.observationTailMs', 1),
      riskUnitRatio: policyNumber(plan.riskUnitRatio, 'walkForwardPolicy.plan.riskUnitRatio', Number.MIN_VALUE, 1),
      referenceAccountEquity: policyNumber(
        plan.referenceAccountEquity,
        'walkForwardPolicy.plan.referenceAccountEquity',
        Number.MIN_VALUE,
      ),
      executionScenarios,
    },
    gates: {
      censoredEntries: 'reject',
      minimumTotalTrades: policyInteger(gates.minimumTotalTrades, 'walkForwardPolicy.gates.minimumTotalTrades', 1),
      minimumActiveFoldRatio: policyNumber(
        gates.minimumActiveFoldRatio,
        'walkForwardPolicy.gates.minimumActiveFoldRatio',
        0,
        1,
      ),
      minimumPositiveFoldRatio: policyNumber(
        gates.minimumPositiveFoldRatio,
        'walkForwardPolicy.gates.minimumPositiveFoldRatio',
        0,
        1,
      ),
      minimumExpectancyR: policyNumber(gates.minimumExpectancyR, 'walkForwardPolicy.gates.minimumExpectancyR'),
      minimumProfitFactor: policyNumber(
        gates.minimumProfitFactor,
        'walkForwardPolicy.gates.minimumProfitFactor',
        0,
      ),
      maximumDrawdownR: policyNumber(
        gates.maximumDrawdownR,
        'walkForwardPolicy.gates.maximumDrawdownR',
        0,
      ),
      segmentStability: {
        dimensions,
        minimumTradesPerSegment: policyInteger(
          segment.minimumTradesPerSegment,
          'walkForwardPolicy.gates.segmentStability.minimumTradesPerSegment',
          1,
        ),
        minimumStableSegmentRatio: policyNumber(
          segment.minimumStableSegmentRatio,
          'walkForwardPolicy.gates.segmentStability.minimumStableSegmentRatio',
          0,
          1,
        ),
      },
      ...(symbolStability ? { symbolStability } : {}),
    },
  };
}

function assertPlanMatchesPolicy(policy, candidate, folds, executionScenarios) {
  if (policy.strategyId !== candidate.strategyId || policy.strategyVersion !== candidate.strategyVersion) {
    throw new Error('walkForwardPolicy strategy identity does not match candidate');
  }
  if (folds.length !== policy.plan.foldCount) {
    throw new Error('walk-forward fold count does not match walkForwardPolicy');
  }
  for (const [index, fold] of folds.entries()) {
    if (fold.entryWindowEndTime - fold.entryWindowStartTime !== policy.plan.entryWindowMs) {
      throw new Error(`folds[${index}] entry window does not match walkForwardPolicy`);
    }
    if (fold.observationEndTime - fold.entryWindowEndTime !== policy.plan.observationTailMs) {
      throw new Error(`folds[${index}] observation tail does not match walkForwardPolicy`);
    }
  }
  if (!isDeepStrictEqual(executionScenarios, policy.plan.executionScenarios)) {
    throw new Error('executionScenarios do not match walkForwardPolicy');
  }
}

function normalizePlanPayload(value) {
  const hasPolicy = Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'walkForwardPolicy'));
  const plan = exactRecord(value, 'walk-forward plan payload', [
    'schemaVersion', 'mode', 'candidate', 'sourceDataset', 'baseTimeframe',
    'requiredTimeframes', 'activationDecisionTime', 'warmupDurationMs', 'folds',
    'executionScenarios', ...(hasPolicy ? ['walkForwardPolicy'] : []),
  ]);
  if (plan.schemaVersion !== WALK_FORWARD_PLAN_SCHEMA_VERSION) {
    throw new Error(`unsupported walk-forward plan schema ${String(plan.schemaVersion)}`);
  }
  if (plan.mode !== 'fixed_candidate') throw new Error('walk-forward plan mode must be fixed_candidate');
  const { timeframe: baseTimeframe, duration } = timeframeMilliseconds(plan.baseTimeframe, 'baseTimeframe');
  if (!Array.isArray(plan.requiredTimeframes) || !plan.requiredTimeframes.length) {
    throw new Error('requiredTimeframes must be a non-empty array');
  }
  const requiredTimeframes = plan.requiredTimeframes.map((item, index) => (
    timeframeMilliseconds(item, `requiredTimeframes[${index}]`).timeframe
  ));
  if (new Set(requiredTimeframes).size !== requiredTimeframes.length) {
    throw new Error('requiredTimeframes must not contain duplicates');
  }
  if (!requiredTimeframes.includes(baseTimeframe)) throw new Error('requiredTimeframes must include baseTimeframe');
  const activationDecisionTime = integer(plan.activationDecisionTime, 'activationDecisionTime');
  const warmupDurationMs = integer(plan.warmupDurationMs, 'warmupDurationMs');
  if (activationDecisionTime % duration) throw new Error('activationDecisionTime must align to baseTimeframe');
  if (activationDecisionTime < duration) {
    throw new Error('activationDecisionTime must follow at least one base candle');
  }
  if (warmupDurationMs > activationDecisionTime) {
    throw new Error('source dataset does not have enough time before activationDecisionTime for warm-up');
  }
  if (!Array.isArray(plan.folds) || !plan.folds.length) throw new Error('folds must be a non-empty array');
  let previousEnd = null;
  let previousObservationEnd = null;
  const folds = plan.folds.map((item, index) => {
    const fold = exactRecord(item, `folds[${index}]`, [
      'sequence', 'entryWindowStartTime', 'entryWindowEndTime', 'observationEndTime',
    ]);
    const sequence = integer(fold.sequence, `folds[${index}].sequence`);
    const entryWindowStartTime = integer(fold.entryWindowStartTime, `folds[${index}].entryWindowStartTime`);
    const entryWindowEndTime = integer(fold.entryWindowEndTime, `folds[${index}].entryWindowEndTime`);
    const observationEndTime = integer(fold.observationEndTime, `folds[${index}].observationEndTime`);
    if (sequence !== index) throw new Error(`folds[${index}].sequence must equal ${index}`);
    if ([entryWindowStartTime, entryWindowEndTime, observationEndTime].some((time) => time % duration)) {
      throw new Error(`folds[${index}] boundaries must align to baseTimeframe`);
    }
    if (entryWindowEndTime <= entryWindowStartTime) throw new Error(`folds[${index}] entry window is empty`);
    if (entryWindowStartTime < activationDecisionTime) {
      throw new Error(`folds[${index}] starts before activationDecisionTime`);
    }
    if (previousEnd !== null && entryWindowStartTime !== previousEnd) {
      throw new Error(`folds[${index}] entry window is not contiguous`);
    }
    if (previousObservationEnd !== null && observationEndTime < previousObservationEnd) {
      throw new Error(`folds[${index}].observationEndTime must not move backward`);
    }
    if (observationEndTime < entryWindowEndTime) {
      throw new Error(`folds[${index}].observationEndTime must cover its entry window`);
    }
    previousEnd = entryWindowEndTime;
    previousObservationEnd = observationEndTime;
    return { sequence, entryWindowStartTime, entryWindowEndTime, observationEndTime };
  });
  const sourceDataset = normalizeSourceDataset(plan.sourceDataset);
  if (folds.some((fold) => fold.observationEndTime > sourceDataset.capturedThrough)) {
    throw new Error('fold observation exceeds sourceDataset.capturedThrough');
  }
  const candidate = normalizeCandidate(plan.candidate);
  const executionScenarios = normalizeScenarios(plan.executionScenarios);
  const walkForwardPolicy = hasPolicy ? normalizeWalkForwardPolicy(plan.walkForwardPolicy) : undefined;
  if (walkForwardPolicy) assertPlanMatchesPolicy(walkForwardPolicy, candidate, folds, executionScenarios);
  return {
    schemaVersion: WALK_FORWARD_PLAN_SCHEMA_VERSION,
    mode: 'fixed_candidate',
    candidate,
    ...(walkForwardPolicy ? { walkForwardPolicy } : {}),
    sourceDataset,
    baseTimeframe,
    requiredTimeframes,
    activationDecisionTime,
    warmupDurationMs,
    folds,
    executionScenarios,
  };
}

export function verifyWalkForwardPlan(value) {
  const hasPolicy = Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'walkForwardPolicy'));
  const plan = exactRecord(value, 'walk-forward plan', [
    'schemaVersion', 'mode', 'candidate', 'sourceDataset', 'baseTimeframe',
    'requiredTimeframes', 'activationDecisionTime', 'warmupDurationMs', 'folds',
    'executionScenarios', 'planHash', ...(hasPolicy ? ['walkForwardPolicy'] : []),
  ]);
  const planHash = hash(plan.planHash, 'planHash');
  const payload = normalizePlanPayload(Object.fromEntries(
    Object.entries(plan).filter(([field]) => field !== 'planHash'),
  ));
  const expectedHash = walkForwardPlanHash(payload);
  if (planHash !== expectedHash) throw new Error(`walk-forward plan hash mismatch: expected ${expectedHash}`);
  return { ...payload, planHash };
}

function fileName(value, name) {
  const normalized = text(value, name);
  if (normalized.includes('/') || normalized.includes('\\') || normalized === '.' || normalized === '..') {
    throw new Error(`${name} must be a file name without a directory`);
  }
  return normalized;
}

function jsonRecord(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  canonicalWalkForwardJson(value);
  return value;
}

function normalizeCensoredEntry(value, name) {
  const entry = exactRecord(value, name, [
    'tradeId', 'entrySignalId', 'decisionId', 'object', 'side',
    'sourceCandleOpenTime', 'decisionTime', 'reason',
  ]);
  const object = exactRecord(entry.object, `${name}.object`, ['model', 'id']);
  const model = text(object.model, `${name}.object.model`);
  const side = text(entry.side, `${name}.side`);
  if (!OBJECT_MODELS.has(model)) throw new Error(`${name}.object.model is invalid`);
  if (!['LONG', 'SHORT'].includes(side)) throw new Error(`${name}.side is invalid`);
  if (!['NO_EXIT_BY_OBSERVATION_END', 'EXIT_AT_OBSERVATION_END'].includes(entry.reason)) {
    throw new Error(`${name}.reason is invalid`);
  }
  const tradeId = text(entry.tradeId, `${name}.tradeId`);
  const entrySignalId = text(entry.entrySignalId, `${name}.entrySignalId`);
  if (tradeId !== entrySignalId) throw new Error(`${name}.tradeId must equal entrySignalId`);
  return {
    tradeId,
    entrySignalId,
    decisionId: text(entry.decisionId, `${name}.decisionId`),
    object: { model, id: text(object.id, `${name}.object.id`) },
    side,
    sourceCandleOpenTime: integer(entry.sourceCandleOpenTime, `${name}.sourceCandleOpenTime`),
    decisionTime: integer(entry.decisionTime, `${name}.decisionTime`),
    reason: entry.reason,
  };
}

function normalizeRunFold(value, index) {
  const name = `folds[${index}]`;
  const fold = exactRecord(value, name, [
    'sequence', 'entryWindowStartTime', 'entryWindowEndTime', 'observationEndTime',
    'datasetFile', 'datasetHash', 'decisionArtifactFile', 'decisionArtifactHash',
    'decisionRiskTraceFile', 'decisionRiskTraceHash', 'replayArtifactFile',
    'replayArtifactHash', 'executionArtifactFile', 'executionArtifactHash',
    'executionRiskTraceFile', 'executionRiskTraceHash', 'tradeIds', 'censoredEntries',
    'statistics',
  ]);
  const sequence = integer(fold.sequence, `${name}.sequence`);
  if (sequence !== index) throw new Error(`${name}.sequence must equal ${index}`);
  const entryWindowStartTime = integer(fold.entryWindowStartTime, `${name}.entryWindowStartTime`);
  const entryWindowEndTime = integer(fold.entryWindowEndTime, `${name}.entryWindowEndTime`);
  const observationEndTime = integer(fold.observationEndTime, `${name}.observationEndTime`);
  if (entryWindowEndTime <= entryWindowStartTime) throw new Error(`${name} entry window must be non-empty`);
  if (observationEndTime < entryWindowEndTime) throw new Error(`${name}.observationEndTime is too early`);
  if (!Array.isArray(fold.tradeIds)) throw new Error(`${name}.tradeIds must be an array`);
  const tradeIds = fold.tradeIds.map((item, tradeIndex) => text(item, `${name}.tradeIds[${tradeIndex}]`));
  if (new Set(tradeIds).size !== tradeIds.length) throw new Error(`${name}.tradeIds must not contain duplicates`);
  if (!Array.isArray(fold.censoredEntries)) throw new Error(`${name}.censoredEntries must be an array`);
  const censoredEntries = fold.censoredEntries.map((item, entryIndex) => (
    normalizeCensoredEntry(item, `${name}.censoredEntries[${entryIndex}]`)
  ));
  const censoredIds = censoredEntries.map(({ tradeId }) => tradeId);
  if (new Set(censoredIds).size !== censoredIds.length) {
    throw new Error(`${name}.censoredEntries must not contain duplicate trade ids`);
  }
  if (censoredIds.some((tradeId) => tradeIds.includes(tradeId))) {
    throw new Error(`${name} cannot mark a completed trade as censored`);
  }
  const statisticsSource = exactRecord(fold.statistics, `${name}.statistics`, [
    'decisionSignals', 'entriesInWindow', 'completedTrades', 'censoredEntries', 'evaluator',
  ]);
  const statistics = {
    decisionSignals: integer(statisticsSource.decisionSignals, `${name}.statistics.decisionSignals`),
    entriesInWindow: integer(statisticsSource.entriesInWindow, `${name}.statistics.entriesInWindow`),
    completedTrades: integer(statisticsSource.completedTrades, `${name}.statistics.completedTrades`),
    censoredEntries: integer(statisticsSource.censoredEntries, `${name}.statistics.censoredEntries`),
    evaluator: jsonRecord(statisticsSource.evaluator, `${name}.statistics.evaluator`),
  };
  if (statistics.completedTrades !== tradeIds.length
    || statistics.censoredEntries !== censoredEntries.length
    || statistics.entriesInWindow !== tradeIds.length + censoredEntries.length) {
    throw new Error(`${name}.statistics does not match its execution cohort`);
  }
  const decisionArtifactHash = hash(fold.decisionArtifactHash, `${name}.decisionArtifactHash`);
  const replayArtifactHash = hash(fold.replayArtifactHash, `${name}.replayArtifactHash`);
  if (decisionArtifactHash !== replayArtifactHash) {
    throw new Error(`${name} decision and replay artifact hashes must match`);
  }
  const prefix = `fold-${String(sequence).padStart(3, '0')}`;
  const normalized = {
    sequence,
    entryWindowStartTime,
    entryWindowEndTime,
    observationEndTime,
    datasetFile: fileName(fold.datasetFile, `${name}.datasetFile`),
    datasetHash: hash(fold.datasetHash, `${name}.datasetHash`),
    decisionArtifactFile: fileName(fold.decisionArtifactFile, `${name}.decisionArtifactFile`),
    decisionArtifactHash,
    decisionRiskTraceFile: fileName(fold.decisionRiskTraceFile, `${name}.decisionRiskTraceFile`),
    decisionRiskTraceHash: hash(fold.decisionRiskTraceHash, `${name}.decisionRiskTraceHash`),
    replayArtifactFile: fileName(fold.replayArtifactFile, `${name}.replayArtifactFile`),
    replayArtifactHash,
    executionArtifactFile: fileName(fold.executionArtifactFile, `${name}.executionArtifactFile`),
    executionArtifactHash: hash(fold.executionArtifactHash, `${name}.executionArtifactHash`),
    executionRiskTraceFile: fileName(fold.executionRiskTraceFile, `${name}.executionRiskTraceFile`),
    executionRiskTraceHash: hash(fold.executionRiskTraceHash, `${name}.executionRiskTraceHash`),
    tradeIds,
    censoredEntries,
    statistics,
  };
  const expectedFiles = {
    datasetFile: `${prefix}-dataset.json`,
    decisionArtifactFile: `${prefix}-decision-artifact.json`,
    decisionRiskTraceFile: `${prefix}-decision-risk-trace.json`,
    replayArtifactFile: `${prefix}-replay-artifact.json`,
    executionArtifactFile: `${prefix}-execution-artifact.json`,
    executionRiskTraceFile: `${prefix}-execution-risk-trace.json`,
  };
  for (const [field, expected] of Object.entries(expectedFiles)) {
    if (normalized[field] !== expected) throw new Error(`${name}.${field} must equal ${expected}`);
  }
  return normalized;
}

function normalizeRunPayload(value) {
  const run = exactRecord(value, 'walk-forward run payload', ['schemaVersion', 'planFile', 'planHash', 'folds']);
  if (run.schemaVersion !== WALK_FORWARD_RUN_SCHEMA_VERSION) {
    throw new Error(`unsupported walk-forward run schema ${String(run.schemaVersion)}`);
  }
  const planFile = fileName(run.planFile, 'planFile');
  if (planFile !== 'walk-forward-plan.json') throw new Error('planFile must equal walk-forward-plan.json');
  if (!Array.isArray(run.folds) || !run.folds.length) throw new Error('run folds must be a non-empty array');
  const folds = run.folds.map(normalizeRunFold);
  for (let index = 1; index < folds.length; index += 1) {
    if (folds[index].entryWindowStartTime !== folds[index - 1].entryWindowEndTime) {
      throw new Error(`folds[${index}] entry window is not contiguous`);
    }
  }
  return {
    schemaVersion: WALK_FORWARD_RUN_SCHEMA_VERSION,
    planFile,
    planHash: hash(run.planHash, 'planHash'),
    folds,
  };
}

export function verifyWalkForwardRun(value) {
  const run = exactRecord(value, 'walk-forward run', ['schemaVersion', 'planFile', 'planHash', 'folds', 'runHash']);
  const runHash = hash(run.runHash, 'runHash');
  const payload = normalizeRunPayload(Object.fromEntries(
    Object.entries(run).filter(([field]) => field !== 'runHash'),
  ));
  const expectedHash = walkForwardRunHash(payload);
  if (runHash !== expectedHash) throw new Error(`walk-forward run hash mismatch: expected ${expectedHash}`);
  return { ...payload, runHash };
}

function readJson(file, name) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${name} ${file}: ${error.message}`);
  }
}

function expectedFoldDataset(sourceDataset, plan, fold) {
  const warmupStart = plan.activationDecisionTime - plan.warmupDurationMs;
  const timeframes = Object.fromEntries(plan.requiredTimeframes.map((timeframe) => {
    const sourceCandles = sourceDataset.timeframes[timeframe];
    if (!sourceCandles) throw new Error(`walk-forward source is missing timeframe ${timeframe}`);
    const duration = marketTimeframeMilliseconds(timeframe);
    const firstOpen = Math.floor(warmupStart / duration) * duration;
    const lastClose = Math.floor(fold.observationEndTime / duration) * duration;
    const lastOpen = lastClose - duration;
    const candles = sourceCandles.filter((candle) => candle.time >= firstOpen && candle.time <= lastOpen);
    if (!candles.length || candles[0].time !== firstOpen || candles.at(-1).time !== lastOpen) {
      throw new Error(`walk-forward source does not cover fold ${fold.sequence} timeframe ${timeframe}`);
    }
    return [timeframe, candles];
  }));
  const payload = {
    schemaVersion: 'helix.market-dataset/v1',
    source: sourceDataset.source,
    capturedThrough: fold.observationEndTime,
    timeframes,
  };
  return { ...payload, datasetHash: marketDatasetHash(payload) };
}

function assertCandidateArtifact(artifact, plan, dataset, name) {
  const expectedIdentity = {
    strategyId: plan.candidate.strategyId,
    strategyVersion: plan.candidate.strategyVersion,
    strategyRepoCommit: plan.candidate.strategyRepoCommit,
    strategyConfigHash: plan.candidate.strategyConfigHash,
    engineCommit: plan.candidate.engineCommit,
    marketDataSnapshotId: dataset.datasetHash,
  };
  if (!isDeepStrictEqual(artifact.identity, expectedIdentity)
    || artifact.strategyLifecycle !== plan.candidate.lifecycle
    || artifact.objectModel !== plan.candidate.objectModel
    || artifact.symbol !== plan.sourceDataset.source.symbol
    || artifact.baseTimeframe !== plan.baseTimeframe) {
    throw new Error(`${name} does not match the fixed candidate identity`);
  }
}

function deriveExecutionCohort(decisionArtifact, fold) {
  const selectedSignals = [];
  const tradeIds = [];
  const censoredEntries = [];
  let openEntry = null;
  let entriesInWindow = 0;
  for (const signal of decisionArtifact.signals) {
    if (signal.action === 'ENTER') {
      openEntry = signal;
      if (signal.decisionTime >= fold.entryWindowStartTime
        && signal.decisionTime < fold.entryWindowEndTime) entriesInWindow += 1;
      continue;
    }
    if (!openEntry) throw new Error('decision artifact EXIT is missing its ENTER');
    if (openEntry.decisionTime >= fold.entryWindowStartTime
      && openEntry.decisionTime < fold.entryWindowEndTime) {
      if (signal.decisionTime < fold.observationEndTime) {
        tradeIds.push(openEntry.signalId);
        selectedSignals.push(openEntry, signal);
      } else {
        censoredEntries.push({
          tradeId: openEntry.signalId,
          entrySignalId: openEntry.signalId,
          decisionId: openEntry.decisionId,
          object: openEntry.object,
          side: openEntry.side,
          sourceCandleOpenTime: openEntry.sourceCandleOpenTime,
          decisionTime: openEntry.decisionTime,
          reason: 'EXIT_AT_OBSERVATION_END',
        });
      }
    }
    openEntry = null;
  }
  if (openEntry
    && openEntry.decisionTime >= fold.entryWindowStartTime
    && openEntry.decisionTime < fold.entryWindowEndTime) {
    censoredEntries.push({
      tradeId: openEntry.signalId,
      entrySignalId: openEntry.signalId,
      decisionId: openEntry.decisionId,
      object: openEntry.object,
      side: openEntry.side,
      sourceCandleOpenTime: openEntry.sourceCandleOpenTime,
      decisionTime: openEntry.decisionTime,
      reason: 'NO_EXIT_BY_OBSERVATION_END',
    });
  }
  return {
    signals: selectedSignals.map((signal, sequence) => ({ ...signal, sequence })),
    tradeIds,
    censoredEntries,
    entriesInWindow,
  };
}

export function loadWalkForwardBundle(runFile, sourceDatasetFile) {
  const absoluteRunFile = resolve(text(runFile, 'walk_forward_run'));
  const directory = dirname(absoluteRunFile);
  const run = verifyWalkForwardRun(readJson(absoluteRunFile, 'walk-forward run'));
  const planFile = resolve(directory, run.planFile);
  const plan = verifyWalkForwardPlan(readJson(planFile, 'walk-forward plan'));
  if (run.planHash !== plan.planHash) throw new Error('walk-forward run does not match its plan hash');
  if (run.folds.length !== plan.folds.length) throw new Error('walk-forward run fold count does not match its plan');
  const sourceDataset = verifyMarketDataset(readJson(
    resolve(text(sourceDatasetFile, 'source_dataset')),
    'source dataset',
  ));
  if (sourceDataset.datasetHash !== plan.sourceDataset.datasetHash
    || sourceDataset.capturedThrough !== plan.sourceDataset.capturedThrough
    || !isDeepStrictEqual(sourceDataset.source, plan.sourceDataset.source)) {
    throw new Error('source_dataset does not match the walk-forward plan');
  }
  const folds = run.folds.map((runFold, index) => {
    const planFold = plan.folds[index];
    if (!isDeepStrictEqual({
      sequence: runFold.sequence,
      entryWindowStartTime: runFold.entryWindowStartTime,
      entryWindowEndTime: runFold.entryWindowEndTime,
      observationEndTime: runFold.observationEndTime,
    }, planFold)) throw new Error(`walk-forward run fold ${index} does not match its plan window`);
    const dataset = verifyMarketDataset(readJson(resolve(directory, runFold.datasetFile), `fold ${index} dataset`));
    const expectedDataset = expectedFoldDataset(sourceDataset, plan, planFold);
    if (runFold.datasetHash !== dataset.datasetHash || !isDeepStrictEqual(dataset, expectedDataset)) {
      throw new Error(`walk-forward fold ${index} dataset is not the exact source prefix`);
    }
    const decisionArtifact = verifySignalArtifact(readJson(
      resolve(directory, runFold.decisionArtifactFile),
      `fold ${index} decision artifact`,
    ));
    const replayArtifact = verifySignalArtifact(readJson(
      resolve(directory, runFold.replayArtifactFile),
      `fold ${index} replay artifact`,
    ));
    const executionArtifact = verifySignalArtifact(readJson(
      resolve(directory, runFold.executionArtifactFile),
      `fold ${index} execution artifact`,
    ));
    const decisionRiskTrace = verifyHistoricalRiskTrace(readJson(
      resolve(directory, runFold.decisionRiskTraceFile),
      `fold ${index} decision risk trace`,
    ), decisionArtifact);
    const executionRiskTrace = verifyHistoricalRiskTrace(readJson(
      resolve(directory, runFold.executionRiskTraceFile),
      `fold ${index} execution risk trace`,
    ), executionArtifact);
    for (const [name, artifact, expectedHash] of [
      ['decision artifact', decisionArtifact, runFold.decisionArtifactHash],
      ['replay artifact', replayArtifact, runFold.replayArtifactHash],
      ['execution artifact', executionArtifact, runFold.executionArtifactHash],
    ]) {
      if (artifact.artifactHash !== expectedHash) throw new Error(`walk-forward fold ${index} ${name} hash mismatch`);
      assertCandidateArtifact(artifact, plan, dataset, `walk-forward fold ${index} ${name}`);
    }
    if (decisionRiskTrace.traceHash !== runFold.decisionRiskTraceHash) {
      throw new Error(`walk-forward fold ${index} decision risk trace hash mismatch`);
    }
    if (executionRiskTrace.traceHash !== runFold.executionRiskTraceHash) {
      throw new Error(`walk-forward fold ${index} execution risk trace hash mismatch`);
    }
    if (!isDeepStrictEqual(decisionArtifact, replayArtifact)) {
      throw new Error(`walk-forward fold ${index} replay is non-deterministic`);
    }
    const baseDuration = marketTimeframeMilliseconds(plan.baseTimeframe);
    if (decisionArtifact.marketData.firstCandleOpenTime !== plan.activationDecisionTime - baseDuration
      || decisionArtifact.marketData.lastCandleCloseTime !== planFold.observationEndTime
      || !isDeepStrictEqual(executionArtifact.marketData, decisionArtifact.marketData)) {
      throw new Error(`walk-forward fold ${index} artifact market window mismatch`);
    }
    const cohort = deriveExecutionCohort(decisionArtifact, planFold);
    if (!isDeepStrictEqual(executionArtifact.signals, cohort.signals)
      || !isDeepStrictEqual(runFold.tradeIds, cohort.tradeIds)
      || !isDeepStrictEqual(runFold.censoredEntries, cohort.censoredEntries)
      || runFold.statistics.decisionSignals !== decisionArtifact.signals.length
      || runFold.statistics.entriesInWindow !== cohort.entriesInWindow) {
      throw new Error(`walk-forward fold ${index} execution cohort mismatch`);
    }
    const completedEntryIds = new Set(cohort.tradeIds);
    const expectedExecutionRisks = decisionRiskTrace.entries.filter(
      ({ entrySignalId }) => completedEntryIds.has(entrySignalId),
    );
    if (!isDeepStrictEqual(executionRiskTrace.entries, expectedExecutionRisks)) {
      throw new Error(`walk-forward fold ${index} execution risk cohort mismatch`);
    }
    return {
      plan: planFold,
      run: runFold,
      dataset,
      decisionArtifact,
      decisionRiskTrace,
      replayArtifact,
      executionArtifact,
      executionRiskTrace,
    };
  });
  for (let index = 1; index < folds.length; index += 1) {
    const previous = folds[index - 1];
    const currentPrefixSignals = folds[index].decisionArtifact.signals.filter(
      ({ decisionTime }) => decisionTime <= previous.plan.observationEndTime,
    );
    if (!isDeepStrictEqual(currentPrefixSignals, previous.decisionArtifact.signals)) {
      throw new Error(`walk-forward fold ${index} decision prefix changed after prior observation`);
    }
    const previousEntryIds = new Set(previous.decisionRiskTrace.entries.map(({ entrySignalId }) => entrySignalId));
    const currentPrefixRisks = folds[index].decisionRiskTrace.entries.filter(
      ({ entrySignalId }) => previousEntryIds.has(entrySignalId),
    );
    if (!isDeepStrictEqual(currentPrefixRisks, previous.decisionRiskTrace.entries)) {
      throw new Error(`walk-forward fold ${index} decision risk prefix changed after prior observation`);
    }
  }
  return { directory, runFile: absoluteRunFile, planFile, plan, run, sourceDataset, folds };
}

function nullableFinite(value, name) {
  if (value === null) return null;
  return finite(value, name);
}

function normalizeBacktestMetrics(value, name) {
  const metrics = exactRecord(value, name, [
    'trades', 'wins', 'draws', 'losses', 'profitRatio', 'profitAbs', 'winRate',
    'maxDrawdownRatio', 'maxDrawdownAbs', 'expectancyAbs', 'expectancyRatio',
    'profitFactor', 'profitFactorStatus', 'holdingSeconds', 'riskNormalized',
  ]);
  const trades = integer(metrics.trades, `${name}.trades`);
  const wins = integer(metrics.wins, `${name}.wins`);
  const draws = integer(metrics.draws, `${name}.draws`);
  const losses = integer(metrics.losses, `${name}.losses`);
  if (wins + draws + losses !== trades) throw new Error(`${name} trade counts are inconsistent`);
  const winRate = nullableFinite(metrics.winRate, `${name}.winRate`);
  if (winRate !== null && (winRate < 0 || winRate > 1)) throw new Error(`${name}.winRate is invalid`);
  const maxDrawdownRatio = nullableFinite(metrics.maxDrawdownRatio, `${name}.maxDrawdownRatio`);
  const maxDrawdownAbs = nullableFinite(metrics.maxDrawdownAbs, `${name}.maxDrawdownAbs`);
  const profitFactor = nullableFinite(metrics.profitFactor, `${name}.profitFactor`);
  const holdingSeconds = nullableFinite(metrics.holdingSeconds, `${name}.holdingSeconds`);
  if ([maxDrawdownRatio, maxDrawdownAbs, profitFactor, holdingSeconds]
    .some((number) => number !== null && number < 0)) {
    throw new Error(`${name} contains a negative non-negative metric`);
  }
  const profitFactorStatus = text(metrics.profitFactorStatus, `${name}.profitFactorStatus`);
  if (!['AVAILABLE', 'NO_LOSSES', 'UNAVAILABLE'].includes(profitFactorStatus)) {
    throw new Error(`${name}.profitFactorStatus is invalid`);
  }
  if ((profitFactorStatus === 'AVAILABLE') !== (profitFactor !== null)) {
    throw new Error(`${name}.profitFactor does not match its status`);
  }
  const risk = exactRecord(metrics.riskNormalized, `${name}.riskNormalized`, [
    'available', 'reason', 'expectancyR', 'maxDrawdownR', 'mfeR', 'maeR',
    ...(Object.hasOwn(metrics.riskNormalized, 'observations') ? ['observations'] : []),
  ]);
  if (typeof risk.available !== 'boolean') throw new Error(`${name}.riskNormalized.available must be boolean`);
  const reason = text(risk.reason, `${name}.riskNormalized.reason`);
  const normalizedRisk = {
    available: risk.available,
    reason,
    expectancyR: nullableFinite(risk.expectancyR, `${name}.riskNormalized.expectancyR`),
    maxDrawdownR: nullableFinite(risk.maxDrawdownR, `${name}.riskNormalized.maxDrawdownR`),
    mfeR: nullableFinite(risk.mfeR, `${name}.riskNormalized.mfeR`),
    maeR: nullableFinite(risk.maeR, `${name}.riskNormalized.maeR`),
  };
  if (Object.hasOwn(risk, 'observations')) {
    if (!Array.isArray(risk.observations)) throw new Error(`${name}.riskNormalized.observations must be an array`);
    normalizedRisk.observations = risk.observations.map((value, index) => {
      const observationName = `${name}.riskNormalized.observations[${index}]`;
      const observation = exactRecord(value, observationName, [
        'entrySignalId', 'openTime', 'closeTime', 'realizedR', 'mfeR', 'maeR',
        'riskUnitRatio', 'riskR', 'leverage', 'accountEquity', 'expectedRiskBudget',
        'priceRiskBudget', 'feeRiskBudget', 'actualRiskBudget',
        'expectedStakeAmount', 'stakeAmount', 'segments',
      ]);
      const segments = jsonRecord(observation.segments, `${observationName}.segments`);
      const normalizedSegments = Object.fromEntries(Object.entries(segments).map(([dimension, segmentValue]) => {
        if (!/^[a-z][a-z0-9_.]*$/.test(dimension)) throw new Error(`${observationName}.segments has invalid dimension`);
        return [dimension, text(segmentValue, `${observationName}.segments.${dimension}`)];
      }));
      const normalizedObservation = {
        entrySignalId: text(observation.entrySignalId, `${observationName}.entrySignalId`),
        openTime: integer(observation.openTime, `${observationName}.openTime`),
        closeTime: integer(observation.closeTime, `${observationName}.closeTime`),
        realizedR: finite(observation.realizedR, `${observationName}.realizedR`),
        mfeR: finite(observation.mfeR, `${observationName}.mfeR`),
        maeR: finite(observation.maeR, `${observationName}.maeR`),
        riskUnitRatio: finite(observation.riskUnitRatio, `${observationName}.riskUnitRatio`),
        riskR: finite(observation.riskR, `${observationName}.riskR`),
        leverage: finite(observation.leverage, `${observationName}.leverage`),
        accountEquity: finite(observation.accountEquity, `${observationName}.accountEquity`),
        expectedRiskBudget: finite(observation.expectedRiskBudget, `${observationName}.expectedRiskBudget`),
        priceRiskBudget: finite(observation.priceRiskBudget, `${observationName}.priceRiskBudget`),
        feeRiskBudget: finite(observation.feeRiskBudget, `${observationName}.feeRiskBudget`),
        actualRiskBudget: finite(observation.actualRiskBudget, `${observationName}.actualRiskBudget`),
        expectedStakeAmount: finite(observation.expectedStakeAmount, `${observationName}.expectedStakeAmount`),
        stakeAmount: finite(observation.stakeAmount, `${observationName}.stakeAmount`),
        segments: normalizedSegments,
      };
      if (normalizedObservation.priceRiskBudget <= 0
        || normalizedObservation.feeRiskBudget < 0
        || Math.abs(
          normalizedObservation.priceRiskBudget
            + normalizedObservation.feeRiskBudget
            - normalizedObservation.actualRiskBudget
        ) > 1e-8) {
        throw new Error(`${observationName} risk budget components are inconsistent`);
      }
      return normalizedObservation;
    });
    if (normalizedRisk.observations.length !== trades
      || new Set(normalizedRisk.observations.map(({ entrySignalId }) => entrySignalId)).size !== trades) {
      throw new Error(`${name}.riskNormalized.observations must cover every trade exactly once`);
    }
    for (let index = 1; index < normalizedRisk.observations.length; index += 1) {
      const previous = normalizedRisk.observations[index - 1];
      const current = normalizedRisk.observations[index];
      if (current.openTime < previous.openTime
        || (current.openTime === previous.openTime && current.entrySignalId < previous.entrySignalId)) {
        throw new Error(`${name}.riskNormalized.observations must be ordered`);
      }
    }
  }
  if (!normalizedRisk.available && Object.entries(normalizedRisk)
    .some(([field, number]) => !['available', 'reason'].includes(field) && number !== null)) {
    throw new Error(`${name}.riskNormalized unavailable metrics must be null`);
  }
  if (normalizedRisk.available && [
    normalizedRisk.expectancyR,
    normalizedRisk.maxDrawdownR,
    normalizedRisk.mfeR,
    normalizedRisk.maeR,
  ].some((number) => number === null)) {
    throw new Error(`${name}.riskNormalized available metrics must be complete`);
  }
  return {
    trades,
    wins,
    draws,
    losses,
    profitRatio: nullableFinite(metrics.profitRatio, `${name}.profitRatio`),
    profitAbs: nullableFinite(metrics.profitAbs, `${name}.profitAbs`),
    winRate,
    maxDrawdownRatio,
    maxDrawdownAbs,
    expectancyAbs: nullableFinite(metrics.expectancyAbs, `${name}.expectancyAbs`),
    expectancyRatio: nullableFinite(metrics.expectancyRatio, `${name}.expectancyRatio`),
    profitFactor,
    profitFactorStatus,
    holdingSeconds,
    riskNormalized: normalizedRisk,
  };
}

function normalizeReconciliation(value, name, expectedTrades) {
  const reconciliation = exactRecord(value, name, ['trades', 'entries', 'exits', 'matchedSignals']);
  const normalized = {
    trades: integer(reconciliation.trades, `${name}.trades`),
    entries: integer(reconciliation.entries, `${name}.entries`),
    exits: integer(reconciliation.exits, `${name}.exits`),
    matchedSignals: integer(reconciliation.matchedSignals, `${name}.matchedSignals`),
  };
  if (normalized.trades !== expectedTrades
    || normalized.entries !== expectedTrades
    || normalized.exits !== expectedTrades
    || normalized.matchedSignals !== expectedTrades * 2) {
    throw new Error(`${name} does not exactly reconcile the execution cohort`);
  }
  return normalized;
}

function normalizeFeeObservations(value, name, scenario, expectedTrades) {
  const observations = exactRecord(value, name, [
    'status', 'trades', 'requestedFee', 'openRates', 'closeRates', 'matchesRequested',
  ]);
  const status = text(observations.status, `${name}.status`);
  if (!['OBSERVED', 'NO_TRADES'].includes(status)) throw new Error(`${name}.status is invalid`);
  const trades = integer(observations.trades, `${name}.trades`);
  const requestedFee = finite(observations.requestedFee, `${name}.requestedFee`);
  if (trades !== expectedTrades || requestedFee !== scenario.fee) {
    throw new Error(`${name} does not match the execution cohort or scenario`);
  }
  const rates = (value, field) => {
    if (!Array.isArray(value)) throw new Error(`${name}.${field} must be an array`);
    const normalized = value.map((rate, index) => {
      const number = finite(rate, `${name}.${field}[${index}]`);
      if (number < 0) throw new Error(`${name}.${field}[${index}] must be non-negative`);
      return number;
    });
    if (new Set(normalized).size !== normalized.length) throw new Error(`${name}.${field} must be unique`);
    return normalized;
  };
  const openRates = rates(observations.openRates, 'openRates');
  const closeRates = rates(observations.closeRates, 'closeRates');
  if (typeof observations.matchesRequested !== 'boolean') {
    throw new Error(`${name}.matchesRequested must be boolean`);
  }
  if (status === 'OBSERVED' && (
    trades < 1 || !openRates.length || !closeRates.length || !observations.matchesRequested
    || [...openRates, ...closeRates].some((rate) => Math.abs(rate - scenario.fee) > 1e-12)
  )) throw new Error(`${name} does not prove the requested fee was applied`);
  if (status === 'NO_TRADES' && (
    trades !== 0 || openRates.length || closeRates.length || observations.matchesRequested
  )) throw new Error(`${name} NO_TRADES observation is inconsistent`);
  return {
    status,
    trades,
    requestedFee,
    openRates,
    closeRates,
    matchesRequested: observations.matchesRequested,
  };
}

function archiveFile(value, name, expectedHash, suffixes) {
  const normalized = text(value, name);
  if (!normalized.startsWith('evidence/') || normalized.includes('..') || normalized.includes('\\')) {
    throw new Error(`${name} must be a relative evidence archive path`);
  }
  const hashName = expectedHash.replace(':', '-');
  if (!suffixes.some((suffix) => normalized === `evidence/${hashName}${suffix}`)) {
    throw new Error(`${name} must be content-addressed by its evidence hash`);
  }
  return normalized;
}

function normalizeCoreEvidence(value, runHash) {
  const evidence = exactRecord(value, 'coreEvidence', ['root', 'sourceDatasetFile', 'runFile', 'files']);
  const root = text(evidence.root, 'coreEvidence.root');
  const expectedRoot = `core/${runHash.replace(':', '-')}`;
  if (root !== expectedRoot) throw new Error(`coreEvidence.root must equal ${expectedRoot}`);
  const sourceDatasetFile = text(evidence.sourceDatasetFile, 'coreEvidence.sourceDatasetFile');
  const runFile = text(evidence.runFile, 'coreEvidence.runFile');
  if (sourceDatasetFile !== `${root}/source-dataset.json`
    || runFile !== `${root}/walk-forward-run.json`) {
    throw new Error('coreEvidence source/run files do not match its content-addressed root');
  }
  if (!Array.isArray(evidence.files) || !evidence.files.length) {
    throw new Error('coreEvidence.files must be a non-empty array');
  }
  const files = evidence.files.map((value, index) => {
    const entry = exactRecord(value, `coreEvidence.files[${index}]`, ['file', 'fileHash']);
    const file = text(entry.file, `coreEvidence.files[${index}].file`);
    if (!file.startsWith(`${root}/`) || file.includes('..') || file.includes('\\')) {
      throw new Error(`coreEvidence.files[${index}].file escapes its root`);
    }
    return { file, fileHash: hash(entry.fileHash, `coreEvidence.files[${index}].fileHash`) };
  });
  if (new Set(files.map(({ file }) => file)).size !== files.length) {
    throw new Error('coreEvidence.files must not contain duplicate paths');
  }
  if (!files.some(({ file }) => file === sourceDatasetFile)
    || !files.some(({ file }) => file === runFile)) {
    throw new Error('coreEvidence.files must include sourceDatasetFile and runFile');
  }
  return { root, sourceDatasetFile, runFile, files };
}

function normalizeExecutionEvidence(value, name, plan, fold) {
  const evidence = exactRecord(value, name, [
    'scenarioId', 'fee', 'freqtradeVersion', 'configHash', 'adapterHash', 'executionProfile',
    'executionProfileHash', 'riskTraceHash', 'riskUnitRatio', 'runtimeEvidenceFile', 'runtimeEvidenceHash', 'resultFile',
    'resultHash', 'resultMetaFile', 'resultMetaHash', 'reconciliation', 'feeObservations',
    'metrics',
  ]);
  const scenarioId = text(evidence.scenarioId, `${name}.scenarioId`);
  const scenario = plan.executionScenarios.find(({ id }) => id === scenarioId);
  if (!scenario) throw new Error(`${name} uses an unknown execution scenario`);
  const fee = finite(evidence.fee, `${name}.fee`);
  if (fee !== scenario.fee) throw new Error(`${name}.fee does not match its plan scenario`);
  const executionProfile = jsonRecord(evidence.executionProfile, `${name}.executionProfile`);
  if (executionProfile.schemaVersion !== 'helix.freqtrade-execution-profile/v1'
    || executionProfile.strategy !== 'HelixSignalStrategy'
    || executionProfile.timeframe !== plan.baseTimeframe
    || !isDeepStrictEqual(executionProfile.pairs, [plan.sourceDataset.source.symbol])
    || executionProfile.fee !== fee
    || (plan.walkForwardPolicy
      && executionProfile.dryRunWallet !== plan.walkForwardPolicy.plan.referenceAccountEquity)) {
    throw new Error(`${name}.executionProfile does not match the plan scenario`);
  }
  const executionProfileHash = hash(evidence.executionProfileHash, `${name}.executionProfileHash`);
  if (executionProfileHash !== walkForwardEvidenceHash(executionProfile)) {
    throw new Error(`${name}.executionProfileHash mismatch`);
  }
  const resultHash = hash(evidence.resultHash, `${name}.resultHash`);
  const resultMetaHash = hash(evidence.resultMetaHash, `${name}.resultMetaHash`);
  const riskTraceHash = hash(evidence.riskTraceHash, `${name}.riskTraceHash`);
  if (riskTraceHash !== fold.executionRiskTraceHash) throw new Error(`${name}.riskTraceHash does not match its fold`);
  const riskUnitRatio = finite(evidence.riskUnitRatio, `${name}.riskUnitRatio`);
  if (riskUnitRatio <= 0 || riskUnitRatio > 1
    || (plan.walkForwardPolicy && riskUnitRatio !== plan.walkForwardPolicy.plan.riskUnitRatio)) {
    throw new Error(`${name}.riskUnitRatio does not match its plan policy`);
  }
  const metrics = normalizeBacktestMetrics(evidence.metrics, `${name}.metrics`);
  if (metrics.trades !== fold.tradeIds.length) throw new Error(`${name}.metrics trades do not match the fold cohort`);
  return {
    scenarioId,
    fee,
    freqtradeVersion: text(evidence.freqtradeVersion, `${name}.freqtradeVersion`),
    configHash: hash(evidence.configHash, `${name}.configHash`),
    adapterHash: hash(evidence.adapterHash, `${name}.adapterHash`),
    executionProfile,
    executionProfileHash,
    riskTraceHash,
    riskUnitRatio,
    runtimeEvidenceFile: archiveFile(
      evidence.runtimeEvidenceFile,
      `${name}.runtimeEvidenceFile`,
      hash(evidence.runtimeEvidenceHash, `${name}.runtimeEvidenceHash`),
      ['.runtime.json'],
    ),
    runtimeEvidenceHash: hash(evidence.runtimeEvidenceHash, `${name}.runtimeEvidenceHash`),
    resultFile: archiveFile(evidence.resultFile, `${name}.resultFile`, resultHash, ['.json', '.zip']),
    resultHash,
    resultMetaFile: archiveFile(evidence.resultMetaFile, `${name}.resultMetaFile`, resultMetaHash, ['.meta.json']),
    resultMetaHash,
    reconciliation: normalizeReconciliation(
      evidence.reconciliation,
      `${name}.reconciliation`,
      fold.tradeIds.length,
    ),
    feeObservations: normalizeFeeObservations(
      evidence.feeObservations,
      `${name}.feeObservations`,
      scenario,
      fold.tradeIds.length,
    ),
    metrics,
  };
}

function riskSummary(observations) {
  if (!observations.length) {
    return {
      trades: 0,
      expectancyR: null,
      maxDrawdownR: null,
      grossProfitR: 0,
      grossLossR: 0,
      profitFactor: null,
      profitFactorStatus: 'UNAVAILABLE',
    };
  }
  let cumulativeR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  let grossProfitR = 0;
  let grossLossR = 0;
  for (const observation of observations) {
    cumulativeR += observation.realizedR;
    peakR = Math.max(peakR, cumulativeR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - cumulativeR);
    if (observation.realizedR > 0) grossProfitR += observation.realizedR;
    if (observation.realizedR < 0) grossLossR += -observation.realizedR;
  }
  return {
    trades: observations.length,
    expectancyR: cumulativeR / observations.length,
    maxDrawdownR,
    grossProfitR,
    grossLossR,
    profitFactor: grossLossR > 0 ? grossProfitR / grossLossR : null,
    profitFactorStatus: grossLossR > 0
      ? 'AVAILABLE'
      : grossProfitR > 0 ? 'NO_LOSSES' : 'UNAVAILABLE',
  };
}

function scenarioRisk(foldEvidence) {
  const complete = foldEvidence.every(({ metrics }) => (
    metrics.trades === 0
      ? metrics.riskNormalized.reason === 'NO_COMPLETED_TRADES'
      : metrics.riskNormalized.available
        && Array.isArray(metrics.riskNormalized.observations)
        && metrics.riskNormalized.observations.length === metrics.trades
  ));
  if (!complete) return { available: false, reason: 'TRADE_LEVEL_R_OBSERVATIONS_UNAVAILABLE' };
  const observations = foldEvidence.flatMap(({ metrics }) => metrics.riskNormalized.observations || [])
    .sort((left, right) => left.openTime - right.openTime || left.entrySignalId.localeCompare(right.entrySignalId));
  if (new Set(observations.map(({ entrySignalId }) => entrySignalId)).size !== observations.length) {
    throw new Error('walk-forward folds contain duplicate risk observations');
  }
  const foldTotals = foldEvidence.map(({ metrics }) => (
    (metrics.riskNormalized.observations || []).reduce((total, observation) => total + observation.realizedR, 0)
  ));
  return {
    available: true,
    reason: 'NET_ACCOUNT_R_EXECUTION',
    activeFolds: foldEvidence.filter(({ metrics }) => metrics.trades > 0).length,
    positiveFolds: foldTotals.filter((total) => total > 0).length,
    ...riskSummary(observations),
    observations,
  };
}

const STRATEGY_SEGMENT_VALUES = {
  helix_scalp_hunter: {
    'scalp.event_type': ['LIQUIDITY_SWEEP', 'BREAKOUT_FAILURE', 'MOMENTUM_BURST'],
    'scalp.grade': ['A_PLUS', 'A', 'B'],
    'scalp.regime.type': ['TRENDING', 'RANGING', 'COMPRESSED', 'EXPANDING', 'EXHAUSTED', 'CHAOTIC'],
  },
  helix_swing_hunter: {
    'swing.stage': ['EARLY', 'STANDARD', 'CONFIRMED'],
    'swing.context.state': ['BULLISH_TREND', 'BEARISH_TREND', 'RANGE', 'TRANSITION', 'UNCLEAR'],
    'swing.context.bias': ['BULLISH', 'BEARISH', 'NEUTRAL'],
  },
};

function profitFactorPass(summary, minimum) {
  return summary.profitFactorStatus === 'NO_LOSSES'
    || (summary.profitFactorStatus === 'AVAILABLE' && summary.profitFactor >= minimum);
}

function segmentStability(policy, scenarioRiskValue) {
  const knownDimensions = STRATEGY_SEGMENT_VALUES[policy.strategyId] || {};
  return policy.gates.segmentStability.dimensions.map((dimension) => {
    const values = knownDimensions[dimension];
    if (!values) throw new Error(`walkForwardPolicy uses unsupported segment dimension ${dimension}`);
    const segments = values.map((value) => {
      const observations = scenarioRiskValue.available
        ? scenarioRiskValue.observations.filter((observation) => observation.segments[dimension] === value)
        : [];
      const summary = riskSummary(observations);
      const stable = summary.trades >= policy.gates.segmentStability.minimumTradesPerSegment
        && summary.expectancyR >= policy.gates.minimumExpectancyR
        && summary.maxDrawdownR <= policy.gates.maximumDrawdownR
        && profitFactorPass(summary, policy.gates.minimumProfitFactor);
      return { value, ...summary, stable };
    });
    const stableSegments = segments.filter(({ stable }) => stable).length;
    return {
      dimension,
      stableSegments,
      requiredSegments: segments.length,
      stableRatio: stableSegments / segments.length,
      segments,
    };
  });
}

function aggregateScenarios(plan, folds) {
  return plan.executionScenarios.map((scenario) => {
    const evidence = folds.map((fold) => (
      fold.executionEvidence.find(({ scenarioId }) => scenarioId === scenario.id)
    ));
    const metrics = evidence.map((item) => item.metrics);
    const trades = metrics.reduce((total, item) => total + item.trades, 0);
    const profitAbs = metrics.every((item) => item.profitAbs !== null)
      ? metrics.reduce((total, item) => total + item.profitAbs, 0)
      : null;
    const result = {
      scenarioId: scenario.id,
      fee: scenario.fee,
      folds: folds.length,
      activeFolds: metrics.filter((item) => item.trades > 0).length,
      positiveFolds: metrics.filter((item) => item.profitAbs !== null && item.profitAbs > 0).length,
      trades,
      wins: metrics.reduce((total, item) => total + item.wins, 0),
      draws: metrics.reduce((total, item) => total + item.draws, 0),
      losses: metrics.reduce((total, item) => total + item.losses, 0),
      profitAbs,
      expectancyAbs: trades > 0 && profitAbs !== null ? profitAbs / trades : null,
    };
    const riskNormalized = scenarioRisk(evidence);
    if (!plan.walkForwardPolicy) return { ...result, riskNormalized };
    return {
      ...result,
      riskNormalized,
      segmentStability: segmentStability(plan.walkForwardPolicy, riskNormalized),
    };
  });
}

function gateCheck(code, ok, actual, required, evidenceRefs) {
  return { code, ok, actual, required, evidenceRefs };
}

export function createWalkForwardReport(bundle, foldEvidence, coreEvidenceValue) {
  if (!bundle?.plan || !bundle?.run || !Array.isArray(bundle.folds)) {
    throw new Error('walk-forward bundle is required');
  }
  if (!Array.isArray(foldEvidence) || foldEvidence.length !== bundle.folds.length) {
    throw new Error('walk-forward execution evidence must cover every fold');
  }
  const coreEvidence = normalizeCoreEvidence(coreEvidenceValue, bundle.run.runHash);
  const expectedCoreFiles = [
    coreEvidence.sourceDatasetFile,
    `${coreEvidence.root}/${bundle.run.planFile}`,
    coreEvidence.runFile,
    ...bundle.run.folds.flatMap((fold) => [
      `${coreEvidence.root}/${fold.datasetFile}`,
      `${coreEvidence.root}/${fold.decisionArtifactFile}`,
      `${coreEvidence.root}/${fold.decisionRiskTraceFile}`,
      `${coreEvidence.root}/${fold.replayArtifactFile}`,
      `${coreEvidence.root}/${fold.executionArtifactFile}`,
      `${coreEvidence.root}/${fold.executionRiskTraceFile}`,
    ]),
  ];
  if (!isDeepStrictEqual(coreEvidence.files.map(({ file }) => file), expectedCoreFiles)) {
    throw new Error('coreEvidence.files does not contain the complete ordered Core bundle');
  }
  const folds = bundle.folds.map(({ plan: planFold, run: runFold }, index) => {
    if (!Array.isArray(foldEvidence[index])
      || foldEvidence[index].length !== bundle.plan.executionScenarios.length) {
      throw new Error(`walk-forward fold ${index} must cover every execution scenario`);
    }
    const executionEvidence = foldEvidence[index].map((value, evidenceIndex) => (
      normalizeExecutionEvidence(value, `folds[${index}].executionEvidence[${evidenceIndex}]`, bundle.plan, runFold)
    ));
    if (!isDeepStrictEqual(
      executionEvidence.map(({ scenarioId }) => scenarioId),
      bundle.plan.executionScenarios.map(({ id }) => id),
    )) throw new Error(`walk-forward fold ${index} execution scenarios are out of order`);
    return {
      ...planFold,
      datasetHash: runFold.datasetHash,
      decisionArtifactHash: runFold.decisionArtifactHash,
      decisionRiskTraceHash: runFold.decisionRiskTraceHash,
      replayArtifactHash: runFold.replayArtifactHash,
      executionArtifactHash: runFold.executionArtifactHash,
      executionRiskTraceHash: runFold.executionRiskTraceHash,
      tradeIds: runFold.tradeIds,
      censoredEntries: runFold.censoredEntries,
      executionEvidence,
    };
  });
  const scenarios = aggregateScenarios(bundle.plan, folds);
  const environments = folds.flatMap(({ executionEvidence }) => executionEvidence);
  if (new Set(environments.map(({ freqtradeVersion }) => freqtradeVersion)).size !== 1
    || new Set(environments.map(({ configHash }) => configHash)).size !== 1
    || new Set(environments.map(({ adapterHash }) => adapterHash)).size !== 1) {
    throw new Error('walk-forward execution evidence must use one Freqtrade version, config, and adapter');
  }
  const base = scenarios.reduce((selected, item) => item.fee < selected.fee ? item : selected, scenarios[0]);
  const costSensitivity = scenarios.map((scenario) => ({
    scenarioId: scenario.scenarioId,
    fee: scenario.fee,
    profitAbsDeltaFromBase: scenario.profitAbs !== null && base.profitAbs !== null
      ? scenario.profitAbs - base.profitAbs
      : null,
    expectancyAbsDeltaFromBase: scenario.expectancyAbs !== null && base.expectancyAbs !== null
      ? scenario.expectancyAbs - base.expectancyAbs
      : null,
  }));
  const censored = folds.reduce((total, fold) => total + fold.censoredEntries.length, 0);
  const policy = bundle.plan.walkForwardPolicy;
  const riskMetricsAvailable = scenarios.every(({ riskNormalized }) => riskNormalized.available);
  const observedFeeScenarios = bundle.plan.executionScenarios.filter((scenario) => folds.some(
    (fold) => fold.executionEvidence.some((evidence) => (
      evidence.scenarioId === scenario.id && evidence.feeObservations.status === 'OBSERVED'
    )),
  )).map(({ id }) => id);
  const checks = [
    gateCheck('PLAN_HASH_VALID', true, bundle.plan.planHash, bundle.run.planHash, ['planHash']),
    gateCheck('RUN_HASH_VALID', true, bundle.run.runHash, bundle.run.runHash, ['runHash']),
    gateCheck('IDENTITY_PIN_MATCH', true, bundle.plan.candidate, bundle.plan.candidate, ['candidate']),
    gateCheck('FOLD_WINDOWS_CONTIGUOUS', true, folds.length, folds.length, ['folds']),
    gateCheck('DATASET_PREFIX_DERIVATION_VALID', true, folds.length, folds.length, ['folds.*.datasetHash']),
    gateCheck('DETERMINISTIC_REPLAY', true, true, true, ['folds.*.replayArtifactHash']),
    gateCheck('ARTIFACT_HASH_VALID', true, true, true, ['folds.*.executionArtifactHash']),
    gateCheck('RISK_TRACE_HASH_VALID', true, true, true, ['folds.*.executionRiskTraceHash']),
    gateCheck('EXECUTION_EVIDENCE_HASH_VALID', true, true, true, ['folds.*.executionEvidence']),
    gateCheck('SIGNAL_RECONCILED', true, true, true, ['folds.*.executionEvidence.*.reconciliation']),
    gateCheck('EXECUTION_PROFILE_PIN_MATCH', true, true, true, ['folds.*.executionEvidence.*.executionProfileHash']),
    gateCheck(
      'FEE_STRESS_OBSERVED',
      observedFeeScenarios.length === bundle.plan.executionScenarios.length,
      observedFeeScenarios,
      bundle.plan.executionScenarios.map(({ id }) => id),
      ['folds.*.executionEvidence.*.feeObservations'],
    ),
    gateCheck('NO_CENSORED_TRADES', censored === 0, censored, 0, ['folds.*.censoredEntries']),
    gateCheck(
      'REQUIRED_METRICS_PRESENT',
      riskMetricsAvailable,
      riskMetricsAvailable ? 'R_NORMALIZED' : 'ABSOLUTE_ONLY',
      'R_NORMALIZED',
      ['folds.*.executionEvidence.*.metrics.riskNormalized'],
    ),
    gateCheck(
      'RISK_SIZING_VALID',
      Boolean(policy) && scenarios.every(({ riskNormalized }) => (
        riskNormalized.available
        && riskNormalized.observations.every((observation) => (
          observation.riskUnitRatio === policy.plan.riskUnitRatio
          && observation.actualRiskBudget <= observation.expectedRiskBudget + 1e-8
          && observation.actualRiskBudget >= observation.expectedRiskBudget
            - Math.max(1e-8, observation.expectedRiskBudget * RISK_BUDGET_TOLERANCE_RATIO)
        ))
      )),
      scenarios.map(({ scenarioId, riskNormalized }) => ({
        scenarioId,
        observations: riskNormalized.available ? riskNormalized.observations.length : 0,
        valid: riskNormalized.available && riskNormalized.observations.every((observation) => (
          policy && observation.riskUnitRatio === policy.plan.riskUnitRatio
          && observation.actualRiskBudget <= observation.expectedRiskBudget + 1e-8
          && observation.actualRiskBudget >= observation.expectedRiskBudget
            - Math.max(1e-8, observation.expectedRiskBudget * RISK_BUDGET_TOLERANCE_RATIO)
        )),
      })),
      policy ? {
        riskUnitRatio: policy.plan.riskUnitRatio,
        referenceAccountEquity: policy.plan.referenceAccountEquity,
        valid: true,
      } : { policy: 'required' },
      [
        'walkForwardPolicy.plan.riskUnitRatio',
        'walkForwardPolicy.plan.referenceAccountEquity',
        'folds.*.executionEvidence.*.metrics.riskNormalized.observations',
      ],
    ),
    gateCheck(
      'VERSIONED_GATE_POLICY_PRESENT',
      Boolean(policy),
      policy ? { id: policy.id, version: policy.version, policyHash: policy.policyHash } : false,
      true,
      policy ? ['walkForwardPolicy'] : ['candidate.strategyConfigHash'],
    ),
  ];
  if (policy?.schemaVersion === 'helix.walk-forward-policy/v2') {
    checks.push(gateCheck(
      'SYMBOL_STABILITY_GATE_SATISFIED',
      false,
      false,
      true,
      ['walkForwardPolicy.gates.symbolStability', 'portfolioReport'],
    ));
  }
  if (policy) {
    const scenarioRequirement = (field, required) => ({
      scenarios: scenarios.map((scenario) => ({
        scenarioId: scenario.scenarioId,
        value: scenario.riskNormalized.available ? scenario.riskNormalized[field] : null,
      })),
      required,
    });
    checks.push(
      gateCheck(
        'MINIMUM_TOTAL_TRADES',
        scenarios.every(({ riskNormalized }) => riskNormalized.available
          && riskNormalized.trades >= policy.gates.minimumTotalTrades),
        scenarioRequirement('trades', policy.gates.minimumTotalTrades).scenarios,
        policy.gates.minimumTotalTrades,
        ['aggregate.scenarios.*.riskNormalized.trades'],
      ),
      gateCheck(
        'MINIMUM_ACTIVE_FOLD_RATIO',
        scenarios.every(({ riskNormalized }) => riskNormalized.available
          && riskNormalized.activeFolds / folds.length >= policy.gates.minimumActiveFoldRatio),
        scenarios.map(({ scenarioId, riskNormalized }) => ({
          scenarioId,
          value: riskNormalized.available ? riskNormalized.activeFolds / folds.length : null,
        })),
        policy.gates.minimumActiveFoldRatio,
        ['aggregate.scenarios.*.riskNormalized.activeFolds'],
      ),
      gateCheck(
        'MINIMUM_POSITIVE_FOLD_RATIO',
        scenarios.every(({ riskNormalized }) => riskNormalized.available
          && riskNormalized.positiveFolds / folds.length >= policy.gates.minimumPositiveFoldRatio),
        scenarios.map(({ scenarioId, riskNormalized }) => ({
          scenarioId,
          value: riskNormalized.available ? riskNormalized.positiveFolds / folds.length : null,
        })),
        policy.gates.minimumPositiveFoldRatio,
        ['aggregate.scenarios.*.riskNormalized.positiveFolds'],
      ),
      gateCheck(
        'MINIMUM_EXPECTANCY_R',
        scenarios.every(({ riskNormalized }) => riskNormalized.available
          && riskNormalized.expectancyR >= policy.gates.minimumExpectancyR),
        scenarioRequirement('expectancyR', policy.gates.minimumExpectancyR).scenarios,
        policy.gates.minimumExpectancyR,
        ['aggregate.scenarios.*.riskNormalized.expectancyR'],
      ),
      gateCheck(
        'MINIMUM_PROFIT_FACTOR',
        scenarios.every(({ riskNormalized }) => riskNormalized.available
          && profitFactorPass(riskNormalized, policy.gates.minimumProfitFactor)),
        scenarios.map(({ scenarioId, riskNormalized }) => ({
          scenarioId,
          value: riskNormalized.available ? riskNormalized.profitFactor : null,
          status: riskNormalized.available ? riskNormalized.profitFactorStatus : 'UNAVAILABLE',
        })),
        policy.gates.minimumProfitFactor,
        ['aggregate.scenarios.*.riskNormalized.profitFactor'],
      ),
      gateCheck(
        'MAXIMUM_DRAWDOWN_R',
        scenarios.every(({ riskNormalized }) => riskNormalized.available
          && riskNormalized.maxDrawdownR <= policy.gates.maximumDrawdownR),
        scenarioRequirement('maxDrawdownR', policy.gates.maximumDrawdownR).scenarios,
        policy.gates.maximumDrawdownR,
        ['aggregate.scenarios.*.riskNormalized.maxDrawdownR'],
      ),
      gateCheck(
        'SEGMENT_STABILITY',
        scenarios.every(({ segmentStability: dimensions }) => dimensions.every(
          ({ stableRatio }) => stableRatio >= policy.gates.segmentStability.minimumStableSegmentRatio,
        )),
        scenarios.map(({ scenarioId, segmentStability: dimensions }) => ({
          scenarioId,
          dimensions: dimensions.map(({ dimension, stableRatio }) => ({ dimension, stableRatio })),
        })),
        policy.gates.segmentStability.minimumStableSegmentRatio,
        ['aggregate.scenarios.*.segmentStability'],
      ),
    );
  }
  const payload = {
    schemaVersion: WALK_FORWARD_REPORT_SCHEMA_VERSION,
    planHash: bundle.plan.planHash,
    runHash: bundle.run.runHash,
    candidate: bundle.plan.candidate,
    sourceDatasetHash: bundle.plan.sourceDataset.datasetHash,
    coreEvidence,
    folds,
    aggregate: { scenarios, costSensitivity },
    gate: { ok: checks.every(({ ok }) => ok), checks },
  };
  return { ...payload, reportHash: walkForwardReportHash(payload) };
}

function rawFileHash(file) {
  try {
    return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
  } catch (error) {
    throw new Error(`cannot read walk-forward report evidence ${file}: ${error.message}`);
  }
}

function verifyReportArchives(report, directory) {
  const root = resolve(text(directory, 'reportDirectory'));
  const coreEvidence = normalizeCoreEvidence(report.coreEvidence, report.runHash);
  for (const { file, fileHash } of coreEvidence.files) {
    if (rawFileHash(resolve(root, file)) !== fileHash) {
      throw new Error(`walk-forward Core archive hash mismatch: ${file}`);
    }
  }
  const archivedBundle = loadWalkForwardBundle(
    resolve(root, coreEvidence.runFile),
    resolve(root, coreEvidence.sourceDatasetFile),
  );
  if (report.folds.length !== archivedBundle.folds.length) {
    throw new Error('walk-forward report fold count does not match its archived Core bundle');
  }
  for (const [foldIndex, fold] of report.folds.entries()) {
    const archivedFold = archivedBundle.folds[foldIndex];
    for (const evidence of fold.executionEvidence) {
      for (const [file, expectedHash] of [
        [evidence.resultFile, evidence.resultHash],
        [evidence.resultMetaFile, evidence.resultMetaHash],
        [evidence.runtimeEvidenceFile, evidence.runtimeEvidenceHash],
      ]) {
        if (rawFileHash(resolve(root, file)) !== expectedHash) {
          throw new Error(`walk-forward execution archive hash mismatch: ${file}`);
        }
      }
      const payload = readBacktestPayload(root, evidence.resultFile);
      const summary = firstStrategySummary(payload, evidence.executionProfile.strategy);
      if (!summary) {
        throw new Error(`walk-forward execution archive has no strategy summary: ${evidence.resultFile}`);
      }
      const meta = readJson(resolve(root, evidence.resultMetaFile), 'walk-forward execution metadata');
      if (!Object.prototype.hasOwnProperty.call(meta, evidence.executionProfile.strategy)) {
        throw new Error(`walk-forward execution metadata has no strategy ${evidence.executionProfile.strategy}`);
      }
      const runtime = verifyExecutionRuntimeArchive(
        readJson(resolve(root, evidence.runtimeEvidenceFile), 'walk-forward runtime evidence'),
        {
          resultFile: resolve(root, evidence.resultFile),
          resultHash: evidence.resultHash,
          resultMetaHash: evidence.resultMetaHash,
          datasetHash: archivedFold.dataset.datasetHash,
          executionArtifactHash: archivedFold.executionArtifact.artifactHash,
          riskTraceHash: archivedFold.executionRiskTrace.traceHash,
          riskUnitRatio: evidence.riskUnitRatio,
          scenarioId: evidence.scenarioId,
          fee: evidence.fee,
        },
      );
      for (const [field, actual] of [
        ['freqtradeVersion', runtime.freqtradeVersion],
        ['configHash', runtime.configHash],
        ['adapterHash', runtime.adapterHash],
        ['executionProfile', runtime.executionProfile],
        ['executionProfileHash', runtime.executionProfileHash],
        ['riskTraceHash', runtime.riskTraceHash],
        ['riskUnitRatio', runtime.riskUnitRatio],
      ]) {
        if (!isDeepStrictEqual(evidence[field], actual)) {
          throw new Error(`walk-forward execution ${field} does not match archived runtime evidence`);
        }
      }
      const recomputed = {
        reconciliation: reconcileSignalBacktest(summary, archivedFold.executionArtifact),
        feeObservations: backtestFeeObservations(summary, evidence.fee),
        metrics: backtestMetrics(summary, {
          signalArtifact: archivedFold.executionArtifact,
          riskTrace: archivedFold.executionRiskTrace,
          marketDataset: archivedFold.dataset,
          riskUnitRatio: evidence.riskUnitRatio,
          accountEquity: evidence.executionProfile.dryRunWallet,
        }),
      };
      for (const field of ['reconciliation', 'feeObservations', 'metrics']) {
        if (!isDeepStrictEqual(evidence[field], recomputed[field])) {
          throw new Error(
            `walk-forward execution ${field} does not match archived result: ${evidence.resultFile}`,
          );
        }
      }
      if (rawFileHash(resolve(root, evidence.resultFile)) !== evidence.resultHash
        || rawFileHash(resolve(root, evidence.resultMetaFile)) !== evidence.resultMetaHash
        || rawFileHash(resolve(root, evidence.runtimeEvidenceFile)) !== evidence.runtimeEvidenceHash) {
        throw new Error(`walk-forward execution archive changed during verification: ${evidence.resultFile}`);
      }
    }
  }
  return archivedBundle;
}

export function verifyWalkForwardReport(value, bundle = null, reportDirectory = null) {
  const report = exactRecord(value, 'walk-forward report', [
    'schemaVersion', 'planHash', 'runHash', 'candidate', 'sourceDatasetHash',
    'coreEvidence', 'folds', 'aggregate', 'gate', 'reportHash',
  ]);
  if (report.schemaVersion !== WALK_FORWARD_REPORT_SCHEMA_VERSION) {
    throw new Error(`unsupported walk-forward report schema ${String(report.schemaVersion)}`);
  }
  hash(report.planHash, 'planHash');
  hash(report.runHash, 'runHash');
  hash(report.sourceDatasetHash, 'sourceDatasetHash');
  normalizeCandidate(report.candidate);
  normalizeCoreEvidence(report.coreEvidence, report.runHash);
  if (!Array.isArray(report.folds) || !report.folds.length) throw new Error('report folds must be a non-empty array');
  jsonRecord(report.aggregate, 'aggregate');
  const gate = exactRecord(report.gate, 'gate', ['ok', 'checks']);
  if (typeof gate.ok !== 'boolean' || !Array.isArray(gate.checks) || !gate.checks.length) {
    throw new Error('report gate is invalid');
  }
  for (const [index, value] of gate.checks.entries()) {
    const check = exactRecord(value, `gate.checks[${index}]`, [
      'code', 'ok', 'actual', 'required', 'evidenceRefs',
    ]);
    text(check.code, `gate.checks[${index}].code`);
    if (typeof check.ok !== 'boolean' || !Array.isArray(check.evidenceRefs)) {
      throw new Error(`gate.checks[${index}] is invalid`);
    }
  }
  if (gate.ok !== gate.checks.every(({ ok }) => ok)) throw new Error('report gate.ok does not match its checks');
  const reportHash = hash(report.reportHash, 'reportHash');
  const payload = Object.fromEntries(Object.entries(report).filter(([field]) => field !== 'reportHash'));
  const expectedHash = walkForwardReportHash(payload);
  if (reportHash !== expectedHash) throw new Error(`walk-forward report hash mismatch: expected ${expectedHash}`);
  if (!reportDirectory) {
    throw new Error('reportDirectory is required to verify walk-forward report archives');
  }
  const archivedBundle = verifyReportArchives(report, reportDirectory);
  if (bundle && (
    archivedBundle.plan.planHash !== bundle.plan.planHash
    || archivedBundle.run.runHash !== bundle.run.runHash
  )) throw new Error('walk-forward report archive does not match the supplied Core bundle');
  const recreated = createWalkForwardReport(
    archivedBundle,
    report.folds.map((fold) => fold.executionEvidence),
    report.coreEvidence,
  );
  if (!isDeepStrictEqual(recreated, report)) {
    throw new Error('walk-forward report does not match its verified Core bundle');
  }
  return report;
}

export function loadPromotableWalkForwardReport(reportFile, artifact) {
  const file = resolve(text(reportFile, 'walk_forward_report'));
  const reportDirectory = dirname(file);
  const report = verifyWalkForwardReport(readJson(file, 'walk-forward report'), null, reportDirectory);
  const expectedName = `walk-forward-report-${report.reportHash.replace(':', '-')}.json`;
  if (basename(file) !== expectedName) throw new Error(`walk-forward report file must equal ${expectedName}`);
  if (!report.gate.ok) throw new Error(`walk-forward report ${report.reportHash} did not pass its versioned policy`);
  if (!artifact?.identity) throw new Error('signal artifact is required for walk-forward report binding');
  const candidate = report.candidate;
  if (candidate.strategyId !== artifact.identity.strategyId
    || candidate.strategyVersion !== artifact.identity.strategyVersion
    || candidate.strategyRepoCommit !== artifact.identity.strategyRepoCommit
    || candidate.strategyConfigHash !== artifact.identity.strategyConfigHash
    || candidate.engineCommit !== artifact.identity.engineCommit
    || candidate.lifecycle !== artifact.strategyLifecycle
    || candidate.objectModel !== artifact.objectModel) {
    throw new Error('walk-forward report candidate does not match the Signal Artifact identity');
  }
  const policyCheck = report.gate.checks.find(({ code }) => code === 'VERSIONED_GATE_POLICY_PRESENT');
  if (!policyCheck?.ok) throw new Error('walk-forward report has no accepted versioned policy');
  const coreEvidence = normalizeCoreEvidence(report.coreEvidence, report.runHash);
  const bundle = loadWalkForwardBundle(
    resolve(reportDirectory, coreEvidence.runFile),
    resolve(reportDirectory, coreEvidence.sourceDatasetFile),
  );
  if (artifact.symbol !== bundle.plan.sourceDataset.source.symbol) {
    throw new Error('walk-forward report source dataset symbol does not match the Signal Artifact symbol');
  }
  if (artifact.baseTimeframe !== bundle.plan.baseTimeframe) {
    throw new Error('Signal Artifact base timeframe does not match the walk-forward plan');
  }
  assertOkxForwardSource(bundle.plan.sourceDataset.source, artifact.symbol, 'Signal Artifact forward source');
  if (!bundle.plan.walkForwardPolicy) throw new Error('walk-forward report archive has no versioned policy');
  return { file, report, walkForwardPolicy: bundle.plan.walkForwardPolicy };
}

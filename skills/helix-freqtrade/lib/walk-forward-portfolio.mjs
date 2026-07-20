import { readFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  WALK_FORWARD_PLAN_SCHEMA_VERSION,
  canonicalWalkForwardJson,
  loadPromotableWalkForwardReport,
  loadWalkForwardBundle,
  verifyWalkForwardPlan,
  verifyWalkForwardReport,
  walkForwardEvidenceHash,
  walkForwardPlanHash,
  walkForwardReportHash,
} from './walk-forward.mjs';
import { assertOkxForwardSource } from './forward-target.mjs';

export const WALK_FORWARD_PORTFOLIO_PLAN_SCHEMA_VERSION = 'helix.walk-forward-portfolio-plan/v1';
export const WALK_FORWARD_PORTFOLIO_REPORT_SCHEMA_VERSION = 'helix.walk-forward-portfolio-report/v1';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PERFORMANCE_CHECKS = new Set([
  'MINIMUM_TOTAL_TRADES',
  'MINIMUM_ACTIVE_FOLD_RATIO',
  'MINIMUM_POSITIVE_FOLD_RATIO',
  'MINIMUM_EXPECTANCY_R',
  'MINIMUM_PROFIT_FACTOR',
  'MAXIMUM_DRAWDOWN_R',
  'SEGMENT_STABILITY',
]);
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
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
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

function source(value, name) {
  const parsed = exactRecord(value, name, ['provider', 'market', 'instrumentId', 'symbol']);
  return {
    provider: text(parsed.provider, `${name}.provider`),
    market: text(parsed.market, `${name}.market`),
    instrumentId: text(parsed.instrumentId, `${name}.instrumentId`),
    symbol: text(parsed.symbol, `${name}.symbol`),
  };
}

function readJson(file, name) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${name} ${file}: ${error.message}`);
  }
}

function relativeArchiveFile(value, name, root) {
  const absolute = resolve(text(value, name));
  const archiveRoot = resolve(root);
  const path = relative(archiveRoot, absolute).split('\\').join('/');
  if (!path || path === '..' || path.startsWith('../')) {
    throw new Error(`${name} must be inside the portfolio report directory`);
  }
  return { absolute, path };
}

function normalizeMember(value, index) {
  const name = `members[${index}]`;
  const member = exactRecord(value, name, [
    'source', 'sourceDatasetHash', 'capturedThrough', 'planHash', 'runHash',
  ]);
  return {
    source: source(member.source, `${name}.source`),
    sourceDatasetHash: hash(member.sourceDatasetHash, `${name}.sourceDatasetHash`),
    capturedThrough: integer(member.capturedThrough, `${name}.capturedThrough`),
    planHash: hash(member.planHash, `${name}.planHash`),
    runHash: hash(member.runHash, `${name}.runHash`),
  };
}

function normalizePortfolioPlanPayload(value) {
  const plan = exactRecord(value, 'walk-forward portfolio plan payload', [
    'schemaVersion', 'mode', 'candidate', 'walkForwardPolicy', 'members', 'baseTimeframe',
    'requiredTimeframes', 'activationDecisionTime', 'warmupDurationMs', 'folds', 'executionScenarios',
  ]);
  if (plan.schemaVersion !== WALK_FORWARD_PORTFOLIO_PLAN_SCHEMA_VERSION) {
    throw new Error(`unsupported walk-forward portfolio plan schema ${String(plan.schemaVersion)}`);
  }
  if (plan.mode !== 'fixed_candidate_multi_symbol') {
    throw new Error('walk-forward portfolio plan mode must be fixed_candidate_multi_symbol');
  }
  if (!Array.isArray(plan.members) || plan.members.length < 2) {
    throw new Error('walk-forward portfolio plan must contain at least two members');
  }
  const members = plan.members.map(normalizeMember);
  if (new Set(members.map(({ source: memberSource }) => memberSource.symbol)).size !== members.length) {
    throw new Error('walk-forward portfolio plan contains duplicate symbols');
  }
  if (new Set(members.map(({ source: memberSource }) => memberSource.instrumentId)).size !== members.length) {
    throw new Error('walk-forward portfolio plan contains duplicate instrument ids');
  }
  if (new Set(members.map(({ sourceDatasetHash }) => sourceDatasetHash)).size !== members.length) {
    throw new Error('walk-forward portfolio plan contains duplicate source datasets');
  }
  if (new Set(members.map(({ planHash }) => planHash)).size !== members.length
    || new Set(members.map(({ runHash }) => runHash)).size !== members.length) {
    throw new Error('walk-forward portfolio plan contains duplicate child identities');
  }
  const representative = members[0];
  const childPayload = {
    schemaVersion: WALK_FORWARD_PLAN_SCHEMA_VERSION,
    mode: 'fixed_candidate',
    candidate: plan.candidate,
    walkForwardPolicy: plan.walkForwardPolicy,
    sourceDataset: {
      datasetHash: representative.sourceDatasetHash,
      source: representative.source,
      capturedThrough: representative.capturedThrough,
    },
    baseTimeframe: plan.baseTimeframe,
    requiredTimeframes: plan.requiredTimeframes,
    activationDecisionTime: plan.activationDecisionTime,
    warmupDurationMs: plan.warmupDurationMs,
    folds: plan.folds,
    executionScenarios: plan.executionScenarios,
  };
  const child = verifyWalkForwardPlan({
    ...childPayload,
    planHash: walkForwardPlanHash(childPayload),
  });
  const policy = child.walkForwardPolicy;
  if (policy?.schemaVersion !== 'helix.walk-forward-policy/v2' || !policy.gates.symbolStability) {
    throw new Error('walk-forward portfolio plan requires a V2 policy with symbol stability');
  }
  if (!isDeepStrictEqual(members.map(({ source: memberSource }) => memberSource), policy.gates.symbolStability.members)) {
    throw new Error('walk-forward portfolio plan members do not exactly match the policy symbol universe');
  }
  if (members.some(({ capturedThrough }) => (
    child.folds.some((fold) => fold.observationEndTime > capturedThrough)
  ))) throw new Error('walk-forward portfolio member does not cover every fold observation window');
  return {
    schemaVersion: WALK_FORWARD_PORTFOLIO_PLAN_SCHEMA_VERSION,
    mode: 'fixed_candidate_multi_symbol',
    candidate: child.candidate,
    walkForwardPolicy: policy,
    members,
    baseTimeframe: child.baseTimeframe,
    requiredTimeframes: child.requiredTimeframes,
    activationDecisionTime: child.activationDecisionTime,
    warmupDurationMs: child.warmupDurationMs,
    folds: child.folds,
    executionScenarios: child.executionScenarios,
  };
}

export function walkForwardPortfolioPlanHash(payload) {
  return walkForwardEvidenceHash(normalizePortfolioPlanPayload(payload));
}

export function verifyWalkForwardPortfolioPlan(value) {
  const plan = exactRecord(value, 'walk-forward portfolio plan', [
    'schemaVersion', 'mode', 'candidate', 'walkForwardPolicy', 'members', 'baseTimeframe',
    'requiredTimeframes', 'activationDecisionTime', 'warmupDurationMs', 'folds', 'executionScenarios',
    'planHash',
  ]);
  const planHash = hash(plan.planHash, 'planHash');
  const payload = normalizePortfolioPlanPayload(Object.fromEntries(
    Object.entries(plan).filter(([field]) => field !== 'planHash'),
  ));
  const expectedHash = walkForwardPortfolioPlanHash(payload);
  if (planHash !== expectedHash) throw new Error(`walk-forward portfolio plan hash mismatch: expected ${expectedHash}`);
  return { ...payload, planHash };
}

function loadMemberReport(fileValue, reportDirectory) {
  const { absolute, path } = relativeArchiveFile(fileValue, 'member report file', reportDirectory);
  const reportDirectoryValue = dirname(absolute);
  const report = verifyWalkForwardReport(
    readJson(absolute, 'walk-forward member report'),
    null,
    reportDirectoryValue,
  );
  const expectedName = `walk-forward-report-${report.reportHash.replace(':', '-')}.json`;
  if (basename(absolute) !== expectedName) throw new Error(`walk-forward member report file must equal ${expectedName}`);
  const coreEvidence = report.coreEvidence;
  const bundle = loadWalkForwardBundle(
    resolve(reportDirectoryValue, coreEvidence.runFile),
    resolve(reportDirectoryValue, coreEvidence.sourceDatasetFile),
  );
  return { file: absolute, reportFile: path, report, bundle };
}

function assertMemberMatchesPlan(member, loaded, portfolioPlan, index) {
  const { report, bundle } = loaded;
  if (report.planHash !== member.planHash
    || report.runHash !== member.runHash
    || report.sourceDatasetHash !== member.sourceDatasetHash
    || bundle.plan.planHash !== member.planHash
    || bundle.run.runHash !== member.runHash
    || bundle.plan.sourceDataset.datasetHash !== member.sourceDatasetHash
    || bundle.plan.sourceDataset.capturedThrough !== member.capturedThrough
    || !isDeepStrictEqual(bundle.plan.sourceDataset.source, member.source)) {
    throw new Error(`portfolio member ${index} report does not match its plan identity`);
  }
  if (!isDeepStrictEqual(report.candidate, portfolioPlan.candidate)) {
    throw new Error(`portfolio member ${index} Candidate identity mismatch`);
  }
  for (const field of [
    'candidate', 'walkForwardPolicy', 'baseTimeframe', 'requiredTimeframes', 'activationDecisionTime',
    'warmupDurationMs', 'folds', 'executionScenarios',
  ]) {
    const childValue = field === 'folds'
      ? bundle.plan.folds
      : bundle.plan[field];
    if (!isDeepStrictEqual(childValue, portfolioPlan[field])) {
      throw new Error(`portfolio member ${index} ${field} does not match the portfolio plan`);
    }
  }
}

function riskSummary(observations) {
  let totalR = 0;
  let grossProfitR = 0;
  let grossLossR = 0;
  for (const observation of observations) {
    totalR += observation.realizedR;
    if (observation.realizedR > 0) grossProfitR += observation.realizedR;
    if (observation.realizedR < 0) grossLossR += -observation.realizedR;
  }
  return {
    trades: observations.length,
    totalR,
    expectancyR: observations.length ? totalR / observations.length : null,
    grossProfitR,
    grossLossR,
    profitFactor: grossLossR > 0 ? grossProfitR / grossLossR : null,
    profitFactorStatus: grossLossR > 0
      ? 'AVAILABLE'
      : grossProfitR > 0 ? 'NO_LOSSES' : 'UNAVAILABLE',
  };
}

function profitFactorPass(summary, minimum) {
  return summary.profitFactorStatus === 'NO_LOSSES'
    || (summary.profitFactorStatus === 'AVAILABLE' && summary.profitFactor >= minimum);
}

function strategySegmentStability(policy, symbols, observations) {
  const knownDimensions = STRATEGY_SEGMENT_VALUES[policy.strategyId] || {};
  return policy.gates.segmentStability.dimensions.map((dimension) => {
    const values = knownDimensions[dimension];
    if (!values) throw new Error(`walkForwardPolicy uses unsupported segment dimension ${dimension}`);
    const segments = values.map((value) => {
      const summary = riskSummary(observations.filter(
        (observation) => observation.segments[dimension] === value,
      ));
      const drawdowns = symbols.flatMap((symbol) => {
        const dimensionSummary = symbol.segmentStability.find((item) => item.dimension === dimension);
        const segment = dimensionSummary?.segments.find((item) => item.value === value);
        return segment?.maxDrawdownR === null || segment?.maxDrawdownR === undefined
          ? []
          : [segment.maxDrawdownR];
      });
      const worstSymbolDrawdownR = drawdowns.length ? Math.max(...drawdowns) : null;
      const stable = summary.trades >= policy.gates.segmentStability.minimumTradesPerSegment
        && summary.expectancyR >= policy.gates.minimumExpectancyR
        && profitFactorPass(summary, policy.gates.minimumProfitFactor)
        && worstSymbolDrawdownR !== null
        && worstSymbolDrawdownR <= policy.gates.maximumDrawdownR;
      return { value, ...summary, worstSymbolDrawdownR, stable };
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

function memberChecks(report) {
  const symbolCheck = report.gate.checks.find(({ code }) => code === 'SYMBOL_STABILITY_GATE_SATISFIED');
  if (!symbolCheck || symbolCheck.ok) {
    throw new Error('V2 member report must require portfolio symbol-stability validation');
  }
  const integrity = report.gate.checks.filter(({ code }) => (
    code !== 'SYMBOL_STABILITY_GATE_SATISFIED' && !PERFORMANCE_CHECKS.has(code)
  ));
  const component = report.gate.checks.filter(({ code }) => code !== 'SYMBOL_STABILITY_GATE_SATISFIED');
  return {
    integrityOk: integrity.every(({ ok }) => ok),
    failedIntegrityChecks: integrity.filter(({ ok }) => !ok).map(({ code }) => code),
    stable: component.every(({ ok }) => ok),
    failedChecks: component.filter(({ ok }) => !ok).map(({ code }) => code),
  };
}

function executionEnvironment(loadedMembers) {
  const evidence = loadedMembers.flatMap(({ report }) => report.folds.flatMap(({ executionEvidence }) => executionEvidence));
  const versions = new Set(evidence.map(({ freqtradeVersion }) => freqtradeVersion));
  const adapters = new Set(evidence.map(({ adapterHash }) => adapterHash));
  const configs = new Set(evidence.map(({ configHash }) => configHash));
  if (versions.size !== 1 || adapters.size !== 1 || configs.size !== 1) {
    throw new Error('portfolio member reports must use one Freqtrade version, adapter, and execution config');
  }
  return {
    freqtradeVersion: evidence[0].freqtradeVersion,
    adapterHash: evidence[0].adapterHash,
    configHash: evidence[0].configHash,
  };
}

function scenarioAggregate(portfolioPlan, loadedMembers, memberStates, scenario) {
  const symbols = loadedMembers.map(({ report, bundle }, memberIndex) => {
    const reportScenario = report.aggregate.scenarios.find(({ scenarioId }) => scenarioId === scenario.id);
    if (!reportScenario) throw new Error(`portfolio member ${memberIndex} is missing scenario ${scenario.id}`);
    if (reportScenario.fee !== scenario.fee) {
      throw new Error(
        `portfolio member ${memberIndex} scenario ${scenario.id} fee mismatch: `
        + `${reportScenario.fee} != ${scenario.fee}`,
      );
    }
    if (!reportScenario.riskNormalized.available) {
      throw new Error(`portfolio member ${memberIndex} scenario ${scenario.id} has no R-normalized evidence`);
    }
    const foldTotals = report.folds.map((fold) => {
      const evidence = fold.executionEvidence.find(({ scenarioId }) => scenarioId === scenario.id);
      if (!evidence) throw new Error(`portfolio member ${memberIndex} fold is missing scenario ${scenario.id}`);
      return (evidence.metrics.riskNormalized.observations || [])
        .reduce((total, observation) => total + observation.realizedR, 0);
    });
    const state = memberStates[memberIndex];
    return {
      source: bundle.plan.sourceDataset.source,
      trades: reportScenario.riskNormalized.trades,
      activeFolds: reportScenario.riskNormalized.activeFolds,
      positiveFolds: reportScenario.riskNormalized.positiveFolds,
      expectancyR: reportScenario.riskNormalized.expectancyR,
      maxDrawdownR: reportScenario.riskNormalized.maxDrawdownR,
      grossProfitR: reportScenario.riskNormalized.grossProfitR,
      grossLossR: reportScenario.riskNormalized.grossLossR,
      profitFactor: reportScenario.riskNormalized.profitFactor,
      profitFactorStatus: reportScenario.riskNormalized.profitFactorStatus,
      foldTotalsR: foldTotals,
      stable: state.stable,
      failedChecks: state.failedChecks,
      segmentStability: reportScenario.segmentStability,
    };
  });
  const observations = loadedMembers.flatMap(({ report, bundle }) => {
    const reportScenario = report.aggregate.scenarios.find(({ scenarioId }) => scenarioId === scenario.id);
    return reportScenario.riskNormalized.observations.map((observation) => ({
      symbol: bundle.plan.sourceDataset.source.symbol,
      instrumentId: bundle.plan.sourceDataset.source.instrumentId,
      ...observation,
    }));
  }).sort((left, right) => (
    left.openTime - right.openTime
      || (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0)
      || (left.entrySignalId < right.entrySignalId ? -1 : left.entrySignalId > right.entrySignalId ? 1 : 0)
  ));
  const tradeKeys = observations.map(({ symbol, entrySignalId }) => canonicalWalkForwardJson([symbol, entrySignalId]));
  if (new Set(tradeKeys).size !== tradeKeys.length) {
    throw new Error(`portfolio scenario ${scenario.id} contains duplicate structured trade references`);
  }
  const pooled = riskSummary(observations);
  const symbolFoldCells = symbols.length * portfolioPlan.folds.length;
  const activeSymbolFolds = symbols.reduce((total, symbol) => total + symbol.activeFolds, 0);
  const positiveSymbolFolds = symbols.reduce((total, symbol) => total + symbol.positiveFolds, 0);
  const drawdowns = symbols.map(({ maxDrawdownR }) => maxDrawdownR).filter((value) => value !== null);
  return {
    scenarioId: scenario.id,
    fee: scenario.fee,
    symbolFoldCells,
    activeSymbolFolds,
    positiveSymbolFolds,
    pooled: { ...pooled, observations },
    worstSymbolDrawdownR: drawdowns.length ? Math.max(...drawdowns) : null,
    strategySegmentStability: strategySegmentStability(
      portfolioPlan.walkForwardPolicy,
      symbols,
      observations,
    ),
    symbols,
  };
}

function gateCheck(code, ok, actual, required, evidenceRefs) {
  return { code, ok, actual, required, evidenceRefs };
}

function buildPortfolioReport(portfolioPlan, loadedMembers) {
  const policy = portfolioPlan.walkForwardPolicy;
  const symbolGate = policy.gates.symbolStability;
  const memberStates = loadedMembers.map(({ report }) => memberChecks(report));
  const environment = executionEnvironment(loadedMembers);
  const scenarios = portfolioPlan.executionScenarios.map((scenario) => (
    scenarioAggregate(portfolioPlan, loadedMembers, memberStates, scenario)
  ));
  const base = scenarios.reduce((selected, scenario) => scenario.fee < selected.fee ? scenario : selected, scenarios[0]);
  const costSensitivity = scenarios.map((scenario) => ({
    scenarioId: scenario.scenarioId,
    fee: scenario.fee,
    totalRDeltaFromBase: scenario.pooled.totalR - base.pooled.totalR,
    expectancyRDeltaFromBase: scenario.pooled.expectancyR !== null && base.pooled.expectancyR !== null
      ? scenario.pooled.expectancyR - base.pooled.expectancyR
      : null,
  }));
  const stableSymbols = memberStates.filter(({ stable }) => stable).length;
  const stableSymbolRatio = stableSymbols / loadedMembers.length;
  const checks = [
    gateCheck('PORTFOLIO_PLAN_HASH_VALID', true, portfolioPlan.planHash, portfolioPlan.planHash, ['planHash']),
    gateCheck('MEMBER_ARCHIVES_VALID', true, loadedMembers.length, portfolioPlan.members.length, ['members']),
    gateCheck('IDENTITY_PIN_MATCH', true, portfolioPlan.candidate, portfolioPlan.candidate, ['candidate']),
    gateCheck('POLICY_SYMBOL_UNIVERSE_COVERED', true, portfolioPlan.members.map(({ source: value }) => value),
      symbolGate.members, ['members.*.source']),
    gateCheck('MEMBER_WINDOWS_AND_SCENARIOS_MATCH', true, true, true, ['portfolioPlan.folds', 'aggregate.scenarios']),
    gateCheck('EXECUTION_ENVIRONMENT_MATCH', true, environment, environment, ['members.*.report.folds.*.executionEvidence']),
    gateCheck('NO_DUPLICATE_TRADE_REFERENCES', true, true, true, ['aggregate.scenarios.*.pooled.observations']),
    gateCheck(
      'MEMBER_INTEGRITY_CHECKS',
      memberStates.every(({ integrityOk }) => integrityOk),
      memberStates.map((state, index) => ({
        symbol: portfolioPlan.members[index].source.symbol,
        failedChecks: state.failedIntegrityChecks,
      })),
      [],
      ['members.*.failedIntegrityChecks'],
    ),
    gateCheck(
      'MINIMUM_TOTAL_TRADES',
      scenarios.every(({ pooled }) => pooled.trades >= policy.gates.minimumTotalTrades),
      scenarios.map(({ scenarioId, pooled }) => ({ scenarioId, value: pooled.trades })),
      policy.gates.minimumTotalTrades,
      ['aggregate.scenarios.*.pooled.trades'],
    ),
    gateCheck(
      'MINIMUM_ACTIVE_FOLD_RATIO',
      scenarios.every(({ activeSymbolFolds, symbolFoldCells }) => (
        activeSymbolFolds / symbolFoldCells >= policy.gates.minimumActiveFoldRatio
      )),
      scenarios.map(({ scenarioId, activeSymbolFolds, symbolFoldCells }) => ({
        scenarioId, value: activeSymbolFolds / symbolFoldCells,
      })),
      policy.gates.minimumActiveFoldRatio,
      ['aggregate.scenarios.*.activeSymbolFolds'],
    ),
    gateCheck(
      'MINIMUM_POSITIVE_FOLD_RATIO',
      scenarios.every(({ positiveSymbolFolds, symbolFoldCells }) => (
        positiveSymbolFolds / symbolFoldCells >= policy.gates.minimumPositiveFoldRatio
      )),
      scenarios.map(({ scenarioId, positiveSymbolFolds, symbolFoldCells }) => ({
        scenarioId, value: positiveSymbolFolds / symbolFoldCells,
      })),
      policy.gates.minimumPositiveFoldRatio,
      ['aggregate.scenarios.*.positiveSymbolFolds'],
    ),
    gateCheck(
      'MINIMUM_EXPECTANCY_R',
      scenarios.every(({ pooled }) => pooled.expectancyR !== null
        && pooled.expectancyR >= policy.gates.minimumExpectancyR),
      scenarios.map(({ scenarioId, pooled }) => ({ scenarioId, value: pooled.expectancyR })),
      policy.gates.minimumExpectancyR,
      ['aggregate.scenarios.*.pooled.expectancyR'],
    ),
    gateCheck(
      'MINIMUM_PROFIT_FACTOR',
      scenarios.every(({ pooled }) => profitFactorPass(pooled, policy.gates.minimumProfitFactor)),
      scenarios.map(({ scenarioId, pooled }) => ({
        scenarioId, value: pooled.profitFactor, status: pooled.profitFactorStatus,
      })),
      policy.gates.minimumProfitFactor,
      ['aggregate.scenarios.*.pooled.profitFactor'],
    ),
    gateCheck(
      'MAXIMUM_DRAWDOWN_R',
      scenarios.every(({ worstSymbolDrawdownR }) => (
        worstSymbolDrawdownR === null || worstSymbolDrawdownR <= policy.gates.maximumDrawdownR
      )),
      scenarios.map(({ scenarioId, worstSymbolDrawdownR }) => ({ scenarioId, value: worstSymbolDrawdownR })),
      policy.gates.maximumDrawdownR,
      ['aggregate.scenarios.*.worstSymbolDrawdownR'],
    ),
    gateCheck(
      'SEGMENT_STABILITY',
      scenarios.every(({ strategySegmentStability: dimensions }) => dimensions.every(
        ({ stableRatio }) => stableRatio >= policy.gates.segmentStability.minimumStableSegmentRatio,
      )),
      scenarios.map(({ scenarioId, strategySegmentStability: dimensions }) => ({
        scenarioId,
        dimensions: dimensions.map(({ dimension, stableRatio }) => ({ dimension, stableRatio })),
      })),
      policy.gates.segmentStability.minimumStableSegmentRatio,
      ['aggregate.scenarios.*.strategySegmentStability'],
    ),
    gateCheck(
      'SYMBOL_STABILITY_GATE_SATISFIED',
      stableSymbolRatio >= symbolGate.minimumStableSymbolRatio,
      { stableSymbols, requiredSymbols: loadedMembers.length, stableRatio: stableSymbolRatio },
      symbolGate.minimumStableSymbolRatio,
      ['members.*.stable'],
    ),
  ];
  const members = loadedMembers.map(({ reportFile, report, bundle }, index) => ({
    source: bundle.plan.sourceDataset.source,
    sourceDatasetHash: report.sourceDatasetHash,
    planHash: report.planHash,
    runHash: report.runHash,
    reportHash: report.reportHash,
    reportFile,
    stable: memberStates[index].stable,
    failedChecks: memberStates[index].failedChecks,
  }));
  const payload = {
    schemaVersion: WALK_FORWARD_PORTFOLIO_REPORT_SCHEMA_VERSION,
    portfolioPlanFile: 'walk-forward-portfolio-plan.json',
    planHash: portfolioPlan.planHash,
    candidate: portfolioPlan.candidate,
    policyHash: portfolioPlan.walkForwardPolicy.policyHash,
    members,
    aggregate: {
      executionEnvironment: environment,
      scenarios,
      costSensitivity,
      stableSymbols,
      requiredSymbols: loadedMembers.length,
      stableSymbolRatio,
    },
    gate: { ok: checks.every(({ ok }) => ok), checks },
  };
  return { ...payload, reportHash: walkForwardReportHash(payload) };
}

export function createWalkForwardPortfolioReport(planValue, memberReportFiles, reportDirectory) {
  const portfolioPlan = verifyWalkForwardPortfolioPlan(planValue);
  if (!Array.isArray(memberReportFiles) || memberReportFiles.length !== portfolioPlan.members.length) {
    throw new Error('portfolio report must provide one archived report per policy member');
  }
  const loaded = memberReportFiles.map((file) => loadMemberReport(file, reportDirectory));
  const loadedBySymbol = new Map(loaded.map((member) => [member.bundle.plan.sourceDataset.source.symbol, member]));
  if (loadedBySymbol.size !== loaded.length) throw new Error('portfolio member reports contain duplicate symbols');
  const ordered = portfolioPlan.members.map((member, index) => {
    const loadedMember = loadedBySymbol.get(member.source.symbol);
    if (!loadedMember) throw new Error(`portfolio member report is missing ${member.source.symbol}`);
    assertMemberMatchesPlan(member, loadedMember, portfolioPlan, index);
    return loadedMember;
  });
  if (ordered.length !== loaded.length) throw new Error('portfolio member report is outside the policy universe');
  return buildPortfolioReport(portfolioPlan, ordered);
}

export function verifyWalkForwardPortfolioReport(value, reportDirectory = null) {
  const report = exactRecord(value, 'walk-forward portfolio report', [
    'schemaVersion', 'portfolioPlanFile', 'planHash', 'candidate', 'policyHash', 'members',
    'aggregate', 'gate', 'reportHash',
  ]);
  if (report.schemaVersion !== WALK_FORWARD_PORTFOLIO_REPORT_SCHEMA_VERSION) {
    throw new Error(`unsupported walk-forward portfolio report schema ${String(report.schemaVersion)}`);
  }
  if (report.portfolioPlanFile !== 'walk-forward-portfolio-plan.json') {
    throw new Error('portfolioPlanFile must equal walk-forward-portfolio-plan.json');
  }
  hash(report.planHash, 'planHash');
  hash(report.policyHash, 'policyHash');
  if (!Array.isArray(report.members) || report.members.length < 2) {
    throw new Error('portfolio report members must be a non-empty multi-symbol array');
  }
  if (!reportDirectory) throw new Error('reportDirectory is required to verify portfolio report archives');
  const reportHash = hash(report.reportHash, 'reportHash');
  const payload = Object.fromEntries(Object.entries(report).filter(([field]) => field !== 'reportHash'));
  const expectedHash = walkForwardReportHash(payload);
  if (reportHash !== expectedHash) throw new Error(`walk-forward portfolio report hash mismatch: expected ${expectedHash}`);
  const root = resolve(text(reportDirectory, 'reportDirectory'));
  const portfolioPlan = verifyWalkForwardPortfolioPlan(readJson(
    resolve(root, report.portfolioPlanFile),
    'walk-forward portfolio plan',
  ));
  if (portfolioPlan.planHash !== report.planHash) {
    throw new Error('portfolio report does not match its archived plan hash');
  }
  const memberFiles = report.members.map((member, index) => {
    const record = exactRecord(member, `members[${index}]`, [
      'source', 'sourceDatasetHash', 'planHash', 'runHash', 'reportHash', 'reportFile',
      'stable', 'failedChecks',
    ]);
    const expectedMemberHash = hash(record.reportHash, `members[${index}].reportHash`);
    const expectedPath = `members/${expectedMemberHash.replace(':', '-')}/walk-forward-report-${expectedMemberHash.replace(':', '-')}.json`;
    if (record.reportFile !== expectedPath) {
      throw new Error(`members[${index}].reportFile must equal ${expectedPath}`);
    }
    return resolve(root, record.reportFile);
  });
  const recreated = createWalkForwardPortfolioReport(portfolioPlan, memberFiles, root);
  if (!isDeepStrictEqual(recreated, report)) {
    throw new Error('walk-forward portfolio report does not match its verified member archives');
  }
  return report;
}

export function loadPromotableWalkForwardPortfolioReport(reportFile, artifact) {
  const file = resolve(text(reportFile, 'walk_forward_report'));
  const reportDirectory = dirname(file);
  const report = verifyWalkForwardPortfolioReport(readJson(file, 'walk-forward portfolio report'), reportDirectory);
  const expectedName = `walk-forward-portfolio-report-${report.reportHash.replace(':', '-')}.json`;
  if (basename(file) !== expectedName) throw new Error(`walk-forward portfolio report file must equal ${expectedName}`);
  if (!report.gate.ok) throw new Error(`walk-forward portfolio report ${report.reportHash} did not pass its policy`);
  if (!artifact?.identity || typeof artifact.symbol !== 'string') {
    throw new Error('Signal Artifact identity and symbol are required for portfolio report binding');
  }
  const candidate = report.candidate;
  if (candidate.strategyId !== artifact.identity.strategyId
    || candidate.strategyVersion !== artifact.identity.strategyVersion
    || candidate.strategyRepoCommit !== artifact.identity.strategyRepoCommit
    || candidate.strategyConfigHash !== artifact.identity.strategyConfigHash
    || candidate.engineCommit !== artifact.identity.engineCommit
    || candidate.lifecycle !== artifact.strategyLifecycle
    || candidate.objectModel !== artifact.objectModel) {
    throw new Error('walk-forward portfolio report candidate does not match the Signal Artifact identity');
  }
  const member = report.members.find(({ source: memberSource }) => memberSource.symbol === artifact.symbol);
  if (!member) throw new Error('Signal Artifact symbol is outside the walk-forward portfolio policy universe');
  if (!member.stable) {
    throw new Error('Signal Artifact symbol did not pass its single-symbol walk-forward gates');
  }
  const plan = verifyWalkForwardPortfolioPlan(readJson(
    resolve(reportDirectory, report.portfolioPlanFile),
    'walk-forward portfolio plan',
  ));
  if (artifact.baseTimeframe !== plan.baseTimeframe) {
    throw new Error('Signal Artifact base timeframe does not match the walk-forward portfolio plan');
  }
  assertOkxForwardSource(member.source, artifact.symbol, 'Signal Artifact forward source');
  return { file, report, walkForwardPolicy: plan.walkForwardPolicy, member };
}

function walkForwardEvidenceFile(reportFile) {
  const file = resolve(text(reportFile, 'walk_forward_report'));
  return { file, reportDirectory: dirname(file), payload: readJson(file, 'walk-forward report') };
}

function singleReportArchiveFiles(file, report) {
  const root = dirname(file);
  return [
    file,
    ...report.coreEvidence.files.map(({ file: archiveFile }) => resolve(root, archiveFile)),
    ...report.folds.flatMap(({ executionEvidence }) => executionEvidence.flatMap((evidence) => [
      resolve(root, evidence.resultFile),
      resolve(root, evidence.resultMetaFile),
      resolve(root, evidence.runtimeEvidenceFile),
    ])),
  ];
}

function reportArchiveFiles(file, report) {
  if (report.schemaVersion !== WALK_FORWARD_PORTFOLIO_REPORT_SCHEMA_VERSION) {
    return singleReportArchiveFiles(file, report);
  }
  const root = dirname(file);
  return [
    file,
    resolve(root, report.portfolioPlanFile),
    ...report.members.flatMap(({ reportFile }) => {
      const memberFile = resolve(root, reportFile);
      return singleReportArchiveFiles(memberFile, readJson(memberFile, 'walk-forward member report'));
    }),
  ];
}

export function verifyWalkForwardEvidenceReportFile(reportFile) {
  const { file, reportDirectory, payload } = walkForwardEvidenceFile(reportFile);
  const portfolio = payload?.schemaVersion === WALK_FORWARD_PORTFOLIO_REPORT_SCHEMA_VERSION;
  const report = portfolio
    ? verifyWalkForwardPortfolioReport(payload, reportDirectory)
    : verifyWalkForwardReport(payload, null, reportDirectory);
  const prefix = portfolio ? 'walk-forward-portfolio-report' : 'walk-forward-report';
  const expectedName = `${prefix}-${report.reportHash.replace(':', '-')}.json`;
  if (basename(file) !== expectedName) throw new Error(`walk-forward report file must equal ${expectedName}`);
  const archiveFiles = [...new Set(reportArchiveFiles(file, report))].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  return { file, report, archiveFiles };
}

export function loadPromotableWalkForwardEvidence(reportFile, artifact) {
  const { file, payload } = walkForwardEvidenceFile(reportFile);
  return payload?.schemaVersion === WALK_FORWARD_PORTFOLIO_REPORT_SCHEMA_VERSION
    ? loadPromotableWalkForwardPortfolioReport(file, artifact)
    : loadPromotableWalkForwardReport(file, artifact);
}

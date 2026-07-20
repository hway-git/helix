import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  STRATEGY_WALK_FORWARD_PLAN_SCHEMA_VERSION,
  STRATEGY_WALK_FORWARD_RUN_SCHEMA_VERSION,
  type StrategyHistoricalDataset,
  type StrategyHistoricalDatasetSource,
  type StrategyHistoricalRiskTrace,
  type StrategyLifecycle,
  type StrategyManifestIdentity,
  type StrategyObjectModel,
  type StrategyRepositorySnapshot,
  type StrategySignalArtifact,
  type StrategySignalRecord,
  type StrategyWalkForwardCandidate,
  type StrategyWalkForwardCensoredEntry,
  type StrategyWalkForwardExecutionScenario,
  type StrategyWalkForwardFold,
  type StrategyWalkForwardPlan,
  type StrategyWalkForwardPlanPayload,
  type StrategyWalkForwardPolicy,
  type StrategyWalkForwardRun,
  type StrategyWalkForwardRunFold,
  type StrategyWalkForwardRunPayload,
} from '@helix/contracts/strategy'
import { assertStrategyHistoricalDataset, createStrategyHistoricalDataset } from './historical-dataset'
import {
  assertStrategyHistoricalRiskTrace,
  createStrategyHistoricalRiskTrace,
} from './historical-risk'
import { createStrategyDecisionIdentityFromSnapshot } from './repository'
import {
  assertStrategySignalArtifact,
  createStrategySignalArtifact,
  strategyTimeframeMilliseconds,
} from './signal-artifact'
import { createStrategyEvaluator, evaluateStrategyDataset } from './strategy-evaluator'

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const EXECUTION_SCENARIO_ID_PATTERN = /^[a-z][a-z0-9_-]*$/
const LIFECYCLES = new Set<StrategyLifecycle>([
  'proposal', 'backtested', 'shadow', 'canary', 'production', 'deprecated',
])
const OBJECT_MODELS = new Set<StrategyObjectModel>(['PRICE_EVENT', 'TRADE_THESIS'])
const POSITION_SIDES = new Set(['LONG', 'SHORT'])
const STRATEGY_SEGMENT_DIMENSIONS: Record<string, ReadonlySet<string>> = {
  helix_scalp_hunter: new Set(['scalp.event_type', 'scalp.grade', 'scalp.regime.type']),
  helix_swing_hunter: new Set(['swing.stage', 'swing.context.state', 'swing.context.bias']),
}

type UnknownRecord = Record<string, unknown>

function exactRecord(value: unknown, name: string, fields: readonly string[]): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${fields.join(', ')}`)
  }
  return value as UnknownRecord
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty trimmed string`)
  }
  return value
}

function integer(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value as number
}

function hash(value: unknown, name: string) {
  const normalized = text(value, name)
  if (!HASH_PATTERN.test(normalized)) throw new Error(`${name} must be a SHA-256 hash`)
  return normalized
}

function commit(value: unknown, name: string) {
  const normalized = text(value, name)
  if (!COMMIT_PATTERN.test(normalized)) throw new Error(`${name} must be a full Git commit`)
  return normalized
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('walk-forward canonical numbers must be finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const source = value as UnknownRecord
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(',')}}`
  }
  throw new Error(`unsupported walk-forward value ${typeof value}`)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as UnknownRecord)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function source(value: unknown, name: string): StrategyHistoricalDatasetSource {
  const parsed = exactRecord(value, name, ['provider', 'market', 'instrumentId', 'symbol'])
  return {
    provider: text(parsed.provider, `${name}.provider`),
    market: text(parsed.market, `${name}.market`),
    instrumentId: text(parsed.instrumentId, `${name}.instrumentId`),
    symbol: text(parsed.symbol, `${name}.symbol`),
  }
}

function candidate(value: unknown): StrategyWalkForwardCandidate {
  const parsed = exactRecord(value, 'candidate', [
    'strategyId',
    'strategyVersion',
    'strategyRepoCommit',
    'strategyConfigHash',
    'engineCommit',
    'lifecycle',
    'objectModel',
  ])
  const lifecycle = text(parsed.lifecycle, 'candidate.lifecycle') as StrategyLifecycle
  const objectModel = text(parsed.objectModel, 'candidate.objectModel') as StrategyObjectModel
  if (!LIFECYCLES.has(lifecycle)) throw new Error('candidate.lifecycle is invalid')
  if (!OBJECT_MODELS.has(objectModel)) throw new Error('candidate.objectModel is invalid')
  return {
    strategyId: text(parsed.strategyId, 'candidate.strategyId'),
    strategyVersion: text(parsed.strategyVersion, 'candidate.strategyVersion'),
    strategyRepoCommit: commit(parsed.strategyRepoCommit, 'candidate.strategyRepoCommit'),
    strategyConfigHash: hash(parsed.strategyConfigHash, 'candidate.strategyConfigHash'),
    engineCommit: commit(parsed.engineCommit, 'candidate.engineCommit'),
    lifecycle,
    objectModel,
  }
}

function normalizeFold(value: unknown, index: number, baseDuration: number): StrategyWalkForwardFold {
  const name = `folds[${index}]`
  const parsed = exactRecord(value, name, [
    'sequence', 'entryWindowStartTime', 'entryWindowEndTime', 'observationEndTime',
  ])
  const fold = {
    sequence: integer(parsed.sequence, `${name}.sequence`),
    entryWindowStartTime: integer(parsed.entryWindowStartTime, `${name}.entryWindowStartTime`),
    entryWindowEndTime: integer(parsed.entryWindowEndTime, `${name}.entryWindowEndTime`),
    observationEndTime: integer(parsed.observationEndTime, `${name}.observationEndTime`),
  }
  if (fold.sequence !== index) throw new Error(`${name}.sequence must equal ${index}`)
  if (fold.entryWindowStartTime % baseDuration !== 0
    || fold.entryWindowEndTime % baseDuration !== 0
    || fold.observationEndTime % baseDuration !== 0) {
    throw new Error(`${name} boundaries must align to baseTimeframe`)
  }
  if (fold.entryWindowEndTime <= fold.entryWindowStartTime) {
    throw new Error(`${name} entry window must be a non-empty half-open interval`)
  }
  if (fold.observationEndTime < fold.entryWindowEndTime) {
    throw new Error(`${name}.observationEndTime must not precede entryWindowEndTime`)
  }
  return fold
}

function executionScenario(value: unknown, index: number): StrategyWalkForwardExecutionScenario {
  const name = `executionScenarios[${index}]`
  const parsed = exactRecord(value, name, ['id', 'fee'])
  const id = text(parsed.id, `${name}.id`)
  if (!EXECUTION_SCENARIO_ID_PATTERN.test(id)) {
    throw new Error(`${name}.id must use lowercase letters, numbers, underscores, or hyphens`)
  }
  if (typeof parsed.fee !== 'number' || !Number.isFinite(parsed.fee) || parsed.fee < 0) {
    throw new Error(`${name}.fee must be a non-negative finite number`)
  }
  return { id, fee: parsed.fee }
}

function policyInteger(value: unknown, name: string, minimum: number) {
  const normalized = integer(value, name)
  if (normalized < minimum) throw new Error(`${name} must be at least ${minimum}`)
  return normalized
}

function policyNumber(value: unknown, name: string, minimum?: number, maximum?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite`)
  if (minimum !== undefined && value < minimum) throw new Error(`${name} must be at least ${minimum}`)
  if (maximum !== undefined && value > maximum) throw new Error(`${name} must be at most ${maximum}`)
  return value
}

export function assertStrategyWalkForwardPolicy(value: unknown): StrategyWalkForwardPolicy {
  const policy = exactRecord(value, 'walkForwardPolicy', [
    'schemaVersion', 'id', 'version', 'strategyId', 'strategyVersion', 'policyPath', 'policyHash', 'plan', 'gates',
  ])
  const schemaVersion = text(policy.schemaVersion, 'walkForwardPolicy.schemaVersion')
  if (schemaVersion !== 'helix.walk-forward-policy/v1'
    && schemaVersion !== 'helix.walk-forward-policy/v2') {
    throw new Error('walkForwardPolicy.schemaVersion is unsupported')
  }
  const hasSymbolStability = schemaVersion === 'helix.walk-forward-policy/v2'
  const id = text(policy.id, 'walkForwardPolicy.id')
  const version = text(policy.version, 'walkForwardPolicy.version')
  if (!/^[a-z][a-z0-9_]*_v[0-9]+$/.test(id)) throw new Error('walkForwardPolicy.id is invalid')
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('walkForwardPolicy.version is invalid')
  }
  const policyPath = text(policy.policyPath, 'walkForwardPolicy.policyPath')
  if (!/^strategies\/[^/]+\/validation\/[a-z][a-z0-9-]*\.yaml$/.test(policyPath)) {
    throw new Error('walkForwardPolicy.policyPath is invalid')
  }
  const plan = exactRecord(policy.plan, 'walkForwardPolicy.plan', [
    'foldCount', 'entryWindowMs', 'observationTailMs', 'riskUnitRatio', 'referenceAccountEquity',
    'executionScenarios',
  ])
  if (!Array.isArray(plan.executionScenarios) || plan.executionScenarios.length < 2) {
    throw new Error('walkForwardPolicy.plan.executionScenarios must contain at least two scenarios')
  }
  const executionScenarios = plan.executionScenarios.map((scenario, index) => executionScenario(scenario, index))
  if (new Set(executionScenarios.map(({ id: scenarioId }) => scenarioId)).size !== executionScenarios.length) {
    throw new Error('walkForwardPolicy.plan.executionScenarios contains duplicate ids')
  }
  const minimumFee = Math.min(...executionScenarios.map(({ fee }) => fee))
  if (!executionScenarios.some(({ fee }) => fee > minimumFee)) {
    throw new Error('walkForwardPolicy.plan.executionScenarios must include a stressed fee')
  }
  const gates = exactRecord(policy.gates, 'walkForwardPolicy.gates', [
    'censoredEntries',
    'minimumTotalTrades',
    'minimumActiveFoldRatio',
    'minimumPositiveFoldRatio',
    'minimumExpectancyR',
    'minimumProfitFactor',
    'maximumDrawdownR',
    'segmentStability',
    ...(hasSymbolStability ? ['symbolStability'] : []),
  ])
  if (gates.censoredEntries !== 'reject') throw new Error('walkForwardPolicy.gates.censoredEntries must be reject')
  const segment = exactRecord(gates.segmentStability, 'walkForwardPolicy.gates.segmentStability', [
    'dimensions', 'minimumTradesPerSegment', 'minimumStableSegmentRatio',
  ])
  if (!Array.isArray(segment.dimensions) || segment.dimensions.length === 0) {
    throw new Error('walkForwardPolicy.gates.segmentStability.dimensions must be non-empty')
  }
  const dimensions = segment.dimensions.map((dimension, index) => {
    const normalized = text(dimension, `walkForwardPolicy.gates.segmentStability.dimensions[${index}]`)
    const strategyId = text(policy.strategyId, 'walkForwardPolicy.strategyId')
    if (!STRATEGY_SEGMENT_DIMENSIONS[strategyId]?.has(normalized)) {
      throw new Error(`walkForwardPolicy.gates.segmentStability.dimensions[${index}] is invalid`)
    }
    return normalized
  })
  if (new Set(dimensions).size !== dimensions.length) {
    throw new Error('walkForwardPolicy.gates.segmentStability.dimensions contains duplicates')
  }
  let symbolStability: StrategyWalkForwardPolicy['gates']['symbolStability']
  if (hasSymbolStability) {
    const symbolGate = exactRecord(
      gates.symbolStability,
      'walkForwardPolicy.gates.symbolStability',
      ['members', 'minimumStableSymbolRatio'],
    )
    if (!Array.isArray(symbolGate.members) || symbolGate.members.length < 2) {
      throw new Error('walkForwardPolicy.gates.symbolStability.members must contain at least two symbols')
    }
    const members = symbolGate.members.map((member, index) => (
      source(member, `walkForwardPolicy.gates.symbolStability.members[${index}]`)
    ))
    if (new Set(members.map(({ symbol }) => symbol)).size !== members.length) {
      throw new Error('walkForwardPolicy.gates.symbolStability.members contains duplicate symbols')
    }
    if (new Set(members.map(({ instrumentId }) => instrumentId)).size !== members.length) {
      throw new Error('walkForwardPolicy.gates.symbolStability.members contains duplicate instrument ids')
    }
    const ordered = [...members].sort((left, right) => (
      left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1
        : left.instrumentId < right.instrumentId ? -1 : left.instrumentId > right.instrumentId ? 1 : 0
    ))
    if (!isDeepStrictEqual(members, ordered)) {
      throw new Error('walkForwardPolicy.gates.symbolStability.members must be ordered by symbol and instrumentId')
    }
    symbolStability = {
      members,
      minimumStableSymbolRatio: policyNumber(
        symbolGate.minimumStableSymbolRatio,
        'walkForwardPolicy.gates.symbolStability.minimumStableSymbolRatio',
        0,
        1,
      ),
    }
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
      minimumTotalTrades: policyInteger(
        gates.minimumTotalTrades,
        'walkForwardPolicy.gates.minimumTotalTrades',
        1,
      ),
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
  }
}

function assertPlanMatchesPolicy(
  policy: StrategyWalkForwardPolicy,
  candidateValue: StrategyWalkForwardCandidate,
  folds: readonly StrategyWalkForwardFold[],
  executionScenarios: readonly StrategyWalkForwardExecutionScenario[],
) {
  if (policy.strategyId !== candidateValue.strategyId || policy.strategyVersion !== candidateValue.strategyVersion) {
    throw new Error('walkForwardPolicy strategy identity does not match candidate')
  }
  if (folds.length !== policy.plan.foldCount) {
    throw new Error('walk-forward fold count does not match walkForwardPolicy')
  }
  for (const [index, fold] of folds.entries()) {
    if (fold.entryWindowEndTime - fold.entryWindowStartTime !== policy.plan.entryWindowMs) {
      throw new Error(`folds[${index}] entry window does not match walkForwardPolicy`)
    }
    if (fold.observationEndTime - fold.entryWindowEndTime !== policy.plan.observationTailMs) {
      throw new Error(`folds[${index}] observation tail does not match walkForwardPolicy`)
    }
  }
  if (!isDeepStrictEqual(executionScenarios, policy.plan.executionScenarios)) {
    throw new Error('executionScenarios do not match walkForwardPolicy')
  }
}

function normalizePlanPayload(value: unknown): StrategyWalkForwardPlanPayload {
  const hasPolicy = Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'walkForwardPolicy'))
  const parsed = exactRecord(value, 'walk-forward plan payload', [
    'schemaVersion',
    'mode',
    'candidate',
    ...(hasPolicy ? ['walkForwardPolicy'] : []),
    'sourceDataset',
    'baseTimeframe',
    'requiredTimeframes',
    'activationDecisionTime',
    'warmupDurationMs',
    'folds',
    'executionScenarios',
  ])
  if (parsed.schemaVersion !== STRATEGY_WALK_FORWARD_PLAN_SCHEMA_VERSION) {
    throw new Error(`unsupported walk-forward plan schema ${String(parsed.schemaVersion)}`)
  }
  if (parsed.mode !== 'fixed_candidate') throw new Error('walk-forward plan mode must be fixed_candidate')
  const sourceDatasetRecord = exactRecord(parsed.sourceDataset, 'sourceDataset', [
    'datasetHash', 'source', 'capturedThrough',
  ])
  const { timeframe: baseTimeframe, duration: baseDuration } = strategyTimeframeMilliseconds(parsed.baseTimeframe)
  if (!Array.isArray(parsed.requiredTimeframes) || parsed.requiredTimeframes.length === 0) {
    throw new Error('requiredTimeframes must be a non-empty array')
  }
  const requiredTimeframes = parsed.requiredTimeframes.map((item, index) => {
    const timeframe = text(item, `requiredTimeframes[${index}]`)
    strategyTimeframeMilliseconds(timeframe)
    return timeframe
  })
  if (new Set(requiredTimeframes).size !== requiredTimeframes.length) {
    throw new Error('requiredTimeframes must not contain duplicates')
  }
  if (!requiredTimeframes.includes(baseTimeframe)) throw new Error('requiredTimeframes must include baseTimeframe')
  const activationDecisionTime = integer(parsed.activationDecisionTime, 'activationDecisionTime')
  const warmupDurationMs = integer(parsed.warmupDurationMs, 'warmupDurationMs')
  if (activationDecisionTime % baseDuration !== 0) {
    throw new Error('activationDecisionTime must align to baseTimeframe')
  }
  if (activationDecisionTime < baseDuration) {
    throw new Error('activationDecisionTime must follow at least one base candle')
  }
  if (warmupDurationMs > activationDecisionTime) {
    throw new Error('source dataset does not have enough time before activationDecisionTime for warm-up')
  }
  if (!Array.isArray(parsed.folds) || parsed.folds.length === 0) {
    throw new Error('folds must be a non-empty array')
  }
  const folds = parsed.folds.map((item, index) => normalizeFold(item, index, baseDuration))
  for (const [index, fold] of folds.entries()) {
    if (fold.entryWindowStartTime < activationDecisionTime) {
      throw new Error(`folds[${index}].entryWindowStartTime must not precede activationDecisionTime`)
    }
    if (index > 0 && fold.entryWindowStartTime !== folds[index - 1]!.entryWindowEndTime) {
      throw new Error(`folds[${index}] must touch the previous half-open entry window without a gap or overlap`)
    }
    if (index > 0 && fold.observationEndTime < folds[index - 1]!.observationEndTime) {
      throw new Error(`folds[${index}].observationEndTime must not move backward`)
    }
  }
  const capturedThrough = integer(sourceDatasetRecord.capturedThrough, 'sourceDataset.capturedThrough')
  if (folds.some((fold) => fold.observationEndTime > capturedThrough)) {
    throw new Error('fold observationEndTime must not exceed sourceDataset.capturedThrough')
  }
  if (!Array.isArray(parsed.executionScenarios) || parsed.executionScenarios.length < 2) {
    throw new Error('executionScenarios must contain at least two explicit fee scenarios')
  }
  const executionScenarios = parsed.executionScenarios.map(executionScenario)
  if (new Set(executionScenarios.map(({ id }) => id)).size !== executionScenarios.length) {
    throw new Error('executionScenarios must not contain duplicate ids')
  }
  const minimumFee = Math.min(...executionScenarios.map(({ fee }) => fee))
  if (!executionScenarios.some(({ fee }) => fee > minimumFee)) {
    throw new Error('executionScenarios must include at least one higher fee')
  }
  const normalizedCandidate = candidate(parsed.candidate)
  const walkForwardPolicy = hasPolicy ? assertStrategyWalkForwardPolicy(parsed.walkForwardPolicy) : undefined
  if (walkForwardPolicy) assertPlanMatchesPolicy(walkForwardPolicy, normalizedCandidate, folds, executionScenarios)
  return {
    schemaVersion: STRATEGY_WALK_FORWARD_PLAN_SCHEMA_VERSION,
    mode: 'fixed_candidate',
    candidate: normalizedCandidate,
    ...(walkForwardPolicy ? { walkForwardPolicy } : {}),
    sourceDataset: {
      datasetHash: hash(sourceDatasetRecord.datasetHash, 'sourceDataset.datasetHash'),
      source: source(sourceDatasetRecord.source, 'sourceDataset.source'),
      capturedThrough,
    },
    baseTimeframe,
    requiredTimeframes,
    activationDecisionTime,
    warmupDurationMs,
    folds,
    executionScenarios,
  }
}

export function strategyWalkForwardPlanHash(payload: StrategyWalkForwardPlanPayload) {
  const normalized = normalizePlanPayload(payload)
  return `sha256:${createHash('sha256').update(canonicalJson(normalized)).digest('hex')}`
}

export function createStrategyWalkForwardPlanArtifact(payload: StrategyWalkForwardPlanPayload): StrategyWalkForwardPlan {
  const normalized = normalizePlanPayload(payload)
  return deepFreeze({ ...normalized, planHash: strategyWalkForwardPlanHash(normalized) })
}

export function assertStrategyWalkForwardPlan(value: unknown): StrategyWalkForwardPlan {
  const hasPolicy = Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'walkForwardPolicy'))
  const parsed = exactRecord(value, 'walk-forward plan', [
    'schemaVersion',
    'mode',
    'candidate',
    ...(hasPolicy ? ['walkForwardPolicy'] : []),
    'sourceDataset',
    'baseTimeframe',
    'requiredTimeframes',
    'activationDecisionTime',
    'warmupDurationMs',
    'folds',
    'executionScenarios',
    'planHash',
  ])
  const planHash = hash(parsed.planHash, 'planHash')
  const payload = normalizePlanPayload({
    schemaVersion: parsed.schemaVersion,
    mode: parsed.mode,
    candidate: parsed.candidate,
    ...(hasPolicy ? { walkForwardPolicy: parsed.walkForwardPolicy } : {}),
    sourceDataset: parsed.sourceDataset,
    baseTimeframe: parsed.baseTimeframe,
    requiredTimeframes: parsed.requiredTimeframes,
    activationDecisionTime: parsed.activationDecisionTime,
    warmupDurationMs: parsed.warmupDurationMs,
    folds: parsed.folds,
    executionScenarios: parsed.executionScenarios,
  })
  const expectedHash = strategyWalkForwardPlanHash(payload)
  if (planHash !== expectedHash) throw new Error(`walk-forward plan hash mismatch: expected ${expectedHash}`)
  return deepFreeze({ ...payload, planHash })
}

function candidateFromSnapshot(
  snapshot: StrategyRepositorySnapshot,
  strategyId: string,
  marketDataSnapshotId: string,
): { candidate: StrategyWalkForwardCandidate; manifest: StrategyManifestIdentity } {
  const manifest = snapshot.manifests.find((item) => item.id === strategyId)
  if (!manifest) throw new Error(`unknown strategy ${strategyId}`)
  const identity = createStrategyDecisionIdentityFromSnapshot(snapshot, { strategyId, marketDataSnapshotId })
  return {
    candidate: {
      strategyId: identity.strategyId,
      strategyVersion: identity.strategyVersion,
      strategyRepoCommit: identity.strategyRepoCommit,
      strategyConfigHash: identity.strategyConfigHash,
      engineCommit: identity.engineCommit,
      lifecycle: manifest.lifecycle,
      objectModel: manifest.objectModel,
    },
    manifest,
  }
}

export function createStrategyWalkForwardPlan(options: {
  snapshot: StrategyRepositorySnapshot
  strategyId: string
  dataset: StrategyHistoricalDataset
  activationDecisionTime: number
  folds: readonly Omit<StrategyWalkForwardFold, 'sequence'>[]
  executionScenarios: readonly StrategyWalkForwardExecutionScenario[]
}) {
  const dataset = assertStrategyHistoricalDataset(options.dataset)
  const pinned = candidateFromSnapshot(options.snapshot, options.strategyId, dataset.datasetHash)
  const evaluator = createStrategyEvaluator(pinned.manifest)
  return createStrategyWalkForwardPlanArtifact({
    schemaVersion: STRATEGY_WALK_FORWARD_PLAN_SCHEMA_VERSION,
    mode: 'fixed_candidate',
    candidate: pinned.candidate,
    ...(pinned.manifest.walkForwardPolicy ? { walkForwardPolicy: pinned.manifest.walkForwardPolicy } : {}),
    sourceDataset: {
      datasetHash: dataset.datasetHash,
      source: dataset.source,
      capturedThrough: dataset.capturedThrough,
    },
    baseTimeframe: evaluator.baseTimeframe,
    requiredTimeframes: evaluator.requiredTimeframes,
    activationDecisionTime: options.activationDecisionTime,
    warmupDurationMs: evaluator.warmupDurationMs,
    folds: options.folds.map((fold, sequence) => ({ sequence, ...fold })),
    executionScenarios: options.executionScenarios,
  })
}

export function createStrategyWalkForwardPlanFromPolicy(options: {
  snapshot: StrategyRepositorySnapshot
  strategyId: string
  dataset: StrategyHistoricalDataset
  activationDecisionTime: number
}) {
  const manifest = options.snapshot.manifests.find((candidateValue) => candidateValue.id === options.strategyId)
  if (!manifest) throw new Error(`unknown strategy ${options.strategyId}`)
  const policy = manifest.walkForwardPolicy
  if (!policy) throw new Error(`strategy ${options.strategyId} has no versioned walk-forward policy`)
  const folds = Array.from({ length: policy.plan.foldCount }, (_, index) => {
    const entryWindowStartTime = options.activationDecisionTime + index * policy.plan.entryWindowMs
    const entryWindowEndTime = entryWindowStartTime + policy.plan.entryWindowMs
    return {
      entryWindowStartTime,
      entryWindowEndTime,
      observationEndTime: entryWindowEndTime + policy.plan.observationTailMs,
    }
  })
  return createStrategyWalkForwardPlan({
    ...options,
    folds,
    executionScenarios: policy.plan.executionScenarios,
  })
}

function runtimeContext(
  planValue: StrategyWalkForwardPlan,
  datasetValue: StrategyHistoricalDataset,
  snapshot: StrategyRepositorySnapshot,
) {
  const plan = assertStrategyWalkForwardPlan(planValue)
  const dataset = assertStrategyHistoricalDataset(datasetValue)
  if (dataset.datasetHash !== plan.sourceDataset.datasetHash
    || dataset.capturedThrough !== plan.sourceDataset.capturedThrough
    || !isDeepStrictEqual(dataset.source, plan.sourceDataset.source)) {
    throw new Error('walk-forward source dataset does not match the precommitted plan')
  }
  const pinned = candidateFromSnapshot(snapshot, plan.candidate.strategyId, dataset.datasetHash)
  if (!isDeepStrictEqual(pinned.candidate, plan.candidate)) {
    throw new Error('walk-forward candidate identity changed after plan creation')
  }
  if (!isDeepStrictEqual(pinned.manifest.walkForwardPolicy ?? undefined, plan.walkForwardPolicy)) {
    throw new Error('walk-forward policy changed after plan creation')
  }
  const evaluator = createStrategyEvaluator(pinned.manifest)
  if (evaluator.baseTimeframe !== plan.baseTimeframe
    || evaluator.warmupDurationMs !== plan.warmupDurationMs
    || !isDeepStrictEqual(evaluator.requiredTimeframes, plan.requiredTimeframes)) {
    throw new Error('walk-forward evaluator parameters do not match the precommitted plan')
  }
  return { plan, dataset, manifest: pinned.manifest }
}

export function assertStrategyWalkForwardCandidateSnapshot(
  planValue: StrategyWalkForwardPlan,
  snapshot: StrategyRepositorySnapshot,
) {
  const plan = assertStrategyWalkForwardPlan(planValue)
  const pinned = candidateFromSnapshot(snapshot, plan.candidate.strategyId, plan.sourceDataset.datasetHash)
  if (!isDeepStrictEqual(pinned.candidate, plan.candidate)) {
    throw new Error('walk-forward candidate identity changed after plan creation')
  }
  if (!isDeepStrictEqual(pinned.manifest.walkForwardPolicy ?? undefined, plan.walkForwardPolicy)) {
    throw new Error('walk-forward policy changed after plan creation')
  }
  const evaluator = createStrategyEvaluator(pinned.manifest)
  if (evaluator.baseTimeframe !== plan.baseTimeframe
    || evaluator.warmupDurationMs !== plan.warmupDurationMs
    || !isDeepStrictEqual(evaluator.requiredTimeframes, plan.requiredTimeframes)) {
    throw new Error('walk-forward evaluator parameters changed after plan creation')
  }
}

function sourcePrefix(
  sourceDataset: StrategyHistoricalDataset,
  plan: StrategyWalkForwardPlan,
  fold: StrategyWalkForwardFold,
) {
  const warmupStart = plan.activationDecisionTime - plan.warmupDurationMs
  const timeframes = Object.fromEntries(plan.requiredTimeframes.map((timeframe) => {
    const sourceCandles = sourceDataset.timeframes[timeframe]
    if (!sourceCandles) throw new Error(`walk-forward source is missing timeframe ${timeframe}`)
    const { duration } = strategyTimeframeMilliseconds(timeframe)
    const firstOpen = Math.floor(warmupStart / duration) * duration
    const lastClose = Math.floor(fold.observationEndTime / duration) * duration
    const lastOpen = lastClose - duration
    const candles = sourceCandles.filter((candle) => candle.time >= firstOpen && candle.time <= lastOpen)
    if (!candles.length || candles[0]!.time !== firstOpen) {
      throw new Error(`walk-forward fold ${fold.sequence} does not cover ${timeframe} common warm-up start ${firstOpen}`)
    }
    if (candles.at(-1)!.time !== lastOpen) {
      throw new Error(`walk-forward fold ${fold.sequence} does not cover ${timeframe} observation end ${lastClose}`)
    }
    return [timeframe, candles]
  }))
  return createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: sourceDataset.source,
    capturedThrough: fold.observationEndTime,
    timeframes,
  })
}

export function createStrategyWalkForwardExecutionCohort(options: {
  decisionArtifact: StrategySignalArtifact
  decisionRiskTrace: StrategyHistoricalRiskTrace
  fold: StrategyWalkForwardFold
}) {
  const artifact = assertStrategySignalArtifact(options.decisionArtifact)
  const decisionRiskTrace = assertStrategyHistoricalRiskTrace(options.decisionRiskTrace, artifact)
  const { duration } = strategyTimeframeMilliseconds(artifact.baseTimeframe)
  const fold = normalizeFold(options.fold, options.fold.sequence, duration)
  if (artifact.marketData.lastCandleCloseTime !== fold.observationEndTime) {
    throw new Error('decision artifact must end exactly at fold observationEndTime')
  }
  const selectedSignals: StrategySignalRecord[] = []
  const tradeIds: string[] = []
  const censoredEntries: StrategyWalkForwardCensoredEntry[] = []
  let openEntry: StrategySignalRecord | undefined
  let entriesInWindow = 0

  for (const signal of artifact.signals) {
    if (signal.action === 'ENTER') {
      openEntry = signal
      if (signal.decisionTime >= fold.entryWindowStartTime
        && signal.decisionTime < fold.entryWindowEndTime) entriesInWindow += 1
      continue
    }
    if (!openEntry) throw new Error('decision artifact EXIT is missing its ENTER')
    if (openEntry.decisionTime >= fold.entryWindowStartTime
      && openEntry.decisionTime < fold.entryWindowEndTime) {
      if (signal.decisionTime < fold.observationEndTime) {
        tradeIds.push(openEntry.signalId)
        selectedSignals.push(openEntry, signal)
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
        })
      }
    }
    openEntry = undefined
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
    })
  }
  const executionArtifact = createStrategySignalArtifact({
    schemaVersion: 'helix.signal-artifact/v1',
    identity: artifact.identity,
    strategyLifecycle: artifact.strategyLifecycle,
    objectModel: artifact.objectModel,
    symbol: artifact.symbol,
    baseTimeframe: artifact.baseTimeframe,
    marketData: artifact.marketData,
    signals: selectedSignals.map((signal, sequence) => ({ ...signal, sequence })),
  })
  const selectedEntryIds = new Set(tradeIds)
  const executionRiskTrace = createStrategyHistoricalRiskTrace({
    schemaVersion: 'helix.historical-risk-trace/v1',
    signalArtifactHash: executionArtifact.artifactHash,
    entries: decisionRiskTrace.entries.filter((entry) => selectedEntryIds.has(entry.entrySignalId)),
  }, executionArtifact)
  return deepFreeze({
    executionArtifact,
    executionRiskTrace,
    tradeIds,
    censoredEntries,
    entriesInWindow,
  })
}

function fileName(value: unknown, name: string) {
  const normalized = text(value, name)
  if (normalized.includes('/') || normalized.includes('\\') || normalized === '.' || normalized === '..') {
    throw new Error(`${name} must be a file name without a directory`)
  }
  return normalized
}

function jsonRecord(value: unknown, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  canonicalJson(value)
  return value as Readonly<Record<string, unknown>>
}

function censoredEntry(value: unknown, index: number): StrategyWalkForwardCensoredEntry {
  const name = `censoredEntries[${index}]`
  const parsed = exactRecord(value, name, [
    'tradeId',
    'entrySignalId',
    'decisionId',
    'object',
    'side',
    'sourceCandleOpenTime',
    'decisionTime',
    'reason',
  ])
  const object = exactRecord(parsed.object, `${name}.object`, ['model', 'id'])
  const model = text(object.model, `${name}.object.model`) as StrategyObjectModel
  const side = text(parsed.side, `${name}.side`) as StrategyWalkForwardCensoredEntry['side']
  if (!OBJECT_MODELS.has(model)) throw new Error(`${name}.object.model is invalid`)
  if (!POSITION_SIDES.has(side)) throw new Error(`${name}.side is invalid`)
  if (parsed.reason !== 'NO_EXIT_BY_OBSERVATION_END'
    && parsed.reason !== 'EXIT_AT_OBSERVATION_END') throw new Error(`${name}.reason is invalid`)
  const tradeId = text(parsed.tradeId, `${name}.tradeId`)
  const entrySignalId = text(parsed.entrySignalId, `${name}.entrySignalId`)
  if (tradeId !== entrySignalId) throw new Error(`${name}.tradeId must equal entrySignalId`)
  return {
    tradeId,
    entrySignalId,
    decisionId: text(parsed.decisionId, `${name}.decisionId`),
    object: { model, id: text(object.id, `${name}.object.id`) },
    side,
    sourceCandleOpenTime: integer(parsed.sourceCandleOpenTime, `${name}.sourceCandleOpenTime`),
    decisionTime: integer(parsed.decisionTime, `${name}.decisionTime`),
    reason: parsed.reason,
  }
}

function normalizeRunFold(value: unknown, index: number): StrategyWalkForwardRunFold {
  const name = `folds[${index}]`
  const parsed = exactRecord(value, name, [
    'sequence',
    'entryWindowStartTime',
    'entryWindowEndTime',
    'observationEndTime',
    'datasetFile',
    'datasetHash',
    'decisionArtifactFile',
    'decisionArtifactHash',
    'decisionRiskTraceFile',
    'decisionRiskTraceHash',
    'replayArtifactFile',
    'replayArtifactHash',
    'executionArtifactFile',
    'executionArtifactHash',
    'executionRiskTraceFile',
    'executionRiskTraceHash',
    'tradeIds',
    'censoredEntries',
    'statistics',
  ])
  const sequence = integer(parsed.sequence, `${name}.sequence`)
  if (sequence !== index) throw new Error(`${name}.sequence must equal ${index}`)
  const entryWindowStartTime = integer(parsed.entryWindowStartTime, `${name}.entryWindowStartTime`)
  const entryWindowEndTime = integer(parsed.entryWindowEndTime, `${name}.entryWindowEndTime`)
  const observationEndTime = integer(parsed.observationEndTime, `${name}.observationEndTime`)
  if (entryWindowEndTime <= entryWindowStartTime) throw new Error(`${name} entry window must be non-empty`)
  if (observationEndTime < entryWindowEndTime) throw new Error(`${name}.observationEndTime is too early`)
  if (!Array.isArray(parsed.tradeIds)) throw new Error(`${name}.tradeIds must be an array`)
  const tradeIds = parsed.tradeIds.map((item, tradeIndex) => text(item, `${name}.tradeIds[${tradeIndex}]`))
  if (new Set(tradeIds).size !== tradeIds.length) throw new Error(`${name}.tradeIds must not contain duplicates`)
  if (!Array.isArray(parsed.censoredEntries)) throw new Error(`${name}.censoredEntries must be an array`)
  const censoredEntries = parsed.censoredEntries.map(censoredEntry)
  const censoredIds = censoredEntries.map(({ tradeId }) => tradeId)
  if (new Set(censoredIds).size !== censoredIds.length) {
    throw new Error(`${name}.censoredEntries must not contain duplicate trade ids`)
  }
  if (censoredIds.some((tradeId) => tradeIds.includes(tradeId))) {
    throw new Error(`${name} cannot mark a completed trade as censored`)
  }
  const statisticsSource = exactRecord(parsed.statistics, `${name}.statistics`, [
    'decisionSignals', 'entriesInWindow', 'completedTrades', 'censoredEntries', 'evaluator',
  ])
  const statistics = {
    decisionSignals: integer(statisticsSource.decisionSignals, `${name}.statistics.decisionSignals`),
    entriesInWindow: integer(statisticsSource.entriesInWindow, `${name}.statistics.entriesInWindow`),
    completedTrades: integer(statisticsSource.completedTrades, `${name}.statistics.completedTrades`),
    censoredEntries: integer(statisticsSource.censoredEntries, `${name}.statistics.censoredEntries`),
    evaluator: jsonRecord(statisticsSource.evaluator, `${name}.statistics.evaluator`),
  }
  if (statistics.completedTrades !== tradeIds.length
    || statistics.censoredEntries !== censoredEntries.length
    || statistics.entriesInWindow !== tradeIds.length + censoredEntries.length) {
    throw new Error(`${name}.statistics does not match its execution cohort`)
  }
  const decisionArtifactHash = hash(parsed.decisionArtifactHash, `${name}.decisionArtifactHash`)
  const replayArtifactHash = hash(parsed.replayArtifactHash, `${name}.replayArtifactHash`)
  if (decisionArtifactHash !== replayArtifactHash) {
    throw new Error(`${name} decision and replay artifact hashes must match`)
  }
  const prefix = `fold-${String(sequence).padStart(3, '0')}`
  const fold = {
    sequence,
    entryWindowStartTime,
    entryWindowEndTime,
    observationEndTime,
    datasetFile: fileName(parsed.datasetFile, `${name}.datasetFile`),
    datasetHash: hash(parsed.datasetHash, `${name}.datasetHash`),
    decisionArtifactFile: fileName(parsed.decisionArtifactFile, `${name}.decisionArtifactFile`),
    decisionArtifactHash,
    decisionRiskTraceFile: fileName(parsed.decisionRiskTraceFile, `${name}.decisionRiskTraceFile`),
    decisionRiskTraceHash: hash(parsed.decisionRiskTraceHash, `${name}.decisionRiskTraceHash`),
    replayArtifactFile: fileName(parsed.replayArtifactFile, `${name}.replayArtifactFile`),
    replayArtifactHash,
    executionArtifactFile: fileName(parsed.executionArtifactFile, `${name}.executionArtifactFile`),
    executionArtifactHash: hash(parsed.executionArtifactHash, `${name}.executionArtifactHash`),
    executionRiskTraceFile: fileName(parsed.executionRiskTraceFile, `${name}.executionRiskTraceFile`),
    executionRiskTraceHash: hash(parsed.executionRiskTraceHash, `${name}.executionRiskTraceHash`),
    tradeIds,
    censoredEntries,
    statistics,
  }
  const expectedFiles = {
    datasetFile: `${prefix}-dataset.json`,
    decisionArtifactFile: `${prefix}-decision-artifact.json`,
    decisionRiskTraceFile: `${prefix}-decision-risk-trace.json`,
    replayArtifactFile: `${prefix}-replay-artifact.json`,
    executionArtifactFile: `${prefix}-execution-artifact.json`,
    executionRiskTraceFile: `${prefix}-execution-risk-trace.json`,
  }
  for (const [field, expected] of Object.entries(expectedFiles)) {
    if (fold[field as keyof typeof expectedFiles] !== expected) {
      throw new Error(`${name}.${field} must equal ${expected}`)
    }
  }
  return fold
}

function normalizeRunPayload(value: unknown): StrategyWalkForwardRunPayload {
  const parsed = exactRecord(value, 'walk-forward run payload', [
    'schemaVersion', 'planFile', 'planHash', 'folds',
  ])
  if (parsed.schemaVersion !== STRATEGY_WALK_FORWARD_RUN_SCHEMA_VERSION) {
    throw new Error(`unsupported walk-forward run schema ${String(parsed.schemaVersion)}`)
  }
  const planFile = fileName(parsed.planFile, 'planFile')
  if (planFile !== 'walk-forward-plan.json') throw new Error('planFile must equal walk-forward-plan.json')
  if (!Array.isArray(parsed.folds) || parsed.folds.length === 0) {
    throw new Error('run folds must be a non-empty array')
  }
  const folds = parsed.folds.map(normalizeRunFold)
  for (let index = 1; index < folds.length; index += 1) {
    if (folds[index]!.entryWindowStartTime !== folds[index - 1]!.entryWindowEndTime) {
      throw new Error(`folds[${index}] must touch the previous half-open entry window without a gap or overlap`)
    }
  }
  return {
    schemaVersion: STRATEGY_WALK_FORWARD_RUN_SCHEMA_VERSION,
    planFile,
    planHash: hash(parsed.planHash, 'planHash'),
    folds,
  }
}

export function strategyWalkForwardRunHash(payload: StrategyWalkForwardRunPayload) {
  const normalized = normalizeRunPayload(payload)
  return `sha256:${createHash('sha256').update(canonicalJson(normalized)).digest('hex')}`
}

export function createStrategyWalkForwardRunArtifact(payload: StrategyWalkForwardRunPayload): StrategyWalkForwardRun {
  const normalized = normalizeRunPayload(payload)
  return deepFreeze({ ...normalized, runHash: strategyWalkForwardRunHash(normalized) })
}

export function assertStrategyWalkForwardRun(value: unknown): StrategyWalkForwardRun {
  const parsed = exactRecord(value, 'walk-forward run', [
    'schemaVersion', 'planFile', 'planHash', 'folds', 'runHash',
  ])
  const runHash = hash(parsed.runHash, 'runHash')
  const payload = normalizeRunPayload({
    schemaVersion: parsed.schemaVersion,
    planFile: parsed.planFile,
    planHash: parsed.planHash,
    folds: parsed.folds,
  })
  const expectedHash = strategyWalkForwardRunHash(payload)
  if (runHash !== expectedHash) throw new Error(`walk-forward run hash mismatch: expected ${expectedHash}`)
  return deepFreeze({ ...payload, runHash })
}

export function runStrategyWalkForward(options: {
  plan: StrategyWalkForwardPlan
  snapshot: StrategyRepositorySnapshot
  dataset: StrategyHistoricalDataset
}) {
  const context = runtimeContext(options.plan, options.dataset, options.snapshot)
  const files: Array<{
    dataset: StrategyHistoricalDataset
    decisionArtifact: StrategySignalArtifact
    decisionRiskTrace: StrategyHistoricalRiskTrace
    replayArtifact: StrategySignalArtifact
    executionArtifact: StrategySignalArtifact
    executionRiskTrace: StrategyHistoricalRiskTrace
  }> = []
  const folds = context.plan.folds.map((fold) => {
    const dataset = sourcePrefix(context.dataset, context.plan, fold)
    const identity = createStrategyDecisionIdentityFromSnapshot(options.snapshot, {
      strategyId: context.plan.candidate.strategyId,
      marketDataSnapshotId: dataset.datasetHash,
    })
    const first = evaluateStrategyDataset({
      manifest: context.manifest,
      dataset,
      identity,
      firstDecisionTime: context.plan.activationDecisionTime,
    })
    const replay = evaluateStrategyDataset({
      manifest: context.manifest,
      dataset,
      identity,
      firstDecisionTime: context.plan.activationDecisionTime,
    })
    if (!isDeepStrictEqual(first, replay)) {
      throw new Error(`walk-forward fold ${fold.sequence} replay is non-deterministic`)
    }
    const cohort = createStrategyWalkForwardExecutionCohort({
      decisionArtifact: first.artifact,
      decisionRiskTrace: first.riskTrace,
      fold,
    })
    files.push({
      dataset,
      decisionArtifact: first.artifact,
      decisionRiskTrace: first.riskTrace,
      replayArtifact: replay.artifact,
      executionArtifact: cohort.executionArtifact,
      executionRiskTrace: cohort.executionRiskTrace,
    })
    const prefix = `fold-${String(fold.sequence).padStart(3, '0')}`
    return {
      ...fold,
      datasetFile: `${prefix}-dataset.json`,
      datasetHash: dataset.datasetHash,
      decisionArtifactFile: `${prefix}-decision-artifact.json`,
      decisionArtifactHash: first.artifact.artifactHash,
      decisionRiskTraceFile: `${prefix}-decision-risk-trace.json`,
      decisionRiskTraceHash: first.riskTrace.traceHash,
      replayArtifactFile: `${prefix}-replay-artifact.json`,
      replayArtifactHash: replay.artifact.artifactHash,
      executionArtifactFile: `${prefix}-execution-artifact.json`,
      executionArtifactHash: cohort.executionArtifact.artifactHash,
      executionRiskTraceFile: `${prefix}-execution-risk-trace.json`,
      executionRiskTraceHash: cohort.executionRiskTrace.traceHash,
      tradeIds: cohort.tradeIds,
      censoredEntries: cohort.censoredEntries,
      statistics: {
        decisionSignals: first.artifact.signals.length,
        entriesInWindow: cohort.entriesInWindow,
        completedTrades: cohort.tradeIds.length,
        censoredEntries: cohort.censoredEntries.length,
        evaluator: first.statistics,
      },
    }
  })
  const run = createStrategyWalkForwardRunArtifact({
    schemaVersion: STRATEGY_WALK_FORWARD_RUN_SCHEMA_VERSION,
    planFile: 'walk-forward-plan.json',
    planHash: context.plan.planHash,
    folds,
  })
  return deepFreeze({ run, files })
}

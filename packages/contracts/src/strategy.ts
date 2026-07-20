export type StrategyFamily = 'scalp' | 'swing'
export type StrategyLifecycle = 'proposal' | 'backtested' | 'shadow' | 'canary' | 'production' | 'deprecated'
export type StrategyObjectModel = 'PRICE_EVENT' | 'TRADE_THESIS'
export type EngineCapabilityKind = 'component' | 'policy'

export type GitRevisionIdentity = {
  commit: string
  dirty: boolean
}

export type StrategyTimeframeIdentity = {
  role: string
  timeframe: string
}

export type StrategyWalkForwardPolicy = {
  schemaVersion: 'helix.walk-forward-policy/v1' | 'helix.walk-forward-policy/v2'
  id: string
  version: string
  strategyId: string
  strategyVersion: string
  policyPath: string
  policyHash: string
  plan: {
    foldCount: number
    entryWindowMs: number
    observationTailMs: number
    riskUnitRatio: number
    referenceAccountEquity: number
    executionScenarios: StrategyWalkForwardExecutionScenario[]
  }
  gates: {
    censoredEntries: 'reject'
    minimumTotalTrades: number
    minimumActiveFoldRatio: number
    minimumPositiveFoldRatio: number
    minimumExpectancyR: number
    minimumProfitFactor: number
    maximumDrawdownR: number
    segmentStability: {
      dimensions: string[]
      minimumTradesPerSegment: number
      minimumStableSegmentRatio: number
    }
    symbolStability?: {
      members: StrategyHistoricalDatasetSource[]
      minimumStableSymbolRatio: number
    }
  }
}

export type StrategyManifestIdentity = {
  schemaVersion: 'helix.strategy/v1'
  id: string
  name: string
  family: StrategyFamily
  version: string
  lifecycle: StrategyLifecycle
  objectModel: StrategyObjectModel
  timeframes: StrategyTimeframeIdentity[]
  manifestPath: string
  configHash: string
  requiredEngineCapabilities: string[]
  capabilityConfigurations: Record<string, unknown>
  reasonCodes: string[]
  walkForwardPolicy?: StrategyWalkForwardPolicy | null
}

export type EngineCapabilityIdentity = {
  id: string
  kind: EngineCapabilityKind
  family: StrategyFamily
  requiresConfiguration: boolean
}

export type StrategyEngineCompatibility = {
  strategyId: string
  engineCommit: string
  compatible: boolean
  required: string[]
  available: string[]
  missing: string[]
  unconfigured: string[]
  invalidConfiguration: string[]
}

export type StrategyRepositorySnapshot = {
  ok: boolean
  source: 'local-git'
  repository: GitRevisionIdentity | null
  engine: GitRevisionIdentity | null
  engineCapabilities: EngineCapabilityIdentity[]
  manifests: StrategyManifestIdentity[]
  compatibility: StrategyEngineCompatibility[]
  fetchedAt: number
  errors: string[]
}

export type StrategyDecisionIdentity = {
  strategyId: string
  strategyVersion: string
  strategyRepoCommit: string
  strategyConfigHash: string
  engineCommit: string
  marketDataSnapshotId: string
}

export const STRATEGY_SIGNAL_ARTIFACT_SCHEMA_VERSION = 'helix.signal-artifact/v1' as const
export const STRATEGY_SIGNAL_ACTIONS = ['ENTER', 'EXIT'] as const
export const STRATEGY_POSITION_SIDES = ['LONG', 'SHORT'] as const

export type StrategySignalAction = typeof STRATEGY_SIGNAL_ACTIONS[number]
export type StrategyPositionSide = typeof STRATEGY_POSITION_SIDES[number]

export type StrategySignalObjectReference = Readonly<{
  model: StrategyObjectModel
  id: string
}>

export type StrategySignalRecord = Readonly<{
  sequence: number
  signalId: string
  decisionId: string
  object: StrategySignalObjectReference
  action: StrategySignalAction
  side: StrategyPositionSide
  sourceCandleOpenTime: number
  decisionTime: number
  reasonCodes: readonly string[]
}>

export type StrategySignalArtifactMarketData = Readonly<{
  firstCandleOpenTime: number
  lastCandleCloseTime: number
}>

export type StrategySignalArtifactPayload = Readonly<{
  schemaVersion: typeof STRATEGY_SIGNAL_ARTIFACT_SCHEMA_VERSION
  identity: Readonly<StrategyDecisionIdentity>
  strategyLifecycle: StrategyLifecycle
  objectModel: StrategyObjectModel
  symbol: string
  baseTimeframe: string
  marketData: StrategySignalArtifactMarketData
  signals: readonly StrategySignalRecord[]
}>

export type StrategySignalArtifact = StrategySignalArtifactPayload & Readonly<{
  artifactHash: string
}>

export const STRATEGY_HISTORICAL_RISK_TRACE_SCHEMA_VERSION = 'helix.historical-risk-trace/v1' as const

type StrategyHistoricalRiskTraceEntryCommon = Readonly<{
  entrySignalId: string
  side: StrategyPositionSide
  entryPrice: Readonly<{
    source: 'DECISION_CANDLE_CLOSE'
    price: number
  }>
  initialStop: number
  initialTarget: number
  riskDistance: number
  riskR: number
}>

export type StrategyHistoricalScalpRiskTraceEntry = StrategyHistoricalRiskTraceEntryCommon & Readonly<{
  family: 'scalp'
  object: Readonly<{
    model: 'PRICE_EVENT'
    id: string
  }>
  scalp: Readonly<{
    eventType: ScalpPriceEventType
    grade: ScalpGrade
    regime: Readonly<{
      id: string
      type: ScalpMarketRegimeType
    }>
  }>
}>

export type StrategyHistoricalSwingRiskTraceEntry = StrategyHistoricalRiskTraceEntryCommon & Readonly<{
  family: 'swing'
  object: Readonly<{
    model: 'TRADE_THESIS'
    id: string
  }>
  swing: Readonly<{
    stage: SwingExecutionStage
    context: Readonly<{
      id: string
      state: SwingDailyMarketState
      bias: SwingContextBias
    }>
  }>
}>

export type StrategyHistoricalRiskTraceEntry =
  | StrategyHistoricalScalpRiskTraceEntry
  | StrategyHistoricalSwingRiskTraceEntry

export type StrategyHistoricalRiskTracePayload = Readonly<{
  schemaVersion: typeof STRATEGY_HISTORICAL_RISK_TRACE_SCHEMA_VERSION
  signalArtifactHash: string
  entries: readonly StrategyHistoricalRiskTraceEntry[]
}>

export type StrategyHistoricalRiskTrace = StrategyHistoricalRiskTracePayload & Readonly<{
  traceHash: string
}>

export const STRATEGY_SIGNAL_BATCH_SCHEMA_VERSION = 'helix.signal-batch/v2' as const

export type StrategySignalRiskIntent = Readonly<{
  entryPrice: number
  initialStop: number
  initialTarget: number
  riskDistance: number
  riskR: number
  riskUnitRatio: number
}>

export type StrategySignalPosition = Readonly<{
  object: StrategySignalObjectReference
  side: StrategyPositionSide
  entrySignalId: string
}>

export type StrategySignalBatchPayload = Readonly<{
  schemaVersion: typeof STRATEGY_SIGNAL_BATCH_SCHEMA_VERSION
  deploymentHash: string
  batchSequence: number
  previousBatchHash: string | null
  previousDecisionStateHash: string | null
  evaluatorStateHash: string
  decisionStateHash: string
  identity: Readonly<StrategyDecisionIdentity>
  strategyLifecycle: StrategyLifecycle
  objectModel: StrategyObjectModel
  symbol: string
  baseTimeframe: string
  positionBefore: StrategySignalPosition | null
  positionAfter: StrategySignalPosition | null
  riskIntent: StrategySignalRiskIntent | null
  signal: StrategySignalRecord
}>

export type StrategySignalBatch = StrategySignalBatchPayload & Readonly<{
  batchHash: string
}>

export const STRATEGY_HISTORICAL_DATASET_SCHEMA_VERSION = 'helix.market-dataset/v1' as const

export type StrategyHistoricalDatasetSource = Readonly<{
  provider: string
  market: string
  instrumentId: string
  symbol: string
}>

export type StrategyHistoricalDatasetPayload = Readonly<{
  schemaVersion: typeof STRATEGY_HISTORICAL_DATASET_SCHEMA_VERSION
  source: StrategyHistoricalDatasetSource
  capturedThrough: number
  timeframes: Readonly<Record<string, readonly Candle[]>>
}>

export type StrategyHistoricalDataset = StrategyHistoricalDatasetPayload & Readonly<{
  datasetHash: string
}>

export const STRATEGY_BACKTEST_CHECKS = [
  'schema_validation',
  'component_availability',
  'agent_doc_references',
  'reason_code_validation',
  'unit_tests',
  'deterministic_replay',
  'historical_backtest',
  'walk_forward',
  'regression_analysis',
] as const

export type StrategyBacktestCheck = typeof STRATEGY_BACKTEST_CHECKS[number]

export type StrategyReplayObservation = {
  identity: StrategyDecisionIdentity
  objectState: string
  reasonCodes: string[]
  score: number | null
  signalDecision: string
  riskDecision: string
}

export type StrategyReplayMismatch = {
  field: string
  expected: unknown
  actual: unknown
}

export type StrategyReplayComparison = {
  ok: boolean
  code: 'MATCH' | 'NON_DETERMINISTIC_REPLAY'
  mismatches: StrategyReplayMismatch[]
}

export const STRATEGY_WALK_FORWARD_PLAN_SCHEMA_VERSION = 'helix.walk-forward-plan/v1' as const
export const STRATEGY_WALK_FORWARD_RUN_SCHEMA_VERSION = 'helix.walk-forward-run/v1' as const

export type StrategyWalkForwardFold = Readonly<{
  sequence: number
  entryWindowStartTime: number
  entryWindowEndTime: number
  observationEndTime: number
}>

export type StrategyWalkForwardExecutionScenario = Readonly<{
  id: string
  fee: number
}>

export type StrategyWalkForwardCandidate = Readonly<{
  strategyId: string
  strategyVersion: string
  strategyRepoCommit: string
  strategyConfigHash: string
  engineCommit: string
  lifecycle: StrategyLifecycle
  objectModel: StrategyObjectModel
}>

export type StrategyWalkForwardPlanPayload = Readonly<{
  schemaVersion: typeof STRATEGY_WALK_FORWARD_PLAN_SCHEMA_VERSION
  mode: 'fixed_candidate'
  candidate: StrategyWalkForwardCandidate
  walkForwardPolicy?: Readonly<StrategyWalkForwardPolicy>
  sourceDataset: Readonly<{
    datasetHash: string
    source: StrategyHistoricalDatasetSource
    capturedThrough: number
  }>
  baseTimeframe: string
  requiredTimeframes: readonly string[]
  activationDecisionTime: number
  warmupDurationMs: number
  folds: readonly StrategyWalkForwardFold[]
  executionScenarios: readonly StrategyWalkForwardExecutionScenario[]
}>

export type StrategyWalkForwardPlan = StrategyWalkForwardPlanPayload & Readonly<{
  planHash: string
}>

export type StrategyWalkForwardCensoredEntry = Readonly<{
  tradeId: string
  entrySignalId: string
  decisionId: string
  object: StrategySignalObjectReference
  side: StrategyPositionSide
  sourceCandleOpenTime: number
  decisionTime: number
  reason: 'NO_EXIT_BY_OBSERVATION_END' | 'EXIT_AT_OBSERVATION_END'
}>

export type StrategyWalkForwardRunFold = Readonly<{
  sequence: number
  entryWindowStartTime: number
  entryWindowEndTime: number
  observationEndTime: number
  datasetFile: string
  datasetHash: string
  decisionArtifactFile: string
  decisionArtifactHash: string
  decisionRiskTraceFile: string
  decisionRiskTraceHash: string
  replayArtifactFile: string
  replayArtifactHash: string
  executionArtifactFile: string
  executionArtifactHash: string
  executionRiskTraceFile: string
  executionRiskTraceHash: string
  tradeIds: readonly string[]
  censoredEntries: readonly StrategyWalkForwardCensoredEntry[]
  statistics: Readonly<{
    decisionSignals: number
    entriesInWindow: number
    completedTrades: number
    censoredEntries: number
    evaluator: Readonly<Record<string, unknown>>
  }>
}>

export type StrategyWalkForwardRunPayload = Readonly<{
  schemaVersion: typeof STRATEGY_WALK_FORWARD_RUN_SCHEMA_VERSION
  planFile: string
  planHash: string
  folds: readonly StrategyWalkForwardRunFold[]
}>

export type StrategyWalkForwardRun = StrategyWalkForwardRunPayload & Readonly<{
  runHash: string
}>

export const STRATEGY_WALK_FORWARD_PORTFOLIO_PLAN_SCHEMA_VERSION =
  'helix.walk-forward-portfolio-plan/v1' as const

export type StrategyWalkForwardPortfolioPlanMember = Readonly<{
  source: StrategyHistoricalDatasetSource
  sourceDatasetHash: string
  capturedThrough: number
  planHash: string
  runHash: string
}>

export type StrategyWalkForwardPortfolioPlanPayload = Readonly<{
  schemaVersion: typeof STRATEGY_WALK_FORWARD_PORTFOLIO_PLAN_SCHEMA_VERSION
  mode: 'fixed_candidate_multi_symbol'
  candidate: StrategyWalkForwardCandidate
  walkForwardPolicy: StrategyWalkForwardPolicy
  members: readonly StrategyWalkForwardPortfolioPlanMember[]
  baseTimeframe: string
  requiredTimeframes: readonly string[]
  activationDecisionTime: number
  warmupDurationMs: number
  folds: readonly StrategyWalkForwardFold[]
  executionScenarios: readonly StrategyWalkForwardExecutionScenario[]
}>

export type StrategyWalkForwardPortfolioPlan = StrategyWalkForwardPortfolioPlanPayload & Readonly<{
  planHash: string
}>
import type { Candle } from './market'
import type { ScalpGrade, ScalpMarketRegimeType, ScalpPriceEventType } from './scalp'
import type { SwingContextBias, SwingDailyMarketState, SwingExecutionStage } from './swing'

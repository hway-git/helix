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
import type { Candle } from './market'

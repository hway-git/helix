import type { StrategyDecisionIdentity, StrategyLifecycle } from './strategy'

export const SWING_THESIS_STATES = [
  'CANDIDATE',
  'ACTIVE',
  'ENTRY_ELIGIBLE',
  'TRIGGERED',
  'REJECTED',
  'INVALIDATED',
  'EXPIRED',
  'CLOSED',
] as const
export const SWING_EVIDENCE_EFFECTS = ['SUPPORTING', 'OPPOSING', 'INVALIDATING'] as const
export const SWING_EXECUTION_STAGES = ['EARLY', 'STANDARD', 'CONFIRMED'] as const
export const SWING_SHADOW_ACTIONS = ['would_trigger', 'would_reject', 'would_exit'] as const

export type SwingTradeThesisState = typeof SWING_THESIS_STATES[number]
export type SwingEvidenceEffect = typeof SWING_EVIDENCE_EFFECTS[number]
export type SwingExecutionStage = typeof SWING_EXECUTION_STAGES[number]
export type SwingShadowAction = typeof SWING_SHADOW_ACTIONS[number]
export type SwingDirection = 'LONG' | 'SHORT'
export type SwingDailyMarketState = 'BULLISH_TREND' | 'BEARISH_TREND' | 'RANGE' | 'TRANSITION' | 'UNCLEAR'
export type SwingContextBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
export type SwingEvidenceDirection = SwingDirection | 'NEUTRAL'
export type SwingJournalRunMode = 'shadow' | 'production'
export type SwingFeatureValue = number | string | boolean | null
export type SwingFeatureSnapshot = Readonly<Record<string, SwingFeatureValue>>

export type SwingMarketContext = {
  id: string
  symbol: string
  daily: string
  h4: string
  reasonCodes: string[]
  observedAt: number
}

export type SwingDailyMarketContextConfig = {
  fastWindowBars: number
  slowWindowBars: number
  emaPeriod: number
  swingLeftBars: number
  swingRightBars: number
  trendMinEfficiency: number
  trendMinEmaSlopeAtr: number
  rangeMaxEfficiency: number
  rangeMaxEmaSlopeAtr: number
}

export type SwingDailyMarketContextDecision = {
  context: SwingMarketContext
  state: SwingDailyMarketState
  bias: SwingContextBias
  score: number
  reasonCodes: string[]
  featureSnapshot: SwingFeatureSnapshot
}

export type SwingPriceBoundary = {
  lower: number
  upper: number
}

export type SwingLocation = {
  id: string
  symbol: string
  type: string
  score: number
  boundaries: SwingPriceBoundary
  reasonCodes: string[]
}

export type SwingLocationConfig = {
  atrPeriod: number
  lookbackBars: number
  rangeLookbackBars: number
  swingLeftBars: number
  swingRightBars: number
  zoneHalfWidthAtr: number
  touchToleranceAtr: number
  reactionDistanceAtr: number
  reactionBars: number
  meanReversionDistanceAtr: number
  maxTestCount: number
  maxAgeBars: number
  minLocationScore: number
}

export type SwingLocationCandidate = SwingLocation & {
  direction: SwingDirection
  detectedAt: number
}

export type SwingLocationScan = {
  locations: SwingLocationCandidate[]
  reasonCodes: string[]
  featureSnapshot: SwingFeatureSnapshot
}

export type SwingThesisInvalidation = {
  policyId: 'thesis_invalidation_v1'
  type: 'H4_CLOSE_ABOVE_LEVEL' | 'H4_CLOSE_BELOW_LEVEL'
  timeframe: '4h'
  level: number
}

export type SwingExpectedMove = {
  targetLocationId: string
  target: number
}

export type SwingEvidenceRecord = {
  id: string
  thesisId: string
  type: string
  time: number
  direction: SwingEvidenceDirection
  effect: SwingEvidenceEffect
  scoreDelta: number
  reasonCodes: string[]
  featureSnapshot: SwingFeatureSnapshot
}

export type SwingTradeThesis = {
  id: string
  symbol: string
  type: string
  direction: SwingDirection
  state: SwingTradeThesisState
  contextId: string
  locationId: string
  score: number
  invalidation: SwingThesisInvalidation
  expectedMove: SwingExpectedMove
  createdAt: number
  expiresAt: number
  updatedAt: number
  reasonCodes: string[]
  evidence: SwingEvidenceRecord[]
}

export type SwingThesisTransition = {
  thesisId: string
  fromState: SwingTradeThesisState
  toState: SwingTradeThesisState
  occurredAt: number
  reasonCodes: string[]
  featureSnapshot: SwingFeatureSnapshot
}

export type SwingExecutionContext = {
  stage: SwingExecutionStage
  triggerId: string
  entryZone: SwingPriceBoundary
  stop: number
  targets: number[]
  expectedRr: number
  reasonCodes: string[]
}

export type SwingRiskContext = {
  policyId: string
  riskR: number
  portfolioExposure: number
  strategyBudgetUsedR: number
  reasonCodes: string[]
}

export type SwingTradeResult = {
  pnlR: number
  mfeR: number
  maeR: number
  holdingMinutes: number
  maxProfitR: number
  profitGivebackR: number
  exitReason: string
  fees: number
  slippage: number
}

export type SwingRiskPolicyConfig = {
  thesisRiskBudgetR: number
  riskByStageR: Record<SwingExecutionStage, number>
}

export type SwingRiskDecision = {
  allowed: boolean
  requestedRiskR: number
  remainingThesisRiskR: number
  reasonCodes: string[]
}

export type SwingInvalidationCandle = {
  timeframe: '4h'
  time: number
  close: number
  closed: boolean
}

export type SwingInvalidationDecision = {
  invalidated: boolean
  reasonCodes: string[]
}

export type SwingExecutionPolicyConfig = {
  minRrByStage: Record<SwingExecutionStage, number>
  maxAttemptsPerThesis: number
}

export type SwingStageEvidence = {
  locationAligned: boolean
  supportingEvidence: boolean
  rejection: boolean
  displacement: boolean
  structureConfirmed: boolean
  breakRetestConfirmed: boolean
  followThrough: boolean
}

export type SwingExecutionDecision = {
  triggered: boolean
  stage: SwingExecutionStage
  reasonCodes: string[]
  featureSnapshot: SwingFeatureSnapshot
}

export type SwingJournalChange = {
  kind: 'THESIS_STATE'
  thesisId: string
  fromState: SwingTradeThesisState | null
  toState: SwingTradeThesisState
  occurredAt: number
} | {
  kind: 'EVIDENCE_APPENDED'
  thesisId: string
  evidenceId: string
  occurredAt: number
}

export type SwingJournalEntry = {
  decisionId: string
  identity: StrategyDecisionIdentity
  engineVersion: string
  strategyLifecycle: StrategyLifecycle
  runMode: SwingJournalRunMode
  decisionTime: number
  symbol: string
  change: SwingJournalChange
  reasonCodes: string[]
  featureSnapshot: SwingFeatureSnapshot
  context?: SwingMarketContext
  location: SwingLocation
  thesis: SwingTradeThesis
  evidence?: SwingEvidenceRecord
  execution?: SwingExecutionContext
  risk?: SwingRiskContext
  result?: SwingTradeResult
  shadowAction?: SwingShadowAction
}

export type StoredSwingJournalEntry = SwingJournalEntry & {
  sequence: number
  recordedAt: number
}

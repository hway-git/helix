import type { StrategyDecisionIdentity, StrategyLifecycle } from './strategy'

export const SCALP_MARKET_REGIMES = [
  'TRENDING',
  'RANGING',
  'COMPRESSED',
  'EXPANDING',
  'EXHAUSTED',
  'CHAOTIC',
] as const

export const SCALP_ZONE_STATES = ['DETECTED', 'ACTIVE', 'WEAKENED', 'EXPIRED'] as const
export const SCALP_EVENT_STATES = ['DETECTED', 'ARMED', 'TRIGGERED', 'FAILED', 'EXPIRED', 'CLOSED'] as const
export const SCALP_RESPONSE_STATES = ['EXPECTED_RESPONSE_WINDOW', 'RESPONSE_OK', 'TRADE_NOT_WORKING'] as const
export const SCALP_SHADOW_ACTIONS = ['would_trigger', 'would_reject', 'would_exit'] as const

export type ScalpMarketRegimeType = typeof SCALP_MARKET_REGIMES[number]
export type ScalpHuntingZoneState = typeof SCALP_ZONE_STATES[number]
export type ScalpPriceEventState = typeof SCALP_EVENT_STATES[number]
export type ScalpResponseState = typeof SCALP_RESPONSE_STATES[number]
export type ScalpShadowAction = typeof SCALP_SHADOW_ACTIONS[number]
export type ScalpDirection = 'LONG' | 'SHORT'
export type ScalpDirectionInterest = ScalpDirection | 'BOTH'
export type ScalpPriceEventType = 'LIQUIDITY_SWEEP' | 'BREAKOUT_FAILURE' | 'MOMENTUM_BURST'
export type ScalpEventDetectorId = 'liquidity_sweep_v1' | 'breakout_failure_v1' | 'momentum_burst_v1'
export type ScalpGrade = 'A_PLUS' | 'A' | 'B'
export type ScalpJournalRunMode = 'shadow' | 'production'
export type ScalpJournalObjectKind = 'PRICE_EVENT' | 'RESPONSE'
export type ScalpFeatureValue = number | string | boolean | null
export type ScalpFeatureSnapshot = Readonly<Record<string, ScalpFeatureValue>>

export type ScalpMarketRegime = {
  id: string
  symbol: string
  type: ScalpMarketRegimeType
  score: number
  observedAt: number
}

export type ScalpMarketRegimeConfig = {
  fastWindowBars: number
  slowWindowBars: number
  emaPeriod: number
  swingLeftBars: number
  swingRightBars: number
  trendMinEfficiency: number
  trendMinEmaSlopeAtr: number
  compressionMaxAtrRatio: number
  compressionMaxRangeRatio: number
  compressionMinOverlapRatio: number
  expansionMinAtrRatio: number
  expansionMinBodyRatio: number
  expansionMinEfficiency: number
  exhaustionMinDirectionalBars: number
  exhaustionMinMeanDistanceAtr: number
  exhaustionMaxLastRangeRatio: number
  chaoticMinAlternationRatio: number
  chaoticMinWickRatio: number
  chaoticMaxEfficiency: number
}

export type ScalpMarketRegimeDecision = {
  regime: ScalpMarketRegime
  reasonCodes: string[]
  featureSnapshot: ScalpFeatureSnapshot
}

export type ScalpPriceBoundary = {
  lower: number
  upper: number
}

export type ScalpHuntingZone = {
  id: string
  symbol: string
  type: string
  state: ScalpHuntingZoneState
  score: number
  testCount: number
  directionInterest: ScalpDirectionInterest
  boundary: ScalpPriceBoundary
  detectedAt: number
  expiresAt?: number
}

export type ScalpHuntingZoneConfig = {
  atrPeriod: number
  lookbackBars: number
  rangeLookbackBars: number
  compressionLookbackBars: number
  swingLeftBars: number
  swingRightBars: number
  zoneHalfWidthAtr: number
  touchToleranceAtr: number
  reactionDistanceAtr: number
  reactionBars: number
  compressionMaxRangeRatio: number
  maxTestCount: number
  maxAgeBars: number
  minZoneScore: number
}

export type ScalpHuntingZoneScan = {
  zones: ScalpHuntingZone[]
  reasonCodes: string[]
  featureSnapshot: ScalpFeatureSnapshot
}

export type ScalpPriceEvent = {
  id: string
  symbol: string
  regimeId: string
  zoneId: string
  detectorId: ScalpEventDetectorId
  type: ScalpPriceEventType
  direction: ScalpDirection
  state: ScalpPriceEventState
  score: number
  detectedAt: number
  expiresAt: number
  updatedAt: number
  reasonCodes: string[]
}

export type ScalpEventTransition = {
  eventId: string
  fromState: ScalpPriceEventState
  toState: ScalpPriceEventState
  occurredAt: number
  reasonCodes: string[]
  featureSnapshot: ScalpFeatureSnapshot
}

export type ScalpResponse = {
  eventId: string
  state: ScalpResponseState
  windowStartedAt: number
  windowEndsAt: number
  updatedAt: number
  reasonCodes: string[]
}

export type ScalpResponseTransition = {
  eventId: string
  fromState: ScalpResponseState
  toState: ScalpResponseState
  occurredAt: number
  reasonCodes: string[]
  featureSnapshot: ScalpFeatureSnapshot
}

export type ScalpExecutionContext = {
  triggerId: string
  triggered: boolean
  reasonCodes: string[]
  entryZone?: ScalpPriceBoundary
  stop?: number
  targets?: number[]
  expectedRr?: number
}

export type ScalpRiskContext = {
  policyId: string
  riskR: number
  dailyUsedR: number
  consecutiveLosses: number
  reasonCodes: string[]
}

export type ScalpTradeResult = {
  pnlR: number
  mfeR: number
  maeR: number
  holdingMinutes: number
  responseLatencyMinutes: number
  exitReason: string
  fees: number
  slippage: number
}

export type ScalpRiskPolicyConfig = {
  dailyLossLimitR: number
  maxConsecutiveLosses: number
  riskByGradeR: Record<ScalpGrade, number>
}

export type ScalpRiskDecision = {
  allowed: boolean
  riskR: number
  reasonCodes: string[]
}

export type ScalpTimePolicyConfig = {
  maxHoldingMs: Record<ScalpPriceEventType, number>
  responseWindowMs: Record<ScalpPriceEventType, number>
}

export type ScalpTimeDecision = {
  action: 'HOLD' | 'EXIT'
  elapsedMs: number
  reasonCodes: string[]
}

export type LiquiditySweepConfig = {
  minZoneScore: number
  maxReclaimBars: number
  minWickRatio: number
  maxFollowThroughAtr: number
}

export type BreakoutFailureConfig = {
  minZoneScore: number
  maxReturnBars: number
  maxFollowThroughAtr: number
}

export type MomentumBurstConfig = {
  minZoneScore: number
  minBodyRatio: number
  minCandleRangeAtr: number
  maxDistanceFromMeanAtr: number
}

export type ScalpDetectorDecision = {
  detected: boolean
  reasonCodes: string[]
  featureSnapshot: ScalpFeatureSnapshot
}

export type ScalpExecutionConfig = {
  minRr: number
}

export type ScalpExecutionDecision = {
  triggered: boolean
  reasonCodes: string[]
  featureSnapshot: ScalpFeatureSnapshot
}

export type ScalpJournalTransition = {
  objectKind: ScalpJournalObjectKind
  objectId: string
  fromState: ScalpPriceEventState | ScalpResponseState | null
  toState: ScalpPriceEventState | ScalpResponseState
  occurredAt: number
}

export type ScalpJournalEntry = {
  decisionId: string
  identity: StrategyDecisionIdentity
  engineVersion: string
  strategyLifecycle: StrategyLifecycle
  runMode: ScalpJournalRunMode
  decisionTime: number
  symbol: string
  transition: ScalpJournalTransition
  reasonCodes: string[]
  featureSnapshot: ScalpFeatureSnapshot
  regime?: ScalpMarketRegime
  zone: ScalpHuntingZone
  event: ScalpPriceEvent
  response?: ScalpResponse
  execution?: ScalpExecutionContext
  risk?: ScalpRiskContext
  result?: ScalpTradeResult
  shadowAction?: ScalpShadowAction
}

export type StoredScalpJournalEntry = ScalpJournalEntry & {
  sequence: number
  recordedAt: number
}

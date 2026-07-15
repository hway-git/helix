import type {
  ScalpGrade,
  ScalpPriceEventType,
  ScalpResponseState,
  ScalpRiskDecision,
  ScalpRiskPolicyConfig,
  ScalpTimeDecision,
  ScalpTimePolicyConfig,
} from '@helix/contracts/scalp'

const EVENT_TYPES: ScalpPriceEventType[] = ['LIQUIDITY_SWEEP', 'BREAKOUT_FAILURE', 'MOMENTUM_BURST']
const GRADES: ScalpGrade[] = ['A_PLUS', 'A', 'B']

function positiveFinite(value: number, field: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`)
}

function nonNegativeFinite(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative`)
}

export function evaluateScalpRiskPolicy(
  config: ScalpRiskPolicyConfig,
  input: { grade: ScalpGrade; dailyLossUsedR: number; consecutiveLosses: number },
): ScalpRiskDecision {
  positiveFinite(config.dailyLossLimitR, 'config.dailyLossLimitR')
  if (!Number.isSafeInteger(config.maxConsecutiveLosses) || config.maxConsecutiveLosses <= 0) {
    throw new Error('config.maxConsecutiveLosses must be a positive integer')
  }
  for (const grade of GRADES) positiveFinite(config.riskByGradeR[grade], `config.riskByGradeR.${grade}`)
  nonNegativeFinite(input.dailyLossUsedR, 'input.dailyLossUsedR')
  if (!Number.isSafeInteger(input.consecutiveLosses) || input.consecutiveLosses < 0) {
    throw new Error('input.consecutiveLosses must be a non-negative integer')
  }

  const reasonCodes: string[] = []
  if (input.dailyLossUsedR >= config.dailyLossLimitR) reasonCodes.push('DAILY_SCALP_LOSS_LIMIT')
  if (input.consecutiveLosses >= config.maxConsecutiveLosses) reasonCodes.push('MAX_CONSECUTIVE_LOSSES')
  return {
    allowed: reasonCodes.length === 0,
    riskR: reasonCodes.length === 0 ? config.riskByGradeR[input.grade] : 0,
    reasonCodes,
  }
}

export function evaluateScalpTimePolicy(
  config: ScalpTimePolicyConfig,
  input: {
    eventType: ScalpPriceEventType
    triggeredAt: number
    evaluatedAt: number
    responseState: ScalpResponseState
  },
): ScalpTimeDecision {
  for (const eventType of EVENT_TYPES) {
    positiveFinite(config.maxHoldingMs[eventType], `config.maxHoldingMs.${eventType}`)
    positiveFinite(config.responseWindowMs[eventType], `config.responseWindowMs.${eventType}`)
    if (config.responseWindowMs[eventType] > config.maxHoldingMs[eventType]) {
      throw new Error(`response window cannot exceed max holding time for ${eventType}`)
    }
  }
  if (!Number.isSafeInteger(input.triggeredAt) || input.triggeredAt < 0) {
    throw new Error('input.triggeredAt must be a non-negative integer timestamp')
  }
  if (!Number.isSafeInteger(input.evaluatedAt) || input.evaluatedAt < input.triggeredAt) {
    throw new Error('input.evaluatedAt cannot precede input.triggeredAt')
  }

  const elapsedMs = input.evaluatedAt - input.triggeredAt
  const reasonCodes: string[] = []
  if (input.responseState === 'TRADE_NOT_WORKING'
    || (input.responseState !== 'RESPONSE_OK' && elapsedMs >= config.responseWindowMs[input.eventType])) {
    reasonCodes.push('RESPONSE_WINDOW_MISSED')
  }
  if (elapsedMs >= config.maxHoldingMs[input.eventType]) reasonCodes.push('TIME_STOP')
  return {
    action: reasonCodes.length === 0 ? 'HOLD' : 'EXIT',
    elapsedMs,
    reasonCodes,
  }
}

import type {
  SwingExecutionStage,
  SwingExecutionDecision,
  SwingExecutionPolicyConfig,
  SwingInvalidationCandle,
  SwingInvalidationDecision,
  SwingRiskDecision,
  SwingRiskPolicyConfig,
  SwingStageEvidence,
  SwingTradeThesis,
} from '@helix/contracts/swing'
import { assertSwingTradeThesis } from './swing-state-machine'

const EXECUTION_STAGES: SwingExecutionStage[] = ['EARLY', 'STANDARD', 'CONFIRMED']
const R_PRECISION = 1_000_000_000
export const SWING_ENTRY_DISTANCE_LIMIT_ATR = 2

export type SwingEntryGateComparison = 'GTE' | 'LTE' | 'LT'

export type SwingEntryGateFailure = Readonly<{
  gateId: string
  gateOrder: number
  reasonCode: string
  comparison: SwingEntryGateComparison
  actual: number
  required: number
  distanceToPass: number
}>

type SwingEntryGate = SwingEntryGateFailure & { passed: boolean }

function positiveFinite(value: number, field: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`)
}

function nonNegativeFinite(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative`)
}

function normalizeR(value: number) {
  return Math.round(value * R_PRECISION) / R_PRECISION
}

function entryGatePassed(comparison: SwingEntryGateComparison, actual: number, required: number) {
  return comparison === 'GTE'
    ? actual >= required
    : comparison === 'LTE'
      ? actual <= required
      : actual < required
}

export function swingEntryGateDistance(
  comparison: SwingEntryGateComparison,
  actual: number,
  required: number,
) {
  const passed = entryGatePassed(comparison, actual, required)
  const distance = comparison === 'GTE'
    ? Math.max(0, required - actual)
    : comparison === 'LTE'
      ? Math.max(0, actual - required)
      : Math.max(0, actual - required + 1)
  const normalized = normalizeR(distance)
  return passed || normalized > 0 ? normalized : 1 / R_PRECISION
}

function entryGate(input: Omit<SwingEntryGateFailure, 'distanceToPass'>): SwingEntryGate {
  nonNegativeFinite(input.actual, `${input.gateId}.actual`)
  nonNegativeFinite(input.required, `${input.gateId}.required`)
  const distanceToPass = swingEntryGateDistance(input.comparison, input.actual, input.required)
  const passed = entryGatePassed(input.comparison, input.actual, input.required)
  return { ...input, distanceToPass, passed }
}

function failedGate(gates: readonly SwingEntryGate[]): SwingEntryGateFailure | null {
  const failed = gates.find(({ passed }) => !passed)
  if (!failed) return null
  const { passed: _passed, ...failure } = failed
  return failure
}

function booleanGate(
  gateId: string,
  gateOrder: number,
  reasonCode: string,
  passed: boolean,
) {
  return entryGate({
    gateId,
    gateOrder,
    reasonCode,
    comparison: 'GTE',
    actual: passed ? 1 : 0,
    required: 1,
  })
}

export function evaluateSwingRiskPolicyWithGate(
  config: SwingRiskPolicyConfig,
  input: { stage: SwingExecutionStage; currentThesisRiskR: number; availablePortfolioRiskR: number; priceRiskRatio?: number },
) {
  positiveFinite(config.thesisRiskBudgetR, 'config.thesisRiskBudgetR')
  positiveFinite(config.maximumLeverage, 'config.maximumLeverage')
  for (const stage of EXECUTION_STAGES) positiveFinite(config.riskByStageR[stage], `config.riskByStageR.${stage}`)
  nonNegativeFinite(input.currentThesisRiskR, 'input.currentThesisRiskR')
  nonNegativeFinite(input.availablePortfolioRiskR, 'input.availablePortfolioRiskR')

  const requestedRiskR = normalizeR(config.riskByStageR[input.stage])
  const remainingThesisRiskR = normalizeR(Math.max(0, config.thesisRiskBudgetR - input.currentThesisRiskR))
  const availablePortfolioRiskR = normalizeR(input.availablePortfolioRiskR)
  const gates: SwingEntryGate[] = []
  if (input.priceRiskRatio !== undefined) {
    positiveFinite(input.priceRiskRatio, 'input.priceRiskRatio')
    if (config.riskUnitRatio !== undefined) {
      positiveFinite(config.riskUnitRatio, 'config.riskUnitRatio')
      gates.push(entryGate({
        gateId: 'LEVERAGE_LIMIT',
        gateOrder: 10,
        reasonCode: 'LEVERAGE_TOO_HIGH',
        comparison: 'LTE',
        actual: config.riskUnitRatio * requestedRiskR / input.priceRiskRatio,
        required: config.maximumLeverage,
      }))
    }
  }
  gates.push(
    entryGate({
      gateId: 'THESIS_RISK_REMAINING',
      gateOrder: 11,
      reasonCode: 'RISK_BUDGET_EXCEEDED',
      comparison: 'LTE',
      actual: requestedRiskR,
      required: remainingThesisRiskR,
    }),
    entryGate({
      gateId: 'PORTFOLIO_RISK_AVAILABLE',
      gateOrder: 12,
      reasonCode: 'RISK_BUDGET_EXCEEDED',
      comparison: 'LTE',
      actual: requestedRiskR,
      required: availablePortfolioRiskR,
    }),
  )
  const firstFailedGate = failedGate(gates)
  const allowed = firstFailedGate === null
  const decision: SwingRiskDecision = {
    allowed,
    requestedRiskR: allowed ? requestedRiskR : 0,
    remainingThesisRiskR,
    reasonCodes: firstFailedGate ? [firstFailedGate.reasonCode] : [],
  }
  return { decision, firstFailedGate }
}

export function evaluateSwingRiskPolicy(
  config: SwingRiskPolicyConfig,
  input: { stage: SwingExecutionStage; currentThesisRiskR: number; availablePortfolioRiskR: number; priceRiskRatio?: number },
): SwingRiskDecision {
  return evaluateSwingRiskPolicyWithGate(config, input).decision
}

export function evaluateSwingInvalidation(
  thesis: SwingTradeThesis,
  candle: SwingInvalidationCandle,
): SwingInvalidationDecision {
  assertSwingTradeThesis(thesis)
  if (!candle.closed) throw new Error('Thesis invalidation requires a closed candle')
  if (!Number.isSafeInteger(candle.time) || candle.time < 0) {
    throw new Error('candle.time must be a non-negative integer timestamp')
  }
  if (!Number.isFinite(candle.close)) throw new Error('candle.close must be finite')
  if (candle.time < thesis.updatedAt) throw new Error('invalidation candle cannot precede Thesis updatedAt')
  if (thesis.invalidation.timeframe !== candle.timeframe) throw new Error('invalidation timeframe mismatch')

  const invalidated = thesis.invalidation.type === 'H4_CLOSE_ABOVE_LEVEL'
    ? candle.close > thesis.invalidation.level
    : candle.close < thesis.invalidation.level
  return {
    invalidated,
    reasonCodes: invalidated ? ['THESIS_INVALIDATED'] : [],
  }
}

export function evaluateSwingExecutionWithGate(
  config: SwingExecutionPolicyConfig,
  thesis: SwingTradeThesis,
  input: {
    stage: SwingExecutionStage
    attemptCount: number
    rr: number
    entryDistanceAtr: number
    evidence: SwingStageEvidence
  },
) {
  assertSwingTradeThesis(thesis)
  for (const stage of EXECUTION_STAGES) positiveFinite(config.minRrByStage[stage], `config.minRrByStage.${stage}`)
  if (!Number.isSafeInteger(config.maxAttemptsPerThesis) || config.maxAttemptsPerThesis <= 0) {
    throw new Error('config.maxAttemptsPerThesis must be a positive integer')
  }
  if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0) {
    throw new Error('input.attemptCount must be a non-negative integer')
  }
  nonNegativeFinite(input.rr, 'input.rr')
  nonNegativeFinite(input.entryDistanceAtr, 'input.entryDistanceAtr')

  const gates: SwingEntryGate[] = [
    booleanGate('THESIS_ENTRY_ELIGIBLE', 0, 'NO_VALID_THESIS', thesis.state === 'ENTRY_ELIGIBLE'),
    entryGate({
      gateId: 'ATTEMPTS_REMAINING',
      gateOrder: 1,
      reasonCode: 'MAX_THESIS_ATTEMPTS',
      comparison: 'LT',
      actual: input.attemptCount,
      required: config.maxAttemptsPerThesis,
    }),
    booleanGate('LOCATION_ALIGNED', 2, 'LOCATION_MISSING', input.evidence.locationAligned),
    booleanGate('SUPPORTING_EVIDENCE', 3, 'EVIDENCE_INSUFFICIENT', input.evidence.supportingEvidence),
  ]
  if (input.stage === 'EARLY') {
    gates.push(booleanGate(
      'EARLY_REACTION',
      4,
      'EVIDENCE_INSUFFICIENT',
      input.evidence.rejection || input.evidence.displacement,
    ))
  } else {
    gates.push(booleanGate('STRUCTURE_CONFIRMED', 4, 'STRUCTURE_NOT_CONFIRMED', input.evidence.structureConfirmed))
    if (input.stage === 'CONFIRMED') {
      gates.push(booleanGate(
        'BREAK_RETEST_CONFIRMED',
        5,
        'STRUCTURE_NOT_CONFIRMED',
        input.evidence.breakRetestConfirmed,
      ))
    }
    gates.push(
      booleanGate('DISPLACEMENT', 6, 'STRUCTURE_NOT_CONFIRMED', input.evidence.displacement),
      booleanGate('FOLLOW_THROUGH', 7, 'STRUCTURE_NOT_CONFIRMED', input.evidence.followThrough),
    )
  }
  gates.push(
    entryGate({
      gateId: 'ENTRY_DISTANCE_ATR',
      gateOrder: 8,
      reasonCode: 'ENTRY_TOO_LATE',
      comparison: 'LTE',
      actual: input.entryDistanceAtr,
      required: SWING_ENTRY_DISTANCE_LIMIT_ATR,
    }),
    entryGate({
      gateId: 'REWARD_RISK',
      gateOrder: 9,
      reasonCode: 'RR_TOO_LOW',
      comparison: 'GTE',
      actual: input.rr,
      required: config.minRrByStage[input.stage],
    }),
  )
  const reasonCodes = [...new Set(gates.filter(({ passed }) => !passed).map(({ reasonCode }) => reasonCode))]
  const triggered = reasonCodes.length === 0
  const decision: SwingExecutionDecision = {
    triggered,
    stage: input.stage,
    reasonCodes: triggered ? ['EXECUTION_TRIGGERED'] : reasonCodes,
    featureSnapshot: {
      attempt_count: input.attemptCount,
      rr: input.rr,
      entry_extended: input.entryDistanceAtr > SWING_ENTRY_DISTANCE_LIMIT_ATR,
      location_aligned: input.evidence.locationAligned,
      supporting_evidence: input.evidence.supportingEvidence,
      rejection: input.evidence.rejection,
      displacement: input.evidence.displacement,
      structure_confirmed: input.evidence.structureConfirmed,
      break_retest_confirmed: input.evidence.breakRetestConfirmed,
      follow_through: input.evidence.followThrough,
    },
  }
  return { decision, firstFailedGate: failedGate(gates) }
}

export function evaluateSwingExecution(
  config: SwingExecutionPolicyConfig,
  thesis: SwingTradeThesis,
  input: {
    stage: SwingExecutionStage
    attemptCount: number
    rr: number
    entryDistanceAtr: number
    evidence: SwingStageEvidence
  },
): SwingExecutionDecision {
  return evaluateSwingExecutionWithGate(config, thesis, input).decision
}

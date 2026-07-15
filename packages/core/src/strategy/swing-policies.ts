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

function positiveFinite(value: number, field: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`)
}

function nonNegativeFinite(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative`)
}

function normalizeR(value: number) {
  return Math.round(value * R_PRECISION) / R_PRECISION
}

export function evaluateSwingRiskPolicy(
  config: SwingRiskPolicyConfig,
  input: { stage: SwingExecutionStage; currentThesisRiskR: number; availablePortfolioRiskR: number },
): SwingRiskDecision {
  positiveFinite(config.thesisRiskBudgetR, 'config.thesisRiskBudgetR')
  for (const stage of EXECUTION_STAGES) positiveFinite(config.riskByStageR[stage], `config.riskByStageR.${stage}`)
  nonNegativeFinite(input.currentThesisRiskR, 'input.currentThesisRiskR')
  nonNegativeFinite(input.availablePortfolioRiskR, 'input.availablePortfolioRiskR')

  const requestedRiskR = normalizeR(config.riskByStageR[input.stage])
  const remainingThesisRiskR = normalizeR(Math.max(0, config.thesisRiskBudgetR - input.currentThesisRiskR))
  const availablePortfolioRiskR = normalizeR(input.availablePortfolioRiskR)
  const allowed = requestedRiskR <= remainingThesisRiskR && requestedRiskR <= availablePortfolioRiskR
  return {
    allowed,
    requestedRiskR: allowed ? requestedRiskR : 0,
    remainingThesisRiskR,
    reasonCodes: allowed ? [] : ['RISK_BUDGET_EXCEEDED'],
  }
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

export function evaluateSwingExecution(
  config: SwingExecutionPolicyConfig,
  thesis: SwingTradeThesis,
  input: {
    stage: SwingExecutionStage
    attemptCount: number
    rr: number
    entryExtended: boolean
    evidence: SwingStageEvidence
  },
): SwingExecutionDecision {
  assertSwingTradeThesis(thesis)
  for (const stage of EXECUTION_STAGES) positiveFinite(config.minRrByStage[stage], `config.minRrByStage.${stage}`)
  if (!Number.isSafeInteger(config.maxAttemptsPerThesis) || config.maxAttemptsPerThesis <= 0) {
    throw new Error('config.maxAttemptsPerThesis must be a positive integer')
  }
  if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0) {
    throw new Error('input.attemptCount must be a non-negative integer')
  }
  nonNegativeFinite(input.rr, 'input.rr')

  const reasonCodes: string[] = []
  if (thesis.state !== 'ENTRY_ELIGIBLE') reasonCodes.push('NO_VALID_THESIS')
  if (input.attemptCount >= config.maxAttemptsPerThesis) reasonCodes.push('MAX_THESIS_ATTEMPTS')
  if (!input.evidence.locationAligned) reasonCodes.push('LOCATION_MISSING')
  if (!input.evidence.supportingEvidence) reasonCodes.push('EVIDENCE_INSUFFICIENT')

  if (input.stage === 'EARLY') {
    if (!input.evidence.rejection && !input.evidence.displacement) reasonCodes.push('EVIDENCE_INSUFFICIENT')
  } else if (!input.evidence.structureConfirmed
    || (input.stage === 'CONFIRMED' && !input.evidence.breakRetestConfirmed)
    || !input.evidence.displacement
    || !input.evidence.followThrough) {
    reasonCodes.push('STRUCTURE_NOT_CONFIRMED')
  }

  if (input.entryExtended) reasonCodes.push('ENTRY_TOO_LATE')
  if (input.rr < config.minRrByStage[input.stage]) reasonCodes.push('RR_TOO_LOW')
  const triggered = reasonCodes.length === 0
  return {
    triggered,
    stage: input.stage,
    reasonCodes: triggered ? ['EXECUTION_TRIGGERED'] : [...new Set(reasonCodes)],
    featureSnapshot: {
      attempt_count: input.attemptCount,
      rr: input.rr,
      entry_extended: input.entryExtended,
      location_aligned: input.evidence.locationAligned,
      supporting_evidence: input.evidence.supportingEvidence,
      rejection: input.evidence.rejection,
      displacement: input.evidence.displacement,
      structure_confirmed: input.evidence.structureConfirmed,
      break_retest_confirmed: input.evidence.breakRetestConfirmed,
      follow_through: input.evidence.followThrough,
    },
  }
}

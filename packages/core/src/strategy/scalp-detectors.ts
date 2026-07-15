import type {
  BreakoutFailureConfig,
  LiquiditySweepConfig,
  MomentumBurstConfig,
  ScalpDetectorDecision,
  ScalpExecutionConfig,
  ScalpExecutionDecision,
  ScalpHuntingZoneState,
  ScalpPriceEvent,
} from '@helix/contracts/scalp'
import { assertScalpPriceEvent } from './scalp-state-machine'

type ZoneInput = {
  zoneState: ScalpHuntingZoneState
  zoneScore: number
}

function finite(value: number, field: string) {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite`)
}

function nonNegative(value: number, field: string) {
  finite(value, field)
  if (value < 0) throw new Error(`${field} must be non-negative`)
}

function ratio(value: number, field: string) {
  finite(value, field)
  if (value < 0 || value > 1) throw new Error(`${field} must be between 0 and 1`)
}

function score(value: number, field: string) {
  finite(value, field)
  if (value < 0 || value > 100) throw new Error(`${field} must be between 0 and 100`)
}

function positiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`)
}

function zoneReasons(input: ZoneInput, minZoneScore: number) {
  score(input.zoneScore, 'input.zoneScore')
  score(minZoneScore, 'config.minZoneScore')
  const reasons: string[] = []
  if (input.zoneState === 'WEAKENED') reasons.push('ZONE_CONSUMED')
  else if (input.zoneState !== 'ACTIVE') reasons.push('ZONE_INACTIVE')
  if (input.zoneScore < minZoneScore) reasons.push('ZONE_SCORE_TOO_LOW')
  return reasons
}

export function detectLiquiditySweep(
  config: LiquiditySweepConfig,
  input: ZoneInput & {
    levelBreached: boolean
    reclaimed: boolean
    reclaimBars: number
    wickRatio: number
    followThroughAtr: number
  },
): ScalpDetectorDecision {
  positiveInteger(config.maxReclaimBars, 'config.maxReclaimBars')
  ratio(config.minWickRatio, 'config.minWickRatio')
  nonNegative(config.maxFollowThroughAtr, 'config.maxFollowThroughAtr')
  if (!Number.isSafeInteger(input.reclaimBars) || input.reclaimBars < 0) {
    throw new Error('input.reclaimBars must be a non-negative integer')
  }
  ratio(input.wickRatio, 'input.wickRatio')
  nonNegative(input.followThroughAtr, 'input.followThroughAtr')

  const reasonCodes = zoneReasons(input, config.minZoneScore)
  if (!input.levelBreached) reasonCodes.push('LEVEL_NOT_BREACHED')
  if (!input.reclaimed) reasonCodes.push('RECLAIM_MISSING')
  if (input.reclaimBars > config.maxReclaimBars) reasonCodes.push('RECLAIM_TOO_SLOW')
  if (input.wickRatio < config.minWickRatio) reasonCodes.push('WICK_RATIO_TOO_LOW')
  if (input.followThroughAtr > config.maxFollowThroughAtr) reasonCodes.push('FOLLOW_THROUGH_TOO_STRONG')
  const detected = reasonCodes.length === 0
  return {
    detected,
    reasonCodes: detected ? ['LIQUIDITY_SWEEP_DETECTED'] : reasonCodes,
    featureSnapshot: {
      zone_state: input.zoneState,
      zone_score: input.zoneScore,
      level_breached: input.levelBreached,
      reclaimed: input.reclaimed,
      reclaim_bars: input.reclaimBars,
      wick_ratio: input.wickRatio,
      follow_through_atr: input.followThroughAtr,
    },
  }
}

export function detectBreakoutFailure(
  config: BreakoutFailureConfig,
  input: ZoneInput & {
    boundaryBroken: boolean
    returnedInside: boolean
    returnBars: number
    followThroughAtr: number
  },
): ScalpDetectorDecision {
  positiveInteger(config.maxReturnBars, 'config.maxReturnBars')
  nonNegative(config.maxFollowThroughAtr, 'config.maxFollowThroughAtr')
  if (!Number.isSafeInteger(input.returnBars) || input.returnBars < 0) {
    throw new Error('input.returnBars must be a non-negative integer')
  }
  nonNegative(input.followThroughAtr, 'input.followThroughAtr')

  const reasonCodes = zoneReasons(input, config.minZoneScore)
  if (!input.boundaryBroken) reasonCodes.push('LEVEL_NOT_BREACHED')
  if (!input.returnedInside) reasonCodes.push('RETURN_INSIDE_MISSING')
  if (input.returnBars > config.maxReturnBars) reasonCodes.push('RETURN_TOO_SLOW')
  if (input.followThroughAtr > config.maxFollowThroughAtr) reasonCodes.push('BREAKOUT_ACCEPTED')
  const detected = reasonCodes.length === 0
  return {
    detected,
    reasonCodes: detected ? ['BREAKOUT_FAILURE_DETECTED'] : reasonCodes,
    featureSnapshot: {
      zone_state: input.zoneState,
      zone_score: input.zoneScore,
      boundary_broken: input.boundaryBroken,
      returned_inside: input.returnedInside,
      return_bars: input.returnBars,
      follow_through_atr: input.followThroughAtr,
    },
  }
}

export function detectMomentumBurst(
  config: MomentumBurstConfig,
  input: ZoneInput & {
    compressionConfirmed: boolean
    breakoutConfirmed: boolean
    bodyRatio: number
    candleRangeAtr: number
    distanceFromMeanAtr: number
  },
): ScalpDetectorDecision {
  ratio(config.minBodyRatio, 'config.minBodyRatio')
  nonNegative(config.minCandleRangeAtr, 'config.minCandleRangeAtr')
  nonNegative(config.maxDistanceFromMeanAtr, 'config.maxDistanceFromMeanAtr')
  ratio(input.bodyRatio, 'input.bodyRatio')
  nonNegative(input.candleRangeAtr, 'input.candleRangeAtr')
  nonNegative(input.distanceFromMeanAtr, 'input.distanceFromMeanAtr')

  const reasonCodes = zoneReasons(input, config.minZoneScore)
  if (!input.compressionConfirmed
    || !input.breakoutConfirmed
    || input.bodyRatio < config.minBodyRatio
    || input.candleRangeAtr < config.minCandleRangeAtr) {
    reasonCodes.push('NO_EXPANSION')
  }
  if (input.distanceFromMeanAtr > config.maxDistanceFromMeanAtr) reasonCodes.push('CHASE_RISK')
  const detected = reasonCodes.length === 0
  return {
    detected,
    reasonCodes: detected ? ['MOMENTUM_BURST_DETECTED'] : reasonCodes,
    featureSnapshot: {
      zone_state: input.zoneState,
      zone_score: input.zoneScore,
      compression_confirmed: input.compressionConfirmed,
      breakout_confirmed: input.breakoutConfirmed,
      body_ratio: input.bodyRatio,
      candle_range_atr: input.candleRangeAtr,
      distance_from_mean_atr: input.distanceFromMeanAtr,
    },
  }
}

export function evaluateScalpExecution(
  config: ScalpExecutionConfig,
  event: ScalpPriceEvent,
  input: { evaluatedAt: number; microStructureBreak: boolean; displacement: boolean; rr: number },
): ScalpExecutionDecision {
  assertScalpPriceEvent(event)
  if (!Number.isFinite(config.minRr) || config.minRr <= 0) throw new Error('config.minRr must be positive')
  if (!Number.isSafeInteger(input.evaluatedAt) || input.evaluatedAt < event.updatedAt) {
    throw new Error('input.evaluatedAt cannot precede Event updatedAt')
  }
  nonNegative(input.rr, 'input.rr')

  const reasonCodes: string[] = []
  if (event.state !== 'ARMED' || !input.microStructureBreak || !input.displacement) {
    reasonCodes.push('EXECUTION_TRIGGER_MISSING')
  }
  if (input.evaluatedAt >= event.expiresAt) reasonCodes.push('EVENT_TTL_EXPIRED')
  if (input.rr < config.minRr) reasonCodes.push('RR_TOO_LOW')
  const triggered = reasonCodes.length === 0
  return {
    triggered,
    reasonCodes: triggered ? ['EXECUTION_TRIGGERED'] : reasonCodes,
    featureSnapshot: {
      micro_structure_break: input.microStructureBreak,
      displacement: input.displacement,
      rr: input.rr,
      evaluated_at: input.evaluatedAt,
    },
  }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import type { StrategyManifestIdentity } from '@helix/contracts/strategy'
import { scalpHistoricalConfig, swingHistoricalConfig } from './historical-config'

function manifest(
  id: 'helix_scalp_hunter' | 'helix_swing_hunter',
  capabilityConfigurations: Record<string, unknown>,
): StrategyManifestIdentity {
  const scalp = id === 'helix_scalp_hunter'
  return {
    schemaVersion: 'helix.strategy/v1',
    id,
    name: id,
    family: scalp ? 'scalp' : 'swing',
    version: '1.0.1',
    lifecycle: 'proposal',
    objectModel: scalp ? 'PRICE_EVENT' : 'TRADE_THESIS',
    timeframes: scalp
      ? [{ role: 'execution', timeframe: '1m' }]
      : [{ role: 'execution', timeframe: '15m' }],
    manifestPath: `strategies/${scalp ? 'scalp' : 'swing'}/strategy.yaml`,
    configHash: `sha256:${'a'.repeat(64)}`,
    requiredEngineCapabilities: Object.keys(capabilityConfigurations),
    capabilityConfigurations,
    reasonCodes: [],
  }
}

const scalpCapabilities = {
  market_regime_v1: {
    fast_window_bars: 10,
    slow_window_bars: 50,
    ema_period: 20,
    swing_left_bars: 2,
    swing_right_bars: 3,
    trend_min_efficiency: 0.35,
    trend_min_ema_slope_atr: 0.5,
    compression_max_atr_ratio: 0.8,
    compression_max_range_ratio: 0.7,
    compression_min_overlap_ratio: 0.55,
    expansion_min_atr_ratio: 1.2,
    expansion_min_body_ratio: 0.6,
    expansion_min_efficiency: 0.45,
    exhaustion_min_directional_bars: 4,
    exhaustion_min_mean_distance_atr: 2.5,
    exhaustion_max_last_range_ratio: 0.75,
    chaotic_min_alternation_ratio: 0.65,
    chaotic_min_wick_ratio: 0.6,
    chaotic_max_efficiency: 0.25,
  },
  hunting_zone_v1: {
    atr_period: 14,
    lookback_bars: 96,
    range_lookback_bars: 48,
    compression_lookback_bars: 12,
    swing_left_bars: 2,
    swing_right_bars: 3,
    zone_half_width_atr: 0.15,
    touch_tolerance_atr: 0.2,
    reaction_distance_atr: 0.5,
    reaction_bars: 4,
    compression_max_range_ratio: 0.8,
    max_test_count: 3,
    max_age_bars: 64,
    min_zone_score: 50,
  },
  liquidity_sweep_v1: {
    min_zone_score: 65,
    max_reclaim_bars: 2,
    min_wick_ratio: 0.5,
    max_follow_through_atr: 0.15,
  },
  breakout_failure_v1: {
    min_zone_score: 66,
    max_return_bars: 3,
    max_follow_through_atr: 0.2,
  },
  momentum_burst_v1: {
    min_zone_score: 67,
    min_body_ratio: 0.7,
    min_candle_range_atr: 1.3,
    max_distance_from_mean_atr: 2,
  },
  micro_structure_execution_v1: { min_rr: 1.5 },
  scalp_risk_budget_v1: {
    daily_loss_limit_r: 1,
    max_consecutive_losses: 3,
    risk_by_grade_r: { A_PLUS: 0.35, A: 0.25, B: 0.15 },
  },
  scalp_time_stop_v1: {
    max_holding_ms: {
      LIQUIDITY_SWEEP: 2_700_000,
      BREAKOUT_FAILURE: 2_600_000,
      MOMENTUM_BURST: 1_200_000,
    },
    response_window_ms: {
      LIQUIDITY_SWEEP: 900_000,
      BREAKOUT_FAILURE: 800_000,
      MOMENTUM_BURST: 300_000,
    },
  },
}

test('maps every Scalp manifest parameter into the evaluator configuration', () => {
  assert.deepEqual(scalpHistoricalConfig(manifest('helix_scalp_hunter', scalpCapabilities)), {
    marketRegime: {
      fastWindowBars: 10,
      slowWindowBars: 50,
      emaPeriod: 20,
      swingLeftBars: 2,
      swingRightBars: 3,
      trendMinEfficiency: 0.35,
      trendMinEmaSlopeAtr: 0.5,
      compressionMaxAtrRatio: 0.8,
      compressionMaxRangeRatio: 0.7,
      compressionMinOverlapRatio: 0.55,
      expansionMinAtrRatio: 1.2,
      expansionMinBodyRatio: 0.6,
      expansionMinEfficiency: 0.45,
      exhaustionMinDirectionalBars: 4,
      exhaustionMinMeanDistanceAtr: 2.5,
      exhaustionMaxLastRangeRatio: 0.75,
      chaoticMinAlternationRatio: 0.65,
      chaoticMinWickRatio: 0.6,
      chaoticMaxEfficiency: 0.25,
    },
    huntingZone: {
      atrPeriod: 14,
      lookbackBars: 96,
      rangeLookbackBars: 48,
      compressionLookbackBars: 12,
      swingLeftBars: 2,
      swingRightBars: 3,
      zoneHalfWidthAtr: 0.15,
      touchToleranceAtr: 0.2,
      reactionDistanceAtr: 0.5,
      reactionBars: 4,
      compressionMaxRangeRatio: 0.8,
      maxTestCount: 3,
      maxAgeBars: 64,
      minZoneScore: 50,
    },
    liquiditySweep: {
      minZoneScore: 65,
      maxReclaimBars: 2,
      minWickRatio: 0.5,
      maxFollowThroughAtr: 0.15,
    },
    breakoutFailure: {
      minZoneScore: 66,
      maxReturnBars: 3,
      maxFollowThroughAtr: 0.2,
    },
    momentumBurst: {
      minZoneScore: 67,
      minBodyRatio: 0.7,
      minCandleRangeAtr: 1.3,
      maxDistanceFromMeanAtr: 2,
    },
    execution: { minRr: 1.5 },
    risk: {
      dailyLossLimitR: 1,
      maxConsecutiveLosses: 3,
      riskByGradeR: { A_PLUS: 0.35, A: 0.25, B: 0.15 },
    },
    time: {
      maxHoldingMs: {
        LIQUIDITY_SWEEP: 2_700_000,
        BREAKOUT_FAILURE: 2_600_000,
        MOMENTUM_BURST: 1_200_000,
      },
      responseWindowMs: {
        LIQUIDITY_SWEEP: 900_000,
        BREAKOUT_FAILURE: 800_000,
        MOMENTUM_BURST: 300_000,
      },
    },
  })
})

const swingCapabilities = {
  daily_market_context_v1: {
    fast_window_bars: 10,
    slow_window_bars: 60,
    ema_period: 20,
    swing_left_bars: 2,
    swing_right_bars: 3,
    trend_min_efficiency: 0.3,
    trend_min_ema_slope_atr: 0.5,
    range_max_efficiency: 0.25,
    range_max_ema_slope_atr: 0.35,
  },
  swing_location_v1: {
    atr_period: 14,
    lookback_bars: 120,
    range_lookback_bars: 60,
    swing_left_bars: 2,
    swing_right_bars: 3,
    zone_half_width_atr: 0.2,
    touch_tolerance_atr: 0.25,
    reaction_distance_atr: 0.75,
    reaction_bars: 4,
    mean_reversion_distance_atr: 2.5,
    max_test_count: 4,
    max_age_bars: 90,
    min_location_score: 55,
  },
  staged_execution_v1: {
    min_rr_by_stage: { EARLY: 1.5, STANDARD: 1.8, CONFIRMED: 2 },
    max_attempts_per_thesis: 3,
  },
  swing_risk_budget_v1: {
    thesis_risk_budget_r: 1,
    risk_by_stage_r: { EARLY: 0.25, STANDARD: 0.35, CONFIRMED: 0.4 },
  },
}

test('maps every Swing manifest parameter into the evaluator configuration', () => {
  assert.deepEqual(swingHistoricalConfig(manifest('helix_swing_hunter', swingCapabilities)), {
    dailyContext: {
      fastWindowBars: 10,
      slowWindowBars: 60,
      emaPeriod: 20,
      swingLeftBars: 2,
      swingRightBars: 3,
      trendMinEfficiency: 0.3,
      trendMinEmaSlopeAtr: 0.5,
      rangeMaxEfficiency: 0.25,
      rangeMaxEmaSlopeAtr: 0.35,
    },
    location: {
      atrPeriod: 14,
      lookbackBars: 120,
      rangeLookbackBars: 60,
      swingLeftBars: 2,
      swingRightBars: 3,
      zoneHalfWidthAtr: 0.2,
      touchToleranceAtr: 0.25,
      reactionDistanceAtr: 0.75,
      reactionBars: 4,
      meanReversionDistanceAtr: 2.5,
      maxTestCount: 4,
      maxAgeBars: 90,
      minLocationScore: 55,
    },
    execution: {
      minRrByStage: { EARLY: 1.5, STANDARD: 1.8, CONFIRMED: 2 },
      maxAttemptsPerThesis: 3,
    },
    risk: {
      thesisRiskBudgetR: 1,
      riskByStageR: { EARLY: 0.25, STANDARD: 0.35, CONFIRMED: 0.4 },
    },
  })
})

test('rejects a mismatched strategy, missing capability, or non-numeric parameter', () => {
  assert.throws(
    () => scalpHistoricalConfig(manifest('helix_swing_hunter', scalpCapabilities)),
    /requires helix_scalp_hunter/,
  )

  const { hunting_zone_v1: _missing, ...missingZone } = scalpCapabilities
  assert.throws(
    () => scalpHistoricalConfig(manifest('helix_scalp_hunter', missingZone)),
    /capability hunting_zone_v1 must be an object/,
  )

  const invalidFastWindow = {
    ...scalpCapabilities,
    market_regime_v1: {
      ...scalpCapabilities.market_regime_v1,
      fast_window_bars: '10',
    },
  }
  assert.throws(
    () => scalpHistoricalConfig(manifest('helix_scalp_hunter', invalidFastWindow)),
    /market_regime_v1.fast_window_bars must be numeric/,
  )
})

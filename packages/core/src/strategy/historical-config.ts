import type { StrategyManifestIdentity } from '@helix/contracts/strategy'
import type { ScalpHistoricalEvaluatorConfig } from './scalp-historical'
import type { SwingHistoricalEvaluatorConfig } from './swing-historical'

type UnknownRecord = Record<string, unknown>

function record(value: unknown, name: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as UnknownRecord
}

function number(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be numeric`)
  return value
}

function capability(manifest: StrategyManifestIdentity, id: string) {
  return record(manifest.capabilityConfigurations[id], `capability ${id}`)
}

export function scalpHistoricalConfig(manifest: StrategyManifestIdentity): ScalpHistoricalEvaluatorConfig {
  if (manifest.id !== 'helix_scalp_hunter') throw new Error('Scalp config requires helix_scalp_hunter manifest')
  const regime = capability(manifest, 'market_regime_v1')
  const zone = capability(manifest, 'hunting_zone_v1')
  const sweep = capability(manifest, 'liquidity_sweep_v1')
  const failure = capability(manifest, 'breakout_failure_v1')
  const momentum = capability(manifest, 'momentum_burst_v1')
  const execution = capability(manifest, 'micro_structure_execution_v1')
  const risk = capability(manifest, 'scalp_risk_budget_v1')
  const grade = record(risk.risk_by_grade_r, 'scalp_risk_budget_v1.risk_by_grade_r')
  const time = capability(manifest, 'scalp_time_stop_v1')
  const maxHolding = record(time.max_holding_ms, 'scalp_time_stop_v1.max_holding_ms')
  const response = record(time.response_window_ms, 'scalp_time_stop_v1.response_window_ms')
  return {
    marketRegime: {
      fastWindowBars: number(regime.fast_window_bars, 'market_regime_v1.fast_window_bars'),
      slowWindowBars: number(regime.slow_window_bars, 'market_regime_v1.slow_window_bars'),
      emaPeriod: number(regime.ema_period, 'market_regime_v1.ema_period'),
      swingLeftBars: number(regime.swing_left_bars, 'market_regime_v1.swing_left_bars'),
      swingRightBars: number(regime.swing_right_bars, 'market_regime_v1.swing_right_bars'),
      trendMinEfficiency: number(regime.trend_min_efficiency, 'market_regime_v1.trend_min_efficiency'),
      trendMinEmaSlopeAtr: number(regime.trend_min_ema_slope_atr, 'market_regime_v1.trend_min_ema_slope_atr'),
      compressionMaxAtrRatio: number(regime.compression_max_atr_ratio, 'market_regime_v1.compression_max_atr_ratio'),
      compressionMaxRangeRatio: number(regime.compression_max_range_ratio, 'market_regime_v1.compression_max_range_ratio'),
      compressionMinOverlapRatio: number(regime.compression_min_overlap_ratio, 'market_regime_v1.compression_min_overlap_ratio'),
      expansionMinAtrRatio: number(regime.expansion_min_atr_ratio, 'market_regime_v1.expansion_min_atr_ratio'),
      expansionMinBodyRatio: number(regime.expansion_min_body_ratio, 'market_regime_v1.expansion_min_body_ratio'),
      expansionMinEfficiency: number(regime.expansion_min_efficiency, 'market_regime_v1.expansion_min_efficiency'),
      exhaustionMinDirectionalBars: number(regime.exhaustion_min_directional_bars, 'market_regime_v1.exhaustion_min_directional_bars'),
      exhaustionMinMeanDistanceAtr: number(regime.exhaustion_min_mean_distance_atr, 'market_regime_v1.exhaustion_min_mean_distance_atr'),
      exhaustionMaxLastRangeRatio: number(regime.exhaustion_max_last_range_ratio, 'market_regime_v1.exhaustion_max_last_range_ratio'),
      chaoticMinAlternationRatio: number(regime.chaotic_min_alternation_ratio, 'market_regime_v1.chaotic_min_alternation_ratio'),
      chaoticMinWickRatio: number(regime.chaotic_min_wick_ratio, 'market_regime_v1.chaotic_min_wick_ratio'),
      chaoticMaxEfficiency: number(regime.chaotic_max_efficiency, 'market_regime_v1.chaotic_max_efficiency'),
    },
    huntingZone: {
      atrPeriod: number(zone.atr_period, 'hunting_zone_v1.atr_period'),
      lookbackBars: number(zone.lookback_bars, 'hunting_zone_v1.lookback_bars'),
      rangeLookbackBars: number(zone.range_lookback_bars, 'hunting_zone_v1.range_lookback_bars'),
      compressionLookbackBars: number(zone.compression_lookback_bars, 'hunting_zone_v1.compression_lookback_bars'),
      swingLeftBars: number(zone.swing_left_bars, 'hunting_zone_v1.swing_left_bars'),
      swingRightBars: number(zone.swing_right_bars, 'hunting_zone_v1.swing_right_bars'),
      zoneHalfWidthAtr: number(zone.zone_half_width_atr, 'hunting_zone_v1.zone_half_width_atr'),
      touchToleranceAtr: number(zone.touch_tolerance_atr, 'hunting_zone_v1.touch_tolerance_atr'),
      reactionDistanceAtr: number(zone.reaction_distance_atr, 'hunting_zone_v1.reaction_distance_atr'),
      reactionBars: number(zone.reaction_bars, 'hunting_zone_v1.reaction_bars'),
      compressionMaxRangeRatio: number(zone.compression_max_range_ratio, 'hunting_zone_v1.compression_max_range_ratio'),
      maxTestCount: number(zone.max_test_count, 'hunting_zone_v1.max_test_count'),
      maxAgeBars: number(zone.max_age_bars, 'hunting_zone_v1.max_age_bars'),
      minZoneScore: number(zone.min_zone_score, 'hunting_zone_v1.min_zone_score'),
    },
    liquiditySweep: {
      minZoneScore: number(sweep.min_zone_score, 'liquidity_sweep_v1.min_zone_score'),
      maxReclaimBars: number(sweep.max_reclaim_bars, 'liquidity_sweep_v1.max_reclaim_bars'),
      minWickRatio: number(sweep.min_wick_ratio, 'liquidity_sweep_v1.min_wick_ratio'),
      maxFollowThroughAtr: number(sweep.max_follow_through_atr, 'liquidity_sweep_v1.max_follow_through_atr'),
    },
    breakoutFailure: {
      minZoneScore: number(failure.min_zone_score, 'breakout_failure_v1.min_zone_score'),
      maxReturnBars: number(failure.max_return_bars, 'breakout_failure_v1.max_return_bars'),
      maxFollowThroughAtr: number(failure.max_follow_through_atr, 'breakout_failure_v1.max_follow_through_atr'),
    },
    momentumBurst: {
      minZoneScore: number(momentum.min_zone_score, 'momentum_burst_v1.min_zone_score'),
      minBodyRatio: number(momentum.min_body_ratio, 'momentum_burst_v1.min_body_ratio'),
      minCandleRangeAtr: number(momentum.min_candle_range_atr, 'momentum_burst_v1.min_candle_range_atr'),
      maxDistanceFromMeanAtr: number(momentum.max_distance_from_mean_atr, 'momentum_burst_v1.max_distance_from_mean_atr'),
    },
    execution: { minRr: number(execution.min_rr, 'micro_structure_execution_v1.min_rr') },
    risk: {
      dailyLossLimitR: number(risk.daily_loss_limit_r, 'scalp_risk_budget_v1.daily_loss_limit_r'),
      maxConsecutiveLosses: number(risk.max_consecutive_losses, 'scalp_risk_budget_v1.max_consecutive_losses'),
      riskByGradeR: {
        A_PLUS: number(grade.A_PLUS, 'risk_by_grade_r.A_PLUS'),
        A: number(grade.A, 'risk_by_grade_r.A'),
        B: number(grade.B, 'risk_by_grade_r.B'),
      },
    },
    time: {
      maxHoldingMs: {
        LIQUIDITY_SWEEP: number(maxHolding.LIQUIDITY_SWEEP, 'max_holding_ms.LIQUIDITY_SWEEP'),
        BREAKOUT_FAILURE: number(maxHolding.BREAKOUT_FAILURE, 'max_holding_ms.BREAKOUT_FAILURE'),
        MOMENTUM_BURST: number(maxHolding.MOMENTUM_BURST, 'max_holding_ms.MOMENTUM_BURST'),
      },
      responseWindowMs: {
        LIQUIDITY_SWEEP: number(response.LIQUIDITY_SWEEP, 'response_window_ms.LIQUIDITY_SWEEP'),
        BREAKOUT_FAILURE: number(response.BREAKOUT_FAILURE, 'response_window_ms.BREAKOUT_FAILURE'),
        MOMENTUM_BURST: number(response.MOMENTUM_BURST, 'response_window_ms.MOMENTUM_BURST'),
      },
    },
  }
}

export function swingHistoricalConfig(manifest: StrategyManifestIdentity): SwingHistoricalEvaluatorConfig {
  if (manifest.id !== 'helix_swing_hunter') throw new Error('Swing config requires helix_swing_hunter manifest')
  const daily = capability(manifest, 'daily_market_context_v1')
  const location = capability(manifest, 'swing_location_v1')
  const execution = capability(manifest, 'staged_execution_v1')
  const rr = record(execution.min_rr_by_stage, 'staged_execution_v1.min_rr_by_stage')
  const risk = capability(manifest, 'swing_risk_budget_v1')
  const stageRisk = record(risk.risk_by_stage_r, 'swing_risk_budget_v1.risk_by_stage_r')
  return {
    dailyContext: {
      fastWindowBars: number(daily.fast_window_bars, 'daily_market_context_v1.fast_window_bars'),
      slowWindowBars: number(daily.slow_window_bars, 'daily_market_context_v1.slow_window_bars'),
      emaPeriod: number(daily.ema_period, 'daily_market_context_v1.ema_period'),
      swingLeftBars: number(daily.swing_left_bars, 'daily_market_context_v1.swing_left_bars'),
      swingRightBars: number(daily.swing_right_bars, 'daily_market_context_v1.swing_right_bars'),
      trendMinEfficiency: number(daily.trend_min_efficiency, 'daily_market_context_v1.trend_min_efficiency'),
      trendMinEmaSlopeAtr: number(daily.trend_min_ema_slope_atr, 'daily_market_context_v1.trend_min_ema_slope_atr'),
      rangeMaxEfficiency: number(daily.range_max_efficiency, 'daily_market_context_v1.range_max_efficiency'),
      rangeMaxEmaSlopeAtr: number(daily.range_max_ema_slope_atr, 'daily_market_context_v1.range_max_ema_slope_atr'),
    },
    location: {
      atrPeriod: number(location.atr_period, 'swing_location_v1.atr_period'),
      lookbackBars: number(location.lookback_bars, 'swing_location_v1.lookback_bars'),
      rangeLookbackBars: number(location.range_lookback_bars, 'swing_location_v1.range_lookback_bars'),
      swingLeftBars: number(location.swing_left_bars, 'swing_location_v1.swing_left_bars'),
      swingRightBars: number(location.swing_right_bars, 'swing_location_v1.swing_right_bars'),
      zoneHalfWidthAtr: number(location.zone_half_width_atr, 'swing_location_v1.zone_half_width_atr'),
      touchToleranceAtr: number(location.touch_tolerance_atr, 'swing_location_v1.touch_tolerance_atr'),
      reactionDistanceAtr: number(location.reaction_distance_atr, 'swing_location_v1.reaction_distance_atr'),
      reactionBars: number(location.reaction_bars, 'swing_location_v1.reaction_bars'),
      meanReversionDistanceAtr: number(location.mean_reversion_distance_atr, 'swing_location_v1.mean_reversion_distance_atr'),
      maxTestCount: number(location.max_test_count, 'swing_location_v1.max_test_count'),
      maxAgeBars: number(location.max_age_bars, 'swing_location_v1.max_age_bars'),
      minLocationScore: number(location.min_location_score, 'swing_location_v1.min_location_score'),
    },
    execution: {
      minRrByStage: {
        EARLY: number(rr.EARLY, 'min_rr_by_stage.EARLY'),
        STANDARD: number(rr.STANDARD, 'min_rr_by_stage.STANDARD'),
        CONFIRMED: number(rr.CONFIRMED, 'min_rr_by_stage.CONFIRMED'),
      },
      maxAttemptsPerThesis: number(execution.max_attempts_per_thesis, 'staged_execution_v1.max_attempts_per_thesis'),
    },
    risk: {
      thesisRiskBudgetR: number(risk.thesis_risk_budget_r, 'swing_risk_budget_v1.thesis_risk_budget_r'),
      riskByStageR: {
        EARLY: number(stageRisk.EARLY, 'risk_by_stage_r.EARLY'),
        STANDARD: number(stageRisk.STANDARD, 'risk_by_stage_r.STANDARD'),
        CONFIRMED: number(stageRisk.CONFIRMED, 'risk_by_stage_r.CONFIRMED'),
      },
    },
  }
}

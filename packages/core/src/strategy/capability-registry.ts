import type {
  EngineCapabilityIdentity,
  StrategyEngineCompatibility,
  StrategyManifestIdentity,
} from '@helix/contracts/strategy'

type EngineCapabilityDefinition = EngineCapabilityIdentity & {
  validateConfiguration?: (value: unknown) => boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function positive(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function nonNegative(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function score(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

function ratio(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function positiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function exactPositiveRecord(value: unknown, keys: string[]) {
  const data = record(value)
  return Boolean(data && exactKeys(data, keys) && keys.every((key) => positive(data[key])))
}

function scalpTimeConfig(value: unknown) {
  const data = record(value)
  const events = ['LIQUIDITY_SWEEP', 'BREAKOUT_FAILURE', 'MOMENTUM_BURST']
  if (!data || !exactKeys(data, ['max_holding_ms', 'response_window_ms'])) return false
  const maxHolding = record(data.max_holding_ms)
  const responseWindow = record(data.response_window_ms)
  return Boolean(maxHolding
    && responseWindow
    && exactPositiveRecord(maxHolding, events)
    && exactPositiveRecord(responseWindow, events)
    && events.every((event) => Number(responseWindow[event]) <= Number(maxHolding[event])))
}

function scalpMarketRegimeConfig(value: unknown) {
  const data = record(value)
  const keys = [
    'fast_window_bars', 'slow_window_bars', 'ema_period', 'swing_left_bars', 'swing_right_bars',
    'trend_min_efficiency', 'trend_min_ema_slope_atr',
    'compression_max_atr_ratio', 'compression_max_range_ratio', 'compression_min_overlap_ratio',
    'expansion_min_atr_ratio', 'expansion_min_body_ratio', 'expansion_min_efficiency',
    'exhaustion_min_directional_bars', 'exhaustion_min_mean_distance_atr', 'exhaustion_max_last_range_ratio',
    'chaotic_min_alternation_ratio', 'chaotic_min_wick_ratio', 'chaotic_max_efficiency',
  ]
  return Boolean(data
    && exactKeys(data, keys)
    && positiveInteger(data.fast_window_bars)
    && positiveInteger(data.slow_window_bars)
    && Number(data.fast_window_bars) >= 3
    && Number(data.fast_window_bars) < Number(data.slow_window_bars)
    && positiveInteger(data.ema_period)
    && positiveInteger(data.swing_left_bars)
    && positiveInteger(data.swing_right_bars)
    && ratio(data.trend_min_efficiency)
    && positive(data.trend_min_ema_slope_atr)
    && positive(data.compression_max_atr_ratio)
    && positive(data.compression_max_range_ratio)
    && ratio(data.compression_min_overlap_ratio)
    && positive(data.expansion_min_atr_ratio)
    && ratio(data.expansion_min_body_ratio)
    && ratio(data.expansion_min_efficiency)
    && positiveInteger(data.exhaustion_min_directional_bars)
    && positive(data.exhaustion_min_mean_distance_atr)
    && positive(data.exhaustion_max_last_range_ratio)
    && ratio(data.chaotic_min_alternation_ratio)
    && ratio(data.chaotic_min_wick_ratio)
    && ratio(data.chaotic_max_efficiency))
}

function scalpHuntingZoneConfig(value: unknown) {
  const data = record(value)
  const keys = [
    'atr_period', 'lookback_bars', 'range_lookback_bars', 'compression_lookback_bars',
    'swing_left_bars', 'swing_right_bars', 'zone_half_width_atr', 'touch_tolerance_atr',
    'reaction_distance_atr', 'reaction_bars', 'compression_max_range_ratio', 'max_test_count',
    'max_age_bars', 'min_zone_score',
  ]
  return Boolean(data
    && exactKeys(data, keys)
    && positiveInteger(data.atr_period)
    && positiveInteger(data.lookback_bars)
    && positiveInteger(data.range_lookback_bars)
    && positiveInteger(data.compression_lookback_bars)
    && Number(data.range_lookback_bars) <= Number(data.lookback_bars)
    && Number(data.compression_lookback_bars) <= Number(data.lookback_bars)
    && positiveInteger(data.swing_left_bars)
    && positiveInteger(data.swing_right_bars)
    && positive(data.zone_half_width_atr)
    && positive(data.touch_tolerance_atr)
    && positive(data.reaction_distance_atr)
    && positiveInteger(data.reaction_bars)
    && positive(data.compression_max_range_ratio)
    && positiveInteger(data.max_test_count)
    && positiveInteger(data.max_age_bars)
    && score(data.min_zone_score))
}

function swingDailyContextConfig(value: unknown) {
  const data = record(value)
  const keys = [
    'fast_window_bars', 'slow_window_bars', 'ema_period', 'swing_left_bars', 'swing_right_bars',
    'trend_min_efficiency', 'trend_min_ema_slope_atr', 'range_max_efficiency', 'range_max_ema_slope_atr',
  ]
  return Boolean(data
    && exactKeys(data, keys)
    && positiveInteger(data.fast_window_bars)
    && positiveInteger(data.slow_window_bars)
    && Number(data.fast_window_bars) >= 3
    && Number(data.fast_window_bars) < Number(data.slow_window_bars)
    && positiveInteger(data.ema_period)
    && positiveInteger(data.swing_left_bars)
    && positiveInteger(data.swing_right_bars)
    && ratio(data.trend_min_efficiency)
    && positive(data.trend_min_ema_slope_atr)
    && ratio(data.range_max_efficiency)
    && positive(data.range_max_ema_slope_atr))
}

function swingLocationConfig(value: unknown) {
  const data = record(value)
  const keys = [
    'atr_period', 'lookback_bars', 'range_lookback_bars', 'swing_left_bars', 'swing_right_bars',
    'zone_half_width_atr', 'touch_tolerance_atr', 'reaction_distance_atr', 'reaction_bars',
    'mean_reversion_distance_atr', 'max_test_count', 'max_age_bars', 'min_location_score',
  ]
  return Boolean(data
    && exactKeys(data, keys)
    && positiveInteger(data.atr_period)
    && positiveInteger(data.lookback_bars)
    && positiveInteger(data.range_lookback_bars)
    && Number(data.range_lookback_bars) <= Number(data.lookback_bars)
    && positiveInteger(data.swing_left_bars)
    && positiveInteger(data.swing_right_bars)
    && positive(data.zone_half_width_atr)
    && positive(data.touch_tolerance_atr)
    && positive(data.reaction_distance_atr)
    && positiveInteger(data.reaction_bars)
    && positive(data.mean_reversion_distance_atr)
    && positiveInteger(data.max_test_count)
    && positiveInteger(data.max_age_bars)
    && score(data.min_location_score))
}

const ENGINE_CAPABILITIES: EngineCapabilityDefinition[] = [
  {
    id: 'market_regime_v1', kind: 'component', family: 'scalp', requiresConfiguration: true,
    validateConfiguration: scalpMarketRegimeConfig,
  },
  {
    id: 'hunting_zone_v1', kind: 'component', family: 'scalp', requiresConfiguration: true,
    validateConfiguration: scalpHuntingZoneConfig,
  },
  {
    id: 'liquidity_sweep_v1', kind: 'component', family: 'scalp', requiresConfiguration: true,
    validateConfiguration: (value) => {
      const data = record(value)
      return Boolean(data
        && exactKeys(data, ['min_zone_score', 'max_reclaim_bars', 'min_wick_ratio', 'max_follow_through_atr'])
        && score(data.min_zone_score)
        && positiveInteger(data.max_reclaim_bars)
        && ratio(data.min_wick_ratio)
        && nonNegative(data.max_follow_through_atr))
    },
  },
  {
    id: 'breakout_failure_v1', kind: 'component', family: 'scalp', requiresConfiguration: true,
    validateConfiguration: (value) => {
      const data = record(value)
      return Boolean(data
        && exactKeys(data, ['min_zone_score', 'max_return_bars', 'max_follow_through_atr'])
        && score(data.min_zone_score)
        && positiveInteger(data.max_return_bars)
        && nonNegative(data.max_follow_through_atr))
    },
  },
  {
    id: 'momentum_burst_v1', kind: 'component', family: 'scalp', requiresConfiguration: true,
    validateConfiguration: (value) => {
      const data = record(value)
      return Boolean(data
        && exactKeys(data, ['min_zone_score', 'min_body_ratio', 'min_candle_range_atr', 'max_distance_from_mean_atr'])
        && score(data.min_zone_score)
        && ratio(data.min_body_ratio)
        && nonNegative(data.min_candle_range_atr)
        && nonNegative(data.max_distance_from_mean_atr))
    },
  },
  {
    id: 'micro_structure_execution_v1', kind: 'component', family: 'scalp', requiresConfiguration: true,
    validateConfiguration: (value) => {
      const data = record(value)
      return Boolean(data && exactKeys(data, ['min_rr']) && positive(data.min_rr))
    },
  },
  { id: 'immediate_response_v1', kind: 'component', family: 'scalp', requiresConfiguration: false },
  { id: 'scalp_event_lifecycle_v1', kind: 'policy', family: 'scalp', requiresConfiguration: false },
  {
    id: 'scalp_risk_budget_v1', kind: 'policy', family: 'scalp', requiresConfiguration: true,
    validateConfiguration: (value) => {
      const data = record(value)
      return Boolean(data
        && exactKeys(data, ['daily_loss_limit_r', 'max_consecutive_losses', 'risk_by_grade_r'])
        && positive(data.daily_loss_limit_r)
        && positiveInteger(data.max_consecutive_losses)
        && exactPositiveRecord(data.risk_by_grade_r, ['A_PLUS', 'A', 'B']))
    },
  },
  {
    id: 'scalp_time_stop_v1', kind: 'policy', family: 'scalp', requiresConfiguration: true,
    validateConfiguration: scalpTimeConfig,
  },
  {
    id: 'daily_market_context_v1', kind: 'component', family: 'swing', requiresConfiguration: true,
    validateConfiguration: swingDailyContextConfig,
  },
  {
    id: 'swing_location_v1', kind: 'component', family: 'swing', requiresConfiguration: true,
    validateConfiguration: swingLocationConfig,
  },
  { id: 'trade_thesis_v1', kind: 'component', family: 'swing', requiresConfiguration: false },
  { id: 'evidence_accumulation_v1', kind: 'component', family: 'swing', requiresConfiguration: false },
  {
    id: 'staged_execution_v1', kind: 'component', family: 'swing', requiresConfiguration: true,
    validateConfiguration: (value) => {
      const data = record(value)
      return Boolean(data
        && exactKeys(data, ['min_rr_by_stage', 'max_attempts_per_thesis'])
        && exactPositiveRecord(data.min_rr_by_stage, ['EARLY', 'STANDARD', 'CONFIRMED'])
        && positiveInteger(data.max_attempts_per_thesis))
    },
  },
  { id: 'swing_thesis_lifecycle_v1', kind: 'policy', family: 'swing', requiresConfiguration: false },
  {
    id: 'swing_risk_budget_v1', kind: 'policy', family: 'swing', requiresConfiguration: true,
    validateConfiguration: (value) => {
      const data = record(value)
      return Boolean(data
        && exactKeys(data, ['thesis_risk_budget_r', 'risk_by_stage_r'])
        && positive(data.thesis_risk_budget_r)
        && exactPositiveRecord(data.risk_by_stage_r, ['EARLY', 'STANDARD', 'CONFIRMED']))
    },
  },
  { id: 'thesis_invalidation_v1', kind: 'policy', family: 'swing', requiresConfiguration: false },
]

export function listEngineCapabilities() {
  return ENGINE_CAPABILITIES.map(({ validateConfiguration: _, ...capability }) => capability)
}

export function evaluateStrategyEngineCompatibility(
  manifest: StrategyManifestIdentity,
  engineCommit: string,
): StrategyEngineCompatibility {
  const availableIds = new Set(
    ENGINE_CAPABILITIES
      .filter((capability) => capability.family === manifest.family)
      .map((capability) => capability.id),
  )
  const available = manifest.requiredEngineCapabilities.filter((id) => availableIds.has(id))
  const missing = manifest.requiredEngineCapabilities.filter((id) => !availableIds.has(id))
  const capabilityById = new Map(ENGINE_CAPABILITIES.map((capability) => [capability.id, capability]))
  const unconfigured = available.filter((id) => (
    capabilityById.get(id)?.requiresConfiguration
    && manifest.capabilityConfigurations[id] === undefined
  ))
  const invalidConfiguration = available.filter((id) => {
    const capability = capabilityById.get(id)
    const config = manifest.capabilityConfigurations[id]
    if (!capability?.requiresConfiguration) return config !== undefined
    return config !== undefined && !capability.validateConfiguration?.(config)
  })
  return {
    strategyId: manifest.id,
    engineCommit,
    compatible: missing.length === 0 && unconfigured.length === 0 && invalidConfiguration.length === 0,
    required: [...manifest.requiredEngineCapabilities],
    available,
    missing,
    unconfigured,
    invalidConfiguration,
  }
}

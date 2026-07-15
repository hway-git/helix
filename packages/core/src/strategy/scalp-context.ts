import type { Candle } from '@helix/contracts/market'
import type {
  ScalpFeatureSnapshot,
  ScalpHuntingZone,
  ScalpHuntingZoneConfig,
  ScalpHuntingZoneScan,
  ScalpMarketRegime,
  ScalpMarketRegimeConfig,
  ScalpMarketRegimeDecision,
  ScalpMarketRegimeType,
} from '@helix/contracts/scalp'
import {
  average,
  clamp,
  confirmedSwings,
  emaSeries,
  marketStructureFeatures,
  trueRanges,
  validateClosedCandles,
} from './market-structure'

const HOUR_MS = 60 * 60 * 1000
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000

function positive(value: number, field: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`)
}

function nonNegative(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative`)
}

function positiveInteger(value: number, field: string, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${field} must be an integer >= ${minimum}`)
}

function unitRatio(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${field} must be between 0 and 1`)
}

function confidence(parts: number[]) {
  return Math.round(100 * average(parts.map((value) => clamp(value))))
}

function regimeConfig(config: ScalpMarketRegimeConfig) {
  positiveInteger(config.fastWindowBars, 'config.fastWindowBars', 3)
  positiveInteger(config.slowWindowBars, 'config.slowWindowBars', 4)
  positiveInteger(config.emaPeriod, 'config.emaPeriod', 2)
  positiveInteger(config.swingLeftBars, 'config.swingLeftBars')
  positiveInteger(config.swingRightBars, 'config.swingRightBars')
  if (config.fastWindowBars >= config.slowWindowBars) throw new Error('fastWindowBars must be smaller than slowWindowBars')
  unitRatio(config.trendMinEfficiency, 'config.trendMinEfficiency')
  positive(config.trendMinEmaSlopeAtr, 'config.trendMinEmaSlopeAtr')
  positive(config.compressionMaxAtrRatio, 'config.compressionMaxAtrRatio')
  positive(config.compressionMaxRangeRatio, 'config.compressionMaxRangeRatio')
  unitRatio(config.compressionMinOverlapRatio, 'config.compressionMinOverlapRatio')
  positive(config.expansionMinAtrRatio, 'config.expansionMinAtrRatio')
  unitRatio(config.expansionMinBodyRatio, 'config.expansionMinBodyRatio')
  unitRatio(config.expansionMinEfficiency, 'config.expansionMinEfficiency')
  positiveInteger(config.exhaustionMinDirectionalBars, 'config.exhaustionMinDirectionalBars', 2)
  positive(config.exhaustionMinMeanDistanceAtr, 'config.exhaustionMinMeanDistanceAtr')
  positive(config.exhaustionMaxLastRangeRatio, 'config.exhaustionMaxLastRangeRatio')
  unitRatio(config.chaoticMinAlternationRatio, 'config.chaoticMinAlternationRatio')
  unitRatio(config.chaoticMinWickRatio, 'config.chaoticMinWickRatio')
  unitRatio(config.chaoticMaxEfficiency, 'config.chaoticMaxEfficiency')
}

export function classifyScalpMarketRegime(
  config: ScalpMarketRegimeConfig,
  input: { id: string; symbol: string; candles: Candle[] },
): ScalpMarketRegimeDecision {
  regimeConfig(config)
  if (!input.id.trim() || !input.symbol.trim()) throw new Error('regime id and symbol are required')
  const minimumBars = Math.max(config.slowWindowBars + 1, config.emaPeriod + 1)
  validateClosedCandles(input.candles, HOUR_MS, minimumBars)
  const features = marketStructureFeatures(input.candles, {
    fastWindowBars: config.fastWindowBars,
    slowWindowBars: config.slowWindowBars,
    emaPeriod: config.emaPeriod,
    swingLeftBars: config.swingLeftBars,
    swingRightBars: config.swingRightBars,
  })
  const structuralTrend = (features.highRelation === 'HIGHER' && features.lowRelation === 'HIGHER')
    || (features.highRelation === 'LOWER' && features.lowRelation === 'LOWER')
  const chaotic = features.alternationRatio >= config.chaoticMinAlternationRatio
    && features.averageWickRatio >= config.chaoticMinWickRatio
    && features.efficiency <= config.chaoticMaxEfficiency
  const exhausted = features.directionalBars >= config.exhaustionMinDirectionalBars
    && features.meanDistanceAtr >= config.exhaustionMinMeanDistanceAtr
    && features.lastRangeRatio <= config.exhaustionMaxLastRangeRatio
  const expanding = features.atrRatio >= config.expansionMinAtrRatio
    && features.averageBodyRatio >= config.expansionMinBodyRatio
    && features.efficiency >= config.expansionMinEfficiency
  const compressed = features.atrRatio <= config.compressionMaxAtrRatio
    && features.rangeRatio <= config.compressionMaxRangeRatio
    && features.overlapRatio >= config.compressionMinOverlapRatio
  const trending = structuralTrend
    && features.efficiency >= config.trendMinEfficiency
    && Math.abs(features.emaSlopeAtr) >= config.trendMinEmaSlopeAtr

  let type: ScalpMarketRegimeType
  let score: number
  if (chaotic) {
    type = 'CHAOTIC'
    score = confidence([
      features.alternationRatio / config.chaoticMinAlternationRatio,
      features.averageWickRatio / config.chaoticMinWickRatio,
      config.chaoticMaxEfficiency / Math.max(features.efficiency, 0.01),
    ])
  } else if (exhausted) {
    type = 'EXHAUSTED'
    score = confidence([
      features.directionalBars / config.exhaustionMinDirectionalBars,
      features.meanDistanceAtr / config.exhaustionMinMeanDistanceAtr,
      config.exhaustionMaxLastRangeRatio / Math.max(features.lastRangeRatio, 0.01),
    ])
  } else if (expanding) {
    type = 'EXPANDING'
    score = confidence([
      features.atrRatio / config.expansionMinAtrRatio,
      features.averageBodyRatio / config.expansionMinBodyRatio,
      features.efficiency / config.expansionMinEfficiency,
    ])
  } else if (compressed) {
    type = 'COMPRESSED'
    score = confidence([
      config.compressionMaxAtrRatio / Math.max(features.atrRatio, 0.01),
      config.compressionMaxRangeRatio / Math.max(features.rangeRatio, 0.01),
      features.overlapRatio / config.compressionMinOverlapRatio,
    ])
  } else if (trending) {
    type = 'TRENDING'
    score = confidence([
      features.efficiency / config.trendMinEfficiency,
      Math.abs(features.emaSlopeAtr) / config.trendMinEmaSlopeAtr,
      structuralTrend ? 1 : 0,
    ])
  } else {
    type = 'RANGING'
    score = confidence([
      1 - features.efficiency,
      1 - clamp(Math.abs(features.emaSlopeAtr) / config.trendMinEmaSlopeAtr),
      features.overlapRatio,
    ])
  }

  const observedAt = input.candles.at(-1)!.time + HOUR_MS
  const regime: ScalpMarketRegime = {
    id: input.id,
    symbol: input.symbol,
    type,
    score,
    observedAt,
  }
  const featureSnapshot: ScalpFeatureSnapshot = {
    atr_ratio: features.atrRatio,
    range_ratio: features.rangeRatio,
    average_body_ratio: features.averageBodyRatio,
    average_wick_ratio: features.averageWickRatio,
    overlap_ratio: features.overlapRatio,
    efficiency: features.efficiency,
    alternation_ratio: features.alternationRatio,
    ema_slope_atr: features.emaSlopeAtr,
    mean_distance_atr: features.meanDistanceAtr,
    directional_bars: features.directionalBars,
    last_range_ratio: features.lastRangeRatio,
    high_relation: features.highRelation,
    low_relation: features.lowRelation,
  }
  return { regime, reasonCodes: [`REGIME_${type}`], featureSnapshot }
}

type ZoneCandidate = {
  type: string
  price: number
  directionInterest: 'LONG' | 'SHORT' | 'BOTH'
  referenceIndex: number
  detectedIndex: number
  structuralScore: number
}

function zoneConfig(config: ScalpHuntingZoneConfig) {
  for (const [field, value] of Object.entries(config)) {
    if (field === 'zoneHalfWidthAtr'
      || field === 'touchToleranceAtr'
      || field === 'reactionDistanceAtr'
      || field === 'compressionMaxRangeRatio') positive(value, `config.${field}`)
    else if (field === 'minZoneScore') {
      nonNegative(value, `config.${field}`)
      if (value > 100) throw new Error('config.minZoneScore must be <= 100')
    } else positiveInteger(value, `config.${field}`)
  }
  if (config.rangeLookbackBars > config.lookbackBars || config.compressionLookbackBars > config.lookbackBars) {
    throw new Error('zone sub-lookbacks cannot exceed lookbackBars')
  }
}

function compatibilityScore(type: string, regime: ScalpMarketRegime['type']) {
  if (regime === 'CHAOTIC') return 0
  if (type === 'EMA_MEAN_AREA') return regime === 'TRENDING' || regime === 'EXPANDING' ? 20 : 10
  if (type.startsWith('COMPRESSION_')) return regime === 'COMPRESSED' || regime === 'EXPANDING' ? 20 : 5
  if (regime === 'RANGING' || regime === 'EXHAUSTED') return 20
  return 10
}

export function scanScalpHuntingZones(
  config: ScalpHuntingZoneConfig,
  input: { symbol: string; candles: Candle[]; regime: ScalpMarketRegime },
): ScalpHuntingZoneScan {
  zoneConfig(config)
  if (!input.symbol.trim() || input.regime.symbol !== input.symbol) throw new Error('zone symbol must match regime symbol')
  const minimumBars = Math.max(config.lookbackBars, config.atrPeriod + 1)
  validateClosedCandles(input.candles, FIFTEEN_MINUTES_MS, minimumBars)
  const evaluatedAt = input.candles.at(-1)!.time + FIFTEEN_MINUTES_MS
  if (input.regime.observedAt > evaluatedAt) throw new Error('regime observation cannot come from the future')
  if (input.regime.type === 'CHAOTIC') {
    return {
      zones: [],
      reasonCodes: ['REGIME_CHAOTIC', 'NO_HUNTING_ZONE'],
      featureSnapshot: { regime: input.regime.type },
    }
  }

  const candles = input.candles.slice(-config.lookbackBars)
  const tr = trueRanges(candles)
  const atr = average(tr.slice(-config.atrPeriod))
  if (atr <= 0) throw new Error('zone ATR must be positive')
  const lastIndex = candles.length - 1
  const candidates: ZoneCandidate[] = []
  const swings = confirmedSwings(candles, config.swingLeftBars, config.swingRightBars)
  for (const side of ['HIGH', 'LOW'] as const) {
    const swing = swings.filter((candidate) => candidate.side === side).at(-1)
    if (swing) {
      candidates.push({
        type: side === 'HIGH' ? 'LOCAL_SWING_HIGH' : 'LOCAL_SWING_LOW',
        price: swing.price,
        directionInterest: side === 'HIGH' ? 'SHORT' : 'LONG',
        referenceIndex: swing.index,
        detectedIndex: swing.knownAtIndex,
        structuralScore: 30,
      })
    }
  }
  const rangeStart = Math.max(0, candles.length - config.rangeLookbackBars)
  const rangeCandles = candles.slice(rangeStart)
  const rangeHigh = Math.max(...rangeCandles.map((candle) => candle.high))
  const rangeLow = Math.min(...rangeCandles.map((candle) => candle.low))
  candidates.push(
    {
      type: 'RANGE_HIGH', price: rangeHigh, directionInterest: 'SHORT',
      referenceIndex: rangeStart + rangeCandles.findIndex((candle) => candle.high === rangeHigh),
      detectedIndex: lastIndex, structuralScore: 30,
    },
    {
      type: 'RANGE_LOW', price: rangeLow, directionInterest: 'LONG',
      referenceIndex: rangeStart + rangeCandles.findIndex((candle) => candle.low === rangeLow),
      detectedIndex: lastIndex, structuralScore: 30,
    },
  )
  const compressionStart = candles.length - config.compressionLookbackBars
  const recentRanges = candles.slice(compressionStart).map((candle) => candle.high - candle.low)
  const baselineRanges = candles.map((candle) => candle.high - candle.low)
  const compressed = average(recentRanges) / average(baselineRanges) <= config.compressionMaxRangeRatio
  if (compressed) {
    candidates.push(
      {
        type: 'COMPRESSION_HIGH', price: Math.max(...candles.slice(compressionStart).map((candle) => candle.high)),
        directionInterest: 'SHORT', referenceIndex: compressionStart, detectedIndex: lastIndex, structuralScore: 30,
      },
      {
        type: 'COMPRESSION_LOW', price: Math.min(...candles.slice(compressionStart).map((candle) => candle.low)),
        directionInterest: 'LONG', referenceIndex: compressionStart, detectedIndex: lastIndex, structuralScore: 30,
      },
    )
  }
  const mean = emaSeries(candles.map((candle) => candle.close), 20).at(-1)!
  candidates.push({
    type: 'EMA_MEAN_AREA', price: mean, directionInterest: 'BOTH',
    referenceIndex: lastIndex, detectedIndex: lastIndex, structuralScore: 15,
  })

  const halfWidth = atr * config.zoneHalfWidthAtr
  const selected: ZoneCandidate[] = []
  for (const candidate of candidates.sort((left, right) => right.structuralScore - left.structuralScore)) {
    if (lastIndex - candidate.referenceIndex > config.maxAgeBars) continue
    if (selected.some((existing) => Math.abs(existing.price - candidate.price) <= halfWidth * 2)) continue
    selected.push(candidate)
  }

  const zones: ScalpHuntingZone[] = []
  for (const candidate of selected) {
    const lower = candidate.price - halfWidth
    const upper = candidate.price + halfWidth
    const touchIndices: number[] = []
    for (let index = candidate.detectedIndex + 1; index <= lastIndex; index += 1) {
      const candle = candles[index]!
      const tolerance = atr * config.touchToleranceAtr
      if (candle.low <= upper + tolerance && candle.high >= lower - tolerance) touchIndices.push(index)
    }
    let reactions = 0
    for (const index of touchIndices) {
      const future = candles.slice(index + 1, index + 1 + config.reactionBars)
      if (candidate.directionInterest === 'SHORT'
        && future.some((candle) => candle.low <= lower - atr * config.reactionDistanceAtr)) reactions += 1
      else if (candidate.directionInterest === 'LONG'
        && future.some((candle) => candle.high >= upper + atr * config.reactionDistanceAtr)) reactions += 1
      else if (candidate.directionInterest === 'BOTH'
        && future.some((candle) => candle.high >= upper + atr * config.reactionDistanceAtr
          || candle.low <= lower - atr * config.reactionDistanceAtr)) reactions += 1
    }
    const ageBars = lastIndex - candidate.referenceIndex
    const freshness = Math.max(0, 10 - Math.max(0, touchIndices.length - 1) * 3 - (ageBars / config.maxAgeBars) * 5)
    const liquidity = Math.min(15, touchIndices.length * 5)
    const reaction = Math.min(20, reactions * 10)
    const compatibility = compatibilityScore(candidate.type, input.regime.type)
    const width = 5 * clamp(1 - config.zoneHalfWidthAtr)
    const score = Math.round(candidate.structuralScore + reaction + compatibility + liquidity + freshness + width)
    if (score < config.minZoneScore) continue
    const detectedAt = candles[candidate.detectedIndex]!.time + FIFTEEN_MINUTES_MS
    zones.push({
      id: `${input.symbol}:15m:${candidate.type}:${detectedAt}`,
      symbol: input.symbol,
      type: candidate.type,
      state: touchIndices.length > config.maxTestCount ? 'WEAKENED' : 'ACTIVE',
      score: Math.min(100, score),
      testCount: touchIndices.length,
      directionInterest: candidate.directionInterest,
      boundary: { lower, upper },
      detectedAt,
      expiresAt: detectedAt + config.maxAgeBars * FIFTEEN_MINUTES_MS,
    })
  }
  zones.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  const featureSnapshot: ScalpFeatureSnapshot = {
    regime: input.regime.type,
    atr,
    compression_confirmed: compressed,
    candidate_count: candidates.length,
    accepted_zone_count: zones.length,
  }
  return {
    zones,
    reasonCodes: zones.length ? ['HUNTING_ZONE_DETECTED'] : ['NO_HUNTING_ZONE'],
    featureSnapshot,
  }
}

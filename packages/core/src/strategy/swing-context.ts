import type { Candle } from '@helix/contracts/market'
import type {
  SwingContextBias,
  SwingDailyMarketContextConfig,
  SwingDailyMarketContextDecision,
  SwingDailyMarketState,
  SwingFeatureSnapshot,
  SwingLocationCandidate,
  SwingLocationConfig,
  SwingLocationScan,
  SwingMarketContext,
} from '@helix/contracts/swing'
import {
  average,
  clamp,
  confirmedSwings,
  emaSeries,
  marketStructureFeatures,
  trueRanges,
  validateClosedCandles,
} from './market-structure'

const DAY_MS = 24 * 60 * 60 * 1000
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000

function positive(value: number, field: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`)
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

function dailyConfig(config: SwingDailyMarketContextConfig) {
  positiveInteger(config.fastWindowBars, 'config.fastWindowBars', 3)
  positiveInteger(config.slowWindowBars, 'config.slowWindowBars', 4)
  positiveInteger(config.emaPeriod, 'config.emaPeriod', 2)
  positiveInteger(config.swingLeftBars, 'config.swingLeftBars')
  positiveInteger(config.swingRightBars, 'config.swingRightBars')
  if (config.fastWindowBars >= config.slowWindowBars) throw new Error('fastWindowBars must be smaller than slowWindowBars')
  unitRatio(config.trendMinEfficiency, 'config.trendMinEfficiency')
  positive(config.trendMinEmaSlopeAtr, 'config.trendMinEmaSlopeAtr')
  unitRatio(config.rangeMaxEfficiency, 'config.rangeMaxEfficiency')
  positive(config.rangeMaxEmaSlopeAtr, 'config.rangeMaxEmaSlopeAtr')
}

export function classifySwingDailyMarketContext(
  config: SwingDailyMarketContextConfig,
  input: { id: string; symbol: string; candles: Candle[] },
): SwingDailyMarketContextDecision {
  dailyConfig(config)
  if (!input.id.trim() || !input.symbol.trim()) throw new Error('context id and symbol are required')
  const minimumBars = Math.max(config.slowWindowBars + 1, config.emaPeriod + 1)
  validateClosedCandles(input.candles, DAY_MS, minimumBars)
  const features = marketStructureFeatures(input.candles, {
    fastWindowBars: config.fastWindowBars,
    slowWindowBars: config.slowWindowBars,
    emaPeriod: config.emaPeriod,
    swingLeftBars: config.swingLeftBars,
    swingRightBars: config.swingRightBars,
  })
  const bullish = features.highRelation === 'HIGHER'
    && features.lowRelation === 'HIGHER'
    && features.efficiency >= config.trendMinEfficiency
    && features.emaSlopeAtr >= config.trendMinEmaSlopeAtr
  const bearish = features.highRelation === 'LOWER'
    && features.lowRelation === 'LOWER'
    && features.efficiency >= config.trendMinEfficiency
    && features.emaSlopeAtr <= -config.trendMinEmaSlopeAtr
  const knownStructure = features.highRelation !== 'UNKNOWN' && features.lowRelation !== 'UNKNOWN'
  const mixedStructure = knownStructure
    && !((features.highRelation === 'HIGHER' && features.lowRelation === 'HIGHER')
      || (features.highRelation === 'LOWER' && features.lowRelation === 'LOWER'))
  const range = features.efficiency <= config.rangeMaxEfficiency
    && Math.abs(features.emaSlopeAtr) <= config.rangeMaxEmaSlopeAtr

  let state: SwingDailyMarketState
  let bias: SwingContextBias
  let score: number
  if (bullish) {
    state = 'BULLISH_TREND'
    bias = 'BULLISH'
    score = confidence([
      features.efficiency / config.trendMinEfficiency,
      features.emaSlopeAtr / config.trendMinEmaSlopeAtr,
      1,
    ])
  } else if (bearish) {
    state = 'BEARISH_TREND'
    bias = 'BEARISH'
    score = confidence([
      features.efficiency / config.trendMinEfficiency,
      Math.abs(features.emaSlopeAtr) / config.trendMinEmaSlopeAtr,
      1,
    ])
  } else if (mixedStructure) {
    state = 'TRANSITION'
    bias = 'NEUTRAL'
    score = confidence([features.efficiency, Math.min(1, Math.abs(features.emaSlopeAtr)), 0.75])
  } else if (range) {
    state = 'RANGE'
    bias = 'NEUTRAL'
    score = confidence([
      config.rangeMaxEfficiency / Math.max(features.efficiency, 0.01),
      config.rangeMaxEmaSlopeAtr / Math.max(Math.abs(features.emaSlopeAtr), 0.01),
      features.overlapRatio,
    ])
  } else {
    state = 'UNCLEAR'
    bias = 'NEUTRAL'
    score = confidence([1 - features.efficiency, 1 - clamp(Math.abs(features.emaSlopeAtr)), 0.25])
  }
  const observedAt = input.candles.at(-1)!.time + DAY_MS
  const reasonCodes = [`DAILY_CONTEXT_${state}`]
  const context: SwingMarketContext = {
    id: input.id,
    symbol: input.symbol,
    daily: state,
    h4: 'UNASSESSED',
    reasonCodes,
    observedAt,
  }
  const featureSnapshot: SwingFeatureSnapshot = {
    atr_ratio: features.atrRatio,
    range_ratio: features.rangeRatio,
    overlap_ratio: features.overlapRatio,
    efficiency: features.efficiency,
    ema_slope_atr: features.emaSlopeAtr,
    mean_distance_atr: features.meanDistanceAtr,
    high_relation: features.highRelation,
    low_relation: features.lowRelation,
  }
  return { context, state, bias, score, reasonCodes, featureSnapshot }
}

type LocationCandidate = {
  type: string
  price: number
  direction: 'LONG' | 'SHORT'
  referenceIndex: number
  detectedIndex: number
  structuralScore: number
}

function locationConfig(config: SwingLocationConfig) {
  for (const [field, value] of Object.entries(config)) {
    if (field === 'zoneHalfWidthAtr'
      || field === 'touchToleranceAtr'
      || field === 'reactionDistanceAtr'
      || field === 'meanReversionDistanceAtr') positive(value, `config.${field}`)
    else if (field === 'minLocationScore') {
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error('config.minLocationScore must be between 0 and 100')
      }
    } else positiveInteger(value, `config.${field}`)
  }
  if (config.rangeLookbackBars > config.lookbackBars) throw new Error('rangeLookbackBars cannot exceed lookbackBars')
}

function contextScore(direction: 'LONG' | 'SHORT', context: SwingDailyMarketContextDecision) {
  if (context.bias === 'NEUTRAL') return 10
  return (direction === 'LONG' && context.bias === 'BULLISH')
    || (direction === 'SHORT' && context.bias === 'BEARISH') ? 15 : 5
}

export function scanSwingLocations(
  config: SwingLocationConfig,
  input: { symbol: string; candles: Candle[]; context: SwingDailyMarketContextDecision },
): SwingLocationScan {
  locationConfig(config)
  if (!input.symbol.trim() || input.context.context.symbol !== input.symbol) {
    throw new Error('location symbol must match daily context symbol')
  }
  const minimumBars = Math.max(config.lookbackBars, config.atrPeriod + 1)
  validateClosedCandles(input.candles, FOUR_HOURS_MS, minimumBars)
  const evaluatedAt = input.candles.at(-1)!.time + FOUR_HOURS_MS
  if (input.context.context.observedAt > evaluatedAt) throw new Error('daily context cannot come from the future')
  const candles = input.candles.slice(-config.lookbackBars)
  const atr = average(trueRanges(candles).slice(-config.atrPeriod))
  if (atr <= 0) throw new Error('location ATR must be positive')
  const lastIndex = candles.length - 1
  const candidates: LocationCandidate[] = []
  const swings = confirmedSwings(candles, config.swingLeftBars, config.swingRightBars)
  for (const side of ['HIGH', 'LOW'] as const) {
    const swing = swings.filter((candidate) => candidate.side === side).at(-1)
    if (swing) {
      candidates.push({
        type: side === 'HIGH' ? 'SWING_HIGH_RESISTANCE' : 'SWING_LOW_SUPPORT',
        price: swing.price,
        direction: side === 'HIGH' ? 'SHORT' : 'LONG',
        referenceIndex: swing.index,
        detectedIndex: swing.knownAtIndex,
        structuralScore: 35,
      })
    }
  }
  const rangeStart = candles.length - config.rangeLookbackBars
  const rangeCandles = candles.slice(rangeStart)
  const rangeHigh = Math.max(...rangeCandles.map((candle) => candle.high))
  const rangeLow = Math.min(...rangeCandles.map((candle) => candle.low))
  candidates.push(
    {
      type: 'RANGE_HIGH', price: rangeHigh, direction: 'SHORT',
      referenceIndex: rangeStart + rangeCandles.findIndex((candle) => candle.high === rangeHigh),
      detectedIndex: lastIndex, structuralScore: 35,
    },
    {
      type: 'RANGE_LOW', price: rangeLow, direction: 'LONG',
      referenceIndex: rangeStart + rangeCandles.findIndex((candle) => candle.low === rangeLow),
      detectedIndex: lastIndex, structuralScore: 35,
    },
  )
  const ema = emaSeries(candles.map((candle) => candle.close), 20).at(-1)!
  const close = candles.at(-1)!.close
  const distanceAtr = Math.abs(close - ema) / atr
  if (distanceAtr >= config.meanReversionDistanceAtr) {
    candidates.push({
      type: close > ema ? 'MEAN_REVERSION_RESISTANCE' : 'MEAN_REVERSION_SUPPORT',
      price: close,
      direction: close > ema ? 'SHORT' : 'LONG',
      referenceIndex: lastIndex,
      detectedIndex: lastIndex,
      structuralScore: 20,
    })
  }

  const halfWidth = atr * config.zoneHalfWidthAtr
  const selected: LocationCandidate[] = []
  for (const candidate of candidates.sort((left, right) => right.structuralScore - left.structuralScore)) {
    if (lastIndex - candidate.referenceIndex > config.maxAgeBars) continue
    if (selected.some((existing) => Math.abs(existing.price - candidate.price) <= halfWidth * 2)) continue
    selected.push(candidate)
  }
  const locations: SwingLocationCandidate[] = []
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
      if (candidate.direction === 'SHORT'
        && future.some((candle) => candle.low <= lower - atr * config.reactionDistanceAtr)) reactions += 1
      if (candidate.direction === 'LONG'
        && future.some((candle) => candle.high >= upper + atr * config.reactionDistanceAtr)) reactions += 1
    }
    const ageBars = lastIndex - candidate.referenceIndex
    const freshness = Math.max(0, 15 - Math.max(0, touchIndices.length - 1) * 4 - (ageBars / config.maxAgeBars) * 8)
    const reaction = Math.min(20, reactions * 10)
    const liquidity = Math.min(10, touchIndices.length * 5)
    const width = 5 * clamp(1 - config.zoneHalfWidthAtr)
    const score = Math.round(
      candidate.structuralScore
      + reaction
      + contextScore(candidate.direction, input.context)
      + liquidity
      + freshness
      + width,
    )
    if (score < config.minLocationScore || touchIndices.length > config.maxTestCount) continue
    const detectedAt = candles[candidate.detectedIndex]!.time + FOUR_HOURS_MS
    locations.push({
      id: `${input.symbol}:4h:${candidate.type}:${detectedAt}`,
      symbol: input.symbol,
      type: candidate.type,
      score: Math.min(100, score),
      boundaries: { lower, upper },
      reasonCodes: ['SWING_LOCATION_DETECTED'],
      direction: candidate.direction,
      detectedAt,
    })
  }
  locations.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  const featureSnapshot: SwingFeatureSnapshot = {
    daily_context: input.context.state,
    daily_bias: input.context.bias,
    atr,
    mean_distance_atr: distanceAtr,
    candidate_count: candidates.length,
    accepted_location_count: locations.length,
  }
  return {
    locations,
    reasonCodes: locations.length ? ['SWING_LOCATION_DETECTED'] : ['LOCATION_MISSING'],
    featureSnapshot,
  }
}

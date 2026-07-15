import type { Candle } from '@helix/contracts/market'

export type ConfirmedSwing = {
  side: 'HIGH' | 'LOW'
  index: number
  knownAtIndex: number
  price: number
}

export type StructureFeatureConfig = {
  fastWindowBars: number
  slowWindowBars: number
  emaPeriod: number
  swingLeftBars: number
  swingRightBars: number
}

export type MarketStructureFeatures = {
  latestAtr: number
  atrRatio: number
  rangeRatio: number
  averageBodyRatio: number
  averageWickRatio: number
  overlapRatio: number
  efficiency: number
  alternationRatio: number
  ema: number
  emaSlopeAtr: number
  meanDistanceAtr: number
  directionalBars: number
  lastRangeRatio: number
  highRelation: 'HIGHER' | 'LOWER' | 'EQUAL' | 'UNKNOWN'
  lowRelation: 'HIGHER' | 'LOWER' | 'EQUAL' | 'UNKNOWN'
  latestSwingHigh?: ConfirmedSwing
  latestSwingLow?: ConfirmedSwing
}

function positiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`)
}

export function average(values: number[]) {
  if (values.length === 0) throw new Error('cannot average an empty series')
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value))
}

export function validateClosedCandles(candles: Candle[], timeframeMs: number, minimumBars: number) {
  positiveInteger(timeframeMs, 'timeframeMs')
  positiveInteger(minimumBars, 'minimumBars')
  if (candles.length < minimumBars) throw new Error(`at least ${minimumBars} closed candles are required`)
  for (const [index, candle] of candles.entries()) {
    if (!Number.isSafeInteger(candle.time) || candle.time < 0 || candle.time % timeframeMs !== 0) {
      throw new Error(`candles[${index}].time must align to the capability timeframe`)
    }
    for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) {
      if (!Number.isFinite(candle[field])) throw new Error(`candles[${index}].${field} must be finite`)
    }
    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0) {
      throw new Error(`candles[${index}] contains invalid OHLCV values`)
    }
    if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) {
      throw new Error(`candles[${index}] has incoherent OHLC values`)
    }
    if (index > 0 && candle.time - candles[index - 1]!.time !== timeframeMs) {
      throw new Error(`candles contain a gap before index ${index}`)
    }
  }
}

export function trueRanges(candles: Candle[]) {
  return candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low
    const previousClose = candles[index - 1]!.close
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    )
  })
}

export function emaSeries(values: number[], period: number) {
  positiveInteger(period, 'emaPeriod')
  if (values.length === 0) throw new Error('EMA requires values')
  const alpha = 2 / (period + 1)
  const output = [values[0]!]
  for (let index = 1; index < values.length; index += 1) {
    output.push(values[index]! * alpha + output[index - 1]! * (1 - alpha))
  }
  return output
}

export function confirmedSwings(candles: Candle[], leftBars: number, rightBars: number) {
  positiveInteger(leftBars, 'swingLeftBars')
  positiveInteger(rightBars, 'swingRightBars')
  const swings: ConfirmedSwing[] = []
  for (let index = leftBars; index < candles.length - rightBars; index += 1) {
    const high = candles[index]!.high
    const low = candles[index]!.low
    let isHigh = true
    let isLow = true
    for (let offset = 1; offset <= leftBars; offset += 1) {
      isHigh = isHigh && high > candles[index - offset]!.high
      isLow = isLow && low < candles[index - offset]!.low
    }
    for (let offset = 1; offset <= rightBars; offset += 1) {
      isHigh = isHigh && high > candles[index + offset]!.high
      isLow = isLow && low < candles[index + offset]!.low
    }
    if (isHigh) swings.push({ side: 'HIGH', index, knownAtIndex: index + rightBars, price: high })
    if (isLow) swings.push({ side: 'LOW', index, knownAtIndex: index + rightBars, price: low })
  }
  return swings.sort((left, right) => left.knownAtIndex - right.knownAtIndex || left.index - right.index)
}

function relation(swings: ConfirmedSwing[], side: ConfirmedSwing['side'], epsilon: number) {
  const selected = swings.filter((swing) => swing.side === side)
  if (selected.length < 2) return 'UNKNOWN' as const
  const previous = selected.at(-2)!
  const latest = selected.at(-1)!
  if (latest.price > previous.price + epsilon) return 'HIGHER' as const
  if (latest.price < previous.price - epsilon) return 'LOWER' as const
  return 'EQUAL' as const
}

export function marketStructureFeatures(candles: Candle[], config: StructureFeatureConfig): MarketStructureFeatures {
  for (const [field, value] of Object.entries(config)) positiveInteger(value, `config.${field}`)
  if (config.fastWindowBars >= config.slowWindowBars) {
    throw new Error('fastWindowBars must be smaller than slowWindowBars')
  }
  const minimumBars = Math.max(
    config.slowWindowBars + 1,
    config.emaPeriod + 1,
    config.swingLeftBars + config.swingRightBars + 2,
  )
  if (candles.length < minimumBars) throw new Error(`at least ${minimumBars} candles are required for structure features`)

  const ranges = candles.map((candle) => candle.high - candle.low)
  const tr = trueRanges(candles)
  const fastRanges = ranges.slice(-config.fastWindowBars)
  const slowRanges = ranges.slice(-config.slowWindowBars)
  const fastTr = tr.slice(-config.fastWindowBars)
  const slowTr = tr.slice(-config.slowWindowBars)
  const latestAtr = average(fastTr)
  if (latestAtr <= 0) throw new Error('ATR must be positive')
  const closes = candles.map((candle) => candle.close)
  const ema = emaSeries(closes, config.emaPeriod)
  const latestEma = ema.at(-1)!
  const priorEma = ema.at(-(config.fastWindowBars + 1))!
  const fastCandles = candles.slice(-config.fastWindowBars)
  const deltas = fastCandles.slice(1).map((candle, index) => candle.close - fastCandles[index]!.close)
  const travel = deltas.reduce((sum, value) => sum + Math.abs(value), 0)
  const net = Math.abs(fastCandles.at(-1)!.close - fastCandles[0]!.close)
  const signs = deltas.map((value) => Math.sign(value)).filter((value) => value !== 0)
  let alternations = 0
  for (let index = 1; index < signs.length; index += 1) {
    if (signs[index] !== signs[index - 1]) alternations += 1
  }
  const overlap = fastCandles.slice(1).map((candle, index) => {
    const previous = fastCandles[index]!
    const amount = Math.max(0, Math.min(candle.high, previous.high) - Math.max(candle.low, previous.low))
    return amount / Math.max(candle.high - candle.low, Number.EPSILON)
  })
  const bodyRatios = fastCandles.map((candle) => (
    Math.abs(candle.close - candle.open) / Math.max(candle.high - candle.low, Number.EPSILON)
  ))
  const wickRatios = bodyRatios.map((bodyRatio) => 1 - bodyRatio)
  let directionalBars = 0
  const latestSign = signs.at(-1) ?? 0
  for (let index = signs.length - 1; index >= 0 && signs[index] === latestSign; index -= 1) directionalBars += 1
  const previousRanges = fastRanges.slice(0, -1)
  const swings = confirmedSwings(candles, config.swingLeftBars, config.swingRightBars)
  const epsilon = latestAtr * 1e-6
  return {
    latestAtr,
    atrRatio: average(fastTr) / average(slowTr),
    rangeRatio: average(fastRanges) / average(slowRanges),
    averageBodyRatio: average(bodyRatios),
    averageWickRatio: average(wickRatios),
    overlapRatio: overlap.length ? average(overlap) : 0,
    efficiency: travel > 0 ? net / travel : 0,
    alternationRatio: signs.length > 1 ? alternations / (signs.length - 1) : 0,
    ema: latestEma,
    emaSlopeAtr: (latestEma - priorEma) / latestAtr,
    meanDistanceAtr: Math.abs(closes.at(-1)! - latestEma) / latestAtr,
    directionalBars,
    lastRangeRatio: ranges.at(-1)! / Math.max(average(previousRanges), Number.EPSILON),
    highRelation: relation(swings, 'HIGH', epsilon),
    lowRelation: relation(swings, 'LOW', epsilon),
    latestSwingHigh: swings.filter((swing) => swing.side === 'HIGH').at(-1),
    latestSwingLow: swings.filter((swing) => swing.side === 'LOW').at(-1),
  }
}

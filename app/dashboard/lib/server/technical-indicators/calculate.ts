import type { Candle, TechnicalIndicators } from '../../market-data'

export type NullableSeries = Array<number | null>

function ema(values: number[], period: number) {
  const alpha = 2 / (period + 1)
  const output: number[] = []
  for (let index = 0; index < values.length; index += 1) {
    output.push(index === 0 ? values[index] : values[index] * alpha + output[index - 1] * (1 - alpha))
  }
  return output
}

export function calculateMacdSeries(candles: Candle[]) {
  const closes = candles.map((candle) => candle.close)
  const fast = ema(closes, 12)
  const slow = ema(closes, 26)
  const macd = fast.map((value, index) => value - slow[index])
  const signal = ema(macd, 9)
  const histogram = macd.map((value, index) => value - signal[index])
  return { macd, signal, histogram }
}

export function calculateRsiSeries(candles: Candle[], period = 14): NullableSeries {
  const output: NullableSeries = Array(candles.length).fill(null)
  if (candles.length <= period) return output

  let averageGain = 0
  let averageLoss = 0
  for (let index = 1; index <= period; index += 1) {
    const change = candles[index].close - candles[index - 1].close
    averageGain += Math.max(change, 0)
    averageLoss += Math.max(-change, 0)
  }
  averageGain /= period
  averageLoss /= period

  const toRsi = () => {
    if (averageLoss === 0) return 100
    if (averageGain === 0) return 0
    const relativeStrength = averageGain / averageLoss
    return 100 - 100 / (1 + relativeStrength)
  }

  output[period] = toRsi()
  for (let index = period + 1; index < candles.length; index += 1) {
    const change = candles[index].close - candles[index - 1].close
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period
    output[index] = toRsi()
  }
  return output
}

export function calculateAtrSeries(candles: Candle[], period = 14): NullableSeries {
  const output: NullableSeries = Array(candles.length).fill(null)
  if (candles.length < period) return output

  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low
    const previousClose = candles[index - 1].close
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    )
  })

  let average = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  output[period - 1] = average
  for (let index = period; index < candles.length; index += 1) {
    average = (average * (period - 1) + trueRanges[index]) / period
    output[index] = average
  }
  return output
}

export function calculateTechnicalIndicators(candles: Candle[]): TechnicalIndicators {
  const rsiSeries = calculateRsiSeries(candles)
  const macdSeries = calculateMacdSeries(candles)

  return {
    rsi: candles.flatMap((candle, index) => {
      const value = rsiSeries[index]
      return value == null ? [] : [{ time: candle.time, value }]
    }),
    macd: candles.slice(25).map((candle, offset) => {
      const index = offset + 25
      return {
        time: candle.time,
        macd: macdSeries.macd[index],
        signal: macdSeries.signal[index],
        hist: macdSeries.histogram[index],
      }
    }),
  }
}

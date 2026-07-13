import assert from 'node:assert/strict'
import test from 'node:test'
import type { Candle, IntradaySignalTimeframe } from '../../market-data'
import { buildIntradaySignal, findConfirmedSwings } from './intraday'

function candle(time: number, close: number, previousClose = close, volume = 100): Candle {
  return {
    time,
    open: previousClose,
    high: Math.max(close, previousClose) + (close >= previousClose ? 0.9 : 0.7),
    low: Math.min(close, previousClose) - (close <= previousClose ? 0.9 : 0.7),
    close,
    volume,
  }
}

function seriesFromCloses(closes: number[], intervalMs: number) {
  return closes.map((close, index) => candle(
    1_700_000_000_000 + index * intervalMs,
    close,
    index === 0 ? close : closes[index - 1],
    index === closes.length - 1 ? 220 : 100,
  ))
}

function hourlyTrend(count = 120) {
  const closes = Array.from({ length: count }, (_, index) => 100 + index * 0.22 + Math.sin((index + 10) / 4) * 1.8)
  return seriesFromCloses(closes, 60 * 60 * 1000)
}

function lowerTimeframeReversal(intervalMs: number, count = 120) {
  const closes: number[] = []
  let price = 100
  for (let index = 0; index < count; index += 1) {
    if (index < 80) price += 0.1
    else if (index < 116) price -= 0.12
    else if (index === 116) price -= 0.3
    else if (index === 117) price += 0.5
    else if (index === 118) price += 1
    else price += 1.4
    closes.push(price)
  }
  return seriesFromCloses(closes, intervalMs)
}

function bullishDivergence(intervalMs: number, count = 120) {
  const closes: number[] = []
  let price = 100
  for (let index = 0; index < count; index += 1) {
    if (index < 60) price += Math.sin(index / 5) * 0.02
    else if (index < 76) price -= 0.65
    else if (index < 86) price += 0.6
    else if (index < 101) price -= 0.44
    else if (index < 111) price += 0.4
    else price += 0.03
    closes.push(price)
  }
  return seriesFromCloses(closes, intervalMs)
}

function inputFromCloses(closes: number[]) {
  return {
    tickSize: 0.1,
    candles: {
      '5m': seriesFromCloses(closes, 5 * 60 * 1000),
      '15m': seriesFromCloses(closes, 15 * 60 * 1000),
      '1h': seriesFromCloses(closes, 60 * 60 * 1000),
    } satisfies Record<IntradaySignalTimeframe, Candle[]>,
  }
}

test('a swing is unavailable until every right-side bar closes', () => {
  const candles = [
    candle(1, 10),
    candle(2, 11),
    { ...candle(3, 12), high: 15 },
    candle(4, 11),
    candle(5, 10),
  ]

  assert.equal(findConfirmedSwings(candles, 2, 2, 3).some((swing) => swing.side === 'high'), false)
  const confirmed = findConfirmedSwings(candles, 2, 2, 4).find((swing) => swing.side === 'high')
  assert.deepEqual(confirmed, { side: 'high', index: 2, knownAtIndex: 4, price: 15 })
})

test('the engine does not invent entry and stop prices without an entry trigger', () => {
  const closes = Array.from({ length: 100 }, (_, index) => 100 + index * 0.1)
  const result = buildIntradaySignal(inputFromCloses(closes))

  assert.notEqual(result.signal.status, 'actionable')
  assert.equal(result.signal.entry, undefined)
  assert.equal(result.signal.stopLoss, undefined)
})

test('MACD histogram divergence uses confirmed price swings', () => {
  const result = buildIntradaySignal({
    tickSize: 0.1,
    candles: {
      '5m': bullishDivergence(5 * 60 * 1000),
      '15m': bullishDivergence(15 * 60 * 1000),
      '1h': bullishDivergence(60 * 60 * 1000),
    },
  })

  assert.equal(result.timeframes['5m']?.macd.divergence, 'bullish')
  assert.ok((result.timeframes['5m']?.macd.divergenceBarsAgo ?? 99) >= 2)
})

test('a missing candle invalidates multi-timeframe evaluation', () => {
  const complete = seriesFromCloses(Array.from({ length: 100 }, (_, index) => 100 + index * 0.1), 5 * 60 * 1000)
  const withGap = complete.filter((_, index) => index !== 50)
  const result = buildIntradaySignal({
    tickSize: 0.1,
    candles: {
      '5m': withGap,
      '15m': seriesFromCloses(Array.from({ length: 100 }, (_, index) => 100 + index * 0.1), 15 * 60 * 1000),
      '1h': seriesFromCloses(Array.from({ length: 100 }, (_, index) => 100 + index * 0.1), 60 * 60 * 1000),
    },
  })

  assert.equal(result.signal.status, 'insufficient-data')
  assert.equal(result.timeframes['5m'], undefined)
})

test('aligned lower-timeframe triggers emit an actionable signal with risk levels', () => {
  const result = buildIntradaySignal({
    tickSize: 0.1,
    candles: {
      '5m': lowerTimeframeReversal(5 * 60 * 1000),
      '15m': lowerTimeframeReversal(15 * 60 * 1000),
      '1h': hourlyTrend(),
    },
  })

  assert.equal(result.signal.bias.side, 'long')
  assert.equal(result.signal.status, 'actionable')
  assert.equal(result.signal.side, 'long')
  assert.ok(result.signal.confidence >= 55)
  assert.ok(result.signal.entry)
  assert.ok(result.signal.stopLoss)
  assert.ok(result.signal.stopLoss.price < result.signal.entry.price)
  assert.ok(result.signal.logic.some((item) => item.includes('MACD') || item.includes('RSI') || item.includes('PA')))
})

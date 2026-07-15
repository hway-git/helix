import assert from 'node:assert/strict'
import test from 'node:test'
import type { Candle } from '@helix/contracts/market'
import type { SwingDailyMarketContextConfig, SwingLocationConfig } from '@helix/contracts/swing'
import { classifySwingDailyMarketContext, scanSwingLocations } from './swing-context'

const day = 24 * 60 * 60 * 1000
const fourHours = 4 * 60 * 60 * 1000

const contextConfig: SwingDailyMarketContextConfig = {
  fastWindowBars: 10,
  slowWindowBars: 40,
  emaPeriod: 20,
  swingLeftBars: 2,
  swingRightBars: 2,
  trendMinEfficiency: 0.2,
  trendMinEmaSlopeAtr: 0.2,
  rangeMaxEfficiency: 0.2,
  rangeMaxEmaSlopeAtr: 0.2,
}

function candles(count: number, interval: number, closeAt: (index: number) => number, range = 2): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = closeAt(index)
    return {
      time: index * interval,
      open: close,
      high: close + range / 2,
      low: close - range / 2,
      close,
      volume: 100,
    }
  })
}

test('classifies bullish daily structure as context rather than an entry signal', () => {
  const history = candles(70, day, (index) => 100 + index * 0.4 + Math.sin(index / 2.5) * 3)
  const decision = classifySwingDailyMarketContext(contextConfig, {
    id: 'daily-1', symbol: 'BTC/USDT:USDT', candles: history,
  })
  assert.equal(decision.state, 'BULLISH_TREND')
  assert.equal(decision.bias, 'BULLISH')
  assert.equal(decision.context.daily, 'BULLISH_TREND')
  assert.equal(decision.context.observedAt, history.at(-1)!.time + day)
})

test('uses RANGE only when both efficiency and EMA slope are flat', () => {
  const history = candles(60, day, (index) => 100 + (index % 2 === 0 ? 0.1 : -0.1))
  const decision = classifySwingDailyMarketContext(contextConfig, {
    id: 'daily-range', symbol: 'BTC/USDT:USDT', candles: history,
  })
  assert.equal(decision.state, 'RANGE')
  assert.equal(decision.bias, 'NEUTRAL')
})

test('scans 4H structural locations with an explicit daily-context score', () => {
  const daily = classifySwingDailyMarketContext(contextConfig, {
    id: 'daily-1',
    symbol: 'BTC/USDT:USDT',
    candles: candles(70, day, (index) => 100 + index * 0.4 + Math.sin(index / 2.5) * 3),
  })
  const history = candles(500, fourHours, (index) => 130 + Math.sin(index / 3) * 8)
  const config: SwingLocationConfig = {
    atrPeriod: 14,
    lookbackBars: 80,
    rangeLookbackBars: 40,
    swingLeftBars: 2,
    swingRightBars: 2,
    zoneHalfWidthAtr: 0.2,
    touchToleranceAtr: 0.25,
    reactionDistanceAtr: 0.75,
    reactionBars: 4,
    meanReversionDistanceAtr: 2.5,
    maxTestCount: 4,
    maxAgeBars: 60,
    minLocationScore: 50,
  }
  const scan = scanSwingLocations(config, {
    symbol: 'BTC/USDT:USDT', candles: history, context: daily,
  })
  const evaluatedAt = history.at(-1)!.time + fourHours
  assert.ok(scan.locations.length >= 1)
  assert.ok(scan.locations.every((location) => location.detectedAt <= evaluatedAt && location.score >= 50))
  assert.deepEqual(scan.reasonCodes, ['SWING_LOCATION_DETECTED'])
})

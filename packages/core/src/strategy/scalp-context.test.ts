import assert from 'node:assert/strict'
import test from 'node:test'
import type { Candle } from '@helix/contracts/market'
import type { ScalpHuntingZoneConfig, ScalpMarketRegimeConfig } from '@helix/contracts/scalp'
import { classifyScalpMarketRegime, scanScalpHuntingZones } from './scalp-context'

const hour = 60 * 60 * 1000
const fifteenMinutes = 15 * 60 * 1000

const regimeConfig: ScalpMarketRegimeConfig = {
  fastWindowBars: 10,
  slowWindowBars: 40,
  emaPeriod: 20,
  swingLeftBars: 2,
  swingRightBars: 2,
  trendMinEfficiency: 0.25,
  trendMinEmaSlopeAtr: 0.3,
  compressionMaxAtrRatio: 0.75,
  compressionMaxRangeRatio: 0.75,
  compressionMinOverlapRatio: 0.5,
  expansionMinAtrRatio: 1.25,
  expansionMinBodyRatio: 0.6,
  expansionMinEfficiency: 0.55,
  exhaustionMinDirectionalBars: 5,
  exhaustionMinMeanDistanceAtr: 3,
  exhaustionMaxLastRangeRatio: 0.7,
  chaoticMinAlternationRatio: 0.75,
  chaoticMinWickRatio: 0.65,
  chaoticMaxEfficiency: 0.2,
}

function candles(count: number, interval: number, closeAt: (index: number) => number, rangeAt = (_index: number) => 2): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = closeAt(index)
    const range = rangeAt(index)
    const open = close
    return {
      time: index * interval,
      open,
      high: Math.max(open, close) + range / 2,
      low: Math.min(open, close) - range / 2,
      close,
      volume: 100,
    }
  })
}

test('classifies deterministic 1H trend structure without using later candles', () => {
  const history = candles(80, hour, (index) => 100 + index * 0.45 + Math.sin(index / 2.5) * 2)
  const prefix = history.slice(0, 70)
  const first = classifyScalpMarketRegime(regimeConfig, { id: 'regime-1', symbol: 'BTC/USDT:USDT', candles: prefix })
  const replay = classifyScalpMarketRegime(regimeConfig, { id: 'regime-1', symbol: 'BTC/USDT:USDT', candles: history.slice(0, 70) })

  assert.equal(first.regime.type, 'TRENDING')
  assert.deepEqual(replay, first)
  assert.equal(first.regime.observedAt, prefix.at(-1)!.time + hour)
})

test('CHAOTIC has priority over the ranging fallback', () => {
  const history = candles(
    60,
    hour,
    (index) => 100 + (index % 2 === 0 ? 0.4 : -0.4),
    () => 8,
  )
  const decision = classifyScalpMarketRegime(regimeConfig, {
    id: 'regime-chaotic', symbol: 'BTC/USDT:USDT', candles: history,
  })
  assert.equal(decision.regime.type, 'CHAOTIC')
  assert.deepEqual(decision.reasonCodes, ['REGIME_CHAOTIC'])
})

test('builds scored 15m zones only from confirmed structure and disables scanning in CHAOTIC', () => {
  const history = candles(100, fifteenMinutes, (index) => 100 + Math.sin(index / 3) * 6)
  const config: ScalpHuntingZoneConfig = {
    atrPeriod: 14,
    lookbackBars: 80,
    rangeLookbackBars: 40,
    compressionLookbackBars: 10,
    swingLeftBars: 2,
    swingRightBars: 2,
    zoneHalfWidthAtr: 0.15,
    touchToleranceAtr: 0.2,
    reactionDistanceAtr: 0.5,
    reactionBars: 3,
    compressionMaxRangeRatio: 0.8,
    maxTestCount: 3,
    maxAgeBars: 60,
    minZoneScore: 50,
  }
  const observedAt = history.at(-1)!.time + fifteenMinutes
  const ranging = scanScalpHuntingZones(config, {
    symbol: 'BTC/USDT:USDT',
    candles: history,
    regime: { id: 'ranging', symbol: 'BTC/USDT:USDT', type: 'RANGING', score: 80, observedAt },
  })
  assert.ok(ranging.zones.length >= 2)
  assert.ok(ranging.zones.every((zone) => zone.detectedAt <= observedAt && zone.score >= 50))
  assert.deepEqual(ranging.reasonCodes, ['HUNTING_ZONE_DETECTED'])

  const chaotic = scanScalpHuntingZones(config, {
    symbol: 'BTC/USDT:USDT',
    candles: history,
    regime: { id: 'chaotic', symbol: 'BTC/USDT:USDT', type: 'CHAOTIC', score: 90, observedAt },
  })
  assert.deepEqual(chaotic.zones, [])
  assert.deepEqual(chaotic.reasonCodes, ['REGIME_CHAOTIC', 'NO_HUNTING_ZONE'])
})

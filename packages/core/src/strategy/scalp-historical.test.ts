import assert from 'node:assert/strict'
import test from 'node:test'
import type { Candle } from '@helix/contracts/market'
import type {
  ScalpHuntingZone,
  ScalpMarketRegimeDecision,
  ScalpPriceEvent,
} from '@helix/contracts/scalp'
import { createStrategyHistoricalDataset } from './historical-dataset'
import { runHistoricalStrategy } from './historical-runner'
import {
  ScalpHistoricalEvaluator,
  selectScalpStructuralTarget,
  type ScalpHistoricalEvaluatorConfig,
} from './scalp-historical'

const minute = 60_000

function minuteCandles(count: number): Candle[] {
  const closes = Array.from({ length: count }, (_, index) => (
    100
      + Math.sin(index / 45) * 5
      + Math.sin(index / 6) * 0.35
      + (index > 24 * 60 && index % 180 === 5 ? 3 : 0)
      - (index > 24 * 60 && index % 180 === 6 ? 3 : 0)
  ))
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1]!
    const sweep = index > 24 * 60 && index % 180 === 0 ? 8 : 0
    return {
      time: index * minute,
      open,
      high: Math.max(open, close) + 0.08 + sweep,
      low: Math.min(open, close) - 0.08 - sweep,
      close,
      volume: 100,
    }
  })
}

function aggregate(source: Candle[], bars: number): Candle[] {
  const output: Candle[] = []
  for (let index = 0; index + bars <= source.length; index += bars) {
    const group = source.slice(index, index + bars)
    output.push({
      time: group[0]!.time,
      open: group[0]!.open,
      high: Math.max(...group.map((candle) => candle.high)),
      low: Math.min(...group.map((candle) => candle.low)),
      close: group.at(-1)!.close,
      volume: group.reduce((sum, candle) => sum + candle.volume, 0),
    })
  }
  return output
}

const config: ScalpHistoricalEvaluatorConfig = {
  marketRegime: {
    fastWindowBars: 10, slowWindowBars: 50, emaPeriod: 20, swingLeftBars: 2, swingRightBars: 2,
    trendMinEfficiency: 0.3, trendMinEmaSlopeAtr: 0.5,
    compressionMaxAtrRatio: 0.7, compressionMaxRangeRatio: 0.7, compressionMinOverlapRatio: 0.8,
    expansionMinAtrRatio: 2, expansionMinBodyRatio: 0.9, expansionMinEfficiency: 0.9,
    exhaustionMinDirectionalBars: 10, exhaustionMinMeanDistanceAtr: 10, exhaustionMaxLastRangeRatio: 0.2,
    chaoticMinAlternationRatio: 1, chaoticMinWickRatio: 1, chaoticMaxEfficiency: 0,
  },
  huntingZone: {
    atrPeriod: 14, lookbackBars: 96, rangeLookbackBars: 48, compressionLookbackBars: 12,
    swingLeftBars: 2, swingRightBars: 2, zoneHalfWidthAtr: 0.2, touchToleranceAtr: 0.3,
    reactionDistanceAtr: 0.2, reactionBars: 3, compressionMaxRangeRatio: 0.8,
    maxTestCount: 20, maxAgeBars: 80, minZoneScore: 40,
  },
  liquiditySweep: { minZoneScore: 40, maxReclaimBars: 2, minWickRatio: 0, maxFollowThroughAtr: 1 },
  breakoutFailure: { minZoneScore: 40, maxReturnBars: 3, maxFollowThroughAtr: 1 },
  momentumBurst: { minZoneScore: 40, minBodyRatio: 0.2, minCandleRangeAtr: 0.5, maxDistanceFromMeanAtr: 10 },
  execution: { minRr: 1 },
  risk: { dailyLossLimitR: 10, maxConsecutiveLosses: 20, riskByGradeR: { A_PLUS: 0.35, A: 0.25, B: 0.15 } },
  time: {
    maxHoldingMs: { LIQUIDITY_SWEEP: 30 * minute, BREAKOUT_FAILURE: 30 * minute, MOMENTUM_BURST: 15 * minute },
    responseWindowMs: { LIQUIDITY_SWEEP: 10 * minute, BREAKOUT_FAILURE: 10 * minute, MOMENTUM_BURST: 5 * minute },
  },
}

test('composes Scalp capabilities into deterministic paired decisions without reviving triggered Events', () => {
  const oneMinute = minuteCandles(3 * 24 * 60)
  const dataset = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: { provider: 'fixture', market: 'test', instrumentId: 'BTC-TEST', symbol: 'BTC/USDT:USDT' },
    capturedThrough: oneMinute.length * minute,
    timeframes: {
      '1m': oneMinute,
      '5m': aggregate(oneMinute, 5),
      '15m': aggregate(oneMinute, 15),
      '1h': aggregate(oneMinute, 60),
    },
  })
  const run = () => {
    const evaluator = new ScalpHistoricalEvaluator(config)
    const artifact = runHistoricalStrategy({
      dataset,
      identity: {
        strategyId: 'helix_scalp_hunter', strategyVersion: '1.0.1',
        strategyRepoCommit: 'a'.repeat(40), strategyConfigHash: `sha256:${'b'.repeat(64)}`,
        engineCommit: 'c'.repeat(40), marketDataSnapshotId: dataset.datasetHash,
      },
      strategyLifecycle: 'proposal',
      objectModel: 'PRICE_EVENT',
      baseTimeframe: '1m',
      requiredTimeframes: ['1m', '5m', '15m', '1h'],
      registeredReasonCodes: [
        'EXECUTION_TRIGGERED', 'STOP_HIT', 'TARGET_HIT', 'TIME_STOP', 'RESPONSE_FAILURE_EXIT',
      ],
      evaluate: evaluator.evaluate,
    })
    return { artifact, statistics: evaluator.statistics() }
  }
  const first = run()
  const second = run()
  assert.ok(first.artifact.signals.length >= 2, JSON.stringify(first.statistics))
  assert.equal(first.artifact.signals.length % 2, 0)
  assert.deepEqual(first, second)
  for (let index = 0; index < first.artifact.signals.length; index += 2) {
    assert.equal(first.artifact.signals[index]!.action, 'ENTER')
    assert.equal(first.artifact.signals[index + 1]!.action, 'EXIT')
    assert.equal(first.artifact.signals[index]!.object.id, first.artifact.signals[index + 1]!.object.id)
  }
})

function zone(overrides: Partial<ScalpHuntingZone> = {}): ScalpHuntingZone {
  return {
    id: 'source-zone',
    symbol: 'BTC/USDT:USDT',
    type: 'RANGE_LOW',
    state: 'ACTIVE',
    score: 80,
    testCount: 1,
    directionInterest: 'LONG',
    boundary: { lower: 100, upper: 101 },
    detectedAt: 0,
    expiresAt: 1_000_000_000,
    ...overrides,
  }
}

test('selects the nearest eligible structural target without synthesizing minimum RR', () => {
  const target = selectScalpStructuralTarget({
    zones: [
      zone(),
      zone({ id: 'far', directionInterest: 'SHORT', boundary: { lower: 120, upper: 121 } }),
      zone({ id: 'near', directionInterest: 'BOTH', boundary: { lower: 110, upper: 111 } }),
      zone({ id: 'inactive', state: 'WEAKENED', directionInterest: 'SHORT', boundary: { lower: 105, upper: 106 } }),
    ],
    sourceZoneId: 'source-zone',
    side: 'LONG',
    entry: 102,
    evaluatedAt: 100,
  })
  assert.deepEqual(target, { zoneId: 'near', price: 110 })
  assert.equal(selectScalpStructuralTarget({
    zones: [zone()], sourceZoneId: 'source-zone', side: 'LONG', entry: 102, evaluatedAt: 100,
  }), null)
})

test('tracks a boundary breach across closed 5m bars and applies follow-through', () => {
  const setup = (maxFollowThroughAtr: number) => {
    const evaluator = new ScalpHistoricalEvaluator({
      ...config,
      liquiditySweep: { ...config.liquiditySweep, maxReclaimBars: 2, maxFollowThroughAtr },
      breakoutFailure: { ...config.breakoutFailure, maxReturnBars: 3, maxFollowThroughAtr },
    })
    const internal = evaluator as unknown as {
      regime?: ScalpMarketRegimeDecision
      zones: ScalpHuntingZone[]
      event?: ScalpPriceEvent
    }
    internal.regime = {
      regime: { id: 'regime-1', symbol: 'BTC/USDT:USDT', type: 'RANGING', score: 80, observedAt: 0 },
      reasonCodes: ['REGIME_RANGING'],
      featureSnapshot: {},
    }
    internal.zones = [zone()]
    return { evaluator, internal }
  }
  const base = Array.from({ length: 20 }, (_, index): Candle => ({
    time: index * 5 * minute,
    open: 100.5,
    high: 101,
    low: 100,
    close: 100.5,
    volume: 100,
  }))
  const breach: Candle = {
    time: 20 * 5 * minute, open: 100.5, high: 101, low: 98.5, close: 99.5, volume: 100,
  }
  const reclaim: Candle = {
    time: 21 * 5 * minute, open: 99.5, high: 101, low: 99.4, close: 100.5, volume: 100,
  }
  const evaluate = (evaluator: ScalpHistoricalEvaluator, fiveMinute: Candle[], decisionTime: number) => evaluator.evaluate({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '1m',
    decisionTime,
    sourceCandle: { ...fiveMinute.at(-1)!, time: decisionTime - minute },
    candles: {
      '1m': [{ ...fiveMinute.at(-1)!, time: decisionTime - minute }],
      '5m': fiveMinute,
      '15m': [],
      '1h': [],
    },
  })

  const accepted = setup(1)
  evaluate(accepted.evaluator, [...base, breach], breach.time + 5 * minute)
  assert.equal(accepted.internal.event, undefined)
  evaluate(accepted.evaluator, [...base, breach, reclaim], reclaim.time + 5 * minute)
  assert.equal((accepted.internal.event as ScalpPriceEvent | undefined)?.type, 'LIQUIDITY_SWEEP')
  assert.equal((accepted.internal.event as ScalpPriceEvent | undefined)?.state, 'ARMED')
  assert.equal((accepted.internal.event as ScalpPriceEvent | undefined)?.score, 72)

  const rejected = setup(0.1)
  evaluate(rejected.evaluator, [...base, breach], breach.time + 5 * minute)
  evaluate(rejected.evaluator, [...base, breach, reclaim], reclaim.time + 5 * minute)
  assert.equal(rejected.internal.event, undefined)
})

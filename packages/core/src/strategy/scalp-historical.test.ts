import assert from 'node:assert/strict'
import test from 'node:test'
import type { Candle } from '@helix/contracts/market'
import type { StrategyHistoricalScalpRiskTraceEntry } from '@helix/contracts/strategy'
import type {
  ScalpHuntingZone,
  ScalpMarketRegimeDecision,
  ScalpPriceEvent,
} from '@helix/contracts/scalp'
import { createStrategyHistoricalDataset } from './historical-dataset'
import { runHistoricalStrategy, type HistoricalDecisionContext } from './historical-runner'
import {
  ScalpHistoricalEvaluator,
  scalpMicroStructureBreak,
  selectScalpStructuralTarget,
  type ScalpHistoricalEvaluatorConfig,
} from './scalp-historical'

const minute = 60_000

function minuteCandles(count: number): Candle[] {
  const closes = Array.from({ length: count }, (_, index) => (
    100
      + Math.sin(index / 45) * 5
      + Math.sin(index / 6) * 0.35
      + [0, 0.3, -0.2, 0.6, 0, -0.3, 0.2, -0.6][index % 8]!
      + (index > 24 * 60 && index % 180 === 5 ? 3 : 0)
      - (index > 24 * 60 && index % 180 === 6 ? 3 : 0)
  ))
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1]!
    const sweep = index > 24 * 60 && index % 180 === 0 ? 2 : 0
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
    const riskEntries: StrategyHistoricalScalpRiskTraceEntry[] = []
    const evaluator = new ScalpHistoricalEvaluator(config, (entry) => riskEntries.push(entry))
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
    return { artifact, riskEntries, statistics: evaluator.statistics() }
  }
  const first = run()
  const second = run()
  assert.ok(first.artifact.signals.length >= 2, JSON.stringify(first.statistics))
  assert.equal(first.artifact.signals.length % 2, 0)
  assert.equal(first.riskEntries.length, first.artifact.signals.length / 2)
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

function primeScalpPosition(evaluator: ScalpHistoricalEvaluator, side: 'LONG' | 'SHORT') {
  const event: ScalpPriceEvent = {
    id: `event-${side.toLowerCase()}`,
    symbol: 'BTC/USDT:USDT',
    regimeId: 'regime-1',
    zoneId: 'source-zone',
    detectorId: 'momentum_burst_v1',
    type: 'MOMENTUM_BURST',
    direction: side,
    state: 'TRIGGERED',
    score: 90,
    detectedAt: 0,
    expiresAt: 60 * minute,
    updatedAt: 2 * minute,
    reasonCodes: ['EXECUTION_TRIGGERED'],
  }
  const internal = evaluator as unknown as {
    position?: {
      event: ScalpPriceEvent
      zone: ScalpHuntingZone
      side: 'LONG' | 'SHORT'
      entryPrice: number
      stop: number
      target: number
      riskDistance: number
      riskR: number
      triggeredAt: number
      responseState: 'EXPECTED_RESPONSE_WINDOW'
    }
  }
  internal.position = {
    event,
    zone: zone(),
    side,
    entryPrice: 100,
    stop: side === 'LONG' ? 95 : 105,
    target: side === 'LONG' ? 110 : 90,
    riskDistance: 5,
    riskR: 0.25,
    triggeredAt: 2 * minute,
    responseState: 'EXPECTED_RESPONSE_WINDOW',
  }
}

function evaluateScalpPosition(evaluator: ScalpHistoricalEvaluator, candle: Candle) {
  return evaluator.evaluate({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '1m',
    decisionTime: 3 * minute,
    sourceCandle: candle,
    candles: { '1m': [candle], '5m': [], '15m': [], '1h': [] },
  })
}

test('exits a Scalp when a closed execution candle wick touches its Target', () => {
  const cases: readonly { side: 'LONG' | 'SHORT'; candle: Candle }[] = [
    {
      side: 'LONG',
      candle: { time: 2 * minute, open: 100, high: 111, low: 99, close: 100, volume: 100 },
    },
    {
      side: 'SHORT',
      candle: { time: 2 * minute, open: 100, high: 101, low: 89, close: 100, volume: 100 },
    },
  ]
  for (const { side, candle } of cases) {
    const evaluator = new ScalpHistoricalEvaluator(config)
    primeScalpPosition(evaluator, side)
    assert.deepEqual(evaluateScalpPosition(evaluator, candle)[0]?.reasonCodes, ['TARGET_HIT'])
  }
})

test('records STOP_HIT first and full loss risk when one Scalp candle touches both boundaries', () => {
  const cases: readonly { side: 'LONG' | 'SHORT'; candle: Candle }[] = [
    {
      side: 'LONG',
      candle: { time: 2 * minute, open: 100, high: 111, low: 94, close: 100, volume: 100 },
    },
    {
      side: 'SHORT',
      candle: { time: 2 * minute, open: 100, high: 106, low: 89, close: 100, volume: 100 },
    },
  ]
  for (const { side, candle } of cases) {
    const evaluator = new ScalpHistoricalEvaluator(config)
    primeScalpPosition(evaluator, side)
    assert.deepEqual(evaluateScalpPosition(evaluator, candle)[0]?.reasonCodes, ['STOP_HIT'])
    assert.equal(evaluator.checkpoint().dailyLossUsedR, 0.25)
    assert.equal(evaluator.checkpoint().consecutiveLosses, 1)
  }
})

test('keeps a consecutive-loss pause until a later closed 1H Regime re-evaluation', () => {
  const evaluator = new ScalpHistoricalEvaluator({
    ...config,
    risk: { ...config.risk, maxConsecutiveLosses: 3 },
  })
  const hourly = Array.from({ length: 51 }, (_, index): Candle => ({
    time: index * 60 * minute,
    open: 100 + index * 0.1,
    high: 101 + index * 0.1,
    low: 99 + index * 0.1,
    close: 100.5 + index * 0.1,
    volume: 100,
  }))
  const internal = evaluator as unknown as {
    consecutiveLosses: number
    lastRegimeCandleTime: number
  }
  internal.consecutiveLosses = 3
  internal.lastRegimeCandleTime = hourly.at(-1)!.time
  const evaluate = (candles: Candle[]) => {
    const decisionTime = candles.at(-1)!.time + 60 * minute
    const current: Candle = {
      time: decisionTime - minute,
      open: 105,
      high: 106,
      low: 104,
      close: 105,
      volume: 100,
    }
    evaluator.evaluate({
      symbol: 'BTC/USDT:USDT',
      baseTimeframe: '1m',
      decisionTime,
      sourceCandle: current,
      candles: { '1m': [current], '5m': [], '15m': [], '1h': candles },
    })
  }

  evaluate(hourly)
  assert.equal(evaluator.checkpoint().consecutiveLosses, 3)

  evaluate([...hourly, {
    ...hourly.at(-1)!,
    time: hourly.at(-1)!.time + 60 * minute,
  }])
  assert.equal(evaluator.checkpoint().consecutiveLosses, 0)
})

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

test('requires a closed 1m pivot before declaring a micro structure break', () => {
  const candle = (time: number, open: number, high: number, low: number, close: number): Candle => ({
    time, open, high, low, close, volume: 100,
  })
  const long = [
    candle(0, 100, 101, 99, 100),
    candle(minute, 100, 103, 100, 102),
    candle(2 * minute, 102, 102.5, 100.5, 101),
    candle(3 * minute, 101, 104, 101, 103.5),
  ]
  const short = [
    candle(0, 100, 101, 99, 100),
    candle(minute, 100, 100, 97, 98),
    candle(2 * minute, 98, 99.5, 97.5, 99),
    candle(3 * minute, 99, 99, 96, 96.5),
  ]
  const monotonic = [
    candle(0, 100, 101, 99, 100.5),
    candle(minute, 100.5, 102, 100, 101.5),
    candle(2 * minute, 101.5, 103, 101, 102.5),
    candle(3 * minute, 102.5, 104, 102, 103.5),
  ]

  assert.equal(scalpMicroStructureBreak(long, 'LONG'), true)
  assert.equal(scalpMicroStructureBreak(short, 'SHORT'), true)
  assert.equal(scalpMicroStructureBreak(monotonic, 'LONG'), false)
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
      eventInvalidationPrice?: number
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
  assert.equal(accepted.internal.eventInvalidationPrice, breach.low)

  const rejected = setup(0.1)
  evaluate(rejected.evaluator, [...base, breach], breach.time + 5 * minute)
  evaluate(rejected.evaluator, [...base, breach, reclaim], reclaim.time + 5 * minute)
  assert.equal(rejected.internal.event, undefined)
})

test('rejects checkpoints from the pre-invalidation Scalp evaluator', () => {
  const legacy = {
    ...new ScalpHistoricalEvaluator(config).checkpoint(),
    schemaVersion: 'helix.scalp-evaluator-checkpoint/v1',
  }
  assert.throws(
    () => new ScalpHistoricalEvaluator(config, undefined, legacy as never),
    /unsupported Scalp evaluator checkpoint/,
  )
})

test('freezes the arm-time Regime in each successful ENTER risk entry', () => {
  const riskEntries: StrategyHistoricalScalpRiskTraceEntry[] = []
  const evaluator = new ScalpHistoricalEvaluator(config, (entry) => riskEntries.push(entry))
  const source = zone()
  const target = zone({
    id: 'target-zone',
    directionInterest: 'SHORT',
    boundary: { lower: 110, upper: 111 },
  })
  const internal = evaluator as unknown as {
    regime?: ScalpMarketRegimeDecision
    zones: ScalpHuntingZone[]
    armEvent(
      context: HistoricalDecisionContext,
      armedZone: ScalpHuntingZone,
      side: 'LONG' | 'SHORT',
      accepted: {
        detectorId: 'momentum_burst_v1'
        type: 'MOMENTUM_BURST'
        decision: { detected: boolean; reasonCodes: string[]; featureSnapshot: Record<string, never> }
        invalidationPrice: number
      },
    ): void
  }
  internal.regime = {
    regime: { id: 'regime-at-arm', symbol: 'BTC/USDT:USDT', type: 'RANGING', score: 80, observedAt: 0 },
    reasonCodes: ['REGIME_RANGING'],
    featureSnapshot: {},
  }
  internal.zones = [source, target]
  const armTime = 15 * minute
  const armCandle: Candle = {
    time: armTime - minute, open: 102, high: 102.2, low: 101.8, close: 102, volume: 100,
  }
  internal.armEvent({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '1m',
    decisionTime: armTime,
    sourceCandle: armCandle,
    candles: { '1m': [armCandle], '5m': [], '15m': [], '1h': [] },
  }, source, 'LONG', {
    detectorId: 'momentum_burst_v1',
    type: 'MOMENTUM_BURST',
    decision: { detected: true, reasonCodes: ['MOMENTUM_BURST_DETECTED'], featureSnapshot: {} },
    invalidationPrice: source.boundary.lower,
  })

  internal.regime = {
    regime: { id: 'regime-after-arm', symbol: 'BTC/USDT:USDT', type: 'TRENDING', score: 95, observedAt: armTime },
    reasonCodes: ['REGIME_TRENDING'],
    featureSnapshot: {},
  }
  const oneMinute = Array.from({ length: 15 }, (_, index): Candle => ({
    time: (index + 1) * minute,
    open: 102,
    high: 102.2,
    low: 101.8,
    close: 102,
    volume: 100,
  }))
  oneMinute[12] = {
    time: 13 * minute, open: 102, high: 103, low: 101.8, close: 102.5, volume: 100,
  }
  oneMinute[14] = {
    time: armTime, open: 102, high: 104.2, low: 101.8, close: 104, volume: 100,
  }
  const decisions = evaluator.evaluate({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '1m',
    decisionTime: armTime + minute,
    sourceCandle: oneMinute.at(-1)!,
    candles: { '1m': oneMinute, '5m': [], '15m': [], '1h': [] },
  })

  assert.equal(decisions[0]?.action, 'ENTER')
  assert.equal(riskEntries.length, 1)
  assert.deepEqual(riskEntries[0]!.scalp.regime, { id: 'regime-at-arm', type: 'RANGING' })
  assert.deepEqual(riskEntries[0]!.entryPrice, { source: 'DECISION_CANDLE_CLOSE', price: 104 })
  assert.ok(riskEntries[0]!.initialStop < source.boundary.lower)
})

test('rejects an armed Event when its stop is not beyond entry in the risk direction', () => {
  const riskEntries: StrategyHistoricalScalpRiskTraceEntry[] = []
  const evaluator = new ScalpHistoricalEvaluator(config, (entry) => riskEntries.push(entry))
  const source = zone({ boundary: { lower: 105, upper: 106 } })
  const target = zone({
    id: 'target-zone',
    directionInterest: 'SHORT',
    boundary: { lower: 110, upper: 111 },
  })
  const internal = evaluator as unknown as {
    regime?: ScalpMarketRegimeDecision
    zones: ScalpHuntingZone[]
    armEvent(
      context: HistoricalDecisionContext,
      armedZone: ScalpHuntingZone,
      side: 'LONG' | 'SHORT',
      accepted: {
        detectorId: 'momentum_burst_v1'
        type: 'MOMENTUM_BURST'
        decision: { detected: boolean; reasonCodes: string[]; featureSnapshot: Record<string, never> }
        invalidationPrice: number
      },
    ): void
  }
  internal.regime = {
    regime: { id: 'regime-at-arm', symbol: 'BTC/USDT:USDT', type: 'RANGING', score: 80, observedAt: 0 },
    reasonCodes: ['REGIME_RANGING'],
    featureSnapshot: {},
  }
  internal.zones = [source, target]
  const armTime = 15 * minute
  const armCandle: Candle = {
    time: armTime - minute, open: 102, high: 102.2, low: 101.8, close: 102, volume: 100,
  }
  internal.armEvent({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '1m',
    decisionTime: armTime,
    sourceCandle: armCandle,
    candles: { '1m': [armCandle], '5m': [], '15m': [], '1h': [] },
  }, source, 'LONG', {
    detectorId: 'momentum_burst_v1',
    type: 'MOMENTUM_BURST',
    decision: { detected: true, reasonCodes: ['MOMENTUM_BURST_DETECTED'], featureSnapshot: {} },
    invalidationPrice: source.boundary.lower,
  })

  const oneMinute = Array.from({ length: 15 }, (_, index): Candle => ({
    time: (index + 1) * minute,
    open: 102,
    high: 102.2,
    low: 101.8,
    close: 102,
    volume: 100,
  }))
  oneMinute[14] = {
    time: armTime, open: 102, high: 104.2, low: 101.8, close: 104, volume: 100,
  }
  const decisions = evaluator.evaluate({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '1m',
    decisionTime: armTime + minute,
    sourceCandle: oneMinute.at(-1)!,
    candles: { '1m': oneMinute, '5m': [], '15m': [], '1h': [] },
  })

  assert.deepEqual(decisions, [])
  assert.deepEqual(riskEntries, [])
  assert.equal(evaluator.statistics().rejectedEventsByReason.RR_TOO_LOW, 1)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Candle } from '@helix/contracts/market'
import type { StrategyHistoricalSwingRiskTraceEntry } from '@helix/contracts/strategy'
import type {
  SwingDailyMarketContextDecision,
  SwingLocationCandidate,
  SwingTradeThesis,
} from '@helix/contracts/swing'
import { createStrategyHistoricalDataset } from './historical-dataset'
import { runHistoricalStrategy, type HistoricalDecisionContext } from './historical-runner'
import {
  SwingHistoricalEvaluator,
  selectSwingStructuralTarget,
  swingStageForEvidence,
  type SwingHistoricalEvaluatorConfig,
} from './swing-historical'
import {
  appendSwingEvidence,
  createSwingTradeThesis,
  transitionSwingTradeThesis,
} from './swing-state-machine'

const fifteenMinutes = 15 * 60 * 1000

function baseCandles(count: number): Candle[] {
  const closes = Array.from({ length: count }, (_, index) => (
    100 + index * 0.001 + Math.sin(index / 32) * 8 + Math.sin(index / 5) * 0.6
  ))
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1]!
    return {
      time: index * fifteenMinutes,
      open,
      high: Math.max(open, close) + 0.15,
      low: Math.min(open, close) - 0.15,
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

const config: SwingHistoricalEvaluatorConfig = {
  dailyContext: {
    fastWindowBars: 8, slowWindowBars: 50, emaPeriod: 20, swingLeftBars: 2, swingRightBars: 2,
    trendMinEfficiency: 0.15, trendMinEmaSlopeAtr: 0.1,
    rangeMaxEfficiency: 0.4, rangeMaxEmaSlopeAtr: 0.5,
  },
  location: {
    atrPeriod: 14, lookbackBars: 100, rangeLookbackBars: 50,
    swingLeftBars: 2, swingRightBars: 2, zoneHalfWidthAtr: 0.3, touchToleranceAtr: 0.4,
    reactionDistanceAtr: 0.3, reactionBars: 4, meanReversionDistanceAtr: 1.5,
    maxTestCount: 20, maxAgeBars: 90, minLocationScore: 40,
  },
  execution: {
    minRrByStage: { EARLY: 1, STANDARD: 1.2, CONFIRMED: 1.5 },
    maxAttemptsPerThesis: 3,
    stopBufferAtr: 0.1,
  },
  risk: { thesisRiskBudgetR: 1, maximumLeverage: 50, riskUnitRatio: 0.01, riskByStageR: { EARLY: 0.25, STANDARD: 0.35, CONFIRMED: 0.4 } },
}

test('requires a positive configured Swing Stop buffer', () => {
  assert.throws(
    () => new SwingHistoricalEvaluator({
      ...config,
      execution: { ...config.execution, stopBufferAtr: 0 },
    }),
    /config.execution.stopBufferAtr must be positive/,
  )
})

test('produces deterministic Swing trades and permits repeated entries only under one Thesis budget', () => {
  const fifteen = baseCandles(70 * 24 * 4)
  const dataset = createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: { provider: 'fixture', market: 'test', instrumentId: 'BTC-TEST', symbol: 'BTC/USDT:USDT' },
    capturedThrough: fifteen.length * fifteenMinutes,
    timeframes: {
      '15m': fifteen,
      '1h': aggregate(fifteen, 4),
      '4h': aggregate(fifteen, 16),
      '1d': aggregate(fifteen, 96),
    },
  })
  const run = () => {
    const riskEntries: StrategyHistoricalSwingRiskTraceEntry[] = []
    const evaluator = new SwingHistoricalEvaluator(config, (entry) => riskEntries.push(entry))
    const artifact = runHistoricalStrategy({
      dataset,
      identity: {
        strategyId: 'helix_swing_hunter', strategyVersion: '1.0.1',
        strategyRepoCommit: 'a'.repeat(40), strategyConfigHash: `sha256:${'b'.repeat(64)}`,
        engineCommit: 'c'.repeat(40), marketDataSnapshotId: dataset.datasetHash,
      },
      strategyLifecycle: 'proposal',
      objectModel: 'TRADE_THESIS',
      baseTimeframe: '15m',
      requiredTimeframes: ['15m', '1h', '4h', '1d'],
      registeredReasonCodes: ['EXECUTION_TRIGGERED', 'STOP_HIT', 'TARGET_HIT', 'THESIS_INVALIDATED'],
      evaluate: evaluator.evaluate,
    })
    return { artifact, riskEntries, statistics: evaluator.statistics() }
  }
  const first = run()
  const second = run()
  assert.ok(first.artifact.signals.length >= 2, JSON.stringify(first.statistics))
  assert.equal(
    first.riskEntries.length,
    first.artifact.signals.filter((signal) => signal.action === 'ENTER').length,
  )
  assert.deepEqual(first, second)
  const openByThesis = new Map<string, number>()
  const activeTheses = new Set<string>()
  for (const signal of first.artifact.signals) {
    if (signal.action === 'ENTER') {
      assert.equal(activeTheses.has(signal.object.id), false)
      activeTheses.add(signal.object.id)
      openByThesis.set(signal.object.id, (openByThesis.get(signal.object.id) ?? 0) + 1)
    } else {
      assert.equal(activeTheses.delete(signal.object.id), true)
    }
  }
  assert.ok([...openByThesis.values()].every((attempts) => attempts <= config.execution.maxAttemptsPerThesis))
  assert.equal(
    Object.values(first.statistics.entriesByStage).reduce((sum, count) => sum + count, 0),
    first.statistics.enteredTrades,
  )
})

function location(overrides: Partial<SwingLocationCandidate> = {}): SwingLocationCandidate {
  return {
    id: 'source-location',
    symbol: 'BTC/USDT:USDT',
    type: 'RANGE_LOW',
    score: 80,
    boundaries: { lower: 100, upper: 101 },
    reasonCodes: ['SWING_LOCATION_DETECTED'],
    direction: 'LONG',
    detectedAt: 0,
    ...overrides,
  }
}

function primeSwingPosition(evaluator: SwingHistoricalEvaluator, side: 'LONG' | 'SHORT') {
  const candidate = createSwingTradeThesis({
    id: `thesis-${side.toLowerCase()}`,
    symbol: 'BTC/USDT:USDT',
    type: 'STRUCTURAL_REVERSAL',
    direction: side,
    contextId: 'context-1',
    locationId: 'source-location',
    score: 80,
    invalidation: {
      policyId: 'thesis_invalidation_v1',
      type: side === 'LONG' ? 'H4_CLOSE_BELOW_LEVEL' : 'H4_CLOSE_ABOVE_LEVEL',
      timeframe: '4h',
      level: side === 'LONG' ? 95 : 105,
    },
    expectedMove: { targetLocationId: 'target-location', target: side === 'LONG' ? 110 : 90 },
    createdAt: 0,
    expiresAt: 100 * fifteenMinutes,
    reasonCodes: ['THESIS_CREATED'],
  })
  const active = transitionSwingTradeThesis(candidate, {
    toState: 'ACTIVE', occurredAt: fifteenMinutes, reasonCodes: ['THESIS_ACTIVATED'],
  }).thesis
  const eligible = transitionSwingTradeThesis(active, {
    toState: 'ENTRY_ELIGIBLE', occurredAt: 2 * fifteenMinutes, reasonCodes: ['ENTRY_ELIGIBLE'],
  }).thesis
  const triggered = transitionSwingTradeThesis(eligible, {
    toState: 'TRIGGERED', occurredAt: 3 * fifteenMinutes, reasonCodes: ['EXECUTION_TRIGGERED'],
  }).thesis
  const internal = evaluator as unknown as {
    thesis?: SwingTradeThesis
    thesisLocation?: SwingLocationCandidate
    position?: {
      thesis: SwingTradeThesis
      location: SwingLocationCandidate
      stage: 'EARLY'
      side: 'LONG' | 'SHORT'
      entryPrice: number
      stop: number
      target: number
      riskR: number
    }
    attempts: number
    thesisRiskUsedR: number
  }
  const source = location({ direction: side })
  internal.thesis = triggered
  internal.thesisLocation = source
  internal.position = {
    thesis: triggered,
    location: source,
    stage: 'EARLY',
    side,
    entryPrice: 100,
    stop: side === 'LONG' ? 95 : 105,
    target: side === 'LONG' ? 110 : 90,
    riskR: 0.25,
  }
  internal.attempts = 1
  internal.thesisRiskUsedR = 0.25
}

function evaluateSwingPosition(evaluator: SwingHistoricalEvaluator, candle: Candle) {
  return evaluator.evaluate({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '15m',
    decisionTime: 4 * fifteenMinutes,
    sourceCandle: candle,
    candles: { '15m': [candle], '1h': [], '4h': [], '1d': [] },
  })
}

test('exits a Swing when a closed execution candle wick touches its Target', () => {
  const cases: readonly { side: 'LONG' | 'SHORT'; candle: Candle }[] = [
    {
      side: 'LONG',
      candle: { time: 3 * fifteenMinutes, open: 100, high: 111, low: 99, close: 100, volume: 100 },
    },
    {
      side: 'SHORT',
      candle: { time: 3 * fifteenMinutes, open: 100, high: 101, low: 89, close: 100, volume: 100 },
    },
  ]
  for (const { side, candle } of cases) {
    const evaluator = new SwingHistoricalEvaluator(config)
    primeSwingPosition(evaluator, side)
    assert.deepEqual(evaluateSwingPosition(evaluator, candle)[0]?.reasonCodes, ['TARGET_HIT'])
  }
})

test('records STOP_HIT first when one Swing candle touches both boundaries', () => {
  const cases: readonly { side: 'LONG' | 'SHORT'; candle: Candle }[] = [
    {
      side: 'LONG',
      candle: { time: 3 * fifteenMinutes, open: 100, high: 111, low: 94, close: 100, volume: 100 },
    },
    {
      side: 'SHORT',
      candle: { time: 3 * fifteenMinutes, open: 100, high: 106, low: 89, close: 100, volume: 100 },
    },
  ]
  for (const { side, candle } of cases) {
    const evaluator = new SwingHistoricalEvaluator(config)
    primeSwingPosition(evaluator, side)
    assert.deepEqual(evaluateSwingPosition(evaluator, candle)[0]?.reasonCodes, ['STOP_HIT'])
  }
})

test('freezes the nearest opposing structural Location as Expected Move', () => {
  const source = location()
  assert.deepEqual(selectSwingStructuralTarget(source, [
    source,
    location({ id: 'far', direction: 'SHORT', boundaries: { lower: 120, upper: 121 } }),
    location({ id: 'near', direction: 'SHORT', boundaries: { lower: 110, upper: 111 } }),
    location({ id: 'same-side', direction: 'LONG', boundaries: { lower: 105, upper: 106 } }),
  ]), { targetLocationId: 'near', target: 110 })
  assert.equal(selectSwingStructuralTarget(source, [source]), null)
})

test('derives Entry Stage from current execution Evidence rather than Thesis score', () => {
  const base = {
    locationAligned: true,
    supportingEvidence: true,
    rejection: true,
    displacement: true,
    structureConfirmed: false,
    breakRetestConfirmed: false,
    followThrough: true,
  }
  assert.equal(swingStageForEvidence(base), 'EARLY')
  assert.equal(swingStageForEvidence({ ...base, structureConfirmed: true, rejection: false }), 'STANDARD')
  assert.equal(swingStageForEvidence({
    ...base, structureConfirmed: true, breakRetestConfirmed: true,
  }), 'CONFIRMED')
})

test('requires a later held retest before classifying an Entry as CONFIRMED', () => {
  const riskEntries: StrategyHistoricalSwingRiskTraceEntry[] = []
  const evaluator = new SwingHistoricalEvaluator({
    ...config,
    execution: {
      minRrByStage: { EARLY: 1, STANDARD: 100, CONFIRMED: 1 },
      maxAttemptsPerThesis: 3,
      stopBufferAtr: 0.1,
    },
  }, (entry) => riskEntries.push(entry))
  const source = location({ direction: 'LONG', boundaries: { lower: 100, upper: 101 } })
  const candidate = createSwingTradeThesis({
    id: 'ordered-retest-thesis',
    symbol: 'BTC/USDT:USDT',
    type: 'STRUCTURAL_REVERSAL',
    direction: 'LONG',
    contextId: 'context-1',
    locationId: source.id,
    score: 60,
    invalidation: {
      policyId: 'thesis_invalidation_v1', type: 'H4_CLOSE_BELOW_LEVEL', timeframe: '4h', level: 95,
    },
    expectedMove: { targetLocationId: 'target-location', target: 110 },
    createdAt: 0,
    expiresAt: 100 * fifteenMinutes,
    reasonCodes: ['THESIS_CREATED'],
  })
  const active = transitionSwingTradeThesis(candidate, {
    toState: 'ACTIVE', occurredAt: fifteenMinutes, reasonCodes: ['THESIS_ACTIVATED'],
  }).thesis
  const supported = appendSwingEvidence(active, {
    id: 'ordered-retest-evidence',
    thesisId: active.id,
    type: 'DIRECTIONAL_PROGRESS',
    time: 2 * fifteenMinutes,
    direction: 'LONG',
    effect: 'SUPPORTING',
    scoreDelta: 8,
    reasonCodes: ['EVIDENCE_STRENGTHENED'],
    featureSnapshot: { body_ratio: 0.8 },
  })
  const eligible = transitionSwingTradeThesis(supported, {
    toState: 'ENTRY_ELIGIBLE', occurredAt: 2 * fifteenMinutes, reasonCodes: ['ENTRY_ELIGIBLE'],
  }).thesis
  const internal = evaluator as unknown as {
    thesis?: SwingTradeThesis
    thesisLocation?: SwingLocationCandidate
    thesisContext?: StrategyHistoricalSwingRiskTraceEntry['swing']['context']
    evaluateEntry(decision: HistoricalDecisionContext, candles: readonly Candle[]): unknown
  }
  internal.thesis = eligible
  internal.thesisLocation = source
  internal.thesisContext = { id: 'context-1', state: 'RANGE', bias: 'NEUTRAL' }

  const prefix = Array.from({ length: 13 }, (_, index): Candle => ({
    time: index * fifteenMinutes, open: 100, high: 101, low: 99, close: 100, volume: 100,
  }))
  const previous: Candle = {
    time: 13 * fifteenMinutes, open: 100, high: 101, low: 99, close: 100, volume: 100,
  }
  const structuralBreak: Candle = {
    time: 14 * fifteenMinutes, open: 100, high: 102.5, low: 99.5, close: 102, volume: 100,
  }
  const breakDecision: HistoricalDecisionContext = {
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '15m',
    decisionTime: structuralBreak.time + fifteenMinutes,
    sourceCandle: structuralBreak,
    candles: { '15m': [...prefix, previous, structuralBreak], '1h': [], '4h': [], '1d': [] },
  }
  assert.equal(internal.evaluateEntry(breakDecision, breakDecision.candles['15m']!), null)
  assert.deepEqual(evaluator.checkpoint().structureBreak, {
    thesisId: eligible.id,
    side: 'LONG',
    level: previous.high,
    occurredAt: breakDecision.decisionTime,
  })

  const heldRetest: Candle = {
    time: 15 * fifteenMinutes, open: 101, high: 103, low: 100.8, close: 102.6, volume: 100,
  }
  const retestDecision: HistoricalDecisionContext = {
    ...breakDecision,
    decisionTime: heldRetest.time + fifteenMinutes,
    sourceCandle: heldRetest,
    candles: { ...breakDecision.candles, '15m': [...prefix, previous, structuralBreak, heldRetest] },
  }
  const entry = internal.evaluateEntry(retestDecision, retestDecision.candles['15m']!) as {
    action: string
  } | null
  assert.equal(entry?.action, 'ENTER')
  assert.equal(riskEntries[0]?.swing.stage, 'CONFIRMED')
})

test('invalidates an active Thesis on its closed 4H condition before any position exists', () => {
  const evaluator = new SwingHistoricalEvaluator(config)
  const candidate = createSwingTradeThesis({
    id: 'BTC-THESIS-INVALIDATION',
    symbol: 'BTC/USDT:USDT',
    type: 'STRUCTURAL_REVERSAL',
    direction: 'LONG',
    contextId: 'context-1',
    locationId: 'location-1',
    score: 50,
    invalidation: {
      policyId: 'thesis_invalidation_v1',
      type: 'H4_CLOSE_BELOW_LEVEL',
      timeframe: '4h',
      level: 95,
    },
    expectedMove: { targetLocationId: 'location-target', target: 110 },
    createdAt: 0,
    expiresAt: 14 * 24 * 60 * 60 * 1000,
    reasonCodes: ['THESIS_CREATED'],
  })
  const state = evaluator as unknown as {
    thesis?: SwingTradeThesis
    thesisContext?: StrategyHistoricalSwingRiskTraceEntry['swing']['context']
  }
  state.thesis = transitionSwingTradeThesis(candidate, {
    toState: 'ACTIVE', occurredAt: 0, reasonCodes: ['THESIS_ACTIVATED'],
  }).thesis
  state.thesisContext = { id: 'context-1', state: 'RANGE', bias: 'NEUTRAL' }
  const fifteenMinute: Candle = {
    time: 4 * 60 * 60 * 1000 - fifteenMinutes,
    open: 96,
    high: 97,
    low: 89,
    close: 90,
    volume: 100,
  }
  const fourHour: Candle = { ...fifteenMinute, time: 0 }

  const decisions = evaluator.evaluate({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '15m',
    decisionTime: 4 * 60 * 60 * 1000,
    sourceCandle: fifteenMinute,
    candles: { '15m': [fifteenMinute], '1h': [], '4h': [fourHour], '1d': [] },
  })

  assert.deepEqual(decisions, [])
  assert.equal(state.thesis?.state, 'INVALIDATED')
  assert.equal(state.thesisContext, undefined)
  assert.equal(evaluator.statistics().invalidatedBeforeFirstEntry, 1)
})

test('reports missing Expected Move decisions without creating a Thesis', () => {
  const evaluator = new SwingHistoricalEvaluator(config)
  const fourHourly = baseCandles(config.location.atrPeriod + 1)
  const decisionTime = fourHourly.at(-1)!.time + fifteenMinutes
  const internal = evaluator as unknown as {
    context?: SwingDailyMarketContextDecision
    locations: SwingLocationCandidate[]
    createThesis(decision: HistoricalDecisionContext, candles: readonly Candle[]): void
  }
  internal.context = {
    context: {
      id: 'context-1', symbol: 'BTC/USDT:USDT', daily: 'RANGE', h4: 'RANGE',
      reasonCodes: ['DAILY_CONTEXT_RANGE'], observedAt: 0,
    },
    state: 'RANGE',
    bias: 'NEUTRAL',
    score: 70,
    reasonCodes: ['DAILY_CONTEXT_RANGE'],
    featureSnapshot: {},
  }
  internal.locations = [location()]
  internal.createThesis({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '15m',
    decisionTime,
    sourceCandle: fourHourly.at(-1)!,
    candles: { '15m': [], '1h': [], '4h': fourHourly, '1d': [] },
  }, fourHourly)

  assert.equal(evaluator.statistics().missingExpectedMoveDecisions, 1)
  assert.equal(evaluator.statistics().createdTheses, 0)
})

test('deduplicates evaluated entry gate reasons by Thesis and counts pre-entry expiry', () => {
  const evaluator = new SwingHistoricalEvaluator(config)
  const candidate = createSwingTradeThesis({
    id: 'BTC-THESIS-GATED',
    symbol: 'BTC/USDT:USDT',
    type: 'STRUCTURAL_REVERSAL',
    direction: 'LONG',
    contextId: 'context-1',
    locationId: 'source-location',
    score: 50,
    invalidation: {
      policyId: 'thesis_invalidation_v1', type: 'H4_CLOSE_BELOW_LEVEL', timeframe: '4h', level: 90,
    },
    expectedMove: { targetLocationId: 'target-location', target: 1 },
    createdAt: 0,
    expiresAt: 14 * 24 * 60 * 60 * 1000,
    reasonCodes: ['THESIS_CREATED'],
  })
  const internal = evaluator as unknown as {
    thesis?: SwingTradeThesis
    thesisLocation?: SwingLocationCandidate
  }
  const active = transitionSwingTradeThesis(candidate, {
    toState: 'ACTIVE', occurredAt: 0, reasonCodes: ['THESIS_ACTIVATED'],
  }).thesis
  const withEvidence = appendSwingEvidence(active, {
    id: 'BTC-THESIS-GATED:evidence:1',
    thesisId: candidate.id,
    type: 'DIRECTIONAL_PROGRESS',
    time: fifteenMinutes,
    direction: 'LONG',
    effect: 'SUPPORTING',
    scoreDelta: 10,
    reasonCodes: ['EVIDENCE_STRENGTHENED'],
    featureSnapshot: {},
  })
  internal.thesis = transitionSwingTradeThesis(withEvidence, {
    toState: 'ENTRY_ELIGIBLE', occurredAt: fifteenMinutes, reasonCodes: ['ENTRY_ELIGIBLE'],
  }).thesis
  internal.thesisLocation = location()
  const fifteenMinute = baseCandles(15)
  const decision = (decisionTime: number): HistoricalDecisionContext => ({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '15m',
    decisionTime,
    sourceCandle: fifteenMinute.at(-1)!,
    candles: { '15m': fifteenMinute, '1h': [], '4h': [], '1d': [] },
  })
  evaluator.evaluate(decision(15 * fifteenMinutes))
  evaluator.evaluate(decision(16 * fifteenMinutes))
  assert.equal(evaluator.statistics().entryGateRejectionsByReason.RR_TOO_LOW, 1)
  assert.equal(evaluator.statistics().entryGateRejectionsByStageAndReason.EARLY.RR_TOO_LOW, 1)
  assert.deepEqual(evaluator.statistics().entryGateRejectionsByStageAndReason.STANDARD, {})
  assert.deepEqual(evaluator.statistics().entryGateRejectionsByStageAndReason.CONFIRMED, {})

  const expiringEvaluator = new SwingHistoricalEvaluator(config)
  const expiringCandidate = createSwingTradeThesis({
    ...candidate,
    id: 'BTC-THESIS-EXPIRING',
    expiresAt: fifteenMinutes,
  })
  const expiringInternal = expiringEvaluator as unknown as { thesis?: SwingTradeThesis }
  expiringInternal.thesis = transitionSwingTradeThesis(expiringCandidate, {
    toState: 'ACTIVE', occurredAt: 0, reasonCodes: ['THESIS_ACTIVATED'],
  }).thesis
  expiringEvaluator.evaluate({
    ...decision(fifteenMinutes),
    candles: { '15m': [fifteenMinute[0]!], '1h': [], '4h': [], '1d': [] },
  })
  assert.equal(expiringEvaluator.statistics().expiredBeforeFirstEntry, 1)
})

test('records LOCATION_MISSING only for an entry-eligible Thesis', () => {
  const evaluator = new SwingHistoricalEvaluator(config)
  const candidate = createSwingTradeThesis({
    id: 'BTC-THESIS-LOCATION-GATE',
    symbol: 'BTC/USDT:USDT',
    type: 'STRUCTURAL_REVERSAL',
    direction: 'LONG',
    contextId: 'context-1',
    locationId: 'missing-location',
    score: 60,
    invalidation: {
      policyId: 'thesis_invalidation_v1', type: 'H4_CLOSE_BELOW_LEVEL', timeframe: '4h', level: 90,
    },
    expectedMove: { targetLocationId: 'target-location', target: 110 },
    createdAt: 0,
    expiresAt: 14 * 24 * 60 * 60 * 1000,
    reasonCodes: ['THESIS_CREATED'],
  })
  const active = transitionSwingTradeThesis(candidate, {
    toState: 'ACTIVE', occurredAt: 0, reasonCodes: ['THESIS_ACTIVATED'],
  }).thesis
  const eligible = transitionSwingTradeThesis(active, {
    toState: 'ENTRY_ELIGIBLE', occurredAt: fifteenMinutes, reasonCodes: ['ENTRY_ELIGIBLE'],
  }).thesis
  const internal = evaluator as unknown as { thesis?: SwingTradeThesis }
  const fifteenMinute = baseCandles(15)
  const evaluate = () => evaluator.evaluate({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '15m',
    decisionTime: 15 * fifteenMinutes,
    sourceCandle: fifteenMinute.at(-1)!,
    candles: { '15m': fifteenMinute, '1h': [], '4h': [], '1d': [] },
  })

  internal.thesis = transitionSwingTradeThesis(
    transitionSwingTradeThesis(eligible, {
      toState: 'TRIGGERED', occurredAt: 2 * fifteenMinutes, reasonCodes: ['EXECUTION_TRIGGERED'],
    }).thesis,
    { toState: 'CLOSED', occurredAt: 3 * fifteenMinutes, reasonCodes: ['THESIS_CLOSED'] },
  ).thesis
  evaluate()
  assert.equal(evaluator.statistics().entryGateRejectionsByReason.LOCATION_MISSING, undefined)

  internal.thesis = eligible
  evaluate()
  assert.equal(evaluator.statistics().entryGateRejectionsByReason.LOCATION_MISSING, 1)
})

test('freezes creation-time Context through ENTER and clears it when the Thesis closes', () => {
  const riskEntries: StrategyHistoricalSwingRiskTraceEntry[] = []
  const evaluator = new SwingHistoricalEvaluator(config, (entry) => riskEntries.push(entry))
  const source = location({ score: 100 })
  const target = location({
    id: 'target-location',
    direction: 'SHORT',
    boundaries: { lower: 110, upper: 111 },
  })
  const internal = evaluator as unknown as {
    context?: SwingDailyMarketContextDecision
    locations: SwingLocationCandidate[]
    thesis?: SwingTradeThesis
    thesisContext?: StrategyHistoricalSwingRiskTraceEntry['swing']['context']
    createThesis(decision: HistoricalDecisionContext, candles: readonly Candle[]): void
  }
  internal.context = {
    context: {
      id: 'context-at-creation', symbol: 'BTC/USDT:USDT', daily: 'RANGE', h4: 'RANGE',
      reasonCodes: ['DAILY_CONTEXT_RANGE'], observedAt: 0,
    },
    state: 'RANGE',
    bias: 'NEUTRAL',
    score: 70,
    reasonCodes: ['DAILY_CONTEXT_RANGE'],
    featureSnapshot: {},
  }
  internal.locations = [source, target]
  const fourHourly = baseCandles(config.location.atrPeriod + 1)
  const createdAt = fourHourly.at(-1)!.time + fifteenMinutes
  internal.createThesis({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '15m',
    decisionTime: createdAt,
    sourceCandle: fourHourly.at(-1)!,
    candles: { '15m': [], '1h': [], '4h': fourHourly, '1d': [] },
  }, fourHourly)
  assert.ok(internal.thesis)
  const withEvidence = appendSwingEvidence(internal.thesis, {
    id: `${internal.thesis.id}:evidence:entry`,
    thesisId: internal.thesis.id,
    type: 'DIRECTIONAL_PROGRESS',
    time: createdAt,
    direction: 'LONG',
    effect: 'SUPPORTING',
    scoreDelta: 10,
    reasonCodes: ['EVIDENCE_STRENGTHENED'],
    featureSnapshot: {},
  })
  internal.thesis = transitionSwingTradeThesis(withEvidence, {
    toState: 'ENTRY_ELIGIBLE', occurredAt: createdAt, reasonCodes: ['ENTRY_ELIGIBLE'],
  }).thesis

  internal.context = {
    context: {
      id: 'context-after-creation', symbol: 'BTC/USDT:USDT', daily: 'UP', h4: 'UP',
      reasonCodes: ['DAILY_CONTEXT_BULLISH_TREND'], observedAt: createdAt,
    },
    state: 'BULLISH_TREND',
    bias: 'BULLISH',
    score: 95,
    reasonCodes: ['DAILY_CONTEXT_BULLISH_TREND'],
    featureSnapshot: {},
  }
  const fifteenMinute = Array.from({ length: 15 }, (_, index): Candle => ({
    time: createdAt - (14 - index) * fifteenMinutes,
    open: 100.5,
    high: 100.7,
    low: 100.3,
    close: 100.5,
    volume: 100,
  }))
  fifteenMinute[14] = {
    time: createdAt, open: 100.5, high: 101.3, low: 100.2, close: 101.2, volume: 100,
  }
  const entryDecisionTime = createdAt + fifteenMinutes
  const entryDecisions = evaluator.evaluate({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '15m',
    decisionTime: entryDecisionTime,
    sourceCandle: fifteenMinute.at(-1)!,
    candles: { '15m': fifteenMinute, '1h': [], '4h': [], '1d': [] },
  })

  assert.equal(entryDecisions[0]?.action, 'ENTER')
  assert.equal(riskEntries.length, 1)
  assert.deepEqual(riskEntries[0]!.swing.context, {
    id: 'context-at-creation', state: 'RANGE', bias: 'NEUTRAL',
  })
  assert.equal(riskEntries[0]!.swing.stage, 'STANDARD')

  const exitCandle: Candle = {
    time: entryDecisionTime, open: 101.2, high: 111.2, low: 101, close: 111, volume: 100,
  }
  const exitDecisions = evaluator.evaluate({
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '15m',
    decisionTime: entryDecisionTime + fifteenMinutes,
    sourceCandle: exitCandle,
    candles: { '15m': [exitCandle], '1h': [], '4h': [], '1d': [] },
  })
  assert.equal(exitDecisions[0]?.action, 'EXIT')
  assert.equal(internal.thesis?.state, 'CLOSED')
  assert.equal(internal.thesisContext, undefined)
})

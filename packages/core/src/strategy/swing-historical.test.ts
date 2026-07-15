import assert from 'node:assert/strict'
import test from 'node:test'
import type { Candle } from '@helix/contracts/market'
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
  execution: { minRrByStage: { EARLY: 1, STANDARD: 1.2, CONFIRMED: 1.5 }, maxAttemptsPerThesis: 3 },
  risk: { thesisRiskBudgetR: 1, riskByStageR: { EARLY: 0.25, STANDARD: 0.35, CONFIRMED: 0.4 } },
}

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
    const evaluator = new SwingHistoricalEvaluator(config)
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
    return { artifact, statistics: evaluator.statistics() }
  }
  const first = run()
  const second = run()
  assert.ok(first.artifact.signals.length >= 2, JSON.stringify(first.statistics))
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
  const state = evaluator as unknown as { thesis?: SwingTradeThesis }
  state.thesis = transitionSwingTradeThesis(candidate, {
    toState: 'ACTIVE', occurredAt: 0, reasonCodes: ['THESIS_ACTIVATED'],
  }).thesis
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

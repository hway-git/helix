import type { Candle } from '@helix/contracts/market'
import type { StrategyHistoricalScalpRiskTraceEntry } from '@helix/contracts/strategy'
import type {
  BreakoutFailureConfig,
  LiquiditySweepConfig,
  MomentumBurstConfig,
  ScalpExecutionConfig,
  ScalpDetectorDecision,
  ScalpGrade,
  ScalpHuntingZone,
  ScalpHuntingZoneConfig,
  ScalpMarketRegimeConfig,
  ScalpMarketRegimeDecision,
  ScalpPriceEvent,
  ScalpResponseState,
  ScalpRiskPolicyConfig,
  ScalpTimePolicyConfig,
} from '@helix/contracts/scalp'
import type { HistoricalDecisionContext, HistoricalSignalDecision } from './historical-runner'
import { average, emaSeries, trueRanges } from './market-structure'
import { classifyScalpMarketRegime, scanScalpHuntingZones } from './scalp-context'
import {
  detectBreakoutFailure,
  detectLiquiditySweep,
  detectMomentumBurst,
  evaluateScalpExecution,
} from './scalp-detectors'
import { evaluateScalpRiskPolicy, evaluateScalpTimePolicy } from './scalp-policies'
import {
  createScalpPriceEvent,
  transitionScalpPriceEvent,
} from './scalp-state-machine'

const MINUTE_MS = 60_000
const FIVE_MINUTES_MS = 5 * MINUTE_MS
const FIFTEEN_MINUTES_MS = 15 * MINUTE_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const EVENT_TTL_MS: Record<ScalpPriceEvent['type'], number> = {
  LIQUIDITY_SWEEP: 15 * MINUTE_MS,
  BREAKOUT_FAILURE: 15 * MINUTE_MS,
  MOMENTUM_BURST: 5 * MINUTE_MS,
}

export type ScalpHistoricalEvaluatorConfig = {
  marketRegime: ScalpMarketRegimeConfig
  huntingZone: ScalpHuntingZoneConfig
  liquiditySweep: LiquiditySweepConfig
  breakoutFailure: BreakoutFailureConfig
  momentumBurst: MomentumBurstConfig
  execution: ScalpExecutionConfig
  risk: ScalpRiskPolicyConfig
  time: ScalpTimePolicyConfig
}

type OpenScalpPosition = {
  event: ScalpPriceEvent
  zone: ScalpHuntingZone
  side: 'LONG' | 'SHORT'
  entryPrice: number
  stop: number
  target: number
  riskDistance: number
  riskR: number
  triggeredAt: number
  responseState: ScalpResponseState
}

type PendingScalpBreach = {
  zone: ScalpHuntingZone
  side: 'LONG' | 'SHORT'
  breachedAt: number
  atr: number
  invalidationPrice: number
  wickRatio: number
  maxOutsideCloseDistance: number
}

type AcceptedScalpEvent = {
  detectorId: ScalpPriceEvent['detectorId']
  type: ScalpPriceEvent['type']
  decision: ScalpDetectorDecision
  invalidationPrice: number
}

export const SCALP_HISTORICAL_CHECKPOINT_SCHEMA_VERSION = 'helix.scalp-evaluator-checkpoint/v2' as const

export type ScalpHistoricalEvaluatorCheckpoint = Readonly<{
  schemaVersion: typeof SCALP_HISTORICAL_CHECKPOINT_SCHEMA_VERSION
  regime: ScalpMarketRegimeDecision | null
  zones: readonly ScalpHuntingZone[]
  event: ScalpPriceEvent | null
  eventZone: ScalpHuntingZone | null
  eventRegime: StrategyHistoricalScalpRiskTraceEntry['scalp']['regime'] | null
  eventInvalidationPrice: number | null
  position: OpenScalpPosition | null
  pendingBreach: PendingScalpBreach | null
  lastRegimeCandleTime: number
  lastZoneCandleTime: number
  lastEventCandleTime: number
  riskDay: number
  dailyLossUsedR: number
  consecutiveLosses: number
  detectedEvents: number
  enteredTrades: number
  exitedTrades: number
  expiredEvents: number
  detectedByType: Readonly<Record<ScalpPriceEvent['type'], number>>
  eventRejections: readonly Readonly<{ eventId: string; reasonCodes: readonly string[] }>[]
}>

function checkpointInteger(value: unknown, name: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`)
  }
  return Number(value)
}

function checkpointNumber(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`)
  }
  return value
}

function latest(series: readonly Candle[] | undefined) {
  return series?.at(-1)
}

function latestAtr(candles: readonly Candle[], period = 14) {
  if (candles.length < period + 1) return null
  return average(trueRanges(candles.slice(-(period + 1))).slice(-period))
}

function bodyRatio(candle: Candle) {
  return Math.abs(candle.close - candle.open) / Math.max(candle.high - candle.low, Number.EPSILON)
}

export function scalpMicroStructureBreak(
  candles: readonly Candle[],
  side: 'LONG' | 'SHORT',
) {
  const current = candles.at(-1)
  if (!current || candles.length < 4) return false
  for (let index = candles.length - 3; index >= 1; index -= 1) {
    const pivot = candles[index]!
    const previous = candles[index - 1]!
    const next = candles[index + 1]!
    if (side === 'LONG' && pivot.high > previous.high && pivot.high > next.high) {
      return current.close > pivot.high
    }
    if (side === 'SHORT' && pivot.low < previous.low && pivot.low < next.low) {
      return current.close < pivot.low
    }
  }
  return false
}

function eventGrade(score: number): ScalpGrade | null {
  if (score >= 85) return 'A_PLUS'
  if (score >= 75) return 'A'
  if (score >= 65) return 'B'
  return null
}

function detectedEventScore(zoneScore: number, regimeScore: number) {
  return Math.round(
    Math.min(100, Math.max(0, zoneScore)) * 0.25
    + Math.min(100, Math.max(0, regimeScore)) * 0.15
    + 25
    + 15,
  )
}

function rejectionCounts(rejections: Map<string, Set<string>>) {
  const counts: Record<string, number> = {}
  for (const reasons of rejections.values()) {
    for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function sideFromZone(zone: ScalpHuntingZone, candle: Candle): 'LONG' | 'SHORT' {
  if (zone.directionInterest === 'LONG' || zone.directionInterest === 'SHORT') return zone.directionInterest
  return candle.close >= candle.open ? 'LONG' : 'SHORT'
}

function zoneTouchesCandle(zone: ScalpHuntingZone, candle: Candle, atr: number) {
  const tolerance = atr * 0.2
  return candle.low <= zone.boundary.upper + tolerance && candle.high >= zone.boundary.lower - tolerance
}

export function selectScalpStructuralTarget(input: {
  zones: readonly ScalpHuntingZone[]
  sourceZoneId: string
  side: 'LONG' | 'SHORT'
  entry: number
  evaluatedAt: number
}) {
  const targets = input.zones.flatMap((zone) => {
    if (zone.id === input.sourceZoneId || zone.state !== 'ACTIVE' || zone.detectedAt > input.evaluatedAt
      || (zone.expiresAt !== undefined && zone.expiresAt <= input.evaluatedAt)) return []
    if (input.side === 'LONG'
      && (zone.directionInterest === 'SHORT' || zone.directionInterest === 'BOTH')
      && zone.boundary.lower > input.entry) return [{ zoneId: zone.id, price: zone.boundary.lower }]
    if (input.side === 'SHORT'
      && (zone.directionInterest === 'LONG' || zone.directionInterest === 'BOTH')
      && zone.boundary.upper < input.entry) return [{ zoneId: zone.id, price: zone.boundary.upper }]
    return []
  })
  targets.sort((left, right) => (
    input.side === 'LONG' ? left.price - right.price : right.price - left.price
  ) || left.zoneId.localeCompare(right.zoneId))
  return targets[0] ?? null
}

export class ScalpHistoricalEvaluator {
  private regime?: ScalpMarketRegimeDecision
  private zones: ScalpHuntingZone[] = []
  private event?: ScalpPriceEvent
  private eventZone?: ScalpHuntingZone
  private eventRegime?: StrategyHistoricalScalpRiskTraceEntry['scalp']['regime']
  private eventInvalidationPrice?: number
  private position?: OpenScalpPosition
  private pendingBreach?: PendingScalpBreach
  private lastRegimeCandleTime = -1
  private lastZoneCandleTime = -1
  private lastEventCandleTime = -1
  private riskDay = -1
  private dailyLossUsedR = 0
  private consecutiveLosses = 0
  private detectedEvents = 0
  private enteredTrades = 0
  private exitedTrades = 0
  private expiredEvents = 0
  private readonly detectedByType: Record<ScalpPriceEvent['type'], number> = {
    LIQUIDITY_SWEEP: 0,
    BREAKOUT_FAILURE: 0,
    MOMENTUM_BURST: 0,
  }
  private readonly eventRejections = new Map<string, Set<string>>()

  constructor(
    private readonly config: ScalpHistoricalEvaluatorConfig,
    private readonly recordHistoricalRiskEntry?: (entry: StrategyHistoricalScalpRiskTraceEntry) => void,
    checkpoint?: ScalpHistoricalEvaluatorCheckpoint,
  ) {
    if (checkpoint) this.restore(checkpoint)
  }

  checkpoint(): ScalpHistoricalEvaluatorCheckpoint {
    return structuredClone({
      schemaVersion: SCALP_HISTORICAL_CHECKPOINT_SCHEMA_VERSION,
      regime: this.regime ?? null,
      zones: this.zones,
      event: this.event ?? null,
      eventZone: this.eventZone ?? null,
      eventRegime: this.eventRegime ?? null,
      eventInvalidationPrice: this.eventInvalidationPrice ?? null,
      position: this.position ?? null,
      pendingBreach: this.pendingBreach ?? null,
      lastRegimeCandleTime: this.lastRegimeCandleTime,
      lastZoneCandleTime: this.lastZoneCandleTime,
      lastEventCandleTime: this.lastEventCandleTime,
      riskDay: this.riskDay,
      dailyLossUsedR: this.dailyLossUsedR,
      consecutiveLosses: this.consecutiveLosses,
      detectedEvents: this.detectedEvents,
      enteredTrades: this.enteredTrades,
      exitedTrades: this.exitedTrades,
      expiredEvents: this.expiredEvents,
      detectedByType: this.detectedByType,
      eventRejections: [...this.eventRejections.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([eventId, reasonCodes]) => ({ eventId, reasonCodes: [...reasonCodes].sort() })),
    })
  }

  private restore(checkpoint: ScalpHistoricalEvaluatorCheckpoint) {
    if (!checkpoint || checkpoint.schemaVersion !== SCALP_HISTORICAL_CHECKPOINT_SCHEMA_VERSION) {
      throw new Error('unsupported Scalp evaluator checkpoint')
    }
    if (!Array.isArray(checkpoint.zones) || !Array.isArray(checkpoint.eventRejections)) {
      throw new Error('Scalp evaluator checkpoint arrays are invalid')
    }
    const detectedByType = checkpoint.detectedByType
    if (!detectedByType || typeof detectedByType !== 'object'
      || Object.keys(detectedByType).sort().join(',') !== 'BREAKOUT_FAILURE,LIQUIDITY_SWEEP,MOMENTUM_BURST') {
      throw new Error('Scalp evaluator checkpoint detectedByType is invalid')
    }
    const rejections = new Map<string, Set<string>>()
    for (const entry of checkpoint.eventRejections) {
      if (!entry || typeof entry.eventId !== 'string' || !entry.eventId.trim()
        || !Array.isArray(entry.reasonCodes)
        || entry.reasonCodes.some((reason: string) => typeof reason !== 'string' || !reason.trim())) {
        throw new Error('Scalp evaluator checkpoint rejection entry is invalid')
      }
      if (rejections.has(entry.eventId)) throw new Error('Scalp evaluator checkpoint has duplicate rejection entries')
      rejections.set(entry.eventId, new Set(entry.reasonCodes))
    }
    if (checkpoint.position && (!checkpoint.event || !checkpoint.eventZone || !checkpoint.eventRegime)) {
      throw new Error('Scalp evaluator checkpoint position is missing its frozen Event state')
    }
    if (checkpoint.event && (!checkpoint.eventRegime || checkpoint.eventInvalidationPrice == null)) {
      throw new Error('Scalp evaluator checkpoint Event is missing frozen context')
    }
    this.regime = structuredClone(checkpoint.regime ?? undefined)
    this.zones = structuredClone([...checkpoint.zones])
    this.event = structuredClone(checkpoint.event ?? undefined)
    this.eventZone = structuredClone(checkpoint.eventZone ?? undefined)
    this.eventRegime = structuredClone(checkpoint.eventRegime ?? undefined)
    this.eventInvalidationPrice = checkpoint.eventInvalidationPrice == null
      ? undefined
      : checkpointNumber(checkpoint.eventInvalidationPrice, 'eventInvalidationPrice')
    this.position = structuredClone(checkpoint.position ?? undefined)
    this.pendingBreach = structuredClone(checkpoint.pendingBreach ?? undefined)
    this.lastRegimeCandleTime = checkpointInteger(checkpoint.lastRegimeCandleTime, 'lastRegimeCandleTime', -1)
    this.lastZoneCandleTime = checkpointInteger(checkpoint.lastZoneCandleTime, 'lastZoneCandleTime', -1)
    this.lastEventCandleTime = checkpointInteger(checkpoint.lastEventCandleTime, 'lastEventCandleTime', -1)
    this.riskDay = checkpointInteger(checkpoint.riskDay, 'riskDay', -1)
    this.dailyLossUsedR = checkpointNumber(checkpoint.dailyLossUsedR, 'dailyLossUsedR')
    this.consecutiveLosses = checkpointInteger(checkpoint.consecutiveLosses, 'consecutiveLosses')
    this.detectedEvents = checkpointInteger(checkpoint.detectedEvents, 'detectedEvents')
    this.enteredTrades = checkpointInteger(checkpoint.enteredTrades, 'enteredTrades')
    this.exitedTrades = checkpointInteger(checkpoint.exitedTrades, 'exitedTrades')
    this.expiredEvents = checkpointInteger(checkpoint.expiredEvents, 'expiredEvents')
    for (const type of Object.keys(this.detectedByType) as ScalpPriceEvent['type'][]) {
      this.detectedByType[type] = checkpointInteger(detectedByType[type], `detectedByType.${type}`)
    }
    this.eventRejections.clear()
    for (const [eventId, reasons] of rejections) this.eventRejections.set(eventId, reasons)
  }

  statistics() {
    return {
      detectedEvents: this.detectedEvents,
      enteredTrades: this.enteredTrades,
      exitedTrades: this.exitedTrades,
      expiredEvents: this.expiredEvents,
      detectedByType: { ...this.detectedByType },
      rejectedEventsByReason: rejectionCounts(this.eventRejections),
    }
  }

  evaluate = (context: HistoricalDecisionContext): readonly HistoricalSignalDecision[] => {
    if (context.baseTimeframe !== '1m') throw new Error('Scalp historical evaluator requires 1m baseTimeframe')
    const oneMinute = context.candles['1m'] ?? []
    const fiveMinute = context.candles['5m'] ?? []
    const fifteenMinute = context.candles['15m'] ?? []
    const hourly = context.candles['1h'] ?? []
    const current = latest(oneMinute)
    if (!current) return []

    const day = Math.floor(context.decisionTime / DAY_MS)
    if (day !== this.riskDay) {
      this.riskDay = day
      this.dailyLossUsedR = 0
    }

    const latestHour = latest(hourly)
    const regimeMinimum = Math.max(this.config.marketRegime.slowWindowBars + 1, this.config.marketRegime.emaPeriod + 1)
    if (latestHour && latestHour.time !== this.lastRegimeCandleTime && hourly.length >= regimeMinimum) {
      const pausedForConsecutiveLosses = this.consecutiveLosses >= this.config.risk.maxConsecutiveLosses
      this.regime = classifyScalpMarketRegime(this.config.marketRegime, {
        id: `${context.symbol}:1h:${latestHour.time + HOUR_MS}`,
        symbol: context.symbol,
        candles: [...hourly],
      })
      this.lastRegimeCandleTime = latestHour.time
      if (pausedForConsecutiveLosses) this.consecutiveLosses = 0
    }

    const latestFifteen = latest(fifteenMinute)
    const zoneMinimum = Math.max(this.config.huntingZone.lookbackBars, this.config.huntingZone.atrPeriod + 1)
    if (this.regime && latestFifteen && latestFifteen.time !== this.lastZoneCandleTime
      && fifteenMinute.length >= zoneMinimum) {
      this.zones = scanScalpHuntingZones(this.config.huntingZone, {
        symbol: context.symbol,
        candles: [...fifteenMinute],
        regime: this.regime.regime,
      }).zones
      this.lastZoneCandleTime = latestFifteen.time
    }

    const exit = this.evaluateOpenPosition(context, oneMinute)
    if (exit) return [exit]

    if (this.event
      && (this.event.state === 'DETECTED' || this.event.state === 'ARMED')
      && context.decisionTime >= this.event.expiresAt) {
      this.event = transitionScalpPriceEvent(this.event, {
        toState: 'EXPIRED',
        occurredAt: context.decisionTime,
        reasonCodes: ['EVENT_TTL_EXPIRED'],
      }).event
      this.recordEventRejection(this.event.id, ['EVENT_TTL_EXPIRED'])
      this.expiredEvents += 1
      this.event = undefined
      this.eventZone = undefined
      this.eventRegime = undefined
      this.eventInvalidationPrice = undefined
    }

    const entry = this.evaluateArmedEvent(context, oneMinute)
    if (entry) return [entry]

    const latestFive = latest(fiveMinute)
    if (!this.event && this.regime && latestFive && latestFive.time !== this.lastEventCandleTime) {
      this.detectEvent(context, fiveMinute)
      this.lastEventCandleTime = latestFive.time
    }
    return []
  }

  private evaluateOpenPosition(
    context: HistoricalDecisionContext,
    oneMinute: readonly Candle[],
  ): HistoricalSignalDecision | null {
    const position = this.position
    const candle = latest(oneMinute)
    if (!position || !candle) return null
    const favorableR = position.side === 'LONG'
      ? (candle.close - position.entryPrice) / position.riskDistance
      : (position.entryPrice - candle.close) / position.riskDistance
    if (position.responseState === 'EXPECTED_RESPONSE_WINDOW' && favorableR >= 0.5) {
      position.responseState = 'RESPONSE_OK'
    }
    const stopped = position.side === 'LONG' ? candle.low <= position.stop : candle.high >= position.stop
    const targeted = position.side === 'LONG' ? candle.high >= position.target : candle.low <= position.target
    const time = evaluateScalpTimePolicy(this.config.time, {
      eventType: position.event.type,
      triggeredAt: position.triggeredAt,
      evaluatedAt: context.decisionTime,
      responseState: position.responseState,
    })
    let reasonCode: string | null = null
    if (stopped) reasonCode = 'STOP_HIT'
    else if (targeted) reasonCode = 'TARGET_HIT'
    else if (time.action === 'EXIT') {
      reasonCode = time.reasonCodes.includes('TIME_STOP') ? 'TIME_STOP' : 'RESPONSE_FAILURE_EXIT'
    }
    if (!reasonCode) return null

    const pnlR = reasonCode === 'STOP_HIT' ? -1 : reasonCode === 'TARGET_HIT' ? 1 : favorableR
    if (pnlR < 0) {
      this.dailyLossUsedR += position.riskR * Math.min(1, Math.abs(pnlR))
      this.consecutiveLosses += 1
    } else {
      this.consecutiveLosses = 0
    }
    const closedEvent = transitionScalpPriceEvent(position.event, {
      toState: 'CLOSED',
      occurredAt: context.decisionTime,
      reasonCodes: [reasonCode],
    }).event
    const decision: HistoricalSignalDecision = {
      signalId: `${closedEvent.id}:exit:${context.decisionTime}`,
      decisionId: `${closedEvent.id}:decision:exit:${context.decisionTime}`,
      object: { model: 'PRICE_EVENT', id: closedEvent.id },
      action: 'EXIT',
      side: position.side,
      reasonCodes: [reasonCode],
    }
    this.position = undefined
    this.event = undefined
    this.eventZone = undefined
    this.eventRegime = undefined
    this.eventInvalidationPrice = undefined
    this.exitedTrades += 1
    return decision
  }

  private evaluateArmedEvent(
    context: HistoricalDecisionContext,
    oneMinute: readonly Candle[],
  ): HistoricalSignalDecision | null {
    if (!this.event || this.event.state !== 'ARMED' || !this.eventZone
      || this.eventInvalidationPrice === undefined || oneMinute.length < 15) return null
    const candle = latest(oneMinute)!
    const atr = latestAtr(oneMinute)
    if (!atr || atr <= 0) return null
    const side = this.event.direction
    const microStructureBreak = scalpMicroStructureBreak(oneMinute.slice(-15), side)
    const displacement = bodyRatio(candle) >= 0.55
      && (side === 'LONG' ? candle.close > candle.open : candle.close < candle.open)
    const entryPrice = candle.close
    const stop = side === 'LONG'
      ? this.eventInvalidationPrice - atr * 0.1
      : this.eventInvalidationPrice + atr * 0.1
    const riskDistance = side === 'LONG' ? entryPrice - stop : stop - entryPrice
    if (riskDistance <= 0) {
      this.recordEventRejection(this.event.id, ['RR_TOO_LOW'])
      return null
    }
    const structuralTarget = selectScalpStructuralTarget({
      zones: this.zones,
      sourceZoneId: this.eventZone.id,
      side,
      entry: entryPrice,
      evaluatedAt: context.decisionTime,
    })
    const rr = structuralTarget ? Math.abs(structuralTarget.price - entryPrice) / riskDistance : 0
    const execution = evaluateScalpExecution(this.config.execution, this.event, {
      evaluatedAt: context.decisionTime,
      microStructureBreak,
      displacement,
      rr,
    })
    if (!execution.triggered || !structuralTarget) {
      this.recordEventRejection(this.event.id, execution.reasonCodes)
      return null
    }
    const triggeredScore = Math.min(100, Math.round(
      this.event.score + 10 + 10 * Math.min(1, rr / this.config.execution.minRr),
    ))
    const grade = eventGrade(triggeredScore)
    if (!grade) {
      this.recordEventRejection(this.event.id, ['EVENT_SCORE_TOO_LOW'])
      return null
    }
    const risk = evaluateScalpRiskPolicy(this.config.risk, {
      grade,
      dailyLossUsedR: this.dailyLossUsedR,
      consecutiveLosses: this.consecutiveLosses,
    })
    if (!risk.allowed) {
      this.recordEventRejection(this.event.id, risk.reasonCodes)
      return null
    }
    const triggered = transitionScalpPriceEvent({ ...this.event, score: triggeredScore }, {
      toState: 'TRIGGERED',
      occurredAt: context.decisionTime,
      reasonCodes: ['EXECUTION_TRIGGERED'],
      featureSnapshot: execution.featureSnapshot,
    }).event
    const signalId = `${triggered.id}:entry:${context.decisionTime}`
    if (this.recordHistoricalRiskEntry) {
      if (!this.eventRegime || this.eventRegime.id !== triggered.regimeId) {
        throw new Error(`Scalp Event ${triggered.id} is missing its frozen arm-time Regime`)
      }
      this.recordHistoricalRiskEntry({
        entrySignalId: signalId,
        family: 'scalp',
        object: { model: 'PRICE_EVENT', id: triggered.id },
        side,
        entryPrice: { source: 'DECISION_CANDLE_CLOSE', price: entryPrice },
        initialStop: stop,
        initialTarget: structuralTarget.price,
        riskDistance,
        riskR: risk.riskR,
        scalp: {
          eventType: triggered.type,
          grade,
          regime: { ...this.eventRegime },
        },
      })
    }
    this.event = triggered
    this.eventRejections.delete(triggered.id)
    this.position = {
      event: triggered,
      zone: this.eventZone,
      side,
      entryPrice,
      stop,
      target: structuralTarget.price,
      riskDistance,
      riskR: risk.riskR,
      triggeredAt: context.decisionTime,
      responseState: 'EXPECTED_RESPONSE_WINDOW',
    }
    this.enteredTrades += 1
    return {
      signalId,
      decisionId: `${triggered.id}:decision:entry:${context.decisionTime}`,
      object: { model: 'PRICE_EVENT', id: triggered.id },
      action: 'ENTER',
      side,
      reasonCodes: ['EXECUTION_TRIGGERED'],
    }
  }

  private detectEvent(context: HistoricalDecisionContext, fiveMinute: readonly Candle[]) {
    const candle = latest(fiveMinute)
    const atr = latestAtr(fiveMinute)
    if (!candle || !atr || fiveMinute.length < 21) return
    if (this.pendingBreach) {
      const accepted = this.evaluatePendingBreach(candle)
      if (accepted) this.armEvent(context, accepted.zone, accepted.side, accepted.event)
      return
    }
    const activeZones = this.zones
      .filter((zone) => zone.state === 'ACTIVE' && zone.detectedAt <= context.decisionTime
        && (zone.expiresAt === undefined || zone.expiresAt > context.decisionTime))
      .filter((zone) => zoneTouchesCandle(zone, candle, atr))
      .sort((left, right) => right.score - left.score)
    const zone = activeZones[0]
    if (!zone) return
    const side = sideFromZone(zone, candle)
    const range = Math.max(candle.high - candle.low, Number.EPSILON)
    const wick = side === 'LONG'
      ? (Math.min(candle.open, candle.close) - candle.low) / range
      : (candle.high - Math.max(candle.open, candle.close)) / range
    const breached = side === 'LONG' ? candle.low < zone.boundary.lower : candle.high > zone.boundary.upper
    if (breached) {
      this.pendingBreach = {
        zone,
        side,
        breachedAt: candle.time,
        atr,
        invalidationPrice: side === 'LONG' ? candle.low : candle.high,
        wickRatio: Math.max(0, wick),
        maxOutsideCloseDistance: 0,
      }
      const accepted = this.evaluatePendingBreach(candle)
      if (accepted) this.armEvent(context, zone, side, accepted.event)
      if (accepted || this.pendingBreach) return
    }
    const ema = emaSeries(fiveMinute.map((item) => item.close), 20).at(-1)!
    const breakout = side === 'LONG' ? candle.close > zone.boundary.upper : candle.close < zone.boundary.lower
    const momentum = detectMomentumBurst(this.config.momentumBurst, {
      zoneState: zone.state,
      zoneScore: zone.score,
      compressionConfirmed: zone.type.startsWith('COMPRESSION_'),
      breakoutConfirmed: breakout,
      bodyRatio: bodyRatio(candle),
      candleRangeAtr: range / atr,
      distanceFromMeanAtr: Math.abs(candle.close - ema) / atr,
    })
    if (momentum.detected) {
      this.armEvent(context, zone, side, {
        detectorId: 'momentum_burst_v1',
        type: 'MOMENTUM_BURST',
        decision: momentum,
        invalidationPrice: side === 'LONG' ? zone.boundary.lower : zone.boundary.upper,
      })
    }
  }

  private evaluatePendingBreach(candle: Candle): {
    zone: ScalpHuntingZone
    side: 'LONG' | 'SHORT'
    event: AcceptedScalpEvent
  } | null {
    const pending = this.pendingBreach
    if (!pending) return null
    pending.invalidationPrice = pending.side === 'LONG'
      ? Math.min(pending.invalidationPrice, candle.low)
      : Math.max(pending.invalidationPrice, candle.high)
    const bars = Math.floor((candle.time - pending.breachedAt) / FIVE_MINUTES_MS) + 1
    const outsideCloseDistance = pending.side === 'LONG'
      ? Math.max(0, pending.zone.boundary.lower - candle.close)
      : Math.max(0, candle.close - pending.zone.boundary.upper)
    pending.maxOutsideCloseDistance = Math.max(pending.maxOutsideCloseDistance, outsideCloseDistance)
    const returnedInside = pending.side === 'LONG'
      ? candle.close > pending.zone.boundary.lower
      : candle.close < pending.zone.boundary.upper
    const followThroughAtr = pending.maxOutsideCloseDistance / pending.atr
    const sweep = detectLiquiditySweep(this.config.liquiditySweep, {
      zoneState: pending.zone.state,
      zoneScore: pending.zone.score,
      levelBreached: true,
      reclaimed: returnedInside,
      reclaimBars: bars,
      wickRatio: pending.wickRatio,
      followThroughAtr,
    })
    const failure = detectBreakoutFailure(this.config.breakoutFailure, {
      zoneState: pending.zone.state,
      zoneScore: pending.zone.score,
      boundaryBroken: true,
      returnedInside,
      returnBars: bars,
      followThroughAtr,
    })
    const event = sweep.detected
      ? { detectorId: 'liquidity_sweep_v1' as const, type: 'LIQUIDITY_SWEEP' as const, decision: sweep }
      : failure.detected
        ? { detectorId: 'breakout_failure_v1' as const, type: 'BREAKOUT_FAILURE' as const, decision: failure }
        : null
    if (returnedInside
      || bars >= Math.max(this.config.liquiditySweep.maxReclaimBars, this.config.breakoutFailure.maxReturnBars)) {
      this.pendingBreach = undefined
    }
    return event ? {
      zone: pending.zone,
      side: pending.side,
      event: { ...event, invalidationPrice: pending.invalidationPrice },
    } : null
  }

  private armEvent(
    context: HistoricalDecisionContext,
    zone: ScalpHuntingZone,
    side: 'LONG' | 'SHORT',
    accepted: AcceptedScalpEvent,
  ) {
    if (!this.regime) return
    const id = `${context.symbol}:5m:${accepted.type}:${context.decisionTime}`
    const detected = createScalpPriceEvent({
      id,
      symbol: context.symbol,
      regimeId: this.regime.regime.id,
      zoneId: zone.id,
      detectorId: accepted.detectorId,
      type: accepted.type,
      direction: side,
      score: detectedEventScore(zone.score, this.regime.regime.score),
      detectedAt: context.decisionTime,
      expiresAt: context.decisionTime + EVENT_TTL_MS[accepted.type],
      reasonCodes: accepted.decision.reasonCodes,
    })
    this.event = transitionScalpPriceEvent(detected, {
      toState: 'ARMED',
      occurredAt: context.decisionTime,
      reasonCodes: [...accepted.decision.reasonCodes, 'EVENT_ARMED'],
      featureSnapshot: {
        ...accepted.decision.featureSnapshot,
        invalidation_price: accepted.invalidationPrice,
      },
    }).event
    this.eventZone = zone
    this.eventInvalidationPrice = accepted.invalidationPrice
    this.eventRegime = {
      id: this.regime.regime.id,
      type: this.regime.regime.type,
    }
    this.pendingBreach = undefined
    this.detectedEvents += 1
    this.detectedByType[accepted.type] += 1
  }

  private recordEventRejection(eventId: string, reasons: readonly string[]) {
    const recorded = this.eventRejections.get(eventId) ?? new Set<string>()
    for (const reason of reasons) recorded.add(reason)
    this.eventRejections.set(eventId, recorded)
  }
}

import type { Candle } from '@helix/contracts/market'
import type { StrategyHistoricalSwingRiskTraceEntry } from '@helix/contracts/strategy'
import type {
  SwingDailyMarketContextConfig,
  SwingDailyMarketContextDecision,
  SwingExecutionPolicyConfig,
  SwingExecutionStage,
  SwingLocationCandidate,
  SwingLocationConfig,
  SwingRiskPolicyConfig,
  SwingStageEvidence,
  SwingTradeThesis,
} from '@helix/contracts/swing'
import type { HistoricalDecisionContext, HistoricalSignalDecision } from './historical-runner'
import { average, trueRanges } from './market-structure'
import { classifySwingDailyMarketContext, scanSwingLocations } from './swing-context'
import { evaluateSwingExecution, evaluateSwingInvalidation, evaluateSwingRiskPolicy } from './swing-policies'
import {
  appendSwingEvidence,
  createSwingTradeThesis,
  transitionSwingTradeThesis,
} from './swing-state-machine'

const MINUTE_MS = 60_000
const FIFTEEN_MINUTES_MS = 15 * MINUTE_MS
const HOUR_MS = 60 * MINUTE_MS
const FOUR_HOURS_MS = 4 * HOUR_MS
const DAY_MS = 24 * HOUR_MS
const THESIS_TTL_MS = 14 * DAY_MS
const ENTRY_ELIGIBLE_SCORE = 55
const EXECUTION_STAGES: readonly SwingExecutionStage[] = ['EARLY', 'STANDARD', 'CONFIRMED']

export type SwingHistoricalEvaluatorConfig = {
  dailyContext: SwingDailyMarketContextConfig
  location: SwingLocationConfig
  execution: SwingExecutionPolicyConfig
  risk: SwingRiskPolicyConfig
}

type OpenSwingPosition = {
  thesis: SwingTradeThesis
  location: SwingLocationCandidate
  stage: SwingExecutionStage
  side: 'LONG' | 'SHORT'
  entryPrice: number
  stop: number
  target: number
  riskR: number
}

type SwingStructureBreak = {
  thesisId: string
  side: 'LONG' | 'SHORT'
  level: number
  occurredAt: number
}

export const SWING_HISTORICAL_CHECKPOINT_SCHEMA_VERSION = 'helix.swing-evaluator-checkpoint/v3' as const

export type SwingHistoricalEvaluatorCheckpoint = Readonly<{
  schemaVersion: typeof SWING_HISTORICAL_CHECKPOINT_SCHEMA_VERSION
  context: SwingDailyMarketContextDecision | null
  locations: readonly SwingLocationCandidate[]
  thesis: SwingTradeThesis | null
  thesisLocation: SwingLocationCandidate | null
  thesisContext: StrategyHistoricalSwingRiskTraceEntry['swing']['context'] | null
  structureBreak: SwingStructureBreak | null
  position: OpenSwingPosition | null
  lastDailyCandleTime: number
  lastLocationCandleTime: number
  lastEvidenceCandleTime: number
  attempts: number
  thesisRiskUsedR: number
  createdTheses: number
  enteredTrades: number
  exitedTrades: number
  missingExpectedMoveDecisions: number
  invalidatedBeforeFirstEntry: number
  expiredBeforeFirstEntry: number
  entriesByStage: Readonly<Record<SwingExecutionStage, number>>
  entryGateRejections: readonly Readonly<{ thesisId: string; reasonCodes: readonly string[] }>[]
  entryGateRejectionsByStage: readonly Readonly<{
    stage: SwingExecutionStage
    thesisId: string
    reasonCodes: readonly string[]
  }>[]
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

function bodyRatio(candle: Candle) {
  return Math.abs(candle.close - candle.open) / Math.max(candle.high - candle.low, Number.EPSILON)
}

function latestAtr(candles: readonly Candle[], period = 14) {
  if (candles.length < period + 1) return null
  return average(trueRanges(candles.slice(-(period + 1))).slice(-period))
}

function rejectionCounts(rejections: Map<string, Set<string>>) {
  const counts: Record<string, number> = {}
  for (const reasons of rejections.values()) {
    for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function stageRejectionMap() {
  return new Map<SwingExecutionStage, Map<string, Set<string>>>(
    EXECUTION_STAGES.map((stage) => [stage, new Map<string, Set<string>>()]),
  )
}

export function swingStageForEvidence(evidence: SwingStageEvidence): SwingExecutionStage {
  if (evidence.structureConfirmed && evidence.breakRetestConfirmed
    && evidence.displacement && evidence.followThrough) return 'CONFIRMED'
  if (evidence.structureConfirmed && evidence.displacement && evidence.followThrough) return 'STANDARD'
  return 'EARLY'
}

function locationThesisType(location: SwingLocationCandidate) {
  if (location.type.startsWith('RANGE_')) return 'RANGE_REVERSAL'
  if (location.type.startsWith('MEAN_REVERSION_')) return 'MEAN_REVERSION'
  return 'STRUCTURAL_REVERSAL'
}

export function selectSwingStructuralTarget(
  source: SwingLocationCandidate,
  locations: readonly SwingLocationCandidate[],
) {
  const targets = locations.flatMap((location) => {
    if (location.id === source.id) return []
    if (source.direction === 'LONG' && location.direction === 'SHORT'
      && location.boundaries.lower > source.boundaries.upper) {
      return [{ targetLocationId: location.id, target: location.boundaries.lower }]
    }
    if (source.direction === 'SHORT' && location.direction === 'LONG'
      && location.boundaries.upper < source.boundaries.lower) {
      return [{ targetLocationId: location.id, target: location.boundaries.upper }]
    }
    return []
  })
  targets.sort((left, right) => (
    source.direction === 'LONG' ? left.target - right.target : right.target - left.target
  ) || left.targetLocationId.localeCompare(right.targetLocationId))
  return targets[0] ?? null
}

export class SwingHistoricalEvaluator {
  private context?: SwingDailyMarketContextDecision
  private locations: SwingLocationCandidate[] = []
  private thesis?: SwingTradeThesis
  private thesisLocation?: SwingLocationCandidate
  private thesisContext?: StrategyHistoricalSwingRiskTraceEntry['swing']['context']
  private structureBreak?: SwingStructureBreak
  private position?: OpenSwingPosition
  private lastDailyCandleTime = -1
  private lastLocationCandleTime = -1
  private lastEvidenceCandleTime = -1
  private attempts = 0
  private thesisRiskUsedR = 0
  private createdTheses = 0
  private enteredTrades = 0
  private exitedTrades = 0
  private missingExpectedMoveDecisions = 0
  private invalidatedBeforeFirstEntry = 0
  private expiredBeforeFirstEntry = 0
  private readonly entriesByStage: Record<SwingExecutionStage, number> = {
    EARLY: 0,
    STANDARD: 0,
    CONFIRMED: 0,
  }
  private readonly entryGateRejections = new Map<string, Set<string>>()
  private readonly entryGateRejectionsByStage = stageRejectionMap()

  constructor(
    private readonly config: SwingHistoricalEvaluatorConfig,
    private readonly recordHistoricalRiskEntry?: (entry: StrategyHistoricalSwingRiskTraceEntry) => void,
    checkpoint?: SwingHistoricalEvaluatorCheckpoint,
  ) {
    if (!Number.isFinite(config.execution.stopBufferAtr) || config.execution.stopBufferAtr <= 0) {
      throw new Error('config.execution.stopBufferAtr must be positive')
    }
    if (checkpoint) this.restore(checkpoint)
  }

  checkpoint(): SwingHistoricalEvaluatorCheckpoint {
    return structuredClone({
      schemaVersion: SWING_HISTORICAL_CHECKPOINT_SCHEMA_VERSION,
      context: this.context ?? null,
      locations: this.locations,
      thesis: this.thesis ?? null,
      thesisLocation: this.thesisLocation ?? null,
      thesisContext: this.thesisContext ?? null,
      structureBreak: this.structureBreak ?? null,
      position: this.position ?? null,
      lastDailyCandleTime: this.lastDailyCandleTime,
      lastLocationCandleTime: this.lastLocationCandleTime,
      lastEvidenceCandleTime: this.lastEvidenceCandleTime,
      attempts: this.attempts,
      thesisRiskUsedR: this.thesisRiskUsedR,
      createdTheses: this.createdTheses,
      enteredTrades: this.enteredTrades,
      exitedTrades: this.exitedTrades,
      missingExpectedMoveDecisions: this.missingExpectedMoveDecisions,
      invalidatedBeforeFirstEntry: this.invalidatedBeforeFirstEntry,
      expiredBeforeFirstEntry: this.expiredBeforeFirstEntry,
      entriesByStage: this.entriesByStage,
      entryGateRejections: [...this.entryGateRejections.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([thesisId, reasonCodes]) => ({ thesisId, reasonCodes: [...reasonCodes].sort() })),
      entryGateRejectionsByStage: EXECUTION_STAGES.flatMap((stage) => (
        [...this.entryGateRejectionsByStage.get(stage)!.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([thesisId, reasonCodes]) => ({
            stage,
            thesisId,
            reasonCodes: [...reasonCodes].sort(),
          }))
      )),
    })
  }

  private restore(checkpoint: SwingHistoricalEvaluatorCheckpoint) {
    if (!checkpoint || checkpoint.schemaVersion !== SWING_HISTORICAL_CHECKPOINT_SCHEMA_VERSION) {
      throw new Error('unsupported Swing evaluator checkpoint')
    }
    if (!Array.isArray(checkpoint.locations)
      || !Array.isArray(checkpoint.entryGateRejections)
      || !Array.isArray(checkpoint.entryGateRejectionsByStage)) {
      throw new Error('Swing evaluator checkpoint arrays are invalid')
    }
    const entriesByStage = checkpoint.entriesByStage
    if (!entriesByStage || typeof entriesByStage !== 'object'
      || Object.keys(entriesByStage).sort().join(',') !== 'CONFIRMED,EARLY,STANDARD') {
      throw new Error('Swing evaluator checkpoint entriesByStage is invalid')
    }
    const rejections = new Map<string, Set<string>>()
    for (const entry of checkpoint.entryGateRejections) {
      if (!entry || typeof entry.thesisId !== 'string' || !entry.thesisId.trim()
        || !Array.isArray(entry.reasonCodes)
        || entry.reasonCodes.some((reason: string) => typeof reason !== 'string' || !reason.trim())) {
        throw new Error('Swing evaluator checkpoint rejection entry is invalid')
      }
      if (rejections.has(entry.thesisId)) throw new Error('Swing evaluator checkpoint has duplicate rejection entries')
      rejections.set(entry.thesisId, new Set(entry.reasonCodes))
    }
    const rejectionsByStage = stageRejectionMap()
    for (const entry of checkpoint.entryGateRejectionsByStage) {
      if (!entry || !EXECUTION_STAGES.includes(entry.stage)
        || typeof entry.thesisId !== 'string' || !entry.thesisId.trim()
        || !Array.isArray(entry.reasonCodes)
        || entry.reasonCodes.some((reason: string) => typeof reason !== 'string' || !reason.trim())) {
        throw new Error('Swing evaluator checkpoint stage rejection entry is invalid')
      }
      const stageEntries = rejectionsByStage.get(entry.stage)!
      if (stageEntries.has(entry.thesisId)) {
        throw new Error('Swing evaluator checkpoint has duplicate stage rejection entries')
      }
      stageEntries.set(entry.thesisId, new Set(entry.reasonCodes))
    }
    if (checkpoint.position && (!checkpoint.thesis || !checkpoint.thesisLocation || !checkpoint.thesisContext)) {
      throw new Error('Swing evaluator checkpoint position is missing its frozen Thesis state')
    }
    if (checkpoint.thesis && (!checkpoint.thesisLocation || !checkpoint.thesisContext)) {
      throw new Error('Swing evaluator checkpoint Thesis is missing its frozen Context')
    }
    if (checkpoint.structureBreak && (
      !checkpoint.thesis
      || checkpoint.structureBreak.thesisId !== checkpoint.thesis.id
      || (checkpoint.structureBreak.side !== 'LONG' && checkpoint.structureBreak.side !== 'SHORT')
      || !Number.isFinite(checkpoint.structureBreak.level) || checkpoint.structureBreak.level <= 0
      || !Number.isSafeInteger(checkpoint.structureBreak.occurredAt) || checkpoint.structureBreak.occurredAt < 0
    )) {
      throw new Error('Swing evaluator checkpoint structure break is invalid')
    }
    this.context = structuredClone(checkpoint.context ?? undefined)
    this.locations = structuredClone([...checkpoint.locations])
    this.thesis = structuredClone(checkpoint.thesis ?? undefined)
    this.thesisLocation = structuredClone(checkpoint.thesisLocation ?? undefined)
    this.thesisContext = structuredClone(checkpoint.thesisContext ?? undefined)
    this.structureBreak = structuredClone(checkpoint.structureBreak ?? undefined)
    this.position = structuredClone(checkpoint.position ?? undefined)
    this.lastDailyCandleTime = checkpointInteger(checkpoint.lastDailyCandleTime, 'lastDailyCandleTime', -1)
    this.lastLocationCandleTime = checkpointInteger(checkpoint.lastLocationCandleTime, 'lastLocationCandleTime', -1)
    this.lastEvidenceCandleTime = checkpointInteger(checkpoint.lastEvidenceCandleTime, 'lastEvidenceCandleTime', -1)
    this.attempts = checkpointInteger(checkpoint.attempts, 'attempts')
    this.thesisRiskUsedR = checkpointNumber(checkpoint.thesisRiskUsedR, 'thesisRiskUsedR')
    this.createdTheses = checkpointInteger(checkpoint.createdTheses, 'createdTheses')
    this.enteredTrades = checkpointInteger(checkpoint.enteredTrades, 'enteredTrades')
    this.exitedTrades = checkpointInteger(checkpoint.exitedTrades, 'exitedTrades')
    this.missingExpectedMoveDecisions = checkpointInteger(
      checkpoint.missingExpectedMoveDecisions,
      'missingExpectedMoveDecisions',
    )
    this.invalidatedBeforeFirstEntry = checkpointInteger(
      checkpoint.invalidatedBeforeFirstEntry,
      'invalidatedBeforeFirstEntry',
    )
    this.expiredBeforeFirstEntry = checkpointInteger(checkpoint.expiredBeforeFirstEntry, 'expiredBeforeFirstEntry')
    for (const stage of Object.keys(this.entriesByStage) as SwingExecutionStage[]) {
      this.entriesByStage[stage] = checkpointInteger(entriesByStage[stage], `entriesByStage.${stage}`)
    }
    this.entryGateRejections.clear()
    for (const [thesisId, reasons] of rejections) this.entryGateRejections.set(thesisId, reasons)
    for (const stage of EXECUTION_STAGES) {
      const destination = this.entryGateRejectionsByStage.get(stage)!
      destination.clear()
      for (const [thesisId, reasons] of rejectionsByStage.get(stage)!) {
        destination.set(thesisId, reasons)
      }
    }
  }

  statistics() {
    return {
      createdTheses: this.createdTheses,
      enteredTrades: this.enteredTrades,
      exitedTrades: this.exitedTrades,
      missingExpectedMoveDecisions: this.missingExpectedMoveDecisions,
      invalidatedBeforeFirstEntry: this.invalidatedBeforeFirstEntry,
      expiredBeforeFirstEntry: this.expiredBeforeFirstEntry,
      entriesByStage: { ...this.entriesByStage },
      entryGateRejectionsByReason: rejectionCounts(this.entryGateRejections),
      entryGateRejectionsByStageAndReason: Object.fromEntries(
        EXECUTION_STAGES.map((stage) => [
          stage,
          rejectionCounts(this.entryGateRejectionsByStage.get(stage)!),
        ]),
      ) as Record<SwingExecutionStage, Record<string, number>>,
    }
  }

  evaluate = (decision: HistoricalDecisionContext): readonly HistoricalSignalDecision[] => {
    if (decision.baseTimeframe !== '15m') throw new Error('Swing historical evaluator requires 15m baseTimeframe')
    const fifteenMinute = decision.candles['15m'] ?? []
    const hourly = decision.candles['1h'] ?? []
    const fourHourly = decision.candles['4h'] ?? []
    const daily = decision.candles['1d'] ?? []
    const current = latest(fifteenMinute)
    if (!current) return []

    const latestDaily = latest(daily)
    const dailyMinimum = Math.max(this.config.dailyContext.slowWindowBars + 1, this.config.dailyContext.emaPeriod + 1)
    if (latestDaily && latestDaily.time !== this.lastDailyCandleTime && daily.length >= dailyMinimum) {
      this.context = classifySwingDailyMarketContext(this.config.dailyContext, {
        id: `${decision.symbol}:1d:${latestDaily.time + DAY_MS}`,
        symbol: decision.symbol,
        candles: [...daily],
      })
      this.lastDailyCandleTime = latestDaily.time
    }

    const latestFourHour = latest(fourHourly)
    if (latestFourHour && latestFourHour.time !== this.lastLocationCandleTime) {
      const invalidation = this.evaluateInvalidation(decision, latestFourHour)
      this.lastLocationCandleTime = latestFourHour.time
      if (invalidation !== undefined) return invalidation ? [invalidation] : []

      const locationMinimum = Math.max(this.config.location.lookbackBars, this.config.location.atrPeriod + 1)
      if (this.context && fourHourly.length >= locationMinimum) {
        this.locations = scanSwingLocations(this.config.location, {
          symbol: decision.symbol,
          candles: [...fourHourly],
          context: this.context,
        }).locations
        if (!this.thesis || ['CLOSED', 'REJECTED', 'INVALIDATED', 'EXPIRED'].includes(this.thesis.state)) {
          this.createThesis(decision, fourHourly)
        }
      }
    }

    const positionExit = this.evaluatePosition(decision, fifteenMinute)
    if (positionExit) return [positionExit]

    if (this.thesis && ['CANDIDATE', 'ACTIVE', 'ENTRY_ELIGIBLE'].includes(this.thesis.state)
      && decision.decisionTime >= this.thesis.expiresAt) {
      if (this.attempts === 0) this.expiredBeforeFirstEntry += 1
      this.thesis = transitionSwingTradeThesis(this.thesis, {
        toState: 'EXPIRED', occurredAt: decision.decisionTime, reasonCodes: ['THESIS_EXPIRED'],
      }).thesis
      this.thesis = undefined
      this.thesisLocation = undefined
      this.thesisContext = undefined
      this.structureBreak = undefined
    }

    const latestHour = latest(hourly)
    if (this.thesis && latestHour && latestHour.time !== this.lastEvidenceCandleTime) {
      this.appendEvidence(decision, hourly)
      this.lastEvidenceCandleTime = latestHour.time
    }

    const entry = this.evaluateEntry(decision, fifteenMinute)
    return entry ? [entry] : []
  }

  private createThesis(decision: HistoricalDecisionContext, fourHourly: readonly Candle[]) {
    const location = this.locations[0]
    const atr = latestAtr(fourHourly, this.config.location.atrPeriod)
    if (!location || !this.context || !atr) return
    const expectedMove = selectSwingStructuralTarget(location, this.locations)
    if (!expectedMove) {
      this.missingExpectedMoveDecisions += 1
      return
    }
    const createdAt = decision.decisionTime
    const invalidationBuffer = atr * 0.2
    const thesis = createSwingTradeThesis({
      id: `${decision.symbol}:4h:THESIS:${createdAt}`,
      symbol: decision.symbol,
      type: locationThesisType(location),
      direction: location.direction,
      contextId: this.context.context.id,
      locationId: location.id,
      score: Math.min(54, Math.max(40, Math.round(location.score * 0.6))),
      invalidation: {
        policyId: 'thesis_invalidation_v1',
        type: location.direction === 'LONG' ? 'H4_CLOSE_BELOW_LEVEL' : 'H4_CLOSE_ABOVE_LEVEL',
        timeframe: '4h',
        level: location.direction === 'LONG'
          ? location.boundaries.lower - invalidationBuffer
          : location.boundaries.upper + invalidationBuffer,
      },
      expectedMove,
      createdAt,
      expiresAt: createdAt + THESIS_TTL_MS,
      reasonCodes: ['THESIS_CREATED', 'LOCATION_ALIGNED'],
    })
    this.thesis = transitionSwingTradeThesis(thesis, {
      toState: 'ACTIVE',
      occurredAt: createdAt,
      reasonCodes: ['THESIS_ACTIVATED'],
    }).thesis
    this.thesisLocation = location
    this.thesisContext = {
      id: this.context.context.id,
      state: this.context.state,
      bias: this.context.bias,
    }
    this.structureBreak = undefined
    this.attempts = 0
    this.thesisRiskUsedR = 0
    this.createdTheses += 1
  }

  private appendEvidence(decision: HistoricalDecisionContext, hourly: readonly Candle[]) {
    if (!this.thesis || (this.thesis.state !== 'ACTIVE' && this.thesis.state !== 'ENTRY_ELIGIBLE')
      || hourly.length < 2) return
    const candle = latest(hourly)!
    const previous = hourly.at(-2)!
    const bullish = candle.close > candle.open && candle.close > previous.close
    const bearish = candle.close < candle.open && candle.close < previous.close
    const supporting = this.thesis.direction === 'LONG' ? bullish : bearish
    const opposing = this.thesis.direction === 'LONG' ? bearish : bullish
    if (!supporting && !opposing) return
    const strength = bodyRatio(candle)
    const rawDelta = supporting ? (strength >= 0.55 ? 12 : 8) : (strength >= 0.55 ? -12 : -8)
    const scoreDelta = Math.max(-this.thesis.score, Math.min(100 - this.thesis.score, rawDelta))
    this.thesis = appendSwingEvidence(this.thesis, {
      id: `${this.thesis.id}:evidence:${decision.decisionTime}`,
      thesisId: this.thesis.id,
      type: supporting ? 'DIRECTIONAL_PROGRESS' : 'DIRECTIONAL_FAILURE',
      time: decision.decisionTime,
      direction: supporting ? this.thesis.direction : (this.thesis.direction === 'LONG' ? 'SHORT' : 'LONG'),
      effect: supporting ? 'SUPPORTING' : 'OPPOSING',
      scoreDelta,
      reasonCodes: [supporting ? 'EVIDENCE_STRENGTHENED' : 'NEGATIVE_EVIDENCE_ACCUMULATING'],
      featureSnapshot: {
        body_ratio: strength,
        close_progress: candle.close - previous.close,
      },
    })
    if (this.thesis.state === 'ACTIVE' && this.thesis.score >= ENTRY_ELIGIBLE_SCORE) {
      this.thesis = transitionSwingTradeThesis(this.thesis, {
        toState: 'ENTRY_ELIGIBLE',
        occurredAt: decision.decisionTime,
        reasonCodes: ['ENTRY_ELIGIBLE'],
      }).thesis
    }
  }

  private evaluateEntry(
    decision: HistoricalDecisionContext,
    fifteenMinute: readonly Candle[],
  ): HistoricalSignalDecision | null {
    if (!this.thesis || this.position || fifteenMinute.length < 15) return null
    if (this.thesis.state !== 'ENTRY_ELIGIBLE' || this.thesis.score < ENTRY_ELIGIBLE_SCORE) return null
    if (!this.thesisLocation) {
      this.recordEntryGateRejection(this.thesis.id, ['LOCATION_MISSING'])
      return null
    }
    const candle = latest(fifteenMinute)!
    const previous = fifteenMinute.at(-2)!
    const atr = latestAtr(fifteenMinute)
    if (!atr) return null
    const side = this.thesis.direction
    const location = this.thesisLocation
    const locationAligned = candle.low <= location.boundaries.upper + atr * 0.5
      && candle.high >= location.boundaries.lower - atr * 0.5
    const displacement = bodyRatio(candle) >= 0.5
      && (side === 'LONG' ? candle.close > candle.open : candle.close < candle.open)
    const rejection = side === 'LONG'
      ? candle.close > candle.open && candle.low <= location.boundaries.upper
      : candle.close < candle.open && candle.high >= location.boundaries.lower
    const structureConfirmedNow = side === 'LONG' ? candle.close > previous.high : candle.close < previous.low
    const priorBreak = this.structureBreak?.thesisId === this.thesis.id
      && this.structureBreak.side === side
      ? this.structureBreak
      : undefined
    const breakRetestConfirmed = Boolean(priorBreak)
      && decision.decisionTime > priorBreak!.occurredAt
      && (side === 'LONG'
        ? candle.low <= priorBreak!.level && candle.close > priorBreak!.level
        : candle.high >= priorBreak!.level && candle.close < priorBreak!.level)
    const structureConfirmed = structureConfirmedNow || Boolean(priorBreak)
    const followThrough = side === 'LONG' ? candle.close > previous.close : candle.close < previous.close
    const evidence: SwingStageEvidence = {
      locationAligned,
      supportingEvidence: this.thesis.evidence.at(-1)?.effect === 'SUPPORTING',
      rejection,
      displacement,
      structureConfirmed,
      breakRetestConfirmed,
      followThrough,
    }
    if (priorBreak && decision.decisionTime > priorBreak.occurredAt
      && (side === 'LONG' ? candle.close <= priorBreak.level : candle.close >= priorBreak.level)) {
      this.structureBreak = undefined
    }
    if (structureConfirmedNow) {
      this.structureBreak = {
        thesisId: this.thesis.id,
        side,
        level: side === 'LONG' ? previous.high : previous.low,
        occurredAt: decision.decisionTime,
      }
    }
    const stage = swingStageForEvidence(evidence)
    const entryPrice = candle.close
    const stop = side === 'LONG'
      ? Math.min(location.boundaries.lower, candle.low) - atr * this.config.execution.stopBufferAtr
      : Math.max(location.boundaries.upper, candle.high) + atr * this.config.execution.stopBufferAtr
    const riskDistance = Math.abs(entryPrice - stop)
    if (riskDistance <= 0) return null
    const target = this.thesis.expectedMove.target
    const availableReward = side === 'LONG' ? target - entryPrice : entryPrice - target
    const rr = Math.max(0, availableReward) / riskDistance
    const center = (location.boundaries.lower + location.boundaries.upper) / 2
    const execution = evaluateSwingExecution(this.config.execution, this.thesis, {
      stage,
      attemptCount: this.attempts,
      rr,
      entryExtended: Math.abs(entryPrice - center) > atr * 2,
      evidence,
    })
    if (!execution.triggered) {
      this.recordEntryGateRejection(this.thesis.id, execution.reasonCodes, stage)
      return null
    }
    const risk = evaluateSwingRiskPolicy(this.config.risk, {
      stage,
      currentThesisRiskR: this.thesisRiskUsedR,
      availablePortfolioRiskR: Math.max(0, this.config.risk.thesisRiskBudgetR - this.thesisRiskUsedR),
      priceRiskRatio: riskDistance / entryPrice,
    })
    if (!risk.allowed) {
      this.recordEntryGateRejection(this.thesis.id, risk.reasonCodes, stage)
      return null
    }
    const triggered = transitionSwingTradeThesis(this.thesis, {
      toState: 'TRIGGERED',
      occurredAt: decision.decisionTime,
      reasonCodes: ['EXECUTION_TRIGGERED'],
      featureSnapshot: execution.featureSnapshot,
    }).thesis
    const attempt = this.attempts + 1
    const signalId = `${triggered.id}:entry:${attempt}:${decision.decisionTime}`
    if (this.recordHistoricalRiskEntry) {
      if (!this.thesisContext || this.thesisContext.id !== triggered.contextId) {
        throw new Error(`Swing Thesis ${triggered.id} is missing its frozen creation-time Context`)
      }
      this.recordHistoricalRiskEntry({
        entrySignalId: signalId,
        family: 'swing',
        object: { model: 'TRADE_THESIS', id: triggered.id },
        side,
        entryPrice: { source: 'DECISION_CANDLE_CLOSE', price: entryPrice },
        initialStop: stop,
        initialTarget: target,
        riskDistance,
        riskR: risk.requestedRiskR,
        swing: {
          stage,
          context: { ...this.thesisContext },
        },
      })
    }
    this.thesis = triggered
    this.attempts = attempt
    this.thesisRiskUsedR += risk.requestedRiskR
    this.position = {
      thesis: this.thesis,
      location,
      stage,
      side,
      entryPrice,
      stop,
      target,
      riskR: risk.requestedRiskR,
    }
    this.enteredTrades += 1
    this.entriesByStage[stage] += 1
    return {
      signalId,
      decisionId: `${this.thesis.id}:decision:entry:${this.attempts}:${decision.decisionTime}`,
      object: { model: 'TRADE_THESIS', id: this.thesis.id },
      action: 'ENTER', side, reasonCodes: ['EXECUTION_TRIGGERED'],
    }
  }

  private evaluatePosition(
    decision: HistoricalDecisionContext,
    fifteenMinute: readonly Candle[],
  ): HistoricalSignalDecision | null {
    const position = this.position
    const candle = latest(fifteenMinute)
    if (!position || !this.thesis || !candle) return null
    const stopped = position.side === 'LONG' ? candle.low <= position.stop : candle.high >= position.stop
    const targeted = position.side === 'LONG' ? candle.high >= position.target : candle.low <= position.target
    if (!stopped && !targeted) return null
    const reasonCode = stopped ? 'STOP_HIT' : 'TARGET_HIT'
    const retryable = stopped && this.attempts < this.config.execution.maxAttemptsPerThesis
      && decision.decisionTime < this.thesis.expiresAt
      && this.thesisRiskUsedR < this.config.risk.thesisRiskBudgetR
    if (retryable) {
      this.thesis = transitionSwingTradeThesis(this.thesis, {
        toState: 'ACTIVE', occurredAt: decision.decisionTime, reasonCodes: ['STOP_HIT'],
      }).thesis
    } else {
      this.thesis = transitionSwingTradeThesis(this.thesis, {
        toState: 'CLOSED', occurredAt: decision.decisionTime, reasonCodes: ['THESIS_CLOSED'],
      }).thesis
      this.thesisLocation = undefined
      this.thesisContext = undefined
      this.structureBreak = undefined
    }
    const thesisId = position.thesis.id
    this.position = undefined
    this.exitedTrades += 1
    return {
      signalId: `${thesisId}:exit:${this.attempts}:${decision.decisionTime}`,
      decisionId: `${thesisId}:decision:exit:${this.attempts}:${decision.decisionTime}`,
      object: { model: 'TRADE_THESIS', id: thesisId },
      action: 'EXIT', side: position.side, reasonCodes: [reasonCode],
    }
  }

  private evaluateInvalidation(
    decision: HistoricalDecisionContext,
    candle: Candle,
  ): HistoricalSignalDecision | null | undefined {
    if (!this.thesis || !['ACTIVE', 'ENTRY_ELIGIBLE', 'TRIGGERED'].includes(this.thesis.state)) return undefined
    const result = evaluateSwingInvalidation(this.thesis, {
      timeframe: '4h',
      time: candle.time + FOUR_HOURS_MS,
      close: candle.close,
      closed: true,
    })
    if (!result.invalidated) return undefined
    const thesisId = this.thesis.id
    const position = this.position
    if (this.attempts === 0) this.invalidatedBeforeFirstEntry += 1
    this.thesis = transitionSwingTradeThesis(this.thesis, {
      toState: 'INVALIDATED',
      occurredAt: decision.decisionTime,
      reasonCodes: ['THESIS_INVALIDATED'],
    }).thesis
    this.position = undefined
    this.thesisLocation = undefined
    this.thesisContext = undefined
    this.structureBreak = undefined
    if (!position) return null
    this.exitedTrades += 1
    return {
      signalId: `${thesisId}:exit:invalidation:${decision.decisionTime}`,
      decisionId: `${thesisId}:decision:exit:invalidation:${decision.decisionTime}`,
      object: { model: 'TRADE_THESIS', id: thesisId },
      action: 'EXIT', side: position.side, reasonCodes: ['THESIS_INVALIDATED'],
    }
  }

  private recordEntryGateRejection(
    thesisId: string,
    reasons: readonly string[],
    stage?: SwingExecutionStage,
  ) {
    const recorded = this.entryGateRejections.get(thesisId) ?? new Set<string>()
    for (const reason of reasons) recorded.add(reason)
    this.entryGateRejections.set(thesisId, recorded)
    if (stage) {
      const stageEntries = this.entryGateRejectionsByStage.get(stage)!
      const staged = stageEntries.get(thesisId) ?? new Set<string>()
      for (const reason of reasons) staged.add(reason)
      stageEntries.set(thesisId, staged)
    }
  }
}

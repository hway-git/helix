import {
  SCALP_EVENT_STATES,
  SCALP_RESPONSE_STATES,
  type ScalpEventTransition,
  type ScalpFeatureSnapshot,
  type ScalpPriceEvent,
  type ScalpPriceEventState,
  type ScalpResponse,
  type ScalpResponseState,
  type ScalpResponseTransition,
} from '@helix/contracts/scalp'

const EVENT_TRANSITIONS: Record<ScalpPriceEventState, ReadonlySet<ScalpPriceEventState>> = {
  DETECTED: new Set(['ARMED', 'FAILED', 'EXPIRED']),
  ARMED: new Set(['TRIGGERED', 'FAILED', 'EXPIRED']),
  TRIGGERED: new Set(['CLOSED']),
  FAILED: new Set(),
  EXPIRED: new Set(),
  CLOSED: new Set(),
}

const RESPONSE_TRANSITIONS: Record<ScalpResponseState, ReadonlySet<ScalpResponseState>> = {
  EXPECTED_RESPONSE_WINDOW: new Set(['RESPONSE_OK', 'TRADE_NOT_WORKING']),
  RESPONSE_OK: new Set(),
  TRADE_NOT_WORKING: new Set(),
}

const DETECTOR_EVENT_TYPES: Record<ScalpPriceEvent['detectorId'], ScalpPriceEvent['type']> = {
  liquidity_sweep_v1: 'LIQUIDITY_SWEEP',
  breakout_failure_v1: 'BREAKOUT_FAILURE',
  momentum_burst_v1: 'MOMENTUM_BURST',
}

export function isScalpEventTransitionAllowed(fromState: ScalpPriceEventState, toState: ScalpPriceEventState) {
  return EVENT_TRANSITIONS[fromState].has(toState)
}

export function isScalpResponseTransitionAllowed(fromState: ScalpResponseState, toState: ScalpResponseState) {
  return RESPONSE_TRANSITIONS[fromState].has(toState)
}

type NewScalpPriceEvent = Omit<ScalpPriceEvent, 'state' | 'updatedAt'>

type EventTransitionInput = {
  toState: ScalpPriceEventState
  occurredAt: number
  reasonCodes: string[]
  featureSnapshot?: ScalpFeatureSnapshot
}

type ResponseTransitionInput = {
  toState: Exclude<ScalpResponseState, 'EXPECTED_RESPONSE_WINDOW'>
  occurredAt: number
  reasonCodes: string[]
  featureSnapshot?: ScalpFeatureSnapshot
}

function nonEmptyText(value: string, field: string) {
  if (!value.trim()) throw new Error(`${field} is required`)
}

function timestamp(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer timestamp`)
}

function score(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${field} must be between 0 and 100`)
}

function normalizeReasonCodes(reasonCodes: string[]) {
  if (reasonCodes.length === 0) throw new Error('reasonCodes must not be empty')
  return reasonCodes.map((reasonCode) => {
    const normalized = reasonCode.trim()
    if (!/^[A-Z][A-Z0-9_]*$/.test(normalized)) {
      throw new Error(`invalid reason code ${reasonCode}`)
    }
    return normalized
  })
}

function normalizeFeatureSnapshot(snapshot: ScalpFeatureSnapshot = {}) {
  const normalized: Record<string, number | string | boolean | null> = {}
  for (const [key, value] of Object.entries(snapshot)) {
    if (!key.trim()) throw new Error('feature snapshot keys must not be empty')
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`feature ${key} must be finite`)
    }
    normalized[key] = value
  }
  return normalized
}

export function assertScalpPriceEvent(event: ScalpPriceEvent) {
  nonEmptyText(event.id, 'event.id')
  nonEmptyText(event.symbol, 'event.symbol')
  nonEmptyText(event.regimeId, 'event.regimeId')
  nonEmptyText(event.zoneId, 'event.zoneId')
  if (!SCALP_EVENT_STATES.includes(event.state)) throw new Error(`invalid event state ${event.state}`)
  if (DETECTOR_EVENT_TYPES[event.detectorId] !== event.type) {
    throw new Error(`detector ${event.detectorId} cannot create ${event.type}`)
  }
  score(event.score, 'event.score')
  timestamp(event.detectedAt, 'event.detectedAt')
  timestamp(event.expiresAt, 'event.expiresAt')
  timestamp(event.updatedAt, 'event.updatedAt')
  if (event.expiresAt <= event.detectedAt) throw new Error('event.expiresAt must be after event.detectedAt')
  if (event.updatedAt < event.detectedAt) throw new Error('event.updatedAt cannot precede event.detectedAt')
  if ((event.state === 'DETECTED' || event.state === 'ARMED' || event.state === 'TRIGGERED')
    && event.updatedAt >= event.expiresAt) {
    throw new Error(`event state ${event.state} cannot begin after TTL`)
  }
  if (event.state === 'EXPIRED' && event.updatedAt < event.expiresAt) {
    throw new Error('event cannot be EXPIRED before TTL')
  }
  normalizeReasonCodes(event.reasonCodes)
}

export function createScalpPriceEvent(input: NewScalpPriceEvent): ScalpPriceEvent {
  const event: ScalpPriceEvent = {
    ...input,
    state: 'DETECTED',
    updatedAt: input.detectedAt,
    reasonCodes: normalizeReasonCodes(input.reasonCodes),
  }
  assertScalpPriceEvent(event)
  return event
}

export function transitionScalpPriceEvent(
  event: ScalpPriceEvent,
  input: EventTransitionInput,
): { event: ScalpPriceEvent; transition: ScalpEventTransition } {
  assertScalpPriceEvent(event)
  timestamp(input.occurredAt, 'transition.occurredAt')
  if (input.occurredAt < event.updatedAt) throw new Error('event time cannot move backwards')

  const allowed = EVENT_TRANSITIONS[event.state]
  if (!isScalpEventTransitionAllowed(event.state, input.toState)) {
    if (allowed.size === 0) throw new Error(`event state ${event.state} is terminal`)
    throw new Error(`illegal event transition ${event.state} -> ${input.toState}`)
  }

  if ((event.state === 'DETECTED' || event.state === 'ARMED') && input.occurredAt >= event.expiresAt) {
    if (input.toState !== 'EXPIRED') throw new Error('event TTL elapsed; only EXPIRED is allowed')
  }
  if (input.toState === 'EXPIRED' && input.occurredAt < event.expiresAt) {
    throw new Error('event cannot expire before its TTL')
  }

  const reasonCodes = normalizeReasonCodes(input.reasonCodes)
  const featureSnapshot = normalizeFeatureSnapshot(input.featureSnapshot)
  const next: ScalpPriceEvent = {
    ...event,
    state: input.toState,
    updatedAt: input.occurredAt,
    reasonCodes,
  }

  return {
    event: next,
    transition: {
      eventId: event.id,
      fromState: event.state,
      toState: input.toState,
      occurredAt: input.occurredAt,
      reasonCodes,
      featureSnapshot,
    },
  }
}

export function createScalpResponse(
  event: ScalpPriceEvent,
  input: { windowEndsAt: number; reasonCodes: string[] },
): ScalpResponse {
  assertScalpPriceEvent(event)
  if (event.state !== 'TRIGGERED') throw new Error('response window requires a TRIGGERED event')
  timestamp(input.windowEndsAt, 'response.windowEndsAt')
  if (input.windowEndsAt <= event.updatedAt) throw new Error('response window must end after the trigger')

  return {
    eventId: event.id,
    state: 'EXPECTED_RESPONSE_WINDOW',
    windowStartedAt: event.updatedAt,
    windowEndsAt: input.windowEndsAt,
    updatedAt: event.updatedAt,
    reasonCodes: normalizeReasonCodes(input.reasonCodes),
  }
}

export function assertScalpResponse(response: ScalpResponse) {
  nonEmptyText(response.eventId, 'response.eventId')
  if (!SCALP_RESPONSE_STATES.includes(response.state)) throw new Error(`invalid response state ${response.state}`)
  timestamp(response.windowStartedAt, 'response.windowStartedAt')
  timestamp(response.windowEndsAt, 'response.windowEndsAt')
  timestamp(response.updatedAt, 'response.updatedAt')
  if (response.windowEndsAt <= response.windowStartedAt) throw new Error('response window must have positive duration')
  if (response.updatedAt < response.windowStartedAt) throw new Error('response.updatedAt cannot precede its window')
  if (response.state === 'EXPECTED_RESPONSE_WINDOW' && response.updatedAt !== response.windowStartedAt) {
    throw new Error('open response window cannot change its start time')
  }
  if (response.state === 'RESPONSE_OK' && response.updatedAt > response.windowEndsAt) {
    throw new Error('RESPONSE_OK must occur inside the expected response window')
  }
  normalizeReasonCodes(response.reasonCodes)
}

export function transitionScalpResponse(
  response: ScalpResponse,
  input: ResponseTransitionInput,
): { response: ScalpResponse; transition: ScalpResponseTransition } {
  assertScalpResponse(response)
  timestamp(input.occurredAt, 'transition.occurredAt')
  if (input.occurredAt < response.updatedAt) throw new Error('response time cannot move backwards')

  const allowed = RESPONSE_TRANSITIONS[response.state]
  if (!isScalpResponseTransitionAllowed(response.state, input.toState)) {
    if (allowed.size === 0) throw new Error(`response state ${response.state} is terminal`)
    throw new Error(`illegal response transition ${response.state} -> ${input.toState}`)
  }
  if (input.toState === 'RESPONSE_OK' && input.occurredAt > response.windowEndsAt) {
    throw new Error('RESPONSE_OK must occur inside the expected response window')
  }

  const reasonCodes = normalizeReasonCodes(input.reasonCodes)
  const featureSnapshot = normalizeFeatureSnapshot(input.featureSnapshot)
  const next: ScalpResponse = {
    ...response,
    state: input.toState,
    updatedAt: input.occurredAt,
    reasonCodes,
  }

  return {
    response: next,
    transition: {
      eventId: response.eventId,
      fromState: response.state,
      toState: input.toState,
      occurredAt: input.occurredAt,
      reasonCodes,
      featureSnapshot,
    },
  }
}

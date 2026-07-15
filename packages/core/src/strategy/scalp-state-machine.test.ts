import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createScalpPriceEvent,
  createScalpResponse,
  transitionScalpPriceEvent,
  transitionScalpResponse,
} from './scalp-state-machine'

function detectedEvent() {
  return createScalpPriceEvent({
    id: 'BTC-5M-EVENT-001',
    symbol: 'BTC-USDT-SWAP',
    regimeId: 'BTC-1H-REGIME-001',
    zoneId: 'BTC-15M-ZONE-001',
    detectorId: 'liquidity_sweep_v1',
    type: 'LIQUIDITY_SWEEP',
    direction: 'LONG',
    score: 82,
    detectedAt: 1_000,
    expiresAt: 2_000,
    reasonCodes: ['LIQUIDITY_SWEEP_DETECTED'],
  })
}

test('moves a Scalp Event through the canonical lifecycle without mutating prior states', () => {
  const detected = detectedEvent()
  const armed = transitionScalpPriceEvent(detected, {
    toState: 'ARMED',
    occurredAt: 1_200,
    reasonCodes: ['EVENT_ARMED'],
    featureSnapshot: { reclaim_bars: 1, wick_ratio: 0.62 },
  }).event
  const triggered = transitionScalpPriceEvent(armed, {
    toState: 'TRIGGERED',
    occurredAt: 1_999,
    reasonCodes: ['EXECUTION_TRIGGERED'],
  }).event
  const closed = transitionScalpPriceEvent(triggered, {
    toState: 'CLOSED',
    occurredAt: 2_400,
    reasonCodes: ['TARGET_HIT'],
  }).event

  assert.equal(detected.state, 'DETECTED')
  assert.equal(armed.state, 'ARMED')
  assert.equal(triggered.state, 'TRIGGERED')
  assert.equal(closed.state, 'CLOSED')
})

test('rejects illegal transitions and never revives terminal Events', () => {
  const detected = detectedEvent()
  assert.throws(
    () => transitionScalpPriceEvent(detected, {
      toState: 'CLOSED',
      occurredAt: 1_100,
      reasonCodes: ['INVALID_CLOSE'],
    }),
    /illegal event transition DETECTED -> CLOSED/,
  )

  const failed = transitionScalpPriceEvent(detected, {
    toState: 'FAILED',
    occurredAt: 1_100,
    reasonCodes: ['FOLLOW_THROUGH_TOO_STRONG'],
  }).event
  assert.throws(
    () => transitionScalpPriceEvent(failed, {
      toState: 'ARMED',
      occurredAt: 1_200,
      reasonCodes: ['EVENT_ARMED'],
    }),
    /event state FAILED is terminal/,
  )
})

test('enforces TTL and monotonic event time', () => {
  const detected = detectedEvent()
  const armed = transitionScalpPriceEvent(detected, {
    toState: 'ARMED',
    occurredAt: 1_200,
    reasonCodes: ['EVENT_ARMED'],
  }).event

  assert.throws(
    () => transitionScalpPriceEvent(armed, {
      toState: 'TRIGGERED',
      occurredAt: 2_000,
      reasonCodes: ['EXECUTION_TRIGGERED'],
    }),
    /event TTL elapsed/,
  )
  assert.throws(
    () => transitionScalpPriceEvent(armed, {
      toState: 'EXPIRED',
      occurredAt: 1_999,
      reasonCodes: ['EVENT_TTL_EXPIRED'],
    }),
    /cannot expire before its TTL/,
  )
  assert.throws(
    () => transitionScalpPriceEvent(armed, {
      toState: 'FAILED',
      occurredAt: 1_199,
      reasonCodes: ['BREAKOUT_ACCEPTED'],
    }),
    /event time cannot move backwards/,
  )

  const expired = transitionScalpPriceEvent(armed, {
    toState: 'EXPIRED',
    occurredAt: 2_000,
    reasonCodes: ['EVENT_TTL_EXPIRED'],
  }).event
  assert.equal(expired.state, 'EXPIRED')
})

test('response state exists only after trigger and cannot report a late RESPONSE_OK', () => {
  assert.throws(
    () => createScalpResponse(detectedEvent(), {
      windowEndsAt: 2_500,
      reasonCodes: ['EXPECTED_RESPONSE_STARTED'],
    }),
    /requires a TRIGGERED event/,
  )

  const armed = transitionScalpPriceEvent(detectedEvent(), {
    toState: 'ARMED',
    occurredAt: 1_200,
    reasonCodes: ['EVENT_ARMED'],
  }).event
  const triggered = transitionScalpPriceEvent(armed, {
    toState: 'TRIGGERED',
    occurredAt: 1_500,
    reasonCodes: ['EXECUTION_TRIGGERED'],
  }).event
  const response = createScalpResponse(triggered, {
    windowEndsAt: 2_500,
    reasonCodes: ['EXPECTED_RESPONSE_STARTED'],
  })

  assert.throws(
    () => transitionScalpResponse(response, {
      toState: 'RESPONSE_OK',
      occurredAt: 2_501,
      reasonCodes: ['EXPECTED_RESPONSE_CONFIRMED'],
    }),
    /must occur inside the expected response window/,
  )

  const notWorking = transitionScalpResponse(response, {
    toState: 'TRADE_NOT_WORKING',
    occurredAt: 2_500,
    reasonCodes: ['RESPONSE_WINDOW_MISSED'],
  }).response
  assert.throws(
    () => transitionScalpResponse(notWorking, {
      toState: 'RESPONSE_OK',
      occurredAt: 2_600,
      reasonCodes: ['EXPECTED_RESPONSE_CONFIRMED'],
    }),
    /response state TRADE_NOT_WORKING is terminal/,
  )
})

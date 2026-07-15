import assert from 'node:assert/strict'
import test from 'node:test'
import {
  detectBreakoutFailure,
  detectLiquiditySweep,
  detectMomentumBurst,
  evaluateScalpExecution,
} from './scalp-detectors'
import { createScalpPriceEvent, transitionScalpPriceEvent } from './scalp-state-machine'

test('detects Liquidity Sweep only when every configured gate passes', () => {
  const config = {
    minZoneScore: 65,
    maxReclaimBars: 2,
    minWickRatio: 0.5,
    maxFollowThroughAtr: 0.15,
  }
  assert.deepEqual(
    detectLiquiditySweep(config, {
      zoneState: 'ACTIVE',
      zoneScore: 80,
      levelBreached: true,
      reclaimed: true,
      reclaimBars: 2,
      wickRatio: 0.6,
      followThroughAtr: 0.1,
    }).reasonCodes,
    ['LIQUIDITY_SWEEP_DETECTED'],
  )

  const rejected = detectLiquiditySweep(config, {
    zoneState: 'WEAKENED',
    zoneScore: 60,
    levelBreached: true,
    reclaimed: false,
    reclaimBars: 3,
    wickRatio: 0.4,
    followThroughAtr: 0.2,
  })
  assert.equal(rejected.detected, false)
  assert.deepEqual(rejected.reasonCodes, [
    'ZONE_CONSUMED',
    'ZONE_SCORE_TOO_LOW',
    'RECLAIM_MISSING',
    'RECLAIM_TOO_SLOW',
    'WICK_RATIO_TOO_LOW',
    'FOLLOW_THROUGH_TOO_STRONG',
  ])
})

test('distinguishes Breakout Failure from accepted continuation', () => {
  const config = { minZoneScore: 65, maxReturnBars: 3, maxFollowThroughAtr: 0.2 }
  const detected = detectBreakoutFailure(config, {
    zoneState: 'ACTIVE',
    zoneScore: 75,
    boundaryBroken: true,
    returnedInside: true,
    returnBars: 2,
    followThroughAtr: 0.1,
  })
  assert.equal(detected.detected, true)
  assert.deepEqual(detected.reasonCodes, ['BREAKOUT_FAILURE_DETECTED'])

  const accepted = detectBreakoutFailure(config, {
    zoneState: 'ACTIVE',
    zoneScore: 75,
    boundaryBroken: true,
    returnedInside: false,
    returnBars: 4,
    followThroughAtr: 0.4,
  })
  assert.deepEqual(accepted.reasonCodes, ['RETURN_INSIDE_MISSING', 'RETURN_TOO_SLOW', 'BREAKOUT_ACCEPTED'])
})

test('detects Momentum Burst without allowing weak expansion or chase risk', () => {
  const config = {
    minZoneScore: 65,
    minBodyRatio: 0.7,
    minCandleRangeAtr: 1.3,
    maxDistanceFromMeanAtr: 2,
  }
  const detected = detectMomentumBurst(config, {
    zoneState: 'ACTIVE',
    zoneScore: 70,
    compressionConfirmed: true,
    breakoutConfirmed: true,
    bodyRatio: 0.75,
    candleRangeAtr: 1.5,
    distanceFromMeanAtr: 1.5,
  })
  assert.deepEqual(detected.reasonCodes, ['MOMENTUM_BURST_DETECTED'])

  const rejected = detectMomentumBurst(config, {
    zoneState: 'ACTIVE',
    zoneScore: 70,
    compressionConfirmed: true,
    breakoutConfirmed: true,
    bodyRatio: 0.6,
    candleRangeAtr: 1.1,
    distanceFromMeanAtr: 2.1,
  })
  assert.deepEqual(rejected.reasonCodes, ['NO_EXPANSION', 'CHASE_RISK'])
})

test('Scalp execution requires an armed in-TTL Event, micro structure, displacement, and RR', () => {
  const detected = createScalpPriceEvent({
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
  const armed = transitionScalpPriceEvent(detected, {
    toState: 'ARMED',
    occurredAt: 1_200,
    reasonCodes: ['EVENT_ARMED'],
  }).event

  assert.deepEqual(
    evaluateScalpExecution({ minRr: 1.5 }, armed, {
      evaluatedAt: 1_999,
      microStructureBreak: true,
      displacement: true,
      rr: 1.5,
    }).reasonCodes,
    ['EXECUTION_TRIGGERED'],
  )
  assert.deepEqual(
    evaluateScalpExecution({ minRr: 1.5 }, armed, {
      evaluatedAt: 2_000,
      microStructureBreak: false,
      displacement: false,
      rr: 1.4,
    }).reasonCodes,
    ['EXECUTION_TRIGGER_MISSING', 'EVENT_TTL_EXPIRED', 'RR_TOO_LOW'],
  )
})

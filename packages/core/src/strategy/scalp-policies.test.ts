import assert from 'node:assert/strict'
import test from 'node:test'
import type { ScalpRiskPolicyConfig, ScalpTimePolicyConfig } from '@helix/contracts/scalp'
import { evaluateScalpRiskPolicy, evaluateScalpTimePolicy } from './scalp-policies'

const riskConfig: ScalpRiskPolicyConfig = {
  dailyLossLimitR: 1,
  maxConsecutiveLosses: 3,
  riskByGradeR: { A_PLUS: 0.35, A: 0.25, B: 0.15 },
}

const timeConfig: ScalpTimePolicyConfig = {
  maxHoldingMs: {
    LIQUIDITY_SWEEP: 45 * 60_000,
    BREAKOUT_FAILURE: 45 * 60_000,
    MOMENTUM_BURST: 20 * 60_000,
  },
  responseWindowMs: {
    LIQUIDITY_SWEEP: 15 * 60_000,
    BREAKOUT_FAILURE: 15 * 60_000,
    MOMENTUM_BURST: 5 * 60_000,
  },
}

test('Scalp risk policy uses only explicit configuration and locks at exact limits', () => {
  assert.deepEqual(
    evaluateScalpRiskPolicy(riskConfig, { grade: 'A', dailyLossUsedR: 0.5, consecutiveLosses: 1 }),
    { allowed: true, riskR: 0.25, reasonCodes: [] },
  )
  assert.deepEqual(
    evaluateScalpRiskPolicy(riskConfig, { grade: 'A_PLUS', dailyLossUsedR: 1, consecutiveLosses: 3 }),
    {
      allowed: false,
      riskR: 0,
      reasonCodes: ['DAILY_SCALP_LOSS_LIMIT', 'MAX_CONSECUTIVE_LOSSES'],
    },
  )
})

test('Scalp time policy exits on response failure and max holding time', () => {
  const triggeredAt = 1_000
  assert.deepEqual(
    evaluateScalpTimePolicy(timeConfig, {
      eventType: 'LIQUIDITY_SWEEP',
      triggeredAt,
      evaluatedAt: triggeredAt + 10 * 60_000,
      responseState: 'EXPECTED_RESPONSE_WINDOW',
    }),
    { action: 'HOLD', elapsedMs: 10 * 60_000, reasonCodes: [] },
  )
  assert.deepEqual(
    evaluateScalpTimePolicy(timeConfig, {
      eventType: 'LIQUIDITY_SWEEP',
      triggeredAt,
      evaluatedAt: triggeredAt + 15 * 60_000,
      responseState: 'EXPECTED_RESPONSE_WINDOW',
    }),
    { action: 'EXIT', elapsedMs: 15 * 60_000, reasonCodes: ['RESPONSE_WINDOW_MISSED'] },
  )
  assert.deepEqual(
    evaluateScalpTimePolicy(timeConfig, {
      eventType: 'LIQUIDITY_SWEEP',
      triggeredAt,
      evaluatedAt: triggeredAt + 45 * 60_000,
      responseState: 'RESPONSE_OK',
    }),
    { action: 'EXIT', elapsedMs: 45 * 60_000, reasonCodes: ['TIME_STOP'] },
  )
})

test('Scalp policies reject incomplete or incoherent configuration instead of using defaults', () => {
  assert.throws(
    () => evaluateScalpRiskPolicy({ ...riskConfig, dailyLossLimitR: 0 }, {
      grade: 'B',
      dailyLossUsedR: 0,
      consecutiveLosses: 0,
    }),
    /config.dailyLossLimitR must be positive/,
  )
  assert.throws(
    () => evaluateScalpTimePolicy({
      ...timeConfig,
      responseWindowMs: { ...timeConfig.responseWindowMs, MOMENTUM_BURST: 30 * 60_000 },
    }, {
      eventType: 'MOMENTUM_BURST',
      triggeredAt: 1_000,
      evaluatedAt: 2_000,
      responseState: 'EXPECTED_RESPONSE_WINDOW',
    }),
    /response window cannot exceed max holding time/,
  )
})

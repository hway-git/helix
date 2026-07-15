import assert from 'node:assert/strict'
import test from 'node:test'
import type { SwingRiskPolicyConfig } from '@helix/contracts/swing'
import { createSwingTradeThesis, transitionSwingTradeThesis } from './swing-state-machine'
import { evaluateSwingExecution, evaluateSwingInvalidation, evaluateSwingRiskPolicy } from './swing-policies'

const riskConfig: SwingRiskPolicyConfig = {
  thesisRiskBudgetR: 1,
  riskByStageR: { EARLY: 0.25, STANDARD: 0.35, CONFIRMED: 0.4 },
}

function activeThesis(type: 'H4_CLOSE_ABOVE_LEVEL' | 'H4_CLOSE_BELOW_LEVEL' = 'H4_CLOSE_ABOVE_LEVEL') {
  const candidate = createSwingTradeThesis({
    id: 'BTC-4H-THESIS-001',
    symbol: 'BTC-USDT-SWAP',
    type: 'TREND_CONTINUATION',
    direction: type === 'H4_CLOSE_ABOVE_LEVEL' ? 'SHORT' : 'LONG',
    contextId: 'BTC-CONTEXT-001',
    locationId: 'BTC-LOCATION-001',
    score: 60,
    invalidation: {
      policyId: 'thesis_invalidation_v1',
      type,
      timeframe: '4h',
      level: 62_650,
    },
    expectedMove: { targetLocationId: 'BTC-TARGET-001', target: 60_500 },
    createdAt: 1_000,
    expiresAt: 10_000,
    reasonCodes: ['LOCATION_ALIGNED'],
  })
  return transitionSwingTradeThesis(candidate, {
    toState: 'ACTIVE',
    occurredAt: 1_500,
    reasonCodes: ['CONTEXT_ALIGNED'],
  }).thesis
}

test('Swing risk policy shares one Thesis budget across execution stages', () => {
  assert.deepEqual(
    evaluateSwingRiskPolicy(riskConfig, {
      stage: 'STANDARD',
      currentThesisRiskR: 0.25,
      availablePortfolioRiskR: 0.5,
    }),
    {
      allowed: true,
      requestedRiskR: 0.35,
      remainingThesisRiskR: 0.75,
      reasonCodes: [],
    },
  )
  assert.deepEqual(
    evaluateSwingRiskPolicy(riskConfig, {
      stage: 'CONFIRMED',
      currentThesisRiskR: 0.8,
      availablePortfolioRiskR: 1,
    }),
    {
      allowed: false,
      requestedRiskR: 0,
      remainingThesisRiskR: 0.2,
      reasonCodes: ['RISK_BUDGET_EXCEEDED'],
    },
  )
  assert.deepEqual(
    evaluateSwingRiskPolicy(riskConfig, {
      stage: 'CONFIRMED',
      currentThesisRiskR: 0.6,
      availablePortfolioRiskR: 0.4,
    }),
    {
      allowed: true,
      requestedRiskR: 0.4,
      remainingThesisRiskR: 0.4,
      reasonCodes: [],
    },
  )
})

test('Swing invalidation is evaluated only from the configured closed 4H condition', () => {
  const shortThesis = activeThesis()
  assert.deepEqual(
    evaluateSwingInvalidation(shortThesis, { timeframe: '4h', time: 2_000, close: 62_650, closed: true }),
    { invalidated: false, reasonCodes: [] },
  )
  assert.deepEqual(
    evaluateSwingInvalidation(shortThesis, { timeframe: '4h', time: 2_000, close: 62_651, closed: true }),
    { invalidated: true, reasonCodes: ['THESIS_INVALIDATED'] },
  )
  assert.deepEqual(
    evaluateSwingInvalidation(activeThesis('H4_CLOSE_BELOW_LEVEL'), {
      timeframe: '4h',
      time: 2_000,
      close: 62_649,
      closed: true,
    }),
    { invalidated: true, reasonCodes: ['THESIS_INVALIDATED'] },
  )
  assert.throws(
    () => evaluateSwingInvalidation(shortThesis, {
      timeframe: '4h',
      time: 2_000,
      close: 62_700,
      closed: false,
    }),
    /requires a closed candle/,
  )
})

test('Swing risk policy rejects missing numeric configuration instead of applying a default', () => {
  assert.throws(
    () => evaluateSwingRiskPolicy({ ...riskConfig, thesisRiskBudgetR: 0 }, {
      stage: 'EARLY',
      currentThesisRiskR: 0,
      availablePortfolioRiskR: 1,
    }),
    /config.thesisRiskBudgetR must be positive/,
  )
})

test('Swing staged execution applies Evidence, attempt, timing, and RR gates', () => {
  const active = activeThesis()
  const eligible = transitionSwingTradeThesis(active, {
    toState: 'ENTRY_ELIGIBLE',
    occurredAt: 2_000,
    reasonCodes: ['ENTRY_ELIGIBLE'],
  }).thesis
  const config = {
    minRrByStage: { EARLY: 1.5, STANDARD: 1.8, CONFIRMED: 2 },
    maxAttemptsPerThesis: 3,
  }
  const evidence = {
    locationAligned: true,
    supportingEvidence: true,
    rejection: true,
    displacement: true,
    structureConfirmed: false,
    breakRetestConfirmed: false,
    followThrough: false,
  }

  assert.deepEqual(
    evaluateSwingExecution(config, eligible, {
      stage: 'EARLY',
      attemptCount: 0,
      rr: 1.5,
      entryExtended: false,
      evidence,
    }).reasonCodes,
    ['EXECUTION_TRIGGERED'],
  )

  const rejected = evaluateSwingExecution(config, eligible, {
    stage: 'CONFIRMED',
    attemptCount: 3,
    rr: 1.9,
    entryExtended: true,
    evidence,
  })
  assert.equal(rejected.triggered, false)
  assert.deepEqual(rejected.reasonCodes, [
    'MAX_THESIS_ATTEMPTS',
    'STRUCTURE_NOT_CONFIRMED',
    'ENTRY_TOO_LATE',
    'RR_TOO_LOW',
  ])
})

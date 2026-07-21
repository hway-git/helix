import assert from 'node:assert/strict'
import test from 'node:test'
import type { SwingRiskPolicyConfig } from '@helix/contracts/swing'
import { createSwingTradeThesis, transitionSwingTradeThesis } from './swing-state-machine'
import {
  evaluateSwingExecution,
  evaluateSwingExecutionWithGate,
  evaluateSwingInvalidation,
  evaluateSwingRiskPolicy,
  evaluateSwingRiskPolicyWithGate,
} from './swing-policies'

const riskConfig: SwingRiskPolicyConfig = {
  thesisRiskBudgetR: 1,
  maximumLeverage: 50,
  riskUnitRatio: 0.01,
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

test('Swing risk policy rejects entries that exceed the configured leverage ceiling', () => {
  assert.deepEqual(
    evaluateSwingRiskPolicy(riskConfig, {
      stage: 'CONFIRMED', currentThesisRiskR: 0, availablePortfolioRiskR: 1, priceRiskRatio: 0.00005,
    }),
    {
      allowed: false,
      requestedRiskR: 0,
      remainingThesisRiskR: 1,
      reasonCodes: ['LEVERAGE_TOO_HIGH'],
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
    stopBufferAtr: 0.1,
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
      entryDistanceAtr: 2,
      evidence,
    }).reasonCodes,
    ['EXECUTION_TRIGGERED'],
  )

  const rejected = evaluateSwingExecution(config, eligible, {
    stage: 'CONFIRMED',
    attemptCount: 3,
    rr: 1.9,
    entryDistanceAtr: 2.1,
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

test('Swing execution reports the ordered first failed gate and exact threshold distance', () => {
  const eligible = transitionSwingTradeThesis(activeThesis(), {
    toState: 'ENTRY_ELIGIBLE',
    occurredAt: 2_000,
    reasonCodes: ['ENTRY_ELIGIBLE'],
  }).thesis
  const result = evaluateSwingExecutionWithGate({
    minRrByStage: { EARLY: 1.5, STANDARD: 1.8, CONFIRMED: 2 },
    maxAttemptsPerThesis: 3,
    stopBufferAtr: 0.1,
  }, eligible, {
    stage: 'CONFIRMED',
    attemptCount: 0,
    rr: 1.9,
    entryDistanceAtr: 2.1,
    evidence: {
      locationAligned: true,
      supportingEvidence: true,
      rejection: true,
      displacement: true,
      structureConfirmed: true,
      breakRetestConfirmed: false,
      followThrough: true,
    },
  })
  assert.deepEqual(result.firstFailedGate, {
    gateId: 'BREAK_RETEST_CONFIRMED',
    gateOrder: 5,
    reasonCode: 'STRUCTURE_NOT_CONFIRMED',
    comparison: 'GTE',
    actual: 0,
    required: 1,
    distanceToPass: 1,
  })
  assert.deepEqual(result.decision.reasonCodes, ['STRUCTURE_NOT_CONFIRMED', 'ENTRY_TOO_LATE', 'RR_TOO_LOW'])
})

test('Swing execution keeps exact gate comparisons below the distance precision tick', () => {
  const eligible = transitionSwingTradeThesis(activeThesis(), {
    toState: 'ENTRY_ELIGIBLE',
    occurredAt: 2_000,
    reasonCodes: ['ENTRY_ELIGIBLE'],
  }).thesis
  const evidence = {
    locationAligned: true,
    supportingEvidence: true,
    rejection: true,
    displacement: true,
    structureConfirmed: false,
    breakRetestConfirmed: false,
    followThrough: false,
  }
  const policy = {
    minRrByStage: { EARLY: 1.5, STANDARD: 1.8, CONFIRMED: 2 },
    maxAttemptsPerThesis: 3,
    stopBufferAtr: 0.1,
  }
  const rr = 1.5 - 1e-12
  const result = evaluateSwingExecutionWithGate(policy, eligible, {
    stage: 'EARLY', attemptCount: 0, rr, entryDistanceAtr: 2, evidence,
  })

  assert.deepEqual(result.firstFailedGate, {
    gateId: 'REWARD_RISK',
    gateOrder: 9,
    reasonCode: 'RR_TOO_LOW',
    comparison: 'GTE',
    actual: rr,
    required: 1.5,
    distanceToPass: 1e-9,
  })
  assert.deepEqual(result.decision, {
    triggered: false,
    stage: 'EARLY',
    reasonCodes: ['RR_TOO_LOW'],
    featureSnapshot: {
      attempt_count: 0,
      rr,
      entry_extended: false,
      location_aligned: true,
      supporting_evidence: true,
      rejection: true,
      displacement: true,
      structure_confirmed: false,
      break_retest_confirmed: false,
      follow_through: false,
    },
  })

  const late = evaluateSwingExecutionWithGate(policy, eligible, {
    stage: 'EARLY', attemptCount: 0, rr: 1.5, entryDistanceAtr: 2 + 1e-12, evidence,
  })
  assert.equal(late.decision.triggered, false)
  assert.deepEqual(late.decision.reasonCodes, ['ENTRY_TOO_LATE'])
  assert.equal(late.firstFailedGate?.distanceToPass, 1e-9)

  const exhausted = evaluateSwingExecutionWithGate(policy, eligible, {
    stage: 'EARLY', attemptCount: 3, rr: 1.5, entryDistanceAtr: 2, evidence,
  })
  assert.equal(exhausted.decision.triggered, false)
  assert.deepEqual(exhausted.decision.reasonCodes, ['MAX_THESIS_ATTEMPTS'])
  assert.equal(exhausted.firstFailedGate?.comparison, 'LT')
  assert.equal(exhausted.firstFailedGate?.distanceToPass, 1)
})

test('Swing risk reports leverage before budget gates and preserves the public decision', () => {
  const input = {
    stage: 'CONFIRMED' as const,
    currentThesisRiskR: 0.8,
    availablePortfolioRiskR: 0.1,
    priceRiskRatio: 0.00005,
  }
  const result = evaluateSwingRiskPolicyWithGate(riskConfig, input)
  assert.deepEqual(result.firstFailedGate, {
    gateId: 'LEVERAGE_LIMIT',
    gateOrder: 10,
    reasonCode: 'LEVERAGE_TOO_HIGH',
    comparison: 'LTE',
    actual: 80,
    required: 50,
    distanceToPass: 30,
  })
  assert.deepEqual(result.decision, evaluateSwingRiskPolicy(riskConfig, input))
})

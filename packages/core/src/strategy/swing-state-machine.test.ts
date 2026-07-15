import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendSwingEvidence,
  createSwingTradeThesis,
  transitionSwingTradeThesis,
} from './swing-state-machine'

function candidateThesis() {
  return createSwingTradeThesis({
    id: 'BTC-4H-THESIS-001',
    symbol: 'BTC-USDT-SWAP',
    type: 'TREND_CONTINUATION',
    direction: 'SHORT',
    contextId: 'BTC-CONTEXT-001',
    locationId: 'BTC-LOCATION-001',
    score: 60,
    invalidation: {
      policyId: 'thesis_invalidation_v1',
      type: 'H4_CLOSE_ABOVE_LEVEL',
      timeframe: '4h',
      level: 62_650,
    },
    expectedMove: { targetLocationId: 'BTC-TARGET-001', target: 60_500 },
    createdAt: 1_000,
    expiresAt: 5_000,
    reasonCodes: ['LOCATION_ALIGNED'],
  })
}

function evidence(id: string, time: number, scoreDelta: number) {
  return {
    id,
    thesisId: 'BTC-4H-THESIS-001',
    type: 'STRUCTURE_EVIDENCE',
    time,
    direction: 'SHORT' as const,
    effect: scoreDelta >= 0 ? 'SUPPORTING' as const : 'OPPOSING' as const,
    scoreDelta,
    reasonCodes: [scoreDelta >= 0 ? 'EVIDENCE_STRENGTHENED' : 'NEGATIVE_EVIDENCE_ACCUMULATING'],
    featureSnapshot: { structure_score: 0.72 },
  }
}

test('moves a Swing Thesis through its lifecycle while preserving ordered Evidence', () => {
  const candidate = candidateThesis()
  const active = transitionSwingTradeThesis(candidate, {
    toState: 'ACTIVE',
    occurredAt: 1_500,
    reasonCodes: ['CONTEXT_ALIGNED'],
  }).thesis
  const withEvidence = appendSwingEvidence(active, evidence('evidence-001', 2_000, 10))
  const eligible = transitionSwingTradeThesis(withEvidence, {
    toState: 'ENTRY_ELIGIBLE',
    occurredAt: 2_500,
    reasonCodes: ['EVIDENCE_STRENGTHENED'],
  }).thesis
  const weakened = appendSwingEvidence(eligible, evidence('evidence-002', 3_000, -5))
  const triggered = transitionSwingTradeThesis(weakened, {
    toState: 'TRIGGERED',
    occurredAt: 4_000,
    reasonCodes: ['EXECUTION_TRIGGERED'],
  }).thesis
  const postTrigger = appendSwingEvidence(triggered, evidence('evidence-003', 6_000, -5))
  const closed = transitionSwingTradeThesis(postTrigger, {
    toState: 'CLOSED',
    occurredAt: 7_000,
    reasonCodes: ['THESIS_INVALIDATED'],
  }).thesis

  assert.equal(candidate.state, 'CANDIDATE')
  assert.equal(closed.state, 'CLOSED')
  assert.equal(closed.score, 60)
  assert.deepEqual(closed.evidence.map((item) => item.id), ['evidence-001', 'evidence-002', 'evidence-003'])
})

test('rejects lifecycle shortcuts and never revives terminal Theses', () => {
  const active = transitionSwingTradeThesis(candidateThesis(), {
    toState: 'ACTIVE',
    occurredAt: 1_500,
    reasonCodes: ['CONTEXT_ALIGNED'],
  }).thesis
  assert.throws(
    () => transitionSwingTradeThesis(active, {
      toState: 'TRIGGERED',
      occurredAt: 2_000,
      reasonCodes: ['EXECUTION_TRIGGERED'],
    }),
    /illegal Thesis transition ACTIVE -> TRIGGERED/,
  )

  const invalidated = transitionSwingTradeThesis(active, {
    toState: 'INVALIDATED',
    occurredAt: 2_000,
    reasonCodes: ['THESIS_INVALIDATED'],
  }).thesis
  assert.throws(
    () => transitionSwingTradeThesis(invalidated, {
      toState: 'ACTIVE',
      occurredAt: 2_100,
      reasonCodes: ['CONTEXT_ALIGNED'],
    }),
    /Thesis state INVALIDATED is terminal/,
  )
  assert.throws(
    () => appendSwingEvidence(invalidated, evidence('evidence-001', 2_100, 5)),
    /Thesis state INVALIDATED is terminal/,
  )
})

test('allows a stopped attempt to return to ACTIVE while preserving the same Thesis', () => {
  const active = transitionSwingTradeThesis(candidateThesis(), {
    toState: 'ACTIVE',
    occurredAt: 1_500,
    reasonCodes: ['CONTEXT_ALIGNED'],
  }).thesis
  const eligible = transitionSwingTradeThesis(active, {
    toState: 'ENTRY_ELIGIBLE',
    occurredAt: 2_000,
    reasonCodes: ['ENTRY_ELIGIBLE'],
  }).thesis
  const triggered = transitionSwingTradeThesis(eligible, {
    toState: 'TRIGGERED',
    occurredAt: 2_500,
    reasonCodes: ['EXECUTION_TRIGGERED'],
  }).thesis
  const retryable = transitionSwingTradeThesis(triggered, {
    toState: 'ACTIVE',
    occurredAt: 3_000,
    reasonCodes: ['STOP_HIT'],
  }).thesis

  assert.equal(retryable.id, triggered.id)
  assert.equal(retryable.state, 'ACTIVE')
  assert.deepEqual(retryable.evidence, triggered.evidence)
})

test('enforces Thesis expiry and monotonic time', () => {
  const active = transitionSwingTradeThesis(candidateThesis(), {
    toState: 'ACTIVE',
    occurredAt: 1_500,
    reasonCodes: ['CONTEXT_ALIGNED'],
  }).thesis

  assert.throws(
    () => transitionSwingTradeThesis(active, {
      toState: 'ENTRY_ELIGIBLE',
      occurredAt: 5_000,
      reasonCodes: ['EVIDENCE_STRENGTHENED'],
    }),
    /Thesis expired; only EXPIRED is allowed/,
  )
  assert.throws(
    () => transitionSwingTradeThesis(active, {
      toState: 'EXPIRED',
      occurredAt: 4_999,
      reasonCodes: ['THESIS_EXPIRED'],
    }),
    /cannot expire before its configured time/,
  )
  assert.throws(
    () => transitionSwingTradeThesis(active, {
      toState: 'INVALIDATED',
      occurredAt: 1_499,
      reasonCodes: ['THESIS_INVALIDATED'],
    }),
    /Thesis time cannot move backwards/,
  )

  const expired = transitionSwingTradeThesis(active, {
    toState: 'EXPIRED',
    occurredAt: 5_000,
    reasonCodes: ['THESIS_EXPIRED'],
  }).thesis
  assert.equal(expired.state, 'EXPIRED')
})

test('rejects duplicate, out-of-order, and score-breaking Evidence', () => {
  const active = transitionSwingTradeThesis(candidateThesis(), {
    toState: 'ACTIVE',
    occurredAt: 1_500,
    reasonCodes: ['CONTEXT_ALIGNED'],
  }).thesis
  const first = appendSwingEvidence(active, evidence('evidence-001', 2_000, 10))

  assert.throws(
    () => appendSwingEvidence(first, evidence('evidence-001', 2_100, 5)),
    /duplicate Evidence id evidence-001/,
  )
  assert.throws(
    () => appendSwingEvidence(first, evidence('evidence-002', 1_999, 5)),
    /Evidence time cannot move backwards/,
  )
  assert.throws(
    () => appendSwingEvidence(first, evidence('evidence-003', 2_100, 31)),
    /Thesis score after Evidence must be between 0 and 100/,
  )
})

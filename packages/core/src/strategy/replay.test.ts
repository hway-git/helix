import assert from 'node:assert/strict'
import test from 'node:test'
import type { StrategyReplayObservation } from '@helix/contracts/strategy'
import { compareStrategyReplay } from './replay'

function observation(): StrategyReplayObservation {
  return {
    identity: {
      strategyId: 'helix_scalp_hunter',
      strategyVersion: '1.0.0',
      strategyRepoCommit: 'a'.repeat(40),
      strategyConfigHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40),
      marketDataSnapshotId: 'snapshot-001',
    },
    objectState: 'ARMED',
    reasonCodes: ['EVENT_ARMED'],
    score: 82,
    signalDecision: 'would_reject',
    riskDecision: 'RR_TOO_LOW',
  }
}

test('reports MATCH only when replay identity and decision semantics are identical', () => {
  const expected = observation()
  const comparison = compareStrategyReplay(expected, structuredClone(expected))
  assert.deepEqual(comparison, { ok: true, code: 'MATCH', mismatches: [] })
})

test('reports every semantic replay mismatch rather than relying on PnL', () => {
  const expected = observation()
  const actual = {
    ...structuredClone(expected),
    identity: { ...expected.identity, engineCommit: 'd'.repeat(40) },
    objectState: 'TRIGGERED',
    reasonCodes: ['EXECUTION_TRIGGERED'],
    signalDecision: 'would_trigger',
  }
  const comparison = compareStrategyReplay(expected, actual)

  assert.equal(comparison.ok, false)
  assert.equal(comparison.code, 'NON_DETERMINISTIC_REPLAY')
  assert.deepEqual(
    comparison.mismatches.map((mismatch) => mismatch.field),
    ['identity.engineCommit', 'objectState', 'reasonCodes', 'signalDecision'],
  )
})

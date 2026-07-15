import { isDeepStrictEqual } from 'node:util'
import type {
  StrategyDecisionIdentity,
  StrategyReplayComparison,
  StrategyReplayObservation,
} from '@helix/contracts/strategy'

const IDENTITY_FIELDS: Array<keyof StrategyDecisionIdentity> = [
  'strategyId',
  'strategyVersion',
  'strategyRepoCommit',
  'strategyConfigHash',
  'engineCommit',
  'marketDataSnapshotId',
]

function assertObservation(observation: StrategyReplayObservation, name: string) {
  if (!observation.objectState.trim()) throw new Error(`${name}.objectState is required`)
  if (!observation.signalDecision.trim()) throw new Error(`${name}.signalDecision is required`)
  if (!observation.riskDecision.trim()) throw new Error(`${name}.riskDecision is required`)
  if (observation.score !== null && !Number.isFinite(observation.score)) {
    throw new Error(`${name}.score must be finite or null`)
  }
}

export function compareStrategyReplay(
  expected: StrategyReplayObservation,
  actual: StrategyReplayObservation,
): StrategyReplayComparison {
  assertObservation(expected, 'expected')
  assertObservation(actual, 'actual')
  const mismatches: StrategyReplayComparison['mismatches'] = []

  for (const field of IDENTITY_FIELDS) {
    if (expected.identity[field] !== actual.identity[field]) {
      mismatches.push({
        field: `identity.${field}`,
        expected: expected.identity[field],
        actual: actual.identity[field],
      })
    }
  }

  for (const field of ['objectState', 'reasonCodes', 'score', 'signalDecision', 'riskDecision'] as const) {
    if (!isDeepStrictEqual(expected[field], actual[field])) {
      mismatches.push({ field, expected: expected[field], actual: actual[field] })
    }
  }

  return {
    ok: mismatches.length === 0,
    code: mismatches.length === 0 ? 'MATCH' : 'NON_DETERMINISTIC_REPLAY',
    mismatches,
  }
}

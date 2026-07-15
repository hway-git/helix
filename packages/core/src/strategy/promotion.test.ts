import assert from 'node:assert/strict'
import test from 'node:test'
import { STRATEGY_BACKTEST_CHECKS } from '@helix/contracts/strategy'
import { assertStrategyLifecycleTransition, evaluateStrategyBacktestGate } from './promotion'

test('allows only the next explicit strategy lifecycle transition', () => {
  assert.doesNotThrow(() => assertStrategyLifecycleTransition('proposal', 'backtested'))
  assert.doesNotThrow(() => assertStrategyLifecycleTransition('production', 'deprecated'))
  assert.throws(
    () => assertStrategyLifecycleTransition('proposal', 'shadow'),
    /illegal strategy lifecycle transition proposal -> shadow; expected backtested/,
  )
  assert.throws(
    () => assertStrategyLifecycleTransition('deprecated', 'production'),
    /strategy lifecycle deprecated is terminal/,
  )
})

test('requires the complete baseline CI evidence before BACKTESTED', () => {
  const incomplete = evaluateStrategyBacktestGate(['schema_validation', 'unit_tests'])
  assert.equal(incomplete.ok, false)
  assert.ok(incomplete.missing.includes('deterministic_replay'))
  assert.ok(incomplete.missing.includes('walk_forward'))

  const complete = evaluateStrategyBacktestGate([...STRATEGY_BACKTEST_CHECKS])
  assert.equal(complete.ok, true)
  assert.deepEqual(complete.missing, [])
})

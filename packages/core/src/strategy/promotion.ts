import {
  STRATEGY_BACKTEST_CHECKS,
  type StrategyBacktestCheck,
  type StrategyLifecycle,
} from '@helix/contracts/strategy'

const LIFECYCLE_TRANSITIONS: Partial<Record<StrategyLifecycle, StrategyLifecycle>> = {
  proposal: 'backtested',
  backtested: 'shadow',
  shadow: 'canary',
  canary: 'production',
  production: 'deprecated',
}

export type StrategyBacktestGate = {
  ok: boolean
  required: StrategyBacktestCheck[]
  passed: StrategyBacktestCheck[]
  missing: StrategyBacktestCheck[]
}

export function assertStrategyLifecycleTransition(from: StrategyLifecycle, to: StrategyLifecycle) {
  const expected = LIFECYCLE_TRANSITIONS[from]
  if (expected !== to) {
    if (!expected) throw new Error(`strategy lifecycle ${from} is terminal`)
    throw new Error(`illegal strategy lifecycle transition ${from} -> ${to}; expected ${expected}`)
  }
}

export function evaluateStrategyBacktestGate(passedChecks: StrategyBacktestCheck[]): StrategyBacktestGate {
  const passed = [...new Set(passedChecks)]
  const passedSet = new Set(passed)
  const required = [...STRATEGY_BACKTEST_CHECKS]
  const missing = required.filter((check) => !passedSet.has(check))
  return {
    ok: missing.length === 0,
    required,
    passed,
    missing,
  }
}

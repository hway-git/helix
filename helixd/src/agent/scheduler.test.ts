import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentMarketContext } from './market-context'
import { retryAgentAnalysis } from './analysis-runner'
import { createAgentScheduler } from './scheduler'

function context(value: string): AgentMarketContext {
  return {
    symbol: 'BTC/USDT',
    timeframe: '15m',
    generatedAt: 1,
    source: { name: 'test', status: 'live', fetchedAt: 1, errors: [] },
    analysisSource: 'test',
    strategyVersion: 'test/v1',
    canPersistStory: true,
    persistenceBlockReason: null,
    evidence: [{ ref: 'strategy.context', value }],
  }
}

test('scheduler runs daily once and then reacts only to strategy changes', async () => {
  const state = new Map<string, string>()
  const runs: string[] = []
  let current = context('channel')
  const scheduler = createAgentScheduler({
    enabled: true,
    pollIntervalMs: 60_000,
    dailyHour: 8,
    timeZone: 'UTC',
    maxAttempts: 3,
  }, {
    listScopes: async () => [{ symbol: 'BTC/USDT', timeframe: '15m' }],
    getMarketContext: async () => current,
    readState: (key) => state.get(key) ?? null,
    writeState: (key, value) => void state.set(key, value),
    runAnalysis: async (_scope, trigger) => void runs.push(trigger),
  })

  const morning = Date.UTC(2026, 6, 15, 9)
  await scheduler.tick(morning)
  await scheduler.tick(morning + 60_000)
  current = context('trend')
  await scheduler.tick(morning + 120_000)

  assert.deepEqual(runs, ['daily', 'market-change'])
})

test('analysis retry recovers transient failures and stops at success', async () => {
  const attempts: number[] = []
  const result = await retryAgentAnalysis(async (attempt) => {
    attempts.push(attempt)
    if (attempt < 3) throw new Error('temporary')
    return 'ok'
  }, 3, 0)
  assert.equal(result, 'ok')
  assert.deepEqual(attempts, [1, 2, 3])
})

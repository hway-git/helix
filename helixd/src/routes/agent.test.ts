import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const testRoot = mkdtempSync(join(tmpdir(), 'helix-agent-route-'))
process.env.HELIX_DATABASE_PATH = join(testRoot, 'helix.sqlite')

test('GET /story/history returns persisted lifecycle events', async () => {
  const [{ agentRoutes }, { writeMarketStory }] = await Promise.all([
    import('./agent'),
    import('../agent/story-store'),
  ])
  writeMarketStory({ symbol: 'BTC/USDT', timeframe: '15m' }, {
    summary: 'Initial story.',
    changeSummary: 'Created.',
    analysisSource: 'test',
    strategyVersion: 'test/v1',
    scenarios: [{
      role: 'primary',
      thesis: 'Continuation.',
      expectation: 'Second leg.',
      state: 'watching',
      waitingFor: 'Signal bar.',
      invalidation: 'Opposite break.',
      evidenceRefs: ['strategy.context'],
    }],
  })

  const response = await agentRoutes.request('/story/history?symbol=btc%2Fusdt&timeframe=15M&limit=10')
  assert.equal(response.status, 200)
  const payload = await response.json() as { scope: { symbol: string; timeframe: string }; events: unknown[] }
  assert.deepEqual(payload.scope, { symbol: 'BTC/USDT', timeframe: '15m' })
  assert.equal(payload.events.length, 1)
})

test('GET /analyses returns persisted background runs', async () => {
  const [{ agentRoutes }, analysisStore] = await Promise.all([
    import('./agent'),
    import('../agent/analysis-store'),
  ])
  const run = analysisStore.startAgentAnalysisRun({ symbol: 'ETH/USDT', timeframe: '5m' }, 'daily', 1)
  analysisStore.completeAgentAnalysisRun(run.id, 'Daily output.', null)

  const response = await agentRoutes.request('/analyses?symbol=ETH%2FUSDT&timeframe=5m')
  assert.equal(response.status, 200)
  const payload = await response.json() as { runs: Array<{ status: string; output: string }> }
  assert.deepEqual(payload.runs.map((item) => item.status), ['succeeded'])
  assert.equal(payload.runs[0].output, 'Daily output.')
})

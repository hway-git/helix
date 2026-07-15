import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const testRoot = mkdtempSync(join(tmpdir(), 'helix-agent-analysis-'))
process.env.HELIX_DATABASE_PATH = join(testRoot, 'helix.sqlite')

test('analysis runs persist success and recover interrupted work', async () => {
  const store = await import('./analysis-store')
  const scope = { symbol: 'btc/usdt', timeframe: '15M' }
  const first = store.startAgentAnalysisRun(scope, 'daily', 1)
  store.completeAgentAnalysisRun(first.id, 'Daily analysis.', 2)
  store.startAgentAnalysisRun(scope, 'market-change', 1)

  assert.equal(store.recoverInterruptedAgentAnalysisRuns(), 1)
  const runs = store.readAgentAnalysisRuns(scope)
  assert.deepEqual(runs.map((run) => run.status), ['failed', 'succeeded'])
  assert.equal(runs[0].error, 'DAEMON_RESTARTED_DURING_ANALYSIS')
  assert.equal(runs[1].storyRevision, 2)
})

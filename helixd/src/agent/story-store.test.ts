import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const testRoot = mkdtempSync(join(tmpdir(), 'helix-agent-story-'))
process.env.HELIX_DATABASE_PATH = join(testRoot, 'helix.sqlite')

test('persists valid lifecycle revisions and exposes newest-first events', async () => {
  const { readMarketStory, readMarketStoryEvents, writeMarketStory } = await import('./story-store')
  const scope = { symbol: 'btc/usdt', timeframe: '15M' }
  const first = writeMarketStory(scope, {
    summary: 'BTC is consolidating under resistance.',
    changeSummary: 'Initial story.',
    analysisSource: 'test-analyzer',
    strategyVersion: 'test-analyzer/v1',
    scenarios: [{
      role: 'primary',
      thesis: 'Consolidation continues.',
      expectation: 'Wait for a directional break.',
      state: 'watching',
      waitingFor: 'A closed-bar breakout.',
      invalidation: 'A decisive break in either direction.',
      evidenceRefs: ['signal.status'],
    }],
  })

  const scenario = first.scenarios[0]
  const second = writeMarketStory(scope, {
    summary: 'The same scenario is now armed.',
    changeSummary: 'Evidence aligned with the scenario.',
    analysisSource: 'test-analyzer',
    strategyVersion: 'test-analyzer/v1',
    scenarios: [{
      id: scenario.id,
      role: scenario.role,
      thesis: scenario.thesis,
      expectation: scenario.expectation,
      state: 'armed',
      waitingFor: 'A confirming trigger.',
      invalidation: scenario.invalidation,
      evidenceRefs: ['signal.status', 'signal.bias'],
    }],
  })

  assert.equal(second.revision, 2)
  assert.equal(second.scenarios[0].id, first.scenarios[0].id)
  assert.equal(second.scenarios[0].state, 'armed')
  assert.deepEqual(readMarketStory({ symbol: 'BTC/USDT', timeframe: '15m' }), second)

  const third = writeMarketStory(scope, {
    summary: 'The scenario trigger is confirmed.',
    changeSummary: 'A later closed bar broke the signal bar.',
    analysisSource: 'test-analyzer',
    strategyVersion: 'test-analyzer/v1',
    scenarios: [{
      id: scenario.id,
      role: scenario.role,
      thesis: scenario.thesis,
      expectation: scenario.expectation,
      state: 'confirmed',
      waitingFor: 'Invalidation or completion.',
      invalidation: scenario.invalidation,
      evidenceRefs: ['signal.status'],
    }],
  })
  const events = readMarketStoryEvents(scope, 2)
  assert.deepEqual(events.map((event) => event.revision), [3, 2])
  assert.deepEqual(events[0].transitions, [{
    scenarioId: scenario.id,
    from: 'armed',
    to: 'confirmed',
  }])

  assert.throws(() => writeMarketStory(scope, {
    summary: 'Invalid rewrite.',
    changeSummary: 'Tried to replace the thesis.',
    analysisSource: 'test-analyzer',
    strategyVersion: 'test-analyzer/v1',
    scenarios: [{
      id: third.scenarios[0].id,
      role: 'primary',
      thesis: 'A different thesis.',
      expectation: third.scenarios[0].expectation,
      state: third.scenarios[0].state,
      waitingFor: third.scenarios[0].waitingFor,
      invalidation: third.scenarios[0].invalidation,
      evidenceRefs: third.scenarios[0].evidenceRefs,
    }],
  }), /SCENARIO_THESIS_IMMUTABLE/)
})

test('rejects invalid bootstrap, omission, and terminal-state revival', async () => {
  const { writeMarketStory } = await import('./story-store')
  const scope = { symbol: 'ETH/USDT', timeframe: '5m' }
  const base = {
    summary: 'Initial.',
    changeSummary: 'Initial.',
    analysisSource: 'test-analyzer',
    strategyVersion: 'test-analyzer/v1',
  }

  assert.throws(() => writeMarketStory(scope, {
    ...base,
    scenarios: [{
      role: 'primary',
      thesis: 'Already invalid.',
      expectation: 'None.',
      state: 'rejected',
      waitingFor: 'A new thesis.',
      invalidation: 'Already occurred.',
      evidenceRefs: ['signal.status'],
    }],
  }), /NEW_SCENARIO_TERMINAL_STATE:rejected/)

  const first = writeMarketStory(scope, {
    ...base,
    scenarios: [{
      role: 'primary',
      thesis: 'Range rotation.',
      expectation: 'Test the opposite edge.',
      state: 'watching',
      waitingFor: 'Supporting evidence.',
      invalidation: 'Range breakout.',
      evidenceRefs: ['signal.status'],
    }],
  })
  assert.throws(() => writeMarketStory(scope, {
    ...base,
    scenarios: [{
      role: 'primary',
      thesis: 'Replacement thesis.',
      expectation: 'Continue.',
      state: 'watching',
      waitingFor: 'Evidence.',
      invalidation: 'Failure.',
      evidenceRefs: ['signal.status'],
    }],
  }), /ACTIVE_SCENARIO_OMITTED/)

  const rejected = writeMarketStory(scope, {
    ...base,
    scenarios: [{
      ...first.scenarios[0],
      state: 'rejected',
      waitingFor: 'A new thesis.',
    }],
  })
  assert.throws(() => writeMarketStory(scope, {
    ...base,
    scenarios: [{
      ...rejected.scenarios[0],
      state: 'watching',
    }],
  }), /INVALID_SCENARIO_TRANSITION:rejected->watching/)
})

test('bootstrap ignores a model-supplied placeholder scenario id', async () => {
  const { writeMarketStory } = await import('./story-store')
  const story = writeMarketStory({ symbol: 'SOL/USDT', timeframe: '15m' }, {
    summary: 'Initial story.',
    changeSummary: 'Created from current evidence.',
    analysisSource: 'test-analyzer',
    strategyVersion: 'test-analyzer/v1',
    scenarios: [{
      id: '00000000-0000-0000-0000-000000000000',
      role: 'primary',
      thesis: 'Wait for a valid setup.',
      expectation: 'No directional expectation yet.',
      state: 'watching',
      waitingFor: 'A structured PA setup.',
      invalidation: 'Context changes first.',
      evidenceRefs: ['strategy.context'],
    }, {
      id: '00000000-0000-0000-0000-000000000000',
      role: 'alternative',
      thesis: 'A short-term counter move may develop.',
      expectation: 'Wait for a valid lower-timeframe setup.',
      state: 'watching',
      waitingFor: 'A structured PA setup.',
      invalidation: 'The counter move loses momentum.',
      evidenceRefs: ['signal.status'],
    }],
  })
  assert.notEqual(story.scenarios[0].id, '00000000-0000-0000-0000-000000000000')
  assert.notEqual(story.scenarios[1].id, '00000000-0000-0000-0000-000000000000')
  assert.notEqual(story.scenarios[0].id, story.scenarios[1].id)
})

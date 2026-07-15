import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildHelixAnalystInstructions,
  reconcileMarketStoryUpdate,
  resolveAgentTargetScope,
} from './runtime'

test('Analyst instructions include versioned strategy doctrine and restored scope', () => {
  const instructions = buildHelixAnalystInstructions(
    { symbol: 'BTC/USDT', timeframe: '15m' },
  )

  assert.match(instructions, /dashboard 场景：BTC\/USDT \/ 15m/)
  assert.match(instructions, /“分析 XRP”应读取 XRP\/USDT/)
  assert.match(instructions, /helix-agent-strategy-doctrine\/v1/)
  assert.match(instructions, /Market Context → PA Setup → Expectation/)
  assert.match(instructions, /禁止指标投票/)
  assert.match(instructions, /不得补写缺失的 Setup/)
  assert.match(instructions, /长期记忆工具状态：unavailable/)
  assert.match(instructions, /禁止写入价格、指标、当前 Setup\/Hypothesis/)
  assert.match(instructions, /图表必须跟随最近一次 selectMarketState 的实际目标标的/)
})

test('Analyst restores only retrieved memories and current intent takes priority', () => {
  const instructions = buildHelixAnalystInstructions(
    { symbol: 'ETH/USDT', timeframe: '5m' },
    [{ id: 'm1', memory: '用户偏好客观分析', categories: ['analysis-habit'] }],
    true,
    '用户上次在等待 15m 闭合确认。',
  )
  assert.match(instructions, /用户偏好客观分析/)
  assert.match(instructions, /长期记忆工具状态：available/)
  assert.match(instructions, /当前用户明确意图优先于长期 Memory/)
  assert.match(instructions, /用户上次在等待 15m 闭合确认/)
})

test('explicit conversation target overrides the dashboard scene', () => {
  const scene = { symbol: 'BTC/USDT', timeframe: '15m' }
  assert.deepEqual(resolveAgentTargetScope(scene), scene)
  assert.deepEqual(resolveAgentTargetScope(scene, { symbol: 'xrp' }), {
    symbol: 'XRP/USDT',
    timeframe: '1h',
  })
  assert.deepEqual(resolveAgentTargetScope(scene, { symbol: 'eth-usdt-swap', timeframe: '5m' }), {
    symbol: 'ETH/USDT',
    timeframe: '5m',
  })
})

test('story updates recover existing ids by thesis and discard new placeholders', () => {
  const existingScenario = {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'primary' as const,
    thesis: 'Existing thesis.',
    expectation: 'Existing expectation.',
    state: 'watching' as const,
    waitingFor: 'Evidence.',
    invalidation: 'Context changes.',
    evidenceRefs: ['strategy.context'],
    createdAt: 1,
    updatedAt: 1,
  }
  const story = {
    id: '22222222-2222-4222-8222-222222222222',
    symbol: 'XRP/USDT',
    timeframe: '1h',
    revision: 1,
    summary: 'Existing story.',
    changeSummary: 'Created.',
    analysisSource: 'test',
    strategyVersion: 'test/v1',
    scenarios: [existingScenario],
    createdAt: 1,
    updatedAt: 1,
  }
  const update = reconcileMarketStoryUpdate(story, {
    summary: 'Updated story.',
    changeSummary: 'Updated.',
    scenarios: [{
      ...existingScenario,
      id: '00000000-0000-0000-0000-000000000000',
    }, {
      ...existingScenario,
      id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      role: 'alternative',
      thesis: 'New alternative.',
    }],
  })
  assert.equal(update.scenarios[0].id, existingScenario.id)
  assert.equal(update.scenarios[1].id, undefined)
})

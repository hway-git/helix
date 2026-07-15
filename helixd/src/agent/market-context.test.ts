import assert from 'node:assert/strict'
import test from 'node:test'
import type { IntradaySignalSnapshot } from '@helix/contracts/market'
import { marketEvidenceFromSnapshot } from './market-context'

test('strategy analysis is exposed as stable Agent evidence refs', () => {
  const snapshot = {
    ok: true,
    activeSymbol: 'BTC/USDT',
    generatedAt: 1,
    signal: {
      status: 'watch',
      side: 'neutral',
      bias: { side: 'long', confidence: 70, logic: [] },
      confidence: 85,
      confidenceLevel: 'very-high',
      logic: [],
      warnings: [],
    },
    strategy: {
      version: 'helix-pa-expectation/v1',
      context: {
        cycle: 'channel',
        direction: 'long',
        alwaysIn: 'long',
        confidence: 70,
        logic: ['context'],
      },
      setups: [{
        timeframe: '15m',
        type: 'second-entry',
        direction: 'long',
        expectation: 'second-leg',
        state: 'armed',
        signalBar: {
          time: 1,
          open: 100,
          high: 102,
          low: 99,
          close: 101,
          volume: 10,
          quality: 'good',
        },
        invalidation: { price: 98, basis: 'pa-hypothesis' },
        confidence: 85,
        logic: ['setup'],
        warnings: [],
      }],
      selectedTimeframe: '15m',
    },
    timeframes: {},
    source: { name: 'test', status: 'live', fetchedAt: 1, errors: [] },
  } satisfies IntradaySignalSnapshot

  const evidence = new Map(marketEvidenceFromSnapshot(snapshot).map((item) => [item.ref, item.value]))
  assert.equal(evidence.get('strategy.version'), 'helix-pa-expectation/v1')
  assert.match(evidence.get('strategy.context') ?? '', /"cycle":"channel"/)
  assert.match(evidence.get('strategy.setup.15m') ?? '', /"state":"armed"/)
  assert.equal(evidence.get('strategy.selectedTimeframe'), '15m')
})

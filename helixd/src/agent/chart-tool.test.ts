import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveChartAnnotations } from './chart-tool'

const evidence = [
  {
    ref: 'strategy.setup.15m',
    value: JSON.stringify({
      direction: 'short',
      signalBar: { time: 1000, high: 102, low: 98 },
      invalidation: { price: 103 },
    }),
  },
  {
    ref: 'timeframes.15m.close',
    value: JSON.stringify({ close: 99, closedAt: 2000 }),
  },
  {
    ref: 'timeframes.15m.priceAction',
    value: JSON.stringify({ event: 'bearish-break', eventLevel: 100 }),
  },
  {
    ref: 'timeframes.15m.macd',
    value: JSON.stringify({ momentum: 'bearish', divergence: 'bullish' }),
  },
]

test('chart annotations resolve coordinates only from existing evidence', () => {
  const annotations = resolveChartAnnotations([
    { type: 'marker', evidenceRef: 'strategy.setup.15m', text: 'L2' },
    { type: 'price-line', evidenceRef: 'strategy.setup.15m', text: '失效', value: 'invalidation' },
    { type: 'marker', evidenceRef: 'timeframes.15m.priceAction', text: '破位' },
    { type: 'marker', evidenceRef: 'timeframes.15m.macd', text: '底背离' },
  ], evidence, '15m')
  assert.deepEqual(annotations, [
    { type: 'marker', evidenceRef: 'strategy.setup.15m', text: 'L2', time: 1000, direction: 'short' },
    { type: 'price-line', evidenceRef: 'strategy.setup.15m', text: '失效', price: 103 },
    { type: 'marker', evidenceRef: 'timeframes.15m.priceAction', text: '破位', time: 2000, direction: 'short' },
    { type: 'marker', evidenceRef: 'timeframes.15m.macd', text: '底背离', time: 2000, direction: 'long' },
  ])
  assert.throws(() => resolveChartAnnotations([
    { type: 'marker', evidenceRef: 'strategy.setup.15m', text: 'L2' },
  ], evidence, '5m'), /TIMEFRAME_MISMATCH/)
  assert.throws(() => resolveChartAnnotations([
    { type: 'marker', evidenceRef: 'missing', text: 'fake' },
  ], evidence, '15m'), /UNKNOWN_EVIDENCE_REF/)
  assert.throws(() => resolveChartAnnotations([
    { type: 'marker', evidenceRef: 'timeframes.15m.priceAction', text: '破位' },
  ], evidence, '5m'), /TIMEFRAME_MISMATCH/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchOkxHistoricalDataset } from './okx-historical'

const minute = 60_000

function row(index: number) {
  const price = 100 + index
  return [
    String(index * minute),
    String(price),
    String(price + 1),
    String(price - 1),
    String(price + 0.5),
    '10',
    '1000',
    '1000',
    '1',
  ]
}

test('paginates OKX backward, deduplicates rows, and hashes only closed requested candles', async () => {
  const source = Array.from({ length: 6 }, (_, index) => row(index)).reverse()
  const cursors: number[] = []
  const fetchImpl = async (input: string | URL) => {
    const url = new URL(input)
    const cursor = Number(url.searchParams.get('after'))
    cursors.push(cursor)
    const page = source.filter((candidate) => Number(candidate[0]) < cursor).slice(0, 2)
    return new Response(JSON.stringify({ code: '0', data: page }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const dataset = await fetchOkxHistoricalDataset({
    instrumentId: 'BTC-USDT-SWAP',
    symbol: 'BTC/USDT:USDT',
    timeframes: ['1m'],
    startTime: 0,
    endTime: 6 * minute,
    fetchImpl,
  })

  assert.ok(cursors.length >= 3)
  assert.deepEqual(dataset.timeframes['1m']!.map((candle) => candle.time), [0, minute, 2 * minute, 3 * minute, 4 * minute, 5 * minute])
  assert.match(dataset.datasetHash, /^sha256:[a-f0-9]{64}$/)
})

test('rejects history pages that stop moving backward', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ code: '0', data: [row(5), row(4)] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
  await assert.rejects(fetchOkxHistoricalDataset({
    instrumentId: 'BTC-USDT-SWAP',
    symbol: 'BTC/USDT:USDT',
    timeframes: ['1m'],
    startTime: 0,
    endTime: 10 * minute,
    fetchImpl,
  }), /pagination did not move backward/)
})

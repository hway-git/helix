import { createOkxSwapPair } from '@helix/contracts/market'
import type { AgentScope } from '@helix/contracts/agent'
import { getMarketDataProvider } from '@helix/core/market-providers'

export async function getAgentChartCandles(input: AgentScope, requestedBars: number) {
  const timeframe = input.timeframe.toLowerCase()
  if (!['5m', '15m', '1h'].includes(timeframe)) {
    throw new Error(`CHART_TIMEFRAME_UNSUPPORTED:${timeframe}`)
  }
  const instrumentId = `${input.symbol.trim().toUpperCase().replace('/', '-')}-SWAP`
  const pair = createOkxSwapPair(instrumentId)
  if (!pair) throw new Error(`CHART_SYMBOL_UNSUPPORTED:${input.symbol}`)
  const provider = getMarketDataProvider('okx')
  const candles = await provider.getCandles({
    pair,
    interval: timeframe,
    limit: Math.max(50, Math.min(300, Math.trunc(requestedBars))),
    closedOnly: true,
  })
  if (candles.length === 0) throw new Error('CHART_CANDLES_UNAVAILABLE')
  return {
    symbol: pair.symbol,
    timeframe,
    candles,
    source: { name: provider.name, fetchedAt: Date.now() },
  }
}

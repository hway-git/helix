import type { MarketSnapshot, TradingPair } from '@/lib/market-data'

export type MarketDataProvider = {
  id: string
  name: string
  market: string
  supportedIntervals: Set<string>
  normalizeInterval: (interval: string | null) => string
  getSnapshot: (params: {
    activePair: TradingPair
    pairs: TradingPair[]
    interval: string
  }) => Promise<MarketSnapshot>
}

export function resolveTradingPair(pairs: TradingPair[], symbol: string | null): TradingPair {
  const normalized = (symbol || '').toUpperCase()
  return pairs.find((pair) => pair.symbol === normalized) ?? pairs[0]
}

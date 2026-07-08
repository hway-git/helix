// Shared market data types and watchlist configuration.

export type Candle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type TradingPair = {
  symbol: string
  base: string
  quote: string
  instrumentId: string
  market: string
  contractType: 'spot' | 'perpetual'
  price: number
  change: number // 24h 涨跌幅 %
  volume: string
  sparkline: number[]
  high24h?: number
  low24h?: number
  fundingRate?: number
  nextFundingTime?: number
  fundingUpdatedAt?: number
  updatedAt?: number
  stale?: boolean
}

export type RsiPoint = {
  time: number
  value: number
}

export type MacdPoint = {
  time: number
  macd: number
  signal: number
  hist: number
}

export type MarketSource = {
  name: string
  market: string
  contractType: string
  status: 'live' | 'partial'
  fetchedAt: number
  errors: string[]
}

export type MarketRangeLevel = {
  high: number
  low: number
  startTime: number
  endTime: number
}

export type MarketLevels = {
  monday?: MarketRangeLevel
}

export type MarketSnapshot = {
  ok: boolean
  activeSymbol: string
  timeframe: string
  pairs: TradingPair[]
  activePair: TradingPair
  candles: Candle[]
  levels?: MarketLevels
  source: MarketSource
}

export type IndicatorSource = {
  name: string
  status: 'live' | 'partial' | 'offline'
  fetchedAt: number
  errors: string[]
}

export type TechnicalIndicators = {
  rsi: RsiPoint[]
  macd: MacdPoint[]
}

export type IndicatorSnapshot = {
  ok: boolean
  activeSymbol: string
  timeframe: string
  indicators: TechnicalIndicators
  source: IndicatorSource
}

export const TRADING_PAIRS: TradingPair[] = [
  { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', instrumentId: 'BTC-USDT-SWAP', market: 'okx', contractType: 'perpetual', price: 0, change: 0, volume: '--', sparkline: [] },
  { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', instrumentId: 'ETH-USDT-SWAP', market: 'okx', contractType: 'perpetual', price: 0, change: 0, volume: '--', sparkline: [] },
  { symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', instrumentId: 'SOL-USDT-SWAP', market: 'okx', contractType: 'perpetual', price: 0, change: 0, volume: '--', sparkline: [] },
  { symbol: 'BNB/USDT', base: 'BNB', quote: 'USDT', instrumentId: 'BNB-USDT-SWAP', market: 'okx', contractType: 'perpetual', price: 0, change: 0, volume: '--', sparkline: [] },
  { symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', instrumentId: 'XRP-USDT-SWAP', market: 'okx', contractType: 'perpetual', price: 0, change: 0, volume: '--', sparkline: [] },
  { symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', instrumentId: 'DOGE-USDT-SWAP', market: 'okx', contractType: 'perpetual', price: 0, change: 0, volume: '--', sparkline: [] },
  { symbol: 'AVAX/USDT', base: 'AVAX', quote: 'USDT', instrumentId: 'AVAX-USDT-SWAP', market: 'okx', contractType: 'perpetual', price: 0, change: 0, volume: '--', sparkline: [] },
  { symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', instrumentId: 'LINK-USDT-SWAP', market: 'okx', contractType: 'perpetual', price: 0, change: 0, volume: '--', sparkline: [] },
  { symbol: 'LTC/USDT', base: 'LTC', quote: 'USDT', instrumentId: 'LTC-USDT-SWAP', market: 'okx', contractType: 'perpetual', price: 0, change: 0, volume: '--', sparkline: [] },
  { symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', instrumentId: 'ADA-USDT-SWAP', market: 'okx', contractType: 'perpetual', price: 0, change: 0, volume: '--', sparkline: [] },
]

export function createOkxSwapPair(instrumentId: string): TradingPair | null {
  const normalized = instrumentId.trim().toUpperCase()
  const match = /^([A-Z0-9]+)-([A-Z0-9]+)-SWAP$/.exec(normalized)
  if (!match) return null

  const [, base, quote] = match
  return {
    symbol: `${base}/${quote}`,
    base,
    quote,
    instrumentId: normalized,
    market: 'okx',
    contractType: 'perpetual',
    price: 0,
    change: 0,
    volume: '--',
    sparkline: [],
  }
}

export function mergeTradingPairs(pairs: TradingPair[]): TradingPair[] {
  const byInstrument = new Map<string, TradingPair>()
  for (const pair of pairs) byInstrument.set(pair.instrumentId, pair)
  return [...byInstrument.values()]
}

export function formatPrice(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return '--'
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (p >= 1) return p.toFixed(2)
  return p.toFixed(4)
}

export function formatUsdVolume(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '--'
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toFixed(0)
}

import { Hono } from 'hono'
import {
  createOkxSwapPair,
  mergeTradingPairs,
  TRADING_PAIRS,
  type IndicatorSnapshot,
  type MarketNewsSnapshot,
  type MarketSnapshot,
  type TradingPair,
} from '@helix/contracts/market'
import { getFreeChineseCryptoNews } from '@helix/core/market-news/free-cn-rss'
import { getMarketDataProvider, resolveTradingPair } from '@helix/core/market-providers'
import { searchOkxSwapPairs } from '@helix/core/market-providers/okx'
import { getIntradaySignalSnapshot } from '@helix/core/signals/snapshot'
import { calculateTechnicalIndicators } from '@helix/core/technical-indicators/calculate'
import {
  addWatchlistInstrument,
  getWatchlistSnapshot,
  removeWatchlistInstrument,
  replaceWatchlist,
} from '@helix/core/watchlist'
import { readJson } from '../http'
import { requireControlAccess } from '../security/control-access'

const SNAPSHOT_CACHE_TTL_MS = 12_000
const SNAPSHOT_ERROR_CACHE_TTL_MS = 2_000
const INDICATOR_CACHE_TTL_MS = 12_000
const INDICATOR_ERROR_CACHE_TTL_MS = 3_000
const NEWS_CACHE_TTL_MS = 60_000
const NEWS_ERROR_CACHE_TTL_MS = 10_000

const snapshotCache = new Map<string, { expiresAt: number; payload: MarketSnapshot }>()
const indicatorCache = new Map<string, { expiresAt: number; payload: IndicatorSnapshot }>()
const newsCache = new Map<string, { expiresAt: number; payload: MarketNewsSnapshot }>()

export const marketRoutes = new Hono()

function emptyPair(pair: TradingPair): TradingPair {
  return { ...pair, sparkline: [], stale: true }
}

async function pairsFromRequest(url: URL) {
  const instruments = (url.searchParams.get('instruments') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(createOkxSwapPair)
    .filter((pair): pair is TradingPair => pair != null)

  if (instruments.length === 0) return (await getWatchlistSnapshot()).pairs
  return mergeTradingPairs([...TRADING_PAIRS, ...instruments])
}

function errorSnapshot({
  activePair,
  pairs,
  interval,
  providerName,
  providerMarket,
  error,
}: {
  activePair: TradingPair
  pairs: TradingPair[]
  interval: string
  providerName: string
  providerMarket: string
  error: unknown
}): MarketSnapshot {
  const emptyPairs = pairs.map(emptyPair)
  return {
    ok: false,
    activeSymbol: activePair.symbol,
    timeframe: interval,
    pairs: emptyPairs,
    activePair: emptyPairs.find((pair) => pair.symbol === activePair.symbol) ?? emptyPairs[0],
    candles: [],
    source: {
      name: providerName,
      market: providerMarket,
      contractType: activePair.contractType,
      status: 'partial',
      fetchedAt: Date.now(),
      errors: [error instanceof Error ? error.message : '行情源不可用'],
    },
  }
}

marketRoutes.get('/snapshot', async (c) => {
  const url = new URL(c.req.url)
  const provider = getMarketDataProvider(url.searchParams.get('provider') ?? 'okx')
  const pairs = await pairsFromRequest(url)
  const activePair = resolveTradingPair(pairs, url.searchParams.get('symbol'))
  const interval = provider.normalizeInterval(url.searchParams.get('interval'))
  const cacheKey = `${provider.id}:${activePair.symbol}:${interval}:${pairs.map((pair) => pair.instrumentId).join(',')}`
  const cached = snapshotCache.get(cacheKey)

  if (cached && cached.expiresAt > Date.now()) return c.json(cached.payload)

  let payload: MarketSnapshot
  try {
    payload = await provider.getSnapshot({ activePair, pairs, interval })
  } catch (error) {
    payload = errorSnapshot({
      activePair,
      pairs,
      interval,
      providerName: provider.name,
      providerMarket: provider.market,
      error,
    })
  }

  snapshotCache.set(cacheKey, {
    expiresAt: Date.now() + (payload.ok ? SNAPSHOT_CACHE_TTL_MS : SNAPSHOT_ERROR_CACHE_TTL_MS),
    payload,
  })
  return c.json(payload)
})

marketRoutes.get('/indicators', async (c) => {
  const url = new URL(c.req.url)
  const provider = getMarketDataProvider(url.searchParams.get('provider') ?? 'okx')
  const pairs = await pairsFromRequest(url)
  const activePair = resolveTradingPair(pairs, url.searchParams.get('symbol'))
  const interval = provider.normalizeInterval(url.searchParams.get('interval'))
  const cacheKey = `${provider.id}:${activePair.symbol}:${interval}`
  const cached = indicatorCache.get(cacheKey)

  if (cached && cached.expiresAt > Date.now()) return c.json(cached.payload)

  let payload: IndicatorSnapshot
  try {
    const candles = await provider.getCandles({ pair: activePair, interval, limit: 300 })
    const indicators = calculateTechnicalIndicators(candles)
    const errors: string[] = []
    if (indicators.rsi.length === 0) errors.push('RSI14 数据不足')
    if (indicators.macd.length === 0) errors.push('MACD 数据不足')
    payload = {
      ok: errors.length === 0,
      activeSymbol: activePair.symbol,
      timeframe: interval,
      indicators,
      source: {
        name: '行情指标',
        status: errors.length === 0 ? 'live' : 'partial',
        fetchedAt: Date.now(),
        errors,
      },
    }
  } catch (error) {
    payload = {
      ok: false,
      activeSymbol: activePair.symbol,
      timeframe: interval,
      indicators: { rsi: [], macd: [] },
      source: {
        name: '行情指标',
        status: 'offline',
        fetchedAt: Date.now(),
        errors: [error instanceof Error ? error.message : '指标源不可用'],
      },
    }
  }

  indicatorCache.set(cacheKey, {
    expiresAt: Date.now() + (payload.ok ? INDICATOR_CACHE_TTL_MS : INDICATOR_ERROR_CACHE_TTL_MS),
    payload,
  })
  return c.json(payload)
})

function clampNewsLimit(value: string | null) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) return 24
  return Math.min(Math.max(parsed, 1), 50)
}

marketRoutes.get('/news', async (c) => {
  const limit = clampNewsLimit(new URL(c.req.url).searchParams.get('limit'))
  const cacheKey = `free-cn-v3:${limit}`
  const cached = newsCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return c.json(cached.payload)

  const payload = await getFreeChineseCryptoNews(limit)
  newsCache.set(cacheKey, {
    expiresAt: Date.now() + (payload.ok ? NEWS_CACHE_TTL_MS : NEWS_ERROR_CACHE_TTL_MS),
    payload,
  })
  return c.json(payload)
})

marketRoutes.get('/search', async (c) => {
  try {
    const pairs = await searchOkxSwapPairs(c.req.query('q') ?? '')
    return c.json({ ok: true, pairs })
  } catch (error) {
    return c.json({
      ok: false,
      pairs: [],
      error: error instanceof Error ? error.message : '交易对搜索不可用',
    })
  }
})

marketRoutes.get('/signals', async (c) => {
  const url = new URL(c.req.url)
  const instruments = (url.searchParams.get('instruments') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const payload = await getIntradaySignalSnapshot({
    providerId: url.searchParams.get('provider') ?? 'okx',
    symbol: url.searchParams.get('symbol'),
    instruments,
  })
  return c.json(payload)
})

marketRoutes.get('/watchlist', async (c) => c.json(await getWatchlistSnapshot()))

marketRoutes.put('/watchlist', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied
  const body = await readJson(c)
  return c.json(await replaceWatchlist(body.instruments))
})

marketRoutes.post('/watchlist', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied
  const body = await readJson(c)
  try {
    return c.json(await addWatchlistInstrument(body.instrumentId))
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : 'invalid instrumentId' }, 400)
  }
})

marketRoutes.delete('/watchlist', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied
  const body = await readJson(c)
  const instrumentId = body.instrumentId ?? c.req.query('instrumentId')
  try {
    return c.json(await removeWatchlistInstrument(instrumentId))
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : 'invalid instrumentId' }, 400)
  }
})

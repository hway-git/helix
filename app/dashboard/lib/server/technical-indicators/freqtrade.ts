import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { IndicatorSnapshot, MacdPoint, RsiPoint, TechnicalIndicators, TradingPair } from '@/lib/market-data'

type FreqtradeConfig = {
  strategy?: string
}

type FreqtradePairHistory = {
  columns?: string[]
  data?: unknown
}

const FREQTRADE_TIMEOUT_MS = 8_000

function readPasswordFromFile() {
  const candidates = [
    process.env.FREQTRADE_PASSWORD_FILE,
    resolve(process.cwd(), '.ft_api_pass'),
    resolve(process.cwd(), '../../.ft_api_pass'),
    '/workspace/.ft_api_pass',
    resolve(homedir(), '.openclaw/workspace/.ft_api_pass'),
  ].filter(Boolean) as string[]

  for (const file of candidates) {
    try {
      if (existsSync(file)) return readFileSync(file, 'utf8').trim()
    } catch {
      // Ignore unreadable candidates; callers will surface the API auth error.
    }
  }

  return ''
}

function authHeader() {
  const user = process.env.FREQTRADE_USERNAME || process.env.FT_API_USER || 'freqtrade'
  const pass = process.env.FREQTRADE_PASSWORD || readPasswordFromFile()
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
}

async function ftGet<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const base = process.env.FREQTRADE_URL || process.env.FT_API_URL || 'http://127.0.0.1:8888'
  const url = new URL(`/api/v1/${path}`, base)
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value)
  }

  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Authorization: authHeader(), Accept: 'application/json' },
    signal: AbortSignal.timeout(FREQTRADE_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`Freqtrade ${response.status}: ${path} 请求失败`)
  }

  return (await response.json()) as T
}

function freqtradePairCandidates(pair: TradingPair) {
  if (pair.contractType !== 'perpetual') return [pair.symbol]
  return [`${pair.symbol}:${pair.quote}`, pair.symbol]
}

function rowsFromPairHistory(payload: FreqtradePairHistory): Array<Record<string, unknown>> {
  const raw = Array.isArray(payload.data)
    ? payload.data
    : payload.data && typeof payload.data === 'object' && Array.isArray((payload.data as { data?: unknown[] }).data)
      ? (payload.data as { data: unknown[] }).data
      : []

  const columns = payload.columns || (payload.data as { columns?: string[] } | undefined)?.columns || []

  return raw
    .map((row) => {
      if (row && typeof row === 'object' && !Array.isArray(row)) return row as Record<string, unknown>
      if (!Array.isArray(row)) return null

      const out: Record<string, unknown> = {}
      row.forEach((value, index) => {
        out[columns[index] || String(index)] = value
      })
      return out
    })
    .filter((row): row is Record<string, unknown> => row != null)
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function timeFrom(row: Record<string, unknown>): number | undefined {
  const value = row.date ?? row.datetime ?? row.time ?? row.timestamp ?? row.ts
  if (typeof value === 'number' && Number.isFinite(value)) return value > 4_000_000_000 ? value : value * 1000
  if (typeof value === 'string') {
    if (/^\d{13}$/.test(value)) return Number(value)
    if (/^\d{10}$/.test(value)) return Number(value) * 1000
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function firstNumber(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const n = numberFrom(row[key])
    if (n != null) return n
  }
  return undefined
}

function indicatorsFromRows(rows: Array<Record<string, unknown>>): TechnicalIndicators {
  const rsi: RsiPoint[] = []
  const macd: MacdPoint[] = []

  for (const row of rows) {
    const time = timeFrom(row)
    if (time == null) continue

    const rsiValue = firstNumber(row, ['rsi', 'rsi_14', 'RSI'])
    if (rsiValue != null) rsi.push({ time, value: rsiValue })

    const macdValue = firstNumber(row, ['macd', 'macd_line', 'macdline'])
    const signal = firstNumber(row, ['macdsignal', 'macd_signal', 'signal'])
    const hist = firstNumber(row, ['macdhist', 'macd_hist', 'histogram', 'hist'])
    if (macdValue != null && signal != null && hist != null) {
      macd.push({ time, macd: macdValue, signal, hist })
    }
  }

  return { rsi, macd }
}

export async function getFreqtradeIndicators({
  activePair,
  interval,
}: {
  activePair: TradingPair
  interval: string
}): Promise<IndicatorSnapshot> {
  const fetchedAt = Date.now()
  const config = await ftGet<FreqtradeConfig>('show_config')
  const strategy = config.strategy
  if (!strategy) throw new Error('Freqtrade 当前未返回 strategy，无法读取 analyzed candles')

  let payload: FreqtradePairHistory | null = null
  let lastError: unknown = null
  for (const pair of freqtradePairCandidates(activePair)) {
    try {
      payload = await ftGet<FreqtradePairHistory>('pair_history', {
        pair,
        timeframe: interval,
        strategy,
      })
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!payload) throw lastError instanceof Error ? lastError : new Error('Freqtrade pair_history 不可用')

  const indicators = indicatorsFromRows(rowsFromPairHistory(payload))
  const errors: string[] = []

  if (indicators.rsi.length === 0) errors.push('当前策略未输出 RSI 字段')
  if (indicators.macd.length === 0) errors.push('当前策略未输出 MACD 字段')

  return {
    ok: errors.length === 0,
    activeSymbol: activePair.symbol,
    timeframe: interval,
    indicators,
    source: {
      name: `Freqtrade · ${strategy}`,
      status: errors.length === 0 ? 'live' : 'partial',
      fetchedAt,
      errors,
    },
  }
}

export function emptyIndicatorSnapshot({
  activePair,
  interval,
  error,
}: {
  activePair: TradingPair
  interval: string
  error: unknown
}): IndicatorSnapshot {
  return {
    ok: false,
    activeSymbol: activePair.symbol,
    timeframe: interval,
    indicators: { rsi: [], macd: [] },
    source: {
      name: 'Freqtrade',
      status: 'offline',
      fetchedAt: Date.now(),
      errors: [error instanceof Error ? error.message : 'Freqtrade 指标源不可用'],
    },
  }
}

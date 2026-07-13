import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  createOkxSwapPair,
  mergeTradingPairs,
  TRADING_PAIRS,
  type TradingPair,
} from '@/lib/market-data'

const WATCHLIST_VERSION = 1
const DATA_DIR = process.env.HELIX_DASHBOARD_DATA_DIR
  ? resolve(process.env.HELIX_DASHBOARD_DATA_DIR)
  : join(process.cwd(), '.helix-data')
const WATCHLIST_FILE = join(DATA_DIR, 'watchlist.json')

type WatchlistRecord = {
  version: typeof WATCHLIST_VERSION
  instruments: string[]
  updatedAt: number
}

export type WatchlistSnapshot = {
  ok: true
  instruments: string[]
  pairs: TradingPair[]
  source: {
    name: 'Helix Watchlist'
    storage: 'file' | 'default'
    updatedAt: number
  }
}

const DEFAULT_INSTRUMENTS = TRADING_PAIRS.map((pair) => pair.instrumentId)

function normalizeInstrument(value: unknown) {
  if (typeof value !== 'string') return null
  return createOkxSwapPair(value)?.instrumentId ?? null
}

export function normalizeWatchlistInstruments(input: unknown) {
  const raw = Array.isArray(input) ? input : []
  const instruments = raw.map(normalizeInstrument).filter((item): item is string => item != null)
  return [...new Set(instruments)]
}

function pairsFromInstruments(instruments: string[]) {
  const pairs = instruments
    .map(createOkxSwapPair)
    .filter((pair): pair is TradingPair => pair != null)

  return mergeTradingPairs(pairs.length > 0 ? pairs : TRADING_PAIRS)
}

async function readWatchlistRecord(): Promise<WatchlistRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(WATCHLIST_FILE, 'utf8')) as Partial<WatchlistRecord>
    const instruments = normalizeWatchlistInstruments(parsed.instruments)
    if (instruments.length === 0) return null

    return {
      version: WATCHLIST_VERSION,
      instruments,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    }
  } catch {
    return null
  }
}

async function writeWatchlistRecord(instruments: string[]) {
  const record: WatchlistRecord = {
    version: WATCHLIST_VERSION,
    instruments: normalizeWatchlistInstruments(instruments),
    updatedAt: Date.now(),
  }
  if (record.instruments.length === 0) record.instruments = DEFAULT_INSTRUMENTS

  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(WATCHLIST_FILE, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return record
}

function snapshotFromRecord(record: WatchlistRecord | null): WatchlistSnapshot {
  const instruments = record?.instruments.length ? record.instruments : DEFAULT_INSTRUMENTS
  const pairs = pairsFromInstruments(instruments)
  return {
    ok: true,
    instruments: pairs.map((pair) => pair.instrumentId),
    pairs,
    source: {
      name: 'Helix Watchlist',
      storage: record ? 'file' : 'default',
      updatedAt: record?.updatedAt ?? 0,
    },
  }
}

export async function getWatchlistSnapshot() {
  return snapshotFromRecord(await readWatchlistRecord())
}

export async function replaceWatchlist(instruments: unknown) {
  const record = await writeWatchlistRecord(normalizeWatchlistInstruments(instruments))
  return snapshotFromRecord(record)
}

export async function addWatchlistInstrument(instrumentId: unknown) {
  const normalized = normalizeInstrument(instrumentId)
  if (!normalized) throw new Error('invalid instrumentId')

  const current = await readWatchlistRecord()
  const instruments = current?.instruments.length ? current.instruments : DEFAULT_INSTRUMENTS
  const record = await writeWatchlistRecord([...instruments, normalized])
  return snapshotFromRecord(record)
}

export async function removeWatchlistInstrument(instrumentId: unknown) {
  const normalized = normalizeInstrument(instrumentId)
  if (!normalized) throw new Error('invalid instrumentId')

  const current = await readWatchlistRecord()
  const instruments = current?.instruments.length ? current.instruments : DEFAULT_INSTRUMENTS
  const record = await writeWatchlistRecord(instruments.filter((item) => item !== normalized))
  return snapshotFromRecord(record)
}

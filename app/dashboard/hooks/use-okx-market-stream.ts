'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Candle, TradingPair } from '@/lib/market-data'

const OKX_PUBLIC_WS = 'wss://ws.okx.com:8443/ws/v5/public'
const OKX_BUSINESS_WS = 'wss://ws.okx.com:8443/ws/v5/business'
const PING_INTERVAL_MS = 25_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000

export type OkxStreamStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'

export type OkxTickerUpdate = {
  instrumentId: string
  price?: number
  open24h?: number
  high24h?: number
  low24h?: number
  volume24h?: number
  updatedAt: number
}

export type OkxCandleUpdate = Candle & {
  instrumentId: string
  confirm: boolean
}

type OkxStreamOptions = {
  pairs: TradingPair[]
  activePair?: TradingPair
  timeframe: string
  enabled?: boolean
  onTicker: (update: OkxTickerUpdate) => void
  onCandle: (update: OkxCandleUpdate) => void
}

type OkxMessage = {
  event?: string
  arg?: {
    channel?: string
    instId?: string
  }
  data?: unknown[]
}

type ManagedSocketOptions = {
  url: string
  args: Array<Record<string, string>>
  enabled: boolean
  onMessage: (message: OkxMessage) => void
  onStatus: (status: OkxStreamStatus) => void
  onSeen: () => void
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function okxCandleChannel(timeframe: string) {
  const normalized = timeframe.toLowerCase()
  const map: Record<string, string> = {
    '1m': 'candle1m',
    '3m': 'candle3m',
    '5m': 'candle5m',
    '15m': 'candle15m',
    '30m': 'candle30m',
    '1h': 'candle1H',
    '2h': 'candle2H',
    '4h': 'candle4H',
    '6h': 'candle6H',
    '12h': 'candle12H',
    '1d': 'candle1D',
    '1w': 'candle1W',
  }
  return map[normalized] ?? 'candle15m'
}

function parseJsonMessage(raw: string): OkxMessage | null {
  if (raw === 'pong') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as OkxMessage) : null
  } catch {
    return null
  }
}

function tickerUpdateFromRow(row: unknown): OkxTickerUpdate | null {
  if (!row || typeof row !== 'object') return null
  const ticker = row as Record<string, unknown>
  const instrumentId = typeof ticker.instId === 'string' ? ticker.instId : ''
  if (!instrumentId) return null

  return {
    instrumentId,
    price: numberFrom(ticker.last),
    open24h: numberFrom(ticker.open24h),
    high24h: numberFrom(ticker.high24h),
    low24h: numberFrom(ticker.low24h),
    volume24h: numberFrom(ticker.volCcy24h),
    updatedAt: numberFrom(ticker.ts) ?? Date.now(),
  }
}

function candleUpdateFromRow(instrumentId: string, row: unknown): OkxCandleUpdate | null {
  if (!Array.isArray(row)) return null

  const time = numberFrom(row[0])
  const open = numberFrom(row[1])
  const high = numberFrom(row[2])
  const low = numberFrom(row[3])
  const close = numberFrom(row[4])
  const volume = numberFrom(row[6]) ?? numberFrom(row[5])
  if (time == null || open == null || high == null || low == null || close == null || volume == null) return null

  return {
    instrumentId,
    time,
    open,
    high,
    low,
    close,
    volume,
    confirm: row[8] === '1',
  }
}

function useManagedOkxSocket({
  url,
  args,
  enabled,
  onMessage,
  onStatus,
  onSeen,
}: ManagedSocketOptions) {
  const onMessageRef = useRef(onMessage)
  const onStatusRef = useRef(onStatus)
  const onSeenRef = useRef(onSeen)
  const argsKey = useMemo(() => JSON.stringify(args), [args])

  useEffect(() => {
    onMessageRef.current = onMessage
    onStatusRef.current = onStatus
    onSeenRef.current = onSeen
  }, [onMessage, onSeen, onStatus])

  useEffect(() => {
    if (!enabled || args.length === 0) {
      onStatusRef.current('idle')
      return
    }

    let disposed = false
    let socket: WebSocket | null = null
    let pingTimer: number | undefined
    let reconnectTimer: number | undefined
    let attempt = 0

    const clearTimers = () => {
      if (pingTimer != null) window.clearInterval(pingTimer)
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
      pingTimer = undefined
      reconnectTimer = undefined
    }

    const connect = () => {
      clearTimers()
      onStatusRef.current(attempt === 0 ? 'connecting' : 'reconnecting')
      socket = new WebSocket(url)

      socket.addEventListener('open', () => {
        if (disposed || !socket) return
        attempt = 0
        onStatusRef.current('live')
        socket.send(JSON.stringify({ op: 'subscribe', args }))
        pingTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send('ping')
        }, PING_INTERVAL_MS)
      })

      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        if (event.data === 'ping') {
          socket?.send('pong')
          return
        }
        const message = parseJsonMessage(event.data)
        if (!message || message.event) return
        onSeenRef.current()
        onMessageRef.current(message)
      })

      socket.addEventListener('close', () => {
        clearTimers()
        if (disposed) return
        attempt += 1
        onStatusRef.current('reconnecting')
        reconnectTimer = window.setTimeout(connect, Math.min(RECONNECT_BASE_MS * attempt, RECONNECT_MAX_MS))
      })

      socket.addEventListener('error', () => {
        onStatusRef.current('error')
      })
    }

    connect()

    return () => {
      disposed = true
      clearTimers()
      socket?.close()
    }
  }, [args.length, argsKey, enabled, url])
}

export function useOkxMarketStream({
  pairs,
  activePair,
  timeframe,
  enabled = true,
  onTicker,
  onCandle,
}: OkxStreamOptions) {
  const [tickerStatus, setTickerStatus] = useState<OkxStreamStatus>('idle')
  const [candleStatus, setCandleStatus] = useState<OkxStreamStatus>('idle')
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null)

  const tickerArgs = useMemo(
    () =>
      pairs
        .map((pair) => pair.instrumentId)
        .filter(Boolean)
        .map((instId) => ({ channel: 'tickers', instId })),
    [pairs],
  )
  const candleArgs = useMemo(() => {
    if (!activePair?.instrumentId) return []
    return [{ channel: okxCandleChannel(timeframe), instId: activePair.instrumentId }]
  }, [activePair?.instrumentId, timeframe])

  useManagedOkxSocket({
    url: OKX_PUBLIC_WS,
    args: tickerArgs,
    enabled,
    onStatus: setTickerStatus,
    onSeen: () => setLastMessageAt(Date.now()),
    onMessage: (message) => {
      if (message.arg?.channel !== 'tickers') return
      for (const row of message.data ?? []) {
        const update = tickerUpdateFromRow(row)
        if (update) onTicker(update)
      }
    },
  })

  useManagedOkxSocket({
    url: OKX_BUSINESS_WS,
    args: candleArgs,
    enabled,
    onStatus: setCandleStatus,
    onSeen: () => setLastMessageAt(Date.now()),
    onMessage: (message) => {
      const instId = message.arg?.instId
      const channel = message.arg?.channel
      if (!instId || channel !== okxCandleChannel(timeframe)) return
      for (const row of message.data ?? []) {
        const update = candleUpdateFromRow(instId, row)
        if (update) onCandle(update)
      }
    },
  })

  return { tickerStatus, candleStatus, lastMessageAt }
}

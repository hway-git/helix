'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  MarketCandleUpdate,
  MarketStreamServerMessage,
  MarketStreamStatus,
  MarketStreamSubscription,
  MarketTickerUpdate,
  TradingPair,
} from '@helix/contracts/market'

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000

export type HelixStreamStatus = MarketStreamStatus
export type HelixTickerUpdate = MarketTickerUpdate
export type HelixCandleUpdate = MarketCandleUpdate

type HelixStreamOptions = {
  pairs: TradingPair[]
  activePair?: TradingPair
  timeframe: string
  provider?: string
  enabled?: boolean
  onTicker: (update: HelixTickerUpdate) => void
  onCandle: (update: HelixCandleUpdate) => void
}

function streamUrl() {
  const configured = process.env.NEXT_PUBLIC_HELIX_WS_URL?.trim()
  if (configured) return configured
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.hostname}:8787/ws/market`
}

function parseMessage(raw: string): MarketStreamServerMessage | null {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? value as MarketStreamServerMessage : null
  } catch {
    return null
  }
}

export function useHelixMarketStream({
  pairs,
  activePair,
  timeframe,
  provider = 'okx',
  enabled = true,
  onTicker,
  onCandle,
}: HelixStreamOptions) {
  const [tickerStatus, setTickerStatus] = useState<MarketStreamStatus>('idle')
  const [candleStatus, setCandleStatus] = useState<MarketStreamStatus>('idle')
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null)
  const onTickerRef = useRef(onTicker)
  const onCandleRef = useRef(onCandle)

  useEffect(() => {
    onTickerRef.current = onTicker
    onCandleRef.current = onCandle
  }, [onCandle, onTicker])

  const subscription = useMemo<MarketStreamSubscription>(() => ({
    type: 'subscribe',
    provider,
    instruments: pairs.map((pair) => pair.instrumentId).filter(Boolean),
    activeInstrumentId: activePair?.instrumentId,
    timeframe,
  }), [activePair?.instrumentId, pairs, provider, timeframe])
  const subscriptionKey = useMemo(() => JSON.stringify(subscription), [subscription])

  useEffect(() => {
    if (!enabled || subscription.instruments.length === 0) {
      setTickerStatus('idle')
      setCandleStatus('idle')
      return
    }

    let disposed = false
    let socket: WebSocket | null = null
    let reconnectTimer: number | undefined
    let attempt = 0

    const setBoth = (status: MarketStreamStatus) => {
      setTickerStatus(status)
      setCandleStatus(status)
    }

    const connect = () => {
      if (disposed) return
      setBoth(attempt === 0 ? 'connecting' : 'reconnecting')
      socket = new WebSocket(streamUrl())

      socket.addEventListener('open', () => {
        if (disposed || !socket) return
        attempt = 0
        socket.send(subscriptionKey)
      })
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        const message = parseMessage(event.data)
        if (!message) return
        if (message.type === 'status') {
          if (message.channel === 'ticker') setTickerStatus(message.status)
          else setCandleStatus(message.status)
          return
        }
        setLastMessageAt(Date.now())
        if (message.type === 'ticker') onTickerRef.current(message.data)
        else onCandleRef.current(message.data)
      })
      socket.addEventListener('close', () => {
        if (disposed) return
        attempt += 1
        setBoth('reconnecting')
        reconnectTimer = window.setTimeout(
          connect,
          Math.min(RECONNECT_BASE_MS * attempt, RECONNECT_MAX_MS),
        )
      })
      socket.addEventListener('error', () => setBoth('error'))
    }

    connect()
    return () => {
      disposed = true
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [enabled, subscription.instruments.length, subscriptionKey])

  return { tickerStatus, candleStatus, lastMessageAt }
}

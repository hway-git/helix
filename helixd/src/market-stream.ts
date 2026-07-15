import type { Server } from 'node:http'
import type {
  MarketCandleUpdate,
  MarketStreamServerMessage,
  MarketStreamStatus,
  MarketStreamSubscription,
  MarketTickerUpdate,
} from '@helix/contracts/market'
import WebSocket, { WebSocketServer, type RawData } from 'ws'

const PUBLIC_WS_URL = 'wss://ws.okx.com:8443/ws/v5/public'
const BUSINESS_WS_URL = 'wss://ws.okx.com:8443/ws/v5/business'
const PING_INTERVAL_MS = 25_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000
const MAX_INSTRUMENTS = 100

type StreamChannel = 'ticker' | 'candle'
type ProviderMessage = {
  event?: string
  code?: string
  msg?: string
  arg?: { channel?: string; instId?: string }
  data?: unknown[]
}

type UpstreamState = {
  channel: StreamChannel
  url: string
  args: Array<Record<string, string>>
  disposed: boolean
  attempt: number
  socket?: WebSocket
  pingTimer?: NodeJS.Timeout
  reconnectTimer?: NodeJS.Timeout
  onMessage: (message: ProviderMessage) => void
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function candleChannel(timeframe: string) {
  const channels: Record<string, string> = {
    '1m': 'candle1m', '3m': 'candle3m', '5m': 'candle5m', '15m': 'candle15m',
    '30m': 'candle30m', '1h': 'candle1H', '2h': 'candle2H', '4h': 'candle4H',
    '6h': 'candle6H', '12h': 'candle12H', '1d': 'candle1D', '1w': 'candle1W',
  }
  return channels[timeframe.toLowerCase()] ?? 'candle15m'
}

function tickerFromRow(row: unknown): MarketTickerUpdate | null {
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

function candleFromRow(instrumentId: string, row: unknown): MarketCandleUpdate | null {
  if (!Array.isArray(row)) return null
  const time = numberFrom(row[0])
  const open = numberFrom(row[1])
  const high = numberFrom(row[2])
  const low = numberFrom(row[3])
  const close = numberFrom(row[4])
  const volume = numberFrom(row[6]) ?? numberFrom(row[5])
  if (time == null || open == null || high == null || low == null || close == null || volume == null) return null
  return { instrumentId, time, open, high, low, close, volume, confirm: row[8] === '1' }
}

function parseProviderMessage(raw: RawData): ProviderMessage | null {
  const text = raw.toString()
  if (text === 'pong') return null
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' ? value as ProviderMessage : null
  } catch {
    return null
  }
}

function parseSubscription(raw: RawData): MarketStreamSubscription | null {
  try {
    const value = JSON.parse(raw.toString()) as Partial<MarketStreamSubscription>
    if (value.type !== 'subscribe' || !Array.isArray(value.instruments) || typeof value.timeframe !== 'string') return null
    const instruments = value.instruments
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().toUpperCase())
      .filter((item) => /^[A-Z0-9]+-[A-Z0-9]+-SWAP$/.test(item))
      .slice(0, MAX_INSTRUMENTS)
    return {
      type: 'subscribe',
      provider: typeof value.provider === 'string' ? value.provider : 'okx',
      instruments: [...new Set(instruments)],
      activeInstrumentId: typeof value.activeInstrumentId === 'string'
        ? value.activeInstrumentId.trim().toUpperCase()
        : undefined,
      timeframe: value.timeframe,
    }
  } catch {
    return null
  }
}

class MarketStreamSession {
  private upstreams: UpstreamState[] = []

  constructor(private readonly client: WebSocket) {
    this.status('ticker', 'idle')
    this.status('candle', 'idle')
  }

  subscribe(subscription: MarketStreamSubscription) {
    this.closeUpstreams()
    if ((subscription.provider ?? 'okx').toLowerCase() !== 'okx') {
      this.status('ticker', 'error', '不支持该行情 provider')
      this.status('candle', 'error', '不支持该行情 provider')
      return
    }

    const tickerArgs = subscription.instruments.map((instId) => ({ channel: 'tickers', instId }))
    const activeInstrumentId = subscription.activeInstrumentId
    const activeIsValid = activeInstrumentId && subscription.instruments.includes(activeInstrumentId)
    const channel = candleChannel(subscription.timeframe)

    if (tickerArgs.length > 0) {
      this.upstreams.push(this.openUpstream('ticker', PUBLIC_WS_URL, tickerArgs, (message) => {
        if (message.arg?.channel !== 'tickers') return
        for (const row of message.data ?? []) {
          const update = tickerFromRow(row)
          if (update) this.send({ type: 'ticker', data: update })
        }
      }))
    } else {
      this.status('ticker', 'idle')
    }

    if (activeIsValid) {
      this.upstreams.push(this.openUpstream(
        'candle', BUSINESS_WS_URL, [{ channel, instId: activeInstrumentId }],
        (message) => {
          if (message.arg?.channel !== channel || message.arg.instId !== activeInstrumentId) return
          for (const row of message.data ?? []) {
            const update = candleFromRow(activeInstrumentId, row)
            if (update) this.send({ type: 'candle', data: update })
          }
        },
      ))
    } else {
      this.status('candle', 'idle')
    }
  }

  dispose() {
    this.closeUpstreams()
  }

  private openUpstream(
    channel: StreamChannel,
    url: string,
    args: Array<Record<string, string>>,
    onMessage: (message: ProviderMessage) => void,
  ) {
    const state: UpstreamState = { channel, url, args, disposed: false, attempt: 0, onMessage }
    this.connect(state)
    return state
  }

  private connect(state: UpstreamState) {
    if (state.disposed) return
    this.clearTimers(state)
    this.status(state.channel, state.attempt === 0 ? 'connecting' : 'reconnecting')

    const socket = new WebSocket(state.url)
    state.socket = socket
    socket.on('open', () => {
      if (state.disposed || state.socket !== socket) return
      state.attempt = 0
      this.status(state.channel, 'live')
      socket.send(JSON.stringify({ op: 'subscribe', args: state.args }))
      state.pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send('ping')
      }, PING_INTERVAL_MS)
    })
    socket.on('message', (raw) => {
      const message = parseProviderMessage(raw)
      if (!message) return
      if (message.event === 'error') {
        const detail = [message.code, message.msg].filter(Boolean).join(' · ') || '上游行情订阅失败'
        this.status(state.channel, 'error', detail)
        socket.close()
        return
      }
      if (!message.event) state.onMessage(message)
    })
    socket.on('close', () => {
      this.clearTimers(state)
      if (state.disposed || state.socket !== socket) return
      state.attempt += 1
      this.status(state.channel, 'reconnecting')
      state.reconnectTimer = setTimeout(
        () => this.connect(state),
        Math.min(RECONNECT_BASE_MS * state.attempt, RECONNECT_MAX_MS),
      )
    })
    socket.on('error', (error) => this.status(state.channel, 'error', error.message))
  }

  private clearTimers(state: UpstreamState) {
    if (state.pingTimer) clearInterval(state.pingTimer)
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    state.pingTimer = undefined
    state.reconnectTimer = undefined
  }

  private closeUpstreams() {
    for (const state of this.upstreams) {
      state.disposed = true
      this.clearTimers(state)
      state.socket?.close()
    }
    this.upstreams = []
  }

  private status(channel: StreamChannel, status: MarketStreamStatus, error?: string) {
    this.send({ type: 'status', channel, status, error })
  }

  private send(message: MarketStreamServerMessage) {
    if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(message))
  }
}

export function attachMarketWebSocket(server: Server) {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    if (url.pathname !== '/ws/market') {
      socket.destroy()
      return
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request)
    })
  })

  webSocketServer.on('connection', (client) => {
    const session = new MarketStreamSession(client)
    client.on('message', (raw) => {
      const subscription = parseSubscription(raw)
      if (subscription) session.subscribe(subscription)
    })
    client.on('close', () => session.dispose())
    client.on('error', () => session.dispose())
  })
  return webSocketServer
}

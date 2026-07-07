// 模拟行情数据生成器 —— 纯前端演示用，非真实数据

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
  price: number
  change: number // 24h 涨跌幅 %
  volume: string
  sparkline: number[]
}

export type FundingRate = {
  symbol: string
  rate: number // %
  interval: string
  nextIn: string
}

export type NewsItem = {
  id: string
  source: string
  title: string
  time: string
  tag: '利好' | '利空' | '中性'
}

export type StrategyProfile = {
  id: string
  name: string
  symbol: string
  timeframe: string
  mode: '监控' | '实盘' | '停用'
  winRate: number
  maxDrawdown: number
}

export type StrategySignal = {
  id: string
  symbol: string
  side: 'long' | 'short' | 'flat'
  confidence: number
  source: string
  age: string
}

// 简单的可复现伪随机数（基于种子），避免 SSR/CSR 不一致
function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateCandles(count: number, seed = 42, startPrice = 64000): Candle[] {
  const rand = mulberry32(seed)
  const candles: Candle[] = []
  let price = startPrice
  const now = Date.now()
  for (let i = count - 1; i >= 0; i--) {
    const drift = (rand() - 0.48) * price * 0.012
    const open = price
    const close = Math.max(1, open + drift)
    const wick = price * 0.006 * rand()
    const high = Math.max(open, close) + wick
    const low = Math.min(open, close) - wick
    const volume = 50 + rand() * 950
    candles.push({
      time: now - i * 60_000,
      open,
      high,
      low,
      close,
      volume,
    })
    price = close
  }
  return candles
}

// RSI 计算
export function computeRSI(candles: Candle[], period = 14): number[] {
  const rsi: number[] = []
  let gains = 0
  let losses = 0
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close
    if (i <= period) {
      if (diff >= 0) gains += diff
      else losses -= diff
      rsi.push(NaN)
      if (i === period) {
        const rs = gains / (losses || 1e-9)
        rsi[rsi.length - 1] = 100 - 100 / (1 + rs)
        gains /= period
        losses /= period
      }
      continue
    }
    const gain = diff >= 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    gains = (gains * (period - 1) + gain) / period
    losses = (losses * (period - 1) + loss) / period
    const rs = gains / (losses || 1e-9)
    rsi.push(100 - 100 / (1 + rs))
  }
  rsi.unshift(NaN)
  return rsi
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  let prev = values[0]
  values.forEach((v, i) => {
    if (i === 0) {
      out.push(v)
    } else {
      prev = v * k + prev * (1 - k)
      out.push(prev)
    }
  })
  return out
}

export type MacdPoint = { macd: number; signal: number; hist: number }

export function computeMACD(candles: Candle[], fast = 12, slow = 26, signalP = 9): MacdPoint[] {
  const closes = candles.map((c) => c.close)
  const emaFast = ema(closes, fast)
  const emaSlow = ema(closes, slow)
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i])
  const signalLine = ema(macdLine, signalP)
  return macdLine.map((m, i) => ({
    macd: m,
    signal: signalLine[i],
    hist: m - signalLine[i],
  }))
}

export const TRADING_PAIRS: TradingPair[] = [
  { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', price: 64218.5, change: 2.34, volume: '1.28B', sparkline: spark(1) },
  { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', price: 3142.88, change: 3.71, volume: '842M', sparkline: spark(2) },
  { symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', price: 148.22, change: -1.42, volume: '512M', sparkline: spark(3) },
  { symbol: 'BNB/USDT', base: 'BNB', quote: 'USDT', price: 592.1, change: 0.88, volume: '288M', sparkline: spark(4) },
  { symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', price: 0.5231, change: -2.65, volume: '196M', sparkline: spark(5) },
  { symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', price: 0.1442, change: 5.12, volume: '174M', sparkline: spark(6) },
  { symbol: 'AVAX/USDT', base: 'AVAX', quote: 'USDT', price: 36.74, change: -0.44, volume: '98M', sparkline: spark(7) },
  { symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', price: 14.08, change: 1.93, volume: '86M', sparkline: spark(8) },
  { symbol: 'TON/USDT', base: 'TON', quote: 'USDT', price: 7.21, change: 4.05, volume: '72M', sparkline: spark(9) },
  { symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', price: 0.4517, change: -3.18, volume: '64M', sparkline: spark(10) },
]

function spark(seed: number): number[] {
  const rand = mulberry32(seed * 7)
  const out: number[] = []
  let v = 50
  for (let i = 0; i < 24; i++) {
    v += (rand() - 0.5) * 12
    out.push(v)
  }
  return out
}

export const FUNDING_RATES: FundingRate[] = [
  { symbol: 'BTC', rate: 0.0104, interval: '8h', nextIn: '02:14:08' },
  { symbol: 'ETH', rate: 0.0087, interval: '8h', nextIn: '02:14:08' },
  { symbol: 'SOL', rate: -0.0052, interval: '8h', nextIn: '02:14:08' },
  { symbol: 'BNB', rate: 0.0031, interval: '8h', nextIn: '02:14:08' },
  { symbol: 'DOGE', rate: 0.0219, interval: '8h', nextIn: '02:14:08' },
  { symbol: 'XRP', rate: -0.0138, interval: '8h', nextIn: '02:14:08' },
]

export const NEWS: NewsItem[] = [
  { id: 'n1', source: 'CoinDesk', title: '现货比特币 ETF 单日净流入创近三个月新高', time: '2 分钟前', tag: '利好' },
  { id: 'n2', source: 'The Block', title: '美联储会议纪要暗示年内或有一次降息', time: '11 分钟前', tag: '中性' },
  { id: 'n3', source: 'Cointelegraph', title: '某大型交易所暂停部分山寨币提现，社区担忧流动性', time: '26 分钟前', tag: '利空' },
  { id: 'n4', source: 'Odaily', title: '以太坊坎昆升级后 Layer2 手续费下降超 90%', time: '43 分钟前', tag: '利好' },
  { id: 'n5', source: 'Wu Blockchain', title: '链上数据显示巨鲸地址近 24 小时增持约 4200 枚 BTC', time: '1 小时前', tag: '利好' },
  { id: 'n6', source: 'Reuters', title: '欧盟 MiCA 稳定币新规将于下月正式生效', time: '2 小时前', tag: '中性' },
]

export const STRATEGIES: StrategyProfile[] = [
  { id: 'trend-15m', name: 'Trend Rider', symbol: 'BTC/USDT', timeframe: '15m', mode: '监控', winRate: 58.4, maxDrawdown: 7.8 },
  { id: 'mean-1h', name: 'Mean Revert', symbol: 'ETH/USDT', timeframe: '1H', mode: '实盘', winRate: 54.1, maxDrawdown: 5.2 },
  { id: 'breakout-5m', name: 'Breakout Scalper', symbol: 'SOL/USDT', timeframe: '5m', mode: '停用', winRate: 49.6, maxDrawdown: 11.3 },
]

export const SIGNALS: StrategySignal[] = [
  { id: 's1', symbol: 'BTC/USDT', side: 'long', confidence: 74, source: 'Trend Rider', age: '18s' },
  { id: 's2', symbol: 'ETH/USDT', side: 'flat', confidence: 61, source: 'Mean Revert', age: '42s' },
  { id: 's3', symbol: 'SOL/USDT', side: 'short', confidence: 69, source: 'Breakout Scalper', age: '1m' },
]

export function formatPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (p >= 1) return p.toFixed(2)
  return p.toFixed(4)
}

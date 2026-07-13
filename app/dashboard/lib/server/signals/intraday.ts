import type {
  Candle,
  IntradayConfidenceLevel,
  IntradaySignalDirection,
  IntradaySignalTimeframe,
  IntradayTimeframeAnalysis,
  IntradayTradeSignal,
} from '../../market-data'
import {
  calculateAtrSeries,
  calculateMacdSeries,
  calculateRsiSeries,
  type NullableSeries,
} from '../technical-indicators/calculate'

const TIMEFRAMES: IntradaySignalTimeframe[] = ['5m', '15m', '1h']
const ENTRY_TIMEFRAMES: Array<Exclude<IntradaySignalTimeframe, '1h'>> = ['15m', '5m']
const MIN_BARS = 80
const CROSS_LOOKBACK = 3
const PA_EVENT_LOOKBACK = 3
const DIVERGENCE_MAX_AGE = 24
const DIVERGENCE_TRIGGER_MAX_AGE = 6
const RETEST_WINDOW = 6
const ACTIONABLE_SCORE = 55
const MAX_STOP_DISTANCE_ATR = 3
const MAX_ENTRY_DRIFT_ATR = 1
const TIMEFRAME_MS: Record<IntradaySignalTimeframe, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
}
const BIAS_WEIGHT = {
  structure: 8,
  macdState: 10,
  macdCross: 6,
  macdDivergence: 6,
  minimum: 12,
  minimumDifference: 4,
  maximum: 32,
} as const
const SIGNAL_WEIGHT = {
  biasCap: 30,
  hourlyRsiConflict: 10,
  macdCross: 10,
  macdCrossConflict: 8,
  macdDivergence: 14,
  macdDivergenceContext: 7,
  macdDivergenceConflict: 12,
  macdDivergenceConflictContext: 6,
  rsiRecovery: 8,
  rsiRecoveryConflict: 6,
  rsiExtreme: 4,
  rsiExtremeConflict: 5,
  priceActionEvent: 14,
  priceActionConflict: 12,
  structureRelation: 3,
  macdMomentum: 4,
  volumeExpansion: 4,
  timeframeConfluence: 8,
} as const

type SwingSide = 'high' | 'low'
type SwingPoint = {
  side: SwingSide
  index: number
  knownAtIndex: number
  price: number
}
type DirectionalEvent = 'bullish' | 'bearish' | 'none'
type TimedEvent = { direction: DirectionalEvent; index?: number }
type PriceActionEvent = {
  type: IntradayTimeframeAnalysis['priceAction']['event']
  index: number
  level?: number
}

export type IntradaySignalInput = {
  tickSize: number
  candles: Record<IntradaySignalTimeframe, Candle[]>
}

export type IntradaySignalResult = {
  signal: IntradayTradeSignal
  timeframes: Partial<Record<IntradaySignalTimeframe, IntradayTimeframeAnalysis>>
}

function lastNumber(series: NullableSeries) {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const value = series[index]
    if (value != null && Number.isFinite(value)) return value
  }
  return null
}

function validClosedCandles(timeframe: IntradaySignalTimeframe, candles: Candle[]) {
  if (candles.length < MIN_BARS) return false
  const interval = TIMEFRAME_MS[timeframe]
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    if (!Number.isFinite(candle.time)
      || !Number.isFinite(candle.open)
      || !Number.isFinite(candle.high)
      || !Number.isFinite(candle.low)
      || !Number.isFinite(candle.close)
      || !Number.isFinite(candle.volume)
      || candle.time <= 0
      || candle.low > Math.min(candle.open, candle.close)
      || candle.high < Math.max(candle.open, candle.close)
      || candle.volume < 0) {
      return false
    }
    if (index > 0 && candle.time - candles[index - 1].time !== interval) return false
  }
  return true
}

export function findConfirmedSwings(
  candles: Candle[],
  leftBars = 2,
  rightBars = 2,
  evaluationIndex = candles.length - 1,
) {
  const swings: SwingPoint[] = []
  const lastCandidate = Math.min(evaluationIndex - rightBars, candles.length - rightBars - 1)

  for (let index = leftBars; index <= lastCandidate; index += 1) {
    let swingHigh = true
    let swingLow = true
    for (let offset = 1; offset <= leftBars; offset += 1) {
      swingHigh = swingHigh && candles[index].high > candles[index - offset].high
      swingLow = swingLow && candles[index].low < candles[index - offset].low
    }
    for (let offset = 1; offset <= rightBars; offset += 1) {
      swingHigh = swingHigh && candles[index].high > candles[index + offset].high
      swingLow = swingLow && candles[index].low < candles[index + offset].low
    }
    if (swingHigh) swings.push({ side: 'high', index, knownAtIndex: index + rightBars, price: candles[index].high })
    if (swingLow) swings.push({ side: 'low', index, knownAtIndex: index + rightBars, price: candles[index].low })
  }

  return swings.sort((left, right) => left.knownAtIndex - right.knownAtIndex || left.index - right.index)
}

function recentCross(macd: number[], signal: number[], lookback = CROSS_LOOKBACK): TimedEvent {
  const start = Math.max(1, macd.length - lookback)
  for (let index = macd.length - 1; index >= start; index -= 1) {
    if (macd[index - 1] <= signal[index - 1] && macd[index] > signal[index]) {
      return { direction: 'bullish', index }
    }
    if (macd[index - 1] >= signal[index - 1] && macd[index] < signal[index]) {
      return { direction: 'bearish', index }
    }
  }
  return { direction: 'none' }
}

function recentRsiRecovery(rsi: NullableSeries, lookback = CROSS_LOOKBACK): TimedEvent {
  const start = Math.max(1, rsi.length - lookback)
  for (let index = rsi.length - 1; index >= start; index -= 1) {
    const previous = rsi[index - 1]
    const current = rsi[index]
    if (previous == null || current == null) continue
    if (previous <= 30 && current > 30) return { direction: 'bullish', index }
    if (previous >= 70 && current < 70) return { direction: 'bearish', index }
  }
  return { direction: 'none' }
}

function latestStructureRelation(swings: SwingPoint[], side: SwingSide, epsilon: number) {
  const sameSide = swings.filter((swing) => swing.side === side)
  if (sameSide.length < 2) return 'unknown' as const
  const previous = sameSide.at(-2)!
  const current = sameSide.at(-1)!
  if (current.price > previous.price + epsilon) return 'higher' as const
  if (current.price < previous.price - epsilon) return 'lower' as const
  return 'equal' as const
}

function divergence(
  swings: SwingPoint[],
  histogram: number[],
  lastIndex: number,
  epsilon: number,
): TimedEvent {
  const candidates: Array<{ direction: Exclude<DirectionalEvent, 'none'>; index: number }> = []

  for (const side of ['low', 'high'] as const) {
    const sameSide = swings.filter((swing) => swing.side === side)
    for (let index = sameSide.length - 1; index >= 1; index -= 1) {
      const current = sameSide[index]
      const previous = sameSide[index - 1]
      if (lastIndex - current.knownAtIndex > DIVERGENCE_MAX_AGE) break

      const currentHistogram = histogram[current.index]
      const previousHistogram = histogram[previous.index]
      if (side === 'low'
        && current.price < previous.price - epsilon
        && currentHistogram < 0
        && previousHistogram < 0
        && currentHistogram > previousHistogram) {
        candidates.push({ direction: 'bullish', index: current.knownAtIndex })
        break
      }
      if (side === 'high'
        && current.price > previous.price + epsilon
        && currentHistogram > 0
        && previousHistogram > 0
        && currentHistogram < previousHistogram) {
        candidates.push({ direction: 'bearish', index: current.knownAtIndex })
        break
      }
    }
  }

  const latest = candidates.sort((left, right) => right.index - left.index)[0]
  return latest ?? { direction: 'none' }
}

function latestSwingAt(swings: SwingPoint[], side: SwingSide, index: number) {
  for (let cursor = swings.length - 1; cursor >= 0; cursor -= 1) {
    const swing = swings[cursor]
    if (swing.side === side && swing.knownAtIndex <= index) return swing
  }
  return undefined
}

function breakAt(
  candles: Candle[],
  swings: SwingPoint[],
  index: number,
  direction: 'bullish' | 'bearish',
  epsilon: number,
) {
  if (index < 1) return undefined
  const swing = latestSwingAt(swings, direction === 'bullish' ? 'high' : 'low', index)
  if (!swing) return undefined

  if (direction === 'bullish'
    && candles[index - 1].close <= swing.price + epsilon
    && candles[index].close > swing.price + epsilon) {
    return swing.price
  }
  if (direction === 'bearish'
    && candles[index - 1].close >= swing.price - epsilon
    && candles[index].close < swing.price - epsilon) {
    return swing.price
  }
  return undefined
}

function retestAt(
  candles: Candle[],
  swings: SwingPoint[],
  index: number,
  direction: 'bullish' | 'bearish',
  epsilon: number,
) {
  let breakIndex: number | undefined
  let level: number | undefined
  for (let cursor = index - 1; cursor >= Math.max(1, index - RETEST_WINDOW); cursor -= 1) {
    const candidate = breakAt(candles, swings, cursor, direction, epsilon)
    if (candidate != null) {
      breakIndex = cursor
      level = candidate
      break
    }
  }
  if (breakIndex == null || level == null) return undefined

  for (let cursor = breakIndex + 1; cursor <= index; cursor += 1) {
    const matched = direction === 'bullish'
      ? candles[cursor].low <= level + epsilon && candles[cursor].close > level + epsilon
      : candles[cursor].high >= level - epsilon && candles[cursor].close < level - epsilon
    if (matched) return cursor === index ? level : undefined
  }
  return undefined
}

function directionalPaEvent(
  candles: Candle[],
  swings: SwingPoint[],
  index: number,
  direction: 'bullish' | 'bearish',
  epsilon: number,
): PriceActionEvent | null {
  const breakLevel = breakAt(candles, swings, index, direction, epsilon)
  if (breakLevel != null) {
    return { type: direction === 'bullish' ? 'bullish-break' : 'bearish-break', index, level: breakLevel }
  }

  const support = latestSwingAt(swings, 'low', index)
  const resistance = latestSwingAt(swings, 'high', index)
  const candle = candles[index]
  const level = direction === 'bullish' ? support?.price : resistance?.price
  if (level == null) return null

  const swept = direction === 'bullish'
    ? candle.low < level - epsilon && candle.close >= level - epsilon
    : candle.high > level + epsilon && candle.close <= level + epsilon
  if (swept) {
    return { type: direction === 'bullish' ? 'bullish-sweep' : 'bearish-sweep', index, level }
  }

  const retestLevel = retestAt(candles, swings, index, direction, epsilon)
  if (retestLevel != null) {
    return { type: direction === 'bullish' ? 'bullish-retest' : 'bearish-retest', index, level: retestLevel }
  }

  const rejected = direction === 'bullish'
    ? candle.low <= level + epsilon && candle.close > level + epsilon
    : candle.high >= level - epsilon && candle.close < level - epsilon
  if (rejected) {
    return { type: direction === 'bullish' ? 'bullish-rejection' : 'bearish-rejection', index, level }
  }
  return null
}

function paEventAt(candles: Candle[], swings: SwingPoint[], index: number, epsilon: number): PriceActionEvent {
  const bullish = directionalPaEvent(candles, swings, index, 'bullish', epsilon)
  const bearish = directionalPaEvent(candles, swings, index, 'bearish', epsilon)
  if (bullish && bearish) return { type: 'ambiguous', index }
  return bullish ?? bearish ?? { type: 'none', index }
}

function recentPaEvent(candles: Candle[], swings: SwingPoint[], epsilon: number) {
  const lastIndex = candles.length - 1
  for (let index = lastIndex; index >= Math.max(0, lastIndex - PA_EVENT_LOOKBACK + 1); index -= 1) {
    const event = paEventAt(candles, swings, index, epsilon)
    if (event.type !== 'none') return event
  }
  return { type: 'none', index: lastIndex } as PriceActionEvent
}

function analyzeTimeframe(
  timeframe: IntradaySignalTimeframe,
  candles: Candle[],
  tickSize: number,
): IntradayTimeframeAnalysis | null {
  if (!validClosedCandles(timeframe, candles)) return null

  const lastIndex = candles.length - 1
  const macd = calculateMacdSeries(candles)
  const rsi = calculateRsiSeries(candles)
  const atr = calculateAtrSeries(candles)
  const rsiValue = lastNumber(rsi)
  const atrValue = lastNumber(atr)
  if (rsiValue == null || atrValue == null || atrValue <= 0) return null

  const swings = findConfirmedSwings(candles)
  const cross = recentCross(macd.macd, macd.signal)
  const divergenceEvent = divergence(swings, macd.histogram, lastIndex, tickSize)
  const recovery = recentRsiRecovery(rsi)
  const paEvent = recentPaEvent(candles, swings, tickSize)
  const latest = candles[lastIndex]
  const volumeWindow = candles.slice(-20)
  const averageVolume = volumeWindow.reduce((sum, candle) => sum + candle.volume, 0) / volumeWindow.length
  const volumeRatio = averageVolume > 0 ? latest.volume / averageVolume : 0

  return {
    timeframe,
    latestTime: latest.time + TIMEFRAME_MS[timeframe],
    close: latest.close,
    atr: atrValue,
    macd: {
      value: macd.macd[lastIndex],
      signal: macd.signal[lastIndex],
      histogram: macd.histogram[lastIndex],
      momentum: macd.histogram[lastIndex] > 0 ? 'bullish' : macd.histogram[lastIndex] < 0 ? 'bearish' : 'mixed',
      cross: cross.direction,
      crossBarsAgo: cross.index == null ? undefined : lastIndex - cross.index,
      divergence: divergenceEvent.direction,
      divergenceBarsAgo: divergenceEvent.index == null ? undefined : lastIndex - divergenceEvent.index,
    },
    rsi: {
      value: rsiValue,
      state: rsiValue >= 70 ? 'overbought' : rsiValue <= 30 ? 'oversold' : 'neutral',
      recovery: recovery.direction,
      recoveryBarsAgo: recovery.index == null ? undefined : lastIndex - recovery.index,
    },
    volume: {
      value: latest.volume,
      average: averageVolume,
      ratio: volumeRatio,
      state: volumeRatio >= 1.2 ? 'expanding' : volumeRatio < 0.7 ? 'weak' : 'normal',
    },
    priceAction: {
      structureHigh: latestStructureRelation(swings, 'high', tickSize),
      structureLow: latestStructureRelation(swings, 'low', tickSize),
      event: paEvent.type,
      eventBarsAgo: paEvent.type === 'none' ? undefined : lastIndex - paEvent.index,
      eventLevel: paEvent.level,
      latestSwingHigh: latestSwingAt(swings, 'high', lastIndex)?.price,
      latestSwingLow: latestSwingAt(swings, 'low', lastIndex)?.price,
    },
  }
}

function buildBias(analysis: IntradayTimeframeAnalysis) {
  let longScore = 0
  let shortScore = 0
  const longLogic: string[] = []
  const shortLogic: string[] = []

  if (analysis.priceAction.structureHigh === 'higher') {
    longScore += BIAS_WEIGHT.structure
    longLogic.push('1h 确认更高高点')
  } else if (analysis.priceAction.structureHigh === 'lower') {
    shortScore += BIAS_WEIGHT.structure
    shortLogic.push('1h 确认更低高点')
  }
  if (analysis.priceAction.structureLow === 'higher') {
    longScore += BIAS_WEIGHT.structure
    longLogic.push('1h 确认更高低点')
  } else if (analysis.priceAction.structureLow === 'lower') {
    shortScore += BIAS_WEIGHT.structure
    shortLogic.push('1h 确认更低低点')
  }

  if (analysis.macd.value > analysis.macd.signal && analysis.macd.histogram > 0) {
    longScore += BIAS_WEIGHT.macdState
    longLogic.push('1h MACD 位于信号线上方且柱体为正')
  } else if (analysis.macd.value < analysis.macd.signal && analysis.macd.histogram < 0) {
    shortScore += BIAS_WEIGHT.macdState
    shortLogic.push('1h MACD 位于信号线下方且柱体为负')
  }
  if (analysis.macd.cross === 'bullish') {
    longScore += BIAS_WEIGHT.macdCross
    longLogic.push(`1h MACD ${analysis.macd.crossBarsAgo ?? 0} 根 K 内金叉`)
  } else if (analysis.macd.cross === 'bearish') {
    shortScore += BIAS_WEIGHT.macdCross
    shortLogic.push(`1h MACD ${analysis.macd.crossBarsAgo ?? 0} 根 K 内死叉`)
  }
  if (analysis.macd.divergence === 'bullish') {
    longScore += BIAS_WEIGHT.macdDivergence
    longLogic.push('1h 出现 MACD 底背离')
  } else if (analysis.macd.divergence === 'bearish') {
    shortScore += BIAS_WEIGHT.macdDivergence
    shortLogic.push('1h 出现 MACD 顶背离')
  }

  const winning = Math.max(longScore, shortScore)
  const difference = Math.abs(longScore - shortScore)
  const side: IntradaySignalDirection = winning >= BIAS_WEIGHT.minimum && difference >= BIAS_WEIGHT.minimumDifference
    ? longScore > shortScore ? 'long' : 'short'
    : 'neutral'

  return {
    side,
    rawScore: side === 'long' ? longScore : side === 'short' ? shortScore : winning,
    confidence: Math.min(100, Math.round((winning / BIAS_WEIGHT.maximum) * 100)),
    logic: side === 'long' ? longLogic : side === 'short' ? shortLogic : [],
  }
}

function paDirection(event: IntradayTimeframeAnalysis['priceAction']['event']): DirectionalEvent {
  if (event.startsWith('bullish-')) return 'bullish'
  if (event.startsWith('bearish-')) return 'bearish'
  return 'none'
}

function paLogicLabel(event: IntradayTimeframeAnalysis['priceAction']['event']) {
  const labels: Record<IntradayTimeframeAnalysis['priceAction']['event'], string> = {
    'bullish-break': '向上突破',
    'bearish-break': '向下突破',
    'bullish-retest': '多头回踩',
    'bearish-retest': '空头回踩',
    'bullish-rejection': '支撑拒绝',
    'bearish-rejection': '阻力拒绝',
    'bullish-sweep': '下扫收回',
    'bearish-sweep': '上扫收回',
    ambiguous: '柱内歧义',
    none: '无事件',
  }
  return labels[event]
}

function confidenceLevel(score: number): IntradayConfidenceLevel {
  if (score >= 85) return 'very-high'
  if (score >= 70) return 'high'
  if (score >= 55) return 'medium'
  return 'low'
}

function barsAgoForAlignedTrigger(analysis: IntradayTimeframeAnalysis, direction: Exclude<DirectionalEvent, 'none'>) {
  const ages: number[] = []
  if (analysis.macd.cross === direction && analysis.macd.crossBarsAgo != null) ages.push(analysis.macd.crossBarsAgo)
  if (analysis.macd.divergence === direction
    && analysis.macd.divergenceBarsAgo != null
    && analysis.macd.divergenceBarsAgo <= DIVERGENCE_TRIGGER_MAX_AGE) {
    ages.push(analysis.macd.divergenceBarsAgo)
  }
  if (analysis.rsi.recovery === direction && analysis.rsi.recoveryBarsAgo != null) ages.push(analysis.rsi.recoveryBarsAgo)
  if (paDirection(analysis.priceAction.event) === direction && analysis.priceAction.eventBarsAgo != null) {
    ages.push(analysis.priceAction.eventBarsAgo)
  }
  return ages.length > 0 ? Math.min(...ages) : undefined
}

function volumeRatioAt(candles: Candle[], index: number) {
  const window = candles.slice(Math.max(0, index - 19), index + 1)
  const average = window.reduce((sum, candle) => sum + candle.volume, 0) / window.length
  return average > 0 ? candles[index].volume / average : 0
}

function roundToTick(value: number, tickSize: number, mode: 'nearest' | 'down' | 'up' = 'nearest') {
  const scaled = value / tickSize
  const rounded = mode === 'down' ? Math.floor(scaled) : mode === 'up' ? Math.ceil(scaled) : Math.round(scaled)
  return Number((rounded * tickSize).toPrecision(14))
}

function fallbackStopBase(candles: Candle[], side: Exclude<IntradaySignalDirection, 'neutral'>) {
  const window = candles.slice(-10)
  return side === 'long'
    ? Math.min(...window.map((candle) => candle.low))
    : Math.max(...window.map((candle) => candle.high))
}

function insufficientSignal(): IntradayTradeSignal {
  return {
    status: 'insufficient-data',
    side: 'neutral',
    bias: { side: 'neutral', confidence: 0, logic: [] },
    confidence: 0,
    confidenceLevel: 'low',
    logic: [],
    warnings: ['5m、15m 或 1h 已闭合 K 线不足，暂不生成信号'],
  }
}

export function buildIntradaySignal(input: IntradaySignalInput): IntradaySignalResult {
  if (!Number.isFinite(input.tickSize) || input.tickSize <= 0) {
    return { signal: insufficientSignal(), timeframes: {} }
  }

  const timeframes: Partial<Record<IntradaySignalTimeframe, IntradayTimeframeAnalysis>> = {}
  for (const timeframe of TIMEFRAMES) {
    const analysis = analyzeTimeframe(timeframe, input.candles[timeframe], input.tickSize)
    if (analysis) timeframes[timeframe] = analysis
  }

  const hourly = timeframes['1h']
  const fiveMinute = timeframes['5m']
  const fifteenMinute = timeframes['15m']
  if (!hourly || !fiveMinute || !fifteenMinute) {
    return { signal: insufficientSignal(), timeframes }
  }

  const bias = buildBias(hourly)
  const warnings: string[] = []
  if (bias.side === 'neutral') warnings.push('1h 多空证据不足，等待方向确认')
  if (bias.side === 'long' && hourly.rsi.state === 'overbought') warnings.push('1h RSI 已超买，多单避免追高')
  if (bias.side === 'short' && hourly.rsi.state === 'oversold') warnings.push('1h RSI 已超卖，空单避免追空')

  let score = Math.min(SIGNAL_WEIGHT.biasCap, bias.rawScore)
  if (bias.side === 'long' && hourly.rsi.state === 'overbought') score -= SIGNAL_WEIGHT.hourlyRsiConflict
  if (bias.side === 'short' && hourly.rsi.state === 'oversold') score -= SIGNAL_WEIGHT.hourlyRsiConflict
  const logic = [...bias.logic]
  const alignedDirection = bias.side === 'long' ? 'bullish' : bias.side === 'short' ? 'bearish' : 'none'
  const oppositeDirection = alignedDirection === 'bullish' ? 'bearish' : alignedDirection === 'bearish' ? 'bullish' : 'none'
  const alignedTimeframes: Array<Exclude<IntradaySignalTimeframe, '1h'>> = []

  if (alignedDirection !== 'none') {
    for (const timeframe of ENTRY_TIMEFRAMES) {
      const analysis = timeframes[timeframe]!
      const label = timeframe
      let hasAlignedTrigger = false

      if (analysis.macd.cross === alignedDirection) {
        score += SIGNAL_WEIGHT.macdCross
        hasAlignedTrigger = true
        logic.push(`${label} MACD ${alignedDirection === 'bullish' ? '金叉' : '死叉'}（${analysis.macd.crossBarsAgo ?? 0} 根 K 内）`)
      } else if (analysis.macd.cross === oppositeDirection) {
        score -= SIGNAL_WEIGHT.macdCrossConflict
        warnings.push(`${label} MACD 出现反向${oppositeDirection === 'bullish' ? '金叉' : '死叉'}`)
      }

      if (analysis.macd.divergence === alignedDirection) {
        const recent = (analysis.macd.divergenceBarsAgo ?? DIVERGENCE_MAX_AGE + 1) <= DIVERGENCE_TRIGGER_MAX_AGE
        score += recent ? SIGNAL_WEIGHT.macdDivergence : SIGNAL_WEIGHT.macdDivergenceContext
        hasAlignedTrigger = hasAlignedTrigger || recent
        logic.push(`${label} 出现 MACD ${alignedDirection === 'bullish' ? '底' : '顶'}背离${recent ? '' : '（背景证据）'}`)
      } else if (analysis.macd.divergence === oppositeDirection) {
        const recent = (analysis.macd.divergenceBarsAgo ?? DIVERGENCE_MAX_AGE + 1) <= DIVERGENCE_TRIGGER_MAX_AGE
        score -= recent ? SIGNAL_WEIGHT.macdDivergenceConflict : SIGNAL_WEIGHT.macdDivergenceConflictContext
        warnings.push(`${label} 出现反向 MACD ${oppositeDirection === 'bullish' ? '底' : '顶'}背离`)
      }

      if (analysis.rsi.recovery === alignedDirection) {
        score += SIGNAL_WEIGHT.rsiRecovery
        hasAlignedTrigger = true
        logic.push(`${label} RSI 从${alignedDirection === 'bullish' ? '超卖区回升' : '超买区回落'}`)
      } else if (analysis.rsi.recovery === oppositeDirection) {
        score -= SIGNAL_WEIGHT.rsiRecoveryConflict
        warnings.push(`${label} RSI 出现反向极值恢复`)
      } else if ((alignedDirection === 'bullish' && analysis.rsi.state === 'oversold')
        || (alignedDirection === 'bearish' && analysis.rsi.state === 'overbought')) {
        score += SIGNAL_WEIGHT.rsiExtreme
        logic.push(`${label} RSI 处于${alignedDirection === 'bullish' ? '超卖' : '超买'}区`)
      } else if ((alignedDirection === 'bullish' && analysis.rsi.state === 'overbought')
        || (alignedDirection === 'bearish' && analysis.rsi.state === 'oversold')) {
        score -= SIGNAL_WEIGHT.rsiExtremeConflict
        warnings.push(`${label} RSI 已${alignedDirection === 'bullish' ? '超买' : '超卖'}，入场位置不理想`)
      }

      const eventDirection = paDirection(analysis.priceAction.event)
      if (eventDirection === alignedDirection) {
        score += SIGNAL_WEIGHT.priceActionEvent
        hasAlignedTrigger = true
        logic.push(`${label} PA ${paLogicLabel(analysis.priceAction.event)}`)
      } else if (eventDirection === oppositeDirection) {
        score -= SIGNAL_WEIGHT.priceActionConflict
        warnings.push(`${label} 出现反向 PA 事件：${paLogicLabel(analysis.priceAction.event)}`)
      } else if (analysis.priceAction.event === 'ambiguous') {
        warnings.push(`${label} 单根 K 线同时满足多空 PA 条件，忽略柱内顺序`)
      }

      const structureAligned = alignedDirection === 'bullish'
        ? [analysis.priceAction.structureHigh, analysis.priceAction.structureLow].filter((value) => value === 'higher').length
        : [analysis.priceAction.structureHigh, analysis.priceAction.structureLow].filter((value) => value === 'lower').length
      if (structureAligned > 0) {
        score += structureAligned * SIGNAL_WEIGHT.structureRelation
        logic.push(`${label} PA 结构有 ${structureAligned} 项与 1h 方向一致`)
      }

      if (analysis.macd.momentum === alignedDirection) score += SIGNAL_WEIGHT.macdMomentum
      const triggerBarsAgo = barsAgoForAlignedTrigger(analysis, alignedDirection)
      const triggerIndex = triggerBarsAgo == null ? -1 : input.candles[timeframe].length - 1 - triggerBarsAgo
      const triggerVolumeRatio = triggerIndex >= 0 ? volumeRatioAt(input.candles[timeframe], triggerIndex) : 0
      if (hasAlignedTrigger && triggerVolumeRatio >= 1.2) {
        score += SIGNAL_WEIGHT.volumeExpansion
        logic.push(`${label} 触发 K 成交量为 20 均量的 ${triggerVolumeRatio.toFixed(2)}x`)
      }
      if (hasAlignedTrigger) alignedTimeframes.push(timeframe)
    }
  }

  if (alignedTimeframes.length === 2) {
    score += SIGNAL_WEIGHT.timeframeConfluence
    logic.push('5m 与 15m 入场信号共振')
  }
  score = Math.min(100, Math.max(0, Math.round(score)))

  const entryTimeframe = alignedTimeframes
    .map((timeframe) => {
      const analysis = timeframes[timeframe]!
      const barsAgo = barsAgoForAlignedTrigger(analysis, alignedDirection as Exclude<DirectionalEvent, 'none'>) ?? 99
      const candles = input.candles[timeframe]
      const candleTime = candles[Math.max(0, candles.length - 1 - barsAgo)]?.time ?? 0
      return { timeframe, barsAgo, triggeredAt: candleTime + TIMEFRAME_MS[timeframe] }
    })
    .sort((left, right) => right.triggeredAt - left.triggeredAt || (left.timeframe === '5m' ? -1 : 1))[0]

  let entry: IntradayTradeSignal['entry']
  let stopLoss: IntradayTradeSignal['stopLoss']
  let riskAcceptable = false
  let entryFresh = false

  if (entryTimeframe && bias.side !== 'neutral') {
    const analysis = timeframes[entryTimeframe.timeframe]!
    const candles = input.candles[entryTimeframe.timeframe]
    const entryPrice = analysis.close
    const preferredBase = bias.side === 'long'
      ? analysis.priceAction.latestSwingLow
      : analysis.priceAction.latestSwingHigh
    const validPreferredBase = preferredBase != null && (bias.side === 'long' ? preferredBase < entryPrice : preferredBase > entryPrice)
    const stopBase = validPreferredBase ? preferredBase : fallbackStopBase(candles, bias.side)
    const buffer = Math.max(analysis.atr * 0.25, input.tickSize * 2)
    const rawStop = bias.side === 'long' ? stopBase - buffer : stopBase + buffer
    const stopPrice = roundToTick(rawStop, input.tickSize, bias.side === 'long' ? 'down' : 'up')
    const zonePadding = analysis.atr * 0.1
    entry = {
      price: roundToTick(entryPrice, input.tickSize),
      zoneLow: roundToTick(entryPrice - zonePadding, input.tickSize, 'down'),
      zoneHigh: roundToTick(entryPrice + zonePadding, input.tickSize, 'up'),
      timeframe: entryTimeframe.timeframe,
    }
    stopLoss = {
      price: stopPrice,
      basis: validPreferredBase
        ? `${entryTimeframe.timeframe} 最近确认 swing ${bias.side === 'long' ? 'low' : 'high'} 外侧 0.25 ATR`
        : `${entryTimeframe.timeframe} 最近 10 根 K 极值外侧 0.25 ATR`,
    }

    const riskInAtr = Math.abs(entryPrice - stopPrice) / analysis.atr
    riskAcceptable = riskInAtr <= MAX_STOP_DISTANCE_ATR
    if (!riskAcceptable) warnings.push(`结构止损距离为 ${riskInAtr.toFixed(2)} ATR，超过 ${MAX_STOP_DISTANCE_ATR} ATR，不建议开单`)
    const triggerIndex = Math.max(0, candles.length - 1 - entryTimeframe.barsAgo)
    const entryDriftInAtr = Math.abs(entryPrice - candles[triggerIndex].close) / analysis.atr
    entryFresh = entryDriftInAtr <= MAX_ENTRY_DRIFT_ATR
    if (!entryFresh) warnings.push(`当前价已偏离触发价 ${entryDriftInAtr.toFixed(2)} ATR，等待新的入场信号`)
  }

  const actionable = bias.side !== 'neutral'
    && alignedTimeframes.length > 0
    && score >= ACTIONABLE_SCORE
    && entry != null
    && stopLoss != null
    && riskAcceptable
    && entryFresh

  if (!actionable && alignedTimeframes.length === 0) logic.push('等待 5m 或 15m 出现与 1h 同向的入场触发')

  return {
    timeframes,
    signal: {
      status: actionable ? 'actionable' : 'watch',
      side: actionable ? bias.side : 'neutral',
      bias: { side: bias.side, confidence: bias.confidence, logic: bias.logic },
      confidence: score,
      confidenceLevel: confidenceLevel(score),
      entry: actionable ? entry : undefined,
      stopLoss: actionable ? stopLoss : undefined,
      triggeredAt: actionable ? entryTimeframe?.triggeredAt : undefined,
      logic,
      warnings,
    },
  }
}

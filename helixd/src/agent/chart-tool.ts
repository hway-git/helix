import type {
  AgentMarketChartResult,
  AgentScope,
} from '@helix/contracts/agent'
import type { AgentMarketContext, MarketEvidence } from './market-context'
import { getAgentChartCandles } from './chart-data'

export type ChartAnnotationRequest =
  | { type: 'marker' | 'expectation'; evidenceRef: string; text: string }
  | {
      type: 'price-line'
      evidenceRef: string
      text: string
      value: 'invalidation' | 'signal-high' | 'signal-low' | 'event-level' | 'close'
    }

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parsedEvidence(evidence: MarketEvidence) {
  try {
    return record(JSON.parse(evidence.value))
  } catch {
    return {}
  }
}

function finite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function evidenceTimeframe(ref: string) {
  return /^strategy\.setup\.([^.]+)$/.exec(ref)?.[1]
    ?? /^timeframes\.([^.]+)\./.exec(ref)?.[1]
}

function markerDirection(value: Record<string, unknown>): 'long' | 'short' | 'neutral' {
  if (value.direction === 'long' || value.direction === 'short') return value.direction
  if (value.divergence === 'bullish') return 'long'
  if (value.divergence === 'bearish') return 'short'
  if (value.momentum === 'bullish') return 'long'
  if (value.momentum === 'bearish') return 'short'
  if (typeof value.event === 'string' && value.event.startsWith('bullish-')) return 'long'
  if (typeof value.event === 'string' && value.event.startsWith('bearish-')) return 'short'
  return 'neutral'
}

function markerCoordinate(value: Record<string, unknown>, fallbackTime: number | null = null): {
  time: number
  direction: 'long' | 'short' | 'neutral'
} | null {
  const signalBar = record(value.signalBar)
  const close = record(value.close)
  const time = finite(signalBar.time) ?? finite(value.closedAt) ?? finite(close.closedAt) ?? fallbackTime
  return time == null ? null : { time, direction: markerDirection(value) }
}

function priceCoordinate(value: Record<string, unknown>, field: Extract<ChartAnnotationRequest, { type: 'price-line' }>['value']) {
  if (field === 'invalidation') return finite(record(value.invalidation).price)
  if (field === 'signal-high') return finite(record(value.signalBar).high)
  if (field === 'signal-low') return finite(record(value.signalBar).low)
  if (field === 'event-level') return finite(value.eventLevel)
  return finite(value.close) ?? finite(record(value.close).close)
}

export function resolveChartAnnotations(
  requests: ChartAnnotationRequest[],
  evidence: MarketEvidence[],
  timeframe: string,
): AgentMarketChartResult['annotations'] {
  const evidenceByRef = new Map(evidence.map((item) => [item.ref, item]))
  return requests.map((request) => {
    const item = evidenceByRef.get(request.evidenceRef)
    if (!item) throw new Error(`UNKNOWN_EVIDENCE_REF:${request.evidenceRef}`)
    const annotationTimeframe = evidenceTimeframe(request.evidenceRef)
    if (annotationTimeframe && annotationTimeframe !== timeframe) {
      throw new Error(`CHART_EVIDENCE_TIMEFRAME_MISMATCH:${request.evidenceRef}`)
    }
    const value = parsedEvidence(item)
    if (request.type === 'price-line') {
      const price = priceCoordinate(value, request.value)
      if (price == null) throw new Error(`EVIDENCE_PRICE_UNAVAILABLE:${request.evidenceRef}`)
      return { type: request.type, evidenceRef: request.evidenceRef, text: request.text, price }
    }
    const companionClose = annotationTimeframe
      ? evidenceByRef.get(`timeframes.${annotationTimeframe}.close`)
      : undefined
    const companionTime = companionClose
      ? markerCoordinate(parsedEvidence(companionClose))?.time ?? null
      : null
    const coordinate = markerCoordinate(value, companionTime)
    if (!coordinate) throw new Error(`EVIDENCE_TIME_UNAVAILABLE:${request.evidenceRef}`)
    return { type: request.type, evidenceRef: request.evidenceRef, text: request.text, ...coordinate }
  })
}

export async function renderAgentMarketChart({
  scope,
  timeframe,
  bars,
  annotations,
  marketContext,
}: {
  scope: AgentScope
  timeframe: string
  bars: number
  annotations: ChartAnnotationRequest[]
  marketContext: AgentMarketContext
}): Promise<AgentMarketChartResult> {
  const chart = await getAgentChartCandles({ symbol: scope.symbol, timeframe }, bars)
  return {
    ...chart,
    annotations: resolveChartAnnotations(annotations, marketContext.evidence, timeframe),
  }
}

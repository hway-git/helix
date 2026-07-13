import { NextResponse, type NextRequest } from 'next/server'
import { createFreqtradeStrategy } from '@/lib/server/freqtrade/read-only'
import { appendFreqtradeAuditEvent, clearFreqtradeSnapshotCache } from '@/lib/server/freqtrade/snapshot-cache'
import { requireControlAccess } from '@/lib/server/control-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function readJson(request: NextRequest) {
  try {
    return (await request.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

function stringField(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
}

export async function POST(request: NextRequest) {
  const denied = requireControlAccess(request)
  if (denied) return denied

  const body = await readJson(request)
  const result = await createFreqtradeStrategy({
    name: stringField(body.name),
    timeframe: stringField(body.timeframe),
    direction: body.direction === 'short' || body.direction === 'both' ? body.direction : 'long',
    indicators: stringList(body.indicators),
  })

  if (!result.ok) {
    appendFreqtradeAuditEvent(
      'strategy_error',
      `${stringField(body.name) ?? 'unknown'} · ${result.error}`,
    )
    clearFreqtradeSnapshotCache()
    return NextResponse.json(
      { ok: false, error: result.error },
      { headers: { 'Cache-Control': 'no-store' }, status: 400 },
    )
  }

  clearFreqtradeSnapshotCache()
  appendFreqtradeAuditEvent(
    'strategy_created',
    `${result.data.strategy} · ${result.data.timeframe} · ${result.data.direction}`,
  )

  return NextResponse.json(
    { ok: true, result: result.data },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

import { NextResponse, type NextRequest } from 'next/server'
import { deployFreqtradeDryRun } from '@/lib/server/freqtrade/read-only'
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

function numberField(value: unknown) {
  return typeof value === 'number' ? value : undefined
}

export async function POST(request: NextRequest) {
  const denied = requireControlAccess(request)
  if (denied) return denied

  const body = await readJson(request)
  const result = await deployFreqtradeDryRun({
    strategy: stringField(body.strategy),
    pairs: stringList(body.pairs),
    maxOpenTrades: numberField(body.maxOpenTrades),
  })

  if (!result.ok) {
    appendFreqtradeAuditEvent(
      'dry_run_deploy_error',
      `${stringField(body.strategy) ?? 'unknown'} · ${result.error}`,
    )
    clearFreqtradeSnapshotCache()
    return NextResponse.json(
      { ok: false, error: result.error },
      { headers: { 'Cache-Control': 'no-store' }, status: 400 },
    )
  }

  clearFreqtradeSnapshotCache()
  appendFreqtradeAuditEvent(
    'dry_run_deployed',
    `${result.data.strategy} · ${result.data.pairs.length || 'existing'} pairs · max ${result.data.maxOpenTrades ?? '--'}`,
  )

  return NextResponse.json(
    { ok: true, result: result.data },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

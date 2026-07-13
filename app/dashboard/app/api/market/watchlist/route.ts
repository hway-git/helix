import { NextResponse, type NextRequest } from 'next/server'
import {
  addWatchlistInstrument,
  getWatchlistSnapshot,
  removeWatchlistInstrument,
  replaceWatchlist,
} from '@/lib/server/watchlist'
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

function ok(payload: unknown) {
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}

function badRequest(error: string) {
  return NextResponse.json(
    { ok: false, error },
    { headers: { 'Cache-Control': 'no-store' }, status: 400 },
  )
}

export async function GET() {
  return ok(await getWatchlistSnapshot())
}

export async function PUT(request: NextRequest) {
  const denied = requireControlAccess(request)
  if (denied) return denied

  const body = await readJson(request)
  return ok(await replaceWatchlist(body.instruments))
}

export async function POST(request: NextRequest) {
  const denied = requireControlAccess(request)
  if (denied) return denied

  const body = await readJson(request)
  try {
    return ok(await addWatchlistInstrument(body.instrumentId))
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : 'invalid instrumentId')
  }
}

export async function DELETE(request: NextRequest) {
  const denied = requireControlAccess(request)
  if (denied) return denied

  const url = new URL(request.url)
  const body = await readJson(request)
  const instrumentId = body.instrumentId ?? url.searchParams.get('instrumentId')

  try {
    return ok(await removeWatchlistInstrument(instrumentId))
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : 'invalid instrumentId')
  }
}

import { NextResponse, type NextRequest } from 'next/server'
import { saveReadOnlyAccountKey } from '@/lib/server/account/read-only'
import { clearAccountSnapshotCache } from '@/lib/server/account/snapshot-cache'
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

export async function POST(request: NextRequest) {
  const denied = requireControlAccess(request)
  if (denied) return denied

  const body = await readJson(request)
  const result = await saveReadOnlyAccountKey({
    apiKey: body.apiKey,
    apiSecret: body.apiSecret,
    passphrase: body.passphrase,
  })

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { headers: { 'Cache-Control': 'no-store' }, status: 400 },
    )
  }

  clearAccountSnapshotCache()
  return NextResponse.json(
    { ok: true, saved: true },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

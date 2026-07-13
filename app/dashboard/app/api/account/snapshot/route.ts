import { NextResponse } from 'next/server'
import { getReadOnlyAccountSnapshot } from '@/lib/server/account/read-only'
import { getCachedAccountSnapshot, setCachedAccountSnapshot } from '@/lib/server/account/snapshot-cache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const cached = getCachedAccountSnapshot()
  if (cached) return NextResponse.json(cached, { headers: { 'Cache-Control': 'no-store' } })

  const payload = await getReadOnlyAccountSnapshot()
  setCachedAccountSnapshot(payload)

  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}

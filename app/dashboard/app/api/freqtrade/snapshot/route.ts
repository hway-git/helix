import { NextResponse, type NextRequest } from 'next/server'
import { getReadOnlyFreqtradeSnapshot } from '@/lib/server/freqtrade/read-only'
import { getOrLoadFreqtradeSnapshot } from '@/lib/server/freqtrade/snapshot-cache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const refresh = url.searchParams.get('refresh') === '1'
  const payload = await getOrLoadFreqtradeSnapshot({
    refresh,
    load: getReadOnlyFreqtradeSnapshot,
  })

  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}

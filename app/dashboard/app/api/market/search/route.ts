import { NextResponse, type NextRequest } from 'next/server'
import { searchOkxSwapPairs } from '@/lib/server/market-providers/okx'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const query = url.searchParams.get('q') ?? ''

  try {
    const pairs = await searchOkxSwapPairs(query)
    return NextResponse.json({ ok: true, pairs }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        pairs: [],
        error: error instanceof Error ? error.message : 'OKX 搜索不可用',
      },
      { headers: { 'Cache-Control': 'no-store' }, status: 200 },
    )
  }
}

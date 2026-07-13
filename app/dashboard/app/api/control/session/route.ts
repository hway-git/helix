import { NextResponse, type NextRequest } from 'next/server'
import {
  clearControlSession,
  createControlSession,
  getControlSessionStatus,
} from '@/lib/server/control-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  return NextResponse.json(
    { ok: true, session: getControlSessionStatus(request) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {}
  try {
    body = await request.json() as Record<string, unknown>
  } catch {}
  return createControlSession(request, body.token)
}

export async function DELETE(request: NextRequest) {
  return clearControlSession(request)
}

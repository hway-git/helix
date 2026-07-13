import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

const CONTROL_COOKIE = 'helix_control'
const SESSION_TTL_SECONDS = 8 * 60 * 60
const MIN_TOKEN_LENGTH = 24

export type ControlSessionStatus = {
  authorized: boolean
  mode: 'local' | 'token' | 'disabled' | 'misconfigured'
  tokenConfigured: boolean
  expiresAt: number | null
}

function configuredToken() {
  return process.env.HELIX_CONTROL_TOKEN?.trim() ?? ''
}

function constantTimeEqual(left: string, right: string) {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}

function requestHostname(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const host = forwarded || request.headers.get('host') || request.nextUrl.host
  try {
    return new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isLoopback(value: string) {
  const normalized = value.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.')
}

function isLocalRequest(request: NextRequest) {
  if (!isLoopback(requestHostname(request))) return false
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (!forwardedFor) return true
  return forwardedFor.split(',').every((address) => isLoopback(address.trim()))
}

function isSameOrigin(request: NextRequest) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false
  const origin = request.headers.get('origin')
  if (!origin) return true

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const expectedHost = forwardedHost || request.headers.get('host') || request.nextUrl.host
  const expectedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    || request.nextUrl.protocol.replace(':', '')
  try {
    const originUrl = new URL(origin)
    return originUrl.host.toLowerCase() === expectedHost.toLowerCase()
      && originUrl.protocol === `${expectedProtocol}:`
  } catch {
    return false
  }
}

function sessionSignature(token: string, expiresAt: number) {
  return createHmac('sha256', token)
    .update(`helix-control:${expiresAt}`)
    .digest('base64url')
}

function readSession(request: NextRequest, token: string) {
  const value = request.cookies.get(CONTROL_COOKIE)?.value ?? ''
  const separator = value.indexOf('.')
  if (separator < 1) return null

  const expiresAt = Number(value.slice(0, separator))
  const signature = value.slice(separator + 1)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null
  if (!constantTimeEqual(signature, sessionSignature(token, expiresAt))) return null
  return expiresAt
}

export function getControlSessionStatus(request: NextRequest): ControlSessionStatus {
  const token = configuredToken()
  if (token && token.length < MIN_TOKEN_LENGTH) {
    return { authorized: false, mode: 'misconfigured', tokenConfigured: true, expiresAt: null }
  }
  if (token) {
    const expiresAt = readSession(request, token)
    return {
      authorized: expiresAt != null,
      mode: 'token',
      tokenConfigured: true,
      expiresAt,
    }
  }
  if (isLocalRequest(request)) {
    return { authorized: true, mode: 'local', tokenConfigured: false, expiresAt: null }
  }
  return { authorized: false, mode: 'disabled', tokenConfigured: false, expiresAt: null }
}

function denied(error: string, status: number) {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}

export function requireControlAccess(request: NextRequest) {
  if (!isSameOrigin(request)) return denied('拒绝跨站控制请求', 403)

  const session = getControlSessionStatus(request)
  if (session.authorized) return null
  if (session.mode === 'misconfigured') {
    return denied(`HELIX_CONTROL_TOKEN 至少需要 ${MIN_TOKEN_LENGTH} 个字符`, 503)
  }
  if (session.mode === 'disabled') {
    return denied('远程控制未启用，请配置 HELIX_CONTROL_TOKEN', 503)
  }
  return denied('控制会话未解锁', 401)
}

export function createControlSession(request: NextRequest, candidate: unknown) {
  if (!isSameOrigin(request)) return denied('拒绝跨站控制请求', 403)

  const token = configuredToken()
  if (!token) {
    if (!isLocalRequest(request)) return denied('远程控制未启用，请配置 HELIX_CONTROL_TOKEN', 503)
    return NextResponse.json(
      { ok: true, session: getControlSessionStatus(request) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return denied(`HELIX_CONTROL_TOKEN 至少需要 ${MIN_TOKEN_LENGTH} 个字符`, 503)
  }
  if (typeof candidate !== 'string' || !constantTimeEqual(candidate, token)) {
    return denied('控制令牌无效', 401)
  }

  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000
  const response = NextResponse.json(
    {
      ok: true,
      session: {
        authorized: true,
        mode: 'token',
        tokenConfigured: true,
        expiresAt,
      } satisfies ControlSessionStatus,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  response.cookies.set(CONTROL_COOKIE, `${expiresAt}.${sessionSignature(token, expiresAt)}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: forwardedProto === 'https' || request.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
  return response
}

export function clearControlSession(request: NextRequest) {
  if (!isSameOrigin(request)) return denied('拒绝跨站控制请求', 403)
  const response = NextResponse.json(
    { ok: true, session: { ...getControlSessionStatus(request), authorized: false, expiresAt: null } },
    { headers: { 'Cache-Control': 'no-store' } },
  )
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  response.cookies.set(CONTROL_COOKIE, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: forwardedProto === 'https' || request.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: 0,
  })
  return response
}

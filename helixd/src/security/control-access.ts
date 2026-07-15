import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

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

function requestHostname(c: Context) {
  const forwarded = c.req.header('x-forwarded-host')?.split(',')[0]?.trim()
  const host = forwarded || c.req.header('host') || new URL(c.req.url).host
  try {
    return new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function requestProtocol(c: Context) {
  return c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
    || new URL(c.req.url).protocol.replace(':', '')
}

function isLoopback(value: string) {
  const normalized = value.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.')
}

function isLocalRequest(c: Context) {
  if (!isLoopback(requestHostname(c))) return false
  const forwardedFor = c.req.header('x-forwarded-for')
  if (!forwardedFor) return true
  return forwardedFor.split(',').every((address) => isLoopback(address.trim()))
}

export function isSameOrigin(c: Context) {
  if (c.req.header('sec-fetch-site') === 'cross-site') return false
  const origin = c.req.header('origin')
  if (!origin) return true

  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim()
  const expectedHost = forwardedHost || c.req.header('host') || new URL(c.req.url).host
  try {
    const originUrl = new URL(origin)
    return originUrl.host.toLowerCase() === expectedHost.toLowerCase()
      && originUrl.protocol === `${requestProtocol(c)}:`
  } catch {
    return false
  }
}

function sessionSignature(token: string, expiresAt: number) {
  return createHmac('sha256', token)
    .update(`helix-control:${expiresAt}`)
    .digest('base64url')
}

function readSession(c: Context, token: string) {
  const value = getCookie(c, CONTROL_COOKIE) ?? ''
  const separator = value.indexOf('.')
  if (separator < 1) return null

  const expiresAt = Number(value.slice(0, separator))
  const signature = value.slice(separator + 1)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null
  if (!constantTimeEqual(signature, sessionSignature(token, expiresAt))) return null
  return expiresAt
}

export function getControlSessionStatus(c: Context): ControlSessionStatus {
  const token = configuredToken()
  if (token && token.length < MIN_TOKEN_LENGTH) {
    return { authorized: false, mode: 'misconfigured', tokenConfigured: true, expiresAt: null }
  }
  if (token) {
    const expiresAt = readSession(c, token)
    return { authorized: expiresAt != null, mode: 'token', tokenConfigured: true, expiresAt }
  }
  if (isLocalRequest(c)) {
    return { authorized: true, mode: 'local', tokenConfigured: false, expiresAt: null }
  }
  return { authorized: false, mode: 'disabled', tokenConfigured: false, expiresAt: null }
}

function denied(c: Context, error: string, status: 401 | 403 | 503) {
  return c.json({ ok: false, error }, status)
}

export function requireControlAccess(c: Context) {
  if (!isSameOrigin(c)) return denied(c, '拒绝跨站控制请求', 403)

  const session = getControlSessionStatus(c)
  if (session.authorized) return null
  if (session.mode === 'misconfigured') {
    return denied(c, `HELIX_CONTROL_TOKEN 至少需要 ${MIN_TOKEN_LENGTH} 个字符`, 503)
  }
  if (session.mode === 'disabled') {
    return denied(c, '远程控制未启用，请配置 HELIX_CONTROL_TOKEN', 503)
  }
  return denied(c, '控制会话未解锁', 401)
}

export function createControlSession(c: Context, candidate: unknown) {
  if (!isSameOrigin(c)) return denied(c, '拒绝跨站控制请求', 403)

  const token = configuredToken()
  if (!token) {
    if (!isLocalRequest(c)) return denied(c, '远程控制未启用，请配置 HELIX_CONTROL_TOKEN', 503)
    return c.json({ ok: true, session: getControlSessionStatus(c) })
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return denied(c, `HELIX_CONTROL_TOKEN 至少需要 ${MIN_TOKEN_LENGTH} 个字符`, 503)
  }
  if (typeof candidate !== 'string' || !constantTimeEqual(candidate, token)) {
    return denied(c, '控制令牌无效', 401)
  }

  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000
  setCookie(c, CONTROL_COOKIE, `${expiresAt}.${sessionSignature(token, expiresAt)}`, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: requestProtocol(c) === 'https',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
  return c.json({
    ok: true,
    session: {
      authorized: true,
      mode: 'token',
      tokenConfigured: true,
      expiresAt,
    } satisfies ControlSessionStatus,
  })
}

export function clearControlSession(c: Context) {
  if (!isSameOrigin(c)) return denied(c, '拒绝跨站控制请求', 403)
  setCookie(c, CONTROL_COOKIE, '', {
    httpOnly: true,
    sameSite: 'Strict',
    secure: requestProtocol(c) === 'https',
    path: '/',
    maxAge: 0,
  })
  return c.json({
    ok: true,
    session: { ...getControlSessionStatus(c), authorized: false, expiresAt: null },
  })
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { isSameOrigin } from './control-access'

const LIVE_COOKIE = 'helix_live_control'
const LIVE_SESSION_TTL_SECONDS = 10 * 60
const MIN_TOKEN_LENGTH = 24

export type LiveSessionStatus = {
  authorized: boolean
  enabled: boolean
  tokenConfigured: boolean
  mode: 'authorized' | 'locked' | 'disabled' | 'misconfigured'
  expiresAt: number | null
}

function localEnv() {
  try {
    return parseEnv(readFileSync(resolve(homedir(), '.helix', '.env'), 'utf8'))
  } catch {
    return {}
  }
}

function liveConfig() {
  const file = localEnv()
  const enabled = (process.env.HELIX_LIVE_TRADING_ENABLED || file.HELIX_LIVE_TRADING_ENABLED) === 'true'
  const token = (process.env.HELIX_LIVE_TRADING_TOKEN || file.HELIX_LIVE_TRADING_TOKEN || '').trim()
  return { enabled, token }
}

function constantTimeEqual(left: string, right: string) {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}

function signature(token: string, expiresAt: number) {
  return createHmac('sha256', token).update(`helix-live:${expiresAt}`).digest('base64url')
}

function readSession(c: Context, token: string) {
  const value = getCookie(c, LIVE_COOKIE) ?? ''
  const separator = value.indexOf('.')
  if (separator < 1) return null

  const expiresAt = Number(value.slice(0, separator))
  const candidate = value.slice(separator + 1)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null
  if (!constantTimeEqual(candidate, signature(token, expiresAt))) return null
  return expiresAt
}

function denied(c: Context, error: string, status: 401 | 403 | 423 | 503) {
  return c.json({ ok: false, error }, status)
}

function setLiveCookie(c: Context, value: string, maxAge: number) {
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
  const protocol = forwardedProto || new URL(c.req.url).protocol.replace(':', '')
  setCookie(c, LIVE_COOKIE, value, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: protocol === 'https',
    path: '/',
    maxAge,
  })
}

export function getLiveSessionStatus(c: Context): LiveSessionStatus {
  const { enabled, token } = liveConfig()
  if (!enabled) {
    return { authorized: false, enabled: false, tokenConfigured: Boolean(token), mode: 'disabled', expiresAt: null }
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return { authorized: false, enabled: true, tokenConfigured: Boolean(token), mode: 'misconfigured', expiresAt: null }
  }
  const expiresAt = readSession(c, token)
  return {
    authorized: expiresAt != null,
    enabled: true,
    tokenConfigured: true,
    mode: expiresAt == null ? 'locked' : 'authorized',
    expiresAt,
  }
}

export function requireLiveAccess(c: Context) {
  if (!isSameOrigin(c)) return denied(c, '拒绝跨站实盘控制请求', 403)
  const session = getLiveSessionStatus(c)
  if (session.authorized) return null
  if (session.mode === 'disabled') return denied(c, '实盘总开关未启用', 423)
  if (session.mode === 'misconfigured') {
    return denied(c, `HELIX_LIVE_TRADING_TOKEN 至少需要 ${MIN_TOKEN_LENGTH} 个字符`, 503)
  }
  return denied(c, '实盘授权会话未解锁', 401)
}

export function createLiveSession(c: Context, candidate: unknown) {
  if (!isSameOrigin(c)) return denied(c, '拒绝跨站实盘控制请求', 403)
  const { enabled, token } = liveConfig()
  if (!enabled) return denied(c, '实盘总开关未启用', 423)
  if (token.length < MIN_TOKEN_LENGTH) {
    return denied(c, `HELIX_LIVE_TRADING_TOKEN 至少需要 ${MIN_TOKEN_LENGTH} 个字符`, 503)
  }
  if (typeof candidate !== 'string' || !constantTimeEqual(candidate, token)) {
    return denied(c, '实盘授权 token 无效', 401)
  }

  const expiresAt = Date.now() + LIVE_SESSION_TTL_SECONDS * 1000
  setLiveCookie(c, `${expiresAt}.${signature(token, expiresAt)}`, LIVE_SESSION_TTL_SECONDS)
  return c.json({
    ok: true,
    session: {
      authorized: true,
      enabled: true,
      tokenConfigured: true,
      mode: 'authorized',
      expiresAt,
    } satisfies LiveSessionStatus,
  })
}

export function clearLiveSession(c: Context) {
  if (!isSameOrigin(c)) return denied(c, '拒绝跨站实盘控制请求', 403)
  setLiveCookie(c, '', 0)
  return c.json({
    ok: true,
    session: {
      ...getLiveSessionStatus(c),
      authorized: false,
      mode: liveConfig().enabled ? 'locked' : 'disabled',
      expiresAt: null,
    },
  })
}

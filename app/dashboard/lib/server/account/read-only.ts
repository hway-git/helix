import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import type { AccountSnapshot, AccountTableRow } from '@/lib/account-data'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 18_000
const REPO_ROOT = process.env.HELIX_REPO_ROOT
  ? resolve(process.env.HELIX_REPO_ROOT)
  : resolve(process.cwd(), '..', '..')
const ACCOUNT_SKILL_DIR = resolve(REPO_ROOT, 'skills', 'helix-account')
const DEFAULT_EXCHANGE = process.env.HELIX_ACCOUNT_EXCHANGE || 'okx'
const DEFAULT_MARKET_TYPE = process.env.HELIX_ACCOUNT_MARKET_TYPE || 'swap'

type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

type AccountAuth = AccountSnapshot['source']['auth']

export type AccountCredentialInput = {
  apiKey: unknown
  apiSecret: unknown
  passphrase?: unknown
}

function parseJson(stdout: string) {
  try {
    return JSON.parse(stdout) as unknown
  } catch {
    return { error: stdout.trim() || 'account script returned non-json output' }
  }
}

async function runAccountAction<T>(action: string, params: Record<string, unknown>): Promise<ActionResult<T>> {
  const args = ['scripts/exchange.mjs', action, JSON.stringify(params)]

  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: ACCOUNT_SKILL_DIR,
      timeout: DEFAULT_TIMEOUT_MS,
      env: {
        ...process.env,
        HELIX_INTERNAL_CALL: '1',
      },
      maxBuffer: 1024 * 1024,
    })
    const parsed = parseJson(stdout) as T & { error?: string }
    if (parsed && typeof parsed === 'object' && parsed.error) return { ok: false, error: parsed.error }
    return { ok: true, data: parsed as T }
  } catch (error) {
    const maybe = error as { stdout?: string; message?: string }
    const parsed = maybe.stdout ? (parseJson(maybe.stdout) as { error?: string }) : null
    return { ok: false, error: parsed?.error || maybe.message || `${action} failed` }
  }
}

function numberFrom(value: unknown) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : undefined
}

function formatAmount(value: unknown) {
  const n = numberFrom(value)
  if (n == null) return '--'
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (Math.abs(n) >= 1) return n.toFixed(4).replace(/\.?0+$/, '')
  return n.toFixed(8).replace(/\.?0+$/, '')
}

function formatPrice(value: unknown) {
  const n = numberFrom(value)
  if (n == null || n <= 0) return '--'
  if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (n >= 1) return n.toFixed(4).replace(/\.?0+$/, '')
  return n.toFixed(8).replace(/\.?0+$/, '')
}

function normalizeBalances(payload: unknown): AccountTableRow[] {
  if (!payload || typeof payload !== 'object') return []

  return Object.entries(payload as Record<string, unknown>)
    .filter(([asset]) => !asset.startsWith('_'))
    .map(([asset, value]) => {
      const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
      return {
        asset,
        free: formatAmount(row.free),
        used: formatAmount(row.used),
        total: formatAmount(row.total),
      }
    })
}

function normalizePositions(payload: unknown): AccountTableRow[] {
  if (!Array.isArray(payload)) return []

  return payload.map((item) => {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const info = row.info && typeof row.info === 'object' ? (row.info as Record<string, unknown>) : {}
    const side = String(row.side || info.posSide || '--')
    const pnl = numberFrom(row.unrealizedPnl ?? info.upl)

    return {
      symbol: String(row.symbol || info.instId || '--'),
      side,
      size: formatAmount(row.contracts ?? info.pos),
      entry: formatPrice(row.entryPrice ?? info.avgPx),
      mark: formatPrice(row.markPrice ?? info.markPx),
      pnl: pnl == null ? '--' : `${pnl >= 0 ? '+' : ''}${formatAmount(pnl)}`,
      risk: formatAmount(row.liquidationPrice ?? info.liqPx),
    }
  })
}

function normalizeOrders(payload: unknown): AccountTableRow[] {
  if (!Array.isArray(payload)) return []

  return payload.slice(0, 50).map((item) => {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    return {
      id: String(row.id ?? '--'),
      symbol: String(row.symbol ?? '--'),
      type: String(row.type ?? '--'),
      side: String(row.side ?? '--'),
      price: formatPrice(row.price),
      status: String(row.status ?? '--'),
    }
  })
}

function normalizeHistory(payload: unknown): AccountTableRow[] {
  if (!Array.isArray(payload)) return []

  return payload.slice(0, 50).map((item) => {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const fee = row.fee && typeof row.fee === 'object' ? (row.fee as Record<string, unknown>) : null
    const timestamp = numberFrom(row.timestamp)
    return {
      time: timestamp == null ? '--' : new Date(timestamp).toLocaleString('zh-CN', { hour12: false }),
      symbol: String(row.symbol ?? '--'),
      side: String(row.side ?? '--'),
      amount: formatAmount(row.amount),
      price: formatPrice(row.price),
      fee: fee ? `${formatAmount(fee.cost)} ${String(fee.currency ?? '')}`.trim() : '--',
    }
  })
}

function firstLine(value: string) {
  return value.split('\n').map((line) => line.trim()).find(Boolean) ?? value.trim()
}

function accountAuthFromError(error: string): AccountAuth {
  const normalized = error.toLowerCase()
  if (error.includes('未配置') && /api\s*key/i.test(error)) return { status: 'missing', label: 'KEY_MISSING' }
  if (
    normalized.includes('authentication') ||
    normalized.includes('invalid') ||
    normalized.includes('signature') ||
    normalized.includes('permission') ||
    error.includes('权限') ||
    error.includes('无效')
  ) {
    return { status: 'invalid', label: 'KEY_INVALID' }
  }
  return { status: 'unknown', label: 'ACCOUNT_OFFLINE' }
}

function sanitizeAccountError(error: string) {
  const message = firstLine(error)
  const auth = accountAuthFromError(message)

  if (auth.status === 'missing') return '未配置账户 API Key'
  if (auth.status === 'invalid') return '账户 API Key 无效或权限不足'

  return message
    .replace(/\bOKX\b/gi, '账户源')
    .replace(/\bBinance\b/gi, '账户源')
    .replace(/\bBybit\b/gi, '账户源')
    .replace(/\bBitget\b/gi, '账户源')
    .replace(/\bGate\.io\b/gi, '账户源')
    .replace(/\bHTX\b/gi, '账户源')
}

function credentialString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export async function saveReadOnlyAccountKey(input: AccountCredentialInput): Promise<ActionResult<{ saved: true }>> {
  const apiKey = credentialString(input.apiKey)
  const apiSecret = credentialString(input.apiSecret)
  const passphrase = credentialString(input.passphrase)

  if (!apiKey || !apiSecret) return { ok: false, error: '需要 API Key 和 API Secret' }

  const result = await runAccountAction<unknown>('save_key', {
    exchange: DEFAULT_EXCHANGE,
    api_key: apiKey,
    api_secret: apiSecret,
    passphrase: passphrase || undefined,
  })

  if (!result.ok) return { ok: false, error: sanitizeAccountError(result.error) }
  return { ok: true, data: { saved: true } }
}

function emptySnapshot(status: AccountSnapshot['source']['status'], errors: string[], auth?: AccountAuth): AccountSnapshot {
  const sanitizedErrors = errors.map(sanitizeAccountError)
  const sourceAuth = auth ?? (errors[0] ? accountAuthFromError(errors[0]) : { status: 'unknown', label: 'ACCOUNT_OFFLINE' })

  return {
    ok: status === 'live',
    mode: 'read_only',
    balances: [],
    positions: [],
    orders: [],
    history: [],
    source: {
      name: 'Helix Account',
      status,
      fetchedAt: Date.now(),
      errors: sanitizedErrors,
      auth: sourceAuth,
      permissions: {
        read: status !== 'offline' && sourceAuth.status === 'configured',
        trade: false,
      },
    },
  }
}

export async function getReadOnlyAccountSnapshot(): Promise<AccountSnapshot> {
  const params = { exchange: DEFAULT_EXCHANGE, market_type: DEFAULT_MARKET_TYPE }
  const balance = await runAccountAction<unknown>('balance', params)

  if (!balance.ok) return emptySnapshot('offline', [balance.error], accountAuthFromError(balance.error))

  const [positions, orders, history] = await Promise.all([
    runAccountAction<unknown>('positions', params),
    runAccountAction<unknown>('open_orders', params),
    runAccountAction<unknown>('my_trades', { ...params, limit: 50 }),
  ])
  const criticalErrors = [positions, orders]
    .filter((result): result is { ok: false; error: string } => !result.ok)
    .map((result) => result.error)
  const optionalErrors = history.ok ? [] : [history.error]
  const errors = [...criticalErrors, ...optionalErrors]
  const sanitizedErrors = errors.map(sanitizeAccountError)

  return {
    ok: criticalErrors.length === 0,
    mode: 'read_only',
    balances: normalizeBalances(balance.data),
    positions: positions.ok ? normalizePositions(positions.data) : [],
    orders: orders.ok ? normalizeOrders(orders.data) : [],
    history: history.ok ? normalizeHistory(history.data) : [],
    source: {
      name: 'Helix Account',
      status: criticalErrors.length === 0 ? 'live' : 'partial',
      fetchedAt: Date.now(),
      errors: sanitizedErrors,
      auth: {
        status: 'configured',
        label: 'READ_ONLY',
      },
      permissions: {
        read: true,
        trade: false,
      },
    },
  }
}

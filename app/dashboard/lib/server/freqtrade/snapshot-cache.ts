import type { FreqtradeSnapshot, FreqtradeTableRow } from '@/lib/freqtrade-data'

const CACHE_TTL_MS = 10_000
const ERROR_CACHE_TTL_MS = 3_000
const MAX_AUDIT_ROWS = 50

let cache: { expiresAt: number; payload: FreqtradeSnapshot } | null = null
let pending: Promise<FreqtradeSnapshot> | null = null
let auditRows: FreqtradeTableRow[] = []

function sanitizeAuditValue(value: string) {
  return value
    .replace(/\b127\.0\.0\.1:\d+\b/g, '[local]')
    .replace(/https?:\/\/[^\s"']+/g, '[url]')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic [redacted]')
    .slice(0, 180)
}

export function getCachedFreqtradeSnapshot() {
  if (!cache || cache.expiresAt <= Date.now()) return null
  return cache.payload
}

export function setCachedFreqtradeSnapshot(payload: FreqtradeSnapshot) {
  cache = {
    expiresAt: Date.now() + (payload.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS),
    payload,
  }
}

export function clearFreqtradeSnapshotCache() {
  cache = null
}

export function appendFreqtradeAuditEvent(event: string, result: string, actor = 'Helix') {
  auditRows = [
    {
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      actor: sanitizeAuditValue(actor),
      event: sanitizeAuditValue(event),
      result: sanitizeAuditValue(result),
    },
    ...auditRows,
  ].slice(0, MAX_AUDIT_ROWS)
}

export function getFreqtradeAuditRows() {
  return auditRows
}

export async function getOrLoadFreqtradeSnapshot({
  refresh,
  load,
}: {
  refresh: boolean
  load: () => Promise<FreqtradeSnapshot>
}) {
  if (refresh) clearFreqtradeSnapshotCache()

  const cached = refresh ? null : getCachedFreqtradeSnapshot()
  if (cached) return cached
  if (!refresh && pending) return pending

  const next = load()
    .then((payload) => {
      setCachedFreqtradeSnapshot(payload)
      return payload
    })
    .finally(() => {
      if (pending === next) pending = null
    })

  pending = next
  return next
}

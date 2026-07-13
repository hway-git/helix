import type { AccountSnapshot } from '@/lib/account-data'

const CACHE_TTL_MS = 10_000
const ERROR_CACHE_TTL_MS = 3_000

let cache: { expiresAt: number; payload: AccountSnapshot } | null = null

export function getCachedAccountSnapshot() {
  if (!cache || cache.expiresAt <= Date.now()) return null
  return cache.payload
}

export function setCachedAccountSnapshot(payload: AccountSnapshot) {
  cache = {
    expiresAt: Date.now() + (payload.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS),
    payload,
  }
}

export function clearAccountSnapshotCache() {
  cache = null
}

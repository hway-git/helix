import { Hono } from 'hono'
import {
  getReadOnlyAccountSnapshot,
  saveReadOnlyAccountKey,
} from '@helix/core/account/read-only'
import {
  clearAccountSnapshotCache,
  getCachedAccountSnapshot,
  setCachedAccountSnapshot,
} from '@helix/core/account/snapshot-cache'
import { appendFreqtradeAuditEvent } from '@helix/core/freqtrade/snapshot-cache'
import { readJson } from '../http'
import { requireControlAccess } from '../security/control-access'

export const accountRoutes = new Hono()

accountRoutes.get('/snapshot', async (c) => {
  const cached = getCachedAccountSnapshot()
  if (cached) return c.json(cached)

  const payload = await getReadOnlyAccountSnapshot()
  setCachedAccountSnapshot(payload)
  return c.json(payload)
})

accountRoutes.post('/credentials', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  const body = await readJson(c)
  const result = await saveReadOnlyAccountKey({
    apiKey: body.apiKey,
    apiSecret: body.apiSecret,
    passphrase: body.passphrase,
  })

  if (!result.ok) {
    appendFreqtradeAuditEvent('account_key_error', result.error, 'Operator')
    return c.json({ ok: false, error: result.error }, 400)
  }

  clearAccountSnapshotCache()
  appendFreqtradeAuditEvent('account_key_saved', 'credentials updated without secret disclosure', 'Operator')
  return c.json({ ok: true, saved: true })
})

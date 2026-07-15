import { Hono } from 'hono'
import { appendFreqtradeAuditEvent } from '@helix/core/freqtrade/snapshot-cache'
import { readJson } from '../http'
import {
  clearControlSession,
  createControlSession,
  getControlSessionStatus,
} from '../security/control-access'

export const controlRoutes = new Hono()

controlRoutes.get('/session', (c) => c.json({ ok: true, session: getControlSessionStatus(c) }))

controlRoutes.post('/session', async (c) => {
  const body = await readJson(c)
  const response = createControlSession(c, body.token)
  appendFreqtradeAuditEvent(
    response.status < 400 ? 'control_unlocked' : 'control_unlock_denied',
    `HTTP ${response.status}`,
    'Operator',
  )
  return response
})

controlRoutes.delete('/session', (c) => {
  const response = clearControlSession(c)
  appendFreqtradeAuditEvent(
    response.status < 400 ? 'control_locked' : 'control_lock_denied',
    `HTTP ${response.status}`,
    'Operator',
  )
  return response
})

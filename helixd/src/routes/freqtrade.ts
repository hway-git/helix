import { Hono } from 'hono'
import {
  createFreqtradeStrategy,
  deployFreqtradeDryRun,
  deployFreqtradeLive,
  emergencyStopFreqtrade,
  getReadOnlyFreqtradeSnapshot,
  runReadOnlyFreqtradeBacktest,
} from '@helix/core/freqtrade/read-only'
import { reconcileFreqtradeAccount } from '@helix/core/freqtrade/reconciliation'
import {
  appendFreqtradeAuditEvent,
  clearFreqtradeSnapshotCache,
  getOrLoadFreqtradeSnapshot,
} from '@helix/core/freqtrade/snapshot-cache'
import { numberField, readJson, stringField, stringList } from '../http'
import { requireControlAccess } from '../security/control-access'
import {
  clearLiveSession,
  createLiveSession,
  getLiveSessionStatus,
  requireLiveAccess,
} from '../security/live-access'

export const freqtradeRoutes = new Hono()

freqtradeRoutes.get('/snapshot', async (c) => {
  const refresh = c.req.query('refresh') === '1'
  const payload = await getOrLoadFreqtradeSnapshot({ refresh, load: getReadOnlyFreqtradeSnapshot })
  return c.json(payload)
})

freqtradeRoutes.post('/backtest', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  const body = await readJson(c)
  const result = await runReadOnlyFreqtradeBacktest({
    strategy: stringField(body.strategy),
    timeframe: stringField(body.timeframe),
    timerange: stringField(body.timerange),
    pairs: stringList(body.pairs),
  })

  if (!result.ok) {
    appendFreqtradeAuditEvent('backtest_error', `${stringField(body.strategy) ?? 'unknown'} · ${result.error}`)
    clearFreqtradeSnapshotCache()
    return c.json({ ok: false, error: result.error }, 400)
  }

  clearFreqtradeSnapshotCache()
  appendFreqtradeAuditEvent(
    'backtest_finished',
    `${result.data.strategy} · ${result.data.timeframe} · ${result.data.timerange}`,
  )
  return c.json({ ok: true, result: result.data })
})

freqtradeRoutes.post('/deploy', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  const body = await readJson(c)
  const result = await deployFreqtradeDryRun({
    strategy: stringField(body.strategy),
    pairs: stringList(body.pairs),
    maxOpenTrades: numberField(body.maxOpenTrades),
  })

  if (!result.ok) {
    appendFreqtradeAuditEvent('dry_run_deploy_error', `${stringField(body.strategy) ?? 'unknown'} · ${result.error}`)
    clearFreqtradeSnapshotCache()
    return c.json({ ok: false, error: result.error }, 400)
  }

  clearFreqtradeSnapshotCache()
  appendFreqtradeAuditEvent(
    'dry_run_deployed',
    `${result.data.strategy} · ${result.data.pairs.length || 'existing'} pairs · max ${result.data.maxOpenTrades ?? '--'}`,
  )
  return c.json({ ok: true, result: result.data })
})

freqtradeRoutes.post('/strategy', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  const body = await readJson(c)
  const result = await createFreqtradeStrategy({
    name: stringField(body.name),
    timeframe: stringField(body.timeframe),
    direction: body.direction === 'short' || body.direction === 'both' ? body.direction : 'long',
    indicators: stringList(body.indicators),
  })

  if (!result.ok) {
    appendFreqtradeAuditEvent('strategy_error', `${stringField(body.name) ?? 'unknown'} · ${result.error}`)
    clearFreqtradeSnapshotCache()
    return c.json({ ok: false, error: result.error }, 400)
  }

  clearFreqtradeSnapshotCache()
  appendFreqtradeAuditEvent(
    'strategy_created',
    `${result.data.strategy} · ${result.data.timeframe} · ${result.data.direction}`,
  )
  return c.json({ ok: true, result: result.data })
})

freqtradeRoutes.post('/emergency-stop', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  const result = await emergencyStopFreqtrade()
  clearFreqtradeSnapshotCache()
  if (!result.ok) {
    appendFreqtradeAuditEvent('emergency_stop_error', result.error, 'Operator')
    return c.json({ ok: false, error: result.error }, 502)
  }

  const summary = `open ${result.data.openTradesBefore ?? '--'} · force ${result.data.forceExitError ? 'failed' : 'ok'} · stop ${result.data.stopError ? 'failed' : 'ok'}`
  appendFreqtradeAuditEvent('emergency_stop', summary, 'Operator')
  return c.json(
    { ok: result.data.success, result: result.data },
    result.data.success ? 200 : 502,
  )
})

freqtradeRoutes.post('/reconcile', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  const result = await reconcileFreqtradeAccount()
  appendFreqtradeAuditEvent(
    'reconciliation',
    `${result.status} · bot ${result.botPositions} · exchange ${result.exchangePositions} · mismatch ${result.mismatches.length}`,
    'Operator',
  )
  return c.json(
    { ok: result.status !== 'offline', result },
    result.status === 'offline' ? 503 : 200,
  )
})

freqtradeRoutes.get('/live/session', (c) => c.json({ ok: true, session: getLiveSessionStatus(c) }))

freqtradeRoutes.post('/live/session', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  const body = await readJson(c)
  const response = createLiveSession(c, body.token)
  appendFreqtradeAuditEvent(
    response.status < 400 ? 'live_authorized' : 'live_authorization_denied',
    response.status < 400 ? '10 minute session' : `HTTP ${response.status}`,
    'Operator',
  )
  return response
})

freqtradeRoutes.delete('/live/session', (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  appendFreqtradeAuditEvent('live_authorization_revoked', 'session cleared', 'Operator')
  return clearLiveSession(c)
})

freqtradeRoutes.post('/live/deploy', async (c) => {
  const denied = requireControlAccess(c) || requireLiveAccess(c)
  if (denied) {
    appendFreqtradeAuditEvent('live_deploy_denied', `HTTP ${denied.status}`, 'Operator')
    return denied
  }

  const body = await readJson(c)
  const result = await deployFreqtradeLive({
    strategy: stringField(body.strategy) ?? '',
    pairs: stringList(body.pairs),
    maxOpenTrades: numberField(body.maxOpenTrades),
  })
  clearFreqtradeSnapshotCache()

  if (!result.ok) {
    appendFreqtradeAuditEvent('live_deploy_denied', result.error, 'Operator')
    return c.json({ ok: false, error: result.error }, 400)
  }

  appendFreqtradeAuditEvent(
    'live_deployed',
    `${result.data.strategy} · ${result.data.pairs.length || 'existing'} pairs · max ${result.data.maxOpenTrades}`,
    'Operator',
  )
  return c.json({ ok: true, result: result.data })
})

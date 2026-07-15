import { Hono } from 'hono'
import type { EconomicCalendarSnapshot, MacroSnapshot } from '@helix/contracts/market'
import { getEconomicCalendarSnapshot } from '@helix/core/macro/economic-calendar'
import { getFredMacroSnapshot } from '@helix/core/macro/fred'

const CACHE_TTL_MS = 300_000
const ERROR_CACHE_TTL_MS = 10_000
let macroCache: { expiresAt: number; payload: MacroSnapshot } | null = null
let calendarCache: { expiresAt: number; payload: EconomicCalendarSnapshot } | null = null

export const macroRoutes = new Hono()

macroRoutes.get('/snapshot', async (c) => {
  if (macroCache && macroCache.expiresAt > Date.now()) return c.json(macroCache.payload)

  const payload = await getFredMacroSnapshot()
  macroCache = {
    expiresAt: Date.now() + (payload.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS),
    payload,
  }
  return c.json(payload)
})

macroRoutes.get('/calendar', async (c) => {
  if (calendarCache && calendarCache.expiresAt > Date.now()) return c.json(calendarCache.payload)

  const payload = await getEconomicCalendarSnapshot()
  calendarCache = {
    expiresAt: Date.now() + (payload.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS),
    payload,
  }
  return c.json(payload)
})

import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { attachMarketWebSocket } from './market-stream'
import { accountRoutes } from './routes/account'
import { agentRoutes } from './routes/agent'
import { controlRoutes } from './routes/control'
import { freqtradeRoutes } from './routes/freqtrade'
import { macroRoutes } from './routes/macro'
import { marketRoutes } from './routes/market'
import { strategyRoutes } from './routes/strategy'
import { startAgentScheduler } from './agent/scheduler'

const DEFAULT_PORT = 8787
const configuredPort = Number.parseInt(process.env.HELIX_PORT ?? '', 10)
const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : DEFAULT_PORT
const hostname = process.env.HELIX_HOST?.trim() || '127.0.0.1'

export const app = new Hono()

app.use('/api/agent/*', cors({
  origin: ['http://127.0.0.1:3000', 'http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  exposeHeaders: ['Content-Type', 'x-vercel-ai-ui-message-stream'],
  maxAge: 600,
}))

app.use('/api/*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})

app.get('/health', (c) => c.json({ ok: true, service: 'helixd' }))
app.route('/api/account', accountRoutes)
app.route('/api/agent', agentRoutes)
app.route('/api/control', controlRoutes)
app.route('/api/freqtrade', freqtradeRoutes)
app.route('/api/macro', macroRoutes)
app.route('/api/market', marketRoutes)
app.route('/api/strategy', strategyRoutes)

app.notFound((c) => c.json({ ok: false, error: 'Not found' }, 404))
app.onError((error, c) => {
  console.error(error)
  return c.json({ ok: false, error: 'Internal server error' }, 500)
})

const server = serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`helixd listening on http://${info.address}:${info.port}`)
})
const webSocketServer = attachMarketWebSocket(server as Server)
const agentScheduler = startAgentScheduler()

function shutdown() {
  agentScheduler.stop()
  webSocketServer.close()
  server.close(() => process.exit(0))
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

import { Hono } from 'hono'
import { loadStrategyRepositorySnapshot } from '@helix/core/strategy/repository'

export const strategyRoutes = new Hono()

strategyRoutes.get('/repository', async (c) => c.json(await loadStrategyRepositorySnapshot()))

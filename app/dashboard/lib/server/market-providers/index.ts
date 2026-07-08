import { okxMarketProvider } from './okx'
import type { MarketDataProvider } from './types'

const providers = {
  okx: okxMarketProvider,
} satisfies Record<string, MarketDataProvider>

export function getMarketDataProvider(id = 'okx'): MarketDataProvider {
  return providers[id as keyof typeof providers] ?? providers.okx
}

export { resolveTradingPair } from './types'

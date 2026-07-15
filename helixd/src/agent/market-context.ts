import type { AgentScope } from '@helix/contracts/agent'
import {
  INTRADAY_STRATEGY_VERSION,
  type IntradaySignalSnapshot,
  type IntradaySignalTimeframe,
} from '@helix/contracts/market'
import { getIntradaySignalSnapshot } from '@helix/core/signals/snapshot'

const TIMEFRAMES: IntradaySignalTimeframe[] = ['1h', '15m', '5m']
const STORY_TIMEFRAMES = new Set<IntradaySignalTimeframe>(TIMEFRAMES)

export type MarketEvidence = {
  ref: string
  value: string
}

export type AgentMarketContext = AgentScope & {
  generatedAt: number
  source: IntradaySignalSnapshot['source']
  analysisSource: string
  strategyVersion: string
  canPersistStory: boolean
  persistenceBlockReason: string | null
  evidence: MarketEvidence[]
}

function add(evidence: MarketEvidence[], ref: string, value: unknown) {
  if (value == null || value === '') return
  evidence.push({ ref, value: typeof value === 'string' ? value : JSON.stringify(value) })
}

export function marketEvidenceFromSnapshot(snapshot: IntradaySignalSnapshot): MarketEvidence[] {
  const evidence: MarketEvidence[] = []
  const strategy = snapshot.strategy
  add(evidence, 'strategy.version', strategy?.version)
  add(evidence, 'strategy.context', strategy?.context)
  for (const setup of strategy?.setups ?? []) {
    add(evidence, `strategy.setup.${setup.timeframe}`, setup)
  }
  add(evidence, 'strategy.selectedTimeframe', strategy?.selectedTimeframe)
  add(evidence, 'signal.status', snapshot.signal.status)
  add(evidence, 'signal.side', snapshot.signal.side)
  add(evidence, 'signal.bias', snapshot.signal.bias)
  add(evidence, 'signal.confidence', {
    value: snapshot.signal.confidence,
    level: snapshot.signal.confidenceLevel,
  })
  snapshot.signal.logic.forEach((value, index) => add(evidence, `signal.logic.${index}`, value))
  snapshot.signal.warnings.forEach((value, index) => add(evidence, `signal.warning.${index}`, value))

  for (const timeframe of TIMEFRAMES) {
    const analysis = snapshot.timeframes[timeframe]
    if (!analysis) continue
    add(evidence, `timeframes.${timeframe}.close`, {
      close: analysis.close,
      closedAt: analysis.latestTime,
      atr: analysis.atr,
    })
    add(evidence, `timeframes.${timeframe}.priceAction`, analysis.priceAction)
    add(evidence, `timeframes.${timeframe}.macd`, analysis.macd)
    add(evidence, `timeframes.${timeframe}.rsi`, analysis.rsi)
    add(evidence, `timeframes.${timeframe}.volume`, analysis.volume)
  }
  snapshot.source.errors.forEach((value, index) => add(evidence, `source.error.${index}`, value))
  return evidence
}

export async function getAgentMarketContext(scope: AgentScope): Promise<AgentMarketContext> {
  const snapshot = await getIntradaySignalSnapshot({ symbol: scope.symbol })
  const supportedTimeframe = STORY_TIMEFRAMES.has(scope.timeframe as IntradaySignalTimeframe)
  const live = snapshot.ok && snapshot.source.status === 'live'
  const persistenceBlockReason = !live
    ? '市场事实源当前不是 live，禁止更新 Market Story'
    : !supportedTimeframe
      ? `当前分析器不支持 ${scope.timeframe} Market Story`
      : null

  return {
    symbol: snapshot.activeSymbol,
    timeframe: scope.timeframe,
    generatedAt: snapshot.generatedAt,
    source: snapshot.source,
    analysisSource: 'helix-intraday-signal',
    strategyVersion: snapshot.strategy?.version ?? INTRADAY_STRATEGY_VERSION,
    canPersistStory: persistenceBlockReason == null,
    persistenceBlockReason,
    evidence: marketEvidenceFromSnapshot(snapshot),
  }
}

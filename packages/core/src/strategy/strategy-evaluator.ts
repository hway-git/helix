import { isDeepStrictEqual } from 'node:util'
import type {
  StrategyDecisionIdentity,
  StrategyHistoricalDataset,
  StrategyHistoricalRiskTraceEntry,
  StrategyManifestIdentity,
} from '@helix/contracts/strategy'
import { scalpHistoricalConfig, swingHistoricalConfig } from './historical-config'
import { createStrategyHistoricalRiskTrace } from './historical-risk'
import { runHistoricalStrategy } from './historical-runner'
import {
  ScalpHistoricalEvaluator,
  type ScalpHistoricalEvaluatorCheckpoint,
} from './scalp-historical'
import {
  SwingHistoricalEvaluator,
  type SwingHistoricalEvaluatorCheckpoint,
} from './swing-historical'

export type StrategyEvaluatorCheckpoint =
  | ScalpHistoricalEvaluatorCheckpoint
  | SwingHistoricalEvaluatorCheckpoint

function evaluatorTimeframes(
  manifest: StrategyManifestIdentity,
  expected: Record<string, string>,
) {
  const actual = Object.fromEntries(manifest.timeframes.map(({ role, timeframe }) => [role, timeframe]))
  const expectedRoles = Object.keys(expected).sort()
  const actualRoles = Object.keys(actual).sort()
  if (!isDeepStrictEqual(actualRoles, expectedRoles)
    || expectedRoles.some((role) => actual[role] !== expected[role])) {
    throw new Error(`${manifest.id} manifest timeframes do not match the current V1 evaluator`)
  }
  return {
    baseTimeframe: expected.execution!,
    requiredTimeframes: manifest.timeframes.map(({ timeframe }) => timeframe),
  }
}

export function createStrategyEvaluator(
  manifest: StrategyManifestIdentity,
  recordHistoricalRiskEntry?: (entry: StrategyHistoricalRiskTraceEntry) => void,
  checkpoint?: StrategyEvaluatorCheckpoint,
) {
  if (manifest.id === 'helix_scalp_hunter') {
    if (manifest.family !== 'scalp' || manifest.objectModel !== 'PRICE_EVENT') {
      throw new Error('helix_scalp_hunter manifest family/objectModel is invalid')
    }
    const timeframes = evaluatorTimeframes(manifest, {
      regime: '1h', hunting_zone: '15m', price_event: '5m', execution: '1m',
    })
    const config = scalpHistoricalConfig(manifest)
    if (checkpoint && checkpoint.schemaVersion !== 'helix.scalp-evaluator-checkpoint/v2') {
      throw new Error('Scalp strategy cannot restore a non-Scalp evaluator checkpoint')
    }
    const evaluator = new ScalpHistoricalEvaluator(config, recordHistoricalRiskEntry, checkpoint)
    const warmupDurationMs = Math.max(
      Math.max(config.marketRegime.slowWindowBars + 1, config.marketRegime.emaPeriod + 1) * 60 * 60_000,
      Math.max(config.huntingZone.lookbackBars, config.huntingZone.atrPeriod + 1) * 15 * 60_000,
      15 * 60_000,
    )
    const retentionMsByTimeframe = {
      // Regime EMA is currently seeded from the full hourly history.
      '1h': Number.MAX_SAFE_INTEGER,
      '15m': Math.max(config.huntingZone.lookbackBars, config.huntingZone.atrPeriod + 1) * 15 * 60_000,
      '5m': 21 * 5 * 60_000,
      '1m': 15 * 60_000,
    }
    return {
      ...timeframes,
      warmupDurationMs,
      retentionMsByTimeframe,
      evaluate: evaluator.evaluate,
      statistics: () => evaluator.statistics(),
      checkpoint: () => evaluator.checkpoint(),
    }
  }
  if (manifest.id === 'helix_swing_hunter') {
    if (manifest.family !== 'swing' || manifest.objectModel !== 'TRADE_THESIS') {
      throw new Error('helix_swing_hunter manifest family/objectModel is invalid')
    }
    const timeframes = evaluatorTimeframes(manifest, {
      context: '1d', thesis: '4h', evidence: '1h', execution: '15m',
    })
    const config = swingHistoricalConfig(manifest)
    if (checkpoint && checkpoint.schemaVersion !== 'helix.swing-evaluator-checkpoint/v3') {
      throw new Error('Swing strategy cannot restore a non-Swing evaluator checkpoint')
    }
    const evaluator = new SwingHistoricalEvaluator(config, recordHistoricalRiskEntry, checkpoint)
    const warmupDurationMs = Math.max(
      Math.max(config.dailyContext.slowWindowBars + 1, config.dailyContext.emaPeriod + 1) * 24 * 60 * 60_000,
      Math.max(config.location.lookbackBars, config.location.atrPeriod + 1) * 4 * 60 * 60_000,
      15 * 15 * 60_000,
    )
    const retentionMsByTimeframe = {
      // Daily Context EMA is currently seeded from the full daily history.
      '1d': Number.MAX_SAFE_INTEGER,
      '4h': Math.max(config.location.lookbackBars, config.location.atrPeriod + 1) * 4 * 60 * 60_000,
      '1h': 2 * 60 * 60_000,
      '15m': 15 * 15 * 60_000,
    }
    return {
      ...timeframes,
      warmupDurationMs,
      retentionMsByTimeframe,
      evaluate: evaluator.evaluate,
      statistics: () => evaluator.statistics(),
      checkpoint: () => evaluator.checkpoint(),
    }
  }
  throw new Error(`historical evaluator is unavailable for ${manifest.id}`)
}

export function evaluateStrategyDataset(options: {
  manifest: StrategyManifestIdentity
  dataset: StrategyHistoricalDataset
  identity: StrategyDecisionIdentity
  firstDecisionTime?: number
}) {
  const { manifest, dataset, identity, firstDecisionTime } = options
  const riskEntries: StrategyHistoricalRiskTraceEntry[] = []
  const evaluator = createStrategyEvaluator(manifest, (entry) => riskEntries.push(entry))
  const artifact = runHistoricalStrategy({
    dataset, identity, strategyLifecycle: manifest.lifecycle, objectModel: manifest.objectModel,
    baseTimeframe: evaluator.baseTimeframe,
    requiredTimeframes: evaluator.requiredTimeframes,
    firstDecisionTime,
    registeredReasonCodes: manifest.reasonCodes,
    evaluate: evaluator.evaluate,
  })
  const riskTrace = createStrategyHistoricalRiskTrace({
    schemaVersion: 'helix.historical-risk-trace/v1',
    signalArtifactHash: artifact.artifactHash,
    entries: riskEntries,
  }, artifact)
  return { artifact, riskTrace, statistics: evaluator.statistics() }
}

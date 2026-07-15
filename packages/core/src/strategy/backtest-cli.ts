import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type {
  StrategyDecisionIdentity,
  StrategyHistoricalDataset,
  StrategyManifestIdentity,
} from '@helix/contracts/strategy'
import { assertStrategySignalArtifact } from './signal-artifact'
import { assertStrategyHistoricalDataset } from './historical-dataset'
import { runHistoricalStrategy } from './historical-runner'
import { scalpHistoricalConfig, swingHistoricalConfig } from './historical-config'
import { ScalpHistoricalEvaluator } from './scalp-historical'
import { SwingHistoricalEvaluator } from './swing-historical'
import {
  createStrategyDecisionIdentityFromSnapshot,
  loadStrategyRepositorySnapshot,
} from './repository'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('params must be an object')
  return value as Record<string, unknown>
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

async function writeJsonAtomic(file: string, value: unknown) {
  const destination = resolve(file)
  const temporary = `${destination}.tmp.${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, destination)
  return destination
}

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

function evaluateHistoricalStrategy(
  manifest: StrategyManifestIdentity,
  dataset: StrategyHistoricalDataset,
  identity: StrategyDecisionIdentity,
) {
  if (manifest.id === 'helix_scalp_hunter') {
    const timeframes = evaluatorTimeframes(manifest, {
      regime: '1h', hunting_zone: '15m', price_event: '5m', execution: '1m',
    })
    const evaluator = new ScalpHistoricalEvaluator(scalpHistoricalConfig(manifest))
    const artifact = runHistoricalStrategy({
      dataset, identity, strategyLifecycle: manifest.lifecycle, objectModel: manifest.objectModel,
      ...timeframes, registeredReasonCodes: manifest.reasonCodes, evaluate: evaluator.evaluate,
    })
    return { artifact, statistics: evaluator.statistics() }
  }
  if (manifest.id === 'helix_swing_hunter') {
    const timeframes = evaluatorTimeframes(manifest, {
      context: '1d', thesis: '4h', evidence: '1h', execution: '15m',
    })
    const evaluator = new SwingHistoricalEvaluator(swingHistoricalConfig(manifest))
    const artifact = runHistoricalStrategy({
      dataset, identity, strategyLifecycle: manifest.lifecycle, objectModel: manifest.objectModel,
      ...timeframes, registeredReasonCodes: manifest.reasonCodes, evaluate: evaluator.evaluate,
    })
    return { artifact, statistics: evaluator.statistics() }
  }
  throw new Error(`historical evaluator is unavailable for ${manifest.id}`)
}

async function run(params: Record<string, unknown>) {
  const datasetFile = resolve(text(params.dataset, 'params.dataset'))
  const dataset = assertStrategyHistoricalDataset(JSON.parse(await readFile(datasetFile, 'utf8')))
  const strategyId = text(params.strategyId, 'params.strategyId')
  const snapshot = await loadStrategyRepositorySnapshot()
  if (!snapshot.ok) throw new Error(snapshot.errors[0] || 'strategy repository unavailable')
  const manifest = snapshot.manifests.find((candidate) => candidate.id === strategyId)
  if (!manifest) throw new Error(`unknown strategy ${strategyId}`)
  const identity = createStrategyDecisionIdentityFromSnapshot(snapshot, {
    strategyId,
    marketDataSnapshotId: dataset.datasetHash,
  })

  const first = evaluateHistoricalStrategy(manifest, dataset, identity)
  const replay = evaluateHistoricalStrategy(manifest, dataset, identity)
  if (!isDeepStrictEqual(replay, first)) {
    throw new Error('historical strategy replay is non-deterministic')
  }
  const verifiedIdentity = createStrategyDecisionIdentityFromSnapshot(
    await loadStrategyRepositorySnapshot(),
    { strategyId, marketDataSnapshotId: dataset.datasetHash },
  )
  if (!isDeepStrictEqual(verifiedIdentity, identity)) {
    throw new Error('strategy or Engine identity changed during historical backtest')
  }
  const output = await writeJsonAtomic(text(params.output, 'params.output'), first.artifact)
  return {
    ok: true,
    output,
    artifactHash: first.artifact.artifactHash,
    identity: first.artifact.identity,
    lifecycle: first.artifact.strategyLifecycle,
    signals: first.artifact.signals.length,
    statistics: first.statistics,
    replay: { ok: true, artifactHash: replay.artifact.artifactHash },
  }
}

async function main() {
  const args = process.argv.slice(2).filter((value) => value !== '--')
  const action = args[0]
  const params = record(JSON.parse(args[1] || '{}'))
  if (action === 'run') return run(params)
  if (action === 'verify') {
    const input = resolve(text(params.input, 'params.input'))
    const artifact = assertStrategySignalArtifact(JSON.parse(await readFile(input, 'utf8')))
    return { ok: true, input, artifactHash: artifact.artifactHash, identity: artifact.identity, signals: artifact.signals.length }
  }
  throw new Error('Usage: backtest-cli.ts <run|verify> <json-params>')
}

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })

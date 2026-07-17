import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type {
  StrategyDecisionIdentity,
  StrategyHistoricalDataset,
  StrategyManifestIdentity,
} from '@helix/contracts/strategy'
import { assertStrategyHistoricalRiskTrace } from './historical-risk'
import { assertStrategySignalArtifact } from './signal-artifact'
import { assertStrategyHistoricalDataset } from './historical-dataset'
import { evaluateStrategyDataset } from './strategy-evaluator'
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

function optionalText(value: unknown, name: string) {
  return value === undefined ? undefined : text(value, name)
}

function optionalTimestamp(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value)
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  }
  throw new Error(`${name} must be a non-negative integer timestamp or ISO date`)
}

async function writeJsonAtomic(file: string, value: unknown) {
  const destination = resolve(file)
  const temporary = `${destination}.tmp.${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, destination)
  return destination
}

function evaluateHistoricalStrategy(
  manifest: StrategyManifestIdentity,
  dataset: StrategyHistoricalDataset,
  identity: StrategyDecisionIdentity,
  firstDecisionTime?: number,
) {
  return evaluateStrategyDataset({ manifest, dataset, identity, firstDecisionTime })
}

async function run(params: Record<string, unknown>) {
  const datasetFile = resolve(text(params.dataset, 'params.dataset'))
  const dataset = assertStrategyHistoricalDataset(JSON.parse(await readFile(datasetFile, 'utf8')))
  const strategyId = text(params.strategyId, 'params.strategyId')
  const firstDecisionTime = optionalTimestamp(params.firstDecisionTime, 'params.firstDecisionTime')
  const snapshot = await loadStrategyRepositorySnapshot()
  if (!snapshot.ok) throw new Error(snapshot.errors[0] || 'strategy repository unavailable')
  const manifest = snapshot.manifests.find((candidate) => candidate.id === strategyId)
  if (!manifest) throw new Error(`unknown strategy ${strategyId}`)
  const identity = createStrategyDecisionIdentityFromSnapshot(snapshot, {
    strategyId,
    marketDataSnapshotId: dataset.datasetHash,
  })

  const first = evaluateHistoricalStrategy(manifest, dataset, identity, firstDecisionTime)
  const replay = evaluateHistoricalStrategy(manifest, dataset, identity, firstDecisionTime)
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
  const outputFile = resolve(text(params.output, 'params.output'))
  const riskTraceFile = resolve(optionalText(params.riskTraceOutput, 'params.riskTraceOutput')
    ?? `${outputFile}.risk-trace.json`)
  if (riskTraceFile === outputFile) {
    throw new Error('params.riskTraceOutput must differ from params.output')
  }
  const output = await writeJsonAtomic(outputFile, first.artifact)
  const riskTraceOutput = await writeJsonAtomic(riskTraceFile, first.riskTrace)
  return {
    ok: true,
    output,
    artifactHash: first.artifact.artifactHash,
    identity: first.artifact.identity,
    lifecycle: first.artifact.strategyLifecycle,
    signals: first.artifact.signals.length,
    riskTraceOutput,
    riskTraceHash: first.riskTrace.traceHash,
    riskEntries: first.riskTrace.entries.length,
    statistics: first.statistics,
    replay: {
      ok: true,
      artifactHash: replay.artifact.artifactHash,
      riskTraceHash: replay.riskTrace.traceHash,
    },
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
    const riskTraceInputValue = optionalText(params.riskTraceInput, 'params.riskTraceInput')
    const riskTraceInput = riskTraceInputValue ? resolve(riskTraceInputValue) : undefined
    const riskTrace = riskTraceInput
      ? assertStrategyHistoricalRiskTrace(JSON.parse(await readFile(riskTraceInput, 'utf8')), artifact)
      : undefined
    return {
      ok: true,
      input,
      artifactHash: artifact.artifactHash,
      identity: artifact.identity,
      signals: artifact.signals.length,
      ...(riskTrace && riskTraceInput ? {
        riskTraceInput,
        riskTraceHash: riskTrace.traceHash,
        riskEntries: riskTrace.entries.length,
      } : {}),
    }
  }
  throw new Error('Usage: backtest-cli.ts <run|verify> <json-params>')
}

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })

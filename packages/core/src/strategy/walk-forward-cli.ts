import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { assertStrategyHistoricalDataset } from './historical-dataset'
import { loadStrategyRepositorySnapshot } from './repository'
import {
  assertStrategyWalkForwardPlan,
  assertStrategyWalkForwardRun,
  assertStrategyWalkForwardCandidateSnapshot,
  createStrategyWalkForwardPlan,
  createStrategyWalkForwardPlanFromPolicy,
  runStrategyWalkForward,
} from './walk-forward'
import { createStrategyWalkForwardPortfolioPlan } from './walk-forward-portfolio'

type UnknownRecord = Record<string, unknown>

function exactRecord(value: unknown, name: string, fields: readonly string[]): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${fields.join(', ')}`)
  }
  return value as UnknownRecord
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty trimmed string`)
  }
  return value
}

function timestamp(value: unknown, name: string) {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value)
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  }
  throw new Error(`${name} must be an integer timestamp or ISO date`)
}

async function writeJsonAtomic(file: string, value: unknown) {
  const temporary = `${file}.tmp.${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

async function main() {
  const args = process.argv.slice(2).filter((value) => value !== '--')
  const action = args[0]
  if (action !== 'run' && action !== 'run-policy' && action !== 'portfolio-plan') {
    throw new Error('Usage: walk-forward-cli.ts <run|run-policy|portfolio-plan> <json-params>')
  }
  if (action === 'portfolio-plan') {
    const params = exactRecord(JSON.parse(args[1] || '{}'), 'params', [
      'strategyId', 'members', 'outputDirectory',
    ])
    if (!Array.isArray(params.members) || params.members.length < 2) {
      throw new Error('params.members must contain at least two child runs')
    }
    const members = await Promise.all(params.members.map(async (value, index) => {
      const member = exactRecord(value, `params.members[${index}]`, ['run'])
      const runFile = resolve(text(member.run, `params.members[${index}].run`))
      const run = assertStrategyWalkForwardRun(JSON.parse(await readFile(runFile, 'utf8')))
      const plan = assertStrategyWalkForwardPlan(JSON.parse(await readFile(
        resolve(dirname(runFile), run.planFile),
        'utf8',
      )))
      return { plan, run }
    }))
    const snapshot = await loadStrategyRepositorySnapshot()
    if (!snapshot.ok) throw new Error(snapshot.errors[0] || 'strategy repository unavailable')
    const portfolioPlan = createStrategyWalkForwardPortfolioPlan({
      snapshot,
      strategyId: text(params.strategyId, 'params.strategyId'),
      members,
    })
    const outputDirectory = resolve(text(params.outputDirectory, 'params.outputDirectory'))
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
    const planFile = resolve(outputDirectory, 'walk-forward-portfolio-plan.json')
    await writeJsonAtomic(planFile, portfolioPlan)
    const currentSnapshot = await loadStrategyRepositorySnapshot()
    if (!currentSnapshot.ok) throw new Error(currentSnapshot.errors[0] || 'strategy repository unavailable')
    const currentPlan = createStrategyWalkForwardPortfolioPlan({
      snapshot: currentSnapshot,
      strategyId: portfolioPlan.candidate.strategyId,
      members,
    })
    if (currentPlan.planHash !== portfolioPlan.planHash) {
      throw new Error('walk-forward portfolio identity changed during plan creation')
    }
    return {
      ok: true,
      planFile,
      planHash: portfolioPlan.planHash,
      members: portfolioPlan.members.map(({ source, planHash, runHash }) => ({
        symbol: source.symbol,
        planHash,
        runHash,
      })),
    }
  }
  const params = exactRecord(JSON.parse(args[1] || '{}'), 'params', [
    'dataset',
    'strategyId',
    'activationDecisionTime',
    ...(action === 'run' ? ['folds', 'executionScenarios'] : []),
    'outputDirectory',
  ])
  if (action === 'run' && (!Array.isArray(params.folds) || params.folds.length === 0)) {
    throw new Error('params.folds must be a non-empty array')
  }
  if (action === 'run' && !Array.isArray(params.executionScenarios)) {
    throw new Error('params.executionScenarios must be an array')
  }
  const dataset = assertStrategyHistoricalDataset(JSON.parse(await readFile(
    resolve(text(params.dataset, 'params.dataset')),
    'utf8',
  )))
  const snapshot = await loadStrategyRepositorySnapshot()
  if (!snapshot.ok) throw new Error(snapshot.errors[0] || 'strategy repository unavailable')
  const common = {
    snapshot,
    strategyId: text(params.strategyId, 'params.strategyId'),
    dataset,
    activationDecisionTime: timestamp(params.activationDecisionTime, 'params.activationDecisionTime'),
  }
  const plan = action === 'run-policy'
    ? createStrategyWalkForwardPlanFromPolicy(common)
    : createStrategyWalkForwardPlan({
      ...common,
      folds: (params.folds as unknown[]).map((value, index) => {
      const fold = exactRecord(value, `params.folds[${index}]`, [
        'entryWindowStartTime', 'entryWindowEndTime', 'observationEndTime',
      ])
      return {
        entryWindowStartTime: timestamp(
          fold.entryWindowStartTime,
          `params.folds[${index}].entryWindowStartTime`,
        ),
        entryWindowEndTime: timestamp(
          fold.entryWindowEndTime,
          `params.folds[${index}].entryWindowEndTime`,
        ),
        observationEndTime: timestamp(
          fold.observationEndTime,
          `params.folds[${index}].observationEndTime`,
        ),
      }
      }),
      executionScenarios: (params.executionScenarios as unknown[]).map((value, index) => {
      const scenario = exactRecord(value, `params.executionScenarios[${index}]`, ['id', 'fee'])
      return {
        id: text(scenario.id, `params.executionScenarios[${index}].id`),
        fee: scenario.fee as number,
      }
      }),
    })
  const built = runStrategyWalkForward({ plan, snapshot, dataset })

  assertStrategyWalkForwardCandidateSnapshot(plan, await loadStrategyRepositorySnapshot())
  const outputDirectory = resolve(text(params.outputDirectory, 'params.outputDirectory'))
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  for (const [index, file] of built.files.entries()) {
    const fold = built.run.folds[index]!
    await writeJsonAtomic(resolve(outputDirectory, fold.datasetFile), file.dataset)
    await writeJsonAtomic(resolve(outputDirectory, fold.decisionArtifactFile), file.decisionArtifact)
    await writeJsonAtomic(resolve(outputDirectory, fold.decisionRiskTraceFile), file.decisionRiskTrace)
    await writeJsonAtomic(resolve(outputDirectory, fold.replayArtifactFile), file.replayArtifact)
    await writeJsonAtomic(resolve(outputDirectory, fold.executionArtifactFile), file.executionArtifact)
    await writeJsonAtomic(resolve(outputDirectory, fold.executionRiskTraceFile), file.executionRiskTrace)
  }
  const planFile = resolve(outputDirectory, built.run.planFile)
  const runFile = resolve(outputDirectory, 'walk-forward-run.json')
  await writeJsonAtomic(planFile, plan)
  await writeJsonAtomic(runFile, built.run)
  assertStrategyWalkForwardCandidateSnapshot(plan, await loadStrategyRepositorySnapshot())
  return {
    ok: true,
    planFile,
    planHash: plan.planHash,
    runFile,
    runHash: built.run.runHash,
    folds: built.run.folds.length,
  }
}

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })

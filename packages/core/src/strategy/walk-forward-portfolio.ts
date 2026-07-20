import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  STRATEGY_WALK_FORWARD_PLAN_SCHEMA_VERSION,
  STRATEGY_WALK_FORWARD_PORTFOLIO_PLAN_SCHEMA_VERSION,
  type StrategyHistoricalDatasetSource,
  type StrategyRepositorySnapshot,
  type StrategyWalkForwardPlan,
  type StrategyWalkForwardPortfolioPlan,
  type StrategyWalkForwardPortfolioPlanMember,
  type StrategyWalkForwardPortfolioPlanPayload,
  type StrategyWalkForwardRun,
} from '@helix/contracts/strategy'
import {
  assertStrategyWalkForwardCandidateSnapshot,
  assertStrategyWalkForwardPlan,
  assertStrategyWalkForwardRun,
  assertStrategyWalkForwardPolicy,
  createStrategyWalkForwardPlanArtifact,
} from './walk-forward'

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/

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

function integer(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return Number(value)
}

function hash(value: unknown, name: string) {
  const normalized = text(value, name)
  if (!HASH_PATTERN.test(normalized)) throw new Error(`${name} must be a SHA-256 hash`)
  return normalized
}

function source(value: unknown, name: string): StrategyHistoricalDatasetSource {
  const parsed = exactRecord(value, name, ['provider', 'market', 'instrumentId', 'symbol'])
  return {
    provider: text(parsed.provider, `${name}.provider`),
    market: text(parsed.market, `${name}.market`),
    instrumentId: text(parsed.instrumentId, `${name}.instrumentId`),
    symbol: text(parsed.symbol, `${name}.symbol`),
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('portfolio plan canonical numbers must be finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as UnknownRecord
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`
  }
  throw new Error(`unsupported portfolio plan value ${typeof value}`)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as UnknownRecord)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function normalizeMember(value: unknown, index: number): StrategyWalkForwardPortfolioPlanMember {
  const name = `members[${index}]`
  const member = exactRecord(value, name, [
    'source', 'sourceDatasetHash', 'capturedThrough', 'planHash', 'runHash',
  ])
  return {
    source: source(member.source, `${name}.source`),
    sourceDatasetHash: hash(member.sourceDatasetHash, `${name}.sourceDatasetHash`),
    capturedThrough: integer(member.capturedThrough, `${name}.capturedThrough`),
    planHash: hash(member.planHash, `${name}.planHash`),
    runHash: hash(member.runHash, `${name}.runHash`),
  }
}

function normalizePayload(value: unknown): StrategyWalkForwardPortfolioPlanPayload {
  const parsed = exactRecord(value, 'walk-forward portfolio plan payload', [
    'schemaVersion', 'mode', 'candidate', 'walkForwardPolicy', 'members', 'baseTimeframe',
    'requiredTimeframes', 'activationDecisionTime', 'warmupDurationMs', 'folds', 'executionScenarios',
  ])
  if (parsed.schemaVersion !== STRATEGY_WALK_FORWARD_PORTFOLIO_PLAN_SCHEMA_VERSION) {
    throw new Error(`unsupported walk-forward portfolio plan schema ${String(parsed.schemaVersion)}`)
  }
  if (parsed.mode !== 'fixed_candidate_multi_symbol') {
    throw new Error('walk-forward portfolio plan mode must be fixed_candidate_multi_symbol')
  }
  if (!Array.isArray(parsed.members) || parsed.members.length < 2) {
    throw new Error('walk-forward portfolio plan must contain at least two members')
  }
  const members = parsed.members.map(normalizeMember)
  if (new Set(members.map(({ source: memberSource }) => memberSource.symbol)).size !== members.length) {
    throw new Error('walk-forward portfolio plan contains duplicate symbols')
  }
  if (new Set(members.map(({ source: memberSource }) => memberSource.instrumentId)).size !== members.length) {
    throw new Error('walk-forward portfolio plan contains duplicate instrument ids')
  }
  if (new Set(members.map(({ sourceDatasetHash }) => sourceDatasetHash)).size !== members.length) {
    throw new Error('walk-forward portfolio plan contains duplicate source datasets')
  }
  if (new Set(members.map(({ planHash }) => planHash)).size !== members.length
    || new Set(members.map(({ runHash }) => runHash)).size !== members.length) {
    throw new Error('walk-forward portfolio plan contains duplicate child identities')
  }
  const walkForwardPolicy = assertStrategyWalkForwardPolicy(parsed.walkForwardPolicy)
  const symbolStability = walkForwardPolicy.gates.symbolStability
  if (walkForwardPolicy.schemaVersion !== 'helix.walk-forward-policy/v2' || !symbolStability) {
    throw new Error('walk-forward portfolio plan requires a V2 policy with symbol stability')
  }
  if (!isDeepStrictEqual(members.map(({ source: memberSource }) => memberSource), symbolStability.members)) {
    throw new Error('walk-forward portfolio plan members do not exactly match the policy symbol universe')
  }
  const representative = members[0]!
  const shared = createStrategyWalkForwardPlanArtifact({
    schemaVersion: STRATEGY_WALK_FORWARD_PLAN_SCHEMA_VERSION,
    mode: 'fixed_candidate',
    candidate: parsed.candidate as never,
    walkForwardPolicy,
    sourceDataset: {
      datasetHash: representative.sourceDatasetHash,
      source: representative.source,
      capturedThrough: representative.capturedThrough,
    },
    baseTimeframe: parsed.baseTimeframe as string,
    requiredTimeframes: parsed.requiredTimeframes as string[],
    activationDecisionTime: parsed.activationDecisionTime as number,
    warmupDurationMs: parsed.warmupDurationMs as number,
    folds: parsed.folds as never,
    executionScenarios: parsed.executionScenarios as never,
  })
  if (members.some(({ capturedThrough }) => (
    shared.folds.some((fold) => fold.observationEndTime > capturedThrough)
  ))) throw new Error('walk-forward portfolio member does not cover every fold observation window')
  return {
    schemaVersion: STRATEGY_WALK_FORWARD_PORTFOLIO_PLAN_SCHEMA_VERSION,
    mode: 'fixed_candidate_multi_symbol',
    candidate: shared.candidate,
    walkForwardPolicy,
    members,
    baseTimeframe: shared.baseTimeframe,
    requiredTimeframes: shared.requiredTimeframes,
    activationDecisionTime: shared.activationDecisionTime,
    warmupDurationMs: shared.warmupDurationMs,
    folds: shared.folds,
    executionScenarios: shared.executionScenarios,
  }
}

export function strategyWalkForwardPortfolioPlanHash(payload: StrategyWalkForwardPortfolioPlanPayload) {
  const normalized = normalizePayload(payload)
  return `sha256:${createHash('sha256').update(canonicalJson(normalized)).digest('hex')}`
}

export function createStrategyWalkForwardPortfolioPlanArtifact(
  payload: StrategyWalkForwardPortfolioPlanPayload,
): StrategyWalkForwardPortfolioPlan {
  const normalized = normalizePayload(payload)
  return deepFreeze({ ...normalized, planHash: strategyWalkForwardPortfolioPlanHash(normalized) })
}

export function assertStrategyWalkForwardPortfolioPlan(value: unknown): StrategyWalkForwardPortfolioPlan {
  const parsed = exactRecord(value, 'walk-forward portfolio plan', [
    'schemaVersion', 'mode', 'candidate', 'walkForwardPolicy', 'members', 'baseTimeframe',
    'requiredTimeframes', 'activationDecisionTime', 'warmupDurationMs', 'folds', 'executionScenarios',
    'planHash',
  ])
  const planHash = hash(parsed.planHash, 'planHash')
  const payload = normalizePayload(Object.fromEntries(
    Object.entries(parsed).filter(([field]) => field !== 'planHash'),
  ))
  const expectedHash = strategyWalkForwardPortfolioPlanHash(payload)
  if (planHash !== expectedHash) {
    throw new Error(`walk-forward portfolio plan hash mismatch: expected ${expectedHash}`)
  }
  return deepFreeze({ ...payload, planHash })
}

function assertRunMatchesPlan(run: StrategyWalkForwardRun, plan: StrategyWalkForwardPlan, index: number) {
  if (run.planHash !== plan.planHash) {
    throw new Error(`portfolio member ${index} run does not match its plan hash`)
  }
  if (run.folds.length !== plan.folds.length || run.folds.some((fold, foldIndex) => {
    const planned = plan.folds[foldIndex]
    return !planned
      || fold.sequence !== planned.sequence
      || fold.entryWindowStartTime !== planned.entryWindowStartTime
      || fold.entryWindowEndTime !== planned.entryWindowEndTime
      || fold.observationEndTime !== planned.observationEndTime
  })) throw new Error(`portfolio member ${index} run fold windows do not match its plan`)
}

export function createStrategyWalkForwardPortfolioPlan(options: {
  snapshot: StrategyRepositorySnapshot
  strategyId: string
  members: readonly Readonly<{ plan: unknown; run: unknown }>[]
}) {
  if (!Array.isArray(options.members) || options.members.length < 2) {
    throw new Error('portfolio plan creation requires at least two child runs')
  }
  const children = options.members.map((member, index) => {
    const plan = assertStrategyWalkForwardPlan(member.plan)
    const run = assertStrategyWalkForwardRun(member.run)
    if (plan.candidate.strategyId !== options.strategyId) {
      throw new Error(`portfolio member ${index} belongs to another strategy`)
    }
    assertStrategyWalkForwardCandidateSnapshot(plan, options.snapshot)
    assertRunMatchesPlan(run, plan, index)
    return { plan, run }
  })
  const reference = children[0]!.plan
  const sharedFields = [
    'candidate', 'walkForwardPolicy', 'baseTimeframe', 'requiredTimeframes', 'activationDecisionTime',
    'warmupDurationMs', 'folds', 'executionScenarios',
  ] as const
  for (const [index, { plan }] of children.entries()) {
    for (const field of sharedFields) {
      if (!isDeepStrictEqual(plan[field], reference[field])) {
        throw new Error(`portfolio member ${index} ${field} does not match the shared Candidate plan`)
      }
    }
  }
  const symbolStability = reference.walkForwardPolicy?.gates.symbolStability
  if (reference.walkForwardPolicy?.schemaVersion !== 'helix.walk-forward-policy/v2' || !symbolStability) {
    throw new Error('portfolio plan creation requires a V2 policy with symbol stability')
  }
  const childBySymbol = new Map(children.map((child) => [child.plan.sourceDataset.source.symbol, child]))
  if (childBySymbol.size !== children.length) throw new Error('portfolio child runs contain duplicate symbols')
  const orderedChildren = symbolStability.members.map((memberSource) => {
    const child = childBySymbol.get(memberSource.symbol)
    if (!child || !isDeepStrictEqual(child.plan.sourceDataset.source, memberSource)) {
      throw new Error(`portfolio child runs do not exactly cover policy member ${memberSource.symbol}`)
    }
    return child
  })
  if (orderedChildren.length !== children.length) {
    throw new Error('portfolio child runs contain a symbol outside the policy universe')
  }
  return createStrategyWalkForwardPortfolioPlanArtifact({
    schemaVersion: STRATEGY_WALK_FORWARD_PORTFOLIO_PLAN_SCHEMA_VERSION,
    mode: 'fixed_candidate_multi_symbol',
    candidate: reference.candidate,
    walkForwardPolicy: reference.walkForwardPolicy,
    members: orderedChildren.map(({ plan, run }) => ({
      source: plan.sourceDataset.source,
      sourceDatasetHash: plan.sourceDataset.datasetHash,
      capturedThrough: plan.sourceDataset.capturedThrough,
      planHash: plan.planHash,
      runHash: run.runHash,
    })),
    baseTimeframe: reference.baseTimeframe,
    requiredTimeframes: reference.requiredTimeframes,
    activationDecisionTime: reference.activationDecisionTime,
    warmupDurationMs: reference.warmupDurationMs,
    folds: reference.folds,
    executionScenarios: reference.executionScenarios,
  })
}

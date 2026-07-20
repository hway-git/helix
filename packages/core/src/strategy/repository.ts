import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  GitRevisionIdentity,
  StrategyDecisionIdentity,
  StrategyFamily,
  StrategyLifecycle,
  StrategyManifestIdentity,
  StrategyObjectModel,
  StrategyRepositorySnapshot,
  StrategyWalkForwardPolicy,
} from '@helix/contracts/strategy'
import yaml from 'js-yaml'
import { HELIX_REPO_ROOT } from '../runtime-paths'
import { evaluateStrategyEngineCompatibility, listEngineCapabilities } from './capability-registry'

const execFileAsync = promisify(execFile)
const STRATEGY_SCHEMA_VERSION = 'helix.strategy/v1'
const STRATEGY_FAMILIES = new Set<StrategyFamily>(['scalp', 'swing'])
const STRATEGY_LIFECYCLES = new Set<StrategyLifecycle>([
  'proposal',
  'backtested',
  'shadow',
  'canary',
  'production',
  'deprecated',
])
const OBJECT_MODELS = new Set<StrategyObjectModel>(['PRICE_EVENT', 'TRADE_THESIS'])
const STRATEGY_SEGMENT_DIMENSIONS: Record<string, ReadonlySet<string>> = {
  helix_scalp_hunter: new Set(['scalp.event_type', 'scalp.grade', 'scalp.regime.type']),
  helix_swing_hunter: new Set(['swing.stage', 'swing.context.state', 'swing.context.bias']),
}

type RepositoryOptions = {
  strategyRepoRoot?: string
  engineRepoRoot?: string
}

type ManifestRecord = Record<string, unknown>
type GitRevisionSnapshot = GitRevisionIdentity & { status: string }

function record(value: unknown, field: string): ManifestRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as ManifestRecord
}

function exactRecord(value: unknown, field: string, fields: readonly string[]) {
  const parsed = record(value, field)
  const actual = Object.keys(parsed).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new Error(`${field} must contain exactly: ${fields.join(', ')}`)
  }
  return parsed
}

function text(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

function capabilities(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value.map((item, index) => {
    const capability = record(item, `${field}[${index}]`)
    const id = text(capability.id, `${field}[${index}].id`)
    const config = capability.config === undefined
      ? undefined
      : record(capability.config, `${field}[${index}].config`)
    return { id, config }
  })
}

function stringList(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value.map((item, index) => text(item, `${field}[${index}]`))
}

function timeframes(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`)
  const parsed = value.map((item, index) => {
    const timeframe = record(item, `${field}[${index}]`)
    return {
      role: text(timeframe.role, `${field}[${index}].role`),
      timeframe: text(timeframe.timeframe, `${field}[${index}].timeframe`),
    }
  })
  const roles = parsed.map((item) => item.role)
  if (new Set(roles).size !== roles.length) throw new Error(`${field} contains duplicate roles`)
  return parsed
}

function integer(value: unknown, field: string, minimum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${field} must be an integer greater than or equal to ${minimum}`)
  }
  return Number(value)
}

function finite(value: unknown, field: string, minimum?: number, maximum?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be finite`)
  if (minimum !== undefined && value < minimum) throw new Error(`${field} must be at least ${minimum}`)
  if (maximum !== undefined && value > maximum) throw new Error(`${field} must be at most ${maximum}`)
  return value
}

function parseWalkForwardPolicy(
  content: string,
  policyPath: string,
  manifest: StrategyManifestIdentity,
): StrategyWalkForwardPolicy {
  const root = exactRecord(yaml.load(content), policyPath, ['schema_version', 'policy', 'strategy', 'plan', 'gates'])
  const schemaVersion = text(root.schema_version, `${policyPath}.schema_version`)
  if (schemaVersion !== 'helix.walk-forward-policy/v1'
    && schemaVersion !== 'helix.walk-forward-policy/v2') {
    throw new Error(`${policyPath} uses an unsupported walk-forward policy schema`)
  }
  const hasSymbolStability = schemaVersion === 'helix.walk-forward-policy/v2'
  const policy = exactRecord(root.policy, `${policyPath}.policy`, ['id', 'version'])
  const id = text(policy.id, `${policyPath}.policy.id`)
  const version = text(policy.version, `${policyPath}.policy.version`)
  if (!/^[a-z][a-z0-9_]*_v[0-9]+$/.test(id)) throw new Error(`${policyPath}.policy.id is invalid`)
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${policyPath}.policy.version is invalid`)
  }
  const strategy = exactRecord(root.strategy, `${policyPath}.strategy`, ['id', 'version'])
  const strategyId = text(strategy.id, `${policyPath}.strategy.id`)
  const strategyVersion = text(strategy.version, `${policyPath}.strategy.version`)
  if (strategyId !== manifest.id || strategyVersion !== manifest.version) {
    throw new Error(`${policyPath} strategy identity does not match ${manifest.manifestPath}`)
  }
  const plan = exactRecord(root.plan, `${policyPath}.plan`, [
    'fold_count',
    'entry_window_ms',
    'observation_tail_ms',
    'risk_unit_ratio',
    'reference_account_equity',
    'execution_scenarios',
  ])
  if (!Array.isArray(plan.execution_scenarios) || plan.execution_scenarios.length < 2) {
    throw new Error(`${policyPath}.plan.execution_scenarios must contain at least two scenarios`)
  }
  const executionScenarios = plan.execution_scenarios.map((value, index) => {
    const scenario = exactRecord(value, `${policyPath}.plan.execution_scenarios[${index}]`, ['id', 'fee'])
    const scenarioId = text(scenario.id, `${policyPath}.plan.execution_scenarios[${index}].id`)
    if (!/^[a-z][a-z0-9_]*$/.test(scenarioId)) {
      throw new Error(`${policyPath}.plan.execution_scenarios[${index}].id is invalid`)
    }
    return {
      id: scenarioId,
      fee: finite(scenario.fee, `${policyPath}.plan.execution_scenarios[${index}].fee`, 0, 1),
    }
  })
  if (new Set(executionScenarios.map(({ id: scenarioId }) => scenarioId)).size !== executionScenarios.length) {
    throw new Error(`${policyPath}.plan.execution_scenarios contains duplicate ids`)
  }
  const minimumFee = Math.min(...executionScenarios.map(({ fee }) => fee))
  if (!executionScenarios.some(({ fee }) => fee > minimumFee)) {
    throw new Error(`${policyPath}.plan.execution_scenarios must include a stressed fee`)
  }
  const gates = exactRecord(root.gates, `${policyPath}.gates`, [
    'censored_entries',
    'minimum_total_trades',
    'minimum_active_fold_ratio',
    'minimum_positive_fold_ratio',
    'minimum_expectancy_r',
    'minimum_profit_factor',
    'maximum_drawdown_r',
    'segment_stability',
    ...(hasSymbolStability ? ['symbol_stability'] : []),
  ])
  if (gates.censored_entries !== 'reject') {
    throw new Error(`${policyPath}.gates.censored_entries must be reject`)
  }
  const segment = exactRecord(gates.segment_stability, `${policyPath}.gates.segment_stability`, [
    'dimensions',
    'minimum_trades_per_segment',
    'minimum_stable_segment_ratio',
  ])
  const dimensions = stringList(segment.dimensions, `${policyPath}.gates.segment_stability.dimensions`)
  if (dimensions.length === 0 || new Set(dimensions).size !== dimensions.length) {
    throw new Error(`${policyPath}.gates.segment_stability.dimensions must be non-empty and unique`)
  }
  for (const dimension of dimensions) {
    if (!STRATEGY_SEGMENT_DIMENSIONS[manifest.id]?.has(dimension)) {
      throw new Error(`${policyPath}.gates.segment_stability.dimensions contains invalid dimension ${dimension}`)
    }
  }
  let symbolStability: StrategyWalkForwardPolicy['gates']['symbolStability']
  if (hasSymbolStability) {
    const symbolGate = exactRecord(
      gates.symbol_stability,
      `${policyPath}.gates.symbol_stability`,
      ['members', 'minimum_stable_symbol_ratio'],
    )
    if (!Array.isArray(symbolGate.members) || symbolGate.members.length < 2) {
      throw new Error(`${policyPath}.gates.symbol_stability.members must contain at least two symbols`)
    }
    const members = symbolGate.members.map((value, index) => {
      const name = `${policyPath}.gates.symbol_stability.members[${index}]`
      const member = exactRecord(value, name, ['provider', 'market', 'instrument_id', 'symbol'])
      return {
        provider: text(member.provider, `${name}.provider`),
        market: text(member.market, `${name}.market`),
        instrumentId: text(member.instrument_id, `${name}.instrument_id`),
        symbol: text(member.symbol, `${name}.symbol`),
      }
    })
    if (new Set(members.map(({ symbol }) => symbol)).size !== members.length) {
      throw new Error(`${policyPath}.gates.symbol_stability.members contains duplicate symbols`)
    }
    if (new Set(members.map(({ instrumentId }) => instrumentId)).size !== members.length) {
      throw new Error(`${policyPath}.gates.symbol_stability.members contains duplicate instrument ids`)
    }
    const orderedMembers = [...members].sort((left, right) => (
      left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1
        : left.instrumentId < right.instrumentId ? -1 : left.instrumentId > right.instrumentId ? 1 : 0
    ))
    if (members.some((member, index) => (
      member.symbol !== orderedMembers[index]?.symbol
      || member.instrumentId !== orderedMembers[index]?.instrumentId
    ))) {
      throw new Error(
        `${policyPath}.gates.symbol_stability.members must be ordered by symbol and instrument_id`,
      )
    }
    symbolStability = {
      members,
      minimumStableSymbolRatio: finite(
        symbolGate.minimum_stable_symbol_ratio,
        `${policyPath}.gates.symbol_stability.minimum_stable_symbol_ratio`,
        0,
        1,
      ),
    }
  }
  return {
    schemaVersion,
    id,
    version,
    strategyId,
    strategyVersion,
    policyPath,
    policyHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    plan: {
      foldCount: integer(plan.fold_count, `${policyPath}.plan.fold_count`, 2),
      entryWindowMs: integer(plan.entry_window_ms, `${policyPath}.plan.entry_window_ms`, 1),
      observationTailMs: integer(plan.observation_tail_ms, `${policyPath}.plan.observation_tail_ms`, 1),
      riskUnitRatio: finite(plan.risk_unit_ratio, `${policyPath}.plan.risk_unit_ratio`, Number.MIN_VALUE, 1),
      referenceAccountEquity: finite(
        plan.reference_account_equity,
        `${policyPath}.plan.reference_account_equity`,
        Number.MIN_VALUE,
      ),
      executionScenarios,
    },
    gates: {
      censoredEntries: 'reject',
      minimumTotalTrades: integer(gates.minimum_total_trades, `${policyPath}.gates.minimum_total_trades`, 1),
      minimumActiveFoldRatio: finite(
        gates.minimum_active_fold_ratio,
        `${policyPath}.gates.minimum_active_fold_ratio`,
        0,
        1,
      ),
      minimumPositiveFoldRatio: finite(
        gates.minimum_positive_fold_ratio,
        `${policyPath}.gates.minimum_positive_fold_ratio`,
        0,
        1,
      ),
      minimumExpectancyR: finite(gates.minimum_expectancy_r, `${policyPath}.gates.minimum_expectancy_r`),
      minimumProfitFactor: finite(
        gates.minimum_profit_factor,
        `${policyPath}.gates.minimum_profit_factor`,
        0,
      ),
      maximumDrawdownR: finite(gates.maximum_drawdown_r, `${policyPath}.gates.maximum_drawdown_r`, 0),
      segmentStability: {
        dimensions,
        minimumTradesPerSegment: integer(
          segment.minimum_trades_per_segment,
          `${policyPath}.gates.segment_stability.minimum_trades_per_segment`,
          1,
        ),
        minimumStableSegmentRatio: finite(
          segment.minimum_stable_segment_ratio,
          `${policyPath}.gates.segment_stability.minimum_stable_segment_ratio`,
          0,
          1,
        ),
      },
      ...(symbolStability ? { symbolStability } : {}),
    },
  }
}

function strategyRepoRoot(configured?: string) {
  if (configured) return resolve(configured)
  if (process.env.HELIX_STRATEGY_REPO?.trim()) return resolve(process.env.HELIX_STRATEGY_REPO.trim())
  return resolve(HELIX_REPO_ROOT, '..', 'helix-strategies')
}

async function gitRevision(root: string): Promise<GitRevisionSnapshot> {
  const { stdout: commit } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  const { stdout: status } = await execFileAsync(
    'git',
    ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'],
    { encoding: 'utf8' },
  )
  return {
    commit: commit.trim(),
    dirty: status.trim().length > 0,
    status,
  }
}

function sameRevision(left: GitRevisionSnapshot, right: GitRevisionSnapshot) {
  return left.commit === right.commit && left.status === right.status
}

function revisionIdentity(revision: GitRevisionSnapshot): GitRevisionIdentity {
  return { commit: revision.commit, dirty: revision.dirty }
}

function parseManifest(content: string, manifestPath: string) {
  const root = record(yaml.load(content), manifestPath)
  const strategy = record(root.strategy, `${manifestPath}.strategy`)
  const schemaVersion = text(root.schema_version, `${manifestPath}.schema_version`)
  const family = text(strategy.family, `${manifestPath}.strategy.family`) as StrategyFamily
  const lifecycle = text(strategy.lifecycle, `${manifestPath}.strategy.lifecycle`) as StrategyLifecycle
  const objectModel = text(root.object_model, `${manifestPath}.object_model`) as StrategyObjectModel
  const strategyTimeframes = timeframes(root.timeframes, `${manifestPath}.timeframes`)
  const version = text(strategy.version, `${manifestPath}.strategy.version`)
  const declaredCapabilities = [
    ...capabilities(root.components, `${manifestPath}.components`),
    ...capabilities(root.policies, `${manifestPath}.policies`),
  ]
  const requiredEngineCapabilities = declaredCapabilities.map((capability) => capability.id)
  const capabilityConfigurations = Object.fromEntries(
    declaredCapabilities
      .filter((capability) => capability.config !== undefined)
      .map((capability) => [capability.id, capability.config]),
  )
  const reasonCodes = stringList(root.reason_codes, `${manifestPath}.reason_codes`)
  let walkForwardPolicyPath: string | null = null
  if (root.validation !== undefined) {
    const validation = exactRecord(root.validation, `${manifestPath}.validation`, ['walk_forward_policy'])
    walkForwardPolicyPath = text(
      validation.walk_forward_policy,
      `${manifestPath}.validation.walk_forward_policy`,
    )
    if (!/^validation\/[a-z][a-z0-9-]*\.yaml$/.test(walkForwardPolicyPath)) {
      throw new Error(`${manifestPath}.validation.walk_forward_policy is invalid`)
    }
  }

  if (schemaVersion !== STRATEGY_SCHEMA_VERSION) throw new Error(`${manifestPath} uses unsupported schema ${schemaVersion}`)
  if (!STRATEGY_FAMILIES.has(family)) throw new Error(`${manifestPath} has invalid family ${family}`)
  if (!STRATEGY_LIFECYCLES.has(lifecycle)) throw new Error(`${manifestPath} has invalid lifecycle ${lifecycle}`)
  if (!OBJECT_MODELS.has(objectModel)) throw new Error(`${manifestPath} has invalid object model ${objectModel}`)
  if (!/^1\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${manifestPath} must identify a V1 strategy`)
  }
  if (new Set(requiredEngineCapabilities).size !== requiredEngineCapabilities.length) {
    throw new Error(`${manifestPath} contains duplicate Engine capability ids`)
  }
  if (new Set(reasonCodes).size !== reasonCodes.length) {
    throw new Error(`${manifestPath} contains duplicate reason codes`)
  }
  for (const reasonCode of reasonCodes) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(reasonCode)) throw new Error(`${manifestPath} has invalid reason code ${reasonCode}`)
  }

  const manifest: StrategyManifestIdentity = {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    id: text(strategy.id, `${manifestPath}.strategy.id`),
    name: text(strategy.name, `${manifestPath}.strategy.name`),
    family,
    version,
    lifecycle,
    objectModel,
    timeframes: strategyTimeframes,
    manifestPath,
    configHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    requiredEngineCapabilities,
    capabilityConfigurations,
    reasonCodes,
    walkForwardPolicy: null,
  }
  return { manifest, walkForwardPolicyPath }
}

async function loadManifests(root: string, commit: string) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, 'ls-tree', '-r', '-z', commit, '--', 'strategies'],
    { encoding: 'utf8' },
  )
  const treeEntries = stdout.split('\0').filter(Boolean).map((entry) => {
    const separator = entry.indexOf('\t')
    if (separator < 0) throw new Error('strategy repository returned an invalid Git tree entry')
    const [mode, type] = entry.slice(0, separator).split(' ')
    return { mode, type, path: entry.slice(separator + 1) }
  })
  const strategyDirectories = new Set(treeEntries.flatMap(({ path }) => {
    const match = /^strategies\/([^/]+)\//.exec(path)
    return match ? [match[1]!] : []
  }))
  const entries = treeEntries.filter(({ path }) => /^strategies\/[^/]+\/strategy\.yaml$/.test(path))
  const manifestPaths = new Set(entries.map(({ path }) => path))
  for (const directory of strategyDirectories) {
    if (!manifestPaths.has(`strategies/${directory}/strategy.yaml`)) {
      throw new Error(`strategies/${directory}/strategy.yaml is missing from the pinned Git tree`)
    }
  }
  for (const { mode, type, path: manifestPath } of entries) {
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      throw new Error(`${manifestPath} must be a regular tracked file`)
    }
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const entryByPath = new Map(treeEntries.map((entry) => [entry.path, entry]))
  const manifests = await Promise.all(entries.map(async ({ path: manifestPath }) => {
    const { stdout: content } = await execFileAsync(
      'git',
      ['-C', root, 'show', `${commit}:${manifestPath}`],
      { encoding: 'utf8' },
    )
    const parsed = parseManifest(content, manifestPath)
    if (!parsed.walkForwardPolicyPath) return parsed.manifest
    const strategyDirectory = manifestPath.slice(0, manifestPath.lastIndexOf('/'))
    const policyPath = `${strategyDirectory}/${parsed.walkForwardPolicyPath}`
    const policyEntry = entryByPath.get(policyPath)
    if (!policyEntry) throw new Error(`${policyPath} is missing from the pinned Git tree`)
    if (policyEntry.type !== 'blob' || (policyEntry.mode !== '100644' && policyEntry.mode !== '100755')) {
      throw new Error(`${policyPath} must be a regular tracked file`)
    }
    const { stdout: policyContent } = await execFileAsync(
      'git',
      ['-C', root, 'show', `${commit}:${policyPath}`],
      { encoding: 'utf8' },
    )
    return {
      ...parsed.manifest,
      walkForwardPolicy: parseWalkForwardPolicy(policyContent, policyPath, parsed.manifest),
    }
  }))
  const ids = new Set<string>()
  for (const manifest of manifests) {
    if (ids.has(manifest.id)) throw new Error(`duplicate strategy id ${manifest.id}`)
    ids.add(manifest.id)
  }
  return manifests
}

export async function loadStrategyRepositorySnapshot(options: RepositoryOptions = {}): Promise<StrategyRepositorySnapshot> {
  const strategyRoot = strategyRepoRoot(options.strategyRepoRoot)
  const engineRoot = resolve(options.engineRepoRoot ?? HELIX_REPO_ROOT)

  try {
    const repositoryBefore = await gitRevision(strategyRoot)
    const engineBefore = await gitRevision(engineRoot)
    const manifests = await loadManifests(strategyRoot, repositoryBefore.commit)
    const repositoryAfter = await gitRevision(strategyRoot)
    const engineAfter = await gitRevision(engineRoot)
    if (!sameRevision(repositoryBefore, repositoryAfter)) {
      throw new Error('strategy repository changed while creating identity snapshot')
    }
    if (!sameRevision(engineBefore, engineAfter)) {
      throw new Error('engine repository changed while creating identity snapshot')
    }
    const engineCapabilities = listEngineCapabilities()
    const compatibility = manifests.map((manifest) => evaluateStrategyEngineCompatibility(manifest, engineAfter.commit))
    return {
      ok: true,
      source: 'local-git',
      repository: revisionIdentity(repositoryAfter),
      engine: revisionIdentity(engineAfter),
      engineCapabilities,
      manifests,
      compatibility,
      fetchedAt: Date.now(),
      errors: [],
    }
  } catch (error) {
    return {
      ok: false,
      source: 'local-git',
      repository: null,
      engine: null,
      engineCapabilities: listEngineCapabilities(),
      manifests: [],
      compatibility: [],
      fetchedAt: Date.now(),
      errors: [error instanceof Error ? error.message : 'strategy repository unavailable'],
    }
  }
}

export function createStrategyDecisionIdentityFromSnapshot(
  snapshot: StrategyRepositorySnapshot,
  { strategyId, marketDataSnapshotId }: { strategyId: string; marketDataSnapshotId: string },
): StrategyDecisionIdentity {
  if (!snapshot.ok || !snapshot.repository || !snapshot.engine) {
    throw new Error(snapshot.errors[0] ?? 'strategy repository unavailable')
  }
  if (snapshot.repository.dirty) throw new Error('strategy repository must be clean before creating decision identity')
  if (snapshot.engine.dirty) throw new Error('engine repository must be clean before creating decision identity')

  const manifest = snapshot.manifests.find((candidate) => candidate.id === strategyId)
  if (!manifest) throw new Error(`unknown strategy id ${strategyId}`)
  const compatibility = snapshot.compatibility.find((candidate) => candidate.strategyId === strategyId)
  if (!compatibility?.compatible) {
    if (compatibility?.missing.length) {
      throw new Error(`strategy ${strategyId} requires unavailable Engine capabilities: ${compatibility.missing.join(', ')}`)
    }
    if (compatibility?.invalidConfiguration.length) {
      throw new Error(`strategy ${strategyId} has invalid Engine capability configuration: ${compatibility.invalidConfiguration.join(', ')}`)
    }
    throw new Error(`strategy ${strategyId} has unconfigured Engine capabilities: ${compatibility?.unconfigured.join(', ') || 'unknown'}`)
  }
  const normalizedSnapshotId = marketDataSnapshotId.trim()
  if (!normalizedSnapshotId) throw new Error('marketDataSnapshotId is required')

  return {
    strategyId: manifest.id,
    strategyVersion: manifest.version,
    strategyRepoCommit: snapshot.repository.commit,
    strategyConfigHash: manifest.configHash,
    engineCommit: snapshot.engine.commit,
    marketDataSnapshotId: normalizedSnapshotId,
  }
}

export async function createStrategyDecisionIdentity({
  strategyId,
  marketDataSnapshotId,
  ...options
}: RepositoryOptions & {
  strategyId: string
  marketDataSnapshotId: string
}): Promise<StrategyDecisionIdentity> {
  const snapshot = await loadStrategyRepositorySnapshot(options)
  return createStrategyDecisionIdentityFromSnapshot(snapshot, { strategyId, marketDataSnapshotId })
}

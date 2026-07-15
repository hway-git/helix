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

function parseManifest(content: string, manifestPath: string): StrategyManifestIdentity {
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

  return {
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
  }
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
  const manifests = await Promise.all(entries.map(async ({ path: manifestPath }) => {
    const { stdout: content } = await execFileAsync(
      'git',
      ['-C', root, 'show', `${commit}:${manifestPath}`],
      { encoding: 'utf8' },
    )
    return parseManifest(content, manifestPath)
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

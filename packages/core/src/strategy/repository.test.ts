import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { createStrategyDecisionIdentity, loadStrategyRepositorySnapshot } from './repository'

const manifest = `schema_version: helix.strategy/v1
strategy:
  id: helix_scalp_hunter
  name: Helix Scalp Hunter
  family: scalp
  version: 1.0.0
  lifecycle: proposal
object_model: PRICE_EVENT
timeframes:
  - role: execution
    timeframe: 1m
components: []
policies: []
reason_codes:
  - TEST_REASON
documentation: {}
`

function commitRepository(root: string) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'helix-test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Helix Test'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'test fixture'], { cwd: root })
}

function initializeRepository(root: string, files: Record<string, string>) {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = resolve(root, relativePath)
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  commitRepository(root)
}

test('loads V1 manifests and creates identity only from clean repositories', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-strategy-repository-'))
  const strategyRoot = resolve(root, 'strategies-repo')
  const engineRoot = resolve(root, 'engine-repo')
  mkdirSync(strategyRoot)
  mkdirSync(engineRoot)

  try {
    initializeRepository(strategyRoot, { 'strategies/scalp/strategy.yaml': manifest })
    initializeRepository(engineRoot, { 'README.md': '# Engine\n' })

    const snapshot = await loadStrategyRepositorySnapshot({ strategyRepoRoot: strategyRoot, engineRepoRoot: engineRoot })
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.repository?.dirty, false)
    assert.equal(snapshot.engine?.dirty, false)
    assert.equal(snapshot.manifests[0]?.version, '1.0.0')
    assert.deepEqual(snapshot.manifests[0]?.timeframes, [{ role: 'execution', timeframe: '1m' }])
    assert.match(snapshot.manifests[0]?.configHash ?? '', /^sha256:[a-f0-9]{64}$/)
    assert.deepEqual(snapshot.compatibility[0]?.missing, [])

    const identity = await createStrategyDecisionIdentity({
      strategyId: 'helix_scalp_hunter',
      marketDataSnapshotId: 'snapshot-001',
      strategyRepoRoot: strategyRoot,
      engineRepoRoot: engineRoot,
    })
    assert.equal(identity.strategyRepoCommit, snapshot.repository?.commit)
    assert.equal(identity.engineCommit, snapshot.engine?.commit)
    assert.equal(identity.marketDataSnapshotId, 'snapshot-001')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects decision identity when strategy configuration is dirty', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-strategy-dirty-'))
  const strategyRoot = resolve(root, 'strategies-repo')
  const engineRoot = resolve(root, 'engine-repo')
  mkdirSync(strategyRoot)
  mkdirSync(engineRoot)

  try {
    const manifestPath = resolve(strategyRoot, 'strategies/scalp/strategy.yaml')
    initializeRepository(strategyRoot, { 'strategies/scalp/strategy.yaml': manifest })
    initializeRepository(engineRoot, { 'README.md': '# Engine\n' })
    appendFileSync(manifestPath, '# dirty\n')

    await assert.rejects(
      createStrategyDecisionIdentity({
        strategyId: 'helix_scalp_hunter',
        marketDataSnapshotId: 'snapshot-002',
        strategyRepoRoot: strategyRoot,
        engineRepoRoot: engineRoot,
      }),
      /strategy repository must be clean/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects decision identity when Engine code is dirty', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-engine-dirty-'))
  const strategyRoot = resolve(root, 'strategies-repo')
  const engineRoot = resolve(root, 'engine-repo')
  mkdirSync(strategyRoot)
  mkdirSync(engineRoot)

  try {
    initializeRepository(strategyRoot, { 'strategies/scalp/strategy.yaml': manifest })
    const engineReadme = resolve(engineRoot, 'README.md')
    initializeRepository(engineRoot, { 'README.md': '# Engine\n' })
    appendFileSync(engineReadme, 'dirty\n')

    await assert.rejects(
      createStrategyDecisionIdentity({
        strategyId: 'helix_scalp_hunter',
        marketDataSnapshotId: 'snapshot-003',
        strategyRepoRoot: strategyRoot,
        engineRepoRoot: engineRoot,
      }),
      /engine repository must be clean/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reads manifests from the pinned Git tree rather than dirty working-tree content', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-strategy-tree-'))
  const strategyRoot = resolve(root, 'strategies-repo')
  const engineRoot = resolve(root, 'engine-repo')
  mkdirSync(strategyRoot)
  mkdirSync(engineRoot)

  try {
    const manifestPath = resolve(strategyRoot, 'strategies/scalp/strategy.yaml')
    initializeRepository(strategyRoot, { 'strategies/scalp/strategy.yaml': manifest })
    initializeRepository(engineRoot, { 'README.md': '# Engine\n' })
    writeFileSync(manifestPath, manifest.replace('Helix Scalp Hunter', 'Dirty Working Tree Name'))

    const snapshot = await loadStrategyRepositorySnapshot({ strategyRepoRoot: strategyRoot, engineRepoRoot: engineRoot })
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.repository?.dirty, true)
    assert.equal(snapshot.manifests[0]?.name, 'Helix Scalp Hunter')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a tracked manifest symlink even when both repositories are clean', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-strategy-symlink-'))
  const strategyRoot = resolve(root, 'strategies-repo')
  const engineRoot = resolve(root, 'engine-repo')
  const externalManifest = resolve(root, 'external-strategy.yaml')
  mkdirSync(resolve(strategyRoot, 'strategies/scalp'), { recursive: true })
  mkdirSync(engineRoot)

  try {
    writeFileSync(externalManifest, manifest)
    symlinkSync(externalManifest, resolve(strategyRoot, 'strategies/scalp/strategy.yaml'))
    commitRepository(strategyRoot)
    initializeRepository(engineRoot, { 'README.md': '# Engine\n' })
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: strategyRoot, encoding: 'utf8' }), '')

    const snapshot = await loadStrategyRepositorySnapshot({ strategyRepoRoot: strategyRoot, engineRepoRoot: engineRoot })
    assert.equal(snapshot.ok, false)
    assert.match(snapshot.errors[0] ?? '', /strategy\.yaml must be a regular tracked file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a tracked strategy directory without a manifest', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-strategy-missing-manifest-'))
  const strategyRoot = resolve(root, 'strategies-repo')
  const engineRoot = resolve(root, 'engine-repo')
  mkdirSync(strategyRoot)
  mkdirSync(engineRoot)

  try {
    initializeRepository(strategyRoot, { 'strategies/scalp/README.md': '# Missing manifest\n' })
    initializeRepository(engineRoot, { 'README.md': '# Engine\n' })

    const snapshot = await loadStrategyRepositorySnapshot({ strategyRepoRoot: strategyRoot, engineRepoRoot: engineRoot })
    assert.equal(snapshot.ok, false)
    assert.match(snapshot.errors[0] ?? '', /strategy\.yaml is missing from the pinned Git tree/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects decision identity when the pinned Engine lacks a manifest capability', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-engine-capability-'))
  const strategyRoot = resolve(root, 'strategies-repo')
  const engineRoot = resolve(root, 'engine-repo')
  mkdirSync(strategyRoot)
  mkdirSync(engineRoot)

  try {
    const manifestWithMissingCapability = manifest.replace(
      'components: []',
      'components:\n  - role: event\n    id: unavailable_detector_v1',
    )
    initializeRepository(strategyRoot, { 'strategies/scalp/strategy.yaml': manifestWithMissingCapability })
    initializeRepository(engineRoot, { 'README.md': '# Engine\n' })

    await assert.rejects(
      createStrategyDecisionIdentity({
        strategyId: 'helix_scalp_hunter',
        marketDataSnapshotId: 'snapshot-004',
        strategyRepoRoot: strategyRoot,
        engineRepoRoot: engineRoot,
      }),
      /requires unavailable Engine capabilities: unavailable_detector_v1/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects decision identity when an available Engine capability is unconfigured', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helix-engine-unconfigured-'))
  const strategyRoot = resolve(root, 'strategies-repo')
  const engineRoot = resolve(root, 'engine-repo')
  mkdirSync(strategyRoot)
  mkdirSync(engineRoot)

  try {
    const unconfiguredManifest = manifest.replace(
      'components: []',
      'components:\n  - role: execution\n    id: micro_structure_execution_v1',
    )
    initializeRepository(strategyRoot, { 'strategies/scalp/strategy.yaml': unconfiguredManifest })
    initializeRepository(engineRoot, { 'README.md': '# Engine\n' })

    await assert.rejects(
      createStrategyDecisionIdentity({
        strategyId: 'helix_scalp_hunter',
        marketDataSnapshotId: 'snapshot-005',
        strategyRepoRoot: strategyRoot,
        engineRepoRoot: engineRoot,
      }),
      /has unconfigured Engine capabilities: micro_structure_execution_v1/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

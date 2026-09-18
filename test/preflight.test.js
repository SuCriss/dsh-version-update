/** Local preflight probes: temporary trees only, no npm process or network. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runPreflight } from '../lib/preflight.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vu-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const installDir = join(root, 'scope', 'dsh')
  const snapshotsDir = join(root, 'state', 'snapshots')
  await mkdir(installDir, { recursive: true })
  return { root, installDir, snapshotsDir, npmCli: () => '/fake/npm-cli.js', statfsImpl: async () => ({ bsize: 4096, bavail: 100 }) }
}

test('preflight reports all local facts and removes both write probes', async (t) => {
  const deps = await fixture(t)
  const verdict = await runPreflight(deps)
  assert.deepEqual(verdict, {
    npm: { available: true, path: '/fake/npm-cli.js' },
    installDirWritable: true, diskFreeBytes: 409600,
    snapshotDirUsable: true, warnings: [], ok: true,
  })
  assert.deepEqual(await readdir(join(deps.root, 'scope')), ['dsh'])
  assert.deepEqual(await readdir(deps.snapshotsDir), [])
})

test('preflight reuses npm resolver with isolated node-adjacent fixture', async (t) => {
  const deps = await fixture(t)
  const cliDir = join(deps.root, 'node_modules', 'npm', 'bin')
  await mkdir(cliDir, { recursive: true })
  const cli = join(cliDir, 'npm-cli.js')
  await writeFile(cli, '// not executed')
  const { npmCli, ...local } = deps
  const verdict = await runPreflight({ ...local, execPath: join(deps.root, 'node'), env: {} })
  assert.deepEqual(verdict.npm, { available: true, path: cli })
})

test('missing npm and a throwing npm resolver remain advisory failures', async (t) => {
  const deps = await fixture(t)
  for (const npmCli of [() => undefined, () => { throw new Error('lookup failed') }]) {
    const verdict = await runPreflight({ ...deps, npmCli })
    assert.deepEqual(verdict.npm, { available: false })
    assert.equal(verdict.installDirWritable, true)
    assert.equal(verdict.snapshotDirUsable, true)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.warnings.length, 1)
  }
})

test('unknown paths and unavailable statfs each become a warning', async () => {
  const verdict = await runPreflight({ npmCli: () => undefined, statfsImpl: null })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.installDirWritable, false)
  assert.equal(verdict.snapshotDirUsable, false)
  assert.equal(verdict.diskFreeBytes, null)
  assert.equal(verdict.warnings.length, 4)
})

test('an invalid installation parent is not created and does not hide snapshot success', async (t) => {
  const deps = await fixture(t)
  const verdict = await runPreflight({ ...deps, installDir: join(deps.root, 'missing', 'dsh') })
  assert.equal(verdict.installDirWritable, false)
  assert.equal(verdict.snapshotDirUsable, true)
  assert.equal((await readdir(deps.root)).includes('missing'), false)
})

test('snapshot directory blocked by a file does not hide other facts', async (t) => {
  const deps = await fixture(t)
  await writeFile(join(deps.root, 'state'), 'not a directory')
  const verdict = await runPreflight(deps)
  assert.equal(verdict.snapshotDirUsable, false)
  assert.equal(verdict.installDirWritable, true)
  assert.equal(verdict.diskFreeBytes, 409600)
  assert.match(verdict.warnings.join('\n'), /Snapshot directory/)
})

test('failed writes still clean up probes and individually report each failure', async (t) => {
  const deps = await fixture(t)
  const verdict = await runPreflight({ ...deps, writeFileImpl: async () => { throw new Error('EACCES') } })
  assert.equal(verdict.installDirWritable, false)
  assert.equal(verdict.snapshotDirUsable, false)
  assert.equal(verdict.warnings.length, 2)
  assert.deepEqual(await readdir(join(deps.root, 'scope')), ['dsh'])
  assert.deepEqual(await readdir(deps.snapshotsDir), [])
})

test('unsupported, throwing and invalid statfs readings return null with a warning', async (t) => {
  const deps = await fixture(t)
  for (const statfsImpl of [null, async () => { throw new Error('ENOSYS') }, async () => ({ bsize: NaN, bavail: 1 })]) {
    const verdict = await runPreflight({ ...deps, statfsImpl })
    assert.equal(verdict.diskFreeBytes, null)
    assert.equal(verdict.warnings.length, 1)
    assert.equal(verdict.snapshotDirUsable, true)
    assert.equal(verdict.ok, false)
  }
})

test('zero disk space is distinguished from unsupported measurement', async (t) => {
  const deps = await fixture(t)
  const verdict = await runPreflight({ ...deps, statfsImpl: async () => ({ bsize: 4096, bavail: 0 }) })
  assert.equal(verdict.diskFreeBytes, 0)
  assert.equal(verdict.ok, false)
  assert.match(verdict.warnings.join('\n'), /No free disk space/)
})

test('real statfs is best-effort and concurrent probes do not collide', async (t) => {
  const deps = await fixture(t)
  const { statfsImpl, ...local } = deps
  const verdicts = await Promise.all([runPreflight(local), runPreflight(local)])
  for (const verdict of verdicts) {
    assert.equal(verdict.installDirWritable, true)
    assert.equal(verdict.snapshotDirUsable, true)
    assert.ok(verdict.diskFreeBytes === null || verdict.diskFreeBytes >= 0)
  }
  assert.deepEqual(await readdir(deps.snapshotsDir), [])
})

/**
 * Snapshot store tests: creation with metadata, idempotent reuse, damaged
 * snapshot replacement, retention pruning, listing, and restore over a live
 * installation.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSnapshot, defaultSnapshotsDir, listSnapshots, removeSnapshot, restoreSnapshot } from '../lib/snapshot.js'

/** Build one fake installed dsh tree of the given version. */
function fakeInstall(t, version) {
  const dir = mkdtempSync(join(tmpdir(), 'vu-install-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'bin.js'), `console.log(${JSON.stringify(version)})`)
  return dir
}

/** One temp snapshot root per test. */
function snapHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'vu-snap-'))
  const snapshotsDir = join(home, 'snapshots')
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return snapshotsDir
}

test('defaultSnapshotsDir lives under the given home', () => {
  assert.equal(defaultSnapshotsDir({ home: '/h' }), join('/h', '.dsh-version-update', 'snapshots'))
})

test('createSnapshot copies the tree and stamps metadata; list reports it usable', (t) => {
  const install = fakeInstall(t, '0.4.0')
  const snapshotsDir = snapHome(t)
  const outcome = createSnapshot({ installDir: install, snapshotsDir, version: '0.4.0', now: () => 1000 })
  assert.deepEqual(outcome, { ok: true })
  const entries = listSnapshots(snapshotsDir)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].version, '0.4.0')
  assert.equal(entries[0].at, 1000)
  assert.equal(entries[0].usable, true)
})

test('a second create reuses an intact snapshot instead of recopying', (t) => {
  const install = fakeInstall(t, '0.4.2')
  const snapshotsDir = snapHome(t)
  assert.deepEqual(createSnapshot({ installDir: install, snapshotsDir, version: '0.4.2', now: () => 1 }), { ok: true })
  assert.deepEqual(createSnapshot({ installDir: install, snapshotsDir, version: '0.4.2', now: () => 2 }), { ok: true, reused: true })
  assert.equal(listSnapshots(snapshotsDir).length, 1)
})

test('a damaged leftover of the same version is replaced, not reused', (t) => {
  const install = fakeInstall(t, '0.9.1')
  const snapshotsDir = snapHome(t)
  // Seed a broken directory where the snapshot belongs.
  const dest = join(snapshotsDir, '0.9.1')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'meta.json'), '{ torn }')
  assert.deepEqual(createSnapshot({ installDir: install, snapshotsDir, version: '0.9.1', now: () => 5 }), { ok: true })
  assert.equal(listSnapshots(snapshotsDir)[0]?.usable, true)
})

test('pruning keeps the newest N and drops damaged entries first', (t) => {
  const install = fakeInstall(t, '1.0.0')
  const snapshotsDir = snapHome(t)
  // One damaged entry plus four healthy ones; keep=2 means the damaged entry
  // goes first, then the two oldest healthy ones; the two newest survive.
  // Each snapshot must agree with the manifest it copies, so the live install
  // advances between creates — exactly what successive updates look like.
  const advanceTo = (version) => {
    writeFileSync(join(install, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  }
  advanceTo('1.0.0')
  createSnapshot({ installDir: install, snapshotsDir, version: '1.0.0', keep: 2, now: () => 10 })
  advanceTo('1.0.1')
  createSnapshot({ installDir: install, snapshotsDir, version: '1.0.1', keep: 2, now: () => 20 })
  advanceTo('1.0.2')
  createSnapshot({ installDir: install, snapshotsDir, version: '1.0.2', keep: 2, now: () => 30 })
  const broken = join(snapshotsDir, '0.0.3')
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, 'stray.txt'), 'not a snapshot')
  advanceTo('1.0.3')
  createSnapshot({ installDir: install, snapshotsDir, version: '1.0.3', keep: 2, now: () => 40 })
  const versions = listSnapshots(snapshotsDir).map(entry => entry.version).sort()
  assert.deepEqual(versions, ['1.0.2', '1.0.3'])
})

test('restore swaps the live tree for the snapshot contents', (t) => {
  const install = fakeInstall(t, '2.0.0')
  const snapshotsDir = snapHome(t)
  createSnapshot({ installDir: install, snapshotsDir, version: '2.0.0', now: () => 1 })
  // Simulate an update having moved the live install forward.
  writeFileSync(join(install, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.1.0' }))
  rmSync(join(install, 'lib', 'bin.js'))
  const outcome = restoreSnapshot({ installDir: install, snapshotsDir, version: '2.0.0' })
  assert.deepEqual(outcome, { ok: true })
  assert.equal(JSON.parse(readFileSync(join(install, 'package.json'), 'utf8')).version, '2.0.0')
  assert.ok(existsSync(join(install, 'lib', 'bin.js')))
  // No replaced-aside leftovers remain beside the install.
  const siblings = readdirSync(dirname(install)).filter(name => name.includes('.replaced-'))
  assert.deepEqual(siblings, [])
})

test('restore refuses versions without a usable snapshot and rejects non-versions', (t) => {
  const install = fakeInstall(t, '3.0.0')
  const snapshotsDir = snapHome(t)
  assert.equal(restoreSnapshot({ installDir: install, snapshotsDir, version: '3.0.0' }).ok, false)
  assert.equal(restoreSnapshot({ installDir: install, snapshotsDir, version: '../etc' }).ok, false)
  assert.equal(removeSnapshot(snapshotsDir, '../etc'), false)
})

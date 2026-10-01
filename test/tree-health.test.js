/**
 * Tree-health tests: retired-name recognition, leftover scanning across the
 * three locations, damaged-manifest snapshot restore, and the freshness guard
 * that keeps a young retirement (a possibly still-running orphaned npm) from
 * being deleted on the boot path.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSnapshot } from '../lib/snapshot.js'
import {
  RETIRED_MIN_AGE_MS,
  RETIRED_NAME_PATTERN,
  inspectTreeHealth,
  repairTree,
  scanRetiredLeftovers,
} from '../lib/tree-health.js'

test('RETIRED_NAME_PATTERN tells retirements from legitimate dot entries', () => {
  assert.equal(RETIRED_NAME_PATTERN.test('.agent-sdk-a1b2c3d4'), true)
  assert.equal(RETIRED_NAME_PATTERN.test('.dsh-1234ABcd'), true)
  assert.equal(RETIRED_NAME_PATTERN.test('.package-lock.json'), false)
  assert.equal(RETIRED_NAME_PATTERN.test('.bin'), false)
  assert.equal(RETIRED_NAME_PATTERN.test('.DS_Store'), false)
  assert.equal(RETIRED_NAME_PATTERN.test('.store'), false)
})

test('scanning finds retired folders in all three locations', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-vu-scan-'))
  try {
    // A healthy tree to snapshot later.
    const good = join(base, 'good')
    mkdirSync(join(good, 'node_modules', '@scope', 'pkg'), { recursive: true })
    mkdirSync(join(good, 'node_modules', 'foo'), { recursive: true })
    writeFileSync(join(good, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }))
    writeFileSync(join(good, 'node_modules', '@scope', 'pkg', 'package.json'), '{"name":"@scope/pkg","version":"1.0.0"}')
    writeFileSync(join(good, 'node_modules', 'foo', 'package.json'), '{"name":"foo","version":"1.0.0"}')

    // The half-committed tree under a scope dir, with dsh's own retirement.
    const scope = join(base, 'global-scope')
    const installDir = join(scope, 'dsh')
    mkdirSync(join(installDir, 'node_modules', '@scope'), { recursive: true })
    writeFileSync(join(installDir, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"1.2.3"}')
    mkdirSync(join(installDir, 'node_modules', '.foo-12345678'), { recursive: true })
    writeFileSync(join(installDir, 'node_modules', '.foo-12345678', 'package.json'), '{"name":"foo"}')
    mkdirSync(join(installDir, 'node_modules', '@scope', '.pkg-abc12345'), { recursive: true })
    writeFileSync(join(installDir, 'node_modules', '@scope', '.pkg-abc12345', 'package.json'), '{"name":"@scope/pkg"}')
    mkdirSync(join(scope, '.dsh-deadbeef'), { recursive: true })
    writeFileSync(join(scope, '.dsh-deadbeef', 'package.json'), '{"name":"@deepseek-ai/dsh","version":"1.2.3"}')
    // Age everything past the freshness guard.
    const old = new Date(Date.now() - 2 * RETIRED_MIN_AGE_MS)
    for (const dir of [
      join(installDir, 'node_modules', '.foo-12345678'),
      join(installDir, 'node_modules', '@scope', '.pkg-abc12345'),
      join(scope, '.dsh-deadbeef'),
    ]) utimesSync(dir, old, old)

    const leftovers = scanRetiredLeftovers(installDir)
    assert.equal(leftovers.length, 3)
    const names = leftovers.map(entry => entry.name).sort()
    assert.deepEqual(names, ['.dsh-deadbeef', '.foo-12345678', '.pkg-abc12345'])

    // A sibling global package's retirement must NOT be picked up: only the
    // managed package's own `.dsh-*` name counts in the parent scope.
    mkdirSync(join(scope, '.other-11223344'), { recursive: true })
    utimesSync(join(scope, '.other-11223344'), old, old)
    assert.equal(scanRetiredLeftovers(installDir).length, 3, 'sibling retirements are ignored')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a damaged manifest is restored from the newest usable snapshot', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-vu-repair-'))
  try {
    // Healthy tree → local snapshot.
    const good = join(base, 'good')
    mkdirSync(join(good, 'node_modules'), { recursive: true })
    writeFileSync(join(good, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }))
    const snapshotsDir = join(base, 'snapshots')
    assert.equal(createSnapshot({ installDir: good, snapshotsDir, version: '1.2.3' }).ok, true)

    // Damaged tree: dsh renamed away, retired folders everywhere.
    const scope = join(base, 'global-scope')
    const installDir = join(scope, 'dsh')
    mkdirSync(join(installDir, 'node_modules', '@scope'), { recursive: true })
    writeFileSync(join(installDir, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"1.2.3"}')
    mkdirSync(join(installDir, 'node_modules', '.foo-12345678'), { recursive: true })
    mkdirSync(join(installDir, 'node_modules', '@scope', '.pkg-abc12345'), { recursive: true })
    mkdirSync(join(scope, '.dsh-deadbeef'), { recursive: true })
    rmSync(join(installDir, 'package.json')) // the npm kill happened mid-move
    const old = new Date(Date.now() - 2 * RETIRED_MIN_AGE_MS)
    for (const dir of [
      join(installDir, 'node_modules', '.foo-12345678'),
      join(installDir, 'node_modules', '@scope', '.pkg-abc12345'),
      join(scope, '.dsh-deadbeef'),
    ]) utimesSync(dir, old, old)

    assert.equal(inspectTreeHealth(installDir).manifestOk, false)
    const outcome = repairTree({ installDir, snapshotsDir, minAgeMs: 0 })
    assert.equal(outcome.restored, '1.2.3')
    assert.equal(outcome.manifestOk, true)
    assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '1.2.3')
    assert.equal(scanRetiredLeftovers(installDir).length, 0, 'no retired folders survive the repair')
    // The restore renames the whole old tree away, so the two bundled retired
    // folders went with it; the self-retired folder is the one explicit rm.
    assert.equal(outcome.removed, 1)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the freshness guard leaves young retirements alone on the boot path', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-vu-fresh-'))
  try {
    const installDir = join(base, 'dsh')
    mkdirSync(join(installDir, 'node_modules'), { recursive: true })
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0' }))
    // A fresh retired folder: mtime NOW — a live reify may hold it.
    mkdirSync(join(installDir, 'node_modules', '.fresh-99999999'), { recursive: true })

    const guarded = repairTree({ installDir, snapshotsDir: join(base, 'snapshots'), minAgeMs: RETIRED_MIN_AGE_MS })
    assert.equal(guarded.removed, 0, 'young retirements are reported, not deleted')
    assert.deepEqual(guarded.leftovers.map(entry => entry.name), ['.fresh-99999999'])
    assert.equal(existsSync(join(installDir, 'node_modules', '.fresh-99999999')), true)

    // Once npm provably settled, the same leftover is removed unconditionally.
    const ungated = repairTree({ installDir, snapshotsDir: join(base, 'snapshots'), minAgeMs: 0 })
    assert.equal(ungated.removed, 1)
    assert.deepEqual(ungated.leftovers, [], 'removed directories are not reported as survivors')
    assert.equal(existsSync(join(installDir, 'node_modules', '.fresh-99999999')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a retirement made by a real rename reads as young, so a live reify keeps its copies', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-vu-rename-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const installDir = join(base, 'dsh')
  const bundled = join(installDir, 'node_modules')
  // A healthy tree, so the only thing either pass can act on is the litter.
  mkdirSync(join(installDir, 'lib'), { recursive: true })
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0' }))
  writeFileSync(join(installDir, 'lib', 'bin.js'), '// launcher')
  mkdirSync(join(bundled, 'foo', 'lib'), { recursive: true })
  writeFileSync(join(bundled, 'foo', 'package.json'), '{"name":"foo","version":"1.0.0"}')

  // The package was installed days ago, so the directory npm is about to retire
  // carries an old mtime...
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  utimesSync(join(bundled, 'foo'), longAgo, longAgo)

  // ...and npm now retires it exactly the way arborist does: a RENAME. That
  // leaves the renamed directory's own mtime at 30 days old while the parent's
  // moves to now — the asymmetry the age gate has to read correctly. Reading the
  // child's mtime is how a retirement belonging to a reify that is STILL RUNNING
  // gets classified as ancient and deleted underneath it.
  renameSync(join(bundled, 'foo'), join(bundled, '.foo-12345678'))

  const leftovers = scanRetiredLeftovers(installDir)
  assert.equal(leftovers.length, 1)
  assert.equal(leftovers[0].name, '.foo-12345678')
  assert.ok(
    leftovers[0].ageMs < RETIRED_MIN_AGE_MS,
    `a just-retired folder must read as young, got ageMs=${String(leftovers[0].ageMs)}`,
  )

  // The boot-path guard therefore protects it — which is the entire point of
  // the gate: this retirement may belong to an npm orphan that is still writing.
  const guarded = repairTree({ installDir, snapshotsDir: join(base, 'snapshots'), minAgeMs: RETIRED_MIN_AGE_MS })
  assert.equal(guarded.removed, 0, 'a retirement from a possibly-live reify is reported, never deleted')
  assert.deepEqual(guarded.leftovers.map(entry => entry.name), ['.foo-12345678'])
  assert.equal(existsSync(join(bundled, '.foo-12345678')), true)

  // The post-settlement pass has no age gate, and still reclaims the same litter.
  const ungated = repairTree({ installDir, snapshotsDir: join(base, 'snapshots'), minAgeMs: 0 })
  assert.equal(ungated.removed, 1)
  assert.equal(existsSync(join(bundled, '.foo-12345678')), false)
})

test('a healthy tree needs no repair', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-vu-healthy-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const installDir = join(base, 'dsh')
  mkdirSync(join(installDir, 'node_modules'), { recursive: true })
  mkdirSync(join(installDir, 'lib'), { recursive: true })
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '3.0.0' }))
  writeFileSync(join(installDir, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  const outcome = repairTree({ installDir, snapshotsDir: join(base, 'snapshots'), minAgeMs: 0 })
  assert.equal(outcome.manifestOk, true)
  assert.equal(outcome.launcherOk, true)
  assert.equal(outcome.removed, 0)
  assert.equal(outcome.restored, undefined)
  assert.deepEqual(outcome.errors, [])
})

test('a missing launcher is repaired from a snapshot even with an intact manifest', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-vu-launcher-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const good = join(base, 'good')
  mkdirSync(join(good, 'lib'), { recursive: true })
  writeFileSync(join(good, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }))
  writeFileSync(join(good, 'lib', 'bin.js'), 'entry')
  const snapshotsDir = join(base, 'snapshots')
  assert.equal(createSnapshot({ installDir: good, snapshotsDir, version: '1.2.3' }).ok, true)

  const installDir = join(base, 'dsh')
  mkdirSync(installDir, { recursive: true })
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }))
  const outcome = repairTree({ installDir, snapshotsDir, minAgeMs: 0 })
  assert.equal(outcome.restored, '1.2.3')
  assert.equal(outcome.launcherOk, true)
  assert.equal(existsSync(join(installDir, 'lib', 'bin.js')), true)
})

test('preferredVersion restores exactly that snapshot even when the tree looks healthy', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-vu-pref-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const build = (version) => {
    const dir = join(base, `tree-${version}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
    return dir
  }
  const good12 = build('1.2.3')
  const snapshotsDir = join(base, 'snapshots')
  assert.equal(createSnapshot({ installDir: good12, snapshotsDir, version: '1.2.3', now: () => 10 }).ok, true)
  const good20 = build('2.0.0')
  assert.equal(createSnapshot({ installDir: good20, snapshotsDir, version: '2.0.0', now: () => 20 }).ok, true)

  // The host wiring knows validation failed while 2.0.0 landed; repair must
  // roll back to 1.2.3, not silently pick the newest snapshot.
  const live = join(base, 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0' }))
  const outcome = repairTree({ installDir: live, snapshotsDir, preferredVersion: '1.2.3', minAgeMs: 0 })
  assert.equal(outcome.restored, '1.2.3')
  assert.equal(JSON.parse(readFileSync(join(live, 'package.json'), 'utf8')).version, '1.2.3')

  // An unknown preferred version restores nothing rather than guessing.
  const other = join(base, 'other')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0' }))
  const refused = repairTree({ installDir: other, snapshotsDir, preferredVersion: '9.9.9', minAgeMs: 0 })
  assert.equal(refused.restored, undefined)
  assert.equal(JSON.parse(readFileSync(join(other, 'package.json'), 'utf8')).version, '2.0.0')
  assert.ok(refused.errors.some(error => error.includes('9.9.9')))
})

test('a snapshot only the byte check rejects does not block the repair', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-vu-skip-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const build = (version) => {
    const dir = join(base, `tree-${version}`)
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
    writeFileSync(join(dir, 'lib', 'bin.js'), `console.log(${JSON.stringify(version)})`)
    return dir
  }
  const snapshotsDir = join(base, 'snapshots')
  assert.equal(createSnapshot({ installDir: build('1.2.0'), snapshotsDir, version: '1.2.0', now: () => 10 }).ok, true)
  assert.equal(createSnapshot({ installDir: build('1.2.3'), snapshotsDir, version: '1.2.3', now: () => 20 }).ok, true)
  // Damage the newest one in a way only the byte check can see — a non-manifest
  // file gone, metadata and naming still agreeing. The store lists it as
  // usable, so a repair that trusted the newest entry alone would fail on it
  // and leave a tree dsh cannot start from.
  rmSync(join(snapshotsDir, '1.2.3', 'lib', 'bin.js'))

  const live = join(base, 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"1.2.3"}')
  rmSync(join(live, 'package.json')) // the npm kill happened mid-move

  const outcome = repairTree({ installDir: live, snapshotsDir, minAgeMs: 0 })
  assert.equal(outcome.restored, '1.2.0', 'the repair fell through to the entry it could use')
  assert.equal(JSON.parse(readFileSync(join(live, 'package.json'), 'utf8')).version, '1.2.0')
  assert.equal(outcome.errors.length, 0, 'a repair that succeeded is not reported as damaged')
  assert.equal(outcome.manifestOk, true)
})
/**
 * Tree-health tests: retired-name recognition, leftover scanning across the
 * three locations, damaged-manifest snapshot restore, and the freshness guard
 * that keeps a young retirement (a possibly still-running orphaned npm) from
 * being deleted on the boot path.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, readFileSync } from 'node:fs'
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
    assert.equal(existsSync(join(installDir, 'node_modules', '.fresh-99999999')), true)

    // Once npm provably settled, the same leftover is removed unconditionally.
    const ungated = repairTree({ installDir, snapshotsDir: join(base, 'snapshots'), minAgeMs: 0 })
    assert.equal(ungated.removed, 1)
    assert.equal(existsSync(join(installDir, 'node_modules', '.fresh-99999999')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a healthy tree needs no repair', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-vu-healthy-'))
  try {
    const installDir = join(base, 'dsh')
    mkdirSync(join(installDir, 'node_modules'), { recursive: true })
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '3.0.0' }))
    const outcome = repairTree({ installDir, snapshotsDir: join(base, 'snapshots'), minAgeMs: 0 })
    assert.equal(outcome.removed, 0)
    assert.equal(outcome.restored, undefined)
    assert.deepEqual(outcome.errors, [])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
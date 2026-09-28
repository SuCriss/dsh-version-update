/**
 * Snapshot store tests: creation with metadata, idempotent reuse, damaged
 * snapshot replacement, retention pruning, listing, and restore over a live
 * installation — including the async siblings the host serves through, whose
 * progress contract and leftover-free swap must match the synchronous ones.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSnapshot, createSnapshotAsync, defaultSnapshotsDir, listSnapshots, measureTree, removeSnapshot, restoreSnapshot, restoreSnapshotAsync, snapshotsTotalBytes, sweepSnapshots } from '../lib/snapshot.js'

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

test('snapshot inventory reports bytes and refuses a missing payload before touching live files', (t) => {
  const installDir = fakeInstall(t, '1.2.3')
  const snapshotsDir = snapHome(t)
  assert.equal(createSnapshot({ installDir, snapshotsDir, version: '1.2.3' }).ok, true)
  assert.ok(listSnapshots(snapshotsDir)[0].bytes > 0)
  rmSync(join(snapshotsDir, '1.2.3', 'lib', 'bin.js'))
  const outcome = restoreSnapshot({ installDir, snapshotsDir, version: '1.2.3' })
  assert.equal(outcome.ok, false)
  assert.ok(existsSync(join(installDir, 'lib', 'bin.js')))
})

for (const [name, restore] of [['sync', restoreSnapshot], ['async', restoreSnapshotAsync]]) {
  test(`${name} restore refuses a failed rename without overwriting live files`, async (t) => {
    const installDir = fakeInstall(t, '1.0.0')
    const snapshotsDir = snapHome(t)
    assert.equal(createSnapshot({ installDir, snapshotsDir, version: '1.0.0' }).ok, true)
    writeFileSync(join(installDir, 'package.json'), '{"version":"2.0.0"}')
    writeFileSync(join(installDir, 'live-only.txt'), 'must survive')
    const before = readFileSync(join(installDir, 'package.json'), 'utf8')
    // A nonempty destination makes rename fail on every platform, without
    // relying on OS permissions or patching filesystem module bindings.
    t.mock.method(Date, 'now', () => 123456)
    const stale = `${installDir}.replaced-123456`
    mkdirSync(stale)
    writeFileSync(join(stale, 'occupied.txt'), 'do not replace')
    t.after(() => rmSync(stale, { recursive: true, force: true }))
    const result = await restore({ installDir, snapshotsDir, version: '1.0.0' })
    assert.equal(result.ok, false)
    assert.match(result.error, /could not move the live installation aside/)
    // A taken target name is NOT the occupancy failure Windows reports with the
    // same EPERM: blaming a running process here would send the user hunting
    // for one that does not exist.
    assert.doesNotMatch(result.error, /held by a running process/)
    assert.equal(readFileSync(join(installDir, 'package.json'), 'utf8'), before)
    assert.equal(readFileSync(join(installDir, 'live-only.txt'), 'utf8'), 'must survive')
    assert.equal(readFileSync(join(stale, 'occupied.txt'), 'utf8'), 'do not replace')
  })

  test(`${name} restore can recreate a truly absent installation`, async (t) => {
    const installDir = fakeInstall(t, '1.0.0')
    const snapshotsDir = snapHome(t)
    assert.equal(createSnapshot({ installDir, snapshotsDir, version: '1.0.0' }).ok, true)
    rmSync(installDir, { recursive: true })
    assert.deepEqual(await restore({ installDir, snapshotsDir, version: '1.0.0' }), { ok: true })
    assert.ok(existsSync(join(installDir, 'lib', 'bin.js')))
  })
}

test('a tree held as a working directory is reported as held, not as a bare code', { skip: process.platform !== 'win32' }, (t) => {
  const installDir = fakeInstall(t, '1.0.0')
  const snapshotsDir = snapHome(t)
  assert.equal(createSnapshot({ installDir, snapshotsDir, version: '1.0.0' }).ok, true)

  // Windows refuses to rename a directory that is a live process's working
  // directory, and that refusal — not a permission problem — is what the
  // message has to explain. POSIX allows the rename, so the case is Windows
  // only; there the same call succeeds and this message never appears.
  const original = process.cwd()
  process.chdir(installDir)
  try {
    const result = restoreSnapshot({ installDir, snapshotsDir, version: '1.0.0' })
    assert.equal(result.ok, false)
    assert.match(result.error, /could not move the live installation aside/)
    assert.match(result.error, /held by a running process/)
    assert.match(result.error, /npm install -g @deepseek-ai\/dsh@latest/)
  } finally {
    process.chdir(original)
  }
})

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

for (const [name, create] of [['sync', createSnapshot], ['async', createSnapshotAsync]]) {
  test(`${name} snapshot quota deletes oldest usable snapshots first after damaged pruning`, async (t) => {
    const snapshotsDir = snapHome(t)
    let bytes
    for (let index = 0; index < 3; index += 1) {
      const version = `1.0.${index}`
      const installDir = fakeInstall(t, version)
      if (index === 2) {
        const damaged = join(snapshotsDir, '0.0.1')
        mkdirSync(damaged)
        writeFileSync(join(damaged, 'stray'), 'damaged')
      }
      assert.equal((await create({ installDir, snapshotsDir, version, keep: 5, maxBytes: bytes === undefined ? 0 : bytes * 2, now: () => index })).ok, true)
      bytes ??= snapshotsTotalBytes(snapshotsDir)
    }
    assert.deepEqual(listSnapshots(snapshotsDir).map(entry => entry.version), ['1.0.2', '1.0.1'])
    assert.equal(snapshotsTotalBytes(snapshotsDir), bytes * 2)
    assert.equal(existsSync(join(snapshotsDir, '0.0.1')), false)
  })

  test(`${name} snapshot quota zero is unlimited while count retention still applies`, async (t) => {
    const snapshotsDir = snapHome(t)
    for (let index = 0; index < 4; index += 1) {
      const version = `2.0.${index}`
      const installDir = fakeInstall(t, version)
      assert.equal((await create({ installDir, snapshotsDir, version, keep: 3, maxBytes: 0, now: () => index })).ok, true)
    }
    assert.deepEqual(listSnapshots(snapshotsDir).map(entry => entry.version), ['2.0.3', '2.0.2', '2.0.1'])
    assert.ok(snapshotsTotalBytes(snapshotsDir) > 0)
  })

  test(`${name} tiny quota preserves the just-created snapshot even after clock rollback`, async (t) => {
    const snapshotsDir = snapHome(t)
    for (let index = 0; index < 2; index += 1) {
      const version = `3.0.${index}`
      const installDir = fakeInstall(t, version)
      assert.deepEqual(await create({ installDir, snapshotsDir, version, keep: 1, maxBytes: 1, now: () => 100 - index }), { ok: true })
    }
    assert.deepEqual(listSnapshots(snapshotsDir).map(entry => entry.version), ['3.0.1'])
    assert.ok(snapshotsTotalBytes(snapshotsDir) > 1, 'rollback safety beats the byte budget')
  })
}

test('snapshot byte totals include legacy payloads without metadata byte counts', (t) => {
  const snapshotsDir = snapHome(t)
  assert.equal(snapshotsTotalBytes(snapshotsDir), 0)
  const installDir = fakeInstall(t, '4.0.0')
  assert.equal(createSnapshot({ installDir, snapshotsDir, version: '4.0.0' }).ok, true)
  const total = snapshotsTotalBytes(snapshotsDir)
  writeFileSync(join(snapshotsDir, '4.0.0', 'meta.json'), JSON.stringify({ version: '4.0.0', at: 1 }))
  assert.equal(snapshotsTotalBytes(snapshotsDir), total)
  const next = fakeInstall(t, '4.0.1')
  assert.equal(createSnapshot({ installDir: next, snapshotsDir, version: '4.0.1', maxBytes: total, now: () => 2 }).ok, true)
  assert.deepEqual(listSnapshots(snapshotsDir).map(entry => entry.version), ['4.0.1'])
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

test('a discard renames the snapshot out of the version namespace before unlinking it', async (t) => {
  const installDir = fakeInstall(t, '6.0.0')
  const snapshotsDir = snapHome(t)
  assert.equal(createSnapshot({ installDir, snapshotsDir, version: '6.0.0' }).ok, true)

  // The point of the rename: the version is gone from the panel the instant the
  // call returns, with the bytes still on disk. A recursive delete in place
  // would block the host for seconds — long enough to outlive the panel's
  // request timeout, which is what made the button look dead.
  assert.equal(removeSnapshot(snapshotsDir, '6.0.0'), true)
  assert.deepEqual(listSnapshots(snapshotsDir), [])
  assert.equal(snapshotsTotalBytes(snapshotsDir), 0)
  const leftovers = readdirSync(snapshotsDir)
  assert.equal(leftovers.length, 1)
  assert.match(leftovers[0], /^\.trash-6\.0\.0-\d+$/)

  // The sweep is the deterministic end of the background unlink.
  await sweepSnapshots(snapshotsDir)
  assert.deepEqual(readdirSync(snapshotsDir), [])
  assert.equal(removeSnapshot(snapshotsDir, '6.0.0'), false, 'nothing left to delete')
})

test('the sweep reclaims interrupted copies and stranded tombstones, and only those', async (t) => {
  const installDir = fakeInstall(t, '7.0.0')
  const snapshotsDir = snapHome(t)
  assert.equal(createSnapshot({ installDir, snapshotsDir, version: '7.0.0' }).ok, true)
  // What a killed process leaves: a copy that never reached its rename, and a
  // tombstone whose unlink died with the host. Neither is a version name, so
  // the panel can never show them and nothing else would free their disk.
  mkdirSync(join(snapshotsDir, '.tmp-7.1.0-1789697010310'), { recursive: true })
  writeFileSync(join(snapshotsDir, '.tmp-7.1.0-1789697010310', 'package.json'), '{}')
  mkdirSync(join(snapshotsDir, '.trash-7.2.0-1789697010311'), { recursive: true })
  writeFileSync(join(snapshotsDir, '.trash-7.2.0-1789697010311', 'package.json'), '{}')

  assert.equal(await sweepSnapshots(snapshotsDir), 2)
  assert.deepEqual(readdirSync(snapshotsDir), ['7.0.0'], 'the usable snapshot survived the sweep')
  assert.deepEqual(listSnapshots(snapshotsDir).map(entry => entry.version), ['7.0.0'])
  assert.equal(await sweepSnapshots(snapshotsDir), 0, 'a clean store sweeps nothing')
})

test('the async restore matches the synchronous one and leaves nothing beside', async (t) => {
  const install = fakeInstall(t, '4.0.0')
  const snapshotsDir = snapHome(t)
  assert.deepEqual(await createSnapshotAsync({ installDir: install, snapshotsDir, version: '4.0.0', now: () => 7 }), { ok: true })
  // Simulate an update having moved the live tree forward and lost the launcher.
  writeFileSync(join(install, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '4.1.0' }))
  rmSync(join(install, 'lib', 'bin.js'))
  assert.deepEqual(await restoreSnapshotAsync({ installDir: install, snapshotsDir, version: '4.0.0' }), { ok: true })
  assert.equal(JSON.parse(readFileSync(join(install, 'package.json'), 'utf8')).version, '4.0.0')
  assert.ok(existsSync(join(install, 'lib', 'bin.js')), 'the launcher came back from the snapshot')
  assert.deepEqual(readdirSync(dirname(install)).filter(name => name.includes('.replaced-')), [])
  // The same refusals as the synchronous variant: nothing usable, nothing vague.
  assert.equal((await restoreSnapshotAsync({ installDir: install, snapshotsDir, version: '4.2.0' })).ok, false)
  assert.equal((await restoreSnapshotAsync({ installDir: install, snapshotsDir, version: '..\\windows' })).ok, false)
})

test('the async snapshot reports live counts against the measured totals', async (t) => {
  const install = fakeInstall(t, '5.0.0')
  const snapshotsDir = snapHome(t)
  /** @type {{ phase: string; files: number; bytes: number; totalFiles?: number; totalBytes?: number }[]} */
  const events = []
  assert.deepEqual(await createSnapshotAsync({
    installDir: install,
    snapshotsDir,
    version: '5.0.0',
    now: () => 11,
    progressMs: 1,
    onProgress: info => events.push(info),
  }), { ok: true })

  const measure = events.filter(entry => entry.phase === 'measure')
  const copies = events.filter(entry => entry.phase === 'copy')
  assert.equal(measure.length, 1, 'exactly one measuring report, before the copy starts')
  assert.ok(copies.length > 0, 'the copy phase reported at least once')
  // The contract the panel's percentage is computed from. Spreading the totals
  // object over the live counts used to satisfy neither: `bytes` arrived as the
  // TOTAL (so every tick looked finished) and `totalBytes` never arrived at all.
  const expected = await measureTree(install)
  for (const entry of copies) {
    assert.equal(typeof entry.files, 'number')
    assert.equal(typeof entry.bytes, 'number')
    assert.equal(entry.totalFiles, expected.files, 'the total file count rides along')
    assert.equal(entry.totalBytes, expected.bytes, 'the total byte count rides along')
    assert.ok(entry.bytes <= entry.totalBytes, 'a copy in progress cannot exceed its own total')
    assert.ok(entry.files <= entry.totalFiles)
  }
  assert.equal(copies.at(-1).bytes, expected.bytes, 'the last report is the completed copy')
  assert.equal(measure[0].totalBytes, expected.bytes)
})

test('listing is metadata-level, and the restore is where the byte check still bites', (t) => {
  const installDir = fakeInstall(t, '1.4.0')
  const snapshotsDir = snapHome(t)
  assert.equal(createSnapshot({ installDir, snapshotsDir, version: '1.4.0' }).ok, true)
  // Damage only the byte check can see: a non-manifest file changed, so the
  // metadata and the naming still agree. The panel's poll path must not walk
  // 26 513 files per snapshot to discover this — listing says "structurally
  // fine", and the restore, which cannot afford to be wrong, refuses.
  writeFileSync(join(snapshotsDir, '1.4.0', 'lib', 'bin.js'), '// overwritten by something else')
  assert.equal(listSnapshots(snapshotsDir)[0].usable, true, 'listing does not walk the tree')
  const outcome = restoreSnapshot({ installDir, snapshotsDir, version: '1.4.0' })
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /no usable snapshot of 1\.4\.0/)
  // The refusal came before anything touched the live installation.
  assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '1.4.0')
})

test('a restore keeps the tree it replaces as a snapshot of the version left behind', async (t) => {
  const installDir = fakeInstall(t, '1.0.0')
  const snapshotsDir = snapHome(t)
  assert.equal(createSnapshot({ installDir, snapshotsDir, version: '1.0.0' }).ok, true)
  // The install that moved the tree forward never snapshotted 2.0.0 — which is
  // the ordinary case, because a snapshot is taken of the version being
  // REPLACED. Without adoption this restore would be one-way.
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0' }))
  const outcome = await restoreSnapshotAsync({ installDir, snapshotsDir, version: '1.0.0', adopt: { keep: 5 } })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.backup, '2.0.0', 'the version left behind is now restorable')
  assert.deepEqual(listSnapshots(snapshotsDir).map(entry => entry.version).sort(), ['1.0.0', '2.0.0'])
  assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '1.0.0')
  // It is a real snapshot, not a bookmark: it restores back to 2.0.0.
  assert.deepEqual(await restoreSnapshotAsync({ installDir, snapshotsDir, version: '2.0.0' }), { ok: true })
  assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '2.0.0')
  // Neither swap left a replaced-aside tree beside the installation.
  assert.deepEqual(readdirSync(dirname(installDir)).filter(name => name.includes('.replaced-')), [])
})

test('adoption is skipped when the version left behind already has an intact snapshot', async (t) => {
  const installDir = fakeInstall(t, '1.0.0')
  const snapshotsDir = snapHome(t)
  assert.equal(createSnapshot({ installDir, snapshotsDir, version: '1.0.0', now: () => 1 }).ok, true)
  // A snapshot of the version now on disk already exists — keeping a second
  // copy of the same version would only cost disk, so the tree is discarded.
  const live = fakeInstall(t, '2.0.0')
  assert.equal(createSnapshot({ installDir: live, snapshotsDir, version: '2.0.0', now: () => 2 }).ok, true)
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0' }))
  const outcome = await restoreSnapshotAsync({ installDir, snapshotsDir, version: '1.0.0', adopt: {} })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.backup, '2.0.0', 'the existing snapshot already covers it')
  assert.deepEqual(listSnapshots(snapshotsDir).map(entry => entry.version).sort(), ['1.0.0', '2.0.0'])
  assert.deepEqual(readdirSync(dirname(installDir)).filter(name => name.includes('.replaced-')), [])
})

test('adoption never evicts the snapshot a restore is moving TO', async (t) => {
  const snapshotsDir = snapHome(t)
  // A full store, with the restore target as its OLDEST entry — the shape a
  // user reaches when they roll back the furthest, and exactly what a prune
  // ordered by age would delete first.
  const versions = ['1.0.0', '1.0.1', '1.0.2']
  for (const [index, version] of versions.entries()) {
    const dir = fakeInstall(t, version)
    assert.equal(createSnapshot({ installDir: dir, snapshotsDir, version, keep: 3, now: () => index }).ok, true)
  }
  const installDir = fakeInstall(t, '2.0.0')
  const outcome = await restoreSnapshotAsync({
    installDir,
    snapshotsDir,
    version: '1.0.0',
    adopt: { keep: 3, protect: ['1.0.0'] },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.backup, '2.0.0')
  const listed = listSnapshots(snapshotsDir).map(entry => entry.version).sort()
  assert.ok(listed.includes('1.0.0'), `the version restored to survived the adoption prune: ${listed.join(', ')}`)
  assert.equal(listed.length, 3, 'and the store still respects its retention')
})

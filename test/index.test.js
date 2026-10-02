/**
 * Composition tests: what apply() mounts, what it persists, and the local
 * behavior of its routes against a fake host context. The network-facing
 * pieces (registry, npm, GitHub) are exercised in their own module tests.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { VERSION_API, DEFAULT_POLICY } from '../lib/protocol.js'
import { createSnapshotAsync } from '../lib/snapshot.js'
import { RETIRED_MIN_AGE_MS } from '../lib/tree-health.js'
import { apply } from '../lib/index.js'

/**
 * A fake cordis context recording route registrations and effects. `register`
 * rejects a duplicate (kind, path) exactly like the real web server does: the
 * route table is keyed by pattern alone, so a family mounting one path twice
 * is a boot failure, not a runtime detail this fake may smooth over.
 */
function fakeCtx() {
  const registered = []
  const effects = []
  return {
    registered,
    effects,
    webServer: {
      host: '127.0.0.1',
      port: 3080,
      register(route) {
        const clash = registered.find(entry => entry.kind === route.kind && entry.path === route.path)
        if (clash !== undefined) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        registered.push(route)
        return () => {
          const index = registered.indexOf(route)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
    },
  }
}

/** One fake installed dsh + fake argv + temp data dir; restores everything after. */
function environment(t, manifestVersion = '0.4.0') {
  const installDir = mkdtempSync(join(tmpdir(), 'vu-idx-install-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: manifestVersion,
  }))
  const dataDir = mkdtempSync(join(tmpdir(), 'vu-idx-data-'))
  const savedArgv = process.argv
  process.argv = [process.execPath, join(installDir, 'lib', 'bin.js'), '--profile', 'web']
  t.after(() => {
    process.argv = savedArgv
    rmSync(installDir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { installDir, dataDir }
}

async function invoke(routes, path, opts = {}) {
  const method = opts.method ?? 'GET'
  const route = routes.find(candidate => candidate.path === path)
  assert.ok(route !== undefined, `route ${path} mounted`)
  const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const req = {
    method,
    url: path,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
  }
  req[Symbol.asyncIterator] = async function* () { yield* chunks }
  const res = {}
  res.status = undefined
  res.body = undefined
  res.writeHead = status => { res.status = status }
  res.end = body => { res.body = JSON.parse(body) }
  await route.handler(req, res)
  return res
}

/**
 * A live process that is NOT this one, for the cases where the machine-wide
 * lock must be honored: the staleness rules only respect a holder whose pid is
 * alive, so a fake pid would be stolen and prove nothing.
 * @param {import('node:test').TestContext} t - for cleanup.
 * @returns {import('node:child_process').ChildProcess} the other "host".
 */
function foreignHost(t) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  t.after(() => { child.kill() })
  return child
}

/**
 * Store a usable snapshot of `version`, built from a throwaway healthy tree.
 *
 * A boot pass that ignores the machine-wide lock has something to restore, and
 * that restore is the destructive step the lock tests exist to prevent.
 * @param {string} snapshotsDir - the store to seed.
 * @param {string} version - the version to snapshot.
 * @returns {Promise<void>} resolves once the snapshot is listed as usable.
 */
async function seedSnapshot(snapshotsDir, version) {
  const tree = mkdtempSync(join(tmpdir(), 'vu-p02-seed-'))
  mkdirSync(join(tree, 'lib'), { recursive: true })
  writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  writeFileSync(join(tree, 'lib', 'bin.js'), '// launcher')
  const outcome = await createSnapshotAsync({ installDir: tree, snapshotsDir, version, now: () => 1 })
  rmSync(tree, { recursive: true, force: true })
  assert.equal(outcome.ok, true, `seed a snapshot of ${version}`)
}

test('apply mounts the full core family; notes stay off without a repo slug', (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  apply(ctx, { dataDir })
  const paths = ctx.registered.map(route => route.path).sort()
  assert.deepEqual(paths, [
    VERSION_API.check,
    VERSION_API.checkAuto,
    VERSION_API.checkRun,
    VERSION_API.restartDiagnostics,
    VERSION_API.policy,
    VERSION_API.pendingCancel,
    VERSION_API.preflight,
    VERSION_API.operations,
    VERSION_API.restart,
    VERSION_API.restore,
    VERSION_API.snapshotDelete,
    VERSION_API.snapshots,
    VERSION_API.status,
    VERSION_API.update,
  ].sort(), 'the family is exactly these routes; /notes stays absent without a repo slug')
  assert.equal(new Set(paths).size, paths.length, 'the web server keys routes by path: no family may mount one twice')
})

test('preflight uses configured dataDir and remains mounted without restart support', async (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  apply(ctx, { dataDir, allowRestart: false })
  t.after(() => { for (const dispose of ctx.effects) dispose?.() })
  const res = await invoke(ctx.registered, VERSION_API.preflight)
  assert.equal(res.status, 200)
  assert.equal(res.body.result.installDirWritable, true)
  assert.equal(res.body.result.snapshotDirUsable, true)
  assert.equal(existsSync(join(dataDir, 'snapshots')), true)
  // A file blocking exactly the configured snapshot directory changes the
  // verdict, proving the probe does not use the default user-profile store.
  rmSync(join(dataDir, 'snapshots'), { recursive: true })
  writeFileSync(join(dataDir, 'snapshots'), 'blocked')
  const blocked = await invoke(ctx.registered, VERSION_API.preflight)
  assert.equal(blocked.status, 200)
  assert.equal(blocked.body.result.snapshotDirUsable, false)
  assert.equal(blocked.body.result.ok, false)
  assert.equal((await invoke(ctx.registered, VERSION_API.preflight, { method: 'POST' })).status, 405)
})

test('pending cancellation is wired even when restart is disabled', async (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  apply(ctx, { dataDir, allowRestart: false })
  t.after(() => { for (const dispose of ctx.effects) dispose?.() })
  const res = await invoke(ctx.registered, VERSION_API.pendingCancel, { method: 'POST' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { result: { cancelled: true } })
  assert.equal((await invoke(ctx.registered, VERSION_API.pendingCancel)).status, 405)
})

test('apply seeds a policy file on first mount and serves it back', async (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  apply(ctx, { dataDir })

  const policyPath = join(dataDir, 'policy.json')
  assert.equal(existsSync(policyPath), true, 'first mount persists the defaults')
  assert.equal(JSON.parse(readFileSync(policyPath, 'utf8')).mode, DEFAULT_POLICY.mode)

  const res = await invoke(ctx.registered, VERSION_API.policy)
  assert.equal(res.status, 200)
  assert.equal(res.body.result.policy.mode, DEFAULT_POLICY.mode)
})

test('policy changes through the route persist immediately', async (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  apply(ctx, { dataDir })

  const res = await invoke(ctx.registered, VERSION_API.policy, {
    method: 'POST',
    body: { mode: 'notify', checkAt: '03:30' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.result.policy.mode, 'notify')

  const stored = JSON.parse(readFileSync(join(dataDir, 'policy.json'), 'utf8'))
  assert.equal(stored.mode, 'notify')
  assert.equal(stored.checkAt, '03:30')

  // A reload reads the same values back.
  const ctx2 = fakeCtx()
  apply(ctx2, { dataDir })
  const again = await invoke(ctx2.registered, VERSION_API.policy)
  assert.equal(again.body.result.policy.checkAt, '03:30')
})

test('status reports the running version from the discovered installation', async (t) => {
  const { dataDir } = environment(t, '7.7.7')
  const ctx = fakeCtx()
  apply(ctx, { dataDir })
  const res = await invoke(ctx.registered, VERSION_API.status)
  assert.equal(res.status, 200)
  assert.equal(res.body.result.running, '7.7.7')
  assert.equal(res.body.result.installed, '7.7.7')
  assert.equal(res.body.result.needsRestart, false)
})

test('snapshots start empty and restore reports a missing snapshot as conflict', async (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  apply(ctx, { dataDir, lockPath: join(dataDir, 'update.lock') })

  const listed = await invoke(ctx.registered, VERSION_API.snapshots)
  assert.deepEqual(listed.body.result.snapshots, [])

  const failed = await invoke(ctx.registered, VERSION_API.restore, {
    method: 'POST',
    body: { version: '9.9.9' },
  })
  assert.equal(failed.status, 409)
  // The reason matters: a 409 from lock contention would pass the status check
  // while proving nothing about the snapshot store.
  assert.match(failed.body.error, /no usable snapshot of 9\.9\.9/)
  const progress = await invoke(ctx.registered, VERSION_API.operations)
  assert.deepEqual(progress.body.result.events.map(entry => entry.phase), ['running', 'failed'])
  assert.match(progress.body.result.events[1].error, /no usable snapshot/)
})

test('only the acting check feeds the auto decision, so a read never parks work', async (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  apply(ctx, { dataDir })
  t.after(() => { for (const dispose of ctx.effects) dispose?.() })
  // auto + a window that is closed at whatever minute this suite runs. The
  // ACTING read parks its finding — visible as pendingAuto — and the OBSERVING
  // read does not. Neither spawns npm, so the two paths are told apart without
  // letting the composition run a real install.
  const now = new Date()
  const stamp = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const at = (now.getHours() * 60 + now.getMinutes() + 30) % 1440
  await invoke(ctx.registered, VERSION_API.policy, {
    method: 'POST',
    body: { mode: 'auto', window: { start: stamp(at), end: stamp((at + 1) % 1440) } },
  })
  const savedFetch = globalThis.fetch
  globalThis.fetch = /** @type {any} */ (async () => ({
    ok: true,
    json: async () => ({ 'dist-tags': { latest: '9.9.9' }, versions: { '9.9.9': {}, '0.4.0': {} } }),
  }))
  try {
    const read = await invoke(ctx.registered, VERSION_API.check)
    assert.equal(read.status, 200)
    assert.equal(read.body.result.lastCheck.target, '9.9.9', 'the read still records what it saw')
    assert.equal(read.body.result.pendingAuto, undefined, 'but a GET never parks automatic work')

    const acted = await invoke(ctx.registered, VERSION_API.checkAuto, { method: 'POST' })
    assert.equal(acted.status, 200)
    assert.equal(acted.body.result.pendingAuto?.target, '9.9.9', 'the acting check is what the policy acts on')
  } finally {
    globalThis.fetch = savedFetch
  }
})

test('manual check updates scheduler facts without installing under auto policy', async (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  apply(ctx, { dataDir, lockPath: join(dataDir, 'update.lock') })
  t.after(() => { for (const dispose of ctx.effects) dispose?.() })
  await invoke(ctx.registered, VERSION_API.policy, { method: 'POST', body: { mode: 'auto' } })
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ 'dist-tags': { latest: '9.9.9' }, versions: { '9.9.9': {}, '0.4.0': {} } }),
  }))
  const res = await invoke(ctx.registered, VERSION_API.checkRun, { method: 'POST' })
  assert.equal(res.status, 200)
  assert.equal(res.body.result.lastCheck.target, '9.9.9')
  assert.equal(res.body.result.task.state, 'idle')
  assert.equal(res.body.result.pendingAuto, undefined)
  assert.equal(existsSync(join(dataDir, 'update.lock')), false)
})

test('restart diagnostics follows dataDir and is absent when restart is disabled', async (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  apply(ctx, { dataDir })
  const empty = await invoke(ctx.registered, VERSION_API.restartDiagnostics)
  assert.deepEqual(empty.body.result, { available: false, log: '', truncated: false })
  writeFileSync(join(dataDir, 'restart.log'), 'replacement ready\n')
  const read = await invoke(ctx.registered, VERSION_API.restartDiagnostics)
  assert.equal(read.body.result.log, 'replacement ready\n')
  const disabled = fakeCtx()
  apply(disabled, { dataDir, allowRestart: false })
  assert.equal(disabled.registered.some(route => route.path === VERSION_API.restartDiagnostics), false)
})

test('disposal unregisters every route and stops the scheduler', (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  apply(ctx, { dataDir })
  assert.ok(ctx.registered.length > 0)
  for (const dispose of [...ctx.effects]) dispose?.()
  assert.equal(ctx.registered.length, 0, 'the routes effect removed every registration')
})

test('an unusable registry config degrades and reports, instead of failing the mount', async (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  const messages = []
  const savedError = console.error
  console.error = (...args) => { messages.push(args.join(' ')) }
  try {
    apply(ctx, { dataDir, registry: 'not a url at all' })
  } finally {
    console.error = savedError
  }
  // Before: the throw escaped apply(), so one typo in one setting took the
  // whole route family with it and the panel reported "host routes not
  // mounted" — sending the user to restart a host that was fine.
  assert.ok(ctx.registered.length > 0, 'the routes still mount')
  assert.ok(messages.some(line => line.includes('invalid registry')), 'the degradation is reported, not silent')
  const res = await invoke(ctx.registered, VERSION_API.status)
  assert.equal(res.status, 200)
})

test('an unwritable state directory costs persistence, not the mount', async (t) => {
  environment(t)
  // A regular file where the state directory should be: every write under it
  // fails with ENOTDIR, including the first-mount policy seeding.
  const blocker = join(tmpdir(), `vu-blocker-${String(Date.now())}`)
  writeFileSync(blocker, 'not a directory')
  t.after(() => rmSync(blocker, { force: true }))
  const ctx = fakeCtx()
  const savedError = console.error
  const messages = []
  console.error = (...args) => { messages.push(args.join(' ')) }
  try {
    apply(ctx, { dataDir: join(blocker, 'state') })
  } finally {
    console.error = savedError
  }
  assert.ok(ctx.registered.length > 0, 'the plugin still serves its routes')
  const res = await invoke(ctx.registered, VERSION_API.policy)
  assert.equal(res.status, 200, 'the policy is still readable from memory')
  assert.ok(messages.some(line => line.includes('cannot write')), 'the failed seed is reported')
})

test('a restore goes through the snapshot store and back to the recorded version', async (t) => {
  const { installDir, dataDir } = environment(t)
  const snapshotsDir = join(dataDir, 'snapshots')
  const made = await createSnapshotAsync({ installDir, snapshotsDir, version: '0.4.0', now: () => 1000 })
  assert.deepEqual(made, { ok: true })
  // An "update" moved the live tree forward.
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.9.0' }))

  const ctx = fakeCtx()
  apply(ctx, { dataDir, lockPath: join(dataDir, 'update.lock') })
  const res = await invoke(ctx.registered, VERSION_API.restore, { method: 'POST', body: { version: '0.4.0' } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.result.restored, '0.4.0')
  assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '0.4.0')
  // The rollback is in the audit trail, marked as a restore.
  const history = JSON.parse(readFileSync(join(dataDir, 'history.json'), 'utf8'))
  assert.equal(history.at(-1).restored, true)
  assert.equal(history.at(-1).to, '0.4.0')
  const progress = await invoke(ctx.registered, VERSION_API.operations)
  assert.equal(progress.status, 200)
  const events = progress.body.result.events.filter(entry => entry.kind === 'restore')
  assert.deepEqual(events.map(entry => entry.phase), ['running', 'done'])
  assert.equal(events[0].id, events[1].id)
  assert.equal(events[0].data.version, '0.4.0')
  assert.ok(events[1].seq > events[0].seq)
})

test('a repair that restored nothing is not recorded as a successful one', async (t) => {
  const { installDir, dataDir } = environment(t)
  // A retired folder left behind by a killed npm, dated far enough back for the
  // boot repair to claim it — that is what makes the pass run at all.
  // `environment` builds a tree whose launcher is missing, so the pass reports
  // the damage and restores nothing. The panel says the repair did not fully
  // succeed, and the audit trail must not call the same pass `ok` merely
  // because package.json still parses.
  const leftover = join(installDir, 'node_modules', '.foo-12345678')
  mkdirSync(leftover, { recursive: true })
  utimesSync(leftover, new Date(0), new Date(0))

  const ctx = fakeCtx()
  const savedError = console.error
  console.error = () => {}
  try {
    apply(ctx, { dataDir, lockPath: join(dataDir, 'update.lock') })
  } finally {
    console.error = savedError
  }
  const history = JSON.parse(readFileSync(join(dataDir, 'history.json'), 'utf8'))
  assert.equal(history.at(-1).repair, true, 'the pass is still recorded as a tree repair')
  assert.equal(history.at(-1).restored, undefined, 'but it must not claim a snapshot restore it never performed')
  assert.equal(history.at(-1).result, 'failed', 'a repair that restored nothing did not succeed')
})

test('a pure litter sweep is recorded as a repair, never as a snapshot restore', async (t) => {
  const { installDir, dataDir } = environment(t, '0.4.0')
  // A healthy tree with one retirement old enough for the boot pass to reclaim,
  // and no snapshot anywhere: the pass can only DELETE, so the audit trail must
  // not describe it as a version transition.
  mkdirSync(join(installDir, 'lib'), { recursive: true })
  writeFileSync(join(installDir, 'lib', 'bin.js'), '// launcher')
  const leftover = join(installDir, 'node_modules', '.foo-12345678')
  mkdirSync(leftover, { recursive: true })
  const at = Date.now() - 2 * RETIRED_MIN_AGE_MS
  utimesSync(leftover, new Date(at), new Date(at))
  utimesSync(join(installDir, 'node_modules'), new Date(at), new Date(at))

  const ctx = fakeCtx()
  apply(ctx, { dataDir, lockPath: join(dataDir, 'update.lock') })
  t.after(() => { for (const dispose of ctx.effects) dispose?.() })
  assert.equal(existsSync(leftover), false, 'the pass reclaimed the litter')

  const entry = JSON.parse(readFileSync(join(dataDir, 'history.json'), 'utf8')).at(-1)
  assert.equal(entry.repair, true, 'the pass is recorded as a tree repair')
  assert.equal(entry.removed, 1, 'and it says how much litter it reclaimed')
  // The lie this replaces: every pass was recorded as `restored: true`, so one
  // that copied nothing over the tree still rendered as "snapshot restore" — a
  // version transition the trail never witnessed.
  assert.equal(entry.restored, undefined, 'a sweep must not claim a snapshot restore')
})

test('a retired folder the boot sweep had to defer is reclaimed once it ages past the gate', async (t) => {
  const { installDir, dataDir } = environment(t)
  // A healthy tree, so the pass that runs is only ever about the litter: a
  // damaged one would send the repair looking for a snapshot instead.
  mkdirSync(join(installDir, 'lib'), { recursive: true })
  writeFileSync(join(installDir, 'lib', 'bin.js'), '// launcher')

  // A killed npm's retired folder, dated just INSIDE the boot gate — too young
  // for the mount pass to delete, which is what makes that pass defer it. The
  // deferral is the point: the mount pass runs exactly once, so without a
  // follow-up the folder and its full copy of the tree sit on disk until the
  // next restart. Dating it a second and a half inside the gate rather than
  // ten minutes inside is what lets this run in real time instead of mocking
  // every timer the plugin owns.
  const leftover = join(installDir, 'node_modules', '.foo-12345678')
  mkdirSync(leftover, { recursive: true })
  const inside = 1500
  const at = Date.now() - (10 * 60 * 1000) + inside
  // BOTH the retirement and the directory that holds it. A retirement is a
  // rename, and a rename moves only the PARENT's mtime — so the age gate reads
  // the parent as its freshness evidence. Back-dating the child alone would now
  // (correctly) describe a folder retired this very instant, and the pass under
  // test would wait out the entire gate instead of the 1.5 s this fixture is
  // about. Order matters: creating the child bumped the parent's mtime.
  utimesSync(leftover, new Date(at), new Date(at))
  utimesSync(join(installDir, 'node_modules'), new Date(at), new Date(at))

  const ctx = fakeCtx()
  apply(ctx, { dataDir, lockPath: join(dataDir, 'update.lock') })
  assert.ok(existsSync(leftover), 'a retired folder younger than the gate survives the mount pass')

  // The follow-up waits out the rest of the gate and then sweeps.
  await new Promise(resolve => { setTimeout(resolve, inside + 1500) })
  assert.equal(existsSync(leftover), false, 'the deferred pass reclaimed the leftover')
})

test('a boot repair yields to another host mid-install instead of rebuilding under it', async (t) => {
  const { installDir, dataDir } = environment(t, '0.4.0')
  const snapshotsDir = join(dataDir, 'snapshots')
  await seedSnapshot(snapshotsDir, '0.3.0')
  // The live tree is in the shape another host's npm leaves behind mid-reify:
  // the package folder renamed aside, so the manifest is unreadable. A boot pass
  // that ignores the lock reads that as "damaged tree + usable snapshot" and
  // copies the snapshot over a tree npm is still writing.
  rmSync(join(installDir, 'package.json'))

  const other = foreignHost(t)
  const lockPath = join(dataDir, 'update.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: other.pid, at: Date.now(), token: 'foreign' }), 'utf8')

  const ctx = fakeCtx()
  apply(ctx, { dataDir, lockPath })
  t.after(() => { for (const dispose of ctx.effects) dispose?.() })

  assert.equal(existsSync(join(installDir, 'package.json')), false, 'the boot pass must not rebuild a tree another host is writing')
  assert.equal(existsSync(join(snapshotsDir, '0.3.0', 'package.json')), true, 'and the snapshot stays in the store, unspent')
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'foreign', 'the foreign lock is neither stolen nor released')
  // Deferring must not mean hiding: the damage still reaches the panel, which is
  // what tells the user the tree is in another host's hands.
  const status = await invoke(ctx.registered, VERSION_API.status)
  assert.equal(status.body.result.tree.manifestOk, false)
  assert.equal(status.body.result.tree.healthy, false)
})

test('a boot repair that deferred to another host is retried, not dropped', async (t) => {
  const { installDir, dataDir } = environment(t, '0.4.0')
  const snapshotsDir = join(dataDir, 'snapshots')
  await seedSnapshot(snapshotsDir, '0.3.0')
  rmSync(join(installDir, 'package.json'))

  const other = foreignHost(t)
  const lockPath = join(dataDir, 'update.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: other.pid, at: Date.now(), token: 'foreign' }), 'utf8')

  const ctx = fakeCtx()
  apply(ctx, { dataDir, lockPath })
  t.after(() => { for (const dispose of ctx.effects) dispose?.() })
  assert.equal(existsSync(join(installDir, 'package.json')), false, 'nothing happens while the other host holds the tree')

  // The other host finishes. The deferred retry is armed at REPAIR_DELAY_MS
  // (RELEASE_GRACE_MS + 1000 = 6 s), so waiting past it is the whole assertion:
  // yielding is only correct if the pass comes back.
  other.kill()
  await new Promise(resolve => { setTimeout(resolve, 7000) })
  assert.equal(
    JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version,
    '0.3.0',
    'the deferred pass ran once the tree was free',
  )
  assert.equal(existsSync(lockPath), false, 'and it gave the machine-wide lock back')
  // The distinction the trail has to keep: this pass really did copy a snapshot
  // over the tree, so it says so — while a pass that only deleted litter does
  // not (see the pure-sweep case above).
  const entry = JSON.parse(readFileSync(join(dataDir, 'history.json'), 'utf8')).at(-1)
  assert.equal(entry.repair, true, 'a deferred pass is still recorded as a tree repair')
  assert.equal(entry.restored, true, 'and a pass that really restored the snapshot says so')
})

test('a boot repair holds the machine-wide lock and gives it back', async (t) => {
  const { installDir, dataDir } = environment(t, '0.4.0')
  // A healthy tree with one retirement old enough for the boot pass to reclaim.
  // The pass only runs at all when there is litter or a damaged manifest.
  mkdirSync(join(installDir, 'lib'), { recursive: true })
  writeFileSync(join(installDir, 'lib', 'bin.js'), '// launcher')
  const leftover = join(installDir, 'node_modules', '.foo-12345678')
  mkdirSync(leftover, { recursive: true })
  const at = Date.now() - 2 * RETIRED_MIN_AGE_MS
  utimesSync(leftover, new Date(at), new Date(at))
  utimesSync(join(installDir, 'node_modules'), new Date(at), new Date(at))

  const lockPath = join(dataDir, 'update.lock')
  const ctx = fakeCtx()
  apply(ctx, { dataDir, lockPath })
  t.after(() => { for (const dispose of ctx.effects) dispose?.() })

  assert.equal(existsSync(leftover), false, 'the boot pass still reclaims old litter')
  // The pass takes the machine-wide lock now, which is what makes it safe against
  // a second host. Failing to hand it back would refuse every later install for
  // the lock's whole staleness window — an hour of "another host holds the lock".
  assert.equal(existsSync(lockPath), false, 'the boot repair released the machine-wide lock')
})

test('a snapshot delete unlinks that version, leaves the tree alone, and writes no history', async (t) => {
  const { installDir, dataDir } = environment(t)
  const snapshotsDir = join(dataDir, 'snapshots')
  assert.deepEqual(await createSnapshotAsync({ installDir, snapshotsDir, version: '0.4.0', now: () => 1000 }), { ok: true })

  const ctx = fakeCtx()
  apply(ctx, { dataDir, lockPath: join(dataDir, 'update.lock') })
  const res = await invoke(ctx.registered, VERSION_API.snapshotDelete, { method: 'POST', body: { version: '0.4.0' } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(existsSync(join(snapshotsDir, '0.4.0')), false, 'that snapshot is gone from disk')
  assert.deepEqual(res.body.result.snapshots, [], 'and it is gone from the list the route returned')
  // The live tree is not what this operation touches, so it must survive
  // byte-for-byte: a deleted backup that also cost the installation is worse
  // than no delete at all.
  assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '0.4.0')
  // A discarded backup is not a transition of the installed version. The audit
  // trail answers "what was this machine running, and when"; writing a record per
  // deletion would read as a restore that never happened.
  const historyPath = join(dataDir, 'history.json')
  const entries = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf8')) : []
  assert.deepEqual(entries, [])

  // The same delete again is a conflict, not a silent success: the caller asked
  // for something that is no longer there to remove.
  const again = await invoke(ctx.registered, VERSION_API.snapshotDelete, { method: 'POST', body: { version: '0.4.0' } })
  assert.equal(again.status, 409)
  assert.match(String(again.body.error), /no snapshot of 0\.4\.0/)
})

test('the panel sees a trail another host rewrote without changing its size', async (t) => {
  const { dataDir } = environment(t)
  const historyPath = join(dataDir, 'history.json')
  // appendHistory's own wire format, so a second entry of the same width is the
  // same number of bytes: the trail is capped and rewritten whole, which is
  // exactly how a size-only cache key goes stale.
  const entry = to => `${JSON.stringify([{ at: 1, to, result: 'ok' }], null, 1)}\n`
  writeFileSync(historyPath, entry('0.3.0'), 'utf8')
  const ctx = fakeCtx()
  apply(ctx, { dataDir })

  const first = await invoke(ctx.registered, VERSION_API.status)
  assert.deepEqual(first.body.result.recent.map(item => item.to), ['0.3.0'])

  writeFileSync(historyPath, entry('0.3.1'), 'utf8')
  assert.equal(readFileSync(historyPath, 'utf8').length, entry('0.3.0').length, 'the rewrite preserved the size')
  // A filesystem that resolves writes coarsely could report the same mtime for
  // both; setting it explicitly is what makes this a test of the key rather than
  // of how fast this machine happens to be.
  utimesSync(historyPath, new Date(2000), new Date(2000))

  const second = await invoke(ctx.registered, VERSION_API.status)
  assert.deepEqual(second.body.result.recent.map(item => item.to), ['0.3.1'], 'the moved stamp was enough to re-read')
})

test('a restore yields to another host that holds the machine-wide lock', async (t) => {
  const { installDir, dataDir } = environment(t)
  const snapshotsDir = join(dataDir, 'snapshots')
  assert.deepEqual(await createSnapshotAsync({ installDir, snapshotsDir, version: '0.4.0', now: () => 1 }), { ok: true })
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.9.0' }))

  // A live process that is NOT this one: the staleness rules must honor it, so
  // the composition has to refuse to swap the tree underneath it.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  t.after(() => { other.kill() })
  const lockPath = join(dataDir, 'update.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: other.pid, at: Date.now(), token: 'foreign' }), 'utf8')

  const ctx = fakeCtx()
  apply(ctx, { dataDir, lockPath })
  const res = await invoke(ctx.registered, VERSION_API.restore, { method: 'POST', body: { version: '0.4.0' } })
  assert.equal(res.status, 409)
  assert.match(res.body.error, /another host holds the machine-wide update lock/)
  assert.doesNotMatch(res.body.error, /this host's own/, 'a foreign holder must not be reported as our own')
  assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '0.9.0', 'the other host\'s tree is untouched')
  // The refusal left the foreign lock exactly where it was.
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'foreign')
})

test('a restore refused by this host\'s own lock does not blame another host', async (t) => {
  const { installDir, dataDir } = environment(t)
  const snapshotsDir = join(dataDir, 'snapshots')
  await seedSnapshot(snapshotsDir, '0.3.0')
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.9.0' }))

  // The lock is held by OUR OWN pid — the state a hard-ceiling kill leaves
  // behind. The task is already terminal by then, so the route's "an install is
  // running" guard no longer fires and the machine-wide lock is the only thing
  // still saying no. Telling the user another host holds it sends them hunting
  // for a process that does not exist.
  const lockPath = join(dataDir, 'update.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'ours' }), 'utf8')

  const ctx = fakeCtx()
  apply(ctx, { dataDir, lockPath })
  t.after(() => { for (const dispose of ctx.effects) dispose?.() })
  const res = await invoke(ctx.registered, VERSION_API.restore, { method: 'POST', body: { version: '0.3.0' } })
  assert.equal(res.status, 409)
  assert.match(res.body.error, /this host's own previous install still holds the machine-wide update lock/)
  assert.doesNotMatch(res.body.error, /another host/, 'our own lock is not another host\'s')
  assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '0.9.0', 'the live tree is untouched')
})

test('a restore keeps the version it replaces, so the rollback can itself be rolled back', async (t) => {
  const { installDir, dataDir } = environment(t)
  const snapshotsDir = join(dataDir, 'snapshots')
  assert.deepEqual(await createSnapshotAsync({ installDir, snapshotsDir, version: '0.4.0', now: () => 1000 }), { ok: true })
  // An install moved the live tree forward and snapshotted only what it
  // REPLACED, so 0.9.0 — the version now on disk — has no rollback point.
  // Restoring 0.4.0 from here used to be one-way.
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.9.0' }))

  const ctx = fakeCtx()
  apply(ctx, { dataDir, lockPath: join(dataDir, 'update.lock') })
  t.after(() => { for (const dispose of ctx.effects) dispose?.() })
  const res = await invoke(ctx.registered, VERSION_API.restore, { method: 'POST', body: { version: '0.4.0' } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '0.4.0')

  const listed = await invoke(ctx.registered, VERSION_API.snapshots)
  assert.deepEqual(
    listed.body.result.snapshots.map(entry => entry.version).sort(),
    ['0.4.0', '0.9.0'],
    'the version left behind is restorable now',
  )
  // The composition's own restore is the only path that adopts: the automatic
  // repairs must not enshrine a tree they are about to overwrite as broken.
  const back = await invoke(ctx.registered, VERSION_API.restore, { method: 'POST', body: { version: '0.9.0' } })
  assert.equal(back.status, 200, JSON.stringify(back.body))
  assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '0.9.0')
})

/**
 * Composition tests: what apply() mounts, what it persists, and the local
 * behavior of its routes against a fake host context. The network-facing
 * pieces (registry, npm, GitHub) are exercised in their own module tests.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { VERSION_API, DEFAULT_POLICY } from '../lib/protocol.js'
import { createSnapshotAsync } from '../lib/snapshot.js'
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

test('apply mounts the full core family; notes stay off without a repo slug', (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  apply(ctx, { dataDir })
  const paths = ctx.registered.map(route => route.path).sort()
  assert.deepEqual(paths, [
    VERSION_API.check,
    VERSION_API.policy,
    VERSION_API.restart,
    VERSION_API.restartCancel,
    VERSION_API.restore,
    VERSION_API.snapshotDelete,
    VERSION_API.snapshots,
    VERSION_API.status,
    VERSION_API.update,
  ].sort(), 'the family is exactly these routes; /notes stays absent without a repo slug')
  assert.equal(new Set(paths).size, paths.length, 'the web server keys routes by path: no family may mount one twice')
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
})

test('a panel check feeds the scheduler, so the auto decision runs without any daily timer', async (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  apply(ctx, { dataDir })
  // notify: the decision records its finding but never installs — the wiring
  // is proven without letting the composition spawn a real npm install.
  await invoke(ctx.registered, VERSION_API.policy, { method: 'POST', body: { mode: 'notify' } })
  const savedFetch = globalThis.fetch
  globalThis.fetch = /** @type {any} */ (async () => ({
    ok: true,
    json: async () => ({ 'dist-tags': { latest: '9.9.9' }, versions: { '9.9.9': {}, '0.4.0': {} } }),
  }))
  try {
    const res = await invoke(ctx.registered, VERSION_API.check)
    assert.equal(res.status, 200)
    assert.equal(res.body.result.lastCheck.updateAvailable, true, 'the panel check reached the scheduler')
    assert.equal(res.body.result.lastCheck.target, '9.9.9')
  } finally {
    globalThis.fetch = savedFetch
  }
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
  assert.match(res.body.error, /machine-wide update lock/)
  assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '0.9.0', 'the other host\'s tree is untouched')
  // The refusal left the foreign lock exactly where it was.
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'foreign')
})

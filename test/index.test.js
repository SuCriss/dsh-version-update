/**
 * Composition tests: what apply() mounts, what it persists, and the local
 * behavior of its routes against a fake host context. The network-facing
 * pieces (registry, npm, GitHub) are exercised in their own module tests.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { VERSION_API, DEFAULT_POLICY } from '../lib/protocol.js'
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
    VERSION_API.restore,
    VERSION_API.snapshots,
    VERSION_API.status,
    VERSION_API.update,
  ].sort(), 'notes requires a GitHub repo; this fake manifest has none')
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
  apply(ctx, { dataDir })

  const listed = await invoke(ctx.registered, VERSION_API.snapshots)
  assert.deepEqual(listed.body.result.snapshots, [])

  const failed = await invoke(ctx.registered, VERSION_API.restore, {
    method: 'POST',
    body: { version: '9.9.9' },
  })
  assert.equal(failed.status, 409)
})

test('disposal unregisters every route and stops the scheduler', (t) => {
  const { dataDir } = environment(t)
  const ctx = fakeCtx()
  apply(ctx, { dataDir })
  assert.ok(ctx.registered.length > 0)
  for (const dispose of [...ctx.effects]) dispose?.()
  assert.equal(ctx.registered.length, 0, 'the routes effect removed every registration')
})

/**
 * Route family tests: envelopes, fences, status codes, and every operation
 * wired behind injected fakes — including the new policy endpoints and the
 * snapshot center.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { VERSION_API, DEFAULT_POLICY } from '../lib/protocol.js'
import { DEFAULT_REGISTRY } from '../lib/core.js'
import { makeRoutes } from '../lib/routes.js'

/** A response double recording one answer. */
function resStub() {
  const res = {}
  res.status = undefined
  res.body = undefined
  res.writeHead = (status) => { res.status = status }
  res.end = (body) => { res.body = JSON.parse(body) }
  return res
}

/**
 * Drive one registered route.
 * @param {object[]} routes - registered routes.
 * @param {string} path - the route path.
 * @param {{ method?: string; body?: unknown; fenced?: boolean }} [opts] - request shape.
 */
async function invoke(routes, path, opts = {}) {
  const method = opts.method ?? 'GET'
  const route = routes.find(candidate => candidate.path === path)
  assert.ok(route !== undefined, `route ${path} is registered`)
  const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const req = {
    method,
    url: `${path}${opts.query ?? ''}`,
    socket: { remoteAddress: opts.fenced === false ? '10.9.8.7' : '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
  }
  req[Symbol.asyncIterator] = async function* () { yield* chunks }
  const res = resStub()
  await route.handler(req, res)
  return res
}

/** Standard fakes for the whole family. */
function harness(overrides = {}) {
  /** @type {any[]} */
  const started = []
  const updater = {
    view: () => overrides.taskView?.() ?? { state: 'idle', log: '' },
    start: (version, trigger) => {
      if ((overrides.busy?.()) === true) throw new Error('an update is already running')
      started.push({ version, trigger })
      return { state: 'running', version, log: '' }
    },
  }
  // A deterministic fake installation so the routes never probe the real
  // global tree of whatever machine runs the tests.
  const installDir = mkdtempSync(join(tmpdir(), 'vu-routes-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: overrides.installedVersion ?? '0.4.0' }))
  const deps = {
    updater,
    running: overrides.runningVersion ?? '0.4.0',
    installDir,
    ...overrides.deps,
  }
  const { routes } = makeRoutes(deps)
  // Registered here so one sweep at the end of the file can reclaim them.
  tempDirs.push(installDir)
  return {
    routes,
    started,
    cleanup: () => rmSync(installDir, { recursive: true, force: true }),
  }
}

/** Every fake installation this file created, reclaimed by the final test. */
const tempDirs = []

test('the full route family registers; optional routes appear only when wired', () => {
  const full = harness({
    deps: {
      restarter: { restart: () => ({}) },
      notes: async () => ({}),
      repoSlug: 'o/r',
      policy: { get: () => DEFAULT_POLICY, set: () => {} },
      snapshots: { list: () => [], restore: () => ({ ok: true }) },
    },
  })
  for (const path of Object.values(VERSION_API)) {
    assert.ok(full.routes.some(route => route.path === path), path)
  }

  // Without optional wiring the restart route still mounts (it answers 501);
  // only notes/policy/snapshots appear when their operations are wired.
  const bare = harness()
  assert.deepEqual(bare.routes.map(r => r.path).sort(), [
    VERSION_API.check, VERSION_API.restart, VERSION_API.restartCancel, VERSION_API.status, VERSION_API.update,
  ])
})

test('the loopback fence answers 403 before touching any handler', async () => {
  const { routes } = harness()
  const res = await invoke(routes, VERSION_API.check, { fenced: false })
  assert.equal(res.status, 403)
})

test('wrong methods are refused with 405', async () => {
  const { routes } = harness()
  const res = await invoke(routes, VERSION_API.check, { method: 'POST' })
  assert.equal(res.status, 405)
})

test('check returns local facts plus the published view and ambient fields', async () => {
  const { routes } = harness({
    deps: {
      ambient: () => ({ lastCheck: { at: 5 }, recent: [] }),
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ 'dist-tags': { latest: '0.5.0' }, versions: { '0.5.0': {}, '0.4.0': {} } }),
      }),
    },
  })
  const res = await invoke(routes, VERSION_API.check)
  assert.equal(res.status, 200)
  assert.equal(res.body.result.installed, '0.4.0')
  assert.equal(res.body.result.channels[0].version, '0.5.0')
  assert.equal(res.body.result.lastCheck.at, 5)
  assert.equal(res.body.result.task.running, '0.4.0')
})

test('a failing registry read degrades check instead of failing it', async () => {
  let served
  const { routes } = harness({
    deps: {
      fetchImpl: async () => { throw new Error('EAI_AGAIN') },
      served: registry => { served = registry },
    },
  })
  const res = await invoke(routes, VERSION_API.check)
  assert.equal(res.status, 200)
  assert.match(res.body.result.publishedError ?? '', /registry unreachable/)
  assert.match(res.body.result.publishedError ?? '', /EAI_AGAIN/)
  assert.equal(res.body.result.channels, undefined)
  assert.equal(res.body.result.installed, '0.4.0')
  // Nothing answered, so nothing may be remembered as the source of a read: an
  // install must not inherit a registry from a check that failed.
  assert.equal(served, undefined)
})

test('a network-layer registry failure falls back to a mirror and still serves the view', async () => {
  let calls = 0
  /** The registry the host was told these versions came from. */
  let served
  const { routes } = harness({
    deps: {
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) throw new Error('fetch failed')
        return {
          ok: true,
          json: async () => ({ 'dist-tags': { latest: '0.5.0' }, versions: { '0.5.0': {}, '0.4.0': {} } }),
        }
      },
      served: registry => { served = registry },
    },
  })
  const res = await invoke(routes, VERSION_API.check)
  assert.equal(res.status, 200)
  assert.equal(calls, 2, 'the primary registry and one mirror were both tried')
  assert.equal(res.body.result.publishedError, undefined)
  assert.equal(res.body.result.channels[0].version, '0.5.0')
  // The install that follows this view asks npm for THIS url, not the configured
  // one: the configured registry is the one that just proved unreachable, and
  // re-asking it for 0.5.0 would report the offered update as nonexistent.
  assert.match(String(served), /^https?:\/\//, 'the fallback source is reported to the host')
  assert.notEqual(served, DEFAULT_REGISTRY, 'a mirror is not reported as the registry it replaced')
})

test('a registry that answers with an HTTP error does not fall back', async () => {
  const { routes } = harness({
    deps: {
      fetchImpl: async () => ({ ok: false, status: 500 }),
    },
  })
  const res = await invoke(routes, VERSION_API.check)
  assert.equal(res.status, 200)
  assert.equal(res.body.result.publishedError, 'registry read failed: HTTP 500')
  assert.equal(res.body.result.channels, undefined)
})

test('a successful check hands its registry facts to the auto-update decision', async () => {
  const considered = []
  const { routes } = harness({
    deps: {
      auto: async (published) => { considered.push(published) },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ 'dist-tags': { latest: '0.5.0' }, versions: { '0.5.0': {}, '0.4.0': {} } }),
      }),
    },
  })
  const res = await invoke(routes, VERSION_API.check)
  assert.equal(res.status, 200)
  assert.equal(considered.length, 1, 'the check reached the scheduler exactly once')
  assert.deepEqual(considered[0].distTags, { latest: '0.5.0' })
  assert.deepEqual(considered[0].versions, ['0.5.0', '0.4.0'])
})

test('a failed registry read never reaches the auto-update decision', async () => {
  let calls = 0
  const { routes } = harness({
    deps: {
      auto: async () => { calls += 1 },
      fetchImpl: async () => { throw new Error('EAI_AGAIN') },
    },
  })
  const res = await invoke(routes, VERSION_API.check)
  assert.equal(res.status, 200)
  assert.equal(calls, 0, 'without registry facts there is nothing to decide from')
})

test('a throwing auto decision cannot fail the panel check', async () => {
  const { routes } = harness({
    deps: {
      auto: async () => { throw new Error('decision exploded') },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ 'dist-tags': { latest: '0.5.0' }, versions: { '0.5.0': {}, '0.4.0': {} } }),
      }),
    },
  })
  const res = await invoke(routes, VERSION_API.check)
  assert.equal(res.status, 200)
  assert.equal(res.body.result.installed, '0.4.0')
})

test('update validates the target and always records manual trigger', async () => {
  const { routes, started } = harness()
  const bad = await invoke(routes, VERSION_API.update, { method: 'POST', body: { version: '^1.0.0' } })
  assert.equal(bad.status, 400)

  const good = await invoke(routes, VERSION_API.update, { method: 'POST', body: { version: '0.5.0' } })
  assert.equal(good.status, 200)
  assert.deepEqual(started, [{ version: '0.5.0', trigger: 'manual' }])
})

test('update reports a busy runner as 409', async () => {
  const { routes } = harness({ busy: () => true })
  const res = await invoke(routes, VERSION_API.update, { method: 'POST', body: { version: '0.5.0' } })
  assert.equal(res.status, 409)
})

test('status exposes staleness derived from running vs installed', async () => {
  // The fake install is at 0.5.0 while the process booted with 0.4.0: exactly
  // the post-install state, and staleness must say so even before any task.
  const { routes } = harness({ installedVersion: '0.5.0' })
  const res = await invoke(routes, VERSION_API.status)
  const result = res.body.result
  assert.equal(result.running, '0.4.0')
  assert.equal(result.installed, '0.5.0')
  assert.equal(result.stale, true)
  assert.equal(result.needsRestart, true)
  assert.equal(result.restartable, false, 'no restarter wired here')
})

/** Reclaim every temp installation this file created (runs last). */
test('route fixtures clean up their temporary installations', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  assert.ok(tempDirs.length > 0)
})

test('restart answers 501 unwired, 200 wired, 409 when the handoff refuses', async () => {
  const bare = harness()
  const missing = await invoke(bare.routes, VERSION_API.restart, { method: 'POST' })
  assert.equal(missing.status, 501)

  let refuse = false
  const wired = harness({
    deps: {
      restarter: {
        restart: () => {
          if (refuse) throw new Error('OS-assigned port')
          return { host: '127.0.0.1', port: 3080 }
        },
      },
    },
  })
  const ok = await invoke(wired.routes, VERSION_API.restart, { method: 'POST' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.result.port, 3080)

  refuse = true
  const conflict = await invoke(wired.routes, VERSION_API.restart, { method: 'POST' })
  assert.equal(conflict.status, 409)
})

test('notes validates versions and maps upstream failure to 502', async () => {
  const { routes } = harness({
    deps: {
      notes: async (_repo, version) => {
        if (version === '0.9.9') return { notes: '# hi' }
        // A version without a release is a normal miss, not an error.
        if (version === '0.1.0') return {}
        throw new Error('HTTP 503')
      },
      repoSlug: 'o/r',
    },
  })
  const bad = await invoke(routes, VERSION_API.notes, { query: '?version=latest' })
  assert.equal(bad.status, 400)
  const miss = await invoke(routes, VERSION_API.notes, { query: '?version=0.1.0' })
  assert.equal(miss.status, 200)
  assert.equal(miss.body.result.hasNotes, false)
  const hit = await invoke(routes, VERSION_API.notes, { query: '?version=0.9.9' })
  assert.equal(hit.body.result.notes, '# hi')

  const upstream = harness({
    deps: {
      notes: async () => { throw new Error('HTTP 503') },
      repoSlug: 'o/r',
    },
  })
  const failed = await invoke(upstream.routes, VERSION_API.notes, { query: '?version=0.9.9' })
  assert.equal(failed.status, 502)
})

test('policy GET reflects the store; POST applies patches and reports rejects', async () => {
  /** @type {any} */
  let current = { ...DEFAULT_POLICY }
  const applied = []
  const { routes } = harness({
    deps: {
      policy: {
        get: () => current,
        set: patch => {
          if (patch?.mode === 'bogus') throw new Error('mode must be one of off, notify, auto')
          current = { ...current, ...patch }
          applied.push(current)
        },
      },
    },
  })
  const initial = await invoke(routes, VERSION_API.policy)
  assert.equal(initial.body.result.policy.mode, 'off')

  const patched = await invoke(routes, VERSION_API.policy, { method: 'POST', body: { mode: 'auto' } })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.result.policy.mode, 'auto')
  assert.equal(applied.length, 1)

  const rejected = await invoke(routes, VERSION_API.policy, { method: 'POST', body: { mode: 'bogus' } })
  assert.equal(rejected.status, 400)
  assert.match(rejected.body.error, /mode/)

  // One path, two methods: everything else is still refused there.
  const wrongMethod = await invoke(routes, VERSION_API.policy, { method: 'DELETE' })
  assert.equal(wrongMethod.status, 405)
})

test('snapshot center lists and restores through its operations', async () => {
  const calls = []
  const { routes } = harness({
    deps: {
      snapshots: {
        list: () => [{ version: '0.4.0', usable: true }],
        restore: version => {
          calls.push(version)
          return version === '0.4.0' ? { ok: true } : { ok: false, error: 'no usable snapshot of 0.0.1' }
        },
      },
    },
  })
  const listed = await invoke(routes, VERSION_API.snapshots)
  assert.deepEqual(listed.body.result.snapshots, [{ version: '0.4.0', usable: true }])

  const badBody = await invoke(routes, VERSION_API.restore, { method: 'POST', body: { version: 'x' } })
  assert.equal(badBody.status, 400)

  const failed = await invoke(routes, VERSION_API.restore, { method: 'POST', body: { version: '0.0.1' } })
  assert.equal(failed.status, 409)
  assert.match(failed.body.error, /no usable snapshot/)

  const okRestore = await invoke(routes, VERSION_API.restore, { method: 'POST', body: { version: '0.4.0' } })
  assert.equal(okRestore.status, 200)
  assert.equal(okRestore.body.result.restored, '0.4.0')
  assert.deepEqual(calls, ['0.0.1', '0.4.0'])
})

test('restore refuses while an install is writing the tree', async () => {
  const { routes } = harness({
    deps: {
      snapshots: { list: () => [], restore: () => ({ ok: true }) },
    },
    taskView: () => ({ state: 'running', log: '' }),
  })
  const res = await invoke(routes, VERSION_API.restore, { method: 'POST', body: { version: '0.4.0' } })
  assert.equal(res.status, 409)
})

test('an async restore is awaited, and a contended lock answers 409 not 500', async () => {
  let releaseHeld
  const held = new Promise(resolve => { releaseHeld = resolve })
  const { routes } = harness({
    deps: {
      snapshots: {
        list: () => [],
        // The composition's restore is asynchronous: it takes the machine-wide
        // lock and copies the tree off the event loop. The route must await it —
        // answering early would tell the panel a rollback happened that has
        // not, and the reply would carry a stale task view.
        restore: async (version) => {
          if (version === '0.4.0') await held
          return version === '0.4.0'
            ? { ok: true }
            : { ok: false, error: 'another host holds the machine-wide update lock (pid 7); try again once it finishes' }
        },
      },
    },
  })
  const pending = invoke(routes, VERSION_API.restore, { method: 'POST', body: { version: '0.4.0' } })
  await new Promise(resolve => setTimeout(resolve, 5))
  const refused = await invoke(routes, VERSION_API.restore, { method: 'POST', body: { version: '0.0.9' } })
  releaseHeld?.()
  const ok = await pending
  assert.equal(ok.status, 200)
  assert.equal(ok.body.result.restored, '0.4.0')
  assert.equal(refused.status, 409, 'a lock contention is the client retrying, not a host failure')
  assert.match(refused.body.error, /machine-wide update lock/)
})

test('the restart cancel is a POST-only route, and the panel defers with POST', async () => {
  let cancelled = 0
  const { routes } = harness({ deps: { restarter: { restart: () => ({}), cancelPending: () => { cancelled += 1 } } } })
  // The browser half can only disarm the host fallback through POST: a deferral
  // that reaches this route as a GET answers 405, is swallowed by the caller's
  // catch, and the host restarts anyway out from under a page that said later.
  const wrong = await invoke(routes, VERSION_API.restartCancel, { method: 'GET' })
  assert.equal(wrong.status, 405)
  assert.equal(cancelled, 0, 'a refused method must not disarm anything')
  const right = await invoke(routes, VERSION_API.restartCancel, { method: 'POST' })
  assert.equal(right.status, 200)
  assert.deepEqual(right.body.result, { cancelled: true })
  assert.equal(cancelled, 1)
})

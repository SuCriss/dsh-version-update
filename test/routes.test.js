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
  const { routes } = harness({
    deps: {
      fetchImpl: async () => { throw new Error('EAI_AGAIN') },
    },
  })
  const res = await invoke(routes, VERSION_API.check)
  assert.equal(res.status, 200)
  assert.equal(res.body.result.publishedError, 'EAI_AGAIN')
  assert.equal(res.body.result.channels, undefined)
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

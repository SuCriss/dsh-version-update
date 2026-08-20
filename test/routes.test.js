/**
 * Route tests over a real HTTP server: the fence, the method guard, the
 * staleness facts the panel decides on, the exact-version guard, and the
 * restart route's behaviour with and without a restarter.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { makeRoutes } from '../lib/routes.js'

/**
 * Serve one route family on a loopback port for the duration of a test body.
 * @param {object} deps - makeRoutes deps.
 * @param {(base: string) => Promise<void>} body - the test body.
 * @returns {Promise<void>} resolves once the server is closed.
 */
async function serving(deps, body) {
  const { routes } = makeRoutes(deps)
  const table = new Map(routes.map(route => [route.path, route.handler]))
  const server = createServer((req, res) => {
    const handler = table.get(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (handler === undefined) {
      res.writeHead(404).end()
      return
    }
    void handler(req, res)
  })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address()
  try {
    await body(`http://127.0.0.1:${String(port)}`)
  } finally {
    await new Promise(resolve => { server.close(resolve) })
  }
}

/**
 * Issue one request and read its JSON body.
 * @param {string} url - the absolute URL.
 * @param {object} [init] - fetch init.
 * @returns {Promise<{ status: number; body: any }>} status and parsed body.
 */
async function call(url, init) {
  const response = await fetch(url, init)
  return { status: response.status, body: await response.json() }
}

/** An updater stand-in recording the versions it was asked to install. */
function fakeUpdater(overrides = {}) {
  const started = []
  return {
    started,
    view: () => ({ state: 'idle', log: '', ...overrides.view }),
    start: (version) => {
      if (overrides.startThrows !== undefined) throw new Error(overrides.startThrows)
      started.push(version)
      return { state: 'running', version, log: '' }
    },
  }
}

const PATHS = {
  check: '/api/dsh-version-update/check',
  update: '/api/dsh-version-update/update',
  status: '/api/dsh-version-update/status',
  restart: '/api/dsh-version-update/restart',
}

test('the four routes are exact-path routes', () => {
  const { routes } = makeRoutes({ updater: fakeUpdater() })
  assert.deepEqual(routes.map(route => route.path).sort(), Object.values(PATHS).sort())
  assert.ok(routes.every(route => route.kind === 'exact'))
})

test('every route refuses a request the fence rejects', async () => {
  await serving({ updater: fakeUpdater(), fence: () => false }, async (base) => {
    for (const [name, path] of Object.entries(PATHS)) {
      const get = await call(base + path)
      assert.equal(get.status, 403, name)
      assert.match(get.body.error, /loopback-only/)
      const post = await call(base + path, { method: 'POST' })
      assert.equal(post.status, 403, `${name} (POST)`)
    }
  })
})

test('each route accepts only its own method', async () => {
  await serving({ updater: fakeUpdater(), fence: () => true }, async (base) => {
    const postToGet = await call(base + PATHS.status, { method: 'POST' })
    assert.equal(postToGet.status, 405)
    const getToPost = await call(base + PATHS.update)
    assert.equal(getToPost.status, 405)
    const getRestart = await call(base + PATHS.restart)
    assert.equal(getRestart.status, 405, 'a navigation must not be able to restart the host')
  })
})

test('check reports the installed version, channels, and the task view', async () => {
  await serving({
    updater: fakeUpdater(),
    fence: () => true,
    running: '0.1.0-rc.7',
    installDir: process.cwd(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        'dist-tags': { latest: '9.9.9' },
        versions: { '9.9.9': {}, '0.0.1': {} },
      }),
    }),
  }, async (base) => {
    const { status, body } = await call(base + PATHS.check)
    assert.equal(status, 200)
    // installDir points at this package, so the installed version is its own.
    assert.equal(typeof body.result.installed, 'string')
    assert.deepEqual(body.result.channels, [{ channel: 'latest', version: '9.9.9', ahead: true }])
    assert.deepEqual(body.result.versions, ['9.9.9', '0.0.1'])
    assert.equal(body.result.installDir, process.cwd())
    assert.equal(body.result.task.running, '0.1.0-rc.7')
    assert.equal(body.result.task.restartable, false)
  })
})

test('check reports a failed registry read as a server error', async () => {
  await serving({
    updater: fakeUpdater(),
    fence: () => true,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  }, async (base) => {
    const { status, body } = await call(base + PATHS.check)
    assert.equal(status, 500)
    assert.match(body.error, /HTTP 503/)
  })
})

test('status carries the staleness facts the panel decides on', async () => {
  // running !== installed is exactly the window where the open page holds
  // assets the new tree no longer has, so a reload is not enough.
  await serving({
    updater: fakeUpdater(),
    fence: () => true,
    running: '0.1.0-rc.7',
    installDir: process.cwd(),
  }, async (base) => {
    const { body } = await call(base + PATHS.status)
    assert.equal(body.result.running, '0.1.0-rc.7')
    assert.equal(typeof body.result.installed, 'string', 'the watchdog needs the version to name')
    assert.equal(body.result.stale, body.result.running !== body.result.installed)
  })
})

test('status reports no staleness when the running version is unknown', async () => {
  await serving({ updater: fakeUpdater(), fence: () => true, installDir: process.cwd() }, async (base) => {
    const { body } = await call(base + PATHS.status)
    assert.equal('running' in body.result, false)
    assert.equal(body.result.stale, false, 'an unknown running version must not force a restart prompt')
  })
})

test('update starts an install for one exact version', async () => {
  const updater = fakeUpdater()
  await serving({ updater, fence: () => true, installDir: process.cwd() }, async (base) => {
    const { status, body } = await call(base + PATHS.update, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.1.0-rc.8' }),
    })
    assert.equal(status, 200)
    assert.equal(body.result.state, 'idle', 'the view is re-read after the start')
    assert.deepEqual(updater.started, ['0.1.0-rc.8'])
  })
})

test('update rejects ranges, tags, and injection attempts without spawning', async () => {
  const updater = fakeUpdater()
  await serving({ updater, fence: () => true }, async (base) => {
    for (const version of ['latest', '^0.1.0', '0.1.x', '0.1.0 && calc', '../evil', 42, null]) {
      const { status, body } = await call(base + PATHS.update, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version }),
      })
      assert.equal(status, 400, JSON.stringify(version))
      assert.match(body.error, /one exact published version/)
    }
    const missing = await call(base + PATHS.update, { method: 'POST' })
    assert.equal(missing.status, 400, 'an empty body')
    assert.deepEqual(updater.started, [])
  })
})

test('update reports a refused concurrent install as a conflict', async () => {
  await serving({
    updater: fakeUpdater({ startThrows: 'an update is already running' }),
    fence: () => true,
  }, async (base) => {
    const { status, body } = await call(base + PATHS.update, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.1.0' }),
    })
    assert.equal(status, 409)
    assert.match(body.error, /already running/)
  })
})

test('update rejects an oversized body', async () => {
  await serving({ updater: fakeUpdater(), fence: () => true }, async (base) => {
    const { status, body } = await call(base + PATHS.update, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.1.0', pad: 'x'.repeat(8192) }),
    })
    assert.equal(status, 500)
    assert.match(body.error, /body too large/)
  })
})

test('restart is unavailable when the composition has no restarter', async () => {
  await serving({ updater: fakeUpdater(), fence: () => true }, async (base) => {
    const { status, body } = await call(base + PATHS.restart, { method: 'POST' })
    assert.equal(status, 501)
    assert.match(body.error, /not available in this composition/)
    const status2 = await call(base + PATHS.status)
    assert.equal(status2.body.result.restartable, false)
  })
})

test('restart hands back where the replacement will answer', async () => {
  let restarts = 0
  await serving({
    updater: fakeUpdater(),
    fence: () => true,
    installDir: process.cwd(),
    restarter: {
      restart: () => {
        restarts += 1
        return { host: '127.0.0.1', port: 5173, pid: 1, launcher: '/opt/dsh/lib/bin.js', logPath: '/tmp/x.log' }
      },
    },
  }, async (base) => {
    const { status, body } = await call(base + PATHS.restart, { method: 'POST' })
    assert.equal(status, 200)
    assert.equal(body.result.port, 5173)
    assert.equal(restarts, 1)
    const view = await call(base + PATHS.status)
    assert.equal(view.body.result.restartable, true)
  })
})

test('a refused restart is a conflict, not a crash', async () => {
  await serving({
    updater: fakeUpdater(),
    fence: () => true,
    restarter: { restart: () => { throw new Error('restart unavailable: this host listens on an OS-assigned port') } },
  }, async (base) => {
    const { status, body } = await call(base + PATHS.restart, { method: 'POST' })
    assert.equal(status, 409)
    assert.match(body.error, /OS-assigned port/)
  })
})

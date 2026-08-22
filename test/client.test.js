/**
 * Browser-half tests for the panel controller: the update confirmation, the
 * restart decision, the countdown, the reload-surviving watchdog, and the
 * not-mounted diagnosis.
 *
 * `lib/client.js` is a hand-written `window.__ModuleLoader__.load` factory with
 * no build step, so the loader and the handful of browser globals it touches are
 * faked here rather than mocked in a DOM environment. The controller is reached
 * through the module's own `createController` seam, which takes the overlay and
 * the reload as injectable dependencies.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * Load lib/client.js under a fake module loader and browser globals.
 * @returns {Promise<{ createController: Function }>} the module exports.
 */
async function loadClient() {
  let captured
  globalThis.window = {
    __ModuleLoader__: { load: (options) => { captured = options.factory } },
    sessionStorage: fakeStorage(),
    location: { reload: () => {} },
    matchMedia: () => ({ matches: false }),
  }
  // The factory only needs createElement plus the two hooks the components use;
  // no component is rendered in these tests.
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
  }
  await import(`../lib/client.js?t=${String(Date.now())}${String(Math.random())}`)
  assert.equal(typeof captured, 'function', 'the module registered a factory')
  return captured((id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require: ${id}`)
  })
}

/** An in-memory sessionStorage. */
function fakeStorage() {
  const map = new Map()
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
  }
}

/** An overlay stand-in recording every view it was shown. */
function fakeOverlay() {
  const shown = []
  return {
    shown,
    hidden: 0,
    show(view) { shown.push(view) },
    hide() { this.hidden += 1 },
    /** The most recent view. */
    last() { return shown[shown.length - 1] },
    /** Click one action of the most recent view by its label key. */
    click(label) {
      const action = this.last().actions?.find(a => a.label === label)
      assert.ok(action !== undefined, `no action labelled ${label}`)
      action.onClick()
    },
  }
}

/**
 * Install a fetch stub answering per path.
 * @param {Record<string, () => object>} table - path suffix to response factory.
 * @returns {{ calls: object[] }} the recorded calls.
 */
function fakeFetch(table) {
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init })
    const key = Object.keys(table).find(suffix => path.endsWith(suffix))
    if (key === undefined) throw new Error(`unexpected fetch: ${path}`)
    return table[key](calls.length)
  }
  return { calls }
}

/** A JSON response stub. */
function json(body, status = 200) {
  return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body }
}

/** The SPA fallback: 200 with an HTML body for an unknown path. */
function htmlFallback() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    json: async () => { throw new SyntaxError('Unexpected token <') },
  }
}

/** Translate a key to itself so assertions can name keys, not prose. */
const t = key => key

/**
 * Advance mock time one scheduled second at a time, flushing microtasks between
 * steps.
 *
 * Both the countdown and the watchdog re-arm their timer from inside the
 * callback, and Node's mock timers run only the level a tick reaches — so one
 * large tick would fire a single step. Each step is followed by a few microtask
 * turns because the watchdog's callback awaits a fetch before it re-arms.
 * @param {import('node:test').TestContext} ctx - the test context owning the timers.
 * @param {number} seconds - how many one-second steps to run.
 * @returns {Promise<void>} resolves once every step has run.
 */
async function advance(ctx, seconds) {
  for (let step = 0; step < seconds; step += 1) {
    ctx.mock.timers.tick(1000)
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
  }
}

/**
 * Build a controller with fake seams.
 * @param {object} module - the loaded client module.
 * @param {object} [overrides] - extra deps.
 * @returns {{ controller: object; overlay: object; reloads: number[] }} the harness.
 */
function makeController(module, overrides = {}) {
  const overlay = fakeOverlay()
  const reloads = []
  const controller = module.createController({
    t,
    overlay,
    reload: () => { reloads.push(Date.now()) },
    ...overrides,
  })
  return { controller, overlay, reloads }
}

test('an idle host is left alone', async () => {
  const module = await loadClient()
  const { controller, overlay } = makeController(module)
  controller.adoptTask({ state: 'idle', stale: false, needsRestart: false })
  assert.deepEqual(overlay.shown, [])
})

test('a stale host found at page load is offered a restart, never forced', async () => {
  const module = await loadClient()
  const { controller, overlay } = makeController(module)
  controller.adoptTask({
    state: 'idle', stale: true, needsRestart: true, restartable: true,
    installed: '0.2.0', running: '0.1.0',
  })
  const view = overlay.last()
  assert.equal(view.title, 'restart.title')
  assert.deepEqual(view.actions.map(a => a.label), ['restart.later', 'restart.now'])
  assert.equal(view.actions[1].primary, true)
})

test('a finished install prompts even when the versions cannot be compared', async () => {
  // The host reports needsRestart without stale when it cannot read the
  // installed version. Keying off stale alone would leave the page broken.
  const module = await loadClient()
  const { controller, overlay } = makeController(module)
  controller.adoptTask({ state: 'done', version: '0.2.0', stale: false, needsRestart: true, restartable: true })
  assert.equal(overlay.shown.length, 1)
  assert.equal(overlay.last().title, 'restart.title')
})

test('a host that cannot restart itself gets a dismiss-only notice', async () => {
  const module = await loadClient()
  const { controller, overlay } = makeController(module)
  controller.adoptTask({ state: 'done', stale: true, needsRestart: true, restartable: false, installed: '0.2.0' })
  assert.equal(overlay.last().body, 'restart.unavailable')
  assert.deepEqual(overlay.last().actions.map(a => a.label), ['restart.dismiss'])
})

test('an update is never one click away', async () => {
  const module = await loadClient()
  fakeFetch({})
  const { controller } = makeController(module)

  controller.requestUpdate('0.2.0')
  assert.equal(controller.getSnapshot().confirm, '0.2.0')
  assert.equal(controller.getSnapshot().busy, false, 'nothing started yet')

  controller.cancelUpdate()
  assert.equal(controller.getSnapshot().confirm, undefined)
})

test('confirming an update starts exactly that version', async () => {
  const module = await loadClient()
  const { calls } = fakeFetch({
    '/update': () => json({ result: { state: 'running', version: '0.2.0', log: '' } }),
  })
  const { controller } = makeController(module)

  controller.requestUpdate('0.2.0')
  await controller.confirmUpdate()

  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0].init.body), { version: '0.2.0' })
  assert.equal(controller.getSnapshot().confirm, undefined)
  assert.equal(controller.getSnapshot().task.state, 'running')
  controller.dispose()
})

test('the countdown restarts on its own only after the full window', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const module = await loadClient()
  const { calls } = fakeFetch({
    '/restart': () => json({ result: { host: '127.0.0.1', port: 3080 } }),
    '/status': () => json({ result: { state: 'done', needsRestart: true } }),
  })
  const { controller, overlay } = makeController(module)

  controller.armedVersion = '0.2.0'
  controller.adoptTask({ state: 'done', version: '0.2.0', stale: true, needsRestart: true, restartable: true })

  assert.equal(overlay.last().body, 'restart.countdown')
  assert.equal(calls.length, 0, 'nothing happens on the first frame')

  // A user has a real window to object: the countdown must not fire early.
  await advance(ctx, 5)
  assert.equal(calls.length, 0, 'five seconds is not the whole window')
  assert.equal(overlay.last().body, 'restart.countdown', 'the card is still counting')

  await advance(ctx, 20)
  assert.ok(calls.some(c => c.path.endsWith('/restart')), 'the restart was requested')
  controller.dispose()
})

test('cancelling the countdown leaves the host running', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const module = await loadClient()
  const { calls } = fakeFetch({ '/restart': () => json({ result: {} }) })
  const { controller, overlay } = makeController(module)

  controller.armedVersion = '0.2.0'
  controller.adoptTask({ state: 'done', version: '0.2.0', stale: true, needsRestart: true, restartable: true })
  overlay.click('restart.later')

  await advance(ctx, 60)
  assert.deepEqual(calls, [], 'a dismissed countdown never restarts anything')
  assert.ok(overlay.hidden > 0)
  controller.dispose()
})

test('the watchdog resumes across the reload it caused', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const module = await loadClient()
  window.sessionStorage.setItem('dsh-version-update:awaiting-restart', '0.2.0')
  // The replacement is not up for the first two probes.
  const { calls } = fakeFetch({
    '/status': (n) => (n < 3
      ? json({ error: 'down' }, 503)
      : json({ result: { state: 'idle', needsRestart: false } })),
  })
  const { controller, overlay, reloads } = makeController(module)

  controller.resume()
  assert.equal(overlay.last().body, 'restart.waiting')

  await advance(ctx, 4)

  assert.ok(calls.length >= 3)
  assert.deepEqual(reloads.length, 1, 'the page reloads onto the new assets exactly once')
  assert.equal(window.sessionStorage.getItem('dsh-version-update:awaiting-restart'), null, 'the marker is cleared')
  controller.dispose()
})

test('a replacement that never answers ends in an actionable timeout', async (ctx) => {
  // Date is mocked alongside setTimeout because the watchdog's ceiling is a
  // wall-clock deadline, not a probe count.
  ctx.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const module = await loadClient()
  fakeFetch({ '/status': () => { throw new TypeError('Failed to fetch') } })
  const { controller, overlay, reloads } = makeController(module)

  controller.awaitReplacement('0.2.0')
  await advance(ctx, 95)

  assert.equal(overlay.last().body, 'restart.timeout')
  assert.deepEqual(overlay.last().actions.map(a => a.label), ['restart.dismiss', 'restart.reloadNow'])
  assert.equal(reloads.length, 0, 'a reload onto a dead host is never automatic')
  assert.equal(controller.getSnapshot().restarting, false)
  controller.dispose()
})

test('the SPA fallback is diagnosed as an unmounted host, not an HTTP 200', async () => {
  // Adding the plugin takes effect only after dsh restarts. Until then the
  // routes 404 into the SPA fallback, which answers 200 with index.html.
  const module = await loadClient()
  fakeFetch({ '/check': () => htmlFallback() })
  const { controller } = makeController(module)

  await controller.check()
  assert.equal(controller.getSnapshot().status, 'error')
  assert.equal(controller.getSnapshot().error, 'notMounted')
  controller.dispose()
})

test('a genuine host error keeps its own message', async () => {
  const module = await loadClient()
  fakeFetch({ '/check': () => json({ error: 'registry read failed: HTTP 503' }, 500) })
  const { controller } = makeController(module)

  await controller.check()
  assert.equal(controller.getSnapshot().error, 'registry read failed: HTTP 503')
  controller.dispose()
})

test('check adopts the facts and preselects the channel that is ahead', async () => {
  const module = await loadClient()
  fakeFetch({
    '/check': () => json({
      result: {
        installed: '0.1.0',
        installDir: '/opt/dsh',
        channels: [{ channel: 'latest', version: '0.1.0', ahead: false }, { channel: 'next', version: '0.2.0', ahead: true }],
        versions: ['0.2.0', '0.1.0'],
        task: { state: 'idle', log: '' },
      },
    }),
  })
  const { controller } = makeController(module)

  await controller.check()
  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.installed, '0.1.0')
  assert.equal(snapshot.selected, '0.2.0', 'the version worth installing is preselected')
  controller.dispose()
})

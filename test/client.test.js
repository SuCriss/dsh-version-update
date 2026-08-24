/**
 * Browser-half tests for the rewritten panel controller: fact merging, the
 * install → countdown → restart → reload chain, the reload-surviving
 * watchdog, policy editing, and the restore flow.
 *
 * lib/client.js is a hand-written window.__ModuleLoader__ factory with no
 * build step, so the loader and the browser globals it touches are faked
 * here rather than mocked in a DOM environment. The controller is reached
 * through createController, whose overlay and reload are injectable seams.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

/**
 * Load lib/client.js under a fake module loader and browser globals.
 * @returns {Promise<{ createController: Function; compareVersionTexts: Function; isDowngrade: Function; dictionaries: Record<string, Record<string, string>> }>} the module exports.
 */
async function loadClient() {
  let captured
  globalThis.window = {
    __ModuleLoader__: { load: (options) => { captured = options.factory } },
    sessionStorage: fakeStorage(),
    location: { reload: () => {} },
    matchMedia: () => ({ matches: false }),
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: initial => ({ current: initial }),
    useState: initial => [initial, () => {}],
    useEffect: () => {},
  }
  await import(`../lib/client.js?t=${String(Date.now())}${String(Math.random())}`)
  assert.equal(typeof captured, 'function', 'the module registered a factory')
  return captured(id => {
    if (id === 'react') return react
    throw new Error(`unexpected require: ${id}`)
  })
}

/** An in-memory sessionStorage. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
  }
}

/** An overlay stand-in recording every view it was shown. */
function fakeOverlay() {
  const shown = []
  return {
    hidden: 0,
    shown,
    show(view) { shown.push(view) },
    hide() { this.hidden += 1 },
    last() { return shown.at(-1) },
    /** Click one action of the most recent view by its label key. */
    click(label) {
      const action = this.last().actions?.find(a => a.label === label)
      assert.ok(action !== undefined, `no action labelled ${label}`)
      action.onClick()
    },
  }
}

/**
 * Install a fetch stub answering per path suffix.
 * @param {Record<string, (call: number) => object>} table - suffix → response factory.
 */
function fakeFetch(table) {
  const counts = {}
  let phase = table
  const impl = async (path) => {
    const key = Object.keys(phase).find(suffix => path.endsWith(suffix))
    if (key === undefined) throw new Error(`unexpected fetch: ${path}`)
    counts[key] = (counts[key] ?? 0) + 1
    return phase[key](counts[key])
  }
  return {
    /** Swap the answer table mid-test (e.g. once the host "restarted"). */
    setTable(next) { phase = next },
    counts,
    install() {
      globalThis.fetch = impl
      return impl
    },
  }
}

/** A JSON response stub. */
function json(body, status = 200) {
  return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body }
}

/** The SPA fallback: 200 with HTML for an unknown path. */
function htmlFallback() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    json: async () => { throw new SyntaxError('Unexpected token <') },
  }
}

/** Translate a key to itself so assertions name keys, not prose. */
const t = key => key

/**
 * Flush pending promise work. Pure MICROTASKS only: under ctx.mock.timers
 * even setImmediate is mocked, so an immediate-based flush would deadlock.
 * @param {number} turns - how many microtask queues to drain.
 */
async function flush(turns = 12) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

/**
 * Every key the panel asks for must resolve. The host locale runtime looks a
 * key up as ONE whole string (`dict[key]`), so a dictionary nested under
 * `policy` would leave `t('policy.title')` unresolved and the panel would
 * render the raw key. This walks the source's own `t()` calls — literal keys
 * plus the prefixes of interpolated ones — against both dictionaries.
 */
test('both dictionaries are flat and cover every key the panel asks for', async () => {
  const client = await loadClient()
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  const literal = new Set()
  for (const match of source.matchAll(/\b(?:t|orElse)\(\s*(?:t,\s*)?(['`])([A-Za-z0-9_.]+)\1/g)) literal.add(match[2])
  assert.ok(literal.size > 40, 'the scan found the panel\'s t() calls')

  const prefixes = new Set()
  for (const match of source.matchAll(/\b(?:t|orElse)\(\s*(?:t,\s*)?`([A-Za-z0-9_.]*)\$\{/g)) prefixes.add(match[1])

  for (const [locale, dict] of Object.entries(client.dictionaries)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${locale}.${key} is a flat string, not a nested object`)
    }
    for (const key of literal) {
      assert.ok(key in dict, `${locale} is missing the key ${key}`)
    }
    // Every interpolated family resolves for each of its known variants.
    for (const prefix of prefixes) {
      assert.ok(
        Object.keys(dict).some(key => key.startsWith(prefix) && key.length > prefix.length),
        `${locale} has no entry under the interpolated prefix ${prefix}`,
      )
    }
  }

  // The two locales carry the identical key set: a locale switch never blanks
  // a field that the other locale fills.
  assert.deepEqual(
    Object.keys(client.dictionaries.en).sort(),
    Object.keys(client.dictionaries.zh).sort(),
  )
})

test('the browser version ranking mirrors the host grammar', async () => {
  const client = await loadClient()
  // Signs only: the mirror agrees with the host on ORDER, not magnitude.
  assert.ok(client.compareVersionTexts('1.2.3', '1.10.0') < 0)
  assert.ok(client.compareVersionTexts('1.0.0-rc.1', '1.0.0') < 0)
  assert.ok(client.compareVersionTexts('2.0.0', '1.99.99') > 0)
  assert.equal(client.compareVersionTexts('1.2.3', '1.2.3'), 0)
  assert.equal(client.isDowngrade('0.3.9', '0.4.0'), true)
  assert.equal(client.isDowngrade('0.5.0', '0.4.0'), false)
  // Uncomparable values are never a downgrade.
  assert.equal(client.isDowngrade('latest', '0.4.0'), false)
})

test('check merges local facts, registry view, and snapshots', async () => {
  const client = await loadClient()
  fakeFetch({
    '/check': () => json({ result: {
      installed: '0.4.0',
      installDir: '/i',
      channels: [{ channel: 'latest', version: '0.5.0', ahead: true }],
      versions: ['0.5.0', '0.4.0'],
      task: { state: 'idle', log: '' },
      lastCheck: { at: 42, updateAvailable: true, target: '0.5.0' },
      recent: [{ at: 1, to: '0.4.0', result: 'ok' }],
    } }),
    '/snapshots': () => json({ result: { snapshots: [{ version: '0.4.0', usable: true }] } }),
  }).install()
  const controller = client.createController({ t })
  await controller.check()
  const s = controller.getSnapshot()
  assert.equal(s.status, 'ready')
  assert.equal(s.installed, '0.4.0')
  assert.equal(s.selected, '0.5.0', 'the newest ahead channel is preselected')
  assert.deepEqual(s.lastCheck.target, '0.5.0')
  assert.equal(s.history.length, 1)
  assert.equal(s.snapshots[0].version, '0.4.0')
})

test('an HTML fallback is diagnosed as not-mounted instead of HTTP 200', async () => {
  const client = await loadClient()
  fakeFetch({ '/check': () => htmlFallback() }).install()
  const controller = client.createController({ t })
  await controller.check()
  assert.equal(controller.getSnapshot().status, 'error')
  assert.equal(controller.getSnapshot().error, 'notMounted')
})

test('a rejected policy patch surfaces the host reason', async () => {
  const client = await loadClient()
  fakeFetch({
    '/policy': () => json({ error: 'mode must be one of off, notify, auto' }, 400),
  }).install()
  const controller = client.createController({ t })
  await controller.savePolicy({ mode: 'bogus' })
  assert.match(controller.getSnapshot().policyError ?? '', /mode must be/)
})

test('a stale host discovered at page load offers a restart without arming one', async () => {
  const client = await loadClient()
  const overlay = fakeOverlay()
  fakeFetch({
    '/status': () => json({ result: {
      state: 'idle', log: '',
      running: '0.4.0', installed: '0.9.0', stale: true, needsRestart: true,
      restartable: true,
    } }),
    '/policy': () => json({ result: { policy: {} } }),
  }).install()
  const controller = client.createController({ t, overlay })
  controller.resume()
  await flush()
  // The identity translator renders keys, not prose: the OFFER is recognized
  // by its actions — restart available but nothing armed or reloaded.
  const view = overlay.last()
  assert.equal(view.title, t('restart.title'))
  assert.ok(view.actions.some(a => a.label === t('restart.now')))
  // Offered, not forced: "later" leaves the page alone.
  overlay.click(t('restart.later'))
  assert.equal(overlay.hidden, 1)
})

test('the watchdog survives a reload through sessionStorage and reloads when ready', async (ctx) => {
  // Load the module BEFORE mock timers: an in-test dynamic import never
  // settles while the timer mocks own the event loop's clock.
  const client = await loadClient()
  ctx.mock.timers.enable()
  try {
    globalThis.window.sessionStorage = fakeStorage({ 'dsh-version-update:awaiting-restart': '8.8.8' })
    const overlay = fakeOverlay()
    let reloaded = 0
    fakeFetch({
      '/status': () => json({ result: { state: 'idle', log: '', stale: false, needsRestart: false } }),
      '/policy': () => json({ result: { policy: {} } }),
    }).install()
    const controller = client.createController({ t, overlay, reload: () => { reloaded += 1 } })
    controller.resume()
    await flush()
    // The first probe is timer-driven; advance it.
    ctx.mock.timers.tick(1000)
    await flush()
    assert.equal(reloaded, 1, 'the replacement answered, the page reloads itself')
    assert.equal(globalThis.window.sessionStorage.getItem('dsh-version-update:awaiting-restart'), null, 'the await marker cleared')
  } finally {
    ctx.mock.timers.reset()
  }
})

test('install settles into a cancellable countdown; restart reloads when ready', async (ctx) => {
  // Module load first; mock timers take over only the test's clock.
  const client = await loadClient()
  ctx.mock.timers.enable()
  try {
    const overlay = fakeOverlay()
    let reloaded = 0
    let installPhase = 'running'
    let replacementReady = false
    fakeFetch({
      '/update': () => json({ result: { state: 'running', version: '9.9.9', log: '' } }),
      '/status': () => json({ result: replacementReady
        ? { state: 'idle', log: '', stale: false, needsRestart: false }
        : installPhase === 'running'
          ? { state: 'running', version: '9.9.9', log: 'npm ...' }
          : {
            state: 'done', version: '9.9.9', log: '',
            running: '0.4.0', installed: '9.9.9', stale: true, needsRestart: true,
            restartable: true,
          } }),
      '/restart': () => json({ result: {} }),
    }).install()
    const controller = client.createController({ t, overlay, reload: () => { reloaded += 1 } })

    controller.requestUpdate('9.9.9')
    assert.equal(controller.getSnapshot().confirm, '9.9.9')
    await controller.confirmUpdate()
    assert.equal(controller.getSnapshot().busy, true)
    assert.equal(controller.getSnapshot().showLog, true)

    // Poll #1: still installing.
    ctx.mock.timers.tick(1500)
    await flush()
    assert.equal(controller.getSnapshot().task.state, 'running')

    // Poll #2: settled → the page arms its own cancellable countdown.
    installPhase = 'done'
    ctx.mock.timers.tick(1500)
    await flush()
    assert.ok(overlay.shown.length > 0, 'the countdown overlay appeared')
    assert.ok(overlay.last().actions.some(a => a.label === t('restart.later')))

    // "Later" cancels without restarting anything.
    overlay.click(t('restart.later'))
    assert.equal(controller.getSnapshot().restarting, false)

    // The manual path walks the identical watchdog flow to a reload.
    const restarting = controller.restart('9.9.9')
    await flush()
    replacementReady = true
    ctx.mock.timers.tick(1000)
    await flush()
    assert.equal(reloaded, 1)
    assert.equal(
      globalThis.window.sessionStorage.getItem('dsh-version-update:awaiting-restart'),
      null,
    )
    await restarting
  } finally {
    ctx.mock.timers.reset()
  }
})

test('restore confirms, applies, and walks the same restart flow', async (ctx) => {
  // Module load first; mock timers take over only the test's clock.
  const client = await loadClient()
  ctx.mock.timers.enable()
  try {
    const overlay = fakeOverlay()
    let reloaded = 0
    let restoredSettled = false
    fakeFetch({
      '/restore': () => json({ result: {
        restored: '7.7.7',
        task: { state: 'idle', log: '', running: '9.9.9', installed: '7.7.7', stale: true, needsRestart: true, restartable: true },
      } }),
      '/snapshots': () => json({ result: { snapshots: [{ version: '7.7.7', usable: true }] } }),
      '/policy': () => json({ result: { policy: {} } }),
      '/check': () => json({ result: {
        installed: restoredSettled ? '7.7.7' : '9.9.9',
        task: { state: 'idle', log: '', running: '9.9.9', installed: '7.7.7', stale: true, needsRestart: true, restartable: true },
      } }),
      '/restart': () => json({ result: {} }),
      '/status': () => json({ result: { state: 'idle', log: '', stale: false, needsRestart: false } }),
    }).install()
    const controller = client.createController({ t, overlay, reload: () => { reloaded += 1 } })

    // Cancel path first.
    controller.requestRestore('7.7.7')
    assert.equal(controller.getSnapshot().restoreConfirm, '7.7.7')
    controller.cancelRestore()
    assert.equal(controller.getSnapshot().restoreConfirm, undefined)

    // Confirm path: adoptTask arms the countdown for the restored version.
    controller.requestRestore('7.7.7')
    const confirming = controller.confirmRestore()
    await flush()
    assert.ok(overlay.last().actions.some(a => a.label === t('restart.later')), 'countdown is cancellable')
    // Run the countdown second by second: node:test tick() does not cascade
    // into timers that a callback re-schedules for a LATER moment, so one
    // big 20s tick would only ever fire the first step.
    for (let second = 0; second < 21; second += 1) {
      ctx.mock.timers.tick(1000)
      await flush()
    }
    assert.equal(controller.getSnapshot().restarting, true, 'expiry started the restart')
    // Advance into the watchdog probe for the healthy replacement host.
    ctx.mock.timers.tick(1000)
    await flush()
    await confirming
    assert.equal(reloaded, 1, 'the restore walked the full restart chain')
  } finally {
    ctx.mock.timers.reset()
  }
})

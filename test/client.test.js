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
async function loadClient(reactImpl) {
  let captured
  globalThis.window = {
    __ModuleLoader__: { load: (options) => { captured = options.factory } },
    sessionStorage: fakeStorage(),
    location: { reload: () => {} },
    matchMedia: () => ({ matches: false }),
  }
  const react = reactImpl ?? {
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
 *
 * Method matters to this stub's callers: several routes are POST-only, so a
 * handler that calls them without a body gets a 405 the browser half would
 * never notice. Every call is therefore recorded with its method (and the
 * parsed body) on `calls`, which is what the restart-deferral tests assert on.
 * @param {Record<string, (call: number, meta: { method: string }) => object>} table - suffix → response factory.
 */
function fakeFetch(table) {
  const counts = {}
  /** @type {{ path: string; method: string; body: unknown }[]} */
  const calls = []
  let phase = table
  const impl = async (path, init) => {
    const method = typeof init?.method === 'string' ? init.method : 'GET'
    calls.push({ path, method, body: init?.body })
    const key = Object.keys(phase).find(suffix => path.endsWith(suffix))
    if (key === undefined) throw new Error(`unexpected fetch: ${path}`)
    counts[key] = (counts[key] ?? 0) + 1
    return phase[key](counts[key], { method })
  }
  return {
    /** Swap the answer table mid-test (e.g. once the host "restarted"). */
    setTable(next) { phase = next },
    counts,
    calls,
    /** How many times one method was used against one path suffix. */
    hit(method, suffix) {
      return calls.filter(call => call.method === method && call.path.endsWith(suffix)).length
    },
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
 * A React stand-in with real hook semantics for ONE component, so a render can
 * be driven by hand. State persists across the renders this harness performs and
 * `useEffect` re-runs exactly when its dependency array changes by identity —
 * which is the mechanism an unsaved form edit lives or dies by.
 */
function fakeHooks() {
  /** @type {{ has: boolean; value: unknown; deps: unknown[] | undefined }[]} */
  const slots = []
  let cursor = 0
  /** Claim the next hook slot, in call order. */
  const next = () => {
    const at = cursor
    cursor += 1
    if (slots[at] === undefined) slots[at] = { has: false, value: undefined, deps: undefined }
    return slots[at]
  }
  const depsChanged = (before, after) => before === undefined
    || after === undefined
    || before.length !== after.length
    || before.some((item, index) => !Object.is(item, after[index]))
  /** Set when a state write happened during a render, so it needs another. */
  let dirty = false
  return {
    react: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useRef: (initial) => {
        const slot = next()
        if (!slot.has) { slot.has = true; slot.value = { current: initial } }
        return slot.value
      },
      useState: (initial) => {
        const slot = next()
        if (!slot.has) { slot.has = true; slot.value = typeof initial === 'function' ? initial() : initial }
        return [slot.value, (update) => {
          dirty = true
          slot.value = typeof update === 'function' ? update(slot.value) : update
        }]
      },
      useEffect: (fn, deps) => {
        const slot = next()
        if (depsChanged(slot.deps, deps)) { slot.deps = deps; fn() }
      },
    },
    /** Render the component until it settles, and return that tree. */
    render(component, props) {
      let tree = undefined
      for (let pass = 0; pass < 4; pass += 1) {
        cursor = 0
        dirty = false
        tree = component(props)
        if (!dirty) break
      }
      return tree
    },
  }
}

/**
 * Depth-first search over a rendered tree, descending into prop values as well
 * as children: this panel hands controls to fields through `control` props, so a
 * children-only walk would miss every input in the form.
 * @param {unknown} node - the node to search from.
 * @param {(node: any) => boolean} predicate - what counts as a hit.
 * @param {Set<object>} [seen] - cycle guard.
 * @returns {any} the first matching node, or undefined.
 */
function findNode(node, predicate, seen = new Set()) {
  if (typeof node !== 'object' || node === null || seen.has(node)) return undefined
  seen.add(node)
  if (predicate(node)) return node
  const children = Array.isArray(node.children) ? node.children.flat() : []
  const queue = [...children, ...Object.values(node.props ?? {})]
  for (const child of queue) {
    const hit = findNode(child, predicate, seen)
    if (hit !== undefined) return hit
  }
  return undefined
}

test('the policy form keeps an unsaved edit, shows the derived hint, and resets on a real answer', async () => {
  const hooks = fakeHooks()
  const client = await loadClient(hooks.react)
  assert.equal(typeof client.PolicyCard, 'function', 'the form is reachable for this test')
  // The policy object the panel passes is the controller's own state object, so
  // it keeps its identity across renders and changes only when the host answers.
  const policy = { mode: 'off', track: { kind: 'tag', tag: 'latest' }, window: null, restart: 'ask', checkAt: null }
  const props = {
    t, policy, nextCheckHint: undefined, saving: false, error: undefined, notice: undefined,
    onSave: () => {}, onRefresh: () => {},
  }
  /** The first dropdown of the form, which is the mode selector. */
  const modeSelect = (tree) => {
    const node = findNode(tree, candidate => candidate?.props?.options !== undefined)
    assert.ok(node !== undefined, 'a dropdown was rendered')
    return node.props
  }
  /** The next-check hint text, or undefined when the form shows none. */
  const hint = (tree) => {
    const node = findNode(tree, candidate => candidate?.props?.className === 'dshvu_hint')
    return node === undefined ? undefined : node.children[0]
  }

  let tree = hooks.render(client.PolicyCard, props)
  assert.equal(modeSelect(tree).value, 'off')

  // An edit, then a re-render that changed nothing about the policy (a poll
  // landed, another card repainted): a half-typed form is the user's work, and no
  // unrelated render may throw it away.
  modeSelect(tree).onChange('auto')
  tree = hooks.render(client.PolicyCard, props)
  assert.equal(modeSelect(tree).value, 'auto', 'an unsaved edit survived an unrelated render')

  // The schedule hint updates on that same stable policy object. It used to
  // travel INSIDE the policy, which is exactly why the form had to be re-fed a
  // fresh object every render — and why every render cost the user their edit.
  tree = hooks.render(client.PolicyCard, { ...props, nextCheckHint: 'next: 04:00' })
  assert.equal(hint(tree), 'next: 04:00', 'the derived hint is not held hostage by the draft')
  assert.equal(modeSelect(tree).value, 'auto', 'and showing it did not cost the edit')

  // A genuine host answer (a save, or a refresh) replaces the draft, as designed.
  tree = hooks.render(client.PolicyCard, { ...props, policy: { ...policy, mode: 'notify' } })
  assert.equal(modeSelect(tree).value, 'notify', 'a real policy change wins over the draft')
})

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

test('the verdict never claims "up to date" for a registry it could not read', async () => {
  const client = await loadClient()
  const verdict = client.installVerdict
  // The healthy cases.
  assert.equal(verdict(t, { status: 'ready', installed: '0.4.0', channels: [] }, []), t('upToDate'))
  assert.equal(
    verdict(t, { status: 'ready', installed: '0.4.0' }, [{ version: '0.5.0' }]),
    t('available', { version: '0.5.0' }),
  )
  // The one that used to lie: a degraded check answers with NO channels at all
  // plus a publishedError, and an empty `ahead` proved nothing about what is
  // published — the panel stated the single thing the data could not support.
  assert.equal(
    verdict(t, { status: 'ready', installed: '0.4.0', publishedError: 'fetch failed' }, []),
    t('publishUnknown'),
  )
  // Nothing to say before the first read answers, or without a known version.
  assert.equal(verdict(t, { status: 'loading' }, []), undefined)
  assert.equal(verdict(t, { status: 'ready' }, []), undefined)
  // Both dictionaries must carry the key the branch renders.
  for (const lang of ['zh', 'en']) {
    assert.ok(client.dictionaries[lang].publishUnknown, `${lang} names the unknown verdict`)
  }
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

test('check with prompt offers an ahead update for confirmation', async () => {
  const client = await loadClient()
  fakeFetch({
    '/check': () => json({ result: {
      installed: '0.4.0',
      installDir: '/i',
      channels: [{ channel: 'latest', version: '0.5.0', ahead: true }],
      versions: ['0.5.0', '0.4.0'],
      task: { state: 'idle', log: '' },
      lastCheck: { at: 42, updateAvailable: true, target: '0.5.0' },
      recent: [],
    } }),
    '/snapshots': () => json({ result: { snapshots: [] } }),
  }).install()
  const controller = client.createController({ t })
  await controller.check({ prompt: true })
  const s = controller.getSnapshot()
  assert.equal(s.confirm, '0.5.0', 'the ahead version is offered for confirmation')
  assert.equal(s.status, 'ready')
})

test('check without prompt does not open a confirmation', async () => {
  const client = await loadClient()
  fakeFetch({
    '/check': () => json({ result: {
      installed: '0.4.0',
      channels: [{ channel: 'latest', version: '0.5.0', ahead: true }],
      task: { state: 'idle', log: '' },
      recent: [],
    } }),
    '/snapshots': () => json({ result: { snapshots: [] } }),
  }).install()
  const controller = client.createController({ t })
  await controller.check()
  assert.equal(controller.getSnapshot().confirm, undefined, 'no confirm without prompt')
})

test('a successful policy save shows a transient notice', async () => {
  const client = await loadClient()
  fakeFetch({
    '/policy': () => json({ result: { policy: {} } }),
  }).install()
  const controller = client.createController({ t })
  await controller.savePolicy({ mode: 'auto' })
  const s = controller.getSnapshot()
  assert.equal(s.savingPolicy, false)
  assert.ok(s.policyNotice !== undefined, 'a notice appeared after saving')
  assert.equal(s.policyNotice.kind, 'ok', 'the notice reports success')
  controller.dispose()
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
  const fetch = fakeFetch({
    '/status': () => json({ result: {
      state: 'idle', log: '',
      running: '0.4.0', installed: '0.9.0', stale: true, needsRestart: true,
      restartable: true,
    } }),
    '/policy': () => json({ result: { policy: {} } }),
    '/cancel': () => json({ result: { cancelled: true } }),
  })
  fetch.install()
  const controller = client.createController({ t, overlay })
  controller.resume()
  await flush()
  // The identity translator renders keys, not prose: the OFFER is recognized
  // by its actions — restart available but nothing armed or reloaded.
  const view = overlay.last()
  assert.equal(view.title, t('restart.title'))
  assert.ok(view.actions.some(a => a.label === t('restart.now')))
  // Offered, not forced: "later" leaves the page alone — but the word carries
  // the same promise in both dialogs, so it must also disarm a pending
  // host-side fallback restart, through the POST-only cancel route.
  overlay.click(t('restart.later'))
  await flush()
  assert.equal(overlay.hidden, 1)
  assert.equal(fetch.hit('POST', '/restart/cancel'), 1, 'deferring the offer disarms the fallback')
  assert.equal(fetch.hit('POST', '/restart'), 0, 'deferring must not restart anything')
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
    const fetch = fakeFetch({
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
      '/cancel': () => json({ result: { cancelled: true } }),
    })
    fetch.install()
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

    // "Later" cancels without restarting anything — and disarms the host-side
    // fallback, which only happens if the cancel reaches the POST-only route.
    overlay.click(t('restart.later'))
    await flush()
    assert.equal(fetch.hit('POST', '/restart/cancel'), 1, 'deferring must POST the cancel route')
    assert.equal(fetch.hit('GET', '/restart/cancel'), 0, 'a GET would answer 405 and be swallowed')
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

test('deleting a snapshot takes two clicks on the same row', async () => {
  const client = await loadClient()
  const overlay = fakeOverlay()
  const fetch = fakeFetch({
    // Insertion order matters to the stub: it matches by suffix, so the more
    // specific route has to be listed before the shorter one it contains.
    '/snapshots/delete': () => json({ result: { removed: '0.3.0', snapshots: [{ version: '0.2.0', at: 2 }] } }),
    '/snapshots': () => json({ result: { snapshots: [{ version: '0.3.0', at: 1 }, { version: '0.2.0', at: 2 }] } }),
    '/policy': () => json({ result: { policy: DEFAULT_POLICY } }),
    '/check': () => json({ result: { installed: '0.4.0', channels: [], versions: [] } }),
  })
  fetch.install()
  const controller = client.createController({ t, overlay })
  await controller.check()
  assert.deepEqual(controller.getSnapshot().snapshots.map(entry => entry.version), ['0.3.0', '0.2.0'])

  // The first click arms the row and asks the host for nothing: this is the one
  // path in the panel that permanently destroys data with no undo.
  await controller.deleteSnapshot('0.3.0')
  assert.equal(controller.getSnapshot().deleteArmed, '0.3.0')
  assert.equal(fetch.hit('POST', '/snapshots/delete'), 0, 'arming must not delete')

  // The second click on the same version deletes, and the row leaves the panel
  // with the list the host sent back rather than a guess of what survived.
  await controller.deleteSnapshot('0.3.0')
  assert.equal(fetch.hit('POST', '/snapshots/delete'), 1)
  assert.equal(controller.getSnapshot().deleteArmed, undefined)
  assert.deepEqual(controller.getSnapshot().snapshots.map(entry => entry.version), ['0.2.0'])

  // A click on a DIFFERENT row moves the arm rather than firing the first one: a
  // user who changes their mind mid-list deletes nothing.
  await controller.deleteSnapshot('0.2.0')
  assert.equal(controller.getSnapshot().deleteArmed, '0.2.0')
  assert.equal(fetch.hit('POST', '/snapshots/delete'), 1)

  // And a check drops the arm — the list a row was armed against may not be the
  // list on screen any more.
  await controller.check()
  assert.equal(controller.getSnapshot().deleteArmed, undefined)
  await controller.deleteSnapshot('0.2.0')
  assert.equal(fetch.hit('POST', '/snapshots/delete'), 1, 'the stale arm did not fire on its own')
})

test('tree health reaches the panel on the poll it changes in', async (ctx) => {
  const client = await loadClient()
  ctx.mock.timers.enable()
  try {
    const overlay = fakeOverlay()
    // What a host reports once an interrupted npm has left the global tree
    // half-committed: no readable manifest, retired directories still in place.
    const broken = {
      installDir: '/prefix/node_modules/@deepseek-ai/dsh',
      manifestOk: false,
      leftovers: [{ name: '@deepseek-ai.dsh-abc123', path: '/x', ageMs: 9000 }],
      healthy: false,
      removed: 0,
      at: 5,
    }
    let phase = 'running'
    fakeFetch({
      '/update': () => json({ result: { state: 'running', version: '9.9.9', log: '' } }),
      '/status': () => json({ result: phase === 'running'
        ? { state: 'running', version: '9.9.9', log: 'npm ERR!' }
        : { state: 'failed', version: '9.9.9', log: '', error: 'npm exited 1', tree: broken } }),
    }).install()
    const controller = client.createController({ t, overlay })
    await controller.startUpdate('9.9.9')
    assert.equal(controller.getSnapshot().tree, undefined, 'no answer has carried a verdict yet')

    ctx.mock.timers.tick(1000)
    await flush()
    assert.equal(controller.getSnapshot().tree, undefined, 'a running install has nothing to report')

    // The repair that produces this fact runs after a failed install settles, so
    // the verdict arrives on a status answer — not on the panel's own check, which
    // may be many minutes stale by then.
    phase = 'failed'
    ctx.mock.timers.tick(1000)
    await flush()
    assert.deepEqual(controller.getSnapshot().tree, broken, 'the failure carried its tree health through')
  } finally {
    ctx.mock.timers.reset()
  }
})

test('a dropped poll keeps following the install instead of ending it', async (ctx) => {
  const client = await loadClient()
  ctx.mock.timers.enable()
  try {
    const overlay = fakeOverlay()
    let mode = 'running'
    const fetch = fakeFetch({
      '/update': () => json({ result: { state: 'running', version: '9.9.9', log: '' } }),
      '/status': () => {
        if (mode === 'hiccup') throw new Error('Failed to fetch')
        return json({ result: { state: 'running', version: '9.9.9', log: 'npm still working' } })
      },
    })
    fetch.install()
    const controller = client.createController({ t, overlay })
    await controller.startUpdate('9.9.9')

    mode = 'hiccup'
    ctx.mock.timers.tick(1000)
    await flush()
    let snap = controller.getSnapshot()
    // One refused request used to stop the follow-up entirely: busy cleared,
    // the error line blaming the UPDATE for a momentary fetch failure, and the
    // log — the one thing worth watching mid-install — going dead.
    assert.equal(snap.busy, true, 'a hiccup does not hand the buttons back')
    assert.equal(snap.error, undefined, 'a dropped fetch is not the install failing')

    mode = 'running'
    ctx.mock.timers.tick(1000)
    await flush()
    snap = controller.getSnapshot()
    assert.equal(snap.task.log, 'npm still working', 'polling carried on to the next answer')
    assert.equal(snap.busy, true)

    // A tolerated miss is also forgotten, not remembered as a pending failure:
    // two hiccups with a good poll between them must not add up to giving up.
    mode = 'hiccup'
    ctx.mock.timers.tick(1000)
    await flush()
    ctx.mock.timers.tick(1000)
    await flush()
    assert.equal(controller.getSnapshot().error, undefined, 'two misses in a row are still tolerated')
    // The third one is the limit, and then it is reported as what it is: the
    // host stopped answering, not the install failing.
    ctx.mock.timers.tick(1000)
    await flush()
    assert.equal(controller.getSnapshot().busy, false)
    assert.equal(controller.getSnapshot().error, 'Failed to fetch')
    const polls = fetch.calls.filter(call => call.path.endsWith('/status')).length
    ctx.mock.timers.tick(5000)
    await flush()
    assert.equal(fetch.calls.filter(call => call.path.endsWith('/status')).length, polls, 'a stopped follow-up stays stopped')
  } finally {
    ctx.mock.timers.reset()
  }
})

test('an absent host half is reported at once, not retried into silence', async (ctx) => {
  const client = await loadClient()
  ctx.mock.timers.enable()
  try {
    const overlay = fakeOverlay()
    fakeFetch({
      '/update': () => json({ result: { state: 'running', version: '9.9.9', log: '' } }),
      // The SPA fallback shape: the plugin is installed but its host half never
      // mounted, which no number of retries will change.
      '/status': () => htmlFallback(),
    }).install()
    const controller = client.createController({ t, overlay })
    await controller.startUpdate('9.9.9')
    ctx.mock.timers.tick(1000)
    await flush()
    assert.equal(controller.getSnapshot().busy, false, 'the panel does not stay locked on a host that is not there')
    assert.equal(controller.getSnapshot().error, t('notMounted'), 'the absence is named, not invented')
  } finally {
    ctx.mock.timers.reset()
  }
})

test('a restart asked for twice is one request to the host', async (ctx) => {
  const client = await loadClient()
  ctx.mock.timers.enable()
  try {
    const overlay = fakeOverlay()
    let reloaded = 0
    const fetch = fakeFetch({
      // The host answers once and then exits; a second POST would be the page
      // asking a process that is already gone.
      '/restart': () => json({ result: {} }),
      '/cancel': () => json({ result: { cancelled: true } }),
      '/status': () => json({ result: { state: 'done', log: '', stale: true, needsRestart: true, restartable: true } }),
    })
    fetch.install()
    const controller = client.createController({ t, overlay, reload: () => { reloaded += 1 } })
    const first = controller.restart('9.9.9')
    const second = controller.restart('9.9.9')
    await flush()
    assert.equal(fetch.hit('POST', '/restart'), 1, 'the second intent is dropped, not queued')
    assert.equal(overlay.last().body, t('restart.waiting'), 'the page is waiting on one handoff')
    ctx.mock.timers.tick(4000)
    await flush()
    assert.equal(reloaded, 0, 'a host that never comes back is not reloaded into')
    await first
    void second
  } finally {
    ctx.mock.timers.reset()
  }
})

test('a restart request that never answered counts as a host already gone', async (ctx) => {
  const client = await loadClient()
  ctx.mock.timers.enable()
  try {
    const overlay = fakeOverlay()
    const fetch = fakeFetch({
      // An aborted fetch is what a request timeout looks like: the host may
      // well have taken the hint and exited, so the page must go on watching
      // rather than report a failure it cannot distinguish from a real refusal.
      '/restart': () => { throw new Error('The operation was aborted due to timeout') },
      '/cancel': () => json({ result: { cancelled: true } }),
      '/status': () => json({ result: { state: 'done', log: '', stale: true, needsRestart: true, restartable: true } }),
    })
    fetch.install()
    const controller = client.createController({ t, overlay, reload: () => {} })
    const waiting = controller.restart('9.9.9')
    await flush()
    assert.equal(overlay.last().body, t('restart.waiting'), JSON.stringify(overlay.shown))
    assert.notEqual(overlay.last().body, t('restart.failed'), 'no failure was declared')
    assert.equal(
      globalThis.window.sessionStorage.getItem('dsh-version-update:awaiting-restart'),
      '9.9.9',
      'the watchdog survives a reload of this page',
    )
    void waiting
  } finally {
    ctx.mock.timers.reset()
  }
})

test('a refused restart is reported as a refusal, not a wait', async (ctx) => {
  const client = await loadClient()
  ctx.mock.timers.enable()
  try {
    const overlay = fakeOverlay()
    fakeFetch({
      '/restart': () => json({ error: 'restart unavailable: the listening address is unknown' }, 409),
      '/cancel': () => json({ result: { cancelled: true } }),
      '/status': () => json({ result: { state: 'done', log: '', stale: true, needsRestart: true, restartable: true } }),
    }).install()
    const controller = client.createController({ t, overlay })
    await controller.restart('9.9.9')
    assert.equal(overlay.last().body, t('restart.failed'))
    assert.equal(controller.getSnapshot().restarting, false, 'the panel hands the choice back')
    // The refusal must not leave a marker behind: a reload would then sit in a
    // watchdog waiting for a restart that was never armed.
    assert.equal(globalThis.window.sessionStorage.getItem('dsh-version-update:awaiting-restart'), null)
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
      '/cancel': () => json({ result: { cancelled: true } }),
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

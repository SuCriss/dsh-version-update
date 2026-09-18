/**
 * Scheduler tests: the pure decision pipeline driven through `runCycle` with
 * a fake clock — tracking resolution per mode, execution-window parking and
 * waking, error recording, and the ambient view the routes expose.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STARTUP_CHECK_MS, createScheduler } from '../lib/scheduler.js'
import { DEFAULT_POLICY } from '../lib/protocol.js'

const PUBLISHED = {
  distTags: { latest: '0.5.0', next: '0.6.0-rc.1' },
  versions: ['0.6.0-rc.1', '0.5.0', '0.4.2'],
}

/** A scheduler wired to in-memory fakes. */
function harness(overrides = {}) {
  /** @type {any} */
  const state = {
    policy: { ...DEFAULT_POLICY },
    installed: '0.4.2',
    started: [],
  }
  const updater = {
    start(version, trigger) {
      if (state.refuse === true) throw new Error('busy')
      state.started.push({ version, trigger })
    },
  }
  const scheduler = createScheduler({
    policy: () => state.policy,
    installed: () => state.installed,
    check: async () => {
      if (state.checkError !== undefined) throw new Error(state.checkError)
      return PUBLISHED
    },
    updater,
    now: () => new Date('2026-03-01T12:00:00'),
    ...overrides,
  })
  return { state, scheduler, updater }
}

/**
 * Replace the timer queue with a recording one: armed callbacks never fire on
 * their own, the test fires them by hand after moving the fake clock.
 * @returns {{ armed: { callback: () => void; ms: number; cleared: boolean }[]; restore: () => void }} the recorder.
 */
function spyTimers() {
  /** @type {{ callback: () => void; ms: number; cleared: boolean }[]} */
  const armed = []
  const original = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const handles = new Map()
  globalThis.clearTimeout = /** @type {any} */ ((handle) => {
    const entry = handles.get(handle)
    if (entry !== undefined) entry.cleared = true
    originalClear(handle)
  })
  globalThis.setTimeout = /** @type {any} */ ((/** @type {Function} */ callback, /** @type {number} */ ms) => {
    const entry = { callback: () => callback(), ms, cleared: false }
    armed.push(entry)
    // Unreffed on purpose: a far-future dummy must never hold the test process
    // open if a case forgets to dispose its scheduler.
    const dummy = original(() => {}, 10 ** 9)
    dummy.unref?.()
    handles.set(dummy, entry)
    return dummy
  })
  return { armed, restore: () => {
    for (const handle of handles.keys()) originalClear(handle)
    globalThis.setTimeout = original
    globalThis.clearTimeout = originalClear
  } }
}

test('mode off and notify record findings but never install', async () => {
  for (const mode of ['off', 'notify']) {
    const { state, scheduler } = harness()
    state.policy.mode = mode
    await scheduler.runCycle()
    assert.deepEqual(state.started, [])
    assert.equal(scheduler.view().lastCheck.updateAvailable, true)
    assert.equal(scheduler.view().lastCheck.target, '0.5.0')
  }
})

test('mode auto installs inside the window with trigger auto', async () => {
  const { state, scheduler } = harness()
  state.policy = { ...state.policy, mode: 'auto' }
  await scheduler.runCycle()
  assert.deepEqual(state.started, [{ version: '0.5.0', trigger: 'auto' }])
})

test('outside the execution window the finding parks instead of installing', async () => {
  const { state, scheduler } = harness() // fake clock says 12:00
  state.policy = { ...state.policy, mode: 'auto', window: { start: '04:00', end: '05:00' } }
  await scheduler.runCycle()
  assert.deepEqual(state.started, [], 'nothing installs at noon')
  const view = scheduler.view()
  assert.equal(view.pendingAuto.target, '0.5.0', 'the finding waits for the window')
})

test('inside the execution window an auto finding installs immediately', async () => {
  const inside = harness({ now: () => new Date('2026-03-02T04:30:00') })
  inside.state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '04:00', end: '05:00' } }
  await inside.scheduler.runCycle()
  assert.deepEqual(inside.state.started, [{ version: '0.5.0', trigger: 'auto' }])
})

test('a parked finding installs when beginAutoInstall succeeds after a refusal', async () => {
  const { state, scheduler } = harness()
  state.policy = { ...state.policy, mode: 'auto' }
  state.refuse = true
  await scheduler.runCycle()
  assert.deepEqual(state.started, [])
  assert.equal(scheduler.view().pendingAuto.target, '0.5.0')

  // Slot frees up; the next cycle (window satisfied) goes through.
  state.refuse = false
  await scheduler.runCycle()
  assert.deepEqual(state.started, [{ version: '0.5.0', trigger: 'auto' }])
  assert.equal(scheduler.view().pendingAuto, undefined)
})

test('the window wake fires after the opening, never a hair before it', async () => {
  let clock = new Date('2026-03-01T03:59:00')
  const { state, scheduler } = harness({ now: () => clock })
  state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '04:00', end: '05:00' } }
  const spy = spyTimers()
  try {
    scheduler.start()
    await scheduler.consider(PUBLISHED)
    const wake = spy.armed.at(-1)
    assert.ok(wake !== undefined, 'parking the finding armed a wake')
    // The old jitter fired the wake 50 ms BEFORE the opening. The wake then
    // re-reads the wall clock in whole minutes to be sure the window is open,
    // and 03:59:59.950 is still minute 239 — it declined the very window it
    // existed for, and nothing armed another one.
    assert.ok(wake.ms >= 60_000, `the wake waits for the opening, got ${wake.ms}ms`)
    clock = new Date('2026-03-01T04:00:00.25')
    wake.callback()
  } finally {
    spy.restore()
    scheduler.dispose()
  }
  assert.deepEqual(state.started, [{ version: '0.5.0', trigger: 'auto' }], 'the parked finding installed on the opening')
  assert.equal(scheduler.view().pendingAuto, undefined, 'a delivered finding stops being parked')
})

test('a parked finding the slot refused keeps a wake armed', async () => {
  const { state, scheduler } = harness()
  // No execution window at all: the refusal has no opening to wait for, so a
  // wake that is not armed simply loses the update until the next check — and
  // with no checkAt configured, there is no next check.
  state.policy = { ...DEFAULT_POLICY, mode: 'auto' }
  state.refuse = true
  const spy = spyTimers()
  try {
    scheduler.start()
    await scheduler.consider(PUBLISHED)
    const retry = spy.armed.at(-1)
    assert.ok(retry !== undefined, 'a refused auto install is not silently dropped')
    assert.equal(scheduler.view().pendingAuto?.target, '0.5.0')
    state.refuse = false
    retry.callback()
    assert.deepEqual(state.started, [{ version: '0.5.0', trigger: 'auto' }], 'the retry delivered it')
    assert.equal(scheduler.view().pendingAuto, undefined)
  } finally {
    spy.restore()
    scheduler.dispose()
  }
})

test('a wake that lands outside its window waits for the next opening', async () => {
  let clock = new Date('2026-03-01T04:00:00')
  const { state, scheduler } = harness({ now: () => clock })
  state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '04:00', end: '05:00' } }
  const spy = spyTimers()
  try {
    scheduler.start()
    clock = new Date('2026-03-01T03:00:00')
    await scheduler.consider(PUBLISHED)
    const wake = spy.armed.at(-1)
    assert.ok(wake !== undefined)
    // The policy moved the window while the timer sat armed.
    state.policy.window = { start: '09:00', end: '10:00' }
    clock = new Date('2026-03-01T04:00:00')
    wake.callback()
    assert.deepEqual(state.started, [], '04:00 is no longer inside the window')
    const next = spy.armed.at(-1)
    assert.notEqual(next, wake, 'the stale wake re-armed instead of ending the chain')
    assert.ok(next.ms > 4 * 60 * 60 * 1000, `the new wake waits for 09:00, got ${next.ms}ms`)
    assert.equal(scheduler.view().pendingAuto?.target, '0.5.0', 'the finding is still parked')
    // And when 09:00 arrives, it goes in.
    clock = new Date('2026-03-01T09:00:00')
    next.callback()
    assert.deepEqual(state.started, [{ version: '0.5.0', trigger: 'auto' }])
  } finally {
    spy.restore()
    scheduler.dispose()
  }
})

test('tracking kinds decide differently over the same registry facts', async () => {
  // Pin: nothing ever.
  const pinned = harness()
  pinned.state.policy.track = { kind: 'pin' }
  pinned.state.policy.mode = 'auto'
  await pinned.scheduler.runCycle()
  assert.deepEqual(pinned.state.started, [])

  // Line ^0.4.x resolves to 0.4.2? No: installed is already 0.4.2 → no target.
  const lined = harness()
  lined.state.policy.track = { kind: 'line', range: '^0.4.0' }
  lined.state.policy.mode = 'auto'
  await lined.scheduler.runCycle()
  assert.deepEqual(lined.state.started, [])
  assert.equal(lined.scheduler.view().lastCheck.updateAvailable, false)

  // Tag next follows pre-releases when asked.
  const nexted = harness()
  nexted.state.policy.track = { kind: 'tag', tag: 'next' }
  nexted.state.policy.mode = 'auto'
  await nexted.scheduler.runCycle()
  assert.deepEqual(nexted.state.started, [{ version: '0.6.0-rc.1', trigger: 'auto' }])
})

test('a failing check is recorded as lastCheck.error without installing', async () => {
  const { state, scheduler } = harness()
  state.policy.mode = 'auto'
  state.checkError = 'registry down'
  await scheduler.runCycle()
  assert.deepEqual(state.started, [])
  assert.equal(scheduler.view().lastCheck.error, 'registry down')
})

test('an unknown installed version never produces an auto install', async () => {
  const { state, scheduler } = harness()
  state.installed = undefined
  state.policy.mode = 'auto'
  await scheduler.runCycle()
  assert.deepEqual(state.started, [])
  assert.equal(scheduler.view().lastCheck.updateAvailable, false)
})

test('view exposes the tracked channel version for display', async () => {
  const { scheduler } = harness()
  await scheduler.runCycle()
  assert.equal(scheduler.view().lastCheck.latest, '0.5.0')
})

test('dispose stops timers so late cycles do not fire', () => {
  const { scheduler } = harness()
  const stopped = []
  const originalSetTimeout = globalThis.setTimeout
  const spy = (fn, ms, ...rest) => {
    stopped.push(ms)
    return originalSetTimeout(() => {}, 10 ** 9)
  }
  const saved = globalThis.setTimeout
  globalThis.setTimeout = /** @type {any} */ (spy)
  try {
    const live = harness()
    live.state.policy.checkAt = '03:00'
    live.scheduler.start()
    assert.ok(stopped.length > 0, 'start armed at least one timer')
    live.scheduler.dispose()
    // No throw, and further policy changes are ignored silently.
    live.scheduler.policyChanged()
  } finally {
    globalThis.setTimeout = saved
  }
})

test('a fired daily check re-arms itself, so silent updates recur every day', async () => {
  const { state, scheduler } = harness()
  state.policy.mode = 'auto'
  state.policy.checkAt = '03:00'
  const armed = []
  const originalSetTimeout = globalThis.setTimeout
  const spy = (fn, ms, ...rest) => {
    armed.push({ fn, ms })
    // A far-future dummy: the re-armed timer must never actually fire here.
    const timer = originalSetTimeout(() => {}, 10 ** 9)
    timer.unref?.()
    return timer
  }
  globalThis.setTimeout = /** @type {any} */ (spy)
  try {
    scheduler.start()
    // `mode: 'auto'` arms two timers at start: the daily check and the one-shot
    // startup check. Only the daily one is expected to recur.
    const startup = armed.filter(entry => entry.ms === STARTUP_CHECK_MS)
    assert.equal(startup.length, 1, 'start armed the one-shot startup check')
    const daily = armed.find(entry => entry.ms !== STARTUP_CHECK_MS)
    assert.ok(daily !== undefined, 'start armed the daily check')
    daily.fn() // the scheduled moment arrives
    // Drain every microtask the cycle and its re-arm produce.
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(state.started, [{ version: '0.5.0', trigger: 'auto' }], 'the scheduled cycle installed silently')
    assert.equal(armed.length, 3, 'the fired check re-armed the next occurrence instead of falling silent')
    assert.equal(armed.filter(entry => entry.ms === STARTUP_CHECK_MS).length, 1, 'the startup check is one-shot and did not re-arm')
  } finally {
    globalThis.setTimeout = originalSetTimeout
    scheduler.dispose()
  }
})

test('the startup check runs one automatic cycle with no panel and no checkAt', async () => {
  const { state, scheduler } = harness()
  // No checkAt at all: the daily timer cannot arm, so this is the ONLY thing
  // that can keep a silent policy current on a host that is off at 03:00.
  state.policy = { ...DEFAULT_POLICY, mode: 'auto' }
  const spy = spyTimers()
  try {
    scheduler.start()
    assert.equal(scheduler.view().nextCheckAt, undefined, 'no checkAt means no daily timer')
    const startup = spy.armed.find(entry => entry.ms === STARTUP_CHECK_MS)
    assert.ok(startup !== undefined, 'mode auto arms the one-shot startup check')
    startup.callback()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(state.started, [{ version: '0.5.0', trigger: 'auto' }], 'the startup cycle installed silently')
    assert.equal(scheduler.view().lastCheck.target, '0.5.0')
  } finally { scheduler.dispose(); spy.restore() }
})

test('modes that only report arm no background startup check', async () => {
  for (const mode of ['off', 'notify']) {
    const { state, scheduler } = harness()
    state.policy = { ...DEFAULT_POLICY, mode }
    const spy = spyTimers()
    try {
      scheduler.start()
      assert.deepEqual(spy.armed, [], `${mode} arms nothing at startup`)
    } finally { scheduler.dispose(); spy.restore() }
  }
})

test('the startup check re-reads the policy when it fires, so switching to off cancels it', async () => {
  // What this check actually buys is the registry round-trip, not the install:
  // `consider` would refuse a non-auto mode anyway. Asserting only "nothing
  // installed" would pass even with the re-read deleted — the assertion has to
  // name the request that never happens.
  let checks = 0
  const { state, scheduler } = harness({ check: async () => { checks += 1; return PUBLISHED } })
  state.policy = { ...DEFAULT_POLICY, mode: 'auto' }
  const spy = spyTimers()
  try {
    scheduler.start()
    const startup = spy.armed.find(entry => entry.ms === STARTUP_CHECK_MS)
    assert.ok(startup !== undefined)
    // The delay is a window in which the user can change their mind.
    state.policy = { ...DEFAULT_POLICY, mode: 'off' }
    startup.callback()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(checks, 0, 'a cancelled check does not even reach the registry')
    assert.deepEqual(state.started, [], 'the delayed check honours the policy it finds, not the one it armed under')
  } finally { scheduler.dispose(); spy.restore() }
})

test('turning auto on arms the startup check the boot under off never armed', async () => {
  const { state, scheduler } = harness()
  state.policy = { ...DEFAULT_POLICY, mode: 'off' }
  const spy = spyTimers()
  try {
    scheduler.start()
    assert.deepEqual(spy.armed, [], 'off arms nothing at boot')
    // Without this the panel's acting read — which ran while the OLD mode was
    // in force — would be the last automatic check until the next checkAt, or
    // forever with none configured.
    state.policy = { ...DEFAULT_POLICY, mode: 'auto' }
    scheduler.policyChanged()
    const startup = spy.armed.find(entry => entry.ms === STARTUP_CHECK_MS)
    assert.ok(startup !== undefined, 'the policy edit armed the check the boot skipped')
    startup.callback()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(state.started, [{ version: '0.5.0', trigger: 'auto' }])
  } finally { scheduler.dispose(); spy.restore() }
})

test('consider decides from pre-fetched facts, so a check can trigger the install without any timer', async () => {
  const { state, scheduler } = harness()
  state.policy.mode = 'auto'
  await scheduler.consider(PUBLISHED)
  assert.deepEqual(state.started, [{ version: '0.5.0', trigger: 'auto' }])
  assert.equal(scheduler.view().lastCheck.updateAvailable, true)
  assert.equal(scheduler.view().lastCheck.target, '0.5.0')
})

test('cancelPending clears window wakes and busy retries but keeps the daily check', async () => {
  for (const busy of [false, true]) {
    const spy = spyTimers()
    let clock = new Date('2026-03-01T12:00:00')
    const { state, scheduler } = harness({ now: () => clock })
    state.policy = { ...DEFAULT_POLICY, mode: 'auto', checkAt: '13:00', window: busy ? null : { start: '04:00', end: '05:00' } }
    state.refuse = busy
    try {
      scheduler.start()
      // Three timers are now live: the daily check, the one-shot startup check,
      // and the wake `consider` arms for the finding it parks.
      const daily = spy.armed[0]
      assert.notEqual(daily.ms, STARTUP_CHECK_MS, 'the daily check is armed first')
      await scheduler.consider(PUBLISHED)
      const wake = spy.armed.at(-1)
      const before = scheduler.view()
      assert.equal(before.pendingAuto?.target, '0.5.0')
      scheduler.cancelPending()
      scheduler.cancelPending() // Safe even when nothing is waiting.
      assert.equal(scheduler.view().pendingAuto, undefined)
      assert.equal(wake.cleared, true)
      assert.equal(daily.cleared, false)
      assert.equal(scheduler.view().nextCheckAt, before.nextCheckAt)
      assert.deepEqual(scheduler.view().lastCheck, before.lastCheck)
      state.refuse = false
      clock = new Date('2026-03-02T04:00:00')
      wake.callback() // A callback queued before cancellation is inert too.
      assert.deepEqual(state.started, [])
      assert.equal(spy.armed.length, 3)
      // The daily timer still fires and re-arms; cancellation is not a policy edit.
      daily.callback()
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(state.started, [{ version: '0.5.0', trigger: 'auto' }])
      assert.equal(spy.armed.length, 4)
    } finally { scheduler.dispose(); spy.restore() }
  }
})

test('manual consider updates lastCheck without installing or parking', async () => {
  const spy = spyTimers()
  try {
    for (const window of [null, { start: '04:00', end: '05:00' }]) {
      const { state, scheduler } = harness()
      state.policy = { ...DEFAULT_POLICY, mode: 'auto', window }
      await scheduler.consider(PUBLISHED, { manual: true })
      assert.deepEqual(state.started, [])
      assert.equal(scheduler.view().pendingAuto, undefined)
      assert.deepEqual(scheduler.view().lastCheck, {
        at: new Date('2026-03-01T12:00:00').getTime(),
        updateAvailable: true, target: '0.5.0', latest: '0.5.0',
      })
      scheduler.dispose()
    }
    assert.equal(spy.armed.length, 0)
  } finally { spy.restore() }
})

test('manual consider leaves earlier automatic pending work unchanged', async () => {
  const spy = spyTimers()
  const { state, scheduler } = harness()
  state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '04:00', end: '05:00' } }
  try {
    await scheduler.consider(PUBLISHED)
    const pending = scheduler.view().pendingAuto
    const wake = spy.armed.at(-1)
    await scheduler.consider({ distTags: { latest: '0.7.0' }, versions: ['0.7.0'] }, { manual: true })
    assert.equal(scheduler.view().lastCheck.target, '0.7.0')
    assert.deepEqual(scheduler.view().pendingAuto, pending)
    assert.equal(spy.armed.at(-1), wake)
    assert.equal(wake.cleared, false)
    assert.deepEqual(state.started, [])
  } finally { scheduler.dispose(); spy.restore() }
})

test('policyChanged clears pending and invalidates even already-queued wake callbacks', async () => {
  const patches = [
    { mode: 'off' }, { mode: 'notify' }, { track: { kind: 'pin' } },
    { track: { kind: 'tag', tag: 'next' } }, { window: null }, { checkAt: '13:00' },
  ]
  for (const patch of patches) {
    const spy = spyTimers()
    const { state, scheduler } = harness()
    state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '04:00', end: '05:00' } }
    try {
      await scheduler.consider(PUBLISHED)
      const wake = spy.armed.at(-1)
      state.policy = { ...state.policy, ...patch }
      scheduler.policyChanged()
      assert.equal(scheduler.view().pendingAuto, undefined)
      assert.equal(wake.cleared, true)
      const count = spy.armed.length
      wake.callback()
      assert.equal(spy.armed.length, count, 'an invalidated callback cannot arm timers')
      assert.deepEqual(state.started, [])
    } finally { scheduler.dispose(); spy.restore() }
  }
})

test('window and busy wakes revalidate mode, track, and installed version without policyChanged', async () => {
  const changes = [
    state => { state.policy.mode = 'off' },
    state => { state.policy.mode = 'notify' },
    state => { state.policy.track = { kind: 'pin' } },
    state => { state.policy.track = { kind: 'tag', tag: 'next' } },
    state => { state.policy.track = { kind: 'line', range: '^0.4.0' } },
    state => { state.installed = '0.5.0' },
    state => { state.installed = '0.7.0' },
    state => { state.installed = undefined },
  ]
  for (const busy of [false, true]) for (const change of changes) {
    let clock = new Date('2026-03-01T03:00:00')
    const { state, scheduler } = harness({ now: () => clock })
    state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: busy ? null : { start: '04:00', end: '05:00' } }
    state.refuse = busy
    const spy = spyTimers()
    try {
      await scheduler.consider(PUBLISHED)
      const wake = spy.armed.at(-1)
      change(state)
      state.refuse = false
      clock = new Date('2026-03-01T04:00:00')
      wake.callback()
      assert.deepEqual(state.started, [])
      assert.equal(scheduler.view().pendingAuto, undefined)
      assert.equal(spy.armed.length, 1, 'a rejected finding does not retry forever')
    } finally { scheduler.dispose(); spy.restore() }
  }
})

test('new automatic facts clear an obsolete pending target and cancel its timer', async () => {
  const { state, scheduler } = harness()
  state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '04:00', end: '05:00' } }
  const spy = spyTimers()
  try {
    await scheduler.consider(PUBLISHED)
    const wake = spy.armed.at(-1)
    await scheduler.consider({ distTags: { latest: '0.4.2' }, versions: ['0.4.2'] })
    assert.equal(scheduler.view().pendingAuto, undefined)
    assert.equal(wake.cleared, true)
    wake.callback()
    assert.deepEqual(state.started, [])
  } finally { scheduler.dispose(); spy.restore() }
})

test('parked facts are saved independently of caller mutations and kept out of the view', async () => {
  let clock = new Date('2026-03-01T03:00:00')
  const { state, scheduler } = harness({ now: () => clock })
  state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '04:00', end: '05:00' } }
  const published = { distTags: { ...PUBLISHED.distTags }, versions: [...PUBLISHED.versions] }
  const spy = spyTimers()
  try {
    await scheduler.consider(published)
    assert.deepEqual(Object.keys(scheduler.view().pendingAuto), ['target', 'since'])
    published.distTags.latest = '0.4.2'
    published.versions.length = 0
    clock = new Date('2026-03-01T04:00:00')
    spy.armed.at(-1).callback()
    assert.deepEqual(state.started, [{ version: '0.5.0', trigger: 'auto' }])
  } finally { scheduler.dispose(); spy.restore() }
})

test('disposed registry generations cannot install, report errors, or re-arm after restart', async () => {
  for (const restart of [false, true]) for (const fail of [false, true]) {
    let settle
    const check = new Promise((resolve, reject) => { settle = () => fail ? reject(new Error('late failure')) : resolve(PUBLISHED) })
    const { state, scheduler } = harness({ check: () => check })
    state.policy = { ...DEFAULT_POLICY, mode: 'auto', checkAt: '03:00' }
    const spy = spyTimers()
    try {
      scheduler.start()
      spy.armed[0].callback()
      scheduler.dispose()
      if (restart) scheduler.start()
      const count = spy.armed.length
      settle()
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(state.started, [])
      assert.deepEqual(scheduler.view().lastCheck, {})
      assert.equal(scheduler.view().pendingAuto, undefined)
      assert.equal(spy.armed.length, count)
      if (!restart) assert.equal(scheduler.view().nextCheckAt, undefined)
    } finally { scheduler.dispose(); spy.restore() }
  }
})

test('policyChanged invalidates in-flight registry decisions even if auto is re-enabled', async () => {
  let finish
  const { state, scheduler } = harness({ check: () => new Promise(resolve => { finish = resolve }) })
  state.policy = { ...DEFAULT_POLICY, mode: 'auto' }
  const cycle = scheduler.runCycle()
  state.policy.mode = 'off'
  scheduler.policyChanged()
  state.policy.mode = 'auto'
  scheduler.policyChanged()
  finish(PUBLISHED)
  await cycle
  assert.deepEqual(state.started, [])
  assert.deepEqual(scheduler.view().lastCheck, {})
  scheduler.dispose()
})

test('disposed direct calls and stale timers are inert across restart', async () => {
  let checks = 0
  const { state, scheduler } = harness({ check: async () => { checks += 1; return PUBLISHED } })
  state.policy = { ...DEFAULT_POLICY, mode: 'auto', checkAt: '03:00' }
  state.refuse = true
  const spy = spyTimers()
  try {
    scheduler.start()
    await scheduler.consider(PUBLISHED)
    const oldTimers = [...spy.armed]
    const lastCheck = scheduler.view().lastCheck
    scheduler.dispose()
    await scheduler.consider(PUBLISHED)
    await scheduler.runCycle()
    assert.equal(checks, 0)
    assert.deepEqual(scheduler.view().lastCheck, lastCheck)
    assert.equal(scheduler.view().pendingAuto, undefined)
    scheduler.start()
    state.refuse = false
    const count = spy.armed.length
    oldTimers.forEach(timer => timer.callback())
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(state.started, [])
    assert.equal(checks, 0)
    assert.equal(spy.armed.length, count)
  } finally { scheduler.dispose(); spy.restore() }
})

test('an early daily timer consumes its occurrence and schedules tomorrow, not a zero-delay refire', async () => {
  let clock = new Date('2026-03-01T02:59:00')
  let checks = 0
  const { state, scheduler } = harness({ now: () => clock, check: async () => { checks += 1; return PUBLISHED } })
  state.policy.checkAt = '03:00'
  const spy = spyTimers()
  try {
    scheduler.start()
    const first = spy.armed[0]
    assert.equal(first.ms, 59_950)
    clock = new Date('2026-03-01T02:59:59.950')
    first.callback()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(checks, 1)
    assert.equal(spy.armed.length, 2)
    assert.equal(spy.armed[1].ms, 24 * 60 * 60 * 1000)
    assert.equal(scheduler.view().nextCheckAt, new Date('2026-03-02T03:00:00').getTime())
    scheduler.policyChanged()
    assert.equal(spy.armed.at(-1).ms, 24 * 60 * 60 * 1000, 'a policy rearm also skips the consumed occurrence')
    first.callback()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(checks, 1)
  } finally { scheduler.dispose(); spy.restore() }
})

/**
 * Scheduler tests: the pure decision pipeline driven through `runCycle` with
 * a fake clock — tracking resolution per mode, execution-window parking and
 * waking, error recording, and the ambient view the routes expose.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUTO_RETRY_MS, createScheduler } from '../lib/scheduler.js'
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
 * Wrap a harness so the scheduler arms its timers into a list instead of the
 * real clock. Two things become testable that are otherwise timing-dependent:
 * HOW FAR OUT a wake-up was armed (the difference between "wait for the window
 * opening" and "retry shortly"), and firing that exact timer, which is the only
 * way to reach the parked-install path without waiting for wall-clock time.
 * @param {() => { state: any; scheduler: any }} build - the harness factory.
 * @returns {{ state: any; scheduler: any; timers: { fn: () => void; ms: number }[]; fireLatest: () => Promise<void>; restore: () => void }} the harness with its armed timers captured.
 */
function captureTimers(build) {
  const timers = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = /** @type {any} */ ((fn, ms) => {
    timers.push({ fn, ms })
    return { unref() {} }
  })
  const live = build()
  return {
    ...live,
    timers,
    /** Fire the most recently armed timer and let its async tail run. */
    async fireLatest() {
      const timer = timers.pop()
      assert.notEqual(timer, undefined, 'the scheduler had a wake-up armed to fire')
      timers.length = 0
      timer.fn()
      await new Promise(resolve => { realSetTimeout(resolve, 20) })
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
    },
  }
}


test('manual checks record policy verdicts without installing or parking in auto mode', async (t) => {
  const { state, scheduler } = harness()
  t.after(() => scheduler.dispose())
  state.policy = { ...DEFAULT_POLICY, mode: 'auto' }
  const published = await scheduler.manualCheck()
  assert.deepEqual(published, PUBLISHED)
  assert.equal(scheduler.view().lastCheck.target, '0.5.0')
  assert.deepEqual(state.started, [])
  assert.equal(scheduler.view().pendingAuto, undefined)
  state.checkError = 'offline'
  await assert.rejects(scheduler.manualCheck(), /offline/)
  assert.equal(scheduler.view().lastCheck.error, 'offline')
})

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

// ---------------------------------------------------------------------------
// Parked installs
//
// A finding that could not install yet is re-validated when its wake-up fires,
// never replayed: it belongs to the policy that produced it. The tests below
// pin down both halves — that a policy which no longer wants the install
// cancels it, and that waiting for a window never turns into waiting forever.
// ---------------------------------------------------------------------------

test('a parked finding installs when its window opens under an unchanged policy', async () => {
  const clock = { at: new Date('2026-03-01T12:00:00') }
  const live = captureTimers(() => harness({ now: () => clock.at }))
  try {
    live.state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '04:00', end: '05:00' } }
    await live.scheduler.runCycle()
    assert.equal(live.scheduler.view().pendingAuto.target, '0.5.0')
    assert.ok(live.timers.at(-1).ms > AUTO_RETRY_MS, 'outside the window the wake is armed for the opening, not for a retry')

    clock.at = new Date('2026-03-01T04:30:00')
    await live.fireLatest()
    assert.deepEqual(live.state.started, [{ version: '0.5.0', trigger: 'auto' }])
    assert.equal(live.scheduler.view().pendingAuto, undefined, 'nothing stays parked once it installed')
  } finally {
    live.restore()
  }
})

test('turning automation off drops a parked finding instead of installing it later', async () => {
  const clock = { at: new Date('2026-03-01T12:00:00') }
  const live = captureTimers(() => harness({ now: () => clock.at }))
  try {
    live.state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '04:00', end: '05:00' } }
    await live.scheduler.runCycle()
    assert.equal(live.scheduler.view().pendingAuto.target, '0.5.0')

    // The user switches automation OFF while the finding waits for its window.
    live.state.policy = { ...DEFAULT_POLICY, mode: 'off', window: { start: '04:00', end: '05:00' } }
    live.scheduler.policyChanged()

    clock.at = new Date('2026-03-01T04:30:00')
    await live.fireLatest()
    assert.deepEqual(live.state.started, [], 'nothing installs once automation is off')
    assert.equal(live.scheduler.view().pendingAuto, undefined, 'the abandoned finding is dropped')
  } finally {
    live.restore()
  }
})

test('pinning the version drops a parked finding', async () => {
  const clock = { at: new Date('2026-03-01T12:00:00') }
  const live = captureTimers(() => harness({ now: () => clock.at }))
  try {
    live.state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '04:00', end: '05:00' } }
    await live.scheduler.runCycle()

    // Automation stays on, but the user pins the version: tracking no longer
    // names this target, so the waiting finding must not install.
    live.state.policy = { ...live.state.policy, track: { kind: 'pin' } }
    live.scheduler.policyChanged()

    clock.at = new Date('2026-03-01T04:30:00')
    await live.fireLatest()
    assert.deepEqual(live.state.started, [])
    assert.equal(live.scheduler.view().pendingAuto, undefined)
  } finally {
    live.restore()
  }
})

test('a window moved while a finding waited defers the install to the new opening', async () => {
  const clock = { at: new Date('2026-03-01T12:00:00') }
  const live = captureTimers(() => harness({ now: () => clock.at }))
  try {
    live.state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '04:00', end: '05:00' } }
    await live.scheduler.runCycle()

    live.state.policy = { ...live.state.policy, window: { start: '22:00', end: '23:00' } }
    live.scheduler.policyChanged()

    clock.at = new Date('2026-03-01T04:30:00') // the OLD window opening
    await live.fireLatest()
    assert.deepEqual(live.state.started, [], 'the install follows the window configured now')
    assert.equal(live.scheduler.view().pendingAuto.target, '0.5.0', 'the finding is still parked')
    assert.ok(live.timers.length > 0, 'a wake is armed for the new opening')
  } finally {
    live.restore()
  }
})

test('a refused auto install with no execution window retries shortly instead of never', async () => {
  const live = captureTimers(() => harness())
  try {
    live.state.policy = { ...DEFAULT_POLICY, mode: 'auto' } // window: null
    live.state.refuse = true // a manual install holds the slot
    await live.scheduler.runCycle()
    assert.equal(live.scheduler.view().pendingAuto.target, '0.5.0', 'the finding parks')
    assert.equal(live.timers.length, 1, 'a retry is armed even with no window to wait for')
    assert.equal(live.timers[0].ms, AUTO_RETRY_MS, 'the retry is a short wait, not the next window opening')

    live.state.refuse = false
    await live.fireLatest()
    assert.deepEqual(live.state.started, [{ version: '0.5.0', trigger: 'auto' }])
    assert.equal(live.scheduler.view().pendingAuto, undefined)
  } finally {
    live.restore()
  }
})

test('an in-window refusal retries in minutes rather than at the next opening', async () => {
  const live = captureTimers(() => harness({ now: () => new Date('2026-03-01T04:10:00') }))
  try {
    live.state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '04:00', end: '05:00' } }
    live.state.refuse = true
    await live.scheduler.runCycle()
    assert.equal(live.timers.at(-1).ms, AUTO_RETRY_MS, 'a refused in-window install does not wait for the next opening')

    live.state.refuse = false
    await live.fireLatest()
    assert.deepEqual(live.state.started, [{ version: '0.5.0', trigger: 'auto' }])
  } finally {
    live.restore()
  }
})

test('check timestamps and parked timestamps use the injected clock', async (t) => {
  const at = new Date('2026-03-01T12:00:00')
  const { state, scheduler } = harness({ now: () => at })
  t.after(() => scheduler.dispose())
  state.policy = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '04:00', end: '05:00' } }
  await scheduler.runCycle()
  assert.equal(scheduler.view().lastCheck.at, at.getTime())
  assert.equal(scheduler.view().pendingAuto.since, at.getTime())
  state.checkError = 'offline'
  await scheduler.runCycle()
  assert.equal(scheduler.view().lastCheck.at, at.getTime())
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

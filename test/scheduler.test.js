/**
 * Scheduler tests: the pure decision pipeline driven through `runCycle` with
 * a fake clock — tracking resolution per mode, execution-window parking and
 * waking, error recording, and the ambient view the routes expose.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createScheduler } from '../lib/scheduler.js'
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
 * @returns {{ armed: { callback: () => void; ms: number }[]; restore: () => void }} the recorder.
 */
function spyTimers() {
  /** @type {{ callback: () => void; ms: number }[]} */
  const armed = []
  const original = globalThis.setTimeout
  globalThis.setTimeout = /** @type {any} */ ((/** @type {Function} */ callback, /** @type {number} */ ms) => {
    armed.push({ callback: () => callback(), ms })
    // Unreffed on purpose: a far-future dummy must never hold the test process
    // open if a case forgets to dispose its scheduler.
    const dummy = original(() => {}, 10 ** 9)
    dummy.unref?.()
    return dummy
  })
  return { armed, restore: () => { globalThis.setTimeout = original } }
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
    armed.push(fn)
    // A far-future dummy: the re-armed timer must never actually fire here.
    const timer = originalSetTimeout(() => {}, 10 ** 9)
    timer.unref?.()
    return timer
  }
  globalThis.setTimeout = /** @type {any} */ (spy)
  try {
    scheduler.start()
    assert.equal(armed.length, 1, 'start armed the daily check exactly once')
    armed[0]() // the scheduled moment arrives
    // Drain every microtask the cycle and its re-arm produce.
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(state.started, [{ version: '0.5.0', trigger: 'auto' }], 'the scheduled cycle installed silently')
    assert.equal(armed.length, 2, 'the fired check re-armed the next occurrence instead of falling silent')
  } finally {
    globalThis.setTimeout = originalSetTimeout
    scheduler.dispose()
  }
})

test('consider decides from pre-fetched facts, so a check can trigger the install without any timer', async () => {
  const { state, scheduler } = harness()
  state.policy.mode = 'auto'
  await scheduler.consider(PUBLISHED)
  assert.deepEqual(state.started, [{ version: '0.5.0', trigger: 'auto' }])
  assert.equal(scheduler.view().lastCheck.updateAvailable, true)
  assert.equal(scheduler.view().lastCheck.target, '0.5.0')
})

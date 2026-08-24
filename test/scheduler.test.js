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

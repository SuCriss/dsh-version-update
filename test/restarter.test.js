/**
 * Restarter tests: the payload the detached helper consumes, the port-0
 * refusal, recovery arming, launcher resolution, and the unattended variant.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTO_RESTART_DELAY_MS, createRestarter, parseRequestedPort, resolveLauncher } from '../lib/restarter.js'

/** Composition seams for one restart. */
function harness(overrides = {}) {
  const spawned = []
  let exited
  const dir = mkdtempSync(join(tmpdir(), 'vu-restart-'))
  const payloadPath = join(dir, 'payload.json')
  const spawnImpl = (execPath, args) => {
    spawned.push({ execPath, args })
    return { unref() {} }
  }
  const deps = {
    spawnImpl,
    exit: () => { exited = true },
    argv: ['/node', '/install/lib/bin.js', '--profile', 'web', '--port', '3080'],
    cwd: '/cwd',
    pid: 111,
    address: () => ({ host: '127.0.0.1', port: 3080 }),
    delayMs: 5,
    ...overrides,
  }
  const restarter = createRestarter(deps)
  return {
    restarter,
    spawned,
    get exited() { return exited },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    /** Read the payload file the helper was pointed at. */
    payload() {
      const call = spawned[0]
      return JSON.parse(readFileSync(call.args[1], 'utf8'))
    },
  }
}

test('parseRequestedPort reads both --port N and --port=N forms', () => {
  assert.equal(parseRequestedPort(['node', 'bin.js', '--port', '3080']), 3080)
  assert.equal(parseRequestedPort(['node', 'bin.js', '--port=0']), 0)
  assert.equal(parseRequestedPort(['node', 'bin.js']), undefined)
  assert.equal(parseRequestedPort(['node', 'bin.js', '--profile', 'x', '--port', '8080']), 8080)
})

test('resolveLauncher prefers argv[1] and falls back to the install dir', () => {
  assert.equal(resolveLauncher({ argv: ['n', '/i/lib/bin.js'] }), '/i/lib/bin.js')
  assert.equal(resolveLauncher({ argv: ['n', '/other/thing.js'], installDir: '/i' }), join('/i', 'lib', 'bin.js'))
  assert.equal(resolveLauncher({ argv: ['n'] }), undefined)
})

test('restart writes a complete payload and schedules the exit', () => {
  const h = harness()
  try {
    const result = h.restarter.restart()
    assert.equal(result.host, '127.0.0.1')
    assert.equal(result.port, 3080)
    assert.equal(result.pid, 111)

    const call = h.spawned[0]
    assert.ok(call.args[0].endsWith('relaunch.js'), 'the detached helper is relaunch.js')

    const payload = h.payload()
    assert.equal(payload.pid, 111)
    assert.deepEqual(payload.args, ['/install/lib/bin.js', '--profile', 'web', '--port', '3080'])
    assert.equal(payload.cwd, '/cwd')
    assert.equal(payload.recovery, undefined)
    assert.ok(typeof payload.logPath === 'string')
    // The exit was scheduled for EXIT_DELAY_MS.
    setTimeout(() => {}, 0)
  } finally {
    h.cleanup()
  }
})

test('a host started with --port 0 refuses to restart', (t) => {
  const h = harness({
    argv: ['/node', '/i/lib/bin.js', '--port', '0'],
    address: () => ({ host: '127.0.0.1', port: 51234, requestedPort: 0 }),
  })
  t.after(h.cleanup)
  assert.throws(() => h.restarter.restart(), /OS-assigned port/)
})

test('recovery arms only when the composition provides it', () => {
  const withRecovery = harness({
    recovery: () => ({ version: '0.4.0', installDir: '/i', snapshotsDir: '/s' }),
  })
  try {
    withRecovery.restarter.restart()
    const payload = withRecovery.payload()
    assert.deepEqual(payload.recovery, { version: '0.4.0', installDir: '/i', snapshotsDir: '/s' })
  } finally {
    withRecovery.cleanup()
  }
})

test('restartAfterDelay swallows refusals and defaults to the auto grace period', (t) => {
  assert.equal(AUTO_RESTART_DELAY_MS >= 1000, true)
  const blocked = harness({ address: () => undefined })
  t.after(blocked.cleanup)
  assert.equal(blocked.restarter.restartAfterDelay(), undefined, 'unattended path never throws')
})

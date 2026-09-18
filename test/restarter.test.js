/**
 * Restarter tests: the payload the detached helper consumes, the port-0
 * refusal, recovery arming, launcher resolution, and the single entry point —
 * restart is only ever a live page asking.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRestarter, parseRequestedPort, replacementSpawnOptions, resolveLauncher } from '../lib/restarter.js'

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
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true })
    },
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

test('replacement spawn options keep a hidden inheritable console on Windows', () => {
  const win = replacementSpawnOptions({ platform: 'win32', cwd: '/cwd', stdio: ['ignore', 5, 6] })
  assert.equal(win.detached, undefined, 'DETACHED_PROCESS leaves the replacement console-less, and its descendants then pop visible consoles')
  assert.equal(win.windowsHide, true, 'CREATE_NO_WINDOW gives the replacement a real hidden console the tree inherits')
  assert.equal(win.cwd, '/cwd')
  assert.deepEqual(win.stdio, ['ignore', 5, 6])
})

test('replacement spawn options keep setsid daemonization on POSIX', () => {
  for (const platform of ['darwin', 'linux']) {
    const posix = replacementSpawnOptions({ platform, cwd: '/cwd', stdio: 'ignore' })
    assert.equal(posix.detached, true, `${platform}: setsid remains the daemonization convention`)
    assert.equal(posix.windowsHide, true, 'harmless no-op off Windows')
    assert.equal(posix.cwd, '/cwd')
  }
})

test('restartCommand overrides the inherited command line verbatim', () => {
  const h = harness({
    restartCommand: {
      execPath: '/usr/bin/electron',
      args: ['/opt/DeepSeek', '--dsh-port', '3080'],
      cwd: '/opt',
    },
  })
  try {
    h.restarter.restart()
    const payload = h.payload()
    assert.deepEqual(payload.args, ['/opt/DeepSeek', '--dsh-port', '3080'], 'explicit args pass through untouched')
    assert.equal(payload.execPath, '/usr/bin/electron')
    assert.equal(payload.cwd, '/opt', 'restartCommand.cwd wins over deps.cwd')
  } finally {
    h.cleanup()
  }
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

test('arm is idempotent: a second handoff reuses the first result', (t) => {
  const h = harness()
  t.after(h.cleanup)
  const first = h.restarter.restart()
  const second = h.restarter.restart()
  assert.equal(h.spawned.length, 1, 'one detached helper per process, however often restart is asked')
  assert.deepEqual(second, first, 'the second caller gets the first handoff back')
})

test('a refused restart throws and arms nothing', (t) => {
  const h = harness({ address: () => undefined })
  t.after(h.cleanup)
  assert.throws(() => h.restarter.restart(), /cannot|address|port/i)
  assert.equal(h.spawned.length, 0, 'no detached helper without a handoff')
})

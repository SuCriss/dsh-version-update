/**
 * Restart-handoff tests: launcher resolution, the refusals that keep a
 * replacement from being started where it could never be found again, the
 * payload the detached helper reads, and the scheduled exit.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { after, test } from 'node:test'

import { RELAUNCH_SCRIPT, createRestarter, parseRequestedPort, resolveLauncher } from '../lib/restarter.js'

/**
 * Temp directories the restarter created for its payloads. The real relauncher
 * consumes and deletes them; these tests never run it, so the suite removes
 * them itself rather than leaving payload files behind in the temp directory.
 */
const payloadDirs = new Set()

after(() => {
  for (const dir of payloadDirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * Build a restarter over fake spawn/exit seams.
 * @param {object} [overrides] - deps to override.
 * @returns {{ restarter: object; calls: object[]; exits: number[] }} the harness.
 */
function harness(overrides = {}) {
  const calls = []
  const exits = []
  const restarter = createRestarter({
    argv: ['/usr/bin/node', '/opt/dsh/lib/bin.js', '--profile', 'web', '--port', '5173'],
    cwd: '/work',
    execPath: '/usr/bin/node',
    pid: 4242,
    address: () => ({ host: '127.0.0.1', port: 5173, requestedPort: 5173 }),
    delayMs: 1,
    exit: code => { exits.push(code) },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      if (typeof args[1] === 'string') payloadDirs.add(dirname(args[1]))
      return { unref: () => {} }
    },
    ...overrides,
  })
  return { restarter, calls, exits }
}

test('the shipped relauncher exists beside the restarter', () => {
  assert.ok(existsSync(RELAUNCH_SCRIPT), RELAUNCH_SCRIPT)
})

test('parseRequestedPort reads the port this invocation asked for', () => {
  assert.equal(parseRequestedPort(['node', 'bin.js', '--port', '8080']), 8080)
  assert.equal(parseRequestedPort(['node', 'bin.js', '--port=8080']), 8080)
  assert.equal(parseRequestedPort(['node', 'bin.js', '--profile', 'web', '--port', '0']), 0)
  assert.equal(parseRequestedPort(['node', 'bin.js', '--port=0']), 0)
})

test('parseRequestedPort reports an absent or unusable flag as unknown', () => {
  assert.equal(parseRequestedPort(['node', 'bin.js', '--profile', 'web']), undefined)
  assert.equal(parseRequestedPort(['node', 'bin.js', '--port']), undefined)
  assert.equal(parseRequestedPort(['node', 'bin.js', '--port', 'auto']), undefined)
  // `--port` as a value of some other flag must not be read as our flag.
  assert.equal(parseRequestedPort([]), undefined)
})

test('resolveLauncher uses argv[1] when it is a dsh launcher', () => {
  assert.equal(
    resolveLauncher({ argv: ['/usr/bin/node', '/opt/dsh/lib/bin.js'] }),
    '/opt/dsh/lib/bin.js',
    'after an update the same path already holds the new code',
  )
})

test('resolveLauncher rebuilds the entry when argv[1] is not a launcher', () => {
  const launcher = resolveLauncher({
    argv: ['/usr/bin/node', '/embedder/server.js'],
    installDir: '/opt/dsh',
  })
  assert.equal(launcher?.replaceAll('\\', '/'), '/opt/dsh/lib/bin.js')
})

test('resolveLauncher reports the entry as unknown when it cannot be derived', () => {
  assert.equal(resolveLauncher({ argv: ['/usr/bin/node', '/embedder/server.js'] }), undefined)
  assert.equal(resolveLauncher({ argv: [] }), undefined)
})

test('restart writes the payload, spawns the detached helper, and schedules the exit', async () => {
  const { restarter, calls, exits } = harness()
  const result = restarter.restart()

  assert.deepEqual(
    { host: result.host, port: result.port, pid: result.pid, launcher: result.launcher },
    { host: '127.0.0.1', port: 5173, pid: 4242, launcher: '/opt/dsh/lib/bin.js' },
    'the panel is told exactly where the replacement will answer',
  )

  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.command, '/usr/bin/node')
  assert.equal(call.args[0], RELAUNCH_SCRIPT)
  assert.equal(call.options.detached, true, 'the helper must outlive this process')
  assert.equal(call.options.windowsHide, true)
  assert.equal(call.options.stdio, 'ignore')

  const payload = JSON.parse(readFileSync(call.args[1], 'utf8'))
  assert.deepEqual(payload, {
    pid: 4242,
    host: '127.0.0.1',
    port: 5173,
    execPath: '/usr/bin/node',
    // Every flag this invocation carried comes back, so the replacement serves
    // the same profile, port, and overlays.
    args: ['/opt/dsh/lib/bin.js', '--profile', 'web', '--port', '5173'],
    cwd: '/work',
    logPath: result.logPath,
  })

  assert.deepEqual(exits, [], 'the response goes out before the process leaves')
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.deepEqual(exits, [0])
})

test('restart refuses when the listening address is unknown', () => {
  const { restarter, calls } = harness({ address: () => undefined })
  assert.throws(() => restarter.restart(), /listening address is unknown/)
  assert.equal(calls.length, 0)
})

test('restart refuses an OS-assigned port', () => {
  // The replacement would bind a different port and the panel could never find
  // it again, so this must fail loudly instead of stranding the user.
  const { restarter, calls } = harness({ address: () => ({ host: '127.0.0.1', port: 0, requestedPort: 0 }) })
  assert.throws(() => restarter.restart(), /OS-assigned port/)
  assert.equal(calls.length, 0)
})

test('restart judges the port the invocation asked for, not the one it got', () => {
  // The regression this guards: `webServer.port` is the RESOLVED port, so a
  // host started with `--port 0` is listening on a real number. Judging that
  // number would arm a handoff whose replacement binds somewhere else, exit
  // this process, and leave the page polling an address nothing answers on.
  const { restarter, calls } = harness({
    argv: ['/usr/bin/node', '/opt/dsh/lib/bin.js', '--profile', 'web', '--port', '0'],
    address: () => ({ host: '127.0.0.1', port: 54321, requestedPort: 0 }),
  })
  assert.throws(() => restarter.restart(), /OS-assigned port/)
  assert.equal(calls.length, 0, 'nothing was spawned and this host stays alive')
})

test('restart accepts a fixed port even without an explicit requestedPort', () => {
  // An embedder that reports only the bound address still gets a restart when
  // that address is a real, reproducible port.
  const { restarter, calls } = harness({ address: () => ({ host: '127.0.0.1', port: 3080 }) })
  const result = restarter.restart()
  assert.equal(result.port, 3080)
  assert.equal(calls.length, 1)
})

test('restart refuses when the launcher entry cannot be resolved', () => {
  const { restarter, calls } = harness({
    argv: ['/usr/bin/node', '/embedder/server.js'],
    installDir: () => undefined,
  })
  assert.throws(() => restarter.restart(), /launcher entry could not be resolved/)
  assert.equal(calls.length, 0)
})

test('a refused restart never leaves the host scheduled to exit', async () => {
  const { restarter, exits } = harness({ address: () => undefined })
  assert.throws(() => restarter.restart())
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.deepEqual(exits, [])
})

/**
 * End-to-end tests for the detached relaunch helper: it is run as a real child
 * process against a real payload, with its wait budgets shortened through the
 * payload's `timeouts` seam. What is under test is the part no fake can stand
 * in for — the helper is the only thing that outlives the exiting host, so a
 * wrong decision here is a machine that stays down.
 *
 * Assertions read the helper's own log file, which is the only channel it has.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeAddress, RELAUNCH_SCRIPT } from '../lib/restarter.js'

/** The tiny program the helper relaunches: live for `ms`, then exit. */
const REPLACEMENT = (ms, port) => `require('node:net').createServer().listen(${port},'127.0.0.1');setTimeout(() => process.exit(0), ${String(ms)})`

/** A process that holds nothing and exits after `ms`. */
const SLEEPER = ms => `setTimeout(() => process.exit(0), ${String(ms)})`

/**
 * One occupied loopback port, released by the test when it wants.
 * @returns {Promise<{ port: number; release: () => Promise<void> }>} the port and its closer.
 */
function occupyPort() {
  const server = createServer()
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
      resolve({
        port,
        release: () => new Promise(done => { server.close(() => { done() }) }),
      })
    })
  })
}

/**
 * Run the helper as its own process and return once it is gone.
 * @param {import('node:test').TestContext} t - for cleanup registration.
 * @param {Record<string, unknown>} payload - everything but `logPath`, which is arranged here.
 * @returns {Promise<{ code: number | null; signal: string | null; log: string }>} the outcome and the helper's log.
 */
async function runHelper(t, payload) {
  const dir = mkdtempSync(join(tmpdir(), 'vu-relaunch-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const logPath = join(dir, 'restart.log')
  writeFileSync(logPath, '', 'utf8')
  const payloadPath = join(dir, 'payload.json')
  writeFileSync(payloadPath, JSON.stringify({ ...payload, logPath }), 'utf8')
  const child = spawn(process.execPath, [RELAUNCH_SCRIPT, payloadPath], { stdio: 'ignore', windowsHide: true })
  // A helper on Windows supervises its replacement for the host's whole
  // lifetime, so a test that ends early must take the supervisor down.
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  })
  const [code, signal] = await new Promise(resolve => { child.once('exit', (c, s) => { resolve([c, s]) }) })
  return { code, signal: signal ?? null, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '' }
}

test('the port release wait gets its own budget, not what the pid wait left over', async (t) => {
  const occupied = await occupyPort()
  const dir = mkdtempSync(join(tmpdir(), 'vu-relaunch-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  // The old host is slow to die, and the port it held is released later still.
  // One shared deadline made the second wait run out inside the first's tail:
  // the helper gave up on a handoff that was about to succeed, and the host
  // simply never came back.
  const sleeper = spawn(process.execPath, ['-e', SLEEPER(600)], { stdio: 'ignore', windowsHide: true })
  t.after(() => { if (sleeper.exitCode === null && sleeper.signalCode === null) { sleeper.kill() } })
  setTimeout(() => { void occupied.release() }, 1800)

  const outcome = await runHelper(t, {
    pid: sleeper.pid,
    host: '0.0.0.0',
    port: occupied.port,
    execPath: process.execPath,
    args: ['-e', REPLACEMENT(300, occupied.port)],
    cwd: dir,
    timeouts: { waitMs: 1500, settleMs: 20, probeIntervalMs: 40, replacementProbeMs: 1500, recoveryProbeMs: 300 },
  })
  assert.doesNotMatch(outcome.log, /giving up/, JSON.stringify(outcome))
  assert.match(outcome.log, /started pid/, 'the replacement was launched')
  // The payload names where the host LISTENED; a wildcard is not dialable, so
  // every probe has to go to loopback instead. Probing the bind address reads
  // as "nothing is there", which starts the replacement too early — and with
  // recovery armed, rolls back a host that is answering fine.
  assert.match(outcome.log, /probing 127\.0\.0\.1/, 'the probe address is normalized')
  assert.equal(outcome.signal, null)
  assert.equal(outcome.code, 0, `helper exited cleanly, log was:\n${outcome.log}`)
})

test('an armed recovery leaves a replacement that answers alone', async (t) => {
  const occupied = await occupyPort()
  await occupied.release()
  const dir = mkdtempSync(join(tmpdir(), 'vu-relaunch-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const outcome = await runHelper(t, {
    pid: 999999, // nothing is there: the pid wait is satisfied immediately
    host: '127.0.0.1',
    port: occupied.port,
    execPath: process.execPath,
    args: ['-e', REPLACEMENT(1200, occupied.port)],
    cwd: dir,
    recovery: { version: '9.9.9', installDir: dir, snapshotsDir: join(dir, 'no-snapshots') },
    timeouts: { waitMs: 200, settleMs: 20, probeIntervalMs: 40, replacementProbeMs: 4000, recoveryProbeMs: 300 },
  })
  assert.match(outcome.log, /update stands/, JSON.stringify(outcome))
  assert.doesNotMatch(outcome.log, /restoring snapshot/, 'a healthy replacement is not rolled back')
  // There is no snapshot of 9.9.9 in this fixture anyway: had it tried, the
  // restore itself would have failed loudly.
  assert.doesNotMatch(outcome.log, /snapshot restore failed/)
  assert.equal(outcome.code, 0)
})

test('an armed recovery rolls back a replacement that never answers', async (t) => {
  const occupied = await occupyPort()
  await occupied.release()
  const dir = mkdtempSync(join(tmpdir(), 'vu-relaunch-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const outcome = await runHelper(t, {
    pid: 999999,
    host: '127.0.0.1',
    port: occupied.port,
    execPath: process.execPath,
    // The "broken" replacement: exits at once and binds nothing, so the port
    // never answers within the probe window.
    args: ['-e', 'process.exit(0)'],
    cwd: dir,
    recovery: { version: '9.9.9', installDir: dir, snapshotsDir: join(dir, 'no-snapshots') },
    timeouts: { waitMs: 200, settleMs: 20, probeIntervalMs: 40, replacementProbeMs: 600, recoveryProbeMs: 300 },
  })
  assert.match(outcome.log, /replacement never became ready; restoring snapshot of 9\.9\.9/, JSON.stringify(outcome))
  // The rollback itself cannot be completed in this fixture (no snapshot), and
  // the helper must say so rather than start a second broken host.
  assert.match(outcome.log, /snapshot restore failed/)
  assert.doesNotMatch(outcome.log, /restarting on the recovered version/)
  assert.equal(outcome.code, 1, 'a recovery that cannot restore is reported as a failure')
})

/**
 * The payload the restarter writes names where the host LISTENED, and a
 * wildcard bind is not an address anything can be dialled as: this table is the
 * helper's only defense against probing a server that is answering fine and
 * concluding the restart failed.
 */
test('a wildcard bind host is probed as loopback, a specific one as itself', () => {
  const cases = [
    ['0.0.0.0', '127.0.0.1'],
    ['*', '127.0.0.1'],
    ['', '127.0.0.1'],
    ['::', '::1'],
    ['[::]', '::1'],
    ['  0.0.0.0  ', '127.0.0.1'],
    ['127.0.0.1', '127.0.0.1'],
    ['localhost', 'localhost'],
    // A host bound to a real interface address is reachable on it: rewriting
    // that to loopback would probe a server that is not there.
    ['192.168.1.20', '192.168.1.20'],
    ['0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:1'],
  ]
  for (const [bound, dialed] of cases) {
    assert.equal(probeAddress(bound), dialed, `bind ${JSON.stringify(bound)} is dialed as ${dialed}`)
  }
})

test('a consumed payload cannot relaunch anything twice', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vu-relaunch-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const logPath = join(dir, 'restart.log')
  const payloadPath = join(dir, 'payload.json')
  writeFileSync(payloadPath, JSON.stringify({
    pid: 999999, host: '127.0.0.1', port: 1, execPath: process.execPath, args: ['-e', 'process.exit(0)'], cwd: dir, logPath,
    timeouts: { waitMs: 10, settleMs: 5, probeIntervalMs: 5 },
  }), 'utf8')
  const first = await new Promise(resolve => {
    const child = spawn(process.execPath, [RELAUNCH_SCRIPT, payloadPath], { stdio: 'ignore', windowsHide: true })
    t.after(() => { if (child.exitCode === null && child.signalCode === null) { child.kill() } })
    child.once('exit', code => { resolve(code) })
  })
  assert.equal(first, 0, 'the first run consumed the payload and relaunched')
  assert.equal(existsSync(payloadPath), false, 'the payload is gone: nothing can replay this command line')
  // A second run has no file to read, so it refuses instead of relaunching.
  const second = await new Promise(resolve => {
    const child = spawn(process.execPath, [RELAUNCH_SCRIPT, payloadPath], { stdio: 'ignore', windowsHide: true })
    child.once('exit', code => { resolve(code) })
  })
  assert.equal(second, 2, 'a missing payload is a refusal, not a relaunch')
})

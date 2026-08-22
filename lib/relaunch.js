/**
 * Detached relauncher for the version-update restart route.
 *
 * `dsh web` cannot restart itself in place: the new process must bind the same
 * port the old one still holds, so someone has to outlive the exiting host.
 * This script is that someone — the host spawns it detached, exits, and this
 * process waits for the old pid to disappear and the port to free before
 * starting the replacement and exiting itself.
 *
 * It takes exactly one argument: the path of a JSON payload file written by the
 * host. Passing the command line through a file rather than argv keeps Windows
 * quoting out of the picture and lets the payload be deleted immediately, so a
 * stale file can never relaunch anything later.
 * @module dsh-version-update/relaunch
 */

import { spawn } from 'node:child_process'
import { appendFileSync, openSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'

/** How long to wait for the old host to exit and release the port. */
const WAIT_TIMEOUT_MS = 30_000

/** Gap between liveness probes while waiting. */
const PROBE_INTERVAL_MS = 200

/** Extra settling time after the port stops answering, before the new bind. */
const SETTLE_MS = 400

/**
 * Append one diagnostic line to the restart log.
 * @param {string} logPath - the log file path.
 * @param {string} line - the message.
 */
function log(logPath, line) {
  try {
    appendFileSync(logPath, `[${new Date().toISOString()}] relaunch: ${line}\n`)
  } catch {
    // The log is a convenience for diagnosing a failed restart; an unwritable
    // temp directory must not abort the restart itself.
  }
}

/**
 * Sleep for a fixed delay.
 * @param {number} ms - milliseconds.
 * @returns {Promise<void>} resolves after the delay.
 */
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Whether a pid is still alive. Signal 0 performs the permission and existence
 * check without delivering a signal.
 * @param {number} pid - the process id.
 * @returns {boolean} true while the process exists.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists but belongs to another user; only ESRCH is
    // proof that it is gone.
    return /** @type {NodeJS.ErrnoException} */ (error)?.code === 'EPERM'
  }
}

/**
 * Whether something still accepts connections on an address.
 * @param {string} host - the bind host.
 * @param {number} port - the port.
 * @returns {Promise<boolean>} true while a connection succeeds.
 */
function isPortBusy(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    /** @param {boolean} busy - whether the port answered. */
    const finish = (busy) => {
      socket.destroy()
      resolve(busy)
    }
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
    socket.setTimeout(1000, () => { finish(false) })
  })
}

/**
 * Wait until a predicate reports the resource is free, or the deadline passes.
 * @param {() => boolean | Promise<boolean>} busy - reports whether the resource is still held.
 * @param {number} deadline - epoch ms after which waiting stops.
 * @returns {Promise<boolean>} true when the resource became free in time.
 */
async function waitUntilFree(busy, deadline) {
  for (;;) {
    if (!(await busy())) return true
    if (Date.now() >= deadline) return false
    await sleep(PROBE_INTERVAL_MS)
  }
}

const payloadPath = process.argv[2]
if (payloadPath === undefined) {
  process.stderr.write('relaunch: missing payload path\n')
  process.exit(2)
}

const payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
// Consume the payload before doing anything else: it names a command line, and
// nothing should be able to replay it.
rmSync(payloadPath, { force: true })

const logPath = payload.logPath
log(logPath, `waiting for pid ${String(payload.pid)} and ${payload.host}:${String(payload.port)}`)

const deadline = Date.now() + WAIT_TIMEOUT_MS
const exited = await waitUntilFree(() => isAlive(payload.pid), deadline)
const freed = await waitUntilFree(() => isPortBusy(payload.host, payload.port), deadline)
if (!exited || !freed) {
  log(logPath, `giving up: pidExited=${String(exited)} portFree=${String(freed)}`)
  process.exit(1)
}
await sleep(SETTLE_MS)

/**
 * Where the replacement's own output goes: appended to the handoff log when it
 * can be opened, discarded otherwise.
 * @type {import('node:child_process').StdioOptions}
 */
let stdio = 'ignore'
try {
  const fd = openSync(logPath, 'a')
  stdio = ['ignore', fd, fd]
} catch {
  // Without a writable log the replacement still starts; only its output is lost.
}

log(logPath, `starting ${payload.execPath} ${payload.args.join(' ')}`)
const child = spawn(payload.execPath, payload.args, {
  cwd: payload.cwd,
  detached: true,
  windowsHide: true,
  stdio,
})
child.unref()
log(logPath, `started pid ${String(child.pid ?? 0)}`)
process.exit(0)

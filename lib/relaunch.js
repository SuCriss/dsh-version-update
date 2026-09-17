/**
 * Detached relauncher for the version-update restart route.
 *
 * `dsh web` cannot restart itself in place: the new process must bind the same
 * port the old one still holds, so someone has to outlive the exiting host.
 * This script is that someone — the host spawns it detached, exits, and this
 * process waits for the old pid to disappear and the port to free before
 * starting the replacement.
 *
 * It takes exactly one argument: the path of a JSON payload file written by the
 * host. Passing the command line through a file rather than argv keeps Windows
 * quoting out of the picture and lets the payload be deleted immediately, so a
 * stale file can never relaunch anything later. The payload names the pid to
 * wait out, the port to wait for, and optionally `timeouts` — shorter budgets
 * for the tests that drive this helper end to end.
 *
 * Both waits are probes of a port, and a port is dialled, not bound: the payload
 * carries the host's BIND address, which for a wildcard bind (`0.0.0.0`, `[::]`)
 * is not an address anything can be reached on. The helper normalizes it to
 * loopback before dialing (see {@link probeAddress}) — a probe that can never
 * connect would otherwise have the helper bind over a live server, or roll back
 * a replacement that was working fine.
 *
 * Lifetime differs by platform. On POSIX the replacement is setsid-detached
 * and survives this helper's exit, so the helper exits right after the spawn.
 * On Windows the replacement is deliberately NOT detached — DETACHED_PROCESS
 * would leave it without a console, and its descendants would pop visible
 * "node.exe" consoles on every later spawn — but Node kills non-detached
 * children when their parent exits, so there this helper stays alive as the
 * replacement's supervisor for the host's whole lifetime, invisible, and goes
 * away only when the host exits.
 *
 * When the payload arms `recovery`, the helper additionally waits long enough
 * to know whether the update actually succeeded. A replacement that never
 * answers within the probe window gets rolled back to the SNAPSHOT of the
 * previous version — a local copy operation, no npm and no network — and the
 * recovered tree is started in its place.
 * @module dsh-version-update/relaunch
 */

import { spawn } from 'node:child_process'
import { appendFileSync, openSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { restoreSnapshot } from './snapshot.js'
import { probeAddress, replacementSpawnOptions } from './restarter.js'

/** How long to wait for the old host to exit, and — separately — for the port to free. */
const WAIT_TIMEOUT_MS = 30_000

/** Gap between liveness probes while waiting. */
const PROBE_INTERVAL_MS = 200

/** Extra settling time after the port stops answering, before the new bind. */
const SETTLE_MS = 400

/**
 * How long to wait for the replacement to become reachable before declaring
 * the update broken — only when recovery is armed in the payload.
 */
const REPLACEMENT_PROBE_MS = 60_000

/** How long the recovered replacement gets after a snapshot rollback. */
const RECOVERY_PROBE_MS = 30_000

/**

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
 *
 * The dial timeout follows the probe cadence rather than being fixed: a
 * half-second wait must not be decided by a one-second connect timeout, and a
 * test that shortens the cadence shortens this with it. At the shipped interval
 * this is the 1000 ms it has always been.
 * @param {string} host - the address to dial (a dialable one — see {@link probeAddress}).
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
    socket.setTimeout(Math.max(50, PROBE * 5), () => { finish(false) })
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
    await sleep(PROBE)
  }
}

const payloadPath = process.argv[2]
if (payloadPath === undefined) {
  process.stderr.write('relaunch: missing payload path\n')
  process.exit(2)
}

let payload
try {
  payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
} catch (error) {
  process.stderr.write(`relaunch: invalid payload: ${String(error)}\n`)
  rmSync(payloadPath, { force: true })
  process.exit(2)
}
// Consume the payload before doing anything else: it names a command line, and
// nothing should be able to replay it.
rmSync(payloadPath, { force: true })

/**
 * The wait budgets the helper actually uses: the payload's `timeouts` override,
 * or the constants above.
 *
 * The payload is a private file between two modules of this plugin, consumed the
 * moment it is read, so nothing but a test ever puts `timeouts` in it. A test
 * that drives this helper end to end cannot sit through a thirty-second timeout
 * it is only trying to prove it handles correctly.
 * @type {{ waitMs?: number; settleMs?: number; probeIntervalMs?: number; replacementProbeMs?: number; recoveryProbeMs?: number }}
 */
const timeoutOverrides = typeof payload.timeouts === 'object' && payload.timeouts !== null
  ? /** @type {{ waitMs?: number; settleMs?: number; probeIntervalMs?: number; replacementProbeMs?: number; recoveryProbeMs?: number }} */ (payload.timeouts)
  : {}

/**
 * One override or the default.
 * @param {number | undefined} value - the payload's override, when it carried one.
 * @param {number} fallback - the shipped constant.
 * @returns {number} the milliseconds to wait.
 */
const budget = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback)

const WAIT = budget(timeoutOverrides.waitMs, WAIT_TIMEOUT_MS)
const SETTLE = budget(timeoutOverrides.settleMs, SETTLE_MS)
const PROBE = budget(timeoutOverrides.probeIntervalMs, PROBE_INTERVAL_MS)
const REPLACEMENT_READY = budget(timeoutOverrides.replacementProbeMs, REPLACEMENT_PROBE_MS)
const RECOVERY_READY = budget(timeoutOverrides.recoveryProbeMs, RECOVERY_PROBE_MS)

/**
 * Where to dial for the port. The payload carries the BIND address, which is not
 * always a dialable one — see {@link probeAddress}.
 */
const probeHost = probeAddress(payload.host)

const logPath = payload.logPath
log(logPath, `waiting for pid ${String(payload.pid)} and ${payload.host}:${String(payload.port)} (probing ${probeHost})`)

// TWO budgets, not one. The old host exiting and the port it held being
// released are sequential waits — the second cannot even be measured until the
// first is true — so sharing a single deadline gave whichever waited last
// whatever the first had not used. A host that took most of the budget to die
// left the port wait a few hundred milliseconds, and the helper abandoned a
// handoff that was about to succeed: no replacement at all, host gone.
const exited = await waitUntilFree(() => isAlive(payload.pid), Date.now() + WAIT)
const freed = await waitUntilFree(() => isPortBusy(probeHost, payload.port), Date.now() + WAIT)
if (!exited || !freed) {
  log(logPath, `giving up: pidExited=${String(exited)} portFree=${String(freed)}`)
  process.exit(1)
}
await sleep(SETTLE)

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

/** Spawn the replacement and detach. @returns {import('node:child_process').ChildProcess | undefined} the child (undefined when the spawn threw). */
const launchReplacement = () => {
  log(logPath, `starting ${payload.execPath} ${payload.args.join(' ')}`)
  let child
  try {
    child = spawn(payload.execPath, payload.args, replacementSpawnOptions({
      cwd: payload.cwd,
      stdio,
    }))
  } catch (error) {
    log(logPath, `spawn threw: ${String(error)}`)
    return undefined
  }
  child.once('error', (error) => { log(logPath, `replacement spawn error: ${String(error)}`) })
  // On POSIX the helper's contract ends at spawn time: setsid keeps the
  // replacement alive past this exit. On Windows the replacement is
  // deliberately NOT detached (see replacementSpawnOptions) and Node kills
  // non-detached children when their parent exits — so there the helper
  // becomes the replacement's supervisor and must never exit first.
  if (process.platform !== 'win32') child.unref()
  log(logPath, `started pid ${String(child.pid ?? 0)}`)
  return child
}

let child = launchReplacement()

// Without armed recovery the helper's contract ends here: the page's own
// watchdog reports the outcome. With one armed, the helper stays alive long
// enough to know whether the replacement ever became reachable — the one
// fact that decides whether this update succeeded.
const recovery = payload.recovery
if (recovery !== undefined && recovery !== null) {
  /**
   * Whether the replacement has become reachable on the handed-over port.
   * @param {number} limit - epoch ms after which waiting stops.
   * @returns {Promise<boolean>} true once the port answers.
   */
  const becameReady = async (limit) => {
    for (;;) {
      if (await isPortBusy(probeHost, payload.port)) return true
      if (Date.now() >= limit) return false
      await sleep(PROBE)
    }
  }

  if (await becameReady(Date.now() + REPLACEMENT_READY)) {
    log(logPath, 'replacement answered before the recovery deadline; update stands')
    if (process.platform !== 'win32') process.exit(0)
    // Windows keeps running: the supervised replacement below must outlive
    // this helper, and exiting here would kill it.
  } else {
    log(logPath, `replacement never became ready; restoring snapshot of ${recovery.version}`)
    const restored = restoreSnapshot({
      installDir: recovery.installDir,
      snapshotsDir: recovery.snapshotsDir,
      version: recovery.version,
    })
    if (!restored.ok) {
      log(logPath, `snapshot restore failed: ${restored.error ?? 'unknown error'}; leaving the tree as-is`)
      process.exit(1)
    }
    log(logPath, `restored ${recovery.version}; restarting on the recovered version`)
    // The broken replacement may hold the port or be wedged starting up; give
    // it a short window to release, then start over on the old version.
    await waitUntilFree(() => isPortBusy(probeHost, payload.port), Date.now() + WAIT)
    await sleep(SETTLE)
    child = launchReplacement()
    if (!(await becameReady(Date.now() + RECOVERY_READY))) {
      log(logPath, 'recovered replacement still not answering; manual intervention required')
      process.exit(1)
    }
    log(logPath, 'recovered replacement is answering; recovery complete')
  }
}

if (process.platform === 'win32' && child !== undefined && (child.pid ?? 0) > 0 && child.exitCode === null && child.signalCode === null) {
  // Supervise. The replacement was deliberately spawned without `detached`
  // (see replacementSpawnOptions) so it owns a hidden, inheritable console —
  // and Node terminates non-detached children when their parent exits, so
  // this helper must outlive the host it just started. It idles here until
  // the replacement exits, then goes away; the next restart's helper takes
  // over the same role for the next host.
  log(logPath, `supervising replacement pid ${String(child.pid)} for the lifetime of the host`)
  child.once('exit', (code, signal) => {
    log(logPath, `supervised replacement exited code=${String(code)} signal=${String(signal)}`)
    process.exit(0)
  })
} else {
  process.exit(0)
}

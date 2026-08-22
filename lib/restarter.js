/**
 * The restart operation behind `POST /api/dsh-version-update/restart`.
 *
 * A host cannot exec over itself and still hand its listening port to the
 * replacement, so the restart is a three-step handoff: write the command line
 * to a payload file, spawn the detached `relaunch.js` helper, then exit. The
 * helper waits for this pid to disappear and the port to free before starting
 * the replacement with the identical argv, cwd, and environment.
 *
 * The replacement inherits `process.argv` verbatim, so whichever `--profile`,
 * `--port`, and `--patch` flags the user started with come back unchanged. That
 * is also why the refusals below judge the port the invocation ASKED for rather
 * than the one this process ended up with. The launcher path is re-resolved
 * from the installation directory rather than reused from argv so the new
 * process runs the freshly installed `lib/bin.js`.
 * @module dsh-version-update/restarter
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Grace period between answering the request and exiting the host. */
export const EXIT_DELAY_MS = 300

/** Absolute path of the detached relauncher shipped beside this module. */
export const RELAUNCH_SCRIPT = fileURLToPath(new URL('./relaunch.js', import.meta.url))

/**
 * The listen port this invocation ASKED for, read from the command line the
 * replacement will inherit.
 *
 * This is the value that decides whether a restart can be found again, and it
 * is not the same as the port the host currently holds: `--port 0` resolves to
 * a real port at bind time, but replaying it binds a different one.
 * @param {readonly string[]} argv - the process command line.
 * @returns {number | undefined} the requested port, or undefined when the flag is absent or unusable.
 */
export function parseRequestedPort(argv) {
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]
    const inline = /^--port=(\d+)$/.exec(arg)
    if (inline !== null) return Number(inline[1])
    if (arg === '--port' && /^\d+$/.test(argv[index + 1] ?? '')) return Number(argv[index + 1])
  }
  return undefined
}

/**
 * Resolve the launcher entry the replacement should run.
 *
 * `process.argv[1]` names the launcher of the process that is exiting; after an
 * update the same path holds the new code, so it is also the correct entry for
 * the replacement. It is only rebuilt from `installDir` when argv[1] is not a
 * dsh launcher (an embedder or a test harness), where restarting argv[1] would
 * relaunch the wrong program.
 * @param {{ argv?: readonly string[]; installDir?: string }} deps - argv and the resolved installation directory.
 * @returns {string | undefined} the launcher path, or undefined when unknown.
 */
export function resolveLauncher(deps = {}) {
  const argv = deps.argv ?? process.argv
  const entry = argv[1]
  if (typeof entry === 'string' && /[\\/]lib[\\/]bin\.js$/.test(entry)) return entry
  if (deps.installDir !== undefined) return join(deps.installDir, 'lib', 'bin.js')
  return undefined
}

/**
 * Create the restart runner.
 * @param {{ spawnImpl?: typeof spawn; exit?: (code: number) => void; argv?: readonly string[]; cwd?: string; execPath?: string; pid?: number; installDir?: () => string | undefined; address?: () => { host: string; port: number; requestedPort?: number } | undefined; delayMs?: number }} [deps] - host seams.
 * @returns {{ restart: () => { host: string; port: number; pid: number; launcher: string; logPath: string } }} the runner.
 */
export function createRestarter(deps = {}) {
  const spawnImpl = deps.spawnImpl ?? spawn

  return {
    /**
     * Arm the handoff and schedule this host's exit.
     * @returns {{ host: string; port: number; pid: number; launcher: string; logPath: string }} what the replacement will bind, so the panel knows where to poll.
     */
    restart() {
      const address = deps.address?.()
      if (address === undefined) {
        throw new Error('restart unavailable: the listening address is unknown')
      }
      // What the replacement will ASK for, which is what decides whether it can
      // be found again — not the port this process happens to hold. The
      // distinction is the whole point: a host started with `--port 0` is
      // listening on a real port right now, but its replacement inherits
      // `--port 0` and would bind a different one, leaving the panel polling an
      // address nothing answers on while this process is already gone.
      const requestedPort = address.requestedPort ?? address.port
      if (requestedPort === 0) {
        throw new Error('restart unavailable: this host listens on an OS-assigned port')
      }
      const installDir = deps.installDir?.()
      const launcher = resolveLauncher({
        ...(deps.argv !== undefined ? { argv: deps.argv } : {}),
        ...(installDir !== undefined ? { installDir } : {}),
      })
      if (launcher === undefined) {
        throw new Error('restart unavailable: the dsh launcher entry could not be resolved')
      }
      const argv = deps.argv ?? process.argv
      const execPath = deps.execPath ?? process.execPath
      const pid = deps.pid ?? process.pid
      const dir = mkdtempSync(join(tmpdir(), 'dsh-version-update-'))
      const logPath = join(dir, 'restart.log')
      const payloadPath = join(dir, 'payload.json')
      writeFileSync(payloadPath, JSON.stringify({
        pid,
        host: address.host,
        port: address.port,
        execPath,
        // The launcher plus every flag this invocation carried, so the
        // replacement serves the same profile, port, and overlays.
        args: [launcher, ...argv.slice(2)],
        cwd: deps.cwd ?? process.cwd(),
        logPath,
      }), 'utf8')

      const child = spawnImpl(execPath, [RELAUNCH_SCRIPT, payloadPath], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      })
      child.unref?.()

      // The response must reach the browser before the process goes away, so
      // the exit is scheduled rather than immediate.
      const exit = deps.exit ?? ((code) => { process.exit(code) })
      const timer = setTimeout(() => { exit(0) }, deps.delayMs ?? EXIT_DELAY_MS)
      timer.unref?.()

      return { host: address.host, port: address.port, pid, launcher, logPath }
    },
  }
}

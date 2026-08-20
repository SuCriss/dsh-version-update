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
 * `--port`, and `--patch` flags the user started with come back unchanged. The
 * launcher path is re-resolved from the installation directory rather than
 * reused from argv so the new process runs the freshly installed `lib/bin.js`.
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
 * @param {{ spawnImpl?: typeof spawn; exit?: (code: number) => void; argv?: readonly string[]; cwd?: string; execPath?: string; pid?: number; installDir?: () => string | undefined; address?: () => { host: string; port: number } | undefined; delayMs?: number }} [deps] - host seams.
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
      if (address.port === 0) {
        // An OS-assigned port is not reproducible: the replacement would bind a
        // different one and the panel could never find it again.
        throw new Error('restart unavailable: this host listens on an OS-assigned port')
      }
      const launcher = resolveLauncher({
        ...(deps.argv !== undefined ? { argv: deps.argv } : {}),
        ...(deps.installDir?.() !== undefined ? { installDir: deps.installDir() } : {}),
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

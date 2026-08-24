/**
 * The update task: one serialized `npm install -g @deepseek-ai/dsh@<version>`
 * run, its captured output, and its settlement. At most one task exists at a
 * time — a second request while one runs is refused rather than queued,
 * because two concurrent global installs of the same package would race over
 * the same directory.
 *
 * npm is spawned WITHOUT a shell on every platform. On Windows the `npm`
 * command is a `.cmd` shim that `spawn` refuses without a shell, so the runner
 * resolves npm's own `npm-cli.js` next to the running node binary and spawns
 * `node npm-cli.js …` instead. That keeps the version argument out of any
 * command-line parser.
 *
 * Two deliberate asymmetries around killing npm, since leaving a global
 * package directory half-written is the worst outcome this module can produce:
 * plugin disposal never kills a running install (losing the progress view is
 * cheaper than a broken installation), but the wall-clock ceiling does. A run
 * still going after {@link INSTALL_TIMEOUT_MS} is assumed wedged rather than
 * working — a wedged install would otherwise hold the single task slot for the
 * lifetime of the process, and no later update could ever start.
 *
 * The single slot is enforced PROCESS-WIDE, not per runner instance: cordis
 * reloads this plugin's fiber on a config change, and disposal deliberately
 * leaves npm alive — so the replacement instance must still refuse to start
 * while the orphaned npm writes the global tree, or two installs would race
 * over the same directory, the exact race the slot exists to prevent. The
 * slot frees when that orphaned run settles, which its surviving stream and
 * close listeners still report.
 * @module dsh-version-update/updater
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSH_PACKAGE } from './protocol.js'
import { isInstallableVersion, normalizeRegistry } from './core.js'

/** How much captured output one task retains (tail-truncated beyond it). */
export const LOG_LIMIT = 64 * 1024

/** Wall-clock cap on one install run. */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/**
 * The install this PROCESS is running, whichever runner instance started it —
 * `{ child }` of the spawned npm, or undefined when nothing is. Module scope is
 * the point: a fiber reload builds a fresh runner whose own task state is idle,
 * and only a fact that outlives the instance can tell it that an orphaned npm
 * is still writing the global tree.
 * @type {{ child: import('node:child_process').ChildProcess } | undefined}
 */
let processInstall

/**
 * Whether a spawned child has not settled yet. A real ChildProcess reports
 * `exitCode`/`signalCode` as null until it exits; the loose comparison also
 * reads the missing properties of a test double as "still running".
 * @param {import('node:child_process').ChildProcess} child - the spawned npm.
 * @returns {boolean} true while the run may still be writing.
 */
function isUnsettled(child) {
  return child.exitCode == null && child.signalCode == null
}

/**
 * Locate npm's CLI entry so npm can be spawned as a plain node script.
 *
 * The node-adjacent layouts come first because they name the npm that ships
 * with the running node; `npm_config_prefix` covers the installations those
 * cannot see (a custom prefix, nvm-windows, a portable node), and is the same
 * value the global install would write to.
 * @param {{ execPath?: string; env?: Record<string, string | undefined> }} [deps] - test seams.
 * @returns {string | undefined} the npm-cli.js path, or undefined when not found.
 */
export function resolveNpmCli(deps = {}) {
  const nodeDir = dirname(deps.execPath ?? process.execPath)
  const env = deps.env ?? process.env
  const roots = [
    join(nodeDir, 'node_modules'),
    join(nodeDir, '..', 'lib', 'node_modules'),
  ]
  const prefix = env.npm_config_prefix
  if (prefix !== undefined && prefix !== '') {
    roots.push(join(prefix, 'node_modules'), join(prefix, 'lib', 'node_modules'))
  }
  if (env.APPDATA !== undefined) roots.push(join(env.APPDATA, 'npm', 'node_modules'))
  return roots
    .map(root => join(root, 'npm', 'bin', 'npm-cli.js'))
    .find(candidate => existsSync(candidate))
}

/**
 * One task's public state, as the panel polls it.
 * @typedef {object} TaskView
 * @property {'idle' | 'running' | 'done' | 'failed'} state - settlement state.
 * @property {string} [version] - the target version of the current or last run.
 * @property {string} log - captured stdout+stderr, tail-truncated.
 * @property {string} [error] - failure message when state is 'failed'.
 * @property {number} [startedAt] - epoch ms when the run started.
 * @property {number} [endedAt] - epoch ms when the run settled.
 */

/**
 * Create the single-slot update runner.
 * @param {{ spawnImpl?: typeof spawn; npmCli?: string; execPath?: string; env?: Record<string, string | undefined>; registry?: string; timeoutMs?: number; onSettled?: (info: { version: string; ok: boolean }) => void }} [deps] - test seams plus the settlement observer the history keeps.
 * @returns {{ view: () => TaskView; start: (version: string) => TaskView; dispose: () => void }} the runner.
 */
export function createUpdater(deps = {}) {
  const spawnImpl = deps.spawnImpl ?? spawn
  const onSettled = deps.onSettled
  /** @type {TaskView} */
  let task = { state: 'idle', log: '' }
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child
  /**
   * The child of this runner's current or last run, kept separate from
   * {@link child}: dispose drops `child` but the OS process outlives it, and
   * its late settlement is what releases the process-wide slot.
   * @type {import('node:child_process').ChildProcess | undefined}
   */
  let slotChild
  /** @type {NodeJS.Timeout | undefined} */
  let timer

  /** @param {string} chunk - decoded npm output to append to the capped log. */
  const append = (chunk) => {
    task.log = (task.log + chunk).slice(-LOG_LIMIT)
  }

  /**
   * Move the task to its terminal state and release the child.
   * @param {'done' | 'failed'} state - the settled state.
   * @param {string} [error] - the failure reason, for a failed run.
   */
  const settle = (state, error) => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    // Release the process-wide slot this run claimed. The identity check keeps
    // a late event from an ancient run from freeing a newer run's slot.
    if (processInstall !== undefined && slotChild !== undefined && processInstall.child === slotChild) {
      processInstall = undefined
    }
    // Detach the streams from the settled task before dropping the handle: a
    // killed npm can still drain buffered output, and an `append` surviving
    // into the next run would write the dead task's log into the live one.
    child?.stdout?.removeAllListeners('data')
    child?.stderr?.removeAllListeners('data')
    child?.removeAllListeners('error')
    child?.removeAllListeners('close')
    child = undefined
    const settled = task
    task = { ...task, state, endedAt: Date.now(), ...(error !== undefined ? { error } : {}) }
    // The history observer fires on the running→terminal transition only, so
    // a duplicate settlement event can never record one install twice — and a
    // throwing recorder cannot break the runner: the install itself has
    // already happened either way.
    if (onSettled !== undefined && settled.state === 'running') {
      try {
        onSettled({ version: /** @type {{ version: string }} */ (settled).version, ok: state === 'done' })
      } catch {
        // See above: history is a passenger here, not the driver.
      }
    }
  }

  return {
    view: () => ({ ...task }),

    start(version) {
      // Validate before the concurrency check so a malformed target reports
      // what is wrong with it rather than what else is running.
      if (!isInstallableVersion(version)) {
        throw new Error(`refusing to install ${JSON.stringify(String(version))}: not one exact published version`)
      }
      if (task.state === 'running') {
        throw new Error('an update is already running')
      }
      // The same slot, enforced across runner instances: a config reload
      // replaces this plugin's fiber but not the npm an earlier fiber spawned,
      // and two installs racing over one global tree is the worst outcome this
      // module can produce. The orphaned run's own settlement frees the slot.
      if (processInstall !== undefined && isUnsettled(processInstall.child)) {
        throw new Error('an update is already running in this host process')
      }
      const npmCli = deps.npmCli ?? resolveNpmCli({
        ...(deps.execPath !== undefined ? { execPath: deps.execPath } : {}),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
      })
      if (npmCli === undefined) {
        throw new Error('npm CLI not found next to the running node binary — update this installation from a terminal instead')
      }
      const spec = `${DSH_PACKAGE}@${version}`
      // The install reads the same registry the panel read the version from;
      // otherwise a mirror-configured deployment would offer a version from
      // the mirror and then fetch it from npmjs.
      const registryArgs = deps.registry === undefined ? [] : ['--registry', normalizeRegistry(deps.registry)]
      const args = [npmCli, 'install', '-g', spec, '--no-fund', '--no-audit', ...registryArgs]
      task = { state: 'running', version, log: `$ npm ${args.slice(1).join(' ')}\n`, startedAt: Date.now() }
      const spawned = spawnImpl(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
      child = spawned
      slotChild = spawned
      processInstall = { child: spawned }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)
      child.on('error', (error) => {
        append(`\n${String(error)}\n`)
        settle('failed', error instanceof Error ? error.message : String(error))
      })
      child.on('close', (code) => {
        if (task.state !== 'running') return
        if (code === 0) {
          append('\nnpm exited 0 — restart dsh for the new version to take effect.\n')
          settle('done')
        } else {
          append(`\nnpm exited ${code}\n`)
          settle('failed', `npm exited ${code}`)
        }
      })
      timer = setTimeout(() => {
        if (task.state !== 'running') return
        // The one place npm IS killed: see the module note. A wedged run must
        // not hold the single task slot for the life of the process.
        child?.kill()
        append('\ntimed out\n')
        settle('failed', 'install timed out')
      }, deps.timeoutMs ?? INSTALL_TIMEOUT_MS)
      return { ...task }
    },

    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      // A running install is left alone deliberately: killing npm midway can
      // leave the global package directory half-written, which is worse than
      // losing the progress view when the plugin fiber goes away. The
      // process-wide slot stays claimed with it — the replacement fiber's
      // runner must refuse until this orphaned npm settles, which its
      // surviving close listener still reports.
      child = undefined
    },
  }
}

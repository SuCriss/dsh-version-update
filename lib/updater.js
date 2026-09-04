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
 * Before npm touches anything, the runner hands control to `beforeSpawn`.
 * The host wires that to the snapshot module, so every install — manual or
 * silent — begins by making the current tree instantly restorable. A failing
 * snapshot is logged and ignored: rollback safety is best-effort, but a
 * broken snapshot must never become a broken update.
 *
 * Two asymmetries around killing npm, since leaving a global package
 * directory half-written is the worst outcome this module can produce: plugin
 * disposal never kills a running install (losing the progress view is cheaper
 * than a broken installation), but the wall-clock ceiling does. A run still
 * going after {@link INSTALL_TIMEOUT_MS} is assumed wedged rather than
 * working.
 *
 * start() is DELIBERATELY non-blocking: it validates, claims the slot, marks
 * the task running, and returns at once, so the panel gets an instant log.
 * The snapshot and the npm spawn then proceed in an async pipeline
 * ({@link createUpdater} internals): the rollback snapshot copies on the
 * threadpool with progress lines streamed into the task log, npm starts only
 * once the old tree is safe, and a periodic on-disk measurement reports the
 * extraction progress while npm itself is silent.
 *
 * The single slot is enforced PROCESS-WIDE, not per runner instance: cordis
 * reloads this plugin's fiber on a config change, and disposal deliberately
 * leaves npm alive — so the replacement instance must still refuse to start
 * while the orphaned npm writes the global tree. The slot frees when that
 * orphaned run settles, which its surviving listeners still report. The slot
 * is also held across the pre-spawn preparation window (the snapshot copy), so
 * no second install can race a snapshot that is still being written.
 * @module dsh-version-update/updater
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSH_PACKAGE } from './protocol.js'
import { isInstallableVersion, normalizeRegistry } from './core.js'
import { measureTree } from './snapshot.js'

/** How much captured output one task retains (tail-truncated beyond it). */
export const LOG_LIMIT = 64 * 1024

/** Wall-clock cap on one install run. */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/** How often the npm phase reports its on-disk extraction progress. */
export const INSTALL_PROGRESS_MS = 4000

/** Smallest on-disk growth one progress line reports (a quieter log). */
export const INSTALL_PROGRESS_STEP = 8 * 1024 * 1024

/** Who asked for an install; recorded on the task and in the history. */
export const TRIGGERS = ['manual', 'auto', 'scheduled']

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
 * Whether ANY run in this process is between start() and the npm spawn — the
 * snapshot copy window. It holds the process-wide slot exactly like a spawned
 * npm does, so a reload during a slow snapshot cannot admit a racing second
 * install.
 * @type {boolean}
 */
let processPreparing = false

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
 * @property {'manual' | 'auto' | 'scheduled'} [trigger] - who asked for this run.
 * @property {string} log - captured stdout+stderr, tail-truncated.
 * @property {string} [error] - failure message when state is 'failed'.
 * @property {number} [startedAt] - epoch ms when the run started.
 * @property {number} [endedAt] - epoch ms when the run settled.
 */

/**
 * Create the single-slot update runner.
 * @param {{ spawnImpl?: typeof spawn; npmCli?: string; execPath?: string; env?: Record<string, string | undefined>; registry?: string; timeoutMs?: number; installDir?: string; progressMs?: number; beforeSpawn?: (version: string, report: (line: string) => void) => void | Promise<void>; onSettled?: (info: { version: string; ok: boolean; trigger: 'manual' | 'auto' | 'scheduled' }) => void }} [deps] - test seams, the pre-install snapshot hook (async, reports progress lines), the on-disk install directory the extraction watcher measures, and the settlement observer the history keeps.
 * @returns {{ view: () => TaskView; start: (version: string, trigger?: 'manual' | 'auto' | 'scheduled') => TaskView; dispose: () => void }} the runner.
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
  /** @type {NodeJS.Timeout | undefined} */
  let progressTimer
  /** Last on-disk total the extraction watcher reported, in bytes. */
  let progressBytes = 0

  /** @param {string} chunk - decoded npm output to append to the capped log. */
  const append = (chunk) => {
    task.log = (task.log + chunk).slice(-LOG_LIMIT)
  }

  /** Seconds since the running task started, for progress lines. */
  const elapsed = () => task.startedAt === undefined ? 0 : Math.max(0, Math.round((Date.now() - task.startedAt) / 1000))

  /** @param {number} bytes - a byte count. @returns {string} human megabytes. */
  const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`

  /** @param {number} seconds - an elapsed count. @returns {string} `34s` or `2m 05s`. */
  const fmtElapsed = (seconds) => seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`

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
    if (progressTimer !== undefined) {
      clearInterval(progressTimer)
      progressTimer = undefined
    }
    // Release the process-wide slot this run claimed — either the spawned
    // npm's slot or the pre-spawn preparation window. The identity check keeps
    // a late event from an ancient run from freeing a newer run's slot.
    if (processInstall !== undefined && slotChild !== undefined && processInstall.child === slotChild) {
      processInstall = undefined
    }
    processPreparing = false
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
        const info = /** @type {{ version: string; trigger?: 'manual' | 'auto' | 'scheduled' }} */ (settled)
        onSettled({ version: info.version, ok: state === 'done', trigger: info.trigger ?? 'manual' })
      } catch {
        // See above: history is a passenger here, not the driver.
      }
    }
  }

  /**
   * Follow the npm phase's on-disk extraction. npm itself prints nothing for
   * long stretches, so the watcher measures the installation directory and
   * reports the climb back toward its final size. The baseline re-arms when
   * the directory shrinks — the mid-reify moment the old tree is removed
   * before the new one is extracted — so the very first reading (the OLD tree,
   * still in place) never reports as progress.
   */
  const watchExtraction = () => {
    if (deps.installDir === undefined || progressTimer !== undefined) return
    const watchedDir = deps.installDir
    progressBytes = 0
    let seeded = false
    progressTimer = setInterval(() => {
      void measureTree(watchedDir).then((current) => {
        if (task.state !== 'running') return
        if (!seeded) {
          seeded = true
          progressBytes = current.bytes
          return
        }
        if (current.bytes < progressBytes - INSTALL_PROGRESS_STEP) {
          // The tree was reset mid-reify; the climb starts over.
          progressBytes = current.bytes
          return
        }
        if (current.bytes > progressBytes + INSTALL_PROGRESS_STEP) {
          progressBytes = current.bytes
          append(`[installing] ${fmtElapsed(elapsed())} elapsed · ${fmtMB(current.bytes)} extracted\n`)
        }
      }, () => {})
    }, deps.progressMs ?? INSTALL_PROGRESS_MS)
  }

  /**
   * The post-start pipeline: snapshot the live tree (async, progress lines
   * streamed into the log), then spawn npm against the safe tree. Runs
   * unawaited — start() has already answered with the running task — and the
   * settled-state checks between steps make a timeout mid-snapshot simply
   * abandon the pipeline instead of spawning against a settled task.
   * @param {string} version - the exact target version.
   * @param {string} npmCli - the resolved npm CLI path.
   * @param {string[]} registryArgs - the `--registry` arguments, if any.
   */
  const runPipeline = async (version, npmCli, registryArgs) => {
    try {
      // Snapshot BEFORE npm touches the tree. A failure here is a line in the
      // log, not a refused update.
      if (deps.beforeSpawn !== undefined) {
        try {
          await deps.beforeSpawn(version, append)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          append(`snapshot failed, continuing without rollback safety: ${reason}\n`)
        }
        if (task.state !== 'running') return
      }
      const spec = `${DSH_PACKAGE}@${version}`
      // The install reads the same registry the panel read the version from;
      // otherwise a mirror-configured deployment would offer a version from
      // the mirror and then fetch it from npmjs.
      const args = [npmCli, 'install', '-g', spec, '--no-fund', '--no-audit', ...registryArgs]
      append(`$ npm ${args.slice(1).join(' ')}\n`)
      const spawned = spawnImpl(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
      child = spawned
      slotChild = spawned
      processInstall = { child: spawned }
      processPreparing = false
      watchExtraction()
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
    } catch (error) {
      // Any unexpected pipeline failure (a throwing spawnImpl, most plausibly)
      // must free the slot and report — never strand a phantom running task.
      processPreparing = false
      append(`\n${error instanceof Error ? error.message : String(error)}\n`)
      settle('failed', error instanceof Error ? error.message : String(error))
    }
  }

  return {
    view: () => ({ ...task }),

    /**
     * Start one install. Refuses while any install runs anywhere in this
     * process, or when the version is not one exact published version.
     * @param {string} version - the exact target version.
     * @param {'manual' | 'auto' | 'scheduled'} [trigger] - who asked.
     * @returns {TaskView} the fresh running task.
     */
    start(version, trigger = 'manual') {
      // Validate before the concurrency check so a malformed target reports
      // what is wrong with it rather than what else is running.
      if (!TRIGGERS.includes(trigger)) throw new Error(`unknown trigger ${JSON.stringify(String(trigger))}`)
      if (!isInstallableVersion(version)) {
        throw new Error(`refusing to install ${JSON.stringify(String(version))}: not one exact published version`)
      }
      if (task.state === 'running') {
        throw new Error('an update is already running')
      }
      // The same slot, enforced across runner instances: a config reload
      // replaces this plugin's fiber but not the work an earlier fiber started
      // (a spawned npm, or a snapshot copy still running), and two installs
      // racing over one global tree is the worst outcome this module can
      // produce. The orphaned run's own settlement frees the slot.
      if (processInstall !== undefined && isUnsettled(processInstall.child)) {
        throw new Error('an update is already running in this host process')
      }
      if (processPreparing) {
        throw new Error('an update is already preparing (snapshot) in this host process')
      }
      const npmCli = deps.npmCli ?? resolveNpmCli({
        ...(deps.execPath !== undefined ? { execPath: deps.execPath } : {}),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
      })
      if (npmCli === undefined) {
        throw new Error('npm CLI not found next to the running node binary — update this installation from a terminal instead')
      }
      const registryArgs = deps.registry === undefined ? [] : ['--registry', normalizeRegistry(deps.registry)]
      // Claim the preparation window BEFORE answering: from here until the npm
      // spawn (or a settlement) the process-wide slot is held, so a second
      // start anywhere in the process is refused rather than racing.
      processPreparing = true
      // Enter the running state and answer AT ONCE — the snapshot copy and the
      // npm spawn proceed in runPipeline. The caller's HTTP response carries
      // this running task, so the panel shows a live log from the first
      // second instead of a frozen empty box.
      task = { state: 'running', version, trigger, log: `$ preparing to install ${DSH_PACKAGE}@${version}\n`, startedAt: Date.now() }
      const run = runPipeline(version, npmCli, registryArgs)
      if (typeof run?.catch === 'function') {
        run.catch(() => {
          // runPipeline already settles itself; this guard only keeps an
          // unexpected rejection from surfacing as an unhandled rejection.
        })
      }
      timer = setTimeout(() => {
        if (task.state !== 'running') return
        // The one place npm IS killed: see the module note. A wedged run must
        // not hold the single task slot for the life of the process. Killing
        // also unblocks a pipeline still awaiting the snapshot: the settled
        // check between steps abandons it.
        child?.kill()
        append('\ntimed out\n')
        settle('failed', 'install timed out')
      }, deps.timeoutMs ?? INSTALL_TIMEOUT_MS)
      return { ...task }
    },

    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (progressTimer !== undefined) {
        clearInterval(progressTimer)
        progressTimer = undefined
      }
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

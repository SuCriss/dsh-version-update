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
 * disposal never kills a running install, and neither does the soft deadline.
 * Killing npm mid-reify is precisely what leaves the global tree
 * half-committed — npm stashes replaced packages under retired temporary
 * names (`.name-hash`) and only deletes them at the end — so the soft
 * {@link INSTALL_TIMEOUT_MS} merely notes the slow run and keeps waiting.
 * Only the hard {@link INSTALL_HARD_TIMEOUT_MS} ceiling stops a run assumed
 * wedged rather than working, and the host wiring then repairs the tree from
 * the pre-install snapshot (see tree-health.js).
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
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSH_PACKAGE } from './protocol.js'
import { isInstallableVersion, normalizeRegistry } from './core.js'
import { measureTree } from './snapshot.js'
import { acquireUpdateLock } from './updatelock.js'

/**
 * Verify the install actually landed: npm exit 0 alone proves npm finished,
 * not that dsh can start. Checks the manifest parses, names the TARGET
 * version, and the launcher entry exists. Runs against the on-disk tree the
 * moment npm settles; the tree may keep changing if another actor writes it,
 * but a mismatch at settle time is already decisive evidence of a broken
 * install.
 * @param {{ installDir: string; version: string }} args - the tree to inspect and the version that was requested.
 * @returns {{ ok: boolean; problem?: string }} the verdict.
 */
export function verifyInstalled(args) {
  const manifestPath = join(args.installDir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { ok: false, problem: `package.json unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (manifest?.version !== args.version) {
    return { ok: false, problem: `package.json reports ${String(manifest?.version)} while ${args.version} was requested` }
  }
  if (!existsSync(join(args.installDir, 'lib', 'bin.js'))) {
    return { ok: false, problem: 'lib/bin.js (the launcher entry) is missing after the install' }
  }
  return { ok: true }
}

/** How much captured output one task retains (tail-truncated beyond it). */
export const LOG_LIMIT = 64 * 1024

/**
 * Soft wall-clock cap on one install run. Reaching it changes nothing about
 * the run: the log notes the slowness and npm keeps working, because stopping
 * it here is what corrupts the global tree into the half-committed state.
 */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Hard wall-clock cap, the only point where npm is stopped. A run still going
 * after an hour is wedged rather than working; the kill is accepted because
 * the host wiring restores the pre-install snapshot afterwards, which turns
 * the half-committed tree back into the version this process was serving.
 */
export const INSTALL_HARD_TIMEOUT_MS = 60 * 60 * 1000

/**
 * How long a killed npm is allowed to take dying before the runner stops
 * waiting to free the process-wide slot and the machine-wide lock. The kill at
 * the hard ceiling is asynchronous, so releasing on the signal rather than the
 * exit would let a second writer into a tree the first one is still touching.
 */
export const RELEASE_GRACE_MS = 5000

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
 * Which run (if any) in this process currently holds the PREPARATION claim —
 * the window between start() and the npm spawn, i.e. the snapshot copy. It
 * holds the process-wide slot exactly like a spawned npm does, so a reload
 * during a slow snapshot cannot admit a racing second install.
 *
 * The claim is a monotonic token rather than a boolean because of who may
 * clear it: a fiber reload leaves the previous instance's run orphaned with its
 * listeners intact, and that run's late settlement must not hand a fresher
 * run's claim away. Zero means free.
 * @type {number}
 */
let processPreparing = 0

/** Monotonic source of {@link processPreparing} tokens. */
let prepareSeq = 0

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
 * @param {{ spawnImpl?: typeof spawn; npmCli?: string; execPath?: string; env?: Record<string, string | undefined>; registry?: string; timeoutMs?: number; hardTimeoutMs?: number; installDir?: string; progressMs?: number; lockPath?: string; beforeSpawn?: (version: string, report: (line: string) => void) => void | Promise<void>; onSettled?: (info: { version: string; ok: boolean; trigger: 'manual' | 'auto' | 'scheduled' }) => void }} [deps] - test seams, the pre-install snapshot hook (async, reports progress lines), the on-disk install directory the extraction watcher measures, the machine-wide lock file path override, and the settlement observer the history keeps.
 * @returns {{ view: () => TaskView; busy: () => boolean; start: (version: string, trigger?: 'manual' | 'auto' | 'scheduled') => TaskView; dispose: () => void }} the runner.
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
  let hardTimer
  /** @type {NodeJS.Timeout | undefined} */
  let progressTimer
  /** Last on-disk total the extraction watcher reported, in bytes. */
  let progressBytes = 0
  /**
   * The machine-wide lock this run holds, or undefined. Released exactly once
   * — by {@link releaseRun} — whether the run succeeded, failed, or was killed
   * at the hard ceiling; when a kill is involved, not before the child has
   * really exited (see {@link RELEASE_GRACE_MS}).
   * @type {ReturnType<typeof acquireUpdateLock> | undefined}
   */
  let machineLock
  /**
   * The preparation-claim token this instance passed to {@link processPreparing}
   * for its current or last run, or 0. Only a matching claim may be cleared.
   * @type {number}
   */
  let prepareToken = 0

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
   * Hand the preparation claim back, but only if THIS run is the one holding it.
   * @returns {void}
   */
  const releasePrepareClaim = () => {
    if (prepareToken !== 0 && processPreparing === prepareToken) {
      processPreparing = 0
    }
  }

  /**
   * Release everything this run claimed in the SHARED process state: the
   * install slot, the preparation claim, and the machine-wide lock.
   *
   * Both releases are identity-checked. A fiber reload deliberately leaves npm
   * running with its listeners attached, and when that orphan finally settles
   * it runs THIS function on the old instance's closure — by which time a newer
   * run may hold the very slot and lock the orphan is about to free. Without the
   * identity comparison an orphan silently unlocks a live install, which is
   * precisely the two-writers-on-one-tree outcome the lock exists to prevent.
   * @returns {void}
   */
  const releaseRun = () => {
    if (processInstall !== undefined && slotChild !== undefined && processInstall.child === slotChild) {
      processInstall = undefined
    }
    releasePrepareClaim()
    // Ownership-checked inside release(): never deletes another holder's file.
    machineLock?.release()
    machineLock = undefined
  }

  /**
   * Move the task to its terminal state and release the child.
   * @param {'done' | 'failed'} state - the settled state.
   * @param {string} [error] - the failure reason, for a failed run.
   * @param {boolean} [holdSlot] - keep the shared slot and machine lock claimed;
   *   the caller releases them once a killed npm has actually exited.
   */
  const settle = (state, error, holdSlot = false) => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (hardTimer !== undefined) {
      clearTimeout(hardTimer)
      hardTimer = undefined
    }
    if (progressTimer !== undefined) {
      clearInterval(progressTimer)
      progressTimer = undefined
    }
    if (!holdSlot) {
      releaseRun()
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
      // The spawned npm holds the process-wide slot through processInstall from
      // here on; the preparation claim is handed back the same way a settlement
      // would hand it back — only if this run still owns it.
      releasePrepareClaim()
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
          // npm exit 0 proves npm finished, not that dsh can start. Verify the
          // tree before calling this done; a broken tree settles failed so the
          // host wiring restores the pre-install snapshot.
          if (deps.installDir !== undefined) {
            const verdict = verifyInstalled({ installDir: deps.installDir, version })
            if (!verdict.ok) {
              append(`\npost-install validation failed: ${verdict.problem}\n`)
              settle('failed', `post-install validation failed: ${verdict.problem}`)
              return
            }
            append(`post-install validation passed: ${version} is on disk with a working launcher\n`)
          }
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
      // settle() releases the preparation claim and the lock with the identity
      // checks in place, so an orphaned failure cannot unlock a newer run.
      append(`\n${error instanceof Error ? error.message : String(error)}\n`)
      settle('failed', error instanceof Error ? error.message : String(error))
    }
  }

  return {
    view: () => ({ ...task }),

    /**
     * Whether ANY run in this process still owns the global installation tree:
     * a live npm, a snapshot copy in flight, or a killed npm that has settled as
     * failed but has not reported its exit yet.
     *
     * Callers that touch the tree from OUTSIDE the updater (the host's repair
     * pass) must ask this rather than "is my task running" — a killed child is
     * still writing for a moment after its task stopped existing as a run.
     * @returns {boolean} true while the tree has an owner.
     */
    busy: () => task.state === 'running'
      || processPreparing !== 0
      || (processInstall !== undefined && isUnsettled(processInstall.child)),

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
      if (processPreparing !== 0) {
        throw new Error('an update is already preparing (snapshot) in this host process')
      }
      // Resolve everything that can still fail BEFORE the lock is taken. The
      // "npm CLI not found" refusal explicitly sends the user to a terminal, and
      // if this long-lived process already held the lock at that moment, the
      // other host they switch to would be refused for the lock's entire
      // staleness window (an hour) for an install that never started.
      const npmCli = deps.npmCli ?? resolveNpmCli({
        ...(deps.execPath !== undefined ? { execPath: deps.execPath } : {}),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
      })
      if (npmCli === undefined) {
        throw new Error('npm CLI not found next to the running node binary — update this installation from a terminal instead')
      }
      const registryArgs = deps.registry === undefined ? [] : ['--registry', normalizeRegistry(deps.registry)]
      // The MACHINE-WIDE lock: a second dsh host (desktop + terminal, two
      // terminals) must not run `npm install -g` against the same tree at
      // once. Acquired last — after every validation that can throw — and
      // released by releaseRun(). A refusal is a clean 409-style error, not a
      // race; a stealable holder (dead/wedged pid) is taken over silently.
      const lock = acquireUpdateLock({ ...(deps.lockPath !== undefined ? { lockPath: deps.lockPath } : {}) })
      if (!lock.ok) {
        throw new Error(`another install holds the machine-wide update lock (pid ${String(lock.holder?.pid)})`)
      }
      machineLock = lock
      // Claim the preparation window BEFORE answering: from here until the npm
      // spawn (or a settlement) the process-wide slot is held, so a second
      // start anywhere in the process is refused rather than racing. The token
      // is what lets the release paths tell their own claim from a newer one.
      prepareToken = ++prepareSeq
      processPreparing = prepareToken
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
      // Soft deadline: note the slow run and keep waiting. npm is NOT
      // interrupted here — mid-reify it holds replaced packages under retired
      // temporary names, and a kill at that moment is exactly the
      // half-committed global tree this module exists to prevent. A pipeline
      // still awaiting the snapshot is likewise left alone; its settled-state
      // check between steps abandons it on its own.
      timer = setTimeout(() => {
        if (task.state !== 'running') return
        const minutes = Math.round((deps.timeoutMs ?? INSTALL_TIMEOUT_MS) / 60000)
        append(`\nnpm has been running for ${minutes} minutes — still waiting; the install is not interrupted mid-run because stopping npm then can leave the global tree half-committed.\n`)
      }, deps.timeoutMs ?? INSTALL_TIMEOUT_MS)
      // The one place npm IS killed: see the module note. A wedged run must
      // not hold the single task slot for the life of the process, and the
      // pre-install snapshot exists precisely so this stop can be repaired.
      hardTimer = setTimeout(() => {
        if (task.state !== 'running') return
        const killed = child
        child?.kill()
        append('\ninstall exceeded the hard time limit; npm was stopped and the pre-install snapshot will be restored to repair the tree.\n')
        // `kill()` only delivers a signal: the stopped npm may keep writing for
        // a moment. The panel must see the failure NOW, but the slot and the
        // machine lock stay claimed until the child has really exited —
        // otherwise the next install (or the repair this failure schedules)
        // races a zombie reify over the same global tree.
        settle('failed', 'install exceeded the hard time limit', killed !== undefined)
        if (killed === undefined) return
        let released = false
        /** @returns {void} */
        const finish = () => {
          if (released) return
          released = true
          releaseRun()
        }
        killed.once('exit', finish)
        // A child that never reports its exit must not strand the slot either;
        // the grace window unrefs so a shutting-down host is not held open.
        const grace = setTimeout(finish, RELEASE_GRACE_MS)
        grace.unref?.()
      }, deps.hardTimeoutMs ?? INSTALL_HARD_TIMEOUT_MS)
      return { ...task }
    },

    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (hardTimer !== undefined) clearTimeout(hardTimer)
      hardTimer = undefined
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

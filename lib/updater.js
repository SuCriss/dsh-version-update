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
 * The task also carries a STRUCTURED progress model ({@link TaskProgress})
 * alongside the log, because a stream of text lines is a poor progress bar:
 * the panel needs a phase, a number, and a total to draw one. Each phase has
 * its own honest signal — the snapshot copy reports copied bytes against the
 * measured tree, the extraction is measured on disk against the size the
 * pre-install snapshot recorded, and the download (npm prints nothing while it
 * streams a tarball) is measured through the optional {@link
 * createUpdater} `downloadBytes` probe, which the host wires to npm's cache
 * scratch directory. Where no signal exists the phase is reported as
 * INDETERMINATE rather than invented: `percent` is simply absent, and a stall
 * is never claimed for a phase this runner cannot see (see `blind`).
 * `stalledMs`/`slow` exist because "the download is slow" is the one failure a
 * progress bar can name before npm does, and the panel offers a mirror switch
 * on the strength of it.
 *
 * An install may also be pinned to a SOURCE ({@link INSTALL_SOURCES}): the
 * registry the panel read the version from (the default), the configured one,
 * or a mirror. Only the source ID travels through the HTTP body — the URL is
 * resolved here from host-side config — so the npm command line still cannot
 * be steered by request input.
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
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DSH_PACKAGE, DEFAULT_SOURCE, INSTALL_SOURCES, PROGRESS_PHASES } from './protocol.js'
import { FALLBACK_REGISTRIES, isInstallableVersion, normalizeRegistry, readInstalled } from './core.js'
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

/** The registry `mirror` means unless a composition names another one. */
export const DEFAULT_MIRROR_REGISTRY = FALLBACK_REGISTRIES[0]

/**
 * How long a running install may show no measurable movement before the task
 * reports itself slow. Chosen against npm's own fetch behaviour: a healthy
 * tarball stream on a slow-but-working link still moves the cache scratch file
 * every few seconds, so half a minute of nothing is a link problem rather than
 * a slow moment.
 */
export const SLOW_PROGRESS_MS = 30_000

/**
 * A preparation failure that must stop the run instead of being logged past.
 *
 * The pre-spawn hook is best-effort by design — a snapshot that cannot be
 * written is a degraded rollback offer, not a refused update. Some failures
 * are not degradations, though: when the composition demands a rollback point
 * before it lets npm rewrite a global package tree, proceeding without one is
 * exactly the outcome that requirement exists to prevent. Throwing this from
 * {@link createUpdater}'s `beforeSpawn` settles the task failed with npm never
 * spawned.
 */
export class FatalPreparationError extends Error {
  /**
   * @param {string} message - why the run cannot proceed.
   */
  constructor(message) {
    super(message)
    this.name = 'FatalPreparationError'
    /** Read by the pipeline: a plain Error is logged past, this one is not. */
    this.fatal = true
  }
}

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
 * What one run reports about its own progress, for a bar rather than a log.
 *
 * `percent` is present only when this runner has BOTH a numerator and a
 * denominator for the current phase; a phase it cannot measure (the download,
 * when the composition wired no cache probe) reports bytes and no percentage,
 * and the panel draws an indeterminate bar instead of a made-up number.
 * @typedef {object} TaskProgress
 * @property {'preparing' | 'snapshot' | 'download' | 'extract' | 'verify' | 'done'} phase - where the run is.
 * @property {number} [percent] - 0-100 when a total is known for this phase.
 * @property {number} bytes - what this phase has moved so far.
 * @property {number} [totalBytes] - the denominator `percent` was computed from.
 * @property {number} [files] - files moved, when the phase counts them.
 * @property {number} elapsedMs - since the task started.
 * @property {number} stalledMs - since the last observed movement.
 * @property {boolean} slow - no movement for {@link SLOW_PROGRESS_MS} in a phase this runner can actually see.
 * @property {boolean} indeterminate - this phase has no denominator (or no signal at all).
 */

/**
 * Locate the directory npm streams an in-flight download into.
 *
 * npm fetches a tarball through its content-addressable cache, which stages the
 * bytes in `<cache>/_cacache/tmp` before moving them into the content store —
 * which makes that directory the only byte count a download phase can honestly
 * have: npm itself prints nothing while a tarball streams, and the installation
 * tree does not move until the download has finished.
 *
 * The cache location follows npm's own resolution order — an explicit
 * `npm_config_cache`, then the per-user default (a Windows `%LocalAppData%`
 * directory, a POSIX `~/.npm`) — and the probe is deliberately best-effort: a
 * layout it does not recognize yields undefined, and the download phase is then
 * reported as indeterminate rather than guessed at.
 * @param {{ env?: Record<string, string | undefined> }} [deps] - test seams.
 * @returns {string | undefined} the scratch directory, or undefined when npm's cache cannot be located.
 */
export function resolveNpmScratch(deps = {}) {
  const env = deps.env ?? process.env
  /** @type {string[]} */
  const caches = []
  if (typeof env.npm_config_cache === 'string' && env.npm_config_cache !== '') caches.push(env.npm_config_cache)
  if (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA !== '') caches.push(join(env.LOCALAPPDATA, 'npm-cache'))
  if (typeof env.APPDATA === 'string' && env.APPDATA !== '') caches.push(join(env.APPDATA, 'npm-cache'))
  const home = env.HOME ?? env.USERPROFILE
  if (typeof home === 'string' && home !== '') caches.push(join(home, '.npm'))
  const cache = caches.find(dir => existsSync(dir)) ?? caches[0]
  return cache === undefined ? undefined : join(cache, '_cacache', 'tmp')
}

/**
 * One task's public state, as the panel polls it.
 * @typedef {object} TaskView
 * @property {'idle' | 'running' | 'done' | 'failed'} state - settlement state.
 * @property {string} [version] - the target version of the current or last run.
 * @property {'manual' | 'auto' | 'scheduled'} [trigger] - who asked for this run.
 * @property {'auto' | 'official' | 'mirror'} [source] - which source this run was told to use.
 * @property {string} [registry] - the registry URL that source resolved to.
 * @property {string} log - captured stdout+stderr, tail-truncated.
 * @property {string} [error] - failure message when state is 'failed'.
 * @property {number} [startedAt] - epoch ms when the run started.
 * @property {number} [endedAt] - epoch ms when the run settled.
 * @property {TaskProgress} [progress] - the structured progress, from 'running' onward.
 */

/**
 * Create the single-slot update runner.
 * @param {{ spawnImpl?: typeof spawn; npmCli?: string; execPath?: string; env?: Record<string, string | undefined>; registry?: string; mirrorRegistry?: string; servedRegistry?: () => string | undefined; timeoutMs?: number; hardTimeoutMs?: number; installDir?: string; progressMs?: number; slowAfterMs?: number; now?: () => number; downloadBytes?: () => number | undefined | Promise<number | undefined>; lockPath?: string; beforeSpawn?: (version: string, report: (line: string) => void, progress: (info: { phase?: 'snapshot'; bytes: number; totalBytes?: number; files?: number }) => void) => void | Promise<void>; onSettled?: (info: { version: string; ok: boolean; trigger: 'manual' | 'auto' | 'scheduled'; previousVersion?: string; repairRequired?: true }) => void }} [deps] - test seams, the pre-install snapshot hook (async, reports progress lines and structured progress), the on-disk install directory the extraction watcher measures, the optional npm-cache probe that makes the download phase measurable, the machine-wide lock file path override, and the settlement observer the history keeps.
 * @returns {{ view: () => TaskView; busy: () => boolean; start: (version: string, trigger?: 'manual' | 'auto' | 'scheduled', options?: { source?: 'auto' | 'official' | 'mirror' }) => TaskView; dispose: () => void }} the runner.
 */
export function createUpdater(deps = {}) {
  const spawnImpl = deps.spawnImpl ?? spawn
  const onSettled = deps.onSettled
  const now = deps.now ?? Date.now
  const slowAfterMs = deps.slowAfterMs ?? SLOW_PROGRESS_MS
  // Both resolved once: a source id must map to a URL this process already
  // trusts, and normalizing on every start would only repeat the work.
  const configuredRegistry = deps.registry === undefined ? undefined : normalizeRegistry(deps.registry)
  const mirrorRegistry = normalizeRegistry(deps.mirrorRegistry ?? DEFAULT_MIRROR_REGISTRY)
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
   * The structured progress of the current (or last) run. Undefined while no
   * run has started, so an idle task view keeps its old shape.
   * @type {{ phase: 'preparing' | 'snapshot' | 'download' | 'extract' | 'verify' | 'done'; bytes: number; totalBytes?: number; files?: number; movedAt: number; extractTotal?: number; sawExtract: boolean } | undefined}
   */
  let progressState
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
  /**
   * Identity of the run THIS runner instance is responsible for, or 0 when it
   * has none. A monotonic token rather than a boolean, for the same reason
   * {@link processPreparing} is one: the guards that read it outlive the run
   * that wrote it.
   *
   * Every "is my run still the live one?" question is asked against THIS, never
   * against `task.state`. `settle` and `start` both REPLACE the `task` object,
   * so a pipeline abandoned by the hard ceiling — which releases the slot while
   * its snapshot is still copying — and then resumed reads the NEXT run's
   * `state: 'running'` out of the shared binding and concludes it is still live.
   * It then spawns npm for its own stale target and settles the new run with the
   * old run's outcome: the panel and the audit trail both report a version that
   * was never installed, while the version the user asked for is never spawned.
   * @type {number}
   */
  let activeRun = 0
  /** Monotonic source of {@link activeRun} identities. */
  let runSeq = 0
  /** Version observed under the lock, before any pre-install work. @type {string | undefined} */
  let previousVersion
  /** Validation failed even though npm exited zero; request explicit rollback. */
  let repairRequired = false

  /** @param {string} chunk - decoded npm output to append to the capped log. */
  const append = (chunk) => {
    task.log = (task.log + chunk).slice(-LOG_LIMIT)
  }

  /** Seconds since the running task started, for progress lines. */
  const elapsed = () => task.startedAt === undefined ? 0 : Math.max(0, Math.round((now() - task.startedAt) / 1000))

  /** @param {number} bytes - a byte count. @returns {string} human megabytes. */
  const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`

  /** @param {number} seconds - an elapsed count. @returns {string} `34s` or `2m 05s`. */
  const fmtElapsed = (seconds) => seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`

  /**
   * Fold one progress observation into the run's progress state.
   *
   * `movedAt` advances only when the phase changes or the byte count moves:
   * it is the timestamp the stall detector subtracts from, so a phase that
   * keeps re-reporting the same number must NOT look like movement — that is
   * precisely the "npm is silent and nothing is arriving" case the panel warns
   * about.
   * @param {{ phase?: 'preparing' | 'snapshot' | 'download' | 'extract' | 'verify' | 'done'; bytes?: number; totalBytes?: number; files?: number }} update - what was observed.
   * @returns {void}
   */
  const setProgress = (update) => {
    if (progressState === undefined) return
    const previous = progressState
    const next = { ...previous, ...update }
    if (next.bytes !== previous.bytes || next.phase !== previous.phase) next.movedAt = now()
    // The snapshot's measured size is the best denominator the extraction can
    // have: the tree being extracted is the same package as the one that was
    // copied, so the old tree's size is a real expectation rather than a guess.
    if (next.phase === 'snapshot' && typeof next.totalBytes === 'number') next.extractTotal = next.totalBytes
    if (next.phase === 'extract' && next.totalBytes === undefined && previous.extractTotal !== undefined) {
      next.totalBytes = previous.extractTotal
    }
    if (next.phase === 'extract') next.sawExtract = true
    progressState = next
  }

  /**
   * Whether this run has any live signal for its current phase. A phase the
   * runner cannot see must never be reported as stalled: "no movement" and
   * "no way to observe movement" are different facts, and only the first one
   * justifies telling the user their download is stuck.
   * @returns {boolean} true when the current phase has no measurable signal.
   */
  const progressBlind = () => {
    if (progressState === undefined) return true
    if (progressState.phase === 'download') return deps.downloadBytes === undefined
    if (progressState.phase === 'extract') return deps.installDir === undefined
    return false
  }

  /**
   * The progress as the panel reads it. Derived on every view() rather than
   * stored, because `stalledMs` and `slow` are facts about NOW: a run that
   * stopped moving must start reporting itself slow without any new event
   * having to arrive — and npm, mid-download, emits exactly none.
   * @returns {TaskProgress | undefined} the progress view, or undefined before any run.
   */
  const progressView = () => {
    if (progressState === undefined) return undefined
    const state = progressState
    const elapsedMs = task.startedAt === undefined ? 0 : Math.max(0, now() - task.startedAt)
    const stalledMs = Math.max(0, now() - state.movedAt)
    const total = state.phase === 'done' ? state.bytes : state.totalBytes
    const raw = total !== undefined && total > 0 ? Math.round((state.bytes / total) * 100) : undefined
    // A live extraction cannot be reported as complete before npm has exited:
    // the tree is measured while npm still holds retired copies of it, so a
    // transient overshoot would otherwise park the bar at 100% for the rest of
    // the run. A settled run, by contrast, is complete by definition.
    const percent = state.phase === 'done'
      ? 100
      : raw === undefined
        ? undefined
        : state.phase === 'extract' ? Math.min(99, Math.max(0, raw)) : Math.min(100, Math.max(0, raw))
    return {
      phase: state.phase,
      ...(percent !== undefined ? { percent } : {}),
      bytes: state.bytes,
      ...(total !== undefined ? { totalBytes: total } : {}),
      ...(state.files !== undefined ? { files: state.files } : {}),
      elapsedMs,
      stalledMs,
      slow: task.state === 'running' && !progressBlind() && stalledMs >= slowAfterMs,
      indeterminate: percent === undefined,
    }
  }

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
   * @param {number} runId - the run this settlement belongs to. A settlement
   *   from a run that is no longer the live one is INERT.
   * @param {'done' | 'failed'} state - the settled state.
   * @param {string} [error] - the failure reason, for a failed run.
   * @param {boolean} [holdSlot] - keep the shared slot and machine lock claimed;
   *   the caller releases them once a killed npm has actually exited.
   */
  const settle = (runId, state, error, holdSlot = false) => {
    // A run that is no longer live must not touch the task. Its own settlement
    // already happened — the hard ceiling is the case that produces this — and
    // whatever `task` holds now belongs to a NEWER run: settling here would
    // report the old run's target version and outcome as the new run's, which is
    // a success record for an install that never ran.
    if (activeRun !== runId) return
    activeRun = 0
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
    task = { ...task, state, endedAt: now(), ...(error !== undefined ? { error } : {}) }
    // A successful run's progress is COMPLETE, whatever the last measurement
    // happened to say: npm has exited and the tree has been verified, so the
    // bar belongs at 100% rather than at the last sampled percentage. A failed
    // run keeps the phase it died in, which is the one fact worth reading.
    if (state === 'done' && progressState !== undefined) {
      progressState = { ...progressState, phase: 'done', bytes: progressState.totalBytes ?? progressState.bytes, totalBytes: progressState.totalBytes ?? progressState.bytes, movedAt: now() }
    }
    // The history observer fires on the running→terminal transition only, so
    // a duplicate settlement event can never record one install twice — and a
    // throwing recorder cannot break the runner: the install itself has
    // already happened either way.
    if (onSettled !== undefined && settled.state === 'running') {
      try {
        const info = /** @type {{ version: string; trigger?: 'manual' | 'auto' | 'scheduled' }} */ (settled)
        onSettled({
          version: info.version, ok: state === 'done', trigger: info.trigger ?? 'manual',
          ...(previousVersion !== undefined ? { previousVersion } : {}),
          ...(repairRequired ? { repairRequired: true } : {}),
        })
      } catch {
        // See above: history is a passenger here, not the driver.
      }
    }
  }

  /**
   * Follow the npm phase's progress, on disk and — when the composition wired
   * one — in npm's cache scratch directory.
   *
   * npm prints nothing for long stretches: not while it streams a tarball, not
   * while it reifies. So the phase is inferred from what actually moves. Until
   * the installation directory moves at all, the run is DOWNLOADING; the
   * moment the tree is reset (the mid-reify removal of the old tree) or grows,
   * it is EXTRACTING, and that is one-way — an extraction whose growth stalls
   * below the reporting step must not be relabelled a download.
   *
   * The baseline re-arms when the directory shrinks, so the very first reading
   * (the OLD tree, still in place) never reports as progress, and the
   * extraction's percentage restarts from zero exactly when the tree does.
   * `downloadBytes`, when provided, supplies the only numerator the download
   * phase can have; without it the phase is reported as indeterminate rather
   * than as a fabricated percentage.
   * @param {number} runId - the run this watcher reports for; ticks that arrive
   *   after it stopped being the live run report nothing.
   */
  const watchInstall = (runId) => {
    if (deps.installDir === undefined && deps.downloadBytes === undefined) return
    if (progressTimer !== undefined) return
    const watchedDir = deps.installDir
    progressBytes = 0
    let seeded = false
    progressTimer = setInterval(() => {
      void (async () => {
        const measured = watchedDir === undefined
          ? undefined
          : await measureTree(watchedDir).catch(() => undefined)
        if (activeRun !== runId) return
        let downloaded
        if (deps.downloadBytes !== undefined) {
          try {
            downloaded = await deps.downloadBytes()
          } catch {
            // An unreadable cache is not progress, and not a reason to stop.
            downloaded = undefined
          }
        }
        if (activeRun !== runId) return
        if (measured !== undefined) {
          if (!seeded) {
            // The old tree, still in place: the reference point, not progress.
            seeded = true
            progressBytes = measured.bytes
          } else if (measured.bytes < progressBytes - INSTALL_PROGRESS_STEP) {
            progressBytes = measured.bytes
            setProgress({ phase: 'extract', bytes: measured.bytes, files: measured.files })
            return
          } else if (measured.bytes > progressBytes + INSTALL_PROGRESS_STEP) {
            progressBytes = measured.bytes
            setProgress({ phase: 'extract', bytes: measured.bytes, files: measured.files })
            append(`[installing] ${fmtElapsed(elapsed())} elapsed · ${fmtMB(measured.bytes)} extracted\n`)
            return
          }
        }
        if (progressState?.sawExtract === true) {
          // Already extracting: keep the byte count live without re-logging.
          if (measured !== undefined) setProgress({ phase: 'extract', bytes: measured.bytes, files: measured.files })
          return
        }
        const enteringDownload = progressState?.phase !== 'download'
        const previousBytes = enteringDownload ? 0 : progressState?.bytes ?? 0
        setProgress({
          phase: 'download',
          // The snapshot's byte counts belong to the snapshot phase; carrying
          // them into the download would report the copy's percentage as the
          // download's, which is the one thing a progress bar must never do.
          ...(enteringDownload ? { totalBytes: undefined, files: undefined } : {}),
          // The scratch file is emptied the moment its bytes are moved into the
          // content store, so the raw reading drops back to zero at the end of
          // every download. The phase therefore reports the high-water mark,
          // and an unmeasurable tick keeps the last count rather than resetting
          // the counter the user is watching.
          bytes: downloaded !== undefined ? Math.max(previousBytes, downloaded) : previousBytes,
        })
      })().catch(() => {})
    }, deps.progressMs ?? INSTALL_PROGRESS_MS)
  }

  /**
   * The post-start pipeline: snapshot the live tree (async, progress lines and
   * structured progress streamed out of the copy), then spawn npm against the
   * safe tree. Runs unawaited — start() has already answered with the running
   * task — and the settled-state checks between steps make a timeout
   * mid-snapshot simply abandon the pipeline instead of spawning against a
   * settled task.
   *
   * A preparation failure is normally logged past (a degraded rollback offer
   * must not become a refused update), with one exception: a
   * {@link FatalPreparationError} means the composition required something it
   * did not get — a rollback point, typically — and proceeding would destroy
   * the very tree that requirement protects. npm is then never spawned and the
   * task settles failed with the reason on it.
   * @param {string} version - the exact target version.
   * @param {string} npmCli - the resolved npm CLI path.
   * @param {string[]} registryArgs - the `--registry` arguments, if any.
   * @param {number} runId - this run's identity, captured by the caller.
   */
  const runPipeline = async (version, npmCli, registryArgs, runId) => {
    try {
      if (deps.beforeSpawn !== undefined) {
        try {
          await deps.beforeSpawn(version, append, setProgress)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          if (error !== null && typeof error === 'object' && /** @type {{ fatal?: unknown }} */ (error).fatal === true) {
            append(`\npreparation refused the install: ${reason}\n`)
            settle(runId, 'failed', reason)
            return
          }
          append(`snapshot failed, continuing without rollback safety: ${reason}\n`)
        }
      }
      // The pre-spawn hook is the ONLY suspension point before the spawn, so this
      // is where a run can have been abandoned while its snapshot was still
      // copying — by the hard ceiling, which frees the slot the instant it fires,
      // or by a disposal. Asked against the run identity and never `task.state`:
      // `start` has already replaced that with the NEXT run's `running`, which
      // would otherwise wave this stale pipeline straight through to spawn npm
      // for a target nobody is waiting for any more.
      if (activeRun !== runId) return
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
        // npm's reify retires the package it replaces by RENAMING it aside, and
        // on Windows it renames each child separately. A directory that is any
        // live process's working directory cannot be renamed there — the
        // directory itself held gives EBUSY, a held CHILD gives EPERM on its
        // parent. Without an explicit cwd the child inherits this host's, and a
        // `dsh web` started from inside its own tree hands npm the very
        // directory it is about to replace: the install then dies with EBUSY on
        // `dsh\lib` while npm's own cwd IS that directory. The temp directory
        // sits outside every tree this plugin manages, so the child can never
        // block its own rename.
        cwd: tmpdir(),
      })
      child = spawned
      slotChild = spawned
      processInstall = { child: spawned }
      // The spawned npm holds the process-wide slot through processInstall from
      // here on; the preparation claim is handed back the same way a settlement
      // would hand it back — only if this run still owns it.
      releasePrepareClaim()
      watchInstall(runId)
      // npm's own output is a movement signal even when it is not a byte
      // count: a line arriving proves the run is alive, which is what keeps a
      // chatty npm from being called slow while it works.
      /** @param {string} chunk - decoded npm output. */
      const appendAndNote = (chunk) => {
        append(chunk)
        if (progressState !== undefined) progressState.movedAt = now()
      }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', appendAndNote)
      child.stderr?.on('data', appendAndNote)
      child.on('error', (error) => {
        append(`\n${String(error)}\n`)
        settle(runId, 'failed', error instanceof Error ? error.message : String(error))
      })
      child.on('close', (code) => {
        if (activeRun !== runId) return
        if (code === 0) {
          // npm exit 0 proves npm finished, not that dsh can start. Verify the
          // tree before calling this done; a broken tree settles failed so the
          // host wiring restores the pre-install snapshot.
          if (deps.installDir !== undefined) {
            setProgress({ phase: 'verify' })
            const verdict = verifyInstalled({ installDir: deps.installDir, version })
            if (!verdict.ok) {
              repairRequired = true
              append(`\npost-install validation failed: ${verdict.problem}\n`)
              settle(runId, 'failed', `post-install validation failed: ${verdict.problem}`)
              return
            }
            append(`post-install validation passed: ${version} is on disk with a working launcher\n`)
          }
          append('\nnpm exited 0 — restart dsh for the new version to take effect.\n')
          settle(runId, 'done')
        } else {
          append(`\nnpm exited ${code}\n`)
          settle(runId, 'failed', `npm exited ${code}`)
        }
      })
    } catch (error) {
      // Any unexpected pipeline failure (a throwing spawnImpl, most plausibly)
      // must free the slot and report — never strand a phantom running task.
      // settle() releases the preparation claim and the lock with the identity
      // checks in place, so an orphaned failure cannot unlock a newer run.
      append(`\n${error instanceof Error ? error.message : String(error)}\n`)
      settle(runId, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Resolve one source id into the registry URL it means.
   *
   * `auto` reads the served registry at call time rather than at mount: the
   * configured URL is the wrong source precisely when it matters — a mirror
   * only ever answers because the configured one was unreachable, and asking
   * that URL again for the version on screen reports the offered update as
   * missing. `official` and `mirror` are the two ends a user can pin when the
   * automatic choice turns out to be the slow one.
   * @param {'auto' | 'official' | 'mirror'} source - the requested source.
   * @returns {string | undefined} the registry URL, or undefined to let npm use its own.
   */
  const resolveRegistry = (source) => {
    if (source === 'mirror') return mirrorRegistry
    if (source === 'official') return configuredRegistry
    const served = deps.servedRegistry !== undefined ? deps.servedRegistry() : undefined
    return served ?? configuredRegistry
  }

  return {
    view: () => ({ ...task, ...(progressState !== undefined ? { progress: progressView() } : {}) }),

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
     * process, when the version is not one exact published version, or when the
     * requested source is not one this runner knows.
     * @param {string} version - the exact target version.
     * @param {'manual' | 'auto' | 'scheduled'} [trigger] - who asked.
     * @param {{ source?: 'auto' | 'official' | 'mirror' }} [options] - which registry to fetch from.
     * @returns {TaskView} the fresh running task.
     */
    start(version, trigger = 'manual', options = {}) {
      // Validate before the concurrency check so a malformed target reports
      // what is wrong with it rather than what else is running.
      if (!TRIGGERS.includes(trigger)) throw new Error(`unknown trigger ${JSON.stringify(String(trigger))}`)
      if (!isInstallableVersion(version)) {
        throw new Error(`refusing to install ${JSON.stringify(String(version))}: not one exact published version`)
      }
      const source = options.source ?? 'auto'
      // The source ID is the ONLY thing a request may say about where the
      // package comes from; the URL is resolved here from host-side config, so
      // no request value can ever reach npm's command line.
      if (!INSTALL_SOURCES.includes(source)) {
        throw new Error(`unknown install source ${JSON.stringify(String(source))}`)
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
      // Install from wherever the offered versions actually came from, or from
      // the source the caller pinned. Read at spawn time, so the most recent
      // successful check decides what `auto` means.
      const registry = resolveRegistry(source)
      const registryArgs = registry === undefined ? [] : ['--registry', registry]
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
      previousVersion = deps.installDir === undefined ? undefined : readInstalled(deps.installDir).installed
      repairRequired = false
      // Claim the preparation window BEFORE answering: from here until the npm
      // spawn (or a settlement) the process-wide slot is held, so a second
      // start anywhere in the process is refused rather than racing. The token
      // is what lets the release paths tell their own claim from a newer one.
      prepareToken = ++prepareSeq
      processPreparing = prepareToken
      // This run's identity, taken before the pipeline starts so the pipeline and
      // all of its guards can hold on to it. See {@link activeRun}: the task
      // object cannot serve as the identity, because settle() replaces it.
      const runId = ++runSeq
      activeRun = runId
      // Enter the running state and answer AT ONCE — the snapshot copy and the
      // npm spawn proceed in runPipeline. The caller's HTTP response carries
      // this running task, so the panel shows a live progress bar (and, if it
      // asks for it, a live log) from the first second instead of a frozen
      // empty box.
      task = {
        state: 'running',
        version,
        trigger,
        source,
        ...(registry !== undefined ? { registry } : {}),
        log: `$ preparing to install ${DSH_PACKAGE}@${version}\n`,
        startedAt: now(),
      }
      // A fresh progress state per run: the panel must never read the previous
      // install's percentage over this one's first second.
      progressState = { phase: 'preparing', bytes: 0, movedAt: now(), sawExtract: false }
      const run = runPipeline(version, npmCli, registryArgs, runId)
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
        if (activeRun !== runId) return
        const minutes = Math.round((deps.timeoutMs ?? INSTALL_TIMEOUT_MS) / 60000)
        append(`\nnpm has been running for ${minutes} minutes — still waiting; the install is not interrupted mid-run because stopping npm then can leave the global tree half-committed.\n`)
      }, deps.timeoutMs ?? INSTALL_TIMEOUT_MS)
      // The one place npm IS killed: see the module note. A wedged run must
      // not hold the single task slot for the life of the process, and the
      // pre-install snapshot exists precisely so this stop can be repaired.
      hardTimer = setTimeout(() => {
        if (activeRun !== runId) return
        const killed = child
        child?.kill()
        append('\ninstall exceeded the hard time limit; npm was stopped and the pre-install snapshot will be restored to repair the tree.\n')
        // `kill()` only delivers a signal: the stopped npm may keep writing for
        // a moment. The panel must see the failure NOW, but the slot and the
        // machine lock stay claimed until the child has really exited —
        // otherwise the next install (or the repair this failure schedules)
        // races a zombie reify over the same global tree.
        settle(runId, 'failed', 'install exceeded the hard time limit', killed !== undefined)
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
      // The answer carries the progress model too, not just the log: the panel
      // draws its bar from the HTTP response to THIS request, before the first
      // poll has had a chance to arrive.
      return { ...task, progress: progressView() }
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

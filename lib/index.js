/**
 * dsh-version-update — host half, rewritten.
 *
 * Serves the loopback-only /api/dsh-version-update route family and owns the
 * automation loop: the policy store, the scheduler that turns a tracking rule
 * into silent installs inside their execution window, the snapshot center
 * that makes every install instantly reversible, and the restart handoff.
 * The browser half (./client) renders the 版本更新 page in the Web GUI
 * settings panel.
 *
 * This rewrite drops the old agent-announcement mechanism entirely: the
 * plugin no longer injects anything into the model's system prompt. It is a
 * user-facing facility — configured, triggered, and observed from the panel.
 *
 * Safety invariants kept from the previous design: only exact published
 * versions are accepted as install targets; npm is spawned without a shell;
 * every install snapshots the current tree first; routes are loopback-only.
 * @module dsh-version-update
 */

import z from '@deepseek-ai/schemastery'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { makeRoutes } from './routes.js'
import { runPreflight } from './preflight.js'
import { DEFAULT_MIRROR_REGISTRY, FatalPreparationError, createUpdater, resolveNpmCli, resolveNpmScratch, RELEASE_GRACE_MS } from './updater.js'
import { createRestarter, parseRequestedPort } from './restarter.js'
import { createOperationLog } from './opevents.js'
import {
  DEFAULT_REGISTRY,
  buildView,
  createNotesReader,
  fetchPublished,
  normalizeRegistry,
  readInstalled,
  readRepository,
  resolveInstallationDir,
} from './core.js'
import { appendHistory, defaultHistoryPath, loadHistory, summarizeHistory } from './history.js'
import { defaultPolicyPath, loadPolicy, savePolicy } from './policy.js'
import { normalizePolicy } from './protocol.js'
import { createScheduler } from './scheduler.js'
import { createSnapshotAsync, defaultSnapshotsDir, listSnapshots, measureTree, removeSnapshot, restoreSnapshotAsync, sweepSnapshots } from './snapshot.js'
import { DEFAULT_LOCK_PATH, acquireUpdateLock } from './updatelock.js'
import { RETIRED_MIN_AGE_MS, inspectTreeHealth, repairTree } from './tree-health.js'

/** Stable cordis plugin name. */
export const name = 'version-update'

/** Services required before the routes can mount. */
export const inject = ['webServer']

/**
 * Entry config, validated by cordis before this plugin starts. Deliberately
 * small: everything the user tunes at runtime (mode, tracking, window,
 * schedule) lives in the policy file the panel edits; these fields describe
 * the composition itself and change rarely enough to survive a host restart.
 */
export const Config = z.object({
  registry: z.string().pattern(/^https?:\/\//i).default(DEFAULT_REGISTRY)
    .description('Base URL of the npm registry read for versions AND installed from (absolute http(s) URL).'),
  mirrorRegistry: z.string().pattern(/^https?:\/\//i).default(DEFAULT_MIRROR_REGISTRY)
    .description('Registry the panel\'s "mirror" install source means, for when the configured one is slow (absolute http(s) URL).'),
  requireSnapshot: z.boolean().default(true)
    .description('Refuse an install whose pre-install rollback snapshot could not be written. On by default: the point of the snapshot is that a failed install cannot leave the machine without a way back.'),
  allowRestart: z.boolean().default(true)
    .description('Serve the restart route. When false the panel only reports that a manual restart is needed.'),
  releaseNotes: z.boolean().default(true)
    .description('Fetch the GitHub release notes of a target version and show them on the confirmation card.'),
  snapshotKeep: z.number().default(5)
    .description('How many version snapshots to retain for instant rollback (1-10).'),
  snapshotMaxBytes: z.number().default(0)
    .description('Maximum retained snapshot payload bytes (0 = unlimited). The just-created snapshot is always kept, even if it exceeds this quota.'),
  recoverOnFailedRestart: z.boolean().default(false)
    .description('When a restarted host never becomes reachable, the relaunch helper restores the previous version from its local snapshot and starts over. Opt-in: recovery runs while the broken process may still hold files.'),
  dataDir: z.string().default('')
    .description('Directory for plugin state (policy, history, snapshots). Empty uses ~/.dsh-version-update.'),
}).description('Version update: inspect, install, roll back, and automate dsh releases.')

/**
 * Clamp the snapshot retention into its sane range: one usable snapshot is
 * the floor (rollback must always exist once an install has happened), ten is
 * a generous ceiling against unbounded disk growth.
 * @param {unknown} value - the configured retention.
 * @returns {number} the clamped value.
 */
function clampSnapshotKeep(value) {
  const keep = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 5
  return Math.min(10, Math.max(1, keep))
}

/**
 * Mount the routes, the policy store, the scheduler, and the restart runner.
 *
 * `lockPath` is NOT part of {@link Config}: it is a composition seam for tests,
 * which must not acquire (or be refused by) the machine-wide lock the real
 * hosts share. Cordis never hands it in — the entry schema does not declare it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context carrying webServer.
 * @param {{ registry?: string; mirrorRegistry?: string; requireSnapshot?: boolean; allowRestart?: boolean; releaseNotes?: boolean; snapshotKeep?: number; snapshotMaxBytes?: number; recoverOnFailedRestart?: boolean; dataDir?: string; lockPath?: string }} [config] - entry config, already validated against {@link Config}, plus the test-only seam above.
 */
export function apply(ctx, config = {}) {
  // A configured registry that cannot be a URL is a typo, not a reason to lose
  // the whole route family: the panel would then report "host routes not
  // mounted" while the real problem is one setting. Report loudly and serve the
  // default registry instead. (Config.pattern() catches the common cases
  // earlier, with a message attached to the field itself.)
  let registry
  if (config?.registry === undefined || config.registry === '') {
    registry = undefined
  } else {
    try {
      registry = normalizeRegistry(config.registry)
    } catch (error) {
      console.error(`[dsh-version-update] invalid registry config, using ${DEFAULT_REGISTRY}: ${error instanceof Error ? error.message : String(error)}`)
      registry = undefined
    }
  }
  const allowRestart = config?.allowRestart !== false
  // Resolved once: the installation directory cannot move while this process
  // lives, and the discovery walk would otherwise run on every status poll.
  const installDir = resolveInstallationDir()
  // Captured at mount: the version whose code this process is actually
  // executing, which an update later makes disagree with the on-disk manifest.
  const running = readInstalled(installDir).installed
  // The GitHub repository release notes are read from, derived once.
  const repoSlug = readRepository(installDir)

  // ---- persisted state ----------------------------------------------------
  // One directory holds everything that must survive an update: the policy,
  // the history, and the snapshots. The default lives under the user profile;
  // a configured dataDir relocates it (portable installs, tests).
  const dataDir = typeof config?.dataDir === 'string' && config.dataDir !== ''
    ? config.dataDir
    : undefined
  const stateDir = dataDir ?? join(homedir(), '.dsh-version-update')
  const restartLogPath = join(stateDir, 'restart.log')
  const historyPath = dataDir === undefined ? defaultHistoryPath() : join(dataDir, 'history.json')
  const policyPath = dataDir === undefined ? defaultPolicyPath() : join(dataDir, 'policy.json')
  const snapshotsDir = dataDir === undefined ? defaultSnapshotsDir() : join(dataDir, 'snapshots')
  // The machine-wide update lock deliberately does NOT follow `dataDir`: its
  // entire purpose is to serialize hosts that share one global npm tree, and
  // two hosts configured with two different state directories (a portable and a
  // profile-bound one) must still contend for the SAME lock. One agreed
  // location, always. `lockPath` is a test seam exactly like the updater's own —
  // a composition test that must not disturb the machine names a file of its own.
  const updateLockPath = typeof config?.lockPath === 'string' && config.lockPath !== ''
    ? config.lockPath
    : DEFAULT_LOCK_PATH
  const snapshotKeep = clampSnapshotKeep(config?.snapshotKeep)

  /**
   * The live policy. Loaded once at mount; mutated only through `setPolicy`,
   * which validates, persists, and notifies the scheduler in one place so no
   * caller can forget a step.
   */
  let policy = loadPolicy(policyPath)

  /**
   * Replace the effective policy with a normalized patch of it.
   * @param {unknown} input - the submitted partial policy.
   * @throws {Error} with every rejected field named, for the route's 400.
   */
  const setPolicy = (input) => {
    const outcome = normalizePolicy(input, policy)
    if (!outcome.ok) throw new Error(outcome.issues.join('; '))
    // Persist BEFORE publishing: a failed write must not leave the scheduler
    // acting on a policy the next host start will not have.
    savePolicy(policyPath, outcome.value)
    policy = outcome.value
    scheduler.policyChanged()
  }

  // Ephemeral progress is separate from the persisted version-transition audit.
  const operations = createOperationLog()

  // ---- updater + history --------------------------------------------------
  /**
   * The parsed history summary, reused while the file behind it has not moved.
   * @type {{ mtimeMs: number; size: number; facts: Record<string, unknown> } | undefined}
   */
  let historyFacts

  /**
   * Summarize the audit trail, reading it at most once per change.
   *
   * These facts ride EVERY polling answer, and the trail is rewritten whole on
   * each record — so without this, the panel's poll cost a file read plus a
   * JSON.parse of the entire history every 800 ms, in the same process that is
   * pumping npm's output on those ticks. The (mtime, size) key catches every
   * foreign write: a rewrite that somehow preserved the size still arrives with a
   * newer mtime.
   * @returns {Record<string, unknown>} the ambient history facts.
   */
  const ambientHistory = () => {
    let stamp = { mtimeMs: -1, size: -1 }
    try {
      const stat = statSync(historyPath)
      stamp = { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      // No trail yet: the empty summary is a real answer, and stays correct until
      // a write creates the file, which moves the stamp.
    }
    if (historyFacts === undefined || historyFacts.mtimeMs !== stamp.mtimeMs || historyFacts.size !== stamp.size) {
      historyFacts = { ...stamp, facts: summarizeHistory(loadHistory(historyPath)) }
    }
    return historyFacts.facts
  }

  /**
   * Record one settled install or restore. `from` is what this process was
   * running when it began.
   * @param {string | undefined} from - the previous running version.
   * @param {{ to: string; ok: boolean; trigger?: string; restored?: boolean }} info - what happened.
   */
  const record = (from, { to, ok, trigger, restored }) => {
    try {
      appendHistory(historyPath, {
        at: Date.now(),
        ...(from !== undefined ? { from } : {}),
        to,
        result: ok ? 'ok' : 'failed',
        ...(trigger !== undefined ? { trigger } : {}),
        ...(restored === true ? { restored: true } : {}),
      })
      // Own writes leave the cache here rather than trusting the stamp: the repair
      // path can record twice inside one millisecond, and a capped rewrite can land
      // on the same size — the panel would then keep showing yesterday's trail on a
      // machine that just moved.
      historyFacts = undefined
    } catch {
      // History is an audit trail, not a dependency of the operation itself.
    }
  }

  // ---- registry provenance --------------------------------------------------
  /**
   * Which registry the last successful published read ACTUALLY came from.
   *
   * Usually this is {@link registry}, but a configured registry that fails at
   * the network layer makes {@link fetchPublished} fall through to a mirror: the
   * version list the panel is holding then came from somewhere else. Since the
   * install reads the same registry the panel read (see normalizeRegistry), an
   * install that ignored this would pass npm the URL that just proved
   * unreachable — the panel offers 1.2.3, npm cannot reach it, and the user is
   * told the version does not exist.
   *
   * Only {@link fetchPublished} results are ever stored here, so the value is
   * always the configured URL or one of the built-in mirrors: never request
   * input, and never a flag an npm command line could be steered with.
   * @type {string | undefined}
   */
  let servedRegistry

  /**
   * Read the published facts, remembering the registry that answered them.
   * @returns {Promise<Awaited<ReturnType<typeof fetchPublished>>>} dist-tags, versions, and their source.
   */
  const readPublished = async () => {
    const published = await fetchPublished({ ...(registry !== undefined ? { registry } : {}) })
    servedRegistry = published.registry
    return published
  }

  // Resolved once: the scratch directory npm stages in-flight downloads in
  // cannot move while this process lives, and the probe runs on every
  // extraction-watcher tick. Undefined means the layout was not recognized, and
  // the download phase reports itself as indeterminate instead of stalled.
  const npmScratch = resolveNpmScratch()
  /** Whether an install may proceed without the rollback point it promised. */
  const requireSnapshot = config?.requireSnapshot !== false

  const updater = createUpdater({
    ...(registry !== undefined ? { registry } : {}),
    ...(config?.mirrorRegistry !== undefined && config.mirrorRegistry !== ''
      ? { mirrorRegistry: normalizeRegistry(config.mirrorRegistry) }
      : {}),
    // Where the offered versions came from, read at spawn time rather than
    // captured at mount: the two only differ when a mirror answered.
    servedRegistry: () => servedRegistry,
    // The same lock the restore path contends on, named from one place so the
    // two writers of the global tree can never drift to different files.
    lockPath: updateLockPath,
    // The extraction watcher measures the installation directory while npm
    // rebuilds it, so the panel shows movement through npm's quiet stretches.
    ...(installDir !== undefined ? { installDir } : {}),
    // ...and npm's cache scratch directory supplies the download phase's only
    // honest byte count. Absent (or not yet created) means "not measurable",
    // never "not moving".
    ...(npmScratch !== undefined
      ? { downloadBytes: async () => existsSync(npmScratch) ? (await measureTree(npmScratch)).bytes : undefined }
      : {}),
    // Every install begins by making the current tree restorable. The hook is
    // async now: the copy runs on the threadpool with progress lines streamed
    // into the task log, and the runner answers the panel before it starts.
    ...(installDir !== undefined
      ? {
        beforeSpawn: /** @type {(version: string, report: (line: string) => void, progress: (info: { phase: 'snapshot'; bytes: number; totalBytes?: number; files?: number }) => void) => Promise<void>} */ (async (version, report, progress) => {
          /** @param {number} bytes - a byte count. @returns {string} human megabytes. */
          const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`
          // The snapshot must be keyed by the version of the TREE it copies
          // (the one running now), not by the install target: validity and
          // the restore/recovery paths all re-read the copied manifest and
          // compare it with the directory name. Naming by the target made
          // every fresh snapshot read as damaged and pruned immediately,
          // silently breaking rollback.
          const current = readInstalled(installDir).installed
          const snapshotVersion = current ?? version
          const outcome = await createSnapshotAsync({
            installDir,
            snapshotsDir,
            version: snapshotVersion,
            keep: snapshotKeep,
            maxBytes: config?.snapshotMaxBytes ?? 0,
            onProgress: (info) => {
              // The same facts serve both readers: the progress bar wants
              // numbers, the log wants a line it can scroll back through.
              progress({
                phase: 'snapshot',
                bytes: info.bytes,
                ...(info.totalBytes !== undefined ? { totalBytes: info.totalBytes } : {}),
                files: info.files,
              })
              if (info.phase === 'measure') {
                report(`snapshot: ${fmtMB(info.bytes)} in ${info.files} files — copying…\n`)
                return
              }
              const percent = info.totalBytes !== undefined && info.totalBytes > 0
                ? `${Math.min(100, Math.round((info.bytes / info.totalBytes) * 100))}% `
                : ''
              report(`snapshot: ${percent}${fmtMB(info.bytes)} copied\n`)
            },
          })
          if (!outcome.ok) {
            const reason = `rollback snapshot unavailable: ${outcome.error ?? 'unknown reason'}`
            // Without a rollback point a failed npm install has nothing to be
            // repaired from, and a half-committed global tree is exactly what
            // this plugin exists to make survivable. Refusing here keeps the
            // version the user is running intact; the alternative trades a
            // working installation for a maybe.
            if (requireSnapshot) {
              throw new FatalPreparationError(`${reason} — refusing to install: the current version could not be backed up first`)
            }
            throw new Error(reason)
          }
          if (outcome.reused === true) {
            report(`snapshot: reusing the existing rollback snapshot of ${snapshotVersion}\n`)
            // A reused snapshot is complete, and its recorded size is the
            // denominator the extraction phase would otherwise go without.
            const known = listSnapshots(snapshotsDir).find(entry => entry.version === snapshotVersion)
            if (known?.bytes !== undefined) {
              progress({ phase: 'snapshot', bytes: known.bytes, totalBytes: known.bytes })
            }
          }
        }),
      }
      : {}),

    onSettled: (info) => {
      // No begin hook exists here: report only the settlement we observed.
      operations.settle('install', {
        ok: info.ok,
        message: `install ${info.ok ? 'done' : 'failed'}: ${info.version} (${info.trigger})`,
        data: { version: info.version, trigger: info.trigger },
        ...(updater.view().error !== undefined ? { error: updater.view().error } : {}),
      })
      record(running, { to: info.version, ok: info.ok, trigger: info.trigger })
      // A failed install may have stopped mid-reify (hard timeout kill,
      // ENOSPC, a crashed npm): schedule the tree repair. The delay lets the
      // killed child finish dying so the restore does not race its writes.
      // A settled task that reports `repairRequired` needs the same pass even
      // when its own exit was otherwise fine — the updater validated the tree
      // after reify and found it damaged, and `previousVersion` is the version
      // whose snapshot is the repair source.
      if ((!info.ok || info.repairRequired === true) && installDir !== undefined) {
        if (repairTimer !== undefined) clearTimeout(repairTimer)
        /**
         * Try one repair pass, deferring while the tree has another owner.
         * @param {number} retries - how many more deferrals this pass may cost.
         * @returns {void}
         */
        const schedule = (retries) => {
          repairTimer = setTimeout(() => {
            repairTimer = undefined
            // Two things can still own the tree even though OUR task settled:
            // a killed npm finishing its last writes, and a snapshot copy that
            // has not been handed over yet. Repairing under either corrupts the
            // other's work as much as its own.
            if (updater.busy()) {
              if (retries > 0) schedule(retries - 1)
              return
            }
            // And a SECOND host may be mid-install on this same tree: it holds
            // the machine-wide lock, and its own pre-install snapshot is the
            // repair its failure needs, not ours.
            const lock = acquireUpdateLock({ lockPath: updateLockPath })
            if (!lock.ok) {
              if (retries > 0) schedule(retries - 1)
              return
            }
            try {
              runRepair(0, info.previousVersion)
            } finally {
              lock.release()
            }
          }, REPAIR_DELAY_MS)
        }
        schedule(REPAIR_RETRIES)
      }
      // Nothing restarts the host from here. A settled install leaves the disk
      // ahead of the running process, and the panel turns exactly that into its
      // 「立即重启」 button — the user's click is the only thing that hands the
      // port over. An unattended fallback used to fire under policy
      // `restart: 'auto'`, which is also the policy that made the install look
      // like it had crashed: the run rewrites the very files the page is served
      // from, so the page that would have reported the restart was usually the
      // first casualty.
    },
  })

  // ---- scheduler ----------------------------------------------------------
  const scheduler = createScheduler({
    policy: () => policy,
    installed: () => readInstalled(installDir).installed,
    check: () => readPublished(),
    updater,
  })

  // ---- tree health --------------------------------------------------------
  // A killed or crashed npm leaves the global tree half-committed: replaced
  // packages sit under retired temporary names and dsh itself may be missing.
  // A tree that cannot be launched counts as damaged on every pass, not only
  // after a failure: a manifest can parse while the entry point is gone, and
  // the recent-retirement guard inside repairTree is what keeps that check
  // from racing an npm that is still writing.
  // Repair paths, in one place each:
  // - at mount (this process just started, so nothing it spawned is writing):
  //   restore from a snapshot when the manifest or the launcher is damaged,
  //   and clear retirements older than RETIRED_MIN_AGE_MS (younger ones may
  //   belong to an npm orphaned by the PREVIOUS host, which can still be
  //   reifying);
  // - after a failed install settles: the same repair with no age threshold,
  //   preferring the version that run replaced, delayed past the killed
  //   child's last writes, and skipped if a new install has already started
  //   (its own snapshot covers it).
  /** The most recent tree-health fact, surfaced through the polling routes. */
  /** @type {{ installDir: string; manifestOk: boolean; launcherOk: boolean; leftovers: { name: string; path: string; ageMs: number }[]; healthy: boolean; removed?: number; restored?: string; errors?: string[]; at?: number } | undefined} */
  let treeHealth
  /**
   * Run one repair pass and refresh the tree-health facts.
   * @param {number} minAgeMs - minimum leftover age to delete (0 = unconditional).
   * @param {string} [preferredVersion] - snapshot version to prefer when the
   *   manifest must be rebuilt (the pre-install version of a failed install).
   */
  const runRepair = (minAgeMs, preferredVersion) => {
    if (installDir === undefined) return
    const id = operations.begin('repair')
    try {
      const outcome = repairTree({
        installDir,
        snapshotsDir,
        minAgeMs,
        ...(preferredVersion !== undefined ? { preferredVersion } : {}),
      })
      treeHealth = {
        ...inspectTreeHealth(installDir),
        healthy: outcome.manifestOk && outcome.launcherOk && outcome.errors.length === 0,
        ...(outcome.restored !== undefined ? { restored: outcome.restored } : {}),
        removed: outcome.removed,
        ...(outcome.errors.length > 0 ? { errors: outcome.errors } : {}),
        at: Date.now(),
      }
      operations.event(id, `restored: ${outcome.restored ?? 'none'}; removed: ${outcome.removed}`, {
        restored: outcome.restored ?? null, removed: outcome.removed,
      })
      operations.end(id, {
        ok: outcome.manifestOk && outcome.launcherOk && outcome.errors.length === 0,
        ...(outcome.errors.length > 0 ? { error: outcome.errors.join('; ') } : {}),
      })
      if (outcome.restored !== undefined || outcome.removed > 0 || outcome.errors.length > 0) {
        for (const line of outcome.errors) console.error(`[dsh-version-update] tree repair: ${line}`)
        record(running, {
          to: outcome.restored ?? readInstalled(installDir).installed ?? 'unknown',
          // A repair that reports errors did not fully succeed, and the panel
          // says exactly that — recording it as `ok` because the manifest
          // happens to parse would contradict the message the user is reading.
          // Same predicate as `treeHealth.healthy` and the `operations.end`
          // call above.
          ok: outcome.manifestOk && outcome.launcherOk && outcome.errors.length === 0,
          restored: true,
        })
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      operations.end(id, { ok: false, error: reason })
      console.error(`[dsh-version-update] tree repair failed: ${reason}`)
    }
  }
  /** Slack past the age gate, so the recheck cannot land a millisecond early. */
  const DEFERRED_SWEEP_SLACK_MS = 1000
  /** @type {NodeJS.Timeout | undefined} */
  let deferredSweepTimer
  /**
   * Look again at the leftovers the boot sweep had to defer.
   *
   * The boot pass runs exactly ONCE, and it deliberately refuses to delete a
   * retired folder younger than RETIRED_MIN_AGE_MS — a previous host's npm may
   * still be writing under one. Deferring is right; stopping there is not,
   * because nothing else ever looks again. And a retired folder born minutes
   * before the mount is the COMMON shape rather than a rare one: it is what a
   * failed install followed by a host restart leaves behind, and each one is a
   * whole copy of the tree — measured at 167 MB for this machine's dsh — that
   * then sits on disk until the NEXT restart.
   *
   * One follow-up pass is enough to converge. A retirement created after this
   * point belongs to an install THIS process spawned, and the post-failure
   * repair sweeps those with no age gate at all.
   */
  const scheduleDeferredSweep = () => {
    if (installDir === undefined) return
    const retained = treeHealth?.leftovers ?? []
    if (retained.length === 0) return
    const youngest = Math.min(...retained.map(entry => entry.ageMs))
    if (deferredSweepTimer !== undefined) clearTimeout(deferredSweepTimer)
    deferredSweepTimer = setTimeout(() => {
      deferredSweepTimer = undefined
      // An install may have started since the mount, and mid-reify the tree is
      // legitimately damaged — the repair's restore branch would fight npm for
      // the same directory. Whatever that install leaves is the post-failure
      // pass's job. The age gate alone is not enough cover here: it bounds the
      // DELETES but not the restore.
      if (updater.busy()) return
      runRepair(RETIRED_MIN_AGE_MS)
    }, Math.max(0, RETIRED_MIN_AGE_MS - youngest) + DEFERRED_SWEEP_SLACK_MS)
  }
  if (installDir !== undefined) {
    const before = inspectTreeHealth(installDir)
    treeHealth = { ...before, healthy: before.manifestOk && before.launcherOk && before.leftovers.every(entry => entry.ageMs < RETIRED_MIN_AGE_MS), at: Date.now() }
    if (before.manifestOk === false || before.leftovers.length > 0) {
      runRepair(RETIRED_MIN_AGE_MS)
      scheduleDeferredSweep()
    }
  }
  /**
   * How long a failed install leaves its tree alone before the repair runs: one
   * killed-npm release grace plus headroom, so the common "hard ceiling killed
   * npm" case has already been reaped by the time the repair looks.
   */
  const REPAIR_DELAY_MS = RELEASE_GRACE_MS + 1000
  /** How many further deferrals a busy tree or a contended lock may cost. */
  const REPAIR_RETRIES = 3
  /** @type {NodeJS.Timeout | undefined} */
  let repairTimer

  // ---- restart ------------------------------------------------------------
  const requestedPort = parseRequestedPort(process.argv)
  const restarter = !allowRestart ? undefined : createRestarter({
    ...(installDir !== undefined ? { installDir: () => installDir } : {}),
    address: () => {
      const port = ctx.webServer.port
      if (typeof port !== 'number') return undefined
      return {
        host: ctx.webServer.host,
        port,
        ...(requestedPort !== undefined ? { requestedPort } : {}),
      }
    },
    // Recovery arms only when a USABLE snapshot of this process's own version
    // exists — otherwise the helper would discover the same fact too late.
    ...(config?.recoverOnFailedRestart !== true || running === undefined || installDir === undefined
      ? {}
      : {
        recovery: () => {
          const usable = listSnapshots(snapshotsDir).find(entry => entry.version === running && entry.usable)
          return usable === undefined
            ? undefined
            : { version: running, installDir, snapshotsDir }
        },
      }),
  })

  // ---- injected operations ------------------------------------------------
  /**
   * Run one tree-writing operation while holding the machine-wide update lock.
   *
   * The updater's process-wide slot only ever sees THIS host process; a restore
   * started from the panel has no reason to look like an install to a second
   * host that is mid-`npm install -g` next door. Both writers swap the same
   * global tree, and an interleaved rename/copy is the half-committed state the
   * snapshot machinery exists to escape from — so every path that overwrites
   * the installation takes this lock, install or not.
   * @template T
   * @param {() => Promise<T> | T} operation - the work to do under the lock.
   * @returns {Promise<T | { ok: false; error: string }>} the operation's result,
   *   or a refusal shaped like one when another host holds the lock.
   */
  const withUpdateLock = async (operation) => {
    const lock = acquireUpdateLock({ lockPath: updateLockPath })
    if (!lock.ok) {
      return { ok: false, error: `another host holds the machine-wide update lock (pid ${String(lock.holder?.pid)}); try again once it finishes` }
    }
    try {
      return await operation()
    } finally {
      lock.release()
    }
  }

  /** Snapshot center operations handed to the routes. */
  const snapshotOps = installDir === undefined
    ? undefined
    : {
      list: () => listSnapshots(snapshotsDir),
      /**
       * Restore one snapshot over the live installation, serialized against
       * every other writer of that tree.
       * @param {string} version - the exact snapshot version to restore.
       * @returns {Promise<{ ok: boolean; error?: string; backup?: string }>} the outcome.
       */
      restore: async (version) => {
        const id = operations.begin('restore', { message: `restore ${version}`, data: { version } })
        try {
          const outcome = await withUpdateLock(async () => {
            const current = readInstalled(installDir).installed
            const restored = await restoreSnapshotAsync({
              installDir,
              snapshotsDir,
              version,
              // Keep the tree this restore replaces as the snapshot of the
              // version being left behind. It costs one rename of a tree that
              // is being moved anyway, and it is what makes a restore
              // reversible: without it, the version you roll away from has no
              // rollback point until the next install, so a mistaken restore
              // cannot be undone from this panel at all.
              adopt: {
                keep: snapshotKeep,
                maxBytes: config?.snapshotMaxBytes ?? 0,
                // ...but the adoption's own pruning must never evict the
                // snapshot being restored TO: it is the oldest entry in the
                // store precisely when a user rolls back the furthest, which
                // is when they need it most.
                protect: [version],
              },
            })
            record(current, { to: version, ok: restored.ok, restored: true })
            return restored
          })
          if ('backupError' in outcome && outcome.backupError !== undefined) {
            console.error(`[dsh-version-update] the replaced tree could not be kept as a snapshot: ${outcome.backupError}`)
          }
          operations.end(id, outcome)
          return outcome
        } catch (error) {
          operations.end(id, { ok: false, error: error instanceof Error ? error.message : String(error) })
          throw error
        }
      },
      /**
       * Discard one stored snapshot, serialized against every writer of the tree:
       * a runner that fails mid-install looks for exactly this directory as its
       * way out, and a restore of the same version would be copying files that are
       * being unlinked under it. Not a history event — the audit trail records
       * transitions of the installed version, and deleting a backup changes none.
       *
       * The removal itself only renames the directory out of the version
       * namespace; the bytes go on the threadpool, so this answers in
       * milliseconds however large the snapshot is. The lock therefore covers
       * the rename and nothing else, which is all it needs to.
       * @param {string} version - the exact snapshot version to discard.
       * @returns {Promise<{ ok: boolean; error?: string }>} the outcome.
       */
      remove: async (version) => await withUpdateLock(() => {
        const outcome = removeSnapshot(snapshotsDir, version)
          ? { ok: true }
          : { ok: false, error: `no snapshot of ${version} to delete` }
        // A tombstone whose unlink cannot complete would otherwise sit there
        // until the next mount; this retries the store on every delete.
        void sweepSnapshots(snapshotsDir).catch(() => {})
        return outcome
      }),
    }

  /** Ambient facts merged into both polling routes. */
  const ambient = () => ({
    ...scheduler.view(),
    ...ambientHistory(),
    ...(treeHealth !== undefined ? { tree: treeHealth } : {}),
  })

  // ---- effects ------------------------------------------------------------
  ctx.effect(() => {
    const disposers = makeRoutes({
      updater,
      operations,
      ...(restarter !== undefined ? { restarter, restartLogPath } : {}),
      ...(running !== undefined ? { running } : {}),
      ...(registry !== undefined ? { registry } : {}),
      // The panel's own read is the one whose versions get clicked, so it is the
      // read whose source has to be remembered.
      served: url => { servedRegistry = url },
      ...(installDir !== undefined ? { installDir } : {}),
      ...(config?.releaseNotes !== false && repoSlug !== undefined
        ? { notes: createNotesReader(), repoSlug }
        : {}),
      ambient,
      policy: { get: () => ({ ...policy }), set: setPolicy },
      // The panel's deliberate "I just opened, evaluate the policy" POST feeds
      // the auto-update decision, so a silent policy acts on what the page just
      // read even when no daily checkAt is configured — the scheduler's timers
      // are not its only trigger. Only the acting check route reaches this:
      // the GET read and the explicit manual check observe and never install.
      auto: (published) => scheduler.consider(published),
      pendingCancel: () => scheduler.cancelPending(),
      preflight: () => runPreflight({
        ...(installDir !== undefined ? { installDir } : {}),
        snapshotsDir,
        npmCli: () => resolveNpmCli({ execPath: process.execPath, env: process.env }),
      }),
      // Button checks refresh the scheduler's facts without authorizing an install.
      manualCheck: async (published) => {
        try {
          await scheduler.consider(published, { manual: true })
        } catch {
          // A decision failure must not hide a successful registry read.
        }
        return buildView({ ...readInstalled(installDir), ...published })
      },
      ...(snapshotOps !== undefined ? { snapshots: snapshotOps } : {}),
    }).routes.map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
      scheduler.dispose()
      updater.dispose()
      if (repairTimer !== undefined) clearTimeout(repairTimer)
      if (deferredSweepTimer !== undefined) clearTimeout(deferredSweepTimer)
    }
  }, 'dsh-version-update: routes')

  // The scheduler runs as its own effect so a fiber reload stops it
  // deterministically. Three things can trigger a check: the one guaranteed
  // check shortly after boot (armed only under `mode: 'auto'` — see
  // STARTUP_CHECK_MS), the configured daily moment, and opening the panel.
  // The startup check is what makes a silent policy reliable on a machine that
  // is not running at its `checkAt`: a host that was off at that moment used to
  // miss the whole day, every day.
  ctx.effect(() => {
    scheduler.start()
    return () => {}
  }, 'dsh-version-update: scheduler')

  // Reclaim what a killed process left in the snapshot store: a copy that was
  // interrupted mid-flight (`.tmp-*`) and a discarded snapshot whose unlink
  // never finished (`.trash-*`) — and a restart landing mid-unlink is exactly
  // how the second kind is born. Both are hidden from the panel, so nothing
  // else would ever free their disk. Deliberately off the mount path: a sweep
  // can take seconds and no part of the page waits on it.
  ctx.effect(() => {
    void sweepSnapshots(snapshotsDir).catch(() => {})
    return () => {}
  }, 'dsh-version-update: snapshot sweep')

  // A missing policy file combined with an existing history means an upgrade
  // from the previous plugin generation; leave the defaults alone rather than
  // guessing the user's intent. Nothing else to migrate: the old history file
  // loads as-is (entries without `trigger` stay valid).
  //
  // Best-effort: this runs AFTER the effects above, so letting an unwritable
  // state directory throw here would leave a mounted-then-failed fiber for
  // what is only an optimization (materializing the defaults on disk).
  if (!existsSync(policyPath)) {
    try {
      savePolicy(policyPath, policy)
    } catch (error) {
      console.error(`[dsh-version-update] cannot write ${policyPath}; the policy stays in memory: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export { readInstalled, resolveInstallationDir }

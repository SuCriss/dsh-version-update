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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeRoutes } from './routes.js'
import { createUpdater, RELEASE_GRACE_MS, resolveNpmCli } from './updater.js'
import { createRestarter, parseRequestedPort } from './restarter.js'
import { AUTO_RESTART_DELAY_MS, MANUAL_RESTART_GRACE_MS } from './restarter.js'
import {
  DEFAULT_REGISTRY,
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
import { createSnapshotAsync, defaultSnapshotsDir, listSnapshots, restoreSnapshotAsync } from './snapshot.js'
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
  allowRestart: z.boolean().default(true)
    .description('Serve the restart route. When false the panel only reports that a manual restart is needed.'),
  releaseNotes: z.boolean().default(true)
    .description('Fetch the GitHub release notes of a target version and show them on the confirmation card.'),
  snapshotKeep: z.number().default(5)
    .description('How many version snapshots to retain for instant rollback (1-10).'),
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
 * @param {{ registry?: string; allowRestart?: boolean; releaseNotes?: boolean; snapshotKeep?: number; recoverOnFailedRestart?: boolean; dataDir?: string; lockPath?: string }} [config] - entry config, already validated against {@link Config}, plus the test-only seam above.
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

  // ---- updater + history --------------------------------------------------
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

  const updater = createUpdater({
    ...(registry !== undefined ? { registry } : {}),
    // Where the offered versions came from, read at spawn time rather than
    // captured at mount: the two only differ when a mirror answered.
    servedRegistry: () => servedRegistry,
    // The same lock the restore path contends on, named from one place so the
    // two writers of the global tree can never drift to different files.
    lockPath: updateLockPath,
    // The extraction watcher measures the installation directory while npm
    // rebuilds it, so the panel shows movement through npm's quiet stretches.
    ...(installDir !== undefined ? { installDir } : {}),
    // Every install begins by making the current tree restorable. The hook is
    // async now: the copy runs on the threadpool with progress lines streamed
    // into the task log, and the runner answers the panel before it starts.
    ...(installDir !== undefined
      ? {
        beforeSpawn: /** @type {(version: string, report: (line: string) => void) => Promise<void>} */ (async (version, report) => {
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
            onProgress: (info) => {
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
          if (!outcome.ok) throw new Error(`rollback snapshot unavailable: ${outcome.error ?? 'unknown reason'}`)
          if (outcome.reused === true) report(`snapshot: reusing the existing rollback snapshot of ${snapshotVersion}\n`)
        }),
      }
      : {}),
    onSettled: (info) => {
      record(running, { to: info.version, ok: info.ok, trigger: info.trigger })
      // A failed install may have stopped mid-reify (hard timeout kill,
      // ENOSPC, a crashed npm): schedule the tree repair. The delay lets the
      // killed child finish dying so the restore does not race its writes.
      if (!info.ok && installDir !== undefined) {
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
              runRepair(0)
            } finally {
              lock.release()
            }
          }, REPAIR_DELAY_MS)
        }
        schedule(REPAIR_RETRIES)
      }
      // Policy `restart: 'auto'` restarts into the new version with or
      // without a live browser. The interactive panel normally drives the
      // countdown and sends POST /restart itself — but the install has just
      // replaced the files the browser is serving from, so the page can go
      // blank mid-countdown and that handoff is never sent. The host-side
      // fallback waits out the panel's countdown window, then restarts
      // anyway, so a manual install still lands without a live page.
      if (info.ok && policy.restart === 'auto') {
        restarter?.restartAfterDelay(info.trigger === 'auto' ? AUTO_RESTART_DELAY_MS : MANUAL_RESTART_GRACE_MS)
      }
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
  // Repair paths, in one place each:
  // - at mount (this process just started, so nothing it spawned is writing):
  //   restore from a snapshot when the manifest is damaged, and clear
  //   retirements older than RETIRED_MIN_AGE_MS (younger ones may belong to
  //   an npm orphaned by the PREVIOUS host, which can still be reifying);
  // - after a failed install settles: same repair with no age threshold,
  //   delayed past the killed child's last writes, skipped if a new install
  //   has already started (its own snapshot covers it).
  /** The most recent tree-health fact, surfaced through the polling routes. */
  /** @type {{ installDir: string; manifestOk: boolean; leftovers: { name: string; path: string; ageMs: number }[]; healthy: boolean; removed?: number; restored?: string; errors?: string[]; at?: number } | undefined} */
  let treeHealth
  /**
   * Run one repair pass and refresh the tree-health facts.
   * @param {number} minAgeMs - minimum leftover age to delete (0 = unconditional).
   */
  const runRepair = (minAgeMs) => {
    if (installDir === undefined) return
    try {
      const outcome = repairTree({ installDir, snapshotsDir, minAgeMs })
      treeHealth = {
        ...inspectTreeHealth(installDir),
        healthy: outcome.manifestOk && outcome.errors.length === 0,
        ...(outcome.restored !== undefined ? { restored: outcome.restored } : {}),
        removed: outcome.removed,
        ...(outcome.errors.length > 0 ? { errors: outcome.errors } : {}),
        at: Date.now(),
      }
      if (outcome.restored !== undefined || outcome.removed > 0 || outcome.errors.length > 0) {
        for (const line of outcome.errors) console.error(`[dsh-version-update] tree repair: ${line}`)
        record(running, {
          to: outcome.restored ?? readInstalled(installDir).installed ?? 'unknown',
          ok: outcome.manifestOk,
          restored: true,
        })
      }
    } catch (error) {
      console.error(`[dsh-version-update] tree repair failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (installDir !== undefined) {
    const before = inspectTreeHealth(installDir)
    treeHealth = { ...before, healthy: before.manifestOk && before.leftovers.every(entry => entry.ageMs < RETIRED_MIN_AGE_MS), at: Date.now() }
    if (before.manifestOk === false || before.leftovers.length > 0) runRepair(RETIRED_MIN_AGE_MS)
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
       * @returns {Promise<{ ok: boolean; error?: string }>} the outcome.
       */
      restore: async (version) => await withUpdateLock(async () => {
        const current = readInstalled(installDir).installed
        const outcome = await restoreSnapshotAsync({ installDir, snapshotsDir, version })
        record(current, { to: version, ok: outcome.ok, restored: true })
        return outcome
      }),
    }

  /** Ambient facts merged into both polling routes. */
  const ambient = () => ({
    ...scheduler.view(),
    ...summarizeHistory(loadHistory(historyPath)),
    ...(treeHealth !== undefined ? { tree: treeHealth } : {}),
  })

  // ---- effects ------------------------------------------------------------
  ctx.effect(() => {
    const disposers = makeRoutes({
      updater,
      ...(restarter !== undefined ? { restarter } : {}),
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
      // Every successful panel check feeds the auto-update decision, so a
      // silent policy acts on what the page just read even when no daily
      // checkAt is configured — the scheduler's timers are not its only trigger.
      auto: (published) => scheduler.consider(published),
      ...(snapshotOps !== undefined ? { snapshots: snapshotOps } : {}),
    }).routes.map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
      scheduler.dispose()
      updater.dispose()
      if (repairTimer !== undefined) clearTimeout(repairTimer)
    }
  }, 'dsh-version-update: routes')

  // The scheduler runs as its own effect so a fiber reload stops it
  // deterministically. First mount seeds nothing automatically: checks happen
  // at the configured daily moment or whenever the panel opens.
  ctx.effect(() => {
    scheduler.start()
    return () => {}
  }, 'dsh-version-update: scheduler')

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

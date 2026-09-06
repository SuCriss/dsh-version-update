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
import { createUpdater, resolveNpmCli } from './updater.js'
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
import { createSnapshotAsync, defaultSnapshotsDir, listSnapshots, restoreSnapshot } from './snapshot.js'
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
  registry: z.string().default(DEFAULT_REGISTRY)
    .description('Base URL of the npm registry read for versions AND installed from.'),
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
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context carrying webServer.
 * @param {{ registry?: string; allowRestart?: boolean; releaseNotes?: boolean; snapshotKeep?: number; recoverOnFailedRestart?: boolean; dataDir?: string }} [config] - entry config, already validated against {@link Config}.
 */
export function apply(ctx, config = {}) {
  const registry = config?.registry === undefined ? undefined : normalizeRegistry(config.registry)
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
    policy = outcome.value
    savePolicy(policyPath, policy)
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

  const updater = createUpdater({
    ...(registry !== undefined ? { registry } : {}),
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
        repairTimer = setTimeout(() => {
          repairTimer = undefined
          // A new install owns the tree now; its own pre-install snapshot is
          // the current rollback safety, and deleting retired folders under a
          // live reify would race its renames.
          if (updater.view().state === 'running') return
          runRepair(0)
        }, REPAIR_DELAY_MS)
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
    check: () => fetchPublished({ ...(registry !== undefined ? { registry } : {}) }),
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
  let treeHealth
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
  /** Milliseconds a settled killed npm is given to finish dying before repair. */
  const REPAIR_DELAY_MS = 3000
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
  /** Snapshot center operations handed to the routes. */
  const snapshotOps = installDir === undefined
    ? undefined
    : {
      list: () => listSnapshots(snapshotsDir),
      /** @param {string} version - the exact snapshot version to restore. */
      restore: (version) => {
        const current = readInstalled(installDir).installed
        const outcome = restoreSnapshot({ installDir, snapshotsDir, version })
        if (outcome.ok) record(current, { to: version, ok: true, restored: true })
        else record(current, { to: version, ok: false, restored: true })
        return outcome
      },
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
      ...(installDir !== undefined ? { installDir } : {}),
      ...(config?.releaseNotes !== false && repoSlug !== undefined
        ? { notes: createNotesReader(), repoSlug }
        : {}),
      ambient,
      policy: { get: () => ({ ...policy }), set: setPolicy },
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
  if (!existsSync(policyPath)) savePolicy(policyPath, policy)
}

export { readInstalled, resolveInstallationDir }

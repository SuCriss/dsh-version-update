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
import { createSnapshot, defaultSnapshotsDir, listSnapshots, restoreSnapshot } from './snapshot.js'

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
    // Every install begins by making the current tree restorable.
    ...(installDir !== undefined
      ? {
        beforeSpawn: /** @type {(version: string) => void} */ ((version) => {
          const outcome = createSnapshot({ installDir, snapshotsDir, version, keep: snapshotKeep })
          if (!outcome.ok) throw new Error(`rollback snapshot unavailable: ${outcome.error ?? 'unknown reason'}`)
        }),
      }
      : {}),
    onSettled: (info) => {
      record(running, { to: info.version, ok: info.ok, trigger: info.trigger })
      // Unattended auto-restart: only for installs the POLICY started, only
      // when the policy says so at settlement time, and only when this
      // composition can actually hand the process over.
      if (info.ok && info.trigger === 'auto' && policy.restart === 'auto') {
        restarter?.restartAfterDelay()
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

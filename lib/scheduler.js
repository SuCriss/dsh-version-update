/**
 * The automation loop behind the four new capabilities: one owner for WHEN to
 * check, WHAT counts as newer, and WHETHER to install without asking.
 *
 * The loop is deliberately boring — two independent timers over one pure
 * decision. A daily timer fires the configured `checkAt` moment (the planned
 * check); a second timer wakes only when an auto install is WAITING for its
 * execution window to open. Every decision itself happens in
 * {@link resolveTarget} and {@link inWindow}, both pure and exhaustively
 * tested; this module only wires them to wall-clock time.
 *
 * The scheduler never reads the policy file itself: the host owns the live
 * policy object (routes mutate it), and pushes it in through `deps.policy`.
 * When the policy changes mid-flight, `policyChanged` re-arms the timers so a
 * newly configured check time takes effect without a host restart.
 *
 * Restarting after a silent install is NOT this module's job: settlement is
 * observed once, in the host composition, where the same hook records history
 * regardless of who asked for the install.
 * @module dsh-version-update/scheduler
 */

import { inWindow, nextOccurrence } from './protocol.js'
import { compareVersions, matchesLine, resolveTarget } from './core.js'

/** Re-arm jitter: fire timers a hair early rather than a hair late. */
const EARLY_MS = 50

/**
 * What the last cycle concluded, as the ambient state the panel polls.
 * @typedef {object} CheckView
 * @property {number} [at] - epoch ms of the last finished cycle.
 * @property {string} [error] - why the registry read failed.
 * @property {boolean} [updateAvailable] - whether tracking found something newer.
 * @property {string} [target] - the resolved version, when one exists.
 * @property {string} [latest] - the tracked channel's version, when readable.
 */

/**
 * Create the scheduler.
 * @param {{ policy: () => import('./protocol.js').Policy; installed: () => string | undefined; check: () => Promise<{ distTags: Record<string, string>; versions: string[] }>; updater: { start: (version: string, trigger?: 'manual' | 'auto' | 'scheduled') => unknown }; now?: () => Date }} deps - the live policy, the installed facts, the registry read, and the runner.
 * @returns {{ start: () => void; dispose: () => void; policyChanged: () => void; runCycle: () => Promise<void>; view: () => { lastCheck: CheckView; nextCheckAt?: number; pendingAuto?: { target: string; since: number } } }} the scheduler.
 */
export function createScheduler(deps) {
  const now = deps.now ?? (() => new Date())
  /** @type {NodeJS.Timeout | undefined} */
  let dailyTimer
  /** @type {NodeJS.Timeout | undefined} */
  let windowTimer
  let stopped = false
  /** @type {CheckView} */
  let lastCheck = {}
  /** @type {{ target: string; since: number } | undefined} */
  let pendingAuto

  /**
   * Arm the daily planned check for the current policy's `checkAt`.
   * A missing or null checkAt simply leaves nothing armed — manual checks
   * from the panel still work, they just bypass this module entirely.
   */
  const armDaily = () => {
    if (dailyTimer !== undefined) {
      clearTimeout(dailyTimer)
      dailyTimer = undefined
    }
    const due = nextOccurrence(/** @type {string | null} */ (deps.policy().checkAt) ?? '', now())
    if (due === undefined) return
    const delay = Math.max(0, due.getTime() - now().getTime() - EARLY_MS)
    dailyTimer = setTimeout(() => { void runCycle('scheduled') }, delay)
    dailyTimer.unref?.()
  }

  /**
   * Arm (or disarm) the window wake-up for a waiting auto install.
   * When no window is configured there is nothing to wait for — the install
   * runs immediately — so any stale timer is dropped.
   */
  const armWindowWake = () => {
    if (windowTimer !== undefined) {
      clearTimeout(windowTimer)
      windowTimer = undefined
    }
    if (pendingAuto === undefined) return
    const window = deps.policy().window
    if (window === null || window === undefined) return
    const due = nextOccurrence(window.start, now())
    if (due === undefined) return
    const delay = Math.max(0, due.getTime() - now().getTime() - EARLY_MS)
    windowTimer = setTimeout(() => { void attemptPendingInstall() }, delay)
    windowTimer.unref?.()
  }

  /**
   * Try to install the version an earlier cycle found while outside the
   * execution window. Called by the window timer, and directly by cycles that
   * find themselves already inside the window.
   * @param {string} target - the resolved version.
   * @returns {boolean} whether the install actually started.
   */
  const beginAutoInstall = (target) => {
    try {
      deps.updater.start(target, 'auto')
      pendingAuto = undefined
      return true
    } catch {
      // The slot may be busy with a manual install; leave the finding parked
      // so the next window wake (or the next cycle) can retry it.
      return false
    }
  }

  /** The window timer's callback: the window has opened again. */
  const attemptPendingInstall = () => {
    windowTimer = undefined
    if (pendingAuto === undefined || stopped) return
    const window = deps.policy().window
    const minutes = now().getHours() * 60 + now().getMinutes()
    // The wake fired for THIS window opening; still verify, because the
    // policy may have changed while the timer sat armed.
    if (window !== null && window !== undefined && !inWindow(minutes, window)) return
    if (beginAutoInstall(pendingAuto.target)) armWindowWake()
  }

  /**
   * Run one full decide-and-maybe-install cycle. Exposed so tests (and the
   * host's first mount) can drive a cycle without waiting for the clock.
   * @param {'scheduled' | 'manual'} [trigger] - why this cycle runs.
   */
  const runCycle = async (trigger = 'scheduled') => {
    let published
    try {
      published = await deps.check()
    } catch (error) {
      lastCheck = { at: Date.now(), error: error instanceof Error ? error.message : String(error) }
      return
    }
    const installed = deps.installed()
    const policy = deps.policy()
    const verdict = resolveTarget(policy.track, installed, published)
    lastCheck = {
      at: Date.now(),
      updateAvailable: verdict.target !== undefined,
      ...(verdict.target !== undefined ? { target: verdict.target } : {}),
      ...(installed !== undefined ? { latest: resolveTrackedVersion(policy.track, published) } : {}),
    }
    if (verdict.target === undefined) return
    if (policy.mode !== 'auto') return
    const minutes = now().getHours() * 60 + now().getMinutes()
    if (policy.window !== null && !inWindow(minutes, policy.window)) {
      // Park the finding and wait for the window; overwrite any older parked
      // target — only the newest discovery matters.
      pendingAuto = { target: verdict.target, since: Date.now() }
      armWindowWake()
      return
    }
    if (!beginAutoInstall(verdict.target)) {
      pendingAuto = { target: verdict.target, since: Date.now() }
      armWindowWake()
    }
  }

  return {
    start() {
      stopped = false
      armDaily()
      armWindowWake()
    },

    dispose() {
      stopped = true
      if (dailyTimer !== undefined) clearTimeout(dailyTimer)
      if (windowTimer !== undefined) clearTimeout(windowTimer)
      dailyTimer = undefined
      windowTimer = undefined
    },

    /** Re-read the policy and re-arm everything it configures. */
    policyChanged() {
      if (stopped) return
      armDaily()
      armWindowWake()
    },

    runCycle,

    view() {
      return {
        lastCheck: { ...lastCheck },
        ...(dailyTimer !== undefined && deps.policy().checkAt !== null
          ? { nextCheckAt: nextOccurrence(/** @type {string} */ (deps.policy().checkAt), now())?.getTime() }
          : {}),
        ...(pendingAuto !== undefined ? { pendingAuto: { ...pendingAuto } } : {}),
      }
    },
  }
}

/**
 * The version the current track points at, for display: the dist-tag's
 * target, the newest stable inside the line, or undefined for a pin.
 * Pure display — the DECISION went through {@link resolveTarget}.
 * @param {{ kind: string; tag?: string; range?: string }} track - the tracking rule.
 * @param {{ distTags: Record<string, string>; versions: string[] }} published - registry facts.
 * @returns {string | undefined} the human-facing "what am I following" version.
 */
export function resolveTrackedVersion(track, published) {
  if (track.kind === 'pin') return undefined
  if (track.kind === 'tag') return published.distTags[track.tag ?? '']
  let best
  for (const version of published.versions) {
    if (!matchesLine(version, /** @type {string} */ (track.range))) continue
    if (best === undefined || compareVersions(version, best) > 0) best = version
  }
  return best
}

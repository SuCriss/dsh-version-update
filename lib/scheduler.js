/**
 * The automation loop behind the four new capabilities: one owner for WHEN to
 * check, WHAT counts as newer, and WHETHER to install without asking.
 *
 * The loop is deliberately boring — two independent timers over one pure
 * decision. A daily timer fires the configured `checkAt` moment (the planned
 * check); a second timer wakes only when an auto install is WAITING for its
 * execution window to open — or retries shortly when there is no window to
 * wait for. Every decision itself happens in {@link resolveTarget} and
 * {@link inWindow}, both pure and exhaustively tested; this module only wires
 * them to wall-clock time.
 *
 * A parked finding is re-validated, never replayed: before it installs, the
 * policy in force at THAT moment must still say `auto`, and its tracking rule
 * must still resolve to the same version. Turning automation off therefore
 * cancels a waiting install instead of letting an older decision execute later.
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
 * How long a parked install waits before retrying when there is nothing to
 * wait FOR — no execution window is configured, or the window is already open
 * but the single install slot was busy. Arming the next window opening in
 * those cases would push a refused attempt a whole day out (or park it
 * forever), even though it could legitimately run as soon as the slot frees.
 */
export const AUTO_RETRY_MS = 60 * 1000

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
 * @param {{ policy: () => import('./protocol.js').Policy; installed: () => string | undefined; check: () => Promise<{ distTags: Record<string, string>; versions: string[] }>; updater: { start: (version: string, trigger?: 'manual' | 'auto' | 'scheduled') => unknown }; now?: () => Date; retryMs?: number }} deps - the live policy, the installed facts, the registry read, the runner, and the retry delay used when a parked install has no window to wait for.
 * @returns {{ start: () => void; dispose: () => void; policyChanged: () => void; manualCheck: () => Promise<{ distTags: Record<string, string>; versions: string[] }>; runCycle: () => Promise<void>; view: () => { lastCheck: CheckView; nextCheckAt?: number; pendingAuto?: { target: string; since: number } } }} the scheduler.
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
  /**
   * The auto install that was found but not started, and the registry facts it
   * was resolved from. Keeping the facts lets a later wake-up re-run the SAME
   * decision against the policy in force THEN, instead of blindly installing a
   * target an older policy chose.
   * @type {{ target: string; since: number; published: { distTags: Record<string, string>; versions: string[] } } | undefined}
   */
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
   * Whether the parked finding still describes what the CURRENT policy wants:
   * automation must still be on, and the tracking rule must still resolve to
   * the very version that was parked. A finding belongs to the policy that
   * produced it — a user who turns automation off, pins the version, or
   * narrows the tracked line must not have it installed behind their back.
   * @param {{ target: string; published: { distTags: Record<string, string>; versions: string[] } }} parked - the parked finding.
   * @returns {boolean} true when it may still be installed.
   */
  const stillWanted = (parked) => {
    const policy = deps.policy()
    if (policy.mode !== 'auto') return false
    const verdict = resolveTarget(policy.track, deps.installed(), parked.published)
    return verdict.target === parked.target
  }

  /**
   * Arm (or disarm) the wake-up for a waiting auto install.
   *
   * Two kinds of wake exist, and picking the wrong one is a real defect:
   * - when the policy HAS a window this moment is outside of, arm the next
   *   opening ({@link nextOccurrence});
   * - when there is nothing to wait for — no window configured, or the window
   *   is open right now and only the install slot was busy — retry after
   *   {@link AUTO_RETRY_MS}. Arming the next opening there would defer a
   *   perfectly legal install by up to a day, and with no window at all the
   *   finding used to be parked with no timer whatsoever, i.e. never retried.
   */
  const armWindowWake = () => {
    if (windowTimer !== undefined) {
      clearTimeout(windowTimer)
      windowTimer = undefined
    }
    if (pendingAuto === undefined) return
    const window = deps.policy().window
    const minutes = now().getHours() * 60 + now().getMinutes()
    if (window === null || window === undefined || inWindow(minutes, window)) {
      windowTimer = setTimeout(() => { void attemptPendingInstall() }, deps.retryMs ?? AUTO_RETRY_MS)
      windowTimer.unref?.()
      return
    }
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

  /** The wake-up callback: the window opened again, or a retry came due. */
  const attemptPendingInstall = () => {
    windowTimer = undefined
    if (pendingAuto === undefined || stopped) return
    // Re-validate before installing: the policy may have changed while this
    // finding waited, and a target nobody tracks any more must be dropped
    // rather than installed.
    if (!stillWanted(pendingAuto)) {
      pendingAuto = undefined
      return
    }
    const window = deps.policy().window
    const minutes = now().getHours() * 60 + now().getMinutes()
    // The wake may have fired for a window opening that has since been moved:
    // wait for the new one instead of installing outside it.
    if (window !== null && window !== undefined && !inWindow(minutes, window)) {
      armWindowWake()
      return
    }
    if (!beginAutoInstall(pendingAuto.target)) armWindowWake()
  }

  /**
   * Run one full decide-and-maybe-install cycle. Exposed so tests (and the
   * host's first mount) can drive a cycle without waiting for the clock.
   * @param {'scheduled' | 'manual'} [trigger] - why this cycle runs.
   */
  const runCycle = async (trigger = 'scheduled') => {
    // Every timestamp this cycle records comes from the injected clock, never
    // from Date.now: the scheduler is tested under a fake clock, and a mixed
    // clock would put the panel's "last check" minutes away from the decision
    // that produced it.
    const at = now().getTime()
    let published
    try {
      published = await deps.check()
    } catch (error) {
      lastCheck = { at, error: error instanceof Error ? error.message : String(error) }
      if (trigger === 'manual') throw error
      return
    }
    const installed = deps.installed()
    const policy = deps.policy()
    const verdict = resolveTarget(policy.track, installed, published)
    lastCheck = {
      at,
      updateAvailable: verdict.target !== undefined,
      ...(verdict.target !== undefined ? { target: verdict.target } : {}),
      ...(installed !== undefined ? { latest: resolveTrackedVersion(policy.track, published) } : {}),
    }
    // Manual checks record a verdict only: never install or create a parked job.
    if (trigger === 'manual') return published
    if (stopped) return
    if (verdict.target === undefined) return
    if (policy.mode !== 'auto') {
      // Automation is off (or only notifying): a finding parked by an earlier
      // policy must not outlive it and install later behind the user's back.
      pendingAuto = undefined
      armWindowWake()
      return
    }
    const minutes = now().getHours() * 60 + now().getMinutes()
    if (policy.window !== null && !inWindow(minutes, policy.window)) {
      // Park the finding and wait for the window; overwrite any older parked
      // target — only the newest discovery matters. The registry facts come
      // along so a later wake-up can re-resolve it against the policy in force.
      pendingAuto = { target: verdict.target, since: at, published }
      armWindowWake()
      return
    }
    if (!beginAutoInstall(verdict.target)) {
      pendingAuto = { target: verdict.target, since: at, published }
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

    runCycle: async () => { await runCycle() },
    manualCheck: async () => {
      const published = await runCycle('manual')
      if (published === undefined) throw new Error('manual check returned no registry facts')
      return published
    },
    view() {
      return {
        lastCheck: { ...lastCheck },
        ...(dailyTimer !== undefined && deps.policy().checkAt !== null
          ? { nextCheckAt: nextOccurrence(/** @type {string} */ (deps.policy().checkAt), now())?.getTime() }
          : {}),
        // Projected, not spread: the registry facts a parked finding carries
        // are internal state, and the panel only needs the target and its age.
        ...(pendingAuto !== undefined
          ? { pendingAuto: { target: pendingAuto.target, since: pendingAuto.since } }
          : {}),
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

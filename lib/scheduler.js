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

/** Re-arm jitter for the daily check: a hair early beats a hair late. */
const EARLY_MS = 50

/**
 * The window wake-up fires a hair AFTER the opening, not before it. The callback
 * re-tests the window against the wall clock before installing, and a wake that
 * lands 50 ms early still reads the PREVIOUS minute — so it declines a window
 * that has just opened.
 */
const WINDOW_LATE_MS = 250

/**
 * How long a refused auto install waits before trying again while its execution
 * window is open (or with no window configured at all). A refusal means the slot
 * is busy with something a human asked for; checking again in a minute is what
 * "silent" should mean, and the window test bounds how long it can retry.
 */
const BUSY_RETRY_MS = 60_000

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
 * @returns {{ start: () => void; dispose: () => void; policyChanged: () => void; runCycle: () => Promise<void>; consider: (published: { distTags: Record<string, string>; versions: string[] }) => Promise<void>; view: () => { lastCheck: CheckView; nextCheckAt?: number; pendingAuto?: { target: string; since: number } } }} the scheduler.
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
   *
   * The timer is ONE occurrence, and it re-arms itself after every fire:
   * without the re-arm a configured checkAt would check exactly once per
   * host lifetime and then fall silent, which is precisely the bug where
   * silent auto-update "stops working" after a day.
   */
  const armDaily = () => {
    if (dailyTimer !== undefined) {
      clearTimeout(dailyTimer)
      dailyTimer = undefined
    }
    const due = nextOccurrence(/** @type {string | null} */ (deps.policy().checkAt) ?? '', now())
    if (due === undefined) return
    const delay = Math.max(0, due.getTime() - now().getTime() - EARLY_MS)
    dailyTimer = setTimeout(() => {
      // Drop the fired handle first so the panel never reads a nextCheckAt
      // that has already passed, then re-arm for tomorrow's occurrence once
      // this cycle settles.
      dailyTimer = undefined
      void runCycle('scheduled').catch(() => {}).finally(armDaily)
    }, delay)
    dailyTimer.unref?.()
  }

  /**
   * Arm (or disarm) the window wake-up for a waiting auto install.
   * When no window is configured there is no opening to wait for, so nothing is
   * armed — the parked finding then relies on {@link armBusyRetry} instead.
   *
   * INVARIANT while `pendingAuto` is set, a wake is armed. Every path out of
   * {@link attemptPendingInstall} re-arms for that reason: a parked target with
   * no timer is not "waiting", it is lost until some later check happens to
   * re-decide, and with no `checkAt` configured that can be never.
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
    const delay = Math.max(0, due.getTime() - now().getTime() + WINDOW_LATE_MS)
    windowTimer = setTimeout(() => { void attemptPendingInstall() }, delay)
    windowTimer.unref?.()
  }

  /**
   * Wake for a parked install the slot refused, a minute from now.
   */
  const armBusyRetry = () => {
    if (windowTimer !== undefined) {
      clearTimeout(windowTimer)
      windowTimer = undefined
    }
    if (pendingAuto === undefined || stopped) return
    windowTimer = setTimeout(() => { void attemptPendingInstall() }, BUSY_RETRY_MS)
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
      // The slot is busy — a manual install here, or another host holding the
      // machine-wide lock. The caller keeps the finding parked and re-arms;
      // nothing is lost by refusing, but everything is lost by not retrying.
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
    if (window !== null && window !== undefined && !inWindow(minutes, window)) {
      // Not open (a moved or removed window, a clock jump): sleep to the next
      // opening rather than drop the finding. With no window configured this
      // path cannot be reached, so the retry below would otherwise disarm.
      armWindowWake()
      if (windowTimer === undefined) armBusyRetry()
      return
    }
    if (!beginAutoInstall(pendingAuto.target)) {
      // The slot is busy with something else — a manual install, another host.
      // Try again shortly while the window still allows it.
      armBusyRetry()
    }
  }

  /**
   * Park a finding and arm the wake that fits WHY it is parked: a finding
   * waiting for an opening sleeps until that opening; one refused by a busy slot
   * comes back shortly, while whoever else is installing may still be finished.
   * @param {string} target - the version to install once the wait is over.
   * @param {'window' | 'busy'} reason - what the finding is waiting for.
   * @returns {void}
   */
  const parkFinding = (target, reason) => {
    pendingAuto = { target, since: Date.now() }
    if (reason === 'busy') {
      armBusyRetry()
      return
    }
    armWindowWake()
    // An unparsable window string arms nothing; keep the finding on the retry
    // timer rather than losing it silently.
    if (windowTimer === undefined) armBusyRetry()
  }

  /**
   * Decide — and maybe silently install — from ALREADY-FETCHED registry facts.
   *
   * This is the whole policy decision, separated from the daily timer so any
   * check can feed it: the scheduled one, and the one the panel's page-load
   * or button click just performed. Without this seam a check that bypasses
   * the scheduler (every panel check) could never trigger an auto install,
   * which made `mode: 'auto'` with no `checkAt` unreachable — the scheduler
   * simply never ran.
   * @param {{ distTags: Record<string, string>; versions: string[] }} published - registry facts.
   */
  const consider = async (published) => {
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
      // Overwrite any older parked target — only the newest discovery matters.
      parkFinding(verdict.target, 'window')
      return
    }
    if (!beginAutoInstall(verdict.target)) parkFinding(verdict.target, 'busy')
  }

  /**
   * Run one full decide-and-maybe-install cycle: fetch the registry, then
   * decide. Exposed so tests (and the host's first mount) can drive a cycle
   * without waiting for the clock.
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
    await consider(published)
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

    /** The same decision, fed registry facts an external check already read. */
    consider,

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

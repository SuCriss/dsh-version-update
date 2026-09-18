/**
 * The automation loop behind the four new capabilities: one owner for WHEN to
 * check, WHAT counts as newer, and WHETHER to install without asking.
 *
 * The loop is deliberately boring — three independent timers over one pure
 * decision. A startup timer fires once shortly after boot; a daily timer fires
 * the configured `checkAt` moment (the planned check); a third timer wakes only
 * when an auto install is WAITING for its execution window to open. Every
 * decision itself happens in {@link resolveTarget} and {@link inWindow}, both
 * pure and exhaustively tested; this module only wires them to wall-clock time.
 *
 * The scheduler never reads the policy file itself: the host owns the live
 * policy object (routes mutate it), and pushes it in through `deps.policy`.
 * When the policy changes mid-flight, `policyChanged` discards old decisions
 * and re-arms the daily check without a host restart.
 *
 * Restarting after a silent install is NOT this module's job: settlement is
 * observed once, in the host composition, where the same hook records history
 * regardless of who asked for the install.
 * @module dsh-version-update/scheduler
 */

import { inWindow, nextOccurrence } from './protocol.js'
import { compareVersions, matchesLine, resolveTarget } from './core.js'

/** Re-arm jitter; each nominal occurrence is consumed even if it fires early. */
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
 * How long after the host boots its one guaranteed automatic check runs.
 *
 * The daily timer alone cannot make a silent policy reliable: `checkAt` names a
 * single wall-clock moment, so a host that was off at that moment loses the
 * whole day, and a host whose lifetime never contains that moment — a short
 * session, a laptop that sleeps through it — loses every day. A check shortly
 * after boot is the one moment a silent policy is guaranteed to get, and it is
 * also the moment the user expects it: they just started the thing they asked
 * to keep current.
 *
 * Delayed rather than immediate on purpose. At mount the host is still loading
 * plugins and inspecting the very tree an install would replace, and a registry
 * read that can end in a silent install must not compete with startup.
 */
export const STARTUP_CHECK_MS = 60_000

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
 * @returns {{ start: () => void; dispose: () => void; cancelPending: () => void; policyChanged: () => void; runCycle: () => Promise<void>; consider: (published: { distTags: Record<string, string>; versions: string[] }, options?: { manual?: boolean }) => Promise<void>; view: () => { lastCheck: CheckView; nextCheckAt?: number; pendingAuto?: { target: string; since: number } } }} the scheduler.
 */
export function createScheduler(deps) {
  const now = deps.now ?? (() => new Date())
  /** @type {NodeJS.Timeout | undefined} */
  let dailyTimer
  /** @type {NodeJS.Timeout | undefined} */
  let windowTimer
  /** @type {NodeJS.Timeout | undefined} */
  let startupTimer
  let stopped = false
  // Policy changes and disposal invalidate work already waiting on the registry.
  let generation = 0
  /** @type {number | undefined} */
  let nextCheckAt
  /** @type {{ checkAt: string; at: number } | undefined} */
  let consumedDaily
  /** @type {CheckView} */
  let lastCheck = {}
  /** @type {{ target: string; since: number; track: string; published: { distTags: Record<string, string>; versions: string[] } } | undefined} */
  let pendingAuto

  const clearPending = () => {
    pendingAuto = undefined
    if (windowTimer !== undefined) clearTimeout(windowTimer)
    windowTimer = undefined
  }

  /**
   * Arm the daily planned check for the current policy's `checkAt`.
   * A missing or null checkAt simply leaves nothing armed — external checks
   * can still feed their already-fetched facts through consider.
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
    nextCheckAt = undefined
    if (stopped) return
    const checkAt = deps.policy().checkAt ?? ''
    const current = now().getTime()
    // Advancing from the consumed nominal occurrence avoids a zero-delay loop
    // when the early timer's registry request settles before checkAt itself.
    const reference = consumedDaily?.checkAt === checkAt
      ? Math.max(current, consumedDaily.at)
      : current
    const due = nextOccurrence(checkAt, new Date(reference))
    if (due === undefined) return
    nextCheckAt = due.getTime()
    const epoch = generation
    const delay = Math.max(0, due.getTime() - current - EARLY_MS)
    const timer = setTimeout(() => {
      if (stopped || epoch !== generation || dailyTimer !== timer) return
      dailyTimer = undefined
      nextCheckAt = undefined
      consumedDaily = { checkAt, at: due.getTime() }
      void runCycle().catch(() => {}).finally(() => {
        if (!stopped && epoch === generation && dailyTimer === undefined) armDaily()
      })
    }, delay)
    dailyTimer = timer
    dailyTimer.unref?.()
  }

  /**
   * Arm the one guaranteed check per host lifetime: shortly after boot.
   *
   * Armed only for `mode: 'auto'`. `off` and `notify` are the user saying
   * "tell me, do not act", and neither needs a background registry read to keep
   * saying it — the panel's own read already covers them, and a silent install
   * is the one outcome they asked not to happen unattended.
   *
   * The mode is re-read when the timer fires rather than trusted from arming
   * time: a policy edited during the delay must be honoured, and switching away
   * from `auto` inside that window is precisely the user saying "stop".
   */
  const armStartupCheck = () => {
    if (startupTimer !== undefined) {
      clearTimeout(startupTimer)
      startupTimer = undefined
    }
    if (stopped || deps.policy().mode !== 'auto') return
    const timer = setTimeout(() => {
      // The same staleness contract the other timers keep: a wake that was
      // cleared, replaced by a re-arm, or invalidated by disposal is inert.
      if (stopped || startupTimer !== timer) return
      startupTimer = undefined
      if (deps.policy().mode !== 'auto') return
      void runCycle().catch(() => {})
    }, STARTUP_CHECK_MS)
    startupTimer = timer
    startupTimer.unref?.()
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
    if (stopped || pendingAuto === undefined) return
    const window = deps.policy().window
    if (window === null || window === undefined) return
    const due = nextOccurrence(window.start, now())
    if (due === undefined) return
    const epoch = generation
    const delay = Math.max(0, due.getTime() - now().getTime() + WINDOW_LATE_MS)
    const timer = setTimeout(() => {
      if (stopped || epoch !== generation || windowTimer !== timer) return
      attemptPendingInstall()
    }, delay)
    windowTimer = timer
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
    if (stopped || pendingAuto === undefined) return
    const epoch = generation
    const timer = setTimeout(() => {
      if (stopped || epoch !== generation || windowTimer !== timer) return
      attemptPendingInstall()
    }, BUSY_RETRY_MS)
    windowTimer = timer
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
    if (stopped) return false
    try {
      deps.updater.start(target, 'auto')
      clearPending()
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
    const policy = deps.policy()
    // A parked version is not permission to install forever. Re-evaluate the
    // saved facts against the current tree, and reject unannounced track edits.
    const verdict = resolveTarget(policy.track, deps.installed(), pendingAuto.published)
    if (policy.mode !== 'auto' || JSON.stringify(policy.track) !== pendingAuto.track || verdict.target !== pendingAuto.target) {
      clearPending()
      return
    }
    const window = policy.window
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
   * @param {{ distTags: Record<string, string>; versions: string[] }} published - the facts behind the target.
   * @returns {void}
   */
  const parkFinding = (target, reason, published) => {
    if (stopped) return
    clearPending()
    pendingAuto = {
      target,
      since: now().getTime(),
      track: JSON.stringify(deps.policy().track),
      published: { distTags: { ...published.distTags }, versions: [...published.versions] },
    }
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
   * This is the whole policy decision, separated from the daily timer so a read
   * that bypasses the scheduler can feed it. Exactly two things do: the daily
   * timer's own cycle, and `POST /check/auto` — the panel's deliberate "I just
   * opened, evaluate the policy" call. Without this seam a check that bypasses
   * the scheduler could never trigger an auto install, which made
   * `mode: 'auto'` with no `checkAt` unreachable — the scheduler simply never
   * ran. The panel's plain reads and its check button deliberately do NOT feed
   * it: those observe, and a GET in particular must never be able to install.
   * A manual check is observation only: refresh the view without starting or
   * adding/replacing pending automatic work.
   * @param {{ distTags: Record<string, string>; versions: string[] }} published - registry facts.
   * @param {{ manual?: boolean }} [options] - whether this is an explicit manual check.
   */
  const consider = async (published, options = {}) => {
    if (stopped) return
    const installed = deps.installed()
    const policy = deps.policy()
    const verdict = resolveTarget(policy.track, installed, published)
    lastCheck = {
      at: now().getTime(),
      updateAvailable: verdict.target !== undefined,
      ...(verdict.target !== undefined ? { target: verdict.target } : {}),
      ...(installed !== undefined ? { latest: resolveTrackedVersion(policy.track, published) } : {}),
    }
    if (options.manual === true) return
    // Any automatic decision supersedes its predecessor, including a finding
    // that is now current, pinned, or no longer allowed by the mode.
    clearPending()
    if (verdict.target === undefined || policy.mode !== 'auto') return
    const minutes = now().getHours() * 60 + now().getMinutes()
    if (policy.window !== null && policy.window !== undefined && !inWindow(minutes, policy.window)) {
      parkFinding(verdict.target, 'window', published)
      return
    }
    if (!beginAutoInstall(verdict.target)) parkFinding(verdict.target, 'busy', published)
  }

  /**
   * Run one full decide-and-maybe-install cycle: fetch the registry, then
   * decide. Exposed so tests (and the host's first mount) can drive a cycle
   * without waiting for the clock.
   */
  const runCycle = async () => {
    if (stopped) return
    const epoch = generation
    let published
    try {
      published = await deps.check()
    } catch (error) {
      if (stopped || epoch !== generation) return
      lastCheck = { at: now().getTime(), error: error instanceof Error ? error.message : String(error) }
      return
    }
    if (stopped || epoch !== generation) return
    await consider(published)
  }

  return {
    start() {
      stopped = false
      armDaily()
      armStartupCheck()
      if (pendingAuto !== undefined && windowTimer === undefined) {
        armWindowWake()
        if (windowTimer === undefined) armBusyRetry()
      }
    },

    dispose() {
      stopped = true
      generation += 1
      if (dailyTimer !== undefined) clearTimeout(dailyTimer)
      dailyTimer = undefined
      if (startupTimer !== undefined) clearTimeout(startupTimer)
      startupTimer = undefined
      nextCheckAt = undefined
      clearPending()
    },

    /** Cancel only the waiting install; future automatic checks remain enabled. */
    cancelPending() {
      clearPending()
    },

    /**
     * Old policy decisions cannot authorize work under a replacement policy.
     * The startup check is re-armed for the same reason it exists: turning
     * `auto` ON is the user asking for unattended installs, and the panel's
     * own acting read happened while the OLD mode was still in force — so
     * without this a host booted under `off` and switched to `auto` would not
     * check until the next `checkAt`, or never with none configured.
     */
    policyChanged() {
      generation += 1
      clearPending()
      if (stopped) return
      armDaily()
      armStartupCheck()
    },

    runCycle,

    /** The same decision, fed registry facts an external check already read. */
    consider,

    view() {
      return {
        lastCheck: { ...lastCheck },
        ...(nextCheckAt !== undefined ? { nextCheckAt } : {}),
        ...(pendingAuto !== undefined ? { pendingAuto: { target: pendingAuto.target, since: pendingAuto.since } } : {}),
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

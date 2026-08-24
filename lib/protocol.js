/**
 * Wire and policy contract shared by every half of the rewritten plugin:
 * the route family, the npm package under management, and — new in this
 * rewrite — the update POLICY domain that turns "check for updates" into a
 * small decision engine.
 *
 * Everything here is pure: no fs, no network, no timers. The host validates
 * and persists policies with it, the scheduler decides with it, and the
 * browser panel renders and edits with a mirrored subset (the client ships as
 * a no-build bundle, so agreement is enforced by test, not by import).
 * @module dsh-version-update/protocol
 */

/** The npm package whose installed version this plugin reports and updates. */
export const DSH_PACKAGE = '@deepseek-ai/dsh'

/** Route family of the version-update host API. All loopback-only. */
export const VERSION_API = {
  /** Installed facts + registry channels/versions + task view + ambient state. */
  check: '/api/dsh-version-update/check',
  /** Start one install of an exact version. Body `{ version, trigger? }`. */
  update: '/api/dsh-version-update/update',
  /** Current (or last) task state, its log, staleness, and ambient state. */
  status: '/api/dsh-version-update/status',
  /** Relaunch the running host with the same command line and exit this one. */
  restart: '/api/dsh-version-update/restart',
  /** GitHub release notes of one exact version (when `releaseNotes` is on). */
  notes: '/api/dsh-version-update/notes',
  /**
   * The effective update policy: `GET` reads it, `POST` replaces parts of it
   * with a partial policy object. One path serving both methods, because the
   * web server keys routes by (kind, path) alone — a read/write pair mounted
   * as two routes is a duplicate registration.
   */
  policy: '/api/dsh-version-update/policy',
  /** List local version snapshots available for instant rollback. */
  snapshots: '/api/dsh-version-update/snapshots',
  /** Restore a snapshot over the live installation. Body `{ version }`. */
  restore: '/api/dsh-version-update/restore',
}

/**
 * The GitHub release tags tried, in order, for one dsh version.
 * @param {string} version - the exact published version.
 * @returns {string[]} tag candidates, most specific first.
 */
export function releaseTagCandidates(version) {
  return [`dsh-v${version}`, `v${version}`]
}

/** dist-tags the panel offers as first-class tracking choices. */
export const CHANNELS = ['latest', 'next']

// ---------------------------------------------------------------------------
// Policy domain
// ---------------------------------------------------------------------------

/**
 * What happens when the scheduler discovers a newer version:
 * - `off`    — report it in the panel only; nothing runs on its own.
 * - `notify` — like off, plus the panel badge stays loud until caught up.
 * - `auto`   — install silently inside the configured time window.
 */
export const POLICY_MODES = ['off', 'notify', 'auto']

/** How an install settles the running host afterwards. */
export const POLICY_RESTART_MODES = ['ask', 'auto']

/** Kinds of update tracking. */
export const TRACK_KINDS = ['tag', 'line', 'pin']

/** Grammar of a time-of-day value: zero-padded 24-hour `HH:MM`. */
export const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Grammar of a tracking line: a caret or tilde range anchored at one full
 * version. Deliberately NOT general semver — two operators whose meaning fits
 * in a sentence cover "follow this minor line" and "follow this major line",
 * and every extra operator would be another surface to test on both ends.
 */
export const LINE_PATTERN = /^(\^|~)(\d+)\.(\d+)\.(\d+)$/

/**
 * Parse a `HH:MM` value into minutes since midnight.
 * @param {unknown} value - candidate text.
 * @returns {number | undefined} minutes since midnight, or undefined when invalid.
 */
export function parseTimeOfDay(value) {
  if (typeof value !== 'string') return undefined
  if (!TIME_PATTERN.test(value)) return undefined
  const [hours, minutes] = value.split(':').map(part => Number(part))
  return hours * 60 + minutes
}

/**
 * Whether `minutes` falls inside a policy window. Windows are half-open
 * `[start, end)` in local time; `start === end` means the whole day; a start
 * after the end wraps past midnight (e.g. 22:00–06:00).
 * @param {number} minutes - minutes since local midnight.
 * @param {{ start: string; end: string }} window - the policy window.
 * @returns {boolean} true when the moment may execute an auto install.
 */
export function inWindow(minutes, window) {
  const start = parseTimeOfDay(window.start)
  const end = parseTimeOfDay(window.end)
  if (start === undefined || end === undefined) return false
  if (start === end) return true
  if (start < end) return minutes >= start && minutes < end
  return minutes >= start || minutes < end
}

/**
 * The next wall-clock occurrence of a `HH:MM` time, local time.
 * @param {string} time - the time of day.
 * @param {Date} [now] - the reference moment; defaults to now.
 * @returns {Date | undefined} the next occurrence, or undefined when unparsable.
 */
export function nextOccurrence(time, now = new Date()) {
  const minutes = parseTimeOfDay(time)
  if (minutes === undefined) return undefined
  const due = new Date(now)
  due.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1)
  return due
}

/** The policy every installation starts from: fully manual, follow latest. */
export const DEFAULT_POLICY = Object.freeze({
  mode: 'off',
  track: Object.freeze({ kind: 'tag', tag: 'latest' }),
  window: null,
  restart: 'ask',
  checkAt: null,
})

/**
 * The effective policy shape, widened over the frozen default so runtime
 * mutations (mode 'auto', restart 'auto', real windows) stay assignable.
 * @typedef {object} Policy
 * @property {'off' | 'notify' | 'auto'} mode - discovery behavior.
 * @property {{ kind: 'tag'; tag: string } | { kind: 'line'; range: string } | { kind: 'pin' }} track - what counts as newer.
 * @property {null | { start: string; end: string }} window - auto-install execution window (local time).
 * @property {'ask' | 'auto'} restart - post-install restart behavior.
 * @property {string | null} checkAt - daily planned check time, or null.
 */

/**
 * Validate one policy field group and append any problem to `issues`.
 * A missing field inherits `base`; an invalid field also falls back to the
 * base value so ONE bad key cannot blank out the rest of a submission — but
 * it IS reported, because silently keeping a broken value would be worse.
 * @param {Record<string, unknown>} source - the submitted partial policy.
 * @param {Record<string, unknown>} base - the policy the submission updates.
 * @param {Record<string, unknown>} out - the normalized output being built.
 * @param {string[]} issues - collector for human-readable problems.
 */
function normalizeMode(source, base, out, issues) {
  const mode = source.mode ?? base.mode
  if (typeof mode === 'string' && POLICY_MODES.includes(mode)) out.mode = mode
  else issues.push(`mode must be one of ${POLICY_MODES.join(', ')}`)
}

/**
 * Validate the `track` group: a dist-tag name, a caret/tilde line, or a pin.
 * @param {Record<string, unknown>} source - the submitted partial policy.
 * @param {Record<string, unknown>} base - the policy the submission updates.
 * @param {Record<string, unknown>} out - the normalized output being built.
 * @param {string[]} issues - collector for human-readable problems.
 */
function normalizeTrack(source, base, out, issues) {
  /** @type {unknown} */
  const raw = source.track !== undefined ? source.track : base.track
  if (typeof raw !== 'object' || raw === null) {
    issues.push('track must be an object with kind tag | line | pin')
    out.track = base.track
    return
  }
  const track = /** @type {Record<string, unknown>} */ (raw)
  const kind = typeof track.kind === 'string' ? track.kind : undefined
  if (kind === undefined || !TRACK_KINDS.includes(kind)) {
    issues.push(`track.kind must be one of ${TRACK_KINDS.join(', ')}`)
    out.track = base.track
    return
  }
  if (kind === 'pin') {
    out.track = { kind }
    return
  }
  const value = track.tag ?? track.range
  if (kind === 'tag') {
    if (typeof value !== 'string' || value === '' || value.length > 64 || /\s/.test(value)) {
      issues.push('track.tag must be a short dist-tag name without whitespace')
      out.track = base.track
      return
    }
    out.track = { kind, tag: value }
    return
  }
  if (typeof value !== 'string' || !LINE_PATTERN.test(value)) {
    issues.push('track.range must look like ^1.2.3 or ~1.2.3')
    out.track = base.track
    return
  }
  out.track = { kind, range: value }
}

/**
 * Validate the execution window. `null` means "any time"; otherwise both ends
 * must parse as HH:MM.
 * @param {Record<string, unknown>} source - the submitted partial policy.
 * @param {Record<string, unknown>} base - the policy the submission updates.
 * @param {Record<string, unknown>} out - the normalized output being built.
 * @param {string[]} issues - collector for human-readable problems.
 */
function normalizeWindow(source, base, out, issues) {
  /** @type {unknown} */
  const raw = source.window !== undefined ? source.window : base.window
  if (raw === null || raw === undefined) {
    out.window = null
    return
  }
  if (typeof raw !== 'object') {
    issues.push('window must be null or { start, end } in HH:MM')
    out.window = base.window
    return
  }
  const window = /** @type {Record<string, unknown>} */ (raw)
  const start = parseTimeOfDay(window.start)
  const end = parseTimeOfDay(window.end)
  if (start === undefined || end === undefined) {
    issues.push('window.start and window.end must both be HH:MM values')
    out.window = base.window
    return
  }
  out.window = { start: window.start, end: window.end }
}

/**
 * Validate one enum-or-null field (`restart`, `checkAt`) against its grammar.
 * @param {Record<string, unknown>} source - the submitted partial policy.
 * @param {Record<string, unknown>} base - the policy the submission updates.
 * @param {Record<string, unknown>} out - the normalized output being built.
 * @param {string[]} issues - collector for human-readable problems.
 * @param {string} field - the field name being normalized.
 * @param {(value: unknown) => boolean} accepts - the field's grammar.
 * @param {string} expectation - the human-readable rule for error text.
 */
function normalizeField(source, base, out, issues, field, accepts, expectation) {
  const value = source[field] !== undefined ? source[field] : base[field]
  if (accepts(value)) out[field] = value
  else {
    // Same contract as the other field groups: the base value survives a
    // rejected submission, and the rejection names itself.
    out[field] = base[field]
    issues.push(`${field} ${expectation}`)
  }
}

/**
 * Normalize a partial policy submission against a base policy.
 *
 * The merge semantics are "patch": absent fields keep their base value, so
 * the panel can toggle one switch without re-sending the whole form. Unknown
 * keys are ignored — forward compatibility beats strictness for a file the
 * user can also edit by hand. Every rejected field degrades to its base value
 * AND names itself in `issues`, so a caller can answer 400 with specifics.
 * @param {unknown} input - the submitted value (usually a request body).
 * @param {Policy} [base] - the policy being updated.
 * @returns {{ ok: boolean; value: Policy; issues: string[] }} the outcome.
 */
export function normalizePolicy(input, base = DEFAULT_POLICY) {
  const source = typeof input === 'object' && input !== null ? /** @type {Record<string, unknown>} */ (input) : {}
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {string[]} */
  const issues = []
  normalizeMode(source, base, out, issues)
  normalizeTrack(source, base, out, issues)
  normalizeWindow(source, base, out, issues)
  normalizeField(source, base, out, issues, 'restart', value => POLICY_RESTART_MODES.includes(/** @type {string} */ (value)), `must be one of ${POLICY_RESTART_MODES.join(', ')}`)
  normalizeField(source, base, out, issues, 'checkAt', value => value === null || parseTimeOfDay(value) !== undefined, 'must be null or an HH:MM time')
  return { ok: issues.length === 0, value: /** @type {Policy} */ (out), issues }
}

/**
 * Repair whatever a hand-edited or outdated policy file contains. Unlike
 * {@link normalizePolicy} this never fails and never reports: each invalid
 * field simply falls back to its default, because a startup path must always
 * produce a usable policy.
 * @param {unknown} input - the stored value.
 * @returns {Policy} a valid policy.
 */
export function repairPolicy(input) {
  return normalizePolicy(input, DEFAULT_POLICY).value
}

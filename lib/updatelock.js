/**
 * A cross-process update lock, guarding the global npm tree against two hosts
 * installing at once.
 *
 * The updater's single slot is PROCESS-WIDE but not machine-wide: a desktop
 * shell's host and a terminal `dsh web` can run side by side, and both would
 * happily run `npm install -g @deepseek-ai/dsh@…` into the same directory —
 * the one outcome this plugin exists to prevent. This file lock closes that
 * gap: `start()` acquires it before spawning npm and `settle()` releases it.
 *
 * Staleness rules — a lock is stolen when:
 *  - the holding pid no longer exists (a crashed host leaked it), or
 *  - the holder is older than the install hard-timeout ceiling (a wedged
 *    holder cannot outlive the ceiling its own updater would kill it at).
 * An unreadable or corrupt lock file is treated as stale as well: a lock
 * nobody can read must never block updates forever.
 *
 * Releasing is ownership-checked: every acquisition writes a unique token, and
 * `release()` removes the file only while that token is still what the file
 * says. A holder whose lock was stolen while it worked must not be able to
 * unlock whoever took it over — that would reopen the exact two-writers race
 * this module closes.
 *
 * Acquiring and STEALING are both identity-safe, because both are two-step
 * operations on a file another process can change underneath them:
 *  - a record is published by writing it to a private temp file and hard-linking
 *    it into place, so the lock path is never observable as an empty file;
 *  - a stale record is removed only after the removal has CLAIMED the file by
 *    renaming it aside and confirmed it took the record it judged stale.
 * See {@link tryCreateLock} and {@link stealLock} for what each one prevents.
 * @module dsh-version-update/updatelock
 */

import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where the lock lives when the host does not name a path. */
export const DEFAULT_LOCK_PATH = join(tmpdir(), 'dsh-version-update.lock')

/**
 * Matches the updater's hard ceiling: a holder older than this is wedged.
 */
export const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000

/** How many steal/retry attempts one acquisition gets. */
const MAX_ATTEMPTS = 5

/**
 * Whether a pid exists (EPERM counts as alive: the pid belongs to another
 * user but is running).
 * @param {number} pid - the pid to probe.
 * @returns {boolean} true while the process exists.
 */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error)?.code === 'EPERM'
  }
}

/**
 * Parse a lock file's contents into its holder, or undefined when unreadable
 * or malformed.
 * @param {string} raw - the file contents.
 * @returns {{ pid: number; at: number } | undefined} the holder.
 */
export function readLockHolder(raw) {
  const parsed = parseLock(raw)
  return parsed === undefined ? undefined : { pid: parsed.pid, at: parsed.at }
}

/**
 * Parse a lock file including its ownership token.
 * @param {string} raw - the file contents.
 * @returns {{ pid: number; at: number; token: string } | undefined} the record.
 */
function parseLock(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (
      typeof parsed?.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 &&
      typeof parsed?.at === 'number' && Number.isFinite(parsed.at)
    ) {
      // `token` is optional on read: a lock written by an older plugin version
      // still names a live holder, which is all the staleness rules need.
      return { pid: parsed.pid, at: parsed.at, token: typeof parsed.token === 'string' ? parsed.token : '' }
    }
  } catch {
    // Fall through: a corrupt lock is treated as stale by the caller.
  }
  return undefined
}

/**
 * Read a lock file, treating any failure as "nothing to read".
 * @param {string} path - the lock or tombstone path.
 * @returns {string} the contents, or '' when unreadable.
 */
function readLockSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Publish a lock record ATOMICALLY, or report that the lock is already held.
 *
 * The record is written to a private temp file and then hard-linked into the
 * lock path: `link` fails with EEXIST when the path is taken, and the file it
 * publishes is complete the instant it becomes visible.
 *
 * Creating the lock with `open(path, 'wx')` and writing the record afterwards —
 * which is what this used to do — left the path occupied by an EMPTY file for
 * the duration of one syscall, and an empty lock file is indistinguishable from
 * a corrupt one, which every reader treats as stale and steals. Two hosts
 * starting an install at the same moment could therefore both come away
 * believing they held the lock, which is exactly the two-writers-on-one-tree
 * outcome this module exists to prevent.
 * @param {string} lockPath - the lock file path.
 * @param {{ pid: number; at: number; token: string }} record - the holder to publish.
 * @returns {boolean} true when this call created the lock; false when it is held.
 */
function tryCreateLock(lockPath, record) {
  const temp = `${lockPath}.${String(record.pid)}-${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(record), 'utf8')
    try {
      linkSync(temp, lockPath)
      return true
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'EEXIST') return false
      // A filesystem without hard links (some network shares, FAT volumes)
      // cannot publish the record atomically. The exclusive create is still
      // correct, but it exposes the empty file for one syscall, so it is the
      // degraded path rather than the rule.
      return createLockExclusively(lockPath, record)
    }
  } finally {
    try { rmSync(temp, { force: true }) } catch { /* the OS temp dir is not this lock's problem */ }
  }
}

/**
 * The non-atomic fallback, used only where hard links are unsupported.
 * @param {string} lockPath - the lock file path.
 * @param {{ pid: number; at: number; token: string }} record - the holder to publish.
 * @returns {boolean} true when this call created the lock; false when it is held.
 */
function createLockExclusively(lockPath, record) {
  /** @type {number | undefined} */
  let fd
  try {
    // 'wx' — exclusive create: the file must not exist for this to succeed.
    fd = openSync(lockPath, 'wx')
    writeSync(fd, JSON.stringify(record), 0, 'utf8')
    return true
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'EEXIST') throw error
    return false
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
  }
}

/**
 * Remove a lock record that was judged stale — and never one that was not.
 *
 * The judgement and the removal are two separate steps, and the file can change
 * between them: two hosts can read the same dead holder, and the first one to
 * act replaces it with its own live record before the second removes anything. A
 * bare `rmSync` then deletes the NEW holder's lock, and both hosts install into
 * the same global tree.
 *
 * So the removal CLAIMS the file by renaming it to a private tombstone — an
 * operation only one process can win — and then checks what it actually took. A
 * record that is still the one judged stale, or still unreadable, is discarded;
 * anything else is put back with a hard link, which cannot clobber a third host
 * that acquired the path in the meantime, and the caller is told who holds it.
 * @param {string} lockPath - the lock file path.
 * @param {{ pid: number; at: number; token: string } | undefined} stale - the record judged stale, or undefined when the file was unreadable.
 * @returns {{ removed: true } | { removed: false; holder: { pid: number; at: number } | undefined }} whether the path is now free, or who holds it instead.
 */
function stealLock(lockPath, stale) {
  const tomb = `${lockPath}.stale-${randomUUID()}`
  try {
    renameSync(lockPath, tomb)
  } catch {
    // Gone already: another waiter claimed it first. The next attempt re-reads.
    return { removed: true }
  }
  const raw = readLockSafe(tomb)
  const record = parseLock(raw)
  // An unreadable record is always discardable — that is this module's contract
  // for a corrupt lock — and so is the exact record that was judged stale.
  const discardable = record === undefined
    || (stale !== undefined && record.pid === stale.pid && record.at === stale.at && record.token === stale.token)
  if (discardable) {
    try { rmSync(tomb, { force: true }) } catch { /* best effort: the path is already free */ }
    return { removed: true }
  }
  try {
    linkSync(tomb, lockPath)
  } catch {
    // Taken again while we held the tombstone: whoever holds it now wins, and the
    // record we displaced is dropped rather than clobbering them.
  }
  try { rmSync(tomb, { force: true }) } catch { /* best effort */ }
  return { removed: false, holder: readLockHolder(raw) }
}

/**
 * Remove the lock file ONLY if it is still the record this process wrote.
 *
 * A lock can be taken away from its holder — the holder's install outlived the
 * staleness ceiling — and an unguarded
 * `rmSync` at that moment would delete the NEW holder's lock, silently opening
 * the door to the one outcome this file exists to prevent: two processes
 * running `npm install -g` against one global tree. Releasing a lock nobody
 * recognizes is therefore a no-op.
 * @param {string} lockPath - the lock file path.
 * @param {string} token - the token written with this acquisition.
 * @returns {void}
 */
function releaseLock(lockPath, token) {
  /** @type {string | undefined} */
  let raw
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch {
    // Already gone (or unreadable): there is nothing left to claim.
    return
  }
  const record = parseLock(raw)
  if (record === undefined || record.token !== token) return
  try {
    rmSync(lockPath, { force: true })
  } catch {
    // raced: the next acquisition judges staleness on whatever is there
  }
}

/**
 * Try to acquire the machine-wide update lock.
 * @param {{ lockPath?: string; pid?: number; now?: () => number; isAlive?: (pid: number) => boolean; maxAgeMs?: number }} [deps] - test seams.
 * @returns {{ ok: true; release: () => void; holder: undefined } | { ok: false; release: () => void; holder?: { pid: number; at: number } | undefined }} the outcome; `release` is always a safe no-op-able callable.
 */
export function acquireUpdateLock(deps = {}) {
  const lockPath = deps.lockPath ?? DEFAULT_LOCK_PATH
  const pid = deps.pid ?? process.pid
  const now = deps.now ?? Date.now
  const isAlive = deps.isAlive ?? defaultIsAlive
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const at = now()
    // Unique per acquisition, so a release can prove the file on disk is still
    // the record THIS call wrote.
    const token = `${pid}-${at}-${randomUUID()}`
    if (tryCreateLock(lockPath, { pid, at, token })) {
      return {
        ok: true,
        holder: undefined,
        release: () => {
          releaseLock(lockPath, token)
        },
      }
    }

    // Held. Judge the record — parsed WITH its token, because that is what lets
    // the removal prove it is discarding the record it judged rather than a
    // newer one. A live same-pid holder may be a restore or an older plugin
    // instance: it is not reentrant.
    const judged = parseLock(readLockSafe(lockPath))
    const stale = judged === undefined
      || !isAlive(judged.pid)
      || now() - judged.at > maxAgeMs
    if (!stale) {
      return {
        ok: false,
        holder: judged === undefined ? undefined : { pid: judged.pid, at: judged.at },
        release: () => {},
      }
    }
    // Unreadable, dead, or wedged: steal and retry. The steal can also find that
    // the file changed under it and hand back the record it restored — that
    // holder, and not a guess, is the answer then.
    const outcome = stealLock(lockPath, judged)
    if (!outcome.removed) {
      return { ok: false, holder: outcome.holder, release: () => {} }
    }
  }
  // Conceded after repeated races: report the last readable holder.
  const last = readLockHolder(readLockSafe(lockPath))
  return { ok: false, holder: last, release: () => {} }
}

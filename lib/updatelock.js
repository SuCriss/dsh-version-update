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
 * @module dsh-version-update/updatelock
 */

import { openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs'
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
  try {
    const parsed = JSON.parse(raw)
    if (
      typeof parsed?.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 &&
      typeof parsed?.at === 'number' && Number.isFinite(parsed.at)
    ) {
      return { pid: parsed.pid, at: parsed.at }
    }
  } catch {
    // Fall through: a corrupt lock is treated as stale by the caller.
  }
  return undefined
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
    let fd
    try {
      // 'wx' — exclusive create: the file must not exist for this to succeed.
      fd = openSync(lockPath, 'wx')
      writeSync(fd, JSON.stringify({ pid, at: now() }), 0, 'utf8')
      return {
        ok: true,
        holder: undefined,
        release: () => {
          try { rmSync(lockPath, { force: true }) } catch { /* raced: ignore */ }
        },
      }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'EEXIST') throw error
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* already closed */ }
      }
    }

    // EEXIST — someone holds it. Read the holder and judge staleness.
    let holder = /** @type {{ pid: number; at: number } | undefined} */
      (readLockHolder((() => { try { return readFileSync(lockPath, 'utf8') } catch { return '' } })()))
    if (holder === undefined || holder.pid === pid || !isAlive(holder.pid) || now() - holder.at > maxAgeMs) {
      // Ours already, unreadable, dead, or wedged: steal and retry.
      try { rmSync(lockPath, { force: true }) } catch { /* raced: retry the open */ }
      continue
    }
    return { ok: false, holder, release: () => {} }
  }
  // Conceded after repeated races: report the last readable holder.
  const last = /** @type {{ pid: number; at: number } | undefined} */
    (readLockHolder((() => { try { return readFileSync(lockPath, 'utf8') } catch { return '' } })()))
  return { ok: false, holder: last, release: () => {} }
}

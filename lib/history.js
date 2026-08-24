/**
 * The install history and the rollback target it derives.
 *
 * Every settled install appends one line: when, from which running version,
 * to which target, with what result. The file lives under the user's home —
 * NOT inside the dsh package directory, which an update replaces — so the
 * history survives the very updates it records.
 *
 * The panel's rollback offer is derived, never stored: the newest successful
 * entry whose `to` still equals the version on disk names the version that
 * was running before it. One newer install (or a manual npm invocation) and
 * the offer silently withdraws rather than pointing somewhere wrong.
 * @module dsh-version-update/history
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** How many entries the file retains. */
export const HISTORY_MAX = 50

/** How many recent entries travel to the panel. */
export const HISTORY_SHOWN = 5

/**
 * The default history file location. A dot-directory under the user profile:
 * no install-scoped path qualifies, because every candidate is wiped by the
 * updates being recorded.
 * @param {{ home?: string }} [deps] - test seam.
 * @returns {string} the history file path.
 */
export function defaultHistoryPath(deps = {}) {
  return join(deps.home ?? homedir(), '.dsh-version-update', 'history.json')
}

/**
 * Read the history file, tolerating every kind of absence or corruption: an
 * unreadable history costs the rollback offer, never the update itself.
 * @param {string} path - the history file path.
 * @returns {{ at: number; from?: string; to: string; result: 'ok' | 'failed' }[]} the entries, oldest first.
 */
export function loadHistory(path) {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(entry =>
      typeof entry === 'object' && entry !== null
      && typeof /** @type {Record<string, unknown>} */ (entry).at === 'number'
      && typeof /** @type {Record<string, unknown>} */ (entry).to === 'string'
      && (/** @type {Record<string, unknown>} */ (entry).result === 'ok' || /** @type {Record<string, unknown>} */ (entry).result === 'failed'))
  } catch {
    return []
  }
}

/**
 * Append one entry and cap the file. Creates the directory on first write.
 * @param {string} path - the history file path.
 * @param {{ at: number; from?: string; to: string; result: 'ok' | 'failed' }} entry - the record.
 */
export function appendHistory(path, entry) {
  const entries = [...loadHistory(path), entry].slice(-HISTORY_MAX)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(entries, null, 1)}\n`, 'utf8')
}

/**
 * Derive the panel's rollback facts from the history.
 *
 * `rollbackTarget` exists only while it can be stated without guessing: the
 * most recent SUCCESSFUL install must be exactly the one that produced the
 * version now on disk, and its `from` must differ from that version. Anything
 * else — failed installs in between, another update since, an unknown current
 * version — and there is no offer, because a stale target would downgrade
 * past the user's actual history.
 * @param {{ at: number; from?: string; to: string; result: 'ok' | 'failed' }[]} entries - the history, oldest first.
 * @param {string | undefined} installed - the version currently on disk.
 * @returns {{ rollbackTarget?: string; recent: { at: number; from?: string; to: string; result: string }[] }} the panel view.
 */
export function summarizeHistory(entries, installed) {
  let rollbackTarget
  if (installed !== undefined) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry.result !== 'ok') continue
      // Walk back over failures to the last success; only when THAT success
      // produced the on-disk version is its origin a trustworthy target.
      if (entry.to === installed && typeof entry.from === 'string' && entry.from !== installed) {
        rollbackTarget = entry.from
      }
      break
    }
  }
  return {
    ...(rollbackTarget !== undefined ? { rollbackTarget } : {}),
    recent: entries.slice(-HISTORY_SHOWN),
  }
}

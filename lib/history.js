/**
 * The install history.
 *
 * Every settled install appends one line: when, from which running version,
 * to which target, with what result, and WHO asked for it (a person, the
 * policy engine, or the planned check). The file lives under the user's home
 * — NOT inside the dsh package directory, which an update replaces — so the
 * history survives the very updates it records.
 *
 * Rollback offers no longer derive from here: the snapshot store answers
 * "what can this machine instantly go back to" far more reliably than a
 * walk over past entries ever could. History stays what it is good at — an
 * audit trail the panel shows as recent activity.
 * @module dsh-version-update/history
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TRIGGERS } from './updater.js'

/** How many entries the file retains. */
export const HISTORY_MAX = 50

/** How many recent entries travel to the panel. */
export const HISTORY_SHOWN = 3

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
 * Whether one parsed value looks like a history entry. Tolerates entries
 * written by older plugin versions (no `trigger`) and by restores (`from`
 * absent because nothing was installed).
 * @param {unknown} entry - the parsed candidate.
 * @returns {boolean} true when the value may stay in the file.
 */
function looksLikeEntry(entry) {
  if (typeof entry !== 'object' || entry === null) return false
  const record = /** @type {Record<string, unknown>} */ (entry)
  if (typeof record.at !== 'number') return false
  if (typeof record.to !== 'string') return false
  if (record.result !== 'ok' && record.result !== 'failed') return false
  if (record.trigger !== undefined && !TRIGGERS.includes(/** @type {string} */ (record.trigger))) return false
  return true
}

/**
 * Read the history file, tolerating every kind of absence or corruption: an
 * unreadable history costs the activity view, never the update itself.
 * @param {string} path - the history file path.
 * @returns {{ at: number; from?: string; to: string; result: 'ok' | 'failed'; trigger?: string }[]} the entries, oldest first.
 */
export function loadHistory(path) {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(looksLikeEntry)
  } catch {
    return []
  }
}

/**
 * Append one entry and cap the file. Creates the directory on first write.
 * @param {string} path - the history file path.
 * @param {{ at: number; from?: string; to: string; result: 'ok' | 'failed'; trigger?: string; restored?: boolean }} entry - the record.
 */
export function appendHistory(path, entry) {
  const entries = [...loadHistory(path), entry].slice(-HISTORY_MAX)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(entries, null, 1)}\n`, 'utf8')
}

/**
 * Shape the history for the panel: the most recent entries, newest first.
 * @param {{ at: number; from?: string; to: string; result: string; trigger?: string; restored?: boolean }[]} entries - the history, oldest first.
 * @returns {{ recent: { at: number; from?: string; to: string; result: string; trigger?: string; restored?: boolean }[] }} the panel view.
 */
export function summarizeHistory(entries) {
  return {
    recent: [...entries].slice(-HISTORY_SHOWN).reverse(),
  }
}

/**
 * Global-tree health: detection and repair of a half-committed npm install.
 *
 * When npm replaces a package during reify it first renames the old folder in
 * place to a RETIRED temporary name — `.<name>-<8-char hash>` in the same
 * directory (see @npmcli/arborist `lib/retire-path.js`) — and deletes the
 * retired copies at the end. npm only reaches that deletion when the run
 * finishes; an npm that is killed (or crashes, or loses power) mid-reify
 * leaves the retired folders behind: the half-committed state. Worse, the
 * rename is a move, so the real package folder may be MISSING while its
 * content sits under a retired name — which is exactly why a killed install
 * breaks the host instead of merely littering the disk. npm's own tree loader
 * ignores every dot-prefixed entry (`load-actual.js`: "ignore . dirs and
 * retired scoped package folders"), so the leftovers are invisible to npm and
 * never cleaned up by it later.
 *
 * This module detects that state and repairs what a local snapshot can
 * repair, without npm and without the network:
 * - a damaged installation manifest (dsh itself unreadable) is restored from
 *   the newest usable local snapshot — the same instant-rollback the panel
 *   offers, applied automatically because a damaged tree cannot serve dsh;
 * - leftover retired folders are deleted once they are provably not from a
 *   run in progress (older than {@link RETIRED_MIN_AGE_MS} on the boot path,
 *   unconditionally after this process's own npm has settled).
 *
 * Everything is synchronous and local: the repair is deliberately as dumb and
 * as reliable as a file copy.
 * @module dsh-version-update/tree-health
 */

import { readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { readInstalled } from './core.js'
import { listSnapshots, restoreSnapshot } from './snapshot.js'

/**
 * How old a retired folder must be before the boot path deletes it.
 *
 * npm retires folders for seconds at a time during a healthy reify, so any
 * retired folder younger than this is plausibly from an npm that is STILL
 * running — an orphan left by a crashed or restarted host keeps writing long
 * after its parent died. Deleting under a live reify would race its renames;
 * reporting instead costs one restart and risks nothing.
 */
export const RETIRED_MIN_AGE_MS = 10 * 60 * 1000

/**
 * npm's retired temporary-name shape: a leading dot, the original package
 * folder name, one dash, and exactly the 8-character truncated sha1 of the
 * original path. The dash-plus-eight rule is what separates retirements from
 * every legitimate dot entry in a node_modules tree (`.bin`,
 * `.package-lock.json`, `.DS_Store`) — none of those end in `-` plus eight
 * alphanumeric characters.
 */
export const RETIRED_NAME_PATTERN = /^\.[A-Za-z0-9@._-]+-[0-9A-Za-z]{8}$/

/**
 * Build the retired-name matcher for one installed package folder: the
 * retirement of `<dir>` is `.<basename>-<hash>` in the parent directory.
 * @param {string} installDir - the installed package directory.
 * @returns {RegExp} the matcher for its own retired names.
 */
function selfRetiredPattern(installDir) {
  return new RegExp(`^\\.${basename(installDir)}-[0-9A-Za-z]{8}$`)
}

/**
 * List one directory's retired-folder entries.
 * @param {string} dir - the directory to scan.
 * @param {(name: string) => boolean} [accept] - extra name filter.
 * @param {() => number} now - clock for age computation.
 * @returns {{ name: string; path: string; ageMs: number }[]} the retired folders found.
 */
function scanDir(dir, accept, now) {
  /** @type {{ name: string; path: string; ageMs: number }[]} */
  const found = []
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return found
  }
  for (const name of names) {
    if (!RETIRED_NAME_PATTERN.test(name)) continue
    if (accept !== undefined && !accept(name)) continue
    const path = join(dir, name)
    let stats
    try {
      stats = statSync(path)
    } catch {
      // Listed but unreadable: age is unknowable, so touching it is not safe
      // to decide here — a concurrently-running reify may hold it.
      continue
    }
    if (!stats.isDirectory()) continue
    found.push({ name, path, ageMs: Math.max(0, now() - stats.mtimeMs) })
  }
  return found
}

/**
 * Scan the managed installation's tree for retired leftovers.
 *
 * Three locations matter, each with its own safety rule:
 * - the directory that holds the dsh package itself (the global `node_modules`
 *   or its `@deepseek-ai` scope): only the dsh package's own `.dsh-<hash>`
 *   entries count, because other global packages live beside dsh and their
 *   own installs may retire folders there;
 * - the dsh package's own `node_modules` root and every `@scope` folder inside
 *   it: dsh bundles its dependency tree, and a killed install retires those
 *   folders by the dozen — this is where the "half-committed" mass comes from.
 * @param {string} installDir - the dsh package directory.
 * @param {{ now?: () => number }} [deps] - clock seam.
 * @returns {{ name: string; path: string; ageMs: number }[]} the leftovers, unsorted.
 */
export function scanRetiredLeftovers(installDir, deps = {}) {
  const now = deps.now ?? Date.now
  /** @type {{ name: string; path: string; ageMs: number }[]} */
  const found = []
  // The managed package's own retirement, wherever it is nested.
  const isSelfRetired = selfRetiredPattern(installDir)
  found.push(...scanDir(dirname(installDir), name => isSelfRetired.test(name), now))
  // Bundled dependencies: the package's own node_modules root and scopes.
  const bundled = join(installDir, 'node_modules')
  found.push(...scanDir(bundled, undefined, now))
  let entries
  try {
    entries = readdirSync(bundled)
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.startsWith('@')) continue
    found.push(...scanDir(join(bundled, entry), undefined, now))
  }
  return found
}

/**
 * Inspect the installation's health: can dsh be read, and what is littered.
 * @param {string} installDir - the dsh package directory.
 * @param {{ now?: () => number }} [deps] - clock seam.
 * @returns {{ installDir: string; manifestOk: boolean; leftovers: { name: string; path: string; ageMs: number }[] }} the facts.
 */
export function inspectTreeHealth(installDir, deps = {}) {
  return {
    installDir,
    manifestOk: readInstalled(installDir).installed !== undefined,
    leftovers: scanRetiredLeftovers(installDir, deps),
  }
}

/**
 * Repair a half-committed installation, best-effort and synchronous.
 *
 * Order matters: the manifest decides whether a restore is needed (a retired
 * folder alone is litter; a missing manifest means dsh itself was renamed
 * away and never came back), and the leftover cleanup runs AFTER any restore
 * because a restore replaces the bundled tree wholesale. A restore is only
 * attempted when no recent retirement of dsh itself suggests an npm is
 * mid-reify right now — see {@link RETIRED_MIN_AGE_MS}.
 * @param {{ installDir: string; snapshotsDir: string; minAgeMs?: number; now?: () => number }} deps - the facts and seams.
 * @returns {{ manifestOk: boolean; restored?: string; removed: number; errors: string[] }} the outcome.
 */
export function repairTree(deps) {
  const { installDir, snapshotsDir } = deps
  const minAgeMs = deps.minAgeMs ?? 0
  const now = deps.now ?? Date.now
  const before = inspectTreeHealth(installDir, { now })
  /** @type {{ manifestOk: boolean; restored?: string; removed: number; errors: string[] }} */
  const outcome = { manifestOk: before.manifestOk, removed: 0, errors: [] }

  if (!before.manifestOk) {
    const isSelfRetired = selfRetiredPattern(installDir)
    const recentRetirement = before.leftovers.some(entry => isSelfRetired.test(entry.name) && entry.ageMs < minAgeMs)
    if (recentRetirement) {
      outcome.errors.push('dsh manifest is damaged, but a recent npm retirement was seen on this tree — an install may still be running, so no automatic restore was attempted; re-run the repair after it settles')
    } else {
      const candidates = (listSnapshots(snapshotsDir) ?? [])
        .filter(entry => entry.usable)
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      const pick = candidates[0]
      if (pick === undefined) {
        outcome.errors.push('dsh manifest is damaged and no usable snapshot exists — repair from a terminal: npm install -g @deepseek-ai/dsh@latest')
      } else {
        const restore = restoreSnapshot({ installDir, snapshotsDir, version: pick.version })
        if (restore.ok) outcome.restored = pick.version
        else outcome.errors.push(`snapshot restore failed: ${restore.error ?? 'unknown reason'}`)
      }
    }
  }

  // Re-inspect after any restore: the copied-in tree replaces the bundled
  // node_modules wholesale, so the earlier scan is stale either way.
  const after = inspectTreeHealth(installDir, { now })
  outcome.manifestOk = after.manifestOk
  for (const entry of after.leftovers) {
    if (entry.ageMs < minAgeMs) continue
    try {
      rmSync(entry.path, { recursive: true, force: true })
      outcome.removed += 1
    } catch (error) {
      outcome.errors.push(`could not remove ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return outcome
}
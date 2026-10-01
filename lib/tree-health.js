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
 * - on the post-failure path the trigger is wider: a tree that still parses
 *   but has lost its launcher entry (`lib/bin.js`) is equally unable to start
 *   dsh, and it is the shape a failed install leaves most often, because npm
 *   replaces files in place and can stop anywhere inside that window;
 * - leftover retired folders are deleted once they are provably not from a
 *   run in progress (older than {@link RETIRED_MIN_AGE_MS} on the boot path,
 *   unconditionally after this process's own npm has settled).
 *
 * Everything is synchronous and local: the repair is deliberately as dumb and
 * as reliable as a file copy.
 * @module dsh-version-update/tree-health
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
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
 * @param {(name: string) => boolean} accept - extra name filter; return true to accept.
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
  // Freshness must come from the DIRECTORY THAT HOLDS the retirement, not from
  // the retired folder's own mtime. npm retires a package by RENAMING it aside
  // (arborist `lib/retire-path.js`), and a rename updates the PARENT's mtime
  // while leaving the renamed directory's own mtime untouched — so a folder
  // retired one second ago still reports whatever mtime it had when it was last
  // written, which for a package installed days ago is days old. Reading that as
  // "old" is how a live reify gets its retired copies deleted underneath it.
  // The parent's mtime is when the last entry in it changed, so taking the
  // YOUNGER of the two can only ever protect more, never less.
  let parentMtimeMs = 0
  try {
    parentMtimeMs = statSync(dir).mtimeMs
  } catch {
    // Unreadable parent: fall back to the entry's own mtime, as before.
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
    found.push({ name, path, ageMs: Math.max(0, now() - Math.max(stats.mtimeMs, parentMtimeMs)) })
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
  found.push(...scanDir(bundled, () => true, now))
  /** @type {string[]} */
  let entries = []
  try {
    entries = readdirSync(bundled)
  } catch {
    // Unreadable bundled directory: nothing to scan inside it.
  }
  for (const entry of entries) {
    if (!entry.startsWith('@')) continue
    found.push(...scanDir(join(bundled, entry), () => true, now))
  }
  return found
}

/**
 * Inspect the installation's health: can dsh be read and launched, and what is
 * littered.
 *
 * `launcherOk` is deliberately separate from `manifestOk` because the two
 * failures have different causes: an unreadable manifest means the package
 * folder itself was renamed away mid-reify, while a readable manifest with no
 * `lib/bin.js` means the tree was left half-written INSIDE — the state in which
 * `npm` reports success-shaped progress and dsh simply cannot start. Only the
 * post-failure repair treats the second as damage (see {@link repairTree}'s
 * `requireLauncher`); the boot path reports it and touches nothing, because a
 * running process that booted from that tree is itself evidence the check may
 * not mean what it looks like.
 * @param {string} installDir - the dsh package directory.
 * @param {{ now?: () => number }} [deps] - clock seam.
 * @returns {{ installDir: string; manifestOk: boolean; launcherOk: boolean; leftovers: { name: string; path: string; ageMs: number }[] }} the facts.
 */
export function inspectTreeHealth(installDir, deps = {}) {
  return {
    installDir,
    manifestOk: readInstalled(installDir).installed !== undefined,
    launcherOk: existsSync(join(installDir, 'lib', 'bin.js')),
    leftovers: scanRetiredLeftovers(installDir, deps),
  }
}

/**
 * Repair a half-committed installation, best-effort and synchronous.
 *
 * A missing manifest or launcher requires a restore; retired folders alone
 * are litter. An explicit preferredVersion requests that exact pre-install
 * snapshot even when the current tree looks healthy (validation may have
 * found the wrong version). If it is unavailable, do not restore an unrelated
 * version. Cleanup runs after restore, and recent retirements of dsh itself
 * still guard against racing a live npm — see {@link RETIRED_MIN_AGE_MS}.
 * @param {{ installDir: string; snapshotsDir: string; preferredVersion?: string; minAgeMs?: number; now?: () => number }} deps - the facts and seams.
 * @returns {{ manifestOk: boolean; launcherOk: boolean; restored?: string; removed: number; errors: string[]; leftovers: { name: string; path: string; ageMs: number }[] }} the outcome.
 */
export function repairTree(deps) {
  const { installDir, snapshotsDir } = deps
  const minAgeMs = deps.minAgeMs ?? 0
  const now = deps.now ?? Date.now
  const before = inspectTreeHealth(installDir, { now })
  /** @type {{ manifestOk: boolean; launcherOk: boolean; restored?: string; removed: number; errors: string[]; leftovers: { name: string; path: string; ageMs: number }[] }} */
  const outcome = { manifestOk: before.manifestOk, launcherOk: before.launcherOk, removed: 0, errors: [], leftovers: [] }

  if (!before.manifestOk || !before.launcherOk || deps.preferredVersion !== undefined) {
    const isSelfRetired = selfRetiredPattern(installDir)
    const recentRetirement = before.leftovers.some(entry => isSelfRetired.test(entry.name) && entry.ageMs < minAgeMs)
    if (recentRetirement) {
      outcome.errors.push('dsh requires repair, but a recent npm retirement was seen on this tree — an install may still be running, so no automatic restore was attempted; re-run the repair after it settles')
    } else {
      const candidates = (listSnapshots(snapshotsDir) ?? [])
        .filter(entry => entry.usable)
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      // Listing is metadata-level, so a snapshot whose bytes no longer match
      // its inventory still lists as usable and is refused by the restore
      // itself. Walking the candidates newest-first is what keeps one such
      // entry from blocking the repair entirely — the state in which dsh
      // cannot start at all. An explicit `preferredVersion` is a different
      // instruction: restore exactly that one, or nothing.
      const wanted = deps.preferredVersion === undefined
        ? candidates
        : candidates.filter(entry => entry.version === deps.preferredVersion)
      if (wanted.length === 0) {
        outcome.errors.push(deps.preferredVersion === undefined
          ? 'dsh manifest or launcher is damaged and no usable snapshot exists — repair from a terminal: npm install -g @deepseek-ai/dsh@latest'
          : `no usable snapshot of requested pre-install version ${deps.preferredVersion}; no other version was restored`)
      }
      /** @type {string[]} */
      const failures = []
      for (const candidate of wanted) {
        const restore = restoreSnapshot({ installDir, snapshotsDir, version: candidate.version })
        if (restore.ok) {
          outcome.restored = candidate.version
          break
        }
        failures.push(`${candidate.version}: ${restore.error ?? 'unknown reason'}`)
      }
      // A candidate that failed while a later one succeeded is a fact about
      // that store entry, not a failure of this repair — and the repair
      // succeeded, so the tree must not be reported as damaged because of it.
      if (outcome.restored === undefined && failures.length > 0) {
        outcome.errors.push(`snapshot restore failed: ${failures.join('; ')}`)
      }
    }
  }

  // Re-inspect after any restore: the copied-in tree replaces the bundled
  // node_modules wholesale, so the earlier scan is stale either way.
  const after = inspectTreeHealth(installDir, { now })
  outcome.manifestOk = after.manifestOk
  outcome.launcherOk = after.launcherOk
  if (outcome.restored !== undefined && (!after.manifestOk || !after.launcherOk)) {
    outcome.errors.push('restored snapshot still has a damaged manifest or missing launcher')
  }
  for (const entry of after.leftovers) {
    if (entry.ageMs < minAgeMs) {
      outcome.leftovers.push(entry)
      continue
    }
    try {
      rmSync(entry.path, { recursive: true, force: true })
      outcome.removed += 1
    } catch (error) {
      outcome.leftovers.push(entry)
      outcome.errors.push(`could not remove ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Report only retained entries, without another full scan.
  return outcome
}
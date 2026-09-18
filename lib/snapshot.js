/**
 * Local version snapshots: the mechanism behind instant rollback.
 *
 * A snapshot is a full copy of the installed dsh package directory, taken
 * BEFORE an install overwrites it, stored under the user profile where no
 * update can reach it. Restoring one is a pure filesystem operation — copy
 * the stored tree back over the live installation — which is why a rollback
 * needs neither npm nor the network nor a reachable registry, and completes
 * in seconds instead of minutes.
 *
 * Each snapshot carries a small `meta.json` naming its version and creation
 * time. A directory without intact metadata is not a snapshot, whatever its
 * name says: every reader validates before trusting, so a half-written copy
 * (crash mid-cp) can never be restored over a working installation. Creation
 * therefore goes through a temp directory first and renames only when the
 * copy is complete.
 * @module dsh-version-update/snapshot
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cp as cpAsync, lstat as lstatAsync, mkdir as mkdirAsync, readdir as readdirAsync, rename as renameAsync, rm as rmAsync, stat as statAsync, writeFile as writeFileAsync } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isInstallableVersion, readInstalled } from './core.js'
import { inventory, inventoryAsync, inventoryBytes } from './snapshot-inventory.js'

/**
 * Read payload bytes, measuring legacy snapshots that have no stored count.
 * Metadata itself and symbolic-link targets are excluded, as in the inventory.
 * @param {string} snapshotsDir - the snapshots directory.
 * @param {{ version: string; bytes?: number }} entry - a listed snapshot.
 * @returns {number} its payload bytes, or zero if it cannot be measured.
 */
function snapshotBytes(snapshotsDir, entry) {
  if (entry.bytes !== undefined) return entry.bytes
  try { return inventoryBytes(inventory(join(snapshotsDir, entry.version))) } catch { return 0 }
}

/**
 * Total stored snapshot payload bytes, without changing the list API shape.
 * Legacy snapshots without a byte count are measured on demand; temporary
 * directories are excluded, just as they are from listSnapshots.
 * @param {string} snapshotsDir - the snapshots directory.
 * @returns {number} the summed payload bytes across stored snapshots.
 */
export function snapshotsTotalBytes(snapshotsDir) {
  return listSnapshots(snapshotsDir).reduce((total, entry) => total + snapshotBytes(snapshotsDir, entry), 0)
}

/**
 * The snapshot storage root under the user profile.
 * @param {{ home?: string }} [deps] - test seam.
 * @returns {string} the snapshots directory.
 */
export function defaultSnapshotsDir(deps = {}) {
  return join(deps.home ?? homedir(), '.dsh-version-update', 'snapshots')
}

/**
 * Read a snapshot directory's own metadata.
 * @param {string} dir - the candidate snapshot directory.
 * @returns {{ version?: string; at?: number; bytes?: number; files?: import('./snapshot-inventory.js').InventoryEntry[]; format?: number }} the metadata, when readable.
 */
function readMeta(dir) {
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    return {
      ...(typeof meta.version === 'string' ? { version: meta.version } : {}),
      ...(typeof meta.at === 'number' ? { at: meta.at } : {}),
      ...(typeof meta.format === 'number' ? { format: meta.format } : {}),
      ...(Number.isFinite(meta.bytes) && meta.bytes >= 0 ? { bytes: meta.bytes } : {}),
      ...(Array.isArray(meta.files) ? { files: meta.files } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Whether a directory holds a trustworthy snapshot of exactly `version`:
 * intact metadata, an intact package manifest, and both naming the same
 * version as the directory itself.
 * @param {string} dir - the candidate snapshot directory.
 * @param {string} version - the version it must be a snapshot of.
 * @returns {boolean} true when the snapshot can be restored.
 */
function isValidSnapshot(dir, version) {
  if (!existsSync(join(dir, 'package.json')) || !existsSync(join(dir, 'meta.json'))) return false
  const meta = readMeta(dir)
  if (meta.version !== version || meta.at === undefined) return false
  if (readInstalled(dir).installed !== version) return false
  if (meta.format === undefined) return true // legacy: metadata-only assurance
  if (meta.format !== 2 || !Array.isArray(meta.files)) return false
  try {
    return JSON.stringify(inventory(dir)) === JSON.stringify(meta.files)
  } catch { return false }
}

/**
 * List the snapshots currently stored, newest first. Entries whose tree or
 * metadata is damaged still appear — marked invalid — because silently hiding
 * them would leave the user wondering why a version they remember is gone.
 * @param {string} snapshotsDir - the snapshots directory.
 * @returns {{ version: string; at?: number; usable: boolean; bytes?: number; integrity: string }[]} the snapshots.
 */
export function listSnapshots(snapshotsDir) {
  if (!existsSync(snapshotsDir)) return []
  /** @type {{ version: string; at?: number; usable: boolean; bytes?: number; integrity: string }[]} */
  const entries = []
  let names = []
  try {
    names = readdirSync(snapshotsDir)
  } catch {
    return []
  }
  for (const name of names) {
    // Hidden working directories — a snapshot still being copied (`.tmp-*`) and
    // a discarded one still being unlinked (`.trash-*`) — are not version names
    // and are excluded by this same rule.
    if (!isInstallableVersion(name)) continue
    const dir = join(snapshotsDir, name)
    let stats
    try {
      stats = statSync(dir)
    } catch {
      continue
    }
    if (!stats.isDirectory()) continue
    const meta = readMeta(dir)
    entries.push({
      version: name,
      ...(meta.at !== undefined ? { at: meta.at } : {}),
      usable: isValidSnapshot(dir, name),
      ...(meta.bytes !== undefined ? { bytes: meta.bytes } : {}),
      integrity: meta.format === 2 ? 'inventory' : 'legacy',
    })
  }
  return entries.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
}

/** Prefix of a directory an in-flight snapshot is still being written into. */
export const TEMP_PREFIX = '.tmp-'

/**
 * Prefix of a directory whose snapshot has been discarded and is only waiting
 * to be unlinked. Renamed out of the way first so the version it held stops
 * being listed the instant the user confirms.
 */
export const TRASH_PREFIX = '.trash-'

/**
 * Unlinks still running in the background, so a sweep can wait for them and a
 * test can assert on the finished state instead of polling.
 * @type {Set<Promise<void>>}
 */
const pendingUnlinks = new Set()

/**
 * Delete a directory off the event loop.
 *
 * A snapshot is a full copy of the installed package tree — 200 MB and tens of
 * thousands of files is ordinary, and on Windows `rmSync` on one measures in
 * the seconds (129 MB / 15 569 files took 5.6 s here, with Defender scanning
 * every entry). Blocking on that inside a route freezes the whole host AND
 * outlives the panel's request timeout, which is what made "删除快照" look like
 * a dead button. So the route only renames; this does the unlinking.
 * @param {string} dir - the directory to remove.
 * @returns {Promise<void>} resolves when it is gone (or cannot be removed).
 */
function unlinkInBackground(dir) {
  const task = rmAsync(dir, { recursive: true, force: true })
    .catch(() => {})
    .then(() => { pendingUnlinks.delete(task) })
  pendingUnlinks.add(task)
  return task
}

/**
 * Delete one stored snapshot.
 *
 * The directory is RENAMED to a hidden tombstone rather than removed in place.
 * A same-volume rename is a metadata operation — instant however large the
 * snapshot — so the caller answers while the bytes are still on disk, and the
 * version disappears from {@link listSnapshots} at once because a tombstone is
 * not a version name. The unlink then happens on the threadpool.
 * @param {string} snapshotsDir - the snapshots directory.
 * @param {string} version - the version whose snapshot should go.
 * @returns {boolean} true when something was removed.
 */
export function removeSnapshot(snapshotsDir, version) {
  if (!isInstallableVersion(version)) return false
  const dir = join(snapshotsDir, version)
  if (!existsSync(dir)) return false
  const trash = join(snapshotsDir, `${TRASH_PREFIX}${version}-${Date.now()}`)
  try {
    renameSync(dir, trash)
  } catch {
    // Windows refuses to rename a directory with an open handle inside it. The
    // slow path is the only one left: correct, but it can outlive the caller's
    // request — which is why it is the fallback and not the rule.
    rmSync(dir, { recursive: true, force: true })
    return true
  }
  unlinkInBackground(trash)
  return true
}

/**
 * Clear the hidden working directories a killed process leaves behind: a
 * `.tmp-*` snapshot that was interrupted mid-copy, and a `.trash-*` tombstone
 * whose unlink never finished. Both are invisible to the panel (they are not
 * version names), so nothing else would ever reclaim their disk.
 * @param {string} snapshotsDir - the snapshots directory.
 * @returns {Promise<number>} how many directories were swept.
 */
export async function sweepSnapshots(snapshotsDir) {
  // Wait out the unlinks this process already started, so the sweep cannot
  // race one of them and count a directory it is about to lose anyway.
  await Promise.all([...pendingUnlinks])
  let names = []
  try {
    names = await readdirAsync(snapshotsDir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX) && !name.startsWith(TRASH_PREFIX)) continue
    await rmAsync(join(snapshotsDir, name), { recursive: true, force: true }).catch(() => {})
    removed += 1
  }
  return removed
}

/**
 * Keep at most `keep` usable snapshots, dropping the oldest first. Damaged
 * directories are pruned first regardless of age: they can never be restored,
 * so they are pure disk waste.
 * @param {string} snapshotsDir - the snapshots directory.
 * @param {number} keep - how many usable snapshots to retain (minimum 1).
 * @param {string} keepVersion - the just-created rollback point to protect.
 */
function pruneSnapshots(snapshotsDir, keep, keepVersion) {
  const limit = Math.max(1, Math.floor(keep))
  const entries = listSnapshots(snapshotsDir)
  const damaged = entries.filter(entry => !entry.usable)
  const healthy = entries.filter(entry => entry.usable).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  // All damaged entries go first (they can never be restored), then the
  // oldest healthy ones beyond the retention limit.
  const doomed = [...damaged, ...healthy.filter(entry => entry.version !== keepVersion).slice(0, Math.max(0, healthy.length - limit))]
  for (const entry of doomed) {
    removeSnapshot(snapshotsDir, entry.version)
  }
}

/**
 * Enforce the optional byte quota after the count-based retention. Damaged
 * snapshots are already gone by the time this runs, so only usable ones are
 * measured; the oldest usable snapshots are deleted until the store fits —
 * except the snapshot just created, which is the rollback point this install
 * depends on and is never a quota casualty, even when it alone exceeds the
 * configured budget. A quota of 0 (or a falsy one) means unlimited.
 * @param {string} snapshotsDir - the snapshots directory.
 * @param {number} maxBytes - the quota in bytes; 0 disables it.
 * @param {string} keepVersion - the version whose snapshot must survive.
 */
function pruneSnapshotQuota(snapshotsDir, maxBytes, keepVersion) {
  const limit = Number(maxBytes)
  if (!Number.isFinite(limit) || limit <= 0) return
  // Oldest first so the quota eats history in creation order, mirroring the
  // count-based retention's "drop the oldest" contract.
  const usable = listSnapshots(snapshotsDir)
    .filter(entry => entry.usable)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  const measured = usable.map(entry => ({ ...entry, bytes: snapshotBytes(snapshotsDir, entry) }))
  let total = measured.reduce((sum, entry) => sum + entry.bytes, 0)
  for (const entry of measured) {
    if (total <= limit) break
    if (entry.version === keepVersion) continue // never delete what was just created
    if (!removeSnapshot(snapshotsDir, entry.version)) continue
    total -= entry.bytes ?? 0
  }
}

/**
 * Capture the live installation as the snapshot of `version`.
 *
 * Idempotent per version: an existing intact snapshot is reused, because the
 * tree of one exact version does not change between installs. A leftover
 * DAMAGED snapshot of the same version is replaced — it is worthless, and
 * keeping it would quietly downgrade this install's rollback safety.
 *
 * Everything is synchronous on purpose: the updater calls this immediately
 * before spawning npm, and the guarantee "the old tree is safe before npm
 * touches anything" must not depend on a floating promise being awaited.
 * @param {{ installDir: string; snapshotsDir: string; version: string; keep?: number; maxBytes?: number; now?: () => number }} deps - the facts and seams.
 * @returns {{ ok: boolean; reused?: boolean; error?: string }} the outcome.
 */
export function createSnapshot(deps) {
  const { installDir, snapshotsDir, version } = deps
  if (!isInstallableVersion(version)) return { ok: false, error: `refusing to snapshot ${JSON.stringify(String(version))}: not one exact published version` }
  const dest = join(snapshotsDir, version)
  if (isValidSnapshot(dest, version)) return { ok: true, reused: true }
  try {
    mkdirSync(snapshotsDir, { recursive: true })
    rmSync(dest, { recursive: true, force: true })
    const temp = join(snapshotsDir, `.tmp-${version}-${Date.now()}`)
    cpSync(installDir, temp, { recursive: true })
    const files = inventory(temp)
    writeFileSync(join(temp, 'meta.json'), `${JSON.stringify({ version, at: (deps.now ?? Date.now)(), format: 2, files, bytes: inventoryBytes(files) })}\n`, 'utf8')
    renameSync(temp, dest)
  } catch (error) {
    // A failed snapshot degrades the rollback offer, never the update: the
    // caller decides whether to proceed with npm anyway.
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  pruneSnapshots(snapshotsDir, deps.keep ?? 5, version)
  pruneSnapshotQuota(snapshotsDir, deps.maxBytes ?? 0, version)
  return { ok: true }
}

/**
 * Restore a snapshot over the live installation.
 *
 * The live tree is renamed aside first (same volume, so the rename is atomic)
 * and removed only after the copy succeeded; if the copy fails midway, the
 * renamed original is moved straight back, leaving the machine running
 * whatever it ran before the attempt. After a successful restore the RUNNING
 * process still executes the old code until the host restarts — exactly like
 * a forward update, and surfaced through the same `needsRestart` flow.
 * @param {{ installDir: string; snapshotsDir: string; version: string }} deps - the facts.
 * @returns {{ ok: boolean; error?: string }} the outcome.
 */
export function restoreSnapshot(deps) {
  const { installDir, snapshotsDir, version } = deps
  if (!isInstallableVersion(version)) return { ok: false, error: `refusing to restore ${JSON.stringify(String(version))}: not one exact published version` }
  const source = join(snapshotsDir, version)
  if (!isValidSnapshot(source, version)) return { ok: false, error: `no usable snapshot of ${version}` }
  const stale = `${installDir}.replaced-${Date.now()}`
  let moved = false
  try {
    renameSync(installDir, stale)
    moved = true
  } catch (error) {
    // Copying over a tree that could not be moved would leave mixed versions
    // and no rollback. Only ENOENT plus lstat-confirmed absence is safe;
    // existsSync alone would also hide permission errors and dangling links.
    let absent = false
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') {
      try { lstatSync(installDir) } catch (probeError) {
        absent = /** @type {NodeJS.ErrnoException} */ (probeError)?.code === 'ENOENT'
      }
    }
    if (!absent) return { ok: false, error: `could not move the live installation aside: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    cpSync(source, installDir, { recursive: true })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (moved) {
      try {
        rmSync(installDir, { recursive: true, force: true })
        renameSync(stale, installDir)
      } catch (rollbackError) {
        // Name the surviving copy: without it the user is left with a
        // half-written installation and no idea where their real tree went.
        return {
          ok: false,
          error: `${reason}; the previous tree was left at ${stale} and could not be moved back (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
        }
      }
    }
    return { ok: false, error: reason }
  }
  if (moved) rmSync(stale, { recursive: true, force: true })
  return { ok: true }
}

/**
 * Restore a snapshot over the live installation — the async sibling of
 * {@link restoreSnapshot}, with the same guarantees and the same rollback on a
 * torn copy.
 *
 * This is the variant the HOST serves restores through: a global dsh tree is
 * tens of thousands of files, and the synchronous copy blocks the event loop
 * for the whole operation — the panel would get no log, no status, and no
 * restart-route answer while the host was busy, which reads to the browser as
 * a dead host. Same-volume renames and `cp` do their IO on the threadpool
 * here, so the server keeps serving while the tree is swapped.
 * @param {{ installDir: string; snapshotsDir: string; version: string }} deps - the facts.
 * @returns {Promise<{ ok: boolean; error?: string }>} the outcome.
 */
export async function restoreSnapshotAsync(deps) {
  const { installDir, snapshotsDir, version } = deps
  if (!isInstallableVersion(version)) return { ok: false, error: `refusing to restore ${JSON.stringify(String(version))}: not one exact published version` }
  const source = join(snapshotsDir, version)
  if (!isValidSnapshot(source, version)) return { ok: false, error: `no usable snapshot of ${version}` }
  const stale = `${installDir}.replaced-${Date.now()}`
  let moved = false
  try {
    await renameAsync(installDir, stale)
    moved = true
  } catch (error) {
    // As in the synchronous path, a failed rename must never become an
    // in-place overwrite of an existing (or unreadable) installation.
    let absent = false
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') {
      try { await lstatAsync(installDir) } catch (probeError) {
        absent = /** @type {NodeJS.ErrnoException} */ (probeError)?.code === 'ENOENT'
      }
    }
    if (!absent) return { ok: false, error: `could not move the live installation aside: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    await cpAsync(source, installDir, { recursive: true, force: true })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (!moved) return { ok: false, error: reason }
    try {
      await rmAsync(installDir, { recursive: true, force: true })
      await renameAsync(stale, installDir)
      return { ok: false, error: reason }
    } catch (rollbackError) {
      // The pre-restore tree still exists under a known name: say where, or the
      // user has nothing to act on except a half-written installation.
      return {
        ok: false,
        error: `${reason}; the previous tree was left at ${stale} and could not be moved back (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
      }
    }
  }
  if (moved) {
    try {
      await rmAsync(stale, { recursive: true, force: true })
    } catch {
      // A leftover copy costs disk, never correctness: the restored tree is
      // complete and live. The boot-time repair has no name pattern for it.
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Asynchronous snapshot with progress
//
// The synchronous {@link createSnapshot} blocks the event loop for the whole
// copy — on a large installation (dsh ships 20k+ files) that freezes the web
// host itself: the install route cannot answer and the panel sits with no log
// for the entire copy. The async variant below does the same work through
// fs/promises (threadpool IO, event loop stays free) and reports progress
// through a callback, so the panel can show the copy advancing in real time.

/**
 * Sum one directory tree's files and bytes, skipping entries that vanish
 * mid-walk (the tree may be the destination of a copy in flight). Exported for
 * the updater's extraction watcher, which reports the same shape of progress
 * while npm rebuilds the installation.
 * @param {string} dir - the tree to measure.
 * @returns {Promise<{ files: number; bytes: number }>} the measured totals.
 */
export async function measureTree(dir) {
  let files = 0
  let bytes = 0
  /**
   * @param {string} current - the directory being walked.
   * @returns {Promise<void>}
   */
  const walk = async (current) => {
    let entries
    try {
      entries = await readdirAsync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
      } else if (entry.isFile()) {
        try {
          const stats = await statAsync(child)
          if (stats.isFile()) {
            files += 1
            bytes += stats.size
          }
        } catch {
          // Vanished mid-walk: excluded from the total, never fatal.
        }
      }
    }
  }
  await walk(dir)
  return { files, bytes }
}

/** How often the copy progress callback fires while a snapshot copies. */
export const SNAPSHOT_PROGRESS_MS = 1500

/**
 * Capture the live installation as the snapshot of `version` — the async
 * sibling of {@link createSnapshot}. Same guarantees (temp directory first,
 * rename on completion, reuse of an intact snapshot, prune after success),
 * but the copy runs on the threadpool and calls {@link deps.onProgress}
 * periodically with the copied totals so a waiting panel can show movement.
 * @param {{ installDir: string; snapshotsDir: string; version: string; keep?: number; maxBytes?: number; now?: () => number; onProgress?: (info: { phase: 'measure' | 'copy'; files: number; bytes: number; totalFiles?: number; totalBytes?: number }) => void; progressMs?: number }} deps - the facts, seams, and the progress observer.
 * @returns {Promise<{ ok: boolean; reused?: boolean; error?: string }>} the outcome.
 */
export async function createSnapshotAsync(deps) {
  const { installDir, snapshotsDir, version, onProgress } = deps
  if (!isInstallableVersion(version)) return { ok: false, error: `refusing to snapshot ${JSON.stringify(String(version))}: not one exact published version` }
  const dest = join(snapshotsDir, version)
  if (isValidSnapshot(dest, version)) return { ok: true, reused: true }
  try {
    await mkdirAsync(snapshotsDir, { recursive: true })
    await rmAsync(dest, { recursive: true, force: true })
    const temp = join(snapshotsDir, `.tmp-${version}-${Date.now()}`)
    try {
      // Measure first so the copy can report a percentage, not just a counter.
      const total = onProgress === undefined ? undefined : await measureTree(installDir)
      if (onProgress !== undefined && total !== undefined) {
        onProgress({ phase: 'measure', files: total.files, bytes: total.bytes, totalFiles: total.files, totalBytes: total.bytes })
      }
      let timer
      /**
       * The copy-phase report. `totalFiles`/`totalBytes` are named explicitly
       * rather than spread out of {@link total}: that object's own keys are
       * `files`/`bytes`, so a trailing spread would overwrite the live counts
       * with the totals — the panel would read a finished copy from the very
       * first tick, and `totalBytes` (the field the percentage is computed
       * from) would never arrive at all.
       * @param {{ files: number; bytes: number }} current - what the copy holds now.
       * @returns {void}
       */
      const report = (current) => {
        onProgress?.({
          phase: 'copy',
          files: current.files,
          bytes: current.bytes,
          ...(total !== undefined ? { totalFiles: total.files, totalBytes: total.bytes } : {}),
        })
      }
      if (onProgress !== undefined) {
        timer = setInterval(() => {
          void measureTree(temp).then(report, () => {})
        }, deps.progressMs ?? SNAPSHOT_PROGRESS_MS)
      }
      try {
        await cpAsync(installDir, temp, { recursive: true, force: true })
      } finally {
        if (timer !== undefined) clearInterval(timer)
      }
      // The final report: the periodic measurement lags the finished copy, so
      // measure once more and emit the completed state.
      if (onProgress !== undefined) {
        report(await measureTree(temp))
      }
      const files = await inventoryAsync(temp)
      await writeFileAsync(join(temp, 'meta.json'), `${JSON.stringify({ version, at: (deps.now ?? Date.now)(), format: 2, files, bytes: inventoryBytes(files) })}\n`, 'utf8')
      await renameAsync(temp, dest)
    } catch (error) {
      // A torn temp directory is worthless; remove it so it cannot pile up.
      await rmAsync(temp, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  } catch (error) {
    // A failed snapshot degrades the rollback offer, never the update: the
    // caller decides whether to proceed with npm anyway.
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  pruneSnapshots(snapshotsDir, deps.keep ?? 5, version)
  pruneSnapshotQuota(snapshotsDir, deps.maxBytes ?? 0, version)
  return { ok: true }
}

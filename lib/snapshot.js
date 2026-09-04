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

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cp as cpAsync, mkdir as mkdirAsync, readdir as readdirAsync, rename as renameAsync, rm as rmAsync, stat as statAsync, writeFile as writeFileAsync } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isInstallableVersion, readInstalled } from './core.js'

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
 * @returns {{ version?: string; at?: number }} the metadata, when readable.
 */
function readMeta(dir) {
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    return {
      ...(typeof meta.version === 'string' ? { version: meta.version } : {}),
      ...(typeof meta.at === 'number' ? { at: meta.at } : {}),
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
  return readInstalled(dir).installed === version
}

/**
 * List the snapshots currently stored, newest first. Entries whose tree or
 * metadata is damaged still appear — marked invalid — because silently hiding
 * them would leave the user wondering why a version they remember is gone.
 * @param {string} snapshotsDir - the snapshots directory.
 * @returns {{ version: string; at?: number; usable: boolean }[]} the snapshots.
 */
export function listSnapshots(snapshotsDir) {
  if (!existsSync(snapshotsDir)) return []
  /** @type {{ version: string; at?: number; usable: boolean }[]} */
  const entries = []
  let names = []
  try {
    names = readdirSync(snapshotsDir)
  } catch {
    return []
  }
  for (const name of names) {
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
    })
  }
  return entries.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
}

/**
 * Delete one stored snapshot.
 * @param {string} snapshotsDir - the snapshots directory.
 * @param {string} version - the version whose snapshot should go.
 * @returns {boolean} true when something was removed.
 */
export function removeSnapshot(snapshotsDir, version) {
  if (!isInstallableVersion(version)) return false
  const dir = join(snapshotsDir, version)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * Keep at most `keep` usable snapshots, dropping the oldest first. Damaged
 * directories are pruned first regardless of age: they can never be restored,
 * so they are pure disk waste.
 * @param {string} snapshotsDir - the snapshots directory.
 * @param {number} keep - how many usable snapshots to retain (minimum 1).
 */
function pruneSnapshots(snapshotsDir, keep) {
  const limit = Math.max(1, Math.floor(keep))
  const entries = listSnapshots(snapshotsDir)
  const damaged = entries.filter(entry => !entry.usable)
  const healthy = entries.filter(entry => entry.usable).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  // All damaged entries go first (they can never be restored), then the
  // oldest healthy ones beyond the retention limit.
  const doomed = [...damaged, ...healthy.slice(0, Math.max(0, healthy.length - limit))]
  for (const entry of doomed) {
    removeSnapshot(snapshotsDir, entry.version)
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
 * @param {{ installDir: string; snapshotsDir: string; version: string; keep?: number; now?: () => number }} deps - the facts and seams.
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
    writeFileSync(join(temp, 'meta.json'), `${JSON.stringify({ version, at: (deps.now ?? Date.now)() })}\n`, 'utf8')
    renameSync(temp, dest)
  } catch (error) {
    // A failed snapshot degrades the rollback offer, never the update: the
    // caller decides whether to proceed with npm anyway.
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  pruneSnapshots(snapshotsDir, deps.keep ?? 5)
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
  } catch {
    // Some other handle refuses the rename (an open watcher, a scan); fall
    // through to copying over the live tree directly. Slower and less tidy,
    // but cpSync overwrites file-by-file and needs nobody's permission.
  }
  try {
    cpSync(source, installDir, { recursive: true })
  } catch (error) {
    if (moved) {
      try {
        rmSync(installDir, { recursive: true, force: true })
        renameSync(stale, installDir)
      } catch {
        // Nothing further can be done here; the error below names the cause.
      }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (moved) rmSync(stale, { recursive: true, force: true })
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
 * @param {{ installDir: string; snapshotsDir: string; version: string; keep?: number; now?: () => number; onProgress?: (info: { phase: 'measure' | 'copy'; files: number; bytes: number; totalFiles?: number; totalBytes?: number }) => void; progressMs?: number }} deps - the facts, seams, and the progress observer.
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
      let last = { files: 0, bytes: 0 }
      let timer
      if (onProgress !== undefined) {
        timer = setInterval(() => {
          void measureTree(temp).then(current => {
            last = current
            onProgress({ phase: 'copy', files: current.files, bytes: current.bytes, ...(total ?? {}) })
          }, () => {})
        }, deps.progressMs ?? SNAPSHOT_PROGRESS_MS)
      }
      try {
        await cpAsync(installDir, temp, { recursive: true, force: true })
      } finally {
        if (timer !== undefined) clearInterval(timer)
      }
      // The final report: the copy threadpool work is done, so `last` lags the
      // true total — measure once more and emit the completed state.
      if (onProgress !== undefined) {
        const done = await measureTree(temp)
        onProgress({ phase: 'copy', files: done.files, bytes: done.bytes, ...(total ?? {}) })
      }
      await writeFileAsync(join(temp, 'meta.json'), `${JSON.stringify({ version, at: (deps.now ?? Date.now)() })}\n`, 'utf8')
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
  pruneSnapshots(snapshotsDir, deps.keep ?? 5)
  return { ok: true }
}

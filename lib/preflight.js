/**
 * Advisory, local-only update checks. No npm process or network request runs;
 * each failed check becomes a warning rather than rejecting the whole verdict.
 * @module dsh-version-update/preflight
 */

import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { resolveNpmCli } from './updater.js'

/**
 * Create and remove one exclusively-owned probe. Only snapshot storage may be
 * created; a missing installation parent must not be silently manufactured.
 * @param {string} dir - directory to probe.
 * @param {boolean} create - whether to create the directory first.
 * @param {{ writeFileImpl?: typeof fs.writeFile; unlinkImpl?: typeof fs.unlink; mkdirImpl?: typeof fs.mkdir }} deps - filesystem seams.
 * @returns {Promise<void>} rejects when creation, writing, or cleanup fails.
 */
async function probeWritable(dir, create, deps) {
  if (create) await (deps.mkdirImpl ?? fs.mkdir)(dir, { recursive: true })
  const path = join(dir, `.dshvu-preflight-${randomUUID()}`)
  // Never truncate an existing file or remove a file we did not create.
  const handle = await fs.open(path, 'wx', 0o600)
  try {
    await (deps.writeFileImpl ?? fs.writeFile)(handle, '')
  } finally {
    try {
      await handle.close()
    } finally {
      await (deps.unlinkImpl ?? fs.unlink)(path)
    }
  }
}

/**
 * Inspect installation prerequisites independently. `ok` means all checks
 * answered successfully, not a guarantee an install will succeed. Unknown
 * disk space is null and carries a warning; no arbitrary size cutoff is used.
 * @param {{ installDir?: string; snapshotsDir?: string; npmCli?: () => string | undefined; execPath?: string; env?: Record<string, string | undefined>; writeFileImpl?: typeof fs.writeFile; unlinkImpl?: typeof fs.unlink; mkdirImpl?: typeof fs.mkdir; statfsImpl?: ((path: string) => Promise<{ bsize: number; bavail: number }>) | null }} [deps] - local paths and injectable checks; null statfs simulates unsupported runtimes.
 * @returns {Promise<{ npm: { available: boolean; path?: string }; installDirWritable: boolean; diskFreeBytes: number | null; snapshotDirUsable: boolean; warnings: string[]; ok: boolean }>} the advisory verdict.
 */
export async function runPreflight(deps = {}) {
  /** @type {string[]} */
  const warnings = []
  /** @type {{ available: boolean; path?: string }} */
  let npm = { available: false }
  try {
    const cli = deps.npmCli !== undefined ? deps.npmCli() : resolveNpmCli(deps)
    if (typeof cli !== 'string' || cli === '') throw new Error('npm CLI not found; update from a terminal instead')
    npm = { available: true, path: cli }
  } catch {
    warnings.push('npm CLI unavailable: check the npm installation next to the running node binary or update from a terminal.')
  }

  let installDirWritable = false
  try {
    if (!deps.installDir) throw new Error('installation directory unknown')
    await probeWritable(dirname(deps.installDir), false, deps)
    installDirWritable = true
  } catch {
    warnings.push('Install directory parent is unknown or not writable: check global npm prefix permissions and file locks.')
  }

  /** @type {number | null} */
  let diskFreeBytes = null
  try {
    const statfs = deps.statfsImpl === undefined ? fs.statfs : deps.statfsImpl
    if (!deps.installDir || typeof statfs !== 'function') throw new Error('statfs unavailable')
    const stats = await statfs(deps.installDir)
    const bytes = stats.bsize * stats.bavail
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error('invalid free space')
    diskFreeBytes = bytes
    if (bytes === 0) warnings.push('No free disk space is available on the installation filesystem.')
  } catch {
    warnings.push('Free disk space could not be read (directory unknown, statfs unsupported, or filesystem error).')
  }

  let snapshotDirUsable = false
  try {
    if (!deps.snapshotsDir) throw new Error('snapshot directory unknown')
    await probeWritable(deps.snapshotsDir, true, deps)
    snapshotDirUsable = true
  } catch {
    warnings.push('Snapshot directory is unknown or not writable; rollback snapshots may be unavailable.')
  }

  return { npm, installDirWritable, diskFreeBytes, snapshotDirUsable, warnings, ok: warnings.length === 0 }
}

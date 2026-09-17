/** Snapshot inventory: file sizes and link targets, not a cryptographic archive. */
import { lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'

/** @typedef {{ path: string; size: number; link?: string }} InventoryEntry */
/** @param {string} dir @returns {InventoryEntry[]} */
export function inventory(dir) {
  /** @type {InventoryEntry[]} */
  const files = []
  /** @param {string} prefix */
  const walk = (prefix) => {
    for (const name of readdirSync(join(dir, prefix))) {
      if (!prefix && name === 'meta.json') continue
      const path = prefix ? `${prefix}/${name}` : name
      const full = join(dir, path)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) files.push({ path, size: 0, link: readlinkSync(full) })
      else if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) files.push({ path, size: stat.size })
      else throw new Error(`unsupported snapshot entry: ${path}`)
    }
  }
  walk('')
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
/** @param {string} dir @returns {Promise<InventoryEntry[]>} */
export async function inventoryAsync(dir) {
  /** @type {InventoryEntry[]} */
  const files = []
  /** @param {string} prefix */
  const walk = async (prefix) => {
    for (const name of await readdir(join(dir, prefix))) {
      if (!prefix && name === 'meta.json') continue
      const path = prefix ? `${prefix}/${name}` : name
      const full = join(dir, path)
      const stat = await lstat(full)
      if (stat.isSymbolicLink()) files.push({ path, size: 0, link: await readlink(full) })
      else if (stat.isDirectory()) await walk(path)
      else if (stat.isFile()) files.push({ path, size: stat.size })
      else throw new Error(`unsupported snapshot entry: ${path}`)
    }
  }
  await walk('')
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
/** @param {InventoryEntry[]} files */
export const inventoryBytes = files => files.reduce((total, file) => total + file.size, 0)

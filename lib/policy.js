/**
 * Persistence for the update policy.
 *
 * The policy is user-facing state that changes from the panel at runtime, so
 * it lives in its own file under the user profile — NOT inside the dsh
 * package directory an update replaces, and NOT only in cordis entry config,
 * which a panel toggle cannot rewrite. The file survives every update it
 * governs; the scheduler reads the in-memory copy the host keeps.
 *
 * Reading is total: any absence or corruption yields the default policy via
 * {@link repairPolicy}, because a broken policy file must never keep the host
 * from starting. Writing is atomic-enough: a temp file plus a same-directory
 * rename, so a crash mid-write cannot leave a truncated JSON behind.
 * @module dsh-version-update/policy
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_POLICY, repairPolicy } from './protocol.js'

/**
 * The persisted policy shape.
 * @typedef {import('./protocol.js').Policy} Policy
 */

/**
 * The policy file location: a dot-directory under the user profile.
 * @param {{ home?: string }} [deps] - test seam.
 * @returns {string} the policy file path.
 */
export function defaultPolicyPath(deps = {}) {
  return join(deps.home ?? homedir(), '.dsh-version-update', 'policy.json')
}

/**
 * Read and repair the stored policy. Every field is validated against the
 * same grammar the API enforces; anything unreadable falls back per-field to
 * the default rather than discarding the whole file — a typo in `window`
 * should not also reset the user's tracking choice.
 * @param {string} path - the policy file path.
 * @returns {Policy} the effective policy.
 */
export function loadPolicy(path) {
  if (!existsSync(path)) return structuredClone(DEFAULT_POLICY)
  try {
    return repairPolicy(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return structuredClone(DEFAULT_POLICY)
  }
}

/**
 * Persist one policy. Creates the directory on first write. The caller passes
 * an already-normalized value (the routes normalize before calling); this
 * function only handles durability.
 * @param {string} path - the policy file path.
 * @param {Policy} policy - the normalized policy to store.
 */
export function savePolicy(path, policy) {
  const dir = join(path, '..')
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.policy-${process.pid}-${Date.now()}.json`)
  writeFileSync(temp, `${JSON.stringify(policy, null, 1)}\n`, 'utf8')
  renameSync(temp, path)
}

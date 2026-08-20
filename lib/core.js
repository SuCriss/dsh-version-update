/**
 * Version facts and the registry read behind the version-update panel:
 * discover the running dsh installation, fetch the npm packument, and rank
 * versions so the panel can say whether an update exists.
 *
 * Version ranking is the semver subset the dsh package actually publishes:
 * `major.minor.patch` with an optional dash-separated pre-release of dot
 * separated numeric or alphanumeric identifiers. A value outside that subset
 * sorts below every valid version instead of throwing, so one malformed
 * registry key cannot hide the rest of the list.
 * @module dsh-version-update/core
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { DSH_PACKAGE } from './protocol.js'

/** Registry base URL of the public npm registry. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** Accept header selecting npm's abbreviated packument (far smaller than the full document). */
const ABBREVIATED = 'application/vnd.npm.install-v1+json'

/** How long a registry read may take before the route reports it as failed. */
export const REGISTRY_TIMEOUT_MS = 15000

/** The publishable version grammar this plugin ranks and accepts as an install target. */
export const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z-]+(?:\.[0-9a-z-]+)*))?$/i

/**
 * Parse a version into its comparable parts.
 * @param {string} version - the version text.
 * @returns {{ core: number[]; pre: string[] } | undefined} parts, or undefined when unparsable.
 */
export function parseVersion(version) {
  const match = VERSION_PATTERN.exec(version.trim())
  if (match === null) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Compare one pre-release identifier pair by semver rules: numeric before
 * alphanumeric, numerics numerically, alphanumerics by ASCII order.
 * @param {string} a - left identifier.
 * @param {string} b - right identifier.
 * @returns {number} negative, zero, or positive.
 */
function comparePreIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Number(a) - Number(b)
  if (aNumeric) return -1
  if (bNumeric) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Rank two versions. An unparsable version sorts below every parsable one.
 * @param {string} a - left version.
 * @param {string} b - right version.
 * @returns {number} negative when a < b, zero when equal, positive when a > b.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined && right === undefined) return 0
  if (left === undefined) return -1
  if (right === undefined) return 1
  for (let index = 0; index < 3; index += 1) {
    const delta = left.core[index] - right.core[index]
    if (delta !== 0) return delta
  }
  // A release outranks any pre-release of the same core version.
  if (left.pre.length === 0 && right.pre.length > 0) return 1
  if (left.pre.length > 0 && right.pre.length === 0) return -1
  const shared = Math.min(left.pre.length, right.pre.length)
  for (let index = 0; index < shared; index += 1) {
    const delta = comparePreIdentifier(left.pre[index], right.pre[index])
    if (delta !== 0) return delta
  }
  return left.pre.length - right.pre.length
}

/**
 * Whether a version string is a safe install target: the published grammar
 * only, so no registry text or user input can reach the spawned argument as a
 * range, a tag, a path, or a shell metacharacter.
 * @param {unknown} version - candidate version.
 * @returns {boolean} true when the value is one exact publishable version.
 */
export function isInstallableVersion(version) {
  return typeof version === 'string' && version.length <= 64 && VERSION_PATTERN.test(version)
}

/**
 * Global install roots to probe when neither the launcher path nor module
 * resolution names an installation: the npm prefix beside the running node
 * binary, and the Windows per-user npm prefix.
 * @param {{ execPath?: string; env?: Record<string, string | undefined> }} deps - platform seams.
 * @returns {string[]} candidate package directories, in probe order.
 */
function globalCandidates(deps) {
  const nodeDir = dirname(deps.execPath ?? process.execPath)
  const env = deps.env ?? process.env
  const roots = [
    join(nodeDir, 'node_modules'),
    join(nodeDir, '..', 'lib', 'node_modules'),
  ]
  if (env.APPDATA !== undefined) roots.push(join(env.APPDATA, 'npm', 'node_modules'))
  return roots.map(root => join(root, ...DSH_PACKAGE.split('/')))
}

/**
 * Locate the running dsh installation directory. `process.argv[1]` is the
 * launcher's own `lib/bin.js`, which names the installation actually running
 * rather than whichever copy module resolution would find; module resolution
 * and the global-prefix probe are fallbacks for hosts started through another
 * entry (tests, embedders).
 * @param {{ argv?: readonly string[]; anchor?: string; execPath?: string; env?: Record<string, string | undefined> }} [deps] - test seams.
 * @returns {string | undefined} the package directory, or undefined when unknown.
 */
export function resolveInstallationDir(deps = {}) {
  const argv = deps.argv ?? process.argv
  const binPath = argv[1]
  if (typeof binPath === 'string' && /[\\/]lib[\\/]bin\.js$/.test(binPath)) {
    return resolve(dirname(binPath), '..')
  }
  try {
    const require = createRequire(deps.anchor ?? import.meta.url)
    return dirname(require.resolve(`${DSH_PACKAGE}/package.json`))
  } catch {
    // Unresolvable from this module (the plugin lives outside the
    // installation's dependency graph): fall through to the global probe.
  }
  return globalCandidates(deps).find(dir => existsSync(join(dir, 'package.json')))
}

/**
 * Read the installed version and its directory from an installation directory.
 * The version is named `installed` because that is the field
 * {@link buildView} ranks channels against.
 * @param {string | undefined} dir - the installation directory.
 * @returns {{ installed?: string; dir?: string }} the installed facts.
 */
export function readInstalled(dir) {
  if (dir === undefined) return {}
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? { installed: manifest.version, dir } : { dir }
  } catch {
    // Unreadable or malformed manifest: the panel shows an unknown installed
    // version, which is exactly what the caller can act on.
    return { dir }
  }
}

/**
 * Fetch the abbreviated packument of the dsh package.
 * @param {{ registry?: string; fetchImpl?: typeof fetch; timeoutMs?: number }} [deps] - test seams.
 * @returns {Promise<{ distTags: Record<string, string>; versions: string[] }>} published facts.
 */
export async function fetchPublished(deps = {}) {
  const registry = (deps.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '')
  const fetchImpl = deps.fetchImpl ?? fetch
  const url = `${registry}/${DSH_PACKAGE.replace('/', '%2F')}`
  const response = await fetchImpl(url, {
    headers: { accept: ABBREVIATED },
    signal: AbortSignal.timeout(deps.timeoutMs ?? REGISTRY_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`registry read failed: HTTP ${response.status}`)
  }
  const body = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new Error('registry read failed: packument is not an object')
  }
  const distTags = typeof body['dist-tags'] === 'object' && body['dist-tags'] !== null ? body['dist-tags'] : {}
  const versionMap = typeof body.versions === 'object' && body.versions !== null ? body.versions : {}
  const tags = {}
  for (const [tag, version] of Object.entries(distTags)) {
    if (typeof version === 'string') tags[tag] = version
  }
  return {
    distTags: tags,
    versions: Object.keys(versionMap).sort((a, b) => compareVersions(b, a)),
  }
}

/**
 * Assemble the panel's view: installed version, channel targets, and whether
 * each channel is ahead of what is installed.
 * @param {{ installed?: string; distTags: Record<string, string>; versions: string[] }} facts - version facts.
 * @returns {{ installed?: string; channels: { channel: string; version: string; ahead: boolean }[]; versions: string[] }} the view.
 */
export function buildView(facts) {
  const channels = []
  for (const [channel, version] of Object.entries(facts.distTags)) {
    channels.push({
      channel,
      version,
      ahead: facts.installed !== undefined && compareVersions(version, facts.installed) > 0,
    })
  }
  channels.sort((a, b) => compareVersions(b.version, a.version))
  return {
    ...(facts.installed !== undefined ? { installed: facts.installed } : {}),
    channels,
    versions: facts.versions,
  }
}

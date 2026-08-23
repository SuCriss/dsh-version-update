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

/**
 * Validate a configured registry base URL and strip its trailing slashes.
 *
 * The value reaches two very different places: a `fetch` URL, and — since the
 * install must read the same registry the panel read — an `npm --registry`
 * argument. The second is why this is a hard validation rather than a
 * best-effort normalization: only an absolute http(s) URL may become a spawned
 * argument, so a configured value can never be read as another npm flag.
 * @param {string} registry - the configured base URL.
 * @returns {string} the URL without trailing slashes.
 * @throws {Error} when the value is not an absolute http(s) URL.
 */
export function normalizeRegistry(registry) {
  let url
  try {
    url = new URL(registry)
  } catch {
    throw new Error(`registry must be an absolute http(s) URL, got ${JSON.stringify(String(registry))}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`registry must use http or https, got ${JSON.stringify(url.protocol)}`)
  }
  return url.href.replace(/\/+$/, '')
}

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
 *
 * Declared as a type predicate so a caller that has passed this check can hand
 * the value straight to the spawn without a cast — the guard and the narrowing
 * stay the same fact.
 * @param {unknown} version - candidate version.
 * @returns {version is string} true when the value is one exact publishable version.
 */
export function isInstallableVersion(version) {
  return typeof version === 'string' && version.length <= 64 && VERSION_PATTERN.test(version)
}

/**
 * Global install roots to probe when neither the launcher path nor module
 * resolution names an installation: the npm prefix beside the running node
 * binary, the prefix npm itself was configured with, and the Windows per-user
 * npm prefix.
 *
 * `npm_config_prefix` covers the installations the node-adjacent probe cannot
 * see — a custom `--prefix`, nvm-windows, a portable node — because it is the
 * same value `npm install -g` would write to.
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
  const prefix = env.npm_config_prefix
  if (prefix !== undefined && prefix !== '') {
    // Windows keeps globals directly under the prefix; POSIX under lib.
    roots.push(join(prefix, 'node_modules'), join(prefix, 'lib', 'node_modules'))
  }
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
 * Extract the `owner/repo` slug from a package manifest's `repository` field.
 *
 * dsh is a monorepo package (`…/deepseek-harness.git`, directory `apps/cli`),
 * but releases are cut on the repository, so only owner and name matter.
 * Accepts the shapes npm manifests actually carry: a URL string or the
 * `{ type, url }` object, with or without the `git+` prefix and `.git`
 * suffix. Anything unparseable yields undefined rather than guessing.
 * @param {unknown} repository - the manifest's `repository` value.
 * @returns {string | undefined} `owner/repo`, or undefined when unrecognized.
 */
export function repositorySlug(repository) {
  /** @type {unknown} */
  let url = repository
  if (typeof url === 'object' && url !== null) {
    url = /** @type {Record<string, unknown>} */ (url).url
  }
  if (typeof url !== 'string') return undefined
  const match = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#]|$)/i.exec(url)
  if (match === null) return undefined
  return `${match[1]}/${match[2]}`
}

/**
 * Read the GitHub `owner/repo` the installed dsh publishes from, per its own
 * manifest. Resolved once per process by the caller; release notes have no
 * source without it.
 * @param {string | undefined} dir - the installation directory.
 * @returns {string | undefined} `owner/repo`, or undefined when unknown.
 */
export function readRepository(dir) {
  if (dir === undefined) return undefined
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return repositorySlug(manifest.repository)
  } catch {
    return undefined
  }
}

/** How long one GitHub release-notes read may take. */
export const NOTES_TIMEOUT_MS = 10000

/** How long a fetched notes body (or a confirmed miss) stays cached. */
export const NOTES_CACHE_TTL_MS = 60 * 60 * 1000

/** Hard cap on a cached notes body: the panel excerpts anyway. */
export const NOTES_LIMIT_CHARS = 20000

/**
 * Fetch the release notes of one exact published version from the package's
 * GitHub releases, trying each known tag convention in turn. A missing
 * release is a normal outcome (an npm-only publish), not an error.
 * @param {{ repo: string; version: string; fetchImpl?: typeof fetch; timeoutMs?: number; tags?: readonly string[] }} deps - the target and its seams.
 * @returns {Promise<{ notes?: string; url?: string }>} the body, when a release exists.
 */
export async function fetchReleaseNotes(deps) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? NOTES_TIMEOUT_MS
  const tags = deps.tags ?? [`dsh-v${deps.version}`, `v${deps.version}`]
  for (const tag of tags) {
    const url = `https://api.github.com/repos/${deps.repo}/releases/tags/${encodeURIComponent(tag)}`
    const response = await fetchImpl(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-version-update' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 404) continue
    if (!response.ok) throw new Error(`release notes read failed: HTTP ${response.status}`)
    const body = await response.json()
    if (typeof body !== 'object' || body === null) continue
    const record = /** @type {Record<string, unknown>} */ (body)
    const notes = typeof record.body === 'string' ? record.body.slice(0, NOTES_LIMIT_CHARS) : undefined
    if (notes === undefined || notes.trim() === '') continue
    return {
      notes,
      ...(typeof record.html_url === 'string' ? { url: record.html_url } : {}),
    }
  }
  return {}
}

/**
 * A cached notes reader: one entry per version, positive or negative, with a
 * wall-clock TTL. The confirm card opens repeatedly while a user hesitates;
 * without the cache every open would hit the GitHub API.
 * @param {{ fetchImpl?: typeof fetch; ttlMs?: number; now?: () => number }} [deps] - test seams.
 * @returns {(repo: string, version: string) => Promise<{ notes?: string; url?: string }>} the reader.
 */
export function createNotesReader(deps = {}) {
  const fetchImpl = deps.fetchImpl
  const ttlMs = deps.ttlMs ?? NOTES_CACHE_TTL_MS
  const now = deps.now ?? Date.now
  /** @type {Map<string, { at: number; value: { notes?: string; url?: string } }>} */
  const cache = new Map()
  return async (repo, version) => {
    const key = `${repo}@${version}`
    const hit = cache.get(key)
    if (hit !== undefined && now() - hit.at < ttlMs) return hit.value
    const value = await fetchReleaseNotes({
      repo,
      version,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    })
    cache.set(key, { at: now(), value })
    return value
  }
}

/**
 * Decide what the periodic auto-check should report. A pure ranking over the
 * facts the registry read produced, so the scheduler stays trivial and the
 * policy is testable without timers.
 * @param {{ installed?: string; distTags: Record<string, string>; versions: string[] }} facts - the same shape {@link buildView} takes.
 * @returns {{ latest?: string; updateAvailable: boolean }} the check verdict.
 */
export function evaluateAutoCheck(facts) {
  const latest = typeof facts.distTags.latest === 'string'
    ? facts.distTags.latest
    : facts.versions[0]
  return {
    ...(latest !== undefined ? { latest } : {}),
    updateAvailable: latest !== undefined && facts.installed !== undefined && compareVersions(latest, facts.installed) > 0,
  }
}

/**
 * Fetch the abbreviated packument of the dsh package.
 * @param {{ registry?: string; fetchImpl?: typeof fetch; timeoutMs?: number }} [deps] - test seams.
 * @returns {Promise<{ distTags: Record<string, string>; versions: string[] }>} published facts.
 */
export async function fetchPublished(deps = {}) {
  const registry = normalizeRegistry(deps.registry ?? DEFAULT_REGISTRY)
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
  /** @type {Record<string, string>} */
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

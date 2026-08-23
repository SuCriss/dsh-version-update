/**
 * Version-fact tests: the semver subset this plugin ranks, the install-target
 * predicate that guards the spawned argument, installation discovery, the
 * packument read, and the panel view assembled from all of it.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildView,
  compareVersions,
  createNotesReader,
  evaluateAutoCheck,
  fetchPublished,
  fetchReleaseNotes,
  isInstallableVersion,
  normalizeRegistry,
  parseVersion,
  readInstalled,
  readRepository,
  repositorySlug,
  resolveInstallationDir,
} from '../lib/core.js'

test('parseVersion accepts the published grammar and rejects the rest', () => {
  assert.deepEqual(parseVersion('1.2.3'), { core: [1, 2, 3], pre: [] })
  assert.deepEqual(parseVersion('0.1.0-rc.8'), { core: [0, 1, 0], pre: ['rc', '8'] })
  assert.deepEqual(parseVersion('  1.0.0  '), { core: [1, 0, 0], pre: [] })
  for (const bad of ['1.2', 'v1.2.3', '^1.2.3', '1.2.3+build', 'latest', '1.2.3-rc.8 && rm -rf /']) {
    assert.equal(parseVersion(bad), undefined, bad)
  }
})

test('compareVersions ranks releases above their own pre-releases', () => {
  assert.ok(compareVersions('0.1.0', '0.1.0-rc.8') > 0)
  assert.ok(compareVersions('0.1.0-rc.8', '0.1.0-rc.7') > 0)
  assert.ok(compareVersions('0.1.0-rc.10', '0.1.0-rc.9') > 0, 'numeric identifiers compare numerically')
  assert.ok(compareVersions('0.1.0-beta', '0.1.0-2') > 0, 'alphanumeric outranks numeric')
  assert.ok(compareVersions('0.1.0-rc.1.1', '0.1.0-rc.1') > 0, 'more identifiers outrank a prefix')
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0, 'components compare numerically, not lexically')
})

test('an unparsable version sorts below every parsable one', () => {
  // One malformed registry key must not be able to hide the rest of the list.
  assert.ok(compareVersions('garbage', '0.0.1') < 0)
  assert.ok(compareVersions('0.0.1', 'garbage') > 0)
  assert.equal(compareVersions('garbage', 'other garbage'), 0)
  const sorted = ['1.0.0', 'nonsense', '0.1.0-rc.8', '0.1.0'].sort((a, b) => compareVersions(b, a))
  assert.deepEqual(sorted, ['1.0.0', '0.1.0', '0.1.0-rc.8', 'nonsense'])
})

test('isInstallableVersion refuses ranges, tags, paths and metacharacters', () => {
  assert.equal(isInstallableVersion('0.1.0-rc.8'), true)
  for (const bad of [
    'latest', 'next', '^0.1.0', '~0.1.0', '>=0.1.0', '0.1.x', '*',
    '../evil', 'file:./evil', '0.1.0 && calc', '0.1.0;calc', '0.1.0|calc',
    '0.1.0`calc`', '0.1.0$(calc)', '', undefined, null, 42, {},
  ]) {
    assert.equal(isInstallableVersion(bad), false, String(bad))
  }
  assert.equal(isInstallableVersion(`0.1.0-${'a'.repeat(80)}`), false, 'over the length cap')
})

test('resolveInstallationDir prefers the running launcher over module resolution', () => {
  const dir = resolveInstallationDir({ argv: ['/usr/bin/node', '/opt/dsh/lib/bin.js'] })
  // A driveless absolute path picks up the current drive on Windows, so the
  // assertion is on the resolved tail rather than the whole string.
  assert.match(dir?.replaceAll('\\', '/') ?? '', /\/opt\/dsh$/)
})

test('resolveInstallationDir falls back to the global prefix probe', () => {
  const root = mkdtempSync(join(tmpdir(), 'vu-core-'))
  const pkgDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8')

  const dir = resolveInstallationDir({
    // Not a dsh launcher, and anchored where '@deepseek-ai/dsh' cannot resolve.
    argv: ['/usr/bin/node', '/somewhere/else/index.js'],
    anchor: join(root, 'anchor.js'),
    execPath: join(root, 'node'),
    env: {},
  })
  assert.equal(dir, pkgDir)
  assert.deepEqual(readInstalled(dir), { installed: '9.9.9', dir: pkgDir })
})

test('readInstalled reports the directory alone when the manifest is unusable', () => {
  assert.deepEqual(readInstalled(undefined), {})
  const root = mkdtempSync(join(tmpdir(), 'vu-core-'))
  assert.deepEqual(readInstalled(root), { dir: root }, 'no manifest at all')

  const broken = mkdtempSync(join(tmpdir(), 'vu-core-'))
  writeFileSync(join(broken, 'package.json'), '{ not json', 'utf8')
  assert.deepEqual(readInstalled(broken), { dir: broken }, 'malformed manifest')

  const bom = mkdtempSync(join(tmpdir(), 'vu-core-'))
  writeFileSync(join(bom, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
  assert.deepEqual(readInstalled(bom), { dir: bom }, 'manifest without a version')
})

test('normalizeRegistry accepts http(s) origins and strips trailing slashes', () => {
  assert.equal(normalizeRegistry('https://registry.npmjs.org'), 'https://registry.npmjs.org')
  assert.equal(normalizeRegistry('https://registry.npmjs.org/'), 'https://registry.npmjs.org')
  assert.equal(normalizeRegistry('https://npm.example.com/mirror///'), 'https://npm.example.com/mirror')
  assert.equal(normalizeRegistry('http://localhost:4873'), 'http://localhost:4873')
})

test('normalizeRegistry refuses anything that is not an absolute http(s) URL', () => {
  // The value reaches an `npm --registry` argument, so a non-URL — and above
  // all something that could read as another flag — must never get that far.
  for (const bad of [
    '', '   ', 'registry.npmjs.org', '//registry.npmjs.org', 'file:///etc/passwd',
    'ftp://mirror/', 'javascript:alert(1)', '--proxy=http://evil', 42, null, {},
  ]) {
    assert.throws(() => normalizeRegistry(bad), /registry must/, String(bad))
  }
})

test('fetchPublished refuses a registry that is not a usable URL', async () => {
  await assert.rejects(
    fetchPublished({ registry: 'not a url', fetchImpl: async () => { throw new Error('unreachable') } }),
    /registry must/,
  )
})

test('fetchPublished returns dist-tags and versions newest first', async () => {
  let seen
  const published = await fetchPublished({
    registry: 'https://registry.example/',
    fetchImpl: async (url, init) => {
      seen = { url, accept: init.headers.accept }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          'dist-tags': { latest: '0.1.0-rc.7', next: '0.1.0-rc.8', broken: 42 },
          versions: { '0.1.0-rc.7': {}, '0.1.0-rc.8': {}, '0.0.1-rc.1': {} },
        }),
      }
    },
  })
  assert.equal(seen.url, 'https://registry.example/@deepseek-ai%2Fdsh', 'the scope separator is encoded')
  assert.equal(seen.accept, 'application/vnd.npm.install-v1+json', 'the abbreviated packument is requested')
  assert.deepEqual(published.distTags, { latest: '0.1.0-rc.7', next: '0.1.0-rc.8' }, 'a non-string tag is dropped')
  assert.deepEqual(published.versions, ['0.1.0-rc.8', '0.1.0-rc.7', '0.0.1-rc.1'])
})

test('fetchPublished surfaces a failed or nonsense registry read', async () => {
  await assert.rejects(
    fetchPublished({ fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /HTTP 503/,
  )
  await assert.rejects(
    fetchPublished({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => null }) }),
    /not an object/,
  )
})

test('fetchPublished tolerates a packument missing either section', async () => {
  const published = await fetchPublished({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  })
  assert.deepEqual(published, { distTags: {}, versions: [] })
})

test('buildView marks only channels ahead of the installed version', () => {
  const view = buildView({
    installed: '0.1.0-rc.7',
    distTags: { latest: '0.1.0-rc.7', next: '0.1.0-rc.8' },
    versions: ['0.1.0-rc.8', '0.1.0-rc.7'],
  })
  assert.equal(view.installed, '0.1.0-rc.7')
  assert.deepEqual(view.channels, [
    { channel: 'next', version: '0.1.0-rc.8', ahead: true },
    { channel: 'latest', version: '0.1.0-rc.7', ahead: false },
  ], 'channels are ordered newest first')
})

test('buildView claims nothing is ahead when the installed version is unknown', () => {
  const view = buildView({ distTags: { latest: '9.9.9' }, versions: ['9.9.9'] })
  assert.equal('installed' in view, false)
  assert.deepEqual(view.channels, [{ channel: 'latest', version: '9.9.9', ahead: false }])
})

test('repositorySlug reads the manifest shapes npm actually carries', () => {
  // dsh's own shape: a monorepo object URL with git+ and .git decoration.
  assert.equal(repositorySlug({ type: 'git', url: 'git+https://github.com/deepseek-ai/deepseek-harness.git' }), 'deepseek-ai/deepseek-harness')
  assert.equal(repositorySlug('git+ssh://git@github.com:deepseek-ai/dsh.git'), 'deepseek-ai/dsh')
  assert.equal(repositorySlug('https://github.com/owner/repo'), 'owner/repo')
  assert.equal(repositorySlug('https://github.com/owner/repo/tree/main/packages/x#readme'), 'owner/repo')
  for (const bad of [undefined, null, 5, '', 'https://gitlab.com/o/r', { type: 'git' }]) {
    assert.equal(repositorySlug(bad), undefined, String(bad === '' ? '<empty>' : String(bad)))
  }
})

test('fetchReleaseNotes tries the dsh tag convention before the plain one', async () => {
  const seen = []
  const result = await fetchReleaseNotes({
    repo: 'deepseek-ai/deepseek-harness',
    version: '0.1.1-rc.2',
    tags: ['dsh-v0.1.1-rc.2', 'v0.1.1-rc.2'],
    fetchImpl: async (url) => {
      seen.push(url)
      if (!url.includes('dsh-v')) return { ok: false, status: 404 }
      return {
        ok: true,
        status: 200,
        json: async () => ({ body: '# notes', html_url: 'https://github.com/x/releases/tag/dsh-v0.1.1-rc.2' }),
      }
    },
  })
  assert.equal(seen.length, 1, 'the first candidate matching ends the walk')
  assert.equal(result.notes, '# notes')
  assert.equal(result.url, 'https://github.com/x/releases/tag/dsh-v0.1.1-rc.2')
})

test('a version without any release is an empty answer, not an error', async () => {
  const result = await fetchReleaseNotes({
    repo: 'o/r',
    version: '9.9.9',
    fetchImpl: async () => ({ ok: false, status: 404 }),
  })
  assert.deepEqual(result, {})
})

test('an upstream GitHub failure surfaces as a thrown error', async () => {
  await assert.rejects(
    () => fetchReleaseNotes({ repo: 'o/r', version: '1.0.0', fetchImpl: async () => ({ ok: false, status: 403 }) }),
    /HTTP 403/,
  )
})

test('createNotesReader caches both hits and misses per version', async () => {
  let now = 0
  let reads = 0
  const reader = createNotesReader({
    ttlMs: 1000,
    now: () => now,
    fetchImpl: async () => {
      reads += 1
      return { ok: true, status: 200, json: async () => ({ body: `body ${String(reads)}`, html_url: 'u' }) }
    },
  })
  assert.equal((await reader('o/r', '1.0.0')).notes, 'body 1')
  await reader('o/r', '2.0.0')
  assert.equal((await reader('o/r', '1.0.0')).notes, 'body 1', 'the cached body answers within the TTL')
  assert.equal(reads, 2)
  now = 2000
  assert.equal((await reader('o/r', '1.0.0')).notes, 'body 3', 'past the TTL the entry is re-read')
  assert.equal(reads, 3)
})

test('evaluateAutoCheck compares latest against installed and stays silent when uncomparable', () => {
  assert.deepEqual(evaluateAutoCheck({ installed: '0.1.0', distTags: { latest: '0.2.0' }, versions: ['0.2.0', '0.1.0'] }), { latest: '0.2.0', updateAvailable: true })
  assert.deepEqual(evaluateAutoCheck({ installed: '0.2.0', distTags: { latest: '0.2.0' }, versions: ['0.2.0'] }), { latest: '0.2.0', updateAvailable: false })
  // A host running a pre-release newer than latest is not "behind".
  assert.equal(evaluateAutoCheck({ installed: '0.3.0-rc.1', distTags: { latest: '0.2.0' }, versions: ['0.2.0'] }).updateAvailable, false)
  // No installed fact: no claim at all.
  assert.deepEqual(evaluateAutoCheck({ distTags: {}, versions: ['0.2.0'] }), { latest: '0.2.0', updateAvailable: false })
})

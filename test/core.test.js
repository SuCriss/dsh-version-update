/**
 * Core domain tests: the semver subset, the caret/tilde line grammar, target
 * resolution for every tracking kind, registry normalization, repository slug
 * extraction, and the panel view assembly.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildView,
  compareVersions,
  isInstallableVersion,
  matchesLine,
  normalizeRegistry,
  parseVersion,
  readInstalled,
  resolveInstallationDir,
  resolveTarget,
  repositorySlug,
  createNotesReader,
} from '../lib/core.js'

test('compareVersions orders releases and pre-releases by semver rules', () => {
  assert.ok(compareVersions('1.2.3', '1.2.4') < 0)
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0)
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  // A release outranks its own pre-releases.
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0)
  assert.ok(compareVersions('1.0.0-rc.2', '1.0.0-rc.10') < 0)
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0-alpha') > 0)
  // Unparsable values sink below everything.
  assert.ok(compareVersions('garbage', '0.0.1') < 0)
  assert.equal(compareVersions('garbage', 'also-bad'), 0)
})

test('isInstallableVersion accepts only exact published versions', () => {
  assert.equal(isInstallableVersion('0.4.0'), true)
  assert.equal(isInstallableVersion('0.4.0-rc.8'), true)
  for (const bad of ['latest', '^0.4.0', '>=0.4.0', 'file:../x', '0.4', '0.4.0 ', '', null, undefined, 42, `${'a'.repeat(65)}`]) {
    assert.equal(isInstallableVersion(bad), false, JSON.stringify(String(bad)))
  }
})

test('matchesLine implements caret and tilde over stable versions only', () => {
  // Caret above zero: whole major line.
  assert.equal(matchesLine('1.2.3', '^1.0.0'), true)
  assert.equal(matchesLine('1.9.9', '^1.5.0'), true)
  assert.equal(matchesLine('2.0.0', '^1.0.0'), false)
  // Caret at zero pins the minor.
  assert.equal(matchesLine('0.4.7', '^0.4.0'), true)
  assert.equal(matchesLine('0.4.7', '^0.3.0'), false)
  assert.equal(matchesLine('0.5.0', '^0.4.0'), false)
  // Tilde pins the minor at any major.
  assert.equal(matchesLine('1.4.9', '~1.4.0'), true)
  assert.equal(matchesLine('1.5.0', '~1.4.0'), false)
  // Pre-releases never satisfy a line.
  assert.equal(matchesLine('0.4.0-rc.1', '^0.4.0'), false)
  // Grammar violations match nothing.
  assert.equal(matchesLine('0.4.0', '0.4.x'), false)
})

test('matchesLine enforces the caret lower bound at every zero position', () => {
  // Below the anchored version never matches, whatever the line shape.
  assert.equal(matchesLine('1.1.0', '^1.5.0'), false, '1.1.0 < ^1.5.0')
  assert.equal(matchesLine('1.5.0', '^1.5.0'), true, 'the anchor itself is the inclusive lower bound')
  assert.equal(matchesLine('0.0.2', '^0.0.3'), false, '0.0.2 < ^0.0.3')
  assert.equal(matchesLine('0.0.3', '^0.0.3'), true)
  assert.equal(matchesLine('0.3.9', '^0.4.0'), false)
  assert.equal(matchesLine('1.5.2', '^1.5.3'), false)
  assert.equal(matchesLine('1.6.0', '^1.5.3'), true, 'higher minor can reset the patch')
  assert.equal(matchesLine('0.4.2', '^0.4.3'), false)
  assert.equal(matchesLine('0.4.3', '^0.4.3'), true)
  assert.equal(matchesLine('0.4.0', '~0.4.1'), false, 'tilde has the same lower bound')
  assert.equal(matchesLine('0.4.1', '~0.4.1'), true)
  assert.equal(matchesLine('1.2.2', '~1.2.3'), false)
})

test('matchesLine enforces the caret and tilde upper bounds at every zero position', () => {
  // ^x.y.z → [x.y.z, (x+1).0.0)
  assert.equal(matchesLine('1.9.9', '^1.5.0'), true)
  assert.equal(matchesLine('2.0.0', '^1.5.0'), false)
  // ^0.y.z → [0.y.z, 0.(y+1).0)
  assert.equal(matchesLine('0.4.99', '^0.4.0'), true)
  assert.equal(matchesLine('0.5.0', '^0.4.0'), false)
  // ^0.0.z → [0.0.z, 0.0.(z+1)) — only that exact stable patch.
  assert.equal(matchesLine('0.0.3', '^0.0.3'), true)
  assert.equal(matchesLine('0.0.4', '^0.0.3'), false, '0.0.4 > ^0.0.3')
  assert.equal(matchesLine('0.1.0', '^0.0.3'), false)
  assert.equal(matchesLine('0.0.0', '^0.0.0'), true)
  assert.equal(matchesLine('0.0.1', '^0.0.0'), false)
  // Tilde never crosses the minor: [x.y.z, x.(y+1).0)
  assert.equal(matchesLine('1.4.99', '~1.4.0'), true)
  assert.equal(matchesLine('1.5.0', '~1.4.0'), false)
  assert.equal(matchesLine('0.0.4', '~0.0.3'), true, 'tilde at 0.0 still spans the patch')
  assert.equal(matchesLine('0.1.0', '~0.0.3'), false)
})

test('resolveTarget resolves tags and lines; pins and unknown installs resolve to nothing', () => {
  const published = {
    distTags: { latest: '0.4.0', next: '0.5.0-rc.1' },
    versions: ['1.4.2', '1.0.0', '0.5.0-rc.1', '0.4.0', '0.3.9', '0.2.0'],
  }

  // Tag: newer than installed → target; equal → nothing.
  assert.deepEqual(resolveTarget({ kind: 'tag', tag: 'latest' }, '0.3.9', published), { target: '0.4.0' })
  assert.deepEqual(resolveTarget({ kind: 'tag', tag: 'latest' }, '0.4.0', published), {})
  assert.deepEqual(resolveTarget({ kind: 'tag', tag: 'next' }, '0.4.0', published), { target: '0.5.0-rc.1' })
  assert.deepEqual(resolveTarget({ kind: 'tag', tag: 'missing' }, '0.4.0', published), {})

  // Caret above zero: newest of the whole major line.
  assert.deepEqual(resolveTarget({ kind: 'line', range: '^1.0.0' }, '1.0.0', published), { target: '1.4.2' })
  // Caret at zero pins the minor: ^0.3.x tops out at 0.3.9.
  assert.deepEqual(resolveTarget({ kind: 'line', range: '^0.3.0' }, '0.2.0', published), { target: '0.3.9' })
  // Tilde pins the minor as well; pre-releases are never line targets.
  assert.deepEqual(resolveTarget({ kind: 'line', range: '~0.3.0' }, '0.3.0', published), { target: '0.3.9' })
  assert.deepEqual(resolveTarget({ kind: 'line', range: '^0.9.0' }, '0.4.0', published), {})
  assert.deepEqual(resolveTarget({ kind: 'line', range: '^0.2.0' }, '0.4.0', published), {}, 'installed already outside/at top of line')

  // Pin never targets. Unknown installed version never targets.
  assert.deepEqual(resolveTarget({ kind: 'pin' }, '0.1.0', published), {})
  assert.deepEqual(resolveTarget({ kind: 'tag', tag: 'latest' }, undefined, published), {})
})

test('normalizeRegistry demands absolute http(s) URLs and trims slashes', () => {
  assert.equal(normalizeRegistry('https://registry.npmjs.org/'), 'https://registry.npmjs.org')
  assert.equal(normalizeRegistry('http://localhost:4873///'), 'http://localhost:4873')
  assert.throws(() => normalizeRegistry('registry.npmjs.org'))
  assert.throws(() => normalizeRegistry('ftp://registry.npmjs.org'))
})

test('readInstalled reads a real manifest or degrades gracefully', async (t) => {
  assert.deepEqual(readInstalled(undefined), {})
  const missing = readInstalled('definitely/not/here')
  assert.equal(missing.installed, undefined)
  // A real temporary manifest round-trips.
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'vu-core-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }))
  assert.equal(readInstalled(dir).installed, '9.9.9')
  writeFileSync(join(dir, 'package.json'), '{broken')
  assert.equal(readInstalled(dir).installed, undefined)
})

test('repositorySlug accepts the manifest shapes npm actually carries', () => {
  assert.equal(repositorySlug({ type: 'git', url: 'git+https://github.com/SuCriss/dsh-version-update.git' }), 'SuCriss/dsh-version-update')
  assert.equal(repositorySlug('https://github.com/deepseek-ai/deepseek-harness.git#main'), 'deepseek-ai/deepseek-harness')
  assert.equal(repositorySlug('git@github.com:owner/repo.git'), 'owner/repo')
  assert.equal(repositorySlug('https://example.com/not/github'), undefined)
  assert.equal(repositorySlug(undefined), undefined)
})

test('buildView marks each channel ahead of installed and ranks them', () => {
  const view = buildView({
    installed: '0.3.0',
    distTags: { latest: '0.4.0', next: '0.5.0-rc.1' },
    versions: ['0.5.0-rc.1', '0.4.0', '0.3.0'],
  })
  assert.equal(view.installed, '0.3.0')
  assert.deepEqual(view.channels.map(c => c.channel), ['next', 'latest'])
  assert.deepEqual(view.channels.map(c => c.ahead), [true, true])

  const current = buildView({ installed: '0.4.0', distTags: { latest: '0.4.0' }, versions: ['0.4.0'] })
  assert.deepEqual(current.channels.map(c => c.ahead), [false])
})

test('parseVersion exposes comparable parts shared with the browser mirror', () => {
  assert.deepEqual(parseVersion('1.2.3'), { core: [1, 2, 3], pre: [] })
  assert.deepEqual(parseVersion('1.2.3-rc.1'), { core: [1, 2, 3], pre: ['rc', '1'] })
  assert.equal(parseVersion('nope'), undefined)
})

test('the notes reader caches per version, honours the TTL, and evicts least-recently-used', async () => {
  const clock = { at: 1000 }
  const fetches = []
  const reader = createNotesReader({
    fetchImpl: async () => {
      fetches.push(fetches.length + 1)
      return { ok: true, json: async () => ({ body: `notes-${fetches.length}`, html_url: 'https://x' }) }
    },
    ttlMs: 1000,
    maxEntries: 2,
    now: () => clock.at,
  })

  await reader('o/r', '1.0.0')
  await reader('o/r', '1.0.0')
  assert.equal(fetches.length, 1, 'a warm version is served from the cache')

  clock.at = 5000 // past the TTL
  await reader('o/r', '1.0.0')
  assert.equal(fetches.length, 2, 'an expired entry is refetched')
  assert.equal((await reader('o/r', '1.0.0')).notes, 'notes-2')

  await reader('o/r', '2.0.0') // cache: [1.0.0, 2.0.0]
  await reader('o/r', '3.0.0') // over the cap: the oldest (1.0.0) goes
  assert.equal(fetches.length, 4)

  await reader('o/r', '3.0.0')
  assert.equal(fetches.length, 4, 'the newest entries stay cached')

  await reader('o/r', '1.0.0') // was evicted
  await reader('o/r', '3.0.0')
  await reader('o/r', '2.0.0') // was evicted when 1.0.0 was re-read
  assert.equal(fetches.length, 6)
})

/** Lay out one fake global npm prefix under `root` and return the package dir. */
function fakeGlobalInstall(root) {
  const install = join(root, 'npm', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(install, { recursive: true })
  writeFileSync(join(install, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }))
  return install
}

test('the per-user npm prefix is found from USERPROFILE when APPDATA never arrived', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vu-core-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = join(root, 'profile')
  const install = fakeGlobalInstall(join(profile, 'AppData', 'Roaming'))

  // `argv` names no launcher, and the anchor sits in a tree with no
  // node_modules above it, so neither the launcher path nor module resolution
  // can answer — the global probe is the only thing left.
  const base = {
    argv: ['node', 'entry.js'],
    anchor: join(root, 'anchor.js'),
    execPath: join(root, 'node', 'bin', 'node'),
  }

  // The shape a shell that rebuilds the environment leaves behind: the
  // directory `%APPDATA%` points at survives under its own name, the variable
  // npm documents does not. Measured on this machine — `process.env.APPDATA`
  // is undefined from Git Bash while `USERPROFILE` is set.
  assert.equal(
    resolveInstallationDir({ ...base, env: { USERPROFILE: profile } }),
    install,
    'dropping APPDATA must not cost the plugin its own installation',
  )

  // APPDATA stays authoritative when it IS there: a redirected profile is a
  // real configuration, and the USERPROFILE-derived default would miss it.
  const redirected = fakeGlobalInstall(join(root, 'redirected'))
  assert.equal(
    resolveInstallationDir({ ...base, env: { APPDATA: join(root, 'redirected'), USERPROFILE: profile } }),
    redirected,
  )
})

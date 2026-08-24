/**
 * Core domain tests: the semver subset, the caret/tilde line grammar, target
 * resolution for every tracking kind, registry normalization, repository slug
 * extraction, and the panel view assembly.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildView,
  compareVersions,
  isInstallableVersion,
  matchesLine,
  normalizeRegistry,
  parseVersion,
  readInstalled,
  resolveTarget,
  repositorySlug,
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

/**
 * Update-lock tests: mutual exclusion, self-heal on stale holders, corrupt
 * lock handling, and post-install validation.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireUpdateLock, readLockHolder } from '../lib/updatelock.js'
import { verifyInstalled } from '../lib/updater.js'

/** One fresh lock path per test. */
function lockPath() {
  return join(mkdtempSync(join(tmpdir(), 'vu-lock-')), 'update.lock')
}

test('readLockHolder parses a well-formed holder and rejects junk', () => {
  assert.deepEqual(readLockHolder('{"pid":42,"at":100}'), { pid: 42, at: 100 })
  assert.equal(readLockHolder('not json'), undefined)
  assert.equal(readLockHolder('{"pid":"42","at":100}'), undefined)
  assert.equal(readLockHolder('{"pid":-1,"at":100}'), undefined)
  assert.equal(readLockHolder('{"pid":42,"at":"x"}'), undefined)
})

test('acquire → release → acquire again', () => {
  const path = lockPath()
  const first = acquireUpdateLock({ lockPath: path, pid: 1 })
  assert.equal(first.ok, true)
  first.release()
  const second = acquireUpdateLock({ lockPath: path, pid: 2 })
  assert.equal(second.ok, true, 'a released lock is acquirable')
  second.release()
  assert.throws(() => readFileSync(path, 'utf8'), { code: 'ENOENT' }, 'release removes the file')
})

test('a live foreign holder refuses the acquisition', () => {
  const path = lockPath()
  writeFileSync(path, JSON.stringify({ pid: 999999, at: Date.now() }), 'utf8')
  const result = acquireUpdateLock({ lockPath: path, pid: 1, isAlive: (pid) => pid === 999999 })
  assert.equal(result.ok, false)
  assert.equal(result.holder?.pid, 999999)
  result.release() // safe no-op — must not delete someone else's lock
  assert.ok(readLockHolder(readFileSync(path, 'utf8')), "release on refusal leaves the holder's lock")
})

test('a dead holder is stolen', () => {
  const path = lockPath()
  writeFileSync(path, JSON.stringify({ pid: 999999, at: Date.now() }), 'utf8')
  const result = acquireUpdateLock({ lockPath: path, pid: 1, isAlive: () => false })
  assert.equal(result.ok, true, 'dead holder → lock stolen')
  result.release()
})

test('a wedged holder older than the max age is stolen', () => {
  const path = lockPath()
  writeFileSync(path, JSON.stringify({ pid: 999999, at: Date.now() - 2 * 60 * 60 * 1000 }), 'utf8')
  const result = acquireUpdateLock({ lockPath: path, pid: 1, isAlive: () => true, maxAgeMs: 60 * 60 * 1000 })
  assert.equal(result.ok, true, 'wedged holder → lock stolen')
  result.release()
})

test('a corrupt lock file is stolen, not honored forever', () => {
  const path = lockPath()
  writeFileSync(path, 'garbage{{{', 'utf8')
  const result = acquireUpdateLock({ lockPath: path, pid: 1, isAlive: () => true })
  assert.equal(result.ok, true, 'unreadable lock must never block updates')
  result.release()
})

test('own pid in the lock is stolen (a crashed self-heal)', () => {
  const path = lockPath()
  writeFileSync(path, JSON.stringify({ pid: 77, at: Date.now() }), 'utf8')
  const result = acquireUpdateLock({ lockPath: path, pid: 77, isAlive: () => true })
  assert.equal(result.ok, true)
  result.release()
})

test('a stolen lock survives the release of the holder it was stolen from', () => {
  const path = lockPath()
  const first = acquireUpdateLock({ lockPath: path, pid: 42 })
  assert.equal(first.ok, true)
  // The exact updater scenario: a fiber reload leaves the previous run's lock
  // in place, the replacement steals it (own pid), and the orphan then settles.
  const second = acquireUpdateLock({ lockPath: path, pid: 42 })
  assert.equal(second.ok, true, 'a same-pid self-heal steal must succeed')
  first.release()
  assert.ok(readLockHolder(readFileSync(path, 'utf8')), 'the orphan release left the live lock alone')
  // A foreign takeover is refused the same way.
  writeFileSync(path, JSON.stringify({ pid: 43, at: Date.now(), token: 'foreign' }), 'utf8')
  second.release()
  assert.equal(readLockHolder(readFileSync(path, 'utf8'))?.pid, 43, 'never removes another host\'s lock')
})

test('each acquisition writes a record only its own release can remove', () => {
  const path = lockPath()
  const first = acquireUpdateLock({ lockPath: path, pid: 5, now: () => 1000 })
  const record = readFileSync(path, 'utf8')
  assert.ok(JSON.parse(record).token, 'the record carries an ownership token')
  assert.deepEqual(readLockHolder(record), { pid: 5, at: 1000 }, 'the holder view stays the same shape')
  first.release()
  const second = acquireUpdateLock({ lockPath: path, pid: 5, now: () => 1000 })
  assert.notEqual(readFileSync(path, 'utf8'), record, 'a repeated acquisition is a NEW record')
  second.release()
  assert.throws(() => readFileSync(path, 'utf8'), { code: 'ENOENT' })
})

test('a lock left unreadable is not "released" into someone else\'s file', () => {
  const path = lockPath()
  const holder = acquireUpdateLock({ lockPath: path, pid: 9 })
  // Torn write: the file exists but names nothing.
  writeFileSync(path, '{{{', 'utf8')
  holder.release()
  assert.equal(readFileSync(path, 'utf8'), '{{{', 'a release must not guess its way into deleting it')
  // And an acquisition still treats it as stale rather than honoring it.
  const next = acquireUpdateLock({ lockPath: path, pid: 10, isAlive: () => true })
  assert.equal(next.ok, true)
  next.release()
})

test('verifyInstalled accepts a matching tree and rejects mismatches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vu-verify-'))
  try {
    // Missing manifest.
    let verdict = verifyInstalled({ installDir: dir, version: '1.2.3' })
    assert.equal(verdict.ok, false)
    assert.match(verdict.problem, /package.json unreadable/)

    // Wrong version.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }), 'utf8')
    verdict = verifyInstalled({ installDir: dir, version: '1.2.3' })
    assert.equal(verdict.ok, false)
    assert.match(verdict.problem, /1\.0\.0/)

    // Right version but no launcher.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }), 'utf8')
    verdict = verifyInstalled({ installDir: dir, version: '1.2.3' })
    assert.equal(verdict.ok, false)
    assert.match(verdict.problem, /launcher/)

    // Complete tree.
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'bin.js'), '#!/usr/bin/env node\n', 'utf8')
    verdict = verifyInstalled({ installDir: dir, version: '1.2.3' })
    assert.deepEqual(verdict, { ok: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

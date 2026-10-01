/**
 * Update-lock tests: mutual exclusion, self-heal on stale holders, corrupt
 * lock handling, and post-install validation.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

test('a same-pid active lock is not reentrant and a refused release preserves it', () => {
  const path = lockPath()
  const first = acquireUpdateLock({ lockPath: path })
  const record = readFileSync(path, 'utf8')
  const result = acquireUpdateLock({ lockPath: path })
  assert.equal(result.ok, false)
  assert.equal(result.holder.pid, process.pid)
  result.release()
  assert.equal(readFileSync(path, 'utf8'), record)
  first.release()
  const next = acquireUpdateLock({ lockPath: path })
  assert.equal(next.ok, true)
  next.release()
})

test('a stolen lock survives the release of the holder it was stolen from', () => {
  const path = lockPath()
  const first = acquireUpdateLock({ lockPath: path, pid: 42, now: () => 1000 })
  assert.equal(first.ok, true)
  // A genuinely expired holder may be replaced, but its late release must not
  // remove the new owner's record (same PID does not establish ownership).
  const second = acquireUpdateLock({ lockPath: path, pid: 42, now: () => 3000, maxAgeMs: 1000, isAlive: () => true })
  assert.equal(second.ok, true, 'an expired lock may be stolen')
  first.release()
  assert.ok(readLockHolder(readFileSync(path, 'utf8')), 'the orphan release left the live lock alone')
  // A foreign takeover is refused the same way.
  writeFileSync(path, JSON.stringify({ pid: 43, at: Date.now(), token: 'foreign' }), 'utf8')
  second.release()
  assert.equal(readLockHolder(readFileSync(path, 'utf8'))?.pid, 43, 'never removes another host\'s lock')
})

test('a steal removes only the record it judged stale, never one that replaced it', () => {
  const path = lockPath()
  // A genuinely stale record: a dead pid, well past the ceiling.
  writeFileSync(path, JSON.stringify({ pid: 999999, at: 0, token: 'stale' }), 'utf8')
  let swapped = false
  const result = acquireUpdateLock({
    lockPath: path,
    pid: 1,
    now: () => 2 * 60 * 60 * 1000,
    maxAgeMs: 60 * 1000,
    // The interleaving two waiters produce: between the staleness judgement and
    // the removal, the first waiter replaces the stale record with its own live
    // one. A bare `rmSync` deletes that new lock — and BOTH hosts then install
    // into the same global tree.
    isAlive: () => {
      if (!swapped) {
        swapped = true
        writeFileSync(path, JSON.stringify({ pid: process.pid, at: 2 * 60 * 60 * 1000, token: 'fresh' }), 'utf8')
      }
      return false
    },
  })
  assert.equal(swapped, true, 'the seam really ran on the staleness path')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'fresh', 'the live record that replaced the stale one survives')
  assert.equal(result.ok, false, 'and the acquisition refuses rather than take a lock somebody holds')
  assert.equal(result.holder?.pid, process.pid, 'the refusal names the holder it actually found')
})

test('an acquisition publishes a complete record and leaves no working file behind', () => {
  const path = lockPath()
  const first = acquireUpdateLock({ lockPath: path, pid: 7, now: () => 1000 })
  assert.equal(first.ok, true)
  // The record is published by hard-linking an already-written temp file into
  // place, so the lock path is never observable as an EMPTY file — and an empty
  // lock is what every reader treats as corrupt and steals.
  const record = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(record.pid, 7)
  assert.ok(record.token, 'the record is complete from the moment the path exists')
  // The temp file it was linked from is gone with it: the lock directory holds
  // the lock and nothing else.
  assert.deepEqual(readdirSync(dirname(path)), ['update.lock'])
  first.release()
  assert.throws(() => readFileSync(path, 'utf8'), { code: 'ENOENT' })
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

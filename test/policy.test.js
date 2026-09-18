/**
 * Policy store tests: tolerant reads, atomic-enough writes, and per-field
 * repair of a hand-edited file.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_POLICY } from '../lib/protocol.js'
import { defaultPolicyPath, loadPolicy, savePolicy } from '../lib/policy.js'

/** One temp home per test. */
function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'vu-policy-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

/** A policy path whose dot-directory already exists (for raw seeded files). */
function seededPolicyPath(t) {
  const home = tempHome(t)
  const path = defaultPolicyPath({ home })
  mkdirSync(join(path, '..'), { recursive: true })
  return path
}

test('defaultPolicyPath lives under the given home', () => {
  assert.equal(defaultPolicyPath({ home: '/home/x' }), join('/home/x', '.dsh-version-update', 'policy.json'))
})

test('a missing policy file yields the default policy and creates nothing', (t) => {
  const home = tempHome(t)
  assert.deepEqual(loadPolicy(defaultPolicyPath({ home })), DEFAULT_POLICY)
})

test('save then load round-trips the exact policy', (t) => {
  const home = tempHome(t)
  const path = defaultPolicyPath({ home })
  const policy = {
    mode: 'auto',
    track: { kind: 'line', range: '~0.4.0' },
    window: { start: '22:00', end: '06:00' },
    checkAt: '04:30',
  }
  savePolicy(path, policy)
  assert.deepEqual(loadPolicy(path), policy)
})

test('a `restart` key written by an older version is ignored, not repaired into the shape', (t) => {
  // The field used to select between "ask me" and "restart unattended". It is
  // not a policy any more — restarting is always the panel's button — so an
  // upgraded install must load its own file without the key and without an
  // error, and the value must never come back out.
  const path = seededPolicyPath(t)
  writeFileSync(path, JSON.stringify({
    mode: 'auto',
    track: { kind: 'tag', tag: 'next' },
    window: null,
    restart: 'auto',
    checkAt: null,
  }))
  const loaded = loadPolicy(path)
  assert.equal(Object.hasOwn(loaded, 'restart'), false)
  assert.deepEqual(loaded, { mode: 'auto', track: { kind: 'tag', tag: 'next' }, window: null, checkAt: null })
})

test('a corrupted file degrades to defaults instead of throwing', (t) => {
  const path = seededPolicyPath(t)
  writeFileSync(path, '{ not json')
  assert.deepEqual(loadPolicy(path), DEFAULT_POLICY)
})

test('damaged fields fall back individually; healthy ones survive the repair', (t) => {
  const path = seededPolicyPath(t)
  writeFileSync(path, JSON.stringify({
    mode: 'notify',
    track: { kind: 'tag', tag: 'next' },
    window: { start: 'oops' },
    checkAt: '05:15',
  }))
  const loaded = loadPolicy(path)
  assert.equal(loaded.mode, 'notify')
  assert.deepEqual(loaded.track, { kind: 'tag', tag: 'next' })
  assert.equal(loaded.window, null)
  assert.equal(loaded.checkAt, '05:15')
})

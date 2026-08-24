/**
 * History tests: tolerant loading (including entries from the previous plugin
 * generation), capped appends, and the panel summary shape.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendHistory, defaultHistoryPath, loadHistory, summarizeHistory } from '../lib/history.js'

function tempPath(t) {
  const home = mkdtempSync(join(tmpdir(), 'vu-hist-'))
  const path = defaultHistoryPath({ home })
  // The seeded files below need the dot-directory to exist already;
  // appendHistory creates it on its own, raw writes do not.
  mkdirSync(join(path, '..'), { recursive: true })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return path
}

test('defaultHistoryPath lives under the given home', () => {
  assert.equal(defaultHistoryPath({ home: '/h' }), join('/h', '.dsh-version-update', 'history.json'))
})

test('append then load round-trips entries with triggers', (t) => {
  const path = tempPath(t)
  appendHistory(path, { at: 1, from: '0.1.0', to: '0.2.0', result: 'ok', trigger: 'manual' })
  appendHistory(path, { at: 2, to: '0.1.0', result: 'ok', restored: true })
  const entries = loadHistory(path)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], { at: 1, from: '0.1.0', to: '0.2.0', result: 'ok', trigger: 'manual' })
  assert.equal(entries[1].restored, true)
})

test('legacy entries without a trigger stay valid; junk is dropped', (t) => {
  const path = tempPath(t)
  writeFileSync(path, JSON.stringify([
    { at: 1, from: '0.1.0', to: '0.2.0', result: 'ok' },
    { at: 2, to: '0.3.0', result: 'ok', trigger: 'auto' },
    { nonsense: true },
    { at: 'nope', to: 'x', result: 'ok' },
    { at: 3, to: 'x', result: 'meh' },
    'a string',
    null,
  ]))
  const entries = loadHistory(path)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].trigger, undefined)
  assert.equal(entries[1].trigger, 'auto')
})

test('the file caps at HISTORY_MAX entries, oldest dropped first', async (t) => {
  const { HISTORY_MAX } = await import('../lib/history.js')
  const path = tempPath(t)
  for (let index = 0; index < HISTORY_MAX + 5; index += 1) {
    appendHistory(path, { at: index, to: `0.0.${index}`, result: 'ok' })
  }
  const entries = loadHistory(path)
  assert.equal(entries.length, HISTORY_MAX)
  assert.equal(entries[0].at, 5)
  assert.equal(entries.at(-1)?.at, HISTORY_MAX + 4)
})

test('summarizeHistory returns the newest entries first', () => {
  const summary = summarizeHistory([
    { at: 1, from: '0.1.0', to: '0.2.0', result: 'ok' },
    { at: 2, to: '0.3.0', result: 'failed', trigger: 'auto' },
    { at: 3, to: '0.2.0', result: 'ok', restored: true },
  ])
  assert.deepEqual(summary.recent.map(entry => entry.at), [3, 2, 1])
})

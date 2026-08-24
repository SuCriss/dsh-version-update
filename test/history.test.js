/**
 * Install-history tests: the on-disk record every settled install appends,
 * its cap, and the rollback target derived from it — including the cases
 * where the derivation must stay silent because a stale target would
 * downgrade past the user's actual history.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { HISTORY_MAX, appendHistory, defaultHistoryPath, loadHistory, summarizeHistory } from '../lib/history.js'

/** A fresh history file in a throwaway directory. */
function file(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vu-history-'))
  const path = join(dir, 'history.json')
  t.after(() => { /* the temp directory outlives the process harmlessly */ })
  return path
}

test('an absent or corrupt history reads as empty', (t) => {
  const missing = join(tmpdir(), `vu-history-${String(Math.random())}`, 'history.json')
  assert.deepEqual(loadHistory(missing), [])

  const corrupt = file(t)
  writeFileSync(corrupt, '{not json', 'utf8')
  assert.deepEqual(loadHistory(corrupt), [])
})

test('entries append oldest first and the file caps itself', (t) => {
  const path = file(t)
  for (let index = 0; index < HISTORY_MAX + 10; index += 1) {
    appendHistory(path, { at: index, from: '0.1.0', to: '0.2.0', result: 'ok' })
  }
  const entries = loadHistory(path)
  assert.equal(entries.length, HISTORY_MAX)
  assert.equal(entries[0].at, 10, 'the oldest entries were dropped')
  // The written form parses back to what loadHistory returns.
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), entries)
})

test('the rollback target is the origin of the install that produced the current version', () => {
  const entries = [
    { at: 1, from: '0.1.0', to: '0.2.0', result: 'ok' },
    { at: 2, from: '0.2.0', to: '0.3.0', result: 'ok' },
  ]
  const view = summarizeHistory(entries, '0.3.0')
  assert.equal(view.rollbackTarget, '0.2.0')
  assert.equal(view.recent.length, 2)
})

test('no target is offered when another update has since superseded it', () => {
  // The last success produced 0.3.0; offering 0.1.0 for a host now on 0.4.0
  // would skip over real history.
  const entries = [{ at: 1, from: '0.1.0', to: '0.3.0', result: 'ok' }]
  assert.equal(summarizeHistory(entries, '0.4.0').rollbackTarget, undefined)
})

test('a failed install never anchors the rollback offer', () => {
  // The failed run left no trustworthy "before"; the success before it does
  // not match the on-disk version either, so there is nothing safe to offer.
  const entries = [
    { at: 1, from: '0.1.0', to: '0.2.0', result: 'ok' },
    { at: 2, from: '0.2.0', to: '0.3.0', result: 'failed' },
  ]
  const view = summarizeHistory(entries, '0.3.0')
  assert.equal(view.rollbackTarget, undefined, 'the failure may have left anything on disk')
})

test('an unknown installed version offers nothing', () => {
  const entries = [{ at: 1, from: '0.1.0', to: '0.2.0', result: 'ok' }]
  assert.equal(summarizeHistory(entries, undefined).rollbackTarget, undefined)
})

test('the default location lives outside the package that updates replace', () => {
  // Any install-scoped path would be wiped by the very update being recorded.
  const home = join('home', 'user')
  assert.match(defaultHistoryPath({ home }), /^home[/\\]user[/\\]\.dsh-version-update[/\\]history\.json$/)
})

/**
 * Protocol tests: the wire and policy contract every other half of the plugin
 * mirrors. The pure decision helpers (time windows, the next occurrence of a
 * check time) and the per-field policy normalization are pinned here, field by
 * field, because the browser half and the persisted policy file both depend on
 * the exact fallback semantics.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_POLICY,
  POLICY_MODES,
  VERSION_API,
  inWindow,
  nextOccurrence,
  normalizePolicy,
  parseTimeOfDay,
  releaseTagCandidates,
  repairPolicy,
} from '../lib/protocol.js'

test('parseTimeOfDay accepts zero-padded HH:MM and nothing else', () => {
  assert.equal(parseTimeOfDay('00:00'), 0)
  assert.equal(parseTimeOfDay('04:30'), 4 * 60 + 30)
  assert.equal(parseTimeOfDay('23:59'), 23 * 60 + 59)
  for (const junk of ['', '4:30', '24:00', '12:60', '12:5', 'ab:cd', ' 12:30', null, undefined, 420]) {
    assert.equal(parseTimeOfDay(junk), undefined, JSON.stringify(junk))
  }
})

test('inWindow is half-open and supports whole-day and cross-midnight windows', () => {
  const window = { start: '22:00', end: '06:00' }
  assert.equal(inWindow(21 * 60 + 59, window), false)
  assert.equal(inWindow(22 * 60, window), true)
  assert.equal(inWindow(23 * 60 + 59, window), true)
  assert.equal(inWindow(0, window), true)
  assert.equal(inWindow(5 * 60 + 59, window), true)
  assert.equal(inWindow(6 * 60, window), false, 'the end is exclusive')

  const morning = { start: '04:00', end: '05:00' }
  assert.equal(inWindow(4 * 60, morning), true)
  assert.equal(inWindow(5 * 60, morning), false)
  assert.equal(inWindow(12 * 60, morning), false)

  // start === end means the whole day.
  assert.equal(inWindow(0, { start: '08:00', end: '08:00' }), true)
  assert.equal(inWindow(23 * 60 + 59, { start: '08:00', end: '08:00' }), true)

  // An unparsable window admits nothing.
  assert.equal(inWindow(600, { start: 'oops', end: '05:00' }), false)
})

test('nextOccurrence returns today when the time has not passed, tomorrow when it has', () => {
  const morning = nextOccurrence('04:30', new Date('2026-03-01T03:00:00'))
  assert.equal(morning?.getDate(), 1)
  assert.equal(morning?.getHours(), 4)
  assert.equal(morning?.getMinutes(), 30)

  const evening = nextOccurrence('04:30', new Date('2026-03-01T04:30:00'))
  assert.equal(evening?.getDate(), 2, 'the same moment counts as passed')

  const next = nextOccurrence('04:30', new Date('2026-03-01T23:59:00'))
  assert.equal(next?.getDate(), 2)

  assert.equal(nextOccurrence('not-a-time', new Date('2026-03-01T12:00:00')), undefined)
})

test('normalizePolicy patches: absent fields keep the base policy', () => {
  const base = { ...DEFAULT_POLICY, mode: 'auto', window: { start: '22:00', end: '06:00' } }
  const outcome = normalizePolicy({ restart: 'auto' }, base)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.value, {
    mode: 'auto',
    track: DEFAULT_POLICY.track,
    window: { start: '22:00', end: '06:00' },
    restart: 'auto',
    checkAt: null,
  })
})

test('normalizePolicy rejects each field by name and keeps the base value', () => {
  const base = { ...DEFAULT_POLICY, mode: 'auto' }
  const rejects = [
    { mode: 'sometimes' },
    { track: { kind: 'nope' } },
    { track: { kind: 'tag', tag: '' } },
    { track: { kind: 'tag', tag: 'has space' } },
    { track: { kind: 'line', range: '>=1.0.0' } },
    { track: { kind: 'line', range: '^1.0' } },
    { track: 'pin' },
    { window: { start: '25:00', end: '06:00' } },
    { window: { start: '04:00' } },
    { window: '04:00-05:00' },
    { restart: 'maybe' },
    { checkAt: '4pm' },
    { checkAt: 420 },
  ]
  for (const submission of rejects) {
    const outcome = normalizePolicy(submission, base)
    assert.equal(outcome.ok, false, JSON.stringify(submission))
    assert.ok(outcome.issues.length > 0, 'the rejection names itself')
    // Every field group keeps its base value, so the submission can never
    // blank out the fields it did not touch.
    assert.deepEqual(outcome.value, base, JSON.stringify(submission))
  }
})

test('normalizePolicy falls back to the base mode like every other field group', () => {
  // mode used to be the one field group that left the normalized value with
  // `mode: undefined` instead of the base value.
  const base = { ...DEFAULT_POLICY, mode: 'auto' }
  const outcome = normalizePolicy({ mode: 'sometimes' }, base)
  assert.equal(outcome.ok, false)
  assert.deepEqual(outcome.issues, ['mode must be one of off, notify, auto'])
  assert.equal(outcome.value.mode, 'auto', 'a rejected mode keeps the base mode')
  assert.deepEqual(outcome.value, base)
})

test('normalizePolicy ignores unknown keys and normalizes the whole shape', () => {
  const outcome = normalizePolicy({
    mode: 'notify',
    track: { kind: 'pin' },
    window: null,
    restart: 'ask',
    checkAt: null,
    // Unknown keys are forward-compatible: a hand-edited file may carry them.
    nextCheckHint: 'soon',
    somethingElse: true,
  })
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.value, { mode: 'notify', track: { kind: 'pin' }, window: null, restart: 'ask', checkAt: null })
})

test('normalizePolicy accepts every kind of tracking rule', () => {
  const kinds = [
    { track: { kind: 'tag', tag: 'latest' } },
    { track: { kind: 'tag', tag: 'beta-rc' } },
    { track: { kind: 'line', range: '^1.2.3' } },
    { track: { kind: 'line', range: '~0.4.0' } },
    { track: { kind: 'pin' } },
  ]
  for (const submission of kinds) {
    const outcome = normalizePolicy(submission)
    assert.equal(outcome.ok, true, JSON.stringify(submission))
    assert.deepEqual(outcome.value.track, submission.track)
  }
})

test('repairPolicy always yields a usable policy, field by field', () => {
  const repaired = repairPolicy({
    mode: 'wat',
    track: { kind: 'tag', tag: 'has space' },
    window: { start: 'nope' },
    restart: 'maybe',
    checkAt: 'not-a-time',
    legacy: true,
  })
  assert.deepEqual(repaired, DEFAULT_POLICY)
  assert.equal(POLICY_MODES.includes(repaired.mode), true)
})

test('the wire contract: route paths, release tag candidates, the frozen default', () => {
  for (const path of Object.values(VERSION_API)) {
    assert.match(path, /^\/api\/dsh-version-update\//)
  }
  assert.deepEqual(releaseTagCandidates('1.2.3'), ['dsh-v1.2.3', 'v1.2.3'])
  assert.deepEqual(DEFAULT_POLICY, { mode: 'off', track: { kind: 'tag', tag: 'latest' }, window: null, restart: 'ask', checkAt: null })
})

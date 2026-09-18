/** Bounded polling progress, independent of filesystem and operation runners. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOperationLog } from '../lib/opevents.js'

test('lifecycle events share an id and globally monotonic sequence', () => {
  const log = createOperationLog()
  assert.deepEqual(log.view(), { events: [], cursor: 0 })
  const restore = log.begin('restore', { data: { version: '0.4.0' } })
  const repair = log.begin('repair')
  log.event(restore, 'copying', { files: 4 })
  log.end(repair, { ok: false, error: 'read-only' })
  log.end(restore, { ok: true })
  const { events, cursor } = log.view()
  assert.equal(cursor, 5)
  assert.deepEqual(events.map(entry => entry.seq), [1, 2, 3, 4, 5])
  assert.deepEqual(events.map(entry => entry.id), [restore, repair, restore, repair, restore])
  assert.deepEqual(events.map(entry => entry.phase), ['running', 'running', 'running', 'failed', 'done'])
  assert.equal(events[3].error, 'read-only')
  assert.ok(events.every(entry => Number.isFinite(entry.at)))
  assert.deepEqual(log.list(3), { events: events.slice(3), cursor: 5 })
  assert.deepEqual(log.list(5), { events: [], cursor: 5 })
})

test('ring eviction retains the tail without resetting sequences or active identities', () => {
  const log = createOperationLog({ limit: 2 })
  const id = log.begin('restore')
  log.event(id, 'one')
  log.event(id, 'two')
  log.end(id, { ok: true })
  assert.deepEqual(log.view().events.map(entry => entry.seq), [3, 4])
  assert.equal(log.view().events[1].phase, 'done')
  assert.equal(log.list(1).cursor, 4)
  log.end(id, { ok: false })
  log.event(id, 'late message')
  log.end(999, { ok: true })
  assert.equal(log.view().cursor, 4, 'ended and unknown operations are ignored')
})

test('default ring caps at 200 and invalid limits use that default', () => {
  for (const options of [{}, { limit: 0 }, { limit: -1 }, { limit: NaN }, { limit: 1.5 }]) {
    const log = createOperationLog(options)
    for (let i = 0; i < 205; i += 1) log.settle('install', { ok: true })
    assert.equal(log.view().events.length, 200)
    assert.equal(log.view().events[0].seq, 6)
    assert.equal(log.view().cursor, 205)
  }
})

test('settlement-only installs do not invent a start and payloads are isolated', () => {
  const log = createOperationLog()
  const data = { version: '0.5.0', nested: { trigger: 'manual' } }
  const id = log.settle('install', { ok: false, error: 'npm failed', data })
  data.nested.trigger = 'auto'
  const first = log.view()
  assert.equal(first.events.length, 1)
  assert.equal(first.events[0].id, id)
  assert.equal(first.events[0].phase, 'failed')
  assert.equal(first.events[0].data.nested.trigger, 'manual')
  first.events[0].data.nested.trigger = 'changed'
  first.events.pop()
  assert.equal(log.view().events[0].data.nested.trigger, 'manual')
})

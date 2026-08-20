/**
 * Update-runner tests: the single-slot install task, the shell-free npm spawn,
 * the exact-version guard on the spawned argument, output capture, and
 * settlement.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { createUpdater, resolveNpmCli } from '../lib/updater.js'

/** A stand-in child process whose streams the runner can subscribe to. */
class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.stdout.setEncoding = () => {}
    this.stderr.setEncoding = () => {}
    this.killed = false
  }

  kill() {
    this.killed = true
  }
}

/**
 * Build a runner over a fake spawn, recording every invocation.
 *
 * A started task holds the install-timeout timer, which keeps the event loop
 * alive for the full ceiling, so every runner is disposed when its test ends.
 * @param {import('node:test').TestContext} t - the test context, for cleanup.
 * @param {{ timeoutMs?: number }} [options] - runner options.
 * @returns {{ updater: object; calls: object[]; children: FakeChild[] }} the harness.
 */
function harness(t, options = {}) {
  const calls = []
  const children = []
  const updater = createUpdater({
    npmCli: '/fake/npm-cli.js',
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    spawnImpl: (command, args, spawnOptions) => {
      calls.push({ command, args, options: spawnOptions })
      const child = new FakeChild()
      children.push(child)
      return child
    },
  })
  t.after(() => { updater.dispose() })
  return { updater, calls, children }
}

test('a fresh runner is idle with an empty log', (t) => {
  const { updater } = harness(t)
  assert.deepEqual(updater.view(), { state: 'idle', log: '' })
})

test('start spawns node against npm-cli.js with no shell', (t) => {
  const { updater, calls } = harness(t)
  updater.start('0.1.0-rc.8')

  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.command, process.execPath, 'npm runs as a plain node script')
  assert.deepEqual(call.args, [
    '/fake/npm-cli.js', 'install', '-g', '@deepseek-ai/dsh@0.1.0-rc.8', '--no-fund', '--no-audit',
  ])
  assert.equal(call.options.shell, false, 'no shell may interpret the version argument')
  assert.equal(call.options.windowsHide, true)
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'])

  const view = updater.view()
  assert.equal(view.state, 'running')
  assert.equal(view.version, '0.1.0-rc.8')
  assert.match(view.log, /^\$ npm install -g @deepseek-ai\/dsh@0\.1\.0-rc\.8\n/)
  assert.equal(typeof view.startedAt, 'number')
})

test('start refuses anything but one exact published version', (t) => {
  const { updater, calls } = harness(t)
  for (const bad of ['latest', '^0.1.0', '0.1.x', '0.1.0 && calc', '', undefined]) {
    assert.throws(() => updater.start(bad), /not one exact published version/, String(bad))
  }
  assert.equal(calls.length, 0, 'nothing was spawned')
  assert.equal(updater.view().state, 'idle')
})

test('a malformed target is rejected even while a task runs', (t) => {
  // The validation order matters: the caller should hear what is wrong with
  // their argument, not what else happens to be running.
  const { updater } = harness(t)
  updater.start('0.1.0')
  assert.throws(() => updater.start('latest'), /not one exact published version/)
})

test('only one install runs at a time', (t) => {
  const { updater, calls } = harness(t)
  updater.start('0.1.0')
  assert.throws(() => updater.start('0.2.0'), /already running/)
  assert.equal(calls.length, 1)
})

test('a settled task can be started again', (t) => {
  const { updater, calls, children } = harness(t)
  updater.start('0.1.0')
  children[0].emit('close', 0)
  assert.equal(updater.view().state, 'done')
  updater.start('0.2.0')
  assert.equal(calls.length, 2)
  assert.equal(updater.view().state, 'running')
})

test('stdout and stderr are both captured', (t) => {
  const { updater, children } = harness(t)
  updater.start('0.1.0')
  children[0].stdout.emit('data', 'added 1 package\n')
  children[0].stderr.emit('data', 'npm warn deprecated\n')
  const { log } = updater.view()
  assert.match(log, /added 1 package/)
  assert.match(log, /npm warn deprecated/)
})

test('the log keeps its tail rather than growing without bound', (t) => {
  const { updater, children } = harness(t)
  updater.start('0.1.0')
  children[0].stdout.emit('data', 'x'.repeat(200 * 1024))
  children[0].stdout.emit('data', 'THE-END')
  const { log } = updater.view()
  assert.ok(log.length <= 64 * 1024, `log is ${String(log.length)} bytes`)
  assert.ok(log.endsWith('THE-END'), 'the newest output survives')
})

test('exit 0 settles as done and says a restart is required', (t) => {
  const { updater, children } = harness(t)
  updater.start('0.1.0')
  children[0].emit('close', 0)
  const view = updater.view()
  assert.equal(view.state, 'done')
  assert.equal(view.error, undefined)
  assert.match(view.log, /restart dsh for the new version to take effect/)
  assert.equal(typeof view.endedAt, 'number')
})

test('a non-zero exit settles as failed with the code', (t) => {
  const { updater, children } = harness(t)
  updater.start('0.1.0')
  children[0].emit('close', 1)
  const view = updater.view()
  assert.equal(view.state, 'failed')
  assert.equal(view.error, 'npm exited 1')
})

test('a spawn error settles as failed', (t) => {
  const { updater, children } = harness(t)
  updater.start('0.1.0')
  children[0].emit('error', new Error('ENOENT'))
  const view = updater.view()
  assert.equal(view.state, 'failed')
  assert.equal(view.error, 'ENOENT')
})

test('a run past the ceiling is killed and reported as timed out', async (t) => {
  const { updater, children } = harness(t, { timeoutMs: 5 })
  updater.start('0.1.0')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(children[0].killed, true)
  const view = updater.view()
  assert.equal(view.state, 'failed')
  assert.equal(view.error, 'install timed out')
})

test('a settled task is never re-settled by a late event', (t) => {
  const { updater, children } = harness(t)
  updater.start('0.1.0')
  children[0].emit('close', 0)
  const done = updater.view()
  children[0].emit('close', 1)
  assert.deepEqual(updater.view(), done, 'a second close is ignored')
})

test('view returns a copy, so a caller cannot mutate task state', (t) => {
  const { updater } = harness(t)
  const view = updater.view()
  view.state = 'running'
  assert.equal(updater.view().state, 'idle')
})

test('dispose leaves a running install alone', (t) => {
  // Killing npm midway can leave the global package directory half-written,
  // which is worse than losing the progress view.
  const { updater, children } = harness(t)
  updater.start('0.1.0')
  updater.dispose()
  assert.equal(children[0].killed, false)
})

test('start reports a missing npm CLI as an actionable error', () => {
  const updater = createUpdater({ execPath: '/nonexistent/node', spawnImpl: () => { throw new Error('unreachable') } })
  assert.throws(() => updater.start('0.1.0'), /npm CLI not found/)
})

test('resolveNpmCli finds nothing beside a nonexistent node', () => {
  assert.equal(resolveNpmCli({ execPath: '/nonexistent/place/node' }), undefined)
})

test('resolveNpmCli locates the npm CLI of the running node', () => {
  // The real npm that ships with this node must be discoverable, or the plugin
  // could never install anything on this machine.
  assert.match(resolveNpmCli() ?? '', /npm-cli\.js$/)
})

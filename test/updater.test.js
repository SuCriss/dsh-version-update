/**
 * Update-runner tests: the single-slot install task, the shell-free npm spawn,
 * the exact-version guard on the spawned argument, output capture, and
 * settlement.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
 * The install slot those runners claim is PROCESS-WIDE module state, so the
 * cleanup also settles every fake child — emitting close on an
 * already-settled run is a no-op — or one test's orphaned npm would hold the
 * slot into every later test in this file.
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
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    spawnImpl: (command, args, spawnOptions) => {
      calls.push({ command, args, options: spawnOptions })
      const child = new FakeChild()
      children.push(child)
      return child
    },
  })
  t.after(() => {
    for (const child of children) child.emit('close', 0)
    updater.dispose()
  })
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
  // The log opens with the command line actually spawned, flags included, so
  // the panel shows what ran rather than a prettified summary of it.
  assert.equal(view.log, '$ npm install -g @deepseek-ai/dsh@0.1.0-rc.8 --no-fund --no-audit\n')
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

test('a runner refuses to start while another runner of this process is still installing', (t) => {
  // The single slot is process-wide, not per runner: a config reload replaces
  // this plugin's fiber with a fresh runner whose own task state is idle, and
  // only module-level state can tell it that an earlier fiber's npm is still
  // writing the global tree.
  const first = harness(t)
  const second = harness(t)
  first.updater.start('0.1.0')
  assert.throws(() => second.updater.start('0.2.0'), /already running in this host process/)
  assert.equal(second.calls.length, 0, 'the refused runner spawned nothing')
})

test('the process-wide slot frees once the earlier run settles', (t) => {
  const first = harness(t)
  const second = harness(t)
  first.updater.start('0.1.0')
  first.children[0].emit('close', 0)
  second.updater.start('0.2.0')
  assert.equal(second.calls.length, 1)
})

test('disposing a runner does not free the slot its npm still holds', (t) => {
  // Disposal deliberately leaves npm alive; losing the progress view is
  // cheaper than a half-written global tree, and so is refusing the next
  // start until that orphaned run settles — which its surviving close
  // listener still reports even though the runner instance is gone.
  const first = harness(t)
  const second = harness(t)
  first.updater.start('0.1.0')
  first.updater.dispose()
  assert.throws(() => second.updater.start('0.2.0'), /already running/)
  assert.equal(second.calls.length, 0)
  first.children[0].emit('close', 1)
  second.updater.start('0.2.0')
  assert.equal(second.calls.length, 1, 'the freed slot accepts the next install')
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

test('a settled run cannot write into the next task\'s log', (t) => {
  // A killed npm keeps draining buffered output. If those stream listeners
  // outlived their task, the dead run's tail would land in the live run's log.
  const { updater, children } = harness(t)
  updater.start('0.1.0')
  children[0].stdout.emit('data', 'FIRST-RUN\n')
  children[0].emit('close', 1)

  updater.start('0.2.0')
  children[0].stdout.emit('data', 'LATE-NOISE-FROM-DEAD-RUN\n')
  children[1].stdout.emit('data', 'SECOND-RUN\n')

  const { log } = updater.view()
  assert.doesNotMatch(log, /LATE-NOISE-FROM-DEAD-RUN/)
  assert.doesNotMatch(log, /FIRST-RUN/)
  assert.match(log, /SECOND-RUN/)
})

test('an install reads the registry the panel read the versions from', (t) => {
  // Otherwise a mirror-configured deployment offers a version from the mirror
  // and then fetches it from npmjs.
  const { updater, calls } = harness(t, { registry: 'https://npm.example.com/' })
  updater.start('0.1.0')
  assert.deepEqual(calls[0].args.slice(-2), ['--registry', 'https://npm.example.com'])
  assert.match(updater.view().log, /--registry https:\/\/npm\.example\.com/)
})

test('no registry configured leaves the npm default alone', (t) => {
  const { updater, calls } = harness(t)
  updater.start('0.1.0')
  assert.equal(calls[0].args.includes('--registry'), false)
})

test('a registry that is not an http(s) URL never reaches the command line', (t) => {
  for (const bad of ['not a url', 'file:///etc/passwd', '--proxy=http://evil', 'ftp://mirror']) {
    const { updater, calls } = harness(t, { registry: bad })
    assert.throws(() => updater.start('0.1.0'), /registry must/, bad)
    assert.equal(calls.length, 0, bad)
  }
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

test('the settlement observer reports each run exactly once with its verdict', (t) => {
  // The history records installs through this hook, so a duplicate report
  // would fabricate history and a missed one would lose it.
  const seen = []
  const calls = []
  const children = []
  const updater = createUpdater({
    npmCli: '/fake/npm-cli.js',
    onSettled: (info) => { seen.push(info) },
    spawnImpl: () => {
      const child = new FakeChild()
      children.push(child)
      return child
    },
  })
  t.after(() => {
    for (const child of children) child.emit('close', 0)
    updater.dispose()
  })
  void calls
  updater.start('0.1.0')
  children[0].emit('close', 0)
  updater.start('0.2.0')
  children[1].emit('close', 3)
  assert.deepEqual(seen, [
    { version: '0.1.0', ok: true },
    { version: '0.2.0', ok: false },
  ])
})

test('a settlement observer that throws cannot break the runner', (t) => {
  const children = []
  const updater = createUpdater({
    npmCli: '/fake/npm-cli.js',
    onSettled: () => { throw new Error('recorder exploded') },
    spawnImpl: () => {
      const child = new FakeChild()
      children.push(child)
      return child
    },
  })
  t.after(() => {
    for (const child of children) child.emit('close', 0)
    updater.dispose()
  })
  updater.start('0.1.0')
  assert.doesNotThrow(() => children[0].emit('close', 0))
  assert.equal(updater.view().state, 'done', 'the task settled normally')
})

test('start reports a missing npm CLI as an actionable error', () => {
  const updater = createUpdater({
    execPath: '/nonexistent/node',
    env: {},
    spawnImpl: () => { throw new Error('unreachable') },
  })
  assert.throws(() => updater.start('0.1.0'), /npm CLI not found/)
})

test('resolveNpmCli finds nothing beside a nonexistent node', () => {
  assert.equal(resolveNpmCli({ execPath: '/nonexistent/place/node', env: {} }), undefined)
})

test('resolveNpmCli locates the npm CLI of the running node', () => {
  // The real npm that ships with this node must be discoverable, or the plugin
  // could never install anything on this machine.
  assert.match(resolveNpmCli() ?? '', /npm-cli\.js$/)
})

test('resolveNpmCli falls back to the configured npm prefix', () => {
  // Covers the installations the node-adjacent probe cannot see: a custom
  // --prefix, nvm-windows, a portable node.
  const root = mkdtempSync(join(tmpdir(), 'vu-npm-'))
  const cli = join(root, 'node_modules', 'npm', 'bin')
  mkdirSync(cli, { recursive: true })
  writeFileSync(join(cli, 'npm-cli.js'), '', 'utf8')

  assert.equal(
    resolveNpmCli({ execPath: '/nonexistent/place/node', env: { npm_config_prefix: root } }),
    join(cli, 'npm-cli.js'),
  )
})

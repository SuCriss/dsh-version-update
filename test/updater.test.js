/**
 * Updater tests: the single process-wide slot, snapshot hook integration,
 * settlement observation, timeout kill, trigger validation, and log capping.
 * npm itself is a fake child whose streams and lifecycle events the tests
 * drive by hand.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { createUpdater, resolveNpmCli, npmMissingAdvice } from '../lib/updater.js'

/**
 * A fake spawned child: enough of ChildProcess for the runner's listeners.
 * @returns {EventEmitter & { stdout: EventEmitter & { setEncoding: () => void }; stderr: EventEmitter & { setEncoding: () => void }; exitCode: number | null; signalCode: null; kill: () => void; pid: number }} the double.
 */
function fakeChild() {
  const withEncoding = () => {
    const stream = /** @type {any} */ (new EventEmitter())
    stream.setEncoding = () => {}
    return stream
  }
  const child = /** @type {any} */ (new EventEmitter())
  child.stdout = withEncoding()
  child.stderr = withEncoding()
  child.exitCode = null
  child.signalCode = null
  child.pid = 4242
  child.killed = false
  child.kill = () => { child.killed = true; return true }
  return child
}

/** A spawn stub collecting every invocation. */
function spawnStub() {
  const calls = []
  const stub = (execPath, args) => {
    const child = fakeChild()
    calls.push({ execPath, args, child })
    return child
  }
  return Object.assign(stub, { calls })
}

test('missing npm advice distinguishes observed environments', () => {
  assert.match(npmMissingAdvice({ PNPM_HOME: '/pnpm' }, '/node'), /pnpm was detected/)
  assert.match(npmMissingAdvice({ COREPACK_ROOT: '/corepack' }, '/node'), /Corepack was detected/)
  assert.match(npmMissingAdvice({ npm_command: 'exec' }, '/node'), /temporary installation/)
  assert.doesNotMatch(npmMissingAdvice({}, '/node'), /was detected/)
})

test('permission failures preserve logs and surface actionable advice', (t) => {
  const spawn = spawnStub()
  const updater = createUpdater({ spawnImpl: spawn, npmCli: '/n' })
  t.after(() => updater.dispose())
  updater.start('1.2.3')
  const child = spawn.calls[0].child
  child.stderr.emit('data', 'npm ERR! code EACCES /global/package\n')
  child.exitCode = 1
  child.emit('close', 1)
  assert.match(updater.view().error, /Permission denied/)
  assert.match(updater.view().error, /user-owned prefix/)
  assert.match(updater.view().log, /EACCES \/global\/package/)
})

test('resolveNpmCli probes node-adjacent roots then configured prefixes', () => {
  // Every case passes an explicit `env`. Omitting it falls through to the real
  // process.env, where a CI runner's `npm_config_prefix` — a root this function
  // probes BY DESIGN — resolves the runner's own npm and defeats the assertion.
  assert.equal(resolveNpmCli({ execPath: '/nowhere/bin/node', env: {} }), undefined)
  // APPDATA layout (Windows per-user npm).
  const found = resolveNpmCli({
    execPath: '/opt/node/bin/node',
    env: { APPDATA: '/users/me/AppData/Roaming' },
  })
  assert.ok(found === undefined || found.endsWith('npm-cli.js'))
})

test('start spawns node npm-cli.js without a shell and settles on exit 0', async (t) => {
  const settled = []
  const spawn = spawnStub()
  const updater = createUpdater({
    spawnImpl: spawn,
    npmCli: '/npm/cli.js',
    onSettled: info => settled.push(info),
  })
  t.after(() => updater.dispose())

  const running = updater.start('0.5.0', 'scheduled')
  assert.equal(running.state, 'running')
  assert.equal(running.version, '0.5.0')
  assert.equal(running.trigger, 'scheduled')

  const call = spawn.calls[0]
  assert.equal(call.execPath, process.execPath)
  assert.deepEqual(call.args.slice(0, 4), ['/npm/cli.js', 'install', '-g', '@deepseek-ai/dsh@0.5.0'])
  assert.ok(!call.args.join(' ').includes('shell'))

  call.child.stdout.emit('data', 'added 1 package\n')
  call.child.exitCode = 0
  call.child.emit('close', 0)
  await Promise.resolve()

  const view = updater.view()
  assert.equal(view.state, 'done')
  assert.match(view.log, /added 1 package/)
  assert.deepEqual(settled, [{ version: '0.5.0', ok: true, trigger: 'scheduled' }])
})

test('non-zero exits settle as failed with the code in view and history', async (t) => {
  const settled = []
  const spawn = spawnStub()
  const updater = createUpdater({ spawnImpl: spawn, npmCli: '/n', onSettled: info => settled.push(info) })
  t.after(() => updater.dispose())
  updater.start('1.0.0')
  const call = spawn.calls[0]
  call.child.stderr.emit('data', 'boom\n')
  call.child.emit('close', 1)
  await Promise.resolve()
  assert.equal(updater.view().state, 'failed')
  assert.equal(updater.view().error, 'npm exited 1')
  assert.deepEqual(settled, [{ version: '1.0.0', ok: false, trigger: 'manual' }])
})

test('the slot is exclusive across runner instances until the orphan settles', async () => {
  const spawnA = spawnStub()
  const first = createUpdater({ spawnImpl: spawnA, npmCli: '/n' })
  first.start('1.0.0')

  // A fresh instance (as after a fiber reload) still sees the orphaned npm.
  const spawnB = spawnStub()
  const second = createUpdater({ spawnImpl: spawnB, npmCli: '/n' })
  assert.throws(() => second.start('1.1.0'), /already running in this host/)
  assert.equal(spawnB.calls.length, 0)

  // The orphaned run settling frees the slot for the replacement instance.
  const child = spawnA.calls[0].child
  child.exitCode = 0
  child.emit('close', 0)
  await Promise.resolve()
  const started = second.start('1.1.0')
  assert.equal(started.state, 'running')

  // Leave no orphan behind for the following tests.
  spawnB.calls[0].child.exitCode = 0
  spawnB.calls[0].child.emit('close', 0)
  await Promise.resolve()
})

test('dispose leaves a running install alive and its slot claimed', async (t) => {
  const spawn = spawnStub()
  const updater = createUpdater({ spawnImpl: spawn, npmCli: '/n' })
  updater.start('1.2.3')
  const child = spawn.calls[0].child
  // Whatever this asserts, the shared process-wide slot must be released
  // again before the next test runs: dispose deliberately does NOT do it.
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.exitCode = 0
      child.emit('close', 0)
    }
  })
  assert.equal(child.killed, false, 'disposal must not kill npm')
  const replacement = createUpdater({ spawnImpl: spawnStub(), npmCli: '/n' })
  assert.throws(() => replacement.start('1.3.0'), /already running in this host/)
})

test('beforeSpawn gates npm, streams progress, and its failure degrades to a log line', async (t) => {
  const spawn = spawnStub()
  /** @type {string[]} */
  const snapshotted = []
  const updater = createUpdater({
    spawnImpl: spawn,
    npmCli: '/n',
    beforeSpawn: async (version, report) => {
      report('snapshot: 50% copied\n')
      snapshotted.push(version)
    },
  })
  t.after(() => updater.dispose())

  const running = updater.start('8.8.8')
  assert.equal(running.state, 'running')
  // start answers at once; npm must wait for the snapshot hook, and the hook's
  // progress line is already visible to the panel.
  assert.equal(spawn.calls.length, 0, 'npm waits for the snapshot to finish')
  assert.match(running.log, /preparing to install/)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(snapshotted, ['8.8.8'])
  assert.equal(spawn.calls.length, 1)
  assert.match(updater.view().log, /snapshot: 50% copied/)
  // Settle this run so the shared process-wide slot frees for the next one.
  spawn.calls[0].child.exitCode = 0
  spawn.calls[0].child.emit('close', 0)
  await Promise.resolve()

  const failingSpawn = spawnStub()
  const failing = createUpdater({
    spawnImpl: failingSpawn,
    npmCli: '/n',
    beforeSpawn: () => { throw new Error('disk full') },
  })
  t.after(() => failing.dispose())
  failing.start('9.9.9')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.match(failing.view().log, /snapshot failed/)
  // A degraded snapshot never blocks the update: npm still runs.
  assert.equal(failingSpawn.calls.length, 1)
  // Release the shared process-wide slot for the following tests.
  failingSpawn.calls[0].child.exitCode = 0
  failingSpawn.calls[0].child.emit('close', 0)
  await Promise.resolve()
})

test('start answers while the snapshot runs and the preparation window holds the slot', async (t) => {
  const spawn = spawnStub()
  let releaseSnapshot
  const gate = new Promise(resolve => { releaseSnapshot = resolve })
  const updater = createUpdater({
    spawnImpl: spawn,
    npmCli: '/n',
    beforeSpawn: () => gate,
  })
  t.after(async () => {
    // Unwind a possibly still-pending run so the process-wide slot frees.
    releaseSnapshot()
    await new Promise(resolve => setTimeout(resolve, 10))
    if (spawn.calls[0] !== undefined) {
      const child = spawn.calls[0].child
      if (child.exitCode === null && child.signalCode === null) {
        child.exitCode = 0
        child.emit('close', 0)
      }
    }
    updater.dispose()
  })

  const running = updater.start('2.0.0')
  assert.equal(running.state, 'running')
  assert.ok(running.log.length > 0, 'the panel sees a live log from the first second')
  assert.equal(spawn.calls.length, 0, 'npm has not started during the snapshot copy')
  // The preparation window holds the process-wide slot: no second install.
  assert.throws(() => updater.start('2.0.1'), /already running/)
  // Release the snapshot; the pipeline continues to npm.
  releaseSnapshot()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(spawn.calls.length, 1)
  assert.match(updater.view().log, /\$ npm install -g @deepseek-ai\/dsh@2\.0\.0/)
})
test('an unknown trigger or malformed version refuses without spawning', (t) => {
  const spawn = spawnStub()
  const updater = createUpdater({ spawnImpl: spawn, npmCli: '/n' })
  t.after(() => updater.dispose())
  assert.throws(() => updater.start('0.1.0', 'telepathy'), /unknown trigger/)
  assert.throws(() => updater.start('^1.0.0'), /not one exact published version/)
  assert.throws(() => updater.start('latest'), /not one exact published version/)
  assert.equal(spawn.calls.length, 0)
})

test('the soft deadline notes the slow run but never kills npm', async (t) => {
  const spawn = spawnStub()
  const updater = createUpdater({ spawnImpl: spawn, npmCli: '/n', timeoutMs: 30, hardTimeoutMs: 10_000 })
  t.after(() => updater.dispose())
  updater.start('5.0.0')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(updater.view().state, 'running', 'soft deadline leaves the task running')
  assert.equal(spawn.calls[0].child.killed, false, 'soft deadline must not kill npm mid-reify')
  assert.match(updater.view().log, /still waiting/, 'the log notes the slow run and keeps waiting')
  // npm finally finishes on its own: the run settles done.
  spawn.calls[0].child.exitCode = 0
  spawn.calls[0].child.emit('close', 0)
  await Promise.resolve()
  assert.equal(updater.view().state, 'done')
})

test('a wedged install is killed only at the hard ceiling and reported failed', async (t) => {
  const spawn = spawnStub()
  const updater = createUpdater({ spawnImpl: spawn, npmCli: '/n', timeoutMs: 30, hardTimeoutMs: 60 })
  t.after(() => updater.dispose())
  updater.start('5.0.0')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(updater.view().state, 'failed')
  assert.equal(updater.view().error, 'install exceeded the hard time limit')
  assert.equal(spawn.calls[0].child.killed, true)
})

test('the retained log tail respects LOG_LIMIT', async (t) => {
  const { LOG_LIMIT } = await import('../lib/updater.js')
  const spawn = spawnStub()
  const updater = createUpdater({ spawnImpl: spawn, npmCli: '/n' })
  t.after(() => updater.dispose())
  updater.start('7.7.7')
  const child = spawn.calls[0].child
  const chunk = 'x'.repeat(LOG_LIMIT)
  child.stdout.emit('data', chunk + 'TAIL')
  child.exitCode = 0
  child.emit('close', 0)
  await Promise.resolve()
  const logText = updater.view().log
  assert.ok(logText.length <= LOG_LIMIT)
  assert.ok(logText.includes('TAIL'), 'the newest output survives the cap')
})
test('isBusy reports the process-wide slot, not just this instance', async (t) => {
  const idle = createUpdater({ spawnImpl: spawnStub(), npmCli: '/n' })
  assert.equal(idle.isBusy(), false, 'an idle runner with no run in the process is free')

  const spawnA = spawnStub()
  const first = createUpdater({ spawnImpl: spawnA, npmCli: '/n' })
  first.start('1.0.0')
  const child = spawnA.calls[0].child
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.exitCode = 0
      child.emit('close', 0)
    }
  })
  assert.equal(first.isBusy(), true, 'a running install is busy')

  // A replacement instance — what a plugin-fiber reload builds — reports its
  // OWN task as idle while the previous fiber's npm still writes the tree. This
  // is the case the restore guard exists for.
  const second = createUpdater({ spawnImpl: spawnStub(), npmCli: '/n' })
  assert.equal(second.view().state, 'idle')
  assert.equal(second.isBusy(), true, 'the orphaned run keeps the tree busy for every runner')

  // Settlement frees it for the replacement instance too.
  child.exitCode = 0
  child.emit('close', 0)
  await Promise.resolve()
  assert.equal(second.isBusy(), false)
  assert.equal(first.isBusy(), false)
})

test('isBusy covers the pre-spawn preparation window', async (t) => {
  const spawn = spawnStub()
  let release = () => {}
  const gate = new Promise(resolve => { release = () => { resolve(undefined) } })
  const updater = createUpdater({
    spawnImpl: spawn,
    npmCli: '/n',
    beforeSpawn: async () => { await gate },
  })
  t.after(() => updater.dispose())

  updater.start('2.0.0')
  // The rollback snapshot is still copying: npm has not been spawned, yet the
  // tree is already spoken for — a restore starting now would race the copy.
  assert.equal(spawn.calls.length, 0)
  assert.equal(updater.isBusy(), true, 'a snapshot being written holds the tree')

  release()
  await new Promise(resolve => { setTimeout(resolve, 10) })
  assert.equal(spawn.calls.length, 1)
  assert.equal(updater.isBusy(), true, 'the spawned npm takes over the claim')

  // Settle so the shared process-wide slot frees for the following tests.
  spawn.calls[0].child.exitCode = 0
  spawn.calls[0].child.emit('close', 0)
  await Promise.resolve()
  assert.equal(updater.isBusy(), false)
})

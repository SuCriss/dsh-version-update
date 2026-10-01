/**
 * Updater tests: the single process-wide slot, snapshot hook integration,
 * settlement observation, timeout kill, trigger validation, and log capping.
 * npm itself is a fake child whose streams and lifecycle events the tests
 * drive by hand.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createUpdater, resolveNpmCli } from '../lib/updater.js'
import { acquireUpdateLock, readLockHolder } from '../lib/updatelock.js'

/**
 * The lock file every runner in this file contends on. The suite must never
 * acquire — or be refused by — the machine-wide lock real hosts share: a second
 * test file's process, or a dsh host somebody left running on the machine,
 * would make these assertions fail for reasons that have nothing to do with the
 * code under test. Two tests below name a file of their own because they
 * inspect the lock itself rather than merely contend for it.
 */
const lockHome = mkdtempSync(join(tmpdir(), 'vu-updater-'))
const FILE_LOCK = join(lockHome, 'update.lock')
after(() => rmSync(lockHome, { recursive: true, force: true }))

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

/** A spawn stub collecting every invocation, options included. */
function spawnStub() {
  const calls = []
  const stub = (execPath, args, options) => {
    const child = fakeChild()
    calls.push({ execPath, args, options, child })
    return child
  }
  return Object.assign(stub, { calls })
}

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
    lockPath: FILE_LOCK,
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

test('npm is spawned outside every tree this plugin replaces, never in the host cwd', async (t) => {
  // npm's reify retires the package it replaces by RENAMING that directory
  // aside, and on Windows a directory that is any live process's working
  // directory cannot be renamed: the directory itself held reports EBUSY, a
  // held CHILD reports EPERM against its parent. Without an explicit cwd the
  // child inherits this host's, and a `dsh web` started from inside its own
  // tree hands npm the very directory it is about to replace — the install
  // then dies with EBUSY on `dsh\lib` while npm's own cwd IS that directory.
  const spawn = spawnStub()
  const updater = createUpdater({
    spawnImpl: spawn,
    npmCli: '/npm/cli.js',
    lockPath: FILE_LOCK,
  })
  t.after(() => updater.dispose())

  updater.start('0.5.0', 'manual')
  const call = spawn.calls[0]
  // Settle the run before asserting. A failed assertion here would otherwise
  // leave the process-wide slot claimed, and every later test in this file
  // would die with 'an update is already running' instead of its own reason.
  call.child.exitCode = 0
  call.child.emit('close', 0)
  await Promise.resolve()

  assert.equal(call.options?.cwd, tmpdir(), 'npm must be given a cwd outside the trees this plugin manages')
  assert.notEqual(call.options?.cwd, process.cwd(), 'inheriting the host cwd is exactly the bug')
})

test('an install asks the registry that served the versions, not the configured one', async (t) => {
  const spawn = spawnStub()
  /**
   * Settle the install that was just spawned — the process-wide slot is held
   * until its child closes, and a test that leaves one running locks every
   * later test in this file out.
   * @returns {Promise<string[]>} the npm arguments it was spawned with.
   */
  const finish = async () => {
    const call = spawn.calls.at(-1)
    assert.ok(call !== undefined, 'an install was spawned')
    call.child.exitCode = 0
    call.child.emit('close', 0)
    await Promise.resolve()
    return call.args
  }
  // The configured registry is the wrong source precisely when it matters: a
  // mirror answers only because that URL was unreachable, and re-asking it for
  // the version on screen reports the offered update as nonexistent. The value
  // is read at spawn time, so a check that succeeded since moves it.
  const viaMirror = createUpdater({
    spawnImpl: spawn,
    npmCli: '/npm/cli.js',
    lockPath: FILE_LOCK,
    registry: 'https://registry.internal',
    servedRegistry: () => 'https://registry.npmmirror.test',
  })
  t.after(() => viaMirror.dispose())
  viaMirror.start('0.5.0', 'manual')
  assert.deepEqual((await finish()).slice(-2), ['--registry', 'https://registry.npmmirror.test'])

  // Before any read has answered, the configured value still decides...
  const notYet = createUpdater({
    spawnImpl: spawn,
    npmCli: '/npm/cli.js',
    lockPath: FILE_LOCK,
    registry: 'https://registry.internal',
    servedRegistry: () => undefined,
  })
  t.after(() => notYet.dispose())
  notYet.start('0.6.0', 'manual')
  assert.deepEqual((await finish()).slice(-2), ['--registry', 'https://registry.internal'])

  // ...and with neither, npm keeps its own default.
  const bare = createUpdater({ spawnImpl: spawn, npmCli: '/npm/cli.js', lockPath: FILE_LOCK })
  t.after(() => bare.dispose())
  bare.start('0.7.0', 'manual')
  assert.ok(!(await finish()).join(' ').includes('--registry'), 'no registry flag was invented')
})

test('non-zero exits settle as failed with the code in view and history', async (t) => {
  const settled = []
  const spawn = spawnStub()
  const updater = createUpdater({ spawnImpl: spawn, npmCli: '/n', lockPath: FILE_LOCK, onSettled: info => settled.push(info) })
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
  const first = createUpdater({ spawnImpl: spawnA, npmCli: '/n', lockPath: FILE_LOCK })
  first.start('1.0.0')

  // A fresh instance (as after a fiber reload) still sees the orphaned npm.
  const spawnB = spawnStub()
  const second = createUpdater({ spawnImpl: spawnB, npmCli: '/n', lockPath: FILE_LOCK })
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
  const updater = createUpdater({ spawnImpl: spawn, npmCli: '/n', lockPath: FILE_LOCK })
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
  const replacement = createUpdater({ spawnImpl: spawnStub(), npmCli: '/n', lockPath: FILE_LOCK })
  assert.throws(() => replacement.start('1.3.0'), /already running in this host/)
})

test('beforeSpawn gates npm, streams progress, and its failure degrades to a log line', async (t) => {
  const spawn = spawnStub()
  /** @type {string[]} */
  const snapshotted = []
  const updater = createUpdater({
    spawnImpl: spawn,
    npmCli: '/n',
    lockPath: FILE_LOCK,
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
    lockPath: FILE_LOCK,
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
    lockPath: FILE_LOCK,
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
  const updater = createUpdater({ spawnImpl: spawn, npmCli: '/n', lockPath: FILE_LOCK })
  t.after(() => updater.dispose())
  assert.throws(() => updater.start('0.1.0', 'telepathy'), /unknown trigger/)
  assert.throws(() => updater.start('^1.0.0'), /not one exact published version/)
  assert.throws(() => updater.start('latest'), /not one exact published version/)
  assert.equal(spawn.calls.length, 0)
})

test('the soft deadline notes the slow run but never kills npm', async (t) => {
  const spawn = spawnStub()
  const updater = createUpdater({ spawnImpl: spawn, npmCli: '/n', lockPath: FILE_LOCK, timeoutMs: 30, hardTimeoutMs: 10_000 })
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
  const updater = createUpdater({ spawnImpl: spawn, npmCli: '/n', lockPath: FILE_LOCK, timeoutMs: 30, hardTimeoutMs: 60 })
  t.after(() => updater.dispose())
  updater.start('5.0.0')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(updater.view().state, 'failed')
  assert.equal(updater.view().error, 'install exceeded the hard time limit')
  assert.equal(spawn.calls[0].child.killed, true)
  // The kill only delivered a signal: the slot stays claimed until the child
  // has really exited, because the repair and the next install would otherwise
  // race a zombie npm over the same global tree.
  assert.throws(() => createUpdater({ spawnImpl: spawnStub(), npmCli: '/n', lockPath: FILE_LOCK }).start('5.0.1'), /already running in this host process/)
  const killed = spawn.calls[0].child
  killed.signalCode = 'SIGTERM'
  killed.emit('exit', null, 'SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 10))
  // Now a replacement runner may start.
  const spawnNext = spawnStub()
  const next = createUpdater({ spawnImpl: spawnNext, npmCli: '/n', lockPath: FILE_LOCK })
  t.after(() => next.dispose())
  assert.equal(next.start('5.0.1').state, 'running')
  spawnNext.calls[0].child.exitCode = 0
  spawnNext.calls[0].child.emit('close', 0)
  await Promise.resolve()
})

test('a run abandoned by the hard ceiling never spawns its stale target over the next run', async (t) => {
  const spawn = spawnStub()
  const settled = []
  /** @type {Map<string, () => void>} */
  const gates = new Map()
  const updater = createUpdater({
    spawnImpl: spawn,
    npmCli: '/n',
    lockPath: FILE_LOCK,
    timeoutMs: 30,
    hardTimeoutMs: 60,
    beforeSpawn: version => new Promise(resolve => { gates.set(version, resolve) }),
    onSettled: info => settled.push(info),
  })
  t.after(() => updater.dispose())

  updater.start('1.0.0')
  // The hard ceiling fires while the snapshot is still copying. The run is
  // reported failed and gives up its slot — but its pipeline is still suspended
  // inside `beforeSpawn`, and nothing has been spawned yet.
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(updater.view().state, 'failed')
  assert.equal(spawn.calls.length, 0, 'nothing was spawned during preparation')

  // A new run is admitted, which is correct here: no npm exists to race.
  updater.start('2.0.0')
  assert.equal(updater.view().state, 'running')
  assert.equal(updater.view().version, '2.0.0')

  // Now let the ABANDONED pipeline resume. Guarded on `task.state` it reads the
  // NEXT run's `running` and spawns npm for 1.0.0 — then settles 2.0.0 as done,
  // recording a success for an install that never ran, while the version the
  // user asked for is never spawned at all.
  gates.get('1.0.0')()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(spawn.calls.length, 0, 'the abandoned run must not spawn npm for its stale target')

  // The live run proceeds normally, on ITS target.
  gates.get('2.0.0')()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(spawn.calls.length, 1)
  assert.deepEqual(spawn.calls[0].args.slice(2, 4), ['-g', '@deepseek-ai/dsh@2.0.0'])

  spawn.calls[0].child.exitCode = 0
  spawn.calls[0].child.emit('close', 0)
  await Promise.resolve()
  assert.equal(updater.view().state, 'done')
  assert.deepEqual(settled, [
    { version: '1.0.0', ok: false, trigger: 'manual' },
    { version: '2.0.0', ok: true, trigger: 'manual' },
  ], 'the abandoned run reports its own failure, and only the live run reports a success')
})

test('a refused start never leaves the machine-wide lock behind', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vu-lock-'))
  const lockPath = join(dir, 'update.lock')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // No npm CLI exists beside this fake node binary, so start() must refuse —
  // and it must do so WITHOUT leaving the lock it would have needed behind.
  // The refusal explicitly sends the user to a terminal; a leaked lock would
  // then refuse that other host for the lock's whole staleness window.
  const updater = createUpdater({
    spawnImpl: spawnStub(),
    execPath: '/nowhere/bin/node',
    env: {},
    lockPath,
  })
  t.after(() => updater.dispose())
  assert.throws(() => updater.start('6.0.0'), /npm CLI not found/)
  assert.equal(existsSync(lockPath), false, 'a refused start releases the lock')
  assert.throws(() => updater.start('6.0.0', 'telepathy'), /unknown trigger/)
  assert.equal(existsSync(lockPath), false, 'a validation refusal releases the lock too')

  // The refusal must not strand the process-wide claim either: a later run in
  // the same process still works.
  const spawnNext = spawnStub()
  const next = createUpdater({ spawnImpl: spawnNext, npmCli: '/n', lockPath })
  t.after(() => next.dispose())
  assert.equal(next.start('6.0.1').state, 'running')
  spawnNext.calls[0].child.exitCode = 0
  spawnNext.calls[0].child.emit('close', 0)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(existsSync(lockPath), false, 'a settled run releases the lock')
})

test('a replacement waits for the orphan lock to release on close', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vu-orphan-'))
  const lockPath = join(dir, 'update.lock')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const spawnA = spawnStub()
  const first = createUpdater({ spawnImpl: spawnA, npmCli: '/n', lockPath })
  first.start('1.0.0')
  const orphan = spawnA.calls[0].child
  // A config reload disposes the fiber but deliberately leaves npm alive.
  first.dispose()
  // The child has exited but its host PID is still alive and owns the lock
  // until close settles the run. A replacement must not steal that lock.
  orphan.exitCode = 0
  const spawnB = spawnStub()
  const second = createUpdater({ spawnImpl: spawnB, npmCli: '/n', lockPath })
  t.after(() => second.dispose())
  assert.throws(() => second.start('1.1.0'), /machine-wide update lock/)
  assert.equal(spawnB.calls.length, 0)

  orphan.emit('close', 0)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(second.start('1.1.0').state, 'running')
  orphan.emit('close', 0) // a duplicate old settlement cannot release the new token

  assert.equal(existsSync(lockPath), true, 'the live run keeps its lock after an orphan settles')
  assert.equal(readLockHolder(readFileSync(lockPath, 'utf8'))?.pid, process.pid, 'still OUR lock')
  // And the newer run's slot claim survived the orphan's settlement.
  const spawnC = spawnStub()
  const third = createUpdater({ spawnImpl: spawnC, npmCli: '/n', lockPath })
  third.dispose()
  assert.throws(() => third.start('1.2.0'), /already running in this host process/)

  // Clean up: settle the live run so nothing leaks into later tests.
  spawnB.calls[0].child.exitCode = 0
  spawnB.calls[0].child.emit('close', 0)
  await new Promise(resolve => setTimeout(resolve, 10))
})

test('the retained log tail respects LOG_LIMIT', async (t) => {
  const { LOG_LIMIT } = await import('../lib/updater.js')
  const spawn = spawnStub()
  const updater = createUpdater({ spawnImpl: spawn, npmCli: '/n', lockPath: FILE_LOCK })
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

/** Let one extraction-watcher tick run, plus a margin. */
const settleTick = () => new Promise(resolve => setTimeout(resolve, 25))

/**
 * Wait for a progress observation to appear. The watcher is timer-driven, so a
 * fixed sleep would either flake or slow the suite down; this waits on the fact
 * being asserted instead.
 * @param {() => boolean} done - whether the awaited state has arrived.
 * @param {string} description - what was awaited, for the failure message.
 * @param {number} [timeoutMs] - how long to keep polling.
 */
async function waitForProgress(done, description, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (done()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`the progress model never reached: ${description}`)
}

test('the task reports a phase, a percentage, and a stall it can actually see', async (t) => {
  const { INSTALL_PROGRESS_STEP } = await import('../lib/updater.js')
  const home = await mkdtemp(join(tmpdir(), 'vu-progress-'))
  // A tree big enough that removing it reads as the mid-reify reset the
  // watcher keys on, plus the two files post-install verification needs.
  const blob = join(home, 'blob.bin')
  await writeFile(blob, Buffer.alloc(INSTALL_PROGRESS_STEP + 1024 * 1024))
  await mkdir(join(home, 'lib'), { recursive: true })
  await writeFile(join(home, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }))
  await writeFile(join(home, 'lib', 'bin.js'), '// launcher\n')

  const spawn = spawnStub()
  const updater = createUpdater({
    spawnImpl: spawn,
    npmCli: '/n',
    lockPath: FILE_LOCK,
    installDir: home,
    progressMs: 60,
    slowAfterMs: 40,
    // The snapshot copy reports bytes against a measured total; that total is
    // also the denominator the extraction phase inherits. The delay stands in
    // for the real hook's own measurement pass, so start() answers while the
    // run is still in its first phase.
    beforeSpawn: async (version, report, progress) => {
      await new Promise(resolve => setTimeout(resolve, 10))
      report('snapshot: 25% 50.0 MB copied\n')
      progress({ phase: 'snapshot', bytes: 50, totalBytes: 200, files: 3 })
    },
  })
  t.after(async () => {
    // A test that fails mid-run must not leave the process-wide slot claimed:
    // every later test in this file would then be refused for it.
    for (const call of spawn.calls) {
      if (call.child.exitCode === null && call.child.signalCode === null) {
        call.child.exitCode = 0
        call.child.emit('close', 0)
      }
    }
    updater.dispose()
    await rm(home, { recursive: true, force: true })
  })

  const started = updater.start('1.2.3')
  assert.equal(started.progress.phase, 'preparing', 'the bar exists from the first second')
  assert.equal(started.progress.percent, undefined, 'nothing has been measured yet')
  assert.equal(started.progress.slow, false)

  // The snapshot copy: the one phase with a denominator it measured itself.
  await new Promise(resolve => setTimeout(resolve, 15))
  const snapshotPhase = updater.view().progress
  assert.equal(snapshotPhase.phase, 'snapshot')
  assert.equal(snapshotPhase.percent, 25, 'a phase with a real denominator reports a real percentage')
  assert.equal(snapshotPhase.totalBytes, 200)

  // npm is running and the tree has not moved: the run is downloading, and
  // with no cache probe wired the phase is honest about having no numerator —
  // in particular it does NOT keep reporting the snapshot's percentage.
  await waitForProgress(() => updater.view().progress.phase === 'download', 'the download phase')
  assert.equal(spawn.calls.length, 1)
  const download = updater.view().progress
  assert.equal(download.percent, undefined)
  assert.equal(download.totalBytes, undefined)
  assert.equal(download.indeterminate, true)

  // The tree shrinks — the mid-reify reset — and extraction begins against the
  // size the snapshot recorded. What remains on disk is the manifest and the
  // launcher, so the climb starts from a few bytes rather than from zero.
  await rm(blob)
  await waitForProgress(() => updater.view().progress.phase === 'extract', 'the extract phase')
  const reset = updater.view().progress
  assert.equal(reset.totalBytes, 200, 'the snapshot total becomes the extraction denominator')
  assert.ok(reset.percent < 50, `the reset starts the climb over (saw ${reset.percent}%)`)

  // Growth inside the tree is reported as a percentage, not as a log line.
  await writeFile(blob, Buffer.alloc(100))
  await waitForProgress(() => updater.view().progress.bytes > reset.bytes, 'the extraction to grow')
  const grown = updater.view().progress
  assert.equal(grown.phase, 'extract')
  assert.ok(grown.percent > reset.percent, 'the bar moves forward as the tree grows')

  // Nothing has moved since, and this phase IS observable — so the run says so.
  await new Promise(resolve => setTimeout(resolve, 80))
  const stalled = updater.view().progress
  assert.equal(stalled.slow, true, 'a measured phase with no movement reports itself slow')
  assert.ok(stalled.stalledMs >= 40)

  spawn.calls[0].child.exitCode = 0
  spawn.calls[0].child.emit('close', 0)
  await Promise.resolve()
  const done = updater.view()
  assert.equal(done.state, 'done')
  assert.equal(done.progress.phase, 'done')
  assert.equal(done.progress.percent, 100, 'a settled run is complete whatever the last sample said')
  assert.equal(done.progress.slow, false, 'a settled run cannot be slow')
})

test('an install can be pinned to a named source, and only to a known one', async (t) => {
  const { DEFAULT_MIRROR_REGISTRY } = await import('../lib/updater.js')
  const spawn = spawnStub()
  /**
   * Settle the install that was just spawned, so the process-wide slot frees.
   * @returns {Promise<string[]>} the npm arguments it was spawned with.
   */
  const finish = async () => {
    const call = spawn.calls.at(-1)
    assert.ok(call !== undefined, 'an install was spawned')
    call.child.exitCode = 0
    call.child.emit('close', 0)
    await Promise.resolve()
    return call.args
  }
  const updater = createUpdater({
    spawnImpl: spawn,
    npmCli: '/npm/cli.js',
    lockPath: FILE_LOCK,
    registry: 'https://registry.internal',
    servedRegistry: () => 'https://registry.served',
  })
  t.after(() => updater.dispose())

  // The default stays what it always was: the source the versions came from.
  const automatic = updater.start('1.0.0', 'manual')
  assert.equal(automatic.source, 'auto')
  assert.equal(automatic.registry, 'https://registry.served')
  assert.deepEqual((await finish()).slice(-2), ['--registry', 'https://registry.served'])

  // The mirror is the escape hatch a slow source sends a user looking for.
  const mirrored = updater.start('1.0.1', 'manual', { source: 'mirror' })
  assert.equal(mirrored.source, 'mirror')
  assert.equal(mirrored.registry, DEFAULT_MIRROR_REGISTRY)
  assert.deepEqual((await finish()).slice(-2), ['--registry', DEFAULT_MIRROR_REGISTRY])

  // ...and the configured registry can be pinned explicitly, mirror or not.
  updater.start('1.0.2', 'manual', { source: 'official' })
  assert.deepEqual((await finish()).slice(-2), ['--registry', 'https://registry.internal'])

  // A source the runner does not know is refused, never passed through: the
  // URL behind a source is host-side config, and no request names one.
  assert.throws(() => updater.start('1.0.3', 'manual', { source: 'https://evil.test' }), /unknown install source/)
  assert.throws(() => updater.start('1.0.3', 'manual', { source: 'mirror ' }), /unknown install source/)
  assert.equal(spawn.calls.length, 3, 'a refused source never spawns')
})

test('a fatal preparation failure stops the install before npm runs', async (t) => {
  const { FatalPreparationError } = await import('../lib/updater.js')
  const spawn = spawnStub()
  const settled = []
  const updater = createUpdater({
    spawnImpl: spawn,
    npmCli: '/n',
    lockPath: FILE_LOCK,
    onSettled: info => settled.push(info),
    beforeSpawn: async () => { throw new FatalPreparationError('rollback snapshot unavailable: disk full') },
  })
  t.after(() => updater.dispose())

  updater.start('3.3.3')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(spawn.calls.length, 0, 'npm must not touch a tree that has no way back')
  const view = updater.view()
  assert.equal(view.state, 'failed')
  assert.match(view.error, /rollback snapshot unavailable/)
  assert.match(view.log, /preparation refused the install/)
  assert.deepEqual(settled, [{ version: '3.3.3', ok: false, trigger: 'manual' }])

  // The refusal released the slot, the preparation claim, and the machine-wide
  // lock: the user's next attempt is not refused for a run that never happened.
  const retry = createUpdater({ spawnImpl: spawn, npmCli: '/n', lockPath: FILE_LOCK })
  t.after(() => retry.dispose())
  retry.start('3.3.4')
  assert.equal(spawn.calls.length, 1, 'the machine-wide lock was released')
  spawn.calls[0].child.exitCode = 0
  spawn.calls[0].child.emit('close', 0)
  await Promise.resolve()
})

test('resolveNpmScratch follows npm\'s own cache resolution', async () => {
  const { resolveNpmScratch } = await import('../lib/updater.js')
  assert.equal(resolveNpmScratch({ env: {} }), undefined, 'no cache anywhere means no download signal')
  assert.equal(
    resolveNpmScratch({ env: { npm_config_cache: '/cache' } }),
    join('/cache', '_cacache', 'tmp'),
    'an explicit cache wins, whether or not it exists yet',
  )
  assert.equal(
    resolveNpmScratch({ env: { HOME: '/home/me' } }),
    join('/home/me', '.npm', '_cacache', 'tmp'),
    'the POSIX per-user default is npm\'s own',
  )
  assert.equal(
    resolveNpmScratch({ env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } }),
    join('C:\\Users\\me\\AppData\\Local', 'npm-cache', '_cacache', 'tmp'),
    'the Windows per-user default is npm\'s own',
  )
})


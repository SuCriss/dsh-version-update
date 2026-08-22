/**
 * Plugin-entry tests: the config schema cordis validates before this plugin
 * starts, the announcement's placement in the system prompt, and the wiring
 * `apply` performs over a fake context — above all that the restart guard is
 * fed the port the invocation asked for rather than the one it was given.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config, VERSION_UPDATE_GUIDANCE, apply, inject, name } from '../lib/index.js'

/**
 * A cordis context stand-in recording what the plugin registers on it.
 * @param {object} [options] - the fake host's shape.
 * @returns {object} the context plus its recordings.
 */
function fakeContext(options = {}) {
  const registered = []
  const sections = []
  const effects = []
  const ctx = {
    webServer: {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 3080,
      register: (route) => {
        registered.push(route)
        return () => {}
      },
    },
    get: (service) => (service === 'systemPrompt' && options.systemPrompt !== false
      ? { section: (s) => { sections.push(s); return () => {} } }
      : undefined),
    effect: (fn, label) => {
      effects.push(label)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return { ctx, registered, sections, effects }
}

test('the plugin declares a stable name and its one hard dependency', () => {
  assert.equal(name, 'version-update')
  assert.deepEqual(inject, ['webServer'])
})

test('Config fills every field so apply never reads an absent option', () => {
  assert.deepEqual(Config({}), {
    announceToAgent: true,
    registry: 'https://registry.npmjs.org',
    allowRestart: true,
  })
})

test('Config rejects a mistyped entry instead of silently disabling a feature', () => {
  // The point of declaring a schema: a typo in a profile's patch layer fails
  // the load with a named path rather than turning a feature off in silence.
  assert.throws(() => Config({ announceToAgent: 'yes' }), /announceToAgent/)
  assert.throws(() => Config({ registry: 5 }), /registry/)
  assert.throws(() => Config({ allowRestart: 1 }), /allowRestart/)
})

test('Config serializes for the settings inventory', () => {
  // schemastery flattens to a ref table: the root's dict maps each key to a uid
  // in `refs`. The settings panel renders a form from that, so every field has
  // to survive the flattening with its type and description intact.
  const json = Config.toJSON()
  const root = json.refs[String(json.uid)]
  assert.equal(root.type, 'object')
  assert.deepEqual(Object.keys(root.dict).sort(), ['allowRestart', 'announceToAgent', 'registry'])
  for (const [key, uid] of Object.entries(root.dict)) {
    const field = json.refs[String(uid)]
    assert.ok(field !== undefined, key)
    assert.equal(field.type, key === 'registry' ? 'string' : 'boolean', key)
    assert.equal(typeof field.meta.description, 'string', key)
  }
})

test('apply registers the four routes and the announcement', () => {
  const { ctx, registered, sections } = fakeContext()
  apply(ctx, Config({}))

  assert.deepEqual(registered.map(route => route.path).sort(), [
    '/api/dsh-version-update/check',
    '/api/dsh-version-update/restart',
    '/api/dsh-version-update/status',
    '/api/dsh-version-update/update',
  ])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'plugin:dsh-version-update')
  assert.equal(sections[0].text, VERSION_UPDATE_GUIDANCE)
})

test('the announcement sits inside the tool-guidance band', () => {
  // Bands are a shared convention: identity at -100, persona at 0, tool
  // guidance at 100-199. An order past the band would outrank first-party
  // guidance that has to be read first.
  const { ctx, sections } = fakeContext()
  apply(ctx, Config({}))
  assert.ok(sections[0].order >= 100 && sections[0].order < 200, String(sections[0].order))
})

test('announceToAgent false serves the routes without touching the prompt', () => {
  const { ctx, registered, sections } = fakeContext()
  apply(ctx, Config({ announceToAgent: false }))
  assert.equal(registered.length, 4)
  assert.deepEqual(sections, [])
})

test('a host without a system prompt still serves the routes', () => {
  // Headless RPC compositions have no systemPrompt service.
  const { ctx, registered } = fakeContext({ systemPrompt: false })
  apply(ctx, Config({}))
  assert.equal(registered.length, 4)
})

test('allowRestart false makes the restart route report itself unavailable', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, Config({ allowRestart: false }))
  const status = registered.find(route => route.path.endsWith('/status'))
  const body = await invoke(status, 'GET')
  assert.equal(body.result.restartable, false)
})

test('the restarter judges the requested port, not the resolved one', async () => {
  // The regression: under `--port 0` the host holds a real, OS-assigned port,
  // so a guard reading `webServer.port` would arm a handoff whose replacement
  // binds elsewhere — after this process has already exited.
  const argv = process.argv
  try {
    process.argv = [argv[0], argv[1], '--profile', 'web', '--port', '0']
    const { ctx, registered } = fakeContext({ port: 54321 })
    apply(ctx, Config({}))
    const restart = registered.find(route => route.path.endsWith('/restart'))
    const { status, body } = await invoke(restart, 'POST', true)
    assert.equal(status, 409)
    assert.match(body.error, /OS-assigned port/)
  } finally {
    process.argv = argv
  }
})

test('a fixed --port leaves the restart route armed', async () => {
  const argv = process.argv
  try {
    process.argv = [argv[0], argv[1], '--port', '3080']
    const { ctx, registered } = fakeContext({ port: 3080 })
    apply(ctx, Config({}))
    const status = registered.find(route => route.path.endsWith('/status'))
    const body = await invoke(status, 'GET')
    assert.equal(body.result.restartable, true)
  } finally {
    process.argv = argv
  }
})

test('an unparsable registry fails the mount instead of reaching npm', () => {
  // Config only proves it is a string; the URL shape is checked here because the
  // value becomes an `npm --registry` argument.
  const { ctx } = fakeContext()
  assert.throws(() => apply(ctx, Config({ registry: 'not a url' })), /registry must/)
})

/**
 * Drive one route handler through fake req/res objects.
 * @param {object} route - the registered route.
 * @param {'GET' | 'POST'} method - the request method.
 * @param {boolean} [withStatus] - resolve to status plus body instead of body alone.
 * @returns {Promise<any>} the parsed response.
 */
async function invoke(route, method, withStatus = false) {
  let code
  let payload = ''
  const req = {
    method,
    url: route.path,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {},
  }
  const res = {
    writeHead: (status) => { code = status; return res },
    end: (chunk) => { payload = chunk ?? '' },
  }
  await route.handler(req, res)
  const body = JSON.parse(payload)
  return withStatus ? { status: code, body } : body
}

/**
 * The `/api/dsh-version-update` route family: the registry check, the update
 * start, the task status poll, the restart handoff, release notes, and — new
 * in this rewrite — the policy endpoints and the snapshot center.
 *
 * Every route carries the loopback-only trust fence: the family reads the
 * network, rewrites a global npm package, restores snapshots over the live
 * installation, mutates persisted user policy, and can end this process.
 *
 * This module is deliberately thin HTTP plumbing: validation, envelopes, and
 * status codes around operations that live elsewhere. The policy store and
 * the snapshot center arrive as injected operation objects (`deps.policy`,
 * `deps.snapshots`) built by the composition, which keeps every handler here
 * testable with plain fakes.
 * @module dsh-version-update/routes
 */

import { buildView, fetchPublished, isInstallableVersion, readInstalled, resolveInstallationDir } from './core.js'
import { isLoopbackRequest } from './loopback.js'
import { INSTALL_SOURCES, VERSION_API } from './protocol.js'
import { readRestartDiagnostics } from './restart-log.js'

/** Maximum accepted request-body size (every body here is one small JSON object). */
const MAX_BODY_BYTES = 4096

/**
 * A failure the CLIENT caused, carrying the status that says so. Without this
 * the fenced handler could only report 500, which would blame the host for an
 * oversized or malformed request body.
 */
class RequestError extends Error {
  /**
   * @param {number} status - the HTTP status to answer with.
   * @param {string} message - the client-facing reason.
   */
  constructor(status, message) {
    super(message)
    this.name = 'RequestError'
    this.status = status
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 */
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<unknown>} the parsed body, or undefined for an empty one.
 * @throws {RequestError} 413 when the body exceeds the cap, 400 when it is not JSON.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new RequestError(413, 'request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, 'request body is not valid JSON')
  }
}

/**
 * Wrap a method → handler table with the loopback fence, the method fence, and
 * the error envelope. A table rather than one method, because the web server
 * keys routes by (kind, path): a path that both reads and writes has to
 * dispatch inside one route instead of mounting one route per method.
 * @param {Partial<Record<string, (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>>>} handlers - accepted methods and their handlers.
 * @param {(req: import('node:http').IncomingMessage) => boolean} fence - the trust fence.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the fenced handler.
 */
function fenced(handlers, fence) {
  return async (req, res) => {
    if (!fence(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return
    }
    const method = req.method ?? 'GET'
    // Own properties only: an inherited member of the table object is not a
    // handler this route family declared.
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
    if (handler === undefined) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      // A client-caused failure keeps its own status; anything else is ours.
      const status = error instanceof RequestError ? error.status : 500
      writeJson(res, status, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Wrap one handler serving a single method.
 * @param {'GET' | 'POST'} method - the only accepted method.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler - the guarded handler.
 * @param {(req: import('node:http').IncomingMessage) => boolean} fence - the trust fence.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the fenced handler.
 */
function guarded(method, handler, fence) {
  return fenced({ [method]: handler }, fence)
}

/**
 * Build the version-update route family.
 *
 * @param {{ updater: { view: () => { state: string; version?: string; log: string; error?: string }; start: (version: string, trigger?: 'manual' | 'auto' | 'scheduled', options?: { source?: 'auto' | 'official' | 'mirror' }) => object }; restarter?: { restart: () => object }; running?: string; fence?: (req: import('node:http').IncomingMessage) => boolean; registry?: string; fetchImpl?: typeof fetch; served?: (registry: string) => void; installDir?: string; repoSlug?: string; notes?: (repo: string, version: string) => Promise<{ notes?: string; url?: string }>; ambient?: () => Record<string, unknown>; policy?: { get: () => unknown; set: (next: unknown) => void }; snapshots?: { list: () => unknown[]; restore: (version: string) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string }; remove: (version: string) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string } }; operations?: { list: (sinceId?: number) => { events: unknown[]; cursor: number } }; auto?: (published: { distTags: Record<string, string>; versions: string[] }) => Promise<void>; manualCheck?: (published: Awaited<ReturnType<typeof fetchPublished>>) => Promise<object>; restartLogPath?: string; pendingCancel?: () => void; preflight?: () => ReturnType<typeof import('./preflight.js').runPreflight> }} deps - the runner, restart, facts, injected operations, and the automation decision.
 * @returns {{ routes: import('@deepseek-ai/dsh-host-webserver').WebRoute[] }} the routes.
 */
export function makeRoutes(deps) {
  const fence = deps.fence ?? isLoopbackRequest
  // Discovered at most once per route family: the installation cannot move
  // while the process lives, and every status poll would otherwise repeat the
  // resolution walk. Only the manifest READ below is repeated, because that is
  // what an install or restore changes.
  /** @type {{ dir: string | undefined } | undefined} */
  let discovered
  const installDir = () => {
    if (deps.installDir !== undefined) return deps.installDir
    if (discovered === undefined) discovered = { dir: resolveInstallationDir() }
    return discovered.dir
  }

  /**
   * The task view plus the staleness facts the panel needs to decide between a
   * plain reload and a restart. `running` is the version this process loaded at
   * boot; `installed` is what is on disk now. They differ exactly while a
   * completed update OR restore is waiting for a restart — which is also when
   * the open page holds assets the on-disk tree no longer contains.
   *
   * `needsRestart` stays deliberately wider than `stale`: a finished task
   * proves this process executes superseded code even when versions cannot be
   * compared, because a process cannot swap its own module tree.
   * @param {string | undefined} installed - the version currently on disk.
   * @returns {object} the task view with staleness fields.
   */
  const taskView = (installed) => {
    const task = deps.updater.view()
    const running = deps.running
    const stale = running !== undefined && installed !== undefined && running !== installed
    return {
      ...task,
      ...(running !== undefined ? { running } : {}),
      ...(installed !== undefined ? { installed } : {}),
      stale,
      needsRestart: stale || task.state === 'done',
      restartable: deps.restarter !== undefined,
    }
  }

  /** Ambient facts both polling routes carry (scheduler conclusions, history). */
  const ambient = () => ({ ...(deps.ambient !== undefined ? deps.ambient() : {}) })

  // Mounted only when release notes are enabled AND the installed manifest
  // names a GitHub repository — without both there is nothing to answer with.
  /** @type {import('@deepseek-ai/dsh-host-webserver').WebRoute[]} */
  const notesRoutes = []
  if (deps.notes !== undefined && typeof deps.repoSlug === 'string') {
    const reader = deps.notes
    const slug = deps.repoSlug
    /** @type {import('@deepseek-ai/dsh-host-webserver').WebRoute} */
    const notesRoute = {
      kind: 'exact',
      path: VERSION_API.notes,
      handler: guarded('GET', async (req, res) => {
        const version = new URL(req.url ?? '/', 'http://localhost').searchParams.get('version') ?? undefined
        if (!isInstallableVersion(version)) {
          writeJson(res, 400, { error: 'version must be one exact published version' })
          return
        }
        try {
          const notes = await reader(slug, version)
          writeJson(res, 200, {
            result: {
              version,
              hasNotes: typeof notes.notes === 'string',
              ...notes,
            },
          })
        } catch (error) {
          // The failure is upstream's (GitHub), not this host's.
          writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      }, fence),
    }
    notesRoutes.push(notesRoute)
  }

  /** The policy operation, when this composition provides one. */
  /** @type {import('@deepseek-ai/dsh-host-webserver').WebRoute[]} */
  const policyRoutes = []
  if (deps.policy !== undefined) {
    const policy = deps.policy
    policyRoutes.push({
      kind: 'exact',
      path: VERSION_API.policy,
      handler: fenced({
        GET: async (_req, res) => {
          writeJson(res, 200, { result: { policy: policy.get() } })
        },
        POST: async (req, res) => {
          const body = await readJsonBody(req)
          try {
            policy.set(body)
            writeJson(res, 200, { result: { policy: policy.get() } })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }, fence),
    })
  }

  /** Waiting automatic work can be cancelled only when a scheduler is wired. */
  /** @type {import('@deepseek-ai/dsh-host-webserver').WebRoute[]} */
  const pendingRoutes = []
  if (deps.pendingCancel !== undefined) {
    pendingRoutes.push({
      kind: 'exact',
      path: VERSION_API.pendingCancel,
      handler: guarded('POST', async (_req, res) => {
        if (deps.pendingCancel === undefined) {
          writeJson(res, 501, { error: 'pending cancellation is not available in this composition' })
          return
        }
        deps.pendingCancel()
        writeJson(res, 200, { result: { cancelled: true } })
      }, fence),
    })
  }

  /** The snapshot center, when this composition provides one. */
  /** @type {import('@deepseek-ai/dsh-host-webserver').WebRoute[]} */
  const snapshotRoutes = []
  if (deps.snapshots !== undefined) {
    const snapshots = deps.snapshots
    snapshotRoutes.push(
      {
        kind: 'exact',
        path: VERSION_API.snapshots,
        handler: guarded('GET', async (_req, res) => {
          writeJson(res, 200, { result: { snapshots: snapshots.list() } })
        }, fence),
      },
      {
        kind: 'exact',
        path: VERSION_API.restore,
        handler: guarded('POST', async (req, res) => {
          const body = await readJsonBody(req)
          const version = typeof body === 'object' && body !== null
            ? /** @type {Record<string, unknown>} */ (body).version
            : undefined
          if (!isInstallableVersion(version)) {
            writeJson(res, 400, { error: 'version must be one exact published version' })
            return
          }
          // Refuse while THIS process is installing: the restore would swap the
          // tree under its own npm. Contention with ANOTHER host's install or
          // restore is settled by the machine-wide lock the injected operation
          // takes — and its refusal arrives as a plain `ok: false`.
          if (deps.updater.view().state === 'running') {
            writeJson(res, 409, { error: 'a restore cannot run while an install is in progress' })
            return
          }
          const outcome = await snapshots.restore(/** @type {string} */ (version))
          if (!outcome.ok) {
            writeJson(res, 409, { error: outcome.error ?? 'restore failed' })
            return
          }
          writeJson(res, 200, { result: { restored: version, task: taskView(readInstalled(installDir()).installed) } })
        }, fence),
      },
      {
        kind: 'exact',
        path: VERSION_API.snapshotDelete,
        handler: guarded('POST', async (req, res) => {
          const body = await readJsonBody(req)
          const version = typeof body === 'object' && body !== null
            ? /** @type {Record<string, unknown>} */ (body).version
            : undefined
          if (!isInstallableVersion(version)) {
            writeJson(res, 400, { error: 'version must be one exact published version' })
            return
          }
          // Wait for the install. A snapshot taken moments ago by a running
          // install is the only way out of it, and the runner's own failure path
          // looks for exactly that directory — deleting it mid-flight would leave
          // a broken tree with nothing to restore.
          if (deps.updater.view().state === 'running') {
            writeJson(res, 409, { error: 'a snapshot cannot be deleted while an install is in progress' })
            return
          }
          const outcome = await snapshots.remove(/** @type {string} */ (version))
          if (!outcome.ok) {
            writeJson(res, 409, { error: outcome.error ?? 'snapshot delete failed' })
            return
          }
          // The fresh list rides along so the panel can drop the row it just
          // deleted without a second round-trip against a possibly busy host.
          writeJson(res, 200, { result: { removed: version, snapshots: snapshots.list() } })
        }, fence),
      },
    )
  }

  /** Local probes run only on demand, behind the same trust/method fences. */
  /** @type {import('@deepseek-ai/dsh-host-webserver').WebRoute[]} */
  const preflightRoutes = []
  if (deps.preflight !== undefined) {
    const preflight = deps.preflight
    preflightRoutes.push({
      kind: 'exact',
      path: VERSION_API.preflight,
      handler: guarded('GET', async (_req, res) => {
        writeJson(res, 200, { result: await preflight() })
      }, fence),
    })
  }

  /** The restart diagnostics operation, when this composition provides one. */
  /** @type {import('@deepseek-ai/dsh-host-webserver').WebRoute[]} */
  const diagnosticsRoutes = []
  if (deps.restarter !== undefined && deps.restartLogPath !== undefined) {
    const logPath = deps.restartLogPath
    diagnosticsRoutes.push({
      kind: 'exact',
      path: VERSION_API.restartDiagnostics,
      handler: guarded('GET', async (_req, res) => {
        try {
          writeJson(res, 200, { result: readRestartDiagnostics(logPath) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      }, fence),
    })
  }

  /** Always mounted; an unwired composition has an empty operation tail. */
  /** @type {import('@deepseek-ai/dsh-host-webserver').WebRoute[]} */
  const operationsRoutes = [{
    kind: 'exact',
    path: VERSION_API.operations,
    handler: guarded('GET', async (req, res) => {
      const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('since')
      const parsed = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN
      // A malformed cursor simply asks for the full retained tail.
      const since = Number.isSafeInteger(parsed) ? parsed : undefined
      writeJson(res, 200, { result: deps.operations?.list(since) ?? { events: [], cursor: 0 } })
    }, fence),
  }]

  /**
   * Read panel facts; explicit checks bypass the automatic-install callback.
   * @param {boolean} manual - whether a user explicitly requested this check.
   * @param {import('node:http').ServerResponse} res - the response.
   */
  const check = async (manual, res) => {
    const installed = readInstalled(installDir())
    // Registry failures must not bury local facts on either check path.
    /** @type {Awaited<ReturnType<typeof fetchPublished>> | undefined} */
    let published
    let publishedError
    try {
      published = await fetchPublished({
        ...(deps.registry !== undefined ? { registry: deps.registry } : {}),
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      })
    } catch (error) {
      publishedError = error instanceof Error ? error.message : String(error)
    }
    // Remember the registry that actually answered, including a mirror.
    if (published !== undefined && deps.served !== undefined) deps.served(published.registry)
    /** @type {object | undefined} */
    let manualView
    if (published !== undefined) {
      try {
        if (manual) manualView = await deps.manualCheck?.(published)
        else await deps.auto?.(published)
      } catch {
        // A decision failure never hides the successfully fetched facts.
      }
    }
    writeJson(res, 200, {
      result: {
        ...(published !== undefined
          ? buildView({ ...installed, ...published })
          : { ...(installed.installed !== undefined ? { installed: installed.installed } : {}) }),
        ...manualView,
        ...(installed.dir !== undefined ? { installDir: installed.dir } : {}),
        ...(publishedError !== undefined ? { publishedError } : {}),
        task: taskView(installed.installed),
        ...ambient(),
      },
    })
  }

  return {
    routes: [
      {
        kind: 'exact',
        path: VERSION_API.check,
        handler: guarded('GET', async (_req, res) => { await check(false, res) }, fence),
      },
      {
        kind: 'exact',
        path: VERSION_API.checkRun,
        handler: guarded('POST', async (_req, res) => { await check(true, res) }, fence),
      },
      {
        kind: 'exact',
        path: VERSION_API.update,
        handler: guarded('POST', async (req, res) => {
          const body = await readJsonBody(req)
          const version = typeof body === 'object' && body !== null
            ? /** @type {Record<string, unknown>} */ (body).version
            : undefined
          if (!isInstallableVersion(version)) {
            writeJson(res, 400, { error: 'version must be one exact published version' })
            return
          }
          // Which registry to fetch from: a source ID, never a URL. A body that
          // names one this build does not know is refused rather than ignored —
          // silently installing from the automatic source when the user asked
          // for the mirror is exactly the outcome they were avoiding.
          const rawSource = typeof body === 'object' && body !== null
            ? /** @type {Record<string, unknown>} */ (body).source
            : undefined
          if (rawSource !== undefined && (typeof rawSource !== 'string' || !INSTALL_SOURCES.includes(rawSource))) {
            writeJson(res, 400, { error: `source must be one of ${INSTALL_SOURCES.join(', ')}` })
            return
          }
          try {
            // The HTTP surface always records 'manual': automated installs
            // start inside the host, never through this route.
            deps.updater.start(/** @type {string} */ (version), 'manual', {
              ...(rawSource !== undefined ? { source: /** @type {'auto' | 'official' | 'mirror'} */ (rawSource) } : {}),
            })
            writeJson(res, 200, { result: taskView(readInstalled(installDir()).installed) })
          } catch (error) {
            writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
          }
        }, fence),
      },
      {
        kind: 'exact',
        path: VERSION_API.status,
        handler: guarded('GET', async (_req, res) => {
          writeJson(res, 200, { result: { ...taskView(readInstalled(installDir()).installed), ...ambient() } })
        }, fence),
      },
      {
        kind: 'exact',
        path: VERSION_API.restart,
        handler: guarded('POST', async (_req, res) => {
          if (deps.restarter === undefined) {
            writeJson(res, 501, { error: 'restart is not available in this composition' })
            return
          }
          try {
            writeJson(res, 200, { result: deps.restarter.restart() })
          } catch (error) {
            writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
          }
        }, fence),
      },
      ...preflightRoutes,
      ...diagnosticsRoutes,
      ...operationsRoutes,
      ...notesRoutes,
      ...policyRoutes,
      ...pendingRoutes,
      ...snapshotRoutes,
    ],
  }
}

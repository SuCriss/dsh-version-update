/**
 * The /api/dsh-version-update route family: the registry check, the update
 * start, the task status poll, and the restart handoff. Every route carries the
 * loopback-only trust fence — the check reaches the network, the update writes a
 * global npm package on the host machine, and the restart ends this process.
 * @module dsh-version-update/routes
 */

import { buildView, fetchPublished, isInstallableVersion, readInstalled, resolveInstallationDir } from './core.js'
import { isLoopbackRequest } from './loopback.js'
import { VERSION_API } from './protocol.js'

/** Maximum accepted request-body size (the update body is one small JSON object). */
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
 * Wrap one handler with the method and loopback fences.
 * @param {'GET' | 'POST'} method - the only accepted method.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler - the guarded handler.
 * @param {(req: import('node:http').IncomingMessage) => boolean} fence - the trust fence.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the fenced handler.
 */
function guarded(method, handler, fence) {
  return async (req, res) => {
    if (!fence(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return
    }
    if ((req.method ?? 'GET') !== method) {
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
 * Build the version-update route family.
 * @param {{ updater: { view: () => { state: string; version?: string; log: string; error?: string }; start: (version: string) => object }; restarter?: { restart: () => object }; running?: string; fence?: (req: import('node:http').IncomingMessage) => boolean; registry?: string; fetchImpl?: typeof fetch; installDir?: string }} deps - the update runner, the restart runner, the version this process booted with, plus test seams.
 * @returns {{ routes: import('@deepseek-ai/dsh-host-webserver').WebRoute[] }} the routes.
 */
export function makeRoutes(deps) {
  const fence = deps.fence ?? isLoopbackRequest
  // Discovered at most once per route family: the installation cannot move
  // while the process lives, and every status poll would otherwise repeat the
  // resolution walk. Only the manifest READ below is repeated, because that is
  // what an install changes.
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
   * completed update is waiting for a restart — which is also when the open
   * page is running assets the new tree no longer has.
   *
   * `needsRestart` is the field the panel acts on, and it is deliberately wider
   * than `stale`: a finished install proves this process is executing
   * superseded code even when the versions cannot be compared, because a
   * process cannot swap its own module tree. Without it, a host whose installed
   * version is unknown (an embedder, or an unreadable manifest) would install
   * successfully and then never prompt for the restart that makes the page
   * usable again — the one path where the fallbacks in
   * {@link resolveInstallationDir} matter most.
   *
   * `installed` is repeated here even though the check route already reports it
   * at the top level: the status route is the only thing the restart watchdog
   * polls, and it needs the version to name in its own messages.
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

  return {
    routes: [
      {
        kind: 'exact',
        path: VERSION_API.check,
        handler: guarded('GET', async (_req, res) => {
          const installed = readInstalled(installDir())
          // The registry read is the only network dependency in the family,
          // and its failure must not bury the LOCAL facts: an offline machine
          // (or one whose mirror is down) still has an installed version and
          // an install path, and hiding them behind a 500 turns a network
          // problem into a panel that shows nothing at all. The response
          // carries `publishedError` instead of channels/versions, and the
          // panel degrades to the local view with the reason attached.
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
          writeJson(res, 200, {
            result: {
              ...(published !== undefined
                ? buildView({ ...installed, ...published })
                : { ...(installed.installed !== undefined ? { installed: installed.installed } : {}) }),
              ...(installed.dir !== undefined ? { installDir: installed.dir } : {}),
              ...(publishedError !== undefined ? { publishedError } : {}),
              task: taskView(installed.installed),
            },
          })
        }, fence),
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
          try {
            deps.updater.start(version)
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
          writeJson(res, 200, { result: taskView(readInstalled(installDir()).installed) })
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
    ],
  }
}

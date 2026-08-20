/**
 * The update task: one serialized `npm install -g @deepseek-ai/dsh@<version>`
 * run, its captured output, and its settlement. At most one task exists at a
 * time — a second request while one runs is refused rather than queued,
 * because two concurrent global installs of the same package would race over
 * the same directory.
 *
 * npm is spawned WITHOUT a shell on every platform. On Windows the `npm`
 * command is a `.cmd` shim that `spawn` refuses without a shell, so the runner
 * resolves npm's own `npm-cli.js` next to the running node binary and spawns
 * `node npm-cli.js …` instead. That keeps the version argument out of any
 * command-line parser.
 * @module dsh-version-update/updater
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSH_PACKAGE } from './protocol.js'
import { isInstallableVersion } from './core.js'

/** How much captured output one task retains (tail-truncated beyond it). */
export const LOG_LIMIT = 64 * 1024

/** Wall-clock cap on one install run. */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Locate npm's CLI entry so npm can be spawned as a plain node script.
 * @param {{ execPath?: string }} [deps] - test seam for the node binary path.
 * @returns {string | undefined} the npm-cli.js path, or undefined when not found.
 */
export function resolveNpmCli(deps = {}) {
  const nodeDir = dirname(deps.execPath ?? process.execPath)
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

/**
 * One task's public state, as the panel polls it.
 * @typedef {object} TaskView
 * @property {'idle' | 'running' | 'done' | 'failed'} state - settlement state.
 * @property {string} [version] - the target version of the current or last run.
 * @property {string} log - captured stdout+stderr, tail-truncated.
 * @property {string} [error] - failure message when state is 'failed'.
 * @property {number} [startedAt] - epoch ms when the run started.
 * @property {number} [endedAt] - epoch ms when the run settled.
 */

/**
 * Create the single-slot update runner.
 * @param {{ spawnImpl?: typeof spawn; npmCli?: string; execPath?: string; timeoutMs?: number }} [deps] - test seams.
 * @returns {{ view: () => TaskView; start: (version: string) => TaskView; dispose: () => void }} the runner.
 */
export function createUpdater(deps = {}) {
  const spawnImpl = deps.spawnImpl ?? spawn
  /** @type {TaskView} */
  let task = { state: 'idle', log: '' }
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child
  /** @type {NodeJS.Timeout | undefined} */
  let timer

  const append = (chunk) => {
    task.log = (task.log + chunk).slice(-LOG_LIMIT)
  }

  const settle = (state, error) => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    child = undefined
    task = { ...task, state, endedAt: Date.now(), ...(error !== undefined ? { error } : {}) }
  }

  return {
    view: () => ({ ...task }),

    start(version) {
      // Validate before the concurrency check so a malformed target reports
      // what is wrong with it rather than what else is running.
      if (!isInstallableVersion(version)) {
        throw new Error(`refusing to install ${JSON.stringify(String(version))}: not one exact published version`)
      }
      if (task.state === 'running') {
        throw new Error('an update is already running')
      }
      const npmCli = deps.npmCli ?? resolveNpmCli({ ...(deps.execPath !== undefined ? { execPath: deps.execPath } : {}) })
      if (npmCli === undefined) {
        throw new Error('npm CLI not found next to the running node binary — update this installation from a terminal instead')
      }
      const spec = `${DSH_PACKAGE}@${version}`
      task = { state: 'running', version, log: `$ npm install -g ${spec}\n`, startedAt: Date.now() }
      child = spawnImpl(process.execPath, [npmCli, 'install', '-g', spec, '--no-fund', '--no-audit'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)
      child.on('error', (error) => {
        append(`\n${String(error)}\n`)
        settle('failed', error instanceof Error ? error.message : String(error))
      })
      child.on('close', (code) => {
        if (task.state !== 'running') return
        if (code === 0) {
          append('\nnpm exited 0 — restart dsh for the new version to take effect.\n')
          settle('done')
        } else {
          append(`\nnpm exited ${code}\n`)
          settle('failed', `npm exited ${code}`)
        }
      })
      timer = setTimeout(() => {
        if (task.state !== 'running') return
        child?.kill()
        append('\ntimed out\n')
        settle('failed', 'install timed out')
      }, deps.timeoutMs ?? INSTALL_TIMEOUT_MS)
      return { ...task }
    },

    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      // A running install is left alone deliberately: killing npm midway can
      // leave the global package directory half-written, which is worse than
      // losing the progress view when the plugin fiber goes away.
      child = undefined
    },
  }
}

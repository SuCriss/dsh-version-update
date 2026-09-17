import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'

/** Only a bounded tail of the host-selected log is exposed to the panel. */
export const RESTART_LOG_BYTES = 16 * 1024

/**
 * Read the latest handoff log. The path is supplied by composition, never HTTP.
 * @param {string} path - fixed plugin-owned log path.
 * @returns {{ available: boolean; log: string; truncated: boolean; error?: string }} diagnostics.
 */
export function readRestartDiagnostics(path) {
  let fd
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('restart log is not a regular file')
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - RESTART_LOG_BYTES)
    const buffer = Buffer.alloc(Math.min(size, RESTART_LOG_BYTES))
    const count = readSync(fd, buffer, 0, buffer.length, start)
    const raw = buffer.subarray(0, count).toString('utf8')
    const lines = raw.split(/\r?\n/)
    if (start > 0) lines.shift() // do not display a partial first line
    const tail = lines.slice(-100).join('\n')
    // Common credential spellings in command lines and registry URLs.
    const log = tail.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
      .replace(/((?:token|password|secret|api[_-]?key)\s*(?:=|:)\s*|--(?:token|password|secret|api[_-]?key)\s+)(\S+)/gi, '$1[redacted]')
    return { available: true, log, truncated: start > 0 || lines.length > 100 }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return { available: false, log: '', truncated: false }
    }
    return { available: false, log: '', truncated: false, error: 'The restart log could not be read.' }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

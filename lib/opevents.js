/**
 * Ephemeral operation progress, shared by the host's install settlements,
 * restores, and repair passes. This is a bounded polling view, not an audit
 * trail: a reload starts a fresh log and old events fall out of the ring.
 * @module dsh-version-update/opevents
 */

/**
 * One immutable observation of an operation (the id links its observations).
 * @typedef {object} OperationEvent
 * @property {number} id - operation identity, distinct from the polling cursor.
 * @property {string} kind - operation family.
 * @property {'running' | 'done' | 'failed'} phase - state at this observation.
 * @property {string} [message] - human-readable progress or outcome.
 * @property {string} [error] - terminal failure reason.
 * @property {Record<string, unknown>} [data] - version, trigger, or measured counts.
 * @property {number} at - epoch milliseconds when observed.
 * @property {number} seq - monotonic cursor shared by all operations in this log.
 */

/**
 * Create a bounded operation log. `end` appends a terminal observation rather
 * than rewriting a previously polled event. Unknown/already-ended ids are
 * ignored. Active operation identities survive ring eviction until ended.
 *
 * `settle` records an outcome whose start was not observed (the updater has
 * only an onSettled hook); it never fabricates a running event.
 * @param {{ limit?: number }} [options] - retained event count, defaults to 200.
 * @returns {{ begin: (kind: string, meta?: { message?: string; data?: Record<string, unknown> }) => number; event: (id: number, message: string, data?: Record<string, unknown>) => void; end: (id: number, outcome: { ok: boolean; error?: string }) => void; settle: (kind: string, outcome: { ok: boolean; error?: string; message?: string; data?: Record<string, unknown> }) => number; list: (sinceId?: number) => { events: OperationEvent[]; cursor: number }; view: () => { events: OperationEvent[]; cursor: number } }} the log.
 */
export function createOperationLog(options = {}) {
  const limit = Number.isSafeInteger(options.limit) && /** @type {number} */ (options.limit) > 0 ? /** @type {number} */ (options.limit) : 200
  /** @type {OperationEvent[]} */
  const events = []
  /** @type {Map<number, { kind: string; data?: Record<string, unknown> }>} */
  const active = new Map()
  let seq = 0
  let nextId = 0

  /**
   * Copy payloads at the boundary so callers cannot mutate retained history.
   * @param {Omit<OperationEvent, 'at' | 'seq'>} entry - the observation.
   */
  const push = (entry) => {
    events.push(structuredClone({ ...entry, at: Date.now(), seq: ++seq }))
    if (events.length > limit) events.shift()
  }

  /**
   * Return observations newer than the cursor, oldest first. A cursor older
   * than the ring simply gets the retained tail; the sequence gap is visible.
   * @param {number} [sinceId] - last seen sequence, not an operation id.
   * @returns {{ events: OperationEvent[]; cursor: number }} an isolated polling view.
   */
  const list = (sinceId = 0) => ({ events: structuredClone(events.filter(entry => entry.seq > sinceId)), cursor: seq })

  return {
    begin(kind, meta = {}) {
      const id = ++nextId
      const data = meta.data === undefined ? {} : { data: structuredClone(meta.data) }
      active.set(id, { kind, ...data })
      push({ id, kind, phase: 'running', message: meta.message ?? `${kind} started`, ...data })
      return id
    },
    event(id, message, data) {
      const operation = active.get(id)
      if (operation === undefined) return
      push({ id, ...operation, phase: 'running', message, ...(data === undefined ? {} : { data }) })
    },
    end(id, { ok, error }) {
      const operation = active.get(id)
      if (operation === undefined) return
      push({ id, ...operation, phase: ok ? 'done' : 'failed', message: `${operation.kind} ${ok ? 'done' : 'failed'}`, ...(error === undefined ? {} : { error }) })
      active.delete(id)
    },
    settle(kind, { ok, error, message, data }) {
      const id = ++nextId
      push({ id, kind, phase: ok ? 'done' : 'failed', message: message ?? `${kind} ${ok ? 'done' : 'failed'}`, ...(error === undefined ? {} : { error }), ...(data === undefined ? {} : { data }) })
      return id
    },
    list,
    view: () => list(),
  }
}

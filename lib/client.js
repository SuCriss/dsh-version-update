window.__ModuleLoader__.load({
  id: 'dsh-version-update',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h } = React

    // ---------------------------------------------------------------- wire

    /** Route family of the version-update host API (mirrors lib/protocol.js). */
    const VERSION_API = {
      check: '/api/dsh-version-update/check',
      update: '/api/dsh-version-update/update',
      status: '/api/dsh-version-update/status',
      restart: '/api/dsh-version-update/restart',
      restartCancel: '/api/dsh-version-update/restart/cancel',
      notes: '/api/dsh-version-update/notes',
      policy: '/api/dsh-version-update/policy',
      snapshots: '/api/dsh-version-update/snapshots',
      restore: '/api/dsh-version-update/restore',
    }

    /** Dictionary namespace and settings-section id owned by this plugin. */
    const NS = 'version-update'

    /** Marker error meaning the host routes are absent, not failing. */
    const NOT_MOUNTED = 'dsh-version-update:not-mounted'

    /**
     * The neutral policy the panel renders before the first read answers;
     * mirrors lib/protocol.js DEFAULT_POLICY.
     */
    const EMPTY_POLICY = Object.freeze({
      mode: 'off',
      track: Object.freeze({ kind: 'tag', tag: 'latest' }),
      window: null,
      restart: 'ask',
      checkAt: null,
    })

    /** Same-origin JSON call unwrapping the host's `{ result }` / `{ error }` envelope. */
    async function call(path, body) {
      const response = await fetch(path, body === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      let payload
      try {
        payload = await response.json()
      } catch {
        // The routes always answer JSON, so unparsable text means nothing
        // answered: the SPA fallback served index.html for an unknown path.
        // That is the shape of "the plugin is installed but its host half has
        // not mounted yet", i.e. dsh has not been restarted since it was added.
        if ((response.headers.get('content-type') ?? '').includes('text/html')) {
          throw new Error(NOT_MOUNTED)
        }
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
      return payload.result
    }

    // ------------------------------------------------------ version ranking

    /**
     * Parse a version into comparable parts — the exact grammar the host ranks
     * (lib/core.js VERSION_PATTERN). This is a deliberate mirror, not a shared
     * import: the browser half ships as a standalone bundle with no build
     * step, so the two copies are kept in agreement by test.
     * @param {string} version - the version text.
     * @returns {{ core: number[]; pre: string[] } | undefined} parts, or undefined when unparsable.
     */
    function parseVersionParts(version) {
      const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z-]+(?:\.[0-9a-z-]+)*))?$/i.exec(version.trim())
      if (match === null) return undefined
      return {
        core: [Number(match[1]), Number(match[2]), Number(match[3])],
        pre: match[4] === undefined ? [] : match[4].split('.'),
      }
    }

    /**
     * Rank two versions by semver rules over the published grammar; mirrors
     * the host's `compareVersions` so both halves agree on what a downgrade is.
     * @param {string} a - left version.
     * @param {string} b - right version.
     * @returns {number} negative when a < b, zero when equal, positive when a > b.
     */
    function compareVersionTexts(a, b) {
      const left = parseVersionParts(a)
      const right = parseVersionParts(b)
      if (left === undefined && right === undefined) return 0
      if (left === undefined) return -1
      if (right === undefined) return 1
      for (let index = 0; index < 3; index += 1) {
        const delta = left.core[index] - right.core[index]
        if (delta !== 0) return delta
      }
      if (left.pre.length === 0 && right.pre.length > 0) return 1
      if (left.pre.length > 0 && right.pre.length === 0) return -1
      const shared = Math.min(left.pre.length, right.pre.length)
      for (let index = 0; index < shared; index += 1) {
        const aNumeric = /^\d+$/.test(left.pre[index])
        const bNumeric = /^\d+$/.test(right.pre[index])
        let delta
        if (aNumeric && bNumeric) delta = Number(left.pre[index]) - Number(right.pre[index])
        else if (aNumeric) delta = -1
        else if (bNumeric) delta = 1
        else delta = left.pre[index] < right.pre[index] ? -1 : left.pre[index] > right.pre[index] ? 1 : 0
        if (delta !== 0) return delta
      }
      return left.pre.length - right.pre.length
    }

    /**
     * Whether installing {@link target} onto an installation running
     * {@link installed} would move it backwards. Uncomparable values are never
     * called a downgrade — the panel keeps the neutral wording instead.
     * @param {string | undefined} target - the candidate version.
     * @param {string | undefined} installed - the version on disk.
     * @returns {boolean} true when the install would be a rollback.
     */
    function isDowngrade(target, installed) {
      if (typeof target !== 'string' || typeof installed !== 'string') return false
      if (parseVersionParts(target) === undefined || parseVersionParts(installed) === undefined) return false
      return compareVersionTexts(target, installed) < 0
    }

    // -------------------------------------------------------------- styles

    /**
     * Attribute marking this plugin's row in the settings navigation, so the
     * stylesheet below can reach a button the settings shell owns without
     * touching any other row.
     */
    const NAV_MARKER = 'data-dsh-version-update-settings-nav'

    /**
     * The nav glyph: a circular refresh arrow over a downward install arrow,
     * drawn at 24x24 with a 2px stroke. Inlined as a data URL because the
     * plugin ships no static assets.
     */
    const NAV_GLYPH = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'/%3E%3Cpath d='M3 3v5h5'/%3E%3Cpath d='M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16'/%3E%3Cpath d='M16 16h5v5'/%3E%3C/svg%3E"

    const CSS_ID = 'dsh-version-update/panel.css'
    const CSS = `
.dshvu_page{display:flex;flex-direction:column;gap:20px;padding:4px 0 16px}
.dshvu_card{background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:18px 20px;border:1px solid var(--dsw-alias-border-l2);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.dshvu_title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;margin:0 0 12px;display:flex;align-items:center;gap:10px;justify-content:space-between}
.dshvu_row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.dshvu_rowSplit{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:6px 0}
.dshvu_label{color:var(--dsw-alias-label-tertiary);font-size:13px;white-space:nowrap}
.dshvu_value{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.dshvu_pathRow{display:flex;flex-direction:column;gap:4px;padding:6px 0}
.dshvu_path{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;word-break:break-all}
.dshvu_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;margin:10px 0 0}
.dshvu_warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:1.6;margin:10px 0 0;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-state-warn-bg)}
.dshvu_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6;margin:8px 0 0;white-space:pre-wrap}
.dshvu_ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.6;margin:8px 0 0}
.dshvu_sep{border-top:1px solid var(--dsw-alias-border-l2);margin:14px 0 0;padding-top:6px}
.dshvu_btn{appearance:none;font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:6px 14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);transition:border-color .16s,background .16s}
.dshvu_btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}
.dshvu_btnPrimary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dshvu_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
.dshvu_btn:disabled{cursor:not-allowed;opacity:.4}
.dshvu_btn:focus-visible,.dshvu_input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshvu_select{appearance:none;font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:6px 28px 6px 10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dshvu_select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshvu_selectWrap{position:relative;display:inline-flex;align-items:center}
.dshvu_selectWrap::after{content:'';position:absolute;right:10px;width:6px;height:6px;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:translateY(-2px) rotate(45deg);pointer-events:none}
.dshvu_input{font:inherit;font-size:13px;border-radius:8px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);width:120px}
/* The policy form: one labelled control per line, hints under the field. */
.dshvu_field{display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:1px dashed var(--dsw-alias-border-l2)}
.dshvu_field:first-of-type{border-top:none}
.dshvu_fieldHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshvu_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;min-width:96px}
.dshvu_badge{border-radius:999px;padding:1px 9px;font-size:11px;font-weight:500;line-height:18px;white-space:nowrap;border:1px solid transparent}
.dshvu_badgeAhead{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary-foreground)}
.dshvu_badgeCurrent{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.dshvu_badgeOk{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dshvu_list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:2px}
.dshvu_listScroll{max-height:260px;overflow-y:auto;padding-right:6px}
.dshvu_listScroll::-webkit-scrollbar{width:4px;height:4px}
.dshvu_listScroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}
.dshvu_item{display:grid;grid-template-columns:minmax(88px,auto) 1fr auto;align-items:center;gap:10px;padding:6px 0}
.dshvu_itemMain{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;min-width:0;overflow-wrap:anywhere}
.dshvu_itemAction{grid-column:3;justify-self:end}
.dshvu_chanName{color:var(--dsw-alias-label-secondary);font-size:13px}
.dshvu_chanVersion{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.dshvu_log{margin:12px 0 0;padding:12px 14px;max-height:300px;overflow:auto;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-all}
.dshvu_log::-webkit-scrollbar{width:4px;height:4px}
.dshvu_log::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}
.dshvu_notesWrap{margin:10px 0 0;display:flex;flex-direction:column;gap:6px}
.dshvu_notes{margin:0;max-height:220px;white-space:pre-wrap}
.dshvu_notesLink{font-size:12px;color:var(--dsw-alias-brand-primary);text-decoration:none}
.dshvu_notesLink:hover{text-decoration:underline}
.dshvu_confirm{border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-bg);box-shadow:0 0 0 1px var(--dsw-alias-state-warn-primary)}
.dshvu_confirmBody{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.7;margin:0}
.dshvu_confirmActions{justify-content:flex-end;margin:16px 0 0}
.dshvu_spin{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshvu_spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-tertiary);border-radius:50%;animation:dshvu_spin .7s linear infinite}
@keyframes dshvu_spin{to{transform:rotate(360deg)}}
[${NAV_MARKER}] > svg:first-child{display:none}
[${NAV_MARKER}]::before{content:'';flex:none;width:18px;height:18px;background:currentColor;-webkit-mask:url("${NAV_GLYPH}") center / contain no-repeat;mask:url("${NAV_GLYPH}") center / contain no-repeat;margin:-1px 0}
`
    /**
     * Insert this plugin's stylesheet once and hand back its remover, so a
     * disposed fiber leaves no `<style>` behind.
     * @returns {() => void} the disposer removing the tag this call inserted.
     */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const selector = 'style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']'
      if (document.querySelector(selector) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-version-update'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    // ------------------------------------------------------------- overlay

    /**
     * The restart overlay is deliberately built from bare DOM with literal
     * colors — the only place here that does either. A completed update
     * replaces the dsh tree the page's assets come from; the hot-swap chain
     * then tears down the theme tokens and possibly the React renderer itself.
     * The overlay must stay legible through exactly that, so it depends on
     * neither. Colors still follow the system theme: prefers-color-scheme is a
     * media query needing no stylesheet the teardown could take away.
     */
    function createOverlay() {
      /** @type {HTMLElement | undefined} */
      let root
      /** @type {(() => void) | undefined} */
      let releaseFocus
      const palette = () => {
        const dark = (() => {
          try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return false }
        })()
        return dark
          ? { bg: '#1b1d21', panel: '#24262c', border: '#3a3d45', text: '#e8e9ec', dim: '#9aa0ab', primary: '#4c8bf0' }
          : { bg: 'rgba(0,0,0,.35)', panel: '#ffffff', border: '#d9dce1', text: '#1c1e22', dim: '#666c76', primary: '#2f6fd6' }
      }
      const close = () => {
        root?.remove()
        root = undefined
        releaseFocus?.()
        releaseFocus = undefined
      }
      return {
        show(view) {
          const colors = palette()
          if (root === undefined) {
            root = document.createElement('div')
            root.id = 'dsh-version-update-restart-overlay'
            root.setAttribute('role', 'dialog')
            root.setAttribute('aria-modal', 'true')
            const shadow = document.createElement('div')
            shadow.style.cssText = `position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:${colors.bg};padding:20px`
            root.appendChild(shadow)
            document.body.appendChild(root)
            const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
            releaseFocus = () => { previous?.focus(); releaseFocus = undefined }
          }
          const shadow = /** @type {HTMLElement} */ (root.firstElementChild)
          shadow.style.background = colors.bg
          const panel = document.createElement('div')
          panel.style.cssText = `max-width:420px;width:100%;background:${colors.panel};border:1px solid ${colors.border};border-radius:14px;padding:20px 22px;color:${colors.text};font:13px/1.65 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.25)`
          const title = document.createElement('div')
          title.style.cssText = 'font-size:15px;font-weight:600;margin:0 0 8px'
          title.textContent = view.title
          panel.appendChild(title)
          if (typeof view.body === 'string') {
            const bodyNode = document.createElement('div')
            bodyNode.style.cssText = `color:${colors.dim}`
            bodyNode.textContent = view.body
            panel.appendChild(bodyNode)
          }
          /** @type {Record<string, unknown>[]} */
          const actions = Array.isArray(view.actions) ? view.actions : []
          if (actions.length > 0) {
            const row = document.createElement('div')
            row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:18px;flex-wrap:wrap'
            for (const action of actions) {
              const primary = action.primary === true
              const button = document.createElement('button')
              button.type = 'button'
              button.textContent = String(action.label)
              button.style.cssText = [
                'appearance:none;font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:6px 14px',
                `border:1px solid ${primary ? colors.primary : colors.border}`,
                primary ? `background:${colors.primary};color:#fff` : `background:transparent;color:${colors.text}`,
              ].join(';')
              button.addEventListener('click', () => { /** @type {() => void} */ (action.onClick)() })
              row.appendChild(button)
            }
            panel.appendChild(row)
          }
          // Replace content wholesale on every show; a countdown re-rendering
          // every second stays cheap because only children are replaced.
          shadow.replaceChildren(panel)
          const focusables = panel.querySelectorAll('button')
          if (focusables.length > 0) /** @type {HTMLElement} */ (focusables[focusables.length - 1]).focus()
          // Escape closes only when closing loses nothing (no primary action).
          const hasPrimary = actions.some(action => action.primary === true)
          root.onkeydown = (event) => {
            if (event.key !== 'Escape') return
            if (hasPrimary) return
            close()
          }
          // A minimal focus loop: without the trap, Tab escapes into a page
          // whose renderer may already be gone.
          panel.addEventListener('keydown', (event) => {
            if (event.key !== 'Tab' || focusables.length === 0) return
            const first = /** @type {HTMLElement} */ (focusables[0])
            const last = /** @type {HTMLElement} */ (focusables[focusables.length - 1])
            const active = document.activeElement
            if (event.shiftKey && active === first) { event.preventDefault(); last.focus() }
            else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
          })
        },
        hide() { close() },
      }
    }

    // ----------------------------------------------------------- controller

    /** How often the panel polls a running install (fast enough to feel live). */
    const POLL_MS = 800

    /**
     * Seconds shown before an automatic restart fires. A restart ends every
     * session, background job, and connection pool on this host.
     */
    const COUNTDOWN_S = 20

    /** How often the watchdog probes for the replacement host. */
    const PROBE_MS = 1000

    /** How long the watchdog waits for the replacement before giving up. */
    const PROBE_TIMEOUT_MS = 90000

    /** Marker surviving a page reload while the replacement host is still starting. */
    const AWAIT_KEY = 'dsh-version-update:awaiting-restart'

    function readAwaitMarker() {
      try {
        return window.sessionStorage.getItem(AWAIT_KEY) ?? undefined
      } catch {
        return undefined
      }
    }

    /**
     * Write or clear the await marker.
     * @param {string | undefined} version - the version, or undefined to clear.
     */
    function writeAwaitMarker(version) {
      try {
        if (version === undefined) window.sessionStorage.removeItem(AWAIT_KEY)
        else window.sessionStorage.setItem(AWAIT_KEY, version)
      } catch {
        // Unavailable storage only costs the cross-reload memory.
      }
    }

    /**
     * Panel state owner plus the restart watchdog. Both live outside React:
     * the watchdog's whole job is to keep working after the UI it belongs to
     * has been unmounted by a hot swap.
     */
    class VersionUpdateController {
      constructor(deps) {
        this.t = deps.t
        this.overlay = deps.overlay ?? createOverlay()
        this.reload = deps.reload ?? (() => { window.location.reload() })
        this.listeners = new Set()
        this.snapshot = {
          status: 'idle',
          installed: undefined,
          installDir: undefined,
          channels: [],
          versions: [],
          selected: undefined,
          publishedError: undefined,
          task: { state: 'idle', log: '' },
          error: undefined,
          busy: false,
          showLog: false,
          restarting: false,
          confirm: undefined,
          // Policy state: what the host enforces, what the form edits.
          policy: EMPTY_POLICY,
          policyError: undefined,
          savingPolicy: false,
          // Transient save feedback: { kind: 'ok' | 'error', text } or undefined.
          policyNotice: undefined,
          // Snapshot center + automation facts.
          snapshots: [],
          restoreConfirm: undefined,
          lastCheck: {},
          nextCheckAt: undefined,
          pendingAuto: undefined,
          history: [],
        }
        this.pollTimer = undefined
        this.countdownTimer = undefined
        this.probeTimer = undefined
        this.noticeTimer = undefined
        // The version whose install or restore this page watched. Only that
        // case restarts by itself; a stale host found at load is offered, not forced.
        this.armedVersion = undefined
      }

      getSnapshot = () => this.snapshot

      subscribe = (fn) => {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      }

      patch(next) {
        this.snapshot = { ...this.snapshot, ...next }
        for (const fn of [...this.listeners]) fn()
      }

      describeError(error) {
        const message = error instanceof Error ? error.message : String(error)
        return message === NOT_MOUNTED ? this.t('notMounted') : message
      }

      /** Clear a policy-save notice after a short while, if still pending. */
      scheduleNoticeClear() {
        if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer)
        this.noticeTimer = setTimeout(() => {
          this.noticeTimer = undefined
          this.patch({ policyNotice: undefined })
        }, 4000)
      }

      /**
       * Read every fact the page shows: local, registry, policy, snapshots.
       * @param {{ prompt?: boolean }} [options] - `prompt: true` (the user
       * clicked the check button) offers a found update for confirmation
       * right away; the page-load check stays silent.
       */
      check = async (options = {}) => {
        if (this.snapshot.status === 'loading') return
        this.patch({ status: 'loading', error: undefined })
        try {
          const [view, snapResult] = await Promise.all([
            call(VERSION_API.check),
            call(VERSION_API.snapshots).catch(() => undefined),
          ])
          const preferred = view.channels?.find(c => c.ahead)?.version
            ?? view.channels?.[0]?.version
            ?? view.versions?.[0]
          this.patch({
            status: 'ready',
            installed: view.installed,
            installDir: view.installDir,
            channels: view.channels ?? [],
            versions: view.versions ?? [],
            publishedError: typeof view.publishedError === 'string' ? view.publishedError : undefined,
            task: view.task ?? { state: 'idle', log: '' },
            selected: this.snapshot.selected ?? preferred,
            lastCheck: typeof view.lastCheck === 'object' && view.lastCheck !== null ? view.lastCheck : {},
            nextCheckAt: typeof view.nextCheckAt === 'number' ? view.nextCheckAt : undefined,
            pendingAuto: typeof view.pendingAuto === 'object' && view.pendingAuto !== null ? view.pendingAuto : undefined,
            history: Array.isArray(view.recent) ? view.recent : [],
            snapshots: Array.isArray(snapResult?.snapshots) ? snapResult.snapshots : this.snapshot.snapshots,
          })
          // The user asked for a check: when it finds something newer, ask
          // whether to install it now instead of waiting for the user to spot
          // the update row. Never preempt an open confirmation or a running
          // install.
          if (options?.prompt === true
            && this.snapshot.confirm === undefined
            && this.snapshot.restoreConfirm === undefined
            && this.snapshot.busy !== true) {
            const target = view.channels?.find(c => c.ahead)?.version
            if (target !== undefined) this.patch({ confirm: target })
          }
          if (view.task?.state === 'running') this.startPolling()
          else this.adoptTask(view.task)
        } catch (error) {
          this.patch({ status: 'error', error: this.describeError(error) })
        }
      }

      /** Read the effective policy without touching anything else. */
      refreshPolicy = async () => {
        try {
          const result = await call(VERSION_API.policy)
          if (typeof result?.policy === 'object' && result.policy !== null) {
            this.patch({ policy: result.policy, policyError: undefined })
          }
        } catch (error) {
          this.patch({ policyError: this.describeError(error) })
        }
      }

      /**
       * Submit a policy patch; the host validates, persists, and returns the
       * effective value, which becomes the new form baseline. A transient
       * notice reports whether the save succeeded.
       * @param {object} patch - the changed fields.
       */
      savePolicy = async (patch) => {
        if (this.snapshot.savingPolicy === true) return
        this.patch({ savingPolicy: true, policyError: undefined, policyNotice: undefined })
        try {
          const result = await call(VERSION_API.policy, patch)
          this.patch({ policy: result.policy, savingPolicy: false, policyNotice: { kind: 'ok', text: this.t('policy.saved') } })
          this.scheduleNoticeClear()
        } catch (error) {
          this.patch({
            policyError: this.describeError(error),
            savingPolicy: false,
            policyNotice: { kind: 'error', text: this.describeError(error) },
          })
          this.scheduleNoticeClear()
        }
      }

      select = (version) => { this.patch({ selected: version }) }

      toggleLog = () => { this.patch({ showLog: !this.snapshot.showLog }) }

      requestUpdate = (version) => {
        if (this.snapshot.busy) return
        this.patch({ confirm: version, error: undefined })
      }

      cancelUpdate = () => { this.patch({ confirm: undefined }) }

      confirmUpdate = async () => {
        const version = this.snapshot.confirm
        if (version === undefined) return
        this.patch({ confirm: undefined })
        await this.startUpdate(version)
      }

      /** Install one explicit version and follow it to settlement. */
      startUpdate = async (version) => {
        if (this.snapshot.busy) return
        this.patch({ busy: true, error: undefined, showLog: true })
        // Remember the target now: the install replaces the running package
        // tree, and the UI holding this value may be gone by settlement.
        this.armedVersion = version
        try {
          const task = await call(VERSION_API.update, { version })
          this.patch({ task })
          this.startPolling()
        } catch (error) {
          this.armedVersion = undefined
          this.patch({ busy: false, error: this.describeError(error) })
        }
      }

      /** Ask for confirmation before restoring a snapshot over the live install. */
      requestRestore = (version) => {
        if (this.snapshot.busy) return
        this.patch({ restoreConfirm: version, error: undefined })
      }

      cancelRestore = () => { this.patch({ restoreConfirm: undefined }) }

      /**
       * Restore the confirmed snapshot. A restore swaps the on-disk tree in
       * seconds and then requires the SAME restart flow as an install — the
       * running process still executes whatever it booted with.
       */
      confirmRestore = async () => {
        const version = this.snapshot.restoreConfirm
        if (version === undefined || this.snapshot.busy) return
        this.patch({ restoreConfirm: undefined, busy: true, error: undefined })
        this.armedVersion = version
        try {
          const result = await call(VERSION_API.restore, { version })
          this.patch({ busy: false, task: result.task ?? { state: 'idle', log: '' } })
          this.adoptTask(result.task)
          void this.check()
        } catch (error) {
          this.armedVersion = undefined
          this.patch({ busy: false, error: this.describeError(error) })
        }
      }

      startPolling() {
        if (this.pollTimer !== undefined) return
        const tick = async () => {
          try {
            const task = await call(VERSION_API.status)
            this.patch({
              task,
              busy: task.state === 'running',
              lastCheck: typeof task.lastCheck === 'object' && task.lastCheck !== null ? task.lastCheck : this.snapshot.lastCheck,
              pendingAuto: typeof task.pendingAuto === 'object' && task.pendingAuto !== null ? task.pendingAuto : undefined,
              history: Array.isArray(task.recent) ? task.recent : this.snapshot.history,
            })
            if (task.state !== 'running') {
              this.stopPolling()
              this.adoptTask(task)
              return
            }
          } catch (error) {
            this.stopPolling()
            this.patch({ busy: false, error: this.describeError(error) })
            return
          }
          this.pollTimer = setTimeout(tick, POLL_MS)
        }
        this.pollTimer = setTimeout(tick, POLL_MS)
      }

      stopPolling() {
        if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
        this.pollTimer = undefined
      }

      /**
       * React to a settled task view. The trigger is `needsRestart`, wider
       * than `stale`: a finished install proves superseded code even when the
       * versions cannot be compared.
       * @param {object | undefined} task - the settled task view.
       */
      adoptTask(task) {
        if (task === undefined) return
        const needsRestart = task.needsRestart ?? task.stale
        if (needsRestart !== true) return
        if (this.snapshot.restarting === true) return
        const target = task.installed ?? task.version ?? this.armedVersion ?? ''
        if (task.restartable !== true) {
          this.overlay.show({
            title: this.t('restart.title'),
            body: this.t('restart.unavailable', { installed: target, running: task.running ?? '' }),
            actions: [{ label: this.t('restart.dismiss'), onClick: () => { this.overlay.hide() } }],
          })
          return
        }
        if (this.armedVersion !== undefined) this.beginCountdown(target)
        else this.offerRestart(target, task.running ?? '')
      }

      /** Offer a restart the user did not trigger from this page. */
      offerRestart(installed, running) {
        this.overlay.show({
          title: this.t('restart.title'),
          body: this.t('restart.staleBody', { installed, running }),
          actions: [
            { label: this.t('restart.later'), onClick: () => { this.overlay.hide() } },
            { label: this.t('restart.now'), primary: true, onClick: () => { void this.restart(installed) } },
          ],
        })
      }

      /** Count down to an automatic restart, cancellable by the user. */
      beginCountdown(version) {
        // A countdown already running wins: a racing check() and restore()
        // response can both land here for the same version.
        if (this.countdownTimer !== undefined) return
        let left = COUNTDOWN_S
        const render = () => {
          this.overlay.show({
            title: this.t('restart.title'),
            body: this.t('restart.countdown', { version, seconds: String(left) }),
            actions: [
              { label: this.t('restart.later'), onClick: () => { this.cancelCountdown() } },
              { label: this.t('restart.now'), primary: true, onClick: () => { this.cancelCountdown(); void this.restart(version) } },
            ],
          })
        }
        const tick = () => {
          left -= 1
          if (left <= 0) {
            this.countdownTimer = undefined
            void this.restart(version)
            return
          }
          render()
          this.countdownTimer = setTimeout(tick, 1000)
        }
        render()
        this.countdownTimer = setTimeout(tick, 1000)
      }

      cancelCountdown() {
        if (this.countdownTimer !== undefined) clearTimeout(this.countdownTimer)
        this.countdownTimer = undefined
        this.armedVersion = undefined
        this.overlay.hide()
        // Disarm the host-side fallback restart so a user who clicked
        // "later" is not overridden when the grace period expires.
        void call(VERSION_API.restartCancel).catch(() => {})
      }

      /** Ask the host to hand its port to a replacement, then wait for it. */
      restart = async (version) => {
        this.cancelCountdown()
        this.patch({ restarting: true })
        this.overlay.show({ title: this.t('restart.title'), body: this.t('restart.pending', { version }) })
        try {
          await call(VERSION_API.restart, {})
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // A refused restart is final; a dropped connection is not — the host
          // may have exited before its response drained.
          if (!/failed to fetch|networkerror|load failed/i.test(message)) {
            this.patch({ restarting: false, error: message })
            this.overlay.show({
              title: this.t('restart.title'),
              body: this.t('restart.failed', { error: message }),
              actions: [{ label: this.t('restart.dismiss'), onClick: () => { this.overlay.hide() } }],
            })
            return
          }
        }
        writeAwaitMarker(version)
        this.awaitReplacement(version)
      }

      /**
       * Probe this origin until the replacement host reports itself stable,
       * then reload onto its fresh assets.
       * @param {string} version - the version being restarted into.
       */
      awaitReplacement(version) {
        if (this.probeTimer !== undefined) return
        this.patch({ restarting: true })
        this.overlay.show({ title: this.t('restart.title'), body: this.t('restart.waiting', { version }) })
        const deadline = Date.now() + PROBE_TIMEOUT_MS
        const tick = async () => {
          let ready = false
          try {
            const task = await call(VERSION_API.status)
            ready = (task.needsRestart ?? task.stale) !== true
          } catch {
            // The host is down or still binding; expected for most of the loop.
          }
          if (ready) {
            this.probeTimer = undefined
            writeAwaitMarker(undefined)
            this.overlay.show({ title: this.t('restart.title'), body: this.t('restart.reload', { version }) })
            this.reload()
            return
          }
          if (Date.now() >= deadline) {
            this.probeTimer = undefined
            writeAwaitMarker(undefined)
            this.patch({ restarting: false })
            this.overlay.show({
              title: this.t('restart.title'),
              body: this.t('restart.timeout', { version }),
              actions: [
                { label: this.t('restart.dismiss'), onClick: () => { this.overlay.hide() } },
                { label: this.t('restart.reloadNow'), primary: true, onClick: () => { this.reload() } },
              ],
            })
            return
          }
          this.probeTimer = setTimeout(tick, PROBE_MS)
        }
        this.probeTimer = setTimeout(tick, PROBE_MS)
      }

      /**
       * Resume a restart this page was already waiting on, or adopt whatever
       * stale state the host reports. Runs even when the panel never opens.
       */
      resume = () => {
        void this.refreshPolicy()
        const pending = readAwaitMarker()
        if (pending !== undefined) {
          this.awaitReplacement(pending)
          return
        }
        void (async () => {
          try {
            this.adoptTask(await call(VERSION_API.status))
          } catch {
            // A host without these routes has nothing to recover from.
          }
        })()
      }

      /** Release notes of one exact version; failure never blocks the card. */
      fetchNotes = async (version) => {
        try {
          const result = await call(`${VERSION_API.notes}?version=${encodeURIComponent(version)}`)
          if (result?.hasNotes !== true || typeof result.notes !== 'string') return undefined
          return {
            text: result.notes,
            ...(typeof result.url === 'string' ? { url: result.url } : {}),
          }
        } catch {
          return undefined
        }
      }

      /** The inject face: the hooks compartment plus plain callbacks. */
      inject = () => ({
        hooks: { versionUpdate: { getSnapshot: this.getSnapshot, subscribe: this.subscribe } },
        check: this.check,
        select: this.select,
        toggleLog: this.toggleLog,
        requestUpdate: this.requestUpdate,
        confirmUpdate: this.confirmUpdate,
        cancelUpdate: this.cancelUpdate,
        requestRestore: this.requestRestore,
        confirmRestore: this.confirmRestore,
        cancelRestore: this.cancelRestore,
        savePolicy: this.savePolicy,
        refreshPolicy: this.refreshPolicy,
        restart: this.restart,
        fetchNotes: this.fetchNotes,
      })

      dispose = () => {
        this.stopPolling()
        if (this.countdownTimer !== undefined) clearTimeout(this.countdownTimer)
        this.countdownTimer = undefined
        if (this.probeTimer !== undefined) clearTimeout(this.probeTimer)
        this.probeTimer = undefined
        if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer)
        this.noticeTimer = undefined
        this.overlay.hide()
      }
    }

    // ------------------------------------------------------------ components

    /**
     * Translate {@link key}, falling back to explicit wording when the
     * dictionaries have no entry for it. The host locale runtime answers an
     * unknown key with the key itself and knows no `defaultValue` option, so
     * without this a dist-tag or trigger the panel has no wording for would
     * render as the literal text `channel.beta`.
     * @param {(key: string, params?: object) => string} t - the bound translator.
     * @param {string} key - the dotted dictionary key.
     * @param {string} fallback - what to show when the key is absent.
     * @param {object} [params] - interpolation params.
     * @returns {string} the translated text, or the fallback.
     */
    function orElse(t, key, fallback, params) {
      const text = t(key, params)
      return text === key ? fallback : text
    }

    /** One label/value line. */
    function Line(props) {
      return h('div', { className: 'dshvu_rowSplit' },
        h('span', { className: 'dshvu_label' }, props.label),
        h('span', { className: 'dshvu_value' }, props.value))
    }

    /** A label above its own full-width filesystem path line. */
    function PathLine(props) {
      return h('div', { className: 'dshvu_pathRow' },
        h('span', { className: 'dshvu_label' }, props.label),
        h('span', { className: 'dshvu_path' }, props.value))
    }

    /** The install log, pinned to its newest line unless the user scrolls up. */
    function LogView(props) {
      const ref = React.useRef(null)
      const pinned = React.useRef(true)
      React.useEffect(() => {
        const node = ref.current
        if (node === null || !pinned.current) return
        node.scrollTop = node.scrollHeight
      }, [props.text])
      return h('pre', {
        ref,
        className: 'dshvu_log',
        tabIndex: 0,
        onScroll: (event) => {
          const node = event.currentTarget
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
        },
      }, props.text)
    }

    /** Release notes of the version awaiting confirmation, read once. */
    function ReleaseNotes(props) {
      const { fetchNotes, version } = props
      const [notes, setNotes] = React.useState(undefined)
      React.useEffect(() => {
        let alive = true
        setNotes(undefined)
        void fetchNotes(version).then((result) => {
          if (alive) setNotes(result)
        })
        return () => { alive = false }
      }, [version])
      if (notes === undefined || notes.text.trim() === '') return null
      return h('div', { className: 'dshvu_notesWrap' },
        h('pre', { className: 'dshvu_log dshvu_notes' }, notes.text),
        notes.url !== undefined
          ? h('a', { className: 'dshvu_notesLink', href: notes.url, target: '_blank', rel: 'noopener noreferrer' }, props.linkLabel)
          : null)
    }

    /**
     * The in-panel confirmation for an install. Rendered inline because the
     * page is still fully alive at this point; the DOM overlay exists for the
     * state AFTER the update, when it may not be.
     */
    function ConfirmCard(props) {
      const { t, version, installed, fetchNotes, onConfirm, onCancel } = props
      const ref = React.useRef(null)
      React.useEffect(() => { ref.current?.focus() }, [])
      const downgrading = isDowngrade(version, installed)
      return h('section', {
        className: 'dshvu_card dshvu_confirm',
        role: 'group',
        'aria-label': downgrading ? t('confirm.downgradeTitle') : t('confirm.title'),
      },
        h('h3', { className: 'dshvu_title' }, downgrading ? t('confirm.downgradeTitle') : t('confirm.title')),
        h('p', { className: 'dshvu_confirmBody' }, downgrading
          ? t('confirm.downgradeBody', { version, installed: installed ?? t('unknown') })
          : t('confirm.body', { version, installed: installed ?? t('unknown') })),
        fetchNotes !== undefined
          ? h(ReleaseNotes, { fetchNotes, version, linkLabel: t('notes.link') })
          : null,
        h('p', { className: 'dshvu_warn' }, t('confirm.impact')),
        h('div', { className: 'dshvu_row dshvu_confirmActions' },
          h('button', { type: 'button', className: 'dshvu_btn', onClick: onCancel }, t('confirm.cancel')),
          h('button', {
            ref,
            type: 'button',
            className: 'dshvu_btn dshvu_btnPrimary',
            onClick: () => { void onConfirm() },
          }, downgrading ? t('confirm.proceedDowngrade', { version }) : t('confirm.proceed', { version }))))
    }

    /** Same shape as ConfirmCard, for restoring a snapshot over the live tree. */
    function RestoreConfirmCard(props) {
      const { t, version, onConfirm, onCancel } = props
      const ref = React.useRef(null)
      React.useEffect(() => { ref.current?.focus() }, [])
      return h('section', {
        className: 'dshvu_card dshvu_confirm',
        role: 'group',
        'aria-label': t('restoreConfirm.title'),
      },
        h('h3', { className: 'dshvu_title' }, t('restoreConfirm.title')),
        h('p', { className: 'dshvu_confirmBody' }, t('restoreConfirm.body', { version })),
        h('p', { className: 'dshvu_warn' }, t('restoreConfirm.impact')),
        h('div', { className: 'dshvu_row dshvu_confirmActions' },
          h('button', { type: 'button', className: 'dshvu_btn', onClick: onCancel }, t('confirm.cancel')),
          h('button', {
            ref,
            type: 'button',
            className: 'dshvu_btn dshvu_btnPrimary',
            onClick: () => { void onConfirm() },
          }, t('restoreConfirm.proceed', { version }))))
    }

    /** One labelled policy control row: label, control, optional hint below. */
    function Field(props) {
      return h('div', { className: 'dshvu_field' },
        h('div', { className: 'dshvu_fieldHead' },
          h('span', { className: 'dshvu_fieldLabel' }, props.label),
          props.control),
        props.hint !== undefined ? h('span', { className: 'dshvu_hint', style: { margin: 0 } }, props.hint) : null)
    }

    /** A styled `<select>` with its arrow wrapper. */
    function Select(props) {
      return h('span', { className: 'dshvu_selectWrap' },
        h('select', {
          className: 'dshvu_select',
          value: props.value,
          disabled: props.disabled === true,
          onChange: (event) => { props.onChange(event.currentTarget.value) },
        }, props.options.map(option =>
          h('option', { key: option.value, value: option.value }, option.label))))
    }

    /**
     * The policy form. Every control edits a LOCAL draft; one explicit save
     * submits the whole draft, so half-finished edits never reach the host,
     * and the host's normalized reply replaces the draft wholesale.
     */
    function PolicyCard(props) {
      const { t, policy, saving, error, notice, onSave, onRefresh } = props
      const [draft, setDraft] = React.useState(policy)
      React.useEffect(() => { setDraft(policy) }, [policy])
      const patch = (next) => { setDraft(current => ({ ...current, ...next })) }
      const trackKind = draft.track.kind
      const autoMode = draft.mode === 'auto'
      // The suggested line when switching tracking kinds: the caret range that
      // names the installed version's own line under caret semantics.
      const suggestedLine = (() => {
        const parsed = parseVersionParts(props.installed ?? '')
        if (parsed === undefined) return '^1.0.0'
        const [major, minor] = parsed.core
        return major > 0 ? `^${major}.0.0` : `^${major}.${minor}.0`
      })()

      const modeOptions = ['off', 'notify', 'auto'].map(mode => ({ value: mode, label: t(`policy.mode.${mode}`) }))
      const kindOptions = ['tag', 'line', 'pin'].map(kind => ({ value: kind, label: t(`policy.track.${kind}`) }))
      const restartOptions = ['ask', 'auto'].map(mode => ({ value: mode, label: t(`policy.restart.${mode}`) }))
      const knownTag = typeof draft.track.tag === 'string' && ['latest', 'next'].includes(draft.track.tag)

      return h('section', { className: 'dshvu_card' },
        h('h3', { className: 'dshvu_title' },
          t('policy.title'),
          h('button', {
            type: 'button',
            className: 'dshvu_btn',
            style: { fontWeight: 400 },
            disabled: saving,
            onClick: () => { void onRefresh() },
          }, t('policy.reset'))),
        h(Field, {
          label: t('policy.mode.label'),
          hint: t(`policy.mode.hint.${draft.mode}`),
          control: h(Select, {
            value: draft.mode,
            options: modeOptions,
            disabled: saving,
            onChange: (mode) => { patch({ mode }) },
          }),
        }),
        h(Field, {
          label: t('policy.track.label'),
          hint: trackKind === 'pin'
            ? t('policy.track.hint.pin')
            : trackKind === 'line' ? t('policy.track.hint.line') : t('policy.track.hint.tag'),
          control: h('span', { className: 'dshvu_row' },
            h(Select, {
              value: trackKind,
              options: kindOptions,
              disabled: saving,
              onChange: (kind) => {
                patch({
                  track: kind === 'tag' ? { kind, tag: 'latest' }
                    : kind === 'line' ? { kind, range: suggestedLine }
                    : { kind },
                })
              },
            }),
            trackKind === 'tag'
              ? h(Select, {
                value: knownTag ? /** @type {string} */ (draft.track.tag) : 'custom',
                options: [
                  { value: 'latest', label: orElse(t, 'channel.latest', 'latest') },
                  { value: 'next', label: orElse(t, 'channel.next', 'next') },
                  { value: 'custom', label: t('policy.track.customTag') },
                ],
                disabled: saving,
                onChange: (tag) => {
                  if (tag !== 'custom') patch({ track: { kind: 'tag', tag } })
                  else if (knownTag) patch({ track: { kind: 'tag', tag: '' } })
                },
              })
              : null,
            trackKind === 'tag' && !knownTag
              ? h('input', {
                className: 'dshvu_input',
                style: { width: 140 },
                value: String(draft.track.tag ?? ''),
                placeholder: t('policy.track.tagPlaceholder'),
                disabled: saving,
                onChange: (event) => { patch({ track: { kind: 'tag', tag: event.currentTarget.value } }) },
              })
              : null,
            trackKind === 'line'
              ? h('input', {
                className: 'dshvu_input',
                style: { width: 140 },
                value: String(draft.track.range ?? ''),
                placeholder: '^1.2.3',
                disabled: saving,
                onChange: (event) => { patch({ track: { kind: 'line', range: event.currentTarget.value } }) },
              })
              : null),
        }),
        h(Field, {
          label: t('policy.window.label'),
          hint: t('policy.window.hint'),
          control: h('span', { className: 'dshvu_row' },
            h('input', {
              type: 'time',
              className: 'dshvu_input',
              value: draft.window === null ? '' : String(draft.window.start),
              disabled: saving || !autoMode,
              onChange: (event) => {
                const start = event.currentTarget.value
                patch({ window: start === '' ? null : { start, end: draft.window === null ? start : draft.window.end } })
              },
            }),
            h('span', { className: 'dshvu_label' }, '–'),
            h('input', {
              type: 'time',
              className: 'dshvu_input',
              value: draft.window === null ? '' : String(draft.window.end),
              disabled: saving || !autoMode,
              onChange: (event) => {
                const end = event.currentTarget.value
                patch({ window: end === '' ? null : { start: draft.window === null ? end : draft.window.start, end } })
              },
            })),
        }),
        h(Field, {
          label: t('policy.restart.label'),
          hint: t(`policy.restart.hint.${draft.restart}`),
          control: h(Select, {
            value: draft.restart,
            options: restartOptions,
            disabled: saving,
            onChange: (restart) => { patch({ restart }) },
          }),
        }),
        h(Field, {
          label: t('policy.checkAt.label'),
          hint: t('policy.checkAt.hint'),
          control: h('span', { className: 'dshvu_row' },
            h('input', {
              type: 'time',
              className: 'dshvu_input',
              value: draft.checkAt === null ? '' : String(draft.checkAt),
              disabled: saving,
              onChange: (event) => { patch({ checkAt: event.currentTarget.value === '' ? null : event.currentTarget.value }) },
            }),
            draft.nextCheckHint !== undefined
              ? h('span', { className: 'dshvu_hint', style: { margin: 0 } }, draft.nextCheckHint)
              : null),
        }),
        error !== undefined ? h('p', { className: 'dshvu_error' }, error) : null,
        notice !== undefined ? h('p', { className: notice.kind === 'ok' ? 'dshvu_ok' : 'dshvu_error', style: { margin: '8px 0 0' } }, notice.text) : null,
        h('div', { className: 'dshvu_row dshvu_sep', style: { justifyContent: 'flex-end' } },
          h('button', {
            type: 'button',
            className: 'dshvu_btn dshvu_btnPrimary',
            disabled: saving,
            onClick: () => { void onSave(draft) },
          }, saving ? t('policy.saving') : t('policy.save'))))
    }

    /**
     * The version-update settings page: status, policy, versions, task,
     * snapshots, and recent activity.
     */
    function VersionUpdateSection(props) {
      const {
        t, useVersionUpdate, check, select, toggleLog,
        requestUpdate, confirmUpdate, cancelUpdate,
        requestRestore, confirmRestore, cancelRestore,
        savePolicy, refreshPolicy, restart, fetchNotes,
      } = props
      const state = useVersionUpdate(s => s)
      // Bumping this state re-renders the page; the running task's elapsed
      // clock uses it to tick once a second.
      const [forceRender, setForceRender] = React.useState(0)

      React.useEffect(() => {
        if (state.status === 'idle') void check()
      }, [])

      const loading = state.status === 'loading'
      const running = state.task.state === 'running' || state.busy
      const needsRestart = (state.task.needsRestart ?? state.task.stale) === true
      const ahead = state.channels.filter(c => c.ahead)

      const fmtTime = (ms) => {
        try {
          return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
        } catch {
          return ''
        }
      }

      let verdict
      if (state.status === 'ready' && state.installed !== undefined) {
        verdict = ahead.length > 0
          ? t('available', { version: ahead[0].version })
          : t('upToDate')
      }

      let taskLine
      if (state.task.state === 'running') {
        taskLine = t('task.running', { version: state.task.version ?? '' })
      } else if (state.task.state === 'done') {
        taskLine = t('task.done', { version: state.task.version ?? '' })
      } else if (state.task.state === 'failed') {
        taskLine = t('task.failed', { error: state.task.error ?? '' })
      }

      // The running label carries a live elapsed counter: a 1 Hz re-render
      // turns the wait into visible movement even while both the snapshot
      // copy and npm stay quiet.
      const runningLabel = (task) => {
        const base = t('task.following')
        const startedAt = typeof task.startedAt === 'number' ? task.startedAt : undefined
        if (startedAt === undefined) return base
        const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
        const clock = seconds < 60
          ? `${seconds}s`
          : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
        return `${base} · ${clock}`
      }
      React.useEffect(() => {
        if (state.task.state !== 'running') return
        const timer = setInterval(() => { setForceRender(x => x + 1) }, 1000)
        return () => { clearInterval(timer) }
      }, [state.task.state, state.task.startedAt])

      // What the last cycle concluded, as one quiet line under the verdict.
      const lastCheckLine = (() => {
        const lastCheck = state.lastCheck ?? {}
        if (typeof lastCheck.error === 'string') return t('lastCheck.error', { error: lastCheck.error })
        if (lastCheck.at === undefined) return undefined
        const base = t('lastCheck.at', { time: fmtTime(lastCheck.at) })
        if (typeof lastCheck.target === 'string') return `${base} · ${t('lastCheck.target', { version: lastCheck.target })}`
        return `${base} · ${t(lastCheck.updateAvailable === true ? 'lastCheck.ahead' : 'lastCheck.current')}`
      })()

      return h('div', { className: 'dshvu_page' },

        // ---- current installation ----
        h('section', { className: 'dshvu_card' },
          h('h3', { className: 'dshvu_title' }, t('title')),
          h(Line, { label: t('installed'), value: state.installed ?? t('unknown') }),
          needsRestart && state.task.running !== undefined
            ? h(Line, { label: t('running'), value: state.task.running })
            : null,
          state.installDir !== undefined
            ? h(PathLine, { label: t('installDir'), value: state.installDir })
            : null,
          verdict !== undefined ? h('p', { className: 'dshvu_hint' }, verdict) : null,
          lastCheckLine !== undefined ? h('p', { className: 'dshvu_hint' }, lastCheckLine) : null,
          state.status === 'ready' && state.publishedError !== undefined
            ? h('p', { className: 'dshvu_warn' }, t('publishFailed', { error: state.publishedError }))
            : null,
          state.pendingAuto !== undefined
            ? h('p', { className: 'dshvu_warn' }, t('pendingAuto', { version: state.pendingAuto.target }))
            : null,
          needsRestart
            ? h('p', { className: 'dshvu_warn' }, state.task.restartable === true
              ? t('restart.staleBody', { installed: state.installed ?? '', running: state.task.running ?? '' })
              : t('restart.unavailable', { installed: state.installed ?? '', running: state.task.running ?? '' }))
            : null,
          h('div', { className: 'dshvu_row dshvu_sep' },
            h('button', {
              type: 'button',
              className: 'dshvu_btn',
              disabled: loading,
              onClick: () => { void check({ prompt: true }) },
            }, loading ? t('checking') : t('check')),
            loading ? h('span', { className: 'dshvu_spinner', 'aria-label': t('checking') }) : null),
          state.status === 'error'
            ? h('p', { className: 'dshvu_error' }, t('loadFailed', { error: state.error ?? '' }))
            : null),

        // ---- update policy ----
        h(PolicyCard, {
          t,
          installed: state.installed,
          policy: { ...(state.policy ?? EMPTY_POLICY), nextCheckHint: state.nextCheckAt !== undefined ? t('policy.nextCheck', { time: fmtTime(state.nextCheckAt) }) : undefined },
          saving: state.savingPolicy === true,
          error: state.policyError,
          notice: state.policyNotice,
          onSave: savePolicy,
          onRefresh: refreshPolicy,
        }),

        // ---- install targets ----
        h('section', { className: 'dshvu_card' },
          h('h3', { className: 'dshvu_title' }, t('versions.title')),
          h('ul', { className: 'dshvu_list' },
            state.channels.map(channel => h('li', { key: channel.channel, className: 'dshvu_item' },
              h('span', { className: 'dshvu_chanName' }, orElse(t, `channel.${channel.channel}`, channel.channel)),
              h('span', { className: 'dshvu_itemMain' },
                h('span', { className: 'dshvu_chanVersion' }, channel.version), ' ',
                channel.version === state.installed
                  ? h('span', { className: 'dshvu_badge dshvu_badgeCurrent' }, t('badge.current'))
                  : channel.ahead === true
                    ? h('span', { className: 'dshvu_badge dshvu_badgeAhead' }, t('badge.ahead'))
                    : null),
              channel.version !== state.installed
                ? h('span', { className: 'dshvu_itemAction' },
                  h('button', {
                    type: 'button',
                    className: 'dshvu_btn',
                    disabled: running,
                    onClick: () => { requestUpdate(channel.version) },
                  }, isDowngrade(channel.version, state.installed) ? t('install.downgrade') : t('install')))
                : null))),
          state.selected !== undefined
            ? h('div', { className: 'dshvu_row dshvu_sep' },
              h('span', { className: 'dshvu_label' }, t('pick')),
              h('span', { className: 'dshvu_selectWrap' },
                h('select', {
                  className: 'dshvu_select',
                  value: state.selected,
                  onChange: (event) => { select(event.currentTarget.value) },
                }, state.versions.map(version => h('option', { key: version, value: version }, version)))),
              h('button', {
                type: 'button',
                className: 'dshvu_btn',
                disabled: running,
                onClick: () => { requestUpdate(state.selected) },
              }, isDowngrade(state.selected, state.installed) ? t('install.downgradeTo', { version: state.selected }) : t('installTo', { version: state.selected })))
            : null),

        // ---- running / last task ----
        taskLine !== undefined || state.task.log
          ? h('section', { className: 'dshvu_card' },
            h('h3', { className: 'dshvu_title' }, t('task.title')),
            taskLine !== undefined ? h('p', { className: 'dshvu_hint', style: { margin: 0 } }, taskLine) : null,
            h('div', { className: 'dshvu_row', style: { marginTop: 10 } },
              h('button', {
                type: 'button',
                className: 'dshvu_btn',
                onClick: () => { toggleLog() },
              }, state.showLog === true ? t('task.hideLog') : t('task.showLog')),
              state.task.state === 'running' ? h('span', { className: 'dshvu_spin' }, runningLabel(state.task)) : null,
              needsRestart && state.task.restartable === true && state.restarting !== true
                ? h('button', {
                  type: 'button',
                  className: 'dshvu_btn dshvu_btnPrimary',
                  onClick: () => { void restart(state.installed ?? '') },
                }, t('restart.now'))
                : null),
            state.showLog === true || state.task.state === 'running'
              ? h(LogView, { text: state.task.log ?? '' })
              : null)
          : null,

        // ---- snapshot center ----
        h('section', { className: 'dshvu_card' },
          h('h3', { className: 'dshvu_title' }, t('snapshots.title')),
          h('p', { className: 'dshvu_hint', style: { margin: '0 0 4px' } }, t('snapshots.hint')),
          state.snapshots.length === 0
            ? h('p', { className: 'dshvu_hint' }, t('snapshots.empty'))
            : h('ul', { className: 'dshvu_list' },
              state.snapshots.map(entry => h('li', { key: entry.version, className: 'dshvu_item' },
                h('span', { className: 'dshvu_chanVersion' }, entry.version),
                h('span', { className: 'dshvu_itemMain' },
                  entry.at !== undefined ? fmtTime(entry.at) : '',
                  entry.usable === false ? ` · ${t('snapshots.unusable')}` : '',
                  entry.version === state.installed ? ` · ${t('badge.current')}` : ''),
                entry.usable !== false && entry.version !== state.installed
                  ? h('span', { className: 'dshvu_itemAction' },
                    h('button', {
                      type: 'button',
                      className: 'dshvu_btn',
                      disabled: running,
                      onClick: () => { requestRestore(entry.version) },
                    }, t('snapshots.restore')))
                  : null)))),

        // ---- recent activity ----
        state.history.length > 0
          ? h('section', { className: 'dshvu_card' },
            h('h3', { className: 'dshvu_title' }, t('history.title')),
            h('ul', { className: 'dshvu_list' },
              state.history.map((entry, index) => h('li', { key: `${entry.at}-${index}`, className: 'dshvu_item' },
                h('span', { className: 'dshvu_chanVersion' }, entry.to),
                h('span', { className: 'dshvu_itemMain' },
                  `${fmtTime(entry.at)}${entry.from !== undefined ? ` · ${entry.from} → ${entry.to}` : ''}${typeof entry.trigger === 'string' ? ` · ${orElse(t, `history.trigger.${entry.trigger}`, entry.trigger)}` : ''}${entry.restored === true ? ` · ${t('history.restored')}` : ''}`),
                h('span', {
                  className: `dshvu_badge ${entry.result === 'ok' ? 'dshvu_badgeOk' : 'dshvu_badgeAhead'}`,
                  style: entry.result === 'ok' ? undefined : { background: 'var(--dsw-alias-state-error-bg)' },
                }, orElse(t, `history.result.${entry.result}`, entry.result))))))
          : null,

        state.confirm !== undefined
          ? h(ConfirmCard, {
            t,
            version: state.confirm,
            installed: state.installed,
            fetchNotes,
            onConfirm: confirmUpdate,
            onCancel: cancelUpdate,
          })
          : null,

        state.restoreConfirm !== undefined
          ? h(RestoreConfirmCard, {
            t,
            version: state.restoreConfirm,
            onConfirm: confirmRestore,
            onCancel: cancelRestore,
          })
          : null)
    }

    // ----------------------------------------------------------- dictionaries

    /*
     * FLAT dotted keys only. The host locale runtime looks a key up as one
     * whole string (`dict[key]`), so a nested object under `policy` would
     * leave `t('policy.title')` unresolved and the panel would render the key
     * itself. Every key the UI asks for must exist here verbatim.
     */

    const zh = {
      'nav': '版本更新',
      'notMounted': '宿主路由尚未挂载：插件已安装，但需要重启一次 dsh web 才能生效。',
      'title': '当前安装',
      'installed': '安装版本',
      'running': '运行中版本',
      'installDir': '安装目录',
      'unknown': '未知',
      'upToDate': '已是最新版本。',
      'available': '发现新版本 {version}。',
      'checking': '检查中…',
      'check': '检查更新',
      'loadFailed': '加载失败：{error}',
      'publishFailed': '无法读取 registry 的发布信息：{error}。本机信息仍然有效。',
      'pick': '任选一个历史版本：',
      'install': '安装',
      'installTo': '安装 {version}',
      'install.downgrade': '降级',
      'install.downgradeTo': '降级到 {version}',
      'badge.current': '当前',
      'badge.ahead': '有更新',
      'channel.latest': 'latest 稳定通道',
      'channel.next': 'next 预发布通道',
      'versions.title': '可用版本',
      'confirm.title': '确认安装',
      'confirm.downgradeTitle': '确认降级',
      'confirm.body': '即将把 @deepseek-ai/dsh 安装到 {version}（当前 {installed}）。安装前会自动为本机当前版本创建回滚快照。',
      'confirm.downgradeBody': '即将把 @deepseek-ai/dsh 降级到 {version}（当前 {installed}）。安装前会自动创建当前版本的回滚快照。',
      'confirm.impact': '该操作会改写本机全局 npm 包；完成后将重启 dsh 宿主进程并重新载入页面。',
      'confirm.proceed': '安装 {version}',
      'confirm.proceedDowngrade': '降级到 {version}',
      'confirm.cancel': '取消',
      'restoreConfirm.title': '确认恢复快照',
      'restoreConfirm.body': '将从本地快照把 @deepseek-ai/dsh 恢复到 {version}。恢复不联网、通常数秒完成。',
      'restoreConfirm.impact': '恢复会直接覆盖磁盘上的现有安装；完成后同样需要重启宿主进程才能生效。',
      'restoreConfirm.proceed': '恢复到 {version}',
      'policy.title': '更新策略',
      'policy.reset': '放弃修改',
      'policy.save': '保存策略',
      'policy.saving': '保存中…',
      'policy.saved': '策略已保存',
      'policy.nextCheck': '下次自动检查 {time}',
      'policy.mode.label': '自动模式',
      'policy.mode.off': '关闭',
      'policy.mode.notify': '仅提醒',
      'policy.mode.auto': '静默自动更新',
      'policy.mode.hint.off': '只在面板里显示可用更新，不做任何自动动作。',
      'policy.mode.hint.notify': '发现新版本时在面板显著提示，仍需手动确认安装。',
      'policy.mode.hint.auto': '发现新版本后自动安装并按下方设置处理重启，无需人工确认。',
      'policy.track.label': '跟踪目标',
      'policy.track.tag': '跟随 dist-tag',
      'policy.track.line': '跟随版本线',
      'policy.track.pin': '固定当前',
      'policy.track.hint.tag': '始终跟随所选 dist-tag 指向的最新发布。',
      'policy.track.hint.line': '只接受 ^ 或 ~ 版本线内的稳定版（如 ^0.4.0 表示 0.4.x 的最新版）。',
      'policy.track.hint.pin': '不跟踪任何目标；只有手动选择才会改变版本。',
      'policy.track.customTag': '自定义…',
      'policy.track.tagPlaceholder': '输入 dist-tag',
      'policy.restart.label': '安装完成后',
      'policy.restart.ask': '询问我是否重启（倒计时 20 秒）',
      'policy.restart.auto': '自动重启宿主（无人值守）',
      'policy.restart.hint.ask': '安装结束后弹出可取消的重启倒计时。',
      'policy.restart.hint.auto': '静默更新完成后约 10 秒自动重启宿主进程。',
      'policy.window.label': '执行时间窗',
      'policy.window.hint': '仅在「静默自动更新」模式下生效：只允许在该本地时间段内开始自动安装。留空表示任何时间。起止相同表示全天；结束早于起始表示跨午夜。',
      'policy.checkAt.label': '每日定时检查',
      'policy.checkAt.hint': '每天在此时刻后台检查一次更新。留空表示不定时检查。',
      'task.title': '安装任务',
      'task.running': '正在安装 {version}…',
      'task.done': '{version} 安装完成。',
      'task.failed': '安装失败：{error}',
      'task.showLog': '查看安装日志',
      'task.hideLog': '收起日志',
      'task.following': '正在跟随输出…',
      'snapshots.title': '快照与回滚',
      'snapshots.hint': '每次安装前会自动备份当前版本。从快照恢复不依赖网络，通常数秒完成。',
      'snapshots.empty': '还没有快照。首次安装或手动更新后这里会出现可回滚的版本。',
      'snapshots.restore': '恢复此版本',
      'snapshots.unusable': '快照不可用',
      'history.title': '最近活动',
      'history.restored': '快照恢复',
      'history.trigger.manual': '手动',
      'history.trigger.auto': '自动',
      'history.trigger.scheduled': '计划',
      'history.result.ok': '成功',
      'history.result.failed': '失败',
      'lastCheck.at': '上次检查 {time}',
      'lastCheck.ahead': '有可用更新',
      'lastCheck.current': '已是最新',
      'lastCheck.target': '目标 {version}',
      'lastCheck.error': '检查失败：{error}',
      'pendingAuto': '已发现新版本 {version}，等待进入执行时间窗后自动安装。',
      'restart.title': '重启 dsh 宿主',
      'restart.staleBody': '磁盘上已是 {installed}，而运行中的进程仍是 {running}。重启后新版本生效，页面资源也会随之更新。',
      'restart.unavailable': '需要重启（磁盘 {installed}/运行 {running}），但当前环境不支持自动重启，请在终端手动操作。',
      'restart.countdown': '将在 {seconds} 秒后重启到 {version}。重启会结束当前所有会话与后台任务。',
      'restart.pending': '正在交接端口并退出旧进程…',
      'restart.waiting': '旧进程已退出，正在等待新进程就绪（{version}）…',
      'restart.reload': '{version} 已就绪，正在重新载入页面…',
      'restart.timeout': '等待新进程超时（{version}）。请检查终端，或重新运行 dsh web。',
      'restart.failed': '自动重启失败：{error}。请自行停止并启动 dsh web。',
      'restart.now': '立即重启',
      'restart.later': '稍后',
      'restart.dismiss': '知道了',
      'restart.reloadNow': '仍然刷新',
      'restart.pendingShort': '重启中…',
      'notes.link': '查看完整发布说明',
    }

    const en = {
      'nav': 'Version Update',
      'notMounted': 'Host routes not mounted: the plugin is installed, but dsh web needs one restart to serve them.',
      'title': 'Current installation',
      'installed': 'Installed',
      'running': 'Running',
      'installDir': 'Install directory',
      'unknown': 'unknown',
      'upToDate': 'Up to date.',
      'available': 'New version available: {version}.',
      'checking': 'Checking…',
      'check': 'Check for updates',
      'loadFailed': 'Failed to load: {error}',
      'publishFailed': 'Could not read the registry: {error}. Local facts remain valid.',
      'pick': 'Pick any published version:',
      'install': 'Install',
      'installTo': 'Install {version}',
      'install.downgrade': 'Downgrade',
      'install.downgradeTo': 'Downgrade to {version}',
      'badge.current': 'current',
      'badge.ahead': 'update',
      'channel.latest': 'latest (stable)',
      'channel.next': 'next (pre-release)',
      'versions.title': 'Available versions',
      'confirm.title': 'Confirm install',
      'confirm.downgradeTitle': 'Confirm downgrade',
      'confirm.body': 'This installs @deepseek-ai/dsh {version} (currently {installed}). A rollback snapshot of the current version is taken automatically first.',
      'confirm.downgradeBody': 'This downgrades @deepseek-ai/dsh to {version} (currently {installed}). A rollback snapshot is taken automatically first.',
      'confirm.impact': 'The operation rewrites this machine\'s global npm package; afterwards the dsh host process restarts and this page reloads.',
      'confirm.proceed': 'Install {version}',
      'confirm.proceedDowngrade': 'Downgrade to {version}',
      'confirm.cancel': 'Cancel',
      'restoreConfirm.title': 'Confirm snapshot restore',
      'restoreConfirm.body': 'This restores @deepseek-ai/dsh to {version} from the local snapshot. No network needed; usually a matter of seconds.',
      'restoreConfirm.impact': 'Restoring overwrites the installation currently on disk; a host restart is required afterwards.',
      'restoreConfirm.proceed': 'Restore {version}',
      'policy.title': 'Update policy',
      'policy.reset': 'Discard changes',
      'policy.save': 'Save policy',
      'policy.saving': 'Saving…',
      'policy.saved': 'Policy saved',
      'policy.nextCheck': 'Next automatic check {time}',
      'policy.mode.label': 'Automation',
      'policy.mode.off': 'Off',
      'policy.mode.notify': 'Notify only',
      'policy.mode.auto': 'Silent auto-update',
      'policy.mode.hint.off': 'Only surface updates in the panel; nothing runs on its own.',
      'policy.mode.hint.notify': 'Highlight discoveries in the panel; installs stay manual.',
      'policy.mode.hint.auto': 'Found versions install automatically and restart per the setting below.',
      'policy.track.label': 'Tracking',
      'policy.track.tag': 'Follow dist-tag',
      'policy.track.line': 'Follow a version line',
      'policy.track.pin': 'Pinned',
      'policy.track.hint.tag': 'Always follow what the chosen dist-tag points at.',
      'policy.track.hint.line': 'Accept only stable releases within a caret/tilde line (e.g. ^0.4.0 — newest 0.4.x).',
      'policy.track.hint.pin': 'Track nothing; only an explicit choice changes the version.',
      'policy.track.customTag': 'Custom…',
      'policy.track.tagPlaceholder': 'dist-tag',
      'policy.restart.label': 'After install',
      'policy.restart.ask': 'Ask me to restart (20 s countdown)',
      'policy.restart.auto': 'Restart automatically (unattended)',
      'policy.restart.hint.ask': 'A cancellable countdown appears when an install settles.',
      'policy.restart.hint.auto': 'Silent installs restart the host after roughly ten seconds.',
      'policy.window.label': 'Execution window',
      'policy.window.hint': 'Applies to silent auto-update: automatic installs may only START inside this local time span. Empty means anytime. Equal bounds mean all day; end before start wraps past midnight.',
      'policy.checkAt.label': 'Daily check at',
      'policy.checkAt.hint': 'Run one background check every day at this time. Empty disables the schedule.',
      'task.title': 'Install task',
      'task.running': 'Installing {version}…',
      'task.done': '{version} installed.',
      'task.failed': 'Install failed: {error}',
      'task.showLog': 'Show install log',
      'task.hideLog': 'Hide log',
      'task.following': 'following output…',
      'snapshots.title': 'Snapshots & rollback',
      'snapshots.hint': 'Every install backs up the previous version first. Restoring a snapshot needs no network and takes seconds.',
      'snapshots.empty': 'No snapshots yet. One appears here after the first install or manual update.',
      'snapshots.restore': 'Restore',
      'snapshots.unusable': 'unusable',
      'history.title': 'Recent activity',
      'history.restored': 'snapshot restore',
      'history.trigger.manual': 'manual',
      'history.trigger.auto': 'auto',
      'history.trigger.scheduled': 'scheduled',
      'history.result.ok': 'ok',
      'history.result.failed': 'failed',
      'lastCheck.at': 'Last check {time}',
      'lastCheck.ahead': 'update available',
      'lastCheck.current': 'up to date',
      'lastCheck.target': 'target {version}',
      'lastCheck.error': 'Check failed: {error}',
      'pendingAuto': 'Found {version}; the silent install starts once the execution window opens.',
      'restart.title': 'Restart the dsh host',
      'restart.staleBody': 'Disk holds {installed} while the running process is {running}. Restarting activates the new version and refreshes this page\'s assets.',
      'restart.unavailable': 'A restart is required (disk {installed}/running {running}), but this environment cannot restart automatically — please do it from a terminal.',
      'restart.countdown': 'Restarting into {version} in {seconds}s. This ends every session and background job on the host.',
      'restart.pending': 'Handing the port over and exiting the old process…',
      'restart.waiting': 'Old process exited; waiting for the replacement ({version})…',
      'restart.reload': '{version} is ready — reloading…',
      'restart.timeout': 'Timed out waiting for the replacement ({version}). Check the terminal, or run dsh web again.',
      'restart.failed': 'Automatic restart failed: {error}. Stop and start dsh web yourself.',
      'restart.now': 'Restart now',
      'restart.later': 'Later',
      'restart.dismiss': 'Got it',
      'restart.reloadNow': 'Reload anyway',
      'restart.pendingShort': 'Restarting…',
      'notes.link': 'Full release notes',
    }

    // ---------------------------------------------------------------- plugin

    const inject = ['slots', 'locale']

    /**
     * Register the 版本更新 settings page: dictionaries, the settings.section
     * entry, the nav glyph marker, the stylesheet, and the restart watchdog.
     *
     * The controller belongs to the plugin fiber rather than the slot
     * registration: an update rewrites every harness client bundle, the host's
     * watcher hot-swaps them, and the settings UI goes away with them. The
     * watchdog has to outlive that to reload the page onto the new version.
     * @param {object} ctx - client plugin context carrying slots and locale.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'version-update: dictionaries')
      ctx.effect(() => installStyles(), 'version-update: stylesheet')

      const controller = new VersionUpdateController({ t: ctx.locale.bind(NS) })
      ctx.effect(() => {
        controller.resume()
        return () => { controller.dispose() }
      }, 'version-update: restart watchdog')

      ctx.effect(() => markNavRow(() => ctx.locale.bind(NS)('nav')), 'version-update: nav glyph')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'version-update',
        order: 140,
        label: () => ctx.locale.bind(NS)('nav'),
        locale: NS,
        inject: () => controller.inject(),
      }, VersionUpdateSection))
    }

    /**
     * Keep {@link NAV_MARKER} on the settings-nav button whose visible text is
     * this plugin's localized section label — the shell projects no icon field,
     * so the stylesheet swaps the fallback gear for the update glyph above.
     * The observer watches the whole body but coalesces bursts into one frame.
     * @param {() => string} label - the locale-aware label resolver.
     * @returns {() => void} disposer clearing the observer and every marker.
     */
    function markNavRow(label) {
      if (typeof document === 'undefined') return () => {}
      let disposed = false
      let frame
      const sync = () => {
        if (disposed) return
        const current = label().trim()
        for (const button of document.querySelectorAll('[role="dialog"] nav button')) {
          if (current.length > 0 && button.textContent?.trim() === current) {
            button.setAttribute(NAV_MARKER, '')
          } else {
            button.removeAttribute(NAV_MARKER)
          }
        }
      }
      const schedule = () => {
        if (disposed || frame !== undefined) return
        const raf = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (fn) => setTimeout(fn, 16)
        frame = raf(() => {
          frame = undefined
          sync()
        })
      }
      sync()
      const observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      return () => {
        disposed = true
        if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
        frame = undefined
        observer.disconnect()
        for (const marked of document.querySelectorAll(`[${NAV_MARKER}]`)) {
          marked.removeAttribute(NAV_MARKER)
        }
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.createController = (deps) => new VersionUpdateController(deps)
    // Exported for tests: the browser ranking is a hand-maintained mirror of
    // lib/core.js, and a test walks both through the same version matrix so
    // the copies cannot silently disagree.
    exports.compareVersionTexts = compareVersionTexts
    exports.isDowngrade = isDowngrade
    // Exported for tests: the host locale runtime resolves a key as one whole
    // string, so a test walks every key the panel asks for against both
    // dictionaries to keep them flat and complete.
    exports.dictionaries = { zh, en }
    return module.exports
  },
})

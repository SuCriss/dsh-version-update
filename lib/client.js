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
      notes: '/api/dsh-version-update/notes',
      policy: '/api/dsh-version-update/policy',
      snapshots: '/api/dsh-version-update/snapshots',
      restore: '/api/dsh-version-update/restore',
      snapshotDelete: '/api/dsh-version-update/snapshots/delete',
      checkRun: '/api/dsh-version-update/check/run',
      checkAuto: '/api/dsh-version-update/check/auto',
      restartDiagnostics: '/api/dsh-version-update/restart/diagnostics',
      pendingCancel: '/api/dsh-version-update/pending/cancel',
      preflight: '/api/dsh-version-update/preflight',
      operations: '/api/dsh-version-update/operations',
    }

    /** Dictionary namespace and settings-section id owned by this plugin. */
    const NS = 'version-update'

    /**
     * Install sources the panel may ask for, mirroring lib/protocol.js
     * INSTALL_SOURCES. The host refuses anything else, and the URLs behind
     * these IDs are host-side config — a page can pick a source, never a
     * registry address.
     */
    const INSTALL_SOURCES = ['auto', 'official', 'mirror']

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
      checkAt: null,
    })

    /**
     * How long a panel request may hang before it is given up on. During a
     * restart this is not an edge case: the host disappears mid-flight, and a
     * fetch the browser never resolves would leave the state machine waiting on
     * a page that has nothing left to answer it.
     */
    const REQUEST_TIMEOUT_MS = 15000

    /**
     * The restore route's own budget, which is a different order of magnitude
     * from every other route's.
     *
     * A restore copies a whole package tree back over the installation: the
     * dsh tree on this machine measures 551 MB across 26 513 files, and one
     * `cp` of it took 88 s. Judging that by {@link REQUEST_TIMEOUT_MS} reports
     * a failure for a restore that is still copying, and then reports it again
     * for the one that already finished — the panel would be wrong twice about
     * the only operation it offers that cannot be retried by clicking again.
     */
    const RESTORE_TIMEOUT_MS = 10 * 60 * 1000

    /**
     * Same-origin JSON call unwrapping the host's `{ result }` / `{ error }` envelope.
     * @param {string} path - the route path.
     * @param {Record<string, unknown>} [body] - absent for a GET, present for a POST.
     * @param {{ timeoutMs?: number }} [options] - a route whose own work outlives the default budget says so here.
     * @returns {Promise<any>} the resolved `result` of a successful envelope.
     */
    async function call(path, body, options = {}) {
      const init = body === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      // Aborted fetches reject with an AbortError, which the callers already
      // treat as a lost host — the same handling a dropped connection gets, and
      // the right one: a request that never answered WAS a lost host.
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        init.signal = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      }
      const response = await fetch(path, init)
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
/* The install progress bar: the panel's primary read on a running task. */
.dshvu_progress{margin:14px 0 0;display:flex;flex-direction:column;gap:8px}
.dshvu_progressHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.dshvu_progressPhase{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
.dshvu_progressValue{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
.dshvu_progressTrack{position:relative;height:8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dshvu_progressFill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .4s ease}
/* A phase with no denominator slides instead of pretending to be 40% done. */
.dshvu_progressIndeterminate .dshvu_progressFill{width:36%;animation:dshvu_slide 1.4s ease-in-out infinite}
@keyframes dshvu_slide{0%{transform:translateX(-110%)}100%{transform:translateX(310%)}}
.dshvu_progressDone .dshvu_progressFill{background:var(--dsw-alias-state-success-primary)}
.dshvu_progressFailed .dshvu_progressFill{background:var(--dsw-alias-state-error-primary)}
.dshvu_progressMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
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
     * How many mountings are currently asking for this stylesheet. Module scope,
     * because the page shares one module instance across them.
     */
    let stylesMounted = 0

    /**
     * Insert this plugin's stylesheet once and hand back its remover, so a
     * disposed fiber leaves no `<style>` behind.
     *
     * The count is what makes that true in both directions. Checking only for an
     * existing tag (the first version of this function) got the leak right and the
     * removal wrong: during a hot swap the NEW mounting usually runs before the
     * old one is disposed, so it found the tag present, was handed a no-op, and the
     * old disposer then removed the stylesheet out from under the instance that was
     * left alive — a settings page rendering with no rules at all.
     * @returns {() => void} the disposer for this call's claim on the tag.
     */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      stylesMounted += 1
      const selector = 'style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']'
      const existing = document.querySelector(selector)
      /** The tag this call inserted, if it inserted one. */
      let mine
      if (existing === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-version-update'
        tag.dataset.pluginCss = CSS_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
        mine = tag
      }
      let released = false
      return () => {
        // A disposer that runs twice would under-count, and the count is the only
        // thing standing between a live instance and its stylesheet disappearing.
        if (released) return
        released = true
        stylesMounted -= 1
        if (stylesMounted > 0) return
        const tag = mine ?? document.querySelector(selector)
        if (tag !== null && tag !== undefined) tag.remove()
      }
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
     * How many unanswered polls in a row the panel tolerates before it reports
     * the install as unreachable. The install outlives any one request; the
     * panel should not treat a dropped fetch as its ending.
     */
    const POLL_MISSES = 3

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
          diagnostics: undefined,
          diagnosticsError: undefined,
          loadingDiagnostics: false,
          // Which registry the next install should be fetched from. 'auto'
          // follows the source the version list was read from; the other two
          // are the user's escape hatch when that source turns out to crawl.
          updateSource: 'auto',
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
        // The snapshot row armed for deletion by a first click. Destructive and
        // irreversible, so it takes two clicks on the same row; see deleteSnapshot.
        deleteArmed: undefined,
        // How the global installation tree looked to the host at boot (and after a
        // failed install), as reported by the polling routes. Undefined until a
        // check answers, and absent entirely on a host that could not locate one.
        tree: undefined,
          restoreConfirm: undefined,
        // The version a restore is currently copying back, so the panel can
        // say what it is waiting for instead of looking idle for minutes.
        restoring: undefined,
          lastCheck: {},
          nextCheckAt: undefined,
          pendingAuto: undefined,
          cancellingPending: false,
          pendingError: undefined,
          history: [],
          operations: [],
          operationsError: undefined,
          loadingOperations: false,
        }
        this.pollTimer = undefined
        this.probeTimer = undefined
        this.noticeTimer = undefined
        // Whether a restart has been asked of the host from this page and is not
        // finished (in flight, or being waited on). The guard lives outside the
        // snapshot because it exists to stop a second request, not to render.
        this.restartInFlight = false
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
       * @param {{ prompt?: boolean; manual?: boolean }} [options] - `prompt: true` (the user
       * clicked the check button) offers a found update for confirmation
       * right away; the page-load check stays silent.
       */
      check = async (options = {}) => {
        if (this.snapshot.status === 'loading') return
        // Three reads, and which one is used is the whole point. `act: true`
        // (opening the panel) is the ONLY one that may silently install, so it
        // goes through a POST — a GET that can replace the installation tree
        // would be reachable by a prefetch, a second tab or any local process.
        // `manual: true` is the quiet refresh: a cancellation refresh must not
        // re-park the install it just cancelled. `prompt: true` (the button)
        // runs the same non-authorizing read and only then opens a
        // confirmation. A bare read just observes.
        const manual = options?.prompt === true || options?.manual === true
        this.patch({ status: 'loading', error: undefined })
        void this.refreshOperations()
        try {
          const [view, snapResult] = await Promise.all([
            options?.act === true
              ? call(VERSION_API.checkAuto, {})
              : manual
                ? call(VERSION_API.checkRun, {})
                : call(VERSION_API.check),
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
            // A fresh list is a fresh start for the armed row: the version under
            // the cursor may not even be there any more.
            deleteArmed: undefined,
            tree: typeof view.tree === 'object' && view.tree !== null ? view.tree : undefined,
          })
          // The user asked for a check: when it finds something newer, ask
          // whether to install it now instead of waiting for the user to spot
          // the update row. A quiet `manual` refresh never prompts, and never
          // preempts an open confirmation or a running install.
          if (options?.prompt === true
            && this.snapshot.confirm === undefined
            && this.snapshot.restoreConfirm === undefined
            && this.snapshot.busy !== true) {
            const target = view.channels?.find(c => c.ahead)?.version
            if (target !== undefined) this.patch({ confirm: target })
          }
          // A running install is followed; a settled one needs no adoption —
          // the restart affordance is derived from the task view this check
          // just patched, so a stale host simply renders the button.
          if (view.task?.state === 'running') this.startPolling()
        } catch (error) {
          this.patch({ status: 'error', error: this.describeError(error) })
        }
      }

      /** Read the bounded tail on demand and after observed settlements. */
      refreshOperations = async () => {
        if (this.snapshot.loadingOperations) return
        this.patch({ loadingOperations: true, operationsError: undefined })
        try {
          // Full tails are at most 200 events and also recover after host reload.
          const result = await call(VERSION_API.operations)
          this.patch({ operations: Array.isArray(result?.events) ? result.events : [], loadingOperations: false })
        } catch (error) {
          this.patch({ operationsError: this.describeError(error), loadingOperations: false })
        }
      }

      /** Read the bounded restart log only when the user asks for diagnostics. */
      refreshDiagnostics = async () => {
        if (this.snapshot.loadingDiagnostics) return
        this.patch({ loadingDiagnostics: true, diagnosticsError: undefined })
        try {
          const diagnostics = await call(VERSION_API.restartDiagnostics)
          this.patch({ diagnostics, loadingDiagnostics: false })
        } catch (error) {
          this.patch({ diagnosticsError: this.describeError(error), loadingDiagnostics: false })
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

      /**
       * Choose which registry the NEXT install is fetched from. Deliberately
       * not applied to a running one: npm is never killed mid-reify to change
       * its source, because the tree it is halfway through replacing is the
       * one thing a snapshot exists to make survivable — and taking the slow
       * path once is cheaper than repairing it.
       * @param {'auto' | 'official' | 'mirror'} source - the chosen source.
       */
      selectSource = (source) => {
        if (!INSTALL_SOURCES.includes(source)) return
        this.patch({ updateSource: source })
      }

      requestUpdate = (version) => {
        if (this.snapshot.busy) return
        this.patch({ confirm: version, error: undefined })
      }

      cancelUpdate = () => { this.patch({ confirm: undefined }) }

      confirmUpdate = async () => {
        const version = this.snapshot.confirm
        if (version === undefined) return
        this.patch({ confirm: undefined })
        await this.startUpdate(version, this.snapshot.updateSource)
      }

      /**
       * Re-run the version that just failed, against the mirror.
       *
       * The one retry the panel offers by itself, because the failure it
       * answers is the one the user is most likely looking at: a source that
       * could not deliver. Safe to fire the moment the task settles — the
       * host's post-failure tree repair defers while a new install holds the
       * tree, and the retry's own snapshot covers it either way.
       */
      retryWithMirror = () => {
        if (this.snapshot.busy) return
        const version = this.snapshot.task?.version ?? this.snapshot.selected
        if (version === undefined) return
        this.patch({ updateSource: 'mirror' })
        void this.startUpdate(version, 'mirror')
      }

      /**
       * Install one explicit version and follow it to settlement.
       * @param {string} version - the exact target version.
       * @param {'auto' | 'official' | 'mirror'} [source] - which registry to fetch from.
       */
      startUpdate = async (version, source) => {
        if (this.snapshot.busy) return
        this.patch({ busy: true, error: undefined })
        try {
          const task = await call(VERSION_API.update, {
            version,
            ...(source !== undefined ? { source } : {}),
          })
          this.patch({ task })
          this.startPolling()
        } catch (error) {
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
        // The wait is stated rather than hidden: this is the one action here
        // that can run for minutes, and a panel that shows nothing for that
        // long reads as a panel that did nothing.
        this.patch({ restoreConfirm: undefined, busy: true, error: undefined, restoring: version })
        try {
          const result = await call(VERSION_API.restore, { version }, { timeoutMs: RESTORE_TIMEOUT_MS })
          this.patch({ busy: false, restoring: undefined, task: result.task ?? { state: 'idle', log: '' } })
          // Observation only, and that is a fix rather than a preference: this
          // used to be the bare read, which under `mode: 'auto'` fed the
          // automatic decision and installed the version the user had just
          // rolled away from — the rollback undid itself within seconds.
          void this.check({ manual: true })
        } catch (error) {
          this.patch({ busy: false, restoring: undefined, error: this.describeError(error) })
        } finally {
          void this.refreshOperations()
        }
      }

      /**
       * Discard one stored snapshot. A snapshot is the rollback point for that
       * version and deleting it cannot be undone from this panel, so the row has
       * to be clicked twice: the first click arms it and relabels it, the second
       * deletes. Any check disarms, so a list that has since moved cannot leave a
       * row waiting to fire against a version the user no longer sees.
       * @param {string} version - the snapshot to discard.
       */
      deleteSnapshot = async (version) => {
        if (this.snapshot.deleteArmed !== version) {
          this.patch({ deleteArmed: version, error: undefined })
          return
        }
        this.patch({ deleteArmed: undefined })
        try {
          const result = await call(VERSION_API.snapshotDelete, { version })
          const list = result?.snapshots
          this.patch(Array.isArray(list) ? { snapshots: list } : {})
        } catch (error) {
          this.patch({ error: this.describeError(error) })
        }
      }

      /**
       * Drop the waiting automatic install. The panel keeps showing the same
       * finding until the next read confirms the drop, so the follow-up check
       * is a QUIET manual one: it must refresh the facts without re-parking
       * what was just cancelled, and without opening an install confirmation.
       */
      cancelPendingAuto = async () => {
        if (this.snapshot.pendingAuto === undefined || this.snapshot.cancellingPending || this.snapshot.status === 'loading') return
        this.patch({ cancellingPending: true, pendingError: undefined })
        try {
          await call(VERSION_API.pendingCancel, {})
          this.patch({ pendingAuto: undefined })
          await this.check({ manual: true })
        } catch (error) {
          this.patch({ pendingError: this.describeError(error) })
        } finally {
          this.patch({ cancellingPending: false })
        }
      }

      startPolling() {
        if (this.pollTimer !== undefined) return
        /** Consecutive unanswered polls. One hiccup is not a failed update. */
        let misses = 0
        const tick = async () => {
          try {
            const task = await call(VERSION_API.status)
            misses = 0
            this.patch({
              task,
              busy: task.state === 'running',
              lastCheck: typeof task.lastCheck === 'object' && task.lastCheck !== null ? task.lastCheck : this.snapshot.lastCheck,
              pendingAuto: typeof task.pendingAuto === 'object' && task.pendingAuto !== null ? task.pendingAuto : undefined,
              history: Array.isArray(task.recent) ? task.recent : this.snapshot.history,
              // Tree health rides the same ambient object, and the moment it
              // changes is right after a failed install — which is exactly what
              // this loop is watching. The panel's own check could be many polls
              // ago, so carrying the fact only there would show a stale verdict
              // over the log of the install that just broke the tree. A status
              // answer without the field keeps the last fact rather than erasing
              // it: absence means this host never located a tree, not that the
              // last one healed.
              tree: typeof task.tree === 'object' && task.tree !== null ? task.tree : this.snapshot.tree,
            })
            if (task.state !== 'running') {
              this.stopPolling()
              void this.refreshOperations()
              return
            }
          } catch (error) {
            // A single dropped poll used to stop following an install that was
            // still running: the panel unlocked itself, blamed the UPDATE for a
            // momentary 502 or an aborted request, and the log — the one thing
            // worth watching mid-install — went dead. An absent host half is a
            // different fact and stays fatal immediately.
            misses += 1
            const message = error instanceof Error ? error.message : String(error)
            if (message !== NOT_MOUNTED && misses < POLL_MISSES) {
              this.pollTimer = setTimeout(tick, POLL_MS)
              return
            }
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
       * Nothing here restarts anything, and that is the point.
       *
       * A settled install that left the disk ahead of the running process used
       * to open a dialog — an offer, or a countdown under policy `restart:
       * 'auto'` — and the countdown restarted the host on its own. Both are
       * gone: the install has just rewritten the very assets this page is
       * served from, so the dialog could outlive the renderer that would have
       * answered it, and a host that restarts itself is indistinguishable from
       * a host that crashed. The one affordance is the panel's 「立即重启」
       * button, which appears because `task.needsRestart` is set — derived
       * state, so a page that reloads onto a stale host shows it too.
       */

      /** Ask the host to hand its port to a replacement, then wait for it. */
      restart = async (version) => {
        // One restart in flight per page. The handoff leaves the page talking
        // to a host that is going away, so a second click — or a re-render that
        // re-fires the button — must not re-enter the wait loop on top of the
        // one already running.
        if (this.restartInFlight === true) return
        this.restartInFlight = true
        this.patch({ restarting: true })
        this.overlay.show({ title: this.t('restart.title'), body: this.t('restart.pending', { version }) })
        try {
          await call(VERSION_API.restart, {})
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // A refused restart is final; a dropped connection — or a request that
          // never answered, which is the same fact during a handoff — is not.
          if (!/failed to fetch|networkerror|load failed|abort|timeout/i.test(message)) {
            this.restartInFlight = false
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
            this.restartInFlight = false
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
       * Resume a restart this page was already waiting on, and keep the policy
       * readable before the panel opens. A stale host needs no recovering
       * here: the panel's own check renders the restart button from the task
       * view, and a page that never opens the panel is not waiting for a
       * dialog it would have to answer.
       */
      resume = () => {
        void this.refreshPolicy()
        const pending = readAwaitMarker()
        if (pending !== undefined) this.awaitReplacement(pending)
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
        selectSource: this.selectSource,
        toggleLog: this.toggleLog,
        requestUpdate: this.requestUpdate,
        confirmUpdate: this.confirmUpdate,
        cancelUpdate: this.cancelUpdate,
        retryWithMirror: this.retryWithMirror,
        requestRestore: this.requestRestore,
        confirmRestore: this.confirmRestore,
        cancelRestore: this.cancelRestore,
        deleteSnapshot: this.deleteSnapshot,
        cancelPendingAuto: this.cancelPendingAuto,
        savePolicy: this.savePolicy,
        refreshPolicy: this.refreshPolicy,
        refreshDiagnostics: this.refreshDiagnostics,
        refreshOperations: this.refreshOperations,
        restart: this.restart,
        fetchNotes: this.fetchNotes,
      })

      dispose = () => {
        this.stopPolling()
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

    /** @param {number} bytes - a byte count. @returns {string} a compact human size. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ''
      if (bytes < 1024) return `${Math.round(bytes)} B`
      if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`
      if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
      return `${(bytes / 1073741824).toFixed(2)} GB`
    }

    /** @param {number} ms - a duration. @returns {string} `34s` or `2m 05s`. */
    function formatDuration(ms) {
      const seconds = Math.max(0, Math.round((typeof ms === 'number' ? ms : 0) / 1000))
      return seconds < 60
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
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

    /** Local prerequisites, refreshed whenever an install confirmation opens. */
    function PreflightCard(props) {
      const { t, version } = props
      const [state, setState] = React.useState({})
      React.useEffect(() => {
        let alive = true
        setState({})
        void call(VERSION_API.preflight).then(
          verdict => { if (alive) setState({ verdict }) },
          () => { if (alive) setState({ failed: true }) },
        )
        return () => { alive = false }
      }, [version])
      const verdict = state.verdict
      const status = value => t(value === true ? 'preflight.yes' : 'preflight.no')
      return h('div', { className: 'dshvu_sep', 'aria-live': 'polite' },
        h('h4', { className: 'dshvu_title' }, t('preflight.title')),
        verdict === undefined
          ? h('p', { className: state.failed ? 'dshvu_warn' : 'dshvu_hint' }, t(state.failed ? 'preflight.failed' : 'preflight.loading'))
          : h(React.Fragment, null,
            h('p', { className: verdict.ok ? 'dshvu_ok' : 'dshvu_warn' }, t(verdict.ok ? 'preflight.ok' : 'preflight.review')),
            h(Line, { label: t('preflight.npm'), value: status(verdict.npm?.available) }),
            verdict.npm?.path ? h(PathLine, { label: t('preflight.npmPath'), value: verdict.npm.path }) : null,
            h(Line, { label: t('preflight.install'), value: status(verdict.installDirWritable) }),
            h(Line, { label: t('preflight.snapshots'), value: status(verdict.snapshotDirUsable) }),
            h(Line, { label: t('preflight.disk'), value: typeof verdict.diskFreeBytes === 'number'
              ? `${(verdict.diskFreeBytes / 1073741824).toFixed(2)} GiB` : t('unknown') }),
            Array.isArray(verdict.warnings) ? verdict.warnings.map((warning, index) => h('p', { key: index, className: 'dshvu_warn' }, warning)) : null),
        h('p', { className: 'dshvu_hint' }, t('preflight.advisory')))
    }

    /**
     * The install progress bar — the panel's primary read on a running task,
     * with the log demoted to an opt-in detail view behind a button.
     *
     * The bar is only as precise as the host's measurements are, and it says so:
     * a phase with a denominator draws a percentage, a phase without one slides
     * and reports the bytes it has seen, and a phase the host cannot observe at
     * all slides with no counter. Nothing here invents a number, because a
     * progress bar that lies is worse than no bar: it is the one element a
     * waiting user actually believes.
     *
     * `stalledMs`/`slow` come from the host and are rendered as a warning
     * rather than a failure — the run is still alive, and the actionable
     * answer (retry from the mirror) belongs to the settled task below.
     * @param {{ t: (key: string, params?: object) => string; progress?: object; state: string; version?: string }} props - the task facts.
     */
    function ProgressBar(props) {
      const { t, progress, state } = props
      const phase = typeof progress?.phase === 'string' ? progress.phase : 'preparing'
      const percent = typeof progress?.percent === 'number' ? progress.percent : undefined
      const done = state === 'done'
      const failed = state === 'failed'
      const bytes = typeof progress?.bytes === 'number' ? progress.bytes : 0
      const totalBytes = typeof progress?.totalBytes === 'number' ? progress.totalBytes : undefined
      const indeterminate = percent === undefined && !done && !failed
      const width = done ? 100 : percent !== undefined ? percent : 36
      const value = done
        ? '100%'
        : percent !== undefined
          ? `${percent}%`
          : formatBytes(bytes)
      /** The quiet line under the track: elapsed, and whatever is being counted. */
      const meta = []
      if (state === 'running' && typeof progress?.elapsedMs === 'number') {
        meta.push(t('progress.elapsed', { time: formatDuration(progress.elapsedMs) }))
      }
      if (percent !== undefined && totalBytes !== undefined) {
        meta.push(`${formatBytes(bytes)} / ${formatBytes(totalBytes)}`)
      } else if (bytes > 0) {
        meta.push(formatBytes(bytes))
      }
      if (typeof progress?.files === 'number' && progress.files > 0 && phase === 'snapshot') {
        meta.push(t('progress.files', { count: String(progress.files) }))
      }
      return h('div', { className: 'dshvu_progress' },
        h('div', { className: 'dshvu_progressHead' },
          h('span', { className: 'dshvu_progressPhase' }, orElse(t, `progress.phase.${phase}`, phase)),
          value.length > 0 ? h('span', { className: 'dshvu_progressValue' }, value) : null),
        h('div', {
          className: 'dshvu_progressTrack'
            + (indeterminate ? ' dshvu_progressIndeterminate' : '')
            + (done ? ' dshvu_progressDone' : failed ? ' dshvu_progressFailed' : ''),
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          ...(percent !== undefined ? { 'aria-valuenow': percent } : {}),
        }, h('div', { className: 'dshvu_progressFill', style: { width: `${width}%` } })),
        meta.length > 0 ? h('div', { className: 'dshvu_progressMeta' }, meta.join(' · ')) : null)
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
     *
     * It also carries the download-source choice, which is the only moment the
     * choice can still be made: npm is never killed mid-reify, so a source
     * picked after the install has started would be a source picked for the
     * next attempt anyway. A slow configured registry is a common enough
     * reason to reach for the mirror that the option belongs on the card the
     * user is already looking at, not buried in a settings form.
     */
    function ConfirmCard(props) {
      const { t, version, installed, fetchNotes, source, onSource, onConfirm, onCancel } = props
      const ref = React.useRef(null)
      React.useEffect(() => { ref.current?.focus() }, [])
      const downgrading = isDowngrade(version, installed)
      const sourceOptions = INSTALL_SOURCES.map(id => ({ value: id, label: t(`source.${id}`) }))
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
        h(PreflightCard, { t, version }),
        h(Field, {
          label: t('source.label'),
          hint: t('source.hint'),
          control: h(Select, {
            value: source ?? 'auto',
            options: sourceOptions,
            onChange: (value) => { onSource(value) },
          }),
        }),
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
     *
     * `policy` has to be the controller's own state object, not a copy built per
     * render: the effect below reads its identity as "the host answered with a
     * different policy". A fresh object carrying the same contents would reset
     * whatever the user is mid-way through typing on every unrelated re-render —
     * and a poll landing is never unrelated. That is why the next-check hint,
     * which is derived and changes with the schedule, arrives as its own prop.
     */
    function PolicyCard(props) {
      const { t, policy, nextCheckHint, saving, error, notice, onSave, onRefresh } = props
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
        // Restart is not a setting any more: it is always the panel's own
        // button, pressed by the user. Stated here as a fact rather than a
        // control, because a page that has no switch to look for should not
        // leave the reader wondering where it went.
        h(Line, { label: t('policy.restart.label'), value: t('policy.restart.fixed') }),
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
            nextCheckHint !== undefined
              ? h('span', { className: 'dshvu_hint', style: { margin: 0 } }, nextCheckHint)
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
     * The one-line verdict under the current installation, split out because it
     * is the panel's only claim about the future — "there is nothing to
     * install" — and that claim must never be made from an absent registry read.
     * @param {(key: string, params?: Record<string, string>) => string} t - the translator.
     * @param {{ status: string; installed?: string; publishedError?: string }} state - the panel snapshot.
     * @param {{ version: string }[]} ahead - channels ahead of the installed version.
     * @returns {string | undefined} the verdict text, when one can be stated.
     */
    function installVerdict(t, state, ahead) {
      if (state.status !== 'ready' || state.installed === undefined) return undefined
      // The route degrades to the local view when the registry cannot be read,
      // answering with NO channels at all — so an empty `ahead` here proves
      // nothing about what is published.
      if (state.publishedError !== undefined) return t('publishUnknown')
      return ahead.length > 0
        ? t('available', { version: ahead[0].version })
        : t('upToDate')
    }

    /**
     * The version-update settings page: status, policy, versions, task,
     * snapshots, and recent activity.
     */
    function VersionUpdateSection(props) {
      const {
        t, useVersionUpdate, check, select, selectSource, toggleLog,
        requestUpdate, confirmUpdate, cancelUpdate, retryWithMirror,
        requestRestore, confirmRestore, cancelRestore, deleteSnapshot, cancelPendingAuto,
        savePolicy, refreshPolicy, refreshDiagnostics, refreshOperations, restart, fetchNotes,
      } = props
      const state = useVersionUpdate(s => s)
      // Bumping this state re-renders the page; the running task's elapsed
      // clock uses it to tick once a second.
      const [forceRender, setForceRender] = React.useState(0)

      React.useEffect(() => {
        // Opening the panel is the panel's own trigger for the policy, and it
        // is a POST for exactly that reason — it may start an install. It is no
        // longer the ONLY trigger: the scheduler also checks once shortly after
        // boot, which is what keeps a silent `mode: 'auto'` current on a host
        // that is off at its configured `checkAt`.
        if (state.status === 'idle') void check({ act: true })
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

      const verdict = installVerdict(t, state, ahead)

      let taskLine
      if (state.task.state === 'running') {
        taskLine = t('task.running', { version: state.task.version ?? '' })
      } else if (state.task.state === 'done') {
        taskLine = t('task.done', { version: state.task.version ?? '' })
      } else if (state.task.state === 'failed') {
        taskLine = t('task.failed', { error: state.task.error ?? '' })
      }

      // A run whose host-side progress has stopped moving: still alive, but
      // slow enough to be worth naming, with the one useful next step spelled
      // out. The mirror retry itself waits for the run to settle — npm is
      // never killed mid-reify to change its source.
      const stalled = state.task.state === 'running' && state.task.progress?.slow === true
      const stalledFor = stalled ? formatDuration(state.task.progress?.stalledMs) : ''
      // A failed install is the one moment the mirror is a first-class action:
      // the tree has been repaired from its pre-install snapshot by then, so
      // re-running the same version against the other source costs nothing but
      // the download.
      const mirrorRetryOffered = state.task.state === 'failed'
        && state.task.source !== 'mirror'
        && typeof state.task.version === 'string'
        && state.busy !== true
      const runningLabel = (task) => {
        const base = t('task.following')
        const startedAt = typeof task.startedAt === 'number' ? task.startedAt : undefined
        if (startedAt === undefined) return base
        return `${base} · ${formatDuration(Date.now() - startedAt)}`
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
            loading ? h('span', { className: 'dshvu_spinner', 'aria-label': t('checking') }) : null,
            // The ONE restart affordance, and it belongs here rather than in the
            // task card below. That card only renders while a task is not idle,
            // and the case this button exists for is precisely the one where the
            // task IS idle: a page reloaded after an install settles. What
            // survives a reload is `needsRestart` — the host comparing the
            // version it booted against the version on disk — so the button is
            // derived from that, and the warning line above it is its reason.
            needsRestart && state.task.restartable === true && state.restarting !== true
              ? h('button', {
                type: 'button',
                className: 'dshvu_btn dshvu_btnPrimary',
                onClick: () => { void restart(state.installed ?? '') },
              }, t('restart.now'))
              : null),
          // A failure that happens while the page is otherwise fine — a
          // refused restore, a delete the host rejected, a policy that would
          // not save — lands in `error` without changing `status`, and used to
          // be rendered NOWHERE: the click simply did nothing visible. The
          // load failure below keeps its own wording, because "could not read
          // the page" is a different fact from "that action was refused".
          state.error !== undefined && state.status !== 'error'
            ? h('p', { className: 'dshvu_error' }, state.error)
            : null,
          state.status === 'error'
            ? h('p', { className: 'dshvu_error' }, t('loadFailed', { error: state.error ?? '' }))
            : null),

        // ---- waiting automatic install ----
        state.pendingAuto !== undefined
          ? h('section', { className: 'dshvu_card', 'aria-label': t('pending.title') },
            h('h3', { className: 'dshvu_title' }, t('pending.title')),
            h(Line, { label: t('pending.target'), value: state.pendingAuto.target }),
            h(Line, { label: t('pending.since'), value: fmtTime(state.pendingAuto.since) }),
            h('p', { className: 'dshvu_hint' }, t('pending.hint')),
            h('div', { className: 'dshvu_row dshvu_sep' },
              h('button', {
                type: 'button',
                className: 'dshvu_btn',
                disabled: loading || state.cancellingPending === true,
                onClick: () => { void cancelPendingAuto() },
              }, state.cancellingPending === true ? t('pending.cancelling') : t('pending.cancel'))),
            state.pendingError !== undefined ? h('p', { className: 'dshvu_error' }, state.pendingError) : null)
          : null,

        // ---- update policy ----
        h(PolicyCard, {
          t,
          installed: state.installed,
          policy: state.policy ?? EMPTY_POLICY,
          nextCheckHint: state.nextCheckAt !== undefined ? t('policy.nextCheck', { time: fmtTime(state.nextCheckAt) }) : undefined,
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

        // ---- installation tree health ----
        // The host measures the global tree it booted from once at mount and again
        // after any install that failed, and carries the result in every polling
        // answer. A half-committed tree is the one state where "update" has already
        // done its damage and nothing else in this panel would say so: an
        // interrupted npm leaves replaced packages under retired names, and dsh's
        // own manifest can be gone while the running process keeps serving from
        // memory. Healthy and unrepaired is deliberately silent — there is no
        // action in it, and a card that reports nothing every time teaches the
        // user to skip the card.
        state.tree !== undefined && (state.tree.healthy !== true || state.tree.restored !== undefined)
          ? h('section', { className: 'dshvu_card' },
            h('h3', { className: 'dshvu_title' }, t('tree.title')),
            state.tree.manifestOk === false
              ? h('p', { className: 'dshvu_warn' }, t('tree.missingManifest', { dir: String(state.tree.installDir ?? '') }))
              : null,
            state.tree.manifestOk !== false && state.tree.launcherOk === false
              ? h('p', { className: 'dshvu_warn' }, t('tree.missingLauncher', { dir: String(state.tree.installDir ?? '') }))
              : null,
            state.tree.restored !== undefined
              ? h('p', { className: 'dshvu_hint', style: { margin: 0 } }, t('tree.restored', { version: String(state.tree.restored) }))
              : null,
            Array.isArray(state.tree.leftovers) && state.tree.leftovers.length > 0
              ? h('p', { className: 'dshvu_warn' }, t('tree.leftovers', { count: String(state.tree.leftovers.length) }))
              : null,
            Array.isArray(state.tree.errors) && state.tree.errors.length > 0
              ? h('p', { className: 'dshvu_warn' }, t('tree.errors', { errors: state.tree.errors.join('; ') }))
              : null)
          : null,

        // ---- running / last task ----
        // A bar, not a log. The install's own output is still one click away,
        // but the thing a waiting user needs — how far along, and is it still
        // moving — is a number the host now measures rather than lines they
        // have to read.
        state.task.state !== 'idle'
          ? h('section', { className: 'dshvu_card' },
            h('h3', { className: 'dshvu_title' }, t('task.title')),
            taskLine !== undefined ? h('p', { className: 'dshvu_hint', style: { margin: 0 } }, taskLine) : null,
            h(ProgressBar, { t, progress: state.task.progress, state: state.task.state }),
            state.task.registry !== undefined
              ? h('p', { className: 'dshvu_hint', style: { margin: '10px 0 0' } }, t('task.source', {
                source: orElse(t, `source.${state.task.source ?? 'auto'}`, state.task.source ?? ''),
                registry: state.task.registry,
              }))
              : null,
            stalled
              ? h('p', { className: 'dshvu_warn' }, t('task.slow', { time: stalledFor }))
              : null,
            h('div', { className: 'dshvu_row', style: { marginTop: 10 } },
              h('button', {
                type: 'button',
                className: 'dshvu_btn',
                onClick: () => { toggleLog() },
              }, state.showLog === true ? t('task.hideLog') : t('task.showLog')),
              state.task.state === 'running' ? h('span', { className: 'dshvu_spin' }, runningLabel(state.task)) : null,
              mirrorRetryOffered
                ? h('button', {
                  type: 'button',
                  className: 'dshvu_btn',
                  onClick: () => { void retryWithMirror() },
                }, t('task.retryMirror'))
                : null),
            state.showLog === true
              ? h(LogView, { text: state.task.log ?? '' })
              : null)
          : null,

        // ---- restart diagnostics (never fetched by polling) ----
        state.task.restartable === true
          ? h('section', { className: 'dshvu_card' },
            h('h3', { className: 'dshvu_title' }, t('diagnostics.title')),
            h('p', { className: 'dshvu_hint' }, t('diagnostics.hint')),
            h('button', {
              type: 'button',
              className: 'dshvu_btn',
              disabled: state.loadingDiagnostics,
              onClick: () => { void refreshDiagnostics() },
            }, state.loadingDiagnostics ? t('diagnostics.loading') : t('diagnostics.read')),
            state.diagnosticsError !== undefined || state.diagnostics?.error !== undefined
              ? h('p', { className: 'dshvu_error' }, state.diagnosticsError ?? state.diagnostics.error)
              : null,
            state.diagnostics?.available === false
              ? h('p', { className: 'dshvu_hint' }, t('diagnostics.empty'))
              : null,
            state.diagnostics?.truncated === true
              ? h('p', { className: 'dshvu_hint' }, t('diagnostics.truncated'))
              : null,
            state.diagnostics?.available === true
              ? h(LogView, { text: state.diagnostics.log ?? '' })
              : null)
          : null,

        // ---- snapshot center ----
        h('section', { className: 'dshvu_card' },
          h('h3', { className: 'dshvu_title' }, t('snapshots.title')),
          h('p', { className: 'dshvu_hint', style: { margin: '0 0 4px' } }, t('snapshots.hint')),
          state.restoring !== undefined
            ? h('p', { className: 'dshvu_hint' }, t('snapshots.restoring', { version: state.restoring }))
            : null,
          state.snapshots.length === 0
            ? h('p', { className: 'dshvu_hint' }, t('snapshots.empty'))
            : h('ul', { className: 'dshvu_list' },
              state.snapshots.map(entry => h('li', { key: entry.version, className: 'dshvu_item' },
                h('span', { className: 'dshvu_chanVersion' }, entry.version),
                h('span', { className: 'dshvu_itemMain' },
                  entry.at !== undefined ? fmtTime(entry.at) : '',
                  // The host measures this at creation and the row is where a
                  // user decides what to delete, so it belongs here: one
                  // snapshot of the dsh tree measures 551 MB.
                  typeof entry.bytes === 'number' && entry.bytes > 0 ? ` · ${formatBytes(entry.bytes)}` : '',
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
                  : null,
                // Deleting is offered on EVERY row, including the unusable ones: a
                // snapshot that can never be restored is only ever taking up disk,
                // and it is the one thing a user should be able to clear by hand.
                // Two clicks on the same row, because there is no undo here.
                h('span', { className: 'dshvu_itemAction' },
                  h('button', {
                    type: 'button',
                    className: 'dshvu_btn',
                    disabled: running,
                    onClick: () => { void deleteSnapshot(entry.version) },
                  }, state.deleteArmed === entry.version ? t('snapshots.deleteConfirm') : t('snapshots.delete'))))))),

        // ---- ephemeral operation timeline ----
        h('section', { className: 'dshvu_card', 'aria-label': t('operations.title') },
          h('h3', { className: 'dshvu_title' },
            t('operations.title'),
            h('button', {
              type: 'button', className: 'dshvu_btn', disabled: state.loadingOperations,
              onClick: () => { void refreshOperations() },
            }, t(state.loadingOperations ? 'operations.loading' : 'operations.refresh'))),
          h('p', { className: 'dshvu_hint' }, t('operations.hint')),
          state.operationsError !== undefined ? h('p', { className: 'dshvu_error' }, state.operationsError) : null,
          (state.operations ?? []).length === 0
            ? h('p', { className: 'dshvu_hint' }, t('operations.empty'))
            : h('ul', { className: 'dshvu_list dshvu_listScroll' },
              [...state.operations].reverse().map(entry => h('li', { key: entry.seq, className: 'dshvu_item' },
                h('span', { className: 'dshvu_chanName' }, orElse(t, `operations.kind.${entry.kind}`, entry.kind)),
                h('span', { className: 'dshvu_itemMain' },
                  `${orElse(t, `operations.phase.${entry.phase}`, entry.phase)} · ${entry.message ?? ''}`,
                  entry.error !== undefined ? h('span', { className: 'dshvu_error' }, ` · ${entry.error}`) : null),
                h('time', { className: 'dshvu_label', dateTime: new Date(entry.at).toISOString() }, fmtTime(entry.at)))))),

        // ---- recent activity ----
        state.history.length > 0
          ? h('section', { className: 'dshvu_card' },
            h('h3', { className: 'dshvu_title' }, t('history.title')),
            h('ul', { className: 'dshvu_list' },
              state.history.map((entry, index) => h('li', { key: `${entry.at}-${index}`, className: 'dshvu_item' },
                h('span', { className: 'dshvu_chanVersion' }, entry.to),
                h('span', { className: 'dshvu_itemMain' },
                  `${fmtTime(entry.at)}${entry.from !== undefined ? ` · ${entry.from} → ${entry.to}` : ''}${typeof entry.trigger === 'string' ? ` · ${orElse(t, `history.trigger.${entry.trigger}`, entry.trigger)}` : ''}${entry.repair === true ? ` · ${t('history.repair')}` : ''}${entry.restored === true ? ` · ${t('history.restored')}` : ''}${typeof entry.removed === 'number' && entry.removed > 0 ? ` · ${t('history.removed', { count: entry.removed })}` : ''}`),
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
            source: state.updateSource ?? 'auto',
            onSource: selectSource,
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
      'publishUnknown': '未能读取发布信息：无法判断是否有新版本。',
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
      'source.label': '下载源',
      'source.hint': '安装从哪个 registry 拉取。官方源慢或超时时改选淘宝镜像；「自动」跟随本次读到版本的那个源。',
      'source.auto': '自动（推荐）',
      'source.official': '官方源',
      'source.mirror': '淘宝镜像（npmmirror）',
      'restoreConfirm.title': '确认恢复快照',
      'restoreConfirm.body': '将从本地快照把 @deepseek-ai/dsh 恢复到 {version}。不联网，但要把整棵安装树复制回去，大安装树可能耗时一到两分钟。当前版本会先被留成快照，所以这一步可以再退回来。',
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
      'policy.restart.fixed': '不会自动重启；在面板上点「立即重启」才重启宿主。',
      'policy.window.label': '执行时间窗',
      'policy.window.hint': '仅在「静默自动更新」模式下生效：只允许在该本地时间段内开始自动安装。留空表示任何时间。起止相同表示全天；结束早于起始表示跨午夜。',
      'policy.checkAt.label': '每日定时检查',
      'policy.checkAt.hint': '每天在此时刻后台检查一次更新。留空表示不定时检查，但自动模式仍会在每次启动后检查一次。',
      'task.title': '安装任务',
      'task.running': '正在安装 {version}…',
      'task.done': '{version} 安装完成。',
      'task.failed': '安装失败：{error}',
      'task.showLog': '查看详细日志',
      'task.hideLog': '收起日志',
      'task.following': '正在跟随输出…',
      'task.source': '下载源：{source} · {registry}',
      'task.slow': '已经 {time} 没有任何进展，可能是下载源太慢。本次不会中途中断（半途杀掉 npm 会破坏安装树），等它结束后可用淘宝镜像重试。',
      'task.retryMirror': '用淘宝镜像重试',
      'progress.phase.preparing': '准备中',
      'progress.phase.snapshot': '备份当前版本（回滚快照）',
      'progress.phase.download': '下载中',
      'progress.phase.extract': '解压安装',
      'progress.phase.verify': '校验安装结果',
      'progress.phase.done': '安装完成',
      'progress.elapsed': '已用 {time}',
      'progress.files': '{count} 个文件',
      'snapshots.title': '快照与回滚',
      'snapshots.hint': '每次安装前会自动备份当前版本；恢复时也会把被替换掉的版本留成快照。恢复不依赖网络，但要把整棵树复制回去，大安装树需要一两分钟。',
      'snapshots.empty': '还没有快照。首次安装或手动更新后这里会出现可回滚的版本。',
      'snapshots.restoring': '正在恢复 {version}：整棵安装树正在复制回去，请不要关闭本页。',
      'snapshots.restore': '恢复此版本',
      'snapshots.delete': '删除快照',
      'snapshots.deleteConfirm': '再点一次确认删除',
      'snapshots.unusable': '快照不可用',
      'tree.title': '安装树健康',
      'tree.missingManifest': '在 {dir} 读不到 dsh 的 package.json：全局树可能被中断的安装改坏了。可从上方快照恢复，或在终端重装。',
      'tree.missingLauncher': '{dir} 里读不到 dsh 的启动入口 lib/bin.js：这次安装只写了一半。可从上方快照恢复，或重新安装一次。',
      'tree.restored': '启动时发现树不完整，已用 {version} 的快照就地重建。',
      'tree.leftovers': '发现 {count} 个被中断的 npm 留下的旧目录，它们仍占着磁盘与解析路径。',
      'tree.errors': '自动修复没有全部成功：{errors}',
      'operations.title': '活动时间线',
      'operations.hint': '本次宿主运行中最近 200 条事件；检查、操作结束或手动刷新时读取。安装仅记录结束结果。',
      'operations.refresh': '刷新活动',
      'operations.loading': '读取中…',
      'operations.empty': '暂无操作事件。',
      'operations.kind.install': '安装',
      'operations.kind.restore': '快照恢复',
      'operations.kind.repair': '树修复',
      'operations.phase.running': '进行中',
      'operations.phase.done': '已完成',
      'operations.phase.failed': '失败',
      'history.title': '最近活动',
      'history.restored': '快照恢复',
      'history.repair': '树修复',
      'history.removed': '清理 {count} 个残留目录',
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
      'pendingAuto': '已发现新版本 {version}，等待自动安装。',
      'pending.title': '等待自动安装',
      'pending.target': '目标版本',
      'pending.since': '开始等待',
      'pending.hint': '正在等待执行时间窗或安装槽位空闲。取消仅清除当前等待，不修改策略或每日检查；后续自动检查仍可安排更新。',
      'pending.cancel': '取消待安装',
      'pending.cancelling': '取消中…',
      'restart.title': '重启 dsh 宿主',
      'restart.staleBody': '磁盘上已是 {installed}，而运行中的进程仍是 {running}。重启后新版本生效，页面资源也会随之更新。',
      'restart.unavailable': '需要重启（磁盘 {installed}/运行 {running}），但当前环境不支持自动重启，请在终端手动操作。',
      'restart.pending': '正在交接端口并退出旧进程…',
      'restart.waiting': '旧进程已退出，正在等待新进程就绪（{version}）…',
      'restart.reload': '{version} 已就绪，正在重新载入页面…',
      'restart.timeout': '等待新进程超时（{version}）。请检查终端，或重新运行 dsh web。',
      'restart.failed': '重启失败：{error}。请自行停止并启动 dsh web。',
      'restart.now': '立即重启',
      'restart.dismiss': '知道了',
      'restart.reloadNow': '仍然刷新',
      'restart.pendingShort': '重启中…',
      'diagnostics.title': '重启诊断',
      'diagnostics.hint': '按需读取重启日志末尾（最多 16 KiB / 100 行），过滤常见凭据格式。日志可能包含本机路径，分享前请检查。',
      'diagnostics.read': '读取重启日志',
      'diagnostics.loading': '读取中…',
      'diagnostics.empty': '尚无可用的重启日志。',
      'diagnostics.truncated': '仅显示日志末尾。',
      'preflight.title': '更新预检',
      'preflight.loading': '正在检查本机安装条件…',
      'preflight.failed': '预检不可用，请检查宿主路由或稍后重试。',
      'preflight.ok': '本机预检通过。',
      'preflight.review': '安装前请检查以下警告。',
      'preflight.npm': 'npm 可用',
      'preflight.npmPath': 'npm CLI 路径',
      'preflight.install': '安装目录父级可写',
      'preflight.snapshots': '快照目录可用',
      'preflight.disk': '安装磁盘可用空间',
      'preflight.yes': '是',
      'preflight.no': '否',
      'preflight.advisory': '仅供参考，不阻止安装；预检通过不保证安装成功。',
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
      'publishUnknown': 'Release information could not be read: whether an update exists is unknown.',
      'publishUnknown': 'Release information could not be read: whether an update exists is unknown.',
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
      'source.label': 'Download source',
      'source.hint': 'Which registry the install fetches from. Pick the mirror when the official one is slow or timing out; "automatic" follows whichever registry served the version list.',
      'source.auto': 'Automatic (recommended)',
      'source.official': 'Official registry',
      'source.mirror': 'Taobao mirror (npmmirror)',
      'restoreConfirm.title': 'Confirm snapshot restore',
      'restoreConfirm.body': 'This restores @deepseek-ai/dsh to {version} from the local snapshot. No network is needed, but the whole installation tree is copied back, which can take a minute or two for a large tree. The version being replaced is kept as a snapshot first, so this step can be undone.',
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
      'policy.restart.fixed': 'Nothing restarts on its own; press "Restart now" on this panel to hand the port over.',
      'policy.window.label': 'Execution window',
      'policy.window.hint': 'Applies to silent auto-update: automatic installs may only START inside this local time span. Empty means anytime. Equal bounds mean all day; end before start wraps past midnight.',
      'policy.checkAt.label': 'Daily check at',
      'policy.checkAt.hint': 'Run one background check every day at this time. Empty disables the schedule, but auto mode still checks once after each start.',
      'task.title': 'Install task',
      'task.running': 'Installing {version}…',
      'task.done': '{version} installed.',
      'task.failed': 'Install failed: {error}',
      'task.showLog': 'Show detailed log',
      'task.hideLog': 'Hide log',
      'task.following': 'following output…',
      'task.source': 'Source: {source} · {registry}',
      'task.slow': 'No movement for {time} — the download source is probably slow. This run is not interrupted (stopping npm mid-reify corrupts the tree); once it settles, retry from the mirror.',
      'task.retryMirror': 'Retry with the Taobao mirror',
      'progress.phase.preparing': 'Preparing',
      'progress.phase.snapshot': 'Backing up the current version (rollback snapshot)',
      'progress.phase.download': 'Downloading',
      'progress.phase.extract': 'Extracting',
      'progress.phase.verify': 'Verifying the install',
      'progress.phase.done': 'Installed',
      'progress.elapsed': '{time} elapsed',
      'progress.files': '{count} files',
      'snapshots.title': 'Snapshots & rollback',
      'snapshots.hint': 'Every install backs up the previous version first, and a restore keeps the version it replaces. Restoring needs no network, but copies the whole tree back — a large one takes a minute or two.',
      'snapshots.empty': 'No snapshots yet. One appears here after the first install or manual update.',
      'snapshots.restoring': 'Restoring {version}: the whole installation tree is being copied back. Keep this page open.',
      'snapshots.restore': 'Restore',
      'snapshots.delete': 'Delete',
      'snapshots.deleteConfirm': 'Click again to delete',
      'snapshots.unusable': 'unusable',
      'tree.title': 'Installation tree health',
      'tree.missingManifest': 'No package.json for dsh could be read in {dir}: the global tree may have been left half-committed by an interrupted install. Restore a snapshot from above, or reinstall from a terminal.',
      'tree.missingLauncher': 'No launcher entry (lib/bin.js) could be read in {dir}: that install only wrote half of itself. Restore a snapshot from above, or install again.',
      'tree.restored': 'The tree was found incomplete at startup and has been rebuilt in place from the snapshot of {version}.',
      'tree.leftovers': '{count} retired directories left by an interrupted npm install are still in the tree, holding disk and resolution paths.',
      'tree.errors': 'Automatic repair did not finish: {errors}',
      'operations.title': 'Activity timeline',
      'operations.hint': 'Latest 200 events in this host run; read on checks, settlement, or manual refresh. Installs record outcomes only.',
      'operations.refresh': 'Refresh activity',
      'operations.loading': 'Reading…',
      'operations.empty': 'No operation events yet.',
      'operations.kind.install': 'Install',
      'operations.kind.restore': 'Restore',
      'operations.kind.repair': 'Tree repair',
      'operations.phase.running': 'Running',
      'operations.phase.done': 'Done',
      'operations.phase.failed': 'Failed',
      'history.title': 'Recent activity',
      'history.restored': 'snapshot restore',
      'history.repair': 'tree repair',
      'history.removed': '{count} leftovers removed',
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
      'pendingAuto': 'Found {version}; waiting to install automatically.',
      'pending.title': 'Waiting to auto-install',
      'pending.target': 'Target version',
      'pending.since': 'Waiting since',
      'pending.hint': 'Waiting for the execution window or a free install slot. Cancelling clears only this wait, not the policy or daily check; later automatic checks may schedule an update again.',
      'pending.cancel': 'Cancel pending install',
      'pending.cancelling': 'Cancelling…',
      'restart.title': 'Restart the dsh host',
      'restart.staleBody': 'Disk holds {installed} while the running process is {running}. Restarting activates the new version and refreshes this page\'s assets.',
      'restart.unavailable': 'A restart is required (disk {installed}/running {running}), but this environment cannot restart automatically — please do it from a terminal.',
      'restart.pending': 'Handing the port over and exiting the old process…',
      'restart.waiting': 'Old process exited; waiting for the replacement ({version})…',
      'restart.reload': '{version} is ready — reloading…',
      'restart.timeout': 'Timed out waiting for the replacement ({version}). Check the terminal, or run dsh web again.',
      'restart.failed': 'Restart failed: {error}. Stop and start dsh web yourself.',
      'restart.now': 'Restart now',
      'restart.dismiss': 'Got it',
      'restart.reloadNow': 'Reload anyway',
      'restart.pendingShort': 'Restarting…',
      'diagnostics.title': 'Restart diagnostics',
      'diagnostics.hint': 'Read the restart log on demand (up to 16 KiB / 100 lines), with common credentials redacted. Review local paths and other details before sharing.',
      'diagnostics.read': 'Read restart log',
      'diagnostics.loading': 'Reading…',
      'diagnostics.empty': 'No restart log is available yet.',
      'diagnostics.truncated': 'Only the log tail is shown.',
      'preflight.title': 'Update preflight',
      'preflight.loading': 'Checking local installation prerequisites…',
      'preflight.failed': 'Preflight unavailable; check host routes or try again later.',
      'preflight.ok': 'Local preflight passed.',
      'preflight.review': 'Review these warnings before installing.',
      'preflight.npm': 'npm available',
      'preflight.npmPath': 'npm CLI path',
      'preflight.install': 'Install directory parent writable',
      'preflight.snapshots': 'Snapshot directory usable',
      'preflight.disk': 'Free space on install disk',
      'preflight.yes': 'Yes',
      'preflight.no': 'No',
      'preflight.advisory': 'Advisory only; does not block installation or guarantee success.',
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
    // Exported for tests: the verdict is the panel's only forward-looking
    // statement, and its "we cannot know" branch is the one a degraded
    // registry read has to reach.
    exports.installVerdict = installVerdict
    // Exported for tests: the policy form's draft is the one place in the panel
    // that holds unsaved user input, and whether it survives a re-render is
    // decided by the identity of the policy prop.
    exports.PolicyCard = PolicyCard
    // Exported for tests: pending actions must disappear after cancellation.
    exports.VersionUpdateSection = VersionUpdateSection
    // Exported for tests: stylesheet ownership across overlapping mountings is a
    // reference-count question, and a hot swap is the only moment it shows.
    exports.installStyles = installStyles
    // Exported for tests: the progress bar is the panel's primary read on a
    // running install, and the line between "measured" and "guessed at" is
    // drawn entirely inside it.
    exports.ProgressBar = ProgressBar
    // Exported for tests: the whole settings page, so a smoke test can render
    // it against a task view and prove the bar is what a running install shows.
    exports.VersionUpdateSection = VersionUpdateSection
    // Exported for tests: the host locale runtime resolves a key as one whole
    // string, so a test walks every key the panel asks for against both
    // dictionaries to keep them flat and complete.
    exports.dictionaries = { zh, en }
    // Exported for tests: confirmation-local probes must settle without blocking install.
    exports.PreflightCard = PreflightCard
    return module.exports
  },
})

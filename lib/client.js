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
    }

    /** Dictionary namespace and settings-section id owned by this plugin. */
    const NS = 'version-update'

    /** Marker error meaning the host routes are absent, not failing. */
    const NOT_MOUNTED = 'dsh-version-update:not-mounted'

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
        // not mounted yet", i.e. dsh has not been restarted since it was added —
        // a far more actionable message than "HTTP 200".
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
     * (lib/core.js VERSION_PATTERN): `major.minor.patch` with an optional
     * dash-separated pre-release. This is a deliberate mirror, not a shared
     * import: the browser half ships as a standalone bundle with no build
     * step, so the two copies must be kept in agreement by test.
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
     * Rank two versions by semver rules over the published grammar; an
     * unparsable value sorts below every parsable one. Mirrors the host's
     * `compareVersions` so both halves agree on what a downgrade is.
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
     * called a downgrade — the panel then keeps the neutral update wording.
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
     * drawn at 24x24 with a 2px stroke to match the shell's other outline
     * icons after the mask scales it to 16px. Inlined as a data URL because the
     * plugin ships no static assets.
     */
    const NAV_GLYPH = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'/%3E%3Cpath d='M3 3v5h5'/%3E%3Cpath d='M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16'/%3E%3Cpath d='M16 16h5v5'/%3E%3C/svg%3E"

    const CSS_ID = 'dsh-version-update/panel.css'
    const CSS = `
.dshvu_page{display:flex;flex-direction:column;gap:20px;padding:4px 0 16px}
.dshvu_card{background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:18px 20px;border:1px solid var(--dsw-alias-border-l2);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.dshvu_card + .dshvu_card{margin-top:0}
.dshvu_row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.dshvu_rowSplit{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:6px 0}
.dshvu_label{color:var(--dsw-alias-label-tertiary);font-size:13px;white-space:nowrap}
.dshvu_value{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
/* The install path is long and unbreakable at word boundaries, so it gets its
 * own full-width line instead of competing with the label in a split row. */
.dshvu_pathRow{display:flex;flex-direction:column;gap:4px;padding:6px 0}
.dshvu_path{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;word-break:break-all}
.dshvu_title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;margin:0 0 12px}
.dshvu_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;margin:10px 0 0}
.dshvu_warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:1.6;margin:10px 0 0;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-state-warn-bg)}
.dshvu_sep{border-top:1px solid var(--dsw-alias-border-l2);margin:14px 0 0;padding-top:6px}
.dshvu_btn{appearance:none;font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:6px 14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);transition:border-color .16s,background .16s}
.dshvu_btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}
.dshvu_btnPrimary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dshvu_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
.dshvu_btn:disabled{cursor:not-allowed;opacity:.4}
.dshvu_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshvu_select{appearance:none;font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:6px 28px 6px 10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dshvu_selectWrap{position:relative;display:inline-flex;align-items:center}
.dshvu_selectWrap::after{content:'';position:absolute;right:10px;width:6px;height:6px;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:translateY(-2px) rotate(45deg);pointer-events:none}
.dshvu_select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshvu_badge{border-radius:999px;padding:1px 9px;font-size:11px;font-weight:500;line-height:18px;white-space:nowrap;border:1px solid transparent}
.dshvu_badgeAhead{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary-foreground)}
/* The neutral badge is outlined rather than filled: every fill token that
 * reads as a chip in the light theme collapses into the card background in
 * the dark theme. */
.dshvu_badgeCurrent{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.dshvu_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6;margin:8px 0 0;white-space:pre-wrap}
.dshvu_log{margin:12px 0 0;padding:12px 14px;max-height:300px;overflow:auto;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-all}
.dshvu_log::-webkit-scrollbar{width:4px;height:4px}
.dshvu_log::-webkit-scrollbar-track{background:transparent}
.dshvu_log::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}
/* The release notes excerpt on the confirmation card: same monospace block as
 * the install log, shorter, and wrapped by a labelled link to the source. */
.dshvu_notesWrap{margin:10px 0 0;display:flex;flex-direction:column;gap:6px}
.dshvu_notes{margin:0;max-height:220px;white-space:pre-wrap}
.dshvu_notesLink{font-size:12px;color:var(--dsw-alias-brand-primary);text-decoration:none}
.dshvu_notesLink:hover{text-decoration:underline}
/* The confirmation card sits between the summary and the version lists, so it
 * gets an accent border to read as a decision rather than another panel. */
.dshvu_confirm{border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-bg);box-shadow:0 0 0 1px var(--dsw-alias-state-warn-primary)}
.dshvu_confirmBody{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.7;margin:0}
.dshvu_confirmActions{justify-content:flex-end;margin:16px 0 0}
.dshvu_chanList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
/* Fixed columns so the two channel rows line up even when only one of them
 * carries an action. */
.dshvu_chan{display:grid;grid-template-columns:104px 96px auto 1fr minmax(112px,auto);align-items:center;gap:10px;padding:6px 0}
.dshvu_chanName{color:var(--dsw-alias-label-secondary);font-size:13px}
.dshvu_chanVersion{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.dshvu_chanAction{grid-column:5;justify-self:end}
.dshvu_grow{flex:1}
.dshvu_spin{color:var(--dsw-alias-label-tertiary);font-size:12px}
/* The settings shell picks nav glyphs from a closed list of its own built-in
 * section ids and projects no icon field from a settings.section registration,
 * so an external section always draws the fallback gear. The marker below is
 * this plugin's own row; swap that gear for an update glyph rendered as a
 * currentColor mask, which keeps the shell's 16px rhythm and inherits its
 * hover/active colors instead of hardcoding any. */
[${NAV_MARKER}] > svg:first-child{display:none}
[${NAV_MARKER}]::before{content:'';flex:none;width:18px;height:18px;background:currentColor;-webkit-mask:url("${NAV_GLYPH}") center / contain no-repeat;mask:url("${NAV_GLYPH}") center / contain no-repeat;margin:-1px 0}
`
    /**
     * Insert this plugin's stylesheet once and hand back its remover, so a
     * disposed fiber leaves no `<style>` behind (the same reversibility the nav
     * marker keeps).
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
     * colors, and it is the only place in this plugin that does either.
     *
     * A completed update replaces the dsh package tree this host serves its
     * frontend from. The host's bundle watcher then reports every harness
     * client bundle as rebuilt, and the browser's hot-swap chain tears those
     * plugin fibers down — including the theme plugin, whose global stylesheet
     * defines every `--dsw-*` token, and the renderer that draws React
     * components at all. The overlay has to stay visible and legible after
     * exactly that, so it can neither be a React component nor rely on
     * inherited page styling.
     *
     * The colors still follow the system theme: `prefers-color-scheme` is a
     * media query, so it needs no token and no stylesheet that the teardown
     * could have taken with it.
     */
    const OVERLAY_ID = 'dsh-version-update-restart-overlay'

    /** Whether the browser currently reports a dark colour scheme. */
    function prefersDark() {
      try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches
      } catch {
        // matchMedia is absent in some embedded webviews; light is the safe default.
        return false
      }
    }

    /**
     * Fixed geometry and colors of the recovery overlay, in both schemes.
     * @param {boolean} dark - whether to return the dark palette.
     * @returns {Record<string, string>} the inline style strings.
     */
    function overlayStyle(dark) {
      const palette = dark
        ? { card: '#1f1f24', text: '#f2f2f5', border: '#33333a', body: '#b4b4bd', btn: '#2a2a31', btnBorder: '#3d3d45' }
        : { card: '#ffffff', text: '#1a1a1f', border: '#e2e2e6', body: '#4a4a52', btn: '#f6f6f8', btnBorder: '#d8d8de' }
      return {
        backdrop: `position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:${dark ? 'rgba(0,0,0,.66)' : 'rgba(15,15,17,.55)'}`,
        card: `box-sizing:border-box;width:min(460px,calc(100vw - 32px));padding:20px 22px;border-radius:14px;background:${palette.card};color:${palette.text};border:1px solid ${palette.border};box-shadow:0 18px 48px rgba(0,0,0,.28);font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif`,
        title: 'margin:0 0 8px;font-size:15px;font-weight:600;line-height:1.5',
        body: `margin:0;font-size:13px;line-height:1.7;color:${palette.body};white-space:pre-wrap`,
        actions: 'display:flex;gap:10px;justify-content:flex-end;margin:18px 0 0',
        button: `appearance:none;font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:7px 16px;border:1px solid ${palette.btnBorder};background:${palette.btn};color:${palette.text}`,
        primary: 'appearance:none;font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:7px 16px;border:1px solid #2f6df6;background:#2f6df6;color:#ffffff',
      }
    }

    /**
     * A DOM-only modal card that survives the render layer being torn down.
     *
     * It claims `aria-modal`, so it also has to earn it: focus moves in on
     * show, Tab cycles within the card, Escape runs the dismissing action when
     * the card offers one, and focus returns to whatever held it before. A
     * dialog that traps neither focus nor Escape while telling screen readers
     * the rest of the page is inert would be worse than no ARIA at all.
     * @returns {{ show: (view: object) => void; hide: () => void }} the overlay handle.
     */
    function createOverlay() {
      let backdrop
      let restoreFocus
      let onKeyDown

      /** Focusable children of the current card, in DOM order. */
      const focusables = () => backdrop === undefined
        ? []
        : [...backdrop.querySelectorAll('button')]

      return {
        show(view) {
          if (typeof document === 'undefined') return
          const style = overlayStyle(prefersDark())
          const first = backdrop === undefined || backdrop.parentNode === null
          if (first) {
            // Remember the pre-overlay focus owner once, not on every re-render
            // of the countdown, so the second tick cannot record our own button.
            restoreFocus = document.activeElement
            backdrop = document.createElement('div')
            backdrop.id = OVERLAY_ID
            backdrop.setAttribute('role', 'alertdialog')
            backdrop.setAttribute('aria-modal', 'true')
            document.body.appendChild(backdrop)
            onKeyDown = (event) => {
              if (event.key === 'Tab') {
                const items = focusables()
                if (items.length === 0) return
                const edge = event.shiftKey ? items[0] : items[items.length - 1]
                if (document.activeElement === edge || !backdrop.contains(document.activeElement)) {
                  event.preventDefault()
                  ;(event.shiftKey ? items[items.length - 1] : items[0]).focus()
                }
                return
              }
              // Escape means "leave me alone", which is the non-primary action
              // when one exists; a card without actions is a progress report
              // the user cannot dismiss, so Escape does nothing there.
              if (event.key === 'Escape') {
                const dismiss = (view.actions ?? []).find(action => action.primary !== true)
                if (dismiss !== undefined) {
                  event.preventDefault()
                  dismiss.onClick()
                }
              }
            }
            document.addEventListener('keydown', onKeyDown, true)
          }
          backdrop.setAttribute('style', style.backdrop)
          backdrop.textContent = ''
          const card = document.createElement('div')
          card.setAttribute('style', style.card)
          const title = document.createElement('h2')
          title.setAttribute('style', style.title)
          title.textContent = view.title
          const body = document.createElement('p')
          body.setAttribute('style', style.body)
          body.textContent = view.body
          card.appendChild(title)
          card.appendChild(body)
          if (view.actions !== undefined && view.actions.length > 0) {
            const actions = document.createElement('div')
            actions.setAttribute('style', style.actions)
            for (const action of view.actions) {
              const button = document.createElement('button')
              button.type = 'button'
              button.setAttribute('style', action.primary === true ? style.primary : style.button)
              button.textContent = action.label
              button.addEventListener('click', action.onClick)
              actions.appendChild(button)
            }
            card.appendChild(actions)
          }
          backdrop.appendChild(card)
          // Only on first show: re-focusing on every countdown tick would fight
          // a user who has already tabbed to the other button.
          if (first) focusables()[0]?.focus()
        },
        hide() {
          if (onKeyDown !== undefined) {
            document.removeEventListener('keydown', onKeyDown, true)
            onKeyDown = undefined
          }
          backdrop?.remove()
          backdrop = undefined
          if (restoreFocus !== undefined) {
            if (typeof restoreFocus.focus === 'function' && restoreFocus.isConnected) restoreFocus.focus()
            restoreFocus = undefined
          }
        },
      }
    }

    // ----------------------------------------------------------- controller

    /** How often the panel polls a running install. */
    const POLL_MS = 1500

    /**
     * Seconds shown before an automatic restart fires.
     *
     * A restart ends every session, background job, and connection pool on this
     * host, so this is the window a user has to say "not now". Five seconds was
     * not enough time to read the sentence explaining that, let alone decide.
     */
    const COUNTDOWN_S = 20

    /** How often the watchdog probes for the replacement host. */
    const PROBE_MS = 1000

    /** How long the watchdog waits for the replacement before giving up. */
    const PROBE_TIMEOUT_MS = 90000

    /** Marker surviving a page reload while the replacement host is still starting. */
    const AWAIT_KEY = 'dsh-version-update:awaiting-restart'

    /**
     * Read the reload-surviving await marker.
     * @returns {string | undefined} the version being restarted into, when armed.
     */
    function readAwaitMarker() {
      try {
        return window.sessionStorage.getItem(AWAIT_KEY) ?? undefined
      } catch {
        // Storage can be denied outright (private mode, blocked cookies); the
        // watchdog then simply loses its cross-reload memory.
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
        // See readAwaitMarker: unavailable storage only costs the memory.
      }
    }

    /**
     * Panel state owner plus the restart watchdog. Both live in the plugin's
     * apply closure, never in a React component: the watchdog's entire job is
     * to keep working after the UI it belongs to has been unmounted.
     */
    class VersionUpdateController {
      constructor(deps) {
        this.t = deps.t
        this.overlay = deps.overlay ?? createOverlay()
        this.reload = deps.reload ?? (() => { window.location.reload() })
        this.listeners = new Set()
        this.snapshot = {
          status: 'idle',
          channels: [],
          versions: [],
          selected: undefined,
          installed: undefined,
          installDir: undefined,
          // The version the recorded history offers to roll back to, when the
          // derivation is unambiguous. Undefined most of the time by design.
          rollbackTarget: undefined,
          // Why the registry read failed, when it did. The local facts stay
          // usable, so this is a warning beside them, not the page's error.
          publishedError: undefined,
          task: { state: 'idle', log: '' },
          error: undefined,
          busy: false,
          showLog: false,
          restarting: false,
          // The version awaiting confirmation, if any. An update rewrites a
          // machine-wide package and then ends this host, so it is never one
          // click away.
          confirm: undefined,
        }
        this.pollTimer = undefined
        this.countdownTimer = undefined
        this.probeTimer = undefined
        // The version whose install this page watched. Only that case restarts
        // by itself; a stale host found at page load is offered, not forced.
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

      /**
       * Localize a caught failure. The not-mounted marker is the one case where
       * the wire message is an internal token rather than prose.
       * @param {unknown} error - the caught value.
       * @returns {string} the message to show.
       */
      describeError(error) {
        const message = error instanceof Error ? error.message : String(error)
        return message === NOT_MOUNTED ? this.t('notMounted') : message
      }

      /** Read installed + published facts; also adopts the current task view. */
      check = async () => {
        if (this.snapshot.status === 'loading') return
        this.patch({ status: 'loading', error: undefined })
        try {
          const view = await call(VERSION_API.check)
          const preferred = view.channels?.find(c => c.ahead)?.version
            ?? view.channels?.[0]?.version
            ?? view.versions?.[0]
          this.patch({
            status: 'ready',
            installed: view.installed,
            installDir: view.installDir,
            rollbackTarget: typeof view.rollbackTarget === 'string' ? view.rollbackTarget : undefined,
            channels: view.channels ?? [],
            versions: view.versions ?? [],
            // A failed registry read degrades the response instead of failing
            // it, so this is cleared whenever a fresh read succeeds.
            publishedError: typeof view.publishedError === 'string' ? view.publishedError : undefined,
            task: view.task ?? { state: 'idle', log: '' },
            selected: this.snapshot.selected ?? preferred,
          })
          if (view.task?.state === 'running') this.startPolling()
          else this.adoptTask(view.task)
        } catch (error) {
          this.patch({ status: 'error', error: this.describeError(error) })
        }
      }

      select = (version) => { this.patch({ selected: version }) }

      toggleLog = () => { this.patch({ showLog: !this.snapshot.showLog }) }

      /** Ask for confirmation before installing one version. */
      requestUpdate = (version) => {
        if (this.snapshot.busy) return
        this.patch({ confirm: version, error: undefined })
      }

      /** Abandon a pending confirmation. */
      cancelUpdate = () => { this.patch({ confirm: undefined }) }

      /** Install the version the user just confirmed. */
      confirmUpdate = async () => {
        const version = this.snapshot.confirm
        if (version === undefined) return
        this.patch({ confirm: undefined })
        await this.startUpdate(version)
      }

      /** Start the install of one explicit version and follow it to settlement. */
      startUpdate = async (version) => {
        if (this.snapshot.busy) return
        this.patch({ busy: true, error: undefined, showLog: true })
        // Remember the target now: the install replaces the running package
        // tree, and the UI that would otherwise hold this value may be gone by
        // the time the task settles.
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

      startPolling() {
        if (this.pollTimer !== undefined) return
        const tick = async () => {
          try {
            const task = await call(VERSION_API.status)
            this.patch({ task, busy: task.state === 'running' })
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
       * React to a settled task view.
       *
       * The trigger is `needsRestart`, not `stale`: a finished install proves
       * this process is running superseded code even when the two versions
       * cannot be compared, and that is exactly the case where the page's own
       * assets are already gone. Falling back to `stale` would leave a host with
       * an unknown installed version silently broken after a successful update.
       * @param {object | undefined} task - the settled task view.
       */
      adoptTask(task) {
        if (task === undefined) return
        const needsRestart = task.needsRestart ?? task.stale
        if (needsRestart !== true) return
        if (this.snapshot.restarting === true) return
        // The version now on disk. `installed` is the authoritative field; the
        // task's own `version` only exists when this host ran the install.
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

      /**
       * Offer a restart the user did not trigger from this page.
       * @param {string} installed - the version now on disk.
       * @param {string} running - the version this process is executing.
       */
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

      /**
       * Count down to an automatic restart, cancellable by the user.
       * @param {string} version - the freshly installed version.
       */
      beginCountdown(version) {
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

      /** Stop an armed countdown and drop the overlay. */
      cancelCountdown() {
        if (this.countdownTimer !== undefined) clearTimeout(this.countdownTimer)
        this.countdownTimer = undefined
        this.armedVersion = undefined
        this.overlay.hide()
      }

      /** Ask the host to hand its port to a replacement, then wait for it. */
      restart = async (version) => {
        this.cancelCountdown()
        this.patch({ restarting: true })
        this.overlay.show({ title: this.t('restart.title'), body: this.t('restart.pending', { version }) })
        try {
          await call(VERSION_API.restart, {})
        } catch (error) {
          // A refused restart is final; a dropped connection is not — the host
          // may have exited before its response drained.
          const message = error instanceof Error ? error.message : String(error)
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
       * Probe this origin until the replacement host reports itself running the
       * on-disk version, then reload the page onto its fresh assets.
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
            // The replacement is a fresh process: its own install task is idle
            // and its running version matches the disk, so it reports no need
            // to restart. Reading `needsRestart` rather than `stale` also
            // settles the case where versions cannot be compared — there the
            // old process says "restart needed" purely because its install
            // finished, and only the replacement clears it.
            ready = (task.needsRestart ?? task.stale) !== true
          } catch {
            // The host is down or still binding; that is the expected state for
            // most of this loop.
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
       * Resume a restart this page was already waiting on before it reloaded,
       * or check once whether the host is running stale code. Called from
       * apply, so it also runs when the settings panel is never opened.
       */
      resume = () => {
        const pending = readAwaitMarker()
        if (pending !== undefined) {
          this.awaitReplacement(pending)
          return
        }
        void (async () => {
          try {
            this.adoptTask(await call(VERSION_API.status))
          } catch {
            // A host without this plugin's routes (or an offline page) has
            // nothing to recover from.
          }
        })()
      }

      /**
       * Read the release notes of one exact version, swallowing every failure:
       * notes are an enhancement on the confirmation card, and a missing or
       * unreachable release must never block the install it annotates.
       * @param {string} version - the target version.
       * @returns {Promise<{ text: string; url?: string } | undefined>} the notes, when they exist.
       */
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
        restart: this.restart,
        fetchNotes: this.fetchNotes,
      })

      dispose = () => {
        this.stopPolling()
        if (this.countdownTimer !== undefined) clearTimeout(this.countdownTimer)
        this.countdownTimer = undefined
        if (this.probeTimer !== undefined) clearTimeout(this.probeTimer)
        this.probeTimer = undefined
        this.overlay.hide()
      }
    }

    // ------------------------------------------------------------ component

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

    /**
     * The install log, kept pinned to its newest line.
     *
     * npm writes for minutes and the interesting output is always the tail, so
     * the panel follows it — unless the user has scrolled up to read something,
     * which is a deliberate act the view must not undo.
     */
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

    /**
     * The release notes of the version awaiting confirmation, read once per
     * target. A missing release, a disabled route, or any fetch failure all
     * render as nothing: the card annotates the decision, it never gates it.
     */
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
     * The in-panel confirmation for an install.
     *
     * The action rewrites a machine-wide npm package and then ends this host —
     * every session, background job, and pooled connection on it — so it is
     * gated on an explicit second click that names what will happen. Rendered
     * inline rather than through the DOM overlay because at this point the page
     * is still fully alive; the overlay exists for the state after the update,
     * when it may not be.
     */
    function ConfirmCard(props) {
      const { t, version, installed, fetchNotes, onConfirm, onCancel } = props
      const ref = React.useRef(null)
      React.useEffect(() => { ref.current?.focus() }, [])
      // A target below the installed version is a rollback, not an update:
      // naming it as one in the title, body, and action keeps the second click
      // an informed one for the direction that is easiest to trigger by
      // accident (any list position above the current row).
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

    /** The version-update settings page. */
    function VersionUpdateSection(props) {
      const { t, useVersionUpdate, check, select, toggleLog, requestUpdate, confirmUpdate, cancelUpdate, restart, fetchNotes } = props
      const state = useVersionUpdate(s => s)

      // One read on mount so the page shows facts without a manual click.
      React.useEffect(() => {
        if (state.status === 'idle') void check()
      }, [])

      const loading = state.status === 'loading'
      const running = state.task.state === 'running' || state.busy
      // The restart-pending state: either the versions disagree, or an install
      // finished in this process, which proves the same thing without needing
      // them to be comparable.
      const needsRestart = (state.task.needsRestart ?? state.task.stale) === true
      const ahead = state.channels.filter(c => c.ahead)
      const channelLabel = (channel) => {
        const key = `channel.${channel}`
        const text = t(key)
        return text === key ? channel : text
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

      return h('div', { className: 'dshvu_page' },
        h('section', { className: 'dshvu_card' },
          h('h3', { className: 'dshvu_title' }, t('title')),
          h(Line, { label: t('installed'), value: state.installed ?? t('unknown') }),
          // The running version only earns a row once it disagrees with the
          // installed one, which is exactly the restart-pending state.
          needsRestart && state.task.running !== undefined
            ? h(Line, { label: t('running'), value: state.task.running })
            : null,
          state.installDir !== undefined
            ? h(PathLine, { label: t('installDir'), value: state.installDir })
            : null,
          verdict !== undefined ? h('p', { className: 'dshvu_hint' }, verdict) : null,
          // The registry read failed while the local facts above still stand:
          // a warning beside them, not a page-level error that hides them.
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
              onClick: () => { void check() },
            }, loading ? t('checking') : t('check')),
            needsRestart && state.task.restartable === true
              ? h('button', {
                type: 'button',
                className: 'dshvu_btn dshvu_btnPrimary',
                disabled: state.restarting === true,
                onClick: () => { void restart(state.installed ?? '') },
              }, state.restarting === true ? t('restart.pendingShort') : t('restart.now'))
              : null,
            // The rollback offer appears only when the recorded history makes
            // it unambiguous (see lib/history.js): the last successful install
            // is exactly the one that produced what is on disk now. It flows
            // through the same confirmation as any install — and since a
            // rollback target is by construction older, it reads as a
            // downgrade there.
            state.rollbackTarget !== undefined && state.rollbackTarget !== state.installed && !running
              ? h('button', {
                type: 'button',
                className: 'dshvu_btn',
                onClick: () => { requestUpdate(state.rollbackTarget) },
              }, t('rollback', { version: state.rollbackTarget }))
              : null,
            loading ? h('span', { className: 'dshvu_spin' }, t('checking')) : null),
          state.status === 'error'
            ? h('p', { className: 'dshvu_error' }, t('loadFailed', { error: state.error ?? '' }))
            : null),

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

        state.channels.length > 0
          ? h('section', { className: 'dshvu_card' },
            h('h3', { className: 'dshvu_title' }, t('channels')),
            h('ul', { className: 'dshvu_chanList' }, state.channels.map(c =>
              h('li', { className: 'dshvu_chan', key: c.channel },
                h('span', { className: 'dshvu_chanName' }, channelLabel(c.channel)),
                h('span', { className: 'dshvu_chanVersion' }, c.version),
                h('span', {
                  className: 'dshvu_badge ' + (c.ahead ? 'dshvu_badgeAhead' : 'dshvu_badgeCurrent'),
                }, c.ahead ? t('badge.ahead') : t('badge.current')),
                // The installed channel row carries its 已是最新 badge instead
                // of a permanently disabled action; the grid keeps the action
                // column aligned across rows either way. A channel may sit
                // BEHIND the installed version (next pre-release vs latest,
                // say) — that row is a rollback and says so.
                c.version === state.installed
                  ? null
                  : h('button', {
                    type: 'button',
                    className: 'dshvu_btn dshvu_chanAction' + (c.ahead ? ' dshvu_btnPrimary' : ''),
                    disabled: running,
                    onClick: () => { requestUpdate(c.version) },
                  }, running
                    ? t('updating')
                    : isDowngrade(c.version, state.installed)
                      ? t('downgradeTo', { version: c.version })
                      : t('update'))))))
          : null,

        state.versions.length > 0
          ? h('section', { className: 'dshvu_card' },
            h('h3', { className: 'dshvu_title' }, t('allVersions')),
            h('div', { className: 'dshvu_row' },
              h('label', { className: 'dshvu_label', htmlFor: 'dshvu-target' }, t('target')),
              h('span', { className: 'dshvu_selectWrap' },
                h('select', {
                  id: 'dshvu-target',
                  className: 'dshvu_select',
                  value: state.selected ?? '',
                  disabled: running,
                  onChange: (event) => { select(event.target.value) },
                }, state.versions.map(v => {
                  const labels = [];
                  for (const c of state.channels) {
                    if (c.version === v) {
                      const key = c.channel === 'latest' ? 'channel.latest' : 'channel.next';
                      const label = t(key);
                      const short = label.replace(/^.*\((.+)\)$/, '$1');
                      if (short && !labels.includes(short)) labels.push(short);
                    }
                  }
                  const suffix = labels.length > 0 ? ` (${labels.join('/')})` : '';
                  return h('option', { key: v, value: v }, v + suffix);
                }))),
              h('span', { className: 'dshvu_grow' }),
              state.task.log !== ''
                ? h('button', {
                  type: 'button',
                  className: 'dshvu_btn',
                  onClick: () => { toggleLog() },
                }, t('log'))
                : null,
              h('button', {
                type: 'button',
                className: 'dshvu_btn dshvu_btnPrimary',
                disabled: running || state.selected === undefined || state.selected === state.installed,
                onClick: () => { if (state.selected !== undefined) requestUpdate(state.selected) },
              }, running
                ? t('updating')
                : state.selected !== undefined && state.selected !== state.installed
                  ? isDowngrade(state.selected, state.installed)
                    ? t('downgradeTo', { version: state.selected })
                    : t('updateTo', { version: state.selected })
                  : t('update'))),
            // Progress is announced, not just drawn: the install runs for
            // minutes with no other feedback, so a screen reader has to hear
            // each settlement without polling the page itself.
            h('p', {
              className: 'dshvu_hint',
              role: 'status',
              'aria-live': 'polite',
            }, taskLine ?? ''),
            state.error !== undefined && state.status !== 'error'
              ? h('p', { className: 'dshvu_error', role: 'alert' }, state.error)
              : null,
            state.showLog && state.task.log !== ''
              ? h(LogView, { text: state.task.log })
              : null,
            h('p', { className: 'dshvu_hint' }, t('restartHint')),
            h('p', { className: 'dshvu_hint' }, t('localOnly')))
          : null)
    }

    // ------------------------------------------------------------- locales

    const zh = {
      'nav': '版本更新',
      'title': '版本更新',
      'installed': '当前版本',
      'running': '运行中版本',
      'installDir': '安装位置',
      'unknown': '未知',
      'channels': '发布通道',
      'channel.latest': '稳定版 (latest)',
      'channel.next': '预发布 (next)',
      'badge.ahead': '可更新',
      'badge.current': '已是最新',
      'check': '检查更新',
      'checking': '正在检查…',
      'update': '更新到此版本',
      'updating': '正在更新…',
      'updateTo': '更新到 {version}',
      'downgradeTo': '降级到 {version}',
      'rollback': '回滚到 {version}',
      'notes.link': '在 GitHub 查看完整发布说明',
      'publishFailed': '在线版本读取失败：{error}。以上为本机信息；请检查网络或 registry 配置后重试。',
      'target': '目标版本',
      'allVersions': '全部已发布版本',
      'upToDate': '已是最新版本。',
      'available': '发现新版本 {version}。',
      'task.running': '正在安装 {version}…',
      'task.done': '{version} 安装完成。',
      'task.failed': '安装失败：{error}',
      'log': '安装日志',
      'confirm.title': '确认更新',
      'confirm.body': '即将把全局 npm 包 @deepseek-ai/dsh 从 {installed} 更新到 {version}。',
      'confirm.downgradeTitle': '确认降级',
      'confirm.downgradeBody': '即将把全局 npm 包 @deepseek-ai/dsh 从 {installed} 回退到更早的版本 {version}。降级与升级一样会改写全局安装并重启宿主。',
      'confirm.impact': '这会改写本机的全局安装，并在安装完成后重启宿主进程：当前所有会话、后台任务、SSH 连接池与任务看板的执行都会随之结束，未落盘的状态将丢失。',
      'confirm.cancel': '取消',
      'confirm.proceed': '确认更新到 {version}',
      'confirm.proceedDowngrade': '确认降级到 {version}',
      'notMounted': '本插件的宿主路由尚未挂载：插件安装后需要重启 dsh 才会生效，请重新运行 dsh web 后再试。',
      'restartHint': '更新会覆盖运行中的 dsh 全局包，安装完成后会自动重启宿主进程并重新载入本页面。',
      'localOnly': '仅本机浏览器可用：远程访问无法读取或执行更新。',
      'loadFailed': '读取版本信息失败：{error}',
      'restart.title': '需要重启 dsh',
      'restart.countdown': '{version} 安装完成。更新已覆盖运行中的程序目录，本页面的资源随之失效，{seconds} 秒后自动重启 dsh 并重新载入页面。',
      'restart.staleBody': '磁盘上已是 {installed}，但当前进程仍在运行 {running}。重启后新版本才会生效，本页面也会重新载入。',
      'restart.unavailable': '磁盘上已是 {installed}，当前进程仍在运行 {running}。此实例监听系统随机分配的端口，无法自动重启：请手动关闭并重新运行 dsh web。',
      'restart.pending': '正在重启 dsh（{version}）…',
      'restart.pendingShort': '正在重启…',
      'restart.waiting': '旧进程已退出，正在等待新进程接管端口（{version}）…',
      'restart.reload': '{version} 已就绪，正在重新载入页面…',
      'restart.timeout': '等待新进程超时（{version}）。请检查终端，或手动重新运行 dsh web。',
      'restart.failed': '自动重启失败：{error}。请手动关闭并重新运行 dsh web。',
      'restart.now': '立即重启',
      'restart.later': '稍后',
      'restart.dismiss': '知道了',
      'restart.reloadNow': '仍然重新载入',
    }

    const en = {
      'nav': 'Version Update',
      'title': 'Version Update',
      'installed': 'Installed',
      'running': 'Running',
      'installDir': 'Install path',
      'unknown': 'unknown',
      'channels': 'Release channels',
      'channel.latest': 'Stable (latest)',
      'channel.next': 'Pre-release (next)',
      'badge.ahead': 'Update available',
      'badge.current': 'Up to date',
      'check': 'Check for updates',
      'checking': 'Checking…',
      'update': 'Update to this version',
      'updating': 'Updating…',
      'updateTo': 'Update to {version}',
      'downgradeTo': 'Downgrade to {version}',
      'rollback': 'Roll back to {version}',
      'notes.link': 'View the full release notes on GitHub',
      'publishFailed': 'Failed to read published versions: {error}. The local facts above still stand; check the network or registry configuration and retry.',
      'target': 'Target version',
      'allVersions': 'All published versions',
      'upToDate': 'Already on the newest version.',
      'available': 'Version {version} is available.',
      'task.running': 'Installing {version}…',
      'task.done': '{version} installed.',
      'task.failed': 'Install failed: {error}',
      'log': 'Install log',
      'confirm.title': 'Confirm update',
      'confirm.body': 'This will update the global npm package @deepseek-ai/dsh from {installed} to {version}.',
      'confirm.downgradeTitle': 'Confirm downgrade',
      'confirm.downgradeBody': 'This will roll the global npm package @deepseek-ai/dsh back from {installed} to the earlier {version}. A downgrade rewrites the global install and restarts the host exactly like an upgrade.',
      'confirm.impact': 'It rewrites this machine\'s global installation and then restarts the host: every session, background job, pooled SSH connection, and running board task ends with it, and anything unsaved is lost.',
      'confirm.cancel': 'Cancel',
      'confirm.proceed': 'Update to {version}',
      'confirm.proceedDowngrade': 'Downgrade to {version}',
      'notMounted': 'This plugin\'s host routes are not mounted yet: adding the plugin takes effect only after dsh restarts. Run dsh web again and retry.',
      'restartHint': 'An update overwrites the running dsh global package; when it finishes, the host restarts itself and this page reloads.',
      'localOnly': 'Loopback only: a remote browser can neither read nor run the update.',
      'loadFailed': 'Failed to read version facts: {error}',
      'restart.title': 'dsh must restart',
      'restart.countdown': '{version} installed. The update replaced the running program directory, so this page\'s assets are gone; dsh restarts and the page reloads in {seconds}s.',
      'restart.staleBody': 'Disk now holds {installed} while this process still runs {running}. A restart activates the new version and reloads this page.',
      'restart.unavailable': 'Disk now holds {installed} while this process still runs {running}. This host listens on an OS-assigned port and cannot restart itself: stop and start dsh web yourself.',
      'restart.pending': 'Restarting dsh ({version})…',
      'restart.pendingShort': 'Restarting…',
      'restart.waiting': 'The old process exited; waiting for the replacement to take the port ({version})…',
      'restart.reload': '{version} is ready — reloading the page…',
      'restart.timeout': 'Timed out waiting for the replacement ({version}). Check the terminal, or run dsh web again.',
      'restart.failed': 'Automatic restart failed: {error}. Stop and start dsh web yourself.',
      'restart.now': 'Restart now',
      'restart.later': 'Later',
      'restart.dismiss': 'Got it',
      'restart.reloadNow': 'Reload anyway',
    }

    // ------------------------------------------------------------- nav icon

    /**
     * Keep {@link NAV_MARKER} on the settings-nav button whose visible text is
     * this plugin's current localized section label.
     *
     * A `settings.section` registration projects only `id`, `order`, and
     * `label`; the shell chooses its glyph from a closed list of built-in ids,
     * so an out-of-tree section cannot supply one through the contract. This
     * marks nothing but its own row — matched by the same label the
     * registration publishes, so it follows a locale change — and owns no shell
     * structure, so removing the attribute fully reverses it.
     *
     * The observer watches the whole body because the settings panel is a modal
     * that mounts anywhere in the tree, but its callback is coalesced into one
     * animation frame: this is a chat application whose message stream mutates
     * `characterData` per token, and re-running a `querySelectorAll` on every
     * one of those would make an idle plugin measurably expensive.
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
        // The panel is a modal that mounts and unmounts, and its rows
        // re-render on locale change, so the match is re-evaluated rather
        // than captured.
        for (const button of document.querySelectorAll('[role="dialog"] nav button')) {
          if (current.length > 0 && button.textContent?.trim() === current) {
            button.setAttribute(NAV_MARKER, '')
          } else {
            button.removeAttribute(NAV_MARKER)
          }
        }
      }
      /** Collapse a burst of mutations into a single sync on the next frame. */
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

    // ---------------------------------------------------------------- plugin

    const inject = ['slots', 'locale']

    /**
     * Register the 版本更新 settings page: its dictionaries, one
     * `settings.section` nav entry whose content is the panel above, its nav
     * glyph marker, and the restart watchdog.
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

      const controller = createController({ t: ctx.locale.bind(NS) })
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
     * Build the panel controller.
     *
     * Exported because this module is a hand-written loader factory with no
     * build step: the controller owns the update lifecycle, the countdown, and
     * the restart watchdog — the logic most worth testing — and this is the only
     * seam through which a test can hand it a fake overlay and reload.
     * @param {{ t: (key: string, params?: object) => string; overlay?: object; reload?: () => void }} deps - the label resolver plus test seams.
     * @returns {VersionUpdateController} the controller.
     */
    function createController(deps) {
      return new VersionUpdateController(deps)
    }

    exports.apply = apply
    exports.inject = inject
    exports.createController = createController
    // Exported for one specific test: the browser ranking is a hand-maintained
    // mirror of lib/core.js, and a test walks both through the same version
    // matrix so the copies cannot silently disagree.
    exports.compareVersionTexts = compareVersionTexts
    exports.isDowngrade = isDowngrade
    return module.exports
  },
})

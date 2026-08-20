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

    /** Same-origin JSON call unwrapping the host's `{ result }` / `{ error }` envelope. */
    async function call(path, body) {
      const response = await fetch(path, body === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
      return payload.result
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
.dshvu_page{display:flex;flex-direction:column;gap:16px;padding:4px 0 16px}
.dshvu_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:16px}
.dshvu_row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.dshvu_rowSplit{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:6px 0}
.dshvu_label{color:var(--dsw-alias-label-tertiary);font-size:13px;white-space:nowrap}
.dshvu_value{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
/* The install path is long and unbreakable at word boundaries, so it gets its
 * own full-width line instead of competing with the label in a split row. */
.dshvu_pathRow{display:flex;flex-direction:column;gap:4px;padding:6px 0}
.dshvu_path{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;word-break:break-all}
.dshvu_title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;margin:0 0 10px}
.dshvu_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;margin:8px 0 0}
.dshvu_warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:1.6;margin:8px 0 0}
.dshvu_sep{border-top:1px solid var(--dsw-alias-border-l2);margin:12px 0 0;padding-top:4px}
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
.dshvu_log{margin:12px 0 0;padding:10px 12px;max-height:260px;overflow:auto;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-all}
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
[${NAV_MARKER}]::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("${NAV_GLYPH}") center / contain no-repeat;mask:url("${NAV_GLYPH}") center / contain no-repeat}
`
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-version-update'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
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
     */
    const OVERLAY_ID = 'dsh-version-update-restart-overlay'

    /** Fixed geometry and colors of the recovery overlay. */
    const OVERLAY_STYLE = {
      backdrop: 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(15,15,17,.55)',
      card: 'box-sizing:border-box;width:min(460px,calc(100vw - 32px));padding:20px 22px;border-radius:14px;background:#ffffff;color:#1a1a1f;border:1px solid #e2e2e6;box-shadow:0 18px 48px rgba(0,0,0,.28);font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
      title: 'margin:0 0 8px;font-size:15px;font-weight:600;line-height:1.5',
      body: 'margin:0;font-size:13px;line-height:1.7;color:#4a4a52;white-space:pre-wrap',
      actions: 'display:flex;gap:10px;justify-content:flex-end;margin:18px 0 0',
      button: 'appearance:none;font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:7px 16px;border:1px solid #d8d8de;background:#f6f6f8;color:#1a1a1f',
      primary: 'appearance:none;font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:7px 16px;border:1px solid #2f6df6;background:#2f6df6;color:#ffffff',
    }

    /**
     * A DOM-only modal card that survives the render layer being torn down.
     * @returns {{ show: (view: object) => void; hide: () => void }} the overlay handle.
     */
    function createOverlay() {
      let backdrop
      return {
        show(view) {
          if (typeof document === 'undefined') return
          if (backdrop === undefined || backdrop.parentNode === null) {
            backdrop = document.createElement('div')
            backdrop.id = OVERLAY_ID
            backdrop.setAttribute('role', 'alertdialog')
            backdrop.setAttribute('aria-modal', 'true')
            backdrop.setAttribute('style', OVERLAY_STYLE.backdrop)
            document.body.appendChild(backdrop)
          }
          backdrop.textContent = ''
          const card = document.createElement('div')
          card.setAttribute('style', OVERLAY_STYLE.card)
          const title = document.createElement('h2')
          title.setAttribute('style', OVERLAY_STYLE.title)
          title.textContent = view.title
          const body = document.createElement('p')
          body.setAttribute('style', OVERLAY_STYLE.body)
          body.textContent = view.body
          card.appendChild(title)
          card.appendChild(body)
          if (view.actions !== undefined && view.actions.length > 0) {
            const actions = document.createElement('div')
            actions.setAttribute('style', OVERLAY_STYLE.actions)
            for (const action of view.actions) {
              const button = document.createElement('button')
              button.type = 'button'
              button.setAttribute('style', action.primary === true ? OVERLAY_STYLE.primary : OVERLAY_STYLE.button)
              button.textContent = action.label
              button.addEventListener('click', action.onClick)
              actions.appendChild(button)
            }
            card.appendChild(actions)
          }
          backdrop.appendChild(card)
        },
        hide() {
          backdrop?.remove()
          backdrop = undefined
        },
      }
    }

    // ----------------------------------------------------------- controller

    /** How often the panel polls a running install. */
    const POLL_MS = 1500

    /** Seconds shown before an automatic restart fires. */
    const COUNTDOWN_S = 5

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
          task: { state: 'idle', log: '' },
          error: undefined,
          busy: false,
          showLog: false,
          restarting: false,
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
            channels: view.channels ?? [],
            versions: view.versions ?? [],
            selected: this.snapshot.selected ?? preferred,
            task: view.task ?? { state: 'idle', log: '' },
          })
          if (view.task?.state === 'running') this.startPolling()
          else this.adoptTask(view.task)
        } catch (error) {
          this.patch({ status: 'error', error: error instanceof Error ? error.message : String(error) })
        }
      }

      select = (version) => { this.patch({ selected: version }) }

      toggleLog = () => { this.patch({ showLog: !this.snapshot.showLog }) }

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
          this.patch({ busy: false, error: error instanceof Error ? error.message : String(error) })
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
            this.patch({ busy: false, error: error instanceof Error ? error.message : String(error) })
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
       * React to a settled task view. `stale` means the host is executing one
       * version while a different one sits on disk — the state in which the
       * page's own asset URLs no longer exist, so it cannot be left alone.
       * @param {object | undefined} task - the settled task view.
       */
      adoptTask(task) {
        if (task === undefined || task.stale !== true) return
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
            ready = task.stale !== true
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

      /** The inject face: the hooks compartment plus plain callbacks. */
      inject = () => ({
        hooks: { versionUpdate: { getSnapshot: this.getSnapshot, subscribe: this.subscribe } },
        check: this.check,
        select: this.select,
        toggleLog: this.toggleLog,
        startUpdate: this.startUpdate,
        restart: this.restart,
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

    /** The version-update settings page. */
    function VersionUpdateSection(props) {
      const { t, useVersionUpdate, check, select, toggleLog, startUpdate, restart } = props
      const state = useVersionUpdate(s => s)

      // One read on mount so the page shows facts without a manual click.
      React.useEffect(() => {
        if (state.status === 'idle') void check()
      }, [])

      const loading = state.status === 'loading'
      const running = state.task.state === 'running' || state.busy
      const stale = state.task.stale === true
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
          stale && state.task.running !== undefined
            ? h(Line, { label: t('running'), value: state.task.running })
            : null,
          state.installDir !== undefined
            ? h(PathLine, { label: t('installDir'), value: state.installDir })
            : null,
          verdict !== undefined ? h('p', { className: 'dshvu_hint' }, verdict) : null,
          stale
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
            stale && state.task.restartable === true
              ? h('button', {
                type: 'button',
                className: 'dshvu_btn dshvu_btnPrimary',
                disabled: state.restarting === true,
                onClick: () => { void restart(state.installed ?? '') },
              }, state.restarting === true ? t('restart.pendingShort') : t('restart.now'))
              : null,
            loading ? h('span', { className: 'dshvu_spin' }, t('checking')) : null),
          state.status === 'error'
            ? h('p', { className: 'dshvu_error' }, t('loadFailed', { error: state.error ?? '' }))
            : null),

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
                // column aligned across rows either way.
                c.version === state.installed
                  ? null
                  : h('button', {
                    type: 'button',
                    className: 'dshvu_btn dshvu_chanAction' + (c.ahead ? ' dshvu_btnPrimary' : ''),
                    disabled: running,
                    onClick: () => { void startUpdate(c.version) },
                  }, running ? t('updating') : t('update'))))))
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
                }, state.versions.map(v => h('option', { key: v, value: v }, v)))),
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
                onClick: () => { if (state.selected !== undefined) void startUpdate(state.selected) },
              }, running ? t('updating') : t('update'))),
            taskLine !== undefined ? h('p', { className: 'dshvu_hint' }, taskLine) : null,
            state.error !== undefined && state.status !== 'error'
              ? h('p', { className: 'dshvu_error' }, state.error)
              : null,
            state.showLog && state.task.log !== ''
              ? h('pre', { className: 'dshvu_log' }, state.task.log)
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
      'target': '目标版本',
      'allVersions': '全部已发布版本',
      'upToDate': '已是最新版本。',
      'available': '发现新版本 {version}。',
      'task.running': '正在安装 {version}…',
      'task.done': '{version} 安装完成。',
      'task.failed': '安装失败：{error}',
      'log': '安装日志',
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
      'target': 'Target version',
      'allVersions': 'All published versions',
      'upToDate': 'Already on the newest version.',
      'available': 'Version {version} is available.',
      'task.running': 'Installing {version}…',
      'task.done': '{version} installed.',
      'task.failed': 'Install failed: {error}',
      'log': 'Install log',
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
     * @param {() => string} label - the locale-aware label resolver.
     * @returns {() => void} disposer clearing the observer and every marker.
     */
    function markNavRow(label) {
      if (typeof document === 'undefined') return () => {}
      let disposed = false
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
      sync()
      const observer = new MutationObserver(sync)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      return () => {
        disposed = true
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

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

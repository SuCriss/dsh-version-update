/**
 * dsh-version-update — host half. Serves the loopback-only
 * /api/dsh-version-update route family: the npm registry check that reports
 * the installed dsh version against the published `latest` / `next` tags, the
 * update start that runs one `npm install -g @deepseek-ai/dsh@<version>`, the
 * status poll that follows it, and the restart handoff that brings the new
 * version into service. The browser half (./client) renders the 版本更新 page
 * in the Web GUI settings panel.
 *
 * Only exact published versions are accepted as install targets and npm is
 * spawned without a shell, so neither registry text nor browser input can
 * reach a command line as a range, a tag, or a metacharacter.
 *
 * The installed version is read once at mount and reported as `running`: a
 * successful update replaces the very package tree this process serves its
 * frontend assets from, so after it finishes `running` and the on-disk version
 * disagree and the open page holds asset URLs the new tree no longer contains.
 * That difference is what the panel uses to require a restart instead of a
 * plain reload.
 * @module dsh-version-update
 */

import z from '@deepseek-ai/schemastery'
import { makeRoutes } from './routes.js'
import { createUpdater, resolveNpmCli } from './updater.js'
import { createRestarter, parseRequestedPort } from './restarter.js'
import {
  DEFAULT_REGISTRY,
  createNotesReader,
  evaluateAutoCheck,
  fetchPublished,
  normalizeRegistry,
  readInstalled,
  readRepository,
  resolveInstallationDir,
} from './core.js'
import { appendHistory, defaultHistoryPath, loadHistory, summarizeHistory } from './history.js'

/** Stable cordis plugin name. */
export const name = 'version-update'

/** Services required before the routes can mount. */
export const inject = ['webServer']

/**
 * Entry config, validated by cordis before this plugin starts.
 *
 * Declaring it as a schema rather than reading a plain object is what makes a
 * typo in a profile's patch layer fail the load with a named issue instead of
 * silently disabling a feature, and it is what the settings panel's plugin
 * inventory renders a configuration form from.
 */
export const Config = z.object({
  announceToAgent: z.boolean().default(true)
    .description('Inject this plugin\'s capability paragraph into the agent\'s system prompt.'),
  registry: z.string().default(DEFAULT_REGISTRY)
    .description('Base URL of the npm registry read for versions AND installed from.'),
  allowRestart: z.boolean().default(true)
    .description('Serve the restart route. When false the panel only reports that a manual restart is needed.'),
  releaseNotes: z.boolean().default(true)
    .description('Fetch the GitHub release notes of a target version and show them on the confirmation card.'),
  autoCheckIntervalHours: z.number().default(0)
    .description('Periodically check the registry for a newer version. 0 disables the loop; e.g. 24 checks daily. A discovery updates the agent announcement and the panel.'),
  autoRollbackOnFailedRestart: z.boolean().default(false)
    .description('When a restart into a new version never becomes reachable, the relaunch helper reinstalls the previous version and starts over. Opt-in: the recovery reinstall runs while the broken process may still hold files (notably on Windows).'),
}).description('Version update: report the installed dsh version, install another, restart into it.')

/** Order of the announcement section within the tool-guidance band (100–199). */
const SECTION_ORDER = 195

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const VERSION_UPDATE_GUIDANCE = '本机已安装 dsh-version-update 插件（DeepSeek Harness 版本更新）：设置面板左侧「版本更新」一级菜单可查看当前安装版本与安装路径，读取 npm registry 上 @deepseek-ai/dsh 的 latest / next 通道与全部已发布版本，并更新到所选版本——包括降级到更早版本（降级目标会以「降级」明确标出并需确认）。确认卡片会展示目标版本的 GitHub 发布说明摘要；安装历史支持一键回滚到上一版本（回滚同样走降级确认）。点击后先弹出确认卡片说明影响，确认后宿主后台执行 `npm install -g @deepseek-ai/dsh@<版本>`，带实时安装日志。安装成功后页面会自动重启宿主并重新载入：更新会覆盖运行中的 dsh 包目录，旧页面持有的 /assets/<hash> 资源随之消失，不重启只刷新会白屏；自动重启前有 20 秒可取消的倒计时。重启由 POST /api/dsh-version-update/restart 触发，宿主写下命令行后 spawn 一个脱离父进程的 relaunch 助手，退出旧进程，助手等端口释放再以原样 argv 拉起新进程；页面用一个不依赖 React 的 watchdog 轮询同一 URL，新进程应答后自动 location.reload()。限制：路由仅限 loopback；只接受精确已发布版本号，不接受 range 或 dist-tag；整个进程同时只允许一个安装任务（插件热重载后依然受限，直到上一次安装结束）；registry 不可达时版本列表不可用，但本机版本与路径仍会显示；以 --port 0 启动（请求 OS 随机端口）时不提供重启，因为新进程会绑到另一个端口。配置项 registry 同时用于读取版本与执行安装（安装带 --registry）；autoCheckIntervalHours 开启定时检查后发现新版本时本插件会在系统提示中追加提示；autoRollbackOnFailedRestart 可在重启失败时自动回滚。用户提到「版本更新 / 检查更新 / 升级 dsh / 降级 dsh / dsh 新版本 / 回退 dsh 版本 / 回滚 dsh / 重启 dsh」时即指本插件，请据此协作。'

/**
 * The interval between auto-checks, clamped to sane bounds. Values below the
 * floor are bumped rather than rejected: an entry typo should not disable the
 * feature by surprise, but it also must not hammer the registry.
 */
const AUTO_CHECK_MIN_MS = 60 * 60 * 1000

/**
 * Mount the version-update routes and the optional model announcement.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context carrying webServer.
 * @param {{ announceToAgent: boolean; registry: string; allowRestart: boolean; releaseNotes: boolean; autoCheckIntervalHours: number; autoRollbackOnFailedRestart: boolean }} [config] - entry config, already validated against {@link Config}.
 */
export function apply(ctx, config) {
  const registry = config?.registry === undefined ? undefined : normalizeRegistry(config.registry)
  // Resolved once: the installation directory cannot move while this process
  // lives, and the discovery walk (`require.resolve` plus several `existsSync`
  // probes) would otherwise run on every status poll — once a second while the
  // restart watchdog is waiting.
  const installDir = resolveInstallationDir()
  // Captured at mount: the version whose code this process is actually
  // executing, which an update later makes disagree with the on-disk manifest.
  const running = readInstalled(installDir).installed
  // The GitHub repository release notes are read from, derived once from the
  // installed manifest.
  const repoSlug = readRepository(installDir)

  // ---- install history ----------------------------------------------------
  // One file under the user's home records every settled install; from it the
  // panel derives the rollback offer. Recording happens through the updater's
  // settlement hook, so nothing else in the plugin needs to know when npm
  // finishes.
  const historyPath = defaultHistoryPath()
  /**
   * Build the settlement recorder for one mount: `from` is the version this
   * process was running when an install started.
   * @param {string | undefined} from - the version running before the install.
   * @returns {(info: { version: string; ok: boolean }) => void} the observer.
   */
  const recordInstall = (from) => (info) => {
    appendHistory(historyPath, {
      at: Date.now(),
      ...(from !== undefined ? { from } : {}),
      to: info.version,
      result: info.ok ? 'ok' : 'failed',
    })
  }
  const updater = createUpdater({
    ...(registry !== undefined ? { registry } : {}),
    onSettled: recordInstall(running),
  })

  // ---- periodic auto-check ------------------------------------------------
  const intervalMsRaw = (config?.autoCheckIntervalHours ?? 0) * 60 * 60 * 1000
  const intervalMs = intervalMsRaw > 0 ? Math.max(intervalMsRaw, AUTO_CHECK_MIN_MS) : 0
  /** @type {{ checkedAt?: number; updateAvailable: boolean; latestVersion?: string; error?: string }} */
  const autoCheckState = { updateAvailable: false }
  let pendingGuidance = /** @type {(() => void) | undefined} */ (undefined)
  const runAutoCheck = async () => {
    try {
      const published = await fetchPublished({ ...(registry !== undefined ? { registry } : {}) })
      const verdict = evaluateAutoCheck({ ...readInstalled(installDir), ...published })
      autoCheckState.checkedAt = Date.now()
      autoCheckState.error = undefined
      if (verdict.latest !== undefined) autoCheckState.latestVersion = verdict.latest
      autoCheckState.updateAvailable = verdict.updateAvailable
      // A discovery is worth telling the model about proactively — that is
      // the closest thing to a notification a system prompt can carry. The
      // pending section replaces itself as versions change and never lingers
      // after the user has caught up (a fresh process after the update
      // re-evaluates from scratch).
      if (verdict.updateAvailable && verdict.latest !== undefined && config?.announceToAgent !== false) {
        const sp = ctx.get('systemPrompt')
        if (sp !== undefined) {
          pendingGuidance?.()
          try {
            pendingGuidance = sp.section({
              name: 'plugin:dsh-version-update:pending',
              order: SECTION_ORDER + 1,
              text: `检测到 @deepseek-ai/dsh 新版本 ${verdict.latest}${running !== undefined ? `（当前 ${running}）` : ''}：设置面板「版本更新」页可一键更新，更新会重启宿主。用户问到版本或更新时请主动告知这一发现。`,
            })
          } catch {
            pendingGuidance = undefined
          }
        }
      }
    } catch (error) {
      autoCheckState.checkedAt = Date.now()
      autoCheckState.error = error instanceof Error ? error.message : String(error)
    }
  }

  // The port this invocation asked for, read once from the command line the
  // replacement will inherit. `webServer.port` cannot answer this: it is the
  // RESOLVED port, so a host started with `--port 0` reports a real number and
  // the restarter would happily arm a handoff nothing could find again.
  const requestedPort = parseRequestedPort(process.argv)

  const restarter = config?.allowRestart === false ? undefined : createRestarter({
    ...(installDir !== undefined ? { installDir: () => installDir } : {}),
    address: () => {
      const port = ctx.webServer.port
      if (typeof port !== 'number') return undefined
      // The bind host is the address the replacement must claim; the panel
      // polls its own origin, so only the port has to match.
      return {
        host: ctx.webServer.host,
        port,
        ...(requestedPort !== undefined ? { requestedPort } : {}),
      }
    },
    // Auto-rollback arms per restart with everything the detached helper
    // needs to reinstall the version THIS process runs, without asking this
    // (exiting) process for anything.
    ...(config?.autoRollbackOnFailedRestart === true
      ? {
        rollback: () => {
          if (running === undefined) return undefined
          const npmCli = resolveNpmCli()
          if (npmCli === undefined) return undefined
          return {
            package: '@deepseek-ai/dsh',
            version: running,
            ...(registry !== undefined ? { registry } : {}),
            npmCli,
          }
        },
      }
      : {}),
  })

  // Release notes share one cached reader; misses cache too, so a version
  // without a GitHub release costs one lookup per hour, not per card open.
  const notesReader = config?.releaseNotes === false ? undefined : createNotesReader()

  ctx.effect(() => {
    const disposers = makeRoutes({
      updater,
      ...(restarter !== undefined ? { restarter } : {}),
      ...(running !== undefined ? { running } : {}),
      ...(registry !== undefined ? { registry } : {}),
      ...(installDir !== undefined ? { installDir } : {}),
      ...(notesReader !== undefined && repoSlug !== undefined
        ? { notes: notesReader, repoSlug }
        : {}),
      ...(intervalMs > 0 ? { autoCheck: () => ({ ...autoCheckState }) } : {}),
      // The rollback offer is independent of the auto-check loop: it derives
      // from the recorded history and the on-disk manifest on every poll.
      ...{ historySummary: () => summarizeHistory(loadHistory(historyPath), readInstalled(installDir).installed) },
    }).routes.map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
      updater.dispose()
    }
  }, 'dsh-version-update: routes')

  // The auto-check loop belongs to its own effect so a fiber reload stops it
  // deterministically; the first tick runs immediately when enabled, so the
  // panel's ambient facts are warm from the start.
  if (intervalMs > 0) {
    ctx.effect(() => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer
      let stopped = false
      const schedule = () => {
        timer = setTimeout(() => {
          void runAutoCheck().then(() => {
            if (!stopped) schedule()
          })
        }, intervalMs)
        timer.unref?.()
      }
      void runAutoCheck().then(() => {
        if (!stopped) schedule()
      })
      return () => {
        stopped = true
        if (timer !== undefined) clearTimeout(timer)
        pendingGuidance?.()
        pendingGuidance = undefined
      }
    }, 'dsh-version-update: auto-check')
  }

  if (config?.announceToAgent === false) return
  // Optional service: a composition without a system prompt (headless RPC
  // hosts) still serves the routes.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) return
  ctx.effect(() => systemPrompt.section({
    name: 'plugin:dsh-version-update',
    order: SECTION_ORDER,
    text: VERSION_UPDATE_GUIDANCE,
  }), 'dsh-version-update: announcement')
}

export { readInstalled, resolveInstallationDir }

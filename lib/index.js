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
import { createUpdater } from './updater.js'
import { createRestarter, parseRequestedPort } from './restarter.js'
import { DEFAULT_REGISTRY, normalizeRegistry, readInstalled, resolveInstallationDir } from './core.js'

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
}).description('Version update: report the installed dsh version, install another, restart into it.')

/** Order of the announcement section within the tool-guidance band (100–199). */
const SECTION_ORDER = 195

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const VERSION_UPDATE_GUIDANCE = '本机已安装 dsh-version-update 插件（DeepSeek Harness 版本更新）：设置面板左侧「版本更新」一级菜单可查看当前安装版本与安装路径，读取 npm registry 上 @deepseek-ai/dsh 的 latest / next 通道与全部已发布版本，并更新到所选版本（点击后先弹出确认卡片说明影响，确认后宿主后台执行 `npm install -g @deepseek-ai/dsh@<版本>`，带实时安装日志）。安装成功后页面会自动重启宿主并重新载入：更新会覆盖运行中的 dsh 包目录，旧页面持有的 /assets/<hash> 资源随之消失，不重启只刷新会白屏；自动重启前有 20 秒可取消的倒计时。重启由 POST /api/dsh-version-update/restart 触发，宿主写下命令行后 spawn 一个脱离父进程的 relaunch 助手，退出旧进程，助手等端口释放再以原样 argv 拉起新进程；页面用一个不依赖 React 的 watchdog 轮询同一 URL，新进程应答后自动 location.reload()。限制：四条路由仅限 loopback；只接受精确已发布版本号，不接受 range 或 dist-tag；同时只允许一个安装任务；以 --port 0 启动（请求 OS 随机端口）时不提供重启，因为新进程会绑到另一个端口。配置项 registry 同时用于读取版本与执行安装（安装带 --registry）。用户提到「版本更新 / 检查更新 / 升级 dsh / dsh 新版本 / 重启 dsh」时即指本插件，请据此协作。'

/**
 * Mount the version-update routes and the optional model announcement.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context carrying webServer.
 * @param {{ announceToAgent: boolean; registry: string; allowRestart: boolean }} [config] - entry config, already validated against {@link Config}.
 */
export function apply(ctx, config) {
  const registry = config?.registry === undefined ? undefined : normalizeRegistry(config.registry)
  // Resolved once: the installation directory cannot move while this process
  // lives, and the discovery walk (`require.resolve` plus several `existsSync`
  // probes) would otherwise run on every status poll — once a second while the
  // restart watchdog is waiting.
  const installDir = resolveInstallationDir()
  const updater = createUpdater({ ...(registry !== undefined ? { registry } : {}) })
  // Captured at mount: the version whose code this process is actually
  // executing, which an update later makes disagree with the on-disk manifest.
  const running = readInstalled(installDir).installed
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
  })

  ctx.effect(() => {
    const disposers = makeRoutes({
      updater,
      ...(restarter !== undefined ? { restarter } : {}),
      ...(running !== undefined ? { running } : {}),
      ...(registry !== undefined ? { registry } : {}),
      ...(installDir !== undefined ? { installDir } : {}),
    }).routes.map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
      updater.dispose()
    }
  }, 'dsh-version-update: routes')

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

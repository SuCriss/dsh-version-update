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

import { makeRoutes } from './routes.js'
import { createUpdater } from './updater.js'
import { createRestarter } from './restarter.js'
import { readInstalled, resolveInstallationDir } from './core.js'

/** Stable cordis plugin name. */
export const name = 'version-update'

/** Services required before the routes can mount. */
export const inject = ['webServer']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 215

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const VERSION_UPDATE_GUIDANCE = '本机已安装 dsh-version-update 插件（DeepSeek Harness 版本更新）：设置面板左侧「版本更新」一级菜单可查看当前安装版本与安装路径，读取 npm registry 上 @deepseek-ai/dsh 的 latest / next 通道与全部已发布版本，并一键更新到所选版本（后台执行 `npm install -g @deepseek-ai/dsh@<版本>`，带实时安装日志）。安装成功后页面会自动重启宿主并重新载入：更新会覆盖运行中的 dsh 包目录，旧页面持有的 /assets/<hash> 资源随之消失，不重启只刷新会白屏。重启由 POST /api/dsh-version-update/restart 触发，宿主写下命令行后 spawn 一个脱离父进程的 relaunch 助手，退出旧进程，助手等端口释放再以原样 argv 拉起新进程；页面用一个不依赖 React 的 watchdog 轮询同一 URL，新进程应答后自动 location.reload()。限制：四条路由仅限 loopback；只接受精确已发布版本号，不接受 range 或 dist-tag；同时只允许一个安装任务；监听 OS 随机端口（--port 0）时不提供重启。用户提到「版本更新 / 检查更新 / 升级 dsh / dsh 新版本 / 重启 dsh」时即指本插件，请据此协作。'

/**
 * Mount the version-update routes and the optional model announcement.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context carrying webServer.
 * @param {{ announceToAgent?: boolean; registry?: string; allowRestart?: boolean }} [config] - composition entry config.
 */
export function apply(ctx, config) {
  const updater = createUpdater()
  // Captured at mount: the version whose code this process is actually
  // executing, which an update later makes disagree with the on-disk manifest.
  const running = readInstalled(resolveInstallationDir()).installed

  const restarter = config?.allowRestart === false ? undefined : createRestarter({
    installDir: () => resolveInstallationDir(),
    address: () => {
      const port = ctx.webServer.port
      if (typeof port !== 'number') return undefined
      // The bind host is the address the replacement must claim; the panel
      // polls its own origin, so only the port has to match.
      return { host: ctx.webServer.host, port }
    },
  })

  ctx.effect(() => {
    const disposers = makeRoutes({
      updater,
      ...(restarter !== undefined ? { restarter } : {}),
      ...(running !== undefined ? { running } : {}),
      ...(config?.registry !== undefined ? { registry: config.registry } : {}),
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

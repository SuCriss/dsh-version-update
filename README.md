# dsh-version-update

[English](README.en.md) | 中文

DeepSeek Harness Web GUI 的「版本更新」设置菜单：在设置面板左侧多出一个一级菜单，显示当前安装的 `@deepseek-ai/dsh` 版本，读取 npm registry 上的发布通道，一键更新到所选版本，并在安装完成后自动重启宿主进程、重新载入页面。

## 功能

- 设置面板一级菜单「版本更新」（`settings.section` 槽位，order 140），左侧带更新图标。
- 显示当前安装版本与安装目录；打开页面即自动检查一次，也可手动「检查更新」。
- 列出 npm dist-tag 通道（`latest` 稳定版 / `next` 预发布）及各自版本，并标注是否比本机版本新。
- 列出全部已发布版本，可任选一个作为更新目标。
- 一键更新：先弹出确认（说明会改写本机全局包并结束宿主进程），确认后宿主进程后台执行 `npm install -g @deepseek-ai/dsh@<版本>`，页面每 1.5 秒轮询任务状态并展示实时安装日志（日志自动跟到最新一行，手动上滚后停止跟随）。
- 降级同样是一键可达：选择比当前旧的版本时，按钮与确认卡片都会明确说「降级」而不是「更新」，避免把回退误当升级。
- registry 读不到时优雅降级：`check` 仍返回 200 与本机事实（安装版本、安装路径、任务视图），只把失败原因放进 `publishedError`，面板在本地信息旁提示网络问题——断网时面板不再一片空白。
- 安装成功后自动重启：20 秒倒计时（可取消）后交接端口拉起新进程，页面等新进程应答再 `location.reload()`。

## 为什么必须重启，而不是只刷新

`npm install -g` 覆盖的正是运行中 `dsh web` 用来提供前端资源的那个包目录：

- 已打开的页面持有 `/assets/index-<hash>.js` 这类内容寻址的 URL。新版本的 hash 不同，旧文件在磁盘上已不存在，而 SPA 兜底会把这些请求当作路由 miss、回 200 + `text/html`。浏览器按 JS 模块解析一份 HTML，直接失败。
- 宿主的 bundle watcher 会发现几十个 client bundle 内容变了，通过 `/plugins/events` 发出 `rebuilt` 帧，浏览器侧的热替换链把这些插件 fiber 逐个拆掉重建——其中包括定义全部 `--dsw-*` 令牌的 theme 插件和负责绘制 React 组件的 renderer。
- 于是页面白屏，而宿主进程仍在执行旧版本代码：单纯刷新页面能拿回新资源，但运行中的服务还是旧版本。

因此插件在 host 侧记录「进程启动时加载的版本」（`running`）与「磁盘上现在的版本」（`installed`），两者不一致即 `stale: true`，这也正是页面资源已失效的状态。

页面实际判断的是更宽的 `needsRestart`：`stale` 为真，**或者**这个进程里刚跑完一次安装。进程无法替换自己的模块树，所以「安装完成」本身就证明当前代码已被取代——即使 `installed` 读不出来（嵌入式宿主、manifest 不可读）也是如此。只看 `stale` 会让这类宿主更新成功后再也收不到重启提示。

## 组成

三个半区在同一个包里：

- Host 半区（`lib/index.js`，exports `.`）注册四条路由：
  - `GET /api/dsh-version-update/check` — 安装版本 + registry 通道 + 全部版本 + 任务视图（含 `running` / `stale` / `needsRestart` / `restartable`）。registry 读失败时不报错：响应仍是 200，带本机事实与 `publishedError`，但不含 `channels` / `versions`。
  - `POST /api/dsh-version-update/update` — 以 `{ "version": "0.1.0-rc.8" }` 启动一次安装。超出 4 KiB 返回 413，非法 JSON 返回 400。
  - `GET /api/dsh-version-update/status` — 读取当前（或上一次）任务状态、日志与 staleness。
  - `POST /api/dsh-version-update/restart` — 交接端口重启宿主进程。
- 浏览器半区（`lib/client.js`，exports `./client`）注册字典、「版本更新」页面，以及一个不依赖 React 的重启 watchdog。
- 脱离父进程的重启助手（`lib/relaunch.js`）由 host 在重启时 spawn。

### 重启是怎么做的

进程无法一边退出一边把监听端口交给自己的后继，所以重启是三步交接：

1. host 把命令行写进临时目录里的 payload 文件（走文件而不是 argv，避开 Windows 引号问题），spawn 脱离父进程的 `lib/relaunch.js`，300 ms 后 `process.exit(0)`；响应先发出，浏览器才看得到结果。
2. 助手立刻删除 payload（一份留在磁盘上的命令行不该还能被重放），然后轮询：旧 pid 消失、端口不再接受连接，最多等 30 秒。
3. 端口释放后再等 400 ms，用原样 `execPath` + `argv`（`--profile` / `--port` / `--patch` 全部保留）+ 原 cwd 拉起新进程，输出重定向到 `restart.log`。

新进程的 launcher 取自 `process.argv[1]`——同一路径下已是新代码；只有当 argv[1] 不是 dsh launcher（嵌入式宿主、测试）时才回退到安装目录拼 `lib/bin.js`。

浏览器侧的 watchdog 属于插件 fiber 而不是设置页组件：热替换会把设置页拆掉，watchdog 必须活得比它久。它把目标版本写进 `sessionStorage`，因此即使页面在等待期间被刷新也能续上；恢复条件是同源 `status` 路由报告 `needsRestart !== true`（新进程是全新进程：任务空闲、版本一致），随后 `location.reload()`。等待期间的提示框是纯 DOM + 字面量颜色构建的——`--dsw-*` 令牌和 React renderer 此刻可能都已不在；颜色仍跟随 `prefers-color-scheme`，因为媒体查询不需要任何样式表。该提示框声明了 `aria-modal`，也相应实现了焦点圈定、Escape 关闭（仅在有非主操作时）与关闭后焦点归还。

### 重启为什么按「请求的端口」判断

`webServer.port` 是**已解析**的端口：以 `--port 0` 启动的宿主此刻监听在一个真实端口上。若据此放行重启，助手会用原样 argv 拉起新进程、新进程绑到另一个随机端口，而旧进程已经退出、页面还在轮询旧地址——90 秒后只剩超时。因此插件从 `process.argv` 解析这次调用**请求**的端口（`--port 0` / `--port=0`），并只在这个值为 0 时拒绝重启。

### 导航图标是怎么换的

`settings.section` 注册只投影 `id` / `order` / `label`，设置面板从一份内置 id 的封闭清单里挑图标，所以外部插件的菜单项一律拿到兜底的齿轮。在这个契约长出图标字段之前，插件在弹窗挂载后按自己当前的本地化标签认出**唯一属于自己**的那一行，打上 `data-dsh-version-update-settings-nav`，由自带样式把齿轮隐掉、用 `::before` 画一个 `currentColor` 遮罩图标（循环更新箭头 + 向下安装箭头）。

这样图标继承原生导航的 hover/激活颜色、保持 16px 节奏，不写死任何颜色；标记不持有面板的任何结构，插件卸载即摘除属性，因此对 HMR 也是安全的。

## 安装

从 npm 安装（推荐，免构建授权）：

```sh
dsh plugin --profile web add dsh-version-update
```

或从源码安装：

```sh
dsh plugin --profile web add github:SuCriss/dsh-version-update
```

重启 `dsh web` 后菜单出现（host 半区需要重启才会挂载路由）。在重启之前打开面板会看到「宿主路由尚未挂载」的提示，而不是一个含义不明的 HTTP 状态码。

## 配置

组合层 entry config 由 `Config` schema（`@deepseek-ai/schemastery`）校验，写错字段会在加载时报出具体路径，而不是静默关掉某个功能：

- `announceToAgent`（默认 true）— 是否向 agent 注入本插件的说明段落。
- `registry`（默认 `https://registry.npmjs.org`）— registry 基地址。**读取版本信息和执行安装都用它**：安装会带上 `--registry <值>`，否则配了镜像的部署会从镜像列出版本、却从 npmjs 下载。必须是绝对 http(s) URL，否则挂载即失败（这个值会进入 npm 命令行）。
- `allowRestart`（默认 true）— 置为 false 则不提供重启路由，页面只提示需要手动重启。

## 开发

```sh
npm test          # 107 个 node:test 用例
npm run typecheck # tsc --checkJs，无需构建产物
```

用例不需要网络与真实安装：版本排序与安装目标校验、registry URL 规范化、loopback 门禁、npm 安装任务（以 fake spawn 断言无 shell 的命令行与 `--registry` 传递、跨 fiber 的进程级安装槽）、重启交接的 payload 与端口拒绝、四条路由（跑在真实 HTTP server 上，含 registry 失败的降级响应）、插件入口的 schema 与接线，以及浏览器侧控制器（确认、倒计时、跨刷新 watchdog、未挂载诊断——通过 `createController` 注入 fake overlay 与 reload）。浏览器半区镜像宿主的版本排序由一份双端同矩阵的对拍测试钉住。

`tsconfig.json` 只做类型检查、不产出文件：`checkJs` 让源码里已有的 JSDoc 真正生效。`lib/client.js` 与测试不在检查范围内（前者的 `require` 属于 `window.__ModuleLoader__` 而非 Node，后者几乎全由刻意残缺的 fake 构成）。

## 安全模型

- 四条路由全部走 loopback 门禁：要求 loopback socket 地址、loopback Host 头、非跨站来源（`sec-fetch-site` / `Origin`）。远程或 LAN 浏览器一律 403——这些路由会联网、在本机写入全局 npm 包，并能结束宿主进程。
- 安装目标只接受精确的已发布版本号（`major.minor.patch` 加可选预发布段），range、dist-tag、路径与任何含 shell 元字符的值都被拒绝。
- npm 在所有平台都以无 shell 方式 spawn：解析出 node 旁的 `npm-cli.js` 后执行 `node npm-cli.js install -g …`，版本参数不经任何命令行解析器。
- `registry` 配置项在挂载时校验为绝对 http(s) URL 后才允许出现在 npm 命令行上，`--proxy=…` 之类冒充参数的值进不去。
- 请求体上限 4 KiB（更新请求只是一个小 JSON 对象）。
- 更新按钮不会一击生效：面板先展示一张说明影响的确认卡片；目标是更旧版本时，卡片与按钮都按「降级」措辞。
- 重启只重放宿主自己的 `process.argv`，不接受请求体里的任何命令、参数或路径。
- 同时只允许一个安装任务，且这个约束是**进程级**的：插件因配置变更被热重载后，新 fiber 的运行器依然会拒绝启动——上一个 npm 还在写全局目录，直到那次运行自己结束（409，不排队；两个并发全局安装会争抢同一目录）。
- 单次安装 10 分钟超时；插件卸载时不会中断正在进行的安装（中途 kill npm 可能留下半写的全局包目录）。

## 已知限制

- 以 `--port 0` 启动（监听系统随机端口）的实例不提供自动重启：新进程会绑到另一个端口，页面再也找不回来。此时页面提示手动重启。判断依据是命令行里请求的端口，而不是当前已解析的端口。
- 重启会中断这个宿主进程上的一切：正在跑的会话、后台任务、SSH 连接池、任务看板的执行都会随之结束，未落盘的状态丢失。更新前的确认卡片会说明这一点，倒计时期间（20 秒）点「稍后」也可以推迟。
- 助手等待旧进程退出与端口释放最多 30 秒；超时则不拉起新进程，只在 `restart.log` 记录原因，页面 90 秒后报等待超时。
- 只更新 `@deepseek-ai/dsh` 这一个全局包；profile 里的插件依赖不在范围内。
- 版本排序只覆盖 dsh 实际发布的 semver 子集；无法解析的版本号排在所有可解析版本之后，不会因一条异常数据隐藏整张列表。
- 安装日志只保留尾部 64 KiB。
- 宿主进程需要能找到 node 旁的 npm CLI；找不到时页面报错并提示改用终端更新。
- 导航图标依赖按可见标签匹配自己的那一行：若未来某个插件把菜单项做成完全相同的文字，两行都会被换成本插件的图标。设置面板一旦提供图标字段，这段适配应当整体删除。为此监听 `document.body` 的 MutationObserver 会把回调合并到下一帧，避免聊天流逐 token 的 `characterData` 变更把空闲插件变成开销。
- Windows 上 npm 常因文件被占用而无法清理旧目录（`EPERM ... koffi.node`），会在 `@deepseek-ai\.dsh-<随机后缀>` 留下残留目录。安装本身仍然成功，残留可在重启后手动删除。

## 许可

Apache-2.0

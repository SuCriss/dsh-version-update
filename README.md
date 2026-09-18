# dsh-version-update

[English](README.en.md) | 中文

DeepSeek Harness Web GUI 的「版本更新」设置菜单 —— v1.0 全面重写版。除了查看与安装 `@deepseek-ai/dsh` 的任意已发布版本，这一代插件把"更新"升级为一套**可自动化的版本管理策略**：静默自动更新、执行时间窗、每日定时检查、dist-tag 与版本线跟踪，以及基于本地快照的秒级回滚。

## 功能

### 版本管理（保留并增强）

- 设置面板一级菜单「版本更新」，展示当前安装版本与安装目录。
- 列出 npm dist-tag 通道（`latest` / `next`）与全部已发布版本，任选其一一键安装或降级（降级按钮与确认卡明确标注方向）。
- 确认卡片读取目标版本的 GitHub Release 说明（`dsh-v*` 标签优先），附完整说明链接；失败或缺失时静默省略，绝不阻塞安装。
- 一键安装后台运行 `npm install -g @deepseek-ai/dsh@<精确版本>`。只接受精确版本号，npm 以无 shell 方式 spawn，registry 文本无法进入命令行。
- **进度条，而不是一直滚的日志**：面板展示阶段（准备 / 快照 / 下载 / 解压 / 完成）、百分比或已见字节数、已用时间与停滞时长。没有分母的阶段如实标注"无法测量"并只报已见字节数，绝不编造百分比；没有任何信号时也不谎报"卡住"。npm 的原始输出收进「查看详细日志」，默认折叠。
- **安装源可选，慢源可换**：确认卡上选「自动 / 官方 / 淘宝镜像」。`auto` 用本次实际读到版本的那个 registry（读取失败时落到的镜像会被记住并沿用）。长时间无进展时安装卡给出提示——但**不会中途杀掉 npm**（reify 半途被杀会留下半提交的安装树），等它结束后可用「用淘宝镜像重试」对同一版本重跑，只需重下。
- **安装失败不破坏你原来的版本**：安装前强制创建快照（`requireSnapshot` 默认开启，快照写不成就不让 npm 动树），失败后从快照修复，并额外校验启动入口 `lib/bin.js` 是否还在。回滚不依赖 npm、不需要网络。
- 安装成功后**不会自动重启**，也不会弹任何窗：面板上出现「立即重启」按钮，点了才重启。宿主三步交接（payload 文件 → 脱离进程的 relaunch 助手等端口释放 → 原样 argv 拉起新进程）→ 页面 watchdog 等新进程应答后自动 reload。

### 快照回滚（全新）

- **每次安装开始前自动为当前版本创建本地快照**（存于 `~/.dsh-version-update/snapshots/<版本>/`），失败只记入日志、绝不阻塞安装。
- 回滚 = 把快照复制回安装目录：**不依赖 npm、不需要网络、通常数秒完成**。恢复采用"先改名旧目录再拷贝"的顺序，拷贝失败会自动还原原目录。
- 面板「快照与回滚」卡片列出全部可用快照，一键恢复；恢复同样走确认卡 + 重启流程。
- 快照按配置数量自动修剪（默认保留 5 个），损坏的快照优先清除且在列表中标注不可用。
- 可选的 `recoverOnFailedRestart`：重启后新进程 60 秒内始终不可达时，relaunch 助手自动从快照恢复上一版本并重新拉起——同样无需网络。

### 更新策略引擎（全新）

策略持久化于 `~/.dsh-version-update/policy.json`，在面板上修改即时生效：

| 字段 | 取值 | 说明 |
|---|---|---|
| `mode` | `off` / `notify` / `auto` | 发现新版后：仅显示 / 显著提醒 / **静默自动安装** |
| `track` | `{kind:'tag', tag}` / `{kind:'line', range}` / `{kind:'pin'}` | 跟随 dist-tag（含自定义标签）/ 跟随 `^x.y.z`、`~x.y.z` 版本线（仅稳定版）/ 固定当前 |
| `window` | `null` 或 `{start,end}` (`HH:MM`) | `auto` 模式的执行时间窗；支持跨午夜（22:00–06:00），起止相同表示全天；窗外发现的版本会被"泊车"，窗开启时自动续装 |
| `checkAt` | `null` 或 `HH:MM` | 每日定时检查时刻 |

调度器是两个朴素定时器加一组纯函数决策（`resolveTarget` / `inWindow`），全部核心逻辑可独立测试。发现新版本时面板状态行与徽标同步更新；`auto` 模式在窗外只会"泊车"等待，绝不越窗安装。

- **待安装管理**：面板显示等待中的自动安装目标版本与开始等待的时间，可取消当前等待（同时解除时间窗唤醒 / 忙碌重试）。不终止已开始的安装，也不修改策略或每日检查；后续自动检查仍可发现并安排更新。

### 移除的能力

- v0.x 的 agent 系统提示通告机制（`announceToAgent`、能力段落注入、待处理通告）已整体移除——本插件现在是纯粹面向用户的面板设施，不再向模型注入任何内容。

## 为什么必须重启，而不是只刷新

`npm install -g`（以及快照恢复）覆盖的正是运行中的 `dsh web` 提供前端资源的那个包目录：

- 已打开页面持有的 `/assets/index-<hash>.js` 在新目录树中不存在，SPA 兜底会回 HTML 导致模块解析失败；
- bundle watcher 触发热替换链，主题令牌与 React renderer 都可能被拆掉。

因此 host 记录进程启动时的 `running` 与磁盘上的 `installed`，二者不一致即 `stale`；`needsRestart` 更宽——本进程里刚完成的任务本身就是"代码已被取代"的证明。重启 overlay 用裸 DOM + 字面量颜色构建（跟随 `prefers-color-scheme` 媒体查询），保证在热替换拆掉一切之后依然可见可读。

## 组成

同一个包里的三个半区：

- **Host 半区**（`lib/`，exports `.`）注册 loopback-only 路由族：
  - `GET /check` — 本机事实 + registry 通道/全量版本 + 任务视图 + ambient（上次检查结论、下次计划时间、泊车目标、近期活动）；registry 失败时降级为 `publishedError`，本机信息照常返回
  - `POST /update` — `{version, source?}` 启动一次安装（trigger 固定记为 manual；`source` 只接受 `auto`/`official`/`mirror` 三个标识符，**不接受 URL**——registry 地址留在 host 配置里，非法值 400）
  - `GET /status` — 任务视图（`running`/`stale`/`needsRestart`/`restartable`）+ ambient
  - `POST /restart` — 三步交接重启（面板「立即重启」按钮调用）
  - `GET /notes?version=` — GitHub 发布说明（`releaseNotes` 开启且能解析出仓库时挂载）
  - `POST /pending/cancel` — 取消当前待自动安装及唤醒 / 重试计时器，保留每日检查；返回 `{result:{cancelled:true}}`。仅本机 POST（其他方法 405），未注入取消操作的独立路由组合不挂载该端点。
  - `GET|POST /policy` — 读取 / 打补丁式修改策略（校验失败的每个字段都会被点名，400 返回）
  - `GET /snapshots`、`POST /restore`、`POST /snapshots/delete` — 快照列表 / 恢复 / 删除单个快照（删除同样走机器锁但不碰安装树，成功时把剩余列表一并带回；面板里同一行点两次才删）；恢复与安装争用同一把机器锁，本机有安装在跑或其他宿主持锁都返回 409
- **浏览器半区**（`lib/client.js`，exports `./client`）：字典、设置页（状态卡 / 策略表单 / 版本列表 / **安装进度条与源选择** / 可折叠日志 / 快照中心 / 活动历史 / 安装树健康）、导航图标标记、重启 watchdog。安装卡只在有任务时出现，日志只在你点开时渲染。
- **脱离父进程的重启助手**（`lib/relaunch.js`）：等旧 pid 消失、端口释放后原样拉起新进程；armed recovery 时驻留观察新进程可达性，必要时快照恢复再拉起。

## 安装

```sh
dsh plugin --profile web add dsh-version-update
```

或从源码：

```sh
dsh plugin --profile web add github:SuCriss/dsh-version-update
```

重启 `dsh web` 后菜单出现（host 半区需要重启才会挂载路由）；未挂载前面板会给出明确的「宿主路由尚未挂载」提示。

## 配置（cordis entry config）

- `registry`（默认 `https://registry.npmjs.org`）— 读取与安装共用的 registry 基地址，必须是绝对 http(s) URL。若该地址在网络层失败，读取会落到内置镜像并记住它：随后的安装按**实际读到版本的那个** registry 执行，不会回去问刚刚超时的地址。
- `mirrorRegistry`（默认 `https://registry.npmmirror.com`，淘宝镜像）— 备用源地址。面板上选「淘宝镜像」或点「用淘宝镜像重试」时使用它；`auto` 不受影响。
- `requireSnapshot`（默认 true）— 要求安装前必须成功写下快照。开启时快照失败会直接终止安装（`FatalPreparationError`），npm 根本不会启动，因为"没有回滚点的安装"正是会破坏原版本的那一类。关掉它换回旧行为：快照失败只记日志、照常安装。
- `allowRestart`（默认 true）— 关闭则不提供重启路由。
- `releaseNotes`（默认 true）— 是否读取并展示 GitHub 发布说明。
- `snapshotKeep`（默认 5，1–10）— 快照保留数量。
- `snapshotMaxBytes`（默认 0 = 不限容量）— 快照载荷总字节配额（不含元数据和符号链接目标）。创建成功后先按数量清理损坏/过旧快照，再按创建时间从旧到新删除可用快照以满足容量限制；始终保留刚创建的快照，即使单个快照已超出配额。旧格式快照缺少体积记录时会现场测量。
- `recoverOnFailedRestart`（默认 false）— 重启失败时由助手做快照恢复式救援。
- `dataDir`（默认空 = `~/.dsh-version-update`）— 状态目录（policy/history/snapshots） relocatable，便于便携部署。

运行时行为（模式、跟踪、窗口、计划）一律走面板 → `/policy`，不进 entry config。

## 新增管理与诊断能力

- 活动时间线：内存保留最近 200 条安装结果、快照恢复与树修复事件；检查、操作结束或手动刷新时读取。`GET /api/dsh-version-update/operations?since=N` 仅限本机、仅支持 GET，按单调序号增量返回 `{result:{events,cursor}}`；宿主重新加载后清空。安装只记结束结果，不虚构开始事件。

- 更新预检：安装确认卡通过本机限定的 `GET /api/dsh-version-update/preflight` 检查 npm、安装目录父级可写性、可用磁盘空间与快照目录（遵循 `dataDir`）；逐项失败返回警告，未知磁盘空间为 `null`，仅供参考、不阻止安装，也不运行 npm 或联网。

- 快照列表展示新快照的载荷体积，可确认删除；安装进行中会拒绝删除（刚创建的那个快照正是失败时的回退点）。删除本身只做改名，面板不会等 unlink。
- 新快照记录文件路径、大小及符号链接目标，恢复前检查，缺失/大小变化会拒绝恢复。不是内容哈希校验；旧快照标记为仅元数据校验，体积可能未知。
- 面板“检查”使用 `POST /check/run`，按当前跟踪策略更新检查记录；即使开启自动更新，手动检查也不会直接安装或新增等待任务。
- 重启诊断卡按需读取状态目录的 `restart.log`，最多返回末尾 16 KiB / 100 行，过滤常见凭据格式。日志可能包含本机路径，分享前仍须检查。
- npm CLI 缺失和 EACCES/EPERM 权限失败会给出终端、全局前缀、缓存权限或文件锁排查建议；不会自动提权。
- 新接口：`POST /snapshots/delete`（`{version}`）、`POST /check/run`、`GET /restart/diagnostics`，均位于 `/api/dsh-version-update` 且沿用本机访问限制。
- 删除快照改为**先改名成 `.trash-*` 墓碑、再后台异步 unlink**：一个 200 MB 级快照的递归删除在 Windows 上要好几秒到几十秒，同步做会冻住整个宿主、并超过面板 15 s 的请求超时，看上去就像按钮没反应。现在版本名立刻从列表消失，字节在后台回收；进程被杀留下的 `.tmp-*` / `.trash-*` 目录会在宿主启动时清扫。

## 开发

```sh
npm test          # node:test，165 个用例覆盖协议/域逻辑/路由/组装/浏览器控制器/重启助手
npm run typecheck # tsc --checkJs strict，无构建产物的类型安全
```

测试刻意覆盖了几类容易腐化的契约：浏览器端 semver 镜像与 host 排序的一致性、策略归一化的逐字段回退、快照元数据校验与剪枝顺序、单槽位跨 fiber 重载的排他性、mock 时钟下的倒计时/watchdog 链路、机器锁记录的所有权校验（release 只能删掉自己那条）、泊车中的自动更新必然存在下一次唤醒、重启助手两段等待各自的预算与可拨测的探针地址，以及降级不得伪装成结论（registry 读不到时不许说"已是最新"）。

本轮新增的契约同样按"哪一步会悄悄退化"来挑：**进度模型不许编数**（无分母的阶段必须 `indeterminate`，无信号的阶段不许报 stalled）、`source` 只收标识符且非法值 400（URL 不许从浏览器进来）、快照写不成时 npm 一次都不能被 spawn、以及 manifest 可读但启动入口缺失时也必须从快照修复。

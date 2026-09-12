# dsh-version-update

[English](README.en.md) | 中文

DeepSeek Harness Web GUI 的「版本更新」设置菜单 —— v1.0 全面重写版。除了查看与安装 `@deepseek-ai/dsh` 的任意已发布版本，这一代插件把"更新"升级为一套**可自动化的版本管理策略**：静默自动更新、执行时间窗、每日定时检查、dist-tag 与版本线跟踪，以及基于本地快照的秒级回滚。

## 功能

### 版本管理（保留并增强）

- 设置面板一级菜单「版本更新」，展示当前安装版本与安装目录。
- 列出 npm dist-tag 通道（`latest` / `next`）与全部已发布版本，任选其一一键安装或降级（降级按钮与确认卡明确标注方向）。
- 确认卡片读取目标版本的 GitHub Release 说明（`dsh-v*` 标签优先），附完整说明链接；失败或缺失时静默省略，绝不阻塞安装。
- 一键安装后台运行 `npm install -g @deepseek-ai/dsh@<精确版本>`，面板实时跟随日志（手动上滚即暂停跟随）。只接受精确版本号，npm 以无 shell 方式 spawn，registry 文本无法进入命令行。
- 安装成功后自动交接重启：20 秒可取消倒计时 → 宿主三步交接（payload 文件 → 脱离进程的 relaunch 助手等端口释放 → 原样 argv 拉起新进程）→ 页面 watchdog 等新进程应答后自动 reload。

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
| `restart` | `ask` / `auto` | 安装完成后：弹可取消倒计时 / 无人值守约 10 秒后自动重启宿主 |
| `checkAt` | `null` 或 `HH:MM` | 每日定时检查时刻 |

调度器是两个朴素定时器加一组纯函数决策（`resolveTarget` / `inWindow`），全部核心逻辑可独立测试。发现新版本时面板状态行与徽标同步更新；`auto` 模式在窗外只会"泊车"等待，绝不越窗安装。

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
  - `POST /update` — `{version}` 启动一次安装（trigger 固定记为 manual）
  - `GET /status` — 任务视图（`running`/`stale`/`needsRestart`/`restartable`）+ ambient
  - `POST /restart` — 三步交接重启
  - `POST /restart/cancel` — 取消已挂起的重启（面板点「稍后」时调用；只接受 POST，GET 返回 405）
  - `GET /notes?version=` — GitHub 发布说明（`releaseNotes` 开启且能解析出仓库时挂载）
  - `GET|POST /policy` — 读取 / 打补丁式修改策略（校验失败的每个字段都会被点名，400 返回）
  - `GET /snapshots`、`POST /restore`、`POST /snapshots/delete` — 快照列表 / 恢复 / 删除单个快照（删除同样走机器锁但不碰安装树，成功时把剩余列表一并带回；面板里同一行点两次才删）；恢复与安装争用同一把机器锁，本机有安装在跑或其他宿主持锁都返回 409
- **浏览器半区**（`lib/client.js`，exports `./client`）：字典、设置页（状态卡 / 策略表单 / 版本列表 / 任务日志 / 快照中心 / 活动历史）、导航图标标记、重启 watchdog。
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
- `allowRestart`（默认 true）— 关闭则不提供重启路由。
- `releaseNotes`（默认 true）— 是否读取并展示 GitHub 发布说明。
- `snapshotKeep`（默认 5，1–10）— 快照保留数量。
- `recoverOnFailedRestart`（默认 false）— 重启失败时由助手做快照恢复式救援。
- `dataDir`（默认空 = `~/.dsh-version-update`）— 状态目录（policy/history/snapshots） relocatable，便于便携部署。

运行时行为（模式、跟踪、窗口、计划）一律走面板 → `/policy`，不进 entry config。

## 开发

```sh
npm test          # node:test，149 个用例覆盖协议/域逻辑/路由/组装/浏览器控制器/重启助手
npm run typecheck # tsc --checkJs strict，无构建产物的类型安全
```

测试刻意覆盖了几类容易腐化的契约：浏览器端 semver 镜像与 host 排序的一致性、策略归一化的逐字段回退、快照元数据校验与剪枝顺序、单槽位跨 fiber 重载的排他性、mock 时钟下的倒计时/watchdog 链路、机器锁记录的所有权校验（release 只能删掉自己那条）、泊车中的自动更新必然存在下一次唤醒、重启助手两段等待各自的预算与可拨测的探针地址，以及降级不得伪装成结论（registry 读不到时不许说"已是最新"）。

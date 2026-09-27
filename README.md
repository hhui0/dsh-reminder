# dsh-reminder

DSH 的提醒插件：**说一句话就定时提醒，到点在屏幕右下角弹出独立的提醒小窗并响三声提示音**。

提醒小窗与 `D:\codex_data\electron_demo` 里那个提醒窗同款：右下角、无边框、圆角深色卡片、需要确认时一直留着等人点「收到」，提示音也是同一个（三音正弦，无音频文件——那个项目里也没有提醒音文件）。

- Host 半边（`lib/host.js`）管状态与定时器：提醒存在磁盘上、每秒检查一次、到点标成「该响」。
- 到点后 Host 拉起 `toast/`（一个只办一件事的 Electron 进程）：右下角弹卡 + 响铃。
- Web Client 半边（`lib/client.js`）提供「提醒」设置页，以及一个**默认关闭**的页面内浮层（给「我就在 DSH 里」的场景）。

## 一句话用法

在会话里直接说，模型会调用 `reminder_set`：

> 10 秒后提醒我
> 30 分钟后提醒我开会
> 明天 8 点叫我起床
> 每天 9 点提醒我喝水

也可以自己打命令（不经过模型，人发起）：

```
/reminder 30m 开会
/reminder 10s 拉屎
/reminder 19:30 吃饭
/reminder 明天 8:00 起床
/reminder 取消 8a3f21c0
/reminder                      # 看当前清单
```

时间写法（工具、命令、设置页三处一致，都由 `lib/parsing.js` 解析）：

| 写法 | 含义 |
|---|---|
| `10s`、`10 秒`、`半分钟` | 秒级相对时间 |
| `30`、`30m`、`30 分钟` | 30 分钟后（**裸数字按分钟**，不是秒） |
| `1h30m`、`2 小时 10 分钟` | 多个片段累加 |
| `19:30`、`8点半`、`20点` | 今天的这个钟点；已经过了就顺延到明天 |
| `明天 08:00`、`后天 9:15` | 带相对日期的钟点 |
| `2026-09-28 07:30`、`2026-09-28T07:30` | 本地时区的绝对时间 |

「每天」这种重复只能走工具（`repeat: "daily"`）或设置页里的「重复」下拉框。

## 到点时会发生什么

1. Host 的调度器（每秒一次）把到点的提醒标成「已响」。
2. 拉起提醒小窗：`electron.exe toast/ --payload-file=<临时 JSON> --log=<可选>`，右下角出现卡片，响三声（880 / 1174.66 / 1567.98 Hz，每音间隔 120ms，峰值 0.12）。
3. （可选）把 DSH 主窗口唤到前台 —— 走 `scripts/dsh-window.ps1` 的 Win32 调用。
4. 卡片等你在「收到」和「稍后 5 分钟」之间选一个；把「自动关闭（秒）」设成大于 0 时它到点自己消失，不留后台进程。
5. 页面那半边**默认不弹浮层**（右下角小窗已经在响了）；在设置里打开「同时在 DSH 页面里盖一层浮层」才会两边都出现。

一次性提醒响完就从清单里消失；每天循环的提醒自动排到下一个同钟点。

## 装上它

这是一个 bundle 包，用 `plugin_manager` 安装即可（`target` 填这个目录的绝对路径）。装好后 `cordis.patch.yml` 会插入一行 `reminder`。

### 前置条件：提醒小窗需要 Electron

小窗是一个独立的一次性 Electron 进程，所以插件要能找到 `electron.exe`。查找顺序：

1. 环境变量 `DSH_REMINDER_ELECTRON`（显式指定，优先级最高）；
2. `D:\codex_data\electron_demo\node_modules\electron\dist\electron.exe`（这台机器上现成的那份）；
3. `PATH` 上的 `electron.exe` / `electron`。

设 `DSH_REMINDER_ELECTRON_ONLY=1` 可以只认第 1 条（用于「就是不许乱找」的场合）。

另外 `toast/node_modules/electron` 是一条指向本机 Electron 安装的**目录联接**（`mklink /J`，不复制那 177MB）。Electron 要求应用目录里能解析到 `electron` 这个包，缺了它会退回纯 Node 模式、直接崩掉。换机器时重建这条联接即可。

## Config

`cordis.patch.yml` 插入的那一行：

| 字段 | 默认 | 说明 |
|---|---|---|
| `dataFile` | `$DSH_HOME/reminders.json` | 提醒清单落盘位置（相对路径按当前工作目录解析） |
| `settingsFile` | `$DSH_HOME/reminder-settings.json` | 偏好单独存一份，删清单不会顺手清掉偏好 |
| `catchUpMinutes` | `120` | 迟到多久之内还补响；关机一整晚后的旧提醒直接丢掉 |
| `activateWindow` | `true` | 宿主侧的唤窗口开关（页面里还有一份同名的，两边都要开） |
| `traceLog` | 空 | 填路径后，页面那半边把每一步写到这个文件（排查用） |
| `toastLog` | 空 | 填路径后，提醒小窗把它自己那半边的日志写到这个文件（排查用） |

清单是原子写的（先写 `.tmp` 再 `rename`），一条坏记录在读入时被丢弃而不是让整份清单加载失败。

## 设置页

「设置 → 提醒」里可以：

- 手动新建提醒（内容 + 时间 + 是否每天 + 备注）——走的是与工具完全相同的那套时间解析；
- 看当前清单并逐条取消；
- 选提示音：清脆铃 / 钟声 / 短哔（页面合成）、朗读内容（小窗 TTS）、静音；
- 调音量、响几声、自动关闭秒数（0 = 一直等你点「收到」）；
- 开关「到点弹提醒小窗」「同时在 DSH 页面里盖一层浮层」「到点把 DSH 唤到前台」。

顶部状态条会说清连接情况：`提醒已就绪` / `正在连接提醒服务…` / `连不上提醒服务`。

## 架构

```
lib/parsing.js   时间解析与领域整形（纯函数，无 DSH 依赖，因此可单元测试）
lib/host.js      ReminderStore（持久化 + 到点判定）、ReminderScheduler（定时器 + 长轮询唤醒）、
                 ReminderService（Cordis 服务）、reminder_* 工具、/reminder 命令、
                 /dsh-reminder/api/call 与 /api/pending 两条本机路由
lib/toast.js     找 Electron、写 payload 文件、detached 拉起提醒小窗
lib/window.js    Win32 窗口激活器（调 scripts/dsh-window.ps1）
toast/main.js    小窗的 Electron 主进程：窗口尺寸/定位/存活时间/退出
toast/toast.js   小窗的页面：卡片、三音提示音、主题（与 electron_demo 的 reminder-toast.js 同源）
toast/preload.js contextBridge 暴露的最小 API
lib/client.js    settings.section 设置页 + 可选的 shell.overlay 浮层 + 长轮询
```

几个刻意的取舍：

- **提醒小窗是「一次提醒一个进程」**，不是常驻窗口。常驻需要一条 HTTP/IPC 通道来持续推送，而提醒是低频事件；一个进程只办一件事，就不会有陈旧卡片、也不会在 DSH 关掉后留孤儿窗口。代价是每次到点有约 200-500ms 的 Electron 冷启动——对提醒够用。
- **payload 走临时文件而不是命令行**。PowerShell 的引号规则会把 `{"id":...}` 交给程序时变成 `{id:...}`（实测），`JSON.parse` 立刻报 position 1；写文件再读没有任何转义问题。
- **拉起子进程时必须剥掉 `ELECTRON_RUN_AS_NODE`**。DSH 的 host 自己就是带着这个变量跑的 Electron，子进程会继承它，于是我们拉起的 `electron.exe` 又退化成纯 Node、`require('electron')` 只给回一个路径字符串，窗口永远不出现。这个坑只在真跑时才暴露。
- **页面不走 `ctx.remote`，走本机 HTTP**。生成的 Remote 命名空间要等网关发布，插件激活时读到的是 `undefined`（这个工作区的另外两个插件都踩过）。本机路由只服务 `127.0.0.1` / `::1`。
- **定时器只有一个，在 Host**，而且注册在服务自己的 `this.ctx` 上（注册在父上下文上会被子 fiber 的启动流程清掉，症状是插件一切正常但永远不响）。

## 已验证 / 未验证

```powershell
node --check lib/host.js; node --check lib/client.js; node --check lib/parsing.js; node --check lib/window.js; node --check lib/toast.js
node --check toast/main.js; node --check toast/toast.js; node --check toast/preload.js
node --test smoke/host-smoke.mjs smoke/wire-smoke.mjs smoke/http-smoke.mjs smoke/lifecycle-check.mjs
node smoke/client-smoke.mjs
node smoke/timer-check.mjs
node smoke/window-smoke.mjs
node smoke/toast-check.mjs      # 会真的弹一个小窗，2 秒后自己消失
node smoke/e2e-toast.mjs 6      # 走插件的真实调用路径，弹一个小窗，6 秒后消失
```

| 脚本 | 条数 | 覆盖什么 |
|---|---|---|
| `smoke/host-smoke.mjs` | 33 | 时间解析（含秒级、`半分钟`）、持久化、到点判定、循环排程、迟到丢弃、长轮询唤醒与去重、默认路径不互撞 |
| `smoke/wire-smoke.mjs` | 3 | 用真的 Cordis 上下文激活：服务挂成 `ctx.get('reminders')`、三个工具与 `/reminder` 命令、路由注册、卸载后定时器停止 |
| `smoke/http-smoke.mjs` | 5 | `/api/call` 的方法派发与信封、坏输入的错误码、`/api/pending` 的超时与去重、只有本机能访问 |
| `smoke/lifecycle-check.mjs` | 1 | **真实生命周期 + 真实时间**：激活后定时器自己在走、到点写成「已响」、卸载后停表 |
| `smoke/client-smoke.mjs` | 49 | 模块加载、两个座位注册、到点弹窗、按钮打到 host、设置页、静音真的没声音、关掉浮层后不弹也不响 |
| `smoke/timer-check.mjs` | 6 | 真实时间下的 store + scheduler（不手动调 `tick()`） |
| `smoke/window-smoke.mjs` | 10 | PowerShell 探测、脚本可解析、`-Action status` 真跑一次（实测 `window=5243272 rect=1936x1048@(-8,-8) visible=True iconic=False`） |
| `smoke/toast-check.mjs` | 28 | 探测/payload/参数/env 清理等纯逻辑 + **真跑一次小窗**（页面加载、渲染器报到、投递、响铃没失败、干净退出） |
| `smoke/e2e-toast.mjs` | 6 | 走插件的真实调用路径（detached + payload 文件 + 剥掉 `ELECTRON_RUN_AS_NODE`）拉起小窗，并用长标题逼出一次「按内容调高度」 |
| `smoke/live-check.mjs` | 6 | 打真实宿主：`/api/call` 建一条十几秒后的提醒，核对清单被消费 + 小窗日志被投递 |

另有五个**现场排查工具**（注释里写清了各自的坑）：`delivery-check.mjs`（自建提醒 + 盯 `/api/pending`）、`clock-check.mjs`（比对宿主与本机时钟）、`fire-check.mjs`（采样窗口是否前台）、`rapid-fire-check.mjs`（250ms 探针）、`timer-detect.mjs`（插一条过期提醒，看宿主会不会改写清单）。

这套测试抓出来的真实缺陷（不是补上去的装饰）：

1. 调度器只在「有提醒响」时唤醒长轮询，于是提醒到点若恰好落在长轮询挂上之前，要等这次长轮询超时（最多 20 秒）才弹出来。
2. `ReminderService` 写了 `start()` / `stop()` 当作生命周期钩子——Cordis 的 `Service` 没有这两个钩子，它们永远不会被调用。
3. **定时器注册错了上下文**：`ctx.plugin()` 返回的子 fiber 是异步启动的，注册在父上下文上的 effect 会被启动流程清理一遍，于是定时器刚建好就被停掉。补了 `lifecycle-check.mjs` / `timer-check.mjs` 两条真实时间的测试，因为此前所有调度测试都用假时钟并手动调 `tick()`。
4. host 不校验 `repeat`，把 `"off"` 之类的非法值静默降级成 `once`。
5. `handleRequest` 被 `void` 掉，`webServer` 收不到「这次请求处理完了没有」的信号。
6. 客户端测试把「音色」和「重复」两个下拉框搞混了（重复是页面里第一个 `select`）。
7. `spawn` 的失败是**异步 error 事件**，没有监听者时整个宿主进程会被带走。
8. 拉起小窗时继承了宿主自己的 `ELECTRON_RUN_AS_NODE=1`，小窗退化回纯 Node。
9. `requireAck` 和 `ttlSeconds` 抢方向盘，导致「设了 6 秒自动关闭却挂到 300 秒」。
10. 页面默认盖浮层，与小窗同时出现（双弹/双响）。
11. 小窗卡片列表上的 `max-height: 80vh` + `overflow-y: auto`：窗口高度本来就等于内容高度，这条规则只会在内容偶尔高出一两像素时长出一条滚动条，而滚动条又把卡片挤窄、折出更多行。改成完全不滚动，并把「量高度」统一到一个函数。
12. **清单与偏好撞成同一个文件**：早先只有一个回退路径、空值一律指向 `reminders.json`；而 Profile 的 patch 是整体替换 `config`（不是合并），于是「只覆盖了 `traceLog`」的配置下偏好文件也变成了清单文件。拆成两个解析函数，并加了一道「两者相同就换回默认偏好文件」的兜底。
13. 页面那半边一度完全没有在轮询：原因是浏览器缓存了**旧的客户端 bundle**（里面根本没有后来的客户端代码）。硬刷新（Ctrl+Shift+R）之后 `reminder-trace.log` 立刻出现 `apply.enter v=2` → `loop.start` → 每 20 秒一轮 `poll.empty`。**改完客户端代码要硬刷新页面，否则看到的是旧包；改完 Host 代码要重启 DSH，ESM 是按 URL 缓存的。**

## 已知限制

- **DSH 必须开着，提醒才会响。** 定时器住在 Host 里；DSH 关掉时没有东西在计时。
- 小窗需要本机有 Electron（见上面的前置条件）；找不到时只记一条日志，页面浮层仍然可用。
- 小窗里的「稍后 5 分钟」只在那个进程内生效（它没有清单可写）；要真正推迟请用设置页或 `/reminder`——那条路会写回清单。
- 提醒只在本地，不会同步到手机，也不发系统通知。
- 只有 Windows 会唤窗口（脚本用的是 Win32）。

## 许可

MIT。

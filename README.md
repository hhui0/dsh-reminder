# dsh-reminder

DSH 的提醒插件：**说一句话就定时提醒，到点弹出提醒窗口并播放提示音**，必要时还会把 DSH 主窗口唤到前台。

- Host 半边（`lib/host.js`）管状态与定时器：提醒存在磁盘上、每秒检查一次、到点标记为「该响」。
- Web Client 半边（`lib/client.js`）管你看到和听到的：浮层弹窗 + Web Audio 现场合成的提示音 + 「提醒」设置页。

## 一句话用法

在会话里直接说，模型会调用 `reminder_set`：

> 30 分钟后提醒我开会
> 明天 8 点叫我起床
> 每天 9 点提醒我喝水

也可以自己打命令（不经过模型，人发起）：

```
/reminder 30m 开会
/reminder 19:30 吃饭
/reminder 明天 8:00 起床
/reminder 取消 8a3f21c0
/reminder                      # 看当前清单
```

「每天」这种重复只能走工具（`repeat: "daily"`）或设置页里的「重复」下拉框：命令的第一个词只用来分流「时间 / 标题」，再塞第三件事会让它变得没法预测。

时间写法（工具、命令、设置页三处一致，都由 `lib/parsing.js` 解析）：

| 写法 | 含义 |
|---|---|
| `30`、`30m`、`30 分钟` | 30 分钟后 |
| `1h30m`、`2 小时 10 分钟` | 多个片段累加 |
| `19:30`、`8点半`、`20点` | 今天的这个钟点；已经过了就顺延到明天 |
| `明天 08:00`、`后天 9:15` | 带相对日期的钟点 |
| `2026-09-28 07:30`、`2026-09-28T07:30` | 本地时区的绝对时间 |

## 提醒到点时会发生什么

1. Host 的调度器（每秒一次）把到点的提醒标成「已响」，并（可选）调用 `scripts/dsh-window.ps1` 把 DSH 窗口显示出来、切到前台。
2. 页面正在挂着一条长轮询（`GET /dsh-reminder/api/pending`，最多 20 秒），它**在提醒到点的那一刻**被唤醒，拿到提醒。
3. 弹窗出现在窗口正中央的浮层上，同时用 Web Audio 现场合成提示音（清脆铃 / 钟声 / 短哔 / 静音）。
4. 你按「知道了」或「再等 5 / 10 分钟」。一次性提醒响完就从清单里消失；每天循环的提醒自动排到下一个同钟点。

弹窗会吃掉点击并挡住整个应用，这是有意的：一条到点的提醒如果可以被路过地点掉，它和浏览器通知就没有区别。`Esc` 等于「知道了」。

## 装上它

这是一个 bundle 包，用 `plugin_manager` 安装即可（`target` 填这个目录的绝对路径）：

```jsonc
// 概念上的等价手工步骤（不要照抄到 Profile 目录里）
{
  "name": "dsh-reminder",
  "dsh": { "client": { "platform": "web" }, "bundle": { "patch": ["./cordis.patch.yml"] } }
}
```

`cordis.patch.yml` 插入一行 `reminder`，Config 只有四个字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `dataFile` | `$DSH_HOME/reminders.json` | 提醒清单落盘位置（相对路径按当前工作目录解析） |
| `settingsFile` | `$DSH_HOME/reminder-settings.json` | 偏好单独存一份，删清单不会顺手清掉偏好 |
| `catchUpMinutes` | `120` | 迟到多久之内还补响；关机一整晚后的旧提醒直接丢掉，不在开机时一次弹出十条 |
| `activateWindow` | `true` | 到点是否唤窗口（页面里还有一个同名开关，两边都要开） |

清单是原子写的（先写 `.tmp` 再 `rename`），一条坏记录在读入时被丢弃而不是让整份清单加载失败。

## 设置页

「设置 → 提醒」里可以：

- 手动新建提醒（内容 + 时间 + 是否每天 + 备注）——走的是与工具完全相同的那套时间解析；
- 看当前清单并逐条取消；
- 选提示音音色（换音色会顺带响一声确认）、音量、响几声、弹窗自动关闭秒数；
- 开关「到点把 DSH 唤到前台」——这一条会同时写进渲染器本地偏好和 Host 偏好，因为只有 Host 那半边碰得到窗口。

顶部状态条会说清连接情况：`提醒已就绪` / `正在连接提醒服务…` / `连不上提醒服务`。**到点不弹窗的第一嫌疑就是这里显示的最后一条。**

## 架构

```
lib/parsing.js   时间解析与领域整形（纯函数，无 DSH 依赖，因此可单元测试）
lib/host.js      ReminderStore（持久化 + 到点判定）、ReminderScheduler（定时器 + 长轮询唤醒）、
                 ReminderService（Cordis 服务）、reminder_* 工具、/reminder 命令、
                 /dsh-reminder/api/call 与 /api/pending 两条本机路由
lib/window.js    Win32 窗口激活器（调 scripts/dsh-window.ps1）
lib/client.js    shell.overlay 弹窗、提示音合成、settings.section 设置页、长轮询循环
```

几个刻意的取舍：

- **页面不走 `ctx.remote`，走本机 HTTP。** 生成的 Remote 命名空间要等网关发布，插件激活时读到的是 `undefined`（这个工作区的另外两个插件都踩过）。本机路由在激活那一刻就存在。路由只服务 `127.0.0.1` / `::1`。
- **定时器只有一个，在 Host。** 多开一个窗口不会多响一次；代价是 Host 停了就没人检查（见下面的限制）。
- **到点的提醒先留在清单里，等页面确认。** 窗口没开着时它不会被丢掉，下次打开页面仍会弹出来（10 分钟内）。
- **提示音现场合成，不携带音频文件。** 「静音」因此是一个真正的分支，而不是少写一个文件。

## 已验证 / 未验证

冒烟测试（本仓库里可重复跑）：

```powershell
node --check lib/host.js; node --check lib/client.js; node --check lib/parsing.js; node --check lib/window.js
node --test smoke/host-smoke.mjs smoke/wire-smoke.mjs smoke/http-smoke.mjs
node smoke/client-smoke.mjs
node smoke/window-smoke.mjs
```

| 脚本 | 条数 | 覆盖什么 |
|---|---|---|
| `smoke/host-smoke.mjs` | 30 | 时间解析、持久化、到点判定、循环排程、迟到丢弃、长轮询唤醒与去重 |
| `smoke/wire-smoke.mjs` | 3 | 用真的 Cordis 上下文激活：服务挂成 `ctx.get('reminders')`、三个工具与 `/reminder` 命令、路由注册、卸载后定时器停止 |
| `smoke/http-smoke.mjs` | 5 | `/api/call` 的方法派发与信封、坏输入的错误码、`/api/pending` 的超时与去重、只有本机能访问 |
| `smoke/client-smoke.mjs` | 46 | 模块加载、两个座位注册、到点弹窗、按钮打到 host、设置页、静音真的没声音 |
| `smoke/window-smoke.mjs` | 10 | PowerShell 探测、脚本可解析、`-Action status` 真跑一次（实测输出 `window=5243272 rect=1936x1048@(-8,-8) visible=True iconic=False`） |

这套测试抓出来的真实缺陷（不是补上去的装饰）：

1. 调度器只在「有提醒响」时唤醒长轮询，于是提醒到点若恰好落在长轮询挂上之前，要等这次长轮询超时（最多 20 秒）才弹出来。改成每 tick 检查「还有没有待确认的提醒」。
2. `ReminderService` 写了 `start()` / `stop()` 当作生命周期钩子——Cordis 的 `Service` 没有这两个钩子，它们永远不会被调用，症状是「插件装好了、工具也在、提醒从来不响」。改成在构造函数里用 `ctx.effect` 起表。
3. host 不校验 `repeat`，把 `"off"` 之类的非法值静默降级成 `once`（「我明明说了每天，它只响了一次」）。改成明确报错。
4. 客户端测试第一次把「音色」下拉框和「重复」下拉框搞混了——因为重复是页面里第一个 `select`。测试改成按选项内容定位，而不是按位置。

`smoke/` 里的 React 与 jsdom 是**测试夹具**（装在 `smoke/node_modules`），刻意不放进插件依赖：DSH 是就地加载这个包的，把别人的框架放到被加载的路径上会污染运行时。

已经验证的：

- 四个 lib 文件语法通过；五套冒烟测试共 **94 条断言**全绿（30 + 3 + 5 + 46 + 10）。
- 在真的 Cordis 上下文里激活成功：服务、工具、命令、路由都挂上了，`/reminder 30m 开会` 真的建出一条提醒，卸载后定时器停止。
- 本机路由的 HTTP 行为（信封、错误码、长轮询超时与去重、本机限制）。
- `scripts/dsh-window.ps1 -Action status` 真跑过，并在这台机器上找到了 DSH 主窗口。

**没有验证的**（需要活着的宿主与真实窗口，我做不了）：

- 在真实 DSH 里挂载这一行、工具被模型调用、`/reminder` 命令出现在命令面板；
- 真实弹窗的视觉（间距、明暗主题下的观感）与真实响铃的音量手感；
- Win32 唤窗口在「应用最小化 / 收进托盘 / 在后面」三种状态下的实际效果（只验了只读的 `status` 路径，没有真的抢过前台）；
- 长轮询在真实浏览器里的时序（比如窗口最小化时浏览器对定时器的节流）。

## 已知限制

- **DSH 必须开着，提醒才会响。** 定时器住在 Host 里，但弹窗和声音是页面产生的；DSH 关掉时不会有任何东西提醒你。
- 只有 Windows 会唤窗口（脚本用的是 Win32）；其他平台这个能力直接不装。
- 提醒只在本地，不会同步到手机，也不发系统通知。

## 许可

MIT。

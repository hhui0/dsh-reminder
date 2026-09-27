'use strict'

/**
 * 提醒小窗（独立进程）的 CLI。
 *
 * 用法（由 DSH 插件在提醒到点时拉起）：
 *   <electron.exe> <这个目录> --reminder-toast='{"label":"开会","time":"19:30"}' [--log=<文件>]
 *
 * 为什么是「另起一个 Electron 进程」而不是在插件里用 Win32 画一个窗口：
 *   · 插件两半都够不到宿主窗口（host 是纯 Node，client 在渲染器里），而 DSH 的页面是
 *     浏览器文档——它画不出「右下角独立小窗」那种全局浮层；
 *   · 这台机器上本来就有 Electron（`D:\codex_data\electron_demo\node_modules\electron`），
 *     复用它零下载成本，且看到的渲染结果与那个项目一模一样。
 *
 * 为什么每个提醒一个进程、而不是常驻一个小窗：
 *   常驻需要一条「谁还活着」的通道（HTTP/IPC）才能持续推送，而提醒是低频事件；
 *   一个进程只办一件事，就不会有陈旧的卡片、也不会在 DSH 关掉之后留一个孤儿窗口。
 *   代价是每次到点有大约 200-500ms 的 Electron 冷启动——对提醒来说完全够用。
 *
 * `--autoplay-policy=no-user-gesture-required` 是必须的：没有它，Chromium 会因为
 * 「页面没有用户手势」把 `AudioContext` 挂起，提示音变成静默失败。
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

/**
 * 最早的一道保险：这个文件里的任何异常都必须先能写进日志，再退出。
 *
 * 踩过一次：`require('electron')` 因为应用目录里没有这个包而返回 undefined，于是
 * `app.exit(2)` 自己抛了 `TypeError`，整个进程只是一句「exit code 1」，日志里什么都没有。
 * 独立的 GUI 进程没有终端可看，所以「崩在有日志之前」是最贵的失败。
 */
let crashLog = ''
try {
  process.on('uncaughtException', (error) => {
    try {
      if (crashLog !== '') fs.appendFileSync(crashLog, `[toast] FATAL uncaughtException ${String(error && error.stack)}\n`, 'utf8')
    } catch {
      /* 连日志都写不了就只能安静退出 */
    }
    process.exit(9)
  })
} catch {
  /* 忽略 */
}

/** 卡片宽度 + 两侧内边距，与 toast.html 里 `.rt-item{width:340px}` + `padding:10px` 对齐。 */
const WINDOW_WIDTH = 380
/** 初始高度；页面量完内容会立刻改。 */
const INITIAL_HEIGHT = 150
/** 卡片最长留多久（秒）。提醒不该比这更久地挂在屏幕上没人管。 */
const MAX_TTL_SECONDS = 300
/** 右下角留白。 */
const MARGIN = 16

/** 解析 `--k=v` 形式的参数。 */
function parseArgs(argv) {
  const out = {}
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(String(arg))
    if (match === null) continue
    out[match[1]] = match[2] === undefined ? 'true' : match[2]
  }
  return out
}

const args = parseArgs(process.argv.slice(1))
// 崩溃日志从参数里尽早拿到手（parseArgs 不依赖 Electron，所以此刻就能用）。
if (args.log) crashLog = String(args.log)

/** 日志文件：主进程这边没有任何 UI，出问题只能靠它。 */
const logFile = args.log ? String(args.log) : ''

if (process.versions.electron === undefined || app === undefined || app === null) {
  // 走到这里说明这个进程**不是**在跑 Electron：最常见的原因是继承了
  // `ELECTRON_RUN_AS_NODE=1`（DSH 的宿主自己就是这么跑起来的），于是 electron.exe
  // 退化成了纯 Node，`require('electron')` 给回来的是一个路径字符串。
  // 这种情况必须写清楚，否则日志里只会出现「Electron failed to install correctly」这种误导。
  try {
    if (logFile !== '') {
      fs.appendFileSync(
        logFile,
        `[toast] FATAL 不是 Electron 进程（versions.electron=${String(process.versions.electron)}，` +
          `ELECTRON_RUN_AS_NODE=${String(process.env.ELECTRON_RUN_AS_NODE)}）\n`,
        'utf8'
      )
    }
  } catch {
    /* 忽略 */
  }
  process.exit(8)
}

/**
 * 记一行诊断。
 *
 * **只写 ASCII**：这个文件会被人在 PowerShell 里 `Get-Content` 看，而 PowerShell 默认按
 * 系统 ANSI 解码 UTF-8 文件——中文会变成乱码、一行被拆成好几段，日志就废了。
 * 提醒内容本身（标题、备注）是 UTF-8，但那部分在 payload 文件里，不在日志里。
 *
 * @param line - 内容（调用方保证不含换行，且只用 ASCII）。
 */
function log(line) {
  const text = `[toast] ${new Date().toISOString()} ${line}`
  if (process.env.DSH_REMINDER_TOAST_DEBUG === '1') console.log(text)
  if (logFile === '') return
  try {
    fs.appendFileSync(logFile, `${text}\n`, 'utf8')
  } catch {
    /* 记日志永远不该是失败的原因 */
  }
}

/**
 * 读 payload。
 *
 * 优先 `--payload-file=<路径>`：命令行里的 JSON 会被外壳的引号规则揉一遍（PowerShell 实测
 * 会把 `{"id":...}` 交给程序时变成 `{id:...}`，于是 `JSON.parse` 报「position 1」），
 * 而写进临时文件再读就没有任何转义问题。`--payload=<JSON>` 保留为直接调用时的方便写法。
 */
function readPayload() {
  const file = args['payload-file']
  if (file) {
    try {
      return JSON.parse(fs.readFileSync(String(file), 'utf8'))
    } catch (error) {
      log(`payload file unreadable: ${String(error && error.message)}`)
      return null
    }
  }
  const raw = args.payload
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (error) {
    log(`payload is not JSON: ${String(error && error.message)}`)
    return null
  }
}

const payload = readPayload()
if (payload === null) {
  log('no valid payload, exiting')
  process.exit(2)
}

/**
 * 把 Electron 的 userData 挪到临时目录。
 *
 * 每个提醒小窗都是一个独立进程，如果都用默认的 userData，它们会去抢同一个目录的锁，
 * 而这个应用又和同机上别的 Electron 应用共用 'Electron' 这个默认名字。挪到临时目录之后，
 * 每个进程只碰自己那点缓存，互不干扰。
 */
try {
  app.setPath('userData', path.join(app.getPath('temp'), 'dsh-reminder-toast'))
} catch (error) {
  log(`setPath(userData) failed (ignored): ${String(error && error.message)}`)
}

/** 这次要展示的提醒 id：「稍后」时用它派生新的 id。 */
const reminderId = String(payload.id || 'toast')

/** 窗口。 */
let win = null
/** 数据发过没有：`toast:ready` 与 `did-finish-load` 都可能先到，只发一次。 */
let delivered = false
/** 自动退出定时器。 */
let exitTimer = null

/**
 * 把窗口贴到当前显示器工作区的右下角。
 *
 * 用 `getCursorScreenPoint` 选显示器而不是主显示器：多屏时，多看一眼光标所在的屏
 * 通常就是用户正在看的屏（与 electron_demo 的 `positionReminderToast` 同一策略）。
 */
function position() {
  if (win === null || win.isDestroyed()) return
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay()
  const area = display.workArea
  const [width, height] = win.getSize()
  win.setPosition(area.x + area.width - width - MARGIN, area.y + area.height - height - MARGIN)
}

/**
 * 把卡片交给页面。
 *
 * 页面一旦收到就会响铃、建卡、量高度——所以这一步同时也验证了「渲染器活着」。
 */
function deliver() {
  if (delivered || win === null || win.isDestroyed()) return
  delivered = true
  win.webContents.send('toast:add', payload)
  // id 之外都不写进日志：标题是任意 UTF-8，写进去就会在 PowerShell 里变乱码。
  log(`delivered payload id=${reminderId} ttl=${String(payload.ttlSeconds)} ack=${String(payload.requireAck)}`)
}

/**
 * 只展示一次：`ttlSeconds` 到点就自己退出。
 *
 * `requireAck` 不参与这里的决策（它只决定卡片上写什么），否则「设了 6 秒自动关闭却挂到
 * 300 秒」这种自相矛盾的行为又会出现。用户点「收到」的那条路走 `toast:empty`，会更快结束。
 */
function armExit() {
  const ttl = Number(payload.ttlSeconds)
  const seconds = Number.isFinite(ttl) && ttl > 0 ? Math.min(MAX_TTL_SECONDS, ttl) : MAX_TTL_SECONDS
  exitTimer = setTimeout(() => {
    log(`ttl reached (${seconds}s), exiting`)
    quit(0)
  }, seconds * 1000)
}

/** 取消自动退出（用户点了「收到」或「稍后」）。 */
function clearExit() {
  if (exitTimer !== null) clearTimeout(exitTimer)
  exitTimer = null
}

/**
 * 「稍后 N 分钟」：把这条提醒的时间推后，并作为一次新的提醒重新到点。
 *
 * 这里直接 `setTimeout` 后重新投递，而不是写回 DSH 的清单：窗口是独立进程，没有清单可写。
 * 代价写进 README：这种推迟只在这个进程里有效，而进程最多活 `MAX_TTL_SECONDS`。
 * DSH 页面里那个「稍后」才是权威的（它会写回清单）。
 */
function snooze(minutes) {
  const value = Number(minutes)
  if (!Number.isFinite(value) || value <= 0) return
  clearExit()
  log(`snooze ${value} minutes`)
  const next = { ...payload, id: `${reminderId}-snooze-${Date.now()}`, time: '' }
  setTimeout(() => {
    if (win !== null && !win.isDestroyed()) {
      delivered = true
      win.webContents.send('toast:add', next)
    }
  }, value * 60000)
  // 推迟期间不退出：否则定时器还没到进程就没了。给足最大存活时间。
  exitTimer = setTimeout(() => quit(0), MAX_TTL_SECONDS * 1000)
}

app.on('window-all-closed', () => quit(0))

/**
 * 退出。
 *
 * 用 `app.exit` + `process.exit` 两道：这个进程没有 UI 之外的职责，任何残留的 handle
 * 都不值得为了「优雅」而多活一毫秒。而 `--user-data-dir` 换到临时目录则是必须的——
 * 否则每个提醒小窗都会去锁同一个 Electron userData，与同机的其它 Electron 应用互相干扰。
 *
 * @param code - 退出码。
 */
function quit(code) {
  try {
    app.exit(code)
  } catch {
    /* 忽略 */
  }
  process.exit(code)
}

app.whenReady().then(() => {
  // 让 Chromium 允许无手势播放：提示音是这个窗口存在的理由之一。
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: INITIAL_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    // 不抢焦点：提醒是通知，不该把你正在打字的位置抢走。
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  win.on('closed', () => {
    win = null
  })

  // 内容量出来之前不要露脸，否则会先闪一个 380×150 的空窗。
  win.webContents.once('did-finish-load', () => {
    log('page loaded')
    // 兜底投递：正常情况下页面会先发 `toast:ready`，但两者谁先到不保证。
    setTimeout(() => {
      deliver()
      armExit()
      if (win !== null && !win.isDestroyed()) win.showInactive()
      position()
    }, 30)
  })

  win.loadFile(path.join(__dirname, 'toast.html')).catch((error) => {
    log(`loadFile failed: ${String(error && error.message)}`)
    quit(3)
  })
})

ipcMain.on('toast:ready', () => {
  log('renderer ready')
  deliver()
})

ipcMain.on('toast:resize', (_event, height) => {
  if (win === null || win.isDestroyed()) return
  const value = Math.max(1, Math.min(2000, Math.round(Number(height) || 0)))
  if (value <= 0) return
  const [, current] = win.getSize()
  // 记一行：排查「右边多了一条滚动条 / 卡片被裁掉」时，先要确认页面报的高度与窗口实际
  // 高度是不是同一个数。这类问题光看截图看不出来。
  log(`resize requested height=${value} current=${current}`)
  if (Math.abs(current - value) < 2) return
  win.setSize(WINDOW_WIDTH, value)
  position()
})

ipcMain.on('toast:empty', () => {
  log('cards empty, exiting')
  clearExit()
  // 给一点时间让最后一次 resize 落下去，再退。
  setTimeout(() => quit(0), 120)
})

ipcMain.on('toast:report', (_event, line) => {
  log(String(line).slice(0, 300))
})

ipcMain.on('toast:snooze', (_event, minutes) => {
  snooze(minutes)
})

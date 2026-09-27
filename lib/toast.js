/**
 * 把提醒交给「提醒小窗」——一个独立的一次性 Electron 进程。
 *
 * 为什么不是插件自己画窗口：host 半边是纯 Node（够不到宿主窗口），client 半边跑在浏览器的
 * 文档里（画不出横跨屏幕的独立小窗）。Electron 是这台机器上现成的东西，复用它既能得到与
 * `electron_demo` 完全一致的渲染结果，又不需要任何下载。
 *
 * 关于「找 Electron」这件事，写死三条经验：
 *   · **探测而不是猜**：候选路径按「显式指定 → 同机常见安装 → PATH」排，找不到时给出
 *     一份带候选清单的错误，而不是一个 ENOENT；
 *   · 用 `electron.exe` 而不是 `electron.cmd`：`.cmd` 需要一个 `cmd.exe` 外壳进程，
 *     而这里的进程是 detached 的，外壳退不掉就会留下一个孤儿；
 *   · 不加 `windowsHide` 之类的花活：Electron 是 GUI 程序，本来就不会闪控制台。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 小窗应用目录：本包的 `toast/`，与 `lib/` 是兄弟目录。 */
export const TOAST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'toast')

/** 一个提醒在屏幕上最多留多久（秒）——提示音与卡片都不该无限期挂着。 */
export const MAX_TTL_SECONDS = 300

/**
 * 要求 Electron 必须来自显式指定，不要在 PATH 上乱找。
 *
 * PATH 上的死活是没法探测的（那只是个名字），所以「找不到 Electron」这件事在
 * 真机上测不出来；这个开关让那种情况变得可复现，也让用户可以明确地说「就用我指定的这个」。
 */
const REQUIRE_EXPLICIT = 'DSH_REMINDER_ELECTRON_ONLY'

/**
 * Electron 可执行文件的候选路径，按优先级排列。
 *
 * @param env - 环境变量（便于测试注入）。
 * @returns 候选路径。
 */
export function electronCandidates(env = process.env) {
  // 要求显式指定时，就**只**用它：不探测同机那份、也不看 PATH。
  // 这样「找不到 Electron」这件事才有确定的行为，而不是靠 PATH 上碰运气。
  if (String(env[REQUIRE_EXPLICIT] ?? '') === '1') {
    return env.DSH_REMINDER_ELECTRON ? [env.DSH_REMINDER_ELECTRON] : []
  }
  const candidates = []
  // 1. 显式指定：用户可以在 Profile 的 config 里填，或者设环境变量。
  if (env.DSH_REMINDER_ELECTRON) candidates.push(env.DSH_REMINDER_ELECTRON)
  // 2. 同机上一个已知的 Electron 安装（那个提醒小窗的原型就在这个项目里）。
  candidates.push(join('D:\\codex_data\\electron_demo', 'node_modules', 'electron', 'dist', 'electron.exe'))
  // 3. PATH 上的 electron（有的机器全局装了）。
  candidates.push('electron.exe')
  candidates.push('electron')
  return candidates
}

/**
 * 挑一个真实存在的 Electron。
 *
 * PATH 上的候选没法用 `existsSync` 判断（那只是个名字），所以它们排在最后，只有在
 * 一个磁盘上的候选都不存在时才轮到它们。
 *
 * @param env - 环境变量。
 * @param exists - 存在性判定（便于测试注入）。
 * @returns `{ path, source }`；一个都没有时 `path` 是 undefined。
 */
export function pickElectron(env = process.env, exists = existsSync) {
  let fallback
  for (const candidate of electronCandidates(env)) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (exists(candidate)) return { path: candidate, source: 'probed' }
      continue
    }
    // 裸名字：交给 spawn 去 PATH 上找，但只能当兜底——所以先记住、继续往下看。
    fallback ??= { path: candidate, source: 'path' }
  }
  return fallback ?? { path: undefined, source: 'missing' }
}

/**
 * 把一次提醒变成小窗的命令行参数。
 *
 * payload 走**文件**而不是命令行：命令行里的 JSON 会被外壳的引号规则揉一遍（PowerShell
 * 实测会把 `{"id":...}` 交给程序时变成 `{id:...}`，`JSON.parse` 直接报 position 1），
 * 而写进临时文件再读没有任何转义问题。`--payload=` 那种写法仍然受支持，只是不从这里走。
 *
 * @param payloadFile - payload JSON 文件的路径。
 * @returns 参数数组。
 */
export function toastArgs(payloadFile) {
  return [
    TOAST_DIR,
    // 没有这一条，Chromium 会因为「页面没有用户手势」挂起 AudioContext，提示音静默失败。
    '--autoplay-policy=no-user-gesture-required',
    `--payload-file=${payloadFile}`
  ]
}

/**
 * 把 payload 写成一个临时 JSON 文件。
 *
 * 写在 DSH home 下的 `toast-payloads/` 里而不是系统临时目录：那个目录里 24 小时前的
 * 垃圾文件和这个插件的文件混在一起没法区分，而这里一眼就能看出是谁写的、也能一把清掉。
 *
 * @param payload - 小窗要展示的内容。
 * @param home - DSH home。
 * @returns 文件路径。
 */
export function writePayloadFile(payload, home) {
  const dir = join(home, 'toast-payloads')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${randomUUID()}.json`)
  writeFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8')
  return file
}

/**
 * 一个提醒该给小窗哪些字段。
 *
 * 这是 host 与页面之间唯一的「约定」，所以集中在一处，方便与 `toast/toast.js` 对照。
 * 字段语义：`ttlSeconds` 是**唯一的**存活时间权威（到点就退出），`requireAck` 只决定
 * 卡片上写「请点击收到确认」还是「提醒」。
 *
 * @param reminder - 刚响的提醒。
 * @param settings - 当前偏好。
 * @param now - 当前时间戳。
 * @returns 小窗 payload。
 */
export function toastPayload(reminder, settings, now = Date.now()) {
  const ttl = Number(settings.autoDismissSeconds)
  // 小窗活多久只有 `ttlSeconds` 一个权威：`0`（默认）= 一直留着等人点「收到」。
  // `requireAck` 只影响卡片上那行提示文字，不再参与退出决策——上一版让它和 ttl 各管一半，
  // 结果是「设了 6 秒自动关闭，小窗却挂到 300 秒」，这种两个开关抢方向盘的设计本身就是 bug。
  const seconds = Number.isFinite(ttl) && ttl > 0 ? Math.min(MAX_TTL_SECONDS, Math.round(ttl)) : MAX_TTL_SECONDS
  return {
    id: String(reminder.id),
    label: String(reminder.title || '提醒'),
    note: String(reminder.note || ''),
    time: formatClock(now),
    rule: reminder.repeat === 'daily' ? '每天' : '',
    requireAck: seconds >= MAX_TTL_SECONDS,
    // 音色映射：偏好里的 `off` 让小窗什么都不放，其余走三音提示音。
    sound: settings.sound === 'off' ? 'off' : 'default',
    theme: 'dark',
    ttlSeconds: seconds,
    snoozeMinutes: 5
  }
}

/** 本地 `HH:mm`。 */
function formatClock(timestamp) {
  const d = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 小窗进程必须没有这些环境变量。
 *
 * `ELECTRON_RUN_AS_NODE=1` 是最关键的一条：DSH 的 host 本身就是以这个变量跑起来的
 * Electron（纯 Node 子进程），而子进程默认继承父进程的环境——于是我们拉起的
 * `electron.exe` 会**又退化回纯 Node 模式**，`require('electron')` 拿到的是一个字符串
 * 路径而不是 API 对象，窗口根本不会出现。这个坑只在真跑的时候才暴露，日志里只有一句
 * 「Electron failed to install correctly」之类的误导信息。
 *
 * @param env - 基础环境。
 * @returns 清理过的环境副本。
 */
export function toastEnv(env = process.env) {
  const clean = { ...env }
  delete clean.ELECTRON_RUN_AS_NODE
  delete clean.ELECTRON_NO_ATTACH_CONSOLE
  return clean
}

/**
 * 拉起一次提醒小窗。
 *
 * `spawn` 的失败是**异步**的：可执行文件不存在时它不在调用处抛错，而是稍后 emit 一个
 * `error` 事件——没有监听者的 `error` 事件会让整个宿主进程崩掉。所以这里必然挂一个
 * 错误监听，并且只在真的 `spawn` 之后才报成功。
 *
 * 成功之后立刻解绑（`unref`）：小窗活多久是它自己的事，不该让宿主多等一秒，也不该拖住
 * Node 退出。payload 文件不必删——小窗读完之后留着也只是几百字节，而「删早了」会让小窗
 * 拿到一个空文件。
 *
 * @param options - payload、DSH home、日志文件、以及便于测试注入的 env/探测/spawn。
 * @returns `{ spawned, pid, electron, source, reason, payloadFile }`；调用方要 await。
 */
export async function spawnToast({ payload, home, logFile, env = process.env, exists = existsSync, spawnFn = spawn } = {}) {
  const { path: electron, source } = pickElectron(env, exists)
  if (electron === undefined) {
    return { spawned: false, electron: undefined, source, reason: 'no-electron' }
  }
  let payloadFile
  try {
    payloadFile = writePayloadFile(payload, home ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'))
  } catch (error) {
    return { spawned: false, electron, source, reason: `payload 写入失败：${String(error?.message ?? error)}` }
  }
  const args = toastArgs(payloadFile)
  if (logFile !== undefined && logFile !== '') args.push(`--log=${logFile}`)
  return await new Promise((resolve) => {
    let child
    try {
      child = spawnFn(electron, args, { detached: true, stdio: 'ignore', windowsHide: false, env: toastEnv(env) })
    } catch (error) {
      resolve({ spawned: false, electron, source, reason: String(error?.message ?? error), payloadFile })
      return
    }
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      if (onError !== undefined) child.off?.('error', onError)
      resolve(value)
    }
    /** 启动失败（ENOENT/EACCES…）：吞掉它，返回一个可读的原因。 */
    const onError = (error) => settle({ spawned: false, electron, source, reason: String(error?.message ?? error), payloadFile })
    child.once('error', onError)
    // 'spawn' 是 Node 对「真的起来了」的确认；用 setImmediate 兜底，避免老版本不发这个事件。
    child.once('spawn', () => {
      child.unref?.()
      schedulePayloadCleanup(payloadFile)
      settle({ spawned: true, pid: child.pid, electron, source, payloadFile })
    })
    setImmediate(() => {
      if (!settled && child.pid !== undefined) {
        child.unref?.()
        schedulePayloadCleanup(payloadFile)
        settle({ spawned: true, pid: child.pid, electron, source, payloadFile })
      }
    })
  })
}

/** payload 文件在拉起成功后留多久再删（毫秒）。 */
const PAYLOAD_TTL_MS = 120000

/**
 * 安排把 payload 文件删掉。
 *
 * 为什么要删：小窗打开时就把文件读完了，但如果不回收，`toast-payloads/` 会随着每一次提醒
 * 一直长下去（实测跑了几十次就堆了 35 个文件）。
 *
 * 为什么延迟 120 秒而不是立刻删：万一要复查还能看到内容；而且定时器 `unref` 掉了，这一次
 * 清理不该让宿主为了它多活两分钟。
 *
 * @param file - payload 文件路径。
 */
function schedulePayloadCleanup(file) {
  if (file === undefined) return
  const timer = setTimeout(() => {
    try {
      rmSync(file, { force: true })
    } catch {
      /* 删不掉就算了：它只是几百字节 */
    }
  }, PAYLOAD_TTL_MS)
  timer.unref?.()
}

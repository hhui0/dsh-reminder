/**
 * dsh-reminder —— Host 半边。
 *
 * 三件事写在这一个模块里，因为它们共享同一份状态，拆开只会让人到处找「提醒到底存在哪」：
 *
 *   1. `ReminderStore`  —— 提醒清单 + 偏好的持久化，以及「到点了该响哪几条」的纯逻辑；
 *   2. `apply()`        —— 把 store 挂成 Cordis 服务、注册 `reminder_*` 工具、
 *                          `/reminder` 命令和页面用的本机 HTTP 路由；
 *   3. 窗口唤醒          —— 走 `scripts/dsh-window.ps1`，因为插件两半都够不到宿主窗口。
 *
 * 为什么页面不走 `ctx.remote`：dsh-ledger 与 dsh-voice 都在同一条路上踩过坑——
 * 生成的 Remote 命名空间要等网关发布，激活期读到的是 `undefined`，而这条路由在插件
 * 激活的那一刻就存在。所以页面用 `fetch('/dsh-reminder/api/...')`，路由只服务本机。
 */
import { mkdirSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { Service } from '@deepseek-ai/cordis'
import {
  MAX_TITLE,
  MAX_NOTE,
  describeRemaining,
  formatLocal,
  nextOccurrence,
  normalizeReminder,
  parseWhen,
  parseRelativeMs
} from './parsing.js'
import { WINDOW_ROUTE, WindowActivator } from './window.js'
import { MAX_TTL_SECONDS, spawnToast, toastPayload } from './toast.js'

/** 插件名。 */
export const name = 'dsh-reminder'

/** 这条路由的前缀；页面半边拼的是同一个字符串。 */
export const REMINDER_ROUTE = '/dsh-reminder'

/** 这个插件注册到宿主上的服务：`ctx.get('reminders')`。 */
export const SERVICE = 'reminders'

/**
 * 硬依赖。缺了它们这一行就不该激活——工具注册和命令注册都没有降级路径，
 * 装不上就等于插件不存在，那还不如让 Loader 明确说「等 tools / commands」。
 */
export const inject = ['tools', 'commands']

/** 页面调用本机路由时的方法名。写成常量，免得两边各写一遍字符串。 */
export const API = {
  describe: 'describe',
  list: 'list',
  create: 'create',
  cancel: 'cancel',
  snooze: 'snooze',
  dismiss: 'dismiss',
  settings: 'settings',
  pending: 'pending'
}

/**
 * 默认偏好。
 *
 * 全部是「响」这件事的参数，因此**不**放进插件 Config：改一次不该重载插件（重载会重建
 * 定时器与长轮询），而且它们是渲染器侧的行为（声音、音量），存在 host 只是为了多开一个
 * 窗口时两边看到同一份设置。
 */
export const DEFAULT_SETTINGS = {
  /**
   * 提示音。
   *
   * `chime` / `bell` / `beep` 是**页面**合成的那三种；提醒小窗（独立 Electron 窗口）
   * 只认两件事：`off` 就静音，其余一律放那个三音提示音（与 `electron_demo` 的提醒小窗
   * 逐参数一致）。`tts` 走小窗的朗读。
   */
  sound: 'chime',
  /** 音量 0-1（只影响页面合成的三种音；小窗的音量由它自己定，与原项目一致）。 */
  volume: 0.6,
  /** 页面合成音的响铃重复次数。 */
  repeat: 3,
  /** 到点是否把 DSH 窗口唤到前台（需要 Windows；失败只记日志）。 */
  activateWindow: true,
  /** 到点是否拉提醒小窗（独立 Electron 窗口）。 */
  toastWindow: true,
  /** 弹窗/小窗是否自动关闭（0 = 一直等确认）。 */
  autoDismissSeconds: 0
}

/** 允许的提示音。 */
const SOUNDS = ['chime', 'bell', 'beep', 'tts', 'off']

/**
 * 兜底整形成一份合法偏好。
 * @param raw - 磁盘或请求里的原始对象。
 * @returns 归一化后的偏好。
 */
export function normalizeSettings(raw) {
  const input = raw === null || typeof raw !== 'object' ? {} : raw
  const sound = SOUNDS.includes(input.sound) ? input.sound : DEFAULT_SETTINGS.sound
  const volume = Number(input.volume)
  const repeat = Number(input.repeat)
  const autoDismiss = Number(input.autoDismissSeconds)
  return {
    sound,
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_SETTINGS.volume,
    repeat: Number.isFinite(repeat) ? Math.min(20, Math.max(1, Math.round(repeat))) : DEFAULT_SETTINGS.repeat,
    activateWindow: input.activateWindow === undefined ? DEFAULT_SETTINGS.activateWindow : input.activateWindow === true,
    toastWindow: input.toastWindow === undefined ? DEFAULT_SETTINGS.toastWindow : input.toastWindow === true,
    autoDismissSeconds:
      Number.isFinite(autoDismiss) && autoDismiss >= 0 ? Math.min(3600, Math.round(autoDismiss)) : DEFAULT_SETTINGS.autoDismissSeconds
  }
}

/**
 * 一条提醒进到「该响了」的判断。
 *
 * 时钟由外面传进来，所以这个函数可以在测试里被摆到任意时刻。
 *
 * @param reminder - 候选提醒。
 * @param now - 当前时间戳。
 * @param graceMs - 迟到多久之内还算数；超出的（关机一整晚）就直接跳过，不再补响。
 * @returns 是否应当在这一刻响。
 */
export function isDue(reminder, now, graceMs) {
  return reminder.status === 'active' && reminder.scheduledAt <= now && now - reminder.scheduledAt <= graceMs
}

/**
 * 原子写一个 JSON 文件。
 *
 * 先写 `.tmp` 再 `rename`：提醒清单是这个插件唯一的状态，一次断电中断的写入会让下次
 * 启动读到半截 JSON，于是所有提醒一起消失。临时文件与目标同目录，`rename` 才是原子的。
 *
 * @param file - 目标路径。
 * @param value - 要序列化的值。
 */
export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * 提醒清单与偏好的持有者。
 *
 * 状态全在内存里，每次改动立刻落盘。没有防抖：提醒的增删改都是人手触发的低频操作，
 * 而「改了但还没写」在崩溃时会直接丢一条提醒，不值得为这点 IO 冒险。
 */
export class ReminderStore {
  /**
   * @param options - 文件路径、时钟、以及迟到容忍。
   */
  constructor({ dataFile, settingsFile, now = () => Date.now(), graceMinutes = 120 } = {}) {
    this.dataFile = dataFile
    this.settingsFile = settingsFile
    this.now = now
    this.graceMs = Math.max(0, graceMinutes) * 60000
    /** @type {Array<ReturnType<typeof normalizeReminder>>} */
    this.reminders = []
    this.settings = { ...DEFAULT_SETTINGS }
    /** 已经落盘了吗——没加载完之前不允许写，否则会把磁盘上的清单覆盖成空。 */
    this.loaded = false
    /** `loading` 是并发调用共享的那一次加载，避免两次 `load()` 各写一遍文件。 */
    this.loading = undefined
    this.listeners = new Set()
  }

  /** 订阅变化（工具改了清单，页面要跟着变）。@returns 取消订阅。 */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 通知所有订阅者。 */
  notify() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // 一个订阅者炸了不该影响其余订阅者，也不该影响工具调用本身。
      }
    }
  }

  /**
   * 从磁盘读取清单与偏好。可以重复调用，只会真的读一次。
   * @returns 加载完成。
   */
  load() {
    this.loading ??= this.read()
    return this.loading
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.dataFile, 'utf8'))
      const raw = Array.isArray(parsed?.reminders) ? parsed.reminders : []
      this.reminders = raw.map(normalizeReminder).filter((item) => item !== undefined)
    } catch {
      // 文件不存在、或是一份读不动的旧 JSON：当作空清单重新开始，而不是让插件起不来。
      this.reminders = []
    }
    try {
      this.settings = normalizeSettings(JSON.parse(await readFile(this.settingsFile, 'utf8')))
    } catch {
      this.settings = { ...DEFAULT_SETTINGS }
    }
    this.loaded = true
    this.notify()
  }

  /** 把清单落盘。 */
  persist() {
    return writeJsonAtomic(this.dataFile, { version: 1, reminders: this.reminders })
  }

  /** 把偏好落盘。 */
  persistSettings() {
    return writeJsonAtomic(this.settingsFile, { version: 1, ...this.settings })
  }

  /**
   * 新建一条提醒。
   *
   * @param request - `{title, note, afterMinutes/in, at, repeat}`，时间字段见 `resolveTime`。
   * @returns 落盘后的提醒。
   */
  async create(request = {}) {
    await this.load()
    const now = this.now()
    const title = String(request.title ?? '').trim()
    if (title === '') throw new Error('提醒需要一个标题')
    // `repeat` 只认两个字面量。不认识的取值直接报错，而不是静默按 `once` 处理：
    // 一个被悄悄丢掉的字段，表现是「我明明说了每天，它只响了一次」——最难查的那种 bug。
    const repeatInput = request.repeat
    if (repeatInput !== undefined && repeatInput !== null && repeatInput !== '' && repeatInput !== 'once' && repeatInput !== 'daily') {
      throw new Error(`repeat 只能是 once 或 daily，收到的是「${String(repeatInput)}」`)
    }
    const repeat = repeatInput === 'daily' ? 'daily' : 'once'
    const scheduledAt = this.resolveTime(request, now)
    if (scheduledAt === undefined) throw new Error('没能识别提醒时间（可用「30」「30m」「10s」「19:30」「2026-09-28 07:30」）')
    if (scheduledAt <= now) throw new Error('提醒时间必须晚于现在')
    const reminder = normalizeReminder({
      id: randomUUID().slice(0, 8),
      title: title.slice(0, MAX_TITLE),
      note: String(request.note ?? '').slice(0, MAX_NOTE),
      scheduledAt,
      repeat,
      status: 'active',
      createdAt: now,
      source: request.source === 'command' || request.source === 'api' ? request.source : 'tool'
    })
    this.reminders.push(reminder)
    await this.persist()
    this.notify()
    return reminder
  }

  /**
   * 把一次请求里的时间字段翻译成绝对时刻。
   *
   * 字段有四个入口，按优先级：`after_minutes` / `in` 是相对时间，`at` / `when` / `time`
   * 是绝对或自然语言时间。都给就以前者为准——模型更可能把「10 分钟后」塞进 `in`，
   * 而 `at` 是它顺手填的猜测。
   *
   * @param request - 请求对象。
   * @param now - 当前时间戳。
   * @returns 时间戳，或 `undefined`。
   */
  resolveTime(request, now) {
    const minutes = request.afterMinutes ?? request.after_minutes ?? request.in
    if (minutes !== undefined && minutes !== null && String(minutes).trim() !== '') {
      const value = Number(minutes)
      if (Number.isFinite(value) && value > 0) return now + Math.round(value * 60000)
      // 允许把 `in` 写成 `"30m"` 这种带单位的形式。
      const parsed = parseRelativeMs(minutes)
      if (parsed !== undefined) return now + parsed
    }
    const text = request.at ?? request.when ?? request.time
    if (text !== undefined && text !== null && String(text).trim() !== '') return parseWhen(text, now)
    return undefined
  }

  /**
   * 列出提醒。
   * @param options - `includeDismissed` 是否带上已经看过的。
   * @returns 按时间升序的副本。
   */
  async list({ includeDismissed = false } = {}) {
    await this.load()
    return this.reminders
      .filter((item) => includeDismissed || item.status !== 'dismissed')
      .slice()
      .sort((left, right) => left.scheduledAt - right.scheduledAt)
  }

  /** 按 id 找一条。 */
  async find(id) {
    await this.load()
    return this.reminders.find((item) => item.id === id)
  }

  /**
   * 删除一条提醒。
   * @param id - 提醒 id。
   * @returns 是否删掉了。
   */
  async remove(id) {
    await this.load()
    const before = this.reminders.length
    this.reminders = this.reminders.filter((item) => item.id !== id)
    if (this.reminders.length === before) return false
    await this.persist()
    this.notify()
    return true
  }

  /**
   * 把一条提醒推迟若干分钟。
   *
   * 循环提醒推迟只影响「下一次」：`scheduledAt` 前移，`repeat` 不动，所以明天仍然是
   * 原来的钟点……但严格说不是——被推迟的循环提醒起点变了，之后每天都跟着新起点走。
   * 这是有意的：用户说「再等 10 分钟」，指的是这一次，没有别的地方可以记。
   *
   * @param id - 提醒 id。
   * @param minutes - 推迟多少分钟。
   * @returns 推迟后的提醒，或 `undefined`。
   */
  async snooze(id, minutes) {
    await this.load()
    const reminder = this.reminders.find((item) => item.id === id)
    if (reminder === undefined) return undefined
    const value = Number(minutes)
    const delta = Number.isFinite(value) && value > 0 ? Math.round(value) : 5
    reminder.scheduledAt = this.now() + delta * 60000
    reminder.status = 'active'
    await this.persist()
    this.notify()
    return reminder
  }

  /**
   * 标记一条提醒已经响过。
   *
   * 一次性提醒响完就删——留着的唯一效果是清单越积越长，而用户对「已经响过的闹钟」
   * 没有任何操作可做。循环提醒则重新排下一次。
   *
   * @param id - 提醒 id。
   * @returns 响过的提醒副本，以及它是否已被移出清单。
   */
  async fire(id) {
    await this.load()
    const reminder = this.reminders.find((item) => item.id === id)
    if (reminder === undefined) return { fired: undefined, removed: false }
    const now = this.now()
    reminder.firedAt = now
    reminder.fireCount += 1
    reminder.status = 'fired'
    if (reminder.repeat === 'daily') reminder.scheduledAt = nextOccurrence(reminder.scheduledAt, now)
    const snapshot = { ...reminder }
    if (reminder.repeat !== 'daily') this.reminders = this.reminders.filter((item) => item.id !== id)
    await this.persist()
    this.notify()
    return { fired: snapshot, removed: snapshot.repeat !== 'daily' }
  }

  /**
   * 挑出此刻该响的提醒并逐个处理。
   *
   * 迟到的判断在这里做，而不是在 `isDue` 里删：一条错过了窗口的提醒不是「响过了」，
   * 而是「没意义了」，两者在清单上的结局不同。
   *
   * @returns 本次真正响了的提醒，以及被跳过的迟到提醒。
   */
  async tick() {
    await this.load()
    const now = this.now()
    const due = []
    const stale = []
    for (const reminder of this.reminders) {
      if (reminder.status !== 'active' || reminder.scheduledAt > now) continue
      if (isDue(reminder, now, this.graceMs)) due.push(reminder)
      else stale.push(reminder)
    }
    const fired = []
    for (const reminder of due) {
      const result = await this.fire(reminder.id)
      if (result.fired !== undefined) fired.push(result.fired)
    }
    if (stale.length > 0) {
      // 超过容忍窗口的旧提醒一律删掉：机器关了三天，醒来不该同时弹出十条「该喝水了」。
      const ids = new Set(stale.map((item) => item.id))
      this.reminders = this.reminders.filter((item) => !ids.has(item.id))
      await this.persist()
      this.notify()
    }
    return { fired, skipped: stale.map((item) => ({ ...item })) }
  }

  /**
   * 改偏好。
   * @param patch - 部分偏好。
   * @returns 合并后的偏好。
   */
  async setSettings(patch) {
    await this.load()
    this.settings = normalizeSettings({ ...this.settings, ...(patch ?? {}) })
    await this.persistSettings()
    this.notify()
    return this.settings
  }

  /** 给页面看的一行状态：文件在哪、有几条提醒、当前偏好。 */
  async describe() {
    await this.load()
    return {
      dataFile: this.dataFile,
      settingsFile: this.settingsFile,
      count: this.reminders.length,
      active: this.reminders.filter((item) => item.status === 'active').length,
      settings: this.settings,
      now: this.now()
    }
  }
}

/**
 * 调度器：一个 interval + 一组长轮询等待者。
 *
 * 页面拿提醒的方式是**长轮询**（`GET /api/pending` 挂住 20 秒），不是定时拉：
 * 定时拉要么延迟肉眼可见，要么请求频率高得离谱；长轮询让「到点」到「弹窗」之间
 * 只有一次本机请求的延迟，而空闲时每个窗口每 20 秒只有一个几乎空转的请求。
 */
export class ReminderScheduler {
  /**
   * @param options - store、时钟、间隔、通知回调。
   */
  constructor({ store, now = () => Date.now(), intervalMs = 1000, onFire = () => {}, onSkip = () => {} } = {}) {
    this.store = store
    this.now = now
    this.intervalMs = Math.max(250, intervalMs)
    this.onFire = onFire
    this.onSkip = onSkip
    this.timer = undefined
    /** 正在等待「有东西响了」的长轮询。 */
    this.waiters = new Set()
    /** 一次 tick 可能还在 await 落盘，重入会让同一条提醒响两次。 */
    this.ticking = false
  }

  /** 开始按间隔检查。重复调用不会叠出第二个定时器。 */
  start() {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    // Node 的定时器默认会吊住事件循环；提醒是纯粹的旁路功能，不该拖住宿主退出。
    this.timer.unref?.()
    void this.tick()
  }

  /** 停表并唤醒所有等待者。 */
  stop() {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.wake()
  }

  /** 跑一次检查；同一条提醒不会被两次重入的检查同时响。 */
  async tick() {
    if (this.ticking) return { fired: [], skipped: [] }
    this.ticking = true
    try {
      const result = await this.store.tick()
      for (const reminder of result.skipped) this.onSkip(reminder)
      for (const reminder of result.fired) this.onFire(reminder)
      if (result.fired.length > 0) {
        this.wake()
        return result
      }
      // 没有任何东西响的时候，也要看看长轮询在等什么。
      //
      // 刚响过的提醒在清单里是「已响」，页面必须**立刻**知道——这是「到点就弹窗」的全部
      // 含义。只在 `fired` 时唤醒是不够的：如果到点恰好落在 `wait()` 挂上之前，那次唤醒就
      // 丢了，页面要等这次长轮询自己超时（最多 20 秒）才会发现。所以这里按「还有没有
      // 待确认的提醒」每 tick 检查一次——机器时间恰好跨过触发点的那一秒就会被捕捉到，
      // 而空闲时（没有任何已响提醒）第二个条件为假，长轮询安静地挂满整段时间。
      if (this.waiters.size > 0) {
        const now = Date.now()
        const pending = (await this.store.list()).some((item) => item.status === 'fired' && now - item.firedAt < 10 * MINUTE)
        if (pending) this.wake()
      }
      return result
    } finally {
      this.ticking = false
    }
  }

  /**
   * 等下一批到点的提醒。
   *
   * 这里的超时定时器**故意不 unref**：它挂着一件真实的工作（一次还没写完的 HTTP 响应），
   * 让它保持引用才是对的。与之相对，`start()` 里那个每秒的检查定时器是纯粹的旁路工作，
   * 所以那个 unref 掉了。
   *
   * @param timeoutMs - 最长挂多久；到点就返回空数组，让页面重新挂一次。
   * @returns 已经响过、等页面确认的提醒。
   */
  wait(timeoutMs) {
    return new Promise((resolve) => {
      const waiter = { resolve, timer: undefined }
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve([])
      }, timeoutMs)
      this.waiters.add(waiter)
    })
  }

  /** 立刻结束所有等待，让它们各自去读一遍清单。 */
  wake() {
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(undefined)
    }
  }
}

/** 一次 API 调用的错误，带上 HTTP 状态码。 */
export class ApiError extends Error {
  constructor(message, status = 400, code = 'bad_request') {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 一分钟，用于把「迟到容忍」换算成毫秒，也用于「已响提醒的可展示窗口」。 */
const MINUTE = 60000

/**
 * 提醒能力的门面：把 store、调度器、窗口唤醒和偏好缝在一起，供工具、命令、路由共用。
 *
 * 单独一层而不是让工具直接摸 store，是因为「响」这件事有三个副作用——记状态、唤醒窗口、
 * 让页面知道——它们必须原子地发生在一起，散在三处迟早会漏掉一个。
 *
 * 继承 Cordis 的 `Service` 并挂到父上下文上（`ctx.plugin(...)`），所以工具与路由拿到的是
 * **同一个**实例，而一次 Config 变更重载插件时，旧实例会连同它的定时器一起被销毁。
 */
export class ReminderService extends Service {
  /**
   * @param ctx - 父上下文。
   * @param config - 这一行解析后的 Config。
   */
  constructor(ctx, config) {
    super(ctx, SERVICE)
    this.dataFile = resolvePath(config.dataFile ?? defaultDataFile())
    this.settingsFile = resolvePath(config.settingsFile ?? defaultSettingsFile())
    this.store = new ReminderStore({
      dataFile: this.dataFile,
      settingsFile: this.settingsFile,
      graceMinutes: config.catchUpMinutes ?? 120
    })
    this.activator = config.activateWindow === false ? undefined : createActivator(ctx, config)
    // 诊断追踪文件：空串 = 关闭（默认）。见 `handleRequest` 的 `/api/trace`。
    this.traceLog = String(config.traceLog ?? '').trim() === '' ? '' : resolvePath(config.traceLog)
    // 提醒小窗（独立 Electron 进程）的日志：空串 = 关闭（默认）。
    this.toastLog = String(config.toastLog ?? '').trim() === '' ? '' : resolvePath(config.toastLog)
    this.log = (line) => this.ctx.logger?.info?.(`[dsh-reminder] ${line}`)
    this.scheduler = new ReminderScheduler({
      store: this.store,
      onFire: (reminder) => this.announce(reminder),
      onSkip: (reminder) => this.log(`跳过迟到的提醒：${reminder.title}（原定 ${formatLocal(reminder.scheduledAt)}）`)
    })
    // 定时器挂在服务的隔离上下文上，而不是传进来的父上下文。
    //
    // 这里踩过一次坑：`ctx.plugin()` 返回的子 fiber 是异步启动的，而 `apply` 拿到的父
    // 上下文在那个时刻仍然活跃——如果 effect 注册在父上下文上、又恰好被子 fiber 的启动
    // 流程顺手清理一遍，定时器就会「刚建好就被停掉」，症状是插件一切正常但永远不响。
    // 挂在 `this.ctx` 上，父子两边谁先谁后都不影响它。
    this.ctx.effect(
      () => {
        this.scheduler.start()
        return () => this.scheduler.stop()
      },
      'dsh-reminder: scheduler'
    )
  }

  /**
   * 到点时要做的副作用：拉提醒小窗 + 唤窗口。
   *
   * 这两件事都是「尽力而为」，任何一步失败都只写日志：
   *   · 提醒小窗是独立的 Electron 进程，找不到 Electron 也还有页面里的浮层兜底；
   *   · 唤窗口只在 Windows 上有效，失败只是少一步。
   *
   * @param reminder - 刚响的提醒。
   */
  announce(reminder) {
    this.log(`提醒到点：${reminder.title}`)
    if (this.store.settings.toastWindow !== false) {
      // 不 await：拉窗口的几百毫秒不该拖住调度器的这一次 tick。
      void this.openToast(reminder).catch((error) => this.log(`提醒小窗出错：${String(error)}`))
    }
    if (this.activator === undefined || this.store.settings.activateWindow !== true) return
    void this.activator.activate().catch((error) => this.log(`唤窗口失败：${String(error)}`))
  }

  /**
   * 拉起提醒小窗。
   *
   * @param reminder - 刚响的提醒。
   */
  async openToast(reminder) {
    const payload = toastPayload(reminder, this.store.settings)
    // `spawnToast` 会 await「真的起来了」：`spawn` 的失败是异步的（error 事件），
    // 不 await 就没法区分「起来了」和「可执行文件不存在」。
    const result = await spawnToast({ payload, logFile: this.toastLog })
    if (result.spawned) this.log(`提醒小窗已拉起 pid=${result.pid}（${result.electron}）`)
    else this.log(`没能拉起提醒小窗：${result.reason}`)
    return result
  }

  /**
   * 新建提醒。
   * @param request - 见 `ReminderStore.create`。
   * @returns 提醒。
   */
  async create(request) {
    const reminder = await this.store.create(request)
    // 唤醒长轮询：页面拿到的列表要立刻包含这条新提醒，而不是等下一次超时。
    this.scheduler.wake()
    return reminder
  }

  /**
   * 读列表（页面与工具共用同一份整形结果）。
   * @param options - `includeDismissed`。
   * @returns `{reminders, settings, now}`。
   */
  async list(options) {
    const reminders = await this.store.list(options)
    return { reminders, settings: this.store.settings, now: Date.now() }
  }

  /**
   * 等下一次响。
   *
   * @param timeoutMs - 最长挂多久。
   * @param seenIds - 调用方已经展示过的提醒 id。到点的提醒在清单里是「已响」，
   *   它会一直留在那里直到页面确认，所以这里必须靠 `seenIds` 去重：否则一次长轮询
   *   超时后重挂，同一条提醒会被反复推给页面，用户看到的是弹窗自己长出来。
   * @returns 还没展示过的、已经到点的提醒。
   */
  async pending(timeoutMs, seenIds = []) {
    await this.scheduler.wait(timeoutMs)
    const now = Date.now()
    const seen = new Set(seenIds)
    const reminders = await this.store.list()
    return {
      reminders: reminders
        .filter((item) => item.status === 'fired' && now - item.firedAt < 10 * MINUTE && !seen.has(item.id))
        .map((item) => ({ ...item })),
      settings: this.store.settings,
      now
    }
  }
}

/** 工具与命令共用的参数整形：把「人话时间」翻译成 store 的请求对象。 */
export function reminderRequest(args = {}, source = 'tool') {
  return {
    title: args.title,
    note: args.note,
    afterMinutes: args.after_minutes ?? args.afterMinutes,
    at: args.at ?? args.when ?? args.time,
    repeat: args.repeat,
    source
  }
}

/** 一条提醒的工具/命令文案。 */
export function renderReminder(reminder, now = Date.now()) {
  const repeat = reminder.repeat === 'daily' ? ' · 每天' : ''
  const state = reminder.status === 'fired' ? ' · 已响' : ''
  return `${formatLocal(reminder.scheduledAt)}（${describeRemaining(reminder.scheduledAt, now)}）${repeat}${state}｜${reminder.title}`
}

/**
 * 注册 Host 半边。
 *
 * @param ctx - Cordis Host 上下文。
 * @param config - 这一行的 Config。
 */
export function apply(ctx, config) {
  const dataFile = resolvePath(config.dataFile ?? defaultDataFile())
  const settingsFile = resolvePath(config.settingsFile ?? defaultSettingsFile())
  // Config 是「用户填的是什么」，解析后的绝对路径要回填，否则设置页显示的是一个相对路径。
  config.dataFile = dataFile
  config.settingsFile = settingsFile
  mkdirSync(dirname(dataFile), { recursive: true })

  // 服务挂成子插件：`ctx.plugin` 负责它的生命周期，工具与路由通过 `need(ctx)` 按名字取。
  // 这样一次 Config 变更重载这个插件时，旧的定时器一定随旧实例走掉。
  ctx.plugin(ReminderService, config)

  installTools(ctx)
  installCommand(ctx)
  installRoutes(ctx)
}

/** `ctx.get` 取服务；没就绪时给一句人能看懂的话。 */
function need(ctx) {
  const service = ctx.get(SERVICE)
  if (service === undefined) throw new Error('提醒服务尚未就绪')
  return service
}

/**
 * 注册三个模型可调用的工具。
 *
 * 名字统一用 `reminder_` 前缀：工具列表是扁平的，前缀是模型分清「这是谁的能力」的唯一线索。
 *
 * @param ctx - Host 上下文。
 */
function installTools(ctx) {
  const renderSummary = (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }]

  ctx.tools.register({
    name: 'reminder_set',
    description:
      '设置一个提醒：到点会弹出提醒窗口并播放提示音。用户说「X 分钟后提醒我」「明天 8 点叫我」「每天 9 点提醒我喝水」时使用。时间给 after_minutes（相对分钟，要秒级就填小数，例如 10 秒 = 0.1667）或 at（"19:30"、"10s"、"30m"、"明天 08:00"、"2026-09-28 07:30"）之一。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '提醒内容，例如「开会」「该吃药了」' },
        after_minutes: { type: 'number', description: '多少分钟后提醒；支持小数（10 秒 = 0.1667）。与 at 二选一' },
        at: {
          type: 'string',
          description:
            '绝对或自然时间："19:30"、"8点半"、"明天 08:00"、"2026-09-28 07:30"，或相对时间 "10s"、"30m"、"1h30m"、"半分钟"'
        },
        repeat: { type: 'string', enum: ['once', 'daily'], description: 'once=只响一次（默认），daily=每天同一时刻' },
        note: { type: 'string', description: '补充备注（可选）' }
      },
      required: ['title'],
      additionalProperties: false
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderSummary },
    async execute(args) {
      const service = need(ctx)
      try {
        const reminder = await service.create(reminderRequest(args, 'tool'))
        return {
          ok: true,
          reminder,
          summary: `已设置提醒：${renderReminder(reminder)}`
        }
      } catch (error) {
        const message = String(error?.message ?? error)
        return { ok: false, error: message, summary: `没能设置提醒：${message}` }
      }
    }
  })

  ctx.tools.register({
    name: 'reminder_list',
    description: '列出当前所有提醒（含每天循环的），按时间排序。用户问「我有哪些提醒」「提醒列表」时使用。',
    parameters: {
      type: 'object',
      properties: {
        include_dismissed: { type: 'boolean', description: '是否包含已经响过、已经看过的（默认不含）' }
      },
      additionalProperties: false
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderSummary },
    async execute(args) {
      const service = need(ctx)
      const { reminders, settings, now } = await service.list({ includeDismissed: args.include_dismissed === true })
      return {
        ok: true,
        count: reminders.length,
        reminders,
        settings,
        summary:
          reminders.length === 0
            ? '当前没有提醒。'
            : [`共 ${reminders.length} 条提醒：`, ...reminders.map((item) => `· [${item.id}] ${renderReminder(item, now)}`)].join('\n')
      }
    }
  })

  ctx.tools.register({
    name: 'reminder_cancel',
    description: '取消一条提醒（id 从 reminder_list 获取）。删除前请先把要删的那条告诉用户。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '提醒 id' } },
      required: ['id'],
      additionalProperties: false
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderSummary },
    async execute(args) {
      const service = need(ctx)
      const reminder = await service.store.find(args.id)
      const removed = await service.store.remove(args.id)
      service.scheduler.wake()
      return {
        ok: removed,
        summary: removed
          ? `已取消提醒：${reminder === undefined ? args.id : renderReminder(reminder)}`
          : `没有找到 id 为 ${args.id} 的提醒`
      }
    }
  })
}

/**
 * 注册 `/reminder` 人工命令。
 *
 * 命令与工具的区别在于「谁发起」：命令由人在输入框里打出来，不经过模型，
 * 所以它必须自己解析时间——这正是 `parsing.js` 存在的意义。
 *
 * @param ctx - Host 上下文。
 */
function installCommand(ctx) {
  ctx.commands.register({
    definitionId: 'dsh-reminder/reminder',
    name: 'reminder',
    description: '设置或查看提醒：/reminder 30m 开会',
    input: { hint: '[时间] <内容>（例：30m 开会 / 19:30 吃饭 / 明天 8:00 起床）' },
    async handler(invocation) {
      const service = need(ctx)
      const raw = String(invocation.rawInput ?? '').trim()
      if (raw === '') {
        const { reminders, now } = await service.list({})
        return {
          kind: 'success',
          text:
            reminders.length === 0
              ? '当前没有提醒。用法：/reminder 30m 开会'
              : [`共 ${reminders.length} 条提醒：`, ...reminders.map((item) => `· [${item.id}] ${renderReminder(item, now)}`)].join('\n')
        }
      }
      // 「取消 8a3f」这种写法留给人：命令没有参数解析器，靠第一个词分流最简单。
      const cancel = /^(?:cancel|del|delete|取消|删除)\s+(\S+)$/i.exec(raw)
      if (cancel !== null) {
        const reminder = await service.store.find(cancel[1])
        const removed = await service.store.remove(cancel[1])
        service.scheduler.wake()
        return removed
          ? { kind: 'success', text: `已取消提醒：${reminder === undefined ? cancel[1] : renderReminder(reminder)}` }
          : { kind: 'error', text: `没有找到 id 为 ${cancel[1]} 的提醒` }
      }
      // 第一个词是时间就用它，否则整句都是标题、默认「10 分钟后」。
      const [head, ...rest] = raw.split(/\s+/)
      const tail = rest.join(' ').trim()
      const headLooksRelative = parseRelativeMs(head) !== undefined && (/[a-z\u4e00-\u9fa5]/i.test(head) || tail !== '')
      const headLooksClock = /^\d{1,2}\s*[:：点时]/.test(head)
      const title = headLooksRelative || headLooksClock ? tail : raw
      const when = headLooksRelative || headLooksClock ? head : '10m'
      if (title === '') return { kind: 'error', text: '提醒内容不能为空。用法：/reminder 30m 开会' }
      try {
        const reminder = await service.create({ title, at: when, source: 'command' })
        return { kind: 'success', text: `已设置提醒：${renderReminder(reminder)}\n（取消：/reminder 取消 ${reminder.id}）` }
      } catch (error) {
        return { kind: 'error', text: `没能设置提醒：${String(error?.message ?? error)}` }
      }
    }
  })
}

/**
 * 页面用的本机 HTTP 路由。
 *
 * 一条 JSON-RPC 风格的 `POST /api/call` 加一条长轮询 `GET /api/pending`，而不是七八条
 * REST：方法名与参数在两边各写一次就够了，路由表的长度不随时间增长。
 *
 * @param ctx - Host 上下文。
 */
function installRoutes(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: REMINDER_ROUTE,
          // 返回这个 promise（而不是 `void` 掉）：webServer 的契约是 handler 的返回值
          // 代表这次请求处理完没有，吞掉它会让上游以为请求已经结束。
          handler: (req, res) => handleRequest(req, res, ctx)
        }),
      'dsh-reminder: api route'
    )
    webCtx.logger?.info?.('[dsh-reminder] 路由：%s/api/call · %s/api/pending', REMINDER_ROUTE, REMINDER_ROUTE)
  })
}

/** 只服务本机：这条路由能弹窗、能发出声音。 */
function isLocalRequest(req) {
  const remote = req.socket?.remoteAddress ?? ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/** 回一个 JSON 响应。 */
function respondJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/** 读请求体（有上限：这条路由只收很小的 JSON）。 */
function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new ApiError('请求体过大', 413, 'too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 处理一条页面请求。
 *
 * @param req - HTTP 请求。
 * @param res - HTTP 响应。
 * @param ctx - Host 上下文（`need(ctx)` 取服务）。
 */
async function handleRequest(req, res, ctx) {
  if (!isLocalRequest(req)) {
    respondJson(res, 403, { ok: false, error: 'local-only' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname.slice(REMINDER_ROUTE.length)
  try {
    const service = need(ctx)
    if (path === '/api/pending' && req.method === 'GET') {
      const timeout = Math.min(30000, Math.max(1000, Number(url.searchParams.get('timeout')) || 20000))
      // 已展示过的 id 由页面通过 `seen` 查询参数带上来（逗号分隔），长度有上限：
      // 这是本机路由，但仍然不该让一个超长 URL 把内存吃满。
      const seen = String(url.searchParams.get('seen') ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
        .slice(0, 200)
      respondJson(res, 200, { ok: true, value: await service.pending(timeout, seen) })
      return
    }
    if (path === '/api/trace' && req.method === 'POST') {
      // 诊断通道：页面把自己的动作写到宿主这边来。
      //
      // 「弹窗没出现」这类问题的第一嫌疑永远是「页面那一半根本没在跑」，而宿主看不到浏览器
      // 的控制台、外部探针也看不到页面的内部状态。所以留一条**只写文件、只服务本机**的
      // 追踪通道：页面每做一步就报一声，出问题时读这个文件就知道链条断在哪一环。
      // 只有 Config 里配了 `traceLog` 才会落盘，默认关闭。
      const log = need(ctx).traceLog
      if (log !== '') {
        const payload = await readBody(req)
        await appendFile(log, `${new Date().toISOString()} ${payload}\n`, 'utf8').catch(() => {})
      }
      respondJson(res, 200, { ok: true, value: { ok: true } })
      return
    }
    if (path === '/api/call' && req.method === 'POST') {
      const text = await readBody(req)
      const call = text === '' ? {} : JSON.parse(text)
      const value = await dispatch(String(call?.method ?? ''), call?.args ?? {}, ctx, service)
      respondJson(res, 200, { ok: true, value })
      return
    }
    respondJson(res, 404, { ok: false, error: 'not-found' })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 400
    const code = error instanceof ApiError ? error.code : 'error'
    respondJson(res, status, { ok: false, error: String(error?.message ?? error), code })
  }
}

/**
 * 把一次方法调用派发到服务。
 *
 * @param method - 方法名。
 * @param args - 参数对象。
 * @param ctx - Host 上下文。
 * @param service - 提醒服务。
 * @returns 方法的返回值。
 */
async function dispatch(method, args, ctx, service) {
  switch (method) {
    case API.describe:
      return await service.store.describe()
    case API.list: {
      const { reminders, settings, now } = await service.list({ includeDismissed: args?.includeDismissed === true })
      return { reminders, settings, now }
    }
    case API.create: {
      // 页面走的是同一套解析：设置页里手打「30m」必须和工具里一样能用。
      const reminder = await service.create(reminderRequest(args, 'api'))
      return { reminder }
    }
    case API.cancel: {
      const reminder = await service.store.find(String(args?.id ?? ''))
      const removed = await service.store.remove(String(args?.id ?? ''))
      service.scheduler.wake()
      return { removed, reminder }
    }
    case API.snooze: {
      const reminder = await service.store.snooze(String(args?.id ?? ''), args?.minutes)
      service.scheduler.wake()
      if (reminder === undefined) throw new ApiError('没有找到这条提醒', 404, 'not_found')
      return { reminder }
    }
    case API.dismiss: {
      // 页面确认「我看到了」。一次性提醒在响的那一刻已经从清单里删掉了，所以这里
      // 通常无事可做；真正做到的是 `service.pending` 的 `seen` 去重——页面把 id 记进
      // 自己的已展示集合，同一个弹窗就不会再被推一次。这里顺手清掉可能残留的记录。
      const id = String(args?.id ?? '')
      if (id !== '') {
        const reminder = await service.store.find(id)
        if (reminder !== undefined && reminder.status === 'fired' && reminder.repeat === 'once') await service.store.remove(id)
      }
      service.scheduler.wake()
      return { ok: true }
    }
    case API.settings:
      return { settings: await service.store.setSettings(args ?? {}) }
    default:
      throw new ApiError(`未知方法：${method}`, 404, 'unknown_method')
  }
}

/** 默认的提醒清单位置：DSH home 下，跟别的插件状态放一起。 */
export function defaultDataFile() {
  return join(dshHome(), 'reminders.json')
}

/** 默认的偏好文件位置。 */
export function defaultSettingsFile() {
  return join(dshHome(), 'reminder-settings.json')
}

/** DSH 的 home 目录。 */
function dshHome() {
  return process.env.DSH_HOME || process.env.DSH_DATA_HOME || join(process.env.USERPROFILE || homedir(), '.dsh')
}

/** 相对路径按当前工作目录解析；给 Config 一个宽松但确定的语义。 */
function resolvePath(value) {
  const text = String(value ?? '').trim()
  return text === '' ? defaultDataFile() : isAbsolute(text) ? text : resolve(text)
}

/**
 * 造窗口激活器。
 *
 * 非 Windows 上直接返回 `undefined`：脚本用的是 Win32 API，在别的平台上它只会失败，
 * 与其每次提醒都记一条错误日志，不如一开始就不装这个能力。
 *
 * @param ctx - Host 上下文。
 * @param config - 这一行的 Config。
 * @returns 激活器，或不装。
 */
function createActivator(ctx, config) {
  if (process.platform !== 'win32') {
    ctx.logger?.info?.('[dsh-reminder] 非 Windows 平台：到点不唤窗口')
    return undefined
  }
  return new WindowActivator({
    // host 的 ctx.logger 落不到用户看得见的地方，失败要留下一个能读的文件。
    logFile: join(dshHome(), 'reminder-window.log'),
    log: (line) => ctx.logger?.info?.(`[dsh-reminder] ${line}`)
  })
}

/** 这一行 Config 的 schema。字段说明见 cordis.patch.yml。 */
export const Config = z.object({
  dataFile: z.string().default(''),
  settingsFile: z.string().default(''),
  /** 迟到多久之内还补响；超出的直接丢掉，避免开机弹出一串旧提醒。 */
  catchUpMinutes: z.natural().max(10080).default(120),
  /** 宿主侧的全局开关：到点是否唤窗口（页面里还有一份同名的偏好，两边都要开）。 */
  activateWindow: z.boolean().default(true),
  /**
   * 诊断追踪文件的路径；空串（默认）= 关闭。
   *
   * 打开之后，页面会把它自己的动作（激活、开始轮询、拿到提醒、播放提示音、出错）通过
   * `/api/trace` 写到这个文件里。排查「弹窗没出现」这类问题时，它是唯一能同时看到页面与
   * 宿主两边的证据。
   */
  traceLog: z.string().default(''),
  /**
   * 提醒小窗（独立 Electron 进程）的日志路径；空串（默认）= 关闭。
   *
   * 小窗在自己的进程里，它的失败不会出现在宿主的日志里，所以排查时把它指到一个文件即可。
   */
  toastLog: z.string().default('')
})

export { WINDOW_ROUTE, WindowActivator }

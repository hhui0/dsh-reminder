/**
 * dsh-reminder —— Web Client 半边。
 *
 * 两个座位，各管一件事：
 *   · `shell.overlay`   到点时的提醒弹窗。它是 frame 级的浮层，所以在哪个面板、滚到哪儿
 *                       都不影响它出现；
 *   · `settings.section` 「提醒」设置页：手建提醒、看清单、取消，以及提示音偏好。
 *
 * 「到点」这件事是 **host 判断**的，页面只负责显示：host 每秒检查一次清单，到点就把提醒
 * 放进「已响」状态，页面用长轮询（`GET /api/pending`，最多挂 20 秒）拿到它。这样做的
 * 代价是必须说清楚——**DSH 必须开着，提醒才会响**；好处是定时器只有一处，不会因为多开一个
 * 窗口就多响一次。
 *
 * 提示音不用音频文件：Web Audio 现场合成。三个理由——插件不携带二进制资源、音量可以精确
 * 控制、「静音」是一个真正的分支而不是少写一个文件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-reminder',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** 这个插件的字典命名空间。 */
    const NS = 'reminder'
    /** 每条 CSS 类都带这个前缀。 */
    const P = 'dsh-reminder'
    /** 页面发请求的路由前缀，与 host 的 `REMINDER_ROUTE` 必须一致。 */
    const ROUTE = '/dsh-reminder'
    /** 渲染器本地的偏好（音色、音量），与 host 那份是同名不同物。 */
    const STORE_KEY = 'dsh.reminder.ui.v1'
    /** 长轮询挂多久；到点就返回，所以这是「最长」。 */
    const POLL_TIMEOUT_MS = 20000
    /** 长轮询失败后的重试间隔：连不上时不打满 CPU。 */
    const RETRY_MS = 3000

    const zh = {
      'settings.label': '提醒',
      'settings.title': '提醒',
      'settings.intro': '用一句话设置提醒：「/reminder 30m 开会」或者直接让我来设。到点会弹出提醒窗口并播放提示音——所以 DSH 需要开着。',
      'section.create': '新建提醒',
      'section.list': '提醒清单',
      'section.sound': '提示音',
      'field.title': '提醒内容',
      'field.titleHint': '例如「开会」「该吃药了」',
      'field.note': '备注',
      'field.when': '时间',
      'field.whenHint': '30=30 分钟后；也可以写 30m、19:30、明天 8:00、2026-09-28 07:30',
      'field.repeat': '重复',
      'field.repeatOnce': '只响一次',
      'field.repeatDaily': '每天同一时刻',
      'field.sound': '音色',
      'field.volume': '音量',
      'field.times': '响几声',
      'field.activateWindow': '到点把 DSH 唤到前台',
      'field.activateWindowHint': '只在 Windows 上有效；需要 DSH 主窗口还能被找到',
      'field.autoDismiss': '自动关闭（秒，0=等我确认）',
      'sound.chime': '清脆铃',
      'sound.bell': '钟声',
      'sound.beep': '短哔',
      'sound.off': '静音',
      'action.create': '添加提醒',
      'action.test': '试听',
      'action.cancel': '取消提醒',
      'action.snooze5': '再等 5 分钟',
      'action.snooze10': '再等 10 分钟',
      'action.dismiss': '知道了',
      'action.refresh': '刷新',
      'state.ready': '提醒已就绪',
      'state.connecting': '正在连接提醒服务…',
      'state.offline': '连不上提醒服务（页面还能用，但到点不会弹窗）',
      'state.noneActive': '还没有提醒。',
      'popup.title': '提醒',
      'popup.due': '到点',
      'popup.snoozed': '已推迟到',
      'error.title': '请填写提醒内容。',
      'error.when': '没能识别这个时间。'
    }
    const en = {
      'settings.label': 'Reminders',
      'settings.title': 'Reminders',
      'settings.intro':
        'Set a reminder in one line: "/reminder 30m stand-up", or just ask me. A popup and a chime appear when it is due — so DSH needs to be running.',
      'section.create': 'New reminder',
      'section.list': 'Scheduled',
      'section.sound': 'Sound',
      'field.title': 'What',
      'field.titleHint': 'e.g. "stand-up"',
      'field.note': 'Note',
      'field.when': 'When',
      'field.whenHint': '30 = in 30 minutes; also 30m, 19:30, tomorrow 8:00, 2026-09-28 07:30',
      'field.repeat': 'Repeat',
      'field.repeatOnce': 'Once',
      'field.repeatDaily': 'Every day at this time',
      'field.sound': 'Tone',
      'field.volume': 'Volume',
      'field.times': 'Chimes',
      'field.activateWindow': 'Bring DSH to the front when due',
      'field.activateWindowHint': 'Windows only; needs the DSH main window to still be findable',
      'field.autoDismiss': 'Auto-close (seconds, 0 = wait for me)',
      'sound.chime': 'Chime',
      'sound.bell': 'Bell',
      'sound.beep': 'Beep',
      'sound.off': 'Silent',
      'action.create': 'Add reminder',
      'action.test': 'Preview',
      'action.cancel': 'Cancel',
      'action.snooze5': 'Snooze 5 min',
      'action.snooze10': 'Snooze 10 min',
      'action.dismiss': 'Got it',
      'action.refresh': 'Refresh',
      'state.ready': 'Reminders are live',
      'state.connecting': 'Connecting to the reminder service…',
      'state.offline': 'Cannot reach the reminder service (the page still works, but nothing will pop up)',
      'state.noneActive': 'No reminders yet.',
      'popup.title': 'Reminder',
      'popup.due': 'Due',
      'popup.snoozed': 'Snoozed to',
      'error.title': 'Give the reminder a title.',
      'error.when': 'That time could not be understood.'
    }

    const DEFAULTS = {
      sound: 'chime',
      volume: 0.6,
      repeat: 3,
      activateWindow: true,
      autoDismissSeconds: 0
    }

    /** 渲染器本地偏好：换音色不需要往返一趟 host。 */
    const store = {
      value: { ...DEFAULTS },
      listeners: new Set(),
      load() {
        try {
          const raw = globalThis.localStorage?.getItem(STORE_KEY)
          if (raw !== null && raw !== undefined) this.value = { ...DEFAULTS, ...JSON.parse(raw) }
        } catch {
          this.value = { ...DEFAULTS }
        }
        return this.value
      },
      get() {
        return this.value
      },
      set(patch) {
        this.value = { ...this.value, ...patch }
        try {
          globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(this.value))
        } catch {
          // 存不进去（隐私模式/配额满）不该让提醒功能坏掉。
        }
        for (const listener of this.listeners) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      }
    }

    function fallbackCopy(key) {
      return Object.prototype.hasOwnProperty.call(en, key) ? en[key] : key
    }
    function copyOf(props) {
      const seat = props === undefined || props === null ? undefined : props.t
      return typeof seat === 'function' ? seat : fallbackCopy
    }

    /** `HH:mm`；由 `/api/list` 的 `now` 之外的本地时间算，避免时区来回换算。 */
    function clockOf(timestamp) {
      const d = new Date(timestamp)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /** `YYYY-MM-DD HH:mm`。 */
    function stampOf(timestamp) {
      const d = new Date(timestamp)
      const pad = (value) => String(value).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /** 人话「还有多久」，与 host 的 `describeRemaining` 保持一致的口径。 */
    function remainingOf(timestamp, now) {
      const delta = timestamp - now
      if (delta <= 0) return '已到点'
      if (delta < 60000) return '不到 1 分钟'
      const minutes = Math.ceil(delta / 60000)
      if (minutes < 60) return `${minutes} 分钟后`
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      if (hours < 24) return rest === 0 ? `${hours} 小时后` : `${hours} 小时 ${rest} 分钟后`
      return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后`
    }

    // ───────────────────────────── 提示音 ─────────────────────────────

    /**
     * 现合成一段提示音并播放。
     *
     * 「静音」在**这里**返回，而不是在调用处判断：这样音量、次数、音色三者只有一个入口，
     * 少一个分支就少一个「以为静音了却还在响」的地方。
     *
     * AudioContext 可能被浏览器的自动播放策略挂起（没有用户手势之前）。`resume()` 之后
     * 再排调度是必须的：在挂起的上下文里 `start()` 出去的音会被丢掉，而用户什么也听不到、
     * 也看不到报错。真被拒绝时静默失败——提醒的可视部分照常，不该因为没声音而崩。
     *
     * @param settings - `{sound, volume, repeat}`。
     * @returns 播放是否被安排下去了。
     */
    function playChime(settings) {
      if (settings.sound === 'off' || settings.volume <= 0) return false
      const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext
      if (Ctor === undefined) return false
      try {
        // 每个 AudioContext 都是一份系统音频资源，所以复用同一个；用完不关，
        // 下次响铃还能用它——关掉再建在部分驱动上会有可听的杂音。
        context ??= new Ctor()
      } catch {
        return false
      }
      const ctx = context
      const begin = () => {
        const start = ctx.currentTime + 0.02
        const times = Math.max(1, Math.min(20, Math.round(settings.repeat) || 1))
        const gain = ctx.createGain()
        gain.connect(ctx.destination)
        // 整体包络：几次鸣响的集合，而不是每次各自一个 gain。
        const total = settings.sound === 'bell' ? 1.5 : 0.32
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(Math.min(1, settings.volume), start + 0.01)
        gain.gain.setValueAtTime(Math.min(1, settings.volume), start + times * 0.24 + total)
        gain.gain.linearRampToValueAtTime(0, start + times * 0.24 + total + 0.05)
        for (let index = 0; index < times; index += 1) {
          const at = start + index * 0.24
          if (settings.sound === 'beep') {
            beep(ctx, gain, at, 0.55)
          } else if (settings.sound === 'bell') {
            bell(ctx, gain, at, 0.5)
          } else {
            chime(ctx, gain, at, 0.6)
          }
        }
      }
      // `state` 在旧实现里是 "suspended"；`resume()` 之后才排调度。
      const ready = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve()
      Promise.resolve(ready).then(begin, () => {})
      return true
    }

    /** 清脆铃：两个八度的主音，衰减快。 */
    function chime(ctx, destination, at, peak) {
      for (const [frequency, weight] of [
        [1318.5, 1],
        [1760, 0.5]
      ]) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = frequency
        gain.gain.setValueAtTime(0, at)
        gain.gain.linearRampToValueAtTime(peak * weight, at + 0.008)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45)
        osc.connect(gain)
        gain.connect(destination)
        osc.start(at)
        osc.stop(at + 0.5)
      }
    }

    /** 钟声：基频 + 非整数倍泛音，尾巴长。 */
    function bell(ctx, destination, at, peak) {
      for (const [frequency, weight, decay] of [
        [880, 1, 1.4],
        [1320, 0.4, 1.0],
        [2640, 0.2, 0.6]
      ]) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = frequency
        gain.gain.setValueAtTime(0, at)
        gain.gain.linearRampToValueAtTime(peak * weight, at + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + decay)
        osc.connect(gain)
        gain.connect(destination)
        osc.start(at)
        osc.stop(at + decay + 0.05)
      }
    }

    /** 短哔：方波，最难被环境噪声盖住。 */
    function beep(ctx, destination, at, peak) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = 740
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(peak * 0.35, at + 0.005)
      gain.gain.setValueAtTime(peak * 0.35, at + 0.09)
      gain.gain.linearRampToValueAtTime(0, at + 0.12)
      osc.connect(gain)
      gain.connect(destination)
      osc.start(at)
      osc.stop(at + 0.14)
    }

    /** 复用的 AudioContext。 */
    let context

    // ───────────────────────────── 与 host 的往返 ─────────────────────────────

    /**
     * 调一次 host 的 API。
     *
     * 信封是 `{ ok, value }` / `{ ok: false, error }`，与 dsh-ledger、dsh-voice 同形：
     * 直接读 `value` 会把一次失败读成 `undefined`，然后页面安静地显示空列表——这个坑在
     * 这个工作区里已经踩过两次。
     *
     * @param method - 方法名。
     * @param args - 参数。
     * @param signal - 取消信号。
     * @returns 服务方法的返回值。
     */
    async function call(method, args = {}, signal) {
      const response = await fetch(`${ROUTE}/api/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args }),
        signal
      })
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined || payload.ok !== true) {
        throw new Error(String(payload?.error ?? `提醒服务返回了 ${response.status}`))
      }
      return payload.value
    }

    // ───────────────────────────── 运行时状态 ─────────────────────────────

    /**
     * 一个极小的可订阅容器。
     *
     * 没有引入任何状态库，也没有把状态塞进 React 的 useState：提醒清单要在**两个**座位
     * （浮层与设置页）之间共享，而 `shell.overlay` 与 `settings.section` 是两棵互不相邻的
     * 渲染树。一个模块级的 store 是这里最小的共享机制。
     */
    const state = {
      value: {
        /** `connecting` | `ready` | `offline`。 */
        connection: 'connecting',
        /** 当前在弹窗里的提醒（已经响过、等确认）。 */
        popups: [],
        /** 清单（含已响的循环提醒）。 */
        reminders: [],
        settings: { ...DEFAULTS },
        note: '',
        now: Date.now()
      },
      listeners: new Set(),
      get() {
        return this.value
      },
      patch(change) {
        this.value = { ...this.value, ...change }
        for (const listener of this.listeners) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      }
    }

    /** 已经展示过的提醒 id：长轮询超时重挂时用它去重，否则同一个弹窗会长出来好几个。 */
    const seen = new Set()

    /** 正在等响的弹窗，按 id 索引，便于更新而不重排。 */
    const pops = new Map()

    /** 弹窗自动关闭的定时器。 */
    const dismissTimers = new Map()

    /** 关掉一个弹窗。 */
    function closePopup(id) {
      const timer = dismissTimers.get(id)
      if (timer !== undefined) clearTimeout(timer)
      dismissTimers.delete(id)
      pops.delete(id)
      state.patch({ popups: [...pops.values()] })
      void call('dismiss', { id }).catch(() => {})
    }

    /** 自动关闭（偏好为 0 时是「一直等确认」）。 */
    function armAutoDismiss(reminder) {
      const seconds = Number(store.get().autoDismissSeconds)
      if (!Number.isFinite(seconds) || seconds <= 0) return
      const timer = setTimeout(() => closePopup(reminder.id), Math.min(3600, seconds) * 1000)
      dismissTimers.set(reminder.id, timer)
    }

    /** 把一个到点的提醒放进弹窗并响铃。 */
    function show(reminder) {
      if (pops.has(reminder.id)) return
      seen.add(reminder.id)
      pops.set(reminder.id, reminder)
      state.patch({ popups: [...pops.values()] })
      playChime(store.get())
      armAutoDismiss(reminder)
    }

    /** 拉一次清单。 */
    async function refresh(signal) {
      const value = await call('list', {}, signal)
      state.patch({ reminders: value.reminders ?? [], settings: value.settings ?? state.get().settings, now: value.now ?? Date.now() })
      return value
    }

    /**
     * 长轮询循环。
     *
     * 一轮结束时**立刻**再挂一轮，而不是等下一次定时器：`/api/pending` 最多挂 20 秒，
     * 它返回空只代表这 20 秒里没有新提醒，重新挂上才能接住下一秒的。失败时退避 3 秒，
     * 连不上服务的时候不要把 CPU 打满。
     */
    async function loop(signal) {
      while (!signal.aborted) {
        try {
          const query = seen.size === 0 ? '' : `&seen=${encodeURIComponent([...seen].join(','))}`
          const response = await fetch(`${ROUTE}/api/pending?timeout=${POLL_TIMEOUT_MS}${query}`, { signal })
          const payload = await response.json()
          if (payload?.ok !== true) throw new Error(String(payload?.error ?? 'pending 失败'))
          const value = payload.value ?? {}
          state.patch({ connection: 'ready', note: '', settings: value.settings ?? state.get().settings, now: value.now ?? Date.now() })
          for (const reminder of value.reminders ?? []) show(reminder)
          // 每次拿到数据都顺手对齐清单：host 是唯一真相，页面只是它的视图。
          await refresh(signal)
        } catch (error) {
          if (signal.aborted) return
          state.patch({ connection: 'offline', note: String(error?.message ?? error) })
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
        }
      }
    }

    /** 订阅状态并在卸载时退订。 */
    function useReminders() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        return state.subscribe(() => bump((value) => value + 1))
      }, [])
      return state.get()
    }

    /** 订阅本地偏好。 */
    function useUiSettings() {
      const [, bump] = React.useState(0)
      React.useEffect(() => store.subscribe(() => bump((value) => value + 1)), [])
      return store.get()
    }

    // ───────────────────────────── 浮层：提醒弹窗 ─────────────────────────────

    /**
     * 到点的弹窗。
     *
     * 画在 `shell.overlay` 里，所以它浮在整个应用之上、不受面板切换影响。它**吃掉点击**
     * （下面那层蒙版），这是有意的：一条到点的提醒如果可以被忽略地点掉，那它和浏览器通知
     * 没有区别；这里的取舍是「必须按一下」，代价是它确实会挡住应用——所以「知道了」和
     * 「再等 5 分钟」都在第一时间可见的位置。
     */
    function ReminderOverlay(props) {
      const t = copyOf(props)
      const snapshot = useReminders()
      // Esc 关掉最上面那条：一个必须点鼠标才能消失的东西在键盘用户手里是坏的。
      React.useEffect(() => {
        if (snapshot.popups.length === 0) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          const top = snapshot.popups[snapshot.popups.length - 1]
          if (top !== undefined) closePopup(top.id)
        }
        globalThis.addEventListener?.('keydown', onKey)
        return () => globalThis.removeEventListener?.('keydown', onKey)
      }, [snapshot.popups])
      if (snapshot.popups.length === 0) return null
      return React.createElement(
        'div',
        { className: `${P}-overlay`, 'data-plugin': 'dsh-reminder', role: 'alertdialog', 'aria-label': t('popup.title') },
        React.createElement('div', { className: `${P}-scrim` }),
        React.createElement(
          'div',
          { className: `${P}-cards` },
          snapshot.popups.map((reminder) =>
            React.createElement(
              'div',
              { key: reminder.id, className: `${P}-card` },
              React.createElement(
                'div',
                { className: `${P}-cardHead` },
                React.createElement('span', { className: `${P}-bell`, 'aria-hidden': 'true' }, '⏰'),
                React.createElement('span', { className: `${P}-cardTag` }, t('popup.title')),
                React.createElement('span', { className: `${P}-cardWhen` }, `${t('popup.due')} ${clockOf(reminder.firedAt || Date.now())}`),
                reminder.repeat === 'daily' ? React.createElement('span', { className: `${P}-badge` }, '每天') : null
              ),
              React.createElement('div', { className: `${P}-cardTitle` }, reminder.title),
              reminder.note === '' ? null : React.createElement('div', { className: `${P}-cardNote` }, reminder.note),
              React.createElement(
                'div',
                { className: `${P}-cardActions` },
                React.createElement(
                  'button',
                  { type: 'button', className: `${P}-button ${P}-primary`, onClick: () => closePopup(reminder.id) },
                  t('action.dismiss')
                ),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: `${P}-button`,
                    onClick: () => {
                      closePopup(reminder.id)
                      void call('snooze', { id: reminder.id, minutes: 5 }).then(() => refresh()).catch(() => {})
                    }
                  },
                  t('action.snooze5')
                ),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: `${P}-button`,
                    onClick: () => {
                      closePopup(reminder.id)
                      void call('snooze', { id: reminder.id, minutes: 10 }).then(() => refresh()).catch(() => {})
                    }
                  },
                  t('action.snooze10')
                )
              )
            )
          )
        )
      )
    }

    // ───────────────────────────── 设置页 ─────────────────────────────

    /** 设置页里的一行。 */
    function Row(props) {
      return React.createElement(
        'div',
        { className: `${P}-row` },
        React.createElement('div', { className: `${P}-rowLabel` }, props.label),
        React.createElement('div', { className: `${P}-rowControl` }, props.children),
        props.hint === undefined ? null : React.createElement('div', { className: `${P}-rowHint` }, props.hint)
      )
    }

    /** 「提醒」设置页：新建、清单、提示音。 */
    function SettingsPage(props) {
      const t = copyOf(props)
      const snapshot = useReminders()
      const ui = useUiSettings()
      const [title, setTitle] = React.useState('')
      const [when, setWhen] = React.useState('30')
      const [repeat, setRepeat] = React.useState('once')
      const [note, setNote] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      // 打开页面时拉一次清单：长轮询只在浮层那半边跑，设置页可能先被打开。
      React.useEffect(() => {
        const controller = new AbortController()
        refresh(controller.signal).catch((error) => state.patch({ note: String(error?.message ?? error) }))
        return () => controller.abort()
      }, [])

      const submit = (event) => {
        event.preventDefault()
        if (title.trim() === '') {
          state.patch({ note: t('error.title') })
          return
        }
        setBusy(true)
        void call('create', { title: title.trim(), at: when, repeat, note: note.trim() })
          .then(() => {
            setTitle('')
            setNote('')
            state.patch({ note: '' })
            return refresh()
          })
          .catch((error) => state.patch({ note: String(error?.message ?? error) }))
          .finally(() => setBusy(false))
      }

      const active = snapshot.reminders.filter((item) => item.status !== 'dismissed')
      const now = snapshot.now ?? Date.now()

      return React.createElement(
        'div',
        { className: `${P}-page`, 'data-plugin': 'dsh-reminder' },
        React.createElement('h2', { className: `${P}-h2` }, t('settings.title')),
        React.createElement('p', { className: `${P}-intro` }, t('settings.intro')),
        // 连接状态放在最上面：「到点不弹」的第一嫌疑就是页面连不上 host，
        // 而这句话必须出现在用户唯一会看的位置。
        React.createElement(
          'div',
          { className: `${P}-status` },
          React.createElement('span', {
            className: `${P}-dot${snapshot.connection === 'ready' ? ` ${P}-dotLive` : ''}`
          }),
          React.createElement(
            'span',
            null,
            snapshot.connection === 'ready'
              ? t('state.ready')
              : snapshot.connection === 'offline'
                ? t('state.offline')
                : t('state.connecting')
          ),
          snapshot.note === '' ? null : React.createElement('span', { className: `${P}-detail` }, snapshot.note)
        ),
        // ── 新建 ──
        React.createElement('h3', { className: `${P}-h3` }, t('section.create')),
        React.createElement(
          'form',
          { className: `${P}-form`, onSubmit: submit },
          React.createElement(Row, { label: t('field.title'), hint: t('field.titleHint') },
            React.createElement('input', {
              type: 'text',
              className: `${P}-input ${P}-grow`,
              value: title,
              placeholder: t('field.titleHint'),
              onChange: (event) => setTitle(event.target.value)
            })
          ),
          React.createElement(Row, { label: t('field.when'), hint: t('field.whenHint') },
            React.createElement('input', {
              type: 'text',
              className: `${P}-input`,
              value: when,
              onChange: (event) => setWhen(event.target.value)
            })
          ),
          React.createElement(Row, { label: t('field.repeat') },
            React.createElement(
              'select',
              { className: `${P}-input`, value: repeat, onChange: (event) => setRepeat(event.target.value) },
              React.createElement('option', { value: 'once' }, t('field.repeatOnce')),
              React.createElement('option', { value: 'daily' }, t('field.repeatDaily'))
            )
          ),
          React.createElement(Row, { label: t('field.note') },
            React.createElement('input', {
              type: 'text',
              className: `${P}-input ${P}-grow`,
              value: note,
              onChange: (event) => setNote(event.target.value)
            })
          ),
          React.createElement(
            'div',
            { className: `${P}-formActions` },
            React.createElement('button', { type: 'submit', className: `${P}-button ${P}-primary`, disabled: busy }, t('action.create'))
          )
        ),
        // ── 清单 ──
        React.createElement('h3', { className: `${P}-h3` }, t('section.list')),
        active.length === 0
          ? React.createElement('p', { className: `${P}-sectionHint` }, t('state.noneActive'))
          : React.createElement(
              'div',
              { className: `${P}-list` },
              active.map((reminder) =>
                React.createElement(
                  'div',
                  { key: reminder.id, className: `${P}-item${reminder.status === 'fired' ? ` ${P}-itemFired` : ''}` },
                  React.createElement(
                    'div',
                    { className: `${P}-itemMain` },
                    React.createElement(
                      'div',
                      { className: `${P}-itemTitle` },
                      reminder.title,
                      reminder.repeat === 'daily' ? React.createElement('span', { className: `${P}-badge` }, '每天') : null,
                      reminder.status === 'fired' ? React.createElement('span', { className: `${P}-badge ${P}-badgeFired` }, '已响') : null
                    ),
                    React.createElement(
                      'div',
                      { className: `${P}-itemMeta` },
                      `${stampOf(reminder.scheduledAt)} · ${remainingOf(reminder.scheduledAt, now)}`,
                      reminder.note === '' ? '' : ` · ${reminder.note}`
                    )
                  ),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: `${P}-button`,
                      onClick: () => {
                        void call('cancel', { id: reminder.id })
                          .then(() => refresh())
                          .catch((error) => state.patch({ note: String(error?.message ?? error) }))
                      }
                    },
                    t('action.cancel')
                  )
                )
              )
            ),
        // ── 提示音 ──
        React.createElement('h3', { className: `${P}-h3` }, t('section.sound')),
        React.createElement(Row, { label: t('field.sound') },
          React.createElement(
            'div',
            { className: `${P}-rowInline` },
            React.createElement(
              'select',
              {
                className: `${P}-input`,
                value: ui.sound,
                onChange: (event) => {
                  store.set({ sound: event.target.value })
                  // 换音色顺手响一下：这是唯一能确认「它到底什么声」的方式。
                  if (event.target.value !== 'off') playChime(store.get())
                }
              },
              React.createElement('option', { value: 'chime' }, t('sound.chime')),
              React.createElement('option', { value: 'bell' }, t('sound.bell')),
              React.createElement('option', { value: 'beep' }, t('sound.beep')),
              React.createElement('option', { value: 'off' }, t('sound.off'))
            ),
            React.createElement(
              'button',
              { type: 'button', className: `${P}-button`, onClick: () => playChime(store.get()) },
              t('action.test')
            )
          )
        ),
        React.createElement(Row, { label: `${t('field.volume')} · ${Math.round(ui.volume * 100)}%` },
          React.createElement('input', {
            type: 'range',
            min: 0,
            max: 1,
            step: 0.05,
            value: ui.volume,
            onChange: (event) => store.set({ volume: Number(event.target.value) })
          })
        ),
        React.createElement(Row, { label: t('field.times') },
          React.createElement('input', {
            type: 'number',
            className: `${P}-input ${P}-inputNarrow`,
            min: 1,
            max: 20,
            step: 1,
            value: ui.repeat,
            onChange: (event) => store.set({ repeat: Math.min(20, Math.max(1, Number(event.target.value) || 1)) })
          })
        ),
        React.createElement(Row, { label: t('field.autoDismiss') },
          React.createElement('input', {
            type: 'number',
            className: `${P}-input ${P}-inputNarrow`,
            min: 0,
            max: 3600,
            step: 5,
            value: ui.autoDismissSeconds,
            onChange: (event) => store.set({ autoDismissSeconds: Math.max(0, Number(event.target.value) || 0) })
          })
        ),
        React.createElement(Row, { label: t('field.activateWindow'), hint: t('field.activateWindowHint') },
          React.createElement('input', {
            type: 'checkbox',
            checked: ui.activateWindow,
            onChange: (event) => {
              store.set({ activateWindow: event.target.checked })
              // host 才知道窗口能不能唤，所以这条偏好要回写一份；写失败不影响页面。
              void call('settings', { activateWindow: event.target.checked }).catch(() => {})
            }
          })
        )
      )
    }

    // ───────────────────────────── 样式 ─────────────────────────────

    const css = `
.${P}-overlay{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center}
.${P}-scrim{position:absolute;inset:0;background:rgba(2,6,23,.42);backdrop-filter:blur(2px)}
.${P}-cards{position:relative;display:flex;flex-direction:column;gap:12px;max-height:80vh;overflow:auto;padding:4px}
.${P}-card{box-sizing:border-box;width:min(420px,86vw);padding:18px 20px 16px;border-radius:16px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 24px 60px rgba(2,6,23,.45);animation:${P}-pop .22s ease-out}
@keyframes ${P}-pop{from{transform:translateY(-10px) scale(.97);opacity:0}to{transform:none;opacity:1}}
.${P}-cardHead{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.5px;color:var(--dsw-alias-label-secondary)}
.${P}-bell{font-size:16px;line-height:1}
.${P}-cardTag{font-weight:600;color:var(--dsw-alias-brand-primary)}
.${P}-cardWhen{margin-left:auto}
.${P}-cardTitle{margin:10px 0 4px;font-size:19px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary);word-break:break-word}
.${P}-cardNote{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.${P}-cardActions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.${P}-badge{margin-left:8px;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:400;line-height:16px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.${P}-badgeFired{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.${P}-page{display:flex;flex-direction:column;gap:2px;padding:4px 0 24px;max-width:760px}
.${P}-h2{margin:0 0 4px;font-size:16px;font-weight:600}
.${P}-h3{margin:18px 0 2px;padding-top:14px;font-size:13px;font-weight:600;border-top:1px solid var(--dsw-alias-border-l1)}
.${P}-h3:first-of-type{border-top:0;padding-top:0;margin-top:8px}
.${P}-intro{margin:0 0 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${P}-sectionHint{margin:0 0 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${P}-status{display:flex;align-items:center;gap:8px;padding:8px 12px;margin-bottom:10px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1)}
.${P}-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-secondary);flex:none;opacity:.5}
.${P}-dotLive{background:var(--dsw-alias-state-success-primary);opacity:1}
.${P}-detail{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}-form{display:flex;flex-direction:column}
.${P}-row{display:grid;grid-template-columns:190px 1fr;gap:6px 12px;align-items:center;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.${P}-rowLabel{font-size:13px}
.${P}-rowControl{display:flex;align-items:center;gap:8px;min-width:0}
.${P}-rowInline{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.${P}-rowHint{grid-column:2;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.${P}-formActions{display:flex;justify-content:flex-end;padding:12px 0 0}
.${P}-input{box-sizing:border-box;height:30px;padding:0 8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);min-width:0}
.${P}-inputNarrow{width:110px}
.${P}-grow{flex:1;min-width:180px}
.${P}-button{box-sizing:border-box;height:30px;padding:0 12px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);cursor:pointer;white-space:nowrap}
.${P}-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.${P}-button:disabled{opacity:.45;cursor:default}
.${P}-primary{color:var(--dsw-alias-label-primary-inverted,var(--dsw-alias-bg-base));background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.${P}-primary:hover:not(:disabled){filter:brightness(1.08);background:var(--dsw-alias-brand-primary)}
.${P}-list{display:flex;flex-direction:column}
.${P}-item{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.${P}-itemMain{flex:1;min-width:0}
.${P}-itemTitle{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);word-break:break-word}
.${P}-itemFired .${P}-itemTitle{color:var(--dsw-alias-brand-primary)}
.${P}-itemMeta{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);word-break:break-word}
`

    /** 插样式；返回移除函数，交给 `ctx.effect`。 */
    function insertStyles() {
      const element = document.createElement('style')
      element.setAttribute('data-plugin', 'dsh-reminder')
      element.setAttribute('data-plugin-css', 'dsh-reminder/reminder.css')
      element.textContent = css
      document.head.append(element)
      return () => {
        element.remove()
      }
    }

    /**
     * 激活这个插件。
     *
     * 注册的东西全部包在 `ctx.effect` 里，所以插件卸载（或 Profile 换掉这一行）时
     * 定时器、监听器、样式都会跟着走，不会留下一份还在发请求的幽灵页面。
     *
     * @param ctx - Client 根上下文。
     */
    function apply(ctx) {
      store.load()
      ctx.effect(() => insertStyles(), 'dsh-reminder: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-reminder: copy')

      // 长轮询是整个页面「听得到提醒」的唯一来源，所以它跟着上下文一起活。
      ctx.effect(() => {
        const controller = new AbortController()
        void loop(controller.signal)
        return () => controller.abort()
      }, 'dsh-reminder: pending loop')

      // 窗口重新可见时立刻对齐一次：后台标签页里的定时器会被浏览器节流，
      // 切回来时不该还等着那 20 秒。
      ctx.effect(() => {
        const onVisible = () => {
          if (document.visibilityState === 'visible') void refresh().catch(() => {})
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
      }, 'dsh-reminder: visibility')

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'reminder', order: 40, locale: NS }, ReminderOverlay)
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'reminder',
            order: 30,
            locale: NS,
            label: () => ctx.locale.bind(NS)('settings.label')
          },
          SettingsPage
        )
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  }
})

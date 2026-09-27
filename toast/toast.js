'use strict'

/**
 * 提醒小窗的页面逻辑。
 *
 * 与 `D:\codex_data\electron_demo\reminder-toast.js` 的血缘关系写清楚：卡片结构、配色、
 * 三音提示音都是照搬那个窗口的，改动的只有三处，每处都对应一个「独立进程」与「应用内窗口」
 * 的区别：
 *
 *   1. **不再有「常驻」概念**。那个窗口是应用的一部分，一直开着、攒着卡片；这里的进程是
 *      为一次提醒而生的，所以 `once` 模式下响完就走，不需要 hide 之类的 IPC。
 *   2. **内容高度决定窗口高度**。尺寸交给主进程按 `document.body.scrollHeight` 调，
 *      否则一块 380×560 的透明窗口会把右下角整片鼠标事件都吃掉。
 *   3. **收尾交给主进程**。`ack` 只负责把卡片移掉，什么时候退出进程由 CLI 决定，
 *      因为「还有没有活着的卡片」只有页面知道，而退出必须有唯一权威。
 *
 * 提示音与那个窗口逐参数一致（三音正弦 880 / 1174.66 / 1567.98，每音间隔 120ms，
 * 峰值 0.12、衰减 0.5s），所以耳朵听到的是同一个声音。
 */

;(() => {
  const listEl = document.getElementById('reminder-toast-list')
  const items = new Map() // id -> { el, ids, timer }

  /** 主题：payload.theme 为 'dark' 时是深色（默认），否则浅色。 */
  function applyTheme(payload) {
    document.body.classList.toggle('light', (payload && payload.theme) !== 'dark')
  }

  /**
   * 三音提示音——与 electron_demo 的 `playChime()` 参数完全相同。
   *
   * 合成而不是播放音频文件：那个项目里也没有任何提醒音文件，声音就是这几个正弦波。
   * `--autoplay-policy=no-user-gesture-required` 由 CLI 传入，所以这里不必等用户手势。
   */
  function playChime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return false
      const ctx = new Ctx()
      const now = ctx.currentTime
      const notes = [880, 1174.66, 1567.98]
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        const t = now + i * 0.12
        gain.gain.setValueAtTime(0, t)
        gain.gain.linearRampToValueAtTime(0.12, t + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5)
        osc.connect(gain).connect(ctx.destination)
        osc.start(t)
        osc.stop(t + 0.55)
      })
      return true
    } catch (err) {
      // 音效失败不影响弹窗——但要让主进程知道，日志里才查得到。
      window.toastAPI.report('chime-failed ' + String(err && err.message))
      return false
    }
  }

  /** 朗读提醒内容（`sound: 'tts'`）。 */
  function speak(text) {
    try {
      if (!('speechSynthesis' in window)) return false
      const u = new SpeechSynthesisUtterance(String(text || '提醒'))
      u.lang = 'zh-CN'
      u.rate = 1
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(u)
      return true
    } catch (err) {
      return false
    }
  }

  /**
   * 按 payload 决定怎么发声。
   *
   * 与 electron_demo 的优先级一致：语音文件 > TTS > 三音提示音。这里的 `sound` 由 DSH 的
   * 偏好映射而来（`chime` → default 三音，`tts` → 朗读，`off` → 什么都不放）。
   */
  function playSound(payload) {
    const sound = String((payload && payload.sound) || 'default')
    if (sound === 'off') return
    if (payload && payload.voiceFile) {
      try {
        const audio = new Audio('file:///' + String(payload.voiceFile).replace(/\\/g, '/').replace(/^\/+/, ''))
        audio.onerror = () => playChime()
        audio.oncanplay = () => {
          audio.play().catch(() => playChime())
        }
        audio.load()
        return
      } catch (err) {
        // 落到提示音
      }
    }
    if (sound === 'tts' && speak(payload && payload.label)) return
    playChime()
  }

  /**
   * 内容需要多高。
   *
   * 取三个量的最大值，而不是只看 `body.scrollHeight`：
   *   · `body.scrollHeight` 在 body 有 margin 或子元素溢出时才是对的；
   *   · `body.offsetHeight` 是布局盒本身；
   *   · 列表元素的 `getBoundingClientRect().bottom` 把外边距与圆角都算进去。
   * 只要有一个比窗口高，就会出现滚动条；所以宁可多给几个像素也不要少给。
   */
  function contentHeight() {
    try {
      const list = document.getElementById('reminder-toast-list')
      const rect = list ? list.getBoundingClientRect().bottom : 0
      return Math.ceil(Math.max(document.body.scrollHeight, document.body.offsetHeight, rect))
    } catch (err) {
      return 0
    }
  }

  /** 通知主进程重新量高度。内容变了就要量，否则窗口要么裁掉卡片要么留一片透明死区。 */
  function resize() {
    const height = contentHeight()
    if (height <= 0) return
    try {
      window.toastAPI.resize(height)
    } catch (err) {
      /* 忽略 */
    }
  }

  /** 移掉一张卡片；空了就告诉主进程「可以收了」。 */
  function removeItem(id) {
    const key = String(id)
    const item = items.get(key)
    if (!item) return
    if (item.timer) clearTimeout(item.timer)
    item.el.remove()
    items.delete(key)
    resize()
    if (items.size === 0) {
      try {
        window.toastAPI.empty()
      } catch (err) {
        /* 忽略 */
      }
    }
  }

  /** 更新卡片上的时间（同一条提醒再次触发时不重复弹卡）。 */
  function updateCard(el, payload) {
    const timeEl = el.querySelector('.rt-time')
    if (!timeEl) return
    const t = String((payload && payload.time) || '')
    const cur = timeEl.textContent || ''
    if (t && !cur.includes(t)) timeEl.textContent = cur ? `${cur}、${t}` : t
    const noteEl = el.querySelector('.rt-note')
    if (noteEl && payload && payload.note) noteEl.textContent = String(payload.note)
  }

  /**
   * 建一张卡片。
   *
   * `snoozeLabel` 存在时多一个「稍后」按钮：它让主进程再开一个进程、把这条提醒往后推。
   * 这是插件比原窗口多出来的一点点——原窗口的推迟在应用里做，这里没有应用层可用。
   */
  function createCard(id, payload) {
    const item = document.createElement('div')
    item.className = 'rt-item'
    item.dataset.id = id

    const head = document.createElement('div')
    head.className = 'rt-head'
    const dot = document.createElement('span')
    dot.className = 'rt-dot'
    const time = document.createElement('span')
    time.className = 'rt-time'
    time.textContent = String(payload.time || '')
    head.append(dot, time)
    if (payload.rule) {
      const rule = document.createElement('span')
      rule.className = 'rt-rule'
      rule.textContent = String(payload.rule)
      head.append(rule)
    }

    const label = document.createElement('div')
    label.className = 'rt-label'
    const labelName = document.createElement('span')
    labelName.className = 'rt-label-name'
    labelName.textContent = payload.label || '提醒'
    const countEl = document.createElement('span')
    countEl.className = 'rt-count'
    countEl.dataset.count = '1'
    countEl.textContent = '×1'
    countEl.hidden = true
    label.append(labelName, countEl)

    if (payload.note) {
      const note = document.createElement('div')
      note.className = 'rt-note'
      note.textContent = String(payload.note)
      item.append(head, label, note)
    } else {
      item.append(head, label)
    }

    const foot = document.createElement('div')
    foot.className = 'rt-foot'
    const meta = document.createElement('span')
    meta.className = 'rt-meta'
    meta.textContent = payload.requireAck ? '请点击「收到」确认' : '提醒'

    const actions = document.createElement('div')
    actions.className = 'rt-actions'

    // 「稍后 N 分钟」：不是每次都出现，只有 payload.snoozeMinutes 给了才有意义
    // （给 0 或省略就不显示）。
    const snoozeMinutes = Number(payload.snoozeMinutes)
    if (Number.isFinite(snoozeMinutes) && snoozeMinutes > 0) {
      const snoozeBtn = document.createElement('button')
      snoozeBtn.type = 'button'
      snoozeBtn.className = 'rt-ghost'
      snoozeBtn.textContent = `稍后 ${snoozeMinutes} 分钟`
      snoozeBtn.addEventListener('click', () => {
        snoozeBtn.disabled = true
        try {
          window.toastAPI.snooze(snoozeMinutes)
        } catch (err) {
          /* 忽略 */
        }
      })
      actions.append(snoozeBtn)
    }

    const ackBtn = document.createElement('button')
    ackBtn.type = 'button'
    ackBtn.className = 'rt-ack'
    ackBtn.textContent = '收到'
    ackBtn.addEventListener('click', () => {
      ackBtn.disabled = true
      removeItem(id)
    })
    actions.append(ackBtn)

    foot.append(meta, actions)
    item.append(foot)
    listEl.appendChild(item)

    // `ttlSeconds` > 0 时自动消失；`requireAck` 只影响卡片上那行提示文字。
    const ttl = Number(payload.ttlSeconds)
    const timer = Number.isFinite(ttl) && ttl > 0 ? setTimeout(() => removeItem(id), ttl * 1000) : null
    items.set(String(id), { el: item, timer, ids: [String(id)] })
    resize()
  }

  /** 收到一条提醒：先响，再决定是合并到已有卡片还是新建。 */
  function addItem(payload) {
    const id = String((payload && payload.id) || '')
    const name = String((payload && payload.label) || '提醒')
    if (!id) return
    applyTheme(payload)
    playSound(payload)

    if (items.has(id)) {
      updateCard(items.get(id).el, payload)
      return
    }
    // 同名的合并成一张卡，避免右下角堆成一摞（与 electron_demo 的行为一致）。
    for (const entry of items.values()) {
      const nameEl = entry.el.querySelector('.rt-label-name')
      if (nameEl && nameEl.textContent === name) {
        updateCard(entry.el, payload)
        entry.ids.push(id)
        const countEl = entry.el.querySelector('.rt-count')
        if (countEl) {
          const n = (Number(countEl.dataset.count) || 1) + 1
          countEl.dataset.count = String(n)
          countEl.textContent = `×${n}`
          countEl.hidden = false
        }
        return
      }
    }
    createCard(id, payload)
  }

  window.toastAPI.onAdd(addItem)
  // 页面就绪：主进程要等这一句才发数据，否则 `onAdd` 还没挂上，提醒就丢了。
  try {
    window.toastAPI.ready()
  } catch (err) {
    /* 忽略 */
  }
})()

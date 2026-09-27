/**
 * Client 半边的冒烟测试。
 *
 * Client 半边是交给 `window.__ModuleLoader__.load` 的模块，没法直接 import，所以这个
 * 夹具自己造出它真正需要的东西：一个能解析 React 的 `require`、一个假的 module loader
 * 全局、一个假的 `fetch`（扮演 host 的本机路由）、一个假的 AudioContext（记录下到底
 * 有没有响铃）。
 *
 * 覆盖的是**眼睛看不过来的那些**：模块能不能加载、两个座位注册得对不对、apply 期间
 * 有没有发请求、到点的提醒有没有真的变成弹窗、按钮有没有打到 host、设置页能不能渲染
 * 并且把参数按 host 的约定发出去。视觉细节（间距、字体）不在覆盖范围内。
 *
 * 跑法：node smoke/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 解析一个测试夹具（React / jsdom）。
 *
 * 它们是测试夹具，不是插件的依赖，所以刻意放在 `smoke/` 自己的 node_modules 里：
 * DSH 是就地加载这个包的，把一份测试用的 React 放进它的依赖里，等于把别人的框架
 * 塞到被加载的路径上。
 *
 * @param specifier - 裸包名。
 * @returns 绝对 file URL。
 */
function fixture(specifier) {
  const roots = [`${here}/package.json`, `${here}/../package.json`]
  const tried = []
  for (const root of roots) {
    try {
      return pathToFileURL(createRequire(root).resolve(specifier)).href
    } catch (error) {
      tried.push(`${root}: ${error.code ?? error.message}`)
    }
  }
  throw new Error(`smoke: 找不到夹具 ${specifier}。先在 smoke/ 里 pnpm install。试过：\n  ${tried.join('\n  ')}`)
}

const React = (await import(fixture('react'))).default
const { renderToStaticMarkup } = await import(fixture('react-dom/server'))
const { JSDOM } = await import(fixture('jsdom'))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let passed = 0
const failures = []

/**
 * 断言一条。
 * @param label - 断言的内容。
 * @param condition - 结果。
 * @param detail - 失败时打印的上下文。
 */
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok  ${label}`)
    return
  }
  failures.push(label)
  console.error(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 等一段真实时间；用于让长轮询与 effect 跑起来。 */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('[smoke] dsh-reminder client half')

// ───────────────────────────── module loader ─────────────────────────────

const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf-8')

/** `load(...)` 被塞了什么；浏览器里它会被执行，这里只捕获。 */
let loaded
const styleElements = []

const fakeDocument = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
  createElement() {
    return { setAttribute() {}, textContent: '', remove() {} }
  },
  head: {
    append(element) {
      styleElements.push(element)
    }
  }
}

/** 一个最小的 localStorage：`store.load()` 会读它，插件不能因为它在 Node 里缺席而崩。 */
const fakeStorage = new Map()
const fakeLocalStorage = {
  getItem: (key) => (fakeStorage.has(key) ? fakeStorage.get(key) : null),
  setItem: (key, value) => fakeStorage.set(key, String(value)),
  removeItem: (key) => fakeStorage.delete(key)
}

const fakeWindow = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    }
  },
  localStorage: fakeLocalStorage,
  addEventListener() {},
  removeEventListener() {}
}

globalThis.window = fakeWindow
globalThis.document = fakeDocument
globalThis.localStorage = fakeLocalStorage
// 页面浮层默认是**关闭**的（到点改由右下角的独立小窗负责），所以这里先把偏好种成
// 「浮层打开」，才能验证浮层那条链路本身；关闭时的行为在设置页那一段单独验。
fakeLocalStorage.setItem(
  'dsh.reminder.ui.v1',
  JSON.stringify({ sound: 'chime', volume: 0.6, repeat: 3, activateWindow: true, toastWindow: true, pageOverlay: true })
)

let evaluateError = null
try {
  // eslint-disable-next-line no-eval -- 模块写成了脚本，不是 ESM。
  eval(source)
} catch (error) {
  evaluateError = error
}
check('module: 求值不抛错', evaluateError === null, String(evaluateError))
check('module: 注册的 id 是 dsh-reminder', loaded?.id === 'dsh-reminder', String(loaded?.id))

const plugin = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
check('plugin: 导出了 apply', typeof plugin.apply === 'function')
check(
  'plugin: inject 只声明 slots 与 locale',
  JSON.stringify(plugin.inject) === JSON.stringify(['slots', 'locale']),
  JSON.stringify(plugin.inject)
)

// ───────────────────────────── 假的 host 与音频 ─────────────────────────────

/** 页面发出的每个请求：`{ method, args, path }`。 */
const calls = []

/** 挂住没回答的长轮询，测试可以随后 resolve 它们。 */
const pendingPolls = []

/** 下一次长轮询要返回的提醒；一次消费一张队列。 */
const pollQueue = []

/** 已经播放的提示音：每次响铃时当时的偏好。 */
const played = []

/** 音频活动的探针：假 AudioContext 把每次「被创建」和每次「振荡器 start」记在这里。 */
const audioActivity = { contexts: 0, starts: 0 }

/** 一个够用的 AudioContext 替身：只记录被创建与何时 start。 */
class FakeAudioContext {
  constructor() {
    audioActivity.contexts += 1
    this.state = 'running'
    this.currentTime = 0
    this.destination = {}
  }
  resume() {
    this.state = 'running'
    return Promise.resolve()
  }
  createGain() {
    return {
      gain: {
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {}
      },
      connect() {}
    }
  }
  createOscillator() {
    return {
      type: 'sine',
      frequency: { value: 0 },
      connect() {},
      start() {
        audioActivity.starts += 1
      },
      stop() {}
    }
  }
}

globalThis.AudioContext = FakeAudioContext

/**
 * 装上假的 fetch。
 *
 * 模仿 host 的信封：`{ ok: true, value }` / `{ ok: false, error }`。长轮询默认**挂住**，
 * 由测试决定什么时候给答案——「到点就弹」这件事只有在这种时序下才测得出来。
 */
const RESPONSES = {}

globalThis.fetch = (url, options) => {
  const parsed = new URL(String(url), 'http://127.0.0.1')
  const path = parsed.pathname.replace('/dsh-reminder/api', '')
  const body = options?.body === undefined ? undefined : JSON.parse(options.body)
  if (body !== undefined) calls.push({ path, method: body.method, args: body.args })
  if (path === '/pending') {
    const queued = pollQueue.shift()
    if (queued !== undefined) {
      return Promise.resolve({
        ok: true,
        status: 200,
        async json() {
          return { ok: true, value: { reminders: [queued], settings: {}, now: Date.now() } }
        }
      })
    }
    return new Promise((resolve) => {
      pendingPolls.push({ resolve, seen: parsed.searchParams.get('seen') ?? '' })
    })
  }
  const answer = RESPONSES[body?.method]
  if (answer === undefined) {
    return Promise.resolve({
      ok: false,
      status: 400,
      async json() {
        return { ok: false, error: `未知方法 ${body?.method}` }
      }
    })
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    async json() {
      return { ok: true, value: typeof answer === 'function' ? answer(body.args) : answer }
    }
  })
}

RESPONSES.list = () => ({ reminders: [], settings: {}, now: Date.now() })
RESPONSES.describe = () => ({ dataFile: 'C:/tmp/reminders.json', count: 0, settings: {}, now: Date.now() })
RESPONSES.dismiss = () => ({ ok: true })
RESPONSES.snooze = () => ({ reminder: { id: 'r1', scheduledAt: Date.now() + 300000 } })
RESPONSES.cancel = () => ({ removed: true })
RESPONSES.create = () => ({ reminder: { id: 'r9', title: '开会', scheduledAt: Date.now() + 1800000 } })

// ───────────────────────────── 启动插件 ─────────────────────────────

const registrations = []
const zhDict = {}

const fakeCtx = {
  effect(callback) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register(ns, dicts) {
      Object.assign(zhDict, dicts.zh ?? {})
      return () => {}
    },
    bind() {
      return (key, vars) =>
        String(zhDict[key] ?? key).replace(/\{(\w+)\}/g, (_match, name) => String(vars?.[name] ?? ''))
    }
  },
  slots: {
    inject(key, callback) {
      registrations.push({ key, registration: callback() })
      return () => {}
    },
    register(definition, component) {
      return { definition, component }
    }
  }
}

let applyError = null
try {
  plugin.apply(fakeCtx)
} catch (error) {
  applyError = error
}
check('apply: 不抛错', applyError === null, String(applyError))
check('apply: 插入了自己的样式表', styleElements.length === 1)
check(
  'apply: 注册了浮层与设置页两个座位',
  JSON.stringify(registrations.map((item) => item.key).sort()) === JSON.stringify(['settings.section', 'shell.overlay']),
  JSON.stringify(registrations.map((item) => item.key))
)
const settingsEntry = registrations.find((item) => item.key === 'settings.section')
check('settings: 有 label 函数', typeof settingsEntry?.registration.definition.label === 'function')
check('settings: label 解析为「提醒」', settingsEntry?.registration.definition.label() === '提醒', String(settingsEntry?.registration.definition.label()))

// apply 期间不能发请求：那时 host 路由可能还不存在，而且一次「空转的失败」会让状态栏
// 一上来就显示「连不上」。
check('http: apply 期间没有发请求', calls.length === 0, JSON.stringify(calls))
// 但长轮询必须已经挂上：它是页面听到提醒的唯一来源。
await tick(10)
check('http: 长轮询已经挂上', pendingPolls.length === 1, String(pendingPolls.length))

// ───────────────────────────── 到点 → 弹窗 → 响铃 ─────────────────────────────

const due = { id: 'r1', title: '开会', note: '带上笔记本', scheduledAt: Date.now() - 1000, firedAt: Date.now(), repeat: 'once', status: 'fired' }
pollQueue.push(due)
// 让挂住的那次长轮询返回：直接把它解掉，模拟 host「有提醒了」的唤醒。
const held = pendingPolls.shift()
held.resolve({
  ok: true,
  status: 200,
  async json() {
    return { ok: true, value: { reminders: [due], settings: {}, now: Date.now() } }
  }
})
await tick(30)

const Overlay = registrations.find((item) => item.key === 'shell.overlay').registration.component
let overlayHtml = ''
let overlayError = null
try {
  overlayHtml = renderToStaticMarkup(React.createElement(Overlay, { t: (key) => zhDict[key] ?? key }))
} catch (error) {
  overlayError = error
}
check('overlay: 渲染不抛错', overlayError === null, String(overlayError))
check('overlay: 标题出现在弹窗里', overlayHtml.includes('开会'), overlayHtml.slice(0, 200))
check('overlay: 备注出现在弹窗里', overlayHtml.includes('带上笔记本'))
check('overlay: 有「知道了」按钮', overlayHtml.includes('知道了'))
check('overlay: 有「再等 5 分钟」按钮', overlayHtml.includes('再等 5 分钟'))
check('overlay: 有 aria 语义（alertdialog）', overlayHtml.includes('alertdialog'))

// 响铃：默认偏好是「清脆铃 · 3 声」，所以到点必须真的建了 AudioContext 并 start 过振荡器。
check('sound: 到点时创建了 AudioContext', audioActivity.contexts > 0, JSON.stringify(audioActivity))
check('sound: 到点时振荡器真的 start 了', audioActivity.starts >= 3, JSON.stringify(audioActivity))

// 长轮询的第二个证据：页面把已经展示过的 id 带上去了，host 才会去重。
await tick(10)
const second = pendingPolls.shift()
check('http: 第二次长轮询带上了 seen', second?.seen.includes('r1') === true, String(second?.seen))

// ───────────────────────────── 弹窗按钮打到 host ─────────────────────────────

// 「知道了」必须真的走 UI 点击，而不是直接调内部函数：这条路径上还挂着
// `dismiss` 请求、弹窗出队和重新渲染，任一环节断了，用户看到的就是「点了没反应」。
// `url` 是必须的：jsdom 默认是 opaque origin，那种来源下没有 localStorage，
// 而页面的偏好正是存在 localStorage 里的。
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
globalThis.window = Object.assign(dom.window, {
  __ModuleLoader__: fakeWindow.__ModuleLoader__,
  AudioContext: FakeAudioContext
})
globalThis.document = dom.window.document
globalThis.localStorage = dom.window.localStorage
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })

const { createRoot } = await import(fixture('react-dom/client'))
const { act } = await import(fixture('react'))
const container = dom.window.document.createElement('div')
dom.window.document.body.append(container)
const root = createRoot(container)

let mountError = null
try {
  await act(async () => {
    root.render(React.createElement(Overlay, { t: (key) => zhDict[key] ?? key }))
  })
} catch (error) {
  mountError = error
}
check('mount: 浮层挂载不抛错', mountError === null, String(mountError))
const buttons = [...container.querySelectorAll('button')]
check('mount: 弹窗里有三个按钮', buttons.length === 3, String(buttons.length))
const dismissButton = buttons.find((button) => button.textContent.includes('知道了'))
check('mount: 找到「知道了」按钮', dismissButton !== undefined)

const beforeDismiss = calls.length
let clickError = null
try {
  await act(async () => {
    dismissButton?.click()
  })
} catch (error) {
  clickError = error
}
await tick(20)
check('mount: 点击不抛错', clickError === null, String(clickError))
check(
  'mount: 点击「知道了」打到了 host 的 dismiss',
  calls.some((item) => item.method === 'dismiss' && item.args?.id === 'r1'),
  JSON.stringify(calls.slice(beforeDismiss).map((item) => item.method))
)
const settled = container.innerHTML
check('mount: 弹窗关掉了', !settled.includes('带上笔记本'), settled.slice(0, 200))
check('http: 确实发生过请求（自检）', calls.length > beforeDismiss)

await act(async () => {
  root.unmount()
})
// ───────────────────────────── 设置页 ─────────────────────────────

const Page = registrations.find((item) => item.key === 'settings.section').registration.component
const pageContainer = dom.window.document.createElement('div')
dom.window.document.body.append(pageContainer)
const pageRoot = createRoot(pageContainer)

let pageError = null
try {
  await act(async () => {
    pageRoot.render(React.createElement(Page, { t: (key) => zhDict[key] ?? key }))
  })
} catch (error) {
  pageError = error
}
check('settings: 挂载不抛错', pageError === null, String(pageError))
const pageHtml = pageContainer.innerHTML
check('settings: 标题是「提醒」', pageHtml.includes('提醒'))
check('settings: 有新建表单', pageContainer.querySelector('form') !== null)
check('settings: 有音色选择', pageHtml.includes('清脆铃'))
check('settings: 有音量滑块', pageHtml.includes('type="range"'))
check('settings: 显示了连接状态', pageHtml.includes('提醒已就绪') || pageHtml.includes('正在连接提醒服务'))
check('settings: 空清单时说了「还没有提醒」', pageHtml.includes('还没有提醒'), pageHtml.slice(0, 300))

// 提示音的三条路径都点一遍：选音色会顺带响一声确认，静音必须**真的**没有声音。
const selectBox = (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
  setter.call(element, value)
  element.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}
const soundSelect = [...pageContainer.querySelectorAll('select')].find((element) =>
  [...element.options].some((option) => option.value === 'off')
)
const testButton = [...pageContainer.querySelectorAll('button')].find((button) => button.textContent.includes('试听'))
check('settings: 找到音色选择框', soundSelect !== undefined)
check('settings: 找到试听按钮', testButton !== undefined)

const beforeMute = audioActivity.starts
await act(async () => {
  selectBox(soundSelect, 'off')
})
await act(async () => {
  testButton?.click()
})
await tick(20)
check('sound: 选到「静音」之后试听不发声', audioActivity.starts === beforeMute, `${beforeMute} → ${audioActivity.starts}`)

await act(async () => {
  selectBox(soundSelect, 'beep')
})
await tick(20)
check('sound: 换音色会顺带响一声', audioActivity.starts > beforeMute, `${beforeMute} → ${audioActivity.starts}`)

// 「到点唤窗口」这条偏好在渲染器里存一份、也要回写 host 一份：host 才是能碰窗口的那半边。
const windowToggle = [...pageContainer.querySelectorAll('input[type=checkbox]')][0]
check('settings: 有「到点唤窗口」开关', windowToggle !== undefined)
let toggleError = null
try {
  await act(async () => {
    windowToggle?.click()
  })
} catch (error) {
  toggleError = error
}
await tick(20)
check('settings: 切换开关不抛错', toggleError === null, String(toggleError))
check(
  'settings: 窗口/小窗开关回写到了 host',
  calls.some((item) => item.method === 'settings' && (item.args?.activateWindow === false || item.args?.toastWindow === false)),
  JSON.stringify(calls.filter((item) => item.method === 'settings'))
)

// 「页面浮层」关掉之后，到点的提醒**不该**再盖住 DSH：这条链路是可选的，而它默认关闭，
// 所以必须有测试守住「关了就真的不弹、也不出声」，否则双弹/双响的问题会悄悄回来。
const pageOverlayToggle = [...pageContainer.querySelectorAll('input[type=checkbox]')].at(-1)
check('settings: 有「同时在 DSH 页面里盖一层浮层」开关', pageOverlayToggle !== undefined)
const audioBeforeSuppress = audioActivity.starts
await act(async () => {
  pageOverlayToggle?.click()
})
const overdue = { id: 'suppress-1', title: '不该出现在浮层里', scheduledAt: Date.now() - 1000, firedAt: Date.now(), repeat: 'once', status: 'fired' }
// 页面的长轮询在后台还在跑（它负责清单同步），把这一轮的答案灌给它。
const waiting = pendingPolls.shift()
waiting?.resolve({
  ok: true,
  status: 200,
  async json() {
    return { ok: true, value: { reminders: [overdue], settings: {}, now: Date.now() } }
  }
})
await tick(40)
// 浮层这时候已经是空的（前面点过「知道了」），静态渲染一次确认它不会为这条新建卡片。
const suppressedHtml =
  mountError === null ? renderToStaticMarkup(React.createElement(Overlay, { t: (key) => zhDict[key] ?? key })) : ''
check('overlay: 浮层关闭时不再盖住页面', !suppressedHtml.includes('不该出现在浮层里'), suppressedHtml.slice(0, 200))
check('sound: 浮层关闭时页面也不发声（交给小窗）', audioActivity.starts === audioBeforeSuppress, `${audioBeforeSuppress} → ${audioActivity.starts}`)

// 新建一条提醒：参数名必须与 host 的 `reminderRequest` 一致（title / at / repeat）。
const titleInput = pageContainer.querySelector('input[type=text]')
const whenInput = [...pageContainer.querySelectorAll('input[type=text]')][1]
let createError = null
try {
  await act(async () => {
    const setValue = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      setter.call(element, value)
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    }
    setValue(titleInput, '喝水')
    setValue(whenInput, '45')
  })
  await act(async () => {
    pageContainer.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  })
} catch (error) {
  createError = error
}
await tick(30)
check('settings: 提交表单不抛错', createError === null, String(createError))
const created = calls.find((item) => item.method === 'create')
check('settings: 提交打到了 host 的 create', created !== undefined, JSON.stringify(calls.map((item) => item.method)))
check('settings: create 带上了标题', created?.args?.title === '喝水', JSON.stringify(created?.args))
check('settings: create 带上了时间字符串', created?.args?.at === '45', JSON.stringify(created?.args))
check('settings: create 带上了重复方式', created?.args?.repeat === 'once', JSON.stringify(created?.args))

// 循环窗口优先于「时间」：填了窗口就发 window，并且**不带** at / repeat——
// 两个都发只会让「到底按哪个」变成一个问题。
const windowInput = [...pageContainer.querySelectorAll('input[type=text]')][2]
check('settings: 有「循环窗口」输入框', windowInput !== undefined)
let windowError = null
try {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    const setText = (element, value) => {
      setter.call(element, value)
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    }
    // 标题在上一轮提交成功后已经被清空，这里必须重新填——否则表单会因为在标题上
    // 校验失败而直接返回，窗口那条分支根本走不到（第一版测试就是这么假通过的）。
    setText(titleInput, '喝水')
    setText(windowInput, '9:00-22:00')
  })
  await act(async () => {
    pageContainer.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  })
} catch (error) {
  windowError = error
}
await tick(30)
check('settings: 填窗口后提交不抛错', windowError === null, String(windowError))
const windowed = calls.filter((item) => item.method === 'create').at(-1)
check('settings: 窗口请求带上了 window', windowed?.args?.window === '9:00-22:00', JSON.stringify(windowed?.args))
check('settings: 窗口请求不带 at', windowed?.args?.at === undefined, JSON.stringify(windowed?.args))
check('settings: 窗口请求不带 repeat', windowed?.args?.repeat === undefined, JSON.stringify(windowed?.args))

await act(async () => {
  pageRoot.unmount()
})

console.log(`\n[smoke] ${passed} 通过, ${failures.length} 失败`)
if (failures.length > 0) {
  console.error('failed:', failures.join('; '))
  process.exit(1)
}
console.log('[smoke] dsh-reminder client half OK')

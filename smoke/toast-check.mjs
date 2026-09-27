/**
 * 提醒小窗的冒烟测试。
 *
 * 分两层：
 *   1. **纯逻辑**（不需要 Electron）：可执行文件探测、命令行参数、payload 整形；
 *   2. **真跑一次**（有 Electron 时）：把这个小窗应用真的拉起来，给它一条"1 秒后自动消失"
 *      的提醒，然后检查它的日志——页面加载完成、payload 已投递、到时间自动退出。
 *      渲染器的 `toast:ready` 只有真的执行了 `toast.js` 才会发出来，所以这一条同时也是
 *      "页面脚本没报错"的证据。
 *
 * 跑法：node smoke/toast-check.mjs
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TOAST_DIR,
  electronCandidates,
  pickElectron,
  spawnToast,
  sweepPayloads,
  toastArgs,
  toastEnv,
  toastPayload,
  writePayloadFile
} from '../lib/toast.js'

let passed = 0
const failures = []

/**
 * 断言一条。
 * @param label - 断言内容。
 * @param condition - 结果。
 * @param detail - 失败时的上下文。
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

/** 等一段真实时间。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('[smoke] dsh-reminder toast window')

// ───────────────────────────── 纯逻辑 ─────────────────────────────

check('探测：环境变量优先', pickElectron({ DSH_REMINDER_ELECTRON: 'C:\\fake\\electron.exe' }, (p) => p === 'C:\\fake\\electron.exe').path === 'C:\\fake\\electron.exe')
check(
  '探测：环境变量不存在时退回同机的已知安装',
  pickElectron({}, (p) => p.includes('electron_demo')).path.includes('electron_demo'),
  String(pickElectron({}, (p) => p.includes('electron_demo')).path)
)
check(
  '探测：磁盘上的候选都不存在时，兜底给 PATH 上的裸名字',
  (() => {
    const picked = pickElectron({ DSH_REMINDER_ELECTRON: 'C:\\nope\\electron.exe' }, () => false)
    return picked.path === 'electron.exe' && picked.source === 'path'
  })(),
  JSON.stringify(pickElectron({ DSH_REMINDER_ELECTRON: 'C:\\nope\\electron.exe' }, () => false))
)
check('探测：候选清单最后是 PATH 上的裸名字', electronCandidates({}).at(-1) === 'electron', String(electronCandidates({}).at(-1)))
check(
  '探测：要求显式指定时不看 PATH，此时才可能真的没有 Electron',
  (() => {
    const env = { DSH_REMINDER_ELECTRON: 'C:\\nope\\electron.exe', DSH_REMINDER_ELECTRON_ONLY: '1' }
    const picked = pickElectron(env, () => false)
    return picked.path === undefined && picked.source === 'missing' && electronCandidates(env).length === 1
  })()
)

// 这一条守的是一个只在真跑时才暴露的坑：DSH 的宿主本身就是 `ELECTRON_RUN_AS_NODE=1`
// 的 Electron 子进程，子进程会继承它，于是我们拉起的 electron.exe 又退化成纯 Node，
// `require('electron')` 只给回一个路径字符串，窗口永远不出现。
const cleaned = toastEnv({ ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', PATH: 'x', DSH_HOME: 'y' })
check('env：剥掉了 ELECTRON_RUN_AS_NODE', cleaned.ELECTRON_RUN_AS_NODE === undefined, JSON.stringify(cleaned))
check('env：剥掉了 ELECTRON_NO_ATTACH_CONSOLE', cleaned.ELECTRON_NO_ATTACH_CONSOLE === undefined)
check('env：其余变量原样保留', cleaned.PATH === 'x' && cleaned.DSH_HOME === 'y')
check('env：不改动传进来的对象', (() => {
  const env = { ELECTRON_RUN_AS_NODE: '1' }
  toastEnv(env)
  return env.ELECTRON_RUN_AS_NODE === '1'
})())

const payload = toastPayload(
  { id: 'abc', title: '开会', note: '带上笔记本', repeat: 'daily', status: 'fired' },
  { sound: 'chime', autoDismissSeconds: 0 },
  new Date(2026, 8, 27, 19, 30, 0, 0).getTime()
)
check('payload：标题与备注都在', payload.label === '开会' && payload.note === '带上笔记本', JSON.stringify(payload))
check('payload：时间是本地 HH:mm', payload.time === '19:30', payload.time)
check('payload：每天循环带上了标记', payload.rule === '每天', payload.rule)
check('payload：需要确认', payload.requireAck === true)
check('payload：偏好关闭时静音', toastPayload({ id: 'a', title: 't' }, { sound: 'off', autoDismissSeconds: 0 }).sound === 'off')
check('payload：autoDismissSeconds=0 时取最长存活', payload.ttlSeconds === 300, String(payload.ttlSeconds))
check(
  'payload：autoDismissSeconds=8 时 8 秒后消失',
  toastPayload({ id: 'a', title: 't' }, { sound: 'chime', autoDismissSeconds: 8 }).ttlSeconds === 8
)

const args = toastArgs('C:\\tmp\\payload.json')
check('args：第一个参数是小窗应用目录', args[0] === TOAST_DIR, args[0])
check('args：带上了自动播放豁免', args.includes('--autoplay-policy=no-user-gesture-required'), args.join(' '))
check('args：payload 走文件而不是命令行', args.includes('--payload-file=C:\\tmp\\payload.json'), args.join(' '))

check('payload 文件：内容可被重新解析', (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reminder-payload-'))
  try {
    const file = writePayloadFile(payload, dir)
    return JSON.parse(readFileSync(file, 'utf8')).label === '开会'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})())

// 过期回收：只靠「拉起成功后 N 秒删」不够——那个定时器是 unref 的，而调用方（宿主之外的
// 脚本）可能早在它触发之前就退出了，实测因此堆了 35 个文件。这里直接验回收逻辑。
check('payload 回收：过期的删掉、新的与别的文件留下', (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reminder-sweep-'))
  try {
    const old = join(dir, 'old.json')
    const fresh = join(dir, 'fresh.json')
    const other = join(dir, 'keep.txt')
    writeFileSync(old, '{}', 'utf8')
    writeFileSync(fresh, '{}', 'utf8')
    writeFileSync(other, 'x', 'utf8')
    const past = new Date(Date.now() - 20 * 60000)
    utimesSync(old, past, past)
    const removed = sweepPayloads(dir)
    return removed === 1 && !existsSync(old) && existsSync(fresh) && existsSync(other)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})())
check('payload 回收：目录不存在时不抛错', sweepPayloads(join(tmpdir(), `dsh-reminder-missing-${Date.now()}`)) === 0)

check('spawn：找不到 Electron 时不抛错，而是返回 reason', await (async () => {
  const result = await spawnToast({
    payload,
    env: { DSH_REMINDER_ELECTRON: 'C:\\nope\\e.exe', DSH_REMINDER_ELECTRON_ONLY: '1' },
    exists: () => false
  })
  return result.spawned === false && result.reason === 'no-electron'
})())

check('spawn：可执行文件不存在时返回原因而不是让进程崩掉', await (async () => {
  // 这一条守的是一个真实的崩溃：`spawn` 的失败是异步 error 事件，没有监听者时
  // 整个 Node 进程会被未处理的 'error' 直接带走。
  const result = await spawnToast({
    payload,
    env: { DSH_REMINDER_ELECTRON: 'C:\\definitely-not-here\\electron.exe' },
    exists: () => true
  })
  return result.spawned === false && /ENOENT|not found/i.test(String(result.reason))
})(), '没能把 spawn 失败变成一个返回值')

check('spawn：注入的 spawnFn 收到了正确参数', await (async () => {
  let seen = null
  const result = await spawnToast({
    payload,
    env: { DSH_REMINDER_ELECTRON: 'C:\\fake\\electron.exe' },
    exists: () => true,
    spawnFn: (command, argv, options) => {
      seen = { command, argv, options }
      const child = new EventEmitter()
      child.pid = 4242
      child.unref = () => {}
      child.off = () => {}
      // 真实 spawn 的 'spawn' 事件在下一个 tick 才到。
      setTimeout(() => child.emit('spawn'), 0)
      return child
    }
  })
  return (
    result.spawned === true &&
    result.pid === 4242 &&
    seen.command === 'C:\\fake\\electron.exe' &&
    seen.argv[0] === TOAST_DIR &&
    seen.options.detached === true &&
    seen.options.stdio === 'ignore'
  )
})(), '注入的 spawnFn 参数不对')

// ───────────────────────────── 真跑一次 ─────────────────────────────

const electron = pickElectron()
console.log(`      electron: ${electron.path} (${electron.source})`)

if (electron.path === undefined || !existsSync(electron.path)) {
  console.log('  --  这台机器上没找到 Electron，跳过「真跑一次」那一段')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reminder-toast-'))
  const logFile = join(dir, 'toast.log')
  const testPayload = { ...payload, ttlSeconds: 2, requireAck: false, label: '小窗冒烟测试' }
  const payloadFile = writePayloadFile(testPayload, dir)
  const child = spawn(electron.path, [...toastArgs(payloadFile), `--log=${logFile}`], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  console.log(`      已拉起 pid=${child.pid}，等它自己退出（ttl=2s）…`)

  const deadline = Date.now() + 25000
  let exited = false
  let code = null
  child.on('exit', (value) => {
    exited = true
    code = value
  })
  while (!exited && Date.now() < deadline) await sleep(200)
  // 目标就是「它自己退」；到点还没退说明自动退出没生效，这时才手动收掉。
  if (!exited) {
    console.log('  --  25 秒还没自己退出，手动结束它')
    try {
      process.kill(child.pid)
    } catch {
      /* 已经没了 */
    }
    await sleep(800)
  }

  let log = ''
  try {
    log = readFileSync(logFile, 'utf8')
  } catch (error) {
    log = `(读不到日志: ${String(error).slice(0, 80)})`
  }
  console.log('      小窗日志：')
  for (const line of log.trim().split('\n')) console.log(`        ${line}`)

  check('真跑：小窗应用加载了页面', log.includes('page loaded'), log.slice(0, 200))
  check('真跑：渲染器执行了 toast.js 并报到', log.includes('renderer ready'), log.slice(0, 300))
  check('真跑：payload 已投递进窗口', log.includes('delivered payload'), log.slice(0, 300))
  check('真跑：提示音没有失败', !log.includes('chime-failed'), log.slice(0, 300))
  // 干净的退出有两条路：卡片到时消失（ttlSeconds），或用户点「收到」后清空。
  check('真跑：干净退出（没有留下常驻窗口）', exited === true && /ttl reached|cards empty/.test(log), `exited=${exited} code=${code}`)

  if (!exited) {
    try {
      process.kill(child.pid)
    } catch {
      /* 已经没了 */
    }
  }
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n[smoke] ${passed} 通过, ${failures.length} 失败`)
if (failures.length > 0) {
  console.error('failed:', failures.join('; '))
  process.exit(1)
}
console.log('[smoke] dsh-reminder toast window OK')

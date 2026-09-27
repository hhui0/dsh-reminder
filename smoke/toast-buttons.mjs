/**
 * 卡片上两个按钮的端到端验证：**真的点一下**，看窗口会不会照预期反应。
 *
 * 为什么值得单独写：这个窗口唯一的交互就是这两个按钮，而此前所有测试验的都是「窗口会
 * 不会自己消失」——于是「按钮点了没反应」可以一路通过全部测试（实测就是这样，用户
 * 点了没反应才发现）。按钮这条链路跨了三个进程边界（渲染器 DOM → preload → 主进程），
 * 每一段断掉的表现都一样：点了没动静。
 *
 * 用的是 `--test-click`，它走的是与真人点击**完全相同**的那条路：`element.click()` →
 * 页面里挂的监听 → `toastAPI.*` → 主进程。区别只在于触发者是脚本而不是鼠标。
 *
 * 跑法：node smoke/toast-buttons.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pickElectron, toastArgs, toastEnv, writePayloadFile } from '../lib/toast.js'

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

/**
 * 拉起一个小窗、点一个按钮，然后在观察窗口末尾看它是否还活着，最后收掉它。
 *
 * 「还活着吗」必须在**观察窗口末尾**看，而不是等它退出：点「稍后」的窗口本来就要
 * 继续活着（等那次推迟的提醒），等它退出只会等到测试自己的超时，然后把
 * 「被测试杀掉」误读成「窗口退出了」——第一版就是这么假失败的。
 *
 * @param options - `label`、`ttlSeconds`、`selector`、`observeMs`。
 * @returns `{ log, alive, code }`。
 */
async function clickTest({ label, ttlSeconds = 300, selector = '.rt-ack', observeMs = 9000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reminder-buttons-'))
  const logFile = join(dir, 'toast.log')
  const payload = {
    id: `btn-${Date.now()}`,
    label,
    note: '按钮测试',
    time: '00:00',
    rule: '',
    requireAck: true,
    sound: 'off',
    theme: 'dark',
    ttlSeconds,
    snoozeMinutes: 5
  }
  const payloadFile = writePayloadFile(payload, dir)
  const electron = pickElectron()
  const child = spawn(electron.path, [...toastArgs(payloadFile), `--log=${logFile}`, `--test-click=${selector}`], {
    detached: true,
    stdio: 'ignore',
    env: toastEnv()
  })
  child.unref()

  let exited = false
  let code = null
  child.on('exit', (value) => {
    exited = true
    code = value
  })
  const deadline = Date.now() + observeMs
  while (!exited && Date.now() < deadline) await sleep(150)
  const alive = !exited
  if (alive) {
    // 收掉它：测试不该在机器上留下窗口（点「稍后」的那个会等 5 分钟才再弹一次）。
    try {
      process.kill(child.pid)
    } catch {
      /* 已经没了 */
    }
    await sleep(300)
  }
  let log = ''
  try {
    log = readFileSync(logFile, 'utf8')
  } catch {
    log = ''
  }
  rmSync(dir, { recursive: true, force: true })
  return { log, alive, code, id: payload.id }
}

const electron = pickElectron()
if (electron.path === undefined || !existsSync(electron.path)) {
  console.log('  --  这台机器上没找到 Electron，跳过按钮验证')
} else {
  // ── 「收到」：卡片消失、窗口关掉 ──
  console.log('[buttons] 点「收到」')
  const ack = await clickTest({ label: '按钮自检-收到' })
  check('ack：渲染器执行了页面脚本', ack.log.includes('renderer ready'), ack.log.slice(0, 200))
  check('ack：卡片被投递', ack.log.includes(`delivered payload id=${ack.id}`), ack.log.slice(0, 300))
  check('ack：按钮真的被点到（页面侧日志）', ack.log.includes('ack clicked'), ack.log.slice(0, 400))
  check('ack：主进程收到了「卡片已清空」', ack.log.includes('cards empty'), ack.log.slice(0, 400))
  check('ack：窗口自行退出', ack.alive === false, '点了「收到」窗口却还活着')

  // ── 「稍后 5 分钟」：窗口**不该**退出（还有一次推迟的提醒等着），卡片留着 ──
  //
  // 「卡片是否消失」这里刻意不断言：点「稍后」之后卡片留在屏幕上，表示「那条提醒还没完」，
  // 这是有意的设计（用户看得见它，也就知道 5 分钟后还会响）。
  console.log('[buttons] 点「稍后 5 分钟」')
  const snooze = await clickTest({ label: '按钮自检-稍后', selector: '.rt-ghost', ttlSeconds: 300 })
  check('snooze：按钮真的被点到（页面侧日志）', snooze.log.includes('snooze clicked minutes=5'), snooze.log.slice(0, 400))
  check('snooze：主进程记下了推迟', snooze.log.includes('snooze 5 minutes'), snooze.log.slice(0, 400))
  check('snooze：自检兜底定时器被撤掉（否则会打断这次推迟）', snooze.log.includes('fallback exit cancelled'), snooze.log.slice(0, 500))
  check('snooze：窗口没有立刻退出（推迟的提醒还在等）', snooze.alive === true, '窗口提前退出了，那次推迟的提醒也就没了')
  check('snooze：没有误报「卡片已清空」', !snooze.log.includes('cards empty'), snooze.log.slice(0, 400))

  // ── 卡片自带 ttl 时，即使不点也会自己消失 ──
  console.log('[buttons] 不点，等 ttl 自动消失')
  const auto = await clickTest({ label: '按钮自检-自动', ttlSeconds: 2, selector: '.rt-ack-does-not-exist', observeMs: 8000 })
  check('ttl：窗口到点自己退出', auto.alive === false, 'ttl 到了窗口还活着')
  check('ttl：没有误报按钮被点到', !auto.log.includes('ack clicked'), auto.log.slice(0, 300))
  check('ttl：日志记下了自动退出', /ttl reached|cards empty/.test(auto.log), auto.log.slice(0, 300))
}

console.log(`\n[buttons] ${passed} 通过, ${failures.length} 失败`)
if (failures.length > 0) {
  console.error('failed:', failures.join('; '))
  process.exit(1)
}
console.log('[buttons] 提醒小窗按钮 OK')

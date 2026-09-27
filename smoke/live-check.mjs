/**
 * 最终端到端：从**跑着的 DSH host** 建一条十几秒后的提醒，然后核对「提醒小窗」是否真的弹了。
 *
 * 它读三样东西：
 *   1. `/dsh-reminder/api/call` 返回的提醒（确认 host 收下了）；
 *   2. `reminders.json`（确认到点后那条被消费掉）；
 *   3. 小窗日志（`toastLog`，确认 Electron 真的起了、页面渲染了、payload 投递了）。
 *
 * 跑法：node smoke/live-check.mjs [seconds]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const base = process.env.DSH_URL ?? 'http://127.0.0.1:19387'
const delaySeconds = Number(process.argv[2] ?? 15)
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
const dataFile = join(home, 'reminders.json')
const toastLog = join(home, 'reminder-toast.log')

/** 等一段真实时间。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 调一次 host 的 API。
 * @param method - 方法名。
 * @param args - 参数。
 * @returns 服务返回值。
 */
async function call(method, args = {}) {
  const response = await fetch(`${base}/dsh-reminder/api/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args })
  })
  const payload = await response.json()
  if (payload?.ok !== true) throw new Error(`${method}: ${payload?.error ?? response.status}`)
  return payload.value
}

/** 读一个小文件，读不到就返回空串。 */
function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const logOffset = readText(toastLog).length
const created = await call('create', {
  title: '最终验证：提醒小窗',
  note: '从跑着的 DSH host 建的，15 秒后应当弹右下角小窗',
  after_minutes: delaySeconds / 60,
  source: 'api'
})
const reminder = created.reminder
console.log(`[live] 已建 ${reminder.id}，计划 ${new Date(reminder.scheduledAt).toLocaleTimeString()}（${delaySeconds} 秒后）`)
console.log('[live] 现在去设置页看「提醒已就绪」，然后等右下角小窗…')

const deadline = Date.now() + (delaySeconds + 25) * 1000
let consumed = false
let toastSeen = false
while (Date.now() < deadline && !(consumed && toastSeen)) {
  await sleep(1000)
  const store = readText(dataFile)
  consumed = !store.includes(reminder.id)
  const log = readText(toastLog).slice(logOffset)
  // 两种写法都认：跑着的宿主可能还是旧的那版（日志里有中文），重启后是纯 ASCII。
  toastSeen = new RegExp(`(?:delivered|已投递) payload id=${reminder.id}`).test(log)
}

const log = readText(toastLog).slice(logOffset)
console.log('\n[live] 小窗日志（本次新增部分）：')
for (const line of log.trim().split('\n')) if (line !== '') console.log(`      ${line}`)

const checks = [
  ['host 收下了这条提醒', reminder.id !== undefined],
  [`到点被消费掉（清单里不再有 ${reminder.id}）`, consumed],
  ['提醒小窗真的被拉起并投递', toastSeen],
  ['小窗页面渲染完成', /(?:page loaded|页面加载完成)/.test(log)],
  ['渲染器执行了 toast.js', /(?:renderer ready|渲染器就绪)/.test(log)],
  ['提示音没失败', !log.includes('chime-failed')]
]
let failed = 0
for (const [label, ok] of checks) {
  if (ok) console.log(`  ok  ${label}`)
  else {
    failed += 1
    console.error(`FAIL  ${label}`)
  }
}
console.log(failed === 0 ? '\n[live] 全部通过：到点确实弹了小窗' : `\n[live] ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

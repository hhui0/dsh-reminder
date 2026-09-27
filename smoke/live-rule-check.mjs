/**
 * 在**真实运行中的宿主**上验证一条规则提醒：建 → 等到点 → 确认它响了、并且排到了下一次。
 *
 * 与 `fire-twice.mjs` 的分工：那个验的是代码里的 store+scheduler；这个验的是真实宿主
 * （HTTP API + Cordis 服务 + 每秒的定时器 + 小窗），也就是用户实际会看到的那条链路。
 *
 * 它只碰自己建的那条提醒（标题带 `规则验证`），跑完就删，不会动用户已有的提醒。
 *
 * 跑法：node smoke/live-rule-check.mjs [延迟秒数，默认 20]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const base = process.env.DSH_URL ?? 'http://127.0.0.1:19387'
const delaySeconds = Number(process.argv[2] ?? 20)
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
const toastLog = join(home, 'reminder-toast.log')
const title = `规则验证-${Date.now()}`

/** 等一段真实时间。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 调一次 host 的 API。
 * @param method - 方法名。
 * @param args - 参数。
 * @returns 服务返回值；失败就抛。
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

let failed = 0
/**
 * 断言一条。
 * @param label - 断言内容。
 * @param condition - 结果。
 * @param detail - 失败时的上下文。
 */
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failed += 1
  console.error(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const toastOffset = readText(toastLog).length

// 规则写成「每分钟整点」：于是下一次命中就在一分钟之内，而且它是一条**真规则**
// （不是 `at` 那种一次性写法），走的正是这次新加的那条路。
const created = await call('create', { title, cron: '* * * * *', note: '每分钟一次，用来验证规则' })
const reminder = created.reminder
console.log(`[rule] 已建 ${reminder.id}：${reminder.rule.expression}，下一次 ${new Date(reminder.nextAt).toLocaleTimeString()}`)
check('create：规则被存下来', reminder.rule?.expression === '* * * * *', JSON.stringify(reminder.rule))
check('create：下一次在将来', reminder.nextAt > Date.now(), String(reminder.nextAt))

// 等它响至少一次。
const deadline = Date.now() + (delaySeconds + 70) * 1000
let fired = false
while (Date.now() < deadline && !fired) {
  await sleep(1000)
  const listed = await call('list')
  const row = (listed.reminders ?? []).find((item) => item.id === reminder.id)
  if (row !== undefined && row.fireCount > 0) fired = true
}
const after = (await call('list')).reminders.find((item) => item.id === reminder.id)
check('到点响了（fireCount > 0）', fired, `fireCount=${after?.fireCount}`)
check('响完还在清单里（规则提醒不该被删）', after !== undefined)
check('响完状态回到 active（否则再也不会响）', after?.status === 'active', String(after?.status))
check('下一次被排到将来', after !== undefined && after.nextAt > Date.now(), after === undefined ? 'missing' : new Date(after.nextAt).toLocaleTimeString())
// 小窗投递比「响」晚 0.3-0.4 秒（要拉一个 Electron 进程），所以这里等一会儿再断言——
// 立刻断言会变成一次竞态，表现是「同一份代码有时通过有时不通过」，最难查的那种。
const toastLine = new RegExp(`(?:delivered|已投递) payload id=${reminder.id}`)
let toastSeen = false
const toastDeadline = Date.now() + 8000
while (Date.now() < toastDeadline && !toastSeen) {
  await sleep(500)
  toastSeen = toastLine.test(readText(toastLog))
}
check('小窗被拉起（真实提醒链路）', toastSeen, '小窗日志里找不到这条 id')

// 收尾：删掉这条验证用的提醒。
const cancelled = await call('cancel', { id: reminder.id })
console.log(`[rule] 已删除验证用的提醒（removed=${cancelled.removed}）`)
const final = await call('list')
console.log(`[rule] 清单现在 ${(final.reminders ?? []).length} 条：${(final.reminders ?? []).map((item) => item.title).join('、')}`)

console.log(failed === 0 ? '\n[rule] 全部通过：真实宿主上的规则提醒会响、会排下一次' : `\n[rule] ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

/**
 * 到点投递验证：自己建一条**十几秒后**的提醒、高频盯住 `/api/pending`、事后把状态打出来。
 *
 * 两个必须说清楚的细节，它们各自骗过我一次：
 *
 *   1. `at: "10"` 按设计是「10 分钟后」（裸数字默认按分钟），不是 10 秒。要十几秒的
 *      提醒就必须用 `after_minutes: 0.25` 这种小数，或者写带单位的 `at: "15s"`。
 *   2. 页面自己挂着一条长轮询，到点后它可能**抢在**本脚本前面把提醒取走（并记进自己的
 *      已展示集合）。所以本脚本一旦拿到就立刻收工，不去和页面抢；拿不到也不能直接
 *      断定「到点没发生」——那是 `store` 文件有没有被消费来判断的。
 *
 * 跑法：node smoke/delivery-check.mjs [seconds]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const base = process.env.DSH_URL ?? 'http://127.0.0.1:19387'
const delaySeconds = Number(process.argv[2] ?? 15)
const dataFile = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'reminders.json')
  : join(homedir(), '.dsh', 'reminders.json')

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

/** 读磁盘上的清单（host 是唯一写者，这里只用来理解状态）。 */
function readStore() {
  try {
    const parsed = JSON.parse(readFileSync(dataFile, 'utf8'))
    const rows = parsed.reminders.map(
      (item) => `${item.id} status=${item.status} fireCount=${item.fireCount} at=${new Date(item.scheduledAt).toLocaleTimeString()}`
    )
    return rows.length === 0 ? '(空)' : rows.join(' | ')
  } catch (error) {
    return `读取失败: ${String(error).slice(0, 80)}`
  }
}

console.log(`[delivery] 清单文件：${dataFile}`)
console.log(`[delivery] 建前：${readStore()}`)

const created = await call('create', { title: '投递验证', after_minutes: delaySeconds / 60, source: 'api' })
const reminder = created.reminder
console.log(
  `[delivery] 已建 ${reminder.id}，计划 ${new Date(reminder.scheduledAt).toLocaleTimeString()}（${delaySeconds} 秒后）`
)

const started = Date.now()
const deadline = started + (delaySeconds + 20) * 1000
let rounds = 0
let got = 0
while (Date.now() < deadline) {
  rounds += 1
  try {
    const response = await fetch(`${base}/dsh-reminder/api/pending?timeout=250`)
    const payload = await response.json()
    const items = payload?.value?.reminders ?? []
    if (items.length > 0) {
      got += 1
      console.log(`[delivery] t+${((Date.now() - started) / 1000).toFixed(1)}s 从 /api/pending 拿到：`)
      for (const item of items) {
        console.log(
          `           id=${item.id} title=${item.title} status=${item.status} firedAt=${new Date(item.firedAt).toLocaleTimeString()}`
        )
      }
      break
    }
  } catch (error) {
    console.log(`[delivery] pending 出错：${String(error).slice(0, 120)}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
}

const after = await call('describe')
console.log(`[delivery] ${rounds} 次轮询；describe：count=${after.count} active=${after.active}`)
console.log(`[delivery] 磁盘：${readStore()}`)
console.log(
  `[delivery] 结论：${
    got > 0
      ? '到点事件被发布到 /api/pending 上了'
      : '本脚本没有抢到（页面可能先取走了）；请看磁盘上那条提醒是否已被消费'
  }`
)
process.exit(0)

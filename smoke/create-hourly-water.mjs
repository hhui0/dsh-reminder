/**
 * 建「早上 9 点到晚上 10 点，每小时提醒喝水」。
 *
 * 为什么是 14 条而不是 1 条：提醒插件目前支持 `once` / `daily` / `every N 分钟`，
 * 没有「9:00-22:00 窗口内每小时」这种规则。用 daily 铺 14 条是现成能力能做到的，
 * 缺点是清单会长一点（小窗会把同名卡片合并成一张 ×N，所以视觉上不会堆 14 张）。
 *
 * 一个必须处理的细节：`create` 只接受**将来**的时刻，而 `at: "9:00"` 的语义是
 * 「今天 9 点，已经过了就顺延到明天」。所以在当前时刻之前的那些整点，必须显式写出
 * 明天的日期，否则会被拒绝。
 *
 * 跑法：node smoke/create-hourly-water.mjs [起] [止] [标题]
 */
const base = process.env.DSH_URL ?? 'http://127.0.0.1:19387'
const from = Number(process.argv[2] ?? 9)
const to = Number(process.argv[3] ?? 22)
const title = process.argv[4] ?? '喝水'

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

/** 本地 `YYYY-MM-DD`。 */
function dayString(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const now = new Date()
console.log(`[water] 现在 ${dayString(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`)

// 先看看清单里有没有同名的，避免重复跑这个脚本铺出两套。
const existing = await call('list')
const already = (existing.reminders ?? []).filter((item) => item.title === title && item.repeat === 'daily')
if (already.length > 0) {
  console.log(`[water] 清单里已经有 ${already.length} 条每天的「${title}」，不再重复创建：`)
  for (const item of already) console.log(`         ${item.id} ${new Date(item.scheduledAt).toLocaleString()}`)
  process.exit(0)
}

const created = []
for (let hour = from; hour <= to; hour += 1) {
  const clock = `${String(hour).padStart(2, '0')}:00`
  // 只对「今天已经过去」的整点补日期；其余交给 `HH:mm` 的顺延逻辑，明天以后照样按钟点响。
  const at = hour > now.getHours() ? clock : `${dayString(new Date(now.getTime() + 86400000))} ${clock}`
  try {
    const value = await call('create', { title, note: `${from}:00-${to}:00 每小时`, at, repeat: 'daily', source: 'api' })
    created.push(value.reminder)
    console.log(`[water] + ${clock} → ${new Date(value.reminder.scheduledAt).toLocaleString()}  (${value.reminder.id})`)
  } catch (error) {
    console.error(`[water] ! ${clock} 创建失败：${String(error.message ?? error)}`)
  }
}

console.log(`\n[water] 共创建 ${created.length} 条（${from}:00 - ${to}:00，每天）`)
const listed = await call('list')
console.log(`[water] 当前清单总数：${(listed.reminders ?? []).length}`)

/**
 * 把「9:00-22:00 每小时喝水」从「14 条 daily」换成「1 条规则提醒」。
 *
 * 两条路都能用，区别在维护成本：14 条 daily 改一次要改 14 处；一条 `cron: "0 9-22 * * *"`
 * 只有一个地方要看。这个脚本负责**干净地换**：先建新的（确认成功），再删旧的。
 * 先建后删是刻意的——反过来的话，中间任何一步失败都会让用户失去提醒。
 *
 * 跑法：node smoke/replace-hourly-water.mjs [标题] [起] [止]
 */
const base = process.env.DSH_URL ?? 'http://127.0.0.1:19387'
const title = process.argv[2] ?? '喝水'
const from = Number(process.argv[3] ?? 9)
const to = Number(process.argv[4] ?? 22)
const window = `${from}:00-${to}:00`

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

/** 本地 `HH:mm`。 */
const clock = (stamp) => new Date(stamp).toTimeString().slice(0, 5)

const before = await call('list')
const old = (before.reminders ?? []).filter((item) => item.title === title && item.rule === undefined && item.repeat === 'daily')
console.log(`[swap] 现在有 ${old.length} 条 daily 的「${title}」${old.length > 0 ? `：${old.map((item) => clock(item.scheduledAt)).join(' ')}` : ''}`)

// 已经是一条规则提醒的话就不重复建。
const existingRule = (before.reminders ?? []).find((item) => item.title === title && item.rule !== undefined)
let created = existingRule
if (existingRule !== undefined) {
  console.log(`[swap] 已经有一条规则提醒 ${existingRule.id}：${existingRule.rule.expression}`)
} else {
  const value = await call('create', {
    title,
    note: `${window} 每小时`,
    window,
    source: 'api'
  })
  created = value.reminder
  console.log(`[swap] + 规则提醒 ${created.id}：${created.rule.expression}，下一次 ${new Date(created.nextAt).toLocaleString()}`)
}

let removed = 0
for (const item of old) {
  const result = await call('cancel', { id: item.id })
  if (result.removed) {
    removed += 1
    console.log(`[swap] - 删掉 ${item.id}（${clock(item.scheduledAt)}）`)
  }
}

const after = await call('list')
console.log(`\n[swap] 新增 1 条规则、删除 ${removed} 条 daily；清单现在 ${(after.reminders ?? []).length} 条：`)
for (const item of after.reminders ?? []) {
  const when = item.rule !== undefined ? `规则 ${item.rule.expression}` : `每天 ${clock(item.scheduledAt)}`
  console.log(`         [${item.id}] ${item.title} · ${when}`)
}

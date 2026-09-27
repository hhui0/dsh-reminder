/**
 * 高频到点探针：确认「提醒到点」这个事件真的被 host 发布给了页面。
 *
 * 为什么需要它：`/api/pending` 是**长轮询**——页面自己正挂着一条，同一条提醒一旦被
 * 页面取走（并进入它的已展示集合），后续轮询就拿不到了。所以想从外面看见「到点」这件事，
 * 只能高频地抢在页面重新挂上之前问到。这个脚本 250 毫秒问一次，**一旦拿到就立刻收工**，
 * 不再和页面抢。
 *
 * 它只读，不改任何提醒数据；拿到之后不做 dismiss（那是页面的动作）。
 *
 * 跑法：node smoke/rapid-fire-check.mjs <seconds> [reminderId]
 */
const seconds = Number(process.argv[2] ?? 120)
const watchId = process.argv[3] ?? ''
const base = process.env.DSH_URL ?? 'http://127.0.0.1:19387'

console.log(`[rapid] 轮询 /dsh-reminder/api/pending，最长 ${seconds} 秒${watchId === '' ? '' : `，关注 ${watchId}`}`)
const started = Date.now()
let rounds = 0
let seen = 0
while (Date.now() - started < seconds * 1000) {
  rounds += 1
  try {
    const response = await fetch(`${base}/dsh-reminder/api/pending?timeout=250`)
    const payload = await response.json()
    const items = payload?.value?.reminders ?? []
    if (items.length > 0) {
      seen += 1
      const elapsed = ((Date.now() - started) / 1000).toFixed(1)
      console.log(`[rapid] t+${elapsed}s 拿到 ${items.length} 条：`)
      for (const item of items) {
        console.log(`         id=${item.id} title=${item.title} status=${item.status} firedAt=${new Date(item.firedAt).toLocaleTimeString()} repeat=${item.repeat}`)
      }
      break
    }
  } catch (error) {
    console.log(`[rapid] 请求失败：${String(error).slice(0, 100)}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}
console.log(`[rapid] 结束：${rounds} 次轮询，${seen} 次拿到到点的提醒`)
process.exit(seen > 0 ? 0 : 1)

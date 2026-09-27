/**
 * 「插件 → 提醒小窗」这条真实链路的端到端验证。
 *
 * 它调的就是 `host.js` 里 `openToast()` 会走的那条路：`spawnToast`（detached）+
 * `toastPayload` + 生产环境变量（含剥掉 `ELECTRON_RUN_AS_NODE`）。跑起来之后应当看到
 * 右下角弹出一个小窗、响三声、然后按 ttl 自己消失。
 *
 * 跑法：node smoke/e2e-toast.mjs [ttlSeconds]
 */
import { readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { spawnToast, toastPayload } from '../lib/toast.js'

const ttl = Number(process.argv[2] ?? 6)
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
const logFile = join(home, 'reminder-toast.log')

/** 等一段真实时间。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 从干净状态开始：上一次的日志会让断言看着像通过了。
try {
  rmSync(logFile, { force: true })
} catch {
  /* 没有就算了 */
}

const reminder = {
  id: `e2e-${Date.now()}`,
  // 故意给一个长标题：它会折成好几行，从而真的走一遍「内容变高 → 窗口跟着变高」那条路。
  // 短标题量出来的高度接近初始值，反而测不出 resize 有没有生效。
  title: '端到端验证：提醒小窗（这条标题故意写得长一些，用来验证内容变高时窗口会跟着变高，而不是在右边长出滚动条）',
  note: '这条走的是插件真实调用路径（detached + payload 文件 + 剥掉 ELECTRON_RUN_AS_NODE）',
  repeat: 'once',
  status: 'fired'
}
const settings = { sound: 'chime', autoDismissSeconds: ttl, toastWindow: true, activateWindow: false }
const payload = toastPayload(reminder, settings)

console.log('[e2e] payload:', JSON.stringify(payload))
console.log(`[e2e] 拉起小窗（detached），它应当自己活 ${payload.ttlSeconds} 秒…`)
const result = await spawnToast({ payload, home, logFile })
console.log('[e2e] spawn 结果:', JSON.stringify(result))
if (!result.spawned) {
  console.error('[e2e] 没能拉起小窗，后面不用看了')
  process.exit(1)
}
console.log(`[e2e] pid=${result.pid}，等 ${payload.ttlSeconds + 4} 秒后读日志…`)
await sleep((payload.ttlSeconds + 4) * 1000)

let log = ''
try {
  log = readFileSync(logFile, 'utf8')
} catch (error) {
  console.error(`[e2e] 读不到日志 ${logFile}: ${String(error).slice(0, 120)}`)
  process.exit(1)
}
console.log('[e2e] 小窗日志：')
for (const line of log.trim().split('\n')) console.log(`      ${line}`)

const checks = [
  ['页面加载完成（page loaded）', log.includes('page loaded')],
  ['渲染器就绪（renderer ready）', log.includes('renderer ready')],
  ['payload 已投递', log.includes(`delivered payload id=${reminder.id}`)],
  // 长标题一定会让内容高于初始的 150px，所以必须有 resize 请求；这也顺带证明
  // 「窗口高度跟着内容走」这条链路是通的（右边不会多出滚动条）。
  ['窗口按内容高度调整过', /resize requested height=\d+/.test(log)],
  ['提示音没失败', !log.includes('chime-failed')],
  // 两条正常的退出路径都算通过：卡片自己到时消失（`ttlSeconds`），或者用户点了「收到」
  // 之后卡片清空。这两条都意味着进程干净收尾，没有留下常驻窗口。
  ['干净退出（到时消失或点「收到」）', /ttl reached|cards empty/.test(log)]
]
let failed = 0
for (const [label, ok] of checks) {
  if (ok) console.log(`  ok  ${label}`)
  else {
    failed += 1
    console.error(`FAIL  ${label}`)
  }
}
console.log(failed === 0 ? '[e2e] 全部通过' : `[e2e] ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

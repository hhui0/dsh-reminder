/**
 * 连续两次到点的端到端验证（用**真实时间戳**，不搬时钟）。
 *
 * 为什么单独写这一条：`catchUp` / `fire` / `nextAt` 这套逻辑里，最危险的缺陷是
 * 「只响一次就再也不响」和「迟到就被删掉」。测试里搬时钟能验它们，但搬时钟的测试
 * 有个隐患——**假的时间戳可能与真实日期算出来的星期/日期不一致**，于是测试通过、
 * 真机却不对。
 *
 * 所以这里反过来：不搬时钟，而是把提醒的下一次放进真实时间轴——`fire()` 会把时间戳
 * 正常往后推，我们只控制「什么时候 tick」。这样 `nextAfter` 拿到的永远是真实日期。
 *
 * 跑法：node smoke/fire-twice.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ReminderScheduler, ReminderStore } from '../lib/host.js'
import { nextAfter, parseCron } from '../lib/timing.js'

const dir = await mkdtemp(join(tmpdir(), 'dsh-reminder-twice-'))
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

/** 本地 `YYYY-MM-DD HH:mm`。 */
function stamp(value) {
  const d = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

console.log('[twice] 规则提醒连续两次到点')

// 一个「每小时整点、覆盖全天」的规则：它下一个整点就在眼前，于是不用等一小时。
const rule = parseCron('0 * * * *')
const store = new ReminderStore({ dataFile: join(dir, 'twice.json'), settingsFile: join(dir, 'twice-settings.json') })
const fired = []
const scheduler = new ReminderScheduler({ store, intervalMs: 200, onFire: (item) => fired.push({ id: item.id, at: item.firedAt }) })

const reminder = await store.create({ title: '连续响两次', cron: '0 * * * *' })
const created = store.reminders.find((item) => item.id === reminder.id)
check('create：规则被记下来', created.rule.expression === '0 * * * *', JSON.stringify(created.rule))
check('create：下一次是真实时间轴上的下一个整点', created.nextAt % 60000 === 0 && created.nextAt > Date.now(), stamp(created.nextAt))

// 把「下一次」挪到现在：既保证它立刻该响，又不动时钟——`fire()` 之后会用真实时间继续算。
const now = Date.now()
created.nextAt = now - 1000
created.scheduledAt = created.nextAt
await store.persist()

scheduler.start()
// 等第一次响（tick 每 200ms）。
let deadline = Date.now() + 4000
while (fired.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
check('第一次到点响了', fired.length === 1, `fired=${fired.length}`)

const afterFirst = store.reminders.find((item) => item.id === reminder.id)
check('响完仍然留在清单里', afterFirst !== undefined)
check('响完状态回到 active（否则再也不会响）', afterFirst?.status === 'active', String(afterFirst?.status))
check('下一次被排到将来', afterFirst !== undefined && afterFirst.nextAt > Date.now(), afterFirst === undefined ? 'missing' : stamp(afterFirst.nextAt))
check('下一次仍然是整点', afterFirst !== undefined && afterFirst.nextAt % 60000 === 0, afterFirst === undefined ? 'missing' : stamp(afterFirst.nextAt))

// 关键一步：把「下一次」再挪到眼前，验证**第二次**也会响。第一次那个缺陷就是死在这里。
afterFirst.nextAt = Date.now() - 1000
afterFirst.scheduledAt = afterFirst.nextAt
await store.persist()
deadline = Date.now() + 4000
while (fired.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
check('第二次到点也响了（守的是「循环提醒只响一次」）', fired.length === 2, `fired=${fired.length}`)

scheduler.stop()
const final = store.reminders.find((item) => item.id === reminder.id)
check('两次之后 fireCount = 2', final?.fireCount === 2, String(final?.fireCount))
check('两次响的时间戳不同', fired.length === 2 && fired[0].at !== fired[1].at)
check('nextAfter 给的是严格将来的整点', nextAfter(rule, Date.now()) > Date.now())

await rm(dir, { recursive: true, force: true })
console.log(`\n[twice] ${passed} 通过, ${failures.length} 失败`)
if (failures.length > 0) {
  console.error('failed:', failures.join('; '))
  process.exit(1)
}
console.log('[twice] 连续两次到点 OK')

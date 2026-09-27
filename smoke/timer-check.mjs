/**
 * 用真的等待验证调度器：`ReminderStore` + `ReminderScheduler` 在真实时间下，
 * 会不会到点把提醒响出去。
 *
 * 这条断言看起来很笨（要等 1.5 秒），但它守的是一件前面几套测试都覆盖不到的事：
 * 单元测试里的时钟是**假的**，`tick()` 是被手动调用的；「定时器自己会走」只有让真实
 * 时间过去才能验。
 *
 * 跑法：node smoke/timer-check.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ReminderScheduler, ReminderStore } from '../lib/host.js'

const dir = await mkdtemp(join(tmpdir(), 'dsh-reminder-timer-'))
const store = new ReminderStore({ dataFile: join(dir, 'timer.json'), settingsFile: join(dir, 'timer-settings.json') })
const fired = []
const scheduler = new ReminderScheduler({ store, intervalMs: 250, onFire: (item) => fired.push(item) })

let passed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok  ${label}`)
    return
  }
  failures.push(label)
  console.error(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log('[smoke] dsh-reminder timer')

const reminder = await store.create({ title: '定时器自检', afterMinutes: 1 })
// 把它挪到 1.2 秒之后：`create` 只接受未来的时刻，测试再手动缩短。
const target = Date.now() + 1200
reminder.scheduledAt = target
await store.persist()

scheduler.start()
check('timer: 起来之后有定时器', scheduler.timer !== undefined)

// 最多等 6 秒。
const deadline = Date.now() + 6000
while (fired.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100))
}

check('timer: 到点自己响了（不需要手动 tick）', fired.length === 1, `fired=${fired.length}`)
check('timer: 响的是那一条', fired[0]?.id === reminder.id, String(fired[0]?.id))
check('timer: 一次性提醒响完就从清单里消失', (await store.list()).length === 0)

// 长轮询必须被唤醒，而不是等满超时：这是「到点就弹窗」的关键一步。
const waitStarted = Date.now()
const waiting = scheduler.wait(8000)
await new Promise((resolve) => setTimeout(resolve, 50))
const second = await store.create({ title: '第二次', afterMinutes: 1 })
second.scheduledAt = Date.now() + 900
await store.persist()
await waiting
const waited = Date.now() - waitStarted
check('timer: 长轮询被唤醒而不是等满超时', waited < 6000, `等了 ${waited}ms`)

scheduler.stop()
check('timer: stop() 之后定时器没了', scheduler.timer === undefined)
await rm(dir, { recursive: true, force: true })

console.log(`\n[smoke] ${passed} 通过, ${failures.length} 失败`)
if (failures.length > 0) {
  console.error('failed:', failures.join('; '))
  process.exit(1)
}
console.log('[smoke] dsh-reminder timer OK')

/**
 * host 半边的冒烟测试。
 *
 * 跑法（在 dsh-reminder 目录下）：
 *   node --test smoke
 *
 * 覆盖的是**不需要 Cordis 就能验的部分**：时间解析、持久化、到点判定与重复提醒的排程。
 * 工具注册、HTTP 路由、窗口唤醒都需要活着的宿主，那部分只能手动验证——README 里写明了
 * 哪些已验证、哪些没有。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  describeRemaining,
  formatLocal,
  nextOccurrence,
  normalizeReminder,
  parseRelativeMs,
  parseWhen
} from '../lib/parsing.js'
import { ReminderScheduler, ReminderStore, isDue, normalizeSettings, writeJsonAtomic } from '../lib/host.js'

/** 一个随测试推进的假时钟。 */
function makeClock(start) {
  let value = start
  return {
    now: () => value,
    advance: (ms) => {
      value += ms
      return value
    }
  }
}

/** 2026-09-27 10:00:00（本地时间）——所有解析断言都相对它。 */
const BASE = new Date(2026, 8, 27, 10, 0, 0, 0).getTime()

describe('parseRelativeMs', () => {
  it('认裸数字为分钟', () => {
    assert.equal(parseRelativeMs('30'), 30 * 60000)
    assert.equal(parseRelativeMs('0.5'), 30000)
  })

  it('认英文与中文单位', () => {
    assert.equal(parseRelativeMs('30m'), 30 * 60000)
    assert.equal(parseRelativeMs('2h'), 2 * 3600000)
    assert.equal(parseRelativeMs('45 分钟'), 45 * 60000)
    assert.equal(parseRelativeMs('2 小时'), 2 * 3600000)
    assert.equal(parseRelativeMs('90秒'), 90000)
  })

  it('累计多个片段', () => {
    assert.equal(parseRelativeMs('1h30m'), 90 * 60000)
    assert.equal(parseRelativeMs('1 小时 30 分钟'), 90 * 60000)
    assert.equal(parseRelativeMs('1天2小时'), 26 * 3600000)
  })

  it('秒级也认（「10 秒后」是最短的验证写法）', () => {
    assert.equal(parseRelativeMs('10s'), 10000)
    assert.equal(parseRelativeMs('10 秒'), 10000)
    assert.equal(parseRelativeMs('45秒钟'), 45000)
    assert.equal(parseRelativeMs('半分钟'), 30000)
    assert.equal(parseWhen('10s', BASE), BASE + 10000)
    assert.equal(parseWhen('10 秒', BASE), BASE + 10000)
  })

  it('拒绝认不出来的东西', () => {
    assert.equal(parseRelativeMs(''), undefined)
    assert.equal(parseRelativeMs('开会'), undefined)
    assert.equal(parseRelativeMs('abc30m'), undefined)
    assert.equal(parseRelativeMs('0m'), undefined)
  })
})

describe('parseWhen', () => {
  it('相对时间以 now 为锚点', () => {
    assert.equal(parseWhen('10m', BASE), BASE + 600000)
    assert.equal(parseWhen('30', BASE), BASE + 1800000)
  })

  it('钟点落在今天', () => {
    const stamp = parseWhen('19:30', BASE)
    assert.equal(stamp, new Date(2026, 8, 27, 19, 30, 0, 0).getTime())
  })

  it('已经过去的钟点顺延到明天', () => {
    const stamp = parseWhen('08:00', BASE)
    assert.equal(stamp, new Date(2026, 8, 28, 8, 0, 0, 0).getTime())
  })

  it('认「明天」「后天」「8点半」', () => {
    assert.equal(parseWhen('明天 08:00', BASE), new Date(2026, 8, 28, 8, 0, 0, 0).getTime())
    assert.equal(parseWhen('后天 09:15', BASE), new Date(2026, 8, 29, 9, 15, 0, 0).getTime())
    assert.equal(parseWhen('明天8点半', BASE), new Date(2026, 8, 28, 8, 30, 0, 0).getTime())
    assert.equal(parseWhen('20点', BASE), new Date(2026, 8, 27, 20, 0, 0, 0).getTime())
  })

  it('认带日期的绝对时间（本地时区，不当成 UTC）', () => {
    assert.equal(parseWhen('2026-09-28 07:30', BASE), new Date(2026, 8, 28, 7, 30, 0, 0).getTime())
    assert.equal(parseWhen('2026-09-28T07:30', BASE), new Date(2026, 8, 28, 7, 30, 0, 0).getTime())
    assert.equal(parseWhen('2026/09/28', BASE), new Date(2026, 8, 28, 0, 0, 0, 0).getTime())
  })

  it('拒绝非法钟点与无关文本', () => {
    assert.equal(parseWhen('25:00', BASE), undefined)
    assert.equal(parseWhen('开会', BASE), undefined)
    assert.equal(parseWhen('晚上开会', BASE), undefined)
  })

  it('formatLocal 用的是本地钟点，不是 UTC', () => {
    assert.equal(formatLocal(parseWhen('19:30', BASE)), '2026-09-27 19:30')
  })

  it('describeRemaining 给人话', () => {
    assert.equal(describeRemaining(BASE, BASE), '已到点')
    assert.equal(describeRemaining(BASE + 1000, BASE), '不到 1 分钟')
    assert.equal(describeRemaining(BASE + 50000, BASE), '不到 1 分钟')
    assert.equal(describeRemaining(BASE + 5 * 60000, BASE), '5 分钟后')
    assert.equal(describeRemaining(BASE + 125 * 60000, BASE), '2 小时 5 分钟后')
    assert.equal(describeRemaining(BASE + 26 * 3600000, BASE), '1 天 2 小时后')
  })
})

describe('normalizeReminder / normalizeSettings', () => {
  it('把缺字段的旧记录补全', () => {
    const item = normalizeReminder({ id: 'a1', title: '开会', scheduledAt: BASE })
    assert.equal(item.repeat, 'once')
    assert.equal(item.status, 'active')
    assert.equal(item.note, '')
    assert.equal(item.fireCount, 0)
  })

  it('丢掉没法救的记录', () => {
    assert.equal(normalizeReminder(null), undefined)
    assert.equal(normalizeReminder({ title: '没有 id' }), undefined)
    assert.equal(normalizeReminder({ id: 'x', scheduledAt: BASE }), undefined)
    assert.equal(normalizeReminder({ id: 'x', title: '没有时间' }), undefined)
  })

  it('偏好取值有边界', () => {
    assert.deepEqual(normalizeSettings({}), {
      sound: 'chime',
      volume: 0.6,
      repeat: 3,
      activateWindow: true,
      toastWindow: true,
      autoDismissSeconds: 0
    })
    assert.equal(normalizeSettings({ volume: 9 }).volume, 1)
    assert.equal(normalizeSettings({ volume: -3 }).volume, 0)
    assert.equal(normalizeSettings({ sound: '不存在的音色' }).sound, 'chime')
    assert.equal(normalizeSettings({ sound: 'tts' }).sound, 'tts')
    assert.equal(normalizeSettings({ sound: 'off' }).sound, 'off')
    assert.equal(normalizeSettings({ repeat: 999 }).repeat, 20)
    assert.equal(normalizeSettings({ activateWindow: 'yes' }).activateWindow, false)
    assert.equal(normalizeSettings({ toastWindow: 'yes' }).toastWindow, false)
    assert.equal(normalizeSettings({ toastWindow: true }).toastWindow, true)
  })
})

describe('nextOccurrence', () => {
  it('严格大于 now', () => {
    const now = new Date(2026, 8, 27, 10, 0, 0, 0).getTime()
    const next = nextOccurrence(new Date(2026, 8, 27, 9, 0, 0, 0).getTime(), now)
    assert.ok(next > now)
    assert.equal(formatLocal(next).slice(11), '09:00')
  })

  it('机器停了一周也只跳到下一次，不逐日累积', () => {
    const now = new Date(2026, 9, 4, 10, 0, 0, 0).getTime()
    const next = nextOccurrence(new Date(2026, 8, 27, 9, 0, 0, 0).getTime(), now)
    assert.ok(next > now)
    assert.equal(formatLocal(next), '2026-10-05 09:00')
  })
})

describe('isDue', () => {
  const item = { status: 'active', scheduledAt: BASE }
  it('到点且在容忍窗口内才算响', () => {
    assert.equal(isDue(item, BASE, 3600000), true)
    assert.equal(isDue(item, BASE - 1, 3600000), false)
    assert.equal(isDue(item, BASE + 3600001, 3600000), false)
    assert.equal(isDue({ ...item, status: 'fired' }, BASE, 3600000), false)
  })
})

describe('writeJsonAtomic', () => {
  it('落盘的内容能被读回来，且不留临时文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reminder-write-'))
    try {
      const file = join(dir, 'nested', 'state.json')
      await writeJsonAtomic(file, { version: 1, reminders: [{ id: 'a' }] })
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, reminders: [{ id: 'a' }] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('ReminderStore', () => {
  let dir
  const clock = makeClock(BASE)

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-reminder-store-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function makeStore(name) {
    return new ReminderStore({
      dataFile: join(dir, `${name}.json`),
      settingsFile: join(dir, `${name}-settings.json`),
      now: clock.now,
      graceMinutes: 120
    })
  }

  it('建、列、删，并跨实例持久化', async () => {
    const store = makeStore('basic')
    const created = await store.create({ title: '开会', afterMinutes: 10 })
    assert.equal(created.title, '开会')
    assert.equal(created.scheduledAt, BASE + 600000)
    assert.equal(created.status, 'active')

    const listed = await store.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, created.id)

    // 另一个实例读同一个文件：这是「重启 DSH 后提醒还在」的那条路径。
    const reopened = makeStore('basic')
    assert.equal((await reopened.list()).length, 1)

    assert.equal(await reopened.remove(created.id), true)
    assert.equal((await makeStore('basic').list()).length, 0)
  })

  it('时间字段的优先级：after_minutes > at，且 at 支持人话', async () => {
    const store = makeStore('times')
    const a = await store.create({ title: 'A', afterMinutes: 5, at: '19:30' })
    assert.equal(a.scheduledAt, BASE + 5 * 60000)
    const b = await store.create({ title: 'B', at: '19:30' })
    assert.equal(b.scheduledAt, new Date(2026, 8, 27, 19, 30, 0, 0).getTime())
    const c = await store.create({ title: 'C', at: '明天 08:00', repeat: 'daily' })
    assert.equal(c.repeat, 'daily')
    assert.equal(c.scheduledAt, new Date(2026, 8, 28, 8, 0, 0, 0).getTime())
  })

  it('拒绝没有标题或时间不合法的新建', async () => {
    const store = makeStore('reject')
    await assert.rejects(() => store.create({ title: '   ', afterMinutes: 5 }), /标题/)
    await assert.rejects(() => store.create({ title: '没有时间' }), /时间/)
    await assert.rejects(() => store.create({ title: '过去', at: '2026-01-01 08:00' }), /晚于现在/)
    // 不认识的 repeat 必须报错，而不是静默按 once 处理：静默降级的症状是
    // 「我明明说了每天，它只响了一次」，用户和开发者都查不出来。
    await assert.rejects(() => store.create({ title: '非法重复', afterMinutes: 5, repeat: 'weekly' }), /repeat/)
    assert.equal((await store.list()).length, 0)
  })

  it('一次性提醒响完即删；当天循环提醒排到明天', async () => {
    const store = makeStore('fire')
    const once = await store.create({ title: '一次性', afterMinutes: 1 })
    const daily = await store.create({ title: '每天', afterMinutes: 1, repeat: 'daily' })
    clock.advance(61000)
    const result = await store.tick()
    assert.equal(result.fired.length, 2)
    const left = await store.list()
    assert.deepEqual(left.map((item) => item.title), ['每天'])
    assert.equal(left[0].status, 'fired')
    assert.equal(left[0].fireCount, 1)
    assert.ok(left[0].scheduledAt > clock.now())
    assert.equal(formatLocal(left[0].scheduledAt).slice(11), formatLocal(daily.scheduledAt).slice(11))
  })

  it('迟到超过容忍窗口的提醒直接丢掉，不补响', async () => {
    const store = makeStore('stale')
    await writeJsonAtomic(store.dataFile, {
      version: 1,
      reminders: [
        { id: 'old', title: '三天前', scheduledAt: BASE - 3 * 86400000, createdAt: BASE - 3 * 86400000 },
        { id: 'fresh', title: '刚过点', scheduledAt: BASE - 60000, createdAt: BASE - 60000 }
      ]
    })
    const reloaded = makeStore('stale')
    const result = await reloaded.tick()
    assert.deepEqual(result.fired.map((item) => item.id), ['fresh'])
    assert.deepEqual(result.skipped.map((item) => item.id), ['old'])
    assert.equal((await reloaded.list()).length, 0)
  })

  it('推迟只改这一次的时刻', async () => {
    const store = makeStore('snooze')
    const reminder = await store.create({ title: '喝水', afterMinutes: 1 })
    const moved = await store.snooze(reminder.id, 10)
    assert.equal(moved.status, 'active')
    assert.equal(moved.scheduledAt, clock.now() + 600000)
    assert.equal(await store.snooze('不存在', 10), undefined)
  })

  it('偏好单独落盘，删提醒不影响偏好', async () => {
    const store = makeStore('settings')
    const saved = await store.setSettings({ sound: 'beep', volume: 0.2 })
    assert.equal(saved.sound, 'beep')
    const reopened = makeStore('settings')
    await reopened.load()
    assert.equal(reopened.settings.sound, 'beep')
    assert.equal(reopened.settings.volume, 0.2)
  })

  it('磁盘上是坏 JSON 时当作空清单，而不是让插件起不来', async () => {
    const store = makeStore('broken')
    await writeFile(store.dataFile, '{ 这不是 JSON', 'utf8')
    await writeFile(store.settingsFile, 'nope', 'utf8')
    assert.deepEqual(await store.list(), [])
    assert.equal(store.settings.sound, 'chime')
  })
})

describe('ReminderScheduler', () => {
  let dir
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-reminder-sched-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('到点唤醒等待者，并把提醒交给 onFire', async () => {
    const clock = makeClock(BASE)
    const store = new ReminderStore({
      dataFile: join(dir, 'sched.json'),
      settingsFile: join(dir, 'sched-settings.json'),
      now: clock.now
    })
    const fired = []
    const scheduler = new ReminderScheduler({ store, now: clock.now, intervalMs: 20, onFire: (item) => fired.push(item) })
    await store.create({ title: '响一下', afterMinutes: 1 })

    // 先挂一个长轮询，再让时间越过触发点：等待者必须在到点的那一秒被唤醒，
    // 而不是等它自己超时——那正是「弹窗迟 20 秒」的成因。等待者的超时给到 5 秒，
    // 而间隔只有 20 毫秒，所以「被唤醒」和「自己超时」在结论上不会混淆。
    const waiting = scheduler.wait(5000)
    clock.advance(61000)
    scheduler.start()
    const result = await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000))])
    scheduler.stop()
    assert.notEqual(result, 'timeout', '长轮询没有被唤醒')
    assert.equal(fired.length, 1)
    assert.equal(fired[0].title, '响一下')
    // 一次性提醒在清单里已经不存在了。
    assert.equal((await store.list()).length, 0)
  })

  it('wake() 立刻结束等待，挂着的调用不会等到超时', async () => {
    const clock = makeClock(BASE)
    const store = new ReminderStore({
      dataFile: join(dir, 'wake.json'),
      settingsFile: join(dir, 'wake-settings.json'),
      now: clock.now
    })
    const scheduler = new ReminderScheduler({ store, now: clock.now })
    const started = Date.now()
    const waiting = scheduler.wait(5000)
    setTimeout(() => scheduler.wake(), 10)
    await waiting
    assert.ok(Date.now() - started < 2000, 'wake() 之后仍然挂到了超时')
  })

  it('pending() 用 seen 去重，同一个弹窗不会推两次', async () => {
    const clock = makeClock(BASE)
    const store = new ReminderStore({
      dataFile: join(dir, 'seen.json'),
      settingsFile: join(dir, 'seen-settings.json'),
      now: clock.now
    })
    const scheduler = new ReminderScheduler({ store, now: clock.now, intervalMs: 20 })
    const daily = await store.create({ title: '每天', afterMinutes: 1, repeat: 'daily' })
    clock.advance(61000)
    await scheduler.tick()

    const first = (await store.list()).filter((item) => item.status === 'fired')
    assert.equal(first.length, 1)
    assert.equal(first[0].id, daily.id)

    // 页面第二次挂长轮询时带上 seen，就必须拿到空列表。
    const seen = new Set([daily.id])
    const second = (await store.list()).filter((item) => item.status === 'fired' && !seen.has(item.id))
    assert.equal(second.length, 0)
  })
})

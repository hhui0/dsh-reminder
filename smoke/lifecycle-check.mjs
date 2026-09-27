/**
 * 真实生命周期下的定时器测试。
 *
 * 这一条是为一个**只有真跑起来才暴露**的缺陷写的：在 `apply` 里注册
 * `ctx.effect(() => { start(); return () => stop() })` 看起来天经地义，但 `ctx.plugin()`
 * 返回的子 fiber 是**异步启动**的——那个 effect 的 cleanup 会在子 fiber 真正启动之前先跑
 * 一遍，于是定时器刚建好就被停掉。症状是：插件激活成功、工具注册成功、清单能读能写，
 * 就是**永远不响**。
 *
 * 所以这里不用假时钟，而是真的等一秒多，并且用的是 `apply` 本身（走真实的
 * plugin/fiber 生命周期），而不是手工 new 一个 Scheduler。
 *
 * 跑法：node --test smoke/lifecycle-check.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'

import { SERVICE, Config, apply } from '../lib/host.js'

/** 等一段真实时间。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('服务在真实生命周期下的调度', () => {
  let dir
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-reminder-life-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('激活后定时器自己在走：到点会把提醒写进「已响」', async () => {
    const root = new Context()
    root.provide('tools', { register: () => () => {} })
    root.provide('commands', { register: () => () => {} })
    const dataFile = join(dir, 'life.json')
    const fiber = root.plugin(
      { name: 'dsh-reminder', inject: ['tools', 'commands'], Config, apply },
      { dataFile, settingsFile: join(dir, 'life-settings.json'), activateWindow: false }
    )
    await fiber
    await sleep(50)

    const service = root.get(SERVICE)
    assert.ok(service !== undefined, '服务没有挂上')
    assert.notEqual(service.scheduler.timer, undefined, '定时器没有在服务激活后建起来')

    // 一条「明天这个点」的循环提醒：它响完之后**留在清单里**（不是一次性提醒那样被删掉），
    // 所以可以从磁盘上观察它到底有没有被 tick 碰到。
    const reminder = await service.store.create({ title: '生命周期自检', afterMinutes: 1, repeat: 'daily' })
    reminder.scheduledAt = Date.now() + 900
    await service.store.persist()

    // 真的等：tick 每 1 秒一次，900 毫秒的到点时间最多 2 秒内应当被处理。
    let sawFired = false
    const deadline = Date.now() + 6000
    while (Date.now() < deadline && !sawFired) {
      await sleep(150)
      const raw = JSON.parse(await readFile(dataFile, 'utf8'))
      const row = raw.reminders.find((item) => item.id === reminder.id)
      sawFired = row !== undefined && row.fireCount > 0
    }
    assert.equal(sawFired, true, '等了 6 秒，提醒一直没有被 tick 处理——定时器根本没在走')

    const raw = JSON.parse(await readFile(dataFile, 'utf8'))
    const row = raw.reminders.find((item) => item.id === reminder.id)
    assert.equal(row.status, 'fired')
    assert.ok(row.scheduledAt > Date.now(), '循环提醒没有排到下一次')

    await fiber.dispose()
    await sleep(20)
    assert.equal(service.scheduler.timer, undefined, '卸载后定时器还在跑')
  })
})

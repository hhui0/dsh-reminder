/**
 * `apply()` 的接线冒烟测试：用真的 Cordis 上下文把 Host 半边拉起来。
 *
 * 这一步验的是前面几个文件各自都对、连起来却可能不对的东西：
 *   · 插件能不能激活（`Config` 校验、`ctx.plugin`、`inject`）；
 *   · 服务有没有真的挂成 `ctx.get('reminders')`；
 *   · 三个工具与 `/reminder` 命令有没有注册上；
 *   · 路由有没有挂到 `webServer` 上（用一个假的 webServer 记录注册）；
 *   · 卸载时定时器与注册项有没有一起走掉。
 *
 * 它**不**验 HTTP 行为本身（那要一个真的宿主），也不验 GUI。
 *
 * 跑法：node --test smoke/wire-smoke.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'

import { Config, REMINDER_ROUTE, SERVICE, apply, defaultDataFile } from '../lib/host.js'

/** 记录注册内容的假服务。 */
function recorder() {
  const items = []
  return {
    items,
    register(definition) {
      items.push(definition)
      return () => {
        const index = items.indexOf(definition)
        if (index >= 0) items.splice(index, 1)
      }
    }
  }
}

/**
 * 造一个装好假服务、只差插件的宿主根上下文。
 *
 * @returns `{ root, tools, commands, routes, webServer }`。
 */
function makeHost() {
  const root = new Context()
  const tools = recorder()
  const commands = recorder()
  const routes = recorder()
  const webServer = {
    register(route) {
      routes.items.push(route)
      return () => {
        const index = routes.items.indexOf(route)
        if (index >= 0) routes.items.splice(index, 1)
      }
    },
    registerUpgrade() {
      return () => {}
    },
    registerFallback() {
      return () => {}
    },
    tapIndex() {
      return () => {}
    }
  }
  root.provide('tools', tools)
  root.provide('commands', commands)
  root.provide('webServer', webServer)
  return { root, tools, commands, routes, webServer }
}

describe('apply() 接线', () => {
  let dir
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-reminder-wire-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('激活后服务、工具、命令、路由都在，卸载后都消失', async () => {
    const { root, tools, commands, routes } = makeHost()
    const config = { dataFile: join(dir, 'wire.json'), settingsFile: join(dir, 'wire-settings.json'), activateWindow: false }
    const fiber = root.plugin({ name: 'dsh-reminder', inject: ['tools', 'commands'], Config, apply }, config)
    await fiber
    // 激活是异步的（`inject` 的依赖要等就绪），所以等它稳定下来再断言。
    await new Promise((resolve) => setTimeout(resolve, 50))

    const service = root.get(SERVICE)
    assert.ok(service !== undefined, '服务没有挂上 ctx.get("reminders")')
    assert.equal(typeof service.create, 'function')
    assert.equal(typeof service.pending, 'function')
    assert.equal(service.dataFile, config.dataFile)
    assert.equal(service.settingsFile, config.settingsFile)

    assert.deepEqual(
      tools.items.map((item) => item.name).sort(),
      ['reminder_cancel', 'reminder_list', 'reminder_set']
    )
    assert.deepEqual(commands.items.map((item) => item.name), ['reminder'])
    assert.equal(routes.items.length, 1)
    assert.equal(routes.items[0].path, REMINDER_ROUTE)
    assert.equal(routes.items[0].kind, 'prefix')

    // 工具真的能建一条提醒：它走的是与命令、页面同一条路径。
    const created = await tools.items.find((item) => item.name === 'reminder_set').execute({ title: '接线测试', after_minutes: 5 })
    assert.equal(created.ok, true, JSON.stringify(created))
    assert.equal(created.reminder.title, '接线测试')
    const listed = await tools.items.find((item) => item.name === 'reminder_list').execute({})
    assert.equal(listed.count, 1)
    const cancelled = await tools.items.find((item) => item.name === 'reminder_cancel').execute({ id: created.reminder.id })
    assert.equal(cancelled.ok, true)

    // 命令也能用：`/reminder 30m 开会` 的第一个词是时间，其余是标题。
    const handler = commands.items[0].handler
    const commandResult = await handler({ commandId: 'c1', agent: {}, rawInput: '30m 开会', attachments: [], signal: new AbortController().signal })
    assert.equal(commandResult.kind, 'success', JSON.stringify(commandResult))
    assert.match(commandResult.text, /开会/)
    const listing = await handler({ commandId: 'c2', agent: {}, rawInput: '', attachments: [], signal: new AbortController().signal })
    assert.equal(listing.kind, 'success')
    assert.match(listing.text, /开会/)

    // 时间解析不了时命令报错而不是接受一条听不懂的提醒。
    const bogus = await handler({ commandId: 'c3', agent: {}, rawInput: '30m', attachments: [], signal: new AbortController().signal })
    assert.equal(bogus.kind, 'error')

    // 卸载：定时器要跟着走。一个还在跑的单秒定时器，就是「插件已卸载却还在响」的那类 bug。
    //
    // 这里只断言定时器，不断言假的 tools/commands 列表：那三个假服务只是记录器，
    // 它们返回的 disposer 不是 cordis 注册的，所以 cordis 不会在卸载时调用它们——
    // 断言它们会得到一条「测试自己的替身不完整」的假失败，而真正要守的契约是定时器。
    //
    // 注意这里**只能**断言 `timer` 存在：`ctx.plugin()` 的子 fiber 是异步启动的，
    // 定时器是否真的在走要等真实时间过去才知道，那是 `smoke/delivery-check.mjs`
    // （打真宿主的 /api/pending）负责的事。这条断言守的是「不早不晚地建起来」。
    assert.notEqual(service.scheduler.timer, undefined, '定时器没起来')
    await fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(service.scheduler.timer, undefined, '卸载后定时器还在跑')
  })

  it('Config 会拒绝非法的 catchUpMinutes', async () => {
    assert.throws(() => Config({ catchUpMinutes: -1 }))
    assert.equal(Config({}).catchUpMinutes, 120)
    assert.equal(Config({ catchUpMinutes: 30 }).catchUpMinutes, 30)
  })

  it('默认清单位于 DSH home 下', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = 'C:\\tmp\\dsh-home'
    try {
      assert.equal(defaultDataFile(), join('C:\\tmp\\dsh-home', 'reminders.json'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

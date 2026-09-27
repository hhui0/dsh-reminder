/**
 * 本机 HTTP 路线的冒烟测试：用假的 req/res 直接打 `webServer` 注册的那个 handler。
 *
 * 为什么值得单独测：页面与 host 之间的全部往来都在这两条路线上，而它们在单元测试里
 * 通常是「看不见的接线」——`/api/call` 的方法派发、信封形状、`/api/pending` 的等待与
 * 去重、以及只有本机能访问这条边界。这些都不是 GUI 能替你验的。
 *
 * 它**不**验真实网络栈（没有真的 socket），也不验页面的长轮询时序。
 *
 * 跑法：node --test smoke/http-smoke.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'

import { API, REMINDER_ROUTE, SERVICE, Config, apply } from '../lib/host.js'

/**
 * 造一个假的 IncomingMessage。
 * @param options - 方法、URL、请求体、来源地址。
 * @returns 一个够 handler 用的事件发射器。
 */
function makeRequest({ method = 'GET', url = '/', body = '', remote = '127.0.0.1' } = {}) {
  const listeners = new Map()
  return {
    method,
    url,
    socket: { remoteAddress: remote },
    on(event, handler) {
      listeners.set(event, handler)
      return this
    },
    destroy() {},
    /** 测试驱动它：按 Node 的顺序把事件发出去。 */
    emit(event, ...args) {
      const handler = listeners.get(event)
      if (handler !== undefined) handler(...args)
    },
    /** 开始读体。 */
    start() {
      if (body !== '') this.emit('data', Buffer.from(body, 'utf8'))
      this.emit('end')
    }
  }
}

/**
 * 造一个假的 ServerResponse，把状态码与响应体记下来。
 * @returns `{ res, read() }`。
 */
function makeResponse() {
  const chunks = []
  const state = { status: 0, headers: undefined }
  return {
    res: {
      writeHead(status, headers) {
        state.status = status
        state.headers = headers
      },
      end(text) {
        chunks.push(String(text ?? ''))
      }
    },
    read() {
      return { status: state.status, headers: state.headers, body: JSON.parse(chunks.join('')) }
    }
  }
}

/**
 * 起一个装好路由的宿主。
 *
 * 每个用例用**自己的**文件名：清单会落盘，共用一个文件会让「上一条用例建的提醒」
 * 出现在下一条的断言里，那是最容易写出假绿灯的一种测试。
 *
 * @param dir - 数据目录。
 * @param name - 这一条用例的文件名（不带扩展名）。
 * @returns `{ root, call, pending, fiber, routes }`。
 */
async function startHost(dir, name) {
  const root = new Context()
  const routes = []
  root.provide('tools', { register: () => () => {} })
  root.provide('commands', { register: () => () => {} })
  root.provide('webServer', {
    register(route) {
      routes.push(route)
      return () => {}
    },
    registerUpgrade: () => () => {},
    registerFallback: () => () => {},
    tapIndex: () => () => {}
  })
  const fiber = root.plugin(
    { name: 'dsh-reminder', inject: ['tools', 'commands'], Config, apply },
    { dataFile: join(dir, `${name}.json`), settingsFile: join(dir, `${name}-settings.json`), activateWindow: false }
  )
  await fiber
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(routes.length, 1, '路由没有挂上')

  /**
   * 打一次 `POST /api/call`。
   * @param method - API 方法名。
   * @param args - 参数。
   * @param remote - 来源地址。
   * @returns `{ status, body }`。
   */
  const call = async (method, args = {}, remote = '127.0.0.1') => {
    const capture = makeResponse()
    const request = makeRequest({
      method: 'POST',
      url: `${REMINDER_ROUTE}/api/call`,
      body: JSON.stringify({ method, args }),
      remote
    })
    // handler 会先挂上 data/end 监听再返回 promise，所以先拿 promise 再灌数据。
    const done = routes[0].handler(request, capture.res)
    request.start()
    await done
    return capture.read()
  }

  /**
   * 打一次 `GET /api/pending`。
   * @param query - 查询串（不含 `?`）。
   * @returns `{ status, body }`。
   */
  const pending = async (query = 'timeout=100') => {
    const capture = makeResponse()
    const request = makeRequest({ method: 'GET', url: `${REMINDER_ROUTE}/api/pending?${query}` })
    const done = routes[0].handler(request, capture.res)
    await done
    return capture.read()
  }

  return { root, call, pending, fiber, routes }
}

describe('本机 HTTP 路线', () => {
  let dir
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-reminder-http-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('create / list 走 JSON-RPC 信封，且提醒真的落进清单', async () => {
    const { call, fiber } = await startHost(dir, 'create')
    try {
      const created = await call(API.create, { title: '接口测试', at: '10', note: '备注' })
      assert.equal(created.status, 200)
      assert.equal(created.body.ok, true)
      assert.equal(created.body.value.reminder.title, '接口测试')

      const listed = await call(API.list)
      assert.equal(listed.body.value.reminders.length, 1)
      assert.equal(listed.body.value.reminders[0].note, '备注')

      const described = await call(API.describe)
      assert.equal(described.body.value.active, 1)
      assert.match(described.body.value.dataFile, /create\.json$/)
    } finally {
      await fiber.dispose()
    }
  })

  it('坏输入返回 4xx 和可读的错误，而不是 200 + 空值', async () => {
    const { call, fiber } = await startHost(dir, 'reject')
    try {
      const noTitle = await call(API.create, { at: '10' })
      assert.equal(noTitle.body.ok, false)
      assert.match(String(noTitle.body.error), /标题/)

      const badRepeat = await call(API.create, { title: 'x', at: '10', repeat: 'weekly' })
      assert.equal(badRepeat.body.ok, false)
      assert.match(String(badRepeat.body.error), /repeat/)

      const unknown = await call('nope')
      assert.equal(unknown.status, 404)
      assert.equal(unknown.body.code, 'unknown_method')
    } finally {
      await fiber.dispose()
    }
  })

  it('只有本机能访问', async () => {
    const { call, fiber } = await startHost(dir, 'remote')
    try {
      const remote = await call(API.list, {}, '10.0.0.7')
      assert.equal(remote.status, 403)
      assert.equal(remote.body.ok, false)
      assert.equal(remote.body.error, 'local-only')
    } finally {
      await fiber.dispose()
    }
  })

  it('pending 等满超时后返回空，且不再重复推送已经见过的提醒', async () => {
    const { call, pending, fiber, root } = await startHost(dir, 'pending')
    try {
      // 空清单：等满 100 毫秒，返回空的提醒数组（而不是挂死或报错）。
      const started = Date.now()
      const empty = await pending('timeout=100')
      assert.equal(empty.body.ok, true)
      assert.deepEqual(empty.body.value.reminders, [])
      assert.ok(Date.now() - started >= 90, `pending 提前返回了：${Date.now() - started}ms`)

      // 造一条「已经响过」的循环提醒：它在清单里是 fired，所以会被推给页面。
      // 直接跑一次 tick 而不是等那个每秒的定时器：测试不该把时间花在等间隔上。
      const service = root.get(SERVICE)
      const reminder = await service.store.create({ title: '已响', afterMinutes: 1, repeat: 'daily' })
      await service.store.fire(reminder.id)
      await service.scheduler.tick()

      const pushed = await pending('timeout=100')
      assert.deepEqual(pushed.body.value.reminders.map((item) => item.id), [reminder.id])

      // 页面把 id 放进 seen 之后再挂：同一条不会再被推一次。
      const deduped = await pending(`timeout=100&seen=${reminder.id}`)
      assert.deepEqual(deduped.body.value.reminders, [])

      // dismiss 不报错（一次性提醒早已从清单里消失，这一步只是收尾）。
      const dismissed = await call(API.dismiss, { id: reminder.id })
      assert.equal(dismissed.body.ok, true)
    } finally {
      await fiber.dispose()
    }
  })

  it('snooze 会把下一次时刻推到未来，未知 id 报 404', async () => {
    const { call, fiber } = await startHost(dir, 'snooze')
    try {
      const created = await call(API.create, { title: '推迟', at: '10' })
      const id = created.body.value.reminder.id
      const snoozed = await call(API.snooze, { id, minutes: 30 })
      assert.equal(snoozed.body.ok, true)
      assert.ok(snoozed.body.value.reminder.scheduledAt > Date.now() + 29 * 60000)

      const missing = await call(API.snooze, { id: '不存在', minutes: 5 })
      assert.equal(missing.status, 404)
      assert.equal(missing.body.code, 'not_found')

      const cancelled = await call(API.cancel, { id })
      assert.equal(cancelled.body.value.removed, true)
      assert.equal((await call(API.list)).body.value.reminders.length, 0)

      const settings = await call(API.settings, { sound: 'bell', volume: 0.5 })
      assert.equal(settings.body.value.settings.sound, 'bell')
      assert.equal(settings.body.value.settings.volume, 0.5)
      // 越界的音量被夹住，而不是原样写进文件。
      assert.equal((await call(API.settings, { volume: 9 })).body.value.settings.volume, 1)
    } finally {
      await fiber.dispose()
    }
  })
})

/**
 * 时间规则（cron 子集）的冒烟测试。
 *
 * 跑法：node --test smoke/timing-smoke.mjs
 *
 * 这一层是「每天早上 9 点到晚上 10 点、每小时提醒我喝水」能不能用**一条**提醒表达的
 * 关键：`nextAfter` 算错一分钟，表现就是「偶尔少响一次」或「多响一次」，肉眼极难发现，
 * 所以这里把边界（跨天、窗口端点、步长、列表、非整点分钟）都钉住。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { describeRule, matches, nextAfter, parseCron, windowToCron } from '../lib/timing.js'

/**
 * 造一个本地时刻的时间戳。
 * @param hour - 时。
 * @param minute - 分。
 * @param second - 秒。
 * @param day - 日（默认 27）。
 * @returns 毫秒时间戳。
 */
const at = (hour, minute = 0, second = 0, day = 27) => new Date(2026, 8, day, hour, minute, second, 0).getTime()

/** 时间戳 → `HH:mm`。 */
const clock = (stamp) => {
  const d = new Date(stamp)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 时间戳 → `MM-DD HH:mm`。 */
const stamp = (stampValue) => {
  const d = new Date(stampValue)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clock(stampValue)}`
}

describe('parseCron', () => {
  it('认整点窗口（用户那条需求的写法）', () => {
    const rule = parseCron('0 9-22 * * *')
    assert.deepEqual(rule.hours, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22])
    assert.deepEqual(rule.minutes, [0])
  })

  it('认单值、列表、步长', () => {
    assert.deepEqual(parseCron('30 9 * * *').minutes, [30])
    assert.deepEqual(parseCron('0 9,12,18 * * *').hours, [9, 12, 18])
    assert.deepEqual(parseCron('*/15 9 * * *').minutes, [0, 15, 30, 45])
    assert.deepEqual(parseCron('0 9-22/4 * * *').hours, [9, 13, 17, 21])
    assert.deepEqual(parseCron('0 * * * *').hours.length, 24)
  })

  it('拒绝非法写法，而不是静默算错', () => {
    assert.throws(() => parseCron('0 9-22 * *'), /5 段/)
    assert.throws(() => parseCron('0 25 * * *'), /超出范围/)
    assert.throws(() => parseCron('0 22-9 * * *'), /区间反了|超出范围/)
    assert.throws(() => parseCron('0 9 * * 1'), /只支持 \*/)
    assert.throws(() => parseCron('abc 9 * * *'), /不认识/)
    assert.throws(() => parseCron('0 9 * * *', 'Asia/Tokyo'), /只支持本机时区/)
    assert.equal(parseCron('0 9 * * *', 'local').hours[0], 9)
  })
})

describe('windowToCron', () => {
  it('把 9:00-22:00 转成 0 9-22 * * *', () => {
    assert.equal(windowToCron('9:00-22:00'), '0 9-22 * * *')
    assert.equal(windowToCron('09:00-22:00'), '0 9-22 * * *')
    assert.equal(windowToCron('9:00~22:00'), '0 9-22 * * *')
    assert.equal(windowToCron('9:30-22:30'), '30 9-22 * * *')
  })

  it('拒绝不合法的窗口', () => {
    assert.throws(() => windowToCron('9:00-22:15'), /分钟要相同/)
    assert.throws(() => windowToCron('22:00-9:00'), /不能晚于/)
    assert.throws(() => windowToCron('早上九点'), /要写成/)
  })
})

describe('nextAfter', () => {
  const every = parseCron('0 9-22 * * *')

  it('窗口内逐小时推进', () => {
    assert.equal(clock(nextAfter(every, at(9, 0, 0))), '10:00')
    assert.equal(clock(nextAfter(every, at(9, 0, 30))), '10:00')
    assert.equal(clock(nextAfter(every, at(21, 5))), '22:00')
  })

  it('窗口最后一响之后跳到第二天早上', () => {
    assert.equal(stamp(nextAfter(every, at(22, 0, 1))), '09-28 09:00')
    assert.equal(stamp(nextAfter(every, at(23, 30))), '09-28 09:00')
  })

  it('窗口之前从当天第一响开始', () => {
    assert.equal(clock(nextAfter(every, at(7, 30))), '09:00')
  })

  it('非整点分钟也照算', () => {
    const half = parseCron('30 9-22 * * *')
    assert.equal(clock(nextAfter(half, at(9, 0))), '09:30')
    assert.equal(clock(nextAfter(half, at(9, 30, 1))), '10:30')
    assert.equal(stamp(nextAfter(half, at(22, 30, 1))), '09-28 09:30')
  })

  it('命中判定与 nextAfter 一致', () => {
    assert.equal(matches(every, new Date(at(9, 0))), true)
    assert.equal(matches(every, new Date(at(9, 1))), false)
    assert.equal(matches(every, new Date(at(23, 0))), false)
  })
})

describe('describeRule', () => {
  it('连续区间说成窗口', () => {
    assert.match(describeRule(parseCron('0 9-22 * * *')), /每天 9:00-22:00 每小时整点/)
    assert.match(describeRule(parseCron('30 9-22 * * *')), /每小时的第 30 分/)
  })

  it('不连续的钟点直接列出来', () => {
    assert.match(describeRule(parseCron('0 9,12,18 * * *')), /9:00、12:00、18:00/)
  })

  it('没有规则时给空串', () => {
    assert.equal(describeRule(undefined), '')
  })
})

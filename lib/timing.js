/**
 * 窗口内循环的时间规则（纯函数，无 DSH 依赖）。
 *
 * 为什么需要这一层：「每天早上 9 点到晚上 10 点、每小时提醒我喝水」用原有的
 * `once` / `daily`（每天一个钟点）表达不出来，只能铺 14 条 daily 提醒——清单被撑长、
 * 改一次要改 14 条。这一层把「什么时候响」抽成一个规则对象，于是同一条提醒可以写成
 * `cron: "0 9-22 * * *"`，Tick 时由 `nextAfter` 算出下一次。
 *
 * 刻意只支持必要的 cron 子集，而不是引进一个 cron 库：
 *   · 位置：`分 时 日 月 周`，日/月/周只接受 `*`（要「每月 1 号」这种需求时再说，
 *     现在假装支持只会留下一个看起来很通用、实际上会静默算错的接口）；
 *   · 分与时支持：全部（星号）、单值、区间（`9-22`）、列表（`9,12,18`）、步长
 *     （星号加 `/2`，或 `9-22/2`）。
 */

/** 分/时字段允许的写法：星号、单值、区间、步长。 */
const FIELD = /^(\*|\d{1,2})(?:-(\d{1,2}))?(?:\/(\d{1,2}))?$/

/**
 * 展开一个 cron 字段成允许的取值集合。
 *
 * @param text - 字段原文。
 * @param min - 该字段的最小值（分 0、时 0）。
 * @param max - 该字段的最大值（分 59、时 23）。
 * @param label - 出错时用来说明是哪个字段。
 * @returns 取值集合（升序）。
 * @throws 写法不认识、或超出范围时。
 */
function expandField(text, min, max, label) {
  const values = new Set()
  for (const part of String(text).split(',')) {
    const piece = part.trim()
    // 关键字形式在 cron 里不算少见，但这里不支持：与其「看起来支持」，不如明确报错。
    if (piece === '') throw new Error(`${label} 字段是空的`)
    if (piece === '*') {
      for (let value = min; value <= max; value += 1) values.add(value)
      continue
    }
    const match = FIELD.exec(piece)
    if (match === null) throw new Error(`${label} 字段不认识：「${piece}」（支持 *、9、9-22、9,12,18、*/2）`)
    // `*` 放在起点：`*/2` 的语义是「从最小值开始，每隔 2 个」，而不是「把 * 当成数字」。
    // 这里差点写错成 `Number('*')` → NaN，表现是「所有 */N 写法都报空集合」。
    const start = match[1] === '*' ? min : Number(match[1])
    const end = match[2] === undefined ? (match[1] === '*' ? max : start) : Number(match[2])
    const step = match[3] === undefined ? 1 : Number(match[3])
    if (step < 1) throw new Error(`${label} 字段的步长必须 ≥ 1：「${piece}」`)
    if (start < min || end > max || start > end) {
      throw new Error(`${label} 字段超出范围（${min}-${max}）或区间反了：「${piece}」`)
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  if (values.size === 0) throw new Error(`${label} 字段没有匹配到任何取值：「${text}」`)
  return [...values].sort((left, right) => left - right)
}

/**
 * 解析一个五段 cron 表达式。
 *
 * @param expression - 例如 `0 9-22 * * *`（每天 9:00-22:00 每小时整点）。
 * @param timeZone - 时区名；目前只接受本机时区，传别的会报错而不是假装支持。
 * @returns 规则对象：`{ kind: 'cron', expression, minutes, hours }`。
 * @throws 表达式非法、或日/月/周不是 `*` 时。
 */
export function parseCron(expression, timeZone) {
  const parts = String(expression ?? '').trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`cron 需要 5 段（分 时 日 月 周），收到 ${parts.length} 段：「${expression}」`)
  }
  const [minuteText, hourText, dayText, monthText, weekText] = parts
  for (const [text, label] of [
    [dayText, '日'],
    [monthText, '月'],
    [weekText, '周']
  ]) {
    if (text !== '*') {
      throw new Error(`${label} 字段只支持 *（要按日期/星期循环请告诉插件作者加，别用会静默算错的写法）：「${expression}」`)
    }
  }
  if (timeZone !== undefined && timeZone !== '' && timeZone !== 'local') {
    throw new Error(`时区目前只支持本机时区（local），收到：「${timeZone}」`)
  }
  return {
    kind: 'cron',
    expression: parts.join(' '),
    minutes: expandField(minuteText, 0, 59, '分'),
    hours: expandField(hourText, 0, 23, '时')
  }
}

/**
 * 把「每天 H1:00 到 H2:00 每小时」这种自然写法转成 cron。
 *
 * 支持 `9:00-22:00`、`09:00-22:00`，两端必须是整点（`9:30-22:00` 现在也支持：它会生成
 * `30 9-22 * * *`，即每个整点后的第 30 分钟——这比拒绝它更有用，而且语义明确）。
 *
 * @param text - 窗口原文。
 * @returns cron 表达式。
 * @throws 格式不对时。
 */
export function windowToCron(text) {
  const match = /^(\d{1,2}):(\d{2})\s*[-~到至]\s*(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (match === null) throw new Error(`时间窗口要写成 9:00-22:00：「${text}」`)
  const [, startHour, startMinute, endHour, endMinute] = match
  if (startMinute !== endMinute) {
    throw new Error(`时间窗口两端的分钟要相同（例如 9:00-22:00 或 9:30-22:30）：「${text}」`)
  }
  const from = Number(startHour)
  const to = Number(endHour)
  if (from > 23 || to > 23) throw new Error(`时间窗口的小时要在 0-23 之间：「${text}」`)
  if (from > to) throw new Error(`时间窗口的起点不能晚于终点：「${text}」`)
  return `${Number(startMinute)} ${from}-${to} * * *`
}

/**
 * 判断规则在这一分钟是否命中。
 *
 * @param rule - 规则对象。
 * @param date - 待判断的时刻。
 * @returns 是否命中。
 */
export function matches(rule, date) {
  return rule.minutes.includes(date.getMinutes()) && rule.hours.includes(date.getHours())
}

/**
 * 下一个命中时刻（本地时间）。
 *
 * 从 `after` 的**下一分钟**开始逐分钟找，最多找一年。逐分钟扫看起来笨，但它换来一个
 * 很重要的性质：结果与「规则有多复杂」无关，永远不会算错——而列出所有组合再排序，
 * 会随着步长、区间、列表的组合迅速长出边界情况。
 *
 * @param rule - 规则对象。
 * @param after - 从这个时刻之后开始找（毫秒时间戳）。
 * @returns 下一个命中时刻的毫秒时间戳。
 * @throws 一年之内没有命中时（例如 `0 25 * * *` 这种被 expandField 挡住的写法不会走到这里，
 *   但空集合的规则会——所以留一条明确的错误）。
 */
export function nextAfter(rule, after) {
  const cursor = new Date(after)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = new Date(after)
  limit.setFullYear(limit.getFullYear() + 1)
  while (cursor <= limit) {
    if (matches(rule, cursor)) return cursor.getTime()
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  throw new Error(`这条规则在一年之内都不会命中：${rule.expression ?? JSON.stringify(rule)}`)
}

/**
 * 给 UI 与工具用的一句话描述。
 *
 * @param rule - 规则对象。
 * @returns 例如 `每天 9:00-22:00 每小时整点`。
 */
export function describeRule(rule) {
  if (rule === undefined || rule === null) return ''
  if (rule.kind !== 'cron') return String(rule.expression ?? '')
  const hours = rule.hours
  const minutes = rule.minutes
  const minuteText = minutes.length === 1 ? `第 ${minutes[0]} 分` : `第 ${minutes.join('、')} 分`
  // 连续区间说成 `9:00-22:00`，否则直接列出来。
  const continuous = hours.every((value, index) => index === 0 || value === hours[index - 1] + 1)
  if (continuous && hours.length > 1) {
    return `每天 ${hours[0]}:00-${hours[hours.length - 1]}:00 每小时${minuteText === '第 0 分' ? '整点' : `的${minuteText}`}`
  }
  return `每天 ${hours.map((hour) => `${hour}:00`).join('、')} 的${minuteText}`
}

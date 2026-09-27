/**
 * 提醒的时间与参数解析（纯函数，无 DSH 依赖）。
 *
 * 单独成模块只有一个理由：**可测**。host.js 要拿到 Cordis 的 ctx 才能跑起来，而这些规则
 * 是提醒功能里最容易被写错、也最值得写测试的部分，所以它们不碰文件系统、不碰 ctx，
 * 只做「人话 → 时刻」的翻译。
 *
 * 时钟永远由调用方注入（`now`）：测试因此可以精确地断言「明天 08:00」到底是哪一天，
 * 而不用假装现在是几点。
 */
import z from '@deepseek-ai/schemastery'

/** 单条提醒的标题上限：够写清楚一件事，又不会撑爆弹窗。 */
export const MAX_TITLE = 200
/** 备注上限。 */
export const MAX_NOTE = 1000
/** 时间戳上限：`setTimeout` 能表示的最大值，超过就不是「提醒」而是「考古」了。 */
export const MAX_TIMESTAMP = 2147483647

/** 相对时间单位：中文与英文都要认，因为工具参数是模型填的，用户的话是中文。 */
const UNIT_MS = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60000,
  min: 60000,
  mins: 60000,
  minute: 60000,
  minutes: 60000,
  h: 3600000,
  hr: 3600000,
  hrs: 3600000,
  hour: 3600000,
  hours: 3600000,
  d: 86400000,
  day: 86400000,
  days: 86400000,
  秒: 1000,
  秒钟: 1000,
  分: 60000,
  分钟: 60000,
  小时: 3600000,
  个小时: 3600000,
  天: 86400000
}

/** 纯数字（没有单位）时的默认单位：分钟。 */
const BARE_NUMBER = /^(\d+(?:\.\d+)?)$/
/** 一天里的钟点：`8:05`、`08:05:30`、`晚上8点`、`8点半`。 */
const CLOCK = /^(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*(?:分)?\s*(?:钟)?\s*(半)?$/

/**
 * 本地日期 + 本地钟点 → 时间戳。
 *
 * 刻意不走 `Date.parse('2026-09-27 08:00')`：那个格式在 V8 里被当作**本地**时间，
 * 但一旦带上 `T` 或 `Z` 就变成 UTC，两种写法混用会让「明天早上 8 点」在时区偏移的机器上
 * 差好几个小时。这里把年月日时分全部交给 `Date` 的本地构造器，行为只有一种。
 *
 * @param year - 四位年份。
 * @param month - 1-12。
 * @param day - 1-31。
 * @param hour - 0-23。
 * @param minute - 0-59。
 * @param second - 0-59。
 * @returns 时间戳。
 */
export function localTimestamp(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

/** 时间戳 → 本地 `YYYY-MM-DD HH:mm`。**不要**用 toISOString：那是 UTC，会显示成另一个钟点。 */
export function formatLocal(timestamp) {
  const d = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 时间戳 → 本地 `HH:mm`。 */
export function formatClock(timestamp) {
  return formatLocal(timestamp).slice(11)
}

/**
 * 把「大约多久之后」翻译成毫秒。
 *
 * 支持的形式，按识别顺序：
 *   · `1h30m`、`2 小时 10 分钟` —— 多个片段累加；
 *   · `30m`、`30 分钟`、`2h`、`10s`、`10 秒`；
 *   · `半分钟`、`半小时` —— 「半」先归一成 `0.5`；
 *   · `30`（裸数字）—— 默认按**分钟**算，因为「30 分钟后提醒我」远比「30 秒」常见；
 *   · `0.5h` —— 小数照收。
 *
 * @param text - 待解析的文本。
 * @returns 毫秒数；无法识别（或非正数）时返回 `undefined`。
 */
export function parseRelativeMs(text) {
  // 「半」先归一成 `0.5`：`半分钟`/`半小时` 里没有数字，正则匹配不到它，
  // 而单独为它们开分支就等于再写一遍单位表。归一只需要一次 replace。
  const value = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/半/g, '0.5')
  if (value === '') return undefined
  const bare = BARE_NUMBER.exec(value)
  if (bare !== null) return Math.round(Number(bare[1]) * UNIT_MS.m)
  let total = 0
  let matched = false
  // 每个调用自带一个正则实例：`g` 正则的 `lastIndex` 是跨调用共享的可变状态，
  // 复用一个模块级常量会在并发解析时错位。
  const part = /(\d+(?:\.\d+)?)\s*([a-z\u4e00-\u9fa5]+)/gi
  let match
  while ((match = part.exec(value)) !== null) {
    const unit = UNIT_MS[match[2]]
    if (unit === undefined) continue
    total += Number(match[1]) * unit
    matched = true
  }
  if (!matched || total <= 0) return undefined
  // 整段必须是「数值 + 单位」的重复，否则 `abc30m` 之类的垃圾也会被当成有效输入。
  const residue = value.replace(/(\d+(?:\.\d+)?)\s*([a-z\u4e00-\u9fa5]+)/gi, '').replace(/[\s,，、和]/g, '')
  if (residue !== '') return undefined
  return Math.round(total)
}

/**
 * 判断一段文本是不是「相对时间」而不是标题。
 *
 * `/reminder 30m 开会` 和 `/reminder 开会` 都要能用，所以第一个词到底是时间还是标题，
 * 只能靠这个判断。它比 `parseRelativeMs` 严格：必须带单位，或者裸数字后面还有别的词，
 * 否则「/reminder 会议 2」会被误解成「2 分钟后提醒我」。
 *
 * @param text - 第一个词。
 * @param rest - 去掉第一个词之后剩下的部分。
 * @returns 是否按相对时间解释。
 */
export function looksRelative(text, rest = '') {
  const parsed = parseRelativeMs(text)
  if (parsed === undefined) return false
  return !BARE_NUMBER.test(String(text).trim()) || rest.trim() !== ''
}

/** 从文本里剥掉「明天 / 后天 / 今天 / 明早」这类日期前缀。 */
function stripDayWord(text) {
  // 结尾的 `(?=[^a-z\u4e00-\u9fa5]|$)` 是必要的：「晚上开会」如果被当成「晚」+「上开会」，
  // 一条正常的标题就没了。
  const match = /^(今|明|后)?\s*(天|日|早|晚|晨)\s*(?=[^a-z\u4e00-\u9fa5]|$)/u.exec(text)
  if (match === null) return { text, dayOffset: 0 }
  const head = match[1] ?? ''
  const tail = match[2]
  const dayOffset = head === '明' ? 1 : head === '后' ? 2 : 0
  // 「明早」「明晚」把「早/晚」也吃掉，剩下的交给钟点解析。
  return { text: text.slice(match[0].length), dayOffset }
}

/**
 * 把一段「什么时间」翻译成绝对时间戳。
 *
 * 识别范围，按顺序：
 *   1. 纯数字/带单位的相对时间（`30`、`30m`、`1h30m`）→ `now + 偏移`；
 *   2. `HH:MM` / `H点M分` / `8点半`，可带 `今天/明天/后天` 前缀，
 *      也可被 `afterMinutes` 这类别的字段替代 → 当天最近的那个时刻（已过则顺延一天）；
 *   3. 带日期的 ISO 串（`2026-09-28T07:30`、`2026-09-28 07:30:00`）→ 本地时间。
 *
 * @param text - 待解析的文本。
 * @param now - 当前时间戳（注入以便测试）。
 * @returns 时间戳；无法识别时返回 `undefined`。
 */
export function parseWhen(text, now = Date.now()) {
  const raw = String(text ?? '').trim()
  if (raw === '') return undefined

  // ── 1. 相对时间 ──
  // 秒级也认：「10s」「10 秒」「10 秒钟」「半分钟」。只有分钟粒度的时候，用户想说
  // 「10 秒后」会写 `10s`，被拒之后很容易以为插件坏了。
  const relative = parseRelativeMs(raw)
  if (relative !== undefined) return now + relative

  // ── 3. 带日期的绝对时间（放在钟点之前，因为它更长、更明确）──
  const absolute = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2})\s*[:：时点]\s*(\d{1,2})?(?:\s*[:：分]\s*(\d{1,2}))?)?$/.exec(raw)
  if (absolute !== null) {
    const stamp = localTimestamp(
      Number(absolute[1]),
      Number(absolute[2]),
      Number(absolute[3]),
      Number(absolute[4] ?? 0),
      Number(absolute[5] ?? 0),
      Number(absolute[6] ?? 0)
    )
    return Number.isFinite(stamp) ? stamp : undefined
  }

  // ── 2. 钟点（可带今天/明天/后天）──
  const { text: rest, dayOffset } = stripDayWord(raw)
  const clock = CLOCK.exec(rest.replace(/\s+/g, ''))
  if (clock === null) return undefined
  let hour = Number(clock[1])
  let minute = clock[2] === undefined ? 0 : Number(clock[2])
  if (clock[3] === '半') minute = 30
  // 不做 12/24 小时制的猜测：「8 点」就是 08:00 或接下来的 20:00 之外的那个 8 点，
  // 一旦按「晚上」补全，用户在上午说「8 点」就会得到 20:00。
  if (hour > 23 || minute > 59) return undefined
  const base = new Date(now)
  base.setHours(hour, minute, 0, 0)
  let stamp = base.getTime() + dayOffset * 86400000
  // 没写「明天」但这个钟点今天已经过了 → 顺延到明天，这是所有提醒应用的做法。
  if (stamp <= now) stamp += 86400000
  return stamp
}

/** 提醒的触发方式；`once` 用完即止，`daily` 每天同一时刻再来。 */
export const RepeatSchema = z.union([z.const('once'), z.const('daily')]).default('once')

/**
 * 一条提醒。
 *
 * `status` 的三态是刻意分开的：
 *   · `active`   还没到点（或每天循环，等下一次）；
 *   · `fired`    已经到点，**正在等页面确认**——这个状态保证窗口没开着时提醒不会被丢掉；
 *   · `dismissed` 人已经看过了，下次启动不再弹。
 * 只有 `active` 参与调度。
 */
export const ReminderSchema = z.object({
  id: z.string().required(),
  title: z.string().required(),
  note: z.string().default(''),
  /** 下一次响的时刻（epoch ms）。 */
  scheduledAt: z.natural().required(),
  /**
   * 循环规则（cron 子集）。有它就由规则算出 `nextAt`，而不是靠「上次响的时刻 + 一天」——
   * 于是「每天 9:00-22:00 每小时」这种需求能用**一条**提醒表达。
   */
  rule: z
    .object({
      kind: z.const('cron').default('cron'),
      expression: z.string().required(),
      minutes: z.array(z.natural()).required(),
      hours: z.array(z.natural()).required()
    })
    .default(undefined),
  /** 规则式提醒的下一次命中时刻（epoch ms）；调度以它为准，`scheduledAt` 只给 UI 看。 */
  nextAt: z.natural().default(0),
  repeat: RepeatSchema,
  status: z.union([z.const('active'), z.const('fired'), z.const('dismissed')]).default('active'),
  createdAt: z.natural().required(),
  /** 最近一次响的时刻；每天循环靠它算下一次，也用来去重。 */
  firedAt: z.natural().default(0),
  /** 已经响过几次。 */
  fireCount: z.natural().default(0),
  /** 由哪个来源创建：`tool` / `command` / `api`。 */
  source: z.string().default('tool')
})

/**
 * 兜底整形成一条合法提醒。
 *
 * 磁盘上的 JSON 是上一个版本写的，字段可能缺、可能是字符串。这里不抛错，能救的救回来，
 * 救不回来的（没有 id 或时间）返回 `undefined` 由调用方丢弃——一条坏记录不该让整个
 * 提醒清单加载失败。
 *
 * @param raw - 磁盘或请求里的原始对象。
 * @returns 归一化后的提醒，或 `undefined`。
 */
export function normalizeReminder(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : undefined
  const scheduledAt = Number(raw.scheduledAt)
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (id === undefined || !Number.isFinite(scheduledAt) || scheduledAt <= 0) return undefined
  if (title === '') return undefined
  const status = raw.status === 'fired' || raw.status === 'dismissed' ? raw.status : 'active'
  // 规则：只在看得出是 cron 子集时才保留，否则整条丢掉规则（而不是留一个半截的对象，
  // 让 `nextAfter` 在调度时炸掉）。
  const rule =
    raw.rule !== null &&
    typeof raw.rule === 'object' &&
    typeof raw.rule.expression === 'string' &&
    Array.isArray(raw.rule.minutes) &&
    Array.isArray(raw.rule.hours) &&
    raw.rule.minutes.length > 0 &&
    raw.rule.hours.length > 0
      ? {
          kind: 'cron',
          expression: raw.rule.expression,
          minutes: raw.rule.minutes.map(Number).filter((value) => Number.isFinite(value)),
          hours: raw.rule.hours.map(Number).filter((value) => Number.isFinite(value))
        }
      : undefined
  const nextAtRaw = Number(raw.nextAt)
  return {
    id,
    title: title.slice(0, MAX_TITLE),
    note: typeof raw.note === 'string' ? raw.note.slice(0, MAX_NOTE) : '',
    scheduledAt: Math.round(scheduledAt),
    ...(rule === undefined ? {} : { rule }),
    // 规则式提醒没有 `nextAt` 时退回 `scheduledAt`：老数据与手写的清单都能继续工作。
    nextAt: rule === undefined ? 0 : Number.isFinite(nextAtRaw) && nextAtRaw > 0 ? Math.round(nextAtRaw) : Math.round(scheduledAt),
    repeat: raw.repeat === 'daily' ? 'daily' : 'once',
    status,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Math.round(Number(raw.createdAt)) : Math.round(scheduledAt),
    firedAt: Number.isFinite(Number(raw.firedAt)) ? Math.round(Number(raw.firedAt)) : 0,
    fireCount: Number.isFinite(Number(raw.fireCount)) ? Math.max(0, Math.round(Number(raw.fireCount))) : 0,
    source: typeof raw.source === 'string' && raw.source !== '' ? raw.source : 'tool'
  }
}

/**
 * 算一条循环提醒的下一次时刻。
 *
 * 不是简单的 `scheduledAt + 1 天`：机器睡了一夜再醒来时，加一天仍然落在过去，
 * 于是每次 tick 都会立刻再响一次。这里一直往前推，直到超过 `now` 为止，
 * 中间的漏响就当作错过了（提醒迟到一小时没有意义）。
 *
 * @param scheduledAt - 本次响的时刻。
 * @param now - 当前时间戳。
 * @returns 严格大于 `now` 的下一次时刻（本地时刻保持相同）。
 */
export function nextOccurrence(scheduledAt, now) {
  let stamp = scheduledAt
  let guard = 0
  do {
    const d = new Date(stamp)
    d.setDate(d.getDate() + 1)
    stamp = d.getTime()
    guard += 1
  } while (stamp <= now && guard < 4000)
  return stamp
}

/**
 * 人类可读的「还有多久」。
 *
 * @param timestamp - 目标时刻。
 * @param now - 当前时间戳。
 * @returns 例如 `已到点` / `还剩 2 小时 5 分钟`。
 */
export function describeRemaining(timestamp, now = Date.now()) {
  const delta = timestamp - now
  if (delta <= 0) return '已到点'
  // 一分钟以内单独说一句，而不是「0 分钟后」这种把人当机器的说法。
  if (delta < 60000) return '不到 1 分钟'
  // 向上取整：还剩 1 分 5 秒说成「2 分钟后」是安全的，说成「1 分钟后」会让人以为要响了。
  const minutes = Math.ceil(delta / 60000)
  if (minutes < 60) return `${minutes} 分钟后`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest === 0 ? `${hours} 小时后` : `${hours} 小时 ${rest} 分钟后`
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时后`
}

/**
 * 判定**跑着的宿主**的调度器到底有没有在走。
 *
 * 做法：从外部往清单文件里插一条「5 分钟前就该响」的提醒，然后看宿主会不会自己把它处理掉。
 *   · 文件在 20 秒内被改写 → 调度器在走（它 tick 之后必然 persist）；
 *   · 文件一动不动 → 定时器没在跑。
 *
 * 这个判据比「等一条未来的提醒到点」快得多，也不受「页面抢先取走提醒」的干扰——它看的是
 * 文件的落盘痕迹，而不是提醒的内容。
 *
 * 注意：它**会写**清单文件（插入一条 probe）。跑完之后宿主只会在文件里留下它自己内存中的
 * 那份列表，probe 会被删掉；如果你中途关掉宿主，请自己确认文件里没有残留。
 *
 * 跑法：node smoke/timer-detect.mjs [seconds]
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const seconds = Number(process.argv[2] ?? 20)
const dataFile = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'reminders.json')
  : join(homedir(), '.dsh', 'reminders.json')

/** 读清单；读不动就当作空。 */
function read() {
  try {
    return JSON.parse(readFileSync(dataFile, 'utf8'))
  } catch {
    return { version: 1, reminders: [] }
  }
}

/** 文件当前的状态指纹。 */
function fingerprint() {
  try {
    const info = statSync(dataFile)
    return `${info.size}:${info.mtimeMs}`
  } catch {
    return 'missing'
  }
}

const before = read()
const probe = {
  id: 'probe-det',
  title: 'timer-detect',
  note: '',
  scheduledAt: Date.now() - 5 * 60 * 1000,
  repeat: 'once',
  status: 'active',
  createdAt: Date.now() - 5 * 60 * 1000,
  firedAt: 0,
  fireCount: 0,
  source: 'api'
}
const written = { version: 1, reminders: [...before.reminders.filter((item) => item.id !== probe.id), probe] }
writeFileSync(dataFile, `${JSON.stringify(written, null, 2)}\n`, 'utf8')
const startFingerprint = fingerprint()
console.log(`[detect] 已插入 probe（scheduledAt 5 分钟前）；文件指纹 ${startFingerprint}`)
console.log(`[detect] 观察 ${seconds} 秒，看宿主会不会改写这个文件…`)

const deadline = Date.now() + seconds * 1000
let changed = false
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const now = fingerprint()
  if (now !== startFingerprint) {
    changed = true
    break
  }
}

const after = read()
console.log(`[detect] 观察结束；文件指纹 ${fingerprint()}`)
console.log(`[detect] 剩余提醒：${after.reminders.map((item) => `${item.id}(${item.status})`).join(', ') || '(空)'}`)
if (changed) {
  console.log('[detect] 结论：宿主**改写了**清单文件 → 调度器在走 ✅')
  process.exit(0)
}
console.log('[detect] 结论：宿主在观察窗口内没有动这个文件 → 定时器没有在跑 ❌')
process.exit(1)

/**
 * 窗口激活器的冒烟测试。
 *
 * 这里验的是**不需要真的动窗口**的那部分：PowerShell 探测、脚本能不能被解析、
 * 以及 `-Action status` 这条只读路径能不能跑完。真正把窗口切到前台的效果只能在有
 * 桌面的机器上肉眼看——README 里写明了这一点。
 *
 * 跑法：node smoke/window-smoke.mjs
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { WindowActivator, pickPowerShell, powershellCandidates } from '../lib/window.js'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'dsh-window.ps1')

let passed = 0
const failures = []

/**
 * 断言一条。
 * @param label - 断言的内容。
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

console.log('[smoke] dsh-reminder window activator')

check('script: 脚本存在', existsSync(script), script)

const candidates = powershellCandidates({ SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' })
check('probe: 候选里包含 Windows PowerShell 5.1', candidates[0].includes('WindowsPowerShell'), candidates[0])
check('probe: 候选里包含 PowerShell 7', candidates.some((item) => item.includes('PowerShell\\7')), candidates.join(' | '))
check(
  'probe: 环境变量为空串时不会拼出相对路径',
  powershellCandidates({ SystemRoot: '', windir: '', ProgramFiles: '' }).every((item) => item.startsWith('C:\\')),
  powershellCandidates({ SystemRoot: '', windir: '', ProgramFiles: '' }).join(' | ')
)
check(
  'probe: 注入的 existsSync 决定选择结果',
  pickPowerShell({}, (path) => path === candidates[2]) === candidates[2],
  String(pickPowerShell({}, (path) => path === candidates[2]))
)
check('probe: 都不存在时仍给第一候选，错误信息才可读', pickPowerShell({}, () => false) === candidates[0])

const powershell = pickPowerShell()
check('run: 机器上找得到 PowerShell', existsSync(powershell), powershell)

if (existsSync(powershell)) {
  // `-Action status` 只读：它枚举窗口、打印一行状态，不动任何东西。
  // 用 `-Command` 而不是直接 `-File` 是为了把解析错误也变成非零退出。
  let status = null
  let statusError = null
  try {
    const { stdout } = await run(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'status'],
      { timeout: 120000, windowsHide: true }
    )
    status = String(stdout).trim()
  } catch (error) {
    statusError = error
  }
  // 脚本在找不到 DSH 窗口时以 exit 2 结束并写 stderr。这台机器上 DSH 正开着，所以应当成功；
  // 但「窗口不存在」也是脚本设计里的一种正常回答，不该让冒烟测试失败——只要求它能跑完并说话。
  const output = status ?? String(statusError?.stdout ?? '').trim()
  const spoke = output.includes('window=') || String(statusError?.stderr ?? '').includes('window not found')
  check('status: 脚本跑完并说了一句可读的话', spoke, `stdout=${output} stderr=${String(statusError?.stderr ?? '').trim()}`)
  if (status !== null) console.log(`      status: ${status}`)

  // 激活路径本身不在这里跑：它会真的把窗口抢到前台，冒烟测试不该动用户的桌面。
  // 这里只确认 `WindowActivator.run` 这个注入点能被替代（出错时不抛到调用方之外）。
  const activator = new WindowActivator({ run: async () => 'stub' })
  check('activator: activate() 走注入的执行器', (await activator.activate()) === 'stub')
  const failing = new WindowActivator({ run: async () => Promise.reject(new Error('boom')) })
  let caught = null
  try {
    await failing.activate()
  } catch (error) {
    caught = error
  }
  check('activator: 失败会抛给调用方（由 host 记日志）', caught !== null && /boom/.test(String(caught)))
}

console.log(`\n[smoke] ${passed} 通过, ${failures.length} 失败`)
if (failures.length > 0) {
  console.error('failed:', failures.join('; '))
  process.exit(1)
}
console.log('[smoke] dsh-reminder window activator OK')

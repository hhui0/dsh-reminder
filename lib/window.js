/**
 * 把 DSH 主窗口唤到前台（host 半边）。
 *
 * 为什么需要外部调用：插件两半都够不到宿主窗口（host 是 `ELECTRON_RUN_AS_NODE` 的纯 Node 子
 * 进程，client 在渲染器里），所以由 `scripts/dsh-window.ps1` 用 Win32 把窗口显示出来并置前。
 *
 * 刻意**不做**的事：不改尺寸、不改位置、不记原状态、不需要还原。提醒到点只是要你看见它——
 * 弹窗和声音都在页面里生成。
 *
 * 调 PowerShell 这件事踩过坑，所以写死了三条：
 *   · 可执行文件**探测**而不是拼一个路径：host 的环境变量不保证与交互式 shell 相同；
 *   · 失败时把「可执行文件 + 脚本 + 错误码 + stderr」写进日志文件，HTTP 响应体里也带原文；
 *   · 超时给足 60 秒（PowerShell 冷启动 + Add-Type 编译）。
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 路由前缀。这个插件不对外暴露窗口控制，host 内部直接调用；常量留着是为了自检路由。 */
export const WINDOW_ROUTE = '/dsh-reminder/window'

/** 脚本与本模块同包；打包后 `scripts/` 与 `lib/` 仍是兄弟目录。 */
const scriptPath = () => join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dsh-window.ps1')

/**
 * PowerShell 的候选路径，按优先级排列。
 *
 * 不赌单一来源：host 跑在 Electron 的 Node 模式里，`SystemRoot` 不保证与交互式 shell 一致；
 * PowerShell 7（pwsh）更快且默认 UTF-8，所以 5.1 找不到时就退到它。用 `||` 而不是 `??`：
 * 环境变量存在但为空串时，`??` 会把它当有效值，于是拼出相对路径，spawn 直接 ENOENT。
 * @param env - 环境变量（便于测试注入）。
 * @returns 候选路径，可能存在的排前面。
 */
export function powershellCandidates(env = process.env) {
  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows'
  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  return [
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  ]
}

/**
 * 选一个真实存在的 PowerShell。
 * @param env - 环境变量。
 * @param exists - 存在性判定（便于测试注入）。
 * @returns 选中的可执行文件；一个都不存在时给出第一候选，让调用处的错误信息照旧可读。
 */
export function pickPowerShell(env = process.env, exists = existsSync) {
  const candidates = powershellCandidates(env)
  return candidates.find((candidate) => exists(candidate)) ?? candidates[0]
}

export class WindowActivator {
  /**
   * @param options - `log`、`logFile`（失败时写这里，便于事后查），以及便于测试注入的 `run`。
   */
  constructor({ log = () => {}, logFile, run, timeoutMs = 60000 } = {}) {
    this.log = log
    this.logFile = logFile
    this.timeoutMs = timeoutMs
    this.powershell = pickPowerShell()
    this.run = run ?? ((args) => this.exec(args))
  }

  /** 失败也要留下痕迹：日志文件是事后唯一能查的东西。 */
  record(line) {
    this.log(line)
    if (this.logFile === undefined) return
    try {
      appendFileSync(this.logFile, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      /* 记日志永远不该是失败的原因 */
    }
  }

  /** 默认执行器：把可执行文件、脚本、错误码与 stderr 一起报出来。 */
  exec(args) {
    return new Promise((resolve, reject) => {
      const script = scriptPath()
      execFile(
        this.powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
        { timeout: this.timeoutMs, windowsHide: true },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(String(stdout).trim())
            return
          }
          const code = error.code === undefined ? '' : ` [${String(error.code)}]`
          const detail = String(stderr ?? '').trim().slice(0, 400)
          reject(new Error(`${this.powershell} -File ${script}${code}: ${error.message}${detail === '' ? '' : ` — ${detail}`}`))
        }
      )
    })
  }

  /** 把窗口显示出来并切到前台。窗口已经在前台时，这只是一次廉价的空转。 */
  async activate() {
    try {
      const output = await this.run(['-Action', 'activate'])
      this.log(`window: activated — ${output}`)
      return output
    } catch (error) {
      this.record(`window: activate failed — ${String(error)}`)
      throw error
    }
  }

  /** 自检快照；窗口找不到时不算致命。 */
  async status() {
    try {
      const output = await this.run(['-Action', 'status'])
      return { powershell: this.powershell, output }
    } catch (error) {
      return { powershell: this.powershell, error: String(error) }
    }
  }
}

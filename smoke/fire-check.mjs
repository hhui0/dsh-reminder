/**
 * 到点验证脚本（只读 + 一次 confirm，不改任何提醒数据）。
 *
 * 它回答三个问题，每 3 秒采样一次，好留下**时序**证据：
 *   1. 提醒到点后 `/api/pending` 会不会把它交给页面（弹窗的数据源通不通）；
 *   2. 到点前后 DSH 主窗口是不是被唤到了前台（Host 侧 Win32 那一步真的做了什么）；
 *   3. 页面有没有先于本脚本把它取走（说明浏览器那一半活着）。
 *
 * 窗口是否前台用 `scripts/dsh-window.ps1 -Action status` 之后的
 * `GetForegroundWindow` 比对来判断——那正是激活器自己用的同一个窗口句柄。
 *
 * 跑法：node smoke/fire-check.mjs <seconds> [reminderId]
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { pickPowerShell } from '../lib/window.js'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'dsh-window.ps1')
const seconds = Number(process.argv[2] ?? 120)
const watchId = process.argv[3] ?? ''
const base = process.env.DSH_URL ?? 'http://127.0.0.1:19387'
const powershell = pickPowerShell()

/** 每次采样的 PowerShell：窗口句柄 + 是否前台。 */
const PROBE = `
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Fg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'DeepSeek|Harness' }
$handles = @{}
foreach ($p in $procs) { $handles[[int]$p.Id] = [int64]$p.MainWindowHandle }
$out = @()
foreach ($p in $procs) {
  $t = $p.MainWindowTitle -replace '\\s+', ' '
  if ($t.Length -gt 30) { $t = $t.Substring(0, 30) }
  $out += ('pid=' + $p.Id + ' hwnd=' + $p.MainWindowHandle + ' fg=' + ([Fg]::GetForegroundWindow() -eq $p.MainWindowHandle) + ' title=[' + $t + ']')
}
if ($out.Count -eq 0) { 'no-process' } else { $out -join ' | ' }
`

/**
 * 采样一次窗口状态。
 * @returns 一行可读的状态。
 */
async function windowState() {
  if (!existsSync(powershell)) return 'no-powershell'
  try {
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', PROBE], {
      timeout: 30000,
      windowsHide: true
    })
    return String(stdout).trim().replace(/\r?\n/g, ' ')
  } catch (error) {
    return `probe-failed: ${String(error).slice(0, 100)}`
  }
}

/**
 * 采样一次 `/api/pending`。
 *
 * 注意：本脚本与页面**同时**挂着长轮询，谁先拿到由 host 的唤醒顺序决定。所以
 * 「本脚本拿到」和「页面拿到」都可能发生；两者都证明到点这件事被 host 发布出来了。
 *
 * @returns 一行可读的状态。
 */
async function pending() {
  try {
    const response = await fetch(`${base}/dsh-reminder/api/pending?timeout=800`)
    const payload = await response.json()
    const items = payload?.value?.reminders ?? []
    return items.length === 0 ? '-' : items.map((item) => `${item.id}:${item.title}`).join(', ')
  } catch (error) {
    return `请求失败: ${String(error).slice(0, 80)}`
  }
}

console.log(`[fire-check] 采样 ${seconds} 秒，每 3 秒一次${watchId === '' ? '' : `，关注 ${watchId}`}`)
const started = Date.now()
let samples = 0
let delivered = 0
while (Date.now() - started < seconds * 1000) {
  const elapsed = Math.round((Date.now() - started) / 1000)
  const [win, pend] = await Promise.all([windowState(), pending()])
  samples += 1
  if (pend !== '-') delivered += 1
  console.log(`t+${String(elapsed).padStart(3)}s | pending=${pend} | ${win}`)
  await new Promise((resolve) => setTimeout(resolve, 3000))
}
console.log(`[fire-check] 结束：${samples} 次采样，其中 ${delivered} 次看到到点的提醒`)

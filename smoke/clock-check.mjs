/**
 * 时钟偏差诊断：比较本进程的 `Date.now()` 与宿主 `describe()` 里的 `now`。
 *
 * 为什么单独量这个：`ReminderStore.create` 用**它自己进程的** `Date.now()` 判断
 * 「提醒时间必须晚于现在」，而调度器也用同一个时钟决定「到点了吗」。如果客户端脚本
 * 与宿主进程的时钟差了哪怕几十秒，「10 秒后」这条提醒在宿主看来可能已经是过去时，
 * 于是被当成迟到提醒直接丢掉——表现却是「定时器不响」，非常容易误诊。
 *
 * 跑法：node smoke/clock-check.mjs
 */
const base = process.env.DSH_URL ?? 'http://127.0.0.1:19387'
const rounds = Number(process.argv[2] ?? 5)

const samples = []
for (let index = 0; index < rounds; index += 1) {
  const before = Date.now()
  const response = await fetch(`${base}/dsh-reminder/api/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'describe', args: {} })
  })
  const payload = await response.json()
  const after = Date.now()
  const hostNow = payload?.value?.now
  if (typeof hostNow !== 'number') {
    console.log(`[clock] 第 ${index + 1} 次：宿主没有回 now，payload=${JSON.stringify(payload).slice(0, 200)}`)
    continue
  }
  const local = Math.round((before + after) / 2)
  const skew = hostNow - local
  samples.push(skew)
  console.log(
    `[clock] 第 ${index + 1} 次：host=${new Date(hostNow).toISOString()} local=${new Date(local).toISOString()} skew=${skew}ms`
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
}

if (samples.length > 0) {
  const worst = samples.reduce((acc, value) => (Math.abs(value) > Math.abs(acc) ? value : acc), 0)
  console.log(`[clock] 采样 ${samples.length} 次，最大偏差 ${worst}ms（约 ${(worst / 1000).toFixed(1)} 秒）`)
  console.log(`[clock] 结论：${Math.abs(worst) > 5000 ? '宿主与本机时钟偏差很大，短延时提醒会被当成迟到而丢弃' : '时钟基本一致'}`)
}
process.exit(0)

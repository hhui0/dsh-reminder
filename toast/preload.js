'use strict'

/**
 * 提醒小窗的 preload。
 *
 * 与 `D:\codex_data\electron_demo\reminder-toast-preload.js` 的差别：那个 preload 挂在
 * 应用自己的主进程上，用 `ipcRenderer.on` 收推送、`invoke` 做 ack；这里的进程是 DSH 插件
 * 临时拉起来的，页面需要反过来知道「主进程准备好了吗」以及「窗口该多高」，所以多了
 * `ready` / `resize` / `report` / `snooze` 四个单向或双向通道。
 *
 * 全部走 `contextIsolation` + `contextBridge`，页面拿不到 `require` 或 `ipcRenderer`。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('toastAPI', {
  /** 收提醒。@returns 取消订阅。 */
  onAdd: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('toast:add', listener)
    return () => ipcRenderer.removeListener('toast:add', listener)
  },
  /** 页面挂好监听之后报一声，主进程据此决定什么时候发数据。 */
  ready: () => ipcRenderer.send('toast:ready'),
  /** 内容高度变了，请主进程把窗口调到刚好装下。 */
  resize: (height) => ipcRenderer.send('toast:resize', height),
  /** 卡片被点「收到」之后移掉了。 */
  empty: () => ipcRenderer.send('toast:empty'),
  /** 记录一条诊断（写进主进程的日志）。 */
  report: (line) => ipcRenderer.send('toast:report', String(line)),
  /** 「稍后 N 分钟」：主进程会另起一个进程，把这条提醒推后。 */
  snooze: (minutes) => ipcRenderer.send('toast:snooze', minutes)
})

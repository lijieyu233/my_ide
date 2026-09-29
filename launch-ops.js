// launch-ops.js —— 启动面板的 IPC 通道清单（照 git-ops.js 的模式：通道 → 服务函数只写一处）
// main.js 按这张表生成 handler；preload.js 显式暴露同名分组（sandbox 下的 preload 不能 require 本模块）。
// ⚠ 新增服务函数后记得：① 这张表加一行 ② preload 加一条 —— 漏了不会报错，只在该通道第一次
//   被调用时抛 "xxx is not a function"（git-native.runRetry 就是这么藏了很久）。
module.exports = [
  { ch: 'config', op: 'loadConfig' },
  { ch: 'save', op: 'saveConfig' },
  { ch: 'import', op: 'importFrom' },
  { ch: 'paths', op: 'paths' },
  { ch: 'origin-add', op: 'addOrigin' },
  { ch: 'origin-remove', op: 'removeOrigin' },
  { ch: 'start', op: 'startEntry' },
  { ch: 'stop', op: 'stopEntry' },
  { ch: 'restart', op: 'restartEntry' },
  { ch: 'status', op: 'statusOf' },
  { ch: 'alive', op: 'aliveEntry' },
  { ch: 'logs', op: 'getLogs' },
  { ch: 'clear-logs', op: 'clearLogs' },
  { ch: 'port-check', op: 'checkPort' },
];

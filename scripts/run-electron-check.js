// 跑 Electron 自检脚本的通用包装。
//
// 为什么需要：自检必须在 Electron 主进程里跑（真实窗口 + IPC），
// 而 DSH harness 会设 ELECTRON_RUN_AS_NODE=1，那样 electron.exe 退化成纯 Node、
// app 会是 undefined。必须在子进程环境里清掉它。
//
// 用法：node scripts/run-electron-check.js <脚本文件名> [额外参数...]
const { spawn } = require('child_process');
const path = require('path');

const [, , script, ...rest] = process.argv;
if (!script) { console.error('用法: node scripts/run-electron-check.js <脚本> [参数...]'); process.exit(2); }

const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(__dirname, script), '--disable-gpu', '--no-sandbox', ...rest], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 1));

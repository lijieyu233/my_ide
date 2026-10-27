// 跑远程编辑弹框的端到端自检。
//
// 为什么需要这层包装：自检必须在 Electron 主进程里跑（要真实窗口 + CodeMirror
// + IPC），而且要带 MYIDE_AUTO_TRUST_HOST=1 让主进程自动接受本地 fixture 的
// 主机指纹（否则会弹「确认指纹」模态框，无人点击就挂到 readyTimeout）。
// Windows 下 npm script 里没法直接写 `VAR=x cmd`，所以用这个 Node 包装。
const { spawn } = require('child_process');
const path = require('path');

const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const script = path.join(__dirname, 'check-remote-edit.js');
const env = { ...process.env, MYIDE_AUTO_TRUST_HOST: '1' };
// DSH harness 会设 ELECTRON_RUN_AS_NODE=1，那样 electron.exe 退化成纯 Node，
// app 会是 undefined。必须清掉。
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [script, '--disable-gpu', '--no-sandbox'], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 1));

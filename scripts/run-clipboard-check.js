// 跑剪贴板历史端到端自检（需要在 Electron 主进程里跑，且要清 ELECTRON_RUN_AS_NODE）。
const { spawn } = require('child_process');
const path = require('path');
const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(__dirname, 'check-clipboard.js'), '--disable-gpu', '--no-sandbox'], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 1));

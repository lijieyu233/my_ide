const path = require('path');
const { spawn } = require('child_process');

// 每个参数独立传给程序，避免空格、引号或 shell 元字符改变用户填写的值。
function launch(entry, { spawnProcess = spawn, windowsHide = false } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const child = spawnProcess(entry.target, entry.args || [], {
        cwd: entry.cwd || path.dirname(entry.target), detached: true,
        stdio: 'ignore', shell: false, windowsHide,
      });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
    } catch (err) { reject(err); }
  });
}
module.exports = { launch };

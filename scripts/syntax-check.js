// scripts/syntax-check.js —— 全量语法检查（npm test 前置步骤）
// 背景：main.js 换行转义损坏潜伏多轮未被发现（测试不加载主进程代码）
// 现在任何运行时 JS 语法错误都会让 npm test 直接失败。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// 搜索服务是主进程生产依赖，不能只靠渲染层语法检查覆盖。
const files = ['main.js', 'preload.js', 'git-service.js', 'git-worker.js', 'git-ops.js', 'git-status.js','git-index.js','git-hunks.js', 'git-queue.js', 'file-write.js', 'file-replace-win.js', 'text-format.js', 'path-move.js', 'path-jobs.js', 'path-worker.js', 'path-create.js', 'file-create-win.js', 'copy-journal.js', 'file-copy-win.js'];
files.push('search-service.js', 'task-recovery.js', 'ai-service.js', 'ai-runs.js', 'quick-launch-service.js', 'ai-tool-contract.js', 'ai-tool-execution.js', 'ai-path-lease-win.js');
for (const f of fs.readdirSync(path.join(root, 'renderer'))) {
  if (f.endsWith('.js')) files.push('renderer/' + f);
}
for (const f of fs.readdirSync(path.join(root, 'plugins'))) {
  if (f.endsWith('.js') && !f.startsWith('_')) files.push('plugins/' + f);
}

let fail = 0;
for (const f of files) {
  try {
    new Function(fs.readFileSync(path.join(root, f), 'utf8'));
  } catch (e) {
    fail++;
    console.error('[syntax] FAIL', f, '->', e.message);
  }
}
if (fail) {
  console.error('[syntax] ' + fail + ' 个文件语法错误');
  process.exit(1);
}
console.log('[syntax] ' + files.length + ' 个文件全部通过');

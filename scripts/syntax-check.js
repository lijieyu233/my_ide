// scripts/syntax-check.js —— 全量语法检查（npm test 前置步骤）
// 背景：main.js 换行转义损坏潜伏多轮未被发现（测试不加载主进程代码）
// 现在任何运行时 JS 语法错误都会让 npm test 直接失败。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// 后台按模块递归发现，新增生产依赖不用再手工维护第二份文件清单。
const files = ['main.js', 'preload.js'];
function collect(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = directory + '/' + entry.name;
    if (entry.isDirectory()) collect(file);
    else if (/\.(js|cjs)$/.test(entry.name)) files.push(file);
  }
}
collect('src/main');
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

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

// ── 绿盾透明加密自检 ────────────────────────────────────────────────────
// 这台机器装了 TsdEncryptMF（绿盾），个别文件会被就地加密成 %TSD-Header-###% 密文。
// 危害是静默的：JS 被加密 → new Function 报语法错（上面能拦住）；但 **CSS 被加密
// 时没有任何报错**，浏览器只是解析出 0 条规则，整个界面变白板 —— 实测
// renderer/remote.css 被加密后远程面板完全没有布局（工具栏/终端全挤在底部），
// 排查了半天才发现是文件本身的问题。
// 所以这里把「渲染层所有文本资源」的头字节都看一遍，命中就直接失败并给出解法。
const textAssets = [];
for (const f of files) if (f.startsWith('renderer/') && /\.(js|css|html)$/.test(f)) textAssets.push(f);
for (const f of fs.readdirSync(path.join(root, 'renderer'))) {
  if (/\.(css|html)$/.test(f)) textAssets.push('renderer/' + f);
}
const encrypted = [...new Set(textAssets)].filter(f => {
  try { return fs.readFileSync(path.join(root, f)).subarray(0, 16).toString('latin1').startsWith('%TSD-Header'); }
  catch { return false; }
});
if (encrypted.length) {
  console.error('[syntax] ' + encrypted.length + ' 个渲染资源被绿盾加密（界面会失去样式/逻辑）:');
  for (const f of encrypted) console.error('  - ' + f);
  console.error('  解法：用仓库里记录的管道法恢复（磁盘落盘会被再次加密）：');
  console.error('    git cat-file blob $(git rev-parse HEAD:<file>) | node -e "..." > %LOCALAPPDATA%/Temp/x');
  console.error('    然后 cp 回原路径；或把仓库目录加入绿盾白名单。');
  process.exit(1);
}
console.log('[syntax] ' + files.length + ' 个文件全部通过');

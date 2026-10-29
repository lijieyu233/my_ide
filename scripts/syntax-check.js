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
// 这台机器装了 TsdEncryptMF（绿盾），文件在磁盘上可能是密文，**白名单进程
// （node / git / electron）读到的却是明文**。所以：
//   · bash / coreutils 里 `head` 看到 %TSD-Header 是正常现象，不代表损坏；
//   · 真正要抓的是「损坏」——用恶意方式（cat >> 之类非白名单写入）把密文
//     写进了文件，这时连白名单进程读出来也是乱码，CSS 解析出 0 条规则、
//     界面静默变白板（实测过 renderer/remote.css）。
//
// 因此判据不能只看头 16 字节（透明加密下永远看不到），必须看**内容是否可用**：
//   1. 全文里不能出现 %TSD-Header 标记（真损坏时它会以明文形式留在内容里）；
//   2. 不能有 U+FFFD 替换字符（编码链路坏掉的典型症状，实测一次坏 179 个字符）；
//   3. CSS 必须至少解析出规则块（0 条 = 白板）。
// 2026-10-29：原来只查头 16 字节，对透明加密等于没查。
const textAssets = [...files];
for (const f of fs.readdirSync(path.join(root, 'renderer'))) {
  if (/\.(css|html)$/.test(f)) textAssets.push('renderer/' + f);
}
const damaged = [];
for (const f of [...new Set(textAssets)]) {
  let text;
  try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
  const problems = [];
  // 只看偏移 0：真损坏（密文被写进文件）时内容**以**标记开头；
  // 而 browser-upload / reader-worker / remote-service 这些文件是**正当引用**
  // 这个字符串当守卫常量（检测到密文就拒绝操作），用 includes 会误报它们。
  if (text.startsWith('%TSD-Header')) problems.push('文件内容以 %TSD 密文标记开头（被写坏了）');
  const fffd = (text.match(/\uFFFD/g) || []).length;
  if (fffd) problems.push('含 ' + fffd + ' 个 U+FFFD 替换字符');
  if (/\.css$/.test(f) && !/\{/.test(text)) problems.push('CSS 解析出 0 条规则');
  if (problems.length) damaged.push(f + ' -> ' + problems.join('；'));
}
if (damaged.length) {
  console.error('[syntax] ' + damaged.length + ' 个渲染资源已损坏（界面会失去样式/逻辑）:');
  for (const d of damaged) console.error('  - ' + d);
  console.error('  解法：用管道法从 git 复原（别用 cat >> 追加，会把密文写进文件）：');
  console.error('    git cat-file blob $(git rev-parse HEAD:<file>) | node -e "..." > %LOCALAPPDATA%/Temp/x');
  console.error('    然后 cp 回原路径；或把仓库目录加入绿盾白名单。');
  process.exit(1);
}
console.log('[syntax] ' + files.length + ' 个文件全部通过');

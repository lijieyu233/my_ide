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
// 这台机器装了「天锐绿盾 TSD」透明加密：同一个文件，受信进程（node / python /
// 编辑器）读到明文，不受信进程（PowerShell / 打包后的 exe）读到
// %TSD-Header-###% 开头的密文。**两种结果不同是正常现象，不能据此判断文件损坏。**
//
// 所以：
//   · bash 里 `head` 看到 %TSD-Header 不代表有问题（实测 renderer/remote.css
//     就是这样，node 读出来是完好的 355 条规则）；
//   · 这里查的是「真损坏」——某个非受信进程读到密文后把它**写进了文件**
//     （典型：cat >> / Set-Content），此时连受信进程读出来也是垃圾：
//     CSS 解析 0 条规则、界面静默变白板（实测踩过）。
//
// ⚠ 本段只是「廉价损坏哨兵」，不是 TSD 的权威校验：受信进程可能始终看到明文，
//   真正的加密/解密确认必须走官方工具（npm run shield → OcularDecrypt.exe）。
//   这一点是规范里点名的坑：自己写「检查文件头是不是 %TSD-Header」当最终验证
//   属于**假闸门**。
//
// 判据（看内容是否可用，而不是看头 16 字节）：
//   1. 内容**以** %TSD-Header 开头（密文被写进文件的症状）；
//   2. 不能有 U+FFFD 替换字符（编码链路坏掉的典型症状，实测一次坏 179 个字符）；
//   3. CSS 必须至少解析出规则块（0 条 = 白板）。
// 2026-10-29：原来只查头 16 字节，对透明加密等于没查；覆盖面同时扩到主进程。
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
  console.error('[syntax] ' + damaged.length + ' 个源文件已损坏（界面会失去样式/逻辑）:');
  for (const d of damaged) console.error('  - ' + d);
  console.error('  先用绿盾官方工具做原地检测+解密（本机已接好）：');
  console.error('    npm run shield');
  console.error('  它调用 OcularDecrypt.exe，对仓库原地检测并解密；');
  console.error('  工具找不到时手动指定路径：');
  console.error('    node scripts/decrypt-shield.js <文件或目录>');
  console.error('');
  console.error('  ⚠ 别用 cat >> / PowerShell Set-Content 之类非受信写入去「修补」——');
  console.error('    那些进程会读到密文并把它写进文件，正是这一步造成损坏。');
  console.error('    改文件请用 node / python（受信进程）完成。');
  process.exit(1);
}
console.log('[syntax] ' + files.length + ' 个文件全部通过');

// scripts/decrypt-shield.js —— 用绿的盾官方工具对仓库做「原地检测 + 解密」。
//
// 为什么需要单独的脚本而不是在 npm test 里自动跑：
// 绿盾 TSD 是透明加密，受信进程（node / python / 编辑器）读到的本来就是明文，
// 仓库日常是「看起来正常、存盘却是密文」的状态。自动解密会把每一次 test 都变成
// 写盘操作，没必要；真正需要它的是「打包 / 交付 / 发布前确认无密文残留」这类节点，
// 以及 check:js 报出密文时的修复动作。
//
// 用法：
//   node scripts/decrypt-shield.js            # 处理整个仓库根目录
//   node scripts/decrypt-shield.js <路径>     # 只处理某个文件/目录
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// 工具按「先本机实际路径、再分发版路径」探测：两台机器上位置不一样。
const CANDIDATES = [
  'D:/programfile/Code工作流-完整版/_internal/tools/OcularDecrypt.exe',
  'C:/Users/Administrator/Desktop/Code-工作流(分发版)/_internal/tools/OcularDecrypt.exe',
];

function findTool() {
  for (const p of CANDIDATES) { try { if (fs.statSync(p).isFile()) return p; } catch {} }
  return null;
}

/** 用 node（受信进程）扫描目标下是否仍有密文残留；返回命中列表。 */
function scan(target) {
  const exts = /\.(js|cjs|mjs|css|html|json|md|txt|py)$/i;
  const hits = [];
  const walk = (p) => {
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isFile()) {
      if (!exts.test(p)) return;
      try {
        if (fs.readFileSync(p).subarray(0, 16).toString('latin1').startsWith('%TSD-Header')) hits.push(p);
      } catch {}
      return;
    }
    let list; try { list = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.ui-check-trash') continue;
      walk(path.join(p, e.name));
    }
  };
  walk(target);
  return hits;
}

const tool = findTool();
const target = process.argv[2] ? path.resolve(process.argv[2]) : root;

if (!tool) {
  console.error('[shield] 找不到 OcularDecrypt.exe，已尝试：');
  for (const p of CANDIDATES) console.error('  ' + p);
  process.exit(2);
}

console.log('[shield] 工具：' + tool);
console.log('[shield] 目标：' + target);
console.log('[shield] 解密前用 node 读到密文的文件数：' + scan(target).length);

// 工具支持「文件路径或目录路径」作为参数，执行原地检测和解密。
const run = spawnSync(tool, [target], { stdio: 'inherit' });
if (run.error) { console.error('[shield] 调用失败：' + run.error.message); process.exit(1); }

const left = scan(target);
if (left.length) {
  console.error('[shield] 仍有 ' + left.length + ' 个文件读到密文：');
  for (const f of left) console.error('  ' + f);
  console.error('[shield] 先确认这些文件没有被别的进程占用/只读，再重跑本脚本。');
  process.exit(1);
}
console.log('[shield] 完成：node 视角已无密文残留。');
console.log('[shield] 注意：这只是「受信进程视角」的确认；对外交付前仍应按规范用官方校验再跑一遍。');

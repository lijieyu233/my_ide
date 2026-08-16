// scripts/git-commit.js —— 自主提交脚本（isomorphic-git，不依赖 git CLI）
// 用法: node scripts/git-commit.js "feat: 提交信息"
const git = require('isomorphic-git');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..');
const message = process.argv[2];
if (!message) {
  console.error('用法: node scripts/git-commit.js "提交信息"');
  process.exit(1);
}
const SKIP = ['node_modules', 'demo', 'dist', '.git', '.idea', 'smoke.log'];

(async () => {
  // 1) 收集待提交文件：statusMatrix（自动尊重 .gitignore），过滤 SKIP 前缀
  const matrix = await git.statusMatrix({ fs, dir });
  const files = [];
  for (const [fp, h, w, s] of matrix) {
    if (SKIP.some((k) => fp === k || fp.startsWith(k + '/'))) continue;
    const H = h > 0, W = w > 0, S = s > 0;
    if (H && W && S && h === w && w === s) continue; // unmodified
    files.push(fp);
  }
  if (!files.length) {
    console.log('没有可提交的变更');
    process.exit(0);
  }

  // 2) 暂存（新增/修改 → add；删除 → remove）
  for (const fp of files) {
    const full = path.join(dir, fp);
    if (fs.existsSync(full)) {
      await git.add({ fs, dir, filepath: fp });
    } else {
      await git.remove({ fs, dir, filepath: fp });
    }
  }

  // 3) 提交
  let author;
  try {
    const name = await git.getConfig({ fs, dir, path: 'user.name' });
    const email = await git.getConfig({ fs, dir, path: 'user.email' });
    author = { name: name || 'My IDE Dev', email: email || 'dev@myide.local' };
  } catch {
    author = { name: 'My IDE Dev', email: 'dev@myide.local' };
  }
  const oid = await git.commit({ fs, dir, message, author });
  console.log('✅ 已提交', oid.slice(0, 7), '|', message);
  console.log('   文件:', files.join(', '));
})().catch((e) => { console.error('提交失败:', e.message); process.exit(1); });
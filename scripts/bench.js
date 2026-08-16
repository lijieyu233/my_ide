// scripts/bench.js —— Git 状态扫描性能基准（对照开发大纲基线 <1s / 1 万文件）
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../git-service');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-bench-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);

  console.log('[bench] 构造 5000 文件仓库（构造耗时不计入）...');
  const dirs = ['src', 'docs', 'lib', 'data'];
  let count = 0;
  const tBuild = Date.now();
  for (const d of dirs) fs.mkdirSync(path.join(repo, d));
  for (const d of dirs) {
    for (let i = 0; i < 1250; i++) {
      fs.writeFileSync(path.join(repo, d, 'file' + i + '.txt'), 'line1\nline2\nline3\n');
      count++;
    }
  }
  console.log('[bench] 文件数:', count, '构造耗时:', Date.now() - tBuild, 'ms');

  await G.initRepo(repo);
  const all = ['src', 'docs', 'lib', 'data'].map((d) => d + '/file0.txt');
  const c1 = await G.commit(repo, { message: 'initial', files: all });
  if (!c1.ok) { console.error('初始提交失败:', c1.error); process.exit(1); }
  // 提交其余文件（分目录）
  for (const d of dirs) {
    const files = [];
    for (let i = 1; i < 1250; i++) files.push(d + '/file' + i + '.txt');
    await G.commit(repo, { message: 'add ' + d, files });
  }
  console.log('[bench] 提交完成，仓库就绪');

  // 修改 500 个文件模拟工作区变更
  for (let i = 0; i < 500; i++) {
    fs.appendFileSync(path.join(repo, dirs[i % 4], 'file' + i + '.txt'), 'changed\n');
  }

  // ===== 计时：状态扫描 =====
  const t0 = Date.now();
  const st = await G.status(repo);
  const elapsed = Date.now() - t0;
  console.log('');
  console.log('========== 基准结果 ==========');
  console.log('扫描文件数: ' + count);
  console.log('变更检测: ' + st.changed.length + ' 个文件');
  console.log('status() 耗时: ' + elapsed + ' ms');
  const BUDGET = 1000; // 开发大纲基线 <1s
  console.log('基线对照: ' + (elapsed < BUDGET ? '✅ 达成（<1s）' : '⚠️ 超出基线 ' + BUDGET + 'ms'));
  // 冷启动二次（缓存清理后）
  const t1 = Date.now();
  await G.status(repo);
  console.log('二次扫描耗时: ' + (Date.now() - t1) + ' ms');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('bench 失败:', e); process.exit(1); });
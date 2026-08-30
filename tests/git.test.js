// tests/git.test.js —— git-service 与 diff 算法自测（node tests/git.test.js）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const G = require('../git-service');

let passed = 0, failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ok(name, fn) {
  try { fn(); passed++; console.log('  ok', name); }
  catch (e) { failed++; console.log('  FAIL', name, '->', e.message); }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok', name); }
  catch (e) { failed++; console.log('  FAIL', name, '->', e.message); }
}

console.log('[diffLines 单元测试]');
ok('完全相同的文本 -> 全部上下文', () => {
  const ops = G.diffLines('a\nb\nc\n', 'a\nb\nc\n');
  assert.ok(ops.every((o) => o.type === 'ctx'));
  assert.strictEqual(ops.length, 3);
});
ok('追加行 -> 上下文 + add', () => {
  const ops = G.diffLines('a\nb\n', 'a\nb\nc\n');
  assert.deepStrictEqual(ops.map((o) => o.type), ['ctx', 'ctx', 'add']);
  assert.strictEqual(ops[2].bLine, 2);
});
ok('中间插入 -> ctx + add + ctx', () => {
  const ops = G.diffLines('a\nc\n', 'a\nb\nc\n');
  assert.deepStrictEqual(ops.map((o) => o.type), ['ctx', 'add', 'ctx']);
});
ok('删除行 -> ctx + del + ctx', () => {
  const ops = G.diffLines('a\nb\nc\n', 'a\nc\n');
  assert.deepStrictEqual(ops.map((o) => o.type), ['ctx', 'del', 'ctx']);
  assert.strictEqual(ops[1].aLine, 1);
});
ok('替换行 -> del + add', () => {
  const ops = G.diffLines('a\nX\nc\n', 'a\nY\nc\n');
  assert.deepStrictEqual(ops.map((o) => o.type), ['ctx', 'del', 'add', 'ctx']);
});
ok('旧文本为空 -> 全 add', () => {
  const ops = G.diffLines('', 'x\ny\n');
  assert.ok(ops.every((o) => o.type === 'add'));
  assert.strictEqual(ops.length, 2);
});
ok('新文本为空 -> 全 del', () => {
  const ops = G.diffLines('x\ny\n', '');
  assert.ok(ops.every((o) => o.type === 'del'));
  assert.strictEqual(ops.length, 2);
});
ok('单行无换行符', () => {
  const ops = G.diffLines('hello', 'hello');
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(ops[0].type, 'ctx');
});
ok('尾部无换行 vs 有换行', () => {
  const ops = G.diffLines('a\nb', 'a\nb\n');
  assert.strictEqual(ops.length, 2);
  assert.ok(ops.every((o) => o.type === 'ctx'));
});
ok('多行块替换', () => {
  const oldT = Array.from({ length: 50 }, (_, i) => 'old' + i).join('\n');
  const newT = Array.from({ length: 50 }, (_, i) => 'new' + i).join('\n');
  const ops = G.diffLines(oldT, newT);
  assert.strictEqual(ops.filter((o) => o.type === 'del').length, 50);
  assert.strictEqual(ops.filter((o) => o.type === 'add').length, 50);
});
ok('diff 可完整还原两侧内容', () => {
  const cases = [['a\nb\nc\n', 'a\nB\nc\nd\n'], ['', 'x\n'], ['x\n', ''], ['1\n2\n3\n', '3\n2\n1\n'], ['a\nb', 'a\nb\n']];
  for (const [o, n] of cases) {
    const ops = G.diffLines(o, n);
    const oldLines = [], newLines = [];
    for (const op of ops) {
      if (op.type !== 'add') oldLines.push(G.linesOf(o)[op.aLine]);
      if (op.type !== 'del') newLines.push(G.linesOf(n)[op.bLine]);
    }
    assert.deepStrictEqual(oldLines.join('\n'), G.linesOf(o).join('\n'));
    assert.deepStrictEqual(newLines.join('\n'), G.linesOf(n).join('\n'));
  }
});
ok('buildHunks 带 3 行上下文', () => {
  const oldT = 'a1\na2\na3\na4\na5\na6\na7\na8\na9\na10\n';
  const newT = 'a1\na2\na3\nCHANGED\na5\na6\na7\na8\na9\na10\n';
  const h = G.buildHunks(oldT, newT);
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].rows.filter((r) => r.type === 'add').length, 1);
  assert.ok(h[0].oldStart >= 1);
});
ok('无差异 -> 空 hunks', () => {
  assert.strictEqual(G.buildHunks('x\ny\n', 'x\ny\n').length, 0);
});

ok('topoSortNewestFirst：子提交先于父提交（链条连续）', () => {
  // a ← b ← c（c 最新）；d 从 a 分叉
  const mk = (oid, parents, ts) => ({ oid, parents, timestamp: ts });
  const map = new Map([
    ['c', mk('c', ['b'], 30)],
    ['b', mk('b', ['a'], 20)],
    ['a', mk('a', [], 10)],
    ['d', mk('d', ['a'], 25)],
  ]);
  const out = G.topoSortNewestFirst(map);
  assert.strictEqual(out.length, 4);
  const idx = new Map(out.map((c, i) => [c.oid, i]));
  assert.ok(idx.get('c') < idx.get('b'), 'c 在 b 前');
  assert.ok(idx.get('b') < idx.get('a'), 'b 在 a 前');
  assert.ok(idx.get('d') < idx.get('a'), '分叉的 d 在共同祖先 a 前');
  assert.strictEqual(out[0].oid, 'c', '无子提交且最新的先出');
  assert.strictEqual(out[1].oid, 'd', '同级按时间 d(25) 先于 b(20)');
});

console.log('[git 集成测试]');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-test-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);

(async () => {
  await okAsync('初始化仓库', async () => {
    const r = await G.initRepo(repo);
    assert.strictEqual(r.ok, true);
    const st = await G.status(repo);
    assert.strictEqual(st.isRepo, true);
    assert.strictEqual(st.changed.length, 0);
  });

  await okAsync('首次提交', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2\n');
    const r = await G.commit(repo, { message: 'first commit', files: ['a.txt'] });
    assert.strictEqual(r.ok, true);
    const lg = await G.log(repo);
    assert.strictEqual(lg.commits.length, 1);
    assert.strictEqual(lg.commits[0].message, 'first commit');
    assert.strictEqual(lg.commits[0].author, 'me');
    const st = await G.status(repo);
    assert.strictEqual(st.changed.length, 0, '提交后工作区应干净');
  });

  await okAsync('修改 + 新增文件 -> 状态正确', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2 CHANGED\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new file\n');
    const st = await G.status(repo);
    assert.strictEqual(st.changed.length, 2);
    const a = st.changed.find((c) => c.file === 'a.txt');
    const b = st.changed.find((c) => c.file === 'b.txt');
    assert.ok(['modified', '*modified'].includes(a.status), 'a.txt status = ' + a.status);
    assert.ok(['added', '*added'].includes(b.status), 'b.txt status = ' + b.status);
  });

  await okAsync('工作区 diff：old/new 内容与 hunks', async () => {
    const d = await G.diffWorkdir(repo, path.join(repo, 'a.txt'));
    assert.strictEqual(d.oldText, 'line1\nline2\n');
    assert.strictEqual(d.newText, 'line1\nline2 CHANGED\n');
    assert.ok(d.hunks.length >= 1);
    assert.ok(d.hunks[0].rows.some((r) => r.type === 'del' && r.aText === 'line2'));
    assert.ok(d.hunks[0].rows.some((r) => r.type === 'add' && r.bText === 'line2 CHANGED'));
  });

  await okAsync('部分文件提交（只提交 a.txt）', async () => {
    const r = await G.commit(repo, { message: 'second', files: ['a.txt'] });
    assert.strictEqual(r.ok, true);
    const st = await G.status(repo);
    assert.strictEqual(st.changed.length, 1);
    assert.strictEqual(st.changed[0].file, 'b.txt');
  });

  await okAsync('提交历史顺序', async () => {
    const lg = await G.log(repo);
    assert.strictEqual(lg.commits.length, 2);
    assert.strictEqual(lg.commits[0].message, 'second');
    assert.strictEqual(lg.commits[1].message, 'first commit');
  });

  await okAsync('commitFiles：列出每个提交涉及的文件（含状态）', async () => {
    const lg = await G.log(repo);
    const c2 = await G.commitFiles(repo, lg.commits[0].oid);
    assert.deepStrictEqual(c2.files, [{ file: 'a.txt', status: 'modified' }]);
    const c1 = await G.commitFiles(repo, lg.commits[1].oid);
    assert.deepStrictEqual(c1.files, [{ file: 'a.txt', status: 'added' }]); // 首提交无父 → 全新增
  });

  await okAsync('commit diff：提交 vs 父提交', async () => {
    const lg = await G.log(repo);
    const d = await G.diffCommit(repo, lg.commits[0].oid, 'a.txt');
    assert.strictEqual(d.oldText, 'line1\nline2\n');
    assert.strictEqual(d.newText, 'line1\nline2 CHANGED\n');
  });

  await okAsync('首次提交 diff：父为空 -> 全新增', async () => {
    const lg = await G.log(repo);
    const d = await G.diffCommit(repo, lg.commits[1].oid, 'a.txt');
    assert.strictEqual(d.oldText, '');
    assert.ok(d.hunks[0].rows.every((r) => r.type === 'add'));
  });

  await okAsync('删除文件 diff', async () => {
    fs.unlinkSync(path.join(repo, 'a.txt'));
    const d = await G.diffWorkdir(repo, path.join(repo, 'a.txt'));
    assert.strictEqual(d.newText, '');
    assert.ok(d.hunks[0].rows.every((r) => r.type === 'del'));
    const r = await G.commit(repo, { message: 'remove a', files: ['a.txt'] });
    assert.strictEqual(r.ok, true);
  });

  await okAsync('二进制文件 diff -> binary 标记（不渲染乱码）', async () => {
    const brepo = path.join(tmp, 'bin-repo');
    fs.mkdirSync(brepo);
    await G.initRepo(brepo);
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    fs.writeFileSync(path.join(brepo, 'img.bin'), bin);
    await G.commit(brepo, { message: 'add bin', files: ['img.bin'] });
    fs.writeFileSync(path.join(brepo, 'img.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xff]));
    const d = await G.diffWorkdir(brepo, path.join(brepo, 'img.bin'));
    assert.strictEqual(d.binary, true, '应返回 binary 标记');
    assert.strictEqual(d.hunks, undefined, '二进制不应生成 hunks');
    // diffCommit 同样识别
    const r2 = await G.commit(brepo, { message: 'bin v2', files: ['img.bin'] });
    assert.strictEqual(r2.ok, true);
    const oid = (await G.log(brepo)).commits[0].oid;
    const d2 = await G.diffCommit(brepo, oid, 'img.bin');
    assert.strictEqual(d2.binary, true, 'diffCommit 也应返回 binary 标记');
  });

  await okAsync('amend：合并进上一次提交', async () => {
    const r = await G.commit(repo, { message: 'second v2', files: ['b.txt'], amend: true });
    assert.strictEqual(r.ok, true);
    const lg = await G.log(repo);
    assert.strictEqual(lg.commits.length, 3); // 提交数不增加（替换了最后一个）
    assert.strictEqual(lg.commits[0].message, 'second v2');
    const c = await G.commitFiles(repo, lg.commits[0].oid);
    assert.deepStrictEqual(c.files, [{ file: 'a.txt', status: 'deleted' }, { file: 'b.txt', status: 'added' }]);
    const st = await G.status(repo);
    assert.strictEqual(st.changed.length, 0);
  });

  await okAsync('非仓库目录 -> isRepo false', async () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    const st = await G.status(plain);
    assert.strictEqual(st.isRepo, false);
  });

  await okAsync('子目录文件状态与提交', async () => {
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'sub', 'deep.txt'), 'deep\n');
    const st = await G.status(repo);
    assert.strictEqual(st.changed.length, 1);
    assert.strictEqual(st.changed[0].file, 'sub/deep.txt'.replace(/\//g, path.sep));
    const r = await G.commit(repo, { message: 'add deep', files: ['sub/deep.txt'.replace(/\//g, path.sep)] });
    assert.strictEqual(r.ok, true);
    const d = await G.diffCommit(repo, (await G.log(repo)).commits[0].oid, 'sub/deep.txt'.replace(/\//g, path.sep));
    assert.strictEqual(d.newText, 'deep\n');
  });

  await okAsync('discard：放弃修改恢复到 HEAD / 未跟踪删除', async () => {
    // 已跟踪文件修改后放弃 → 恢复 HEAD 内容
    fs.writeFileSync(path.join(repo, 'sub', 'deep.txt'), 'changed\n');
    const d1 = await G.discard(repo, path.join('sub', 'deep.txt'));
    assert.strictEqual(d1.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(repo, 'sub', 'deep.txt'), 'utf8'), 'deep\n');
    // 未跟踪文件放弃 → 从磁盘删除
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'tmp\n');
    const d2 = await G.discard(repo, 'untracked.txt');
    assert.strictEqual(d2.ok, true);
    assert.strictEqual(fs.existsSync(path.join(repo, 'untracked.txt')), false);
  });

  await okAsync('discardFiles：批量回滚（恢复 + 删除，汇总结果）', async () => {
    fs.writeFileSync(path.join(repo, 'sub', 'deep.txt'), 'changed again\n');
    fs.writeFileSync(path.join(repo, 'tmp2.txt'), 'temp\n');
    const r = await G.discardFiles(repo, [path.join('sub', 'deep.txt'), 'tmp2.txt']);
    assert.strictEqual(r.ok, 2, '两个成功: ' + JSON.stringify(r));
    assert.strictEqual(r.failed.length, 0);
    assert.strictEqual(fs.readFileSync(path.join(repo, 'sub', 'deep.txt'), 'utf8'), 'deep\n', '已跟踪恢复 HEAD');
    assert.strictEqual(fs.existsSync(path.join(repo, 'tmp2.txt')), false, '未跟踪被删除');
    // 空列表不崩
    const r2 = await G.discardFiles(repo, []);
    assert.deepStrictEqual(r2, { ok: 0, failed: [] });
  });

  await okAsync('createBranch：新建并切换分支', async () => {
    const r = await G.createBranch(repo, 'feature');
    assert.strictEqual(r.ok, true);
    const br = await G.branches(repo);
    assert.ok(br.branches.includes('feature'), '分支列表含 feature');
    assert.strictEqual(br.current, 'feature', '已切换到 feature');
    // 切回 main，避免影响后续
    await G.checkout(repo, 'main');
  });

  await okAsync('logGraph：多分支拓扑序 + 分支头映射 + ref 过滤 + 截断', async () => {
    // 制造分叉：feature 上提交 f.txt，main 上提交 g.txt
    await G.checkout(repo, 'feature');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'f\n');
    await G.commit(repo, { message: 'feature work', files: ['f.txt'] });
    await G.checkout(repo, 'main');
    fs.writeFileSync(path.join(repo, 'g.txt'), 'g\n');
    await G.commit(repo, { message: 'main work', files: ['g.txt'] });

    // 所有分支视图
    const lg = await G.logGraph(repo);
    assert.strictEqual(lg.isRepo, true);
    assert.strictEqual(lg.branch, 'main');
    assert.strictEqual(lg.commits.length, 6, '6 个提交全部可见: ' + lg.commits.length);
    // 拓扑序：父提交必须排在子提交之后（链条连续的根因）
    const idx = new Map(lg.commits.map((c, i) => [c.oid, i]));
    for (const c of lg.commits) {
      for (const p of c.parents) {
        if (idx.has(p)) assert.ok(idx.get(p) > idx.get(c.oid), `父 ${p.slice(0, 7)} 应在子 ${c.oid.slice(0, 7)} 之后`);
      }
    }
    const byMsg = Object.fromEntries(lg.commits.map((c) => [c.message, c]));
    assert.ok(idx.get(byMsg['add deep'].oid) > idx.get(byMsg['feature work'].oid), '分叉点在 feature 头之后');
    assert.ok(idx.get(byMsg['add deep'].oid) > idx.get(byMsg['main work'].oid), '分叉点在 main 头之后');
    // 分支头映射（图上徽章数据源）+ HEAD
    assert.deepStrictEqual(lg.branchHeads[byMsg['feature work'].oid], ['feature']);
    assert.deepStrictEqual(lg.branchHeads[byMsg['main work'].oid], ['main']);
    assert.strictEqual(lg.headOid, byMsg['main work'].oid);

    // ref 视图：只看 feature 侧
    const lf = await G.logGraph(repo, 500, 'feature');
    const fMsgs = lf.commits.map((c) => c.message);
    assert.ok(fMsgs.includes('feature work'), 'feature 视图含 feature work');
    assert.ok(!fMsgs.includes('main work'), 'feature 视图不含 main work');
    assert.strictEqual(fMsgs.length, 5, 'feature 侧 5 个提交: ' + fMsgs.join(','));

    // limit 截断
    const lt = await G.logGraph(repo, 2);
    assert.strictEqual(lt.commits.length, 2);
    assert.strictEqual(lt.truncated, true, '截断标记');
  });

  await okAsync('worker 调度链路：init/commit/status', async () => {
    const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-worker-'));
    const call = (op, args) => new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, '..', 'git-worker.js'));
      w.on('message', (m) => { w.terminate(); resolve(m.error ? { error: m.error } : m.result); });
      w.on('error', reject);
      w.postMessage({ id: 1, op, args });
    });
    const r1 = await call('initRepo', [wdir]);
    assert.strictEqual(r1.ok, true);
    fs.writeFileSync(path.join(wdir, 'w.txt'), 'worker\n');
    const r2 = await call('commit', [wdir, { message: 'worker commit', files: ['w.txt'] }]);
    assert.strictEqual(r2.ok, true);
    const r3 = await call('status', [wdir]);
    assert.strictEqual(r3.isRepo, true);
    assert.strictEqual(r3.changed.length, 0);
    fs.rmSync(wdir, { recursive: true, force: true });
  });

  await okAsync('.gitignore：未跟踪被过滤，已跟踪照常显示，否定规则生效', async () => {
    const repo2 = path.join(tmp, 'repo2');
    fs.mkdirSync(repo2);
    await G.initRepo(repo2);
    fs.writeFileSync(path.join(repo2, 'a.txt'), 'v1\n');
    await G.commit(repo2, { message: 'init', files: ['a.txt'] });
    // 规则：.idea/ 目录、*.log、任意层级 build/、否定 !keep.log
    fs.writeFileSync(path.join(repo2, '.gitignore'), '.idea/\n*.log\nbuild/\n!keep.log\n');
    // isomorphic-git statusMatrix 用 mtime 秒级判断修改：同秒内的写入检测不到，跨秒再改
    await new Promise((r) => setTimeout(r, 1100));
    fs.writeFileSync(path.join(repo2, 'a.txt'), 'v2\n'); // 已跟踪文件修改
    fs.mkdirSync(path.join(repo2, '.idea'), { recursive: true });
    fs.writeFileSync(path.join(repo2, '.idea', 'workspace.xml'), 'x');
    fs.writeFileSync(path.join(repo2, 'debug.log'), 'log');
    fs.writeFileSync(path.join(repo2, 'keep.log'), 'keep');
    fs.mkdirSync(path.join(repo2, 'build'), { recursive: true });
    fs.writeFileSync(path.join(repo2, 'build', 'out.js'), 'x');
    fs.mkdirSync(path.join(repo2, 'sub', 'build'), { recursive: true });
    fs.writeFileSync(path.join(repo2, 'sub', 'build', 'nested.js'), 'x');
    fs.writeFileSync(path.join(repo2, 'c.txt'), 'normal\n');
    const st = await G.status(repo2);
    const files = st.changed.map((c) => c.file);
    assert.ok(!files.some((f) => f.replace(/\\/g, '/').startsWith('.idea/')), '.idea/ 被忽略: ' + JSON.stringify(files));
    assert.ok(!files.includes('debug.log'), '*.log 被忽略');
    assert.ok(!files.some((f) => f.replace(/\\/g, '/') === 'build/out.js'), 'build/ 被忽略');
    assert.ok(!files.some((f) => f.replace(/\\/g, '/') === 'sub/build/nested.js'), '任意层级 build/ 被忽略');
    assert.ok(files.includes('keep.log'), '否定规则 !keep.log 保留');
    assert.ok(files.includes('c.txt'), '未忽略的未跟踪文件照常显示');
    assert.ok(files.some((c) => c === 'a.txt' && st.changed.find((x) => x.file === 'a.txt').status.includes('modified')), '已跟踪文件修改不受 .gitignore 影响');
  });

  await okAsync('CRLF 误报：autocrlf 仓库（LF 提交 + CRLF 工作区）不报已修改', async () => {
    // 真实 git 提交时归一化 LF、工作区文件是 CRLF（autocrlf=true 场景）：
    // isomorphic-git 按原始字节比对会把所有 CRLF 文件误报为已修改
    const repo3 = path.join(tmp, 'repo3');
    fs.mkdirSync(repo3);
    await G.initRepo(repo3);
    // 用 LF 内容提交（模拟真实 git 归一化后的仓库）
    fs.writeFileSync(path.join(repo3, 'a.txt'), 'line1\nline2\n', 'utf8');
    fs.mkdirSync(path.join(repo3, 'sub'));
    fs.writeFileSync(path.join(repo3, 'sub', 'b.txt'), 'x\n', 'utf8');
    await G.commit(repo3, { message: 'init', files: ['a.txt', 'sub/b.txt'] });
    // 工作区改写为 CRLF（内容不变）
    fs.writeFileSync(path.join(repo3, 'a.txt'), 'line1\r\nline2\r\n', 'utf8');
    fs.writeFileSync(path.join(repo3, 'sub', 'b.txt'), 'x\r\n', 'utf8');
    const st = await G.status(repo3);
    assert.strictEqual(st.changed.length, 0, 'CRLF-only 差异不报已修改: ' + JSON.stringify(st.changed));
    // 真实修改 + CRLF → 正常报 modified，且 diff 只显示真实改动行
    fs.writeFileSync(path.join(repo3, 'a.txt'), 'line1\r\nline2 CHANGED\r\n', 'utf8');
    const st2 = await G.status(repo3);
    assert.strictEqual(st2.changed.length, 1, '真实修改照常报');
    const d = await G.diffWorkdir(repo3, path.join(repo3, 'a.txt'));
    assert.ok(d.hunks, 'diff 有 hunks');
    const delRows = d.hunks.flatMap((h) => h.rows).filter((r) => r.type === 'del');
    assert.strictEqual(delRows.length, 1, 'CRLF 归一化后 diff 只有 1 行删除（不整文件刷屏）, got ' + delRows.length);
  });

  await okAsync('blame：行级作者归属 + 二次修改归属 + 未提交行', async () => {
    const repo4 = path.join(tmp, 'repo4');
    fs.mkdirSync(repo4);
    await G.initRepo(repo4);
    fs.writeFileSync(path.join(repo4, 'b.txt'), 'l1\nl2\nl3\n');
    await G.commit(repo4, { message: 'first', files: ['b.txt'] });
    const c1 = (await G.log(repo4)).commits[0];
    // 未提交修改：追加两行 → 前 3 行归属 first，后 2 行 uncommitted
    fs.writeFileSync(path.join(repo4, 'b.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    let bl = await G.blame(repo4, 'b.txt');
    assert.strictEqual(bl.lines.length, 5);
    assert.ok(bl.lines.slice(0, 3).every((l) => l.oid === c1.oid), '原 3 行归属 first 提交');
    assert.ok(bl.lines.slice(3).every((l) => l.uncommitted), '新增 2 行归属工作区未提交');
    assert.strictEqual(bl.lines[0].text, 'l1');
    // 提交修改后再改中间行并提交 → 修改行归属新提交，其余不变
    await G.commit(repo4, { message: 'second', files: ['b.txt'] });
    const c2 = (await G.log(repo4)).commits[0];
    fs.writeFileSync(path.join(repo4, 'b.txt'), 'l1\nL2X\nl3\nl4\nl5\n');
    await G.commit(repo4, { message: 'third', files: ['b.txt'] });
    const c3 = (await G.log(repo4)).commits[0];
    bl = await G.blame(repo4, 'b.txt');
    assert.strictEqual(bl.lines.length, 5);
    assert.strictEqual(bl.lines[1].oid, c3.oid, '修改行归属 third 提交');
    assert.ok(bl.lines.slice(3).every((l) => !l.uncommitted), '无未提交行');
    assert.ok([0, 2].every((i) => bl.lines[i].oid === c1.oid), '首次提交的行仍归属 first');
    assert.ok([3, 4].every((i) => bl.lines[i].oid === c2.oid), 'l4/l5 在 second 提交引入，归属 second');
    assert.strictEqual(bl.lines[1].author, c3.author, '行注解带作者');
    assert.ok(bl.lines[1].timestamp > 0, '行注解带时间戳');
  });

  await okAsync('cherry-pick：摘取提交到当前分支（改/增/删文件 + 脏工作区拒绝）', async () => {
    const repo5 = path.join(tmp, 'repo5');
    fs.mkdirSync(repo5);
    await G.initRepo(repo5);
    // 基线：master 上 a.txt
    fs.writeFileSync(path.join(repo5, 'a.txt'), 'base\n');
    await G.commit(repo5, { message: 'base', files: ['a.txt'] });
    // 建分支 feat 改 a.txt + 新增 n.txt + 删 d.txt（先加后删验删除重放）
    fs.writeFileSync(path.join(repo5, 'd.txt'), 'del me\n');
    await G.commit(repo5, { message: 'add d', files: ['d.txt'] });
    await G.createBranch(repo5, 'feat');
    fs.writeFileSync(path.join(repo5, 'a.txt'), 'base\ncherry line\n');
    fs.writeFileSync(path.join(repo5, 'n.txt'), 'new file\n');
    fs.rmSync(path.join(repo5, 'd.txt'));
    await G.commit(repo5, { message: 'feat change', files: ['a.txt', 'n.txt', 'd.txt'] });
    const featC = (await G.log(repo5)).commits[0];
    // 回 main 摘取（initRepo 默认分支是 main）
    await G.checkout(repo5, 'main');
    // 脏工作区（涉及文件）→ 拒绝
    fs.writeFileSync(path.join(repo5, 'a.txt'), 'base\nDIRTY\n');
    let r = await G.cherryPick(repo5, featC.oid);
    assert.ok(!r.ok && /未提交的本地修改/.test(r.error), '涉及文件脏工作区时拒绝摘取');
    await sleep(1200); // 跨秒：绕过 statusMatrix 的 mtime 秒级缓存（同秒写回会复用脏 oid）
    fs.writeFileSync(path.join(repo5, 'a.txt'), 'base\n');
    await sleep(50);
    // 正常摘取
    r = await G.cherryPick(repo5, featC.oid);
    assert.ok(r.ok, '摘取成功: ' + (r.error || ''));
    assert.strictEqual(r.files, 3, '涉及 3 个文件, got ' + r.files);
    assert.strictEqual(fs.readFileSync(path.join(repo5, 'a.txt'), 'utf8'), 'base\ncherry line\n', '修改文件已重放');
    assert.strictEqual(fs.readFileSync(path.join(repo5, 'n.txt'), 'utf8'), 'new file\n', '新增文件已写入');
    assert.ok(!fs.existsSync(path.join(repo5, 'd.txt')), '删除文件已重放');
    // 新提交在 main HEAD，完整消息带 cherry picked 溯源（log.message 只取首行，用 fullMessage 验证）
    const head = (await G.log(repo5)).commits[0];
    assert.ok(head.message.includes('feat change'), '新提交保留原消息');
    assert.ok(head.fullMessage.includes('cherry picked from commit'), '消息带溯源标注');
    // 重复摘取 → 内容一致仍生成新提交（幂等内容）
    await sleep(1200);
    r = await G.cherryPick(repo5, featC.oid);
    assert.ok(r.ok, '重复摘取不报错（生成内容相同的新提交）');
    assert.strictEqual(fs.readFileSync(path.join(repo5, 'a.txt'), 'utf8'), 'base\ncherry line\n', '内容保持一致');
    // cherry-pick 非仓库路径报错
    r = await G.cherryPick(path.join(tmp, '不存在目录'), featC.oid);
    assert.ok(!r.ok, '非仓库路径报错');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('');
  console.log('结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
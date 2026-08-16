// tests/git.test.js —— git-service 与 diff 算法自测（node tests/git.test.js）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const G = require('../git-service');

let passed = 0, failed = 0;
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

  await okAsync('commitFiles：列出每个提交涉及的文件', async () => {
    const lg = await G.log(repo);
    const c2 = await G.commitFiles(repo, lg.commits[0].oid);
    assert.deepStrictEqual(c2.files, ['a.txt']);
    const c1 = await G.commitFiles(repo, lg.commits[1].oid);
    assert.deepStrictEqual(c1.files, ['a.txt']);
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

  await okAsync('amend：合并进上一次提交', async () => {
    const r = await G.commit(repo, { message: 'second v2', files: ['b.txt'], amend: true });
    assert.strictEqual(r.ok, true);
    const lg = await G.log(repo);
    assert.strictEqual(lg.commits.length, 3); // 提交数不增加（替换了最后一个）
    assert.strictEqual(lg.commits[0].message, 'second v2');
    const c = await G.commitFiles(repo, lg.commits[0].oid);
    assert.deepStrictEqual(c.files, ['a.txt', 'b.txt']);
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

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('');
  console.log('结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
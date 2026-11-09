// 独立运行：node tests/git-large-diff.test.js
// 只创建临时仓库；资源基准在独立、96MiB V8 堆限制的进程里测量，不读取真实提交历史。
const assert = require('assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const D = require('../src/main/git/git-line-diff');
const text = (lines, eof = true, eol = '\n') => lines.join(eol) + (eof && lines.length ? eol : '');
const series = n => Array.from({ length: n }, (_, i) => 'line-' + i);
const count = hunks => ({ add: hunks.flatMap(h => h.rows).filter(r => r.type === 'add').length, del: hunks.flatMap(h => h.rows).filter(r => r.type === 'del').length });

if (process.argv.some(arg => arg.startsWith('--bench='))) {
  const scenario = process.argv.find(arg => arg.startsWith('--bench=')).split('=')[1];
  let a, b;
  if (scenario === '50000-small-edit') {
    a = series(50000); b = a.slice(); b.splice(17000, 0, 'new-a', 'new-b', 'new-c'); b.splice(43003, 0, 'new-d', 'new-e', 'new-f');
  } else if (scenario === '4000-all-change') {
    a = series(4000); b = a.map(line => 'replacement-' + line);
  } else throw Error('Unknown benchmark');
  const oldText = text(a), newText = text(b);
  if (global.gc) global.gc();
  const before = process.memoryUsage(), start = performance.now();
  const ops = D.diffLines(oldText, newText), hunks = D.buildHunks(oldText, newText);
  const elapsedMs = performance.now() - start, after = process.memoryUsage();
  console.log(JSON.stringify({ scenario, elapsedMs: +elapsedMs.toFixed(2), peakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(2), heapDeltaMiB: +((after.heapUsed - before.heapUsed) / 1048576).toFixed(2), arrayBuffersDeltaMiB: +((after.arrayBuffers - before.arrayBuffers) / 1048576).toFixed(2), tracePeakBytes: ops.stats.tracePeakBytes, work: ops.stats.work, ...count(hunks), incomplete: hunks.some(h => h.incomplete) }));
} else {
  const G = require('../src/main/git/git-service'), git = require('isomorphic-git');
  let passed = 0;
  async function check(name, fn) { await fn(); passed++; console.log('  ok ' + name); }

  function verifyOps(oldText, newText) {
    const a = D.linesOf(oldText), b = D.linesOf(newText), ops = D.diffLines(oldText, newText), old = [], next = [];
    for (const op of ops) {
      assert(['ctx', 'del', 'add'].includes(op.type));
      if (op.type !== 'add') { assert.equal(op.aLine, old.length, '旧行必须逐行连续覆盖'); old.push(a[op.aLine]); }
      if (op.type !== 'del') { assert.equal(op.bLine, next.length, '新行必须逐行连续覆盖'); next.push(b[op.bLine]); }
      if (op.type === 'ctx') assert.equal(a[op.aLine], b[op.bLine], 'ctx 必须真实相等，不能只检查重构后碰巧一致');
    }
    assert.equal(text(old, ops.oldEof), oldText, '完整旧原文（包括CR与末尾LF）');
    assert.equal(text(next, ops.newEof), newText, '完整新原文（包括CR与末尾LF）');
    assert(ops.stats.tracePeakBytes <= D._test.limits.traceCells * 4);
    assert(ops.stats.work <= D._test.limits.work + 1);
    return ops;
  }

  function verifyHunks(oldText, newText, hunks = D.buildHunks(oldText, newText)) {
    const a = D.linesOf(oldText), b = D.linesOf(newText);
    let oldCursor = 0, newCursor = 0;
    const old = [], next = [];
    for (const h of hunks) {
      const aStart = h.oldStart - 1, bStart = h.newStart - 1;
      assert(aStart >= oldCursor && bStart >= newCursor, '块不能交叠或逆序');
      const oldGap = a.slice(oldCursor, aStart), newGap = b.slice(newCursor, bStart);
      assert.deepEqual(oldGap, newGap, '块之间被省略的正文必须真实相同');
      old.push(...oldGap); next.push(...newGap);
      let oldCount = 0, newCount = 0;
      for (const row of h.rows) {
        assert(['ctx', 'del', 'add', 'unresolved'].includes(row.type));
        if (row.aNum) {
          assert.equal(row.aNum, aStart + ++oldCount); assert.equal(row.aText, a[row.aNum - 1]); old.push(row.aText);
          assert.equal(!!row.aNoNewline, row.aNum === a.length && !oldText.endsWith('\n'));
        }
        if (row.bNum) {
          assert.equal(row.bNum, bStart + ++newCount); assert.equal(row.bText, b[row.bNum - 1]); next.push(row.bText);
          assert.equal(!!row.bNoNewline, row.bNum === b.length && !newText.endsWith('\n'));
        }
        if (row.type === 'ctx') { assert(row.aNum && row.bNum); assert.equal(row.aText, row.bText); }
        if (row.type === 'unresolved') assert(h.incomplete && h.coarse && h.readOnlyReason && h.reasonCode === 'DIFF_COMPLEXITY_LIMIT');
      }
      assert.equal(oldCount, h.oldLines); assert.equal(newCount, h.newLines);
      oldCursor = aStart + oldCount; newCursor = bStart + newCount;
    }
    assert.deepEqual(a.slice(oldCursor), b.slice(newCursor), '最后一块之后不能偷偷遗漏变化');
    old.push(...a.slice(oldCursor)); next.push(...b.slice(newCursor));
    assert.equal(text(old, oldText.endsWith('\n')), oldText);
    assert.equal(text(next, newText.endsWith('\n')), newText);
    if (oldText.endsWith('\n') !== newText.endsWith('\n')) assert(hunks.some(h => h.eofChanged && h.readOnlyReason), 'EOF-only不能被误判无变化');
    return hunks;
  }

  function applyAll(oldText, newText) {
    const hunks = verifyHunks(oldText, newText);
    let actual = oldText;
    // 后向应用保证前块坐标不受后块插删影响，同时实测与真实块操作相同的拼接函数。
    for (const hunk of hunks.slice().reverse()) { const applied = G.applyHunkToText(actual, hunk, false); assert(applied.ok, applied.error); actual = applied.text; }
    assert.equal(actual, newText, '全部精确hunk应能重构新原文，而不是只验证计数');
  }

  function editDistance(a, b) {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? previous[j - 1] : Math.min(previous[j], row[j - 1]) + 1;
      previous = row;
    }
    return previous[b.length];
  }

  (async () => {
    await check('4712行只新增6行保持+6/-0，不整份coarse', () => {
      const a = series(4712), b = a.slice(); b.splice(2500, 0, ...series(6).map(s => 'insert-' + s));
      const old = text(a), next = text(b), hunks = verifyHunks(old, next);
      verifyOps(old, next); assert.deepEqual(count(hunks), { add: 6, del: 0 }); assert(hunks.every(h => !h.coarse)); applyAll(old, next);
    });
    await check('50000行两处相距很远的小改分块且上下文连续', () => {
      const a = series(50000), b = a.slice(); b[7] = 'changed-near-start'; b[49991] = 'changed-near-end';
      const old = text(a), next = text(b), hunks = verifyHunks(old, next);
      verifyOps(old, next); assert.equal(hunks.length, 2); assert.deepEqual(count(hunks), { add: 2, del: 2 }); applyAll(old, next);
    });
    await check('大文件首尾删除不制造整份替换，行号正确', () => {
      const a = series(6000), old = text(a), next = text(a.slice(2, -3)), hunks = verifyHunks(old, next);
      verifyOps(old, next); assert.equal(hunks.length, 2); assert.deepEqual(count(hunks), { add: 0, del: 5 }); applyAll(old, next);
    });
    await check('大量同名重复行与交替重复行小改仍精确', () => {
      const cases = [Array(7000).fill('same'), Array.from({ length: 7000 }, (_, i) => i % 2 ? 'odd' : 'even')];
      for (const a of cases) { const b = a.slice(); b.splice(1234, 0, 'unique-one', 'unique-two'); b.splice(6300, 1); const old = text(a), next = text(b); verifyOps(old, next); assert.deepEqual(count(verifyHunks(old, next)), { add: 2, del: 1 }); applyAll(old, next); }
    });
    await check('同一hunk两处修改之间ctx不能丢失', () => {
      const a = series(30), b = a.slice(); b[10] = 'change-a'; b[15] = 'change-b';
      const old = text(a), next = text(b), hunks = verifyHunks(old, next);
      assert.equal(hunks.length, 1); assert(hunks[0].rows.some(r => r.type === 'ctx' && r.aText === 'line-12')); applyAll(old, next);
    });
    await check('纯插入块前后上下文不因aLine未定义消失', () => {
      const a = series(20), b = a.slice(); b.splice(9, 0, 'new'); const hunks = verifyHunks(text(a), text(b));
      assert.equal(hunks[0].rows.filter(r => r.type === 'ctx').length, 6); applyAll(text(a), text(b));
    });
    await check('CRLF字节、空行与缺末尾换行完整重构', () => {
      const a = series(5000); a[12] = ''; const b = a.slice(); b.splice(2500, 0, '中文新增', '');
      for (const eol of ['\n', '\r\n']) for (const eof of [true, false]) { const old = text(a, eof, eol), next = text(b, eof, eol); verifyOps(old, next); verifyHunks(old, next); applyAll(old, next); }
    });
    await check('EOF-only与文字+EOF变化显式标识且不冒充无变化', () => {
      for (const [old, next] of [['a\nb', 'a\nb\n'], ['a\nb\n', 'a\nb'], ['a\nb', 'A\nb\n'], ['', '\n'], ['\n', '']]) {
        verifyOps(old, next); const hunks = verifyHunks(old, next); assert(hunks.some(h => h.eofChanged)); assert(hunks.some(h => h.reasonCode === 'EOF_CHANGE_UNSUPPORTED'));
      }
      assert.deepEqual(D.diffLines('a\nb', 'a\nb\n').map(op => op.type), ['ctx', 'ctx'], '保留已有逐行API兼容性');
    });
    await check('4000全不同行由不相交证明得到精确+4000/-4000，无trace爆炸', () => {
      const a = series(4000), b = a.map(s => 'all-new-' + s), old = text(a), next = text(b), ops = verifyOps(old, next), hunks = verifyHunks(old, next);
      assert.equal(ops.stats.tracePeakBytes, 0); assert.deepEqual(count(hunks), { add: 4000, del: 4000 }); assert(hunks.every(h => !h.coarse)); applyAll(old, next);
    });
    await check('预算耗尽只标未决重复段，保留其他确切新增，不伪造ctx/增删', () => {
      const prefix = series(10), repeatA = [...Array(200).fill('A'), ...Array(200).fill('B')], repeatB = [...Array(200).fill('B'), ...Array(200).fill('A')], tail = series(100).map(s => 'tail-' + s);
      const old = text([...prefix, ...repeatA, 'stable-anchor', ...tail, 'end']), next = text([...prefix, ...repeatB, 'stable-anchor', ...tail, 'new-tail', 'end']);
      const hunks = D._test.buildHunks(old, next, 3, { distance: 0, traceCells: 0 }); verifyHunks(old, next, hunks);
      const unresolved = hunks.filter(h => h.incomplete); assert.equal(unresolved.length, 1); assert.equal(unresolved[0].oldStart, 11); assert.equal(unresolved[0].oldLines, 400); assert(unresolved[0].rows.every(r => r.type === 'unresolved')); assert.deepEqual(count(hunks), { add: 1, del: 0 });
    });
    await check('生产复杂度预算对病态重复内容返回明确未决，逐行API拒绝假归因', () => {
      const old = text([...Array(1800).fill('A'), ...Array(1800).fill('B')]), next = text([...Array(1800).fill('B'), ...Array(1800).fill('A')]);
      const start = performance.now(), hunks = verifyHunks(old, next);
      assert.equal(hunks.length, 1); assert(hunks[0].incomplete); assert.deepEqual(count(hunks), { add: 0, del: 0 }); assert.throws(() => D.diffLines(old, next), { code: 'DIFF_COMPLEXITY_LIMIT' }); assert(performance.now() - start < 5000);
    });
    await check('正常small最短编辑距离、真实ctx与完整文本随机重构属性(600组)', () => {
      let seed = 918273;
      const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
      for (let run = 0; run < 600; run++) {
        const a = Array.from({ length: random(25) }, () => ['A', 'B', '', '中文', 'D'][random(5)]), b = Array.from({ length: random(25) }, () => ['A', 'B', '', '中文', 'D'][random(5)]);
        const eof = !!random(2), old = text(a, eof), next = text(b, eof), ops = verifyOps(old, next);
        assert.equal(ops.filter(op => op.type !== 'ctx').length, editDistance(D.linesOf(old), D.linesOf(next)), 'small必须最短编辑路径');
        verifyHunks(old, next);
        if (old.endsWith('\n') === next.endsWith('\n')) applyAll(old, next);
      }
    });
    await check('大段稳定锚点重排与重复行混合的重构属性(60组)', () => {
      let seed = 192837;
      const random = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
      for (let run = 0; run < 60; run++) {
        const a = Array.from({ length: 300 }, (_, i) => i % 13 === 0 ? 'anchor-' + i : 'repeat-' + random(7));
        const b = a.slice();
        for (let k = 0; k < 20; k++) { const at = random(b.length); b.splice(at, random(3), 'insert-' + run + '-' + k); }
        if (run % 2) b.splice(100, 90, ...b.slice(100, 190).reverse());
        const old = text(a), next = text(b); verifyOps(old, next); verifyHunks(old, next); applyAll(old, next);
      }
    });
    await check('不同ctx预算的hunk都保留完整正文与稳定行号', () => {
      const a = series(40), b = a.slice(); b.splice(0, 0, 'first'); b.splice(9, 2); b[15] = 'middle'; b.push('last');
      for (const ctx of [0, 1, 3, 8, 100]) verifyHunks(text(a), text(b), D.buildHunks(text(a), text(b), ctx));
    });
    await check('diffCommit临时真实提交接入一次算法，大文件/EOF/未决元数据正确', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-large-diff-'));
      try {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('myide-large-diff-'));
        await git.init({ fs, dir: root, defaultBranch: 'main' });
        const author = { name: 'Fixture', email: 'fixture@example.invalid' };
        const save = async value => { fs.writeFileSync(path.join(root, 'large.txt'), value); await git.add({ fs, dir: root, filepath: 'large.txt' }); return git.commit({ fs, dir: root, message: 'fixture only', author }); };
        const a = series(4712), b = a.slice(); b.splice(2500, 0, ...series(6).map(s => 'new-' + s));
        await save(text(a)); const changed = await save(text(b)), result = await G.diffCommit(root, changed, 'large.txt');
        assert(!result.error, JSON.stringify(result)); assert.equal(result.completeness, 'complete'); assert.deepEqual(count(result.hunks), { add: 6, del: 0 }); verifyHunks(text(a), text(b), result.hunks);
        const eof = await save(text(b, false)), eofDiff = await G.diffCommit(root, eof, 'large.txt'); assert.equal(eofDiff.reasonCode, 'EOF_CHANGE_UNSUPPORTED'); assert(eofDiff.hunks.some(h => h.eofChanged));
        const old = text([...Array(1800).fill('A'), ...Array(1800).fill('B')]), next = text([...Array(1800).fill('B'), ...Array(1800).fill('A')]);
        await save(old); const pathological = await save(next), partial = await G.diffCommit(root, pathological, 'large.txt'); assert.equal(partial.completeness, 'incomplete'); assert.equal(partial.reasonCode, 'DIFF_COMPLEXITY_LIMIT'); assert.equal(partial.unresolvedRanges.length, 1); assert(partial.readOnlyReason); assert.deepEqual(count(partial.hunks), { add: 0, del: 0 }); verifyHunks(old, next, partial.hunks);
      } finally {
        if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('myide-large-diff-')) throw Error('Unsafe cleanup');
        await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    });
    await check('独立进程time/memory基准：50000小改与4000全改均资源有界', () => {
      for (const scenario of ['50000-small-edit', '4000-all-change']) {
        const child = cp.spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=96', __filename, '--bench=' + scenario], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        assert.equal(child.status, 0, child.stderr || child.error?.message); const result = JSON.parse(child.stdout.trim());
        console.log('  benchmark ' + JSON.stringify(result)); assert(result.elapsedMs < 5000, '算法耗时不得秒级失控'); assert(result.peakRssMiB < 180, '峰值RSS必须远低于旧trace约488MiB'); assert(result.tracePeakBytes <= D._test.limits.traceCells * 4); assert.equal(result.incomplete, false);
        assert.deepEqual({ add: result.add, del: result.del }, scenario === '50000-small-edit' ? { add: 6, del: 0 } : { add: 4000, del: 4000 });
      }
    });
    console.log('大文件差异结果: ' + passed + ' 通过, 0 失败');
  })().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

// 行数不是复杂度：五万行插入几行仍应精确，重复行的高编辑距离才需要预算。
// trace 只保留当前 d 的有效对角线；原实现每层复制 2*(N+M)，4k 全改会占约 488MiB。
const LIMITS = Object.freeze({ work: 2000000, traceCells: 1048576, distance: 1024 });

function linesOf(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function limitedMyers(a, b, a0, a1, b0, b1, budget) {
  const n = a1 - a0, m = b1 - b0, trace = [];
  let cells = 0;
  for (let d = 0; d <= n + m && d <= budget.limits.distance; d++) {
    if (cells + d + 1 > budget.limits.traceCells) return null;
    const row = new Int32Array(d + 1), prev = trace[d - 1];
    cells += row.length;
    budget.tracePeakBytes = Math.max(budget.tracePeakBytes, cells * 4);
    for (let j = 0; j <= d; j++) {
      if (++budget.work > budget.limits.work) return null;
      const k = 2 * j - d;
      let x = d === 0 ? 0 : j === 0 || (j !== d && prev[j - 1] < prev[j]) ? prev[j] : prev[j - 1] + 1;
      let y = x - k;
      while (x < n && y < m && x >= 0 && y >= 0) {
        if (++budget.work > budget.limits.work) return null;
        if (a[a0 + x] !== b[b0 + y]) break;
        x++; y++;
      }
      row[j] = x;
      if (x < n || y < m) continue;
      trace.push(row);
      const ops = [];
      x = n; y = m;
      for (let level = d; level > 0; level--) {
        const diag = x - y, index = (diag + level) / 2, before = trace[level - 1];
        const down = index === 0 || (index !== level && before[index - 1] < before[index]);
        const prevX = down ? before[index] : before[index - 1];
        const prevY = prevX - (down ? diag + 1 : diag - 1);
        while (x > prevX && y > prevY) ops.push({ type: 'ctx', aLine: a0 + --x, bLine: b0 + --y });
        if (down) ops.push({ type: 'add', bLine: b0 + --y });
        else ops.push({ type: 'del', aLine: a0 + --x });
      }
      while (x > 0 && y > 0) ops.push({ type: 'ctx', aLine: a0 + --x, bLine: b0 + --y });
      ops.reverse();
      return ops;
    }
    trace.push(row);
  }
  return null;
}

// 两侧都唯一的行才是稳定锚点；Map 按真实字符串比较，不以可能碰撞的哈希证明相等。
function patienceAnchors(a, b, a0, a1, b0, b1, budget) {
  if (budget.work + a1 - a0 + b1 - b0 > budget.limits.work) return null;
  const old = new Map(), next = new Map();
  for (let i = a0; i < a1; i++) { budget.work++; old.set(a[i], old.has(a[i]) ? -1 : i); }
  let shared = false;
  for (let i = b0; i < b1; i++) {
    budget.work++;
    if (old.has(b[i])) shared = true;
    next.set(b[i], next.has(b[i]) ? -1 : i);
  }
  if (!shared) return { disjoint: true, anchors: [] };
  const pairs = [];
  for (const [text, i] of old) {
    if (++budget.work > budget.limits.work) return null;
    const j = next.get(text);
    if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j]);
  }
  const tails = [], previous = new Int32Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      if (++budget.work > budget.limits.work) return null;
      const mid = (lo + hi) >>> 1;
      if (pairs[tails[mid]][1] < pairs[i][1]) lo = mid + 1;
      else hi = mid;
    }
    if (lo) previous[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const anchors = [];
  for (let i = tails.at(-1); i !== undefined && i >= 0; i = previous[i]) anchors.push(pairs[i]);
  anchors.reverse();
  return { disjoint: false, anchors };
}

function calculate(aText, bText, limits = LIMITS) {
  const a = linesOf(aText), b = linesOf(bText), ops = [];
  const budget = { limits, work: 0, tracePeakBytes: 0 }, pending = [{ a0: 0, a1: a.length, b0: 0, b1: b.length }];
  const context = (a0, b0, count) => { for (let i = 0; i < count; i++) ops.push({ type: 'ctx', aLine: a0 + i, bLine: b0 + i }); };
  const unresolved = (a0, a1, b0, b1) => ops.push({ type: 'unresolved', a0, a1, b0, b1, reasonCode: 'DIFF_COMPLEXITY_LIMIT' });
  while (pending.length) {
    const task = pending.pop();
    if (task.count !== undefined) { context(task.a0, task.b0, task.count); continue; }
    let { a0, a1, b0, b1 } = task;
    // 首尾裁剪始终线性，预算耗尽也不把已经确证的公共边界伪报为替换。
    const startA = a0, startB = b0;
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { a0++; b0++; }
    context(startA, startB, a0 - startA);
    let suffix = 0;
    while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) { a1--; b1--; suffix++; }
    if (suffix) pending.push({ a0: a1, b0: b1, count: suffix });
    if (a0 === a1 || b0 === b1) {
      for (let i = a0; i < a1; i++) ops.push({ type: 'del', aLine: i });
      for (let i = b0; i < b1; i++) ops.push({ type: 'add', bLine: i });
      continue;
    }
    // 小段仍走最短编辑路径，避免 patience 改变既有小文件/重复行的对齐选择。
    if (a1 - a0 + b1 - b0 <= 256) {
      const exact = limitedMyers(a, b, a0, a1, b0, b1, budget);
      if (exact) { for (const op of exact) ops.push(op); continue; }
      unresolved(a0, a1, b0, b1); continue;
    }
    const partition = patienceAnchors(a, b, a0, a1, b0, b1, budget);
    if (!partition) { unresolved(a0, a1, b0, b1); continue; }
    if (partition.disjoint) {
      for (let i = a0; i < a1; i++) ops.push({ type: 'del', aLine: i });
      for (let i = b0; i < b1; i++) ops.push({ type: 'add', bLine: i });
    } else if (partition.anchors.length) {
      // 显式栈避免恶意锚点分布导致递归栈溢出；每个 ctx 必须对应真实相等的两行。
      const anchors = partition.anchors;
      pending.push({ a0: anchors.at(-1)[0] + 1, a1, b0: anchors.at(-1)[1] + 1, b1 });
      for (let i = anchors.length - 1; i >= 0; i--) {
        const [x, y] = anchors[i], previous = anchors[i - 1];
        pending.push({ a0: x, b0: y, count: 1 });
        pending.push({ a0: previous ? previous[0] + 1 : a0, a1: x, b0: previous ? previous[1] + 1 : b0, b1: y });
      }
    } else {
      const exact = limitedMyers(a, b, a0, a1, b0, b1, budget);
      if (exact) for (const op of exact) ops.push(op);
      else unresolved(a0, a1, b0, b1);
    }
  }
  return { a, b, ops, oldEof: aText.endsWith('\n'), newEof: bText.endsWith('\n'), stats: { work: budget.work, tracePeakBytes: budget.tracePeakBytes } };
}

function diffLines(aText, bText) {
  const result = calculate(aText, bText);
  if (result.ops.some(op => op.type === 'unresolved')) {
    throw Object.assign(Error('行差异超过资源预算，重复内容未能精确对齐'), { code: 'DIFF_COMPLEXITY_LIMIT' });
  }
  // 保留逐行 API 忽略 EOF 的兼容行为；元数据允许调用方进行完整原文重构而非只比较 join('\n')。
  Object.defineProperties(result.ops, {
    oldEof: { value: result.oldEof }, newEof: { value: result.newEof }, stats: { value: result.stats },
  });
  return result.ops;
}

function hunksFrom(result, ctx) {
  const { a, b, oldEof, newEof } = result, ops = result.ops.slice();
  ctx = Number.isFinite(ctx) ? Math.max(0, Math.floor(ctx)) : 3;
  const eofChanged = oldEof !== newEof;
  // 仅末尾换行变化不能被吞成「无变更」；行API保持兼容，展示API显式给出最后行两侧。
  if (eofChanged && ops.at(-1)?.type === 'ctx') {
    const last = ops.pop();
    ops.push({ type: 'del', aLine: last.aLine }, { type: 'add', bLine: last.bLine });
  }
  const oldBefore = new Uint32Array(ops.length + 1), newBefore = new Uint32Array(ops.length + 1);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    oldBefore[i + 1] = oldBefore[i] + (op.type === 'unresolved' ? op.a1 - op.a0 : op.type !== 'add' ? 1 : 0);
    newBefore[i + 1] = newBefore[i] + (op.type === 'unresolved' ? op.b1 - op.b0 : op.type !== 'del' ? 1 : 0);
  }
  const hunks = [];
  function row(op) {
    const hasA = op.aLine !== undefined, hasB = op.bLine !== undefined;
    const value = { type: op.type, aText: hasA ? a[op.aLine] : '', bText: hasB ? b[op.bLine] : '', aNum: hasA ? op.aLine + 1 : 0, bNum: hasB ? op.bLine + 1 : 0 };
    if (hasA && op.aLine === a.length - 1 && !oldEof) value.aNoNewline = true;
    if (hasB && op.bLine === b.length - 1 && !newEof) value.bNoNewline = true;
    return value;
  }
  function markEof(hunk) {
    if (eofChanged && (hunk.oldStart - 1 + hunk.oldLines === a.length || hunk.newStart - 1 + hunk.newLines === b.length)) {
      hunk.eofChanged = true; hunk.oldEof = oldEof; hunk.newEof = newEof;
      if (!hunk.incomplete) hunk.reasonCode = 'EOF_CHANGE_UNSUPPORTED';
      hunk.readOnlyReason = hunk.readOnlyReason || '末尾换行变化暂不支持按块写入，请按整份文件处理';
    }
    return hunk;
  }
  function exactSegment(lo, hi) {
    const windows = [];
    for (let i = lo; i < hi; i++) {
      if (ops[i].type === 'ctx') continue;
      const start = Math.max(lo, i - ctx), end = Math.min(hi, i + ctx + 1), last = windows.at(-1);
      if (last && start <= last[1]) last[1] = end;
      else windows.push([start, end]);
    }
    for (const [start, end] of windows) {
      // 按连续操作区间截取，包括中间 ctx。旧实现只保留 changeIdx，会丢正文并无法重构。
      hunks.push(markEof({ oldStart: oldBefore[start] + 1, oldLines: oldBefore[end] - oldBefore[start], newStart: newBefore[start] + 1, newLines: newBefore[end] - newBefore[start], rows: ops.slice(start, end).map(row) }));
    }
  }
  let lo = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type !== 'unresolved') continue;
    exactSegment(lo, i);
    const rows = [];
    for (let k = 0; k < Math.max(op.a1 - op.a0, op.b1 - op.b0); k++) {
      rows.push(row({ type: 'unresolved', ...(op.a0 + k < op.a1 ? { aLine: op.a0 + k } : {}), ...(op.b0 + k < op.b1 ? { bLine: op.b0 + k } : {}) }));
    }
    const reason = '重复内容的精确对齐超过资源预算；仅此区间未决，不计入精确增删行数';
    hunks.push(markEof({ oldStart: op.a0 + 1, oldLines: op.a1 - op.a0, newStart: op.b0 + 1, newLines: op.b1 - op.b0, rows, coarse: true, incomplete: true, reasonCode: op.reasonCode, reason, readOnlyReason: reason }));
    lo = i + 1;
  }
  exactSegment(lo, ops.length);
  return hunks;
}

function buildHunks(aText, bText, ctx = 3) { return hunksFrom(calculate(aText, bText), ctx); }

// 测试只能收紧固定生产预算，不能通过调用参数把生产 Myers 变回无界 trace。
const _test = Object.freeze({ limits: LIMITS, buildHunks(aText, bText, ctx, limits) {
  const reduced = {};
  for (const key of Object.keys(LIMITS)) reduced[key] = Number.isFinite(limits?.[key]) ? Math.max(0, Math.min(LIMITS[key], Math.floor(limits[key]))) : LIMITS[key];
  return hunksFrom(calculate(aText, bText, reduced), ctx);
} });
module.exports = { linesOf, diffLines, buildHunks, _test };

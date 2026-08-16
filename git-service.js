// git-service.js —— isomorphic-git 封装（纯 Node，不依赖 Electron，可独立测试）
const git = require('isomorphic-git');
const fs = require('fs');
const path = require('path');

// Windows 反斜杠路径 → POSIX 正斜杠（isomorphic-git 树操作需要）
const posix = (p) => String(p).split(path.sep).join('/');

const STATUS_LABEL = {
  modified: '已修改', added: '已新增', deleted: '已删除', absent: '已删除',
  '*modified': '已暂存修改', '*added': '已暂存新增', '*deleted': '已暂存删除', '*absent': '已暂存删除',
};

// ---------- 基础 ----------
async function findRoot(dir) {
  try {
    return await git.findRoot({ fs, filepath: dir });
  } catch { return null; }
}
async function isRepo(dir) {
  const root = await findRoot(dir);
  return root ? { root, yes: true } : { root: null, yes: false };
}
async function currentBranch(root) {
  try {
    const b = await git.currentBranch({ fs, dir: root, fullname: false });
    return b || '(无提交)';
  } catch { return '(无提交)'; }
}

// 递归列出目录下所有文件（跳过 .git / node_modules）
function listFiles(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

// ---------- 状态 ----------
async function status(dir) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { isRepo: false, error: '不是 Git 仓库' };
  const branch = await currentBranch(root);
  const changed = [];
  for (const f of listFiles(root)) {
    let st;
    try { st = await git.status({ fs, dir: root, filepath: posix(path.relative(root, f)) }); }
    catch { continue; }
    if (st && st !== 'unmodified' && st !== 'ignored') {
      changed.push({ file: path.relative(root, f), status: st, label: STATUS_LABEL[st] || st });
    }
  }
  changed.sort((a, b) => a.file.localeCompare(b.file));
  return { isRepo: true, root, branch, changed };
}

// ---------- 日志 ----------
async function log(dir, depth = 100) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { isRepo: false, error: '不是 Git 仓库', commits: [] };
  try {
    const commits = await git.log({ fs, dir: root, depth, ref: 'HEAD' });
    const items = commits.map((c) => ({
      oid: c.oid,
      short: c.oid.slice(0, 7),
      message: (c.commit.message || '').split('\n')[0],
      fullMessage: c.commit.message || '',
      author: c.commit.author.name,
      email: c.commit.author.email,
      timestamp: c.commit.author.timestamp * 1000,
      parents: c.commit.parent,
    }));
    return { isRepo: true, root, branch: await currentBranch(root), commits: items };
  } catch (e) {
    if (String(e.message || e).includes('HEAD')) {
      return { isRepo: true, root, branch: await currentBranch(root), commits: [], unborn: true };
    }
    return { isRepo: true, root, error: String(e.message || e), commits: [] };
  }
}

// ---------- 提交 ----------
async function getAuthor(root) {
  let name, email;
  try { name = await git.getConfig({ fs, dir: root, path: 'user.name' }); } catch {}
  try { email = await git.getConfig({ fs, dir: root, path: 'user.email' }); } catch {}
  return { name: name || 'me', email: email || 'me@localhost' };
}

// 注意：本版本 isomorphic-git 的 commit() 不支持 filepaths 参数，
// 必须先显式 add / remove 暂存，再 commit。
async function commit(dir, { message, files, amend = false }) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  const author = await getAuthor(root);
  try {
    if (files && files.length) {
      for (const f of files) {
        if (fs.existsSync(path.join(root, f))) {
          await git.add({ fs, dir: root, filepath: posix(f) });
        } else {
          await git.remove({ fs, dir: root, filepath: posix(f) }); // 已删除的文件 → 暂存删除
        }
      }
    }
    const r = await git.commit({ fs, dir: root, message, author, amend });
    return { ok: true, oid: r };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function initRepo(dir) {
  try {
    await git.init({ fs, dir, defaultBranch: 'main' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------- 读取某 commit 中某文件内容 ----------
// readBlob 不解析 ref，需先 resolveRef 转成完整 SHA
async function blobAt(root, oid, file) {
  if (!oid) return null;
  try {
    const resolved = await git.resolveRef({ fs, dir: root, ref: oid });
    const { blob } = await git.readBlob({ fs, dir: root, oid: resolved, filepath: file });
    return Buffer.from(blob).toString('utf8');
  } catch { return null; } // 该提交中不存在此文件
}

// ---------- 行级 Diff（Myers O(ND)）----------
// 文本 → 行数组：忽略末尾换行产生的空行（与 git 显示行为一致）
function linesOf(t) {
  if (t === '') return [];
  const arr = t.split('\n');
  if (arr[arr.length - 1] === '') arr.pop();
  return arr;
}

// 返回 ops: [{type:'ctx'|'del'|'add', aLine?, bLine?}]（行号从 0 起）
function diffLines(aText, bText) {
  const a = linesOf(aText), b = linesOf(bText);
  const N = a.length, M = b.length;
  const MAX = N + M;
  const OFF = MAX + 1;
  const v = new Int32Array(2 * MAX + 2);
  const trace = [];
  let found = false;
  for (let d = 0; d <= MAX && !found; d++) {
    const row = new Int32Array(2 * MAX + 2);
    for (let k = -d; k <= d; k += 2) {
      const idx = k + OFF;
      let x;
      if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) x = v[idx + 1];
      else x = v[idx - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[idx] = x; row[idx] = x;
      if (x >= N && y >= M) { trace.push(row); found = true; break; }
    }
    if (!found) trace.push(row);
  }
  const ops = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const k = x - y;
    const idx = k + OFF;
    let prevX, prevY;
    if (d === 0) { prevX = 0; prevY = 0; }
    else {
      const prevRow = trace[d - 1];
      let prevK;
      if (k === -d || (k !== d && prevRow[idx - 1] < prevRow[idx + 1])) prevK = k + 1;
      else prevK = k - 1;
      prevX = prevRow[prevK + OFF];
      prevY = prevX - prevK;
    }
    while (x > prevX && y > prevY) { ops.push({ type: 'ctx', aLine: x - 1, bLine: y - 1 }); x--; y--; }
    if (x > prevX) { ops.push({ type: 'del', aLine: x - 1 }); x--; }
    else if (y > prevY) { ops.push({ type: 'add', bLine: y - 1 }); y--; }
  }
  ops.reverse();
  return ops;
}

// 把 ops 分组为 hunks（带 3 行上下文），并映射成前后对比行
// rows: [{type:'ctx'|'del'|'add', aText, bText, aNum, bNum}]  aNum/bNum 为 1 起行号，无则 0
function buildHunks(aText, bText, ctx = 3) {
  const a = linesOf(aText), b = linesOf(bText);
  const ops = diffLines(aText, bText);
  if (!ops.some((o) => o.type !== 'ctx')) return [];
  const groups = [];
  let cur = null;
  for (const o of ops) {
    if (o.type === 'ctx') {
      if (cur) cur.push(o);
    } else {
      if (!cur) { cur = []; groups.push(cur); }
      cur.push(o);
    }
  }
  const hunks = [];
  for (const g of groups) {
    const first = g[0], last = g[g.length - 1];
    const rows = [];
    const ctxHead = ops.filter((o) => o.type === 'ctx' && o.aLine < first.aLine).slice(-ctx);
    const ctxTail = ops.filter((o) => o.type === 'ctx' && o.aLine > last.aLine).slice(0, ctx);
    for (const o of [...ctxHead, ...g, ...ctxTail]) {
      if (o.type === 'ctx') rows.push({ type: 'ctx', aText: a[o.aLine] ?? '', bText: b[o.bLine] ?? '', aNum: o.aLine + 1, bNum: o.bLine + 1 });
      else if (o.type === 'del') rows.push({ type: 'del', aText: a[o.aLine] ?? '', bText: '', aNum: o.aLine + 1, bNum: 0 });
      else rows.push({ type: 'add', aText: '', bText: b[o.bLine] ?? '', aNum: 0, bNum: o.bLine + 1 });
    }
    const aStart = rows.find((r) => r.aNum)?.aNum ?? 0;
    const bStart = rows.find((r) => r.bNum)?.bNum ?? 0;
    hunks.push({
      oldStart: aStart, oldLines: rows.filter((r) => r.aNum).length,
      newStart: bStart, newLines: rows.filter((r) => r.bNum).length,
      rows,
    });
  }
  return hunks;
}

// ---------- 对比：工作区 vs HEAD ----------
async function diffWorkdir(dir, file) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { error: '不是 Git 仓库' };
  const rel = path.relative(root, file);
  let oldText = null, newText = null;
  try { oldText = await blobAt(root, 'HEAD', posix(rel)); } catch {}
  try { newText = fs.readFileSync(file, 'utf8'); } catch {}
  if (oldText === null && newText === null) return { error: '无法读取文件' };
  if (oldText === newText) return { file: rel, unchanged: true };
  return { file: rel, oldText: oldText ?? '', newText: newText ?? '', hunks: buildHunks(oldText ?? '', newText ?? '') };
}

// ---------- 某提交涉及的文件列表 ----------
async function treeFiles(root, oid) {
  const out = {};
  if (!oid) return out;
  await git.walk({
    fs, dir: root,
    trees: [git.TREE({ ref: oid })],
    map: async (filepath, entries) => {
      const [t] = entries;
      if (filepath === '.') return;
      if (t && (await t.type()) === 'blob') out[filepath] = await t.oid();
    },
  });
  return out;
}

async function commitFiles(dir, oid) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { error: '不是 Git 仓库' };
  try {
    const c = await git.readCommit({ fs, dir: root, oid });
    const parent = c.commit.parent[0] || null;
    const [oldTree, newTree] = [await treeFiles(root, parent), await treeFiles(root, oid)];
    const files = new Set([...Object.keys(oldTree), ...Object.keys(newTree)]);
    const changed = [];
    for (const f of files) {
      if (oldTree[f] !== newTree[f]) changed.push(f);
    }
    changed.sort();
    return { files: changed };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ---------- 对比：某提交 vs 其父提交 ----------
async function diffCommit(dir, oid, file) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { error: '不是 Git 仓库' };
  try {
    const c = await git.readCommit({ fs, dir: root, oid });
    const parent = c.commit.parent[0] || null;
    const [oldText, newText] = [await blobAt(root, parent, posix(file)), await blobAt(root, oid, posix(file))];
    if (oldText === null && newText === null) return { error: '文件中不存在于该提交' };
    if (oldText === newText) return { file, unchanged: true };
    return { file, oldText: oldText ?? '', newText: newText ?? '', hunks: buildHunks(oldText ?? '', newText ?? '') };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

module.exports = { findRoot, isRepo, status, log, commit, initRepo, diffWorkdir, diffCommit, commitFiles, diffLines, buildHunks, listFiles, linesOf };
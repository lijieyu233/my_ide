// git-service.js —— isomorphic-git 封装（纯 Node，不依赖 Electron，可独立测试）
const git = require('isomorphic-git');
const fs = require('fs');
const path = require('path');

// Windows 反斜杠路径 → POSIX 正斜杠（isomorphic-git 树操作需要）
const posix = (p) => String(p).split(path.sep).join('/');
const native = (p) => String(p).split('/').join(path.sep);

// ---------- 基础 ----------
// 注意：不用 git.findRoot —— 它在 Windows 反斜杠路径上有 bug
// （内部 path.posix.dirname 会把整条路径当文件名，返回 '.' 后误查相对 .git）
async function findRoot(dir) {
  let p = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(p, '.git'))) return p;
    const parent = path.dirname(p);
    if (parent === p) return null;
    p = parent;
  }
}
async function isRepo(dir) {
  const root = await findRoot(dir);
  return root ? { root, yes: true } : { root: null, yes: false };
}
const CRLF_BUF = Buffer.from('\r\n'); // CRLF 误报校验用（见 status）

async function currentBranch(root) {
  try {
    const b = await git.currentBranch({ fs, dir: root, fullname: false });
    return b || '(无提交)';
  } catch { return '(无提交)'; }
}

// ---------- 状态（statusMatrix：一次 walk 批量计算，性能关键）----------
// statusMatrix 每行 [filepath, head, workdir, stage]，值 = oid 在 [undefined, headOid, workdirOid, stageOid] 的下标：
// 0=不存在 1=与HEAD同 2=workdir自身 3=stage自身
function matrixToStatus(m) {
  const [, h, w, s] = m;
  const H = h > 0, W = w > 0, S = s > 0;
  if (!H && !W && !S) return null;                       // 不存在
  if (H && W && S && h === w && w === s) return null;    // 未修改
  if (!H && W && !S) return { status: 'added', label: '新增' };                    // 未跟踪
  if (!H && W && S) return { status: s === w ? 'added' : '*added', label: '新增' }; // 已暂存新增（或暂存后又改）
  if (H && !W && !S) return { status: 'deleted', label: '已删除' };                  // 工作区删除
  if (H && !W && S) return { status: '*deleted', label: '已删除（已暂存）' };
  if (H && W && !S) return { status: 'modified', label: '已修改' };
  // H && W && S：有修改
  if (h === s) return { status: 'modified', label: '已修改' };        // [1,2,1] 未暂存
  if (w === s) return { status: '*modified', label: '已修改（已暂存）' }; // [1,2,2]
  return { status: '*modified', label: '已修改（暂存+未暂存）' };          // [1,2,3]
}

// ---------- .gitignore 支持（isomorphic-git statusMatrix 不解析 .gitignore，需自行过滤）----------
// 规则 → 正则：dirOnly=尾部'/'；anchored=含'/'（相对 .gitignore 所在目录）；否则匹配任意层级末段
function ignoreRuleRegex(pattern) {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.includes('/');
  p = p.replace(/^\/+/, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } // **/ → 任意层级前缀
        else { re += '.*'; i += 1; }                        // ** → 任意（含 /）
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  const body = anchored ? '^' + re + '$' : '(?:^|/)' + re + '$';
  return { regex: new RegExp(body), dirOnly, anchored };
}

function parseIgnoreText(text) {
  const rules = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    if (!line) continue;
    const { regex, dirOnly, anchored } = ignoreRuleRegex(line);
    rules.push({ regex, dirOnly, anchored, negate });
  }
  return rules;
}

// 判定 relPath（POSIX 相对 root）是否被忽略：逐前缀段（父目录用 dirOnly 也命中）+ 后到规则优先
function isIgnoredPath(relPath, rules) {
  const segs = relPath.split('/');
  let ignored = false;
  for (let i = 0; i < segs.length; i++) {
    const sub = segs.slice(0, i + 1).join('/');
    const isDir = i < segs.length - 1;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.regex.test(sub)) ignored = !r.negate;
    }
  }
  return ignored;
}

// 收集 relPath 各级父目录（含 root）下的 .gitignore 规则（带缓存，读写失败静默）
const ignoreCache = new Map(); // dirKey(绝对路径) -> rules[]（空数组=无/空文件）
function rulesForDir(dir) {
  let d = dir;
  while (d) {
    if (ignoreCache.has(d)) return ignoreCache.get(d);
    let rules = [];
    try {
      const text = fs.readFileSync(path.join(d, '.gitignore'), 'utf8');
      rules = parseIgnoreText(text);
    } catch {}
    ignoreCache.set(d, rules);
    return rules;
  }
  return [];
}
function allRulesFor(rootDir, relPosix) {
  const segs = relPosix.split('/');
  const out = [];
  for (let i = 0; i <= segs.length - 1; i++) { // 各级父目录（不含文件自身所在层的文件名）
    const dirAbs = path.join(rootDir, ...segs.slice(0, i));
    out.push(...rulesForDir(dirAbs));
  }
  return out;
}

async function status(dir) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { isRepo: false, error: '不是 Git 仓库' };
  const branch = await currentBranch(root);
  let matrix;
  try {
    matrix = await git.statusMatrix({ fs, dir: root });
  } catch (e) {
    return { isRepo: true, root, branch, changed: [], error: String(e.message || e) };
  }
  ignoreCache.clear(); // .gitignore 内容可能已变，每次 status 重新读
  const changed = [];
  for (const row of matrix) {
    const st = matrixToStatus(row);
    if (!st) continue;
    // 纯未跟踪文件（未暂存）尊重 .gitignore；已跟踪 / 已暂存的照常显示（与 git 行为一致）
    if (st.status === 'added' && row[2] === 2 && row[3] === 0) {
      const relPosix = posix(row[0]);
      const rules = allRulesFor(root, relPosix);
      if (rules.length && isIgnoredPath(relPosix, rules)) continue;
    }
    // CRLF 误报校验：autocrlf 仓库（真实 git 提交时归一化为 LF，工作区是 CRLF），
    // isomorphic-git 不做行尾过滤、按原始字节比对会把整仓 CRLF 文件全部误报为已修改。
    // 归一化 \r\n 后与 HEAD 一致 → 视为未修改（与 git status 行为一致）
    if (st.status === 'modified') {
      let raw = null;
      try { raw = fs.readFileSync(path.join(root, row[0])); } catch {}
      if (raw && raw.includes(CRLF_BUF)) {
        const headText = await blobAt(root, 'HEAD', row[0]);
        if (headText !== null &&
            headText.replace(/\r\n/g, '\n') === raw.toString('utf8').replace(/\r\n/g, '\n')) continue;
      }
    }
    changed.push({ file: native(row[0]), status: st.status, label: st.label });
  }
  changed.sort((a, b) => a.file.localeCompare(b.file));
  return { isRepo: true, root, branch, changed };
}

// ---------- 日志 ----------
async function log(dir, depth = 100, ref = 'HEAD') {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { isRepo: false, error: '不是 Git 仓库', commits: [] };
  try {
    const commits = await git.log({ fs, dir: root, depth, ref });
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
    return { isRepo: true, root, branch: await currentBranch(root), commits: items, ref };
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

// 本版本 isomorphic-git 的 commit() 不支持 filepaths 参数，需先显式 add/remove 暂存
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

// ---------- 提交图数据（PyCharm Log：拓扑序 + 分支头映射）----------
// 拓扑排序：子提交先于父提交（链条连续的关键），同级按时间取最新（Kahn + 大顶堆）
// commitMap: Map<oid, {oid, parents[], timestamp}>，返回拓扑序数组
function topoSortNewestFirst(commitMap) {
  const childCount = new Map(); // oid -> 集合内尚未输出的子提交数（入度）
  for (const c of commitMap.values()) {
    for (const p of c.parents) {
      if (commitMap.has(p)) childCount.set(p, (childCount.get(p) || 0) + 1);
    }
  }
  const heap = []; // 大顶堆（按 timestamp）
  const push = (c) => {
    heap.push(c);
    let i = heap.length - 1;
    while (i > 0) {
      const pi = (i - 1) >> 1;
      if (heap[pi].timestamp >= heap[i].timestamp) break;
      [heap[pi], heap[i]] = [heap[i], heap[pi]];
      i = pi;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].timestamp > heap[m].timestamp) m = l;
        if (r < heap.length && heap[r].timestamp > heap[m].timestamp) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const c of commitMap.values()) if (!childCount.get(c.oid)) push(c);
  const out = [];
  while (heap.length) {
    const c = pop();
    out.push(c);
    for (const p of c.parents) {
      if (!commitMap.has(p)) continue;
      const n = (childCount.get(p) || 0) - 1;
      childCount.set(p, n);
      if (n === 0) push(commitMap.get(p));
    }
  }
  return out;
}

// logGraph：ref=null 所有分支头 / 'HEAD' / 分支名。
// 从头按时间新→旧收集 limit 个提交，再拓扑排序；branchHeads 供图上分支徽章用。
async function logGraph(dir, limit = 500, ref = null) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { isRepo: false, error: '不是 Git 仓库', commits: [] };
  try {
    const branchNames = await git.listBranches({ fs, dir: root });
    const current = (await git.currentBranch({ fs, dir: root, fullname: false })) || '';
    const branchHeads = {}; // oid -> [分支名]（每个分支头指向的提交，徽章用，所有视图都计算）
    for (const b of branchNames) {
      try {
        const oid = await git.resolveRef({ fs, dir: root, ref: b });
        (branchHeads[oid] = branchHeads[oid] || []).push(b);
      } catch {}
    }
    let headOids = [];
    if (ref) {
      // 单 ref 视图：仅从该 ref 出发
      const oid = await git.resolveRef({ fs, dir: root, ref: ref === 'HEAD' ? 'HEAD' : ref });
      headOids.push(oid);
    } else {
      headOids = [...new Set(Object.keys(branchHeads))];
    }
    // 按时间新→旧收集（大顶堆探索，等价 git log --all -n limit 的可见集合）
    const collected = new Map(); // oid -> {oid, parents, ts, raw}
    const seen = new Set();
    const frontier = []; // 小工具堆（按 ts 大顶）
    const fpush = (e) => {
      frontier.push(e);
      let i = frontier.length - 1;
      while (i > 0) {
        const pi = (i - 1) >> 1;
        if (frontier[pi].ts >= frontier[i].ts) break;
        [frontier[pi], frontier[i]] = [frontier[i], frontier[pi]];
        i = pi;
      }
    };
    const fpop = () => {
      const top = frontier[0];
      const last = frontier.pop();
      if (frontier.length) {
        frontier[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < frontier.length && frontier[l].ts > frontier[m].ts) m = l;
          if (r < frontier.length && frontier[r].ts > frontier[m].ts) m = r;
          if (m === i) break;
          [frontier[m], frontier[i]] = [frontier[i], frontier[m]];
          i = m;
        }
      }
      return top;
    };
    for (const oid of headOids) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      try {
        const c = await git.readCommit({ fs, dir: root, oid });
        fpush({ oid, ts: c.commit.author.timestamp, raw: c.commit });
      } catch {}
    }
    while (frontier.length && collected.size < limit) {
      const e = fpop();
      collected.set(e.oid, { oid: e.oid, parents: e.raw.parent || [], timestamp: e.raw.author.timestamp * 1000, raw: e.raw });
      for (const p of e.raw.parent || []) {
        if (seen.has(p)) continue;
        seen.add(p);
        try {
          const c = await git.readCommit({ fs, dir: root, oid: p });
          fpush({ oid: p, ts: c.commit.author.timestamp, raw: c.commit });
        } catch {}
      }
    }
    const ordered = topoSortNewestFirst(collected);
    const commits = ordered.map((c) => ({
      oid: c.oid,
      short: c.oid.slice(0, 7),
      message: (c.raw.message || '').split('\n')[0],
      fullMessage: c.raw.message || '',
      author: c.raw.author.name,
      email: c.raw.author.email,
      timestamp: c.timestamp,
      parents: c.parents,
    }));
    return {
      isRepo: true, root, branch: current, commits, branchHeads,
      headOid: (await git.resolveRef({ fs, dir: root, ref: 'HEAD' }).catch(() => null)) || null,
      truncated: collected.size >= limit && frontier.length > 0,
    };
  } catch (e) {
    if (String(e.message || e).includes('HEAD')) {
      return { isRepo: true, root, branch: await currentBranch(root), commits: [], unborn: true, branchHeads: {} };
    }
    return { isRepo: true, root, error: String(e.message || e), commits: [] };
  }
}

// ---------- 分支 ----------
async function branches(dir) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { isRepo: false, error: '不是 Git 仓库', branches: [], current: '' };
  try {
    const list = await git.listBranches({ fs, dir: root });
    const current = (await git.currentBranch({ fs, dir: root, fullname: false })) || '';
    return { isRepo: true, branches: list.sort(), current };
  } catch (e) {
    return { isRepo: true, error: String(e.message || e), branches: [], current: '' };
  }
}
async function checkout(dir, ref) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  try {
    await git.checkout({ fs, dir: root, ref });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// 从当前 HEAD 新建分支并切换过去（PyCharm Branches → New Branch）
async function createBranch(dir, name) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  if (!name || !/^[A-Za-z0-9._/-]+$/.test(name)) return { ok: false, error: '分支名不合法' };
  try {
    await git.branch({ fs, dir: root, ref: name, checkout: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// 放弃单个文件的修改：已跟踪 → 从 HEAD 恢复原始字节；未跟踪 → 从磁盘删除
async function discard(dir, file) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  const rel = posix(String(file).replace(/^[\\/]+/, ''));
  const abs = path.isAbsolute(file) ? file : path.join(root, native(file));
  try {
    let blob = null;
    try {
      const resolved = await git.resolveRef({ fs, dir: root, ref: 'HEAD' });
      const r = await git.readBlob({ fs, dir: root, oid: resolved, filepath: rel });
      blob = r.blob;
    } catch {}
    if (blob != null) {
      fs.writeFileSync(abs, Buffer.from(blob));
    } else if (fs.existsSync(abs)) {
      fs.rmSync(abs, { force: true });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------- 用户配置（提交作者）----------
async function getUserConfig(dir) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { name: '', email: '', isRepo: false };
  let name = '', email = '';
  try { name = await git.getConfig({ fs, dir: root, path: 'user.name' }); } catch {}
  try { email = await git.getConfig({ fs, dir: root, path: 'user.email' }); } catch {}
  return { name: name || '', email: email || '', isRepo: true };
}
async function setUserConfig(dir, { name, email }) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  try {
    if (name) await git.setConfig({ fs, dir: root, path: 'user.name', value: name });
    if (email) await git.setConfig({ fs, dir: root, path: 'user.email', value: email });
    return { ok: true };
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
async function blobAt(root, oid, file) {
  if (!oid) return null;
  try {
    const resolved = await git.resolveRef({ fs, dir: root, ref: oid });
    const { blob } = await git.readBlob({ fs, dir: root, oid: resolved, filepath: posix(file) });
    return Buffer.from(blob).toString('utf8');
  } catch { return null; }
}

// 二进制检测（git 同款启发式）：文本内容出现 NUL 字节即视为二进制，
// 否则 readFileSync/readBlob 的 utf8 解码会把 exe/图片渲染成乱码 diff
function isBinaryText(t) {
  return typeof t === 'string' && t.indexOf('\0') !== -1;
}

// ---------- 行级 Diff（Myers O(ND)）----------
const DIFF_MAX_LINES = 4000; // 超过此行数放弃精确对齐，避免 O(N·M) 卡死

function linesOf(t) {
  if (t === '') return [];
  const arr = t.split('\n');
  if (arr[arr.length - 1] === '') arr.pop();
  return arr;
}

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

// 超大文件降级：不做对齐，全部显示为 del + add（线性时间，不卡）
function coarseHunks(a, b) {
  const rows = [];
  for (let i = 0; i < a.length; i++) rows.push({ type: 'del', aText: a[i], bText: '', aNum: i + 1, bNum: 0 });
  for (let j = 0; j < b.length; j++) rows.push({ type: 'add', aText: '', bText: b[j], aNum: 0, bNum: j + 1 });
  return [{
    oldStart: 1, oldLines: a.length, newStart: 1, newLines: b.length, rows, coarse: true,
  }];
}

function buildHunks(aText, bText, ctx = 3) {
  const a = linesOf(aText), b = linesOf(bText);
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return coarseHunks(a, b);
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
  // file 可能是相对路径（提交窗口传 repo 相对路径）：相对进程 cwd 解析在打包 exe 下
  // cwd=exe 目录 ≠ 仓库目录，会读不到文件（表现为"点击无反应/整文件假差异"）→ 统一锚定到仓库根
  if (!path.isAbsolute(file)) file = path.join(root, file);
  const rel = path.relative(root, file);
  let oldText = null, newText = null;
  try { oldText = await blobAt(root, 'HEAD', rel); } catch {}
  try {
    const st = fs.statSync(file);
    if (st.size > 20 * 1024 * 1024) return { file: rel, tooLarge: true, size: st.size };
    newText = fs.readFileSync(file, 'utf8');
  } catch {}
  if (oldText === null && newText === null) return { error: '无法读取文件' };
  if (oldText === newText) return { file: rel, unchanged: true };
  if (isBinaryText(oldText) || isBinaryText(newText)) return { file: rel, binary: true };
  // CRLF 归一化（autocrlf 仓库）：HEAD 是 LF、工作区是 CRLF 时按归一化比对，
  // 否则每个真实改动都会连带整文件行尾差异刷屏（与 git diff 行为一致）
  if (oldText && newText && oldText.indexOf('\r') === -1 && newText.includes('\r\n')) {
    newText = newText.replace(/\r\n/g, '\n');
    if (oldText === newText) return { file: rel, unchanged: true };
  }
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
      if (!(f in oldTree)) changed.push({ file: native(f), status: 'added' });
      else if (!(f in newTree)) changed.push({ file: native(f), status: 'deleted' });
      else if (oldTree[f] !== newTree[f]) changed.push({ file: native(f), status: 'modified' });
    }
    changed.sort((a, b) => a.file.localeCompare(b.file));
    return { files: changed, isMerge: (c.commit.parent || []).length > 1 };
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
    const [oldText, newText] = [await blobAt(root, parent, file), await blobAt(root, oid, file)];
    if (oldText === null && newText === null) return { error: '文件中不存在于该提交' };
    if (oldText === newText) return { file, unchanged: true };
    if (isBinaryText(oldText) || isBinaryText(newText)) return { file, binary: true };
    return { file, oldText: oldText ?? '', newText: newText ?? '', hunks: buildHunks(oldText ?? '', newText ?? '') };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// 批量回滚（提交窗口「回滚选中」）：循环 discard，汇总成功/失败
async function discardFiles(dir, files) {
  const failed = [];
  let ok = 0;
  for (const f of (files || [])) {
    const r = await discard(dir, f);
    if (r.ok) ok++;
    else failed.push({ file: f, error: r.error });
  }
  return { ok, failed };
}

module.exports = { findRoot, isRepo, status, log, logGraph, topoSortNewestFirst, commit, initRepo, branches, checkout, createBranch, discard, discardFiles, getUserConfig, setUserConfig, diffWorkdir, diffCommit, commitFiles, diffLines, buildHunks, linesOf, matrixToStatus };
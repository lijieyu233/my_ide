// git-service.js —— isomorphic-git 封装（纯 Node，不依赖 Electron，可独立测试）
const git = require('isomorphic-git');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  // inIndexOnly：这份变更**整份已经在 index 里**（stage=2 = index 与工作区一致）。
  // stage=3（index 与工作区不一致）说明 index 与工作区各有一份改动，不算「只在暂存区」。
  const inIndexOnly = s === 2;
  if (!H && !W && !S) return null;                       // 不存在
  if (H && W && S && h === w && w === s) return null;    // 未修改
  if (!H && W && !S) return { status: 'added', label: '新增', inIndexOnly };                    // 未跟踪
  if (!H && W && S) return { status: s === w ? 'added' : '*added', label: '新增', inIndexOnly }; // 已暂存新增（或暂存后又改）
  if (H && !W && !S) return { status: 'deleted', label: '已删除', inIndexOnly };                  // 工作区删除
  if (H && !W && S) return { status: '*deleted', label: '已删除（已暂存）', inIndexOnly };
  if (H && W && !S) return { status: 'modified', label: '已修改', inIndexOnly };
  // H && W && S：有修改
  if (h === s) return { status: 'modified', label: '已修改', inIndexOnly };        // [1,2,1] 未暂存
  if (w === s) return { status: '*modified', label: '已修改（已暂存）', inIndexOnly }; // [1,2,2]
  return { status: '*modified', label: '已修改（暂存+未暂存）', inIndexOnly };          // [1,2,3]
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

// ---------- 快速矩阵（git 的 index stat 捷径 + 忽略目录剪枝）----------
// isomorphic 的 statusMatrix 每次刷新都把整棵工作区走一遍：node_modules 这类**被忽略的目录**
// 里的每个条目都要 readdir/lstat + 问一次忽略规则（本机实测 ~1.2s，绿盾会放大每一次 IO）。
// 而 git 自己的 fast path 是「index 里本来就存着每个文件的 stat——stat 没变 = 内容没变」：
//   * 走查时整棵剪掉「被忽略且下面没有已跟踪文件」的目录（node_modules 一次都不进）
//   * 文件 stat 与 index 一致 → workdir oid 直接取 index oid，一个字节都不读
//   * 只有 stat 对不上的文件才真正 read+sha1（通常就是刚保存的那一个）
// 行编码与 statusMatrix 完全一致（[path, head, workdir, stage]，值 = oid 在
// [undefined, headOid, workdirOid, stageOid] 里的下标），matrixToStatus 无需任何改动。
// 任何异常（index v4 / 解析失败 / 权限）都向上抛，由 status() 回落 statusMatrix —— 宁慢勿错。

// HEAD 树缓存（按 root，HEAD 一变就整体重建）：CRLF 校验要对每个"已修改"文件读一次
// HEAD blob，本机 readBlob 30~40ms/次，12 个文件就是 0.5s；HEAD 不变时树与 blob 全部可复用
const headTreeCache = new Map(); // root -> { headOid, tree: Map<path, oid>, blobs: Map<path, string> }
async function headInfo(root) {
  const headOid = await git.resolveRef({ fs, dir: root, ref: 'HEAD' }).catch(() => null);
  if (!headOid) return null;
  const hit = headTreeCache.get(root);
  if (hit && hit.headOid === headOid) return hit;
  const tree = new Map();
  const walkTree = async (oid, prefix) => {
    const { tree: entries } = await git.readTree({ fs, dir: root, oid });
    for (const e of entries) {
      const p = prefix ? prefix + '/' + e.path : e.path;
      if (e.type === 'tree') await walkTree(e.oid, p);
      else if (e.type === 'blob') tree.set(p, e.oid);
    }
  };
  const commit = await git.readCommit({ fs, dir: root, oid: headOid });
  await walkTree(commit.commit.tree, '');
  const info = { headOid, tree, blobs: new Map() };
  if (headTreeCache.size > 8) headTreeCache.clear(); // 多项目轮换时的简单上限
  headTreeCache.set(root, info);
  return info;
}

function gitdirOf(root) {
  const dot = path.join(root, '.git');
  let st;
  try { st = fs.statSync(dot); } catch { return null; }
  if (st.isDirectory()) return dot;
  try {
    const m = fs.readFileSync(dot, 'utf8').match(/^gitdir:\s*(.+)\r?$/m); // worktree/submodule 的 .git 是文件
    const p = m && m[1].trim();
    return p ? (path.isAbsolute(p) ? p : path.resolve(root, p)) : null;
  } catch { return null; }
}

// 解析 .git/index（v2/v3；v4 前缀压缩不解析 → 抛错走回落）。返回 Map<path, {oid, mtimeMs, size, ctimeSec}>
// （⚠ 与下面提交事务用的 readIndexEntries 是两回事：那个走 isomorphic 的 STAGE walker，
//   只有 oid/mode 没有 stat —— stat 捷径必须要磁盘 stat，所以这里直接读 index 原始字节）
function readIndexStat(gitdir) {
  let buf;
  try { buf = fs.readFileSync(path.join(gitdir, 'index')); } catch (e) {
    if (e && e.code === 'ENOENT') return new Map(); // 全新仓库还没有 index = 全部未跟踪
    throw e;
  }
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'DIRC') throw new Error('index 头不对');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('index v' + version + ' 不支持');
  const count = buf.readUInt32BE(8);
  const out = new Map();
  let o = 12;
  for (let i = 0; i < count; i++) {
    const start = o;
    if (o + 62 > buf.length) throw new Error('index 被截断');
    const ctimeSec = buf.readUInt32BE(o);
    const mtimeSec = buf.readUInt32BE(o + 8);
    const mtimeNs = buf.readUInt32BE(o + 12);
    const size = buf.readUInt32BE(o + 36);
    const oid = buf.toString('hex', o + 40, o + 60);
    const flags = buf.readUInt16BE(o + 60);
    const stage = (flags >> 12) & 0x3;
    const extended = version >= 3 && (flags & 0x4000) !== 0;
    const nameLen = flags & 0xfff;
    o += 62 + (extended ? 2 : 0);
    let name;
    if (nameLen < 0xfff) {
      name = buf.toString('utf8', o, o + nameLen);
    } else {
      const end = buf.indexOf(0, o);
      if (end === -1) throw new Error('index 名字没有终止符');
      name = buf.toString('utf8', o, end);
    }
    o += nameLen;
    o = start + Math.ceil((o - start + 1) / 8) * 8; // 条目按 8 字节对齐（至少 1 个 NUL）
    if (stage === 0) out.set(name.replace(/\\/g, '/'), {
      oid,
      size,
      mtimeMs: mtimeSec * 1000 + Math.floor(mtimeNs / 1e6),
      ctimeSec,
    });
  }
  return out;
}

const blobSha = (content) => crypto.createHash('sha1')
  .update(Buffer.concat([Buffer.from('blob ' + content.length + '\0'), content]))
  .digest('hex');

async function matrixFast(root) {
  const head = await headInfo(root);
  if (!head) throw new Error('HEAD 不可用（空仓库）→ 回落 statusMatrix');
  const gitdir = gitdirOf(root);
  if (!gitdir) throw new Error('找不到 .git → 回落');
  const idx = readIndexStat(gitdir);
  let indexMtimeMs = 0;
  try { indexMtimeMs = fs.lstatSync(path.join(gitdir, 'index')).mtimeMs; } catch {}
  // 含已跟踪文件的目录（index ∪ HEAD 的全部祖先）：剪枝时必须放行 —— 被忽略的目录里
  // 若有已跟踪文件，它们照常要进矩阵（与 git 行为一致，见 listIgnored 的注释）
  const trackedDirs = new Set();
  const addDirs = (p) => {
    let i = p.lastIndexOf('/');
    while (i > 0) { trackedDirs.add(p.slice(0, i)); i = p.lastIndexOf('/', i - 1); }
  };
  for (const p of idx.keys()) addDirs(p);
  for (const p of head.tree.keys()) addDirs(p);

  const rows = [];
  const seen = new Set();
  const walkDir = (abs, rel) => {
    let es;
    try { es = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name === '.git') continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        // 被忽略且没有已跟踪文件 → 整棵剪掉（node_modules 从此一次都不进）
        if (!trackedDirs.has(childRel)) {
          const rules = allRulesFor(root, childRel);
          if (rules.length && ignoredDir(childRel, rules)) continue;
        }
        walkDir(childAbs, childRel);
        continue;
      }
      seen.add(childRel);
      const entry = idx.get(childRel);
      const headOid = head.tree.get(childRel);
      let wOid;
      if (entry) {
        let st = null;
        try { st = fs.lstatSync(childAbs); } catch {}
        const match = st
          && Math.floor(st.mtimeMs) === entry.mtimeMs
          && Math.floor(st.ctimeMs / 1000) === entry.ctimeSec
          && st.size === entry.size
          && st.mtimeMs < indexMtimeMs; // racy-git：index 写入之后动过的文件不信任 stat，老实哈希
        wOid = match ? entry.oid : blobSha(st && st.isSymbolicLink() ? fs.readlinkSync(childAbs) : fs.readFileSync(childAbs));
      } else {
        wOid = '\u0002workdir'; // 未跟踪：内容不参与状态判断（cell 恒为 2），不必哈希
      }
      const sOid = entry ? entry.oid : undefined;
      rows.push([
        childRel,
        headOid ? 1 : 0,
        wOid === undefined ? 0 : (wOid === headOid ? 1 : 2),
        !sOid ? 0 : (sOid === headOid ? 1 : (sOid === wOid ? 2 : 3)),
      ]);
    }
  };
  walkDir(root, '');

  // 只在 index / HEAD 里、磁盘上已不在的文件（删除类状态）也要进矩阵
  const pushAbsent = (p, headOid, sOid) => {
    if (seen.has(p)) return;
    seen.add(p);
    rows.push([p, headOid ? 1 : 0, 0, !sOid ? 0 : (sOid === headOid ? 1 : 3)]);
  };
  for (const [p, entry] of idx) pushAbsent(p, head.tree.get(p), entry.oid);
  for (const [p] of head.tree) pushAbsent(p, head.tree.get(p), undefined);

  return rows;
}

async function status(dir, opts = {}) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { isRepo: false, error: '不是 Git 仓库' };
  const branch = await currentBranch(root);
  // legacy：测试对照用 —— 强制走 isomorphic 的 statusMatrix 原实现（tests/git.test.js 对拍两条路径）
  const buildMatrix = () => (opts.legacy
    ? git.statusMatrix({ fs, dir: root })
    : matrixFast(root).catch(() => git.statusMatrix({ fs, dir: root }))); // 任何异常回落原实现，宁慢勿错
  let matrix;
  try {
    matrix = await buildMatrix();
  } catch {
    // 工作区正在被改写时（自检里"挪目录 / 建夹具"与 0 延迟的 git 刷新撞在一起）走查
    // 会偶发抛 "An internal error caused this command to fail."，表现为 changed=[] + tracked=[]
    // → 提交窗口空列表、文件树状态色全丢、"只看 Git 文件"把树清空（2026-09-29 实测复现）。
    // status 是**只读且幂等**的 → 稍等再试一次；仍失败才如实报错（上层按"没拿到状态"处理）。
    await new Promise((r) => setTimeout(r, 90));
    try {
      matrix = await buildMatrix();
    } catch (e2) {
      return { isRepo: true, root, branch, changed: [], tracked: [], error: String(e2.message || e2) };
    }
  }
  ignoreCache.clear(); // .gitignore 内容可能已变，每次 status 重新读
  const changed = [];
  // tracked：**被 git 管理的文件**（存在于 HEAD 或 index）。与 `git ls-files` 等价 ——
  // 2026-09-29 实测对拍：本仓 statusMatrix 的 h>0||s>0 共 181 条 = ls-files 181 条，
  // 未跟踪的纯工作区文件（h=0,s=0）不算。文件树「只看 Git 文件」直接用它过滤，零额外遍历
  // （statusMatrix 本来就已经走完整个工作区）。
  const tracked = [];
  for (const row of matrix) {
    if (row[1] > 0 || row[3] > 0) tracked.push(posix(row[0]));
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
    changed.push({ file: native(row[0]), status: st.status, label: st.label, inIndexOnly: !!st.inIndexOnly });
  }
  changed.sort((a, b) => a.file.localeCompare(b.file));
  tracked.sort();
  return { isRepo: true, root, branch, changed, tracked };
}

// ---------- 被忽略的文件（PyCharm 提交窗口的「忽略的文件」节点）----------
// 只列「未跟踪 + 命中 .gitignore」的项；命中规则的目录整棵跳过（否则 node_modules 会拖死遍历）。
// 已跟踪的文件即使命中规则也照常显示在变更列表里（与 git 行为一致），所以这里要排除它们。
// dirOnly 规则（node_modules/）只在「有下级」时才命中 → 判定目录时补一段假尾段（见 ignoredDir）
function ignoredDir(rel, rules) { return isIgnoredPath(rel + '/\u0001', rules); }
async function listIgnored(dir, { limit = 800, maxDepth = 8 } = {}) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { isRepo: false, error: '不是 Git 仓库', files: [] };
  ignoreCache.clear();
  const tracked = new Set();
  try {
    const matrix = await git.statusMatrix({ fs, dir: root });
    for (const row of matrix) if (row[1] > 0) tracked.add(posix(row[0]));
  } catch {}
  const out = [];
  let truncated = false;
  const walk = (abs, rel) => {
    if (out.length >= limit) { truncated = true; return; }
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) { truncated = true; return; }
      if (e.name === '.git') continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      const childAbs = path.join(abs, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try { isDir = fs.statSync(childAbs).isDirectory(); } catch { isDir = false; }
      }
      if (isDir) {
        if (tracked.has(childRel)) continue; // 目录里有已跟踪文件（少见）：交给正常变更列表
        if (ignoredDir(childRel, allRulesFor(root, childRel))) {
          out.push({ file: native(childRel), dir: true });
          continue; // 整目录被忽略 → 不再下钻
        }
        if (rel.split('/').length < maxDepth) walk(childAbs, childRel);
        continue;
      }
      if (!tracked.has(childRel) && isIgnoredPath(childRel, allRulesFor(root, childRel))) {
        out.push({ file: native(childRel), dir: false });
      }
    }
  };
  walk(root, '');
  out.sort((a, b) => a.file.localeCompare(b.file));
  return { isRepo: true, root, files: out, truncated };
}

// ---------- .gitignore 编辑（提交窗口右键「添加到 .gitignore」/「不再忽略」）----------
// 只做「确切路径行」的增删（PyCharm 的 Add to .gitignore 同样是写入具体路径，不做模式推导）
function toRepoRel(root, p) {
  let s = String(p || '');
  if (path.isAbsolute(s)) s = path.relative(root, s);
  return posix(s);
}
async function addToGitignore(dir, file) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  const rel = toRepoRel(root, file);
  if (!rel || rel === '.' || rel.startsWith('..')) return { ok: false, error: '文件不在仓库内' };
  const gi = path.join(root, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(gi, 'utf8'); } catch {}
  const hit = text.split(/\r?\n/).some((l) => { const t = l.trim(); return t === rel || t === '/' + rel; });
  if (hit) return { ok: true, skipped: true, pattern: rel };
  const prefix = text ? text + (text.endsWith('\n') ? '' : '\n') : '';
  fs.writeFileSync(gi, prefix + rel + '\n', 'utf8');
  ignoreCache.clear();
  return { ok: true, pattern: rel };
}
async function removeFromGitignore(dir, file) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  const rel = toRepoRel(root, file);
  const gi = path.join(root, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(gi, 'utf8'); } catch { return { ok: false, error: '仓库里没有 .gitignore' }; }
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((l) => { const t = l.trim(); return !(t === rel || t === '/' + rel); });
  if (kept.length === lines.length) return { ok: false, error: '该项目不在 .gitignore 的确切路径行中（可能匹配的是通配规则）' };
  fs.writeFileSync(gi, kept.join('\n'), 'utf8');
  ignoreCache.clear();
  return { ok: true, removed: lines.length - kept.length };
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
//
// ★ 语义对齐 PyCharm：**勾选集合就是唯一权威**。commit() 提交的是整个 index，
//   所以「未勾选但已在 index 里」的文件必须显式 resetIndex 取消暂存，否则它会被一起提交
//   （老实现只 add 不 unstage → 取消勾选形同虚设，且暂存内容会被这次提交"吃掉"）。
//   resetIndex 只改 index，不动工作区 → 未勾选的改动仍留在工作区，提交后照常显示为未暂存。
// ---------- index（暂存区）工具：提交事务要用 ----------
// .git 可能是文件（worktree / submodule 的 gitdir 指针），别假设它是目录
function resolveGitDir(root) {
  const g = path.join(root, '.git');
  try {
    if (fs.statSync(g).isDirectory()) return g;
    const txt = fs.readFileSync(g, 'utf8');
    const m = txt.match(/^gitdir:\s*(.+)$/mi);
    if (m) return path.resolve(root, m[1].trim());
  } catch {}
  return g;
}

// ---------- 收进 index 的唯一入口：原生优先、无本机 git 回落 isomorphic ----------
// 为什么不能直接用 `git.add`：isomorphic-git 只读**仓库本地** `.git/config` 的 core.autocrlf
// （GitConfigManager 注释：只能读写本地 $GIT_DIR/config），而 autocrlf 真实机器上通常只在
// **全局** ~/.gitconfig → 它读到 undefined，不做 CRLF→LF 归一化，把工作区 CRLF 字节原样写进 index。
// 实测（文档 088）：本仓 commit() 提交 `l1\r\nl2\r\n` 后 `git ls-files --eol` 是 `i/crlf`，
// 而原生 git 是 `i/lf` —— 提交进仓库的行尾是错的，协作者会看到整文件重写。
//
// ⚠ 只在**确实有本机 git** 时走原生；探测失败（caps 全 false / 用户没装 git）时回落 isomorphic，
//   并保留 084 的定位：这条回落路径在 autocrlf 仓库上仍然不完美，但"没有 git 可用"时
//   它是唯一选择 —— 宁可行尾不归一化，也不能让提交直接失败（用户会丢工作）。
function nativeGitOrNull() {
  try { return require('./git-native'); } catch { return null; }
}
async function nativeAvailable() {
  const N = nativeGitOrNull();
  if (!N) return null;
  try {
    // ⚠ probe() 的返回字段是 `available`（不是 `ok`）—— 写错过一次，表现为"永远回落 isomorphic"，
    //   修完 CRLF 缺陷却完全没生效（复现脚本仍是 i/crlf）。
    const p = await N.probe();
    return p && p.available ? N : null;
  } catch { return null; }
}
// 暂存一个工作区文件（force：勾选被 .gitignore 忽略的文件时也要能收，= PyCharm 的强制加入）
async function stageFile(root, relPosix, { force = true } = {}) {
  const N = await nativeAvailable();
  if (N) {
    const r = await N.addPath(root, relPosix, force);
    if (r.ok) return { ok: true, via: 'native' };
    // 原生失败了也别直接认输：可能是"路径不在仓库内"之类 isomorphic 反而能处理的情形
    try { await git.add({ fs, dir: root, filepath: relPosix, force }); return { ok: true, via: 'iso-fallback' }; }
    catch { return { ok: false, error: r.error || '暂存失败' }; }
  }
  try { await git.add({ fs, dir: root, filepath: relPosix, force }); return { ok: true, via: 'iso' }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// 读 index 里每个条目的 {oid, mode}（提交事务要在改 index 之前留好"原件"）
// ⚠ walker 给的是**带异步方法的条目对象**（`await e.type()` / `await e.oid()` / `await e.mode()`），
//   不是普通对象；而且 `map` 返回 null 会把整棵子树剪掉（实测只吐根目录一条）→ 目录必须返回真值。
async function readIndexEntries(root) {
  const map = new Map();
  try {
    await git.walk({
      fs, dir: root, cache: {},
      trees: [git.STAGE()],
      map: async (filepath, [stage]) => {
        if (!stage) return 'null';
        const t = await stage.type();
        if (t !== 'blob') return t;
        map.set(posix(filepath), { oid: await stage.oid(), mode: await stage.mode() });
        return t;
      },
    });
  } catch {}
  return map;
}

async function commit(dir, { message, files, amend = false, author: authorOverride }) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  const author = authorOverride || await getAuthor(root);
  // ---------- 提交事务：勾选集合决定"这次提交带走什么"，但**不许动用户的暂存区** ----------
  // 背景：`git.commit()` 提交的是"当前 index 那一棵树"，而 index 是全仓库一份（.git/index）。
  // 所以"只提交勾选的文件"必然要先临时把 index 改成"只有勾选内容"的样子 —— 老实现只做了这一步，
  // 提交完就不管了，于是"用户在终端 git add 过、这次没勾"的内容会被顺手 unstage（真实的数据损失）。
  //
  // 事务三步：
  //   ① 改 index 之前，把 index 里每个条目的 {oid, mode} 留一份（readIndexEntries）
  //   ② 临时把未勾选文件的 index 条目退回 HEAD（resetIndex）→ 只暂存勾选内容 → commit
  //   ③ 用 updateIndex 把①里记下的条目**原样写回**（其余文件的暂存状态一点不变）
  // 例：HEAD A=a0 B=b0，用户终端 `git add A`（index A=a1），工作区 A=a1 B=b1；IDE 只勾 B。
  //     → 提交后 HEAD A=a0 B=b1，index 仍是 A=a1（仍 staged）+ B=b1（与新 HEAD 一致，干净）。
  const idxEntries = await readIndexEntries(root);
  const idxPath = path.join(resolveGitDir(root), 'index');
  let idxBytes = null;
  try { if (fs.existsSync(idxPath)) idxBytes = fs.readFileSync(idxPath); } catch {}
  const touched = [];   // 我们改过 index 条目的文件（提交后要还回去）
  let committed = false;
  try {
    if (files) {
      const sel = new Set(files.map((f) => posix(f)));
      let matrix = [];
      try { matrix = await git.statusMatrix({ fs, dir: root }); } catch {}
      for (const row of matrix) {
        const p = posix(row[0]);
        if (sel.has(p)) continue;
        const [, h, , s] = row;
        // s > 0 && s !== h → index 与 HEAD 不一致（有暂存内容）→ 先把暂存内容挪开，保证不混进本次提交
        if (s > 0 && s !== h) {
          try { await git.resetIndex({ fs, dir: root, filepath: p }); touched.push(p); } catch {}
        }
      }
    }
    if (files && files.length) {
      for (const f of files) {
        if (fs.existsSync(path.join(root, f))) {
          // force：勾选的是被 .gitignore 忽略的文件时也要能暂存（PyCharm 勾选忽略文件即强制加入）
          // ⚠ 走 stageFile（原生优先）而不是裸 git.add —— 见该函数上方关于 autocrlf 的说明
          const r = await stageFile(root, posix(f), { force: true });
          if (!r.ok) throw new Error('暂存失败 ' + f + '：' + (r.error || ''));
        } else {
          await git.remove({ fs, dir: root, filepath: posix(f) }); // 已删除的文件 → 暂存删除
        }
      }
    }
    const r = await git.commit({ fs, dir: root, message, author, amend });
    committed = true;
    // ③ 把①里记下的 index 条目原样写回（含"暂存后又改过"的情形：写回的是当时的 oid，不是工作区内容）
    for (const p of touched) {
      const e = idxEntries.get(p);
      try {
        if (e) await git.updateIndex({ fs, dir: root, filepath: p, oid: e.oid, mode: e.mode });
        else await git.updateIndex({ fs, dir: root, filepath: p, remove: true });
      } catch {}
    }
    // 本次提交带走的文件：index 拉回与新 HEAD 一致（否则会显示成"暂存了回退内容"）
    if (files && files.length) {
      for (const f of files) {
        try {
          if (fs.existsSync(path.join(root, f))) await stageFile(root, posix(f), { force: true });
          else await git.remove({ fs, dir: root, filepath: posix(f) });
        } catch {}
      }
    }
    return { ok: true, oid: r, restored: touched.length };
  } catch (e) {
    // 事务失败：尽量把 index 恢复到进入时的样子（字节级兜底），别把用户的暂存状态弄丢
    if (idxBytes) { try { fs.writeFileSync(idxPath, idxBytes); } catch {} }
    else { try { for (const p of touched) await git.resetIndex({ fs, dir: root, filepath: p }); } catch {} }
    return { ok: false, error: String(e.message || e) + (committed ? '（提交已产生，但暂存区恢复失败）' : '') };
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
  if (!yes) return { isRepo: false, error: '不是 Git 仓库', branches: [], current: '', remotes: [], upstream: '' };
  try {
    const list = await git.listBranches({ fs, dir: root });
    const current = (await git.currentBranch({ fs, dir: root, fullname: false })) || '';
    // M4 收尾：远程分支（各 remote 下的引用）+ 当前分支的 upstream（命令行 pull/push 的默认去向）
    const remotes = [];
    try {
      const rs = await git.listRemotes({ fs, dir: root }).catch(() => []);
      for (const rm of rs) {
        const bs = await git.listBranches({ fs, dir: root, remote: rm.remote }).catch(() => []);
        for (const b of bs) remotes.push(rm.remote + '/' + b);
      }
    } catch {}
    let upstream = '';
    try {
      const N = require('./git-native');
      const u = await N.run(['rev-parse', '--abbrev-ref', 'HEAD@{upstream}'], { cwd: root, timeout: 5000, env: N.NO_EDIT });
      if (u.ok) upstream = u.stdout.trim();
    } catch {}
    // ⚠ 兜底：`HEAD@{upstream}` 依赖 refs/remotes，本机 git 写不进 → 解析失败（实测还会原样返回
    //   "@{upstream}"）。但 config 里的 branch.<name>.remote/merge 是**真的写进去了**的 → 直接读它，
    //   这才是 upstream 的权威来源（git 自己也是这么存的）。
    if ((!upstream || upstream === '@{upstream}') && current) {
      try {
        const N = require('./git-native');
        const rn = await N.run(['config', '--get', 'branch.' + current + '.remote'], { cwd: root, timeout: 5000, env: N.NO_EDIT });
        const mg = await N.run(['config', '--get', 'branch.' + current + '.merge'], { cwd: root, timeout: 5000, env: N.NO_EDIT });
        const r0 = rn.ok ? rn.stdout.trim() : '';
        const m0 = mg.ok ? mg.stdout.trim() : '';
        if (r0 && m0) upstream = r0 + '/' + String(m0).replace(/^refs\/heads\//, '');
      } catch {}
    }
    return { isRepo: true, branches: list.sort(), current, remotes, upstream };
  } catch (e) {
    return { isRepo: true, error: String(e.message || e), branches: [], current: '', remotes: [], upstream: '' };
  }
}
// ⚠ 这是**回落实现**：应用里 `git:checkout` 现在优先走原生 git（`git-ops.js` 里 checkout 同时写了
//   `op` 与 `native` 两个字段，main.js 按"原生可用就用原生"注册）。本函数只在**本机没找到 git 可执行文件**
//   时被调用 —— 因为它有个已知缺陷：isomorphic-git 不实现 core.autocrlf 归一化，autocrlf 仓库里工作区的
//   CRLF 文件会被算成"已修改"，于是切分支抛 CheckoutConflictError 报一串没动过的文件（2026-09-28 实测，13 个）。
//   `status()` 里有针对同一缺陷的「CRLF 误报校验」补丁（见上方），但**不给这里加**：这里没法区分
//   "真改动" 与 "只差行尾"，而 checkout 一旦误判放行就是**覆盖用户没提交的内容**，不能赌。
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
    // HEAD 快路径：树与 blob 内容按 HEAD oid 缓存（headInfo），免去逐层读树 ——
    // 本机 readBlob 30~40ms/次，modified 文件一多 CRLF 校验就是 0.5s（headTreeCache 的由来）
    if (oid === 'HEAD') {
      const hit = headTreeCache.get(root);
      // 先验 HEAD 没变（终端里 commit 会绕过本进程）：变了就走通用路径，绝不拿旧树比对新工作区
      if (hit && (await git.resolveRef({ fs, dir: root, ref: 'HEAD' }).catch(() => null)) === hit.headOid) {
        const p = posix(file);
        const blobOid = hit.tree.get(p);
        if (blobOid === undefined) return null; // HEAD 树里没有 = 读不到
        let text = hit.blobs.get(p);
        if (text === undefined) {
          const { blob } = await git.readBlob({ fs, dir: root, oid: blobOid });
          text = Buffer.from(blob).toString('utf8');
          hit.blobs.set(p, text);
        }
        return text;
      }
    }
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
  // 分块规则与 git 一致：**两处改动之间隔了 > 2×ctx 行未改动内容就断成两块**。
  // ⚠ 老实现是"从第一处改动一路吃到最后一处"，一个文件永远只有 1 块 —— 那样 M3 的
  //   hunk 级暂存就成了"整文件暂存"，等于没做。（改动 ≤ 2×ctx 行时仍合成一块，与 git 相同）
  const changeIdx = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].type !== 'ctx') changeIdx.push(i);
  const groups = [];
  let cur = [changeIdx[0]];
  for (let k = 1; k < changeIdx.length; k++) {
    let gap = 0;
    for (let i = changeIdx[k - 1] + 1; i < changeIdx[k]; i++) if (ops[i].type === 'ctx') gap++;
    if (gap > ctx * 2) { groups.push(cur); cur = []; }
    cur.push(changeIdx[k]);
  }
  groups.push(cur);
  const hunks = [];
  for (const g of groups) {
    const first = ops[g[0]], last = ops[g[g.length - 1]];
    const rows = [];
    const ctxHead = ops.filter((o) => o.type === 'ctx' && o.aLine < first.aLine).slice(-ctx);
    const ctxTail = ops.filter((o) => o.type === 'ctx' && o.aLine > last.aLine).slice(0, ctx);
    for (const o of [...ctxHead, ...g.map((i) => ops[i]), ...ctxTail]) {
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

// ---------- M3：双区差异（未暂存 / 已暂存）+ hunk 级暂存 ----------
// 双区语义（对齐 git status 的两栏，也是 M3 的 UI 依据）：
//   「更改」区   → **index → 工作区**：diffUnstaged（这是"还没进暂存区"的那部分）
//   「已暂存」区 → **HEAD → index**：diffStaged  （这是"已经进暂存区、下次提交会带走"的那部分）
// 文件同时有暂存与未暂存改动时（statusMatrix 的 stage=3），两个 diff 各自成立、互不干扰。

const stripCR = (s) => (String(s).endsWith('\r') ? String(s).slice(0, -1) : String(s));
const detectEol = (t) => (/\r\n/.test(t) ? '\r\n' : '\n');
function splitEol(t) {
  if (t === '') return { lines: [], had: false };   // 空文本 = 0 行（别变成 ['']）
  const had = /\n$/.test(t);
  const lines = String(t).split('\n');
  if (had) lines.pop();
  return { lines, had };
}

// 用同一套 CRLF 规则把两段文本变成 hunk（与 diffWorkdir 完全一致，别各写一套）
function hunkify(aText, bText) {
  let a = aText, b = bText;
  if (a && b && a.indexOf('\r') === -1 && b.includes('\r\n')) b = b.replace(/\r\n/g, '\n');
  if (a === b) return { oldText: a, newText: b, hunks: [] };
  return { oldText: a, newText: b, hunks: buildHunks(a, b) };
}

const HunkService=require('./git-hunks').createHunks({git,findRoot,resolveGitDir,hunkify,applyHunkToText});
const diffUnstaged=(dir,file)=>HunkService.diff(dir,file,'unstaged');
const diffStaged=(dir,file)=>HunkService.diff(dir,file,'staged');

// 把 hunk 应用到一段文本（forward: a→b / reverse: b→a）。
// ⚠ **带前置校验**：目标位置的现有内容必须与 hunk 对应侧逐行相符，否则拒绝并让上层提示刷新。
//   这是"自研拼接"能站得住脚的关键 —— 我们不猜，改不动就报错（比 git apply 的模糊匹配更保守）。
// ⚠ 行尾：比对时统一剥掉行尾 \r，写回时按原文的 EOL 约定拼（autocrlf 仓库的文件不会被改成 LF）。
function applyHunkToText(text, hunk, reverse) {
  const { lines, had } = splitEol(text);
  const eol = detectEol(text);
  const start = reverse ? hunk.newStart : hunk.oldStart;
  const count = reverse ? hunk.newLines : hunk.oldLines;
  const expect = hunk.rows.filter((r) => (reverse ? r.bNum : r.aNum)).map((r) => stripCR(reverse ? r.bText : r.aText));
  const want = hunk.rows.filter((r) => (reverse ? r.aNum : r.bNum)).map((r) => stripCR(reverse ? r.aText : r.bText));
  const have = lines.slice(start - 1, start - 1 + count).map(stripCR);
  if (have.length !== expect.length || have.some((l, i) => l !== expect[i])) {
    return { ok: false, error: '文件内容与差异不一致（可能已被改动），请刷新后重试' };
  }
  const out = lines.slice(0, start - 1).concat(want, lines.slice(start - 1 + count));
  // 统一剥掉行尾 \r 再按原文的 EOL 拼回：混着来的话会拼出 \r\r\n
  return { ok: true, text: out.map(stripCR).join(eol) + (had ? eol : '') };
}

const stageHunk=(dir,file,selection)=>HunkService.action(dir,file,selection,'stage');
const unstageHunk=(dir,file,selection)=>HunkService.action(dir,file,selection,'unstage');
const revertHunk=(dir,file,selection,recoveryRoot)=>HunkService.action(dir,file,selection,'revert',recoveryRoot);

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

// ---------- 分支 / 提交对比（A vs B）----------
// A 独有提交 = A 祖先集 - B 祖先集（等价 git log B..A），B 独有反之；
// 差异文件 = 两头指向的树做 blob oid 对比（等价 git diff A B --name-status）
async function compareRefs(dir, aRef, bRef) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { error: '不是 Git 仓库' };
  if (!aRef || !bRef) return { error: '请选择两个对比目标' };
  try {
    const aOid = await git.resolveRef({ fs, dir: root, ref: aRef });
    const bOid = await git.resolveRef({ fs, dir: root, ref: bRef });
    if (aOid === bOid) return { isRepo: true, same: true, aOnly: [], bOnly: [], files: [] };
    const ancestors = async (oid) => {
      const set = new Set();
      const stack = [oid];
      while (stack.length) {
        const cur = stack.pop();
        if (set.has(cur)) continue;
        set.add(cur);
        try {
          const c = await git.readCommit({ fs, dir: root, oid: cur });
          stack.push(...(c.commit.parent || []));
        } catch {}
      }
      return set;
    };
    const [setA, setB] = [await ancestors(aOid), await ancestors(bOid)];
    const readCommits = async (oids) => {
      const out = [];
      for (const oid of oids) {
        try {
          const c = await git.readCommit({ fs, dir: root, oid });
          out.push({
            oid, short: oid.slice(0, 7),
            message: (c.commit.message || '').split('\n')[0],
            author: c.commit.author.name,
            timestamp: c.commit.author.timestamp * 1000,
          });
        } catch {}
      }
      out.sort((x, y) => y.timestamp - x.timestamp);
      return out;
    };
    const aOnly = await readCommits([...setA].filter((o) => !setB.has(o)));
    const bOnly = await readCommits([...setB].filter((o) => !setA.has(o)));
    const [ta, tb] = [await treeFiles(root, aOid), await treeFiles(root, bOid)];
    const all = new Set([...Object.keys(ta), ...Object.keys(tb)]);
    const files = [];
    for (const f of all) {
      if (!(f in ta)) files.push({ file: native(f), status: 'added' });      // B 有 A 无（相对 A 新增）
      else if (!(f in tb)) files.push({ file: native(f), status: 'deleted' });
      else if (ta[f] !== tb[f]) files.push({ file: native(f), status: 'modified' });
    }
    files.sort((x, y) => x.file.localeCompare(y.file));
    return { isRepo: true, same: false, aOnly, bOnly, files };
  } catch (e) { return { error: String(e.message || e) }; }
}

// 对比两 ref 的单个文件内容（blobAt 内部 resolveRef，支持分支名 / HEAD / oid）
async function diffRefs(dir, aRef, bRef, file) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { error: '不是 Git 仓库' };
  try {
    const [oldText, newText] = [await blobAt(root, aRef, file), await blobAt(root, bRef, file)];
    if (oldText === null && newText === null) return { error: '文件不存在于两个分支' };
    if (oldText === newText) return { file, unchanged: true };
    if (isBinaryText(oldText) || isBinaryText(newText)) return { file, binary: true };
    return { file, oldText: oldText ?? '', newText: newText ?? '', hunks: buildHunks(oldText ?? '', newText ?? '') };
  } catch (e) { return { error: String(e.message || e) }; }
}

// ---------- 远程（fetch / pull / push / remote 管理）----------
// ---------- SSH 远程必须走原生 git ----------
// isomorphic-git 只认 http(s)，`git@host:` / `ssh://` 一律不支持（会直接抛错），
// 且 SSH 要靠系统 ssh 密钥/known_hosts，只能交给命令行 git。
// 这里只做「是否必须走原生」的判定；实际执行统一交给 git-native
// （能力探测选 exe、幂等重试、NO_EDIT 环境），不另起一套 spawn。
function needNativeRemote(url) {
  const u = String(url || '');
  if (/^git@|^ssh:\/\//i.test(u)) return true;
  // 🔴 isomorphic-git **只认 http(s)**：本地路径（C:\...、/home/x/repo）、UNC（\\host\share）、
  //   file:// 在它那儿一律是 `Cannot parse remote URL` —— push / fetch / pull(ff) 三条通道
  //   在这些远程下 100% 失败。交给原生 git（本来它们也只有原生能干），https 链路不受影响。
  return !/^https?:\/\//i.test(u);
}

const rawHttp = require('isomorphic-git/http/node');
// 原生 git 后端（M2）：只承担 credential / proxy 这类"必须问命令行"的能力
const nativeGit = require('./git-native');
const netHttp = require('http');
const netHttps = require('https');
const tls = require('tls');

// 远程 URL → 主机（含端口）。http://user@host:port/path → host:port；非 http(s) 返回 null
function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

// ---------- 代理支持（修复 isomorphic-git 忽略 git config 代理 → GitHub 直连不稳）----------
// 命令行 git 读 http.proxy（含 http.<url>.proxy 按主机匹配）走代理；isomorphic-git 完全忽略 → 只能直连碰运气。
// 这里用 git config --get-urlmatch 读同一份配置（三层级合并 + URL 匹配，与命令行行为一致），
// https 目标构造 HTTP CONNECT 隧道 agent 注入底层 http client。

// 查 git config 里该远程 URL 的 http.proxy（不走网络，仅读配置；结果缓存）
// —— 已收编进原生后端（git-native.js 的 proxyFor，实现与缓存都在那边）
function gitConfigProxy(root, url) { return nativeGit.proxyFor(root, url); }

// HTTP CONNECT 隧道 agent（https 目标经 http 代理；agent 按 proxyUrl 缓存复用）
// 注意：createConnection 是 Agent 的原型方法，构造参数传入会被忽略，必须子类覆写。
class TunnelAgent extends netHttps.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: false });
    this._proxy = new URL(proxyUrl);
  }
  createConnection(options, callback) {
    let settled = false;
    const done = (err, sock) => { if (!settled) { settled = true; err ? callback(err) : callback(null, sock); } };
    try {
      const host = options.host, port = options.port || 443;
      const p = this._proxy;
      const req = netHttp.request({
        host: p.hostname, port: parseInt(p.port || 80, 10),
        method: 'CONNECT', path: host + ':' + port,
      });
      req.setTimeout(15000, () => req.destroy(new Error('代理 CONNECT 超时')));
      req.once('connect', (res, socket) => {
        if (res.statusCode !== 200) { socket.destroy(); return done(new Error('代理 CONNECT 被拒: HTTP ' + res.statusCode)); }
        const sock = tls.connect({ socket, servername: host, rejectUnauthorized: true });
        sock.once('secureConnect', () => done(null, sock));
        sock.once('error', (e) => done(e));
      });
      req.once('error', (e) => done(e));
      req.end();
    } catch (e) { done(e); }
  }
}
const tunnelAgentCache = new Map(); // proxyUrl -> TunnelAgent
function tunnelAgentFor(proxyUrl) {
  if (tunnelAgentCache.has(proxyUrl)) return tunnelAgentCache.get(proxyUrl);
  try { new URL(proxyUrl); } catch { return null; }
  if (!/^https?:/i.test(proxyUrl)) return null;
  const agent = new TunnelAgent(proxyUrl);
  tunnelAgentCache.set(proxyUrl, agent);
  return agent;
}

// 按远程 URL 取 http client：git config 配了代理且目标为 https → 注入隧道 agent；否则直连原生 client
async function httpFor(root, url) {
  if (!url || !/^https:/i.test(url)) return rawHttp; // 仅 https 目标支持 CONNECT 隧道
  const proxy = await gitConfigProxy(root, url);
  if (!proxy) return rawHttp;
  const agent = tunnelAgentFor(proxy);
  if (!agent) return rawHttp;
  return { request: (req) => rawHttp.request(Object.assign({}, req, { agent })) };
}

// 系统 Git 凭证管理器查询 —— 已收编进原生后端（git-native.js）
// （M2「按能力路由」：credential / proxy 走 native，其余继续走 isomorphic-git）
function systemCredentialFill(url) { return nativeGit.credentialFill(url); }

// 候选凭证迭代制（onAuth 与 onAuthFailure 共用同一迭代器）：
// isomorphic-git 语义：首次 401 调 onAuth 取凭证，之后每次 401 调 onAuthFailure 取下一个；
// 返回 null 即停止重试并抛 401。任一候选成功即通过。
// 候选优先级：host 匹配的渲染层凭证 > 远程 URL 内嵌凭证 > 系统 Git 凭证管理器 > '*' 兜底凭证。
// 注意 '*' 兜底（早期全局单份凭证迁移而来）可能是为其他主机存的，排在系统凭证之后，
// 避免它毒害本可用系统凭证成功的推送（GitHub/GitLab 多主机混用场景）。
function onAuthOf(auth, remoteUrl) {
  const host = hostOf(remoteUrl);
  const cands = [];
  if (auth) {
    if (host && auth[host] && auth[host].username) cands.push(auth[host]);
    if (auth.username) cands.push(auth); // 兼容旧平铺格式 {username,password}
  }
  if (remoteUrl) { // URL 内嵌凭证（isomorphic-git 不解析 URL userinfo，这里代为生效）
    try {
      const u = new URL(remoteUrl);
      if (u.username) cands.push({ username: decodeURIComponent(u.username), password: decodeURIComponent(u.password || '') });
    } catch {}
  }
  const star = auth && auth['*'] && auth['*'].username ? auth['*'] : null;
  let i = 0, sysTried = false, starTried = false;
  return async () => {
    while (i < cands.length) {
      const c = cands[i++];
      if (c && c.username) return { username: c.username, password: c.password || '' };
    }
    if (!sysTried) {
      sysTried = true;
      const sys = await systemCredentialFill(remoteUrl); // 系统 Git 凭证（命令行存过的）
      if (sys && sys.username) return sys;
    }
    if (!starTried && star) { starTried = true; return { username: star.username, password: star.password || '' }; }
    return null; // 候选耗尽：isomorphic-git 停止重试，外层统一转友好报错
  };
}

// 网络错误 → 友好提示（认证耗尽时指明已尝试所有凭证，引导到远程仓库弹窗）
function friendlyNetError(e, pr) {
  const msg = String((e && e.message) || e);
  if (/HTTP Error: 40[13]/.test(msg)) {
    return '认证失败：' + (hostOf(pr && pr.url) || '远程') + ' 拒绝了所有已存凭证，请在「远程仓库」弹窗中为该主机保存正确的用户名和密码/令牌';
  }
  return msg;
}

// GitLab 对不带 .git 后缀的 http(s) 远程会 301 重定向到 .git 地址，isomorphic-git 不跟随重定向 → 报 404。
// 这里在 404 时自动把远程 URL 规范化（补 .git，写回 git config）重试一次；仍失败则还原 URL 报原错误。
// op 闭包内 git.fetch/push 按 remote 名从 config 重新解析 URL，addRemote(force) 更新后重试即生效。
async function withRemoteUrlFix(root, pr, op) {
  try {
    return await op();
  } catch (e) {
    const msg = String((e && e.message) || e);
    const fixable = /404/.test(msg) && pr && pr.url && /^https?:/i.test(pr.url) && !/\.git\/?$/.test(pr.url);
    if (!fixable) throw e;
    const fixedUrl = pr.url.replace(/\/+$/, '') + '.git';
    await git.addRemote({ fs, dir: root, remote: pr.name, url: fixedUrl, force: true });
    try {
      const r = await op();
      return Object.assign({}, r, { urlFixed: true, fixedUrl });
    } catch (e2) {
      await git.addRemote({ fs, dir: root, remote: pr.name, url: pr.url, force: true }); // 还原，避免误改无关 404
      throw e2;
    }
  }
}

// 远程跟踪分支（refs/remotes/<remote>/…）：松散 refs 目录 + packed-refs 两处合并，无网络
// 返回 [{ name, head, oid }] —— head=true 表示远程默认分支（refs/remotes/<remote>/HEAD 指向）
function remoteBranchesSync(root, remoteName) {
  const branches = new Map(); // name -> oid
  const base = path.join(root, '.git', 'refs', 'remotes', remoteName);
  try {
    if (fs.existsSync(base)) {
      const walk = (dir, prefix) => {
        for (const n of fs.readdirSync(dir)) {
          const p = path.join(dir, n);
          let st; try { st = fs.statSync(p); } catch { continue; }
          if (st.isDirectory()) walk(p, prefix + n + '/');
          else if (n !== 'HEAD') branches.set(prefix + n, fs.readFileSync(p, 'utf8').trim());
        }
      };
      walk(base, '');
    }
  } catch {}
  try {
    const packed = path.join(root, '.git', 'packed-refs');
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
        const m = line.match(/^([0-9a-f]{40}) refs\/remotes\/([^/\s]+)\/(.+)$/);
        if (m && m[2] === remoteName && m[3] !== 'HEAD' && !branches.has(m[3])) branches.set(m[3], m[1]);
      }
    }
  } catch {}
  // 远程默认分支：refs/remotes/<remote>/HEAD 内容形如 "ref: refs/remotes/<remote>/main"
  let headName = null;
  try {
    const hf = path.join(base, 'HEAD');
    if (fs.existsSync(hf)) {
      const v = fs.readFileSync(hf, 'utf8').trim();
      const m = v.match(/^ref:\s*refs\/remotes\/[^/]+\/(.+)$/);
      if (m) headName = m[1];
    }
  } catch {}
  return [...branches.entries()]
    .sort((a, b) => (headName === b[0]) - (headName === a[0]) || a[0].localeCompare(b[0]))
    .map(([name, oid]) => ({ name, head: name === headName, oid: String(oid).slice(0, 7) }));
}

async function listRemotes(dir) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { isRepo: false, error: '不是 Git 仓库', remotes: [] };
  try {
    const list = await git.listRemotes({ fs, dir: root });
    return { isRepo: true, remotes: list.map((r) => ({ name: r.remote, url: r.url, branches: remoteBranchesSync(root, r.remote) })) };
  } catch (e) {
    return { isRepo: true, error: String(e.message || e), remotes: [] };
  }
}

async function addRemote(dir, { name, url }) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return { ok: false, error: '远程名不合法' };
  if (!url || !/\S/.test(url)) return { ok: false, error: 'URL 不能为空' };
  // 🔴 Windows 本地路径 / UNC 里的反斜杠必须先规范成正斜杠：git config 把 `\` 当转义符，
  //   原样写进 .git/config 会让**所有原生 git 命令**报 `bad config line N` —— status / push /
  //   merge / rebase / 冲突处理 / pre-commit 钩子全线失效，而且报错完全看不懂。
  //   实测原生 `git remote add` 就是这么规范化的（C:\a\b → C:/a/b），这里保持一致行为。
  //   ⚠ 只对"没有 scheme"的输入做（本地路径 / UNC / scp-like），http(s)、ssh、git+ssh 原样保留。
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) url = url.replace(/\\/g, '/');
  try {
    await git.addRemote({ fs, dir: root, remote: name, url, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function removeRemote(dir, name) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  try {
    await git.deleteRemote({ fs, dir: root, remote: name });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// fetch：只更新 refs/remotes，不动工作区
async function fetchRemote(dir, { auth } = {}) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  const pr = await primaryRemote(root);
  if (!pr) return { ok: false, error: '未配置远程仓库' };
  // SSH 远程 isomorphic-git 不支持 → 走原生 git（fetch 幂等，允许重试一次抖动的失败）
  if (needNativeRemote(pr.url)) {
    const N = require('./git-native');
    const r = await N.runRetry(['fetch', '--prune', pr.name], { cwd: root, timeout: 120000, env: N.NO_EDIT });
    return r.ok ? { ok: true, fetchHead: true }
      : { ok: false, error: (r.stderr.trim() || r.error || 'fetch 失败') };
  }
  try {
    return await withRemoteUrlFix(root, pr, async () => {
      const onAuth = onAuthOf(auth, pr.url);
      const r = await git.fetch({
        fs, dir: root, http: await httpFor(root, pr.url), remote: pr.name,
        onAuth, onAuthFailure: onAuth, // 共用迭代器：401 后自动换下一个候选凭证
      });
      return { ok: true, fetchHead: r && r.fetchHead };
    });
  } catch (e) {
    return { ok: false, error: friendlyNetError(e, pr) };
  }
}

// pull：fetch + fast-forward 合并（分叉时明确报错，不静默产生合并提交）
// 拉取策略（M4 收尾）：ff=默认快进；ff-only=分叉就报错；merge=分叉时建合并提交；
// rebase=把本地提交重放上去。merge / rebase / ff-only 整条走**原生 git**
// （isomorphic 没有真合并；fetch 也用原生，这样 FETCH_HEAD 语义与命令行完全一致），
// 撞冲突交给 M4 的解决流程。
//
// 🔴 ff（默认策略）是 2026-09-30 修过的一条：**fetch 留 isomorphic，快进合并改走原生**。
//   原因（用户现场："我刚拉下代码怎么就显示有更改"）：isomorphic 的 `git.pull` 内部是
//   `_merge` → `_checkout` 两步，而它的快进分支**只写 ref、不碰工作区**
//   （见 node_modules/isomorphic-git/index.cjs 的 `_merge`：`writeRef` 后直接 return），
//   真正落盘靠紧随其后的 `_checkout`；可那个 checkout 不认 core.autocrlf（见 git-native.js
//   里 checkout 的注释），在本仓这种「LF 提交 + CRLF 工作区」的仓库上把每个 CRLF 文件都算成
//   "有本地改动" → 抛 CheckoutConflictError。于是 refs 前进了、工作区留在旧版本，两者的差集
//   被提交窗口显示成一屏从没动过的改动（实测 10 项：6 个 CRLF 文件 + 被删的文档 + 2 个 LF 文件）。
//   ⚠ 只把落盘那步交给原生：原生 git 先做行尾归一化再比对，**只在真有本地改动时拒绝**，
//     且拒绝发生在移动 ref 之前 —— 不会再有"指针走了、文件没走"的半吊子状态。
//   为什么 fetch 不一起交给原生：应用「远程仓库」弹窗里存的凭证是经 `auth` 传进来的，
//   只有 isomorphic 这条路认；原生 git 只认系统凭证助手（gh CLI），
//   用户若只在弹窗里填过 token，整条拉取就会拉不动。代理同理（后端已注入 CONNECT 隧道）。
async function pullRemote(dir, { auth, strategy } = {}) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  const branch = await currentBranch(root);
  if (!branch || branch === '(无提交)') return { ok: false, error: '当前无分支' };
  const pr = await primaryRemote(root);
  if (!pr) return { ok: false, error: '未配置远程仓库' };
  const strat = ['ff', 'ff-only', 'merge', 'rebase'].includes(strategy) ? strategy : 'ff';
  // SSH 远程 isomorphic 完全不支持 → 不进这个分支，直接落到下面的原生 git 流程（语义等价）
  if (strat === 'ff' && !needNativeRemote(pr.url)) {
    try {
      return await withRemoteUrlFix(root, pr, async () => {
        const onAuth = onAuthOf(auth, pr.url);
        // ① fetch：isomorphic（凭证 / 代理兜底链在这条路上）。ref: branch 必须传 ——
        //    不传它会拉全部远程分支，fetchHead 可能落在别的分支上，下面的快进就并错分支了。
        const f = await git.fetch({
          fs, dir: root, http: await httpFor(root, pr.url), remote: pr.name, ref: branch,
          onAuth, onAuthFailure: onAuth,
        });
        const head = f && f.fetchHead;
        if (!head) return { ok: true, strategy: strat, fetchHead: true };
        // ② 快进合并：原生。取不到本机 git 时只能退回 isomorphic 的老路径（那条在本仓
        //    这类 autocrlf 仓库上会留下"refs 走了、工作区没走"的半吊子状态 —— 无本机 git 时无解）
        const info = await nativeGit.info(false).catch(() => null);
        if (!(info && info.git && info.git.available)) {
          const r = await git.pull({
            fs, dir: root, http: await httpFor(root, pr.url), remote: pr.name, ref: branch, fastForwardOnly: true,
            author: await getAuthor(root),
            onAuth, onAuthFailure: onAuth,
          });
          return { ok: true, oid: r && r.oid, strategy: strat };
        }
        const m = await nativeGit.merge(root, head, { ffOnly: true });
        if (!m.ok) {
          const why = String(m.error || '');
          if (/not possible to fast-forward|not a fast-forward/i.test(why)) {
            return { ok: false, strategy: strat, error: '本地与远程已分叉：请换「拉取并合并 / 拉取并变基」，或先处理本地更改' };
          }
          // 真有未提交改动时原生 git 会拒绝并**保持工作区与 refs 原样**（这正是要的行为）
          if (/would be overwritten|local changes/i.test(why)) {
            return { ok: false, strategy: strat, error: '本地有未提交的改动，会被远程更新覆盖：先提交或暂存后再拉取' };
          }
          return { ok: false, strategy: strat, error: why };
        }
        return { ok: true, oid: head, strategy: strat };
      });
    } catch (e) {
      const msg = String(e.message || e);
      if (/HTTP Error: 40[13]/.test(msg)) return { ok: false, error: friendlyNetError(e, pr) };
      if (msg.includes('fast-forward') || msg.includes('Not a fast-forward')) {
        return { ok: false, error: '本地与远程已分叉：请换「拉取并合并 / 拉取并变基」，或先处理本地更改' };
      }
      return { ok: false, error: msg };
    }
  }
  // ---- 以下策略走原生 git ----
  const N = require('./git-native');
  const f = await N.run(['fetch', '--prune', pr.name], { cwd: root, timeout: 120000, env: N.NO_EDIT });
  if (!f.ok) return { ok: false, error: '拉取失败：' + (f.stderr.trim() || f.error) };
  // ⚠ ff 与 ff-only 都是"只快进"：以前 ff 只在 isomorphic 分支成立，落到原生后会被当成 merge
  //   （分叉时静默建合并提交）——本地路径远程现在也走原生，这里必须补上，否则语义不一致。
  if (strat === 'ff-only' || strat === 'ff') {
    const m = await N.run(['merge', '--ff-only', 'FETCH_HEAD'], { cwd: root, timeout: 30000, env: N.NO_EDIT });
    if (m.ok) return { ok: true, strategy: strat };
    const why = m.stderr.trim() || m.stdout.trim() || m.error;
    return {
      ok: false, strategy: strat,
      error: strat === 'ff-only' ? '不是快进（本地与远程已分叉）：' + why
        : '本地与远程已分叉：请换「拉取并合并 / 拉取并变基」，或先处理本地更改',
    };
  }
  const r = strat === 'rebase' ? await N.rebase(root, 'FETCH_HEAD') : await N.merge(root, 'FETCH_HEAD');
  if (!r.ok) return { ok: false, error: r.error, strategy: strat, state: r.state };
  if (r.conflict) return { ok: true, strategy: strat, conflict: true, state: r.state };
  return { ok: true, strategy: strat, out: r.out };
}

// push：当前分支 → 主远程同名分支
async function pushRemote(dir, { auth, remote, force } = {}) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  const branch = await currentBranch(root);
  if (!branch || branch === '(无提交)') return { ok: false, error: '当前无可推送的提交' };
  let pr = null;
  if (remote) {
    const list = await git.listRemotes({ fs, dir: root }).catch(() => []);
    const hit = list.find((r) => r.remote === remote);
    if (hit) pr = { name: hit.remote, url: hit.url };
  }
  if (!pr) pr = await primaryRemote(root); // 未指定 / 指定的远程不存在 → 回退主远程
  if (!pr) return { ok: false, error: '未配置远程仓库' };
  // SSH 远程 isomorphic-git 不支持 → 走原生 git（重复 push 是幂等 no-op，允许重试抖动的失败）
  if (needNativeRemote(pr.url)) {
    const N = require('./git-native');
    const args = ['push'];
    if (force) args.push('--force');
    args.push(pr.name, branch);
    const r = await N.runRetry(args, { cwd: root, timeout: 120000, env: N.NO_EDIT });
    if (r.ok) return { ok: true, remote: pr.name, branch, force: !!force };
    const msg = r.stderr.trim() || r.error || 'push 失败';
    if (/fetch first|behind|non-fast-forward/i.test(msg)) {
      return { ok: false, error: '远程有新提交，请先拉取（⬇）再推送' };
    }
    return { ok: false, error: msg };
  }
  try {
    return await withRemoteUrlFix(root, pr, async () => {
      const onAuth = onAuthOf(auth, pr.url);
      await git.push({
        fs, dir: root, http: await httpFor(root, pr.url), remote: pr.name, ref: branch,
        force: !!force, onAuth, onAuthFailure: onAuth,
      });
      return { ok: true, remote: pr.name, branch, force: !!force };
    });
  } catch (e) {
    const msg = String(e.message || e);
    if (/HTTP Error: 40[13]/.test(msg)) return { ok: false, error: friendlyNetError(e, pr) };
    if (msg.includes('fetch first') || msg.includes('behind')) {
      return { ok: false, error: '远程有新提交，请先拉取（⬇）再推送' };
    }
    if (msg.includes('pre-receive hook declined')) {
      return { ok: false, error: '服务端拒绝推送 ' + branch + '：多为受保护分支（需权限或走合并请求），也可能是提交信息不符合服务端钩子要求' };
    }
    return { ok: false, error: msg };
  }
}

// 主远程：优先 origin，否则第一个远程（避免远程名非 origin 时全链路失效）
// config 无远程时回退扫描 refs/remotes/*（手工跟踪 ref 也能算 ahead/behind；url 置 null）
async function primaryRemote(root) {
  const remotes = await git.listRemotes({ fs, dir: root }).catch(() => []);
  if (remotes.length) {
    const origin = remotes.find((r) => r.remote === 'origin');
    const r = origin || remotes[0];
    return { name: r.remote, url: r.url };
  }
  try {
    const dir = path.join(root, '.git', 'refs', 'remotes');
    if (!fs.existsSync(dir)) return null;
    const names = fs.readdirSync(dir).filter((n) => {
      try {
        return fs.statSync(path.join(dir, n)).isDirectory() && fs.readdirSync(path.join(dir, n)).length > 0;
      } catch { return false; }
    }).sort();
    if (!names.length) return null;
    const name = names.includes('origin') ? 'origin' : names[0];
    return { name, url: null };
  } catch { return null; }
}

// 远端某个分支的真实 oid —— ⚠ **不能只信 refs/remotes**。
// 🔴 本机 git.exe 写不进 `refs/remotes/**`（4 段路径 rc=0 但文件不落地）→ `git fetch` 明明成功输出
//    `* [new branch] main -> origin/main`，`refs/remotes/origin/main` 却不存在。后果是 ahead/behind
//    恒为 null、push 预览把已推送的提交也算进去（还误标"首次推送"）、set-upstream 被拒。
//    三级兜底：① 标准 remote-tracking 引用（正常机器上都走这条）
//             ② .git/FETCH_HEAD（fetch 的产物，2 段路径 → 本机也落得下来，形如
//                "<oid>\t\tbranch 'main' of <url>"）
//             ③ git ls-remote（最后手段，要走网络，只读不改工作区）
async function remoteOid(root, remote, branch, remoteUrl) {
  if (!remote || !branch) return null;
  try {
    const oid = await git.resolveRef({ fs, dir: root, ref: 'refs/remotes/' + remote + '/' + branch });
    if (oid) return String(oid);
  } catch {}
  try {
    const txt = fs.readFileSync(path.join(root, '.git', 'FETCH_HEAD'), 'utf8');
    const want = new RegExp("branch\\s+'" + branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'\\s+of\\s");
    const urlKey = remoteUrl ? String(remoteUrl).replace(/\\/g, '/') : '';
    for (const line of txt.split('\n')) {
      const m = line.match(/^([0-9a-f]{40})\s+(.*)$/);
      if (!m || !want.test(m[2])) continue;
      if (urlKey && m[2].indexOf(urlKey) < 0) continue;  // 多远程时按 url 区分
      return m[1];
    }
  } catch {}
  try {
    const N = require('./git-native');
    const r = await N.run(['ls-remote', remote, 'refs/heads/' + branch], { cwd: root, timeout: 15000, env: N.NO_EDIT });
    const m = r.ok && String(r.stdout).match(/^([0-9a-f]{40})/);
    if (m) return m[1];
  } catch {}
  return null;
}

// ahead/behind：本地分支 vs 远程跟踪分支
// opts.fetch=true 时先静默 fetch（更新 refs/remotes 后再算，反映远程真实状态；失败回退本地 refs）
async function aheadBehind(dir, opts = {}) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return {};
  const branch = await currentBranch(root);
  if (!branch || branch === '(无提交)') return { branch };
  const pr = await primaryRemote(root);
  if (!pr) return { branch, remote: null, remoteUrl: null, ahead: null, behind: null };
  let fetched = false;
  if (opts.fetch && pr.url) { // 无 url（纯本地 ref 回退场景）不联网
    try {
      // 公开仓库不触发 401 不会调 onAuth；私有仓库按候选迭代取凭证（host 匹配 > URL 内嵌 > 系统凭证 > '*' 兜底）
      const onAuth = onAuthOf(opts.auth, pr.url);
      await git.fetch({ fs, dir: root, http: await httpFor(root, pr.url), remote: pr.name, onAuth, onAuthFailure: onAuth });
      fetched = true;
    } catch {} // 网络不通/需认证：静默回退本地 refs（显示旧值总比报错好）
  }
  // ⚠ 走 remoteOid 的三级兜底（refs/remotes → FETCH_HEAD → ls-remote）：本机 git 写不进
  //   refs/remotes 时，只 resolveRef 会恒为 null → 面板上的 ↑/↓ 永远不显示。
  const upstream = await remoteOid(root, pr.name, branch, pr.url);
  const head = await git.resolveRef({ fs, dir: root, ref: 'HEAD' }).catch(() => null);
  let ahead = null, behind = null;
  if (upstream && head) {
    // ⚠ 必须先找 merge-base 再各自计数：直接 `countNotReached(upstream, head)` 在**本地领先**时
    //   （远端是本地的祖先，沿父链永远到不了 head）会把整段历史都数成 behind —— 实测本地多提交
    //   一个后报 ahead=1 behind=1。分叉时同理，两边都只数"自己独有"的那段才是对的。
    let base = null;
    try {
      const bs = await git.findMergeBase({ fs, dir: root, oids: [String(head), String(upstream)] });
      base = (bs && bs[0]) || null;
    } catch {}
    const stop = base || '0000000000000000000000000000000000000000';   // 无共同祖先 = 整段都算
    ahead = await countNotReached(root, head, stop);
    behind = await countNotReached(root, upstream, stop);
  }
  return { branch, remote: pr.name, remoteUrl: pr.url, fetched, ahead, behind };
}

// Push 预览：列出本地领先远程跟踪分支的待推送提交（HEAD → refs/remotes/<remote>/<branch>，纯本地 refs，无网络）
async function listPushCommits(dir) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  const branch = await currentBranch(root);
  if (!branch || branch === '(无提交)') return { ok: false, error: '当前无可推送的提交' };
  const head = await git.resolveRef({ fs, dir: root, ref: 'HEAD' }).catch(() => null);
  if (!head) return { ok: false, error: '当前无可推送的提交' };
  const pr = await primaryRemote(root);
  if (!pr) return { ok: false, error: '未配置远程仓库' };
  // ⚠ 同上走三级兜底：拿不到远端 oid 时会把**已推送过**的提交也列成待推送（还标 first:true），
  //   本机 refs/remotes 不落地就是这种情况。
  const upstream = await remoteOid(root, pr.name, branch, pr.url);
  // 无上游：全部分支历史都是待推送（首次 push 场景），上限保护 500
  const stop = upstream || '0000000000000000000000000000000000000000';
  const seen = new Set([stop]);
  const queue = [head];
  const commits = [];
  while (queue.length && commits.length < 500) {
    const oid = queue.shift();
    if (seen.has(oid)) continue;
    seen.add(oid);
    try {
      const c = await git.readCommit({ fs, dir: root, oid });
      commits.push({
        oid, short: oid.slice(0, 7),
        message: (c.commit.message || '').split('\n')[0],
        author: c.commit.author.name,
        timestamp: c.commit.author.timestamp * 1000,
      });
      for (const p of (c.commit.parent || [])) queue.push(p);
    } catch { break; }
  }
  if (!upstream && !commits.length) return { ok: false, error: '当前无可推送的提交' };
  // 时间正序展示（旧→新，推送顺序）
  commits.reverse();
  return { ok: true, branch, remote: pr.name, remoteUrl: pr.url, first: !upstream, count: commits.length, commits };
}

// 从 from 出发沿父链 BFS、不越过 stop，统计未到达 stop 的提交数（上限保护）
async function countNotReached(root, fromOid, stopOid) {
  const seen = new Set([stopOid]);
  const queue = [fromOid];
  let n = 0;
  while (queue.length && n < 5000) {
    const oid = queue.shift();
    if (seen.has(oid)) continue;
    seen.add(oid);
    n++;
    try {
      const c = await git.readCommit({ fs, dir: root, oid });
      for (const p of (c.commit.parent || [])) queue.push(p);
    } catch { break; }
  }
  return n;
}

// ---------- 标签 ----------
async function listTags(dir) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { isRepo: false, error: '不是 Git 仓库', tags: [] };
  try {
    const names = await git.listTags({ fs, dir: root });
    const tags = [];
    for (const name of names) {
      try {
        const oid = await git.resolveRef({ fs, dir: root, ref: name });
        const c = await git.readCommit({ fs, dir: root, oid });
        tags.push({
          name, oid,
          short: oid.slice(0, 7),
          message: (c.commit.message || '').split('\n')[0],
          timestamp: c.commit.author.timestamp * 1000,
        });
      } catch {}
    }
    tags.sort((a, b) => b.timestamp - a.timestamp);
    return { isRepo: true, tags };
  } catch (e) {
    return { isRepo: true, error: String(e.message || e), tags: [] };
  }
}

async function createTag(dir, { name, message, oid }) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  if (!name || !/^[A-Za-z0-9._/-]+$/.test(name)) return { ok: false, error: '标签名不合法' };
  try {
    // oid 省略 → 指向当前 HEAD；有 message → 附注标签，否则轻量标签
    await git.tag({ fs, dir: root, ref: name, message: message || undefined, object: oid || undefined });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------- 还原提交（git revert：生成反向新提交）----------
async function revertCommit(dir, oid) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  try {
    const c = await git.readCommit({ fs, dir: root, oid });
    const parents = c.commit.parent || [];
    if (parents.length > 1) return { ok: false, error: '合并提交暂不支持还原' };
    const parent = parents[0] || null;
    const [oldTree, newTree] = [await treeFiles(root, parent), await treeFiles(root, oid)];
    const files = new Set([...Object.keys(oldTree), ...Object.keys(newTree)]);
    const changed = [];
    for (const f of files) {
      if (!(f in oldTree)) changed.push({ file: f, status: 'deleted' });   // 提交里新增 → 还原=删除
      else if (!(f in newTree)) changed.push({ file: f, status: 'added' });// 提交里删除 → 还原=恢复
      else if (oldTree[f] !== newTree[f]) changed.push({ file: f, status: 'modified' });
    }
    // 涉及文件必须工作区干净（git revert 同样要求）
    const st = await status(dir);
    if (st.changed && st.changed.length) {
      const conflict = st.changed.filter((x) => changed.some((y) => posix(y.file) === posix(x.file)));
      if (conflict.length) return { ok: false, error: '以下文件有未提交的本地修改，请先提交或回滚：\n' + conflict.map((x) => x.file).join('\n') };
    }
    // 生成反向补丁：写回父版本内容 / 删除新增文件
    for (const ch of changed) {
      const rel = posix(ch.file);
      const abs = path.join(root, ch.file);
      if (ch.status === 'deleted') {
        fs.rmSync(abs, { force: true });
        await git.remove({ fs, dir: root, filepath: rel });
      } else {
        const { blob } = await git.readBlob({ fs, dir: root, oid: parent, filepath: rel });
        fs.writeFileSync(abs, Buffer.from(blob));
        await stageFile(root, rel);
      }
    }
    const msg = `Revert "${(c.commit.message || '').split('\n')[0]}"\n\nThis reverts commit ${oid}.`;
    const newOid = await git.commit({ fs, dir: root, message: msg, author: await getAuthor(root) });
    return { ok: true, oid: newOid, files: changed.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------- Cherry-pick（摘取提交：将该提交的变更重放到当前 HEAD 并建新提交） ----------
// isomorphic-git 无内置 cherry-pick → 手工重放：读取 提交 vs 其父 的差异，
// 把「提交版本」内容写进工作区（revert 的镜像：revert 写回父版本）。
async function cherryPick(dir, oid) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  try {
    const c = await git.readCommit({ fs, dir: root, oid });
    const parents = c.commit.parent || [];
    if (parents.length > 1) return { ok: false, error: '合并提交暂不支持摘取' };
    const parent = parents[0] || null;
    const [oldTree, newTree] = [await treeFiles(root, parent), await treeFiles(root, oid)];
    const files = new Set([...Object.keys(oldTree), ...Object.keys(newTree)]);
    const changed = [];
    for (const f of files) {
      if (!(f in oldTree)) changed.push({ file: f, status: 'added' });     // 提交里新增 → 摘取=写入
      else if (!(f in newTree)) changed.push({ file: f, status: 'deleted' }); // 提交里删除 → 摘取=删除
      else if (oldTree[f] !== newTree[f]) changed.push({ file: f, status: 'modified' });
    }
    if (!changed.length) return { ok: false, error: '该提交没有变更可摘取' };
    // 涉及文件必须工作区干净（避免摘取内容与本地改动混淆丢失）
    const st = await status(dir);
    if (st.changed && st.changed.length) {
      const conflict = st.changed.filter((x) => changed.some((y) => posix(y.file) === posix(x.file)));
      if (conflict.length) return { ok: false, error: '以下文件有未提交的本地修改，请先提交或回滚：\n' + conflict.map((x) => x.file).join('\n') };
    }
    for (const ch of changed) {
      const rel = posix(ch.file);
      const abs = path.join(root, ch.file);
      if (ch.status === 'deleted') {
        fs.rmSync(abs, { force: true });
        await git.remove({ fs, dir: root, filepath: rel });
      } else {
        const { blob } = await git.readBlob({ fs, dir: root, oid, filepath: rel });
        fs.writeFileSync(abs, Buffer.from(blob));
        await stageFile(root, rel);
      }
    }
    const msg = (c.commit.message || '').trim();
    const newOid = await git.commit({ fs, dir: root, message: msg + '\n\n(cherry picked from commit ' + oid + ')', author: await getAuthor(root) });
    return { ok: true, oid: newOid, files: changed.length, message: msg };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------- Shelve 搁置（PyCharm 式：未提交改动快照存 .git/myide-shelves/，不依赖 git stash） ----------
// 快照式：搁置 = 保存工作区内容（base64，二进制安全）+ 回滚到 HEAD；恢复 = 写回快照。
// 比 patch 式简单且无三方合并冲突问题；恢复时若目标文件有未提交改动则拒绝（force 可覆盖）。
const SHELVES_DIR = 'myide-shelves';

function shelveFile(root, id) {
  return path.join(root, '.git', SHELVES_DIR, id + '.json');
}

async function shelveCreate(dir, { name, files } = {}) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  try {
    const st = await status(dir);
    let targets = st.changed;
    if (files && files.length) {
      const set = new Set(files.map((f) => posix(f)));
      targets = st.changed.filter((c) => set.has(posix(c.file)));
    }
    if (!targets.length) return { ok: false, error: '没有可搁置的更改' };
    // 快照工作区状态
    const items = [];
    for (const t of targets) {
      const rel = posix(t.file);
      const isDeleted = t.status === 'deleted' || t.status === '*deleted';
      if (isDeleted) {
        items.push({ path: rel, status: 'deleted', content: null });
      } else {
        const buf = fs.readFileSync(path.join(root, native(rel)));
        items.push({ path: rel, status: t.status.startsWith('*') ? t.status.slice(1) : t.status, content: buf.toString('base64') });
      }
    }
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const meta = {
      id, name: (name || '').trim() || '搁置 ' + items.length + ' 个文件',
      createdAt: Date.now(),
      branch: st.branch || '',
      files: items,
    };
    fs.mkdirSync(path.join(root, '.git', SHELVES_DIR), { recursive: true });
    fs.writeFileSync(shelveFile(root, id), JSON.stringify(meta));
    // 回滚这些文件（工作区+暂存区恢复 HEAD）
    // 注意：HEAD 有的文件 discard 后必须 git.add 同步 index，否则 statusMatrix 是 [1,1,0] 会误报 modified
    for (const it of items) {
      const inHead = await blobAt(root, 'HEAD', it.path) !== null;
      if (inHead) {
        const r = await discard(dir, it.path);
        if (!r.ok) return { ok: false, error: '已搁置但部分文件回滚失败：' + it.path };
        await stageFile(root, posix(it.path));
      } else {
        // HEAD 没有（新增/未跟踪）：清 index + 删文件
        try { await git.remove({ fs, dir: root, filepath: it.path }); } catch {}
        fs.rmSync(path.join(root, native(it.path)), { force: true });
      }
    }
    return { ok: true, id, files: items.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function shelveList(dir) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库', shelves: [] };
  try {
    const dirPath = path.join(root, '.git', SHELVES_DIR);
    if (!fs.existsSync(dirPath)) return { ok: true, shelves: [] };
    const shelves = [];
    for (const f of fs.readdirSync(dirPath)) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dirPath, f), 'utf8'));
        shelves.push({
          id: m.id, name: m.name, createdAt: m.createdAt, branch: m.branch,
          files: (m.files || []).map((x) => ({ path: x.path, status: x.status })),
        });
      } catch {}
    }
    shelves.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { ok: true, shelves };
  } catch (e) {
    return { ok: false, error: String(e.message || e), shelves: [] };
  }
}

async function shelveApply(dir, id, { force } = {}) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  try {
    const file = shelveFile(root, id);
    if (!fs.existsSync(file)) return { ok: false, error: '搁置不存在或已被删除' };
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = m.files || [];
    if (!items.length) return { ok: false, error: '该搁置没有文件' };
    // 目标文件当前有未提交改动 → 拒绝（force 覆盖）
    if (!force) {
      const st = await status(dir);
      const dirty = new Set(st.changed.map((c) => posix(c.file)));
      const conflict = items.filter((x) => dirty.has(x.path)).map((x) => x.path);
      if (conflict.length) {
        return { ok: false, conflict: true, error: '以下文件有未提交的修改，恢复搁置会覆盖它们：\n' + conflict.join('\n') + '\n（可选择强制覆盖继续）' };
      }
    }
    for (const it of items) {
      const abs = path.join(root, native(it.path));
      if (it.content == null) {
        // 快照时文件被删除 → 恢复删除动作
        fs.rmSync(abs, { force: true });
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(it.content, 'base64'));
      }
    }
    return { ok: true, files: items.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function shelveDelete(dir, id) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { ok: false, error: '不是 Git 仓库' };
  try {
    const file = shelveFile(root, id);
    if (!fs.existsSync(file)) return { ok: false, error: '搁置不存在' };
    fs.rmSync(file, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------- 文件历史（log --follow 简化版：改动的提交，不含重命名追踪）----------
async function logFile(dir, file, limit = 500) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { isRepo: false, error: '不是 Git 仓库', commits: [] };
  const rel = posix(String(file).replace(/^[\\/]+/, ''));
  try {
    const entries = await git.log({ fs, dir: root, depth: limit });
    const oidCache = new Map(); // commitOid -> blobOid|null
    const blobOidAt = async (commitOid) => {
      if (oidCache.has(commitOid)) return oidCache.get(commitOid);
      let v = null;
      try { const r = await git.readBlob({ fs, dir: root, oid: commitOid, filepath: rel }); v = r.oid; } catch {}
      oidCache.set(commitOid, v);
      return v;
    };
    const commits = [];
    for (const e of entries) {
      const cOid = await blobOidAt(e.oid);
      const hasParent = e.commit.parent && e.commit.parent[0];
      const pVal = hasParent ? await blobOidAt(e.commit.parent[0]) : '\0'; // 首提交无父 → 必不等 → 视为新增
      if (cOid !== pVal) {
        commits.push({
          oid: e.oid, short: e.oid.slice(0, 7),
          message: (e.commit.message || '').split('\n')[0],
          author: e.commit.author.name, email: e.commit.author.email,
          timestamp: e.commit.author.timestamp * 1000, parents: e.commit.parent,
        });
      }
    }
    return { isRepo: true, root, file: native(rel), commits };
  } catch (e) {
    if (String(e.message || e).includes('HEAD')) return { isRepo: true, commits: [], unborn: true, file: native(rel) };
    return { isRepo: true, error: String(e.message || e), commits: [], file: native(rel) };
  }
}

// ---------- Blame（谁在哪个提交改的这行）----------
// 算法：正向重放——从最早引入文件的提交开始，逐提交应用 diff，
// 新增行记为该提交、上下文行携带旧归因；最后叠加未提交的工作区改动（归因 = 未提交）
async function blame(dir, file) {
  const { yes, root } = await isRepo(dir);
  if (!yes) return { error: '不是 Git 仓库' };
  const rel = posix(String(file).replace(/^[\\/]+/, ''));
  const abs = path.isAbsolute(file) ? file : path.join(root, native(file));
  const hist = await logFile(dir, rel, 300);
  if (hist.error) return { error: hist.error };
  if (!hist.commits.length) {
    // 无历史（未跟踪/未提交）→ 全部归因为未提交
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { return { error: '文件不存在' }; }
    return {
      file: native(rel), untracked: true,
      lines: linesOf(text).map((t) => ({ text: t, commit: null, uncommitted: true })),
    };
  }
  const blobText = async (commitOid) => {
    try {
      const { blob } = await git.readBlob({ fs, dir: root, oid: commitOid, filepath: rel });
      const t = Buffer.from(blob).toString('utf8');
      return isBinaryText(t) ? null : t;
    } catch { return null; }
  };
  let lines = [];
  let blames = [];
  for (const c of [...hist.commits].reverse()) { // 旧 → 新重放
    const text = await blobText(c.oid);
    if (text === null) continue;
    const textLines = linesOf(text);
    const ops = diffLines(lines.map((l) => l.text).join('\n'), text);
    const newLines = [], newBlames = [];
    for (const o of ops) {
      if (o.type === 'ctx') { newLines.push(lines[o.aLine]); newBlames.push(blames[o.aLine]); }
      else if (o.type === 'add') { newLines.push({ text: textLines[o.bLine] ?? '' }); newBlames.push(c); }
    }
    lines = newLines; blames = newBlames;
  }
  // 叠加未提交的工作区改动
  let workText = null;
  try {
    workText = fs.readFileSync(abs, 'utf8');
    if (isBinaryText(workText)) workText = null;
  } catch {}
  if (workText !== null) {
    const headText = lines.map((l) => l.text).join('\n');
    if (headText !== workText) {
      const workLines = linesOf(workText);
      const ops = diffLines(headText, workText);
      const newLines = [], newBlames = [];
      for (const o of ops) {
        if (o.type === 'ctx') { newLines.push(lines[o.aLine]); newBlames.push(blames[o.aLine]); }
        else if (o.type === 'add') { newLines.push({ text: workLines[o.bLine] ?? '' }); newBlames.push({ uncommitted: true }); }
      }
      lines = newLines; blames = newBlames;
    }
  }
  return {
    file: native(rel),
    lines: lines.map((l, i) => ({
      text: l.text,
      oid: blames[i] && blames[i].oid, short: blames[i] && blames[i].short,
      author: blames[i] && blames[i].author, timestamp: blames[i] && blames[i].timestamp,
      uncommitted: !!(blames[i] && blames[i].uncommitted),
    })),
  };
}

module.exports = {
  findRoot, isRepo, status, log, logGraph, topoSortNewestFirst, commit, initRepo,
  branches, checkout, createBranch, discard, discardFiles, getUserConfig, setUserConfig,
  diffWorkdir, diffCommit, diffRefs, compareRefs, commitFiles, diffLines, buildHunks, linesOf, matrixToStatus,
  // M3：双区差异 + hunk 级暂存/取消暂存/回退（+ 供测试直接验的纯拼接函数）
  diffUnstaged, diffStaged, stageHunk, unstageHunk, revertHunk, applyHunkToText,
  listRemotes, addRemote, removeRemote, fetchRemote, pullRemote, pushRemote, aheadBehind,
  listTags, createTag, revertCommit, cherryPick, listPushCommits,
  shelveCreate, shelveList, shelveApply, shelveDelete, logFile, blame,
  addToGitignore, removeFromGitignore, listIgnored,
};
// 导出的写操作共用仓库队列；内部调用保留原流程，不递归获取同一把队列锁。
const serializeGit=require('./git-queue').createQueue();
for(const name of ['commit','checkout','createBranch','discard','discardFiles','stageHunk','unstageHunk','revertHunk','pullRemote','shelveCreate','shelveApply','revertCommit','cherryPick']){const original=module.exports[name];module.exports[name]=(dir,...args)=>serializeGit(dir,()=>original(dir,...args));}

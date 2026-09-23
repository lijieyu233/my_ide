// git-native.js —— 原生 git 命令行后端（M2「按能力路由」里的 Native 那一半）
//
// 定位：**只负责"调用本机 git"这一件事**。
//   · merge / rebase / stash / hooks / partial staging / credential 这些 isomorphic-git 没有
//     （或做不好）的能力从这里走；
//   · status / log / diff / commit / branch 继续留在 git-service.js（isomorphic-git 实现，
//     已经稳定，不为"架构漂亮"重写）。
//   也就是说：**这不是推倒重建 Git 层，而是把已经在跑的 spawn git 收编成正式后端**。
//
// ⚠ 本文件同时被主进程与 git-worker 线程加载（git-service 会 require 它），所以配置**不靠内存注入**：
//   每次用之前读一次配置文件（1 秒缓存），跨进程 / 跨线程都一致。
//   `sandbox: true` 的 preload 不能 require 本地模块 → 渲染层只通过 IPC 拿 backendInfo / setGitExe。
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 能力位：探测不到本机 git 时全 false，上层据此隐藏/禁用高级功能（软依赖，不是启动硬依赖）
const EMPTY_CAPS = {
  merge: false, rebase: false, stash: false, hooks: false,
  partialStaging: false, credential: false, worktree: false,
};

// 配置文件默认放用户级 `~/.myide/git-native.json`（"本机 git 在哪"对所有项目都一样）。
// ⚠ 不用 app.getPath('userData')：git-worker 线程不经过 main 的初始化，注入路径必然有一边拿不到；
//   用固定的用户级路径，主进程 / worker / 测试三方天然一致。`setConfigPath` 只给测试改写到临时目录。
const defaultCfgPath = () => path.join(os.homedir(), '.myide', 'git-native.json');
let cfgPath = null;                       // null = 用默认路径
let cfgCache = { at: 0, data: { exe: '' } };
let probed = null;                        // 最近一次探测结果（probe 的缓存）

function setConfigPath(p) { cfgPath = p || null; cfgCache = { at: 0, data: { exe: '' } }; probed = null; }
function readCfg() {
  const now = Date.now();
  if (now - cfgCache.at < 1000) return cfgCache.data;
  let data = { exe: '' };
  const f = cfgPath || defaultCfgPath();
  try { data = Object.assign({ exe: '' }, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {}
  cfgCache = { at: now, data };
  return data;
}
function saveCfg(patch) {
  const data = Object.assign({ exe: '' }, readCfg(), patch);
  cfgCache = { at: Date.now(), data };
  try {
    const f = cfgPath || defaultCfgPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(data, null, 2));
  } catch {}
  return data;
}
const configuredExe = () => String((readCfg().exe || '')).trim();

// 候选顺序：用户指定 → PATH 里的 git → Windows 常见安装位置
const WIN_GUESS = [
  'C:/Program Files/Git/bin/git.exe',
  'C:/Program Files/Git/cmd/git.exe',
  'C:/Program Files (x86)/Git/bin/git.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs/Git/bin/git.exe'),
];
function candidates() {
  const out = [];
  const cfgExe = configuredExe();
  if (cfgExe) out.push(cfgExe);
  out.push('git');
  if (process.platform === 'win32') out.push(...WIN_GUESS.filter(Boolean));
  return [...new Set(out)];
}

// 跑一条 git 命令：**永不抛**，统一返回 { ok, code, stdout, stderr, error }
// ⚠ `env` 只做**叠加**（默认继承 process.env）。M4 的 continue 类命令必须带 GIT_EDITOR=true，
//   否则 git 会去拉编辑器、进程永远不退出（无头环境下表现为"卡住"）。
function run(args, { cwd, timeout = 15000, input = null, exe = null, env = null } = {}) {
  const bin = exe || configuredExe() || 'git';
  return new Promise((resolve) => {
    let child;
    const done = (err, stdout, stderr) => resolve({
      ok: !err,
      code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
      error: err ? String(err.message || err) : '',
    });
    try {
      child = execFile(bin, args, {
        cwd: cwd || undefined, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
        env: env ? Object.assign({}, process.env, env) : undefined,
      }, (err, stdout, stderr) => done(err, stdout, stderr));
    } catch (e) { done(e, '', ''); return; }
    if (input != null && child && child.stdin) { try { child.stdin.end(input); } catch {} }
  });
}

// 不拉编辑器 / 不弹凭证框 / 不起后台 gc：所有可能触发交互或留后台进程的命令都套这一层。
// ⚠ `GIT_OPTIONAL_LOCKS=0` 是实测加的：不加时 git 会顺手起后台 `gc --auto`，
//   那个进程继承当前 stdio，会让「跑完命令的父进程」（npm test / 自检）卡在等管道关闭上。
const NO_EDIT = {
  GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0',
};

// 探测：git 路径 + 版本 + 能力位。设置页「测试」、启动、自检都问这一个（默认 60s 缓存）。
async function probe(force) {
  if (!force && probed && Date.now() - probed.at < 60000) return probed;
  const info = {
    available: false, exe: '', version: '', source: '',
    caps: Object.assign({}, EMPTY_CAPS), error: '', at: Date.now(), candidates: candidates(),
  };
  for (const cand of info.candidates) {
    const r = await run(['--version'], { timeout: 5000, exe: cand });
    if (!r.ok) { info.error = r.error || ('exit ' + r.code); continue; }
    const m = r.stdout.match(/git version (\d+)\.(\d+)(?:\.(\d+))?/i);
    if (!m) { info.error = '无法解析版本：' + r.stdout.trim().slice(0, 60); continue; }
    info.available = true;
    info.exe = cand;
    info.version = m[1] + '.' + m[2] + (m[3] ? '.' + m[3] : '');
    info.source = cand === configuredExe() ? 'configured' : (cand === 'git' ? 'PATH' : 'guess');
    const major = parseInt(m[1], 10), minor = parseInt(m[2], 10);
    const ge = (M, N) => major > M || (major === M && minor >= N);
    info.caps = {
      merge: ge(1, 0), rebase: ge(1, 0), stash: ge(1, 0), hooks: ge(1, 0),
      partialStaging: ge(2, 0),   // apply --cached（hunk/行级暂存靠它）
      credential: ge(1, 7),       // git credential fill
      worktree: ge(2, 5),
    };
    break;
  }
  probed = info;
  return info;
}

// 设置页「测试」：拿一个候选路径试跑，**不落盘**（自检也只调这个 → 不动用户的配置）
async function testExe(cand) {
  const bin = String(cand || '').trim() || configuredExe() || 'git';
  const r = await run(['--version'], { timeout: 5000, exe: bin });
  if (!r.ok) return { ok: false, exe: bin, error: r.error || ('exit ' + r.code) };
  const m = r.stdout.match(/git version (\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!m) return { ok: false, exe: bin, error: '无法解析版本：' + r.stdout.trim().slice(0, 60) };
  return { ok: true, exe: bin, version: m[1] + '.' + m[2] + (m[3] ? '.' + m[3] : '') };
}

// 设置页「测试 / 保存路径」：写配置 + 强制重新探测
async function setExe(p) {
  saveCfg({ exe: String(p || '').trim() });
  return probe(true);
}

// ---------- 系统 Git 凭证（`git credential fill`）：与命令行共享凭证管理器 ----------
// ⚠ 必须带 GCM_INTERACTIVE=never + GIT_TERMINAL_PROMPT=0：查不到就直接失败，**绝不弹窗阻塞 UI**（踩过）。
// 结果按 protocol//host 进程内缓存（**失败不写缓存**：一次抖动固化 null 会让后续推送全跳过系统凭证）。
const credCache = new Map();
function credentialFill(url) {
  let u; try { u = new URL(url); } catch { return Promise.resolve(null); }
  if (!/^https?:$/.test(u.protocol)) return Promise.resolve(null);   // 仅 http(s) 远程
  const key = u.protocol + '//' + u.host;
  if (credCache.has(key)) return Promise.resolve(credCache.get(key));
  return new Promise((resolve) => {
    let settled = false;
    const done = (v, cache) => { if (!settled) { settled = true; if (cache) credCache.set(key, v); resolve(v); } };
    try {
      const bin = configuredExe() || 'git';
      const child = execFile(bin, ['credential', 'fill'], {
        timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024,
        env: Object.assign({}, process.env, { GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' }),
      }, (err, stdout) => {
        if (err) return done(null, false);
        const s = String(stdout);
        const mu = s.match(/^username=(.*)$/m), mp = s.match(/^password=(.*)$/m);
        done(mu && mp ? { username: mu[1], password: mp[1] } : null, !!(mu && mp));
      });
      child.stdin.on('error', () => {});   // stdin 异常不致命（超时 kill 时可能触发）
      child.stdin.write('protocol=' + u.protocol.replace(':', '') + '\nhost=' + u.host + '\n\n');
      child.stdin.end();
    } catch { done(null); }
  });
}

// ---------- 代理：命令行 git 读 http.proxy（含 http.<url>.proxy 按主机匹配）----------
// isomorphic-git 完全忽略这份配置 → 只能直连碰运气。这里问同一个配置（三层级合并 + URL 匹配）。
const proxyCache = new Map();   // root \n url -> proxyUrl
function proxyFor(root, url) {
  const key = root + '\n' + url;
  if (proxyCache.has(key)) return Promise.resolve(proxyCache.get(key));
  return new Promise((resolve) => {
    let settled = false;
    const done = (v, cache) => { if (!settled) { settled = true; if (cache && v) proxyCache.set(key, v); resolve(v || null); } };
    try {
      execFile(configuredExe() || 'git', ['-C', root, 'config', '--get-urlmatch', 'http.proxy', url], {
        timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024,
      }, (err, stdout) => done(!err && stdout ? stdout.trim() : null, !err && !!stdout));
    } catch { done(null, false); }
  });
}

// 给自检/设置页用的形状（能安全过 IPC 的纯数据）
async function info(force) {
  const i = await probe(force);
  return {
    git: { available: i.available, exe: i.exe, version: i.version, source: i.source, error: i.error, candidates: i.candidates },
    caps: i.caps,
    fallback: { name: 'isomorphic-git', version: '1.41.4' },
    routing: ROUTING_DOC,
  };
}

// ---------- M4：分支工作流（merge / rebase / 操作状态机 / 冲突解决） ----------
// 全部走本机 git —— isomorphic-git **没有** merge / rebase，自己实现等于重写一遍合并算法（不可接受）。
// 入口仍是白名单能力（`merge` / `rebase` / `opState` / `conflicts` / `resolveFile` / `continueOp` …），
// 不提供任意命令口子。

const has = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const readTrim = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };

// 当前 Git 操作状态：NORMAL / MERGING / REBASING / CHERRY_PICKING / REVERTING
// 判据就是 `.git` 下的标记文件（与 git 自己判断 "You have not concluded your merge" 同源）。
// ⚠ `rebase-merge` = 交互式 rebase（`-i`），`rebase-apply` = 普通 rebase / am。两者都算 REBASING。
async function opState(repo) {
  const state = { state: 'NORMAL', target: '', onto: '', step: '', total: '' };
  try {
    const dot = await run(['rev-parse', '--git-dir'], { cwd: repo, timeout: 5000 });
    if (!dot.ok) return state;
    const g = path.isAbsolute(dot.stdout.trim()) ? dot.stdout.trim() : path.join(repo, dot.stdout.trim());
    const f = (n) => path.join(g, n);
    if (has(f('rebase-merge')) || has(f('rebase-apply'))) {
      state.state = 'REBASING';
      const dir = has(f('rebase-merge')) ? f('rebase-merge') : f('rebase-apply');
      state.target = readTrim(path.join(dir, 'head-name')).replace(/^refs\/heads\//, '');
      state.onto = readTrim(path.join(dir, 'onto')).slice(0, 7);
      state.step = readTrim(path.join(dir, 'msgnum'));
      state.total = readTrim(path.join(dir, 'end'));
    } else if (has(f('MERGE_HEAD'))) {
      state.state = 'MERGING';
      state.target = readTrim(f('MERGE_HEAD')).slice(0, 7);
      // 尽量还原成分支名（MERGE_MSG 第一行就是 "Merge branch 'x'"）
      const mm = readTrim(f('MERGE_MSG'));
      const m = mm.match(/Merge (?:branch|commit|remote-tracking branch) '([^']+)'/);
      if (m) state.target = m[1];
    } else if (has(f('CHERRY_PICK_HEAD'))) {
      state.state = 'CHERRY_PICKING';
      state.target = readTrim(f('CHERRY_PICK_HEAD')).slice(0, 7);
    } else if (has(f('REVERT_HEAD'))) {
      state.state = 'REVERTING';
      state.target = readTrim(f('REVERT_HEAD')).slice(0, 7);
    }
  } catch {}
  return state;
}

// 冲突文件列表（`git diff --name-only --diff-filter=U` = 未合并的条目；git 自己的口径）
// ⚠ 本机偶发一次 `git diff` 非零退出（空 stderr，重试即成功 —— 环境层面的抖动，不是代码问题）；
//   这是只读命令，失败重试一次比直接报错给用户体验好得多。
async function conflicts(repo) {
  let r = await run(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: repo, timeout: 10000, env: NO_EDIT });
  if (!r.ok) {
    await new Promise((s) => setTimeout(s, 250));
    r = await run(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: repo, timeout: 10000, env: NO_EDIT });
  }
  if (!r.ok) return { ok: false, error: r.stderr.trim() || r.error, files: [] };
  const files = r.stdout.split('\0').map((s) => s.trim()).filter(Boolean);
  // 顺带给出每个文件是否已经解决（status --porcelain 里 UU=未解决，M /A = 已 add 过）
  const st = await run(['status', '--porcelain', '-z'], { cwd: repo, timeout: 10000, env: NO_EDIT });
  const map = new Map();
  for (const line of String(st.stdout).split('\0')) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2).trim();
    map.set(line.slice(3).trim(), xy);
  }
  return {
    ok: true,
    files: files.map((f) => ({ file: f, resolved: map.has(f) && !/U/.test(map.get(f) || '') })),
  };
}

// 冲突文件的三方内容：:1=共同祖先(base) :2=ours :3=theirs
// ⚠ rebase 时 ours/theirs 的含义会**反过来**（git 语义：ours=新基底、theirs=正在重放的提交），
//   UI 文案必须按 opState 说明，不能一律写成"你的修改"。
async function conflictSides(repo, file) {
  const get = async (n) => {
    const r = await run(['show', ':' + n + ':' + file], { cwd: repo, timeout: 10000, env: NO_EDIT });
    return r.ok ? r.stdout : null;
  };
  const [base, ours, theirs] = [await get(1), await get(2), await get(3)];
  return { ok: ours !== null || theirs !== null, base, ours, theirs };
}

// 取某一侧覆盖冲突文件并标记为已解决（git checkout --ours/--theirs + git add）
async function resolveFile(repo, file, side) {
  const flag = side === 'theirs' ? '--theirs' : '--ours';
  const a = await run(['checkout', flag, '--', file], { cwd: repo, timeout: 10000, env: NO_EDIT });
  if (!a.ok) return { ok: false, error: a.stderr.trim() || a.error };
  const b = await run(['add', '--', file], { cwd: repo, timeout: 10000, env: NO_EDIT });
  return b.ok ? { ok: true } : { ok: false, error: b.stderr.trim() || b.error };
}

// merge：默认允许 fast-forward；noFf 强制建合并提交；ffOnly 只接受快进
async function merge(repo, ref, opts = {}) {
  const args = ['merge'];
  if (opts.noFf) args.push('--no-ff');
  if (opts.ffOnly) args.push('--ff-only');
  args.push('--', ref);
  const r = await run(args, { cwd: repo, timeout: 30000, env: NO_EDIT });
  const st = await opState(repo);
  if (r.ok) return { ok: true, conflict: false, state: st, out: r.stdout.trim() };
  // merge 冲突时 git 退出码非 0，但仓库进入了 MERGING —— 这不是"失败"，是"待你解决"
  if (st.state === 'MERGING') return { ok: true, conflict: true, state: st, out: r.stdout.trim() || r.stderr.trim() };
  return { ok: false, error: r.stderr.trim() || r.stdout.trim() || r.error, state: st };
}

async function rebase(repo, ref) {
  const r = await run(['rebase', '--', ref], { cwd: repo, timeout: 60000, env: NO_EDIT });
  const st = await opState(repo);
  if (r.ok) return { ok: true, conflict: false, state: st, out: r.stdout.trim() };
  if (st.state === 'REBASING') return { ok: true, conflict: true, state: st, out: r.stdout.trim() || r.stderr.trim() };
  return { ok: false, error: r.stderr.trim() || r.stdout.trim() || r.error, state: st };
}

// 继续 / 跳过 / 终止 —— 按当前状态选命令（用户不需要知道自己在哪种状态）
async function continueOp(repo) {
  const st = await opState(repo);
  const cmd = { MERGING: ['merge', '--continue'], REBASING: ['rebase', '--continue'],
    CHERRY_PICKING: ['cherry-pick', '--continue'], REVERTING: ['revert', '--continue'] }[st.state];
  if (!cmd) return { ok: false, error: '当前没有进行中的 Git 操作' };
  const r = await run(cmd, { cwd: repo, timeout: 60000, env: NO_EDIT });
  return { ok: r.ok, error: r.ok ? '' : r.stderr.trim() || r.stdout.trim() || r.error, state: await opState(repo), out: r.stdout.trim() };
}
async function skipOp(repo) {
  const st = await opState(repo);
  // merge / revert 没有 --skip（语义上无处可跳）→ 明确拒绝，别让按钮点了没反应
  const cmd = { REBASING: ['rebase', '--skip'], CHERRY_PICKING: ['cherry-pick', '--skip'] }[st.state];
  if (!cmd) return { ok: false, error: st.state === 'NORMAL' ? '当前没有进行中的 Git 操作' : st.state + ' 不支持跳过（只有 rebase / cherry-pick 可以）' };
  const r = await run(cmd, { cwd: repo, timeout: 60000, env: NO_EDIT });
  return { ok: r.ok, error: r.ok ? '' : r.stderr.trim() || r.stdout.trim() || r.error, state: await opState(repo), out: r.stdout.trim() };
}
async function abortOp(repo) {
  const st = await opState(repo);
  const cmd = { MERGING: ['merge', '--abort'], REBASING: ['rebase', '--abort'],
    CHERRY_PICKING: ['cherry-pick', '--abort'], REVERTING: ['revert', '--abort'] }[st.state];
  if (!cmd) return { ok: false, error: '当前没有进行中的 Git 操作' };
  const r = await run(cmd, { cwd: repo, timeout: 30000, env: NO_EDIT });
  return { ok: r.ok, error: r.ok ? '' : r.stderr.trim() || r.stdout.trim() || r.error, state: await opState(repo) };
}

// ---------- M4-C：分支操作（从指定提交建分支 / 重命名 / 删除） ----------
// ⚠ isomorphic-git 的 `git.branch` 只能从 HEAD 建分支、不能删/改名 —— 这三个只能靠本机 git。
//   checkout 保留 isomorphic 的实现（已在 git-service），这里不重复。
async function branchCreate(repo, name, ref, checkout) {
  if (!name || !/^[A-Za-z0-9._/-]+$/.test(name)) return { ok: false, error: '分支名不合法' };
  const args = checkout ? ['checkout', '-b', name] : ['branch', name];
  if (ref) args.push(ref);
  const r = await run(args, { cwd: repo, timeout: 15000, env: NO_EDIT });
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() || r.error };
}
async function branchRename(repo, from, to) {
  const r = await run(['branch', '-m', from, to], { cwd: repo, timeout: 15000, env: NO_EDIT });
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() || r.error };
}
async function branchDelete(repo, name, force) {
  // -D（强删，丢弃未合并提交）需明确确认；默认 -d（未合并的会拒绝，更安全）
  const r = await run(['branch', force ? '-D' : '-d', name], { cwd: repo, timeout: 15000, env: NO_EDIT });
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() || r.error };
}

// 「按能力路由」的表：现在只有 credential / proxy 内部走 native（M2）；M3/M4 往这里加
// partialStaging（apply --cached）与 merge/rebase/stash/hooks。**没有 git.exec(任意字符串) 这种口子**，
// 上层只能调用明确列出的能力。
const ROUTING_DOC = {
  native: ['credential', 'merge', 'rebase', 'opState', 'conflicts', 'resolveFile', 'continue/skip/abort'],
  isomorphic: ['status', 'log', 'diff', 'commit', 'branch', 'tag', 'shelve', 'revert', 'cherryPick', 'blame'],
  planned: { partialStaging: 'git apply --cached', stash: 'git stash', hooks: '提交时执行 .git/hooks/*' },
};

module.exports = {
  setConfigPath, probe, info, setExe, testExe, run, credentialFill, proxyFor,
  getExe: () => configuredExe() || 'git', EMPTY_CAPS,
  // M4：分支工作流与冲突（本机 git；无本机 git 时由上层按 caps 隐藏）
  opState, conflicts, conflictSides, resolveFile, merge, rebase, continueOp, skipOp, abortOp,
  branchCreate, branchRename, branchDelete,
};

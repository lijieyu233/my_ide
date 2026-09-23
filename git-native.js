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
function run(args, { cwd, timeout = 15000, input = null, exe = null } = {}) {
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
      }, (err, stdout, stderr) => done(err, stdout, stderr));
    } catch (e) { done(e, '', ''); return; }
    if (input != null && child && child.stdin) { try { child.stdin.end(input); } catch {} }
  });
}

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

// 「按能力路由」的表：现在只有 credential / proxy 内部走 native（M2）；M3/M4 往这里加
// partialStaging（apply --cached）与 merge/rebase/stash/hooks。**没有 git.exec(任意字符串) 这种口子**，
// 上层只能调用明确列出的能力。
const ROUTING_DOC = {
  native: ['credential'],
  isomorphic: ['status', 'log', 'diff', 'commit', 'branch', 'tag', 'shelve', 'revert', 'cherryPick', 'blame'],
  planned: { partialStaging: 'git apply --cached', merge: 'git merge', rebase: 'git rebase', stash: 'git stash', hooks: '提交时执行 .git/hooks/*' },
};

module.exports = {
  setConfigPath, probe, info, setExe, testExe, run, credentialFill, proxyFor,
  getExe: () => configuredExe() || 'git', EMPTY_CAPS,
};

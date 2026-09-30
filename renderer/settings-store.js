// settings-store.js —— 本地设置（localStorage）的容错层
//
// 为什么必须有这一层（2026-09-30 实测，用户原话「上次的记录没有保存」）：
//   本应用全部设置都存 localStorage，而它落在 Chromium profile（%APPDATA%\my-ide）。
//   一旦那个目录不可写 —— 实测是被加了一条**继承下来的只读权限**
//   （%APPDATA% 上 `CodexSandboxUsers =(I)(RX)`，会传播到所有子目录）—— 现象极其隐蔽：
//     · `setItem` 在内存里照样成功，**落盘静默失败**：渲染层 57 处 `catch {}` 一处都发现不了；
//     · 下次启动 localStorage 近乎为空 → 主题 / 项目 / 标签页全部"没保存"。
//   原先既没有备份、也没有自愈，**坏了就一直坏**（数据其实还完好地躺在 leveldb 的 .ldb 里，
//   只是索引读不到 —— 这个现场是用手写的 leveldb 解析器救回来的）。
//
// 这一层做四件事：
//   ① 兜底镜像：每次写 myide-* 设置，防抖同步一份到 `~/.myide/settings.json`
//      （交给**主进程的 node fs** 写，绕开 Chromium profile 那套权限；同 git-native.json 的做法）
//   ② 启动自愈：镜像里有、本地没有的键，开机同步补回来 ——「坏了就一直坏」到此为止
//      ⚠ 只补缺失、**绝不覆盖**：本地可能已有更新的值（镜像只是还没跟上），覆盖会倒退回旧设置
//   ③ 失败可见：向主进程查 profile 到底能不能写，不能写就明确告诉用户，不再当没发生
//   ④ 手动导出 / 导入：把全部设置存成一份 JSON（这轮救数据走的就是同一条路径）
//
// ⚠ 为什么打 `Storage.prototype` 而不是替换 `window.localStorage`：
//   全仓 57 处 setItem 散在 20 个文件里；写原型方法能**无侵入**覆盖所有现存与将来的调用点，
//   而替换 window.localStorage 在 Electron 里不一定可配置（还可能踩到只读属性）。
const SettingsStore = (() => {
  const PREFIX = 'myide-';
  const LS = window.localStorage;
  const proto = Object.getPrototypeOf(LS);

  // 保存原始实现：内部读写一律走它们，避免触发自己打的钩子（否则递归）
  const raw = {
    getItem: proto.getItem,
    setItem: proto.setItem,
    removeItem: proto.removeItem,
    clear: proto.clear,
    key: proto.key,
  };
  let lenGetter = null;
  try { lenGetter = Object.getOwnPropertyDescriptor(proto, 'length').get; } catch {}

  const bridge = () => (window.myIDE && window.myIDE.settings) || null;

  const read = (k) => { try { return raw.getItem.call(LS, k); } catch { return null; } };
  const write = (k, v) => { try { raw.setItem.call(LS, k, String(v)); return true; } catch { return false; } };
  const drop = (k) => { try { raw.removeItem.call(LS, k); return true; } catch { return false; } };
  const allKeys = () => {
    const out = [];
    try {
      const n = lenGetter ? lenGetter.call(LS) : LS.length;
      for (let i = 0; i < n; i++) { const k = raw.key.call(LS, i); if (k != null) out.push(k); }
    } catch {}
    return out;
  };

  // 全部 myide-* 设置（镜像与导出用的都是这个形状）
  function snapshot() {
    const o = {};
    for (const k of allKeys()) if (k.startsWith(PREFIX)) o[k] = read(k);
    return o;
  }

  // ---------- ① 镜像写入（防抖） ----------
  // 防抖 800ms：设置页拖滑块 / 编辑器改字号会连续写，没必要每次都落盘。
  // 另外页面隐藏 / 卸载时强制 flush 一次，把丢失窗口压到最小。
  let timer = null, lastJson = '', lastResult = { ok: false, skipped: true };
  let oversized = false;
  // 上限 4MB：正常全量设置实测 65KB（最大一项 myide-ai-sessions 约 24KB）。
  // 真撞上这个量级说明某项失控增长（比如 AI 会话历史滚雪球）——
  // 此时**不写**镜像并记一条日志，而不是把几百 MB 往盘上灌。
  const MIRROR_MAX = 4 * 1024 * 1024;
  function flushMirror() {
    clearTimeout(timer); timer = null;
    const b = bridge();
    if (!b || !b.mirrorWrite) return Promise.resolve({ ok: false, error: 'no-bridge' });
    const data = snapshot();
    data.__meta = { at: Date.now(), count: Object.keys(data).length - 1 };
    const json = JSON.stringify(data);
    if (json === lastJson) return Promise.resolve(lastResult);   // 没变就不写
    if (json.length > MIRROR_MAX) {
      if (!oversized) {
        oversized = true;
        try { if (window.MI && MI.log) MI.log('ERROR', 'settings', '设置镜像过大（' + Math.round(json.length / 1024) + 'KB），已跳过本次写入'); } catch {}
      }
      lastResult = { ok: false, error: 'too-large' };
      return Promise.resolve(lastResult);
    }
    oversized = false;
    lastJson = json;
    return Promise.resolve(b.mirrorWrite(data)).then((r) => { lastResult = r || { ok: false }; return lastResult; })
      .catch((e) => { lastResult = { ok: false, error: String(e) }; return lastResult; });
  }
  function scheduleMirror() {
    clearTimeout(timer);
    timer = setTimeout(flushMirror, 800);
  }

  // ---------- ② 启动自愈（同步，必须早于任何设置读取） ----------
  // 用 sendSync 而不是 async：theme.js / app.js 启动时立刻就要读设置，
  // 异步补写会晚一拍，表现为"主题先闪一下默认色再变"。
  let healResult = { healed: 0, total: 0, reason: 'not-run' };
  function healFromMirror() {
    const b = bridge();
    if (!b || !b.mirrorReadSync) { healResult = { healed: 0, total: 0, reason: 'no-bridge' }; return healResult; }
    let r = null;
    try { r = b.mirrorReadSync(); } catch { r = null; }
    const data = r && r.ok && r.data;
    if (!data) { healResult = { healed: 0, total: 0, reason: 'no-mirror' }; return healResult; }

    const mine = {};
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith(PREFIX) && typeof v === 'string') mine[k] = v;
    }
    const total = Object.keys(mine).length;
    if (!total) { healResult = { healed: 0, total: 0, reason: 'mirror-empty' }; return healResult; }

    const have = new Set(allKeys());
    const missing = Object.keys(mine).filter((k) => !have.has(k));
    let healed = 0;
    for (const k of missing) if (write(k, mine[k])) healed++;
    healResult = { healed, total, reason: healed ? 'restored' : 'intact' };
    return healResult;
  }

  // ---------- ③ 健康检查（异步，启动后跑） ----------
  let health = null;
  let warned = false;
  function warnDegraded(h) {
    if (warned) return;
    warned = true;
    const msg = '⚠ 设置无法保存到磁盘：' + (h.userData || '') + '\n'
      + '（' + (h.error || '目录不可写') + '）\n'
      + '已启用兜底镜像：' + h.mirror + '；改动仍会保留。';
    try { if (window.MI && MI.log) MI.log('ERROR', 'settings', msg.replace(/\n/g, ' ')); } catch {}
    // MI 可能还没就绪：等一小会儿再弹，避免启动早期 toast 被后续渲染吞掉
    const fire = () => { try { if (window.MI && MI.toast) MI.toast('⚠ 设置无法保存到磁盘，已启用兜底镜像（改动仍会保留）', 'err'); } catch {} };
    if (window.MI && MI.toast) fire(); else setTimeout(fire, 2500);
  }
  async function checkHealth() {
    const b = bridge();
    if (!b || !b.probe) return null;
    try { health = await b.probe(); } catch { return null; }
    if (health && health.writable === false) warnDegraded(health);
    return health;
  }

  // ---------- ④ 导出 / 导入 ----------
  function exportPayload() {
    return { app: 'my-ide', kind: 'settings-export', at: new Date().toISOString(), keys: snapshot() };
  }
  // 导入：只认 myide-* 的字符串值，其余一律丢弃（别让一份脏 JSON 写坏别的键）
  function applyImport(obj) {
    const keys = (obj && obj.keys) || obj || {};
    let n = 0;
    for (const [k, v] of Object.entries(keys)) {
      if (!k.startsWith(PREFIX) || typeof v !== 'string') continue;
      if (write(k, v)) n++;
    }
    return n;
  }

  // ---------- 安装钩子 ----------
  let installed = false;
  function install() {
    if (installed) return;
    installed = true;
    try {
      proto.setItem = function (k, v) {
        const r = raw.setItem.call(this, k, v);
        if (typeof k === 'string' && k.startsWith(PREFIX)) scheduleMirror();
        return r;
      };
      proto.removeItem = function (k) {
        const r = raw.removeItem.call(this, k);
        if (typeof k === 'string' && k.startsWith(PREFIX)) scheduleMirror();
        return r;
      };
      proto.clear = function () {
        const r = raw.clear.call(this);
        scheduleMirror();
        return r;
      };
    } catch (e) {
      // 打不上钩子也不能让应用起不来：退化成"没有镜像"，但至少不崩
      try { if (window.MI && MI.log) MI.log('ERROR', 'settings', '无法安装存储钩子: ' + e); } catch {}
    }
    // 丢失窗口兜底：页面隐藏/卸载时把镜像补上
    try {
      window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushMirror(); });
      window.addEventListener('pagehide', () => { flushMirror(); });
    } catch {}
  }

  // 启动顺序：先自愈（同步，让 theme/app 读到正确的值），再挂钩子，最后异步查健康
  install();
  healFromMirror();
  try { if (window.MI && MI.log && healResult.healed) MI.log('INFO', 'settings', '已从兜底镜像恢复 ' + healResult.healed + ' 项设置（本地存储不可用）'); } catch {}
  setTimeout(checkHealth, 1200);

  return {
    snapshot, flushMirror, healFromMirror, checkHealth, exportPayload, applyImport,
    get health() { return health; },
    get healResult() { return healResult; },
    PREFIX,
  };
})();
window.SettingsStore = SettingsStore;

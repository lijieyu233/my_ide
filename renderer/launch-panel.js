// launch-panel.js —— 启动面板（侧栏工具窗口）
// 配置：~/.myide/launch.json（机器级，用户拍板）；运行状态：~/.myide/launch-state.json
// ★ 后台保留（用户拍板）：子进程 detached + unref，关闭 my_ide 后继续运行 —— 所以"还活着"
//   不能只看内存进程表，必须靠「端口探测」+「落盘 PID」两种手段在重启后找回。
const LaunchPanel = (() => {
  const L = () => (window.myIDE && window.myIDE.launch) || null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const q = (id) => document.getElementById(id);

  let cfg = { apiOrigins: [], entries: [] };
  let status = {};           // id -> { alive, by, pid }
  let collapsed = {};        // 分类 -> bool（折叠）
  let logsOpen = {};         // id -> bool（日志展开）
  let logsText = {};         // id -> string[]（最近一次取到的日志）
  let timer = null;
  let inited = false;

  const groups = () => {
    const m = new Map();
    for (const e of cfg.entries) {
      const k = e.category || '未分类';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    return [...m.entries()];
  };
  const stOf = (id) => status[id] || { alive: false, by: 'none', pid: 0 };

  // ---------- 渲染 ----------
  function render() {
    const body = q('launch-body');
    if (!body) return;
    if (!cfg.entries.length) {
      body.innerHTML = '<div class="launch-empty">还没有终端条目。<br>点右下「导入」把 mh_launch_panel 的 '
        + 'panel-config.json 搬过来，或点「＋」手动添加。</div>';
      return;
    }
    const html = groups().map(([cat, list]) => {
      const isCol = !!collapsed[cat];
      return '<div class="launch-group">'
        + '<div class="launch-cat" data-cat="' + esc(cat) + '">'
        + '<span class="launch-caret">' + (isCol ? '▸' : '▾') + '</span>'
        + '<span class="launch-cat-nm">' + esc(cat) + '</span>'
        + '<span class="launch-cat-n">' + list.length + '</span></div>'
        + (isCol ? '' : '<div class="launch-cards">' + list.map(cardHtml).join('') + '</div>')
        + '</div>';
    }).join('');
    body.innerHTML = html;
  }

  function cardHtml(e) {
    const s = stOf(e.id);
    const dot = s.alive ? 'launch-dot on' : 'launch-dot';
    const title = s.alive
      ? ('运行中' + (s.by === 'port' ? '（端口 ' + e.port + '）' : s.pid ? '（PID ' + s.pid + '）' : ''))
      : '已停止';
    return '<div class="launch-card" data-id="' + esc(e.id) + '">'
      + '<div class="launch-card-head">'
      + '<span class="' + dot + '" title="' + esc(title) + '"></span>'
      + '<span class="launch-nm" title="' + esc(e.cwd || e.command) + '">' + esc(e.name) + '</span>'
      + (e.port ? '<span class="launch-port">:' + e.port + '</span>' : '')
      + '<span class="launch-acts">'
      + '<button class="vt-btn lp-btn" data-act="start" title="启动">▶</button>'
      + '<button class="vt-btn lp-btn" data-act="stop" title="停止">■</button>'
      + '<button class="vt-btn lp-btn" data-act="log" title="日志">▤</button>'
      + (e.openUrl ? '<button class="vt-btn lp-btn" data-act="open" title="打开页面">↗</button>' : '')
      + '</span></div>'
      + '<div class="launch-cmd" title="' + esc(e.command) + '">' + esc(e.command) + '</div>'
      + (logsOpen[e.id] ? logHtml(e) : '')
      + '</div>';
  }

  function logHtml(e) {
    const lines = logsText[e.id] || [];
    const tail = lines.slice(-120);
    return '<div class="launch-log"><div class="launch-log-bar">'
      + '<button class="vt-btn lp-btn" data-act="refresh-log" title="刷新">⟲</button>'
      + '<button class="vt-btn lp-btn" data-act="clear-log" title="清空">⊘</button>'
      + '<span class="launch-log-t">日志（' + lines.length + ' 行）</span></div>'
      + '<pre>' + esc(tail.join('\n') || '(暂无输出)') + '</pre></div>';
  }

  // 只更新状态点（render 会重建整棵 DOM → 日志滚动位置/折叠态会丢，轮询不能走全量 render）
  function refreshDots() {
    const body = q('launch-body');
    if (!body) return;
    for (const el of body.querySelectorAll('.launch-card')) {
      const id = el.getAttribute('data-id');
      const s = stOf(id);
      const dot = el.querySelector('.launch-dot');
      if (dot) dot.className = s.alive ? 'launch-dot on' : 'launch-dot';
      const e = cfg.entries.find((x) => x.id === id);
      if (dot && e) {
        dot.title = s.alive
          ? ('运行中' + (s.by === 'port' ? '（端口 ' + e.port + '）' : s.pid ? '（PID ' + s.pid + '）' : ''))
          : '已停止';
      }
    }
  }

  // ---------- 动作 ----------
  async function act(entry, kind) {
    const api = L();
    if (!api) return;
    if (kind === 'start') {
      const r = await api.start(entry);
      if (r && r.error) toast('启动失败：' + r.error, 'err');
      else toast('已启动：' + entry.name, 'ok');
    } else if (kind === 'stop') {
      await api.stop(entry);
      toast('已停止：' + entry.name, 'ok');
    } else if (kind === 'refresh-log') {
      const r = await api.logs(entry.id);
      logsText[entry.id] = (r && r.lines) || [];
      render();
    } else if (kind === 'clear-log') {
      await api.clearLogs(entry.id);
      logsText[entry.id] = [];
      render();
    }
    await pollOnce();
  }

  function toast(msg, type) {
    try { if (window.MI && MI.toast) { MI.toast(msg, type || 'info'); return; } } catch {}
    const box = q('launch-toast');
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'launch-toast-item' + (type === 'err' ? ' err' : '');
    d.textContent = msg;
    box.appendChild(d);
    setTimeout(() => d.remove(), 2600);
  }

  async function pollOnce() {
    const api = L();
    if (!api || !cfg.entries.length) return;
    const st = await api.status(cfg.entries);
    const m = {};
    for (const s of (st || [])) m[s.id] = s;
    status = m;
    refreshDots();
  }

  async function load() {
    const api = L();
    if (!api) return;
    cfg = await api.config();
    await pollOnce();
    render();
  }

  // ---------- 添加 / 编辑 ----------
  function openDialog(entry) {
    const dlg = q('launch-dialog');
    if (!dlg) return;
    const f = q('launch-form');
    const set = (n, v) => { const el = f.elements[n]; if (el) el.value = v == null ? '' : v; };
    set('id', entry && entry.id);
    set('name', entry && entry.name);
    set('category', entry && entry.category);
    set('cwd', entry && entry.cwd);
    set('command', entry && entry.command);
    set('port', entry && entry.port);
    set('apiOrigin', entry && entry.apiOrigin);
    set('openUrl', entry && entry.openUrl);
    q('launch-dialog-title').textContent = entry ? '编辑终端' : '添加终端';
    dlg.__editing = entry ? entry.id : null;
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  async function submitDialog() {
    const dlg = q('launch-dialog');
    const f = q('launch-form');
    const v = (n) => { const el = f.elements[n]; return el ? String(el.value || '').trim() : ''; };
    const item = {
      name: v('name'), category: v('category') || '未分类', cwd: v('cwd'),
      command: v('command'), port: Number(v('port')) || 0,
      apiOrigin: v('apiOrigin'), openUrl: v('openUrl'), kind: '', script: '', python: '',
    };
    if (!item.name || !item.command) { toast('名称与启动命令必填', 'err'); return; }
    const editing = dlg.__editing;
    const list = cfg.entries.slice();
    if (editing) {
      const i = list.findIndex((x) => x.id === editing);
      if (i >= 0) list[i] = Object.assign({}, list[i], item);
    } else {
      item.id = 'e' + Date.now().toString(36);
      list.push(item);
    }
    cfg = await L().save({ apiOrigins: cfg.apiOrigins, entries: list });
    dlg.__editing = null;
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
    render();
    await pollOnce();
  }

  async function removeEntry(id) {
    const e = cfg.entries.find((x) => x.id === id);
    if (!e) return;
    if (!window.confirm('删除终端「' + e.name + '」？（如果它正在运行，会先停止）')) return;
    await L().stop(e);
    cfg = await L().save({ apiOrigins: cfg.apiOrigins, entries: cfg.entries.filter((x) => x.id !== id) });
    render();
    await pollOnce();
  }

  // ---------- 事件 ----------
  function bind() {
    const body = q('launch-body');
    if (body) {
      body.addEventListener('click', (ev) => {
        const cat = ev.target.closest('.launch-cat');
        if (cat) {
          const k = cat.getAttribute('data-cat');
          collapsed[k] = !collapsed[k];
          render();
          return;
        }
        const btn = ev.target.closest('.lp-btn');
        if (!btn) return;
        const card = btn.closest('.launch-card');
        const id = card && card.getAttribute('data-id');
        const e = cfg.entries.find((x) => x.id === id);
        if (!e) return;
        const kind = btn.getAttribute('data-act');
        if (kind === 'log') {
          logsOpen[id] = !logsOpen[id];
          if (logsOpen[id]) act(e, 'refresh-log'); else render();
          return;
        }
        if (kind === 'open') { if (e.openUrl) L().openUrl(e.openUrl); return; }
        act(e, kind);
      });
      // 右键卡片 → 编辑/删除（用 contextmenu，避免侧栏挤按钮）
      body.addEventListener('contextmenu', (ev) => {
        const card = ev.target.closest('.launch-card');
        if (!card) return;
        const id = card.getAttribute('data-id');
        const e = cfg.entries.find((x) => x.id === id);
        if (!e) return;
        ev.preventDefault();
        const pick = window.confirm('「' + e.name + '」\n确定 = 编辑，取消 = 删除');
        if (pick) openDialog(e); else removeEntry(id);
      });
    }
    const add = q('launch-add');
    if (add) add.addEventListener('click', () => openDialog(null));
    const imp = q('launch-import');
    if (imp) imp.addEventListener('click', async () => {
      const p = window.prompt('导入 mh_launch_panel 的 panel-config.json 路径：',
        'D:\\document\\code\\tools\\mh_launch_panel\\panel-config.json');
      if (!p) return;
      const r = await L().import(p);
      if (r && r.ok) { toast('已导入 ' + r.count + ' 个条目', 'ok'); await load(); }
      else toast('导入失败：' + ((r && r.error) || '未知'), 'err');
    });
    const sa = q('launch-start-all');
    if (sa) sa.addEventListener('click', async () => {
      for (const e of cfg.entries) {
        const s = stOf(e.id);
        if (!s.alive) await act(e, 'start');
      }
    });
    const so = q('launch-stop-all');
    if (so) so.addEventListener('click', async () => {
      for (const e of cfg.entries) {
        if (stOf(e.id).alive) await act(e, 'stop');
      }
    });
    const ok = q('launch-dialog-ok');
    if (ok) ok.addEventListener('click', (ev) => { ev.preventDefault(); submitDialog(); });
    const cancel = q('launch-dialog-cancel');
    if (cancel) cancel.addEventListener('click', () => {
      const dlg = q('launch-dialog');
      if (dlg && typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
    });
  }

  function init() {
    if (inited) return;
    if (!q('launch-body')) return;
    inited = true;
    bind();
    load();
    if (timer) clearInterval(timer);
    timer = setInterval(pollOnce, 1500);   // 外部启停也要能反映到面板
  }

  return { init, refresh: load, isOpen: () => !!(q('panel-launch') && !q('panel-launch').classList.contains('hidden')) };
})();
window.LaunchPanel = LaunchPanel;

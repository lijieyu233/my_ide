// launch-panel.js —— 启动面板（侧栏条目列表 + 主区详情/日志，双区联动，照 db 面板的模式）
// 配置：~/.myide/launch.json（机器级，用户拍板）；运行状态：~/.myide/launch-state.json
// ★ 后台保留（用户拍板）：子进程 detached + unref，关 my_ide 后继续跑 ——
//   "还活着"不能只看内存进程表，必须靠「端口探测」+「落盘 PID」在重启后找回。
const LaunchPanel = (() => {
  const L = () => (window.myIDE && window.myIDE.launch) || null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const q = (id) => document.getElementById(id);

  let cfg = { apiOrigins: [], entries: [] };
  let status = {};           // id -> { alive, by, pid }
  let selectedId = null;     // 主区当前展示的条目
  let collapsed = {};        // 分类折叠
  let timer = null;
  let inited = false;

  const stOf = (id) => status[id] || { alive: false, by: 'none', pid: 0 };
  const byId = (id) => cfg.entries.find((x) => x.id === id);

  // ---------- 侧栏 ----------
  function renderList() {
    const body = q('launch-body');
    if (!body) return;
    if (!cfg.entries.length) {
      body.innerHTML = '<div class="launch-empty">还没有终端条目。<br>点右下「⇩」导入 mh_launch_panel 的 '
        + 'panel-config.json，或点「＋」手动添加。</div>';
      return;
    }
    const m = new Map();
    for (const e of cfg.entries) {
      const k = e.category || '未分类';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    body.innerHTML = [...m.entries()].map(([cat, list]) => {
      const isCol = !!collapsed[cat];
      return '<div class="launch-group">'
        + '<div class="launch-cat" data-cat="' + esc(cat) + '">'
        + '<span class="launch-caret">' + (isCol ? '▸' : '▾') + '</span>'
        + '<span class="launch-cat-nm">' + esc(cat) + '</span>'
        + '<span class="launch-cat-n">' + list.length + '</span></div>'
        + (isCol ? '' : '<div class="launch-cards">' + list.map(cardHtml).join('') + '</div>')
        + '</div>';
    }).join('');
    refreshDots();
  }

  function cardHtml(e) {
    const s = stOf(e.id);
    const sel = e.id === selectedId ? ' sel' : '';
    const dot = s.alive ? 'launch-dot on' : 'launch-dot';
    return '<div class="launch-card' + sel + '" data-id="' + esc(e.id) + '" title="点击在右侧查看详情与日志">'
      + '<div class="launch-card-head">'
      + '<span class="' + dot + '"></span>'
      + '<span class="launch-nm">' + esc(e.name) + '</span>'
      + (e.port ? '<span class="launch-port">:' + e.port + '</span>' : '')
      + '<span class="launch-acts">'
      + '<button class="vt-btn lp-btn" data-act="start" title="启动">▶</button>'
      + '<button class="vt-btn lp-btn" data-act="stop" title="停止">■</button>'
      + '</span></div></div>';
  }

  // 轮询只更新状态点与主区（不全量重建，保住选中与滚动位置）
  function refreshDots() {
    const body = q('launch-body');
    if (!body) return;
    for (const el of body.querySelectorAll('.launch-card')) {
      const id = el.getAttribute('data-id');
      const s = stOf(id);
      const dot = el.querySelector('.launch-dot');
      if (dot) dot.className = s.alive ? 'launch-dot on' : 'launch-dot';
    }
  }

  // ---------- 主区（详情 + 日志） ----------
  function renderMain() {
    const main = q('launch-main');
    if (!main || main.classList.contains('hidden')) return;
    const e = selectedId ? byId(selectedId) : null;
    const name = q('lm-name'), port = q('lm-port'), dot = q('lm-dot'), meta = q('lm-meta');
    if (!e) {
      name.textContent = '—';
      port.textContent = '';
      dot.className = 'launch-dot';
      meta.innerHTML = '<span class="launch-empty">从左侧选择一个终端，这里显示它的状态与日志。</span>';
      q('lm-log').textContent = '';
      for (const id of ['lm-start', 'lm-stop', 'lm-restart', 'lm-open', 'lm-edit', 'lm-del']) q(id).disabled = true;
      return;
    }
    for (const id of ['lm-start', 'lm-stop', 'lm-restart', 'lm-open', 'lm-edit', 'lm-del']) q(id).disabled = false;
    const s = stOf(e.id);
    name.textContent = e.name;
    port.textContent = e.port ? ':' + e.port : '';
    dot.className = s.alive ? 'launch-dot on' : 'launch-dot';
    dot.title = s.alive ? '运行中' : '已停止';
    q('lm-open').style.display = e.openUrl ? '' : 'none';
    meta.innerHTML = '<span class="lm-k">命令</span>' + esc(e.command)
      + '<span class="lm-k">目录</span>' + esc(e.cwd || '—')
      + '<span class="lm-k">后端</span>' + esc(e.apiOrigin || (cfg.apiOrigins[0] || '—'));
    // 日志（自动滚到底）
    const logEl = q('lm-log');
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
    L().logs(e.id).then((r) => {
      if (selectedId !== e.id) return;
      const arr = (r && r.lines) || [];
      logEl.textContent = arr.join('\n') || '(暂无输出)';
      if (atBottom || arr.length) logEl.scrollTop = logEl.scrollHeight;
    }).catch(() => {});
  }

  // ---------- 动作 ----------
  async function act(e, kind) {
    const api = L();
    if (!api) return;
    if (kind === 'start') {
      const r = await api.start(e);
      if (r && r.error) toast('启动失败：' + r.error, 'err'); else toast('已启动：' + e.name, 'ok');
    } else if (kind === 'stop') {
      await api.stop(e);
      toast('已停止：' + e.name, 'ok');
    } else if (kind === 'restart') {
      const r = await api.restart(e);
      if (r && r.error) toast('重启失败：' + r.error, 'err'); else toast('已重启：' + e.name, 'ok');
    }
    await pollOnce();
  }

  function toast(msg, type) {
    try { if (window.MI && MI.toast) { MI.toast(msg, type || 'info'); return; } } catch {}
  }

  async function pollOnce() {
    const api = L();
    if (!api || !cfg.entries.length) return;
    const st = await api.status(cfg.entries);
    const m = {};
    for (const s of (st || [])) m[s.id] = s;
    status = m;
    refreshDots();
    renderMain();
    const run = cfg.entries.filter((e) => stOf(e.id).alive).length;
    const cnt = q('launch-count');
    if (cnt) cnt.textContent = run + '/' + cfg.entries.length;
  }

  async function load() {
    const api = L();
    if (!api) return;
    cfg = await api.config();
    if (selectedId && !byId(selectedId)) selectedId = null;
    await pollOnce();
    renderList();
    renderMain();
  }

  // ---------- 对话框 ----------
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
    set('kind', (entry && entry.kind) || '');
    set('python', (entry && entry.python) || 'python');
    set('script', (entry && entry.script) || '');
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
      apiOrigin: v('apiOrigin'), openUrl: v('openUrl'),
      kind: v('kind'), script: v('script'), python: v('python') || 'python',
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
    cfg = await L().save({ apiOrigins: cfg.apiOrigins, entries: list, keepOnExit: cfg.keepOnExit });
    dlg.__editing = null;
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
    renderList();
    await pollOnce();
  }

  async function removeEntry(id) {
    const e = byId(id);
    if (!e) return;
    if (!window.confirm('删除终端「' + e.name + '」？（如果它正在运行，会先停止）')) return;
    await L().stop(e);
    cfg = await L().save({ apiOrigins: cfg.apiOrigins, entries: cfg.entries.filter((x) => x.id !== id), keepOnExit: cfg.keepOnExit });
    if (selectedId === id) selectedId = null;
    renderList();
    renderMain();
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
          renderList();
          return;
        }
        const btn = ev.target.closest('.lp-btn');
        const card = ev.target.closest('.launch-card');
        if (card) {
          const id = card.getAttribute('data-id');
          if (selectedId !== id) { selectedId = id; renderList(); renderMain(); }
        }
        if (btn && card) {
          const id = card.getAttribute('data-id');
          const e = byId(id);
          const kind = btn.getAttribute('data-act');
          if (e && (kind === 'start' || kind === 'stop')) act(e, kind);
        }
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
    if (sa) sa.addEventListener('click', async () => { for (const e of cfg.entries) if (!stOf(e.id).alive) await act(e, 'start'); });
    const so = q('launch-stop-all');
    if (so) so.addEventListener('click', async () => { for (const e of cfg.entries) if (stOf(e.id).alive) await act(e, 'stop'); });

    // 主区动作
    const on = (id, fn) => { const el = q(id); if (el) el.addEventListener('click', fn); };
    on('lm-start', () => { const e = byId(selectedId); if (e) act(e, 'start'); });
    on('lm-stop', () => { const e = byId(selectedId); if (e) act(e, 'stop'); });
    on('lm-restart', () => { const e = byId(selectedId); if (e) act(e, 'restart'); });
    on('lm-open', () => { const e = byId(selectedId); if (e && e.openUrl) L().openUrl(e.openUrl); });
    on('lm-edit', () => { const e = byId(selectedId); if (e) openDialog(e); });
    on('lm-del', () => { if (selectedId) removeEntry(selectedId); });

    const ok = q('launch-dialog-ok');
    if (ok) ok.addEventListener('click', (ev) => { ev.preventDefault(); submitDialog(); });
    const cancel = q('launch-dialog-cancel');
    if (cancel) cancel.addEventListener('click', () => {
      const dlg = q('launch-dialog');
      if (dlg && typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
    });

    // 后台保留开关（主区）
    const keep = q('launch-keep');
    if (keep) {
      keep.addEventListener('change', async () => {
        await L().setKeep(keep.checked);
        toast(keep.checked ? '退出时保留后台进程' : '退出时停止全部终端', 'ok');
      });
      L().getKeep().then((v) => { keep.checked = v === true; }).catch(() => {});
    }
  }

  function init() {
    if (inited) return;
    if (!q('launch-body')) return;
    inited = true;
    bind();
    load();
    if (timer) clearInterval(timer);
    timer = setInterval(pollOnce, 1500);
  }

  return { init, refresh: load, isOpen: () => !!(q('panel-launch') && !q('panel-launch').classList.contains('hidden')) };
})();
window.LaunchPanel = LaunchPanel;

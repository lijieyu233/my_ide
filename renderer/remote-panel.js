window.RemotePanel = (() => {
  const q = id => document.getElementById(id), api = () => window.myIDE.remote;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icons = { folder: '<svg class="ic" viewBox="0 0 16 16"><path d="M2 4h4l1.5 2H14v7H2z"/></svg>', file: '<svg class="ic" viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4zM9 2v3h3"/></svg>', server: '<svg class="ic" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="5" rx="1"/><rect x="2" y="9" width="12" height="5" rx="1"/><path d="M4.5 4.5h.5M4.5 11.5h.5M8 4.5h3M8 11.5h3"/></svg>', up: '<svg class="ic" viewBox="0 0 16 16"><path d="M8 13V3M4 7l4-4 4 4"/></svg>', upload: '<svg class="ic" viewBox="0 0 16 16"><path d="M8 11V2M4 6l4-4 4 4M3 10v4h10v-4"/></svg>', download: '<svg class="ic" viewBox="0 0 16 16"><path d="M8 2v9M4 7l4 4 4-4M3 10v4h10v-4"/></svg>', computer: '<svg class="ic" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="9" rx="1"/><path d="M5 14h6M8 11v3"/></svg>' };
  const labels = { connecting: '连接中', connected: '已连接', disconnected: '已断开', queued: '等待传输', running: '传输中', completed: '已完成', cancelled: '已取消', failed: '失败' };
  let profiles = [], version = '', selected = null, sid = null, activeTerm = null, visible = false, initialized = false, mode = 'terminal', connecting = false, loading = 0;
  const sessions = new Map(), terminals = new Map(), jobs = new Map();
  let fitFrame = 0, appearanceDirty = false;
  const panes = { local: { path: '', entries: [], selected: new Set(), serial: 0 }, remote: { path: '', entries: [], selected: new Set(), serial: 0 } };
  const notify = (text, error = false) => { q('remote-notice').textContent = text; q('remote-notice').title = text; q('remote-notice').classList.toggle('error', error); };
  async function call(op, ...args) { const result = await api()[op](...args); if (!result?.ok) throw Error(result?.error || '远程操作未确认'); return result.data; }
  const attempt = fn => async event => { try { await fn(event); } catch (error) { notify(error.message, true); } };
  const closeModal = box => { if (Modal.stack.at(-1) === box) Modal.hide(); };
  const current = () => sessions.get(sid), connected = () => current()?.state === 'connected';
  function controls() {
    q('remote-connect').disabled = !selected || connecting; q('remote-connect').classList.toggle('remote-muted', connected()); q('remote-connect').setAttribute('aria-busy', String(connecting));
    q('remote-disconnect').disabled = !sid || current()?.state === 'disconnected';
    q('remote-new-terminal').disabled = !connected();
    if (connecting) { q('remote-state').textContent = '连接中'; q('remote-state').dataset.state = 'connecting'; } q('remote-edit').disabled = !selected; q('remote-delete').disabled = !selected;
    for (const button of q('remote-files').querySelectorAll('[data-side="remote"] button, [data-action="download"], [data-action="upload"]')) button.disabled = !connected();
  }
  function renderProfiles() {
    q('remote-profile-count').textContent = profiles.length;
    q('remote-profiles').innerHTML = profiles.length ? profiles.map(p => {
      const live = [...sessions.values()].filter(s => s.profileId === p.id && s.state !== 'disconnected');
      return `<button class="remote-profile${p.id === selected ? ' selected' : ''}" data-profile="${esc(p.id)}"><span class="remote-profile-icon">${icons.server}</span><span class="remote-profile-info"><strong>${esc(p.name)}</strong><span class="remote-profile-endpoint">${esc(p.username)}@${esc(p.host)}:${p.port}</span><small data-state="${live.at(-1)?.state || 'disconnected'}">${live.length ? labels[live.at(-1).state] + (live.length > 1 ? ' · ' + live.length + '个会话' : '') : '未连接'}</small></span></button>`;
    }).join('') : '<div class="remote-side-empty">' + icons.server + '<strong>还没有保存的连接</strong><span>点击＋添加第一台服务器</span></div>';
    controls();
  }
  function renderSessions() {
    q('remote-sessions').innerHTML = '<option value="">选择连接会话</option>' + [...sessions.values()].filter(s => s.state !== 'disconnected').map(s => `<option value="${esc(s.id)}">${s.state === 'connected' ? '●' : '◌'} ${esc(s.name)}${[...sessions.values()].filter(other => other.profileId === s.profileId && other.state !== 'disconnected').length > 1 ? ' · ' + ([...sessions.values()].filter(other => other.profileId === s.profileId && other.state !== 'disconnected').indexOf(s) + 1) : ''}</option>`).join('');
    const profile = profiles.find(p => p.id === selected), state = current()?.state || 'disconnected';
    q('remote-sessions').value = sid || ''; q('remote-sessions').title = current() ? current().name + ' · ' + labels[current().state] : '选择连接会话'; q('remote-title').textContent = profile?.name || '远程服务器';
    q('remote-endpoint').textContent = profile ? `${profile.username}@${profile.host}:${profile.port}` : 'SSH 终端与 SFTP 文件传输';
    q('remote-state').textContent = current() ? labels[state] : '未连接'; q('remote-state').dataset.state = state; renderProfiles();
  }
  async function refresh() {
    const serial = ++loading, value = await call('load'); if (serial !== loading) return;
    profiles = value.profiles; version = value.version; if (!profiles.some(p => p.id === selected)) selected = profiles[0]?.id || null;
    renderSessions();
  }
  function form(profile) {
    const p = profile || { name: '', host: '', port: 22, username: '', auth: 'password', privateKey: '', hasSecret: false };
    const box = document.createElement('div'); box.className = 'remote-form'; box.dataset.selfEsc = '1';
    box.innerHTML = `<div class="m-head">${profile ? '编辑服务器' : '新建服务器'}</div><form class="m-body">
      <label>名称<input name="name" required autocomplete="off"></label><div class="remote-form-row"><label>主机<input name="host" required autocomplete="off" placeholder="服务器IP或域名"></label><label>端口<input name="port" type="number" min="1" max="65535" required></label></div>
      <label>用户名<input name="username" required autocomplete="off"></label><label>认证方式<select name="auth"><option value="password">密码</option><option value="key">私钥</option></select></label>
      <label data-auth="password">密码<input name="password" type="password" autocomplete="new-password" placeholder="${p.hasSecret ? '留空沿用已保存密码' : '不记住时将在连接时输入'}"></label>
      <label data-auth="key">私钥路径<div class="remote-form-row"><input name="privateKey" placeholder="选择本地私钥文件"><button type="button" id="rem-key-pick" class="tb-btn">选择</button></div></label>
      <label data-auth="key">私钥口令<input name="passphrase" type="password" autocomplete="new-password" placeholder="未加密私钥可留空"></label>
      <label class="remote-check"><input name="remember" type="checkbox">记住密码／私钥口令（使用系统加密）</label>
      <div class="remote-form-error" role="status"></div><div class="m-foot">${profile ? '<button type="button" id="rem-forget-host" class="tb-btn">清除已记住指纹</button>' : ''}<span class="spacer"></span><button type="button" id="rem-form-cancel" class="tb-btn">取消</button><button type="submit" class="tb-btn m-ok">保存</button></div></form>`;
    Modal.show(box); const f = box.querySelector('form'); for (const name of ['name', 'host', 'port', 'username', 'auth', 'privateKey']) f.elements[name].value = p[name]; f.elements.remember.checked = p.hasSecret;
    const sync = () => box.querySelectorAll('[data-auth]').forEach(el => { el.hidden = el.dataset.auth !== f.elements.auth.value; }); sync(); f.elements.auth.onchange = sync;
    box.querySelector('#rem-key-pick').onclick = attempt(async () => { const chosen = await window.myIDE.fs.pickFile('选择SSH私钥', []); if (chosen) f.elements.privateKey.value = typeof chosen === 'string' ? chosen : chosen.path || chosen.filePaths?.[0] || ''; });
    let busy = false; const close = () => { if (!busy) closeModal(box); }; box.querySelector('#rem-form-cancel').onclick = close;
    box.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
    if (profile) box.querySelector('#rem-forget-host').onclick = attempt(async () => {
      if (await Modal.confirm('清除服务器指纹', '清除后下次连接需要重新核对主机指纹。')) { await call('forgetHost', p.id); box.querySelector('.remote-form-error').textContent = '已清除；下次连接请核对新指纹。'; }
    });
    f.onsubmit = async event => {
      event.preventDefault(); if (busy) return; busy = true;
      const values = Object.fromEntries(new FormData(f)); values.id = p.id; values.remember = f.elements.remember.checked;
      box.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try { const saved = await call('save', values, version); profiles = saved.profiles; version = saved.version; selected = saved.profiles.find(s => s.id === p.id)?.id || saved.profiles.at(-1)?.id; closeModal(box); renderSessions(); notify('服务器配置已保存。'); }
      catch (error) { box.querySelector('.remote-form-error').textContent = error.message; }
      finally { busy = false; box.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
    };
    f.elements.name.focus();
  }
  function credentials(profile) {
    if (profile.hasSecret) return Promise.resolve({});
    return new Promise(resolve => {
      const box = document.createElement('div'); box.className = 'remote-form'; box.dataset.selfEsc = '1';
      box.innerHTML = `<div class="m-head">连接 ${esc(profile.name)}</div><form class="m-body"><label>${profile.auth === 'password' ? '密码' : '私钥口令（可留空）'}<input type="password" name="secret" autocomplete="off"></label><div class="m-foot"><button type="button" class="tb-btn">取消</button><button type="submit" class="tb-btn m-ok">连接</button></div></form>`;
      Modal.show(box); let settled = false;
      const finish = value => { if (settled) return; settled = true; closeModal(box); resolve(value); };
      box.onModalHide = () => { if (!settled) { settled = true; resolve(null); } };
      box.querySelector('button').onclick = () => finish(null); box.querySelector('form').onsubmit = event => { event.preventDefault(); const value = box.querySelector('input').value; finish({ [profile.auth === 'password' ? 'password' : 'passphrase']: value }); };
      box.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); finish(null); } }; box.querySelector('input').focus();
    });
  }
  async function connect() {
    if (connecting) return; const profile = profiles.find(p => p.id === selected); if (!profile) return;
    connecting = true; controls();
    try { const supplied = await credentials(profile); if (supplied === null) return; notify('正在连接 ' + profile.name + '…'); const result = await call('connect', profile.id, supplied); sessions.set(result.id, result); await activateSession(result.id); notify('已连接 ' + profile.name); await newTerminal(); }
    finally { connecting = false; renderSessions(); }
  }
  async function activateSession(id) {
    sid = id || null; const s = current(); if (s) selected = s.profileId; renderSessions();
    panes.remote.serial++; panes.remote.selected.clear(); panes.remote.entries = []; panes.remote.path = s?.home || '';
    renderPane('remote'); if (connected()) await browse('remote', panes.remote.path);
    const existing = [...terminals.values()].find(t => t.sid === sid && !t.closed); activeTerm = existing?.id || null; renderTerminals(); if (existing) selectTerminal(existing.id);
  }
  function fit(t) {
    if (!t || !visible || mode !== 'terminal' || activeTerm !== t.id || !t.container.clientWidth) return;
    try {
      t.fit.fit(); const size = t.term.cols + ':' + t.term.rows;
      // 重复 window-change 会让远端 Shell 重画提示符，缩放和切标签只发送真正改变的行列数。
      if (t.opened && !t.closed && t.remoteSize !== size) {
        t.remoteSize = size;
        void call('resize', t.sid, t.id, t.term.cols, t.term.rows).catch(() => { if (t.remoteSize === size) t.remoteSize = null; });
      }
    } catch {}
  }
  function requestFit() {
    // 拖动窗口和切换标签的多次通知合并到一帧，避免连续强制读取布局。
    if (fitFrame || !visible || mode !== 'terminal') return;
    fitFrame = requestAnimationFrame(() => { fitFrame = 0; fit(terminals.get(activeTerm)); });
  }
  function terminalTheme(css = getComputedStyle(q('remote-main'))) {
    // ANSI 颜色保持终端语义；普通字色按背景亮度选择，避免随粉色 UI 文字一起染色。
    const rgb = css.backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number) || [0, 0, 0];
    const light = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > 150;
    return { background: css.backgroundColor, foreground: light ? '#30343b' : '#eee9ec', cursor: css.getPropertyValue('--accent').trim(),
      black: light ? '#30343b' : '#50434b', red: light ? '#ad2639' : '#e87989', green: light ? '#297341' : '#92c992', yellow: light ? '#8b6019' : '#dfc07f',
      blue: light ? '#285fa8' : '#8caee2', magenta: light ? '#9b3985' : '#cf9dca', cyan: light ? '#15717b' : '#89c5cc', white: light ? '#626975' : '#d6ced3',
      brightBlack: light ? '#737984' : '#aa96a2', brightRed: light ? '#c23443' : '#ffa2ac', brightGreen: light ? '#287f39' : '#b5e2a3', brightYellow: light ? '#957013' : '#f5db9d',
      brightBlue: light ? '#326fd0' : '#b1c9f4', brightMagenta: light ? '#ab428f' : '#e5b8de', brightCyan: light ? '#137986' : '#b2e1e5', brightWhite: light ? '#30343b' : '#fff4f8' };
  }
  function terminalFontSize() { return parseFloat(getComputedStyle(q('remote-main')).fontSize) || 13; }
  function syncTerminalAppearance() {
    if (!visible) return;
    appearanceDirty = false;
    const css = getComputedStyle(q('remote-main')), theme = terminalTheme(css), fontSize = parseFloat(css.fontSize) || 13;
    for (const t of terminals.values()) {
      // xterm 用对象引用判断 theme 变化；无关 body/root 样式变化不能反复触发整屏重绘。
      if (Object.keys(theme).some(key => t.term.options.theme[key] !== theme[key])) t.term.options.theme = theme;
      if (t.term.options.fontSize !== fontSize) { t.term.options.fontSize = fontSize; fit(t); }
    }
  }
  function requestAppearance() {
    appearanceDirty = true;
    if (visible) syncTerminalAppearance();
  }
  function mountTerminal(id,sessionId,opened=false){
    if(terminals.has(id))return terminals.get(id);
    if(!window.Terminal||!window.FitAddon)throw Error('终端组件未加载，请检查依赖');
    const container = document.createElement('div'); container.className = 'remote-terminal'; q('remote-terminal-panes').append(container);
    const term = new Terminal({ fontSize: terminalFontSize(), fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace', lineHeight: 1.45, fontWeight: '400', scrollback: 3000, cursorBlink: true, allowProposedApi: false, theme: terminalTheme() });
    const fitter = new FitAddon.FitAddon(); term.loadAddon(fitter); term.open(container);
    const t = { id, sid:sessionId, term, fit: fitter, container, name: sessions.get(sessionId)?.name||'SSH', closed: false, opened }; terminals.set(id,t);renderTerminals();
    let inputChain = Promise.resolve();
    term.onData(data => {
      if (t.closed || !t.opened) return; if (data.length > 1024 * 1024) { notify('粘贴内容超过1MiB，请使用文件上传。', true); return; }
      inputChain = inputChain.then(async () => { for (let i = 0; i < data.length; i += 2048) await call('input', t.sid, id, data.slice(i, i + 2048)); }).catch(error => notify(error.message, true));
    });
    term.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') { void window.myIDE.clip.copy(term.getSelection()); return false; }
      if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') { void window.myIDE.clip.readText().then(text => term.paste(text)); return false; }
      return true;
    });
    // 编辑器的全局快捷键不能消费终端里的Ctrl+C、Tab和方向键。
    for (const type of ['keydown', 'keyup']) container.addEventListener(type, event => event.stopPropagation());
    return t;
  }
  async function newTerminal(){
    if(!connected())return;
    const id=crypto.randomUUID(),t=mountTerminal(id,sid),term=t.term;selectTerminal(id);fit(t);
    try { const cols = term.cols, rows = term.rows; await call('openTerminal', t.sid, id, cols, rows); t.remoteSize = cols + ':' + rows; t.opened = true; fit(t); if (visible && mode === 'terminal' && activeTerm === id && !Modal.stack.length) term.focus(); }
    catch (error) { t.closed = true; term.writeln('\r\n连接终端失败：' + error.message); renderTerminals(); throw error; }
  }

  function showTerminal(sessionId,id){
    const t=terminals.get(id);if(!t||t.sid!==sessionId)throw Error('终端尚未显示，请在远程服务器页面查看');selectTerminal(id);
  }
  function renderTerminals() {
    q('remote-terminal-tabs').innerHTML = [...terminals.values()].map((t, i) => `<span class="remote-terminal-tab${activeTerm === t.id ? ' active' : ''}"><button data-term="${esc(t.id)}">${esc(t.name)} · ${i + 1}${t.closed ? '（已关闭）' : ''}</button><button data-close-term="${esc(t.id)}" title="关闭终端" aria-label="关闭终端">×</button></span>`).join('');
    q('remote-terminal-empty').hidden = !!activeTerm; for (const t of terminals.values()) t.container.classList.toggle('hidden', t.id !== activeTerm);
  }
  function selectTerminal(id) { activeTerm = id; const t = terminals.get(id); if (t) { const changed = sid !== t.sid; sid = t.sid; selected = sessions.get(sid)?.profileId || selected; renderSessions(); if (changed) { panes.remote.serial++; panes.remote.entries = []; panes.remote.selected.clear(); panes.remote.path = current()?.home || ''; renderPane('remote'); if (connected()) void browse('remote', panes.remote.path).catch(error => notify(error.message, true)); } } mode = 'terminal'; renderMode(); renderTerminals(); if (t) requestFit(); }
  function renderMode() {
    q('remote-files').classList.toggle('hidden', mode !== 'files');
    q('remote-terminal-area').classList.toggle('hidden', mode !== 'terminal');
    q('remote-overview')?.classList.toggle('hidden', mode !== 'overview');
    for (const tab of ['terminal', 'files', 'overview']) q('remote-tab-' + tab)?.classList.toggle('active', mode === tab);
    // 概览的定时刷新只在概览页可见时跑：切走就停，避免白占 SSH 通道。
    if (mode === 'overview' && visible && connected()) { void loadOverview(); startOverviewTimer(); }
    else stopOverviewTimer();
  }
  // ── 右键菜单 ──────────────────────────────────────────────────────────
  // 远程/本地文件列表原来只有顶部那排「新建目录 / 重命名 / 删除」，用户在
  // 具体某个文件上没有任何就地操作入口（尤其「编辑远程文件」根本不存在）。
  //
  // 关键设计：编辑走「下载到临时目录 → 用编辑器打开 → 保存时自动传回」。
  // 不能只下载了事 —— 编辑器保存写的是本地文件，若不挂回程，用户改了半天空欢喜。
  // 回程用 remote-edit 模块登记的映射（本地路径 → {sessionId, remotePath}）。
  let ctxMenu = null;
  function closeFileMenu() {
    ctxMenu?.remove(); ctxMenu = null;
    document.removeEventListener('pointerdown', onFileMenuDown, true);
    document.removeEventListener('keydown', onFileMenuKey, true);
  }
  function onFileMenuDown(event) { if (!ctxMenu?.contains(event.target)) closeFileMenu(); }
  // Esc 关闭：仓库里其它右键菜单都支持（app.js 的 Esc 处理只覆盖 #ctx-menu，
  // 这个菜单是独立元素，必须自己监听，否则用户按 Esc 没反应会觉得卡住了）。
  function onFileMenuKey(event) {
    if (event.key !== 'Escape' || !ctxMenu) return;
    event.preventDefault(); event.stopPropagation();
    closeFileMenu();
  }

  const fileMenuIcons = {
    edit: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 2.6l2.2 2.2-7.6 7.6-2.9.7.7-2.9z"/></svg>',
    download: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.6v7.2M5 7l3 3 3-3M3 12.4h10"/></svg>',
    upload: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10.6V3.4M5 6.4l3-3 3 3M3 12.4h10"/></svg>',
    rename: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 8h10.8M10.4 4.8L13.6 8l-3.2 3.2"/></svg>',
    remove: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 4.4h9.2M6.2 4.4V2.8h3.6v1.6M4.6 4.4l.6 8.8h5.6l.6-8.8"/></svg>',
    copyPath: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.4" y="2.6" width="8" height="9.4" rx="1.2"/><path d="M10.6 12.2v1.2H3.4a1 1 0 0 1-1-1V5.6h1.2"/></svg>',
    refresh: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 6a5 5 0 1 0 0 4M13 2v4H9"/></svg>',
  };

  function openFileMenu(side, event) {
    const pane = panes[side], root = q('remote-' + side + '-pane');
    const row = event.target.closest('[data-path]');
    const path = row?.dataset.path || null;
    const entry = path ? pane.byPath.get(path) : null;
    closeFileMenu();
    const menu = document.createElement('div');
    menu.className = 'remote-file-menu';
    menu.setAttribute('role', 'menu');
    const add = (icon, label, fn, opts = {}) => {
      if (opts.hidden) return;
      const item = document.createElement('button');
      item.type = 'button'; item.className = 'ctx-item with-icon' + (opts.danger ? ' danger' : '');
      item.setAttribute('role', 'menuitem');
      if (opts.disabled) item.disabled = true;
      item.innerHTML = '<span class="ctx-item-ic">' + icon + '</span>';
      const span = document.createElement('span'); span.textContent = label; item.append(span);
      item.onclick = ev => { ev.stopPropagation(); closeFileMenu(); if (!opts.disabled) fn(); };
      menu.append(item);
    };
    const sep = () => { const d = document.createElement('div'); d.className = 'ctx-sep'; menu.append(d); };
    const isRemote = side === 'remote';
    const isFile = entry && !entry.directory;

    // ① 编辑 / 打开
    if (isFile) {
      add(fileMenuIcons.edit, isRemote ? '编辑远程文件' : '打开', () => editEntry(side, entry));
    } else if (entry?.directory) {
      add(fileMenuIcons.edit, '打开目录', () => { pane.selected.clear(); pane.selected.add(entry.path); void browse(side, entry.path); });
    }
    if (isFile) {
      sep();
      if (isRemote) {
        add(fileMenuIcons.download, '下载到本地…', () => transferSelected(side, 'download'));
      } else {
        add(fileMenuIcons.upload, '上传到远程…', () => transferSelected(side, 'upload'));
      }
    }
    if (path) {
      add(fileMenuIcons.copyPath, '复制路径', () => {
        try { navigator.clipboard.writeText(path); notify('已复制路径', false); } catch { notify('复制失败', true); }
      });
    }
    sep();
    add(fileMenuIcons.rename, '重命名…', () => root.querySelector('[data-action="rename"]').click(), { disabled: pane.selected.size !== 1 });
    add(fileMenuIcons.remove, '删除', () => root.querySelector('[data-action="remove"]').click(), { danger: true, disabled: !pane.selected.size });
    sep();
    add(fileMenuIcons.refresh, '刷新', () => { void browse(side, pane.path).catch(() => {}); });

    menu.style.left = '0px'; menu.style.top = '0px';
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(event.clientX, innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(event.clientY, innerHeight - r.height - 8)) + 'px';
    ctxMenu = menu;
    document.addEventListener('pointerdown', onFileMenuDown, true);
    document.addEventListener('keydown', onFileMenuKey, true);
    menu.querySelector('.ctx-item:not(:disabled)')?.focus({ preventScroll: true });
  }

  // 右键菜单里的「下载 / 上传」：作用对象是当前选中的那一批文件。
  // 复用顶部工具条那条 enqueue 链路（含冲突确认、进度队列），不另造一套传输。
  async function transferSelected(side, action) {
    const sources = [...panes[side].selected];
    if (!sources.length) { notify('请先选择文件', true); return; }
    try { await enqueue(action, sources); }
    catch (error) { notify(error.message, true); }
  }

  // 编辑：远程文件先下载到「远程编辑暂存目录」，登记映射后交给编辑器打开。
  async function editEntry(side, entry) {
    if (!entry || entry.directory) return;
    if (side === 'local') { await Viewer.openFile(entry.path); return; }
    try {
      const staged = await call('stageEdit', sid, entry.path);
      if (!staged?.localPath) throw Error('暂存失败');
      await Viewer.openFile(staged.localPath);
      notify('已打开 ' + entry.name + '；保存后会自动传回服务器', false);
    } catch (error) { notify('打开远程文件失败：' + error.message, true); }
  }

  // ── 概览页（仿 1Panel 的首屏）────────────────────────────────────────
  // 数据全部来自主进程的固定只读采集脚本（见 remote-service 的 OVERVIEW_SCRIPT），
  // 这里只负责画。每块单独判空：服务器没装 Docker / 不是 systemd，对应区块整块不画，
  // 而不是留一张空卡片。
  let overviewSerial = 0, overviewTimer = null, overviewCpuPrev = null;

  const fmtBytes = value => {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = value, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
  };
  const fmtDuration = seconds => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
    if (d) return d + ' 天 ' + h + ' 小时';
    if (h) return h + ' 小时 ' + m + ' 分';
    return m + ' 分';
  };
  const pct = (used, total) => !total ? 0 : Math.min(100, Math.max(0, Math.round(used / total * 100)));

  function overviewCard(title, body, extraClass = '') {
    return '<section class="remote-ov-card ' + extraClass + '"><header>' + title + '</header>' + body + '</section>';
  }
  // 进度条：用同一套 meter 画 CPU / 内存 / 磁盘，颜色按阈值走（>90 红、>75 黄）。
  function meter(label, percent, detail) {
    const level = percent >= 90 ? 'critical' : percent >= 75 ? 'warn' : 'ok';
    return '<div class="remote-ov-meter" data-level="' + level + '"><div class="remote-ov-meter-head"><span>' + label + '</span><strong>' + percent + '%</strong></div>'
      + '<div class="remote-ov-bar"><i style="width:' + percent + '%"></i></div>'
      + (detail ? '<div class="remote-ov-meter-foot">' + detail + '</div>' : '') + '</div>';
  }

  function renderOverview(ov) {
    const host = q('remote-overview'); if (!host) return;
    if (!ov) { host.innerHTML = '<div class="remote-empty">连接服务器后查看概览。</div>'; return; }
    const { os = {}, kernel = {}, cpu = {}, memory = {}, uptime, disks = [], listen = [], services = [], docker = [], du = [] } = ov;
    const parts = [];

    // ① 资源：CPU / 内存 / 磁盘合并成一张卡 —— 这正是 1Panel 首屏最上面那四块的核心。
    const cpuPercent = (() => {
      if (!cpu.usage) return 0;
      const prev = overviewCpuPrev;
      overviewCpuPrev = cpu.usage;
      if (!prev) return Math.max(0, Math.min(100, Math.round((1 - cpu.usage.idle / Math.max(1, cpu.usage.total)) * 100)));
      const dTotal = cpu.usage.total - prev.total, dIdle = cpu.usage.idle - prev.idle;
      if (dTotal <= 0) return 0;
      return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
    })();
    const memPercent = pct(memory.used, memory.total);
    const diskTotal = disks.reduce((sum, d) => sum + d.total, 0);
    const diskUsed = disks.reduce((sum, d) => sum + d.used, 0);
    const loadText = cpu.load?.length ? cpu.load.map(n => n.toFixed(2)).join('  ') : '—';
    parts.push(overviewCard('资源监控',
      '<div class="remote-ov-meters">'
      + meter('CPU', cpuPercent, (cpu.cores || '?') + ' 核 · 负载 ' + loadText)
      + meter('内存', memPercent, fmtBytes(memory.used) + ' / ' + fmtBytes(memory.total)
        + (memory.swapTotal ? ' · 交换 ' + fmtBytes(memory.swapUsed || 0) + ' / ' + fmtBytes(memory.swapTotal) : ''))
      + meter('磁盘', pct(diskUsed, diskTotal), fmtBytes(diskUsed) + ' / ' + fmtBytes(diskTotal) + ' · ' + disks.length + ' 个分区')
      + '</div>'
      + '<div class="remote-ov-facts"><span>运行 <strong>' + fmtDuration(uptime) + '</strong></span>'
      + '<span>系统时间 <strong>' + (kernel.serverTime ? new Date(kernel.serverTime * 1000).toLocaleString() : '—') + '</strong></span></div>'));

    // ② 系统信息
    parts.push(overviewCard('系统信息',
      '<dl class="remote-ov-kv">'
      + '<div><dt>发行版</dt><dd>' + esc(os.name || '—') + '</dd></div>'
      + '<div><dt>内核</dt><dd>' + esc(kernel.release || '—') + '</dd></div>'
      + '<div><dt>架构</dt><dd>' + esc(kernel.arch || '—') + '</dd></div>'
      + '<div><dt>主机名</dt><dd>' + esc(kernel.hostname || '—') + '</dd></div>'
      + '</dl>'));

    // ③ 磁盘分区（每个挂载点一条）
    if (disks.length) parts.push(overviewCard('磁盘分区',
      '<div class="remote-ov-list">' + disks.map(d =>
        '<div class="remote-ov-row"><span class="remote-ov-row-main" title="' + esc(d.fs) + '">' + esc(d.mount) + '</span>'
        + '<span class="remote-ov-row-size">' + fmtBytes(d.used) + ' / ' + fmtBytes(d.total) + '</span>'
        + '<span class="remote-ov-row-pct" data-level="' + (d.percent >= 90 ? 'critical' : d.percent >= 75 ? 'warn' : 'ok') + '">' + d.percent + '%</span></div>').join('')
      + '</div>'));

    // ④ 服务（systemd）
    if (services.length) parts.push(overviewCard('运行中的服务 <small>' + services.length + '</small>',
      '<div class="remote-ov-list scroll">' + services.map(s =>
        '<div class="remote-ov-row"><span class="remote-ov-row-main" title="' + esc(s.description) + '">' + esc(s.unit) + '</span>'
        + '<span class="remote-ov-tag">' + esc(s.sub || s.active) + '</span></div>').join('')
      + '</div>'));

    // ⑤ Docker（没装就不画这块）
    if (docker.length) parts.push(overviewCard('Docker 容器 <small>' + docker.length + '</small>',
      '<div class="remote-ov-list scroll">' + docker.map(c =>
        '<div class="remote-ov-row"><span class="remote-ov-row-main" title="' + esc(c.image) + '">' + esc(c.name) + '</span>'
        + '<span class="remote-ov-row-sub">' + esc(c.status) + '</span></div>').join('')
      + '</div>'));

    // ⑥ 监听端口
    if (listen.length) parts.push(overviewCard('监听端口 <small>' + listen.length + '</small>',
      '<div class="remote-ov-list scroll">' + listen.map(p =>
        '<div class="remote-ov-row"><span class="remote-ov-row-main"><b>' + p.port + '</b> <small>' + p.proto + '</small></span>'
        + '<span class="remote-ov-row-sub" title="' + esc(p.address) + '">' + esc(p.process || p.address) + '</span></div>').join('')
      + '</div>'));

    // ⑦ 家目录占用
    if (du.length) parts.push(overviewCard('主目录占用 <small>' + esc(du[0]?.path?.split('/').pop() || '') + '</small>',
      '<div class="remote-ov-list">' + du.map(d =>
        '<div class="remote-ov-row"><span class="remote-ov-row-main" title="' + esc(d.path) + '">' + esc(d.path) + '</span>'
        + '<span class="remote-ov-row-size">' + fmtBytes(d.bytes) + '</span></div>').join('')
      + '</div>'));

    host.innerHTML = '<div class="remote-ov-grid">' + parts.join('') + '</div>';
  }

  async function loadOverview({ silent = false } = {}) {
    if (!connected()) { renderOverview(null); return; }
    const serial = ++overviewSerial;
    const host = q('remote-overview');
    if (!silent && host && !host.querySelector('.remote-ov-grid')) host.innerHTML = '<div class="remote-empty">正在采集…</div>';
    try {
      const result = await call('overview', sid);
      if (serial !== overviewSerial) return;
      renderOverview(result);
    } catch (error) {
      if (serial !== overviewSerial) return;
      // 采集失败要留下可见原因：不能默默显示上一次的数字（那会让人以为服务器还活着）。
      if (host) host.innerHTML = '<div class="remote-empty">概览采集失败：' + esc(error.message) + '</div>';
    }
  }

  function stopOverviewTimer() { if (overviewTimer) { clearInterval(overviewTimer); overviewTimer = null; } }
  function startOverviewTimer() {
    stopOverviewTimer();
    // 5 秒刷新：与 1Panel 的节奏接近；只在概览页可见时跑，切走就停（不白占 SSH 通道）。
    overviewTimer = setInterval(() => { if (mode === 'overview' && visible && connected() && !Modal.stack.length) void loadOverview({ silent: true }); }, 5000);
  }

  function displaySize(value) { return value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : value + ' B'; }
  const fileNames = new Intl.Collator(undefined, { numeric: true });
  function fileRow(pane, e, top) {
    return `<button class="remote-file${pane.selected.has(e.path) ? ' selected' : ''}" data-path="${esc(e.path)}" draggable="true" title="${esc(e.path)}"${top === undefined ? '' : ' style="top:' + top + 'px"'}><span>${icons[e.directory ? 'folder' : 'file']}</span><span class="remote-file-name">${esc(e.name)}${e.link ? ' ↗' : ''}</span><small>${e.directory ? '目录' : displaySize(e.size)}</small></button>`;
  }
  function paintFiles(side) {
    const pane = panes[side], root = q('remote-' + side + '-pane'), list = root.querySelector('.remote-file-list');
    if (!pane.virtual || !pane.window) return;
    const rowHeight = (parseFloat(getComputedStyle(list).fontSize) || 13) * 2.6;
    const start = Math.max(0, Math.floor(list.scrollTop / rowHeight) - 5), end = Math.min(pane.ordered.length, Math.ceil((list.scrollTop + list.clientHeight) / rowHeight) + 5);
    const key = start + ':' + end + ':' + rowHeight; if (pane.paintKey === key) return;
    pane.paintKey = key; pane.rowHeight = rowHeight;
    const focused = list.contains(document.activeElement) && document.activeElement.closest('[data-path]')?.dataset.path;
    pane.window.style.height = pane.ordered.length * rowHeight + 'px';
    // 大目录只创建视口及前后5行，保留全部路径和选择状态；滚动到末尾仍能访问每个文件。
    pane.window.innerHTML = pane.ordered.slice(start, end).map((e, i) => fileRow(pane, e, (start + i) * rowHeight)).join('');
    if (focused) ([...list.querySelectorAll('[data-path]')].find(row => row.dataset.path === focused) || list).focus({ preventScroll: true });
  }
  function requestFilePaint(side) {
    const pane = panes[side]; if (pane.frame) return;
    pane.frame = requestAnimationFrame(() => { pane.frame = 0; paintFiles(side); });
  }
  function renderPane(side) {
    const pane = panes[side], root = q('remote-' + side + '-pane'); if (!root) return;
    root.querySelector('input').value = pane.path;
    pane.ordered = [...pane.entries].sort((a, b) => Number(b.directory) - Number(a.directory) || fileNames.compare(a.name, b.name));
    pane.byPath = new Map(pane.entries.map(e => [e.path, e])); pane.virtual = pane.entries.length > 200; pane.paintKey = null;
    const list = root.querySelector('.remote-file-list'); list.scrollTop = 0; list.tabIndex = pane.virtual ? 0 : -1;
    if (pane.virtual) { list.innerHTML = '<div class="remote-file-window"></div>'; pane.window = list.firstElementChild; paintFiles(side); }
    else { pane.window = null; list.innerHTML = pane.ordered.length ? pane.ordered.map(e => fileRow(pane, e)).join('') : '<div class="remote-empty">' + (side === 'remote' && !connected() ? '连接服务器后浏览远程文件。' : '此目录没有文件。') + '</div>'; }
    root.querySelector('.remote-file-status').textContent = pane.entries.length + ' 项 · 已选 ' + pane.selected.size + ' 项'; controls();
  }
  async function browse(side, target) {
    const pane = panes[side], serial = ++pane.serial, requestedSession = sid;
    const root = q('remote-' + side + '-pane'); root.querySelector('.remote-file-status').textContent = '正在读取…';
    try {
      const result = side === 'local' ? await call('localList', target) : await call('list', requestedSession, target);
      if (serial !== pane.serial || side === 'remote' && requestedSession !== sid) return;
      pane.path = result.path; pane.entries = result.entries; pane.selected.clear(); renderPane(side);
    } catch (error) { if (serial !== pane.serial) return; root.querySelector('.remote-file-status').textContent = '读取失败：' + error.message; throw error; }
  }
  const parent = (side, target) => { if (side === 'remote') return target.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'; const value = target.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, ''); return /^[A-Za-z]:$/.test(value) ? value + '\\' : value || target; };
  const joined = (side, dir, name) => dir.replace(/[\\/]+$/, '') + (side === 'remote' ? '/' : '\\') + name;
  async function enqueue(direction, sources) {
    if (!connected()) throw Error('请先连接服务器'); if (!sources.length) throw Error('请先选择文件');
    const target = panes[direction === 'upload' ? 'remote' : 'local'].path, requestedSession = sid;
    let result = await call('enqueue', requestedSession, direction, sources, target, false);
    if (result.conflicts?.length) {
      if (!await Modal.confirm('覆盖目标文件', esc(result.conflicts.join('\n')) + '\n\n目标文件已存在，确认覆盖？')) return;
      result = await call('enqueue', requestedSession, direction, sources, target, true);
    }
    for (const job of result.jobs) jobs.set(job.id, job); renderJobs(); q('remote-transfers').open = true;
  }
  function installFiles() {
    q('remote-files').innerHTML = ['local', 'remote'].map(side => `<section id="remote-${side}-pane" class="remote-file-pane" data-side="${side}"><div class="remote-file-heading"><span class="remote-pane-icon">${icons[side === 'local' ? 'computer' : 'server']}</span><div><strong>${side === 'local' ? '本地文件' : '远程文件'}</strong><small>${side === 'local' ? '你的电脑' : '当前服务器'}</small></div><span class="spacer"></span><button class="vt-btn remote-transfer-action" data-action="${side === 'local' ? 'upload' : 'download'}">${icons[side === 'local' ? 'upload' : 'download']}${side === 'local' ? '上传' : '下载'}</button></div><form class="remote-path-bar"><button type="button" class="vt-btn" data-action="up" title="上级目录" aria-label="上级目录">${icons.up}</button><input aria-label="${side === 'local' ? '本地路径' : '远程路径'}" autocomplete="off" spellcheck="false"><button type="submit" class="vt-btn">前往</button><button type="button" class="vt-btn" data-action="refresh">刷新</button></form><div class="remote-file-tools"><button class="vt-btn" data-action="mkdir">新建目录</button><button class="vt-btn" data-action="rename">重命名</button><button class="vt-btn" data-action="remove">删除</button></div><div class="remote-file-columns"><span>名称</span><span>大小</span></div><div class="remote-file-list"></div><div class="remote-file-status" role="status"></div></section>`).join('');
    for (const side of ['local', 'remote']) {
      const root = q('remote-' + side + '-pane'), pane = panes[side];
      const list = root.querySelector('.remote-file-list'); list.onscroll = () => requestFilePaint(side);
      if (window.ResizeObserver) new ResizeObserver(() => requestFilePaint(side)).observe(list);
      root.onkeydown = attempt(async event => {
        if (event.target !== list && !event.target.closest('[data-path]')) return;
        const path = event.target.closest('[data-path]')?.dataset.path || [...pane.selected].at(-1), index = pane.ordered.findIndex(e => e.path === path);
        if (event.key === 'Enter') { const entry = pane.byPath.get(path); if (entry?.directory && !entry.link) { event.preventDefault(); event.stopPropagation(); await browse(side, entry.path); } return; }
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? pane.ordered.length - 1 : event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : -1;
        if (next < 0 || next >= pane.ordered.length || !['Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); const entry = pane.ordered[next];
        if (pane.virtual) { const offset = next * pane.rowHeight; if (offset < list.scrollTop) list.scrollTop = offset; else if (offset + pane.rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = offset + pane.rowHeight - list.clientHeight; paintFiles(side); }
        const row = [...list.querySelectorAll('[data-path]')].find(r => r.dataset.path === entry.path); row?.focus({ preventScroll: pane.virtual }); row?.click();
      });
      root.querySelector('form').onsubmit = attempt(async event => { event.preventDefault(); await browse(side, root.querySelector('input').value); });
      // 右键：就地操作某个文件（编辑 / 上传下载 / 重命名 / 删除 / 复制路径）。
      // 先把它选中再弹菜单 —— 否则会出现「右键 A、删掉 B」这种最糟糕的误操作。
      root.addEventListener('contextmenu', event => {
        const row = event.target.closest('[data-path]');
        event.preventDefault(); event.stopPropagation();
        if (row && !pane.selected.has(row.dataset.path)) {
          pane.selected.clear(); pane.selected.add(row.dataset.path);
          for (const r of root.querySelectorAll('[data-path]')) r.classList.toggle('selected', pane.selected.has(r.dataset.path));
          root.querySelector('.remote-file-status').textContent = pane.entries.length + ' 项 · 已选 ' + pane.selected.size + ' 项';
        }
        openFileMenu(side, event);
      });
      // 双击：目录进入，文件打开（远程先暂存到本地再交给编辑器）。
      root.addEventListener('dblclick', attempt(async event => {
        const row = event.target.closest('[data-path]'); if (!row) return;
        const entry = pane.byPath.get(row.dataset.path); if (!entry) return;
        event.preventDefault(); event.stopPropagation();
        if (entry.directory) { if (!entry.link) await browse(side, entry.path); return; }
        await editEntry(side, entry);
      }));
      root.onclick = attempt(async event => {
        const row = event.target.closest('[data-path]');
        if (row) { if (!event.ctrlKey && !event.metaKey) pane.selected.clear(); if (pane.selected.has(row.dataset.path)) pane.selected.delete(row.dataset.path); else pane.selected.add(row.dataset.path); for (const r of root.querySelectorAll('[data-path]')) r.classList.toggle('selected', pane.selected.has(r.dataset.path)); root.querySelector('.remote-file-status').textContent = pane.entries.length + ' 项 · 已选 ' + pane.selected.size + ' 项'; return; }
        const action = event.target.closest('[data-action]')?.dataset.action; if (!action) return;
        if (action === 'up' || action === 'refresh') return browse(side, action === 'up' ? parent(side, pane.path) : pane.path);
        if (action === 'upload' || action === 'download') return enqueue(action, [...pane.selected]);
        if (action === 'mkdir') { const name = await Modal.prompt('新建目录', '目录名称', ''); if (!name) return; if (/[\\/\0\r\n]/.test(name) || name === '.' || name === '..') throw Error('请输入目录名称，不能包含路径分隔符'); if (side === 'local') await call('localMkdir', joined(side, pane.path, name)); else await call('mkdir', sid, joined(side, pane.path, name)); }
        if (action === 'rename') { if (pane.selected.size !== 1) throw Error('请选择一个项目'); const target = [...pane.selected][0], name = await Modal.prompt('重命名', '新名称', pane.byPath.get(target)?.name); if (!name) return; if (side === 'local') await call('localRename', target, name); else await call('rename', sid, target, name); }
        if (action === 'remove') { if (!pane.selected.size) throw Error('请选择要删除的项目'); const paths = [...pane.selected]; if (!await Modal.confirm('删除文件', esc(paths.join('\n')) + '\n\n删除不可撤销；目录仅允许删除空目录。')) return; for (const target of paths) { if (side === 'local') await call('localRemove', target); else await call('removeFile', sid, target); } }
        await browse(side, pane.path);
      });
      root.ondblclick = attempt(async event => { const row = event.target.closest('[data-path]'), entry = row && pane.byPath.get(row.dataset.path); if (entry?.directory && !entry.link) await browse(side, entry.path); });
      root.ondragstart = event => { const row = event.target.closest('[data-path]'); if (!row) return; const paths = pane.selected.has(row.dataset.path) ? [...pane.selected] : [row.dataset.path]; event.dataTransfer.setData('application/x-myide-' + side, JSON.stringify({ paths, sid })); event.dataTransfer.effectAllowed = 'copy'; };
      root.ondragover = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; };
      root.ondrop = attempt(async event => {
        event.preventDefault(); event.stopPropagation(); const opposite = side === 'local' ? 'remote' : 'local', internal = event.dataTransfer.getData('application/x-myide-' + opposite);
        if (internal) { const parsed = JSON.parse(internal); if (side === 'local' && parsed.sid !== sid) throw Error('拖入内容来自其他会话，请切回原服务器'); await enqueue(side === 'local' ? 'download' : 'upload', parsed.paths); }
        else if (side === 'remote' && event.dataTransfer.files.length) await enqueue('upload', [...event.dataTransfer.files].map(file => window.myIDE.fs.pathOfDroppedFile(file)).filter(Boolean));
      });
      renderPane(side);
    }
  }
  function renderJobs() {
    q('remote-transfer-count').textContent = jobs.size;
    const active = [...jobs.values()].filter(j => ['running', 'queued'].includes(j.state)).length, completed = [...jobs.values()].filter(j => j.state === 'completed').length, failed = [...jobs.values()].filter(j => j.state === 'failed').length;
    q('remote-transfer-summary').textContent = active ? `${active} 项正在传输` : jobs.size ? `${completed} 项已完成` + (failed ? ` · ${failed} 项失败` : '') : '尚无传输';
    if (!jobs.size) q('remote-transfers').open = false;
    q('remote-transfer-jobs').innerHTML = jobs.size ? [...jobs.values()].map(job => `<div class="remote-transfer" data-state="${esc(job.state)}"><span class="remote-transfer-icon">${icons[job.direction]}</span><div class="remote-transfer-body"><div class="remote-transfer-label"><strong>${job.direction === 'upload' ? '上传' : '下载'} · ${esc(job.from.split(/[\\/]/).pop())}</strong><span class="remote-job-state">${labels[job.state]}</span></div><div class="remote-transfer-dest" title="${esc(job.to)}">${esc(job.to)}</div><div class="remote-progress-row"><progress max="${Math.max(job.total || job.bytes, 1)}" value="${job.bytes}"></progress><span>${displaySize(job.bytes)} / ${displaySize(job.total || 0)}</span></div>${job.error ? '<div class="remote-form-error">' + esc(job.error) + '</div>' : ''}</div>${['running', 'queued'].includes(job.state) ? '<button class="vt-btn" data-cancel-job="' + esc(job.id) + '">取消</button>' : ['failed', 'cancelled'].includes(job.state) && !job.retried ? '<button class="vt-btn" data-retry-job="' + esc(job.id) + '">重试</button>' : ''}</div>`).join('') : '<div class="remote-empty">尚无传输。</div>';
  }
  function onEvent(event) {
    if (event.type === 'session') { sessions.set(event.session.id, event.session); renderSessions(); if (event.session.id === sid && event.session.state === 'disconnected') { panes.remote.serial++; notify('连接已断开' + (event.session.error ? '：' + event.session.error : ''), !!event.session.error); } }
    if(event.type==='terminal-open'){try{const t=mountTerminal(event.terminalId,event.sessionId,true);t.opened=true;}catch(error){notify(error.message,true);}}
    if (event.type === 'terminal-data') { const t = terminals.get(event.terminalId); if (t) t.term.write(event.data, () => { void call('ack', event.sessionId, event.terminalId, event.seq).catch(() => {}); }); else void call('ack', event.sessionId, event.terminalId, event.seq).catch(() => {}); }
    if (event.type === 'terminal-close') { const t = terminals.get(event.terminalId); if (t) { t.closed = true; t.term.writeln('\r\n[终端已关闭]'); renderTerminals(); } }
    if (event.type === 'terminal-error') notify(event.error, true);
    if (event.type === 'transfer') { jobs.set(event.job.id, event.job); renderJobs(); if (event.job.state === 'completed' && event.job.sessionId === sid) void browse(event.job.direction === 'upload' ? 'remote' : 'local', panes[event.job.direction === 'upload' ? 'remote' : 'local'].path).catch(() => {}); }
  }
  function init() {
    if (initialized || !q('remote-main') || !window.myIDE?.remote) return; initialized = true; installFiles(); api().onEvent(onEvent);
    q('remote-add').onclick = () => form(); q('remote-edit').onclick = () => form(profiles.find(p => p.id === selected));
    q('remote-delete').onclick = attempt(async () => { const p = profiles.find(p => p.id === selected); if (p && await Modal.confirm('删除服务器配置', '删除「' + esc(p.name) + '」的保存配置？')) { const result = await call('remove', p.id, version); profiles = result.profiles; version = result.version; selected = profiles[0]?.id; renderSessions(); } });
    q('remote-refresh').onclick = attempt(refresh); q('remote-connect').onclick = attempt(connect);
    q('remote-disconnect').onclick = attempt(async () => {
      await call('disconnect', sid);
      notify('已断开SSH连接。'); controls();
      // 断开后必须停掉概览轮询并清空：否则定时器还在拿旧 sid 调用，每隔 5 秒
      // 报一次「连接已断开」，而且页面还留着上一次的数字（看着像服务器还活着）。
      stopOverviewTimer(); renderOverview(null);
    });
    q('remote-new-terminal').onclick = attempt(newTerminal);
    q('remote-profiles').onclick = attempt(async event => { const id = event.target.closest('[data-profile]')?.dataset.profile; if (!id) return; selected = id; const found = [...sessions.values()].find(s => s.profileId === id && s.state === 'connected'); await activateSession(found?.id || null); });
    q('remote-sessions').onchange = attempt(event => activateSession(event.target.value));
    q('remote-terminal-tabs').onclick = attempt(async event => { const close = event.target.closest('[data-close-term]')?.dataset.closeTerm; if (close) { const t = terminals.get(close); if (!t) return; if (!t.closed && !await Modal.confirm('关闭终端', '关闭会结束这个SSH终端；终端前台任务可能随之结束。')) return; await call('closeTerminal', t.sid, t.id); t.term.dispose(); t.container.remove(); terminals.delete(close); if (activeTerm === close) { activeTerm = [...terminals.keys()].at(-1) || null; if (activeTerm) selectTerminal(activeTerm); } renderTerminals(); } else { const id = event.target.closest('[data-term]')?.dataset.term; if (id) selectTerminal(id); } });
    for (const tab of ['terminal', 'files', 'overview']) q('remote-tab-' + tab).onclick = () => {
      mode = tab; renderMode(); requestFit();
      if (tab === 'files' && !panes.local.path) void browse('local', '').catch(error => notify(error.message, true));
    };
    q('remote-transfer-jobs').onclick = attempt(async event => { const cancel = event.target.closest('[data-cancel-job]')?.dataset.cancelJob, retry = event.target.closest('[data-retry-job]')?.dataset.retryJob; const button = event.target.closest('button'); if (button) button.disabled = true; try { if (cancel) { const result = await call('cancel', cancel); if (result?.reason) notify(result.reason); } if (retry) await call('retry', retry, sid); } finally { if (button?.isConnected) button.disabled = false; } });
    q('remote-clear-transfers').onclick = attempt(async event => { event.preventDefault(); const result = await call('clearFinished'); jobs.clear(); result.forEach(j => jobs.set(j.id, j)); renderJobs(); });
    // 主题和自定义调色都更新 body；xterm 的 Canvas 配色也必须同步。
    const appearance = new MutationObserver(requestAppearance);
    appearance.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    if (window.ResizeObserver) new ResizeObserver(requestFit).observe(q('remote-terminal-panes'));
    void refresh().catch(error => notify(error.message, true));
    void call('snapshot').then(value => { value.sessions.forEach(s => sessions.set(s.id, s)); value.jobs.forEach(j => jobs.set(j.id, j)); renderSessions(); renderJobs(); }).catch(error => notify(error.message, true));
  }
  function syncVisible(value) {
    visible = value;
    if (value) { if (appearanceDirty) syncTerminalAppearance(); requestFit(); }
    // 面板整个被切走时也要停概览轮询：用户看不见它，没必要每 5 秒跑一次 SSH 采集。
    if (!value) stopOverviewTimer();
    else if (mode === 'overview' && connected()) startOverviewTimer();
  }
  function getPageContext() {
    const profile = profiles.find(p => p.id === selected);
    // 白名单字段：页面定位不能把密码、私钥、终端输出或文件内容带入模型请求。
    return { mode, server: profile ? { id:profile.id, name:profile.name, host:profile.host,
      port:profile.port, username:profile.username } : null, sessionId:sid || null, terminalId:activeTerm || null };
  }
  // renderOverview 暴露出来是给自检用的：真实采集要连服务器，而概览的渲染骨架
  // （卡片、进度条、阈值配色、空态）可以拿一份同构样本单独验证。
  return { init, syncVisible, refresh, showTerminal, getPageContext, renderOverview, loadOverview };
})();

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
    newFile: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 1.8H4.2a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V5.4z"/><path d="M9.2 1.8v3.6h3.6M8 8.6v3.2M6.4 10.2h3.2"/></svg>',
    newDir: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4.2h4l1.4 1.9h7v7.1H1.8z"/><path d="M8 8.4v3M6.5 9.9h3"/></svg>',
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
    // 新建：右键空白处 = 建在当前目录；右键某个目录 = 建在那个目录里。
    // （右键一个文件时，建在它所在目录 —— 与 Windows 资源管理器一致）
    const targetDir = entry?.directory ? entry.path : pane.path;
    sep();
    add(fileMenuIcons.newFile, '新建文件…', () => void createEntry(side, targetDir, false));
    add(fileMenuIcons.newDir, '新建目录…', () => void createEntry(side, targetDir, true));
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

  // 新建文件 / 新建目录。dir 是目标父目录，isDir 决定建哪种。
  // 名称校验与顶部工具条的「新建目录」保持一致，避免两处规则不同。
  const NAME_BAD = /[\\/\0\r\n]/;
  async function createEntry(side, dir, isDir) {
    const label = isDir ? '新建目录' : '新建文件';
    const name = await Modal.prompt(label, isDir ? '目录名称' : '文件名称（可带扩展名，如 frps.toml）', '');
    if (!name) return;
    const trimmed = String(name).trim();
    if (!trimmed || NAME_BAD.test(trimmed) || trimmed === '.' || trimmed === '..') {
      MI.toast('名称不能为空，也不能包含路径分隔符', 'err');
      return;
    }
    // 自己拼路径，不依赖后面的 joined：那个 const 在同一模块作用域末尾定义，
    // 虽然运行时已初始化，但读代码时容易误以为有 TDZ 风险。
    const sepChar = side === 'remote' ? '/' : '\\';
    const baseDir = String(dir).replace(/[\\/]+$/, '');
    const target = (baseDir || (side === 'remote' ? '' : sepChar)) + sepChar + trimmed;
    try {
      if (side === 'remote') {
        await call(isDir ? 'mkdir' : 'createFile', sid, target);
      } else {
        await call(isDir ? 'localMkdir' : 'localCreateFile', target);
      }
      // 建完刷新该面板；新建文件后直接打开编辑（新建的目的就是写内容）。
      await browse(side, dir).catch(() => {});
      if (!isDir) {
        const entry = panes[side].byPath.get(target);
        if (entry) await editEntry(side, entry);
        else notify('已创建 ' + trimmed + '（刷新后可见）', false);
      } else {
        notify('已创建目录 ' + trimmed, false);
      }
    } catch (error) {
      MI.toast('新建失败：' + ((error && error.message) || error), 'err');
      notify('新建失败：' + ((error && error.message) || error), true);
    }
  }

  // 右键菜单里的「下载 / 上传」：作用对象是当前选中的那一批文件。
  // 复用顶部工具条那条 enqueue 链路（含冲突确认、进度队列），不另造一套传输。
  async function transferSelected(side, action) {
    const sources = [...panes[side].selected];
    if (!sources.length) { notify('请先选择文件', true); return; }
    try { await enqueue(action, sources); }
    catch (error) { notify(error.message, true); }
  }

  // ── 远程文件编辑弹框 ──────────────────────────────────────────────────
  // 用户要求：右键「编辑远程文件」应该是**独立弹出一个编辑框**，不要在标签页之间跳、
  // 也不要把远程面板收起来。之前两版都不对 —— 一版是下载到临时目录再当本地文件打开，
  // 一版是塞进主编辑器（会把当前正在看的文件和视图挤掉）。
  //
  // 这里用 Modal 弹一个自包含的浮层：CodeMirror 编辑 + 保存/关闭，直接读 remote://
  // 虚拟路径（fs:* 层已转发到 SFTP），保存即写回服务器。
  let remoteEditorBox = null;

  function closeRemoteEditor() {
    if (!remoteEditorBox) return;
    const box = remoteEditorBox;
    remoteEditorBox = null;
    try { box.__editor?.destroy?.(); } catch {}
    try { box.__cleanup?.(); } catch {}
    while (Modal.stack.includes(box)) Modal.hide();
  }

  async function openRemoteEditor(entry) {
    if (!entry || entry.directory) return;
    if (!connected()) { MI.toast('请先连接服务器再编辑远程文件', 'err'); return; }
    // 同一文件已经开着就直接聚焦，不重复弹（避免多个框改同一文件互相覆盖）。
    if (remoteEditorBox?.__path === entry.path) {
      remoteEditorBox.__editor?.focus?.();
      return;
    }
    closeRemoteEditor();

    const virtual = window.myIDE.remote.virtualPath(sid, entry.path);
    const box = document.createElement('div');
    box.className = 're-box';
    box.dataset.selfEsc = '1';
    box.innerHTML =
      '<div class="m-head"><span class="re-title"></span><span class="x" data-re="close">✕</span></div>'
      + '<div class="re-sub"></div>'
      + '<div class="re-host"><div class="re-loading">正在读取…</div></div>'
      + '<div class="m-foot"><span class="re-state"></span><span class="spacer"></span>'
      + '<button class="tb-btn" data-re="close">关闭</button>'
      + '<button class="tb-btn m-ok" data-re="save">保存 (Ctrl+S)</button></div>';
    box.querySelector('.re-title').textContent = entry.name || entry.path.split('/').pop();
    box.querySelector('.re-sub').textContent = entry.path;

    const host = box.querySelector('.re-host');
    const stateEl = box.querySelector('.re-state');
    let dirty = false;
    let savedVersion = null;
    let editor = null;

    const setState = text => { stateEl.textContent = text || ''; };

    // 保存：拿磁盘当前版本做条件写，远程被别人改过就拒绝（与本地保存同一条规矩）。
    const save = async () => {
      if (!editor) return;
      const content = editor.getValue();
      setState('正在保存…');
      try {
        // 注意 fs:fileVersion 返回的是 {version} / {error} 形状（没有 ok 字段），
        // 直接用 current.error 判断，别再写 !current.ok === false 这种无效表达式。
        const current = await window.myIDE.fs.fileVersion(virtual);
        if (current?.error) throw Error(current.error);
        const result = await window.myIDE.fs.writeFile(virtual, content, null,
          { expectedVersion: savedVersion });
        // ⚠ fs:writeFile 成功时返回 {textFormat, version}，**没有 ok 字段** ——
        // 之前写 `if (!result?.ok) throw`，于是每次保存都报「写入失败」，
        // 但服务器上的文件其实已经写好了（端到端测试抓到的就是这个：
        // 磁盘内容变了、状态却是保存失败）。改成按 error 判断。
        if (result?.error) throw Error(result.error);
        savedVersion = result.version || savedVersion;
        dirty = false;
        setState('已写回服务器 ' + new Date().toLocaleTimeString());
        MI.toast('已保存到服务器', 'ok');
      } catch (error) {
        setState('保存失败');
        MI.toast('保存失败：' + ((error && error.message) || error), 'err');
      }
    };

    box.addEventListener('click', event => {
      const action = event.target.closest('[data-re]')?.dataset.re;
      if (!action) return;
      event.preventDefault(); event.stopPropagation();
      if (action === 'close') {
        if (dirty && !confirm('还有未保存的修改，确定关闭？')) return;
        closeRemoteEditor();
      } else if (action === 'save') void saveOnce();
    });
    // Ctrl+S 有两条触发路径：编辑器内（CodeEditor 的 onSave）和这里（焦点在
    // 按钮/别处时）。加一个短防抖，避免同一次按键触发两次写入。
    let saving = false;
    const saveOnce = async () => {
      if (saving) return;
      saving = true;
      try { await save(); } finally { saving = false; }
    };
    box.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); event.stopPropagation(); void saveOnce();
      }
    });

    box.__path = entry.path;
    remoteEditorBox = box;
    Modal.show(box);
    // ⚠ 可选链不能出现在赋值左侧（`x?.y = 0` 是语法错误），必须分开判断。
    const hostEl = box.querySelector('.re-host');
    if (hostEl) hostEl.scrollTop = 0;

    try {
      const file = await window.myIDE.fs.readFile(virtual);
      if (!remoteEditorBox) return; // 读取期间被关掉了
      if (file?.error) throw Error(file.error);
      if (file?.tooLarge) throw Error('文件过大（' + Math.round((file.size || 0) / 1024) + ' KiB），请下载到本地再编辑');
      // ⚠ 字段是 content（TextFormat.decodeText 返回 {content, encoding, textFormat}），
      // 不是 text。之前读 file.text 永远是 undefined，弹框只会显示空文档 ——
      // 端到端测试（真实 SSH）才暴露出来，单测里我用了自己造的 {text} 假数据所以没发现。
      const text = file.content ?? '';
      if (file.binary) throw Error('这是二进制文件，无法以文本方式编辑');
      savedVersion = file.version || null;
      host.innerHTML = '';
      const target = document.createElement('div');
      target.className = 're-editor';
      host.append(target);
      const ext = (entry.name.split('.').pop() || '').toLowerCase();
      if (window.CodeEditor) {
        editor = window.CodeEditor.create({
          // ⚠ canEdit 是「函数」不是布尔值：code-editor 里写的是
          // `opts.canEdit && !opts.canEdit()`，传 true 会直接抛
          // "opts.canEdit is not a function"（实测弹框打开即报这个错）。
          parent: target, ext, doc: text, canEdit: () => true,
          onChange: () => { if (!dirty) { dirty = true; setState('未保存'); } },
          // Ctrl+S 交给弹框自己的保存逻辑（CodeMirror 的 Mod-s 默认会被它拦下）
          onSave: () => { void saveOnce(); },
        });
      }
      if (!editor) {
        // CodeMirror 不可用时退回 textarea：仍然能编辑保存，而不是打不开。
        const ta = document.createElement('textarea');
        ta.className = 're-textarea'; ta.value = text; ta.spellcheck = false;
        ta.addEventListener('input', () => { if (!dirty) { dirty = true; setState('未保存'); } });
        target.append(ta);
        editor = { getValue: () => ta.value, focus: () => ta.focus(), destroy: () => ta.remove() };
      }
      box.__editor = editor;
      editor.focus?.();
      setState('已加载 ' + text.length + ' 字符');
    } catch (error) {
      if (!remoteEditorBox) return;
      host.innerHTML = '<div class="re-error">读取失败：' + esc((error && error.message) || error) + '</div>';
      setState('读取失败');
    }

    box.__cleanup = () => { host.innerHTML = ''; };
  }

  // 编辑：把远程文件编码成 remote:// 虚拟路径直接交给编辑器打开。
  //
  // 之前是「下载到 userData 临时目录再当本地文件打开」，从用户视角完全说不通：
  // 标签页显示的是一串哈希名和 %APPDATA% 路径，根本看不出自己在编辑哪台服务器上的
  // 哪个文件，而且还得关心里存不存在。现在标签就是 /app/frp/frps.toml，
  // 读写由 fs:* 的 remote:// 路由直连 SFTP，磁盘上什么都不留。
  async function editEntry(side, entry) {
    if (!entry || entry.directory) return;
    if (side === 'local') {
      const r = await Viewer.openFile(entry.path).catch(error => ({ ok: false, error: error.message }));
      if (r?.ok === false) MI.toast('打开失败：' + (r.error || '未知原因'), 'err');
      return;
    }
    // 远程文件弹出独立的编辑框：不跳标签页、不收起远程面板。
    await openRemoteEditor(entry);
  }

  // ── 概览页（服务器仪表盘）─────────────────────────────────────────────
  // 数据全部来自主进程的固定只读采集脚本（见 remote-service 的 OVERVIEW_SCRIPT），
  // 这里只负责画与交互。
  //
  // 布局：左侧「资源监控」占大头（三条大进度条 + 网速 + 负载），右侧一列其余卡片。
  // 之前是等宽 auto-fit 网格，八张卡片大小一致、参差不齐地换行，CPU/内存这种
  // 最该被看见的数据和「主目录占用」占同样面积，视线没有落点。
  //
  // 交互：点每一行都能做进一步操作（跳文件、开终端、看日志），
  // 全部通过「在已有终端里投递命令」实现 —— 复用现成终端（能看输出、能 Ctrl+C），
  // 不另开一条命令执行通道。
  let overviewSerial = 0, overviewTimer = null;
  let overviewCpuPrev = null, overviewNetPrev = null, overviewLastAt = 0;
  let overviewLast = null; // 上一份数据，供点击时取行内上下文

  const fmtBytes = value => {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = value, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
  };
  const fmtRate = bytesPerSec => {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
    return fmtBytes(bytesPerSec) + '/s';
  };
  // 时长格式化（2026-10-28）：不再输出「30 天 0 小时」这种冗余尾项
  const fmtDuration = seconds => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
    if (d) return h ? d + ' 天 ' + h + ' 小时' : d + ' 天';
    if (h) return m ? h + ' 小时 ' + m + ' 分' : h + ' 小时';
    return m + ' 分';
  };
  const pct = (used, total) => !total ? 0 : Math.min(100, Math.max(0, Math.round(used / total * 100)));
  const level = p => p >= 90 ? 'critical' : p >= 75 ? 'warn' : 'ok';

  // 单条大进度条（左标签、右数值、下方细条 + 说明）。
  function bigMeter(label, percent, figure, detail) {
    return '<div class="remote-ov-big" data-level="' + level(percent) + '">'
      + '<div class="remote-ov-big-head"><span>' + label + '</span><strong>' + figure + '</strong></div>'
      + '<div class="remote-ov-bar"><i style="width:' + percent + '%"></i></div>'
      + '<div class="remote-ov-big-foot">' + detail + '</div></div>';
  }
  // 可点的行：data-ov-* 携带点击所需上下文。
  function row(attrs, main, right, opts = {}) {
    const cls = 'remote-ov-row' + (opts.clickable === false ? '' : ' is-clickable');
    return '<div class="' + cls + '" ' + attrs + ' role="button" tabindex="0">'
      + '<span class="remote-ov-row-main" title="' + esc(opts.title || main) + '">' + main + '</span>'
      + '<span class="' + (opts.rightClass || 'remote-ov-row-sub') + '">' + right + '</span></div>';
  }
  const card = (title, body, cls = '') =>
    '<section class="remote-ov-card ' + cls + '"><header>' + title + '</header>' + body + '</section>';

  /**
   * 渲染概览。
   * @param {object} ov   采集结果
   * @param {string} [cat] 指定运维台分类（自检/预览用；不传则沿用当前选择）
   */
  /**
   * 页面骨架：把 HTML 里的文本内容、属性值都抹掉，只留标签结构与 class/data 键。
   * 两次骨架相同 = 行的集合与顺序没变，可以只更新文本而不重建 DOM。
   * 用 data-ops-key 而不是文本参与比较 —— 文本正是要更新的东西。
   */
  function skeletonOf(html) {
    return String(html)
      .replace(/>[^<]*</g, '><')                       // 去文本
      .replace(/style="[^"]*"/g, '')                   // 进度条宽度会变，不算结构
      .replace(/data-ops-args="[^"]*"/g, '')
      .replace(/title="[^"]*"/g, '')
      .replace(/value="[^"]*"/g, '');
  }

  /**
   * 判断「当前 DOM 的行」与「新数据的行」是否是同一批对象、同顺序。
   * 用 data-ops-key 比对 —— 它由对象的稳定标识构成（容器名/单元名/pid/路径）。
   */
  function sameRowKeys(listEl, rows) {
    const nodes = listEl.querySelectorAll('.remote-ops-row');
    if (nodes.length !== rows.length) return false;
    for (let i = 0; i < nodes.length; i++) {
      const btn = nodes[i].querySelector('[data-ops-key]');
      const key = btn ? btn.dataset.opsKey : '';
      if (key !== String(rows[i].key)) return false;
    }
    return true;
  }

  /**
   * 只更新已存在的行文本（骨架未变时使用）。
   * 关键：不碰 nodes，所以滚动位置、菜单展开状态、输入焦点都保留。
   */
  function patchOpsRows(host, rows, meters) {
    const list = host.querySelector('#remote-ops-list');
    if (!list) return;
    const nodes = [...list.querySelectorAll('.remote-ops-row')];
    // 行数对不上说明骨架其实变了（理论上不会走到这），交给上层重建
    if (nodes.length !== rows.length) return;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i], r = rows[i];
      const set = (sel, text) => {
        const el = node.querySelector(sel);
        if (el && el.textContent !== text) el.textContent = text;
      };
      set('.remote-ops-name', r.name);
      const badge = node.querySelector('.remote-ops-badge');
      if (badge && r.badge && badge.textContent !== r.badge.text) {
        badge.textContent = r.badge.text;
        badge.dataset.level = r.badge.level || 'off';
      }
      set('.remote-ops-meta', r.meta || '');
      set('.remote-ops-sub', r.sub || '');
      set('.remote-ops-key', r.keyText || '');
      const dot = node.querySelector('.remote-ops-dot');
      if (dot) dot.className = 'remote-ops-dot ' + r.state;
      node.classList.toggle('is-bad', !!r.bad);
    }
    // 资源摘要条：宽度与阈值配色随数值变化，增量路径下也要更新，
    // 否则「内存 97% 变红」这类告警不会出现（2026-10-28）
    if (meters) {
      host.querySelectorAll('.remote-ov-mini').forEach((el, i) => {
        const m = meters[i];
        if (!m) return;
        if (el.dataset.level !== m.level) el.dataset.level = m.level;
        const bar = el.querySelector('.remote-ov-mini-bar > i');
        if (bar) bar.style.width = m.percent + '%';
        const figure = el.querySelector('.remote-ov-mini-head strong');
        if (figure && figure.textContent !== m.figure) figure.textContent = m.figure;
        const foot = el.querySelector('.remote-ov-mini-foot');
        if (foot && m.detail && foot.textContent !== m.detail) foot.textContent = m.detail;
      });
    }

    // 计数也要更新（筛出 N / 共 M 可能变）
    const count = host.querySelector('.remote-ops-count');
    if (count) {
      const total = (overviewLast && opsRows(overviewLast).length) || rows.length;
      count.textContent = rows.length === total ? '共 ' + total : '筛出 ' + rows.length + ' / 共 ' + total;
    }
  }

  function renderOverview(ov, cat) {
    if (cat) opsCat = cat;
    const host = q('remote-overview'); if (!host) return;
    if (!ov) { host.innerHTML = '<div class="remote-empty">连接服务器后查看概览。</div>'; overviewLast = null; return; }
    overviewLast = ov;
    const { os = {}, kernel = {}, cpu = {}, memory = {}, uptime, disks = [], listen = [], services = [], docker = [], du = [], net } = ov;

    // CPU：用两次 /proc/stat 采样做差才算得准；首次没历史值就退回累计占比。
    const now = Date.now();
    let cpuPercent = 0;
    if (cpu.usage) {
      const prev = overviewCpuPrev;
      overviewCpuPrev = cpu.usage;
      if (!prev) cpuPercent = Math.round((1 - cpu.usage.idle / Math.max(1, cpu.usage.total)) * 100);
      else {
        const dTotal = cpu.usage.total - prev.total, dIdle = cpu.usage.idle - prev.idle;
        cpuPercent = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
      }
      cpuPercent = Math.max(0, Math.min(100, cpuPercent));
    }
    // 网速：同样两次采样做差（服务端只给累计字节）。
    let rxRate = 0, txRate = 0;
    if (net && overviewNetPrev && overviewLastAt) {
      const dt = Math.max(0.5, (now - overviewLastAt) / 1000);
      rxRate = Math.max(0, (net.rx - overviewNetPrev.rx) / dt);
      txRate = Math.max(0, (net.tx - overviewNetPrev.tx) / dt);
    }
    if (net) { overviewNetPrev = net; overviewLastAt = now; }

    const memPercent = pct(memory.used, memory.total);
    const diskTotal = disks.reduce((s, d) => s + d.total, 0);
    const diskUsed = disks.reduce((s, d) => s + d.used, 0);
    const diskPercent = pct(diskUsed, diskTotal);

    // ── 左：资源监控（大头）──
    // 顶部摘要条（2026-10-28 按原型改）：CPU/内存/磁盘压成一行三格。
    // 原来三根大进度条占掉左列大半高度，把运维台挤到下面只露一条 ——
    // 监控是背景信息，一眼扫过就够；主区应该留给「能操作的对象」。
    const miniMeter = (label, percent, figure, detail) =>
      '<div class="remote-ov-mini" data-level="' + level(percent) + '">'
      + '<div class="remote-ov-mini-head"><span>' + label + '</span><strong>' + figure + '</strong></div>'
      + '<div class="remote-ov-mini-bar"><i style="width:' + percent + '%"></i></div>'
      + '<div class="remote-ov-mini-foot">' + detail + '</div></div>';

    lastMeters = [
      { percent: cpuPercent, level: level(cpuPercent), figure: cpuPercent + '%',
        detail: (cpu.cores || '?') + ' 核 · 负载 ' + (cpu.load?.length ? cpu.load.map(n => n.toFixed(2)).join(' ') : '—') },
      { percent: memPercent, level: level(memPercent),
        figure: fmtBytes(memory.used) + ' / ' + fmtBytes(memory.total),
        detail: '可用 ' + fmtBytes(memory.available) },
      { percent: diskPercent, level: level(diskPercent),
        figure: fmtBytes(diskUsed) + ' / ' + fmtBytes(diskTotal),
        detail: disks.length + ' 个分区' },
    ];
    const monitor = card('资源监控',
      '<div class="remote-ov-minis">'
      + miniMeter('CPU', cpuPercent, cpuPercent + '%',
        (cpu.cores || '?') + ' 核 · 负载 ' + (cpu.load?.length ? cpu.load.map(n => n.toFixed(2)).join(' ') : '—'))
      + miniMeter('内存', memPercent, fmtBytes(memory.used) + ' / ' + fmtBytes(memory.total),
        '可用 ' + fmtBytes(memory.available))
      + miniMeter('磁盘', diskPercent, fmtBytes(diskUsed) + ' / ' + fmtBytes(diskTotal),
        disks.length + ' 个分区')
      + '</div>'
      + '<div class="remote-ov-net"><span>入站 <strong>' + fmtRate(rxRate) + '</strong></span>'
      + '<span>出站 <strong>' + fmtRate(txRate) + '</strong></span>'
      + '<span>运行 <strong>' + fmtDuration(uptime) + '</strong></span>'
      + '<span>' + esc(kernel.serverTime ? new Date(kernel.serverTime * 1000).toLocaleString() : '—') + '</span></div>');


    // ── 运维台（2026-10-28 重做）──
    // 原来每张卡片点一下只是「往终端投递一条命令」，用户必须自己去敲 restart。
    // 现在改成分类列表 + 行内操作按钮：看到即能操作，写操作弹确认，执行后有回执。
    // 2026-10-28 再次调整：右侧那些「只能看」的卡片（系统/磁盘/端口/目录）全部并入
    // 运维台的分类，不再单独占一列 —— 一处看全、一处操作。
    const opsCard = card('服务器对象 <small>写操作会先确认</small>', buildOpsPanel(ov));

    // 布局（2026-10-28 用户要求）：取消右侧列，所有信息都进「服务器对象」。
    // 之前是「左主区 + 右列卡片」，右列那些信息（系统/磁盘/端口/目录）只能看不能操作，
    // 与左侧运维台割裂；现在把它们各自变成运维台的一个分类，一处看全、一处操作。
    const nextHtml = '<div class="remote-ov-grid single">' + monitor + opsCard + '</div>';

    // 增量更新（2026-10-28）：结构没变就不重建 DOM。
    // 原来每 5 秒 innerHTML 全量重建，导致：滚动位置跳回顶部、打开的「⋯」菜单被关掉、
    // 搜索框失焦、正在读的日志背景闪。
    //
    // 判据用「行键序列」而不是整段 HTML 字符串比对：浏览器会把 innerHTML 规范化
    // （属性顺序、空白、自闭合），字符串比对几乎永远不相等，等于没做增量。
    // 行键序列能准确表达「同一批对象、同样顺序」，正是增量更新的前提。
    const currentList = host.querySelector('#remote-ops-list');
    if (currentList && sameRowKeys(currentList, lastOpsRows)) {
      patchOpsRows(host, lastOpsRows, lastMeters);
      return;
    }
    host.innerHTML = nextHtml;
    bindOverviewClicks(host);
  }

  // ── 运维台（2026-10-28）────────────────────────────────────────────────
  // 分类 → 列表 → 行内操作。数据来自概览采集（只读），动作走 remote.op 通道。
  // 动作表按「对象状态」动态给按钮：已停止的容器给「启动」，运行中的给「停止」——
  // 之前固定四个按钮，导致已停止的容器永远没有启动入口。
  let opsCat = 'docker';
  // 每个分类各自记住「搜索词 / 排序 / 只看异常」，切回来不重置（2026-10-28）
  const listState = {};
  /** 各分类的默认排序：按用户最关心的字段，而不是字母序 */
  const defaultSort = cat => ({
    docker: 'status',   // 异常优先
    svc: 'status',
    proc: 'cpu',        // 看进程就是为了找谁在吃 CPU
    port: 'name',       // 端口号升序
    disk: 'name',
    du: 'mem',          // 目录按大小倒序
    sys: 'name',
  }[cat] || 'name');
  /**
   * 表格列定义（2026-10-28 用户要求改成表格）。
   *
   * 为什么用表格而不是「一行两层的卡片式」：卡片式只能塞两行文字，字段一多就变成
   * 「镜像 · 状态 · 时长」糊在一行里，读不出哪一列是什么。表格有表头，每个字段
   * 各归各位，宽度可控，还能按列排序。
   *
   * 列定义：{ id, label, width, align, sortable, cell(row) }
   */
  const tableColumns = cat => ({
    docker: [
      { id: 'name', label: '名称', width: 'minmax(9em,1.6fr)', sortable: true },
      { id: 'status', label: '状态', width: '7em', align: 'left' },
      { id: 'cpu', label: 'CPU', width: '6em', align: 'right', sortable: true },
      { id: 'mem', label: '内存', width: '6.5em', align: 'right', sortable: true },
      { id: 'ports', label: '端口', width: '9.5em', align: 'left' },
      { id: 'uptime', label: '运行时长', width: '8em', align: 'right' },
      { id: 'restarts', label: '重启', width: '4em', align: 'right' },
      { id: 'image', label: '镜像', width: 'minmax(7em,1.2fr)' },
    ],
    svc: [
      { id: 'name', label: '服务', width: 'minmax(10em,1.8fr)', sortable: true },
      { id: 'status', label: '状态', width: '6em', align: 'left' },
      { id: 'mem', label: '内存', width: '6.5em', align: 'right', sortable: true },
      { id: 'uptime', label: '已运行', width: '8em', align: 'right' },
      { id: 'enabled', label: '自启', width: '4.5em', align: 'center' },
      { id: 'desc', label: '描述', width: 'minmax(8em,1.4fr)' },
    ],
    proc: [
      { id: 'name', label: '进程', width: 'minmax(8em,1.3fr)', sortable: true },
      { id: 'pid', label: 'PID', width: '5.5em', align: 'right' },
      { id: 'cpu', label: 'CPU', width: '6em', align: 'right', sortable: true },
      { id: 'mem', label: '内存', width: '5.5em', align: 'right', sortable: true },
      { id: 'rss', label: '常驻', width: '6em', align: 'right', sortable: true },
      { id: 'etime', label: '运行时长', width: '7.5em', align: 'right' },
      { id: 'args', label: '命令行', width: 'minmax(10em,2fr)' },
    ],
    port: [
      { id: 'port', label: '端口', width: '6em', align: 'right', sortable: true },
      { id: 'proto', label: '协议', width: '4em', align: 'center' },
      { id: 'address', label: '监听地址', width: 'minmax(7em,1fr)' },
      { id: 'process', label: '进程', width: 'minmax(6em,1fr)' },
      { id: 'pid', label: 'PID', width: '5.5em', align: 'right' },
      { id: 'owner', label: '所属容器', width: 'minmax(8em,1.2fr)' },
    ],
    disk: [
      { id: 'name', label: '挂载点 / 项目', width: 'minmax(10em,1.6fr)', sortable: true },
      { id: 'used', label: '已用', width: '8em', align: 'right' },
      { id: 'total', label: '总量', width: '7em', align: 'right' },
      { id: 'percent', label: '占用', width: '5.5em', align: 'right', sortable: true },
      { id: 'note', label: '说明', width: 'minmax(8em,1.4fr)' },
    ],
    du: [
      { id: 'name', label: '目录', width: 'minmax(12em,2fr)', sortable: true },
      { id: 'size', label: '大小', width: '7em', align: 'right', sortable: true },
      { id: 'pct', label: '占比', width: '6em', align: 'right' },
    ],
    sys: [
      { id: 'name', label: '值', width: 'minmax(12em,2fr)' },
      { id: 'field', label: '项目', width: '8em' },
    ],
  }[cat] || []);

  /** 排序可选项（给下拉用） */
  const sortOptions = cat => ({
    docker: [['status', '异常优先'], ['name', '名称'], ['mem', '重启次数']],
    svc: [['status', '异常优先'], ['name', '名称'], ['mem', '内存']],
    proc: [['cpu', 'CPU 占用'], ['mem', '内存占用'], ['name', '名称']],
    port: [['name', '端口号'], ['mem', '无']],
    disk: [['name', '挂载点']],
    du: [['mem', '大小'], ['name', '名称']],
    sys: [['name', '名称']],
  }[cat] || [['name', '名称']]);

  const dockerActions = (running) => [
    { label: '日志', action: 'docker.logs', kind: 'logs', primary: true },
    running
      ? { label: '重启', action: 'docker.restart', primary: true }
      : { label: '启动', action: 'docker.start', primary: true },
    running
      ? { label: '停止', action: 'docker.stop', danger: true }
      : { label: '删除', action: 'docker.remove', danger: true },
    running ? { label: '暂停', action: 'docker.pause', danger: true } : null,
    { label: '详情', action: 'docker.inspect', kind: 'info' },
  ].filter(Boolean);

  // 服务动作分「主操作」与「更多」两档（2026-10-28）：
  // 之前每行 5 个按钮横着排，32 个服务就是 160 个按钮，整片区域被按钮占满，
  // 反而看不清服务本身。现在行内只留最高频的 日志 + 重启/启动，
  // 停止/重载/状态收进「更多」下拉，视觉噪音降一个量级。
  const svcActions = (running) => [
    { label: '日志', action: 'systemd.logs', kind: 'logs', primary: true },
    running
      ? { label: '重启', action: 'systemd.restart', primary: true }
      : { label: '启动', action: 'systemd.start', primary: true },
    running ? { label: '停止', action: 'systemd.stop', danger: true } : null,
    running ? { label: '重载', action: 'systemd.reload', danger: true } : null,
    { label: '状态', action: 'systemd.status', kind: 'info' },
  ].filter(Boolean);

  // 磁盘分类不是「对象列表」，是「可清理项清单」：每项自带预计释放空间的探测动作。
  const DISK_TARGETS = [
    { key: 'apt', name: 'APT 包缓存', meta: '/var/cache/apt · 安装包残留',
      action: 'disk.cleanApt', danger: true, probe: 'disk.aptCache' },
    { key: 'journal', name: 'systemd 日志', meta: 'journalctl · 保留最近 200MB',
      action: 'disk.vacuumJournal', args: { size: '200M' }, danger: true, probe: 'disk.journalSize' },
    { key: 'docker-images', name: 'Docker 悬空镜像', meta: 'docker image prune · 未被引用的层',
      action: 'docker.pruneImages', danger: true, probe: 'docker.df' },
    { key: 'usage', name: '主目录占用排行', meta: 'du -xhd1 · 只读',
      action: 'disk.usage', args: { path: '/home/ubuntu' }, kind: 'info' },
    { key: 'bigfiles', name: '大于 100MB 的文件', meta: 'find · 只读',
      action: 'disk.bigFiles', args: { path: '/home/ubuntu' }, kind: 'info' },
  ];

  /** 每类的行数据：从概览结果里取，保持与列表一致。 */
  /**
   * 每个分类的行数据（2026-10-28 重做）。
   *
   * 每行三层，让「不看详情就能判断」：
   *   name    名称
   *   badge   状态徽标（健康/不健康/异常退出/已停止…）
   *   key     第一层右侧的关键指标（端口映射 / CPU 内存 / 时长）
   *   meta    第二层身份信息（镜像 / 命令行 / 描述）
   *   sub     第二层次要指标（重启次数 / 自启 / PID）
   *   bad     是否异常（异常置顶 + 红边）
   */
  /**
   * 每行的单元格值（按列 id 取）。表格渲染时逐列取用，
   * 与 tableColumns 的 id 一一对应。
   */
  function opsCells(r) {
    return r.cells || {};
  }

  function opsRows(ov) {
    // ── Docker ──
    if (opsCat === 'docker') {
      return (ov.docker || []).map(c => {
        const running = /^Up /i.test(c.status);
        const exited = /Exited|Dead/i.test(c.status);
        const restarting = /Restarting/i.test(c.status);
        // 退出码非 0 = 异常退出（这是最需要被看见的状态）
        const exitCode = /Exited \((\d+)\)/.exec(c.status);
        const badExit = !!exitCode && exitCode[1] !== '0';
        const unhealthy = c.health === 'unhealthy';

        const badge = unhealthy ? { text: '不健康', level: 'bad' }
          : badExit ? { text: '异常退出', level: 'bad' }
          : exited ? { text: '已停止', level: 'off' }
          : restarting ? { text: '重启中', level: 'warn' }
          : c.health === 'healthy' ? { text: '健康', level: 'ok' }
          : running ? { text: '运行中', level: 'ok' }
          : { text: '未知', level: 'off' };

        // 关键指标改成「CPU + 内存」（2026-10-28）：
        // 原来显示端口映射和 "7 days ago"，前者是配置不是状态，后者和下一行的
        // Up 7 days 完全重复 —— 用户看了等于没看。资源占用才是要判断的东西。
        // 防御：老版本采集或夹具可能没有这些字段，不能因为缺字段就崩
        const cpuVal = typeof c.cpu === 'number' ? c.cpu : null;
        const memVal = typeof c.memBytes === 'number' ? c.memBytes : null;
        const key = running
          ? [(cpuVal !== null ? 'CPU ' + cpuVal.toFixed(1) + '%' : ''),
             (memVal !== null ? fmtBytes(memVal) : '')].filter(Boolean).join('　')
          : '';

        // 状态文本中文化：把 Docker 的英文时长（"23 hours ago" / "2 weeks ago"）
        // 转成中文，而不是「已运行 23 hours ago」这种半截翻译。
        const zhAge = text => {
          const t = String(text || '').trim();
          const m = /^(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago$/i.exec(t);
          if (!m) return t;
          const n = Number(m[1]);
          const unit = { second: '秒', minute: '分钟', hour: '小时', day: '天', week: '周', month: '个月', year: '年' }[m[2].toLowerCase()];
          return n + ' ' + unit;
        };
        const runText = (() => {
          if (/^Up /.test(c.status)) {
            const age = zhAge(c.runningFor);
            return age ? '已运行 ' + age : '运行中';
          }
          const e = /^Exited \((\d+)\)/.exec(c.status);
          if (e) return '已退出，代码 ' + e[1];
          if (/^Created/.test(c.status)) return '未启动';
          if (/^Restarting/.test(c.status)) return '重启中';
          return c.status;
        })();
        // 端口放第二行，去重后只显示对外端口
        const portsText = c.ports && c.ports.length
          ? c.ports.map(pt => ':' + pt.host + '→' + pt.container).join('  ')
          : '';

        return {
          key: c.name, name: c.name,
          cpuNum: c.cpu || 0, memNum: c.memBytes || 0,
          badge, bad: unhealthy || badExit,
          keyText: key,
          meta: c.image,
          // 表格单元格（2026-10-28）
          cells: {
            name: c.name,
            status: badge.text, statusLevel: badge.level,
            cpu: cpuVal !== null ? cpuVal.toFixed(1) + "%" : "—",
            mem: memVal !== null ? fmtBytes(memVal) : "—",
            ports: portsText || "—",
            uptime: runText.indexOf('已运行 ') === 0 ? runText.slice(4) : '—',
            restarts: c.restarts ? String(c.restarts) : "—",
            image: c.image,
          },
          sub: [
            portsText,
            runText,
            c.restarts ? '重启 ' + c.restarts + ' 次' : '',
          ].filter(Boolean).join(' · '),
          state: running ? 'on' : exited ? 'off' : 'warn',
          args: { name: c.name }, actions: dockerActions(running),
        };
      });
    }

    // ── 服务 ──
    if (opsCat === 'svc') {
      return (ov.services || []).map(sv => {
        const running = sv.sub === 'running';
        const failed = sv.sub === 'failed' || sv.active === 'failed';
        const badge = failed ? { text: '失败', level: 'bad' }
          : running ? { text: '运行中', level: 'ok' }
          : { text: '已停止', level: 'off' };
        // 关键指标：内存占用（服务最关心的资源）
        const key = running && sv.memory ? fmtBytes(sv.memory) : '';
        const since = sv.startedAt && running ? '已运行 ' + fmtDuration((Date.now() - sv.startedAt) / 1000) : '';
        return {
          key: sv.unit, name: sv.unit,
          cpuNum: 0, memNum: sv.memory || 0,
          badge, bad: failed,
          keyText: key,
          meta: sv.description || sv.unit,
          cells: {
            name: sv.unit,
            status: badge.text, statusLevel: badge.level,
            mem: sv.memory ? fmtBytes(sv.memory) : "—",
            uptime: since ? since.replace(/^已运行 /, "") : "—",
            enabled: sv.enabled === true ? "✓" : sv.enabled === false ? "—" : "?",
            desc: sv.description || "",
          },
          sub: [since, sv.enabled === true ? '开机自启' : sv.enabled === false ? '不自启' : ''].filter(Boolean).join(' · '),
          state: running ? 'on' : 'off',
          args: { unit: sv.unit }, actions: svcActions(running),
        };
      });
    }

    // ── 进程 ──
    if (opsCat === 'proc') {
      return (ov.procs || []).map(pr => {
        const hot = pr.cpu >= 50 || pr.mem >= 50;
        return {
          key: 'pid-' + pr.pid,
          name: pr.comm,
          cpuNum: pr.cpu, memNum: pr.mem,
          badge: pr.kernelThread ? { text: '内核线程', level: 'off' }
            : hot ? { text: '高占用', level: 'warn' }
            : { text: '运行中', level: 'ok' },
          bad: false,           // 进程高占用不算故障，用徽标提示即可
          keyText: 'CPU ' + pr.cpu.toFixed(1) + '%　内存 ' + pr.mem.toFixed(1) + '%',
          meta: pr.args,
          cells: {
            name: pr.comm,
            pid: String(pr.pid),
            cpu: pr.cpu.toFixed(1) + "%",
            mem: pr.mem.toFixed(1) + "%",
            rss: fmtBytes(pr.rss * 1024),
            etime: pr.etime,
            args: pr.args,
          },
          sub: 'PID ' + pr.pid + ' · ' + fmtBytes(pr.rss * 1024) + ' · 运行 ' + pr.etime,
          state: hot ? 'warn' : 'on',
          args: { pid: String(pr.pid) },
          actions: [
            { label: '详情', action: 'proc.detail', kind: 'info', primary: true },
            { label: '结束', action: 'proc.kill', danger: true },
          ],
          // 内核线程默认过滤（对用户无意义），但提供开关显示
          kernelThread: pr.kernelThread || pr.unknown,
        };
      });
    }

    // ── 端口 ──
    if (opsCat === 'port') {
      // 端口 → 反查所属容器，这是「谁占了这个端口」的答案
      const dockerByPort = new Map();
      for (const c of ov.docker || []) {
        for (const pt of c.ports || []) dockerByPort.set(pt.host, c.name);
      }
      return (ov.listen || []).map(p => {
        const owner = dockerByPort.get(p.port);
        return {
          key: 'port-' + p.port + '-' + p.proto,
          name: String(p.port),
          badge: owner ? { text: 'Docker', level: 'ok' }
            : p.process ? { text: p.process, level: 'off' }
            : { text: '未知', level: 'off' },
          bad: false,
          keyText: p.proto.toUpperCase() + '　' + p.address,
          meta: owner ? '由容器 ' + owner + ' 映射' : (p.process || '未知进程'),
          cells: {
            port: String(p.port),
            proto: p.proto.toUpperCase(),
            address: p.address,
            process: p.process || "—",
            pid: p.pid ? String(p.pid) : "—",
            owner: owner || "—",
          },
          sub: p.pid ? 'PID ' + p.pid : '',
          state: 'on',
          args: p.pid ? { pid: String(p.pid) } : {},
          actions: p.pid ? [{ label: '进程详情', action: 'proc.detail', kind: 'info', primary: true }] : [],
        };
      });
    }

    // ── 目录 ──
    if (opsCat === 'du') {
      const total = (ov.du || []).reduce((n, d) => n + d.bytes, 0);
      return (ov.du || []).map(d => ({
        key: 'du-' + d.path, name: d.path,
        cpuNum: 0, memNum: d.bytes,
        badge: { text: '', level: 'off' }, bad: false,
        keyText: fmtBytes(d.bytes),
        meta: total ? '占主目录 ' + Math.round(d.bytes / total * 100) + '%' : '',
        cells: {
          name: d.path,
          size: fmtBytes(d.bytes),
          pct: total ? Math.round(d.bytes / total * 100) + "%" : "—",
        },
        sub: '',
        state: 'on',
        args: { path: d.path },
        actions: [{ label: '看排行', action: 'disk.usage', kind: 'info', primary: true }],
      }));
    }

    // ── 系统 ──
    if (opsCat === 'sys') {
      const k = ov.kernel || {}, o = ov.os || {};
      // 系统信息：纯展示，每行一个字段（2026-10-28 表格化）
      const sysRows = [
        { field: "发行版", value: o.name || "—", extra: o.version ? "版本 " + o.version : "" },
        { field: "内核", value: k.release || "—", extra: "" },
        { field: "架构", value: k.arch || "—", extra: "" },
        { field: "主机名", value: k.hostname || "—", extra: "" },
        { field: "运行时长", value: ov.uptime ? fmtDuration(ov.uptime) : "—", extra: "" },
        { field: "CPU 核心", value: ((ov.cpu && ov.cpu.cores) || "?") + " 核", extra: "" },
      ];
      return sysRows.map((it, i) => ({
        key: "sys-" + i, name: it.value,
        cells: { name: it.value, field: it.extra ? it.field + "（" + it.extra + "）" : it.field },
        args: {}, actions: [], state: "on", bad: false,
      }));
    }

    // ── 磁盘：分区 + 可清理项 ──
    if (opsCat === 'disk') {
      const parts = (ov.disks || []).map(d => ({
        key: 'part-' + d.mount, name: d.mount,
        badge: { text: d.percent >= 90 ? '空间紧张' : '正常', level: d.percent >= 90 ? 'bad' : 'ok' },
        cells: {
          name: d.mount,
          used: fmtBytes(d.used),
          total: fmtBytes(d.total),
          percent: d.percent + "%",
          note: d.percent >= 90 ? "空间紧张" : "正常",
        },
        bad: d.percent >= 90,
        keyText: d.percent + '%',
        meta: fmtBytes(d.used) + ' / ' + fmtBytes(d.total) + ' 已用',
        sub: d.fs,
        state: d.percent >= 90 ? 'warn' : 'on',
        args: {}, actions: [],
      }));
      return parts.concat(DISK_TARGETS.map(t => ({
        key: t.key, name: t.name,
        cells: { name: t.name, used: "—", total: "—", percent: "—", note: t.meta },
        badge: { text: t.kind === 'info' ? '查看' : '可清理', level: 'off' },
        bad: false, keyText: '', meta: t.meta, sub: '',
        state: 'on',
        args: t.args || {},
        actions: [{
          label: t.kind === 'info' ? '查看' : '清理',
          action: t.action, danger: !!t.danger,
          kind: t.kind || null,
          probe: t.probe || null,
          primary: true,
        }],
      })));
    }

    return [];
  }

  // buildOpsPanel 渲染时把行数据留在这里，供增量补丁使用（同一份数据不重算）
  let lastOpsRows = [];
  // 资源摘要条的状态（百分比/配色/文案），同样供增量补丁更新
  let lastMeters = [];

  function buildOpsPanel(ov) {
    const rawRows = opsRows(ov);

    // 列表状态（2026-10-28）：每个分类各自记住搜索词、排序、只看异常
    const st = listState[opsCat] || (listState[opsCat] = { q: '', sort: '', onlyBad: false });

    // ① 过滤：只看异常 + 搜索
    let rows = rawRows;
    if (st.onlyBad) rows = rows.filter(r => r.bad);
    if (st.q) {
      const terms = st.q.toLowerCase().split(/\s+/).filter(Boolean);
      rows = rows.filter(r => {
        const hay = (r.name + ' ' + (r.meta || '') + ' ' + (r.sub || '') + ' ' + (r.keyText || '')).toLowerCase();
        return terms.every(t => hay.includes(t));
      });
    }

    // ② 排序：默认「异常优先 + 名称」，其余按分类给有意义的选择
    const sorters = {
      name: (a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true }),
      cpu: (a, b) => (b.cpuNum || 0) - (a.cpuNum || 0),
      mem: (a, b) => (b.memNum || 0) - (a.memNum || 0),
      status: (a, b) => (a.bad === b.bad ? 0 : a.bad ? -1 : 1),
    };
    const sortKey = st.sort || defaultSort(opsCat);
    rows = [...rows].sort(sorters[sortKey] || sorters.name);
    // 异常永远置顶（不论选了什么排序）——有问题的必须先被看到
    rows.sort((a, b) => (a.bad === b.bad ? 0 : a.bad ? -1 : 1));
    const counts = {
      docker: (ov.docker || []).length,
      svc: (ov.services || []).length,
      proc: (ov.procs || []).length,
      port: (ov.listen || []).length,
      disk: DISK_TARGETS.length,
      du: (ov.du || []).length,
      sys: 4,
    };
    // 分类（2026-10-28）：原来右侧那些「只能看」的卡片并进来，
    // 系统信息 / 监听端口 / 主目录都成了分类，一处看全、一处操作。
    const seg = [['docker', 'Docker'], ['svc', '服务'], ['proc', '进程'],
      ['port', '端口'], ['disk', '磁盘'], ['du', '目录'], ['sys', '系统']].map(([id, label]) =>
      '<button class="remote-ops-seg' + (opsCat === id ? ' active' : '') + '" data-ops-cat="' + id + '">'
      + label + '<em>' + counts[id] + '</em></button>').join('');

    // 工具行（2026-10-28）：搜索 / 只看异常 / 排序 / 计数
    const opts = sortOptions(opsCat);
    const toolbar = '<div class="remote-ops-tools">'
      + '<input class="remote-ops-search" type="search" placeholder="搜索名称 / 镜像 / 命令行 / 端口…"'
      + ' value="' + esc(st.q) + '" data-ops-search="' + esc(opsCat) + '" aria-label="搜索">'
      + '<label class="remote-ops-onlybad"><input type="checkbox" data-ops-onlybad="' + esc(opsCat) + '"'
      + (st.onlyBad ? ' checked' : '') + '> 只看异常</label>'
      + '<select class="remote-ops-sort" data-ops-sort="' + esc(opsCat) + '" aria-label="排序">'
      + opts.map(([v, label]) => '<option value="' + esc(v) + '"'
        + (sortKey === v ? ' selected' : '') + '>' + esc(label) + '</option>').join('')
      + '</select>'
      + '<span class="remote-ops-count">' + (rows.length === rawRows.length
        ? '共 ' + rawRows.length
        : '筛出 ' + rows.length + ' / 共 ' + rawRows.length) + '</span>'
      + '</div>';

    // 每行带自己的动作表（按对象状态生成），不再用全局 OPS_SPEC
    // 表格渲染（2026-10-28 用户要求）：
    // 用 <table> 而不是卡片式行，每个字段一列、顶部有表头，
    // 宽度由 colgroup 控制，数值列右对齐便于纵向比较。
    const cols = tableColumns(opsCat);
    const cellValue = (r, id) => {
      const cells = r.cells || {};
      return cells[id] === undefined || cells[id] === '' ? '—' : String(cells[id]);
    };

    const head = cols.length
      ? '<div class="remote-ops-thead" role="row">'
        + cols.map(c => {
          const sortable = c.sortable;
          const active = sortKey === (c.id === 'name' ? 'name' : c.id);
          return '<span class="remote-ops-th' + (c.sortable ? ' is-sortable' : '')
            + (active ? ' is-active' : '') + '"'
            + ' style="' + (c.align ? 'text-align:' + c.align + ';' : '')
            + 'flex:' + (c.id === 'name' ? '1 1 auto' : '0 0 ' + c.width) + '"'
            + (sortable ? ' data-ops-sortcol="' + esc(opsCat) + ':' + esc(c.id) + '"' : '')
            + '>' + esc(c.label) + (active ? ' ▾' : '') + '</span>';
        }).join('')
        + '<span class="remote-ops-th remote-ops-th-acts">操作</span>'
        + '</div>'
      : '';

    const body = rows.length ? rows.map(r => {
      const btn = (o) =>
        '<button class="remote-ops-act' + (o.danger ? ' danger' : '') + '"'
        + ' data-ops-run="' + esc(o.action) + '"'
        + ' data-ops-key="' + esc(r.key) + '"'
        + ' data-ops-args="' + esc(JSON.stringify(r.args)) + '"'
        + ' data-ops-name="' + esc(r.name) + '"'
        + (o.danger ? ' data-ops-danger="1"' : '')
        + (o.kind ? ' data-ops-kind="' + o.kind + '"' : '')
        + (o.probe ? ' data-ops-probe="' + esc(o.probe) + '"' : '')
        + '>' + o.label + '</button>';
      const all = r.actions || [];
      const primary = all.filter(o => o.primary).length
        ? all.filter(o => o.primary)
        : all.slice(0, 1);
      const rest = all.filter(o => !primary.includes(o));
      const acts = primary.map(btn).join('')
        + (rest.length
          ? '<button class="remote-ops-act remote-ops-more" data-ops-more="' + esc(r.key) + '"'
            + ' title="更多操作" aria-haspopup="true">⋯</button>'
            + '<div class="remote-ops-menu hidden" data-ops-menu="' + esc(r.key) + '">'
            + rest.map(btn).join('') + '</div>'
          : '');

      // 名称列带状态点和徽标；状态列单独着色
      // 名称列只放「状态点 + 名称」：徽标已经在独立的状态列里，
      // 两处都显示就是「健康 ... 健康」的重复（2026-10-28 截图发现）
      const nameCell = '<span class="remote-ops-td remote-ops-td-name" style="flex:1 1 auto">'
        + '<i class="remote-ops-dot ' + r.state + '"></i>'
        + '<span class="remote-ops-name" title="' + esc(r.name) + '">' + esc(r.name) + '</span>'
        + '</span>';

      const otherCells = cols.filter(c => c.id !== 'name').map(c => {
        const v = cellValue(r, c.id);
        const cls = 'remote-ops-td' + (c.align === 'right' ? ' is-num' : '')
          + (c.id === 'status' && r.badge ? ' is-status' : '')
          + (c.id === 'args' ? ' is-mono' : '');
        const level = c.id === 'status' && r.badge ? ' data-level="' + (r.badge.level || 'off') + '"' : '';
        return '<span class="' + cls + '" style="'
          + (c.align ? 'text-align:' + c.align + ';' : '')
          + 'flex:0 0 ' + c.width + '"' + level
          + ' title="' + esc(v) + '">' + esc(v) + '</span>';
      }).join('');

      return '<div class="remote-ops-row' + (r.bad ? ' is-bad' : '') + '" role="row">'
        + nameCell + otherCells
        + '<span class="remote-ops-td remote-ops-td-acts"><div class="remote-ops-acts">' + acts + '</div></span>'
        + '</div>';
    }).join('') : '<div class="remote-empty">这一类没有可显示的对象。</div>';

    lastOpsRows = rows;
    return '<div class="remote-ops">'
      + '<div class="remote-ops-segs">' + seg + '</div>'
      + toolbar
      + head
      + '<div class="remote-ops-list" id="remote-ops-list">' + body + '</div>'
      + '<div class="remote-ops-foot" id="remote-ops-state"></div>'
      + '</div>';
  }

  /**
   * 执行一个运维动作（2026-10-28）。
   *
   * 流程：只读动作直接跑；写动作先弹确认框（写清对象、影响、当前状态），
   * 确认后调 remote.op，结果以「退出码 + 状态回读」呈现。
   *
   * 为什么不复用 runInTerminal：终端拿不到退出码，也没法把结果结构化显示，
   * 无法判断操作到底成没成 —— 那正是这次要解决的问题。
   */
  async function runOpsAction(btn) {
    const action = btn.dataset.opsRun;
    const name = btn.dataset.opsName;
    const kind = btn.dataset.opsKind;
    let args = {};
    try { args = JSON.parse(btn.dataset.opsArgs || '{}'); } catch {}

    // 是否弹确认，按「动作是不是只读」判断，而不是看按钮有没有 danger 标记。
    // 2026-10-28 修：原来只对 danger 按钮弹确认，结果「重启」这种写操作直接执行了 ——
    // 危险标记只用来标红，不能当权限判据。用户明确要求「全部操作都要确认」。
    // 确认放在「连接检查」之前：先让用户看清要做什么，再判断能不能做，
    // 否则断开连接时点重启会直接提示"请先连接"，用户不知道刚才点的是什么操作。
    const readOnly = kind === 'logs' || kind === 'info';
    if (!connected()) { MI.toast('请先连接服务器', 'err'); return; }
    if (!readOnly) {
      // 清理类操作先探测「能释放多少」，把数字写进确认框 ——
      // 用户需要知道自己在删什么、删掉能腾出多少空间，而不是盲点确认。
      let probeText = '';
      const probe = btn.dataset.opsProbe;
      if (probe) {
        try {
          // 同 runOpsAction：call() 已解包，直接读内层字段
          const pr = await call('op', sid, probe, args);
          if (pr) {
            const raw = String(pr.stdout || pr.stderr || '').trim();
            const first = raw.split(String.fromCharCode(10)).filter(Boolean)[0] || '';
            if (first) probeText = first.slice(0, 120);
          }
        } catch { /* 探测失败不影响确认流程 */ }
      }
      // 重启/停止前先看最近错误：让用户知道「为什么要重启、重启前发生了什么」。
      // 只在 Docker/systemd 的写操作上做，且失败不影响确认流程。
      let recentError = '';
      if (/^(docker|systemd)\.(restart|stop|start)$/.test(action)) {
        try {
          const logAction = action.startsWith('docker') ? 'docker.logs' : 'systemd.logs';
          const logArgs = action.startsWith('docker')
            ? { name, tail: 40 } : { unit: name, tail: 40 };
          const logRes = await call('op', sid, logAction, logArgs);
          const errorLines = String(logRes.stdout || '').split(String.fromCharCode(10))
            .filter(l => /(ERROR|ERR|FATAL|Exception|Traceback|failed)/i.test(l))
            .slice(-3);
          if (errorLines.length) recentError = errorLines.map(l => l.trim().slice(0, 120)).join(String.fromCharCode(10));
        } catch { /* 取不到就留空，不阻断确认 */ }
      }
      const ok = await confirmOps(action, name, args, probeText, recentError);
      if (!ok) return;
    }
    setOpsState('正在执行：' + action + ' ' + name + '…');
    btn.disabled = true;
    try {
      // call() 已经把 {ok,data} 解包过，返回的就是内层结果（含 stdout/code/state）。
      // 原来这里又取了一次 res.data，拿到 undefined → 结果全变空，
      // 界面显示「（无输出）」（2026-10-28 真实点击自检发现）。
      const data = await call('op', sid, action, args);
      if (kind === 'logs' || kind === 'info') {
        // 只读结果：弹只读查看层，不写终端
        showOpsOutput(action, name, data);
        setOpsState('');
      } else {
        // 写操作：退出码 + 状态回读
        const code = data.code === null ? '—' : data.code;
        const st = data.state?.text ? '　·　回读：' + data.state.text : '';
        const good = data.ok;
        setOpsState((good ? '已执行 ' : '执行失败 ') + action + ' ' + name
          + '　·　退出码 ' + code + st, good ? 'ok' : 'err');
        MI.toast(good ? '已执行：' + action + ' ' + name : '执行失败：' + (data.stderr || action), good ? 'ok' : 'err');
        // 写操作后刷新概览（拿到真实新状态），不靠猜。
        // ⚠ 但刷新会重建整个概览 DOM，把刚写好的回执冲掉 —— 用户根本看不到
        // 「退出码 0 / 回读 running」这两句（2026-10-28 真实点击自检发现）。
        // 所以先记下回执文本，刷新后重新写回同一个位置。
        const receipt = document.getElementById('remote-ops-state')?.textContent || '';
        const receiptKind = good ? 'ok' : 'err';
        await loadOverview({ silent: true });
        setOpsState(receipt, receiptKind);
      }
    } catch (error) {
      setOpsState('执行失败：' + ((error && error.message) || error), 'err');
      MI.toast('执行失败：' + ((error && error.message) || error), 'err');
    } finally {
      btn.disabled = false;
    }
  }

  function setOpsState(text, kind) {
    const el = document.getElementById('remote-ops-state');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'remote-ops-foot' + (kind ? ' ' + kind : '');
  }

  /** 写操作确认框：对象、影响、当前状态三件事必须写清。 */
  function confirmOps(action, name, args, probeText, recentError) {
    const info = {
      'docker.restart': { title: '重启容器', impact: '服务中断约 3–10 秒，正在处理的请求会失败。' },
      'docker.stop': { title: '停止容器', impact: '停止后该服务不可用，直到手动启动。' },
      'docker.start': { title: '启动容器', impact: '容器将开始运行，可能占用内存与端口。' },
      'docker.remove': { title: '删除容器', impact: '容器将被移除且不可恢复（仅限已停止的容器）。' },
      'systemd.restart': { title: '重启服务', impact: '服务中断数秒，依赖它的功能会一并受影响。' },
      'systemd.stop': { title: '停止服务', impact: '停止后不会自动恢复，需手动启动。' },
      'systemd.start': { title: '启动服务', impact: '服务将开始运行。' },
      'systemd.reload': { title: '重载配置', impact: '仅重读配置，通常不中断连接（取决于服务实现）。' },
      'proc.kill': { title: '结束进程', impact: '进程会被终止；若由系统服务管理会自动重启，建议改用「停止服务」。' },
      'disk.cleanApt': { title: '清理 APT 缓存', impact: '删除已下载的安装包缓存，不影响已安装的软件。' },
      'disk.vacuumJournal': { title: '清理 systemd 日志', impact: '只保留最近 200MB 日志，更早的会被删除。' },
      'docker.pruneImages': { title: '清理悬空镜像', impact: '删除未被任何容器引用的镜像层，不可恢复。' },
    }[action] || { title: '确认操作', impact: '' };

    const cur = (overviewLast?.docker || []).find(c => c.name === name)?.status
      || (overviewLast?.services || []).find(s => s.unit === name)?.sub || '—';

    return new Promise(resolve => {
      const box = document.createElement('div');
      box.className = 'remote-ops-dlg-mask';
      box.innerHTML = '<div class="remote-ops-dlg">'
        + '<h3>' + esc(info.title) + '：' + esc(name) + '</h3>'
        + '<div class="remote-ops-dlg-body">'
        + (info.impact ? '<p class="impact">影响：' + esc(info.impact) + '</p>' : '')
        + (probeText ? '<p class="cur">预计可释放：' + esc(probeText) + '</p>' : '')
        + (recentError ? '<p class="cur" style="margin-top:.5em">最近错误：</p><pre class="remote-ops-pre" style="font-size:.85em;color:#f0b8b6;max-height:5.5em;overflow:auto">'
          + esc(recentError) + '</pre>' : '')
        + '<p class="cur">当前状态：' + esc(cur) + '</p>'
        + '</div>'
        + '<div class="remote-ops-dlg-foot">'
        + '<button class="tb-btn" data-dlg="0">取消</button>'
        + '<button class="tb-btn ' + (info.title.includes('停止') || info.title.includes('删除') || info.title.includes('结束') ? 'remote-ops-danger' : 'm-ok') + '" data-dlg="1">' + esc(info.title) + '</button>'
        + '</div></div>';
      const close = ok => { box.remove(); document.removeEventListener('keydown', onKey); resolve(ok); };
      const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); close(false); } };
      box.addEventListener('click', e => {
        const b = e.target.closest('[data-dlg]');
        if (b) return close(b.dataset.dlg === '1');
        if (e.target === box) close(false);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(box);
    });
  }

  /** 只读结果查看层（日志/详情）：不写终端，便于复制。 */
  /**
   * 日志 / 只读结果查看层（2026-10-28 重做成抽屉）。
   *
   * 之前是居中弹窗塞一段纯文本 —— 等于把终端输出搬进弹窗，没有行号、没有级别着色、
   * 不能筛、不能跟，200 行里找一个 ERROR 得靠眼睛扫。
   *
   * 现在：右侧抽屉 + 行号 + 级别着色 + 级别筛选 + 关键字过滤 + 增量跟随。
   * 跟随用「短连接增量轮询」而不是常驻 docker logs -f：
   * 后者会长期占用 SSH 通道，断线恢复也复杂；轮询用 --since 续读，行为可预期。
   */
  function showOpsOutput(action, name, data) {
    const isLog = action === 'docker.logs' || action === 'systemd.logs';
    const raw = String(data.stdout || data.stderr || '');
    const box = document.createElement('div');
    box.className = 'remote-drawer-mask';
    box.innerHTML = '<div class="remote-drawer">'
      + '<header class="remote-drawer-head">'
      + '<span class="remote-drawer-title">' + esc(name) + ' · ' + (isLog ? '日志' : '输出') + '</span>'
      + (isLog ? '<label class="remote-drawer-follow"><input type="checkbox" data-drw="follow"> 跟随</label>' : '')
      + (isLog ? '<select class="remote-drawer-level" data-drw="level" aria-label="级别">'
        + '<option value="">全部级别</option><option value="ERROR">只看错误</option>'
        + '<option value="WARN">警告以上</option><option value="INFO">信息以上</option></select>' : '')
      + '<input class="remote-drawer-search" type="search" placeholder="过滤…" data-drw="q">'
      + '<span class="remote-drawer-count" data-drw="count"></span>'
      + '<button class="tb-btn" data-drw="copy">复制</button>'
      + '<button class="tb-btn" data-drw="term">在终端打开</button>'
      + '<button class="tb-btn" data-drw="close">关闭</button>'
      + '</header>'
      + '<div class="remote-drawer-body"><div class="remote-drawer-lines" data-drw="lines"></div></div>'
      + '</div>';

    // 原始行（保留供筛选）；追加时只往这里 push
    const lines = raw.split('\n').map(l => l.replace(/\r$/, ''));
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

    /** 级别识别：ERROR / WARN / INFO / DEBUG / TRACE，大小写无关；识别不到归 other */
    const levelOf = line => {
      const m = /\b(ERROR|ERR|FATAL|WARN|WARNING|INFO|DEBUG|TRACE)\b/i.exec(line);
      if (!m) return '';
      const v = m[1].toUpperCase();
      return v === 'WARN' || v === 'WARNING' ? 'WARN'
        : v === 'ERR' || v === 'FATAL' ? 'ERROR' : v;
    };
    const LEVEL_ORDER = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };

    const body = box.querySelector('[data-drw="lines"]');
    const countEl = box.querySelector('[data-drw="count"]');

    /** 按当前筛选条件重绘（跟随追加时也走这里，保证视图一致） */
    const paint = () => {
      const level = box.querySelector('[data-drw="level"]')?.value || '';
      const q = (box.querySelector('[data-drw="q"]')?.value || '').toLowerCase();
      const maxLevel = level ? LEVEL_ORDER[level] : null;
      const shown = [];
      lines.forEach((line, idx) => {
        const lv = levelOf(line);
        if (maxLevel !== null) {
          // 「只看错误」= 只要 ERROR；「警告以上」= ERROR+WARN；依此类推
          if (!lv || LEVEL_ORDER[lv] === undefined || LEVEL_ORDER[lv] > maxLevel) return;
        }
        if (q && !line.toLowerCase().includes(q)) return;
        shown.push({ line, idx, lv });
      });
      body.innerHTML = shown.length
        ? shown.map(it => '<div class="remote-drawer-line" data-level="' + (it.lv ? it.lv.toLowerCase() : '') + '">'
          + '<span class="remote-drawer-no">' + (it.idx + 1) + '</span>'
          + '<span class="remote-drawer-txt">' + esc(it.line) + '</span></div>').join('')
        : '<div class="remote-empty">没有匹配的行。</div>';
      countEl.textContent = shown.length === lines.length
        ? lines.length + ' 行'
        : shown.length + ' / ' + lines.length + ' 行';
      // 跟随：保持在底部
      if (box.querySelector('[data-drw="follow"]')?.checked) {
        const wrap = box.querySelector('.remote-drawer-body');
        if (wrap) wrap.scrollTop = wrap.scrollHeight;
      }
    };

    const close = () => {
      stopFollow();
      box.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); close(); } };

    // ── 跟随：每 2 秒拉一次增量（用 --since 时间戳续读，不重复不丢） ──
    let followTimer = null;
    let lastCount = lines.length;
    const stopFollow = () => { if (followTimer) { clearInterval(followTimer); followTimer = null; } };
    const startFollow = () => {
      stopFollow();
      followTimer = setInterval(async () => {
        if (!document.body.contains(box)) { stopFollow(); return; }
        if (!connected()) { stopFollow(); return; }
        try {
          // 只取最近 50 行做增量比较：.log 的 --since 需要时间戳，
          // 这里用「重新拉尾部 + 按已有行数截取」更稳（不依赖服务端时钟精度）
          // 参数名按对象类型区分：docker 用 name，systemd 用 unit
          const followArgs = action.startsWith('systemd')
            ? { unit: name, tail: Math.min(2000, lastCount + 100) }
            : { name, tail: Math.min(2000, lastCount + 100) };
          const r = await call('op', sid, action, followArgs);
          const next = String(r.stdout || '').split('\n').map(l => l.replace(/\r$/, ''));
          while (next.length && !next[next.length - 1].trim()) next.pop();
          if (next.length > lines.length) {
            // 只追加新增的部分
            for (let k = lines.length; k < next.length; k++) lines.push(next[k]);
            lastCount = lines.length;
            paint();
          }
        } catch { /* 跟随失败静默重试，不打断阅读 */ }
      }, 2000);
    };

    box.querySelector('[data-drw="follow"]')?.addEventListener('change', e => {
      if (e.target.checked) startFollow(); else stopFollow();
    });
    box.querySelector('[data-drw="level"]')?.addEventListener('change', paint);
    box.querySelector('[data-drw="q"]')?.addEventListener('input', paint);
    box.querySelector('[data-drw="copy"]').addEventListener('click', () => {
      // 复制的是「当前筛选后的内容」，不是全量 —— 用户看到什么就复制什么
      const text = [...body.querySelectorAll('.remote-drawer-txt')].map(e => e.textContent).join('\n');
      void window.myIDE.clip.copy(text);
      MI.toast('已复制 ' + (text ? text.split('\n').length + ' 行' : '空内容'), 'ok');
    });
    box.querySelector('[data-drw="term"]').addEventListener('click', () => {
      close();
      runInTerminal(action.startsWith('systemd')
        ? 'journalctl -u ' + shellQuote(name) + ' -f --no-pager'
        : 'docker logs -f --tail 200 ' + shellQuote(name), '日志 ' + name);
    });
    box.querySelector('[data-drw="close"]').addEventListener('click', close);
    box.addEventListener('click', e => { if (e.target === box) close(); });
    document.addEventListener('keydown', onKey);

    document.body.appendChild(box);
    paint();
    if (data.truncated) {
      lines.push('', '（输出已截断，只显示前 512KB）');
      paint();
    }
  }


  function bindOverviewClicks(host) {
    if (host.__ovBound) return;
    host.__ovBound = true;
    host.addEventListener('click', event => {
      // 运维台：分类切换
      const cat = event.target.closest('[data-ops-cat]');
      if (cat) {
        opsCat = cat.dataset.opsCat;
        if (overviewLast) renderOverview(overviewLast);
        return;
      }

      // 运维台：排序下拉（change 事件不走 click，这里兜底）
      // 只看异常
      const onlyBad = event.target.closest('[data-ops-onlybad]');
      if (onlyBad && event.target.type === 'checkbox') {
        const k = onlyBad.dataset.opsOnlybad;
        listState[k] = listState[k] || { q: '', sort: '', onlyBad: false };
        listState[k].onlyBad = event.target.checked;
        if (overviewLast) renderOverview(overviewLast);
        return;
      }
      // 运维台：表头点击排序（2026-10-28 表格化后，列头就是排序入口）
      const th = event.target.closest('[data-ops-sortcol]');
      if (th) {
        const [cat, colId] = th.dataset.opsSortcol.split(':');
        const st = listState[cat] || (listState[cat] = { q: '', sort: '', onlyBad: false });
        // 映射列到排序键；点同一列再点一次切回默认
        const map = { name: 'name', cpu: 'cpu', mem: 'mem', rss: 'mem', size: 'mem',
          percent: 'mem', port: 'name', restarts: 'mem' };
        const key = map[colId] || 'name';
        st.sort = st.sort === key ? '' : key;
        if (cat === opsCat && overviewLast) renderOverview(overviewLast);
        return;
      }

      // 运维台：「更多」展开次要操作
      const more = event.target.closest('[data-ops-more]');
      if (more) {
        event.stopPropagation();
        const key = more.dataset.opsMore;
        const menu = host.querySelector('[data-ops-menu="' + CSS.escape(key) + '"]');
        // 先关掉其它已展开的，保证同时只有一个菜单
        host.querySelectorAll('[data-ops-menu]').forEach(m => { if (m !== menu) m.classList.add('hidden'); });
        if (menu) menu.classList.toggle('hidden');
        return;
      }
      // 点菜单外任意处收起
      if (!event.target.closest('[data-ops-menu]')) {
        host.querySelectorAll('[data-ops-menu]').forEach(m => m.classList.add('hidden'));
      }

      // 运维台：动作按钮
      const act = event.target.closest('[data-ops-run]');
      if (act) { void runOpsAction(act); return; }

      const row = event.target.closest('[data-ov-browse],[data-ov-port],[data-ov-unit]');
      if (!row) return;
      if (row.hasAttribute('data-ov-browse')) {
        // 跳文件面板并进入该目录（最实用的一条）。
        const dir = row.dataset.ovBrowse;
        mode = 'files'; renderMode();
        void browse('remote', dir).catch(error => MI.toast('打开目录失败：' + error.message, 'err'));
        return;
      }
      if (row.hasAttribute('data-ov-docker')) {
        runInTerminal('docker logs -f --tail 200 ' + shellQuote(row.dataset.ovDocker), '查看容器日志 ' + row.dataset.ovDocker);
        return;
      }
      if (row.hasAttribute('data-ov-port')) {
        const pid = row.dataset.ovPid;
        const cmd = pid ? 'ps -o pid,ppid,user,%cpu,%mem,etime,args -p ' + pid
                        : 'ss -tulpn | grep -w ' + row.dataset.ovPort;
        runInTerminal(cmd, '查看 ' + row.dataset.ovPort + ' 端口占用');
        return;
      }
      if (row.hasAttribute('data-ov-unit')) {
        runInTerminal('systemctl status ' + shellQuote(row.dataset.ovUnit) + ' --no-pager -l | head -n 40',
          '查看服务 ' + row.dataset.ovUnit);
      }
    });
    // 工具行事件（2026-10-28）：搜索输入、排序切换、只看异常
    host.addEventListener('input', event => {
      const box = event.target.closest('[data-ops-search]');
      if (!box) return;
      const k = box.dataset.opsSearch;
      listState[k] = listState[k] || { q: '', sort: '', onlyBad: false };
      listState[k].q = box.value;
      // 重渲染会丢焦点，所以记下当前的输入位置，渲染后恢复
      const pos = box.selectionStart;
      if (overviewLast) renderOverview(overviewLast);
      const again = host.querySelector('[data-ops-search]');
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch {} }
    });
    host.addEventListener('change', event => {
      const sel = event.target.closest('[data-ops-sort]');
      if (!sel) return;
      const k = sel.dataset.opsSort;
      listState[k] = listState[k] || { q: '', sort: '', onlyBad: false };
      listState[k].sort = sel.value;
      if (overviewLast) renderOverview(overviewLast);
    });

    // 右键：给 Docker 容器更细的操作（重启/停止）。
    host.addEventListener('contextmenu', event => {
      const row = event.target.closest('[data-ov-docker]');
      if (!row) return;
      event.preventDefault(); event.stopPropagation();
      const name = row.dataset.ovDocker;
      const menu = document.getElementById('ctx-menu');
      menu.className = 'tool-strip-menu'; menu.replaceChildren(); delete menu.dataset.toolOwner;
      const add = (label, fn) => {
        const b = document.createElement('button');
        b.className = 'ctx-item'; b.type = 'button'; b.textContent = label;
        b.onclick = ev => { ev.stopPropagation(); menu.classList.add('hidden'); fn(); };
        menu.append(b);
      };
      const head = document.createElement('div');
      head.className = 'tool-menu-heading'; head.textContent = name;
      menu.append(head);
      add('📜 查看日志（持续）', () => runInTerminal('docker logs -f --tail 200 ' + shellQuote(name), '日志 ' + name));
      add('📄 最近 200 行日志', () => runInTerminal('docker logs --tail 200 ' + shellQuote(name), '日志 ' + name));
      add('🔄 重启容器', () => runInTerminal('docker restart ' + shellQuote(name), '重启 ' + name));
      add('⏹ 停止容器', () => runInTerminal('docker stop ' + shellQuote(name), '停止 ' + name));
      add('ℹ 详细信息', () => runInTerminal('docker inspect --format "{{json .State}}" ' + shellQuote(name) + ' | head -c 2000', '容器信息 ' + name));
      menu.classList.remove('hidden');
      const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 160;
      menu.style.left = Math.max(8, Math.min(event.clientX, innerWidth - mw - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(event.clientY, innerHeight - mh - 8)) + 'px';
      const close = ev => { if (!menu.contains(ev.target)) { menu.classList.add('hidden'); document.removeEventListener('pointerdown', close, true); } };
      document.addEventListener('pointerdown', close, true);
    });
  }

  // 在终端里投递一条命令。复用已有终端（用户能看输出、能 Ctrl+C 中断），
  // 不另造命令执行通道 —— 这样也符合「远程操作必须可见」这个原则。
  const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
  async function runInTerminal(command, label) {
    if (!connected()) { MI.toast('请先连接服务器', 'err'); return; }
    try {
      mode = 'terminal'; renderMode();
      // 复用当前活动终端；没有就新建一个。
      if (!activeTerm || terminals.get(activeTerm)?.closed) await newTerminal();
      const t = terminals.get(activeTerm);
      if (!t) throw Error('没有可用终端');
      // 新起一行再发，避免和用户正在输入的命令粘在一起。
      await call('input', t.sid, t.id, '\r' + command + '\r');
      MI.toast('已在终端执行：' + (label || command), 'ok');
      t.term?.focus?.();
    } catch (error) {
      MI.toast('执行失败：' + ((error && error.message) || error), 'err');
    }
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
  // 交互状态探测（2026-10-28）：用户正在操作列表时不要抢刷新。
  // 采用「降频」而不是「暂停」——暂停会让用户以为数据不更新了（方案 §7.2 定为降频）。
  function overviewBusy() {
    const host = document.getElementById('remote-overview');
    if (!host) return false;
    // 有菜单打开、搜索框聚焦、鼠标悬停在列表上、或正在执行写操作
    if (host.querySelector('[data-ops-menu]:not(.hidden)')) return true;
    const ae = document.activeElement;
    if (ae && host.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return true;
    if (host.matches(':hover')) return true;
    if (document.querySelector('.remote-drawer, .remote-ops-dlg')) return true;
    return false;
  }
  let overviewTick = 0;
  function startOverviewTimer() {
    stopOverviewTimer();
    // 5 秒一档；交互中降到 20 秒一档（每 4 跳只刷 1 次）
    overviewTimer = setInterval(() => {
      if (!(mode === 'overview' && visible && connected() && !Modal.stack.length)) return;
      overviewTick++;
      if (overviewBusy()) {
        if (overviewTick % 4 !== 0) return;   // 降频：20 秒一次
      }
      void loadOverview({ silent: true });
    }, 5000);
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
  // openRemoteEditor / closeRemoteEditor 也暴露出来：弹框要能端到端驱动
  // （真实 SSH → 真实 fs 路由 → 回读服务器文件校验），否则只能分段验证。
  /**
   * 仅自检/预览用：返回完整概览的 HTML 字符串，不碰全局状态、不发请求。
   *
   * 为什么需要它：真实渲染要连服务器，而 loadOverview 是异步的，
   * 截图/预览时会被「空结果」覆盖（我为此踩过两次，截出来的都是白板）。
   * 这里把 renderOverview 塞进一个游离容器跑一遍，取出 innerHTML，
   * 于是渲染结果与异步刷新彻底解耦。
   */
  function __renderOverviewHtml(ov, cat) {
    const real = document.getElementById('remote-overview');
    // 面板里已有 #remote-overview 时，getElementById 只会返回它，
    // 所以临时把它的内容清空、跑一遍渲染、取走 HTML、再恢复原状。
    // 这样既不改全局状态，也不会污染用户正在看的页面。
    if (cat) opsCat = cat;
    if (real) {
      const backup = real.innerHTML;
      const wasHidden = real.classList.contains('hidden');
      try {
        renderOverview(ov || null);
        return real.innerHTML;
      } finally {
        real.innerHTML = backup;
        real.classList.toggle('hidden', wasHidden);
      }
    }
    // 面板尚未初始化（自检早期）：临时挂一个同名容器
    const probe = document.createElement('div');
    probe.id = 'remote-overview';
    probe.style.display = 'none';
    document.body.appendChild(probe);
    try {
      renderOverview(ov || null);
      return probe.innerHTML;
    } finally {
      probe.remove();
    }
  }

  return { init, syncVisible, refresh, showTerminal, getPageContext, renderOverview, loadOverview, openRemoteEditor, closeRemoteEditor,
    __renderOverviewHtml,
    // 仅自检用：单独打开日志抽屉，验证着色/筛选/行号，不依赖真实连接
    __testOutput: (action, name, data) => showOpsOutput(action, name, data) };
})();

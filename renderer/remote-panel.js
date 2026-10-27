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
  const fmtDuration = seconds => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
    if (d) return d + ' 天 ' + h + ' 小时';
    if (h) return h + ' 小时 ' + m + ' 分';
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

  function renderOverview(ov) {
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
    const monitor = card('资源监控',
      '<div class="remote-ov-bigs">'
      + bigMeter('CPU', cpuPercent, cpuPercent + '%',
        (cpu.cores || '?') + ' 核 · 负载 ' + (cpu.load?.length ? cpu.load.map(n => n.toFixed(2)).join('  ') : '—'))
      + bigMeter('内存', memPercent, fmtBytes(memory.used) + ' / ' + fmtBytes(memory.total),
        '可用 ' + fmtBytes(memory.available) + (memory.swapTotal
          ? ' · 交换 ' + fmtBytes(memory.swapUsed || 0) + ' / ' + fmtBytes(memory.swapTotal) : ''))
      + bigMeter('磁盘', diskPercent, fmtBytes(diskUsed) + ' / ' + fmtBytes(diskTotal), disks.length + ' 个分区')
      + '</div>'
      + '<div class="remote-ov-net"><span>入站 <strong>' + fmtRate(rxRate) + '</strong></span>'
      + '<span>出站 <strong>' + fmtRate(txRate) + '</strong></span>'
      + '<span>运行 <strong>' + fmtDuration(uptime) + '</strong></span>'
      + '<span>' + esc(kernel.serverTime ? new Date(kernel.serverTime * 1000).toLocaleString() : '—') + '</span></div>',
      'span-2');

    // ── 右上：系统信息（不参与点击）──
    const sys = card('系统信息',
      '<dl class="remote-ov-kv">'
      + '<div><dt>发行版</dt><dd>' + esc(os.name || '—') + '</dd></div>'
      + '<div><dt>内核</dt><dd>' + esc(kernel.release || '—') + '</dd></div>'
      + '<div><dt>架构</dt><dd>' + esc(kernel.arch || '—') + '</dd></div>'
      + '<div><dt>主机名</dt><dd>' + esc(kernel.hostname || '—') + '</dd></div>'
      + '</dl>');

    // ── 右：磁盘分区（点 = 文件面板进入该挂载点）──
    const diskCard = disks.length ? card('磁盘分区 <small>' + disks.length + '</small>',
      '<div class="remote-ov-list">' + disks.map(d =>
        row('data-ov-browse="' + esc(d.mount) + '" data-ov-title="打开 ' + esc(d.mount) + '"',
          esc(d.mount), fmtBytes(d.used) + ' / ' + fmtBytes(d.total) + ' <b data-level="' + level(d.percent) + '">' + d.percent + '%</b>',
          { title: d.fs + ' → ' + d.mount })).join('')
      + '</div>') : '';

    // ── 右：Docker（点 = 看日志；右键 = 更多）──
    const dockerCard = docker.length ? card('Docker 容器 <small>' + docker.length + '</small>',
      '<div class="remote-ov-list scroll">' + docker.map(c =>
        row('data-ov-docker="' + esc(c.name) + '" data-ov-title="查看 ' + esc(c.name) + ' 的日志"',
          esc(c.name), esc(c.status), { title: c.image + '\\n' + c.status })).join('')
      + '</div>') : '';

    // ── 右：监听端口（点 = 查进程）──
    const portCard = listen.length ? card('监听端口 <small>' + listen.length + '</small>',
      '<div class="remote-ov-list scroll">' + listen.map(p =>
        row('data-ov-port="' + p.port + '" data-ov-pid="' + (p.pid || '') + '" data-ov-title="查看 ' + p.port + ' 端口的进程"',
          '<b>' + p.port + '</b> <small>' + p.proto + '</small>',
          esc(p.process || p.address), { title: p.address + ':' + p.port + (p.process ? ' · ' + p.process : '') })).join('')
      + '</div>') : '';

    // ── 右：服务（点 = systemctl status）──
    const serviceCard = services.length ? card('运行中的服务 <small>' + services.length + '</small>',
      '<div class="remote-ov-list scroll">' + services.map(s =>
        row('data-ov-unit="' + esc(s.unit) + '" data-ov-title="查看 ' + esc(s.unit) + ' 的状态"',
          esc(s.unit), '<span class="remote-ov-tag">' + esc(s.sub || s.active) + '</span>',
          { title: s.description || s.unit, rightClass: 'remote-ov-row-pct' })).join('')
      + '</div>') : '';

    // ── 右：主目录占用（点 = 文件面板进入该目录）──
    const duCard = du.length ? card('主目录占用', '<div class="remote-ov-list">' + du.map(d =>
      row('data-ov-browse="' + esc(d.path) + '" data-ov-title="打开 ' + esc(d.path) + '"',
        esc(d.path), fmtBytes(d.bytes), { title: d.path })).join('')
      + '</div>') : '';

    host.innerHTML = '<div class="remote-ov-grid">' + monitor + sys + diskCard
      + dockerCard + portCard + serviceCard + duCard + '</div>';
    bindOverviewClicks(host);
  }

  // 点击/右键绑定。用事件委托，重绘后不需要重新绑定。
  function bindOverviewClicks(host) {
    if (host.__ovBound) return;
    host.__ovBound = true;
    host.addEventListener('click', event => {
      const row = event.target.closest('[data-ov-browse],[data-ov-docker],[data-ov-port],[data-ov-unit]');
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
  // openRemoteEditor / closeRemoteEditor 也暴露出来：弹框要能端到端驱动
  // （真实 SSH → 真实 fs 路由 → 回读服务器文件校验），否则只能分段验证。
  return { init, syncVisible, refresh, showTerminal, getPageContext, renderOverview, loadOverview, openRemoteEditor, closeRemoteEditor };
})();

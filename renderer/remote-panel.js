window.RemotePanel = (() => {
  const q = id => document.getElementById(id), api = () => window.myIDE.remote;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icons = { folder: '<svg class="ic" viewBox="0 0 16 16"><path d="M2 4h4l1.5 2H14v7H2z"/></svg>', file: '<svg class="ic" viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4zM9 2v3h3"/></svg>', server: '<svg class="ic" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="5" rx="1"/><rect x="2" y="9" width="12" height="5" rx="1"/><path d="M4.5 4.5h.5M4.5 11.5h.5M8 4.5h3M8 11.5h3"/></svg>', up: '<svg class="ic" viewBox="0 0 16 16"><path d="M8 13V3M4 7l4-4 4 4"/></svg>', upload: '<svg class="ic" viewBox="0 0 16 16"><path d="M8 11V2M4 6l4-4 4 4M3 10v4h10v-4"/></svg>', download: '<svg class="ic" viewBox="0 0 16 16"><path d="M8 2v9M4 7l4 4 4-4M3 10v4h10v-4"/></svg>', computer: '<svg class="ic" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="9" rx="1"/><path d="M5 14h6M8 11v3"/></svg>' };
  const labels = { connecting: '连接中', connected: '已连接', disconnected: '已断开', queued: '等待传输', running: '传输中', completed: '已完成', cancelled: '已取消', failed: '失败' };
  let profiles = [], version = '', selected = null, sid = null, activeTerm = null, visible = false, initialized = false, mode = 'terminal', connecting = false, loading = 0;
  const sessions = new Map(), terminals = new Map(), jobs = new Map();
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
  function fit(t) { if (!visible || mode !== 'terminal' || activeTerm !== t.id || !t.container.clientWidth) return; try { t.fit.fit(); if (!t.closed) void call('resize', t.sid, t.id, t.term.cols, t.term.rows).catch(() => {}); } catch {} }
  function terminalTheme() {
    const css = getComputedStyle(q('remote-main'));
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
    for (const t of terminals.values()) { t.term.options.theme = terminalTheme(); t.term.options.fontSize = terminalFontSize(); fit(t); }
  }
  async function newTerminal() {
    if (!connected()) return; if (!window.Terminal || !window.FitAddon) throw Error('终端组件未加载，请检查依赖');
    const id = crypto.randomUUID(), container = document.createElement('div'); container.className = 'remote-terminal'; q('remote-terminal-panes').append(container);
    const term = new Terminal({ fontSize: terminalFontSize(), fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace', lineHeight: 1.45, fontWeight: '400', scrollback: 3000, cursorBlink: true, allowProposedApi: false, theme: terminalTheme() });
    const fitter = new FitAddon.FitAddon(); term.loadAddon(fitter); term.open(container);
    const t = { id, sid, term, fit: fitter, container, name: current().name, closed: false, opened: false }; terminals.set(id, t); selectTerminal(id); fit(t);
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
    try { await call('openTerminal', t.sid, id, term.cols, term.rows); t.opened = true; fit(t); if (visible && mode === 'terminal' && activeTerm === id && !Modal.stack.length) term.focus(); }
    catch (error) { t.closed = true; term.writeln('\r\n连接终端失败：' + error.message); renderTerminals(); throw error; }
  }
  function renderTerminals() {
    q('remote-terminal-tabs').innerHTML = [...terminals.values()].map((t, i) => `<span class="remote-terminal-tab${activeTerm === t.id ? ' active' : ''}"><button data-term="${esc(t.id)}">${esc(t.name)} · ${i + 1}${t.closed ? '（已关闭）' : ''}</button><button data-close-term="${esc(t.id)}" title="关闭终端" aria-label="关闭终端">×</button></span>`).join('');
    q('remote-terminal-empty').hidden = !!activeTerm; for (const t of terminals.values()) t.container.classList.toggle('hidden', t.id !== activeTerm);
  }
  function selectTerminal(id) { activeTerm = id; const t = terminals.get(id); if (t) { const changed = sid !== t.sid; sid = t.sid; selected = sessions.get(sid)?.profileId || selected; renderSessions(); if (changed) { panes.remote.serial++; panes.remote.entries = []; panes.remote.selected.clear(); panes.remote.path = current()?.home || ''; renderPane('remote'); if (connected()) void browse('remote', panes.remote.path).catch(error => notify(error.message, true)); } } mode = 'terminal'; renderMode(); renderTerminals(); if (t) requestAnimationFrame(() => fit(t)); }
  function renderMode() { q('remote-files').classList.toggle('hidden', mode !== 'files'); q('remote-terminal-area').classList.toggle('hidden', mode !== 'terminal'); for (const tab of ['terminal', 'files']) q('remote-tab-' + tab).classList.toggle('active', mode === tab); }
  function displaySize(value) { return value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : value + ' B'; }
  function renderPane(side) {
    const pane = panes[side], root = q('remote-' + side + '-pane'); if (!root) return;
    root.querySelector('input').value = pane.path;
    const entries = [...pane.entries].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    root.querySelector('.remote-file-list').innerHTML = entries.length ? entries.map(e => `<button class="remote-file${pane.selected.has(e.path) ? ' selected' : ''}" data-path="${esc(e.path)}" draggable="true" title="${esc(e.path)}"><span>${icons[e.directory ? 'folder' : 'file']}</span><span class="remote-file-name">${esc(e.name)}${e.link ? ' ↗' : ''}</span><small>${e.directory ? '目录' : displaySize(e.size)}</small></button>`).join('') : '<div class="remote-empty">' + (side === 'remote' && !connected() ? '连接服务器后浏览远程文件。' : '此目录没有文件。') + '</div>';
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
      root.querySelector('form').onsubmit = attempt(async event => { event.preventDefault(); await browse(side, root.querySelector('input').value); });
      root.onclick = attempt(async event => {
        const row = event.target.closest('[data-path]');
        if (row) { if (!event.ctrlKey && !event.metaKey) pane.selected.clear(); if (pane.selected.has(row.dataset.path)) pane.selected.delete(row.dataset.path); else pane.selected.add(row.dataset.path); for (const r of root.querySelectorAll('[data-path]')) r.classList.toggle('selected', pane.selected.has(r.dataset.path)); root.querySelector('.remote-file-status').textContent = pane.entries.length + ' 项 · 已选 ' + pane.selected.size + ' 项'; return; }
        const action = event.target.closest('[data-action]')?.dataset.action; if (!action) return;
        if (action === 'up' || action === 'refresh') return browse(side, action === 'up' ? parent(side, pane.path) : pane.path);
        if (action === 'upload' || action === 'download') return enqueue(action, [...pane.selected]);
        if (action === 'mkdir') { const name = await Modal.prompt('新建目录', '目录名称', ''); if (!name) return; if (/[\\/\0\r\n]/.test(name) || name === '.' || name === '..') throw Error('请输入目录名称，不能包含路径分隔符'); if (side === 'local') await call('localMkdir', joined(side, pane.path, name)); else await call('mkdir', sid, joined(side, pane.path, name)); }
        if (action === 'rename') { if (pane.selected.size !== 1) throw Error('请选择一个项目'); const target = [...pane.selected][0], name = await Modal.prompt('重命名', '新名称', pane.entries.find(e => e.path === target)?.name); if (!name) return; if (side === 'local') await call('localRename', target, name); else await call('rename', sid, target, name); }
        if (action === 'remove') { if (!pane.selected.size) throw Error('请选择要删除的项目'); const paths = [...pane.selected]; if (!await Modal.confirm('删除文件', esc(paths.join('\n')) + '\n\n删除不可撤销；目录仅允许删除空目录。')) return; for (const target of paths) { if (side === 'local') await call('localRemove', target); else await call('removeFile', sid, target); } }
        await browse(side, pane.path);
      });
      root.ondblclick = attempt(async event => { const row = event.target.closest('[data-path]'), entry = row && pane.entries.find(e => e.path === row.dataset.path); if (entry?.directory && !entry.link) await browse(side, entry.path); });
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
    q('remote-disconnect').onclick = attempt(async () => { await call('disconnect', sid); notify('已断开SSH连接。'); controls(); });
    q('remote-new-terminal').onclick = attempt(newTerminal);
    q('remote-profiles').onclick = attempt(async event => { const id = event.target.closest('[data-profile]')?.dataset.profile; if (!id) return; selected = id; const found = [...sessions.values()].find(s => s.profileId === id && s.state === 'connected'); await activateSession(found?.id || null); });
    q('remote-sessions').onchange = attempt(event => activateSession(event.target.value));
    q('remote-terminal-tabs').onclick = attempt(async event => { const close = event.target.closest('[data-close-term]')?.dataset.closeTerm; if (close) { const t = terminals.get(close); if (!t) return; if (!t.closed && !await Modal.confirm('关闭终端', '关闭会结束这个SSH终端；终端前台任务可能随之结束。')) return; await call('closeTerminal', t.sid, t.id); t.term.dispose(); t.container.remove(); terminals.delete(close); if (activeTerm === close) { activeTerm = [...terminals.keys()].at(-1) || null; if (activeTerm) selectTerminal(activeTerm); } renderTerminals(); } else { const id = event.target.closest('[data-term]')?.dataset.term; if (id) selectTerminal(id); } });
    for (const tab of ['terminal', 'files']) q('remote-tab-' + tab).onclick = () => { mode = tab; renderMode(); if (terminals.get(activeTerm)) fit(terminals.get(activeTerm)); };
    q('remote-transfer-jobs').onclick = attempt(async event => { const cancel = event.target.closest('[data-cancel-job]')?.dataset.cancelJob, retry = event.target.closest('[data-retry-job]')?.dataset.retryJob; const button = event.target.closest('button'); if (button) button.disabled = true; try { if (cancel) { const result = await call('cancel', cancel); if (result?.reason) notify(result.reason); } if (retry) await call('retry', retry, sid); } finally { if (button?.isConnected) button.disabled = false; } });
    q('remote-clear-transfers').onclick = attempt(async event => { event.preventDefault(); const result = await call('clearFinished'); jobs.clear(); result.forEach(j => jobs.set(j.id, j)); renderJobs(); });
    // 主题和自定义调色都更新 body；xterm 的 Canvas 配色也必须同步。
    const appearance = new MutationObserver(syncTerminalAppearance);
    appearance.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    if (window.ResizeObserver) new ResizeObserver(() => { const t = terminals.get(activeTerm); if (t) fit(t); }).observe(q('remote-terminal-panes'));
    void refresh().catch(error => notify(error.message, true)); void browse('local', '').catch(error => notify(error.message, true));
    void call('snapshot').then(value => { value.sessions.forEach(s => sessions.set(s.id, s)); value.jobs.forEach(j => jobs.set(j.id, j)); renderSessions(); renderJobs(); }).catch(error => notify(error.message, true));
  }
  function syncVisible(value) { visible = value; if (value) { const t = terminals.get(activeTerm); if (t) requestAnimationFrame(() => fit(t)); } }
  return { init, syncVisible, refresh };
})();

// db-panel.js —— 数据库工具窗口（MySQL / SQLite：连接管理 / 表浏览 / 增删改查 / 分页 / SQL）
// 结构与 browser-panel 一致：#content 内全宽覆盖层，Ctrl+5 或工具条按钮开关。
// 连接配置持久化在 localStorage（myide-db-conns）——本地单机工具，密码随配置存本机。
window.DbPanel = (() => {
  const B = () => window.myIDE && window.myIDE.db;
  let panel = null, visible = false;

  // ---------- 状态 ----------
  let conns = [];        // 已保存的连接配置 [{name,type,host,port,user,password,database,file}]
  let connId = null;     // 当前活动连接（主进程句柄 id）
  let connCfg = null;    // 当前活动连接的配置
  let curTable = null;   // 当前表
  let curCols = [];      // 当前表列 [{name,pk,...}]
  let curPk = [];        // 主键列名（sqlite 无主键时为 ['__rid']）
  let page = 1, pageSize = 50, total = 0;
  let selRows = new Set(); // 选中的行索引（本页内）
  let tab = 'data';      // data | sql
  let sqlText = '';

  const LS_KEY = 'myide-db-conns';
  function loadConns() {
    try { conns = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { conns = []; }
  }
  function saveConns() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(conns)); } catch {}
  }

  // ---------- IPC 快捷封装 ----------
  async function call(fn, ...args) {
    const b = B();
    if (!b) { MI.toast('数据库服务不可用', 'err'); return null; }
    const r = await b[fn](...args);
    if (!r || !r.ok) { MI.toast('数据库错误：' + ((r && r.error) || '未知'), 'err'); return null; }
    return r.data;
  }

  // ---------- 开关 ----------
  function show() {
    if (visible) return;
    visible = true;
    panel.classList.remove('hidden');
    document.getElementById('tool-db').classList.add('active');
    if (!connId) renderConnBar();
  }
  function hide() {
    if (!visible) return;
    visible = false;
    panel.classList.add('hidden');
    document.getElementById('tool-db').classList.remove('active');
  }
  function toggle() { visible ? hide() : show(); }

  // ---------- 工具条（连接选择 / 状态） ----------
  function renderConnBar() {
    const sel = document.getElementById('db-conn-select');
    sel.innerHTML = '';
    conns.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = (connId !== null && c === connCfg ? '● ' : '') + connLabel(c);
      sel.appendChild(o);
    });
    const o = document.createElement('option');
    o.value = 'new';
    o.textContent = '＋ 新建连接…';
    sel.appendChild(o);
    const st = document.getElementById('db-status');
    if (connId) {
      st.textContent = '已连接：' + connLabel(connCfg);
      st.className = 'db-st db-st-on';
    } else {
      st.textContent = conns.length ? '未连接' : '尚无保存的连接';
      st.className = 'db-st';
    }
    const btn = document.getElementById('db-connect-btn');
    btn.textContent = connId ? '断开' : '连接';
  }
  function connLabel(c) {
    return c.type === 'sqlite' ? (c.name || c.file) : (c.name || (c.user + '@' + c.host));
  }

  // ---------- 连接表单（新建 / 编辑） ----------
  function connForm(idx) {
    const c = idx >= 0 ? { ...conns[idx] } : { type: 'sqlite', name: '', host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '', file: '' };
    const box = document.createElement('div');
    box.className = 'db-conn-form';
    box.innerHTML = `
      <div class="m-head">${idx >= 0 ? '编辑连接' : '新建连接'} <span class="x" id="dbf-x">✕</span></div>
      <div class="m-body">
        <label class="m-label">类型</label>
        <select id="dbf-type">
          <option value="sqlite">SQLite（本地文件）</option>
          <option value="mysql">MySQL</option>
        </select>
        <label class="m-label">名称（可选）</label>
        <input id="dbf-name" type="text" placeholder="如：本地笔记库">
        <div id="dbf-sqlite">
          <label class="m-label">数据库文件路径</label>
          <div class="dbf-row">
            <input id="dbf-file" type="text" placeholder="D:\\data\\notes.db">
            <button class="tb-btn" id="dbf-pick" title="浏览…">📂</button>
          </div>
        </div>
        <div id="dbf-mysql" class="hidden">
          <label class="m-label">主机</label><input id="dbf-host" type="text">
          <label class="m-label">端口</label><input id="dbf-port" type="number">
          <label class="m-label">用户</label><input id="dbf-user" type="text">
          <label class="m-label">密码</label><input id="dbf-pass" type="password">
          <label class="m-label">数据库</label><input id="dbf-db" type="text">
        </div>
      </div>
      <div class="m-foot">
        <button class="tb-btn m-cancel" id="dbf-cancel">取消</button>
        <button class="tb-btn m-ok" id="dbf-save">保存并连接</button>
      </div>`;
    Modal.show(box);
    const $ = (s) => box.querySelector(s);
    $('#dbf-type').value = c.type;
    const syncType = () => {
      const t = $('#dbf-type').value;
      $('#dbf-sqlite').classList.toggle('hidden', t !== 'sqlite');
      $('#dbf-mysql').classList.toggle('hidden', t !== 'mysql');
    };
    $('#dbf-type').onchange = syncType;
    syncType();
    $('#dbf-name').value = c.name || '';
    $('#dbf-file').value = c.file || '';
    $('#dbf-host').value = c.host || '';
    $('#dbf-port').value = c.port || 3306;
    $('#dbf-user').value = c.user || '';
    $('#dbf-pass').value = c.password || '';
    $('#dbf-db').value = c.database || '';
    $('#dbf-pick').onclick = async () => {
      const r = await window.myIDE.fs.pickFile('选择 SQLite 数据库文件',
        [{ name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }, { name: '所有文件', extensions: ['*'] }]);
      if (r) $('#dbf-file').value = r;
    };
    const done = () => Modal.hide();
    $('#dbf-cancel').onclick = done;
    $('#dbf-x').onclick = done;
    $('#dbf-save').onclick = async () => {
      const cfg = {
        type: $('#dbf-type').value,
        name: $('#dbf-name').value.trim(),
        file: $('#dbf-file').value.trim(),
        host: $('#dbf-host').value.trim(),
        port: Number($('#dbf-port').value) || 3306,
        user: $('#dbf-user').value.trim(),
        password: $('#dbf-pass').value,
        database: $('#dbf-db').value.trim(),
      };
      if (cfg.type === 'sqlite' && !cfg.file) { MI.toast('请填写 SQLite 文件路径', 'err'); return; }
      if (cfg.type === 'mysql' && !cfg.database) { MI.toast('请填写数据库名', 'err'); return; }
      if (!cfg.name) cfg.name = cfg.type === 'sqlite' ? pathBase(cfg.file) : (cfg.user + '@' + cfg.host + '/' + cfg.database);
      // 保存
      if (idx >= 0) conns[idx] = cfg; else conns.push(cfg);
      saveConns();
      done();
      await doConnect(cfg);
    };
  }

  function pathBase(p) {
    return String(p || '').split(/[\\/]/).pop() || 'SQLite';
  }

  // ---------- 连接 / 断开 ----------
  async function doConnect(cfg) {
    MI.toast('正在连接 ' + connLabel(cfg) + '…', 'ok');
    const r = await call('connect', cfg);
    if (!r) return;
    connId = r.id;
    connCfg = cfg;
    page = 1; curTable = null; selRows.clear();
    renderConnBar();
    renderTables();
    MI.toast('已连接 ' + connLabel(cfg) + (r.serverInfo ? '（' + r.serverInfo + '）' : ''), 'ok');
  }

  async function doDisconnect() {
    if (connId) await call('close', connId);
    connId = null; connCfg = null; curTable = null;
    document.getElementById('db-tables').innerHTML = '<div class="db-hint">断开连接后此处显示表列表</div>';
    document.getElementById('db-data').innerHTML = '<div class="db-hint">选择左侧表查看数据</div>';
    renderConnBar();
  }

  // ---------- 表列表 ----------
  async function renderTables() {
    if (!connId) return;
    const el = document.getElementById('db-tables');
    el.innerHTML = '<div class="db-hint">加载表…</div>';
    const list = await call('tables', connId);
    if (!list) { el.innerHTML = '<div class="db-hint db-err">表列表加载失败</div>'; return; }
    el.innerHTML = '';
    if (!list.length) { el.innerHTML = '<div class="db-hint">数据库中没有表</div>'; return; }
    list.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'db-table-item' + (t.name === curTable ? ' active' : '');
      row.textContent = t.name;
      row.title = t.name + (t.approx != null ? '（约 ' + t.approx + ' 行）' : '');
      row.onclick = () => openTable(t.name);
      el.appendChild(row);
    });
  }

  // ---------- 打开表（数据页） ----------
  async function openTable(name) {
    curTable = name;
    page = 1;
    selRows.clear();
    switchTab('data');
    renderTables(); // 高亮
    await loadData();
  }

  async function loadData() {
    if (!connId || !curTable) return;
    const el = document.getElementById('db-data');
    el.innerHTML = '<div class="db-hint">加载中…</div>';
    const r = await call('select', connId, curTable, page, pageSize);
    if (!r) { el.innerHTML = '<div class="db-hint db-err">数据加载失败</div>'; return; }
    curCols = (r.columns || []).filter((c) => c !== '__rid').map((c) => ({ name: c }));
    curPk = r.pk || [];
    total = Number(r.total) || 0;
    renderGrid(r);
  }

  function renderGrid(r) {
    const el = document.getElementById('db-data');
    el.innerHTML = '';
    // 表头信息 + 行操作
    const head = document.createElement('div');
    head.className = 'db-grid-bar';
    head.innerHTML = `
      <span class="db-grid-title">${curTable}</span>
      <span class="db-grid-sub">${total} 行 · 主键：${curPk.filter((k) => k !== '__rid').join(', ') || '（无，按 rowid 定位）'}</span>
      <span class="spacer"></span>
      <button class="vt-btn" id="db-add-row" title="插入一行（表单填写）">＋ 行</button>
      <button class="vt-btn" id="db-del-row" title="删除勾选的行">－ 行</button>
      <button class="vt-btn" id="db-refresh" title="刷新当前页">🔄</button>`;
    el.appendChild(head);

    // 网格
    const wrap = document.createElement('div');
    wrap.className = 'db-grid-wrap';
    if (!r.rows.length) {
      wrap.innerHTML = '<div class="db-hint">表中没有数据（点「＋ 行」插入）</div>';
    } else {
      const table = document.createElement('table');
      table.className = 'db-grid';
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      hr.innerHTML = '<th class="db-cb">✓</th>';
      (r.columns || []).forEach((c) => {
        const th = document.createElement('th');
        th.textContent = c;
        if (curPk.includes(c)) th.classList.add('db-pk');
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      r.rows.forEach((row, ri) => {
        const tr = document.createElement('tr');
        tr.dataset.ri = ri;
        if (selRows.has(ri)) tr.classList.add('sel');
        const td = document.createElement('td');
        td.className = 'db-cb';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selRows.has(ri);
        cb.onclick = (e) => {
          e.stopPropagation();
          cb.checked ? selRows.add(ri) : selRows.delete(ri);
          tr.classList.toggle('sel', cb.checked);
        };
        td.appendChild(cb);
        tr.appendChild(td);
        (r.columns || []).forEach((c) => {
          const t = document.createElement('td');
          const v = row[c];
          t.textContent = v === null || v === undefined ? 'NULL' : String(v);
          if (v === null || v === undefined) t.classList.add('db-null');
          if (c !== '__rid') {
            t.ondblclick = () => editCell(t, row, c);
          }
          tr.appendChild(t);
        });
        tr.onclick = () => { // 单击整行切换勾选（简单直觉），双击单元格仍可编辑
          const on = !selRows.has(ri);
          on ? selRows.add(ri) : selRows.delete(ri);
          tr.classList.toggle('sel', on);
          tr.querySelector('.db-cb input').checked = on;
        };
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }
    el.appendChild(wrap);

    // 分页
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const bar = document.createElement('div');
    bar.className = 'db-pager';
    bar.innerHTML = `
      <button class="vt-btn" id="db-pg-first" title="首页">⏮</button>
      <button class="vt-btn" id="db-pg-prev" title="上一页">‹</button>
      <span class="db-pg-info"><input id="db-pg-num" type="number" min="1" max="${pages}" value="${page}"> / ${pages}</span>
      <button class="vt-btn" id="db-pg-next" title="下一页">›</button>
      <button class="vt-btn" id="db-pg-last" title="末页">⏭</button>
      <select id="db-pg-size" title="每页行数">
        ${[20, 50, 100, 200].map((n) => `<option value="${n}" ${n === pageSize ? 'selected' : ''}>${n} 行/页</option>`).join('')}
      </select>
      <span class="db-pg-total">共 ${total} 行</span>`;
    el.appendChild(bar);

    // 事件
    const go = (p) => { page = Math.min(Math.max(1, p), pages); selRows.clear(); loadData(); };
    bar.querySelector('#db-pg-first').onclick = () => go(1);
    bar.querySelector('#db-pg-prev').onclick = () => go(page - 1);
    bar.querySelector('#db-pg-next').onclick = () => go(page + 1);
    bar.querySelector('#db-pg-last').onclick = () => go(pages);
    bar.querySelector('#db-pg-num').onkeydown = (e) => { if (e.key === 'Enter') go(Number(e.target.value) || 1); };
    bar.querySelector('#db-pg-size').onchange = (e) => { pageSize = Number(e.target.value); page = 1; loadData(); };
    head.querySelector('#db-refresh').onclick = () => loadData();
    head.querySelector('#db-del-row').onclick = deleteSelected;
    head.querySelector('#db-add-row').onclick = insertRowForm;
  }

  // ---------- 单元格编辑（双击 → input，Enter 提交 / Esc 取消） ----------
  function editCell(td, row, col) {
    if (td.querySelector('input')) return;
    const old = row[col];
    const input = document.createElement('input');
    input.type = 'text';
    input.value = old === null || old === undefined ? '' : String(old);
    input.className = 'db-cell-edit';
    td.textContent = '';
    td.appendChild(input);
    input.focus();
    input.select();
    const cancel = () => { td.textContent = old === null || old === undefined ? 'NULL' : String(old); if (old == null) td.classList.add('db-null'); };
    const commit = async () => {
      let val = input.value;
      if (val === 'NULL') val = null;
      // 主键值数组（定位行）
      const pkVals = curPk.map((k) => (k === '__rid' ? row.__rid : row[k]));
      const r = await call('updateCell', connId, curTable, curPk, pkVals, col, val);
      if (!r) { cancel(); return; }
      MI.toast('已更新 ' + curTable + '.' + col, 'ok');
      loadData();
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    input.onblur = cancel; // 失焦不提交（防误触丢数据，明确 Enter 才提交）
  }

  // ---------- 删除选中行 ----------
  async function deleteSelected() {
    if (!selRows.size) { MI.toast('先勾选要删除的行', 'err'); return; }
    const ok = await Modal.confirm('删除行', '确定删除选中的 ' + selRows.size + ' 行？\n此操作不可撤销。');
    if (!ok) return;
    // 重新取当前页数据拿主键值（渲染时只存了行内容；重查一次最可靠）
    const r = await call('select', connId, curTable, page, pageSize);
    if (!r) return;
    const pkRows = [...selRows].map((ri) => curPk.map((k) => (k === '__rid' ? r.rows[ri].__rid : r.rows[ri][k])));
    const res = await call('deleteRows', connId, curTable, curPk, pkRows);
    if (!res) return;
    MI.toast('已删除 ' + res.affected + ' 行', 'ok');
    selRows.clear();
    loadData();
  }

  // ---------- 插入行（表单） ----------
  function insertRowForm() {
    if (!curTable) return;
    const cols = curCols.map((c) => c.name);
    const box = document.createElement('div');
    box.innerHTML = `
      <div class="m-head">插入行 → ${curTable} <span class="x" id="dbi-x">✕</span></div>
      <div class="m-body">
        <div class="db-insert-hint">留空的字段插入 NULL（自增主键可留空）</div>
        ${cols.map((c) => `
          <label class="m-label">${c}${curPk.includes(c) ? ' 🔑' : ''}</label>
          <input type="text" data-col="${c}" placeholder="">`).join('')}
      </div>
      <div class="m-foot">
        <button class="tb-btn m-cancel" id="dbi-cancel">取消</button>
        <button class="tb-btn m-ok" id="dbi-ok">插入</button>
      </div>`;
    Modal.show(box);
    const done = () => Modal.hide();
    box.querySelector('#dbi-cancel').onclick = done;
    box.querySelector('#dbi-x').onclick = done;
    box.querySelector('#dbi-ok').onclick = async () => {
      const inputs = [...box.querySelectorAll('input[data-col]')];
      const cols2 = [], vals = [];
      inputs.forEach((i) => {
        if (i.value !== '') { cols2.push(i.dataset.col); vals.push(i.value); }
      });
      if (!cols2.length) { MI.toast('至少填写一个字段', 'err'); return; }
      const r = await call('insertRow', connId, curTable, cols2, vals);
      if (!r) return;
      MI.toast('已插入 1 行', 'ok');
      done();
      loadData();
    };
    setTimeout(() => { const f = box.querySelector('input[data-col]'); if (f) f.focus(); }, 50);
  }

  // ---------- SQL 标签页 ----------
  function renderSql() {
    const el = document.getElementById('db-sql');
    el.innerHTML = `
      <div class="db-sql-bar">
        <span class="db-sql-hint">Ctrl+Enter 运行 · 选中片段仅执行选中部分</span>
        <span class="spacer"></span>
        <button class="vt-btn" id="db-sql-run" title="运行 SQL (Ctrl+Enter)">▶ 运行</button>
        <button class="vt-btn" id="db-sql-clear" title="清空">✕</button>
      </div>
      <textarea id="db-sql-input" placeholder="SELECT * FROM ..." spellcheck="false">${escapeHtml(sqlText)}</textarea>
      <div id="db-sql-result" class="db-grid-wrap"><div class="db-hint">运行 SQL 后结果在此显示</div></div>`;
    const ta = el.querySelector('#db-sql-input');
    ta.addEventListener('input', () => { sqlText = ta.value; });
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); }
    });
    el.querySelector('#db-sql-run').onclick = runSql;
    el.querySelector('#db-sql-clear').onclick = () => { ta.value = ''; sqlText = ''; };
  }

  async function runSql() {
    if (!connId) { MI.toast('先连接数据库', 'err'); return; }
    const ta = document.getElementById('db-sql-input');
    const sql = (ta.value.slice(ta.selectionStart, ta.selectionEnd).trim() || ta.value.trim());
    if (!sql) { MI.toast('SQL 为空', 'err'); return; }
    const out = document.getElementById('db-sql-result');
    out.innerHTML = '<div class="db-hint">执行中…</div>';
    const r = await call('query', connId, sql, []);
    if (!r) { out.innerHTML = '<div class="db-hint db-err">执行失败</div>'; return; }
    if (r.ok === 'write') {
      out.innerHTML = '<div class="db-hint">✅ 执行成功' + (r.affected != null ? '（影响 ' + r.affected + ' 行' + (r.insertId ? '，ID=' + r.insertId : '') + '）' : '') + '</div>';
      return;
    }
    // SELECT 结果表格
    out.innerHTML = '';
    if (!r.rows.length) { out.innerHTML = '<div class="db-hint">✅ 无结果行</div>'; return; }
    const table = document.createElement('table');
    table.className = 'db-grid';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    r.columns.forEach((c) => { const th = document.createElement('th'); th.textContent = c; hr.appendChild(th); });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    r.rows.slice(0, 1000).forEach((row) => {
      const tr = document.createElement('tr');
      r.columns.forEach((c) => {
        const td = document.createElement('td');
        const v = row[c];
        td.textContent = v === null || v === undefined ? 'NULL' : String(v);
        if (v == null) td.classList.add('db-null');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    out.appendChild(table);
    if (r.rows.length > 1000) {
      const more = document.createElement('div');
      more.className = 'db-hint';
      more.textContent = '（仅显示前 1000 行，共 ' + r.rows.length + ' 行）';
      out.appendChild(more);
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------- 标签切换 ----------
  function switchTab(t) {
    tab = t;
    document.getElementById('db-tab-data').classList.toggle('active', t === 'data');
    document.getElementById('db-tab-sql').classList.toggle('active', t === 'sql');
    document.getElementById('db-data-wrap').classList.toggle('hidden', t !== 'data');
    document.getElementById('db-sql').classList.toggle('hidden', t !== 'sql');
    if (t === 'sql' && !document.getElementById('db-sql-input')) renderSql();
  }

  // ---------- 初始化 ----------
  function init() {
    panel = document.getElementById('db-panel');
    loadConns();

    document.getElementById('db-close').onclick = hide;
    document.getElementById('db-connect-btn').onclick = () => {
      if (connId) { doDisconnect(); return; }
      const sel = document.getElementById('db-conn-select');
      if (sel.value === 'new') { connForm(-1); return; }
      const c = conns[Number(sel.value)];
      if (c) doConnect(c);
      else if (!conns.length) connForm(-1);
    };
    document.getElementById('db-conn-edit').onclick = () => {
      const sel = document.getElementById('db-conn-select');
      if (sel.value === 'new') { connForm(-1); return; }
      const i = Number(sel.value);
      if (conns[i]) connForm(i); else MI.toast('先选择一个连接', 'err');
    };
    document.getElementById('db-conn-del').onclick = async () => {
      const sel = document.getElementById('db-conn-select');
      if (sel.value === 'new') { MI.toast('没有选中要删除的连接', 'err'); return; }
      const i = Number(sel.value);
      if (!conns[i]) return;
      const ok = await Modal.confirm('删除连接', '删除已保存的连接「' + connLabel(conns[i]) + '」？\n（不影响数据库本身）');
      if (!ok) return;
      if (connCfg === conns[i]) doDisconnect();
      conns.splice(i, 1);
      saveConns();
      renderConnBar();
    };
    document.getElementById('db-conn-select').onchange = (e) => {
      if (e.target.value === 'new') connForm(-1);
    };
    document.getElementById('db-tables-refresh').onclick = () => { if (connId) renderTables(); };
    document.getElementById('db-tab-data').onclick = () => switchTab('data');
    document.getElementById('db-tab-sql').onclick = () => switchTab('sql');

    renderConnBar();
    renderSql(); // 预建（保证 Ctrl+Enter 绑定就绪）
    switchTab('data');
  }

  return { init, toggle, show, hide, isOpen: () => visible };
})();
window.DbPanel = DbPanel;

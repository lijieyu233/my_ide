// db-panel.js —— 数据库工具窗口（MySQL / SQLite：连接管理 / 表浏览 / 增删改查 / 分页 / SQL）
// 布局：左侧栏 #panel-db（连接管理 + 表列表），右侧 #db-panel（数据表格 / SQL，Ctrl+5）。
// 可见性由 App 工具切换驱动（TOOLS 含 'db'），侧栏与右侧双区同步显隐。
// 连接配置持久化在 localStorage（myide-db-conns）——本地单机工具，密码随配置存本机。
window.DbPanel = (() => {
  const B = () => window.myIDE && window.myIDE.db;
  let visible = false;

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
  // 可见性由 App 工具切换驱动（switchTool/renderToolStrip）：侧栏 #panel-db 与右侧 #db-panel 同步显隐
  function syncVisible(v) {
    if (visible === v) return;
    visible = v;
    if (v && !connId) renderConnBar();
  }
  function toggle() { App.switchTool('db'); }

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
    schema = { tables: [], cols: {} }; // SQL 补全缓存随连接重置
    renderConnBar();
    renderTables();
    MI.toast('已连接 ' + connLabel(cfg) + (r.serverInfo ? '（' + r.serverInfo + '）' : ''), 'ok');
  }

  async function doDisconnect() {
    if (connId) await call('close', connId);
    connId = null; connCfg = null; curTable = null;
    schema = { tables: [], cols: {} };
    document.getElementById('db-tables').innerHTML = '<div class="db-hint">断开连接后此处显示表列表</div>';
    document.getElementById('db-data').innerHTML = '<div class="db-hint">选择左侧表查看数据</div>';
    document.getElementById('db-ddl').innerHTML = '<div class="db-hint">选择左侧表查看结构</div>';
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
      <button class="vt-btn" id="db-import-csv" title="从 CSV 文件导入数据（首行须为表头）">📥 导入</button>
      <button class="vt-btn" id="db-export-csv" title="导出当前表全部数据为 CSV（Excel 直开）">📤 CSV</button>
      <button class="vt-btn" id="db-export-json" title="导出为 JSON 数组文件">📤 JSON</button>
      <button class="vt-btn" id="db-export-sql" title="导出为 SQL INSERT 语句（可重放）">📤 SQL</button>
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
    head.querySelector('#db-export-csv').onclick = () => exportCsv('csv');
    head.querySelector('#db-export-json').onclick = () => exportCsv('json');
    head.querySelector('#db-export-sql').onclick = () => exportCsv('sql');
    head.querySelector('#db-import-csv').onclick = () => importCsv();
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

  // ---------- SQL 编辑器（CM6：表名/列名自动补全，Ctrl+Enter 运行） ----------
  // Schema 缓存：连接后载表名；列名按表懒加载（补全首次触达某表时才查）
  let schema = { tables: [], cols: {} };
  let sqlCm = null; // CM 编辑器实例（不可用时回退 textarea）
  const SQL_KW = ['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'DROP', 'ALTER', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'UNION', 'ALL', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'INDEX', 'VIEW', 'EXISTS', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'];

  async function ensureSchemaTables() {
    if (!connId || schema.tables.length) return;
    const list = await call('tables', connId);
    if (list) schema.tables = list.map((t) => t.name);
  }
  async function ensureCols(table) {
    if (!connId || schema.cols[table]) return;
    const r = await call('columns', connId, table);
    schema.cols[table] = (r || []).map((c) => c.name);
  }

  // 补全源：FROM/JOIN/INTO 后补表名；tbl. 后补列名；默认关键词+表名+文中已出现表的列
  async function sqlComplete(ctx) {
    await ensureSchemaTables();
    const word = ctx.matchBefore(/[\w.]+/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    const text = word.text;
    const dot = text.lastIndexOf('.');
    const before = ctx.state.doc.sliceString(0, word.from).toUpperCase();
    if (dot >= 0) { // 前缀是表名 → 补列
      const t = text.slice(0, dot).replace(/"/g, '');
      await ensureCols(t);
      return { from: word.from + dot + 1, options: (schema.cols[t] || []).map((c) => ({ label: c, type: 'property' })) };
    }
    if (/\b(FROM|JOIN|INTO|TABLE|UPDATE)\s+$/i.test(before)) {
      return { from: word.from, options: schema.tables.map((t) => ({ label: t, type: 'type' })) };
    }
    const options = SQL_KW.map((k) => ({ label: k, type: 'keyword' }))
      .concat(schema.tables.map((t) => ({ label: t, type: 'type' })));
    const docText = ctx.state.doc.toString();
    for (const t of schema.tables) {
      if (new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(docText)) {
        await ensureCols(t);
        for (const c of schema.cols[t] || []) options.push({ label: c, type: 'property' });
      }
    }
    return { from: word.from, options };
  }

  // ---------- 查询历史（localStorage 持久化，上限 50 条） ----------
  const HIST_KEY = 'myide-db-sql-history';
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; }
  }
  function saveHistoryEntry(sql, ok) {
    if (!sql) return;
    try {
      const h = loadHistory().filter((x) => x.sql !== sql); // 去重（最新在前）
      h.unshift({ sql, ts: Date.now(), ok: !!ok });
      localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 50)));
    } catch {}
  }

  // 取当前编辑器中的 SQL（选中片段优先）
  function currentSql() {
    if (sqlCm) {
      const sel = sqlCm.getSelection();
      const all = sqlCm.getValue();
      return (sel && sel.from !== sel.to ? all.slice(sel.from, sel.to) : all).trim();
    }
    const ta = document.getElementById('db-sql-input');
    if (!ta) return '';
    return (ta.value.slice(ta.selectionStart, ta.selectionEnd).trim() || ta.value.trim());
  }
  function setSql(text) {
    sqlText = text;
    if (sqlCm) sqlCm.setValue(text);
    else { const ta = document.getElementById('db-sql-input'); if (ta) ta.value = text; }
  }

  // 结果表格渲染（runSql / EXPLAIN 共用）
  function renderRows(out, r) {
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

  // EXPLAIN 执行计划：SELECT 前加 EXPLAIN，结果表格化显示
  async function runExplain() {
    if (!connId) { MI.toast('先连接数据库', 'err'); return; }
    const sql = currentSql();
    if (!sql) { MI.toast('SQL 为空', 'err'); return; }
    const out = document.getElementById('db-sql-result');
    out.innerHTML = '<div class="db-hint">分析中…</div>';
    const r = await call('explain', connId, sql);
    if (!r) { out.innerHTML = '<div class="db-hint db-err">EXPLAIN 执行失败</div>'; return; }
    const bar = document.createElement('div');
    bar.className = 'db-hint';
    bar.style.padding = '4px 10px';
    bar.textContent = '⚡ 执行计划（' + (connCfg && connCfg.type === 'mysql' ? 'MySQL EXPLAIN' : 'SQLite EXPLAIN QUERY PLAN') + '）';
    out.innerHTML = '';
    out.appendChild(bar);
    const grid = document.createElement('div');
    grid.className = 'db-grid-wrap';
    grid.style.borderTop = '1px solid var(--border-mid)';
    out.appendChild(grid);
    renderRows(grid, r);
  }

  // 历史弹窗：点击条目载入编辑器，Ctrl 重跑
  function openHistory() {
    const h = loadHistory();
    const box = document.createElement('div');
    box.id = 'br-box';
    Modal.show(box);
    box.innerHTML = `
      <div class="m-head">查询历史 <span class="x" id="qh-x">✕</span></div>
      <div class="m-body">
        ${!h.length ? '<div class="db-hint">暂无执行记录（运行 SQL 后自动保存，上限 50 条）</div>' : ''}
        <div id="qh-list" style="max-height:400px;overflow:auto"></div>
        ${h.length ? '<div style="margin-top:8px;text-align:right"><button class="tb-btn" id="qh-clear" style="color:var(--danger,#e06c75)">清空历史</button></div>' : ''}
      </div>`;
    const list = box.querySelector('#qh-list');
    h.forEach((it, idx) => {
      const d = document.createElement('div');
      d.className = 'qh-item' + (it.ok ? '' : ' qh-err');
      d.title = '点击载入编辑器';
      const t = new Date(it.ts);
      const p = (n) => String(n).padStart(2, '0');
      const short = it.sql.length > 120 ? it.sql.slice(0, 120) + '…' : it.sql;
      d.innerHTML = `<span class="qh-dot">${it.ok ? '✅' : '❌'}</span>
        <span class="qh-sql">${escapeHtml(short)}</span>
        <span class="qh-ts">${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}</span>`;
      d.onclick = () => {
        setSql(it.sql);
        Modal.hide();
        if (tab !== 'sql') switchTab('sql');
        MI.toast('已载入历史 SQL', 'ok');
      };
      list.appendChild(d);
    });
    const clr = box.querySelector('#qh-clear');
    if (clr) clr.onclick = () => { localStorage.removeItem(HIST_KEY); Modal.hide(); MI.toast('历史已清空', 'ok'); };
  }

  function renderSql() {
    const el = document.getElementById('db-sql');
    el.innerHTML = `
      <div class="db-sql-bar">
        <span class="db-sql-hint">Ctrl+Enter 运行 · 选中片段仅执行选中部分 · 输入表名/列名有补全</span>
        <span class="spacer"></span>
        <button class="vt-btn" id="db-sql-explain" title="执行计划（对当前 SELECT 跑 EXPLAIN）">⚡ EXPLAIN</button>
        <button class="vt-btn" id="db-sql-history" title="查询历史（最近 50 条，点击载入）">🕘 历史</button>
        <button class="vt-btn" id="db-sql-run" title="运行 SQL (Ctrl+Enter)">▶ 运行</button>
        <button class="vt-btn" id="db-sql-clear" title="清空">✕</button>
      </div>
      <div id="db-sql-input-wrap" class="db-sql-input-wrap"></div>
      <div id="db-sql-result" class="db-grid-wrap"><div class="db-hint">运行 SQL 后结果在此显示</div></div>`;
    const wrap = el.querySelector('#db-sql-input-wrap');
    if (window.CodeEditor) {
      sqlCm = CodeEditor.create({
        parent: wrap,
        doc: sqlText || '',
        ext: 'sql',
        completions: sqlComplete,
        onRun: () => runSql(),
        onChange: (v) => { sqlText = v; },
      });
    } else {
      // CM6 未加载时回退 textarea（无补全，功能可用）
      sqlCm = null;
      const ta = document.createElement('textarea');
      ta.id = 'db-sql-input';
      ta.spellcheck = false;
      ta.placeholder = 'SELECT * FROM ...';
      ta.value = sqlText || '';
      ta.addEventListener('input', () => { sqlText = ta.value; });
      ta.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); }
      });
      wrap.appendChild(ta);
    }
    el.querySelector('#db-sql-run').onclick = runSql;
    el.querySelector('#db-sql-explain').onclick = runExplain;
    el.querySelector('#db-sql-history').onclick = openHistory;
    el.querySelector('#db-sql-clear').onclick = () => setSql('');
  }

  async function runSql() {
    if (!connId) { MI.toast('先连接数据库', 'err'); return; }
    const sql = currentSql();
    if (!sql) { MI.toast('SQL 为空', 'err'); return; }
    const out = document.getElementById('db-sql-result');
    out.innerHTML = '<div class="db-hint">执行中…</div>';
    const r = await call('query', connId, sql, []);
    saveHistoryEntry(sql, !!r);
    if (!r) { out.innerHTML = '<div class="db-hint db-err">执行失败</div>'; return; }
    if (r.ok === 'write') {
      out.innerHTML = '<div class="db-hint">✅ 执行成功' + (r.affected != null ? '（影响 ' + r.affected + ' 行' + (r.insertId ? '，ID=' + r.insertId : '') + '）' : '') + '</div>';
      return;
    }
    renderRows(out, r);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------- 结构标签页（列定义 + DDL） ----------
  async function renderDdl() {
    const el = document.getElementById('db-ddl');
    if (!connId || !curTable) { el.innerHTML = '<div class="db-hint">选择左侧表查看结构</div>'; return; }
    el.innerHTML = '<div class="db-hint">加载中…</div>';
    const [cols, ddl] = await Promise.all([
      call('columns', connId, curTable),
      call('ddl', connId, curTable),
    ]);
    if (!cols) { el.innerHTML = '<div class="db-hint db-err">结构加载失败</div>'; return; }
    el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'db-grid-bar';
    head.innerHTML = `<span class="db-grid-title">${curTable}</span>
      <span class="db-grid-sub">${cols.length} 列 · ${cols.filter((c) => c.pk).length} 个主键列</span>
      <span class="spacer"></span>
      <button class="vt-btn" id="db-ddl-copy" title="复制 CREATE 语句">⧉ 复制 DDL</button>`;
    el.appendChild(head);
    const table = document.createElement('table');
    table.className = 'db-grid';
    table.innerHTML = '<thead><tr><th>列名</th><th>类型</th><th>主键</th><th>备注</th></tr></thead>';
    const tbody = document.createElement('tbody');
    cols.forEach((c) => {
      const tr = document.createElement('tr');
      const mk = (v, cls) => { const td = document.createElement('td'); td.textContent = v; if (cls) td.className = cls; tr.appendChild(td); };
      mk(c.name, c.pk ? 'db-pk' : '');
      mk(c.type || '');
      mk(c.pk ? '🔑 是' : '');
      mk(c.extra || '');
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    const wrap = document.createElement('div');
    wrap.className = 'db-grid-wrap';
    wrap.appendChild(table);
    el.appendChild(wrap);
    const pre = document.createElement('pre');
    pre.className = 'db-ddl-pre';
    pre.textContent = (ddl && ddl.ddl) || '（无 DDL）';
    el.appendChild(pre);
    head.querySelector('#db-ddl-copy').onclick = () => {
      MI.copyText((ddl && ddl.ddl) || '');
      MI.toast('已复制 CREATE 语句', 'ok');
    };
  }

  // ---------- ER 图（PyCharm 式：表节点 + FK 连线 + 拖拽/缩放画布） ----------
  // 节点尺寸：列名 22px 行高、标题栏 26px；列超 12 截断显示「…还有 N 列」
  const ER = {
    W_COL: 170, H_TITLE: 26, H_COL: 20, MAX_COLS: 12, PAD: 60,
    data: null,        // erSchema 结果 {tables, relations}
    pos: {},           // 表名 -> {x,y}（拖拽后更新；布局键持久化）
    scale: 1, pan: { x: 0, y: 0 },
    dragging: null,    // {table, dx, dy} 节点拖拽
    panning: null,     // {x,y} 画布平移
    highlight: null,   // hover/选中的表名（高亮其连线）
  };

  function erKey() {
    if (!connCfg) return null;
    return 'myide-db-er:' + (connCfg.type === 'mysql'
      ? connCfg.host + ':' + connCfg.port + '/' + connCfg.database
      : connCfg.file);
  }
  function erLoadPos() {
    try { return JSON.parse(localStorage.getItem(erKey()) || '{}'); } catch { return {}; }
  }
  function erSavePos() {
    try { localStorage.setItem(erKey(), JSON.stringify(ER.pos)); } catch {}
  }

  // 自动布局：按 FK 依赖分层（被引用表在上），同层横向网格
  function erAutoLayout() {
    const d = ER.data;
    if (!d) return;
    const depth = {};
    const calc = (name, seen) => {
      if (depth[name] !== undefined) return depth[name];
      if (seen.has(name)) return 0; // 环
      seen.add(name);
      let dep = 0;
      for (const r of d.relations) if (r.from === name) dep = Math.max(dep, calc(r.to, seen) + 1);
      depth[name] = dep;
      return dep;
    };
    d.tables.forEach((t) => calc(t.name, new Set()));
    // 同层排网格
    const layers = {};
    let maxW = 0;
    d.tables.forEach((t) => {
      const l = depth[t.name] || 0;
      (layers[l] = layers[l] || []).push(t);
      maxW = Math.max(maxW, (layers[l] || []).length);
    });
    ER.pos = {};
    const COL_GAP = ER.W_COL + ER.PAD;
    const layerNames = Object.keys(layers).map(Number).sort((a, b) => a - b);
    let y = 0;
    for (const l of layerNames) {
      let layerH = 0;
      layers[l].forEach((t, i) => {
        const h = ER.H_TITLE + Math.min(t.columns.length, ER.MAX_COLS) * ER.H_COL + 10;
        layerH = Math.max(layerH, h);
        ER.pos[t.name] = { x: i * COL_GAP, y };
      });
      y += layerH + ER.PAD;
    }
    erSavePos();
  }

  // 节点实际尺寸
  function erNodeSize(t) {
    return { w: ER.W_COL, h: ER.H_TITLE + Math.min(t.columns.length, ER.MAX_COLS) * ER.H_COL + 10 };
  }
  // 列在节点内的 y 坐标（用于连线锚点）
  function erColY(t, colName) {
    const i = t.columns.findIndex((c) => c.name === colName);
    if (i < 0) return ER.H_TITLE / 2;
    return ER.H_TITLE + Math.min(i, ER.MAX_COLS - 1) * ER.H_COL + ER.H_COL / 2;
  }

  function renderEr() {
    const el = document.getElementById('db-er');
    if (!connId) { el.innerHTML = '<div class="db-hint">先连接数据库，再查看 ER 图</div>'; return; }
    el.innerHTML = '<div class="db-hint">加载 schema 中…</div>';
    call('er', connId).then((d) => {
      if (!d) { el.innerHTML = '<div class="db-hint db-err">schema 加载失败</div>'; return; }
      ER.data = d;
      const saved = erLoadPos();
      if (!d.tables.length || d.tables.some((t) => !saved[t.name])) erAutoLayout(); // 首次/表结构变化 → 自动布局
      else ER.pos = saved;
      erDraw(el);
    });
  }

  function erDraw(el) {
    const d = ER.data;
    el.innerHTML = '';
    // 工具栏
    const bar = document.createElement('div');
    bar.className = 'er-bar';
    bar.innerHTML = `
      <span class="db-grid-sub">${d.tables.length} 张表 · ${d.relations.length} 个外键关系 · 拖动表节点调整布局 · 滚轮缩放 · 空白处拖动平移</span>
      <span class="spacer"></span>
      <button class="vt-btn" id="er-relayout" title="重新自动布局（清除手动位置）">⊞ 自动布局</button>
      <button class="vt-btn" id="er-fit" title="缩放到适合窗口">⤢ 适应窗口</button>
      <button class="vt-btn" id="er-zoom-in" title="放大">＋</button>
      <button class="vt-btn" id="er-zoom-out" title="缩小">－</button>
      <button class="vt-btn" id="er-zoom-reset" title="重置缩放（100%）">1:1</button>`;
    el.appendChild(bar);
    const canvas = document.createElement('div');
    canvas.className = 'er-canvas';
    el.appendChild(canvas);

    const draw = () => {
      canvas.innerHTML = '';
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'er-svg');
      svg.style.width = '100%'; svg.style.height = '100%';
      canvas.appendChild(svg);
      const root = document.createElementNS(NS, 'g');
      root.setAttribute('transform', 'translate(' + ER.pan.x + ',' + ER.pan.y + ') scale(' + ER.scale + ')');
      svg.appendChild(root);
      // 连线（画在节点下层）
      for (const r of d.relations) {
        const a = ER.pos[r.from], b = ER.pos[r.to];
        if (!a || !b) continue;
        const ta = d.tables.find((t) => t.name === r.from);
        const y1 = a.y + erColY(ta, r.fromCol);
        const x1 = a.x + ER.W_COL;
        // 从 from 右缘连到 to 左缘；若 to 在左侧则反向
        const toLeft = b.x < a.x;
        const x2 = toLeft ? b.x + ER.W_COL : b.x;
        const y2 = b.y + erColY(d.tables.find((t) => t.name === r.to), r.toCol);
        const mid = (x1 + x2) / 2;
        const line = document.createElementNS(NS, 'path');
        line.setAttribute('d', 'M' + (toLeft ? x2 : x1) + ' ' + (toLeft ? y2 : y1) + ' C ' + mid + ' ' + (toLeft ? y2 : y1) + ', ' + mid + ' ' + (toLeft ? y1 : y2) + ', ' + (toLeft ? x1 : x2) + ' ' + (toLeft ? y1 : y2));
        line.setAttribute('class', 'er-edge' + (ER.highlight === r.from || ER.highlight === r.to ? ' hl' : ''));
        const t = document.createElementNS(NS, 'title');
        t.textContent = r.from + '.' + r.fromCol + ' → ' + r.to + '.' + r.toCol;
        line.appendChild(t);
        root.appendChild(line);
      }
      // 表节点
      for (const t of d.tables) {
        const p = ER.pos[t.name];
        if (!p) continue;
        const { w, h } = erNodeSize(t);
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
        g.setAttribute('class', 'er-node' + (ER.highlight === t.name ? ' hl' : ''));
        g.dataset.table = t.name;
        const box = document.createElementNS(NS, 'rect');
        box.setAttribute('width', w); box.setAttribute('height', h);
        box.setAttribute('rx', 4);
        g.appendChild(box);
        const title = document.createElementNS(NS, 'text');
        title.setAttribute('x', 8); title.setAttribute('y', 17);
        title.setAttribute('class', 'er-title');
        title.textContent = t.name;
        g.appendChild(title);
        const n = Math.min(t.columns.length, ER.MAX_COLS);
        for (let i = 0; i < n; i++) {
          const c = t.columns[i];
          const tx = document.createElementNS(NS, 'text');
          tx.setAttribute('x', 8); tx.setAttribute('y', ER.H_TITLE + i * ER.H_COL + 14);
          tx.setAttribute('class', 'er-col' + (c.pk ? ' pk' : ''));
          tx.textContent = (c.pk ? '🔑 ' : '') + c.name + '  ' + (c.type || '');
          g.appendChild(tx);
        }
        if (t.columns.length > ER.MAX_COLS) {
          const more = document.createElementNS(NS, 'text');
          more.setAttribute('x', 8); more.setAttribute('y', ER.H_TITLE + n * ER.H_COL + 14);
          more.setAttribute('class', 'er-more');
          more.textContent = '…还有 ' + (t.columns.length - ER.MAX_COLS) + ' 列';
          g.appendChild(more);
        }
        root.appendChild(g);
      }
    };
    draw();

    // ---------- 交互 ----------
    const getSvg = () => canvas.querySelector('svg');

    // 节点拖拽（mousedown 在 g.er-node 上）/ 画布平移（mousedown 在空白）
    canvas.onmousedown = (e) => {
      if (e.button !== 0) return;
      const node = e.target.closest && e.target.closest('g.er-node');
      if (node) {
        const t = node.dataset.table;
        ER.dragging = { table: t, dx: e.clientX, dy: e.clientY, ox: ER.pos[t].x, oy: ER.pos[t].y };
      } else {
        ER.panning = { x: e.clientX, y: e.clientY, px: ER.pan.x, py: ER.pan.y };
      }
      e.preventDefault();
    };
    window.addEventListener('mousemove', (e) => {
      if (ER.dragging) {
        const p = ER.pos[ER.dragging.table];
        p.x = ER.dragging.ox + (e.clientX - ER.dragging.dx) / ER.scale;
        p.y = ER.dragging.oy + (e.clientY - ER.dragging.dy) / ER.scale;
        draw();
      } else if (ER.panning) {
        ER.pan.x = ER.panning.px + (e.clientX - ER.panning.x);
        ER.pan.y = ER.panning.py + (e.clientY - ER.panning.y);
        const s = getSvg();
        if (s) s.firstChild.setAttribute('transform', 'translate(' + ER.pan.x + ',' + ER.pan.y + ') scale(' + ER.scale + ')');
      }
    });
    window.addEventListener('mouseup', () => {
      if (ER.dragging) { erSavePos(); ER.dragging = null; }
      ER.panning = null;
    });
    // 滚轮缩放（以鼠标为中心）
    canvas.onwheel = (e) => {
      e.preventDefault();
      const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const ns = Math.min(3, Math.max(0.2, ER.scale * k));
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      ER.pan.x = mx - (mx - ER.pan.x) * (ns / ER.scale);
      ER.pan.y = my - (my - ER.pan.y) * (ns / ER.scale);
      ER.scale = ns;
      const s = getSvg();
      if (s) s.firstChild.setAttribute('transform', 'translate(' + ER.pan.x + ',' + ER.pan.y + ') scale(' + ER.scale + ')');
    };
    // hover 高亮关联（节点整组 hover）
    canvas.onmouseover = (e) => {
      const node = e.target.closest && e.target.closest('g.er-node');
      const name = node ? node.dataset.table : null;
      if (name !== ER.highlight) { ER.highlight = name; draw(); }
    };
    // 双击表节点 → 跳到该表数据页
    canvas.ondblclick = (e) => {
      const node = e.target.closest && e.target.closest('g.er-node');
      if (!node) return;
      openTable(node.dataset.table);
    };

    bar.querySelector('#er-relayout').onclick = () => { erAutoLayout(); ER.scale = 1; ER.pan = { x: ER.PAD, y: ER.PAD }; draw(); };
    bar.querySelector('#er-zoom-in').onclick = () => { ER.scale = Math.min(3, ER.scale * 1.2); draw(); };
    bar.querySelector('#er-zoom-out').onclick = () => { ER.scale = Math.max(0.2, ER.scale / 1.2); draw(); };
    bar.querySelector('#er-zoom-reset').onclick = () => { ER.scale = 1; ER.pan = { x: ER.PAD, y: ER.PAD }; draw(); };
    bar.querySelector('#er-fit').onclick = () => {
      // 计算内容包围盒，缩放平移到画布内
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const t of d.tables) {
        const p = ER.pos[t.name];
        if (!p) continue;
        const { w, h } = erNodeSize(t);
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
      }
      if (minX === Infinity) return;
      const rect = canvas.getBoundingClientRect();
      const s = Math.min(2, Math.max(0.2, Math.min((rect.width - 40) / (maxX - minX), (rect.height - 40) / (maxY - minY))));
      ER.scale = s;
      ER.pan = { x: 20 - minX * s, y: 20 - minY * s };
      draw();
    };
    ER.pan = { x: ER.PAD, y: ER.PAD };
    draw();
  }

  // ---------- CSV 导出 / 导入 ----------
  // 导出（fmt: 'csv' | 'json' | 'sql'）：JSON 为数组文件，SQL 为可重放的 INSERT 语句
  async function exportCsv(fmt) {
    if (!connId || !curTable) { MI.toast('先选择一个表', 'err'); return; }
    const FMTS = {
      csv: { ext: 'csv', name: 'CSV 文件', label: 'CSV' },
      json: { ext: 'json', name: 'JSON 文件', label: 'JSON' },
      sql: { ext: 'sql', name: 'SQL 文件', label: 'SQL' },
    };
    const f = FMTS[fmt] || FMTS.csv;
    const file = await window.myIDE.fs.pickSave('导出 ' + f.label, curTable + '.' + f.ext,
      [{ name: f.name, extensions: [f.ext] }, { name: '所有文件', extensions: ['*'] }]);
    if (!file) return;
    MI.toast('正在导出 ' + curTable + '…', 'ok');
    const r = await call('exportCsv', connId, curTable, file, fmt);
    if (!r) return;
    MI.toast('已导出 ' + r.rows + ' 行（' + f.label + '）→ ' + file, 'ok');
  }

  async function importCsv() {
    if (!connId || !curTable) { MI.toast('先选择要导入的目标表', 'err'); return; }
    const file = await window.myIDE.fs.pickFile('选择 CSV 文件（首行必须是表头）',
      [{ name: 'CSV 文件', extensions: ['csv', 'txt'] }, { name: '所有文件', extensions: ['*'] }]);
    if (!file) return;
    const okc = await Modal.confirm('导入 CSV', '将「' + file.split(/[\\/]/).pop() + '」的数据追加到表「' + curTable + '」？\n（首行作为列名须与表列匹配，空单元格插入 NULL）');
    if (!okc) return;
    const r = await call('importCsv', connId, curTable, file);
    if (!r) return;
    MI.toast('已导入 ' + r.inserted + ' 行', 'ok');
    loadData();
  }

  // ---------- 标签切换 ----------
  function switchTab(t) {
    tab = t;
    document.getElementById('db-tab-data').classList.toggle('active', t === 'data');
    document.getElementById('db-tab-ddl').classList.toggle('active', t === 'ddl');
    document.getElementById('db-tab-er').classList.toggle('active', t === 'er');
    document.getElementById('db-tab-sql').classList.toggle('active', t === 'sql');
    document.getElementById('db-data-wrap').classList.toggle('hidden', t !== 'data');
    document.getElementById('db-ddl').classList.toggle('hidden', t !== 'ddl');
    document.getElementById('db-er').classList.toggle('hidden', t !== 'er');
    document.getElementById('db-sql').classList.toggle('hidden', t !== 'sql');
    if (t === 'sql' && !document.getElementById('db-sql-input-wrap')) renderSql();
    if (t === 'ddl') renderDdl();
    if (t === 'er') renderEr();
  }

  // ---------- 初始化 ----------
  function init() {
    loadConns();

    document.getElementById('db-close').onclick = () => App.switchTool('db'); // 已激活 → 收起
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
    document.getElementById('db-tab-ddl').onclick = () => switchTab('ddl');
    document.getElementById('db-tab-er').onclick = () => switchTab('er');
    document.getElementById('db-tab-sql').onclick = () => switchTab('sql');

    renderConnBar();
    renderSql(); // 预建（保证 Ctrl+Enter 绑定就绪）
    switchTab('data');
  }

  return { init, toggle, syncVisible, isOpen: () => visible };
})();
window.DbPanel = DbPanel;

// 会话是位置记录；坏记录不能被标签重绘触发的空快照覆盖。
const Session = (() => {
  // 会话按项目隔离：每个项目记住自己的标签
  const KEY = (root = App.root) => 'myide-session:' + (root || '');
  const reports = new Map();
  let timer = null, sequence = 0, restoring = null;
  const tools = new Set(['project','outline','search','git','tasks','launch','db','browser','log','quick-launch']);
  const pathKey = p => DocumentPaths.key(p);
  function validPath(p, root) {
    return !!root && typeof p === 'string' && p.length > 0 && p.length <= 4096 && !/[\0\r\n]/.test(p)
      && /^(?:[a-z]:[\\/]|[\\/])/i.test(p) && !p.split(/[\\/]/).some(x => x === '.' || x === '..')
      && DocumentPaths.contains(root, p);
  }
  const current = run => restoring === run && App.root === run.root && sequence === run.sequence;
  const note = error => MI.toast(error, 'err');

  function capture(root) {
    try {
      // 只保存属于当前项目的标签（防会话串项目）
      const rootPrefix = root;
      // 每个标签带浏览位置（滚动 + 光标行），切换项目回来不丢
      const tabs = Viewer.openTabs
        .filter((t) => !t.dirty && t.retention!=='preview' && validPath(t.path, rootPrefix))
        .map((t) => {
          let line = null;
          try {
            const cmState = t === Viewer.activeTab && Viewer.cm?.view?.state || t.cmState;
            if (cmState && cmState.selection) {
              line = cmState.doc.lineAt(cmState.selection.main.head).number;
            }
          } catch {}
          return { p: t.path, s: Number.isFinite(t.scrollTop) && t.scrollTop >= 0 ? t.scrollTop : 0, l: line, ...(t.pinned?{f:true}:{}) };
        });
      const active = Viewer.activeTab;
      const state = {
        tabs,
        active: active && tabs.some(t => pathKey(t.p) === pathKey(active.path)) ? active.path : null,
        tool: App.getTool(),
        expanded: window.Tree ? Tree.getExpandedPaths().filter(p => validPath(p, root)) : [],
      };
      return state;
    } catch (error) { throw error; }
  }
  function publish(root, state, expected) {
    if (!root || App.root !== root) return { ok: false, stale: true };
    if (restoring?.root === root || reports.get(root)?.blocked) return { ok: false, protected: true };
    try {
      if (localStorage.getItem(KEY(root)) !== expected) throw Error('会话记录已变化，请重新读取；未覆盖原记录');
      if (expected) { const old = JSON.parse(expected); if (!old || typeof old !== 'object' || Array.isArray(old)) throw Error('原会话格式损坏，已保留'); }
      localStorage.setItem(KEY(root), JSON.stringify(state)); return { ok: true };
    } catch (error) { note('会话未保存：' + error.message); return { ok: false, error: error.message }; }
  }
  // 保存（viewer.renderTabs 每次标签变化都会调用，400ms 防抖）
  function save() {
    clearTimeout(timer);
    // closeAll会先触发保存通知，再由App清空root；结算后同步隐藏旧项目的提示。
    queueMicrotask(updateButton);
    const root = App.root;
    if (!root || restoring?.root === root || reports.get(root)?.blocked) return;
    try { const state = capture(root), expected = localStorage.getItem(KEY(root)); timer = setTimeout(() => publish(root, state, expected), 400); }
    catch (error) { note('会话未保存：' + error.message); }
  }
  // 立即保存（切换项目前调用，防止旧项目会话丢失）
  function saveNow() {
    clearTimeout(timer);
    if (!App.root) return { ok: true };
    try { return publish(App.root, capture(App.root), localStorage.getItem(KEY())); }
    catch (error) { note('会话未保存：' + error.message); return { ok: false, error: error.message }; }
  }

  async function restore() {
    clearTimeout(timer);
    const run = { root: App.root, sequence: ++sequence }, report = { raw: null, entries: [], errors: [], blocked: false, status: 'restoring', backups: [] };
    restoring = run; reports.set(run.root, report); updateButton();
    const fail = (part, error) => report.errors.push({ part, error: String(error?.message || error) });
    try { await restoreInto(run, report, fail); } catch (error) { fail('读取会话', error); }
    finally {
      if (current(run)) {
        report.blocked = report.errors.length > 0 || report.entries.some(e => e.status === 'failed');
        report.status = report.blocked ? 'partial' : report.status === 'empty' ? 'empty' : 'ready';
        restoring = null; updateButton();
        if (report.blocked) note('部分会话未恢复，原记录已保留；点击状态栏「部分恢复」查看详情');
      } else { report.status = 'stale'; if (restoring === run) restoring = null; }
    }
    return JSON.parse(JSON.stringify({ root: run.root, entries: report.entries, errors: report.errors, blocked: report.blocked, status: report.status }));
  }
  async function restoreInto(run, report, fail) {
    const root = run.root;
    // 备份入口必须在重新打开项目后仍可用，不能仅保存在本轮内存报告中。
    const prefix = 'myide-session-backup:' + root + ':';
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(prefix)) report.backups.push(key); }
    report.backupKey = report.backups.at(-1);
    report.raw = localStorage.getItem(KEY(root));
    if (!report.raw) { report.status = 'empty'; return; }
    const state = JSON.parse(report.raw);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw Error('会话格式无效');
    const list = state.tabs === undefined ? [] : state.tabs, seen = new Set();
    if (!Array.isArray(list)) fail('标签列表', '标签列表格式无效');
    const add = (it, part) => {
      if (!current(run)) return;
      const item = typeof it === 'string' ? { p: it } : it;
      if (!item || !validPath(item.p, root) || pathKey(item.p) === pathKey(root)) { fail(part, '文件路径无效或不属于当前项目'); return; }
      if (seen.has(pathKey(item.p))) return; seen.add(pathKey(item.p));
      let scroll = item.s ?? 0, line = item.l ?? null;
      if (!Number.isFinite(scroll) || scroll < 0) { fail(part, '滚动位置无效，按默认位置恢复'); scroll = 0; }
      if (line !== null && (!Number.isSafeInteger(line) || line < 1)) { fail(part, '行号无效，按默认位置恢复'); line = null; }
      const entry = { path: item.p, status: 'pending' }; report.entries.push(entry);
      try {
        const existing = Viewer.openTabs.find(t => pathKey(t.path) === pathKey(item.p));
        if (existing?.dirty) { entry.status = 'loaded'; entry.error = '保留当前未保存正文与位置'; return; }
        Viewer.addLazyTab(item.p, { scrollTop: scroll, line, pinned: item.f === true });
        const tab = Viewer.openTabs.find(t => pathKey(t.path) === pathKey(item.p));
        if (!tab) throw Error('标签正被关闭或迁移，可稍后重试');
        updateEntry(entry, tab);
      } catch (error) { entry.status = 'failed'; entry.error = error.message; }
    };
    if (Array.isArray(list)) list.forEach((it, i) => add(it, '标签 ' + (i + 1)));
    if (!current(run)) return;
    let target = null;
    if (state.active != null) {
      if (validPath(state.active, root) && pathKey(state.active) !== pathKey(root)) {
        if (!seen.has(pathKey(state.active))) add(state.active, '活动标签');
        target = Viewer.openTabs.find(t => pathKey(t.path) === pathKey(state.active));
      } else fail('活动标签', '活动文件路径无效或不属于当前项目');
    } else if (report.entries.length) target = Viewer.openTabs.find(t => pathKey(t.path) === pathKey(report.entries[0].path));
    if (target) {
      try { Viewer.activate(Viewer.openTabs.indexOf(target), { history: false }); if (target.loadPromise) await target.loadPromise; }
      catch (error) { fail('活动标签', error); }
      // 读盘结算后只操作同一项目、原记录版本和同一活动对象。
      if (!current(run) || localStorage.getItem(KEY(root)) !== report.raw) { if (current(run)) fail('记录版本', '恢复期间记录已变化，请重新读取'); return; }
      const entry = report.entries.find(e => pathKey(e.path) === pathKey(target.path)); if (entry) updateEntry(entry, target);
      if (Viewer.activeTab === target && !target.dirty && !target.error && target.restoreLine) { Viewer.revealLine(target.restoreLine); delete target.restoreLine; }
    }
    if (!current(run)) return;
    if (state.expanded !== undefined) {
      if (!Array.isArray(state.expanded)) fail('目录展开', '目录展开记录格式无效');
      else {
        const expanded = state.expanded.filter(p => validPath(p, root));
        if (expanded.length !== state.expanded.length) fail('目录展开', '已跳过无效或其他项目的目录');
        try { if (window.Tree) Tree.setExpandedPaths(expanded); } catch (error) { fail('目录展开', error); }
      }
    }
    if (state.tool != null) { if (!tools.has(state.tool)) fail('工具窗口', '工具名称无效'); else try { App.setTool(state.tool); } catch (error) { fail('工具窗口', error); } }
  }
  function updateEntry(entry, tab) {
    entry.status = tab?.error || tab?.mode === 'error' ? 'failed' : tab?.lazy || tab?.mode == null ? 'pending' : 'loaded';
    if (entry.status === 'failed') entry.error = tab?.error || '文件无法读取';
  }
  function getRestoreReport(root = App.root) {
    const report = reports.get(root);
    return report ? JSON.parse(JSON.stringify({ root, entries: report.entries, errors: report.errors, blocked: report.blocked, status: report.status })) : null;
  }
  function updateButton() {
    let button = document.getElementById('session-recovery-status'); const report = reports.get(App.root);
    if (!button && (report?.blocked || report?.backupKey) && document.getElementById('statusbar')) {
      button = document.createElement('button'); button.id = 'session-recovery-status'; button.className = 'tb-btn'; button.type = 'button';
      button.onclick = () => showRestoreReport(); document.getElementById('statusbar').prepend(button);
    }
    if (button) { button.hidden = !report?.blocked && !report?.backupKey; button.textContent = report?.blocked ? '部分恢复 · 查看详情' : '会话记录备份'; button.title = '查看恢复记录或复制原记录备份'; }
  }
  function showRestoreReport() {
    const root = App.root, report = reports.get(root); if (!report || !window.Modal) return;
    const box = document.createElement('div'); box.className = 'session-recovery'; box.dataset.selfEsc = '1';
    const head = document.createElement('div'); head.className = 'm-head'; head.textContent = '会话恢复详情';
    const close = document.createElement('button'); close.className = 'x'; close.type = 'button'; close.textContent = '关闭'; close.setAttribute('aria-label', '关闭会话恢复详情'); head.append(close);
    const body = document.createElement('div'); body.className = 'm-body';
    const message = document.createElement('p'); message.textContent = '项目：' + root + (report.blocked ? '。失败或坏记录未覆盖。' : report.backupKey ? '。当前会话可用，原记录备份可复制保留。' : '。当前会话已恢复。') + '后台标签仅登记，点击时才读取，不表示已经验证可读。'; body.append(message);
    for (const entry of report.entries) {
      const row = document.createElement('p'); row.textContent = ({ loaded: '已载入', pending: '待加载', failed: '无法恢复' })[entry.status] + '：' + entry.path + (entry.error ? ' — ' + entry.error : '');
      const tab = Viewer.openTabs.find(t => pathKey(t.path) === pathKey(entry.path));
      if (tab) { const view = document.createElement('button'); view.type = 'button'; view.className = 'tb-btn'; view.textContent = '查看文件'; view.onclick = () => { if (App.root !== root || !Viewer.openTabs.includes(tab)) return; hide(); Viewer.activate(Viewer.openTabs.indexOf(tab)); }; row.append(view); }
      body.append(row);
    }
    for (const issue of report.errors) { const row = document.createElement('p'); row.textContent = issue.part + '：' + issue.error; body.append(row); }
    for (const [i, saved] of report.backups.entries()) {
      const row = document.createElement('p'); row.textContent = '保留的原记录备份 ' + (i + 1) + '：';
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'tb-btn'; copy.textContent = '复制备份 ' + (i + 1);
      copy.onclick = async () => { if (App.root !== root || reports.get(root) !== report) return; try { const raw = localStorage.getItem(saved); if (raw === null) throw Error('备份不存在'); await MI.copyText(raw); MI.toast('记录备份已复制', 'ok'); } catch (error) { note('复制备份失败：' + error.message); } };
      row.append(copy); body.append(row);
    }
    const foot = document.createElement('div'); foot.className = 'm-foot';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'tb-btn'; retry.textContent = '重新读取记录';
    retry.onclick = async () => { if (App.root !== root) return; hide(); await restore(); if (App.root === root) showRestoreReport(); };
    const backup = document.createElement('button'); backup.type = 'button'; backup.className = 'tb-btn'; backup.textContent = '备份原记录并保存当前会话';
    backup.disabled = !report.blocked || report.raw === null;
    backup.onclick = async () => {
      if (App.root !== root || reports.get(root) !== report) return;
      const confirmed = await Modal.confirm('保存当前会话', '原会话将另存一份记录备份，再保存当前标签与位置。未加载标签仍保留；不会修改文件正文。继续？');
      if (!confirmed || App.root !== root || reports.get(root) !== report) return;
      try {
        if (localStorage.getItem(KEY(root)) !== report.raw) throw Error('原记录已变化，请重新读取');
        const backupKey = 'myide-session-backup:' + root + ':' + Date.now() + '-' + crypto.randomUUID();
        localStorage.setItem(backupKey, report.raw);
        if (localStorage.getItem(backupKey) !== report.raw) throw Error('备份核对失败，未替换原记录');
        localStorage.setItem(KEY(root), JSON.stringify(capture(root)));
        report.backups.push(backupKey); report.backupKey = backupKey; report.blocked = false; report.status = 'ready'; updateButton(); hide(); MI.toast('原记录已备份，当前会话已保存；状态栏可查看备份', 'ok');
      } catch (error) { note('会话未替换：' + error.message); }
    };
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'tb-btn'; copy.textContent = '复制原记录';
    copy.onclick = async () => { if (App.root !== root || reports.get(root) !== report) return; try { const raw = !report.blocked && report.backupKey ? localStorage.getItem(report.backupKey) : report.raw; if (raw === null) throw Error('原记录无法读取'); await MI.copyText(raw); MI.toast('原会话记录已复制，可另存备份', 'ok'); } catch (error) { note('复制原记录失败：' + error.message); } };
    foot.append(retry, copy, backup); box.append(head, body, foot);
    const previous = document.activeElement, hide = () => { if (Modal.stack.at(-1) === box) Modal.hide(); };
    const key = e => { if (Modal.stack.at(-1) !== box) return; if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopImmediatePropagation(); hide(); } if (e.key === 'Tab') { const buttons = [...box.querySelectorAll('button:not(:disabled)')]; if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons.at(-1).focus(); } else if (!e.shiftKey && document.activeElement === buttons.at(-1)) { e.preventDefault(); buttons[0].focus(); } } };
    close.onclick = hide; box.onModalHide = () => { document.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus(); };
    Modal.show(box); document.addEventListener('keydown', key, true); close.focus();
  }

  function pathsMoved(from,to) {
    // 未激活项目也有已存标签，不能只更新当前Session后等下一次打开旧路径失败。
    for(let i=0;i<localStorage.length;i++) {
      const key=localStorage.key(i);if(!key?.startsWith('myide-session:')||reports.get(key.slice('myide-session:'.length))?.blocked)continue;
      try {
        const state=JSON.parse(localStorage.getItem(key));if(!state||typeof state!=='object')continue;
        if(Array.isArray(state.tabs))state.tabs=state.tabs.map(t=>typeof t==='string'?DocumentPaths.map(t,from,to):{...t,p:DocumentPaths.map(t.p,from,to)});
        if(state.active)state.active=DocumentPaths.map(state.active,from,to);
        if(Array.isArray(state.expanded))state.expanded=state.expanded.map(p=>DocumentPaths.map(p,from,to));
        localStorage.setItem(key,JSON.stringify(state));
      }catch{}
    }
    save();
  }
  return { save, saveNow, restore, pathsMoved, getRestoreReport, showRestoreReport };
})();
window.Session = Session;

const QuickLaunch = (() => {
  const api = () => window.myIDE?.quickLaunch;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const q = id => document.getElementById(id);
  const copy = value => JSON.parse(JSON.stringify(value));
  const uid = () => 'q' + crypto.randomUUID().replace(/-/g, '');
  const typeNames = { app: '应用 / 快捷方式', file: '文件', folder: '文件夹', web: '网页' };
  const paths = { app: '<rect x="2" y="2" width="12" height="12" rx="2"/><path d="M2 6h12M6 6v8"/>',
    file: '<path d="M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 11h4"/>',
    folder: '<path d="M2 4h4l2 2h6v7H2z"/>', web: '<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.5" ry="6"/><path d="M2 8h12"/>' };
  const svg = type => '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">' + paths[type] + '</svg>';
  let config = null, version = null, loading = false, saving = false, managing = false, generation = 0;
  let loadError = '', query = '', composing = false, dragId = null, inited = false, dialog = null, confirming = false;
  let iconLoading = false, iconRefresh = false;
  const opening = new Set(), iconCache = new Map();
  function message(text, error = false) {
    const state = q('ql-status');
    state.textContent = text;
    state.classList.toggle('error', error);
  }
  function focus(key) {
    const target = [...q('quick-launch-main').querySelectorAll('[data-focus]')].find(el => el.dataset.focus === key);
    // 删除搜索结果后，原来的相邻入口可能被过滤；给键盘一个仍可到达的落点。
    (target || (q('ql-add').disabled ? q('ql-reload') : q('ql-add')))?.focus();
  }
  function filtered() {
    const needle = query.toLocaleLowerCase();
    return (config?.entries || []).filter(e => !needle || (e.name + '\n' + e.target).toLocaleLowerCase().includes(needle));
  }
  function render() {
    const root = q('quick-launch-main');
    if (!root) return;
    const focused = root.contains(document.activeElement) ? document.activeElement.dataset.focus : '';
    q('ql-add').disabled = loading || saving || confirming || !config || !!loadError;
    q('ql-group-add').disabled = q('ql-add').disabled;
    q('ql-manage').disabled = q('ql-add').disabled;
    q('ql-import').disabled = q('ql-add').disabled;
    q('ql-export').disabled = q('ql-add').disabled;
    q('ql-reload').disabled = loading || saving || confirming;
    q('ql-manage').textContent = managing ? '完成管理' : '管理';
    q('ql-manage').setAttribute('aria-pressed', String(managing));
    q('ql-count').textContent = config ? config.entries.length + ' 个入口' : '';
    q('ql-search').disabled = loading || !config;
    const visible = filtered();
    q('ql-results').textContent = query ? visible.length + ' 个匹配；清空搜索后可排序' : managing ? '拖动卡片或使用前移 / 后移整理；删除只影响入口' : '点击卡片，交给系统打开';
    const disabled = loading || saving || confirming || !!loadError;
    q('ql-groups').innerHTML = config ? config.groups.map((g, gi) => {
      const items = visible.filter(e => e.groupId === g.id);
      if (query && !items.length) return '';
      return '<section class="ql-group" data-group="' + esc(g.id) + '"><div class="ql-group-head"><h2>' + esc(g.name) + '</h2><span>' + items.length + '</span>'
        + (managing ? '<div class="ql-group-actions">' + button('group-rename', g.id, '改名', disabled)
          + button('group-up', g.id, '前移', disabled || !!query || gi === 0) + button('group-down', g.id, '后移', disabled || !!query || gi === config.groups.length - 1)
          + button('group-delete', g.id, '删除分组', disabled, '至少保留一个分组；非空分组请先迁移入口') + '</div>' : '')
        + '</div><div class="ql-cards">' + items.map(e => {
          const peers = config.entries.filter(x => x.groupId === e.groupId), index = peers.findIndex(x => x.id === e.id);
          return '<article class="ql-card" data-entry="' + esc(e.id) + '" draggable="' + (managing && !query && !disabled) + '">'
            + (managing ? '<span class="ql-grip" title="' + (query ? '清空搜索后可拖动排序' : '拖动卡片到其他卡片前或分组末尾') + '"><svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 4h1M10 4h1M5 8h1M10 8h1M5 12h1M10 12h1"/></svg></span>' : '')
            + '<button class="ql-open" data-action="open" data-id="' + esc(e.id) + '" data-focus="open:' + esc(e.id) + '" title="' + esc(e.name + '\n' + e.target) + '"' + (opening.has(e.id) ? ' disabled' : '') + '>'
            + '<span class="ql-icon" data-icon="' + esc(e.id) + '">' + svg(e.type) + '</span><span class="ql-name">' + esc(e.name) + '</span><span class="ql-type">' + (opening.has(e.id) ? '正在打开…' : typeNames[e.type]) + '</span></button>'
            + (managing ? '<div class="ql-card-actions">' + button('edit', e.id, '编辑', disabled) + button('delete', e.id, '删除', disabled)
              + button('up', e.id, '前移', disabled || !!query || index === 0) + button('down', e.id, '后移', disabled || !!query || index === peers.length - 1) + '</div>' : '') + '</article>';
        }).join('') + (items.length ? '' : '<p class="ql-empty">添加常用应用、文件夹或网页</p>') + '</div>'
        + '<button class="ql-group-add" data-action="add" data-id="' + esc(g.id) + '"' + (disabled ? ' disabled' : '') + '>添加入口</button></section>';
    }).join('') : '<p class="ql-empty">' + (loading ? '正在加载快速启动…' : '配置不可用，请重新加载。') + '</p>';
    if (config && query && !visible.length) q('ql-groups').innerHTML = '<div class="ql-empty"><p>没有匹配入口</p><button data-action="clear">清空搜索</button></div>';
    if (focused) focus(focused);
    loadIcons();
  }
  function button(action, id, label, disabled, title = '') {
    return '<button data-action="' + action + '" data-id="' + esc(id) + '" data-focus="' + action + ':' + esc(id) + '"' + (disabled ? ' disabled' : '') + (title ? ' title="' + esc(title) + '"' : '') + '>' + label + '</button>';
  }
  async function loadIcons() {
    if (!api()?.icon || !config) return;
    if (iconLoading) { iconRefresh = true; return; }
    iconLoading = true; iconRefresh = false;
    const epoch = generation;
    const entries = filtered().filter(e => e.type !== 'web');
    // 系统图标采集有成本；限制四个在途请求，缓存最多128项，不随每次键入重新排队。
    let cursor = 0;
    const worker = async () => {
      while (cursor < entries.length && epoch === generation) {
        const e = entries[cursor++], key = e.type + ':' + e.target;
        if (!iconCache.has(key)) {
          if (iconCache.size >= 128) iconCache.delete(iconCache.keys().next().value);
          iconCache.set(key, Promise.resolve(api().icon(e.id, e.target)).catch(() => ({ data: '' })));
        }
        const r = await iconCache.get(key);
        if (epoch !== generation || !r?.data?.startsWith('data:image/png;base64,')) continue;
        const slot = [...q('ql-groups').querySelectorAll('[data-icon]')].find(el => el.dataset.icon === e.id);
        if (slot && config.entries.some(x => x.id === e.id && x.target === e.target)) {
          const img = document.createElement('img'); img.src = r.data; img.alt = ''; slot.replaceChildren(img);
        }
      }
    };
    try { await Promise.all(Array.from({ length: 4 }, worker)); }
    finally { iconLoading = false; if (iconRefresh) { iconRefresh = false; loadIcons(); } }
  }
  async function load() {
    if (saving || confirming || dialog) return;
    const epoch = ++generation;
    loading = true; render();
    try {
      const r = await api().load();
      if (epoch !== generation) return;
      if (!r?.ok) throw Error((r?.error || '读取失败') + (r?.file ? '\n配置位置：' + r.file : ''));
      config = r.config; version = r.version; loadError = ''; iconCache.clear();
      message('配置位置：' + r.file);
    } catch (err) {
      if (epoch !== generation) return;
      loadError = err.message; message('加载失败：' + loadError + '\n已保留原配置，请修复后重新加载。', true);
    } finally {
      if (epoch === generation) { loading = false; render(); }
    }
  }
  async function commit(request, focusKey = '') {
    if (loading || saving || loadError || !config) return false;
    saving = true; render();
    try {
      const r = await request();
      if (!r?.ok) {
        if (r?.errorCode === 'VERSION_CONFLICT') loadError = r.error;
        const err = Error(r?.error || '服务未确认保存成功'); err.existingId = r?.existingId; throw err;
      }
      config = r.config; version = r.version; generation++; iconCache.clear();
      message(r.imported !== undefined ? '已导入 ' + r.imported + ' 个入口，新增 ' + r.addedGroups + ' 个分组' : '已保存'); return true;
    } catch (err) {
      message('保存失败：' + err.message + (loadError ? '；取消编辑并重新加载后再修改。' : '；原配置与草稿已保留。'), true);
      if (dialog) {
        dialog.querySelector('.ql-dialog-error').textContent = err.message;
        const locate = dialog.querySelector('[data-locate]');
        if (locate) { locate.hidden = !err.existingId; locate.dataset.locate = err.existingId || ''; }
      }
      return false;
    } finally { saving = false; render(); if (focusKey) focus(focusKey); }
  }
  const save = (next, focusKey = '') => commit(() => api().save(next, version), focusKey);
  async function open(id) {
    if (opening.has(id)) return;
    opening.add(id); render();
    try {
      const r = await api().open(id);
      if (!r?.ok) throw Error(r?.error || '系统未确认打开请求');
      message('已交给系统打开：' + (config?.entries.find(e => e.id === id)?.name || '入口'));
    } catch (err) { message('打开失败：' + err.message + '；可重试或在管理中编辑目标。', true); }
    finally { opening.delete(id); render(); }
  }
  function closeDialog() {
    if (!dialog || saving) return;
    const restore = dialog.__restore;
    dialog.__cleanup?.();
    dialog.close?.(); dialog.remove(); dialog = null;
    if (restore?.isConnected && restore.matches('button,input,select,textarea,[tabindex]')) restore.focus(); else q('ql-add').focus();
  }
  function makeDialog(title, content, submit) {
    if (dialog || loading || saving || confirming || loadError) return;
    const restore = document.activeElement;
    dialog = document.createElement('dialog'); dialog.className = 'ql-dialog';
    dialog.setAttribute('aria-label', title);
    dialog.__restore = restore;
    dialog.innerHTML = '<form><h2>' + title + '</h2><fieldset>' + content + '</fieldset><p class="ql-dialog-error" role="status"></p><div class="ql-dialog-foot"><button type="button" data-locate hidden>定位已有入口</button><button type="button" data-cancel>取消</button><button type="submit" class="ql-primary">保存</button></div></form>';
    document.body.append(dialog);
    dialog.querySelector('[data-cancel]').onclick = closeDialog;
    dialog.addEventListener('cancel', ev => { ev.preventDefault(); closeDialog(); });
    // 原生dialog自管提交/取消，不能让工作台的全局按键同时消费Enter/Escape。
    dialog.addEventListener('keydown', ev => { ev.stopPropagation(); });
    dialog.querySelector('form').onsubmit = async ev => {
      ev.preventDefault(); if (saving || loadError) return;
      const current = dialog, data = Object.fromEntries(new FormData(current.querySelector('form')));
      current.querySelector('fieldset').disabled = true;
      current.querySelector('[type="submit"]').disabled = true;
      current.querySelector('[data-cancel]').disabled = true;
      try { if (await submit(data)) closeDialog(); }
      finally { if (current.isConnected) { current.querySelector('fieldset').disabled = false; current.querySelector('[type="submit"]').disabled = !!loadError || !!current.__submitDisabled?.(); current.querySelector('[data-cancel]').disabled = false; } }
    };
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    dialog.querySelector('input, select')?.focus();
  }
  function importEntries() {
    let plan = null;
    const initial = '<label>导入来源<select name="kind"><option value="config">快速启动配置文件</option><option value="apps">多个应用 / 快捷方式</option></select></label>'
      + '<label data-import-group hidden>添加到分组<select name="groupId">' + config.groups.map(g => '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>').join('') + '</select></label>'
      + '<p class="ql-dialog-hint">主动选择文件；不会扫描桌面或开始菜单。配置按分组名称合并，重复目标跳过，原入口与顺序保留。</p>';
    makeDialog('导入入口', initial, async data => {
      if (plan) {
        const selected = [...dialog.querySelectorAll('[data-import-entry]:checked')].map(el => el.value);
        return commit(() => api().applyImport(plan.token, selected));
      }
      const current = dialog;
      saving = true; render();
      try {
        const r = await api().previewImport(data.kind, data.groupId);
        if (!r?.ok) throw Error(r?.error || '未能读取导入文件');
        if (r.canceled) return false;
        plan = r; current.classList.add('ql-import-dialog');
        const ready = r.entries.filter(e => e.status === 'ready').length;
        current.querySelector('fieldset').innerHTML = '<p class="ql-dialog-hint">' + ready + ' 个可导入，' + r.entries.filter(e => e.status === 'duplicate').length + ' 个重复，' + r.entries.filter(e => e.status === 'error').length + ' 个不可用；还可添加 ' + r.availableSlots + ' 个入口。</p>'
          + '<p class="ql-dialog-hint">同名分组沿用已有分组。新分组按所选入口创建，源配置中的新空分组也会保留。</p>'
          + (r.emptyGroups.length ? '<p class="ql-dialog-hint">新增空分组：' + r.emptyGroups.map(g => esc(g.name)).join('、') + '</p>' : '')
          + '<div class="ql-import-list">' + r.entries.map(e => '<label class="ql-import-row"><input type="checkbox" data-import-entry value="' + esc(e.id) + '"' + (e.status === 'ready' ? ' checked' : ' disabled') + '><span><strong>' + esc(e.name) + '</strong><span>' + esc(typeNames[e.type] + ' · ' + e.groupName) + '</span><span class="ql-import-target">' + esc(e.target) + '</span><span>' + esc(e.error || '可导入') + '</span></span></label>').join('') + '</div>'
          + '<p data-import-summary class="ql-dialog-hint"></p><button type="button" data-import-reset>重新选择</button>';
        current.querySelector('[type="submit"]').textContent = '确认导入';
        current.querySelector('.ql-dialog-error').textContent = '';
        const summary = () => {
          const count = current.querySelectorAll('[data-import-entry]:checked').length;
          current.querySelector('[data-import-summary]').textContent = '将添加 ' + count + ' 个入口；未勾选、重复和不可用的入口不会导入。';
          current.querySelector('[type="submit"]').disabled = count > r.availableSlots || !count && !r.emptyGroups.length;
        };
        current.__submitDisabled = () => {
          const count = current.querySelectorAll('[data-import-entry]:checked').length;
          return count > r.availableSlots || !count && !r.emptyGroups.length;
        };
        current.querySelector('.ql-import-list').onchange = summary; summary();
        current.querySelector('[data-import-reset]').onclick = () => {
          api().cancelImport(plan.token).catch(() => {}); plan = null;
          current.__submitDisabled = null; current.classList.remove('ql-import-dialog');
          current.querySelector('fieldset').innerHTML = initial; prepare();
          current.querySelector('[type="submit"]').textContent = '选择并预览'; current.querySelector('[type="submit"]').disabled = !!loadError;
          current.querySelector('.ql-dialog-error').textContent = ''; current.querySelector('select').focus();
        };
      } catch (err) { current.querySelector('.ql-dialog-error').textContent = err.message; }
      finally { saving = false; render(); }
      return false;
    });
    if (!dialog) return;
    const current = dialog;
    const prepare = () => { current.querySelector('[name="kind"]').onchange = ev => { current.querySelector('[data-import-group]').hidden = ev.target.value !== 'apps'; }; };
    prepare(); current.querySelector('[type="submit"]').textContent = '选择并预览';
    current.__cleanup = () => { if (plan) api().cancelImport(plan.token).catch(() => {}); };
  }
  async function exportEntries() {
    if (loading || saving || confirming || dialog || loadError || !config) return;
    saving = true; render();
    try {
      const r = await api().export();
      if (!r?.ok) throw Error(r?.error || '未确认导出成功');
      if (!r.canceled) message('已导出 ' + r.exported + ' 个入口：' + r.file);
    } catch (err) { message('导出失败：' + err.message + '；当前配置未改变。', true); }
    finally { saving = false; render(); q('ql-export').focus(); }
  }
  function edit(id, groupId) {
    if (!config) return;
    const e = config.entries.find(x => x.id === id);
    makeDialog(e ? '编辑入口' : '添加入口',
      '<label>名称<input name="name" required maxlength="100" value="' + esc(e?.name || '') + '"></label>'
      + '<label>类型<select name="type">' + Object.entries(typeNames).map(([type, name]) => '<option value="' + type + '"' + (type === e?.type ? ' selected' : '') + '>' + name + '</option>').join('') + '</select></label>'
      + '<label>目标<input name="target" required value="' + esc(e?.target || '') + '" placeholder="绝对路径或完整 HTTP(S) 地址"></label><button type="button" data-pick>选择目标</button>'
      + '<p class="ql-dialog-hint">网页在系统默认浏览器打开。应用参数请放在已有快捷方式中。</p><p class="ql-dialog-hint" data-summary></p>'
      + '<label>分组<select name="groupId">' + config.groups.map(g => '<option value="' + esc(g.id) + '"' + (g.id === (e?.groupId || groupId) ? ' selected' : '') + '>' + esc(g.name) + '</option>').join('') + '</select></label>',
      async data => {
        const next = copy(config), item = { id: e?.id || uid(), ...data, name: data.name.trim() };
        if (e) next.entries[next.entries.findIndex(x => x.id === id)] = item; else next.entries.push(item);
        return save(next, 'open:' + item.id);
      });
    if (!dialog) return;
    const current = dialog, form = current.querySelector('form'), pick = current.querySelector('[data-pick]');
    const syncType = () => {
      pick.hidden = form.elements.type.value === 'web';
      current.querySelector('[data-summary]').textContent = '将打开：' + typeNames[form.elements.type.value] + ' · ' + (form.elements.target.value || '尚未选择目标');
    };
    form.elements.type.onchange = syncType; form.elements.target.oninput = syncType; syncType();
    pick.onclick = async () => {
      if (saving) return;
      pick.disabled = true;
      try {
        const kind = form.elements.type.value, r = await api().pick(kind);
        if (dialog !== current || kind !== form.elements.type.value) return;
        if (r?.error) current.querySelector('.ql-dialog-error').textContent = r.error;
        if (r?.target) {
          form.elements.target.value = r.target;
          if (!form.elements.name.value.trim()) form.elements.name.value = [...r.name].slice(0, 100).join('');
          syncType();
        }
      } catch (err) { if (dialog === current) current.querySelector('.ql-dialog-error').textContent = err.message; }
      finally { if (dialog === current) pick.disabled = false; }
    };
    current.querySelector('[data-locate]').onclick = () => {
      const existing = current.querySelector('[data-locate]').dataset.locate;
      closeDialog(); query = ''; q('ql-search').value = ''; render(); focus('open:' + existing);
    };
  }
  function editGroup(id) {
    const group = config?.groups.find(g => g.id === id);
    makeDialog(group ? '分组改名' : '添加分组', '<label>分组名称<input name="name" required maxlength="60" value="' + esc(group?.name || '') + '"></label>', async data => {
      const next = copy(config);
      if (group) next.groups.find(g => g.id === id).name = data.name.trim();
      else next.groups.push({ id: uid(), name: data.name.trim() });
      return save(next);
    });
  }
  async function remove(id, group = false) {
    if (loading || saving || confirming || dialog || loadError) return;
    const item = group ? config.groups.find(g => g.id === id) : config.entries.find(e => e.id === id);
    if (!item) return;
    if (group && (config.groups.length === 1 || config.entries.some(e => e.groupId === id))) {
      message('删除分组前请迁移或删除其中入口，并至少保留一个分组。', true); return;
    }
    const revision = version;
    confirming = true; render();
    let accepted;
    try { accepted = await window.Modal.confirm(group ? '删除分组' : '删除入口', '删除「' + esc(item.name) + '」？只删除入口配置，不删除目标文件或卸载应用。'); }
    finally { confirming = false; render(); }
    if (!accepted || saving || loadError || version !== revision) return;
    const next = copy(config), index = next.entries.findIndex(e => e.id === id);
    if (group) next.groups = next.groups.filter(g => g.id !== id); else next.entries = next.entries.filter(e => e.id !== id);
    await save(next, next.entries[Math.min(index, next.entries.length - 1)] ? 'open:' + next.entries[Math.min(index, next.entries.length - 1)].id : 'add');
  }
  async function move(id, groupId, beforeId) {
    if (query || loading || saving || confirming || loadError) return;
    const next = copy(config), e = next.entries.find(x => x.id === id);
    if (!e || !next.groups.some(g => g.id === groupId) || id === beforeId) return;
    if (beforeId && !next.entries.some(x => x.id === beforeId && x.groupId === groupId)) return;
    next.entries = next.entries.filter(x => x.id !== id); e.groupId = groupId;
    let index = beforeId ? next.entries.findIndex(x => x.id === beforeId) : -1;
    if (index < 0) index = next.entries.length;
    next.entries.splice(index, 0, e); await save(next, 'open:' + id);
  }
  async function action(action, id) {
    if (action === 'open') return open(id);
    if (action === 'clear') { query = ''; q('ql-search').value = ''; render(); q('ql-search').focus(); return; }
    if (loading || saving || confirming || loadError || !config) return;
    if (action === 'add') return edit(null, id);
    if (action === 'edit') return edit(id);
    if (action === 'delete') return remove(id);
    if (action === 'group-rename') return editGroup(id);
    if (action === 'group-delete') return remove(id, true);
    if (query) { message('请清空搜索后调整顺序。'); return; }
    if (action === 'up' || action === 'down') {
      const e = config.entries.find(x => x.id === id), peers = config.entries.filter(x => x.groupId === e.groupId), i = peers.findIndex(x => x.id === id);
      if (action === 'up' && i > 0) return move(id, e.groupId, peers[i - 1].id);
      if (action === 'down' && i < peers.length - 1) {
        const next = copy(config), a = next.entries.findIndex(x => x.id === id), b = next.entries.findIndex(x => x.id === peers[i + 1].id);
        [next.entries[a], next.entries[b]] = [next.entries[b], next.entries[a]]; return save(next, 'open:' + id);
      }
    }
    if (action === 'group-up' || action === 'group-down') {
      const next = copy(config), i = next.groups.findIndex(g => g.id === id), j = i + (action === 'group-up' ? -1 : 1);
      if (j >= 0 && j < next.groups.length) { [next.groups[i], next.groups[j]] = [next.groups[j], next.groups[i]]; await save(next, action + ':' + id); }
    }
  }
  function init() {
    if (inited) return;
    inited = true;
    const root = document.createElement('section'); root.id = 'quick-launch-main'; root.className = 'hidden'; root.setAttribute('aria-label', '快速启动');
    root.innerHTML = '<header class="ql-head"><div><h1>快速启动</h1><span id="ql-count"></span></div><button id="ql-back">返回编辑器</button></header>'
      + '<div class="ql-toolbar"><input id="ql-search" type="search" placeholder="搜索名称、路径或网页…" aria-label="搜索快速启动入口"><button id="ql-add" data-focus="add" class="ql-primary">添加入口</button><button id="ql-group-add">添加分组</button><button id="ql-manage" aria-pressed="false">管理</button><button id="ql-import">导入</button><button id="ql-export">导出</button><button id="ql-reload">重新加载</button></div>'
      + '<p id="ql-results" class="ql-results"></p><div id="ql-groups"></div><p id="ql-status" role="status" aria-live="polite"></p>';
    q('content').append(root);
    q('ql-back').onclick = () => { window.App.backToEditor(); q('tool-quick-launch')?.focus(); };
    q('ql-add').onclick = () => edit(); q('ql-group-add').onclick = () => editGroup(); q('ql-reload').onclick = load;
    q('ql-import').onclick = importEntries; q('ql-export').onclick = exportEntries;
    q('ql-manage').onclick = () => { managing = !managing; render(); q('ql-manage').focus(); };
    q('ql-search').oninput = ev => { query = ev.target.value; render(); };
    q('ql-search').addEventListener('compositionstart', () => { composing = true; });
    q('ql-search').addEventListener('compositionend', () => { composing = false; });
    q('ql-search').onkeydown = ev => {
      if (composing || ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === 'Enter') { ev.preventDefault(); const e = filtered()[0]; if (e) open(e.id); }
      if (ev.key === 'Escape') { ev.preventDefault(); action('clear'); }
    };
    q('ql-groups').onclick = ev => { const b = ev.target.closest('[data-action]'); if (b && !b.disabled) action(b.dataset.action, b.dataset.id); };
    q('ql-groups').addEventListener('dragstart', ev => {
      const card = ev.target.closest('[data-entry]');
      if (!card || !managing || query || loading || saving || confirming || loadError) { ev.preventDefault(); return; }
      dragId = card.dataset.entry; ev.dataTransfer.setData('text/plain', dragId); ev.dataTransfer.effectAllowed = 'move';
    });
    const clearDrop = () => q('ql-groups').querySelectorAll('.ql-drop').forEach(el => el.classList.remove('ql-drop'));
    q('ql-groups').addEventListener('dragover', ev => {
      const target = ev.target.closest('[data-entry], [data-group]');
      if (dragId && target && !query && !loading && !saving && !confirming && !loadError) { ev.preventDefault(); clearDrop(); target.classList.add('ql-drop'); ev.dataTransfer.dropEffect = 'move'; }
    });
    q('ql-groups').addEventListener('drop', ev => {
      ev.preventDefault(); clearDrop(); const group = ev.target.closest('[data-group]'), card = ev.target.closest('[data-entry]'), id = dragId;
      dragId = null; if (id && group && !query && !saving) move(id, group.dataset.group, card?.dataset.entry);
    });
    q('ql-groups').addEventListener('dragend', () => { dragId = null; clearDrop(); });
  }
  function show() { init(); q('quick-launch-main').classList.remove('hidden'); if (!config && !loading) load(); q('ql-search').focus(); }
  function hide() { q('quick-launch-main')?.classList.add('hidden'); }
  return { init, show, hide, reload: load };
})();
window.QuickLaunch = QuickLaunch;

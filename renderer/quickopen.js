// quickopen.js —— 快速打开；候选和焦点都属于打开时的项目与面板。
const QuickOpen = (() => {
  let cache = null, pending = null, panel = null, generation = 0;
  const paths = window.DocumentPaths;
  const top = box => Modal.stack[Modal.stack.length - 1] === box;
  const current = state => panel === state && state.generation === generation
    && paths.key(App.root) === paths.key(state.root) && state.box.isConnected;
  const descriptor = (path, root) => {
    const normalized = paths.normalize(path);
    const rel = paths.contains(root, path) ? normalized.slice(paths.normalize(root).length + 1) : normalized;
    const name = normalized.split('/').pop();
    return { path, name, rel, key: paths.key(path), nameLower: name.toLowerCase(), text: (name + ' ' + rel).toLowerCase() };
  };

  // 连续文件名优先；保留原有分散字符匹配，结果上限只限制展示，不限制评分范围。
  function score(query, file) {
    const base = file.nameLower.includes(query) ? 500 : file.text.includes(query) ? 200 : 0;
    let seq = 0, pos = 0;
    for (const ch of query) {
      const i = file.text.indexOf(ch, pos);
      if (i < 0) return base || -1;
      seq += i === pos ? 10 : 1; pos = i + 1;
    }
    return base + seq;
  }
  function rank(query, files) {
    const best = [];
    for (const file of files) {
      const value = score(query, file);
      if (value <= 0) continue;
      let at = 0;
      while (at < best.length && (best[at].value > value
        || (best[at].value === value && best[at].file.key <= file.key))) at++;
      if (at < 30) { best.splice(at, 0, { file, value }); if (best.length > 30) best.pop(); }
    }
    return best.map(item => item.file);
  }
  function setSelection(state, index) {
    state.selected = state.results.length ? Math.max(0, Math.min(index, state.results.length - 1)) : -1;
    const rows = [...state.list.querySelectorAll('.qo-item')];
    rows.forEach((row, i) => {
      row.classList.toggle('sel', i === state.selected); row.setAttribute('aria-selected', String(i === state.selected));
    });
    const selected = rows[state.selected];
    if (selected) {
      state.input.setAttribute('aria-activedescendant', selected.id); selected.scrollIntoView?.({ block: 'nearest' });
    } else state.input.removeAttribute('aria-activedescendant');
  }
  function render(state, resetSelection = false) {
    if (!current(state)) return;
    const selectedKey = state.results[state.selected]?.key;
    const query = state.input.value.trim().toLowerCase(), recent = [], seen = new Set();
    const entries = Viewer.recentFiles();
    if (!query) for (const entry of Array.isArray(entries) ? entries : []) {
      if (typeof entry?.path !== 'string' || !entry.path || seen.has(paths.key(entry.path))) continue;
      seen.add(paths.key(entry.path)); recent.push(descriptor(entry.path, state.root));
    }
    state.results = query ? rank(query, state.index?.files || []) : recent;
    state.list.replaceChildren();
    if (!query && recent.length) {
      const label = document.createElement('div'); label.className = 'sr-stat'; label.textContent = '最近打开';
      label.setAttribute('role', 'presentation'); state.list.appendChild(label);
    }
    state.results.forEach((file, i) => {
      const row = document.createElement('div'); row.className = 'qo-item'; row.id = 'qo-option-' + i;
      row.setAttribute('role', 'option'); row.title = file.path;
      const name = document.createElement('span'); name.className = 'qo-name'; name.textContent = file.name;
      const rel = document.createElement('span'); rel.className = 'qo-rel'; rel.textContent = query ? file.rel : file.path;
      row.append(name, rel);
      row.onmouseenter = () => { if (current(state) && top(state.box)) setSelection(state, i); };
      // 点击的身份来自这一行，不能依赖鼠标是否先经过另一行。
      row.onclick = event => pick(state,i,event.shiftKey?'regular':'browse'); state.list.appendChild(row);
    });
    if (!state.results.length) {
      const empty = document.createElement('div'); empty.className = 'qo-empty';
      empty.textContent = query ? (state.loading ? '正在读取项目文件…' : state.error ? '文件列表读取失败，请重试' : '没有匹配的文件') : '输入关键字开始搜索…';
      state.list.appendChild(empty);
    }
    state.status.textContent = state.loading ? '正在读取项目文件…' : state.error ? '文件列表读取失败：' + state.error
      : state.index?.truncated ? '仅索引前 5 万个文件；结果可能不完整' : query ? '显示 ' + state.results.length + ' 项，最多 30 项' : '';
    state.retry.hidden = !state.error; state.input.setAttribute('aria-busy', String(state.loading));
    setSelection(state, resetSelection ? 0 : Math.max(0, state.results.findIndex(file => file.key === selectedKey)));
  }
  function restoreFocus(state) {
    if (paths.key(App.root) !== paths.key(state.root)) return;
    const other = Modal.stack[Modal.stack.length - 1], origin = state.origin;
    if (origin?.isConnected && origin !== document.body && (!other || other.contains(origin))
      && (!origin.closest('.cm-editor') || Viewer.activeTab?.id === state.tabId)) origin.focus();
    else if (other) other.querySelector('input, button, [tabindex="0"]')?.focus();
    else if (Viewer.cm?.__tab === Viewer.activeTab) Viewer.cm.focus();
    else document.getElementById('btn-open')?.focus();
  }
  function cleanup(state) {
    if (state.closed) return;
    state.closed = true; document.removeEventListener('keydown', state.onKey, true);
    document.removeEventListener('focusin', state.onFocus, true);
    state.inert.forEach(([element, previous]) => previous ? element.setAttribute('inert', '') : element.removeAttribute('inert'));
    if (panel === state) panel = null;
    if (state.restore) restoreFocus(state);
  }
  function close(state, restore = true) {
    if (!current(state) || !top(state.box)) return;
    state.restore = restore; Modal.hide();
  }
  async function pick(state, index = state.selected, intent='browse') {
    if (!current(state) || !top(state.box)) return;
    const file = state.results[index]; if (!file) return;
    close(state, false);
    try { await Viewer.openFile(file.path,{intent}); }
    catch (error) { MI.toast('打开文件失败：' + String(error?.message || error), 'err'); }
    // 等待读取期间用户可能切项目、再开弹窗或选另一份文档；迟到完成不能抢走焦点。
    if (generation !== state.generation || paths.key(App.root) !== paths.key(state.root) || Modal.stack.length
      || paths.key(Viewer.activeTab?.path) !== file.key) return;
    if (Viewer.cm?.__tab === Viewer.activeTab) Viewer.cm.focus();
    else Viewer.activeTab?.ta?.focus();
  }
  async function load(state) {
    state.loading = true; state.error = ''; render(state);
    const token = state.generation, root = state.root;
    if (!pending || pending.generation !== token) {
      const request = { generation: token }; pending = request;
      request.promise = (async () => {
        const response = await window.myIDE.fs.listAll(root, false);
        if (response?.error || !Array.isArray(response?.files)) throw new Error(response?.error || '无效的文件列表');
        const seen = new Set(), files = [];
        for (const path of response.files) {
          if (!paths.contains(root, path) || seen.has(paths.key(path))) continue;
          seen.add(paths.key(path)); files.push(descriptor(path, root));
        }
        const index = { root, files, truncated: !!response.truncated };
        if (generation === token && paths.key(App.root) === paths.key(root)) cache = index;
        return index;
      })().finally(() => { if (pending === request) pending = null; });
    }
    try { const index = await pending.promise; if (current(state) && state.generation === token) state.index = index; }
    catch (error) { if (current(state) && state.generation === token) state.error = String(error?.message || error); }
    if (current(state) && state.generation === token) { state.loading = false; render(state); }
  }
  async function open() {
    if (!App.root) { MI.toast('请先打开一个文件夹', 'err'); return; }
    if (panel && current(panel)) { if (top(panel.box)) panel.input.focus(); return; }
    const box = document.createElement('div'); box.id = 'qo-box'; box.dataset.selfEsc = '1';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'qo-title');
    box.innerHTML = `<div class="qo-head"><span id="qo-title">快速打开</span><button id="qo-close" class="tb-btn" aria-label="关闭快速打开">关闭</button></div>
      <input id="qo-input" type="text" placeholder="输入文件名，支持模糊匹配…" autocomplete="off" spellcheck="false" aria-label="查找文件" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="qo-list">
      <div id="qo-list" role="listbox" aria-label="文件结果"></div>
      <div id="qo-status" role="status"></div><button id="qo-retry" class="tb-btn" hidden>重试读取文件列表</button>
      <div class="qo-foot">${Viewer.previewEnabled()?'Enter 临时预览 · Shift+Enter 保留':'↑↓ 选择 · Enter 打开'} · Esc 关闭</div>`;
    const state = { box, root: App.root, generation, origin: document.activeElement, tabId: Viewer.activeTab?.id,
      input: box.querySelector('#qo-input'), list: box.querySelector('#qo-list'), status: box.querySelector('#qo-status'),
      retry: box.querySelector('#qo-retry'), index: cache, results: [], selected: -1, loading: false, error: '', composing: false, restore: true };
    panel = state;
    state.inert = [...document.body.children, ...Modal.stack].filter(element => element.id !== 'modal-mask' && element.id !== 'toast-wrap')
      .map(element => [element, element.hasAttribute('inert')]);
    state.inert.forEach(([element]) => element.setAttribute('inert', ''));
    box.onModalHide = () => cleanup(state); Modal.show(box);
    state.input.addEventListener('input', () => render(state, true));
    state.input.addEventListener('compositionstart', () => { state.composing = true; });
    state.input.addEventListener('compositionend', () => { state.composing = false; });
    state.onKey = event => {
      if (!current(state) || !top(box)) return;
      if (state.composing || event.isComposing || event.keyCode === 229) { event.stopImmediatePropagation(); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(state); }
      else if (event.key === 'Tab') {
        event.preventDefault(); event.stopImmediatePropagation();
        const controls = [state.input, ...(state.retry.hidden ? [] : [state.retry]), box.querySelector('#qo-close')];
        const i = controls.indexOf(document.activeElement), step = event.shiftKey ? -1 : 1;
        controls[(i + step + controls.length) % controls.length].focus();
      } else if (event.target === state.input && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === 'Enter') pick(state,state.selected,event.shiftKey?'regular':'browse');
        else setSelection(state, state.selected + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.ctrlKey || event.metaKey || event.altKey) event.stopImmediatePropagation();
    };
    document.addEventListener('keydown', state.onKey, true);
    // 编辑器挂载后的延迟focus不能把正在查询的人拉回背景；叠层时只守栈顶。
    state.onFocus = event => { if (current(state) && top(box) && !box.contains(event.target)) state.input.focus(); };
    document.addEventListener('focusin', state.onFocus, true);
    box.querySelector('#qo-close').onclick = () => close(state);
    state.retry.onclick = () => { if (current(state) && top(box) && !state.loading) load(state); };
    render(state); state.input.focus(); if (!state.index) await load(state);
  }
  function invalidate(projectChanged = false) {
    if (panel && projectChanged) {
      const state = panel, index = Modal.stack.indexOf(state.box); state.restore = false;
      if (top(state.box)) Modal.hide();
      else { if (index >= 0) Modal.stack.splice(index, 1); state.box.remove(); cleanup(state); }
    }
    generation++; cache = null; pending = null;
    // fs.watch连正文保存也会通知；同项目刷新保留查询/焦点，只有切项目才关闭面板。
    if (panel) { panel.generation = generation; panel.index = null; load(panel); }
  }
  return { open, invalidate };
})();
window.QuickOpen = QuickOpen;

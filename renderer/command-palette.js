// 命令只保留id和打开时的上下文；执行/键位仍归Shortcuts，避免复制一套动作。
const CommandPalette = (() => {
  let panel = null;
  const groups = ['项目', '文件', '编辑', '工作台', '阅读'];
  const current = state => panel === state && state.box.isConnected;
  const top = state => Modal.stack[Modal.stack.length - 1] === state.box;
  function score(query, command) {
    if (!query) return 0;
    const label = command.label.toLowerCase(), aliases = command.aliases.map(alias => alias.toLowerCase());
    const terms = [label, ...aliases, command.category.toLowerCase(), command.id];
    if (!query.split(/\s+/).every(token => terms.some(term => term.includes(token)))) return -1;
    if (label === query) return 1000;
    if (label.startsWith(query)) return 800;
    if (label.includes(query)) return 600;
    if (aliases.includes(query)) return 500;
    if (aliases.some(alias => alias.startsWith(query))) return 400;
    return 200;
  }
  function select(state, index) {
    state.selected = state.results.length ? Math.max(0, Math.min(index, state.results.length - 1)) : -1;
    const rows = [...state.list.querySelectorAll('.cp-item')];
    rows.forEach((row, i) => { row.classList.toggle('sel', i === state.selected); row.setAttribute('aria-selected', String(i === state.selected)); });
    const row = rows[state.selected], command = state.results[state.selected];
    if (row) { state.input.setAttribute('aria-activedescendant', row.id); row.scrollIntoView?.({ block: 'nearest' }); }
    else state.input.removeAttribute('aria-activedescendant');
    state.status.textContent = command && !command.enabled ? command.reason : state.results.length ? '显示 ' + state.results.length + ' 项，最多 30 项' : '没有匹配的命令';
  }
  function render(state, reset = false) {
    if (!current(state)) return;
    const selected = state.results[state.selected]?.id, query = state.input.value.trim().toLowerCase();
    const commands = Shortcuts.commands(state.context).map(command => ({ ...command, score: score(query, command) }));
    state.results = commands.filter(command => command.score >= 0).sort((a, b) => b.score - a.score
      || (groups.indexOf(a.category) < 0 ? groups.length : groups.indexOf(a.category)) - (groups.indexOf(b.category) < 0 ? groups.length : groups.indexOf(b.category))
      || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0)
      || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 30);
    state.list.replaceChildren(); let group = null;
    state.results.forEach((command, i) => {
      if (!query && group !== command.category) {
        group = command.category; const heading = document.createElement('div'); heading.className = 'cp-group'; heading.textContent = group;
        heading.setAttribute('role', 'presentation'); state.list.appendChild(heading);
      }
      const row = document.createElement('div'); row.className = 'cp-item'; row.id = 'command-option-' + i; row.dataset.action = command.id;
      row.setAttribute('role', 'option'); row.setAttribute('aria-disabled', String(!command.enabled));
      const line = document.createElement('div'); line.className = 'cp-line';
      const label = document.createElement('span'); label.className = 'cp-label'; label.textContent = command.label;
      const keys = document.createElement('span'); keys.className = 'cp-keys'; keys.textContent = command.combos.length ? command.combos.join(' / ').replace(/\+/g, ' + ') : '未设置快捷键'; keys.title = keys.textContent;
      line.append(label, keys); row.appendChild(line);
      if (!command.enabled) {
        const reason = document.createElement('div'); reason.className = 'cp-reason'; reason.id = row.id + '-reason'; reason.textContent = command.reason;
        row.setAttribute('aria-describedby', reason.id); row.appendChild(reason);
      }
      row.onmouseenter = () => { if (current(state) && top(state)) select(state, i); };
      row.onclick = () => accept(state, command.id); state.list.appendChild(row);
    });
    if (!state.results.length) { const empty = document.createElement('div'); empty.className = 'cp-empty'; empty.textContent = '没有匹配的命令'; state.list.appendChild(empty); }
    const failure = Shortcuts.lastFailure; state.failure.hidden = !failure;
    state.failureText.textContent = failure ? failure.label + '失败：' + failure.message + (failure.path || failure.root ? '\n执行位置：' + (failure.path || failure.root) : '') : '';
    select(state, reset ? 0 : Math.max(0, state.results.findIndex(command => command.id === selected)));
  }
  function restoreFocus(state) {
    if (DocumentPaths.key(App.root) !== DocumentPaths.key(state.context.root)) return;
    const other = Modal.stack[Modal.stack.length - 1], origin = state.context.invoker;
    if (origin?.isConnected && origin !== document.body && (!other || other.contains(origin))
      && (!origin.closest('.cm-editor') || Viewer.activeTab?.id === state.context.documentId)) origin.focus();
    else if (other) other.querySelector('input, textarea, button, [tabindex="0"]')?.focus();
    else if (Viewer.cm?.__tab === Viewer.activeTab && Viewer.cm.view?.dom.isConnected) Viewer.cm.focus();
    else document.getElementById('btn-commands')?.focus();
  }
  function cleanup(state) {
    if (state.closed) return;
    state.closed = true; state.unsubscribe?.();
    document.removeEventListener('keydown', state.onKey, true); document.removeEventListener('focusin', state.onFocus, true); state.mask.removeEventListener('click', state.onMask);
    state.inert.forEach(([element, previous]) => previous ? element.setAttribute('inert', '') : element.removeAttribute('inert'));
    if (panel === state) panel = null;
    if (state.restore) restoreFocus(state);
  }
  function close(state) { if (current(state) && top(state)) Modal.hide(); }
  function accept(state, id = state.results[state.selected]?.id) {
    if (!current(state) || !top(state) || !id || state.accepting) return;
    const available = Shortcuts.availability(id, state.context);
    if (!available.enabled) { render(state); state.status.textContent = available.reason; return; }
    state.accepting = true; close(state);
    const operation = Shortcuts.execute(id, state.context);
    // 同步打开的搜索/设置接收输入；异步结束不再抢焦点或重开原面板。
    const opened = Modal.stack[Modal.stack.length - 1];
    if (opened && !opened.contains(document.activeElement)) {
      // 主题页首个input是隐藏的文件选择器，直接focus会把输入留在刚恢复的工具栏。
      const control = [...opened.querySelectorAll('input:not([disabled]), textarea:not([disabled]), button:not([disabled])')]
        .find(element => element.type !== 'hidden' && !element.hidden && element.getClientRects().length
          && getComputedStyle(element).visibility !== 'hidden');
      if (control) control.focus();
      else { opened.tabIndex = -1; opened.focus(); }
    }
    return operation;
  }
  function open() {
    if (panel && current(panel)) { if (top(panel)) panel.input.focus(); return; }
    const box = document.createElement('div'); box.id = 'command-box'; box.dataset.selfEsc = '1';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'command-title');
    box.innerHTML = `<div class="cp-head"><span id="command-title">查找命令</span><button id="command-close" class="tb-btn">关闭</button></div>
      <div id="command-context"></div><div id="command-failure" hidden><div id="command-failure-text"></div><button id="command-clear" class="tb-btn">清除提示</button></div>
      <input id="command-input" placeholder="输入命令名称或别名…" aria-label="查找命令" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="command-list" aria-describedby="command-context command-status" autocomplete="off" spellcheck="false">
      <div id="command-list" role="listbox" aria-label="命令结果"></div><div id="command-status" role="status"></div><div class="cp-foot">↑↓ 选择 · Enter 执行 · Esc 关闭</div>`;
    const state = { box, context: { ...Shortcuts.context(), source: 'palette' }, mask: document.getElementById('modal-mask'),
      input: box.querySelector('#command-input'), list: box.querySelector('#command-list'), status: box.querySelector('#command-status'),
      failure: box.querySelector('#command-failure'), failureText: box.querySelector('#command-failure-text'), results: [], selected: -1, composing: false, restore: true };
    panel = state;
    const location = box.querySelector('#command-context'); location.textContent = state.context.path || state.context.root || '未打开项目'; location.title = location.textContent;
    state.inert = [...document.body.children, ...Modal.stack].filter(element => element.id !== 'modal-mask' && element.id !== 'toast-wrap').map(element => [element, element.hasAttribute('inert')]);
    state.inert.forEach(([element]) => element.setAttribute('inert', ''));
    box.onModalHide = () => cleanup(state); Modal.show(box);
    state.onKey = event => {
      if (!current(state) || !top(state)) return;
      if (state.composing || event.isComposing || event.keyCode === 229) { event.stopImmediatePropagation(); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(state); }
      else if (event.key === 'Tab') {
        event.preventDefault(); event.stopImmediatePropagation();
        const controls = [box.querySelector('#command-close'), ...(state.failure.hidden ? [] : [box.querySelector('#command-clear')]), state.input];
        controls[(controls.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
      } else if (event.target === state.input && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === 'Enter') accept(state); else select(state, state.selected + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.ctrlKey || event.metaKey || event.altKey) event.stopImmediatePropagation();
    };
    state.onFocus = event => { if (current(state) && top(state) && !box.contains(event.target)) state.input.focus(); };
    state.onMask = event => { if (event.target === state.mask) close(state); };
    document.addEventListener('keydown', state.onKey, true); document.addEventListener('focusin', state.onFocus, true); state.mask.addEventListener('click', state.onMask);
    box.querySelector('#command-close').onclick = () => close(state); box.querySelector('#command-clear').onclick = () => Shortcuts.clearFailure();
    state.input.addEventListener('input', () => render(state, true));
    state.input.addEventListener('compositionstart', () => { state.composing = true; }); state.input.addEventListener('compositionend', () => { state.composing = false; });
    state.unsubscribe = Shortcuts.onChanged(() => render(state)); render(state); state.input.focus();
  }
  function invalidate() {
    if (!panel) return;
    const state = panel; state.restore = false;
    if (top(state)) Modal.hide();
    else { const index = Modal.stack.indexOf(state.box); if (index >= 0) Modal.stack.splice(index, 1); state.box.remove(); cleanup(state); }
  }
  return { open, invalidate };
})();
window.CommandPalette = CommandPalette;

// search.js —— Ctrl+Shift+F 内容搜索
const Search = (() => {
  let timer = null;
  let results = [];
  let sel = 0;

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function build() {
    const box = document.createElement('div');
    box.id = 'sr-box';
    box.innerHTML = `
      <div class="qo-head">搜索内容（Ctrl+Shift+F）</div>
      <input id="sr-input" type="text" placeholder="输入要搜索的文字…" autocomplete="off" spellcheck="false">
      <div id="sr-list"></div>
      <div class="qo-foot">Enter 打开第一条 · ↑↓ 选择 · Esc 关闭</div>`;
    return box;
  }

  function renderEmpty(msg) {
    const list = document.getElementById('sr-list');
    list.innerHTML = `<div class="qo-empty">${esc(msg)}</div>`;
  }

  async function doSearch(q) {
    const list = document.getElementById('sr-list');
    if (!q) { renderEmpty('输入关键字开始搜索…'); return; }
    renderEmpty('搜索中…');
    const r = await window.myIDE.fs.grep(App.root, q);
    results = r.results;
    sel = 0;
    if (!results.length) { renderEmpty('没有匹配的内容'); return; }
    list.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'sr-stat';
    head.textContent = `${results.length} 条结果` + (r.truncated ? '（已截断）' : '') + ` · ${r.elapsed}ms`;
    list.appendChild(head);
    results.forEach((res, i) => {
      const row = document.createElement('div');
      row.className = 'qo-item' + (i === 0 ? ' sel' : '');
      row.innerHTML = `<span class="sr-file">${esc(res.file)}:${res.line}</span><span class="sr-text">${esc(res.text)}</span>`;
      row.onmouseenter = () => setSel(i);
      row.onclick = () => pick();
      list.appendChild(row);
    });
  }

  function setSel(i) {
    sel = i;
    const list = document.getElementById('sr-list');
    [...list.children].forEach((el, j) => {
      if (el.classList.contains('qo-item')) el.classList.toggle('sel', j === sel);
    });
  }

  function pick() {
    const res = results[sel];
    if (!res) return;
    Modal.hide();
    Viewer.openFile(App.root + '\\' + res.file);
    MI.toast('🔍 ' + res.file + ':' + res.line, 'ok');
  }

  function open() {
    if (!App.root) { MI.toast('请先打开一个文件夹', 'err'); return; }
    const box = build();
    Modal.show(box);
    const input = document.getElementById('sr-input');
    setTimeout(() => input.focus(), 30);
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value;
      timer = setTimeout(() => doSearch(q), 300); // 防抖
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(sel + 1, results.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(sel - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(); }
      else if (e.key === 'Escape') { e.preventDefault(); Modal.hide(); }
    });
    renderEmpty('输入关键字开始搜索…');
  }

  return { open };
})();
window.Search = Search;
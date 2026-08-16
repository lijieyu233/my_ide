// quickopen.js —— Ctrl+P 快速打开文件（PyCharm Go to File 的轻量版）
const QuickOpen = (() => {
  const mask = document.getElementById('modal-mask');
  let files = null; // [{name, rel, path}]
  let sel = 0;
  let results = [];

  const BASENAME = /[\\/]([^\\/]+)$/;

  async function load() {
    const root = App.root;
    if (!root) return [];
    const r = await window.myIDE.fs.listAll(root, false);
    if (r.truncated) MI.toast('文件过多，仅索引前 5 万个', 'err');
    return r.files.map((full) => {
      const rel = full.slice(root.length).replace(/^[\\/]/, '');
      const m = BASENAME.exec(rel);
      return { name: m ? m[1] : rel, rel, path: full };
    });
  }

  // 轻量模糊评分：连续子串 > 字符序列；文件名命中 > 路径命中
  function score(q, f) {
    const ql = q.toLowerCase();
    const nameL = f.name.toLowerCase();
    const fullL = (f.name + ' ' + f.rel).toLowerCase();
    let base = 0;
    if (nameL.includes(ql)) base = 500; // 文件名连续子串
    else if (fullL.includes(ql)) base = 200; // 路径连续子串
    // 字符序列（分散匹配）
    let seq = 0, pos = 0, ok = true;
    for (const ch of ql) {
      const i = fullL.indexOf(ch, pos);
      if (i < 0) { ok = false; break; }
      seq += i === pos ? 10 : 1;
      pos = i + 1;
    }
    if (!ok && !base) return -1;
    return base + seq;
  }

  function build() {
    const box = document.createElement('div');
    box.id = 'qo-box';
    box.innerHTML = `
      <div class="qo-head">快速打开（Ctrl+P）</div>
      <input id="qo-input" type="text" placeholder="输入文件名，支持模糊匹配…" autocomplete="off" spellcheck="false">
      <div id="qo-list"></div>
      <div class="qo-foot">↑↓ 选择 · Enter 打开 · Esc 关闭</div>`;
    return box;
  }

  function render(q) {
    const list = document.getElementById('qo-list');
    const ql = q.trim().toLowerCase();
    results = [];
    if (!ql) {
      // 最近打开的文件
      const recent = Viewer.recentFiles();
      if (!recent.length) { list.innerHTML = '<div class="qo-empty">输入关键字开始搜索…</div>'; return; }
      list.innerHTML = '<div class="sr-stat">最近打开</div>';
      recent.forEach((r, i) => {
        const name = r.path.split(/[\\/]/).pop();
        const row = document.createElement('div');
        row.className = 'qo-item';
        row.innerHTML = `<span class="qo-name">${esc(name)}</span><span class="qo-rel">${esc(r.path)}</span>`;
        row.onclick = () => { Modal.hide(); Viewer.openFile(r.path); };
        list.appendChild(row);
      });
      return;
    }
    for (const f of files) {
      const s = score(ql, f);
      if (s > 0) results.push({ f, s });
      if (results.length > 400) break; // 匹配过多时提前截断
    }
    results.sort((a, b) => b.s - a.s);
    results = results.slice(0, 30);
    sel = 0;
    list.innerHTML = '';
    results.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'qo-item' + (i === 0 ? ' sel' : '');
      row.innerHTML = `<span class="qo-name">${esc(r.f.name)}</span><span class="qo-rel">${esc(r.f.rel)}</span>`;
      row.onmouseenter = () => setSel(i);
      row.onclick = () => pick();
      list.appendChild(row);
    });
    if (!results.length) list.innerHTML = '<div class="qo-empty">没有匹配的文件</div>';
  }

  function setSel(i) {
    sel = i;
    const list = document.getElementById('qo-list');
    [...list.children].forEach((el, j) => el.classList.toggle('sel', j === sel));
  }

  function pick() {
    const r = results[sel];
    if (!r) return;
    Modal.hide();
    Viewer.openFile(r.f.path);
    MI.copyText(r.f.path);
    MI.toast('📋 已复制完整路径\n' + r.f.path, 'ok');
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  async function open() {
    if (!App.root) { MI.toast('请先打开一个文件夹', 'err'); return; }
    if (!files) files = await load();
    const box = build();
    Modal.show(box);
    files = files || [];
    const input = document.getElementById('qo-input');
    setTimeout(() => input.focus(), 30);
    input.addEventListener('input', () => render(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(sel + 1, results.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(sel - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(); }
      else if (e.key === 'Escape') { e.preventDefault(); Modal.hide(); }
    });
    render('');
  }

  function invalidate() { files = null; }

  return { open, invalidate };
})();
window.QuickOpen = QuickOpen;
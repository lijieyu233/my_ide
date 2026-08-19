// settings.js —— 设置页面（PyCharm Settings 风格：左分类 + 右内容）
const Settings = (() => {
  let listening = null; // 正在修改的动作 id
  let keysFilter = '';  // 快捷键过滤词

  function open() {
    const box = document.createElement('div');
    box.id = 'set-box';
    box.innerHTML = `
      <div class="m-head">⚙️ 设置 <span class="x" id="set-x">✕</span></div>
      <div class="set-body">
        <div class="set-side">
          <div class="set-cat active" data-cat="keys">⌨️ 快捷键</div>
          <div class="set-cat" data-cat="font">🔤 外观</div>
          <div class="set-cat" data-cat="git">🔀 Git</div>
          <div class="set-cat" data-cat="theme">🎨 主题</div>
        </div>
        <div class="set-main" id="set-main">
          <div class="set-toolbar">
            <span class="set-title" id="set-title">快捷键（点击按键可修改）</span>
            <span class="spacer"></span>
            <button class="tb-btn" id="set-reset-all">恢复全部默认</button>
          </div>
          <div id="set-list"></div>
          <div class="set-hint" id="set-hint">点击动作右侧的按键 → 按下新组合键完成修改 · Esc 取消</div>
        </div>
      </div>`;
    Modal.show(box);
    document.getElementById('set-x').onclick = () => Modal.hide();
    document.getElementById('set-reset-all').onclick = () => {
      Shortcuts.resetAll();
      renderList();
      MI.toast('已恢复全部默认快捷键', 'ok');
    };
    // 分类切换
    $all('.set-cat[data-cat]').forEach((cat) => {
      cat.onclick = () => {
        $all('.set-cat').forEach((x) => x.classList.remove('active'));
        cat.classList.add('active');
        if (cat.dataset.cat === 'keys') renderKeys();
        else if (cat.dataset.cat === 'font') renderFont();
        else if (cat.dataset.cat === 'git') renderGit();
        else if (cat.dataset.cat === 'theme') renderTheme();
      };
    });
    renderKeys();
  }

  function $all(sel) { return [...document.querySelectorAll(sel)]; }

  // ---------- 快捷键视图 ----------
  function renderKeys() {
    document.getElementById('set-title').textContent = '快捷键（点击按键可修改）';
    document.getElementById('set-hint').textContent = '点击动作右侧的按键 → 按下新组合键完成修改 · Esc 取消';
    document.getElementById('set-reset-all').classList.remove('hidden');
    const list = document.getElementById('set-list');
    if (!document.getElementById('set-keys-filter')) {
      const filter = document.createElement('input');
      filter.id = 'set-keys-filter';
      filter.type = 'text';
      filter.placeholder = '🔍 过滤动作…';
      filter.value = keysFilter;
      filter.addEventListener('input', () => { keysFilter = filter.value; renderList(); });
      list.parentElement.insertBefore(filter, list);
    }
    renderList();
  }

  // ---------- 外观视图（字体大小） ----------
  function renderFont() {
    const f = document.getElementById('set-keys-filter');
    if (f) f.remove(); // 快捷键过滤框不属于本视图
    document.getElementById('set-title').textContent = '外观（字体大小）';
    document.getElementById('set-hint').textContent = '拖动滑块调整界面与编辑器字号，即时生效并保存（Ctrl+= / Ctrl+- 也可调整）';
    document.getElementById('set-reset-all').classList.add('hidden');
    const list = document.getElementById('set-list');
    let size = 13;
    try { size = parseInt(localStorage.getItem('myide-editor-font') || '13', 10) || 13; } catch {}
    list.innerHTML = `
      <div class="set-form">
        <label class="m-label">字体大小：<span id="font-size-val">${size}</span> px</label>
        <input id="font-size-range" type="range" min="10" max="20" step="1" value="${size}" style="width:100%">
        <div style="display:flex;justify-content:space-between;color:var(--text-dim);font-size:11px;margin-top:2px">
          <span>10px 小</span><span>13px 默认</span><span>20px 大</span>
        </div>
        <div style="margin-top:14px">
          <button class="tb-btn m-ok" id="font-reset">恢复默认 (13px)</button>
        </div>
      </div>`;
    const range = document.getElementById('font-size-range');
    range.addEventListener('input', () => {
      const v = parseInt(range.value, 10);
      document.getElementById('font-size-val').textContent = v;
      if (window.Viewer) Viewer.applyFontSize(v);
    });
    document.getElementById('font-reset').onclick = () => {
      range.value = 13;
      document.getElementById('font-size-val').textContent = 13;
      if (window.Viewer) Viewer.applyFontSize(13);
      MI.toast('已恢复默认字号', 'ok');
    };
  }

  // ---------- 主题视图 ----------
  function renderTheme() {
    const f = document.getElementById('set-keys-filter');
    if (f) f.remove(); // 快捷键过滤框不属于本视图
    document.getElementById('set-title').textContent = '主题';
    document.getElementById('set-hint').textContent = '选择界面配色，即时生效并保存';
    document.getElementById('set-reset-all').classList.add('hidden');
    const list = document.getElementById('set-list');
    const cur = Theme.current();
    list.innerHTML = `
      <div class="set-form">
        <div class="theme-options">
          <button class="theme-opt ${cur === 'dark' ? 'sel' : ''}" data-th="dark">🌙 深色</button>
          <button class="theme-opt ${cur === 'light' ? 'sel' : ''}" data-th="light">☀️ 浅色</button>
          <button class="theme-opt ${cur === 'pink' ? 'sel' : ''}" data-th="pink">🌸 粉红</button>
          <button class="theme-opt ${cur === 'crimson' ? 'sel' : ''}" data-th="crimson">🌹 深红</button>
        </div>
      </div>`;
    $all('.theme-opt').forEach((b) => {
      b.onclick = () => {
        Theme.set(b.dataset.th);
        $all('.theme-opt').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
        MI.toast('已切换为' + Theme.name(b.dataset.th) + '主题', 'ok');
      };
    });
  }

  // ---------- Git 视图 ----------
  async function renderGit() {
    const f = document.getElementById('set-keys-filter');
    if (f) f.remove(); // 快捷键过滤框不属于本视图
    document.getElementById('set-title').textContent = 'Git 配置（提交作者信息）';
    document.getElementById('set-hint').textContent = '保存后写入当前仓库 .git/config，下次提交生效';
    document.getElementById('set-reset-all').classList.add('hidden');
    const list = document.getElementById('set-list');
    list.innerHTML = '<div class="git-empty">加载中…</div>';
    const cfg = await window.myIDE.git.getUserConfig(App.root);
    if (!cfg.isRepo) {
      list.innerHTML = '<div class="git-empty">当前项目不是 Git 仓库</div>';
      return;
    }
    list.innerHTML = `
      <div class="set-form">
        <label class="m-label">用户名</label>
        <input id="git-cfg-name" type="text" placeholder="如：zhangsan" value="${esc(cfg.name)}">
        <label class="m-label">邮箱</label>
        <input id="git-cfg-email" type="text" placeholder="如：zhangsan@example.com" value="${esc(cfg.email)}">
        <div style="margin-top:14px">
          <button class="tb-btn m-ok" id="git-cfg-save">保存</button>
        </div>
      </div>`;
    document.getElementById('git-cfg-save').onclick = async () => {
      const name = document.getElementById('git-cfg-name').value.trim();
      const email = document.getElementById('git-cfg-email').value.trim();
      if (!name || !email) { MI.toast('用户名和邮箱不能为空', 'err'); return; }
      const r = await window.myIDE.git.setUserConfig(App.root, { name, email });
      if (r.ok) MI.toast('✅ Git 配置已保存，下次提交生效', 'ok');
      else MI.toast('保存失败: ' + r.error, 'err');
    };
  }

  function renderList() {
    const list = document.getElementById('set-list');
    if (!list) return;
    list.innerHTML = '';
    const q = keysFilter.trim().toLowerCase();
    for (const b of Shortcuts.bindings()) {
      if (q && !(b.desc + ' ' + b.id + ' ' + b.combos.join(' ')).toLowerCase().includes(q)) continue;
      const row = document.createElement('div');
      row.className = 'set-row';
      const info = document.createElement('div');
      info.className = 'set-info';
      info.innerHTML = `<div class="set-name">${esc(b.id === 'settings' ? '⚙️ 设置' : b.id)}</div><div class="set-desc">${esc(b.desc)}</div>`;
      const comboBtn = document.createElement('button');
      comboBtn.className = 'set-combo' + (listening === b.id ? ' listening' : '');
      comboBtn.textContent = listening === b.id ? '按下新组合键…' : b.combos.join(' / ').replace(/\+/g, ' + ');
      comboBtn.onclick = () => startListen(b.id, comboBtn);
      const resetBtn = document.createElement('button');
      resetBtn.className = 'set-reset' + (b.custom ? '' : ' hidden');
      resetBtn.textContent = '恢复默认';
      resetBtn.onclick = () => { Shortcuts.reset(b.id); renderList(); };
      row.appendChild(info);
      row.appendChild(resetBtn);
      row.appendChild(comboBtn);
      list.appendChild(row);
    }
  }

  function startListen(id, btn) {
    listening = id;
    renderList();
    Shortcuts.captureNext((combo) => {
      listening = null;
      if (!combo) { renderList(); return; } // Esc 取消
      if (combo === 'escape') { renderList(); return; }
      const conflict = Shortcuts.setBinding(id, combo);
      renderList();
      if (conflict) MI.toast('⚠️ 与「' + conflict + '」冲突，已覆盖', 'err');
      else MI.toast('✅ 已设置为 ' + combo.replace(/\+/g, ' + '), 'ok');
    });
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  return { open };
})();
window.Settings = Settings;
// settings.js —— 设置页面（PyCharm Settings 风格：左分类 + 右内容）
const Settings = (() => {
  let listening = null; // 正在修改的动作 id

  function open() {
    const box = document.createElement('div');
    box.id = 'set-box';
    box.innerHTML = `
      <div class="m-head">⚙️ 设置 <span class="x" id="set-x">✕</span></div>
      <div class="set-body">
        <div class="set-side">
          <div class="set-cat active">⌨️ 快捷键</div>
          <div class="set-cat dim" title="敬请期待">🎨 主题</div>
        </div>
        <div class="set-main">
          <div class="set-toolbar">
            <span class="set-title">快捷键（点击按键可修改）</span>
            <span class="spacer"></span>
            <button class="tb-btn" id="set-reset-all">恢复全部默认</button>
          </div>
          <div id="set-list"></div>
          <div class="set-hint">点击动作右侧的按键 → 按下新组合键完成修改 · Esc 取消</div>
        </div>
      </div>`;
    Modal.show(box);
    document.getElementById('set-x').onclick = () => Modal.hide();
    document.getElementById('set-reset-all').onclick = () => {
      Shortcuts.resetAll();
      renderList();
      MI.toast('已恢复全部默认快捷键', 'ok');
    };
    renderList();
  }

  function renderList() {
    const list = document.getElementById('set-list');
    if (!list) return;
    list.innerHTML = '';
    for (const b of Shortcuts.bindings()) {
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
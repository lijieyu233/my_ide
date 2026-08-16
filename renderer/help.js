// help.js —— F1 帮助页：快捷键速查（动态反映自定义）
const Help = (() => {
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function open() {
    const box = document.createElement('div');
    box.id = 'help-box';
    Modal.show(box);
    const rows = Shortcuts.bindings()
      .map((b) => `<tr><td>${esc(b.desc)}</td><td class="help-keys">${esc(b.combos.join(' / ').replace(/\+/g, ' + '))}</td></tr>`)
      .join('');
    box.innerHTML = `
      <div class="m-head">ℹ️ 帮助与快捷键 <span class="x" id="help-x">✕</span></div>
      <div class="help-body">
        <div class="help-ver" id="help-ver">加载中…</div>
        <table class="help-table">
          <tr><th>动作</th><th>快捷键</th></tr>
          ${rows}
        </table>
        <div class="help-hint">
          📌 技巧：单击文件即复制完整路径 · 中键关闭标签 · 标签可拖拽排序 · Ctrl+Alt+S 自定义快捷键 · Ctrl+P 快速打开
        </div>
      </div>`;
    document.getElementById('help-x').onclick = () => Modal.hide();
    // 版本信息
    window.myIDE.appInfo().then((info) => {
      const el = document.getElementById('help-ver');
      if (el && info) el.textContent = 'My IDE v' + info.version + (info.commit ? ' (' + info.commit + ')' : '');
    }).catch(() => {});
  }

  return { open };
})();
window.Help = Help;
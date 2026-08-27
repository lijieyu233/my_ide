// translate.js —— 翻译插件：选中文本 → Ctrl+Alt+T → LLM 翻译（OpenAI 兼容接口）
// 配置在 设置 → 翻译（服务地址 / API Key / 模型 / 目标语言），请求走主进程 llm:chat
const Translate = (() => {
  const CFG_KEY = 'myide-translate-cfg';

  function getConfig() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch { return {}; }
  }
  function setConfig(c) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(c || {})); } catch {}
  }

  // 获取当前选中文本：CM6 编辑器（md/code）→ 输入框 → 页面选区
  function selectionText() {
    try {
      const cm = window.Viewer && Viewer.cm;
      if (cm && cm.view && cm.view.hasFocus) {
        const s = cm.view.state.selection.main;
        if (!s.empty) return cm.view.state.sliceDoc(s.from, s.to);
      }
    } catch {}
    const ae = document.activeElement;
    if (ae && /^(TEXTAREA|INPUT)$/.test(ae.tagName) &&
        ae.selectionStart != null && ae.selectionEnd > ae.selectionStart) {
      return ae.value.slice(ae.selectionStart, ae.selectionEnd);
    }
    const sel = window.getSelection && window.getSelection();
    return sel ? String(sel) : '';
  }

  async function run() {
    const src = (selectionText() || '').trim();
    if (!src) { MI.toast('请先选中文本再翻译', 'err'); return; }
    const cfg = getConfig();
    if (!cfg.baseUrl || !cfg.model) {
      MI.toast('请先配置 LLM：设置 → 翻译', 'err');
      if (window.Settings) Settings.open('translate');
      return;
    }
    showBox(src, '⏳ 翻译中…');
    const target = cfg.target || '中文';
    const r = await window.myIDE.llm.chat(cfg, [
      {
        role: 'system',
        content: '你是翻译引擎。将用户文本翻译成' + target +
          '。只输出译文本身，不要任何解释、原文复读或额外标记。若原文已是' + target + '则原样返回。',
      },
      { role: 'user', content: src },
    ]);
    if (r && r.error) { showBox(src, '❌ ' + r.error); return; }
    showBox(src, (r && r.text) || '(空响应)');
  }

  // ---------- 结果弹窗（原文 + 译文 + 复制） ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let box = null;
  function closeBox() {
    if (!box) return;
    // 栈顶时用 Modal.hide 弹栈；被覆盖时直接移除（防错杀上层面板）
    if (window.Modal && Modal.stack[Modal.stack.length - 1] === box) Modal.hide();
    else box.remove();
    box = null;
  }
  function showBox(src, result) {
    closeBox();
    box = document.createElement('div');
    box.className = 'modal-panel tr-box';
    box.innerHTML = `
      <div class="m-head">🌐 翻译成 ${esc(getConfig().target || '中文')} <span class="x" id="tr-x">✕</span></div>
      <div class="tr-body">
        <div class="tr-src">${esc(src)}</div>
        <div class="tr-arrow">↓</div>
        <div class="tr-dst">${esc(result)}</div>
      </div>
      <div class="m-foot">
        <button class="tb-btn" id="tr-copy">复制译文</button>
        <button class="tb-btn m-ok" id="tr-close">关闭</button>
      </div>`;
    Modal.show(box);
    box.querySelector('#tr-x').onclick = closeBox;
    box.querySelector('#tr-close').onclick = closeBox;
    box.querySelector('#tr-copy').onclick = () => {
      MI.copyText(box.querySelector('.tr-dst').textContent).then(() => MI.toast('已复制译文', 'ok'));
    };
    // 面板自管 Esc：全局 shortcuts 的 Esc 不处理「非 selfEsc」以外逻辑，
    // 不设 selfEsc 时全局 Esc 走 Modal.hide（无 promise 挂起，安全）
  }

  return { run, getConfig, setConfig };
})();
window.Translate = Translate;

// 快捷键注册（Shortcuts.register 内部 rebuild，任意时机可调）
if (window.Shortcuts) {
  Shortcuts.register('translate', {
    desc: '翻译选中文本（LLM）',
    keys: ['ctrl+alt+t'],
    run: () => Translate.run(),
  });
}

// translate.js —— 翻译插件：选中文本 → Ctrl+Alt+T → LLM 翻译（OpenAI 兼容接口）
// 配置在 设置 → 翻译（服务地址 / API Key / 模型 / 目标语言），请求走主进程 llm:chat
//
// 弹窗三件事（用户反馈）：
//   ① 必须居中 —— 根因是 #modal-mask 里遗留了一个空的 560px 宽 #modal-box（旧版 Modal 的容器），
//      它作为一个 flex 子项占着整行，把弹窗整体挤偏。已把那个空 div 从 HTML/CSS 删掉。
//   ② 原文框可以自己填 —— .tr-src 从 div 改成 textarea（未选中文本时进来就是空的，直接写/粘贴）。
//   ③ 未选中文本按快捷键也能弹 —— 原实现只弹个 toast 就 return，现在照常开框。
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

  // srcOverride：外部直接给原文（自检 / 以后的右键菜单「翻译这段」用）
  function run(srcOverride) {
    const cfg = getConfig();
    if (!cfg.baseUrl || !cfg.model) {
      MI.toast('请先配置 LLM：设置 → 翻译', 'err');
      if (window.Settings) Settings.open('translate');
      return;
    }
    const src = String(srcOverride != null ? srcOverride : (selectionText() || '')).trim();
    showBox(src);   // 未选中文本也照常开框（原实现只弹 toast 不打开，用户明确要求改）
  }

  // ---------- 结果弹窗（原文可编辑 + 译文 + 复制） ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let box = null;
  let busy = false;
  function closeBox() {
    if (!box) return;
    // 栈顶时用 Modal.hide 弹栈；被覆盖时直接移除（防错杀上层面板）
    if (window.Modal && Modal.stack[Modal.stack.length - 1] === box) Modal.hide();
    else box.remove();
    box = null;
    busy = false;
  }

  function showBox(initialSrc) {
    closeBox();
    box = document.createElement('div');
    box.className = 'modal-panel tr-box';
    // 自管 Esc：焦点在文本框里时也关掉（否则全局 Esc 的语义在这里就不一致了）
    box.dataset.selfEsc = '1';
    box.innerHTML = `
      <div class="m-head">🌐 翻译成 ${esc(getConfig().target || '中文')} <span class="x" id="tr-x">✕</span></div>
      <div class="tr-body">
        <textarea class="tr-src" id="tr-src" spellcheck="false" rows="3"
          placeholder="输入或粘贴要翻译的文本（未选中文本时直接在这里写）"></textarea>
        <div class="tr-arrow">↓</div>
        <div class="tr-dst" id="tr-dst"></div>
      </div>
      <div class="m-foot">
        <span class="tr-hint">Ctrl+Enter 翻译</span>
        <button class="tb-btn" id="tr-copy">复制译文</button>
        <button class="tb-btn" id="tr-do">翻译</button>
        <button class="tb-btn m-ok" id="tr-close">关闭</button>
      </div>`;
    Modal.show(box);

    const srcEl = box.querySelector('#tr-src');
    const dstEl = box.querySelector('#tr-dst');
    srcEl.value = initialSrc || '';

    async function doTranslate() {
      if (busy) return;
      const src = srcEl.value.trim();
      if (!src) { MI.toast('请输入要翻译的文本', 'err'); srcEl.focus(); return; }
      const cfg = getConfig();
      const target = cfg.target || '中文';
      busy = true;
      dstEl.classList.add('tr-pending');
      dstEl.textContent = '⏳ 翻译中…';
      let r;
      try {
        r = await window.myIDE.llm.chat(cfg, [
          {
            role: 'system',
            content: '你是翻译引擎。将用户文本翻译成' + target +
              '。只输出译文本身，不要任何解释、原文复读或额外标记。若原文已是' + target + '则原样返回。',
          },
          { role: 'user', content: src },
        ]);
      } catch (e) { r = { error: (e && e.message) || String(e) }; }
      busy = false;
      if (!box || !box.isConnected) return;   // 期间被关掉了
      dstEl.classList.remove('tr-pending');
      dstEl.textContent = (r && r.error) ? ('❌ ' + r.error) : ((r && r.text) || '(空响应)');
    }

    box.querySelector('#tr-x').onclick = closeBox;
    box.querySelector('#tr-close').onclick = closeBox;
    box.querySelector('#tr-do').onclick = () => doTranslate();
    box.querySelector('#tr-copy').onclick = () => {
      const txt = dstEl.textContent || '';
      if (!txt.trim() || dstEl.classList.contains('tr-pending')) { MI.toast('还没有译文', 'err'); return; }
      MI.copyText(txt).then(() => MI.toast('已复制译文', 'ok'));
    };
    srcEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doTranslate(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeBox(); }
    });

    srcEl.focus();
    if (initialSrc) doTranslate();   // 带着选中文本进来的：直接翻，少一次点击
  }

  return { run, getConfig, setConfig, showBox, closeBox };
})();
window.Translate = Translate;

// 快捷键注册（Shortcuts.register 内部 rebuild，任意时机可调）
if (window.Shortcuts) {
  Shortcuts.register('translate', {
    desc: '翻译（选中文本直接翻；未选中则打开输入框）',
    keys: ['ctrl+alt+t'],
    run: () => Translate.run(),
  });
}

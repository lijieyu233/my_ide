// ai-panel.js —— AI 助手对话面板（右侧停靠，PyCharm AI Assistant 式）
// 流式对话：主进程 ai-service SSE → ai:chunk/ai:done 事件；配置存 localStorage（与翻译插件同模式）
const AiPanel = (() => {
  const panel = document.getElementById('ai-panel');
  const msgsEl = document.getElementById('ai-msgs');
  const inputEl = document.getElementById('ai-input');
  const sendBtn = document.getElementById('ai-send');
  const fileChip = document.getElementById('ai-file-chip');

  const LS_CFG = 'myide-ai-cfg';
  const LS_W = 'myide-ai-width';
  const MAX_CTX = 24000; // 附带文件内容上限（字符），防 token 爆炸

  let msgs = [];            // 会话历史 [{role, content}]
  let busy = false;         // 生成中（禁发）
  let ctxFile = null;       // 附带的当前文件 {path, content}
  let curStream = null;     // 流式中的气泡元素
  let curText = '';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function getConfig() {
    try { return JSON.parse(localStorage.getItem(LS_CFG) || '{}'); } catch { return {}; }
  }
  function setConfig(c) {
    try { localStorage.setItem(LS_CFG, JSON.stringify(c)); } catch {}
  }

  function syncVisible(v) {
    if (panel) panel.classList.toggle('hidden', !v);
    if (v && inputEl) inputEl.focus();
  }

  // ---------- 消息渲染 ----------
  function scrollBottom() {
    if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function renderMd(text) {
    try {
      const html = window.marked.parse(text || '');
      return hljsWrap(html);
    } catch { return '<p>' + esc(text) + '</p>'; }
  }
  // marked 输出的 <code> 块套 hljs 高亮（失败静默）
  function hljsWrap(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    if (window.hljs) {
      div.querySelectorAll('pre code').forEach((b) => {
        try { hljs.highlightElement(b); } catch {}
      });
    }
    return div.innerHTML;
  }

  function addMsg(role, text) {
    const row = document.createElement('div');
    row.className = 'ai-msg ' + (role === 'user' ? 'ai-user' : 'ai-assistant');
    if (role === 'user') {
      const pre = document.createElement('div');
      pre.className = 'ai-md';
      pre.innerHTML = '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
      row.appendChild(pre);
    } else {
      const pre = document.createElement('div');
      pre.className = 'ai-md';
      pre.innerHTML = renderMd(text);
      row.appendChild(pre);
    }
    msgsEl.appendChild(row);
    scrollBottom();
    return row;
  }

  function showWelcome() {
    const cfg = getConfig();
    const w = document.createElement('div');
    w.className = 'ai-welcome';
    w.innerHTML = `
      <div class="ai-logo">🤖</div>
      <div class="ai-welcome-title">AI 助手</div>
      <div class="ai-welcome-tip">${cfg.baseUrl ? '已连接 ' + esc(cfg.model || '模型') + '，开始对话吧' : '尚未配置模型 —— 点击 ⚙ 或到 设置 → AI 助手 填写服务地址与模型'}</div>
      <div class="ai-welcome-tip" style="margin-top:4px">支持多轮对话 · 📎 附带当前文件作为上下文 · Enter 发送</div>`;
    msgsEl.appendChild(w);
  }

  // ---------- 发送 ----------
  function buildMessages() {
    const cfg = getConfig();
    const out = [];
    if (cfg.systemPrompt && cfg.systemPrompt.trim()) out.push({ role: 'system', content: cfg.systemPrompt.trim() });
    for (const m of msgs) out.push({ role: m.role, content: m.content });
    // 文件上下文并入最后一条 user 消息（保持消息序列合法：最后必须是 user）
    if (ctxFile && out.length && out[out.length - 1].role === 'user') {
      const last = out[out.length - 1];
      last.content = '（当前编辑器文件 ' + ctxFile.path + ' 的内容：）\n```\n' + ctxFile.content + '\n```\n\n' + last.content;
    }
    return out;
  }

  async function send() {
    if (busy) return;
    const text = (inputEl.value || '').trim();
    if (!text) return;
    const cfg = getConfig();
    if (!cfg.baseUrl || !cfg.model) {
      MI.toast('请先配置服务地址与模型', 'err');
      Settings.open('ai');
      return;
    }
    busy = true;
    setBusyUI(true);
    inputEl.value = '';
    // 清空欢迎语
    const w = msgsEl.querySelector('.ai-welcome');
    if (w) w.remove();
    addMsg('user', text);
    msgs.push({ role: 'user', content: text });

    curStream = addMsg('assistant', '');
    curText = '';
    const dot = document.createElement('span');
    dot.className = 'ai-cursor';
    curStream.querySelector('.ai-md').appendChild(dot);

    const r = await window.myIDE.ai.chat(cfg, buildMessages());
    // 兜底：onDone 事件已处理时 curStream 为 null；否则用 invoke 返回值收尾（两者内容一致）
    if (curStream) {
      if (r && r.error) finishStream(r.error, true);
      else finishStream((r && r.text) || curText, false);
    }
  }

  function finishStream(text, isErr) {
    if (!curStream) return;
    const md = curStream.querySelector('.ai-md');
    if (isErr) {
      md.innerHTML = '<p class="ai-err">⚠ ' + esc(text || '请求失败') + '</p>';
    } else if (text) {
      md.innerHTML = renderMd(text);
      // 最后一行光标移除 + 存入历史
    }
    if (text && !isErr) msgs.push({ role: 'assistant', content: text });
    else if (text && isErr) { /* 失败不入历史 */ }
    curStream = null;
    curText = '';
    busy = false;
    setBusyUI(false);
    scrollBottom();
  }

  function setBusyUI(b) {
    if (sendBtn) {
      sendBtn.textContent = b ? '⏹' : '➤';
      sendBtn.title = b ? '停止生成' : '发送（Enter）';
    }
  }

  // ---------- 附带当前文件 ----------
  async function toggleCtxFile() {
    if (ctxFile) {
      ctxFile = null;
      fileChip.classList.remove('on');
      fileChip.textContent = '📎 附当前文件';
      fileChip.title = '把当前编辑器文件内容作为上下文';
      return;
    }
    const tab = Viewer.activeTab;
    if (!tab || tab.dir) { MI.toast('当前没有打开的文件', 'err'); return; }
    const r = await window.myIDE.fs.readFile(tab.path);
    if (!r || r.error) { MI.toast('读取文件失败: ' + (r && r.error || ''), 'err'); return; }
    let content = r.content || '';
    if (content.length > MAX_CTX) content = content.slice(0, MAX_CTX) + '\n…（已截断）';
    ctxFile = { path: tab.path, content };
    const name = tab.path.replace(/^.*[\\/]/, '');
    fileChip.classList.add('on');
    fileChip.textContent = '📎 ' + name;
    fileChip.title = tab.path + '（点击移除）';
  }

  // ---------- 面板宽度拖拽 ----------
  function initResize() {
    const grip = document.getElementById('ai-resize');
    if (!grip || !panel) return;
    let dragging = false;
    grip.addEventListener('mousedown', (e) => {
      dragging = true;
      e.preventDefault();
      document.body.classList.add('col-resizing');
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.min(Math.max(window.innerWidth - e.clientX, 280), window.innerWidth * 0.6);
      panel.style.width = w + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('col-resizing');
      try { localStorage.setItem(LS_W, panel.style.width); } catch {}
    });
    try {
      const w = localStorage.getItem(LS_W);
      if (w && /^\d+px$/.test(w)) panel.style.width = w;
    } catch {}
  }

  function init() {
    if (!panel) return;
    showWelcome();
    if (sendBtn) {
      sendBtn.onclick = () => {
        if (busy) { window.myIDE.ai.abort(); return; }
        send();
      };
    }
    if (inputEl) {
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          if (!busy) send();
        }
      });
    }
    const newBtn = document.getElementById('ai-new');
    if (newBtn) newBtn.onclick = () => {
      msgs = [];
      ctxFile = null;
      fileChip.classList.remove('on');
      fileChip.textContent = '📎 附当前文件';
      msgsEl.innerHTML = '';
      showWelcome();
      MI.toast('已开始新对话', 'ok');
    };
    const cfgBtn = document.getElementById('ai-cfg');
    if (cfgBtn) cfgBtn.onclick = () => { Settings.open('ai'); };
    if (fileChip) fileChip.onclick = toggleCtxFile;
    initResize();

    // 主进程事件流
    window.myIDE.ai.onChunk((delta) => {
      if (!curStream) return;
      curText += delta;
      const md = curStream.querySelector('.ai-md');
      md.innerHTML = renderMd(curText);
      const d = document.createElement('span');
      d.className = 'ai-cursor';
      md.appendChild(d);
      scrollBottom();
    });
    window.myIDE.ai.onDone((r) => {
      if (!curStream) return;
      finishStream(r && r.error ? r.error : (r && r.text) || curText, !!(r && r.error));
    });
  }

  return { init, syncVisible, getConfig, setConfig };
})();
window.AiPanel = AiPanel;

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
  const MAX_ROUNDS = 8;  // Agent 工具循环上限（防失控烧 token）

  // 服务商预设：选服务商后只需填 API Key（baseUrl/模型列表自动带出）
  const PROVIDERS = [
    { id: 'deepseek', name: 'DeepSeek（深度求索）', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
    { id: 'qwen', name: '通义千问（阿里百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-max'] },
    { id: 'moonshot', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-0905-preview', 'moonshot-v1-8k', 'moonshot-v1-32k'] },
    { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-flash', 'glm-4.5'] },
    { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
    { id: 'siliconflow', name: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3.1', 'Qwen/Qwen2.5-72B-Instruct'] },
    { id: 'ollama', name: 'Ollama（本地，无需 Key）', baseUrl: 'http://localhost:11434/v1', models: ['qwen3:8b', 'llama3.1:8b'] },
    { id: 'custom', name: '自定义（手动填写）', baseUrl: '', models: [] },
  ];
  function providerOf(cfg) {
    if (cfg && cfg.provider) {
      const p = PROVIDERS.find((x) => x.id === cfg.provider);
      if (p) return p;
    }
    // 旧配置迁移：按 baseUrl 匹配预设
    if (cfg && cfg.baseUrl) return PROVIDERS.find((x) => x.baseUrl && x.baseUrl === cfg.baseUrl.replace(/\/+$/, '')) || PROVIDERS[PROVIDERS.length - 1];
    return null;
  }

  let msgs = [];            // 会话历史 [{role, content}]（含 tool_result 伪 user 消息）
  let busy = false;         // 生成中（禁发）
  let ctxFile = null;       // 附带的当前文件 {path, content}
  let curStream = null;     // 流式中的气泡元素
  let curText = '';
  let agentRounds = 0;      // 本轮任务已用的工具循环次数
  let agentStopped = false; // 用户中断（⏹）：停止后续自动续流

  // ---------- Agent 工具系统 ----------
  // 主通道：OpenAI 原生 function calling（请求带 tools schema，模型结构化返回 tool_calls）
  // 回退通道：提示词约定 ```tool_call {...}``` 文本块（供不支持 tools 的服务用）
  const TOOLS = [
    { type: 'function', function: { name: 'list_files', description: '列出目录内容（文件和子目录）。需要了解项目结构时先用这个', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对项目根的目录路径，"." 表示根目录' } }, required: [] } } },
    { type: 'function', function: { name: 'read_file', description: '读取项目内一个文本文件的完整内容', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对项目根的文件路径' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'search_files', description: '在整个项目里搜索文本内容（支持正则）', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词或正则表达式' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'replace_edit', description: '修改已有文件的一小块：把 path 文件中恰好出现一次的 search 文本替换为 replace 文本（其余内容原样保留）。优先用它做局部修改，不要为改几行重写整个文件', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对项目根的文件路径' }, search: { type: 'string', description: '要被替换的原文（必须与文件内容逐字符一致，含缩进；不含行号）' }, replace: { type: 'string', description: '替换后的新文本（传空字符串即删除 search 段）' }, replace_all: { type: 'boolean', description: 'search 不唯一时是否替换全部出现，默认 false' } }, required: ['path', 'search', 'replace'] } } },
    { type: 'function', function: { name: 'write_file', description: '写入文件（新内容完整覆盖，会先给用户看 diff 确认）。仅在新建文件或大规模重写时使用；局部修改请改用 replace_edit', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对项目根的文件路径，可新建' }, content: { type: 'string', description: '完整的新文件内容' } }, required: ['path', 'content'] } } },
  ];
  const AGENT_SYS = [
    '你是 My IDE 内置的 AI 编程助手，可以调用工具查看和修改用户的项目文件。',
    '',
    '## 工作规则',
    '1. 回答代码问题前先用工具查看项目（list_files / search_files / read_file），不要凭空猜测文件内容',
    '2. 修改已有文件优先用 replace_edit（只输出要改的片段）；只有新建文件或重写大半内容才用 write_file',
    '3. replace_edit 的 search 必须与文件内容逐字符一致（含缩进、空行），不确定就先 read_file',
    '4. 需要多步操作就分多轮调用，每轮等工具结果回来再决定下一步',
    '5. 全部任务完成后用中文总结改动，不再调用工具',
    '',
    '（如果当前服务不支持原生工具调用，也可在正文里用 ```tool_call {"name":"工具名","args":{...}}``` 代码块表达同样的调用）',
  ].join('\n');

  function parseToolCalls(text) {
    const out = [];
    const re = /```tool_call\s*([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text || ''))) {
      try {
        const j = JSON.parse(m[1].trim());
        if (j && typeof j.name === 'string' && j.args && typeof j.args === 'object') out.push({ name: j.name, args: j.args });
      } catch {}
    }
    return out;
  }

  // 项目内路径解析：拒绝对路径和 .. 逃逸（写操作安全闸的第一道）；'.' 与 '' = 项目根
  function resolveInRoot(p) {
    const root = window.App && App.root;
    if (!root) return null;
    const clean = String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.?\//, '');
    if (clean === '' || clean === '.') return { root: root.replace(/[\\/]+$/, ''), rel: '' };
    const parts = clean.split('/').filter((s) => s && s !== '.');
    if (!parts.length || parts.includes('..')) return null;
    return { root: root.replace(/[\\/]+$/, ''), rel: parts.join('/') };
  }

  async function executeTool(call) {
    const a = call.args || {};
    if (call.name === 'list_files') {
      const loc = resolveInRoot(a.path || '.');
      if (!loc) return { ok: false, text: '错误：路径不合法（只能是项目内相对路径）' };
      const r = await window.myIDE.fs.readDir(loc.rel ? loc.root + '/' + loc.rel : loc.root);
      if (!r || r.error) return { ok: false, text: '错误：' + ((r && r.error) || '目录不存在') };
      // 后端返回条目数组（注意 Array.prototype.entries 是内置方法，不能直接 r.entries 判断）
      const list = Array.isArray(r) ? r : (r.files || r.children || []);
      const items = list.map((e) => (((e.type === 'dir') || e.isDir || e.isDirectory) ? '[目录] ' : '') + e.name);
      return { ok: true, text: '目录 ' + loc.rel + ' 的内容：\n' + (items.join('\n') || '（空）') };
    }
    if (call.name === 'read_file') {
      const loc = resolveInRoot(a.path);
      if (!loc) return { ok: false, text: '错误：路径不合法（只能是项目内相对路径）' };
      const r = await window.myIDE.fs.readFile(loc.root + '/' + loc.rel);
      if (!r || r.error) return { ok: false, text: '错误：' + ((r && r.error) || '文件不存在') };
      let c = r.content || '';
      if (c.length > 30000) c = c.slice(0, 30000) + '\n…（内容过长已截断）';
      return { ok: true, text: '文件 ' + loc.rel + ' 的内容：\n```\n' + c + '\n```' };
    }
    if (call.name === 'search_files') {
      const root = window.App && App.root;
      if (!root) return { ok: false, text: '错误：未打开项目' };
      const q = String(a.query || '').trim();
      if (!q) return { ok: false, text: '错误：query 为空' };
      const r = await window.myIDE.fs.grep(root, q);
      if (!r || r.error) return { ok: false, text: '错误：' + ((r && r.error) || '搜索失败') };
      const rows = (r.results || []).slice(0, 50).map((x) => x.file + ':' + x.line + ' ' + x.text);
      return { ok: true, text: '搜索 "' + q + '" 的结果（' + (r.results || []).length + ' 处，最多显示 50）：\n' + (rows.join('\n') || '（无结果）') };
    }
    if (call.name === 'replace_edit') {
      const loc = resolveInRoot(a.path);
      if (!loc) return { ok: false, text: '错误：路径不合法（只能是项目内相对路径）' };
      const search = typeof a.search === 'string' ? a.search : '';
      const replace = typeof a.replace === 'string' ? a.replace : '';
      if (!search) return { ok: false, text: '错误：search 不能为空（替换内容请用 write_file）' };
      const full = loc.root + '/' + loc.rel;
      const old = await window.myIDE.fs.readFile(full);
      if (!old || old.error) return { ok: false, text: '错误：文件不存在 ' + loc.rel + '（新文件请用 write_file）' };
      const oldText = old.content || '';
      // 计数全部出现位置（多重匹配时报行号，帮模型精确化）
      const hits = [];
      let i = oldText.indexOf(search);
      while (i >= 0) { hits.push(i); i = oldText.indexOf(search, i + search.length); }
      if (!hits.length) {
        return { ok: false, text: '错误：search 在 ' + loc.rel + ' 中未找到。请先 read_file 核对原文（注意逐字符一致，包括缩进和空行）' };
      }
      if (hits.length > 1 && !a.replace_all) {
        const lineOf = (pos) => oldText.slice(0, pos).split('\n').length;
        return { ok: false, text: '错误：search 在 ' + loc.rel + ' 出现 ' + hits.length + ' 次（行 ' + hits.map(lineOf).join(', ') + '）。请扩大上下文使其唯一，或设 replace_all: true' };
      }
      const newText = hits.length > 1
        ? oldText.split(search).join(replace)
        : oldText.slice(0, hits[0]) + replace + oldText.slice(hits[0] + search.length);
      if (newText === oldText) return { ok: true, text: '无变化：replace 与 search 相同' };
      return await applyWrite(loc, newText);
    }
    if (call.name === 'write_file') {
      const loc = resolveInRoot(a.path);
      if (!loc) return { ok: false, text: '错误：路径不合法（只能是项目内相对路径）' };
      const content = typeof a.content === 'string' ? a.content : '';
      return await applyWrite(loc, content);
    }
    return { ok: false, text: '错误：未知工具 ' + call.name };
  }

  // 写入安全闸：diff 预览 → 用户确认 → 写盘
  async function applyWrite(loc, content) {
    const full = loc.root + '/' + loc.rel;
    const old = await window.myIDE.fs.readFile(full);
    const oldText = old && !old.error ? (old.content || '') : '';
    const applied = await confirmDiff(loc.rel, oldText, content);
    if (!applied) return { ok: false, text: '用户拒绝了本次写入 ' + loc.rel + '（未做任何修改）' };
    const w = await window.myIDE.fs.writeFile(full, content);
    if (!w || w.error) return { ok: false, text: '错误：写入失败 ' + ((w && w.error) || '') };
    try { if (window.App && App.refreshAll) App.refreshAll(); } catch {}
    return { ok: true, text: '已写入 ' + loc.rel + '（新内容 ' + content.split('\n').length + ' 行）' };
  }

  // 统一 diff（前缀/后缀裁剪 + 中段 LCS，超限退化整块替换）
  function lineDiff(aText, bText) {
    const A = String(aText).split('\n'), B = String(bText).split('\n');
    let s = 0;
    while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let e = 0;
    while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
    const midA = A.slice(s, A.length - e), midB = B.slice(s, B.length - e);
    const rows = [];
    for (let i = 0; i < s; i++) rows.push({ t: ' ', s: A[i] });
    if (midA.length * midB.length > 4000000) {
      for (const l of midA) rows.push({ t: '-', s: l });
      for (const l of midB) rows.push({ t: '+', s: l });
    } else {
      const n = midA.length, m = midB.length, W = m + 1;
      const dp = new Int32Array((n + 1) * W);
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
        dp[i * W + j] = midA[i] === midB[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (midA[i] === midB[j]) { rows.push({ t: ' ', s: midA[i] }); i++; j++; }
        else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) rows.push({ t: '-', s: midA[i++] });
        else rows.push({ t: '+', s: midB[j++] });
      }
      while (i < n) rows.push({ t: '-', s: midA[i++] });
      while (j < m) rows.push({ t: '+', s: midB[j++] });
    }
    for (let k = e - 1; k >= 0; k--) rows.push({ t: ' ', s: A[A.length - 1 - k] });
    return rows;
  }

  // diff 确认弹窗：返回 Promise<boolean>（true=应用）
  function confirmDiff(rel, oldText, newText) {
    return new Promise((resolve) => {
      const rows = lineDiff(oldText, newText);
      const addN = rows.filter((r) => r.t === '+').length, delN = rows.filter((r) => r.t === '-').length;
      // 上下文压缩：长未改动段折叠为 ⋯ N 行未改动 ⋯
      const parts = [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].t !== ' ') { parts.push({ cls: rows[i].t === '+' ? 'd-add' : 'd-del', text: (rows[i].t === '+' ? '+' : '-') + ' ' + rows[i].s }); continue; }
        let j = i;
        while (j < rows.length && rows[j].t === ' ') j++;
        const run = j - i;
        if (run > 8 && i > 0 && j < rows.length) {
          parts.push({ cls: 'd-skip', text: '⋯ ' + (run - 6) + ' 行未改动 ⋯' });
          for (let k = j - 3; k < j; k++) parts.push({ cls: 'd-ctx', text: '  ' + rows[k].s });
        } else {
          for (let k = i; k < j; k++) parts.push({ cls: 'd-ctx', text: '  ' + rows[k].s });
        }
        i = j - 1;
      }
      let html = '';
      for (const p of parts) html += '<div class="' + p.cls + '">' + esc(p.text) + '</div>';
      const box = document.createElement('div');
      box.style.cssText = 'display:flex;flex-direction:column;min-width:520px;max-width:760px;height:70vh';
      box.innerHTML = `
        <div class="m-head">✏️ AI 修改确认 <span class="x" id="dw-x">✕</span></div>
        <div style="padding:8px 14px;font-size:12px;color:var(--text-dim)">${esc(rel)} <span style="float:right">+${addN} 行 / -${delN} 行</span></div>
        <div class="dw-diff">${html}</div>
        <div class="m-foot">
          <button class="tb-btn m-cancel" id="dw-no">拒绝</button>
          <button class="tb-btn m-ok" id="dw-yes">应用修改</button>
        </div>`;
      Modal.show(box);
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; Modal.hide(); resolve(v); };
      box.querySelector('#dw-yes').onclick = () => finish(true);
      box.querySelector('#dw-no').onclick = () => finish(false);
      box.querySelector('#dw-x').onclick = () => finish(false);
    });
  }

  // 工具活动行（消息流里的紧凑状态条）
  function renderToolRow(call) {
    const icons = { list_files: '📂', read_file: '📄', search_files: '🔍', write_file: '✏️', replace_edit: '🔧' };
    const row = document.createElement('div');
    row.className = 'ai-tool';
    const arg = (call.args && (call.args.path || call.args.query)) || '';
    row.innerHTML = '<span class="ai-tool-ic">' + (icons[call.name] || '·') + '</span>' +
      '<span class="ai-tool-tx">' + esc(call.name + ' ' + arg) + '</span>' +
      '<span class="ai-tool-st">…</span>';
    msgsEl.appendChild(row);
    scrollBottom();
    return row;
  }
  function setToolState(row, ok, note) {
    if (!row) return;
    const st = row.querySelector('.ai-tool-st');
    if (st) { st.textContent = ok ? '✓ ' + (note || '') : '✗ ' + (note || '失败'); st.classList.add(ok ? 'ok' : 'err'); }
  }

  // 一轮工具执行完毕：结果喂回模型，然后自动续流
  // native=true 走 role:tool 消息（原生 function calling），否则走伪 user 消息（文本协议回退）
  async function agentStep(calls, native) {
    if (!calls || !calls.length || agentStopped) return;
    if (agentRounds >= MAX_ROUNDS) {
      msgs.push({ role: 'user', content: '（已达工具调用轮次上限，请基于现有信息总结收尾，不要再调用工具）' });
    } else {
      for (const c of calls) {
        const row = renderToolRow(c);
        let r;
        try { r = await executeTool(c); } catch (e) { r = { ok: false, text: '错误：' + ((e && e.message) || e) }; }
        setToolState(row, r.ok, (c.name === 'write_file' || c.name === 'replace_edit') ? (r.ok ? '已应用' : '已拒绝') : '');
        if (native) msgs.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: r.text || '' });
        else msgs.push({ role: 'user', content: '<tool_results>\n<result tool="' + c.name + '">\n' + (r.text || '') + '\n</result>\n</tool_results>' });
      }
      agentRounds++;
    }
    if (agentStopped) return;
    await continueStream();
  }

  // 自动续流（Agent 循环的下一轮回复；用户消息已在 msgs 里）
  async function continueStream() {
    const cfg = getConfig();
    curStream = addMsg('assistant', '');
    curText = '';
    const dot = document.createElement('span');
    dot.className = 'ai-cursor';
    curStream.querySelector('.ai-md').appendChild(dot);
    const r = await window.myIDE.ai.chat(cfg, buildMessages(), TOOLS);
    if (curStream) {
      if (r && r.error) finishStream(r.error, true, r);
      else finishStream((r && r.text) || curText, false, r);
    }
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function getConfig() {
    try { return JSON.parse(localStorage.getItem(LS_CFG) || '{}'); } catch { return {}; }
  }
  // setConfig 改为合并：局部更新（如只切模型）不丢 apiKey 等其他字段
  function setConfig(c) {
    try {
      const cfg = { ...getConfig(), ...(c || {}) };
      localStorage.setItem(LS_CFG, JSON.stringify(cfg));
      refreshModelSel();
    } catch {}
  }

  // 面板头部模型切换器：当前模型 + 服务商预设模型列表
  function refreshModelSel() {
    const sel = document.getElementById('ai-model');
    if (!sel) return;
    const cfg = getConfig();
    const prov = providerOf(cfg);
    const models = [];
    if (cfg.model && !models.includes(cfg.model)) models.push(cfg.model);
    for (const m of (prov ? prov.models : [])) if (!models.includes(m)) models.push(m);
    sel.innerHTML = models.length
      ? models.map((m) => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('')
      : '<option value="">未选择模型</option>';
    sel.value = cfg.model || '';
    sel.title = '当前模型：' + (cfg.model || '未设置') + (prov ? '（' + prov.name + '）' : '');
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
      // 工具调用块不进渲染（含流式中的未闭合半块）
      const clean = String(text || '').replace(/```tool_call[\s\S]*?```/g, '').replace(/```tool_call[\s\S]*$/g, '');
      const html = window.marked.parse(clean);
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
      <div class="ai-welcome-tip" style="margin-top:4px">支持工具调用（读文件/搜索/修改需确认）· 多轮对话 · 📎 附当前文件 · Enter 发送</div>`;
    msgsEl.appendChild(w);
  }

  // ---------- 发送 ----------
  // 消息透传（保留原生 function calling 的 tool_calls / tool_call_id 字段）
  function buildMessages() {
    const cfg = getConfig();
    const out = [];
    // Agent 工具系统提示在前，用户自定义系统提示在后（用户可覆盖语气/角色）
    out.push({ role: 'system', content: AGENT_SYS + (cfg.systemPrompt && cfg.systemPrompt.trim() ? '\n\n# 用户补充设定\n' + cfg.systemPrompt.trim() : '') });
    for (const m of msgs) {
      if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content || '' });
      else if (m.tool_calls) out.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
      else out.push({ role: m.role, content: m.content });
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
    agentRounds = 0;   // 新任务重置 Agent 循环计数
    agentStopped = false;
    inputEl.value = '';
    // 清空欢迎语
    const w = msgsEl.querySelector('.ai-welcome');
    if (w) w.remove();
    // 文件上下文在发送时并入该条 user 消息（一次性，不污染后续 tool_results 轮次）
    let content = text;
    if (ctxFile) content = '（当前编辑器文件 ' + ctxFile.path + ' 的内容：）\n```\n' + ctxFile.content + '\n```\n\n' + text;
    addMsg('user', text);
    msgs.push({ role: 'user', content });

    curStream = addMsg('assistant', '');
    curText = '';
    const dot = document.createElement('span');
    dot.className = 'ai-cursor';
    curStream.querySelector('.ai-md').appendChild(dot);

    const r = await window.myIDE.ai.chat(cfg, buildMessages(), TOOLS);
    // 兜底：onDone 事件已处理时 curStream 为 null；否则用 invoke 返回值收尾（两者内容一致）
    if (curStream) {
      if (r && r.error) finishStream(r.error, true, r);
      else finishStream((r && r.text) || curText, false, r);
    }
  }

  // 收尾一轮回复：渲染 + 入历史 + 若有工具调用则续跑 Agent 循环（保持 busy）
  // r：完整返回 {ok, text, toolCalls}（原生 function calling 的工具调用在 r.toolCalls）
  function finishStream(text, isErr, r) {
    if (!curStream) return;
    const md = curStream.querySelector('.ai-md');
    if (isErr) {
      md.innerHTML = '<p class="ai-err">⚠ ' + esc(text || '请求失败') + '</p>';
    } else if (text) {
      md.innerHTML = renderMd(text);
    }
    const nativeCalls = (!isErr && r && Array.isArray(r.toolCalls)) ? r.toolCalls : [];
    const textCalls = (!isErr && text) ? parseToolCalls(text) : [];
    if (!isErr) {
      // 原生通道：assistant 消息要带 tool_calls（role:tool 结果的引用锚点）
      if (nativeCalls.length) {
        msgs.push({
          role: 'assistant',
          content: text || '',
          tool_calls: nativeCalls.map((c) => ({
            id: c.id, type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
          })),
        });
      } else if (text) {
        msgs.push({ role: 'assistant', content: text });
      }
    }
    curStream = null;
    curText = '';
    scrollBottom();
    // Agent 循环：原生 tool_calls 优先，文本协议块回退
    if (!agentStopped && (nativeCalls.length || textCalls.length)) {
      agentStep(nativeCalls.length ? nativeCalls : textCalls, !!nativeCalls.length).catch(() => {});
      return;
    }
    busy = false;
    setBusyUI(false);
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
    refreshModelSel();
    const modelSel = document.getElementById('ai-model');
    if (modelSel) modelSel.onchange = () => {
      const m = modelSel.value;
      if (!m) return;
      setConfig({ model: m });
      MI.toast('已切换模型：' + m, 'ok');
    };
    if (sendBtn) {
      sendBtn.onclick = () => {
        if (busy) { agentStopped = true; window.myIDE.ai.abort(); return; }
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
      if (busy) { agentStopped = true; window.myIDE.ai.abort(); busy = false; setBusyUI(false); }
      agentRounds = 0;
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
      finishStream(r && r.error ? r.error : (r && r.text) || curText, !!(r && r.error), r);
    });
  }

  return { init, syncVisible, getConfig, setConfig, PROVIDERS, providerOf };
})();
window.AiPanel = AiPanel;

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
  let ctxFiles = [];        // 附带上下文列表 [{path, content, isDir}]（📎 按钮 / @引用 均入此列）
  let curStream = null;     // 流式中的气泡元素
  let curText = '';
  let agentRounds = 0;      // 本轮任务已用的工具循环次数
  let agentStopped = false; // 用户中断（⏹）：停止后续自动续流
  let usageSum = { in: 0, out: 0, cacheHit: 0, cacheMiss: 0 }; // 会话累计 token 用量（usage 有值时更新）
  let checkpoints = [];      // AI 写入检查点：[{path, rel, oldText, existed, done, card}]
  let followPath = null;     // 正在跟随的编辑器文件（自动作为上下文，用户不用手动点 📎）
  const followMuted = new Set(); // 用户明确说过「不跟随」的文件（切走再切回也不再自动加）

  // ---------- token 用量显示 ----------
  // 粗估当前上下文（无 usage 时的近似值：英文 ~4 字符/token、中文更密，取 3.2 折中）
  function estTokens() {
    let chars = 0;
    for (const m of msgs) chars += (m.content || '').length + 40;
    return Math.round(chars / 3.2);
  }
  function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
  function renderUsage() {
    const el = document.getElementById('ai-usage');
    if (!el) return;
    const parts = ['上下文 ~' + fmtK(estTokens()) + ' tok'];
    if (usageSum.in || usageSum.out) {
      parts.push('Σ 输入 ' + fmtK(usageSum.in));
      parts.push('输出 ' + fmtK(usageSum.out));
      if (usageSum.cacheHit || usageSum.cacheMiss) {
        const pct = Math.round((usageSum.cacheHit / (usageSum.cacheHit + usageSum.cacheMiss)) * 100);
        parts.push('缓存命中 ' + pct + '%（' + fmtK(usageSum.cacheHit) + ' tok）');
      }
    }
    el.textContent = parts.join(' · ');
    el.title = usageSum.cacheHit
      ? 'DeepSeek 上下文缓存：命中的 token 按缓存价计费（约 1/10 价格），miss 部分按原价'
      : '上下文为字符数估算值；接入模型返回 usage 后显示精确统计';
  }
  function addUsage(u) {
    if (!u) return;
    usageSum.in += u.prompt_tokens || 0;
    usageSum.out += u.completion_tokens || 0;
    usageSum.cacheHit += u.cache_hit || 0;
    usageSum.cacheMiss += u.cache_miss || 0;
    renderUsage();
  }

  // ---------- 上下文压缩 ----------
  // 超限时从旧到新截断工具结果（read_file/search 等大块头），保留近 3 条消息不动
  const CTX_LIMIT_CHARS = 96000; // ≈30k tokens，超过开始压缩
  function compressHistory() {
    const total = () => msgs.reduce((s, m) => s + (m.content || '').length, 0);
    let guard = 0;
    while (total() > CTX_LIMIT_CHARS && msgs.length > 6 && guard++ < 100) {
      // 找最早的大块工具结果（role:tool 或含 <tool_results> 的伪 user）
      const idx = msgs.findIndex((m, i) =>
        i < msgs.length - 3 &&
        (m.role === 'tool' || (m.role === 'user' && String(m.content).includes('<tool_results>'))) &&
        (m.content || '').length > 800);
      if (idx < 0) break;
      const head = String(msgs[idx].content).slice(0, 500);
      msgs[idx].content = head + '\n…（此工具结果已压缩，如需详情请重新调用工具）';
    }
  }

  // ---------- Agent 工具系统 ----------
  // 主通道：OpenAI 原生 function calling（请求带 tools schema，模型结构化返回 tool_calls）
  // 回退通道：提示词约定 ```tool_call {...}``` 文本块（供不支持 tools 的服务用）
  const TOOLS = [
    { type: 'function', function: { name: 'list_files', description: '列出目录内容（文件和子目录）。需要了解项目结构时先用这个', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对项目根的目录路径，"." 表示根目录' } }, required: [] } } },
    { type: 'function', function: { name: 'read_file', description: '读取项目内一个文本文件的完整内容', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对项目根的文件路径' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'search_files', description: '在整个项目里搜索文本内容（支持正则）', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词或正则表达式' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'replace_edit', description: '修改已有文件的一小块：把 path 文件中恰好出现一次的 search 文本替换为 replace 文本（其余内容原样保留）。优先用它做局部修改，不要为改几行重写整个文件', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对项目根的文件路径' }, search: { type: 'string', description: '要被替换的原文（必须与文件内容逐字符一致，含缩进；不含行号）' }, replace: { type: 'string', description: '替换后的新文本（传空字符串即删除 search 段）' }, replace_all: { type: 'boolean', description: 'search 不唯一时是否替换全部出现，默认 false' } }, required: ['path', 'search', 'replace'] } } },
    { type: 'function', function: { name: 'write_file', description: '写入文件（新内容完整覆盖，会先给用户看 diff 确认）。仅在新建文件或大规模重写时使用；局部修改请改用 replace_edit', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对项目根的文件路径，可新建' }, content: { type: 'string', description: '完整的新文件内容' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'run_command', description: '在项目根目录执行一条 shell 命令（如运行脚本/装依赖/git 操作，15 秒超时）。每条命令都会先弹窗让用户确认', parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' } }, required: ['command'] } } },
  ];
  // 定位：通用助手。用户主要用它整理内容（改文档 / 查项目内容），代码能力保留不砍；
  // 所以规则里把「省 token」「说人话」讲清楚，而不是只教怎么改代码
  const AGENT_SYS = [
    '你是 My IDE 内置的 AI 助手，可以调用工具查看和修改用户项目里的文件。',
    '用户主要拿你整理内容（改文档、查资料、归纳改写），也会让你处理代码，两者用同一套规则。',
    '',
    '## 工作规则',
    '1. 动手前先看真实内容（list_files / search_files / read_file），不要凭空猜测',
    '2. 改文件优先用 replace_edit，只改要动的那一段；只有新建文件或整篇重写才用 write_file',
    '3. replace_edit 的 search 必须与文件内容逐字符一致（含缩进、空行），不确定就先 read_file',
    '4. 文件很长时不要整篇读：先用 search_files 定位到相关段落，再按需读取 —— 省时间也省额度',
    '5. 需要多步操作就分多轮调用，每轮等工具结果回来再决定下一步',
    '6. 只在确有必要时用 run_command（跑测试 / 验证），一条命令只做一件事',
    '7. 全部任务完成后用中文说明改了什么，不再调用工具',
    '',
    '## 表达',
    '说人话：结论先行、少堆术语，不要输出与用户要求无关的技术细节。',
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

  // ---------- 访问权限（设置 → AI 助手，多种档位）----------
  // permWrite：'confirm' 每次弹 diff 确认（默认）| 'auto' 自动应用（不弹窗）| 'deny' 禁止写入
  // permRun：'confirm' 每条命令弹窗确认（默认）| 'deny' 禁止执行命令
  function permWrite() {
    const v = getConfig().permWrite;
    return ['confirm', 'auto', 'deny'].includes(v) ? v : 'confirm';
  }
  function permRun() {
    const v = getConfig().permRun;
    return ['confirm', 'deny'].includes(v) ? v : 'confirm';
  }

  // ---------- 授权记忆：确认过一次就别再问（否则跑一次测试要点十几次）----------
  // 范围：session = 本次对话（内存）；project = 本项目（localStorage，按项目分开存）
  // 粒度：整类操作（写文件 / 执行命令）+ 单条命令前缀（如 git、npm test）
  let sessionPerm = { write: false, run: false };
  const permKey = () => 'myide-ai-perms:' + ((window.App && App.root) || '');
  function loadPerms() {
    try { return JSON.parse(localStorage.getItem(permKey()) || '{}') || {}; } catch { return {}; }
  }
  function savePerms(p) {
    try { localStorage.setItem(permKey(), JSON.stringify(p || {})); } catch {}
  }
  function grantPerm(kind, scope) {
    if (scope === 'session') { sessionPerm[kind] = true; return; }
    const p = loadPerms();
    p[kind] = true;
    savePerms(p);
  }
  function grantCmdPrefix(pre) {
    if (!pre) return;
    const p = loadPerms();
    p.cmds = [...new Set([...(p.cmds || []), pre])];
    savePerms(p);
  }
  function cmdPrefixOf(cmd) { return String(cmd || '').trim().split(/\s+/)[0] || ''; }
  function writeNeedsConfirm() {
    const base = permWrite();
    if (base === 'deny') return 'deny';
    if (base === 'auto') return 'no';
    if (sessionPerm.write || loadPerms().write) return 'no';
    return 'yes';
  }
  function runNeedsConfirm(cmd) {
    if (permRun() === 'deny') return 'deny';
    if (sessionPerm.run || loadPerms().run) return 'no';
    const t = String(cmd || '').trim();
    if ((loadPerms().cmds || []).some((pre) => pre && t.startsWith(pre))) return 'no';
    return 'yes';
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
    if (call.name === 'run_command') {
      const cmd = String(a.command || '').trim();
      if (!cmd) return { ok: false, text: '错误：command 为空' };
      const root = (window.App && App.root || '').replace(/[\\/]+$/, '');
      if (!root) return { ok: false, text: '错误：没有打开的项目' };
      const needR = runNeedsConfirm(cmd);
      if (needR === 'deny') return { ok: false, text: '用户已禁止 AI 执行命令（设置 → AI 助手 → 访问权限）' };
      if (needR === 'yes') {
        // 确认闸：命令有副作用必须批准，但给「记住这类命令」的出口
        const ans = await confirmRun(cmd, cmdPrefixOf(cmd)); // 'once' | 'always' | false
        if (!ans) return { ok: false, text: '用户拒绝了执行该命令' };
        if (ans === 'always') grantCmdPrefix(cmdPrefixOf(cmd));
      }
      const r = await window.myIDE.ai.run(cmd, root);
      return { ok: !!(r && r.ok), text: (r && r.text) || '（无输出）' };
    }
    return { ok: false, text: '错误：未知工具 ' + call.name };
  }

  // 写入安全闸：权限档位裁决 →（confirm 时）diff 预览 → 写盘
  async function applyWrite(loc, content) {
    const full = loc.root + '/' + loc.rel;
    const needW = writeNeedsConfirm();
    if (needW === 'deny') {
      return { ok: false, text: '用户已禁止 AI 写入文件（设置 → AI 助手 → 访问权限）' };
    }
    const old = await window.myIDE.fs.readFile(full);
    const oldText = old && !old.error ? (old.content || '') : '';
    const existed = old && !old.error;
    if (needW === 'yes') {
      const ans = await confirmDiff(loc.rel, oldText, content); // 'once' | 'always' | false
      if (!ans) return { ok: false, text: '用户拒绝了本次写入 ' + loc.rel + '（未做任何修改）' };
      if (ans === 'always') grantPerm('write', 'project');
    }
    const w = await window.myIDE.fs.writeFile(full, content);
    if (!w || w.error) return { ok: false, text: '错误：写入失败 ' + ((w && w.error) || '') };
    // 检查点 + 改动卡片：写下前的旧内容留档（新文件记 existed:false，撤销时删除）
    const cp = { path: full, rel: loc.rel, oldText, existed, done: false, card: null };
    checkpoints.push(cp);
    cp.card = addEditCard(cp, content);
    try { if (window.App && App.refreshAll) App.refreshAll(); } catch {}
    return { ok: true, text: '已写入 ' + loc.rel + '（新内容 ' + content.split('\n').length + ' 行）' };
  }

  // 撤销最近一次 AI 写入（栈式，可连续点）
  async function undoCheckpoint() {
    let cp = null;
    for (let i = checkpoints.length - 1; i >= 0; i--) {
      if (!checkpoints[i].done) { cp = checkpoints[i]; break; }
    }
    if (!cp) { MI.toast('没有可回滚的 AI 修改', 'err'); return; }
    await undoEditCp(cp);
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
      const html = diffRowsHtml(rows);
      const box = document.createElement('div');
      box.style.cssText = 'display:flex;flex-direction:column;min-width:520px;max-width:760px;height:70vh';
      box.innerHTML = `
        <div class="m-head">✏️ AI 修改确认 <span class="x" id="dw-x">✕</span></div>
        <div style="padding:8px 14px;font-size:12px;color:var(--text-dim)">${esc(rel)} <span style="float:right">+${addN} 行 / -${delN} 行</span></div>
        <div class="dw-diff">${html}</div>
        <div class="m-foot">
          <button class="tb-btn m-cancel" id="dw-no">拒绝</button>
          <button class="tb-btn" id="dw-always" title="以后本项目里改文件都不再询问（可在 设置 → AI 助手 清除）">本项目内都允许</button>
          <button class="tb-btn m-ok" id="dw-yes">应用修改</button>
        </div>`;
      Modal.show(box);
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; Modal.hide(); resolve(v); };
      box.querySelector('#dw-yes').onclick = () => finish('once');
      box.querySelector('#dw-always').onclick = () => finish('always');
      box.querySelector('#dw-no').onclick = () => finish(false);
      box.querySelector('#dw-x').onclick = () => finish(false);
    });
  }

  // 工具活动行（消息流里的紧凑状态条）
  function renderToolRow(call) {
    const icons = { list_files: '📂', read_file: '📄', search_files: '🔍', write_file: '✏️', replace_edit: '🔧', run_command: '▶' };
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

  // 消息气泡（含悬停复制按钮：一键复制原始 markdown 文本）
  function addMsg(role, text) {
    const row = document.createElement('div');
    row.className = 'ai-msg ' + (role === 'user' ? 'ai-user' : 'ai-assistant');
    const pre = document.createElement('div');
    pre.className = 'ai-md';
    if (role === 'user') {
      pre.innerHTML = '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
    } else {
      pre.innerHTML = renderMd(text);
    }
    row.appendChild(pre);
    // 复制按钮（PyCharm AI Assistant 式悬停出现；文本可选中 + 一键复制双通道）
    const cp = document.createElement('button');
    cp.className = 'ai-copy';
    cp.title = '复制全文';
    cp.textContent = '⧉';
    cp.onclick = async () => {
      try {
        await MI.copyText(String(text == null ? '' : text));
        MI.toast('📋 已复制' + (role === 'user' ? '该消息' : '回复全文'), 'ok');
      } catch (e) { MI.toast('复制失败: ' + String(e), 'err'); }
    };
    row.appendChild(cp);
    msgsEl.appendChild(row);
    scrollBottom();
    return row;
  }

  // 空状态：卡片 + 场景入口 —— 点一下把指令填进输入框（用户不用自己想该怎么问）
  const AI_IC = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 1.8l1.1 2.9 2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9L2.4 5.8l2.9-1.1z"/><path d="M11.9 9l.65 1.75L14.3 11.4l-1.75.65L11.9 13.8l-.65-1.75L9.5 11.4l1.75-.65z"/></svg>';
  const QUICK_PROMPTS = [
    { label: '整理当前文档', tip: '理顺结构、统一格式，改完先看 diff', file: true, text: '把当前打开的文档整理一下：理顺结构、统一格式，改完先给我看 diff' },
    { label: '提取要点', tip: '按章节归纳要点', file: true, text: '读一下当前文档，按章节提取要点，用简洁的列表整理给我' },
    { label: '按标题重组', tip: '保持原意，只调结构', file: true, text: '按标题层级重新组织当前文档的内容，保持原意不变，改完给我看 diff' },
    { label: '在项目中查找', tip: '搜项目里的内容', file: false, text: '在项目里查找：' },
  ];
  // 场景入口：填指令 + 聚焦；整理类顺手挂上当前文件（省得模型自己猜是哪个文件）
  async function runQuickPrompt(q) {
    const input = document.getElementById('ai-input');
    if (!input) return;
    if (q.file) {
      const tab = window.Viewer && Viewer.activeTab;
      if (!tab || tab.dir) { MI.toast('先在编辑器里打开一个文档，再点这个', 'err'); return; }
      if (!ctxFiles.some((f) => f.path === tab.path)) await toggleCtxFile();
    }
    input.value = q.text;
    input.focus();
    try { input.setSelectionRange(q.text.length, q.text.length); } catch {}
  }
  function showWelcome() {
    const cfg = getConfig();
    const w = document.createElement('div');
    w.className = 'ai-welcome';
    const card = document.createElement('div');
    card.className = 'ai-card';
    if (!cfg.baseUrl) {
      card.innerHTML =
        '<div class="ai-card-ic">' + AI_IC + '</div>' +
        '<div class="ai-card-title">AI 助手</div>' +
        '<div class="ai-card-sub">还没配置模型 —— 点右上角设置，或到「设置 → AI 助手」填写服务地址与模型</div>';
    } else {
      card.innerHTML =
        '<div class="ai-card-ic">' + AI_IC + '</div>' +
        '<div class="ai-card-title">整理你的文档和项目内容</div>' +
        '<div class="ai-card-sub">我会读项目里的文件、按你的要求改文档。任何写入都先把改动摆给你看，确认了才落盘。</div>';
      const grid = document.createElement('div');
      grid.className = 'ai-quick';
      for (const q of QUICK_PROMPTS) {
        const b = document.createElement('button');
        b.className = 'ai-quick-btn';
        b.textContent = q.label;
        b.title = q.tip;
        b.onclick = () => runQuickPrompt(q);
        grid.appendChild(b);
      }
      card.appendChild(grid);
    }
    w.appendChild(card);
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
    await followActive(); // 发送前对齐一次：用户可能刚切了文件就说话
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
    compressHistory(); // 超限时先压缩旧工具结果，防止上下文撑爆
    renderUsage();
    inputEl.value = '';
    // 清空欢迎语
    const w = msgsEl.querySelector('.ai-welcome');
    if (w) w.remove();
    // 文件上下文在发送时并入该条 user 消息（一次性，不污染后续 tool_results 轮次）
    let content = text;
    if (ctxFiles.length) {
      const blocks = ctxFiles.map((f) => '（' + (f.isDir ? '目录 ' : '文件 ') + f.path + ' 的' + (f.isDir ? '结构' : '内容') + '：）\n```\n' + f.content + '\n```');
      content = blocks.join('\n\n') + '\n\n' + text;
    }
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
    addUsage(r && r.usage); // 精确 token 统计（DeepSeek 含缓存命中细分）
    const md = curStream.querySelector('.ai-md');
    // 空气泡不留：模型这一轮只调工具、没说话时，聊天里挂个空白框只会让人莫名其妙
    const hasCalls = !!(r && Array.isArray(r.toolCalls) && r.toolCalls.length);
    if (!isErr && !String(text || '').trim()) {
      if (hasCalls) {
        try { curStream.remove(); } catch {}
      } else {
        md.innerHTML = '<p class="ai-err">（模型这轮没有返回内容）</p>';
      }
    }
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

  // ---------- 跟随当前编辑器文件 ----------
  // 为什么需要：用户在面板里说「把这份文档精简一下」，AI 并不知道「这份」是哪份 ——
  // 以前要先手动点 📎 或 @ 引用，忘了附就答非所问。现在面板始终跟着当前打开的文件走。
  function renderFollow() {
    const box = document.getElementById('ai-follow');
    if (!box) return;
    const f = ctxFiles.find((x) => x.auto);
    box.classList.toggle('hidden', !f);
    if (!f) return;
    const nm = box.querySelector('.ai-follow-nm');
    if (nm) nm.textContent = f.path.replace(/^.*[\\/]/, '');
    box.title = f.path;
  }
  async function followActive() {
    const tab = window.Viewer && Viewer.activeTab;
    const path = (tab && !tab.dir) ? tab.path : null;
    if (path === followPath) { renderFollow(); return; }
    followPath = path;
    ctxFiles = ctxFiles.filter((x) => !x.auto);
    if (path && !followMuted.has(path)) {
      const r = await window.myIDE.fs.readFile(path);
      if (r && !r.error) {
        let content = r.content || '';
        if (content.length > MAX_CTX) content = content.slice(0, MAX_CTX) + '\n…（已截断）';
        ctxFiles = ctxFiles.filter((x) => !x.auto);
        ctxFiles.push({ path, content, isDir: false, auto: true });
      }
    }
    renderChips();
    renderFollow();
  }
  // 用户点「不再跟随」：记住这次选择，切到别的文件才会重新跟随
  function unfollowActive() {
    const f = ctxFiles.find((x) => x.auto);
    if (!f) return;
    followMuted.add(f.path);
    ctxFiles = ctxFiles.filter((x) => !x.auto);
    renderChips();
    renderFollow();
    MI.toast('已取消跟随当前文件（切到别的文件会重新跟随）', 'ok');
  }

  // ---------- 拖拽引用 ----------
  // 把文件/文件夹直接拖进面板就进上下文。两类来源：
  //   ① 项目树里拖过来（tree.js 已经在发 text/myide-path / text/myide-paths 自定义 MIME）
  //   ② 从系统（资源管理器 / Finder）拖文件进来（Electron 32+ 移除了 File.path，得用 webUtils）
  async function addDropped(paths) {
    const uniq = [...new Set((paths || []).filter(Boolean))];
    let added = 0;
    for (const p of uniq) {
      if (ctxFiles.some((f) => f.path === p)) continue;
      const rf = await window.myIDE.fs.readFile(p);
      if (rf && !rf.error) {                       // 是文件 → 附内容
        let content = rf.content || '';
        if (content.length > MAX_CTX) content = content.slice(0, MAX_CTX) + '\n…（已截断）';
        ctxFiles.push({ path: p, content, isDir: false, dropped: true });
        added++;
        continue;
      }
      const root = String((window.App && App.root) || '').replace(/[\\/]+$/, '');
      const norm = (x) => String(x).replace(/\\/g, '/');
      let tree = '';
      if (root && norm(p).startsWith(norm(root) + '/')) {
        tree = await dirTreeText(norm(p).slice(norm(root).length + 1)); // 项目内目录：复用已有实现
      } else {
        const al = await window.myIDE.fs.listAll(p, false);             // 项目外目录：列一层路径清单
        const files = ((al && al.files) || []).slice(0, 300);
        if (files.length) {
          const base = norm(p);
          tree = files.map((f) => '  ' + norm(f).slice(base.length).replace(/^[\\/]/, '')).join('\n')
            + (files.length >= 300 ? '\n…（仅列前 300 个）' : '');
        }
      }
      if (!tree) continue;
      ctxFiles.push({ path: p, content: tree, isDir: true, dropped: true });
      added++;
    }
    renderChips();
    MI.toast(added ? '已加入上下文 ' + added + ' 项' : '没有可加入的内容（可能已在上下文里）', added ? 'ok' : 'err');
  }
  function initDrop() {
    if (!panel) return;
    const isFileDrag = (e) => {
      const dt = e.dataTransfer;
      if (!dt) return false;
      const types = [...(dt.types || [])];
      // 只接管「文件类」拖拽：树内拖拽（自定义 MIME）或系统文件；纯文本拖拽不拦
      return types.includes('Files') || types.includes('text/myide-path') || types.includes('text/myide-paths');
    };
    panel.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch {}
      panel.classList.add('drop-active');
    });
    panel.addEventListener('dragleave', (e) => {
      if (!panel.contains(e.relatedTarget)) panel.classList.remove('drop-active');
    });
    panel.addEventListener('drop', async (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      panel.classList.remove('drop-active');
      const paths = [];
      try {                                          // ① 项目树里拖来的
        const many = e.dataTransfer.getData('text/myide-paths');
        if (many) paths.push(...JSON.parse(many));
        const one = e.dataTransfer.getData('text/myide-path');
        if (one) paths.push(one);
      } catch {}
      const fl = e.dataTransfer.files;               // ② 从系统拖来的
      if (fl && fl.length) {
        for (const f of fl) {
          try { const p = window.myIDE.fs.pathOfDroppedFile(f); if (p) paths.push(p); } catch {}
        }
      }
      if (!paths.length) { MI.toast('没识别到文件路径', 'err'); return; }
      await addDropped(paths);
    });
  }

  // ---------- 改动卡片 ----------
  // 逐行 diff 渲染（确认弹窗与改动卡片共用）：长未改动段折叠为「⋯ N 行未改动 ⋯」
  // 命令确认：多给一个「记住这类命令」的出口
  // （Cursor 是 allowlist，VS Code 是 scoped approval —— 都在解决"点十几次确认"）
  function confirmRun(cmd, pre) {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.style.cssText = 'display:flex;flex-direction:column;min-width:460px;max-width:640px';
      box.innerHTML =
        '<div class="m-head">▶ AI 请求执行命令 <span class="x" id="cr-x">✕</span></div>' +
        '<div class="m-body">' +
          '<div style="white-space:pre-wrap;line-height:1.6;background:var(--bg-input);border:1px solid var(--border-mid);border-radius:6px;padding:8px 10px">' + esc(cmd) + '</div>' +
          '<div style="margin-top:8px;font-size:12px;color:var(--text-dim)">在项目目录执行。' +
            (pre ? '选「总是允许」后，以 <b>' + esc(pre) + '</b> 开头的命令不再询问（可在 设置 → AI 助手 清除）。' : '') +
          '</div>' +
        '</div>' +
        '<div class="m-foot">' +
          '<button class="tb-btn m-cancel" id="cr-no">拒绝</button>' +
          (pre ? '<button class="tb-btn" id="cr-always">总是允许「' + esc(pre) + '」</button>' : '') +
          '<button class="tb-btn m-ok" id="cr-yes">运行一次</button>' +
        '</div>';
      Modal.show(box);
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; Modal.hide(); resolve(v); };
      box.querySelector('#cr-no').onclick = () => finish(false);
      box.querySelector('#cr-yes').onclick = () => finish('once');
      const al = box.querySelector('#cr-always');
      if (al) al.onclick = () => finish('always');
      box.querySelector('#cr-x').onclick = () => finish(false);
    });
  }

  function diffRowsHtml(rows) {
    const parts = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].t !== ' ') {
        parts.push({ cls: rows[i].t === '+' ? 'd-add' : 'd-del', text: (rows[i].t === '+' ? '+' : '-') + ' ' + rows[i].s });
        continue;
      }
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
    return html;
  }
  // AI 改完一个文件 → 在消息流里留一张卡片：改了哪个文件、加减几行、能展开、能单独撤销。
  // 以前只留一行「🔧 replace_edit 周报.md」，用户想知道改了啥得自己翻文件。
  function addEditCard(cp, newText) {
    const rows = lineDiff(cp.oldText, newText);
    const addN = rows.filter((x) => x.t === '+').length;
    const delN = rows.filter((x) => x.t === '-').length;
    const card = document.createElement('div');
    card.className = 'ai-edit';
    card.innerHTML =
      '<div class="ai-edit-head">' +
        '<span class="ai-edit-nm" title="' + esc(cp.rel) + '">' + esc(cp.rel) + '</span>' +
        '<span class="ai-edit-stat"><i class="e-add">+' + addN + '</i><i class="e-del">-' + delN + '</i></span>' +
        '<button class="ai-edit-btn e-toggle">看改动</button>' +
        '<button class="ai-edit-btn e-undo" title="把这处改回原样">撤销</button>' +
      '</div>' +
      '<div class="ai-edit-body dw-diff hidden"></div>';
    const body = card.querySelector('.ai-edit-body');
    const tg = card.querySelector('.e-toggle');
    tg.onclick = () => {
      const show = body.classList.contains('hidden');
      if (show && !body.dataset.filled) {
        body.innerHTML = diffRowsHtml(rows); // 懒渲染：展开才铺 DOM
        body.dataset.filled = '1';
      }
      body.classList.toggle('hidden', !show);
      tg.textContent = show ? '收起' : '看改动';
    };
    card.querySelector('.e-undo').onclick = () => undoEditCp(cp);
    msgsEl.appendChild(card);
    scrollBottom();
    return card;
  }
  // 按处撤销：把这处改回写入前的样子（其余改动不受影响）
  async function undoEditCp(cp) {
    if (!cp) { MI.toast('找不到这处改动记录', 'err'); return; }
    if (cp.done) { MI.toast('这处已经撤销过了', 'ok'); return; }
    if (cp.existed) {
      const w = await window.myIDE.fs.writeFile(cp.path, cp.oldText);
      if (!w || w.error) { MI.toast('撤销失败：' + ((w && w.error) || ''), 'err'); return; }
    } else {
      const d = await window.myIDE.fs.remove(cp.path);
      if (!d || d.error) { MI.toast('撤销失败：' + ((d && d.error) || ''), 'err'); return; }
    }
    cp.done = true;
    if (cp.card) {
      cp.card.classList.add('undone');
      const u = cp.card.querySelector('.e-undo');
      if (u) { u.textContent = '已撤销'; u.disabled = true; }
    }
    MI.toast('已把 ' + cp.rel + ' 改回原样', 'ok');
    try { if (window.App && App.refreshAll) App.refreshAll(); } catch {}
  }

  // ---------- 附带上下文（📎 当前文件 + @ 引用文件/文件夹，统一 chips 展示）----------
  function renderChips() {
    const box = document.getElementById('ai-chips');
    if (!box) return;
    box.innerHTML = '';
    const manual = ctxFiles.filter((x) => !x.auto); // 自动跟随的由「正在看」条显示
    box.classList.toggle('hidden', !manual.length);
    for (const f of manual) {
      const chip = document.createElement('span');
      chip.className = 'ai-ctx-chip' + (f.isDir ? ' dir' : '');
      chip.title = f.path + '（点击移除）';
      const nm = document.createElement('span');
      nm.textContent = (f.isDir ? '🗂 ' : '📄 ') + f.path.replace(/^.*[\\/]/, '') + (f.isDir ? '/' : '');
      const x = document.createElement('span');
      x.className = 'ai-ctx-x';
      x.textContent = '✕';
      chip.appendChild(nm);
      chip.appendChild(x);
      chip.onclick = () => { removeCtx(f.path); };
      box.appendChild(chip);
    }
  }
  function removeCtx(path) {
    const wasAuto = ctxFiles.some((f) => f.auto && f.path === path);
    ctxFiles = ctxFiles.filter((f) => f.path !== path);
    if (wasAuto) followMuted.add(path); // 用户主动去掉的，别自动加回来
    renderChips();
    renderFollow();
  }
  function addCtx(entry) {
    followMuted.delete(entry.path); // 用户手动加回来的，撤销之前「不跟随」的决定
    if (ctxFiles.some((f) => f.path === entry.path)) { MI.toast('已在上下文中：' + entry.path, 'ok'); return; }
    ctxFiles.push(entry);
    renderChips();
  }
  // 📎 按钮：附当前编辑器文件（已在列表中则移除，再点取消）
  async function toggleCtxFile() {
    const tab = Viewer.activeTab;
    if (!tab || tab.dir) { MI.toast('当前没有打开的文件', 'err'); return; }
    if (ctxFiles.some((f) => f.path === tab.path)) { removeCtx(tab.path); return; }
    const r = await window.myIDE.fs.readFile(tab.path);
    if (!r || r.error) { MI.toast('读取文件失败: ' + (r && r.error || ''), 'err'); return; }
    let content = r.content || '';
    if (content.length > MAX_CTX) content = content.slice(0, MAX_CTX) + '\n…（已截断）';
    addCtx({ path: tab.path, content, isDir: false });
    MI.toast('已附上 ' + tab.path.replace(/^.*[\\/]/, ''), 'ok');
  }

  // ---------- @ 引用（文件 / 文件夹）----------
  // 输入 @ 弹出项目文件/目录补全；选中文件附内容、选中文件夹附目录树结构
  let mentionState = null; // {start(光标处@token起点), items, sel, popup}
  let mentionCache = null; // [{name, rel, path, isDir}]（含从文件路径推导出的目录）
  let mentionRoot = null; // 缓存对应的项目根（换项目自动失效）
  async function ensureMentionList() {
    const root = (window.App && App.root) || '';
    if (!root) return null;
    if (mentionCache && mentionRoot === root) return mentionCache;
    const r = await window.myIDE.fs.listAll(root, false);
    if (!r || r.error) return null;
    const files = (r.files || []).map((full) => {
      const rel = String(full).slice(root.length).replace(/^[\\/]/, '');
      return { name: rel.replace(/^.*[\\/]/, ''), rel, path: full, isDir: false };
    });
    // 目录从文件路径推导（含全部非空目录；空目录罕见，可接受）
    const dirSet = new Set();
    for (const f of files) {
      let p = f.rel;
      while ((p = p.replace(/[\\/][^\\/]*$/, ''))) dirSet.add(p);
    }
    const dirs = [...dirSet].map((rel) => ({ name: rel.replace(/^.*[\\/]/, ''), rel, path: root + '/' + rel, isDir: true }));
    // 目录排前（先选范围再选具体文件，符合 @ 的浏览习惯）
    mentionCache = dirs.sort((a, b) => a.rel < b.rel ? -1 : 1).concat(files.sort((a, b) => a.rel < b.rel ? -1 : 1));
    mentionRoot = root;
    return mentionCache;
  }
  // 目录树文本（附文件夹上下文用）：递归列出 name，深度/数量双限防 token 爆炸
  async function dirTreeText(relDir) {
    const root = (window.App && App.root || '').replace(/[\\/]+$/, '');
    const out = [];
    const MAX_ITEMS = 300;
    const walk = async (rel, depth) => {
      if (out.length >= MAX_ITEMS || depth > 5) return;
      const r = await window.myIDE.fs.readDir(rel ? root + '/' + rel : root);
      if (!r || r.error) return;
      const list = Array.isArray(r) ? r : (r.files || r.children || []);
      const sorted = list.slice().sort((a, b) => ((b.type === 'dir') - (a.type === 'dir')) || (a.name < b.name ? -1 : 1));
      for (const e of sorted) {
        if (out.length >= MAX_ITEMS) { out.push('…（超过 ' + MAX_ITEMS + ' 项已截断）'); return; }
        const isDir = e.type === 'dir' || e.isDir || e.isDirectory;
        out.push('  '.repeat(depth) + (isDir ? '[目录] ' : '') + e.name);
        if (isDir) await walk((rel ? rel + '/' : '') + e.name, depth + 1);
      }
    };
    await walk(relDir, 0);
    return out.join('\n') || '（空目录）';
  }
  function closeMention() {
    if (mentionState && mentionState.popup && mentionState.popup.parentNode) mentionState.popup.parentNode.removeChild(mentionState.popup);
    mentionState = null;
  }
  function activeMentionToken() {
    if (!inputEl) return null;
    const pos = inputEl.selectionStart;
    if (pos == null) return null;
    const before = inputEl.value.slice(0, pos);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!m) return null;
    return { query: m[2], start: pos - m[2].length - 1 }; // start 含 @ 本身
  }
  function renderMention() {
    if (!mentionState) return;
    const items = mentionState.items;
    const popup = mentionState.popup;
    const list = popup.querySelector('.ai-at-list');
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="ai-at-empty">没有匹配的文件或文件夹</div>';
      return;
    }
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'ai-at-item' + (i === mentionState.sel ? ' sel' : '');
      row.innerHTML = '<span class="ai-at-ic">' + (it.isDir ? '🗂' : '📄') + '</span>' +
        '<span class="ai-at-name">' + esc(it.name) + (it.isDir ? '/' : '') + '</span>' +
        '<span class="ai-at-rel">' + esc(it.rel) + '</span>';
      row.onclick = () => pickMention(i);
      list.appendChild(row);
    });
    const selEl = list.children[mentionState.sel];
    if (selEl && selEl.scrollIntoView) { try { selEl.scrollIntoView({ block: 'nearest' }); } catch {} }
  }
  async function openMention(token) {
    const all = await ensureMentionList();
    if (!all || !all.length) return;
    const q = token.query.toLowerCase();
    const items = (q
      ? all.filter((x) => (x.name + ' ' + x.rel).toLowerCase().includes(q))
      : all).slice(0, 50);
    closeMention();
    // 弹窗锚定在面板内（左右各留 12px，永不超出 AI 面板边界），出现在输入框上方
    const popup = document.createElement('div');
    popup.className = 'ai-at-pop';
    popup.innerHTML = '<div class="ai-at-list"></div>';
    const bar = inputEl.closest('.ai-input-bar');
    (bar || panel).appendChild(popup);
    mentionState = { start: token.start, items, sel: 0, popup };
    renderMention();
  }
  async function pickMention(idx) {
    if (!mentionState) return;
    const it = mentionState.items[idx];
    const start = mentionState.start;
    closeMention();
    if (!it) return;
    // 替换输入框里的 @token 为 @相对路径
    const val = inputEl.value;
    const after = val.slice(inputEl.selectionStart == null ? start + 1 : inputEl.selectionStart);
    inputEl.value = val.slice(0, start) + '@' + it.rel + ' ' + after;
    inputEl.focus();
    try { inputEl.setSelectionRange(start + it.rel.length + 2, start + it.rel.length + 2); } catch {}
    // 附上下文：文件读内容（截断），文件夹列目录树
    if (it.isDir) {
      MI.toast('正在读取目录结构…', 'ok');
      const tree = await dirTreeText(it.rel);
      addCtx({ path: it.rel, content: tree, isDir: true });
      MI.toast('🗂 已附上目录 ' + it.rel + ' 的结构', 'ok');
    } else {
      const r = await window.myIDE.fs.readFile(it.path);
      if (!r || r.error) { MI.toast('读取文件失败: ' + ((r && r.error) || ''), 'err'); return; }
      let content = r.content || '';
      if (content.length > MAX_CTX) content = content.slice(0, MAX_CTX) + '\n…（已截断）';
      addCtx({ path: it.rel, content, isDir: false });
      MI.toast('📄 已附上 ' + it.name, 'ok');
    }
  }
  function onInputMention() {
    const token = activeMentionToken();
    if (!token) { closeMention(); return; }
    if (mentionState) {
      // 已开弹窗：跟随输入过滤（保住 start 锚点）
      const q = token.query.toLowerCase();
      const all = mentionCache || [];
      mentionState.items = (q ? all.filter((x) => (x.name + ' ' + x.rel).toLowerCase().includes(q)) : all).slice(0, 50);
      mentionState.sel = 0;
      renderMention();
      return;
    }
    openMention(token);
  }
  // 弹窗打开时键盘接管：↑↓ 换选、Enter 选中、Esc 关闭（不与发送冲突）
  function onKeydownMention(e) {
    if (!mentionState) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionState.sel = Math.min(mentionState.sel + 1, mentionState.items.length - 1); renderMention(); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionState.sel = Math.max(mentionState.sel - 1, 0); renderMention(); return true; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pickMention(mentionState.sel); return true; }
    if (e.key === 'Escape') { e.preventDefault(); closeMention(); return true; }
    return false;
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
    const followBox = document.getElementById('ai-follow');
    if (followBox) {
      const fx = followBox.querySelector('.ai-follow-x');
      if (fx) fx.onclick = unfollowActive;
    }
    if (inputEl) {
      // 输入框获得焦点时同步「正在看哪个文件」（用户可能刚切过标签）
      inputEl.addEventListener('focus', () => { followActive(); });
      inputEl.addEventListener('input', onInputMention);
      inputEl.addEventListener('keydown', (e) => {
        if (onKeydownMention(e)) return; // @ 补全弹窗接管：↑↓/Enter/Esc
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
      usageSum = { in: 0, out: 0, cacheHit: 0, cacheMiss: 0 };
      renderUsage();
      // 新对话保留「当前正在看的文件」（否则每开一次新对话都得重新附一次）
      ctxFiles = ctxFiles.filter((f) => f.auto);
      renderChips();
      renderFollow();
      msgsEl.innerHTML = '';
      showWelcome();
      MI.toast('已开始新对话', 'ok');
    };
    const undoBtn = document.getElementById('ai-undo');
    if (undoBtn) undoBtn.onclick = undoCheckpoint;
    const cfgBtn = document.getElementById('ai-cfg');
    if (cfgBtn) cfgBtn.onclick = () => { Settings.open('ai'); };
    if (fileChip) fileChip.onclick = toggleCtxFile;
    initDrop(); // 拖文件进面板 = 加进上下文
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

  // 编程式提问（048-P2 AI 联动入口）：填入并发送；面板没开先打开（App.showAi）
  // busy 时静默拒绝（不打断进行中的生成）——调用方靠 toast 提示
  function ask(text) {
    const v = String(text || '').trim();
    if (!v) return false;
    if (busy) return false;
    if (window.App && App.showAi) App.showAi();
    const el2 = document.getElementById('ai-input');
    if (el2) el2.value = v;
    send();
    return true;
  }

  return { init, syncVisible, getConfig, setConfig, PROVIDERS, providerOf, ask, followActive, unfollowActive, loadPerms, savePerms, sessionPerm };
})();
window.AiPanel = AiPanel;

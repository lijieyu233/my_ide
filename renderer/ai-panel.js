// ai-panel.js —— AI 助手对话面板（右侧停靠，PyCharm AI Assistant 式）
// 流式对话：主进程 ai-service SSE → ai:chunk/ai:done 事件；配置存 localStorage（与翻译插件同模式）
const AiPanel = (() => {
  const panel = document.getElementById('ai-panel');
  const msgsEl = document.getElementById('ai-msgs');
  const inputEl = document.getElementById('ai-input');
  const sendBtn = document.getElementById('ai-send');

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
  let pendingImages = [];    // 待发送的图片（dataURL）：贴图直接进下一条消息
  let uiSeq = 0;             // 消息序号（给 DOM 行挂 id，编辑/重发时要能找到是哪条）
  let lastUserAt = null;     // 上一条用户消息在 msgs 里的下标（重新生成时回退到这里）
  let curSessionId = null;   // 当前会话 id（历史会话列表用）

  // ---------- token 用量显示 ----------
  // 粗估当前上下文（无 usage 时的近似值：英文 ~4 字符/token、中文更密，取 3.2 折中）
  function estTokens() {
    let chars = 0;
    for (const m of msgs) chars += msgChars(m) + 40;
    return Math.round(chars / 3.2);
  }
  // 消息内容可能是字符串，也可能是多模态数组（贴图时）——按「图片≈800 tok」折算
  function msgChars(m) {
    if (typeof m.content === 'string') return m.content.length;
    if (Array.isArray(m.content)) return m.content.reduce((n, p) => n + (p && p.type === 'image_url' ? 2560 : String((p && p.text) || '').length), 0);
    return 0;
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

  // ---------- 上下文预算明细 ----------
  // 「上下文 ~12k tok」这种单个数字没法指导行动：用户想知道「谁在占地方、要不要摘掉」。
  // VS Code Copilot 会把每条上下文的占比列出来，这里照做（点用量条弹出）。
  function showCtxBreakdown() {
    const estOf = (n) => Math.round(n / 3.2);
    const rows = [];
    for (const f of ctxFiles) {
      const n = String(f.content || '').length;
      rows.push({
        ic: f.isDir ? '\u{1F5C2}' : '\u{1F4C4}',
        nm: f.path,
        sub: fmtK(n) + ' 字符 · ~' + fmtK(estOf(n)) + ' tok',
        tag: f.pin ? '已固定' : (f.auto ? '跟随当前文件' : (f.dropped ? '拖入' : '')),
        weight: n,
      });
    }
    let msgChars = 0;
    for (const mm of msgs) msgChars += (typeof mm.content === 'string' ? mm.content.length : 200);
    rows.push({ ic: '\u{1F5E8}', nm: '对话历史（' + msgs.length + ' 条）', sub: fmtK(msgChars) + ' 字符 · ~' + fmtK(estOf(msgChars)) + ' tok', tag: '不可摘', weight: msgChars });
    const maxW = Math.max(1, ...rows.map((r) => r.weight));
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;min-width:420px;max-width:600px;max-height:64vh';
    let html = '<div class="m-head">\u{1F4CA} 上下文占用 <span class="x" id="cb-x">\u2715</span></div>' +
      '<div class="m-body" style="overflow:auto">' +
      '<div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">' +
        '当前上下文约 <b>' + fmtK(estTokens()) + ' tok</b>（按字符数估算；接入模型返回 usage 后以真实值为准）。' +
        '附带的文件每条消息都会重发一次 —— 太大就摘掉一些。</div>';
    for (const r of rows) {
      const pct = Math.max(2, Math.round((r.weight / maxW) * 100));
      html += '<div class="ai-bd-row">' +
        '<span class="ai-bd-ic">' + r.ic + '</span>' +
        '<span class="ai-bd-main"><span class="ai-bd-nm" title="' + esc(r.nm) + '">' + esc(r.nm) + '</span>' +
        '<span class="ai-bd-sub">' + esc(r.sub) + (r.tag ? ' · ' + esc(r.tag) : '') + '</span>' +
        '<span class="ai-bd-bar"><i style="width:' + pct + '%"></i></span></span></div>';
    }
    if (ctxFiles.length > 1) {
      html += '<div style="margin-top:10px"><button class="tb-btn" id="cb-clear">摘掉所有未固定的上下文</button></div>';
    }
    html += '</div>';
    box.innerHTML = html;
    Modal.show(box);
    const close = () => Modal.hide();
    box.querySelector('#cb-x').onclick = close;
    const cl = box.querySelector('#cb-clear');
    if (cl) cl.onclick = () => {
      ctxFiles = ctxFiles.filter((f) => f.auto || f.pin);
      renderChips(); renderFollow(); renderUsage(); close();
      MI.toast('已摘掉未固定的上下文', 'ok');
    };
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
    return ['confirm', 'auto', 'deny'].includes(v) ? v : 'confirm';
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
  // 危险命令永远要问一次：路径白名单 / 记住授权 / /yolo 都不豁免。
  // （Cursor 的 deny 优先级高于 allow，同一条规矩：能一键放行「改文件」，但不能一键放行 rm。）
  const DANGER_TOKENS = ['rm', 'rmdir', 'rd', 'del', 'erase', 'format', 'diskpart', 'dd', 'shutdown', 'reboot',
    'taskkill', 'kill', 'pkill', 'chmod', 'chown', 'takeown', 'icacls', 'reg'];
  const DANGER_SEQ = ['git clean', 'git reset --hard', 'git reset --keep', 'git push --force', 'git push -f',
    'git branch -d', 'git branch -D', 'git checkout --', 'git restore', '> /dev/sda'];
  function dangerousCmd(cmd) {
    const t = String(cmd || '').trim().toLowerCase();
    if (!t) return false;
    for (const sq of DANGER_SEQ) if (t.includes(sq.toLowerCase())) return true;
    // 按管道 / 分号 / && 拆开，逐段看第一个词（`npm run x && rm -rf y` 也要认出来）
    for (const seg of t.split(/[;&|]+/)) {
      const first = (seg.trim().split(/\s+/)[0] || '');
      const base = first.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|sh|ps1|com)$/, '');
      if (base && DANGER_TOKENS.includes(base)) return true;
    }
    return false;
  }
  // 简化的 glob（支持 ** 与 *），用来做写入路径白名单
  const RE_META = '\\^$.|?*+()[]{}';
  function escRe(x) { return String(x).split('').map((c) => (RE_META.indexOf(c) >= 0 ? '\\' + c : c)).join(''); }
  function globMatch(pat, rel) {
    const p = String(pat || '').replace(/\\/g, '/').replace(/^\.?\//, '').trim();
    const r = String(rel || '').replace(/\\/g, '/');
    if (!p) return false;
    const rx = '^' + p.split('**').map((seg) => seg.split('*').map(escRe).join('[^/]*')).join('.*') + '$';
    try { return new RegExp(rx).test(r); } catch { return false; }
  }
  function pathAllowed(rel) {
    const list = getConfig().allowPaths;
    if (!Array.isArray(list) || !list.length) return false;
    return list.some((x) => x && globMatch(x, rel));
  }

  function writeNeedsConfirm(rel) {
    const base = permWrite();
    if (base === 'deny') return 'deny';
    if (base === 'auto') return 'no';
    if (sessionPerm.write || loadPerms().write) return 'no';
    if (rel && pathAllowed(rel)) return 'no';   // 只放行你点头过的目录，避免「一处放心 = 全项目放行」
    return 'yes';
  }
  function runNeedsConfirm(cmd) {
    const base = permRun();
    if (base === 'deny') return 'deny';
    const t = String(cmd || '').trim();
    const lc = t.toLowerCase();
    if (dangerousCmd(t)) return 'danger';                                    // 内置危险命令
    const deny = (getConfig().denyCmds || []).filter((x) => x && String(x).trim());
    if (deny.some((d2) => lc.startsWith(String(d2).trim().toLowerCase()))) return 'danger'; // 用户黑名单
    if (base === 'auto') return 'no';            // 预设「自动执行」（危险命令 / 黑名单已在上面拦掉）
    if (sessionPerm.run || loadPerms().run) return 'no';
    if ((loadPerms().cmds || []).some((pre) => pre && t.startsWith(pre))) return 'no';
    return 'yes';
  }

  // ---------- 访问权限浮层（头部盾牌按钮）----------
  // 用户的原话：「能不能预先给权限，不用每一个修改都要确认」。
  // 以前只能钻进 设置 → AI 助手 改下拉，改完也不知道生效没。现在一个按钮摊开：
  // 两个维度的档位（改文件 / 执行命令）+ 本项目已记住的授权（看得见、清得掉）。
  let permPop = null;
  function closePermPop() {
    if (permPop && permPop.parentNode) permPop.parentNode.removeChild(permPop);
    permPop = null;
  }
  function syncPermBtn() {
    const b = document.getElementById('ai-perm');
    if (!b) return;
    const auto = permWrite() === 'auto' || !!loadPerms().write;
    b.classList.toggle('on', auto);
    b.title = '访问权限：改文件 ' + ({ confirm: '每次确认', auto: '自动应用', deny: '禁止' }[permWrite()] || '')
      + ' · 命令 ' + ({ confirm: '每次确认', auto: '自动执行', deny: '禁止' }[permRun()] || '')
      + (auto ? '（已开启自动应用）' : '');
  }
  function togglePermPop() { if (permPop) closePermPop(); else renderPermPop(); }
  function renderPermPop() {
    closePermPop();
    const segHtml = (key, cur) => {
      const opts = [{ v: 'confirm', t: '每次确认' }, { v: 'auto', t: '自动' }, { v: 'deny', t: '禁止' }];
      return '<div class="ai-seg">' + opts.map((o) =>
        '<button data-set="' + key + ':' + o.v + '" class="' + (o.v === cur ? 'on' : '') + '">' + o.t + '</button>').join('') + '</div>';
    };
    const pop = document.createElement('div');
    pop.className = 'ai-perm-pop';
    let html =
      '<div class="ai-perm-sec"><span class="ai-perm-lb">改文件</span>' + segHtml('permWrite', permWrite()) + '</div>' +
      '<div class="ai-perm-sec"><span class="ai-perm-lb">执行命令</span>' + segHtml('permRun', permRun()) + '</div>' +
      '<div class="ai-perm-note">选「自动」后不再逐次弹确认；但危险命令（rm / del / git reset --hard…）与「把文件清空」始终要单独点一次。</div>';
    const p = loadPerms();
    const items = [];
    if (p.write) items.push({ k: 'write', t: '本项目改文件不再询问' });
    if (p.run) items.push({ k: 'run', t: '本项目执行命令不再询问' });
    for (const c of (p.cmds || [])) items.push({ k: 'cmd:' + c, t: '「' + c + '」开头的命令不再询问' });
    for (const g of (getConfig().allowPaths || [])) items.push({ k: 'path:' + g, t: '写入 ' + g + ' 不询问' });
    if (items.length) {
      html += '<div class="ai-perm-sec" style="margin:8px 0 0"><span class="ai-perm-lb">已记住的授权（本项目）</span>';
      for (const it of items) {
        html += '<div class="ai-perm-item"><span title="' + esc(it.t) + '">' + esc(it.t) + '</span>' +
          '<button class="tb-btn" data-clear="' + esc(it.k) + '">清除</button></div>';
      }
      html += '</div>';
    } else {
      html += '<div class="ai-perm-note">还没有记住任何授权。</div>';
    }
    pop.innerHTML = html;
    panel.appendChild(pop);
    permPop = pop;
    pop.addEventListener('click', (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.set) {
        const i = t.dataset.set.indexOf(':');
        setConfig({ [t.dataset.set.slice(0, i)]: t.dataset.set.slice(i + 1) });
        renderPermPop(); syncPermBtn();
        const k = t.dataset.set.slice(0, i);
        MI.toast(k === 'permWrite' ? '改文件权限：' + (t.textContent) : '执行命令权限：' + (t.textContent), 'ok');
        return;
      }
      if (t.dataset && t.dataset.clear) {
        const k = t.dataset.clear;
        if (k.indexOf('path:') === 0) { MI.toast('路径白名单请到 设置 → AI 助手 里删该行', 'err'); return; }
        const np = loadPerms();
        if (k === 'write') delete np.write;
        else if (k === 'run') delete np.run;
        else if (k.indexOf('cmd:') === 0) np.cmds = (np.cmds || []).filter((x) => x !== k.slice(4));
        savePerms(np);
        renderPermPop(); syncPermBtn();
        MI.toast('已清除该授权（下次会重新询问）', 'ok');
      }
    });
    document.addEventListener('mousedown', function onOut(ev) {
      if (!permPop) { document.removeEventListener('mousedown', onOut); return; }
      if (!permPop.contains(ev.target) && !(ev.target.closest && ev.target.closest('#ai-perm'))) {
        closePermPop();
        document.removeEventListener('mousedown', onOut);
      }
    });
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
      if (needR === 'yes' || needR === 'danger') {
        // 确认闸：命令有副作用必须批准，但给「记住这类命令」的出口。
        // danger（rm / git reset --hard / 用户黑名单）不给「总是允许」，只能逐次点。
        const ans = await confirmRun(cmd, needR === 'danger' ? '' : cmdPrefixOf(cmd), needR === 'danger');
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
    let needW = writeNeedsConfirm(loc.rel);
    if (needW === 'deny') {
      return { ok: false, text: '用户已禁止 AI 写入文件（设置 → AI 助手 → 访问权限）' };
    }
    const old = await window.myIDE.fs.readFile(full);
    const oldText = old && !old.error ? (old.content || '') : '';
    const existed = old && !old.error;
    // 删除保护：把已有内容清空 = 删内容。即便前面放行了写入（白名单 / 记住授权 / auto），
    // 这一步也必须问一次 —— 这是最容易造成不可逆损失的操作（Cursor 也单独保护删除）。
    const isWipe = existed && String(oldText).trim() !== '' && String(content).trim() === '';
    if (needW === 'no' && isWipe) needW = 'danger';
    if (needW === 'yes' || needW === 'danger') {
      const ans = await confirmDiff(loc.rel, oldText, content, needW === 'danger'); // 'once' | 'always' | false
      if (!ans) return { ok: false, text: '用户拒绝了本次写入 ' + loc.rel + '（未做任何修改）' };
      if (ans === 'always') grantPerm('write', 'project');
    }
    const w = await window.myIDE.fs.writeFile(full, content);
    if (!w || w.error) return { ok: false, text: '错误：写入失败 ' + ((w && w.error) || '') };
    // 检查点 + 改动卡片：写下前的旧内容留档（新文件记 existed:false，撤销时删除）
    // 刚写完的就是规则文件 → 让缓存失效，下次提问立即按新规则（否则要切项目才生效）
    if (RULE_FILES.includes(String(loc.rel).replace(/^\.\//, ''))) rulesRoot = null;
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

  // 改动确认：贴在面板底部的浮层（返回 'once' | 'always' | false）。
  // 以前是居中大模态 —— 一跳出来编辑器被整个盖住，用户没法一边看真实文件一边决定改不改。
  // Cursor（编辑器内 inline diff + Keep/Undo）、Cline（对话流里的 diff 卡片）、
  // VS Code（Working Set 里开 diff 视图）都是「就地给 diff、决策按钮贴着 diff」，这里取同样的路子：
  // 不抢焦点、不遮编辑器，diff 默认展开、可收起。
  function confirmDiff(rel, oldText, newText, danger) {
    return new Promise((resolve) => {
      const rows = lineDiff(oldText, newText);
      const addN = rows.filter((r) => r.t === '+').length, delN = rows.filter((r) => r.t === '-').length;
      const box = document.createElement('div');
      box.className = 'ai-confirm';
      box.innerHTML =
        '<div class="ai-cf-head' + (danger ? ' warn' : '') + '">' +
          '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">' + (danger
            ? '<path d="M8 2.8l5.2 9.2H2.8z"/><path d="M8 6.4v3.2M8 11.5v.1"/>'
            : '<path d="M4.4 2.3h4.1l3 3v8.4H4.4z"/><path d="M8.5 2.3v3h3"/>') + '</svg>' +
          '<span class="ai-cf-nm" title="' + esc(rel) + '">' + esc(rel) + '</span>' +
          '<span class="ai-cf-stat"><i class="e-add">+' + addN + '</i><i class="e-del">-' + delN + '</i></span>' +
          '<button class="ai-cf-fold" id="dw-fold">收起</button>' +
        '</div>' +
        '<div class="ai-cf-body dw-diff" id="dw-diff">' + diffRowsHtml(rows) + '</div>' +
        (danger ? '<div class="ai-cf-note warn">改完这个文件就空了 —— 等于把已有内容删掉。这一步不提供「以后都允许」。</div>' : '') +
        '<div class="ai-cf-foot">' +
          (danger ? '' : '<button class="ai-cf-quiet" id="dw-always" title="以后本项目里改文件都不再询问（权限按钮或设置里可清除）">本项目内都允许</button>') +
          '<button class="tb-btn m-cancel" id="dw-no">拒绝</button>' +
          '<button class="tb-btn ' + (danger ? 'm-cancel' : 'm-ok') + '" id="dw-yes">' + (danger ? '确认清空' : '应用修改') + '</button>' +
        '</div>';
      const prev = panel.querySelector('.ai-confirm');
      if (prev) prev.parentNode.removeChild(prev); // 上一处没处理完的确认先作废（它指向的文件可能已经变了）
      panel.appendChild(box);
      let settled = false;
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
      const finish = (v) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey);
        if (box.parentNode) box.parentNode.removeChild(box);
        resolve(v);
      };
      document.addEventListener('keydown', onKey);
      box.querySelector('#dw-yes').onclick = () => finish('once');
      const al = box.querySelector('#dw-always');
      if (al) al.onclick = () => finish('always');
      box.querySelector('#dw-no').onclick = () => finish(false);
      const fold = box.querySelector('#dw-fold');
      fold.onclick = () => {
        const hid = box.querySelector('#dw-diff').classList.toggle('hidden');
        fold.textContent = hid ? '展开 diff' : '收起';
      };
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
    curStream.dataset.mid = 'a' + (++uiSeq);
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
  function addMsg(role, text, opts) {
    const row = document.createElement('div');
    row.className = 'ai-msg ' + (role === 'user' ? 'ai-user' : 'ai-assistant');
    const pre = document.createElement('div');
    pre.className = 'ai-md';
    if (role === 'user') {
      pre.innerHTML = '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
      // 贴图：气泡里也把图显示出来（否则发完就看不见自己发了什么）
      const imgs = (opts && opts.imgs) || [];
      for (const u of imgs) {
        const im = document.createElement('img');
        im.className = 'ai-msg-img';
        im.src = u;
        im.alt = '发送的图片';
        pre.appendChild(im);
      }
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
    if (role === 'user') {
      // 编辑并重发（Cursor / Copilot 都有）：说错一句话不用重开一轮
      const acts = document.createElement('div');
      acts.className = 'ai-msg-acts';
      const eb = document.createElement('button');
      eb.className = 'ai-act-btn';
      eb.textContent = '\u270E 编辑并重发';
      eb.title = '把这条消息放回输入框，改完重新发送（这条之后的对话会被丢弃）';
      eb.onclick = () => editUserMsg(row.dataset.mid);
      acts.appendChild(eb);
      row.appendChild(acts);
    } else {
      decorateCodeBlocks(row);
    }
    msgsEl.appendChild(row);
    scrollBottom();
    return row;
  }

  // ---------- 代码块：逐块复制 / 插入编辑器 ----------
  // 以前回复里的代码只能整个复制到剪贴板，再自己去编辑器粘贴定位。
  function decorateCodeBlocks(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.dataset.acts) return;
      pre.dataset.acts = '1';
      const code = pre.querySelector('code');
      const txtOf = () => (code ? code.textContent : pre.textContent);
      const bar = document.createElement('div');
      bar.className = 'ai-code-acts';
      const mk = (label, title, fn) => {
        const bt = document.createElement('button');
        bt.className = 'ai-code-act';
        bt.textContent = label;
        bt.title = title;
        bt.onclick = (e) => { e.stopPropagation(); fn(); };
        bar.appendChild(bt);
      };
      mk('复制', '复制这段内容', async () => {
        try { await MI.copyText(txtOf()); MI.toast('已复制代码块', 'ok'); } catch (e) { MI.toast('复制失败', 'err'); }
      });
      mk('插入到编辑器', '插入到当前编辑器的光标处（有选区则替换选区）', () => insertIntoEditor(txtOf()));
      pre.appendChild(bar);
    });
  }

  // 插入到当前编辑器（CM6 优先；纯文本模式回退到 textarea）
  function insertIntoEditor(text) {
    const t = String(text == null ? '' : text);
    if (!t) return false;
    try {
      const cm = window.Viewer && Viewer.cm;
      if (cm && cm.view && cm.view.dispatch) {
        const v = cm.view;
        const sel = v.state.selection.main;
        v.dispatch({
          changes: { from: sel.from, to: sel.to, insert: t },
          selection: { anchor: sel.from + t.length },
        });
        v.focus();
        MI.toast('已插入到编辑器', 'ok');
        return true;
      }
    } catch {}
    const ae = document.activeElement;
    if (ae && ae.tagName === 'TEXTAREA' && ae.selectionStart != null) {
      const p = ae.selectionStart, q = ae.selectionEnd == null ? p : ae.selectionEnd;
      ae.value = ae.value.slice(0, p) + t + ae.value.slice(q);
      ae.selectionStart = ae.selectionEnd = p + t.length;
      MI.toast('已插入到编辑器', 'ok');
      return true;
    }
    MI.toast('先在编辑器里打开一个文件，再点插入', 'err');
    return false;
  }

  // ---------- 编辑已发消息 / 重新生成 ----------
  function removeRegen() {
    try { msgsEl.querySelectorAll('.ai-regen').forEach((b) => b.remove()); } catch {}
  }
  // 只在「最后一条助手回复」上挂 ⟳：中间那些重新生成没有意义，到处挂只会误点
  function markRegen() {
    removeRegen();
    if (busy || lastUserAt == null || lastUserAt >= msgs.length) return;
    const rows = [...msgsEl.querySelectorAll('.ai-msg.ai-assistant')];
    const last = rows[rows.length - 1];
    if (!last) return;
    const b = document.createElement('button');
    b.className = 'ai-regen';
    b.textContent = '\u27F3 重新生成';
    b.title = '丢弃这个回复，让模型重新答一次';
    b.onclick = regenerate;
    last.appendChild(b);
  }
  async function regenerate() {
    if (busy) { MI.toast('正在生成中…', 'err'); return; }
    if (lastUserAt == null || lastUserAt >= msgs.length) { MI.toast('没有可重新生成的回复', 'err'); return; }
    msgs.length = lastUserAt + 1;             // 保留那条用户消息，丢掉之后的
    const keep = msgs[lastUserAt] && msgs[lastUserAt]._ui;
    const rows = [...msgsEl.querySelectorAll('.ai-msg, .ai-tool')];
    const at = rows.findIndex((r) => r.dataset.mid === keep);
    for (let i = rows.length - 1; i > at; i--) rows[i].remove(); // 改动卡片留着（文件确实改了，撤销入口不能丢）
    removeRegen();
    agentRounds = 0;
    agentStopped = false;
    busy = true;
    setBusyUI(true);
    await continueStream();
  }
  function editUserMsg(mid) {
    if (!mid) { MI.toast('找不到这条消息', 'err'); return; }
    if (busy) { MI.toast('正在生成中，先点停止再编辑', 'err'); return; }
    const idx = msgs.findIndex((m) => m._ui === mid);
    if (idx < 0) { MI.toast('找不到这条消息', 'err'); return; }
    const text = msgs[idx]._text || (typeof msgs[idx].content === 'string' ? msgs[idx].content : '');
    const rows = [...msgsEl.querySelectorAll('.ai-msg, .ai-tool')];
    const at = rows.findIndex((r) => r.dataset.mid === mid);
    msgs.length = idx;                        // 这条及其之后全部丢弃（重发会重新生成）
    for (let i = rows.length - 1; i >= at && at >= 0; i--) rows[i].remove();
    removeRegen();
    lastUserAt = null;
    inputEl.value = text;
    pendingImages = (msgs[idx] && msgs[idx]._imgs) ? msgs[idx]._imgs.slice() : pendingImages;
    renderImages();
    inputEl.focus();
    try { inputEl.setSelectionRange(text.length, text.length); } catch {}
    MI.toast('已放回输入框，改完直接回车重发', 'ok');
  }

  // ---------- 贴图（内容整理经常要「照这张图改」）----------
  function renderImages() {
    const box = document.getElementById('ai-images');
    if (!box) return;
    box.innerHTML = '';
    box.classList.toggle('hidden', !pendingImages.length);
    pendingImages.forEach((u, i) => {
      const d = document.createElement('span');
      d.className = 'ai-img-thumb';
      const im = document.createElement('img');
      im.src = u;
      im.alt = '待发送图片';
      const x = document.createElement('button');
      x.className = 'ai-img-x';
      x.textContent = '\u2715';
      x.title = '移除这张图';
      x.onclick = (e) => { e.stopPropagation(); pendingImages.splice(i, 1); renderImages(); };
      d.appendChild(im);
      d.appendChild(x);
      box.appendChild(d);
    });
  }
  function onPasteImage(e) {
    const dt = e.clipboardData;
    if (!dt || !dt.items) return;
    const item = [...dt.items].find((it) => it.kind === 'file' && /^image\//.test(it.type || ''));
    if (!item) return;
    e.preventDefault();
    const f = item.getAsFile();
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) { MI.toast('图片超过 4MB，先压缩一下再贴（大图又贵又慢）', 'err'); return; }
    const fr = new FileReader();
    fr.onload = () => {
      pendingImages.push(String(fr.result || ''));
      renderImages();
      MI.toast('已附上图片，发送时一并给模型（需要模型支持看图）', 'ok');
    };
    fr.onerror = () => MI.toast('读图片失败', 'err');
    fr.readAsDataURL(f);
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

  // ---------- 斜杠命令 ----------
  // 内容整理高频动作的快捷入口（Cursor/Copilot 的 /命令 同款）。视觉上复用 @ 补全的弹窗样式，
  // 少一套 CSS、行为也一致（↑↓ 选择 / Enter 确认 / Esc 关闭）。
  const SLASH_CMDS = [
    { cmd: '/精简', tip: '压缩篇幅、去掉废话，保持原意', prompt: '把当前内容精简一下：去掉重复和废话，保持原意不变。' },
    { cmd: '/扩写', tip: '把要点展开成完整表达', prompt: '把当前内容扩写成完整表达，补上必要的细节和过渡。' },
    { cmd: '/润色', tip: '只改表达，不动事实和结构', prompt: '润色当前内容：只改表达和语气，不要改变事实与结构。' },
    { cmd: '/纠错', tip: '改错别字、标点、语法', prompt: '检查当前内容的错别字、标点和语法问题并改正，改完给我看 diff。' },
    { cmd: '/统一术语', tip: '同一概念统一用词', prompt: '统一当前文档里的术语和称呼（同一概念用同一个词），改完给我看 diff。' },
    { cmd: '/提炼要点', tip: '归纳成简洁列表', prompt: '提炼当前内容的要点，用简洁的列表整理。' },
    { cmd: '/转表格', tip: '把并列信息变成表格', prompt: '把当前内容里并列的信息整理成表格。' },
    { cmd: '/生成提交信息', tip: '按当前改动写 commit message', action: 'commitmsg' },
    { cmd: '/压缩上下文', tip: '压掉旧工具结果，省额度', action: 'compact' },
    { cmd: '/yolo', tip: '本次对话内改文件 / 跑命令都不再询问', action: 'yolo' },
  ];
  let slashState = null;
  function activeSlashToken() {
    if (!inputEl) return null;
    const v = inputEl.value;
    if (!v || v.charAt(0) !== '/') return null;
    const pos = inputEl.selectionStart == null ? v.length : inputEl.selectionStart;
    const head = v.slice(0, pos);
    if (/\s/.test(head)) return null;   // 只在第一个词上生效（正文里出现 / 不弹）
    return { query: head.slice(1) };
  }
  function closeSlash() {
    if (slashState && slashState.popup && slashState.popup.parentNode) slashState.popup.parentNode.removeChild(slashState.popup);
    slashState = null;
  }
  function renderSlash() {
    if (!slashState) return;
    const list = slashState.popup.querySelector('.ai-at-list');
    list.innerHTML = '';
    if (!slashState.items.length) {
      list.innerHTML = '<div class="ai-at-empty">没有匹配的命令</div>';
      return;
    }
    slashState.items.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'ai-at-item' + (i === slashState.sel ? ' sel' : '');
      row.innerHTML = '<span class="ai-at-name">' + esc(c.cmd) + '</span>' +
        '<span class="ai-at-rel">' + esc(c.tip) + '</span>';
      row.onclick = () => pickSlash(i);
      list.appendChild(row);
    });
    const el = list.children[slashState.sel];
    if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest' }); } catch {} }
  }
  function openSlash(items) {
    closeMention();
    closeSlash();
    const popup = document.createElement('div');
    popup.className = 'ai-at-pop';
    popup.innerHTML = '<div class="ai-at-list"></div>';
    const bar = inputEl.closest('.ai-input-bar');
    (bar || panel).appendChild(popup);
    slashState = { items, sel: 0, popup };
    renderSlash();
  }
  async function pickSlash(idx) {
    if (!slashState) return;
    const it = slashState.items[idx];
    closeSlash();
    if (!it) return;
    inputEl.value = '';
    if (it.action) { await runSlashAction(it.action); return; }
    // 内容整理类命令：有选区就带上选区（用户说「精简」多半指他选中的那段），否则跟随当前文件
    let hasSel = false;
    try {
      const cm = window.Viewer && Viewer.cm;
      hasSel = !!(cm && cm.view && !cm.view.state.selection.main.empty);
    } catch {}
    if (hasSel) await addSpecialCtx('sel'); else await followActive();
    inputEl.value = it.prompt;
    inputEl.focus();
    try { inputEl.setSelectionRange(it.prompt.length, it.prompt.length); } catch {}
    MI.toast('指令已填好，按 Enter 发送', 'ok');
  }
  async function runSlashAction(kind) {
    if (kind === 'compact') {
      const before = msgs.reduce((n, m) => n + msgChars(m), 0);
      compressHistory();
      const after = msgs.reduce((n, m) => n + msgChars(m), 0);
      renderUsage();
      const saved = Math.max(0, before - after);
      MI.toast(saved ? '已压缩上下文，省下约 ' + fmtK(Math.round(saved / 3.2)) + ' tok' : '上下文还不需要压缩', 'ok');
      return;
    }
    if (kind === 'yolo') {
      sessionPerm.write = true;
      sessionPerm.run = true;
      MI.toast('本次对话内改文件 / 执行命令都不再询问（关掉面板或开新对话即恢复；永久授权请到设置页）', 'ok');
      return;
    }
    if (kind === 'commitmsg') { await genCommitMsg(); return; }
  }
  // 按当前工作区改动生成提交信息（把 diff 作为上下文，不需要执行命令）
  async function genCommitMsg() {
    const root = (window.App && App.root) || '';
    if (!root) { MI.toast('没有打开的项目', 'err'); return; }
    const st = await window.myIDE.git.status(root);
    if (!st || st.error || !Array.isArray(st.changed) || !st.changed.length) { MI.toast('工作区没有未提交的改动', 'err'); return; }
    const parts = [st.changed.map((c) => c.label + '  ' + c.file).join('\n')];
    for (const c of st.changed.slice(0, 15)) {
      const d = await window.myIDE.git.diffWorkdir(root, c.file).catch(() => null);
      if (!d || d.error || d.binary || d.tooLarge) continue;
      const rows = lineDiff(d.oldText || '', d.newText || '')
        .filter((r) => r.t !== ' ').slice(0, 120).map((r) => (r.t === '+' ? '+ ' : '- ') + r.s);
      if (rows.length) parts.push('--- ' + c.file + ' ---\n' + rows.join('\n'));
    }
    addCtx({ path: '（待提交的改动）', content: parts.join('\n\n').slice(0, 40000), isDir: true, special: 'git' });
    inputEl.value = '根据上面的改动写一条 Git 提交信息。格式「<类型>: <中文说明>」，类型用 feat/fix/docs/refactor/test/chore 之一；'
      + '一行讲清做了什么，事情多就另起一段用短句列明细。只给提交信息本身，不要解释、不要加代码块。';
    await send();
  }
  function onInputSlash() {
    const tok = activeSlashToken();
    if (!tok) { closeSlash(); return false; }
    const q = tok.query.toLowerCase();
    const items = SLASH_CMDS.filter((c) => (c.cmd + ' ' + c.tip).toLowerCase().includes(q)).slice(0, 12);
    if (slashState) { slashState.items = items; slashState.sel = 0; renderSlash(); return true; }
    if (items.length) openSlash(items);
    return true;
  }
  function onKeydownSlash(e) {
    if (!slashState) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); slashState.sel = Math.min(slashState.sel + 1, slashState.items.length - 1); renderSlash(); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashState.sel = Math.max(slashState.sel - 1, 0); renderSlash(); return true; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pickSlash(slashState.sel); return true; }
    if (e.key === 'Tab') { e.preventDefault(); pickSlash(slashState.sel); return true; }
    if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return true; }
    return false;
  }

  // ---------- 发送 ----------
  // 消息透传（保留原生 function calling 的 tool_calls / tool_call_id 字段）
  function buildMessages() {
    const cfg = getConfig();
    const out = [];
    // Agent 工具系统提示在前，项目规则居中，用户自定义系统提示在最后（优先级从低到高）
    out.push({
      role: 'system',
      content: AGENT_SYS
        + (rulesText ? '\n\n# 项目规则（读取自 ' + rulesFile + '，请遵守）\n' + rulesText : '')
        + (cfg.systemPrompt && cfg.systemPrompt.trim() ? '\n\n# 用户补充设定\n' + cfg.systemPrompt.trim() : ''),
    });
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
    closeSlash();
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
    const imgs = pendingImages.slice();
    pendingImages = [];
    renderImages();
    if (imgs.length) {
      // 多模态消息：文本 + 图片（OpenAI 兼容格式；不支持看图的模型会忽略图片部分）
      content = [{ type: 'text', text: content }].concat(imgs.map((u) => ({ type: 'image_url', image_url: { url: u } })));
    }
    const urow = addMsg('user', text, { imgs });
    const mid = 'u' + (++uiSeq);
    urow.dataset.mid = mid;
    lastUserAt = msgs.length;                  // 重新生成时回退到这里（保留这条用户消息）
    msgs.push({ role: 'user', content, _ui: mid, _text: text, _imgs: imgs });

    curStream = addMsg('assistant', '');
    curStream.dataset.mid = 'a' + (++uiSeq);
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
      decorateCodeBlocks(curStream);
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
    lastUserAt = msgs.map((m) => m.role).lastIndexOf('user');
    persistSession();   // 每轮结束存一次：关掉面板也翻得回来
    markRegen();
  }

  function setBusyUI(b) {
    if (sendBtn) {
      sendBtn.textContent = b ? '⏹' : '➤';
      sendBtn.title = b ? '停止生成' : '发送（Enter）';
    }
  }

  // ---------- 历史会话（保存 / 切换 / 重命名 / 删除）----------
  // 以前关掉面板对话就没了：改到一半想翻回上一轮的说法，翻不到。
  // 每次一轮对话结束自动存一条（localStorage，最多 30 条），标题取第一条用户发言。
  const LS_SESS = 'myide-ai-sessions';
  const SESS_LIMIT = 30;
  // ⚠ key 必须带项目根：以前是全局的，A 项目的对话切到 B 项目还挂在那儿 ——
  // 历史里翻出来的会话带着另一个项目的文件路径，模型会当成当前项目的上下文。
  function sessKey() { return LS_SESS + ':' + ((window.App && App.root) || ''); }
  function loadSessions() { try { return JSON.parse(localStorage.getItem(sessKey()) || '[]') || []; } catch { return []; } }
  function saveSessions(a) { try { localStorage.setItem(sessKey(), JSON.stringify((a || []).slice(0, SESS_LIMIT))); } catch {} }
  function sessTitle(list) {
    const first = (list || []).find((m) => m.role === 'user');
    const t = (first && (first._text || (typeof first.content === 'string' ? first.content : ''))) || '';
    return t.replace(/\s+/g, ' ').trim().slice(0, 40) || '（空对话）';
  }
  function relTime(ts) {
    const d = Date.now() - (ts || 0);
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 86400000 * 30) return Math.floor(d / 86400000) + ' 天前';
    const dt = new Date(ts);
    return (dt.getMonth() + 1) + '-' + dt.getDate();
  }
  function persistSession() {
    const has = msgs.some((m) => m.role === 'user' || m.role === 'assistant');
    if (!has) return;
    if (!curSessionId) curSessionId = 's' + Date.now().toString(36);
    const rest = loadSessions().filter((x) => x.id !== curSessionId);
    rest.unshift({ id: curSessionId, ts: Date.now(), title: sessTitle(msgs), msgs: msgs.slice(), usage: { ...usageSum } });
    saveSessions(rest);
  }
  function replayMsgs() {
    msgsEl.innerHTML = '';
    lastUserAt = null;
    if (!msgs.length) { showWelcome(); return; }
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === 'tool' || m.tool_calls) continue; // 工具轮次不重放（工具行是一次性的）
      if (m.role === 'user') {
        const t = m._text || (typeof m.content === 'string' ? m.content : '（含图片的消息）');
        const row = addMsg('user', t, { imgs: m._imgs || [] });
        if (m._ui) row.dataset.mid = m._ui;
        lastUserAt = i;
      } else if (m.role === 'assistant') {
        const row = addMsg('assistant', m.content || '');
        decorateCodeBlocks(row);
      }
    }
    if (lastUserAt != null) markRegen();
    scrollBottom();
  }
  let histPop = null;
  function closeHist() {
    if (histPop && histPop.parentNode) histPop.parentNode.removeChild(histPop);
    histPop = null;
  }
  function toggleHist() { if (histPop) closeHist(); else renderHist(); }
  function renderHist() {
    closeHist();
    const all = loadSessions();
    const pop = document.createElement('div');
    pop.className = 'ai-hist-pop';
    let html = '<div class="ai-hist-head">历史会话<span class="ai-hist-n">' + all.length + '</span></div>';
    if (!all.length) html += '<div class="ai-hist-empty">还没有历史会话 —— 每轮对话结束会自动存一条</div>';
    for (const se of all) {
      html += '<div class="ai-hist-row' + (se.id === curSessionId ? ' cur' : '') + '" data-id="' + esc(se.id) + '">' +
        '<span class="ai-hist-nm" title="' + esc(se.title) + '">' + esc(se.title) + '</span>' +
        '<span class="ai-hist-ts">' + relTime(se.ts) + '</span>' +
        '<button class="ai-hist-b" data-act="ren" title="重命名">\u270E</button>' +
        '<button class="ai-hist-b" data-act="del" title="删除">\u2715</button></div>';
    }
    pop.innerHTML = html;
    panel.appendChild(pop);
    histPop = pop;
    pop.addEventListener('click', async (e) => {
      const row = e.target.closest && e.target.closest('.ai-hist-row');
      if (!row) return;
      const id = row.dataset.id;
      const act = e.target.dataset && e.target.dataset.act;
      const all2 = loadSessions();
      const se = all2.find((x) => x.id === id);
      if (!se) return;
      if (act === 'del') {
        saveSessions(all2.filter((x) => x.id !== id));
        if (id === curSessionId) curSessionId = null;
        renderHist();
        MI.toast('已删除该会话', 'ok');
        return;
      }
      if (act === 'ren') {
        const nm = await Modal.prompt('重命名会话', '会话名称：', se.title);
        if (nm == null) return;
        se.title = String(nm).trim().slice(0, 60) || se.title;
        saveSessions(all2);
        renderHist();
        return;
      }
      openSession(id);
    });
    document.addEventListener('mousedown', function onOut(ev) {
      if (!histPop) { document.removeEventListener('mousedown', onOut); return; }
      if (!histPop.contains(ev.target) && ev.target.id !== 'ai-history' && !ev.target.closest('#ai-history')) {
        closeHist();
        document.removeEventListener('mousedown', onOut);
      }
    });
  }
  function openSession(id) {
    const se = loadSessions().find((x) => x.id === id);
    if (!se) { MI.toast('找不到该会话', 'err'); return; }
    if (busy) { agentStopped = true; window.myIDE.ai.abort(); busy = false; setBusyUI(false); }
    closeHist();
    msgs = (se.msgs || []).slice();
    usageSum = Object.assign({ in: 0, out: 0, cacheHit: 0, cacheMiss: 0 }, se.usage || {});
    curSessionId = se.id;
    renderUsage();
    replayMsgs();
    MI.toast('已载入会话：' + se.title, 'ok');
  }

  // ---------- 切换项目 ----------
  // 会话跟着项目走：对话历史、上下文、本次对话的临时授权、项目规则缓存，
  // 换项目一律重来（否则 AI 会把上一个项目的文件当成本项目的上下文）。
  function onProjectChange() {
    if (busy) { agentStopped = true; window.myIDE.ai.abort(); busy = false; setBusyUI(false); }
    closeMention(); closeHist(); closeSlash(); closePermPop();
    const cf = panel.querySelector('.ai-confirm');
    if (cf) cf.parentNode.removeChild(cf);   // 没处理完的确认直接作废：它指的是上一个项目的文件
    msgs = [];
    curSessionId = null;
    lastUserAt = null;
    uiSeq = 0;
    usageSum = { in: 0, out: 0, cacheHit: 0, cacheMiss: 0 };
    pendingImages = [];
    renderImages();
    ctxFiles = [];
    followPath = null;
    followMuted.clear();
    // ⚠ 原地清空，别重新赋值 —— AiPanel.sessionPerm 导出的是这个对象的引用，
    //   赋新对象会让导出的引用永远指向旧对象（测试和设置页读到的都是过期值）
    sessionPerm.write = false;
    sessionPerm.run = false;
    mentionCache = null;
    mentionRoot = null;
    rulesRoot = null;
    rulesText = '';
    rulesFile = '';
    agentRounds = 0;
    msgsEl.innerHTML = '';
    renderUsage();
    renderChips();
    syncPermBtn();
    loadProjectRules();
    followActive();
    showWelcome();
  }

  // ---------- 项目规则文件 ----------
  // 「这个项目的文档用什么口吻、术语怎么写」这种事每次重复交代很烦。
  // 支持 .myide/ai-rules.md（本项目专用）/ AGENTS.md / CLAUDE.md / .cursorrules，
  // 找到第一个非空的就作为项目规则注入系统提示（Cline 的 .clinerules、Cursor 的 rules 同款）。
  const RULE_FILES = ['.myide/ai-rules.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules'];
  let rulesText = '';
  let rulesFile = '';
  let rulesRoot = null;
  async function loadProjectRules(force) {
    const root = (window.App && App.root) || '';
    if (!root) { rulesText = ''; rulesFile = ''; rulesRoot = null; return ''; }
    if (rulesRoot === root && !force) return rulesText;
    rulesRoot = root;
    rulesText = '';
    rulesFile = '';
    for (const f of RULE_FILES) {
      const r = await window.myIDE.fs.readFile(root + '/' + f).catch(() => null);
      if (r && !r.error && r.content && String(r.content).trim()) {
        rulesText = String(r.content).trim().slice(0, 8000);
        rulesFile = f;
        break;
      }
    }
    return rulesText;
  }

  // ---------- 跟随当前编辑器文件 ----------
  // 为什么需要：用户在面板里说「把这份文档精简一下」，AI 并不知道「这份」是哪份 ——
  // 以前要先手动点 📎 或 @ 引用，忘了附就答非所问。现在面板始终跟着当前打开的文件走。
  // 「正在看」已并入 chips（class = follow），保留这个入口名，调用点不用改
  function renderFollow() { renderChips(); }
  async function followActive() {
    await loadProjectRules();   // 项目规则只在换项目时真正读一次
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
  function confirmRun(cmd, pre, danger) {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.className = 'ai-confirm';
      box.innerHTML =
        '<div class="ai-cf-head' + (danger ? ' warn' : '') + '">' +
          '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">' + (danger
            ? '<path d="M8 2.8l5.2 9.2H2.8z"/><path d="M8 6.4v3.2M8 11.5v.1"/>'
            : '<path d="M4.7 2.7l8 5.3-8 5.3z"/>') + '</svg>' +
          '<span class="ai-cf-nm">' + (danger ? '危险命令，请确认' : 'AI 请求执行命令') + '</span>' +
          (pre ? '<span class="ai-cf-stat">' + esc(pre) + '</span>' : '') +
          '<button class="ai-cf-fold" id="cr-fold">收起</button>' +
        '</div>' +
        '<div class="ai-cf-body" id="cr-body"><div class="ai-cf-cmd">' + esc(cmd) + '</div></div>' +
        '<div class="ai-cf-note' + (danger ? ' warn' : '') + '">' +
          (danger
            ? '这条命令可能是破坏性的（删除 / 重置 / 强制推送）。这一步不提供「总是允许」。'
            : '在项目目录执行。' + (pre ? '选「总是允许」后，以 <b>' + esc(pre) + '</b> 开头的命令不再询问（权限按钮或设置里可清除）。' : '')) +
        '</div>' +
        '<div class="ai-cf-foot">' +
          (pre ? '<button class="ai-cf-quiet" id="cr-always">总是允许「' + esc(pre) + '」</button>' : '') +
          '<button class="tb-btn m-cancel" id="cr-no">拒绝</button>' +
          '<button class="tb-btn ' + (danger ? 'm-cancel' : 'm-ok') + '" id="cr-yes">' + (danger ? '仍然执行' : '运行一次') + '</button>' +
        '</div>';
      const prev = panel.querySelector('.ai-confirm');
      if (prev) prev.parentNode.removeChild(prev);
      panel.appendChild(box);
      let settled = false;
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
      const finish = (v) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey);
        if (box.parentNode) box.parentNode.removeChild(box);
        resolve(v);
      };
      document.addEventListener('keydown', onKey);
      box.querySelector('#cr-no').onclick = () => finish(false);
      box.querySelector('#cr-yes').onclick = () => finish('once');
      const al = box.querySelector('#cr-always');
      if (al) al.onclick = () => finish('always');
      const fold = box.querySelector('#cr-fold');
      fold.onclick = () => {
        const hid = box.querySelector('#cr-body').classList.toggle('hidden');
        fold.textContent = hid ? '展开' : '收起';
      };
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

  // ---------- 附带上下文（跟随的当前文件 + 固定项 + @ 引用，收在一条线上）----------
  // 以前「正在看」独占一整行、chips 又换行，外加一个回形针按钮，贴着输入框堆了三层，又高又乱。
  // 现在全收进一条横向滚动的 chips：谁在上下文里、谁是跟随/固定，一眼看全。
  const CTX_ICON = {
    follow: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.7 8s2.4-4.2 6.3-4.2S14.3 8 14.3 8s-2.4 4.2-6.3 4.2S1.7 8 1.7 8z"/><circle cx="8" cy="8" r="1.9"/></svg>',
    sel: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.6h10M3 8h6.4M3 12.4h8"/></svg>',
    tabs: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.4 4.6h3.6l1.2 1.5h6.4v6.3H2.4z"/></svg>',
    git: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.6" cy="4.1" r="1.5"/><circle cx="4.6" cy="11.9" r="1.5"/><circle cx="11.4" cy="6.6" r="1.5"/><path d="M4.6 5.6v4.8M6.1 5.1h3.4c1 0 1.9.7 1.9 1.7"/></svg>',
    clip: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.7 5.6h4.6a1 1 0 0 1 1 1v5.3a1 1 0 0 1-1 1H5.7a1 1 0 0 1-1-1V6.6a1 1 0 0 1 1-1z"/><path d="M6.5 5.6V4.4a1.5 1.5 0 0 1 3 0v1.2"/></svg>',
    file: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 2.3h4.1l3 3v8.4H4.4z"/><path d="M8.5 2.3v3h3"/></svg>',
    dir: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.4 4.6h3.6l1.2 1.5h6.4v6.3H2.4z"/></svg>',
  };
  // chip 上只写「短到能认出来」的名字（完整路径在悬停提示与上下文明细里）
  function chipLabel(f) {
    if (f.auto) return f.path.replace(/^.*[\\/]/, '');
    if (f.special === 'sel') return '当前选区';
    if (f.special === 'tabs') return '打开的标签页';
    if (f.special === 'git') return 'Git 变更';
    if (f.special === 'clip') return '剪贴板';
    if (f.isDir) return f.path.replace(/^.*[\\/]/, '') + '/';
    return f.path.replace(/^.*[\\/]/, '');
  }
  function chipIcon(f) {
    if (f.auto) return CTX_ICON.follow;
    if (f.special) return CTX_ICON[f.special] || CTX_ICON.file;
    return f.isDir ? CTX_ICON.dir : CTX_ICON.file;
  }
  function renderChips() {
    const box = document.getElementById('ai-chips');
    if (!box) return;
    box.innerHTML = '';
    // 顺序：跟随的当前文件 → 固定过的 → 其余（固定=用户明确说「一直带着」，排前面）
    const list = ctxFiles.filter((x) => x.auto)
      .concat(ctxFiles.filter((x) => !x.auto).sort((x, y) => ((y.pin ? 1 : 0) - (x.pin ? 1 : 0))));
    box.classList.toggle('hidden', !list.length);
    for (const f of list) {
      const chip = document.createElement('span');
      chip.className = 'ai-ctx-chip' + (f.isDir ? ' dir' : '') + (f.pin ? ' pinned' : '')
        + (f.auto ? ' follow' : '') + (f.special ? ' special' : '');
      chip.title = (f.auto ? '正在看：' : '') + f.path
        + (f.auto ? '（点 ✕ 不再跟随；切到别的文件会重新跟随）' : '');
      chip.insertAdjacentHTML('beforeend', chipIcon(f));
      const nm = document.createElement('span');
      nm.className = 'ai-ctx-nm';
      nm.textContent = chipLabel(f);
      chip.appendChild(nm);
      if (!f.auto) {
        const pin = document.createElement('span');
        pin.className = 'ai-ctx-pin' + (f.pin ? ' on' : '');
        pin.textContent = '📌';
        pin.title = f.pin ? '取消固定' : '固定（开始新对话时也保留）';
        pin.onclick = (e) => { e.stopPropagation(); f.pin = !f.pin; renderChips(); };
        chip.appendChild(pin);
      }
      const x = document.createElement('span');
      x.className = 'ai-ctx-x';
      x.textContent = '✕';
      x.title = f.auto ? '不再跟随这个文件' : '从上下文移除';
      // ⚠ 只有 ✕ 才移除：以前整块可点，想看一眼就误删，还得重新 @ 一次
      x.onclick = (e) => {
        e.stopPropagation();
        if (f.auto) unfollowActive(); else removeCtx(f.path);
      };
      chip.appendChild(x);
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
  // 文件/文件夹之外，用户高频想引用的其实还有几样：我正在选的那段、我开着的那几个文件、
  // 仓库里还没提交的改动、剪贴板。别的编辑器都把它们做成一等入口（Continue 的 context
  // provider / Cline 的 @git @terminal），我们原来只能 @ 文件。
  function specialMentions() {
    const openN = (((window.Viewer && Viewer.openTabs) || []).filter((t) => t && !t.dir)).length;
    return [
      { special: 'sel', name: '当前选区', rel: '选区', isDir: false },
      { special: 'tabs', name: '打开的标签页' + (openN ? '（' + openN + '）' : ''), rel: '标签页', isDir: false },
      { special: 'git', name: 'Git 变更', rel: 'Git变更', isDir: false },
      { special: 'clip', name: '剪贴板', rel: '剪贴板', isDir: false },
    ];
  }

  // 把特殊来源塞进上下文（不往输入框插 @token —— 那是文件路径的写法，模型看到「@选区」只会困惑）
  async function addSpecialCtx(kind) {
    const CAP = 24000;
    if (kind === 'sel') {
      let sel = '';
      try {
        const cm = window.Viewer && Viewer.cm;
        if (cm && cm.view) {
          const s2 = cm.view.state.selection.main;
          if (!s2.empty) sel = cm.view.state.sliceDoc(s2.from, s2.to);
        }
      } catch {}
      if (!sel) { try { sel = String((window.getSelection && window.getSelection()) || ''); } catch {} }
      sel = String(sel || '').trim();
      if (!sel) { MI.toast('先在编辑器里选中一段文字，再引用选区', 'err'); return; }
      addCtx({ path: '（编辑器当前选区）', content: sel.slice(0, CAP), isDir: false, special: 'sel' });
      MI.toast('已带上当前选区（' + sel.length + ' 字）', 'ok');
      return;
    }
    if (kind === 'tabs') {
      const tabs2 = (((window.Viewer && Viewer.openTabs) || []).filter((t) => t && !t.dir));
      if (!tabs2.length) { MI.toast('当前没有打开的文件', 'err'); return; }
      const parts = [];
      let total = 0;
      for (const t of tabs2) {
        let c = String(t.content == null ? '' : t.content);
        if (total + c.length > 60000) c = c.slice(0, Math.max(0, 60000 - total)) + '\n…（已截断）';
        total += c.length;
        parts.push('（文件 ' + t.path + ' 的内容：）\n```\n' + c + '\n```');
        if (total >= 60000) break;
      }
      addCtx({ path: '（打开的 ' + tabs2.length + ' 个标签页）', content: parts.join('\n\n'), isDir: true, special: 'tabs' });
      MI.toast('已带上 ' + tabs2.length + ' 个打开的文件', 'ok');
      return;
    }
    if (kind === 'git') {
      const root = (window.App && App.root) || '';
      if (!root) { MI.toast('没有打开的项目', 'err'); return; }
      const st = await window.myIDE.git.status(root);
      if (!st || st.error || !Array.isArray(st.changed) || !st.changed.length) {
        MI.toast('工作区没有未提交的改动', 'err');
        return;
      }
      const parts = ['（Git 未提交改动，分支 ' + (st.branch || '?') + '，共 ' + st.changed.length + ' 个文件）',
        st.changed.map((c) => c.label + '  ' + c.file).join('\n')];
      for (const c of st.changed.slice(0, 12)) {
        const d = await window.myIDE.git.diffWorkdir(root, c.file).catch(() => null);
        if (!d || d.error || d.binary || d.tooLarge) continue;
        const rows = lineDiff(d.oldText || '', d.newText || '')
          .filter((r) => r.t !== ' ')
          .slice(0, 200)
          .map((r) => (r.t === '+' ? '+ ' : '- ') + r.s);
        if (rows.length) parts.push('--- ' + c.file + ' ---\n' + rows.join('\n'));
      }
      addCtx({ path: '（Git 未提交改动）', content: parts.join('\n\n').slice(0, 60000), isDir: true, special: 'git' });
      MI.toast('已带上 ' + st.changed.length + ' 个改动文件', 'ok');
      return;
    }
    if (kind === 'clip') {
      const r = await window.myIDE.clip.readText().catch(() => null);
      const txt = String((r && r.text) || '').trim();
      if (!txt) { MI.toast('剪贴板里没有文本', 'err'); return; }
      addCtx({ path: '（剪贴板内容）', content: txt.slice(0, CAP), isDir: false, special: 'clip' });
      MI.toast('已带上剪贴板内容（' + txt.length + ' 字）', 'ok');
      return;
    }
  }

  async function ensureMentionList() {
    const root = (window.App && App.root) || '';
    if (!root) return specialMentions(); // 没开项目也能引用选区 / 标签页 / 剪贴板
    if (mentionCache && mentionRoot === root) return mentionCache;
    const r = await window.myIDE.fs.listAll(root, false);
    if (!r || r.error) return null;
    const files = (r.files || []).map((full) => {
      const rel = String(full).slice(root.length).replace(/^[\\/]/, '');
      return { name: rel.replace(/^.*[\\/]/, ''), rel, path: full, isDir: false };
    });
    // 目录从文件路径推导（含全部非空目录；空目录罕见，可接受）
    // ⚠ 早先写成 while ((p = p.replace(正则剥掉最后一段))) —— rel 里没有分隔符时
    //   （根目录下的文件，如 package.json）replace 找不到匹配会**原样返回**，p 永远非空，
    //   于是死循环把整个应用卡死：用户一打「@」就中招。必须显式判「还有没有分隔符」。
    const dirSet = new Set();
    for (const f of files) {
      let rel = String(f.rel || '');
      const SEP = String.fromCharCode(92);   // 反斜杠（Windows 路径）
      for (;;) {
        const i1 = rel.indexOf('/');
        const i2 = rel.indexOf(SEP);
        const cut = i1 < 0 ? i2 : (i2 < 0 ? i1 : Math.min(i1, i2));
        if (cut < 0) break;                  // 没有分隔符 = 已到顶层，收工
        rel = rel.slice(0, cut);
        if (!rel) break;
        dirSet.add(rel);
      }
    }
    const dirs = [...dirSet].map((rel) => ({ name: rel.replace(/^.*[\\/]/, ''), rel, path: root + '/' + rel, isDir: true }));
    // 目录排前（先选范围再选具体文件，符合 @ 的浏览习惯）
    mentionCache = specialMentions()
      .concat(dirs.sort((a, b) => a.rel < b.rel ? -1 : 1))
      .concat(files.sort((a, b) => a.rel < b.rel ? -1 : 1));
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
      row.innerHTML = '<span class="ai-at-ic">' + (it.special ? '✨' : (it.isDir ? '🗂' : '📄')) + '</span>' +
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
    if (it.special) {
      // 特殊来源：把用户打出的 @token 从输入框里抹掉（它不是文件路径），再直接进上下文
      const val0 = inputEl.value;
      const cur0 = inputEl.selectionStart == null ? start + 1 : inputEl.selectionStart;
      inputEl.value = val0.slice(0, start) + val0.slice(cur0);
      inputEl.focus();
      try { inputEl.setSelectionRange(start, start); } catch {}
      await addSpecialCtx(it.special);
      return;
    }
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
    if (inputEl) {
      // 输入框获得焦点时同步「正在看哪个文件」（用户可能刚切过标签）
      inputEl.addEventListener('focus', () => { followActive(); });
      inputEl.addEventListener('input', () => {
        if (onInputSlash()) return;   // 打 / 开头 = 命令补全
        onInputMention();             // 否则看是不是 @ 引用
      });
      inputEl.addEventListener('keydown', (e) => {
        if (onKeydownSlash(e)) return;   // / 命令弹窗接管
        if (onKeydownMention(e)) return; // @ 补全弹窗接管：↑↓/Enter/Esc
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          if (!busy) send();
        }
      });
      inputEl.addEventListener('paste', onPasteImage);
    }
    const histBtn = document.getElementById('ai-history');
    if (histBtn) histBtn.onclick = (e) => { e.stopPropagation(); toggleHist(); };
    renderImages();
    const newBtn = document.getElementById('ai-new');
    if (newBtn) newBtn.onclick = () => {
      if (busy) { agentStopped = true; window.myIDE.ai.abort(); busy = false; setBusyUI(false); }
      persistSession();          // 先把当前这轮存进历史，再开新的
      curSessionId = null;
      lastUserAt = null;
      pendingImages = [];
      renderImages();
      removeRegen();
      agentRounds = 0;
      msgs = [];
      usageSum = { in: 0, out: 0, cacheHit: 0, cacheMiss: 0 };
      renderUsage();
      // 新对话保留「当前正在看的文件」+ 用户固定过的上下文（固定就是为了跨会话一直带着）
      ctxFiles = ctxFiles.filter((f) => f.auto || f.pin);
      renderChips();
      renderFollow();
      msgsEl.innerHTML = '';
      showWelcome();
      MI.toast('已开始新对话', 'ok');
    };
    const undoBtn = document.getElementById('ai-undo');
    if (undoBtn) undoBtn.onclick = undoCheckpoint;
    const permBtn = document.getElementById('ai-perm');
    if (permBtn) permBtn.onclick = (e) => { e.stopPropagation(); togglePermPop(); };
    syncPermBtn();
    const usageEl = document.getElementById('ai-usage');
    if (usageEl) {
      usageEl.classList.add('clickable');
      usageEl.title = '点击查看上下文都被什么占用了';
      usageEl.onclick = showCtxBreakdown;
    }
    const cfgBtn = document.getElementById('ai-cfg');
    if (cfgBtn) cfgBtn.onclick = () => { Settings.open('ai'); };
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

  // 编辑器右键菜单的动作：把选中内容作为上下文，指令填好等用户自己按回车
  // （不直接发送：用户可能想改一下措辞再问）
  const EDITOR_ACTIONS = {
    explain: { needSel: true, text: '解释一下选中的这段内容：它在说什么、有哪些容易误解或需要注意的地方。用中文回答。' },
    fix: { needSel: true, text: '修正选中这段内容里的问题（错别字、标点、语法、前后不一致），只改真正有问题的地方，改完给我看 diff。' },
    improve: { needSel: true, text: '改进选中这段内容的表达：让它更清楚、更简洁、更连贯，保持原意和事实不变，改完给我看 diff。' },
    doc: { needSel: false, text: '把当前打开的文件整理一下：理顺结构、统一格式、把重复的内容合并，改完先给我看 diff。' },
  };
  async function fromEditor(kind) {
    const act = EDITOR_ACTIONS[kind] || EDITOR_ACTIONS.improve;
    let sel = '';
    try {
      const cm = window.Viewer && Viewer.cm;
      if (cm && cm.view) {
        const s2 = cm.view.state.selection.main;
        if (!s2.empty) sel = cm.view.state.sliceDoc(s2.from, s2.to);
      }
    } catch {}
    if (act.needSel && !String(sel).trim()) { MI.toast('先在编辑器里选中一段文字', 'err'); return; }
    if (window.App && App.showAi) App.showAi();
    if (act.needSel) {
      addCtx({ path: '（编辑器当前选区）', content: String(sel).slice(0, 24000), isDir: false, special: 'sel' });
    } else {
      await followActive();
    }
    inputEl.value = act.text;
    inputEl.focus();
    try { inputEl.setSelectionRange(act.text.length, act.text.length); } catch {}
    MI.toast('指令已填好，按 Enter 发送', 'ok');
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

  return { init, syncVisible, getConfig, setConfig, PROVIDERS, providerOf, ask, followActive, unfollowActive, loadPerms, savePerms, sessionPerm, fromEditor, loadProjectRules, showCtxBreakdown, runNeedsConfirm, writeNeedsConfirm, dangerousCmd, pathAllowed, permWrite, permRun, syncPermBtn, onProjectChange };
})();
window.AiPanel = AiPanel;

// ai-service.js —— AI 助手服务（主进程）：OpenAI 兼容流式对话
// 流式 SSE → 事件推送到渲染层（event.sender.send）；AbortController 支持中断
// API Key 只在主进程内存中经过，配置由渲染层 localStorage 持有（与翻译插件一致）

let activeAbort = null; // 当前会话的 AbortController（单会话：一次只跑一个请求）

// fetcher 注入 Electron net.fetch（走系统代理；llm:chat 同款）
let fetcher = null;
function init(net) { fetcher = (u, opts) => net.fetch(u, opts); }

// 流式对话：cfg {baseUrl, apiKey, model}，messages [{role, content, tool_calls?, tool_call_id?}]
// tools：OpenAI 原生 function calling 的工具 schema（可空）
// onDelta(text) 每收到增量回调；返回 {ok, text, toolCalls} 或 {error}
// toolCalls: [{id, name, args(对象)}] —— 流式分片按 index 拼装
// 无 tools 回退：部分服务/模型不支持 function calling（如 deepseek-reasoner）→ 直接 400。
// 剥离 tools 与 role:tool 消息（转伪 user 文本），模型可走 ```tool_call``` 文本协议（前端已兼容解析）
function sanitizeForNoTools(messages) {
  const out = [];
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (m && m.role === 'tool') {
      out.push({ role: 'user', content: '<tool_results>\n<result tool="' + String(m.name || '') + '">\n' + String(m.content || '') + '\n</result>\n</tool_results>' });
    } else if (m && m.tool_calls) {
      out.push({ role: 'assistant', content: m.content || '' }); // assistant 的 tool_calls 锚点一并去掉（无 tools 时留着也会 400）
    } else {
      out.push(m);
    }
  }
  return out;
}

async function chatStream(cfg, messages, onDelta, tools) {
  const base = String((cfg && cfg.baseUrl) || '').replace(/\/+$/, '');
  if (!base) return { error: '未配置 AI 服务地址（设置 → AI 助手）' };
  const model = String((cfg && cfg.model) || '').trim();
  if (!model) return { error: '未配置模型名称（设置 → AI 助手）' };
  const headers = { 'Content-Type': 'application/json' };
  const key = String((cfg && cfg.apiKey) || '').trim();
  if (key) headers['Authorization'] = 'Bearer ' + key;

  activeAbort = new AbortController();
  let full = '';
  const tc = {}; // index → {id, name, args} 流式拼装中的工具调用
  let usageInfo = null; // SSE 末尾 usage 块（DeepSeek 含 prompt_cache_hit/miss_tokens）
  const hasTools = Array.isArray(tools) && tools.length;
  // 渐进降级：完整请求 → 400/422 时去掉 stream_options 重试 → 仍 400/422 时去掉 tools（文本协议回退）再试。
  // 覆盖两类常见 400：不支持 stream_options（部分兼容服务）、不支持 function calling（deepseek-reasoner / 部分本地模型）
  const doFetch = async (withUsage, noTools) => {
    const body = { model, messages: noTools ? sanitizeForNoTools(messages) : (Array.isArray(messages) ? messages : []), stream: true };
    if (!noTools && hasTools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (withUsage) body.stream_options = { include_usage: true }; // 取 usage（DeepSeek/OpenAI 支持；个别服务报错则回退）
    return fetcher(base + '/chat/completions', {
      method: 'POST',
      headers,
      signal: activeAbort.signal,
      body: JSON.stringify(body),
    });
  };
  try {
    let res = await doFetch(true, false);
    if (!res.ok && (res.status === 400 || res.status === 422)) {
      res = await doFetch(false, false); // 部分兼容服务不认 stream_options：去掉重试
    }
    if (!res.ok && (res.status === 400 || res.status === 422) && hasTools) {
      res = await doFetch(false, true); // 模型不支持 function calling：去 tools 走文本协议
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { error: 'HTTP ' + res.status + (t ? '：' + t.slice(0, 300) : '') };
    }
    // 手工解析 SSE：data: {...} 行，[DONE] 结束
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const collect = (j) => {
      if (j && j.usage && typeof j.usage === 'object') {
        usageInfo = {
          prompt_tokens: j.usage.prompt_tokens || 0,
          completion_tokens: j.usage.completion_tokens || 0,
          // DeepSeek 缓存命中/未命中（其他服务商无此字段，UI 不显示缓存项）
          cache_hit: j.usage.prompt_cache_hit_tokens || 0,
          cache_miss: j.usage.prompt_cache_miss_tokens || 0,
        };
      }
      const delta = j && j.choices && j.choices[0] && j.choices[0].delta;
      if (!delta) return;
      if (typeof delta.content === 'string' && delta.content) {
        full += delta.content;
        if (onDelta) onDelta(delta.content);
      }
      // 原生工具调用：按 index 拼装（name 一次给全，arguments 分片追加）
      if (Array.isArray(delta.tool_calls)) {
        for (const c of delta.tool_calls) {
          const i = c.index == null ? 0 : c.index;
          if (!tc[i]) tc[i] = { id: '', name: '', args: '' };
          if (c.id) tc[i].id = c.id;
          if (c.function && c.function.name) tc[i].name += c.function.name;
          if (c.function && typeof c.function.arguments === 'string') tc[i].args += c.function.arguments;
        }
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return { ok: true, text: full, toolCalls: packToolCalls(tc), usage: usageInfo };
        try { collect(JSON.parse(payload)); } catch {}
      }
    }
    return { ok: true, text: full, toolCalls: packToolCalls(tc), usage: usageInfo };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: true, text: full, aborted: true, toolCalls: packToolCalls(tc), usage: usageInfo };
    return { error: String(e.message || e) };
  } finally {
    activeAbort = null;
  }
}

// 拼装完成的工具调用：args 字符串安全解析为对象
function packToolCalls(tc) {
  const out = [];
  for (const i of Object.keys(tc).sort((a, b) => a - b)) {
    const c = tc[i];
    if (!c.name) continue;
    let args = {};
    try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { _raw: c.args }; }
    out.push({ id: c.id || 'call_' + i, name: c.name, args });
  }
  return out;
}

function abortChat() {
  if (activeAbort) activeAbort.abort();
}

module.exports = { init, chatStream, abortChat };

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
  try {
    const body = { model, messages: Array.isArray(messages) ? messages : [], stream: true };
    if (Array.isArray(tools) && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const res = await fetcher(base + '/chat/completions', {
      method: 'POST',
      headers,
      signal: activeAbort.signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { error: 'HTTP ' + res.status + (t ? '：' + t.slice(0, 300) : '') };
    }
    // 手工解析 SSE：data: {...} 行，[DONE] 结束
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const collect = (j) => {
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
        if (payload === '[DONE]') return { ok: true, text: full, toolCalls: packToolCalls(tc) };
        try { collect(JSON.parse(payload)); } catch {}
      }
    }
    return { ok: true, text: full, toolCalls: packToolCalls(tc) };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: true, text: full, aborted: true, toolCalls: packToolCalls(tc) };
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

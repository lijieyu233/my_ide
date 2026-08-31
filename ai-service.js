// ai-service.js —— AI 助手服务（主进程）：OpenAI 兼容流式对话
// 流式 SSE → 事件推送到渲染层（event.sender.send）；AbortController 支持中断
// API Key 只在主进程内存中经过，配置由渲染层 localStorage 持有（与翻译插件一致）

let activeAbort = null; // 当前会话的 AbortController（单会话：一次只跑一个请求）

// fetcher 注入 Electron net.fetch（走系统代理；llm:chat 同款）
let fetcher = null;
function init(net) { fetcher = (u, opts) => net.fetch(u, opts); }

// 流式对话：cfg {baseUrl, apiKey, model}，messages [{role, content}]
// onDelta(text) 每收到增量回调；返回 {ok, text} 或 {error}
async function chatStream(cfg, messages, onDelta) {
  const base = String((cfg && cfg.baseUrl) || '').replace(/\/+$/, '');
  if (!base) return { error: '未配置 AI 服务地址（设置 → AI 助手）' };
  const model = String((cfg && cfg.model) || '').trim();
  if (!model) return { error: '未配置模型名称（设置 → AI 助手）' };
  const headers = { 'Content-Type': 'application/json' };
  const key = String((cfg && cfg.apiKey) || '').trim();
  if (key) headers['Authorization'] = 'Bearer ' + key;

  activeAbort = new AbortController();
  let full = '';
  try {
    const res = await fetcher(base + '/chat/completions', {
      method: 'POST',
      headers,
      signal: activeAbort.signal,
      body: JSON.stringify({
        model,
        messages: Array.isArray(messages) ? messages : [],
        stream: true,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { error: 'HTTP ' + res.status + (t ? '：' + t.slice(0, 300) : '') };
    }
    // 手工解析 SSE：data: {...} 行，[DONE] 结束
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
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
        if (payload === '[DONE]') return { ok: true, text: full };
        try {
          const j = JSON.parse(payload);
          const d = j && j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (typeof d === 'string' && d) {
            full += d;
            if (onDelta) onDelta(d);
          }
        } catch {}
      }
    }
    return { ok: true, text: full };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: true, text: full, aborted: true };
    return { error: String(e.message || e) };
  } finally {
    activeAbort = null;
  }
}

function abortChat() {
  if (activeAbort) activeAbort.abort();
}

module.exports = { init, chatStream, abortChat };

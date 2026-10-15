// ai-service.js —— AI 助手服务（主进程）：OpenAI 兼容流式对话
// 流式 SSE → 事件推送到渲染层（event.sender.send）；AbortController 支持中断
// API Key 只在主进程内存中经过，配置由渲染层 localStorage 持有（与翻译插件一致）

const requests = new Map();

// fetcher 注入 Electron net.fetch（走系统代理；llm:chat 同款）
let fetcher = null;
function init(net) { fetcher = (u, opts) => net.fetch(u, opts); }

// 流式对话：cfg {baseUrl, apiKey, model}，messages [{role, content, tool_calls?, tool_call_id?}]
// tools：OpenAI 原生 function calling 的工具 schema（可空）
// onDelta(text) 每收到增量回调；完整终态才返回可执行toolCalls，失败仍保留已收到正文。
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

async function chatStream(cfg, messages, onDelta, tools, context = {}, policy = {}) {
  const controller = new AbortController(), token = Symbol();
  requests.set(token, { controller, context });
  try { return { ...await stream(cfg, messages, onDelta, tools, controller, policy), context }; }
  finally { requests.delete(token); }
}
async function stream(cfg, messages, onDelta, tools, controller, policy) {
  let full = '', usageInfo = null, finishReason = null;
  const tc = new Map(), capabilities = { protocol: 'chat-completions', usage: true, nativeTools: !!tools?.length, downgrades: [], attempts: 0 };
  const result = (status, extra = {}) => ({ ok: status === 'completed', status, complete: status === 'completed',
    finishReason, text: full, toolCalls: [], usage: usageInfo, capabilities, ...extra });
  const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
  const scrub = value => {
    let s = String(value || '');
    const key = String(cfg?.apiKey || ''); if (key) s = s.split(key).join('[已隐藏]');
    return s.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').slice(0, 600);
  };
  const base = String((cfg && cfg.baseUrl) || '').replace(/\/+$/, '');
  if (!base) return result('failed', { error: '未配置 AI 服务地址（设置 → AI 助手）' });
  const model = String((cfg && cfg.model) || '').trim();
  if (!model) return result('failed', { error: '未配置模型名称（设置 → AI 助手）' });
  const headers = { 'Content-Type': 'application/json' };
  const key = String((cfg && cfg.apiKey) || '').trim();
  if (key) headers['Authorization'] = 'Bearer ' + key;

  const hasTools = Array.isArray(tools) && tools.length;
  const limit = (key, max) => Number.isSafeInteger(policy[key]) && policy[key] > 0 ? Math.min(policy[key], max) : max;
  const wireLimit = limit('wireBytes', 8 * 1024 * 1024), eventLimit = limit('eventBytes', 1024 * 1024);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limit('timeoutMs', 120000));
  // 部分兼容fetch忽略signal；等待也绑定本请求，取消后不会永远等reader或降级响应。
  const wait = async promise => {
    if (controller.signal.aborted) throw Object.assign(Error('请求已停止'), { name: 'AbortError' });
    let cancel;
    const stopped = new Promise((_resolve, reject) => { cancel = () => reject(Object.assign(Error('请求已停止'), { name: 'AbortError' })); controller.signal.addEventListener('abort', cancel, { once: true }); });
    try { return await Promise.race([promise, stopped]); } finally { controller.signal.removeEventListener('abort', cancel); }
  };
  const doFetch = async (withUsage, noTools) => {
    if (controller.signal.aborted) throw Object.assign(Error('请求已停止'), { name: 'AbortError' });
    const body = { model, messages: noTools ? sanitizeForNoTools(messages) : (Array.isArray(messages) ? messages : []), stream: true };
    if (!noTools && hasTools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (withUsage) body.stream_options = { include_usage: true }; // 取 usage（DeepSeek/OpenAI 支持；个别服务报错则回退）
    capabilities.attempts++;
    const fetched = Promise.resolve(fetcher(base + '/chat/completions', {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(body),
    })).then(res => {
      if (controller.signal.aborted) {
        try { Promise.resolve(res.body?.cancel()).catch(() => {}); } catch {}
        throw Object.assign(Error('请求已停止'), { name: 'AbortError' });
      }
      return res;
    });
    return wait(fetched);
  };
  let reader;
  try {
    let res;
    for (;;) {
      res = await doFetch(capabilities.usage, !capabilities.nativeTools);
      if (controller.signal.aborted) throw Object.assign(Error('请求已停止'), { name: 'AbortError' });
      if (res.ok) break;
      const raw = await readError(res, wait), structured = parseError(raw), e = structured || {};
      const feature = unsupportedFeature(e);
      if ((res.status === 400 || res.status === 422) && feature && capabilities[feature]
        && (feature !== 'nativeTools' || hasTools)) {
        capabilities[feature] = false;
        capabilities.downgrades.push({ feature, reason: scrub(e.message), code: scrub(e.code), param: scrub(e.param) });
        continue;
      }
      return result('failed', { error: 'HTTP ' + res.status + (e.message ? '：' + scrub(e.message) : '：服务返回错误，未自动降级'),
        errorCode: 'AI_HTTP_ERROR', httpStatus: res.status, serviceError: { code: scrub(e.code), type: scrub(e.type), param: scrub(e.param), message: scrub(e.message) },
        requestSummary: { model, hasAuthorization: !!key, nativeTools: capabilities.nativeTools, usage: capabilities.usage, attempts: capabilities.attempts } });
    }
    reader = res.body.getReader();
    const dec = new TextDecoder('utf-8', { fatal: true });
    let buf = '', data = [], eventBytes = 0, wireBytes = 0, ended = false;
    const collect = (j) => {
      if (!j || typeof j !== 'object' || Array.isArray(j) || j.error) fail('AI_INVALID_EVENT', 'AI流包含错误或无效事件');
      if (j && j.usage && typeof j.usage === 'object') {
        usageInfo = {
          prompt_tokens: j.usage.prompt_tokens || 0,
          completion_tokens: j.usage.completion_tokens || 0,
          // DeepSeek 缓存命中/未命中（其他服务商无此字段，UI 不显示缓存项）
          cache_hit: j.usage.prompt_cache_hit_tokens || 0,
          cache_miss: j.usage.prompt_cache_miss_tokens || 0,
        };
      }
      if (!Array.isArray(j.choices) || j.choices.length > 1) fail('AI_INVALID_EVENT', 'AI流的回复序号无效');
      if (!j.choices.length) { if (!j.usage) fail('AI_INVALID_EVENT', 'AI流缺少回复内容'); return; }
      const choice = j.choices[0], delta = choice.delta;
      if (choice.index != null && choice.index !== 0 || !delta || typeof delta !== 'object' || Array.isArray(delta)) fail('AI_INVALID_EVENT', 'AI流的回复片段无效');
      if (finishReason !== null && (choice.finish_reason != null || delta.content || delta.tool_calls?.length)) fail('AI_TERMINAL_CONFLICT', 'AI完成后仍返回回复片段');
      if (delta.refusal) fail('AI_CONTENT_FILTER', 'AI服务拒绝了本次回复');
      if (choice.finish_reason != null) {
        if (typeof choice.finish_reason !== 'string') fail('AI_INVALID_EVENT', 'AI完成原因无效');
        finishReason = choice.finish_reason;
      }
      if (delta.content != null && typeof delta.content !== 'string') fail('AI_INVALID_EVENT', 'AI正文片段类型无效');
      if (typeof delta.content === 'string' && delta.content) {
        full += delta.content;
        if (onDelta) onDelta(delta.content);
      }
      if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) fail('AI_INVALID_TOOL_STREAM', 'AI工具片段类型无效');
      if (Array.isArray(delta.tool_calls)) {
        for (const c of delta.tool_calls) {
          if (!c || !Number.isSafeInteger(c.index) || c.index < 0 || c.index >= 64 || c.type != null && c.type !== 'function') fail('AI_INVALID_TOOL_STREAM', 'AI工具序号或类型无效');
          const i = c.index;
          if (!tc.has(i)) tc.set(i, { id: '', name: '', args: '' });
          const call = tc.get(i);
          if (c.id != null) {
            if (typeof c.id !== 'string' || !c.id || c.id.length > 200 || call.id && call.id !== c.id) fail('AI_INVALID_TOOL_STREAM', 'AI工具身份无效');
            call.id = c.id;
          }
          if (c.function != null && (typeof c.function !== 'object' || Array.isArray(c.function))) fail('AI_INVALID_TOOL_STREAM', 'AI工具函数无效');
          if (c.function?.name != null) {
            if (typeof c.function.name !== 'string') fail('AI_INVALID_TOOL_STREAM', 'AI工具名称无效');
            call.name += c.function.name;
          }
          if (c.function?.arguments != null) {
            if (typeof c.function.arguments !== 'string') fail('AI_INVALID_TOOL_STREAM', 'AI工具参数片段无效');
            call.args += c.function.arguments;
          }
          if (call.name.length > 200 || Buffer.byteLength(call.args) > 256 * 1024) fail('AI_RESPONSE_LIMIT', 'AI工具参数超过预算');
        }
      }
    };
    const event = () => {
      if (!data.length) { eventBytes = 0; return; }
      const payload = data.join('\n'); data = []; eventBytes = 0;
      if (ended) fail('AI_TERMINAL_CONFLICT', 'AI流结束标记后仍返回数据');
      if (payload.trim() === '[DONE]') { ended = true; return; }
      let j; try { j = JSON.parse(payload); } catch { fail('AI_INVALID_EVENT', 'AI流事件JSON不完整或无效'); }
      collect(j);
    };
    for (;;) {
      const { done, value } = await wait(reader.read());
      if (controller.signal.aborted) throw Object.assign(Error('请求已停止'), { name: 'AbortError' });
      if (done) { dec.decode(); return result('incomplete', { errorCode: 'AI_UNEXPECTED_EOF', message: '回复连接提前结束，未执行工具' }); }
      wireBytes += value.byteLength;
      if (wireBytes > wireLimit) fail('AI_RESPONSE_LIMIT', 'AI回复超过8MiB预算');
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        eventBytes += Buffer.byteLength(line);
        if (eventBytes > eventLimit) fail('AI_RESPONSE_LIMIT', 'AI流事件超过1MiB预算');
        if (!line) event();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (eventBytes + Buffer.byteLength(buf) > eventLimit) fail('AI_RESPONSE_LIMIT', 'AI流事件超过1MiB预算');
      if (ended) {
        if (buf.trim() || data.length) fail('AI_TERMINAL_CONFLICT', 'AI流结束标记后仍返回数据');
        if (!['stop', 'tool_calls'].includes(finishReason)) {
          const reason = finishReason === 'length' ? '达到长度限制' : finishReason === 'content_filter' ? '被服务过滤' : '缺少有效完成原因';
          return result('incomplete', { errorCode: 'AI_INCOMPLETE_RESPONSE', message: '回复未完整完成（' + reason + '），未执行工具' });
        }
        if (tc.size && finishReason !== 'tool_calls' || !tc.size && finishReason === 'tool_calls') fail('AI_TERMINAL_CONFLICT', 'AI完成原因与工具调用不一致');
        const toolCalls = packToolCalls(tc);
        return result('completed', { toolCalls });
      }
    }
  } catch (e) {
    if (controller.signal.aborted || e?.name === 'AbortError') return timedOut
      ? result('incomplete', { errorCode: 'AI_RESPONSE_TIMEOUT', message: '回复超过120秒预算，未执行工具' })
      : result('aborted', { aborted: true, message: '已停止生成' });
    return result('failed', { error: scrub(e.message || e), errorCode: e.code || 'AI_STREAM_ERROR' });
  } finally {
    clearTimeout(timer);
    try { if (reader) Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    try { reader?.releaseLock(); } catch {}
  }
}

// 拼装完成的工具调用：args 字符串安全解析为对象
function packToolCalls(tc) {
  const out = [], ids = new Set();
  for (const [, c] of [...tc.entries()].sort((a, b) => a[0] - b[0])) {
    let args;
    try { args = JSON.parse(c.args); } catch {}
    if (!c.id || !c.name || ids.has(c.id) || !args || typeof args !== 'object' || Array.isArray(args))
      throw Object.assign(Error('AI工具身份、名称或参数JSON无效，未执行工具'), { code: 'AI_INVALID_TOOL_RESPONSE' });
    ids.add(c.id); out.push({ id: c.id, name: c.name, args });
  }
  return out;
}

function parseError(text) { try { const e = JSON.parse(text).error; return e && typeof e === 'object' && !Array.isArray(e) ? e : null; } catch { return null; } }
function unsupportedFeature(e) {
  const feature = ['stream_options', 'stream_options.include_usage'].includes(e.param) ? 'usage'
    : ['tools', 'tool_choice'].includes(e.param) ? 'nativeTools' : null;
  if (!feature) return null;
  const message = String(e.message || '');
  // 不支持某个schema字段不是不支持tools；误降级会掩盖参数错误并把用户意图换成文本执行。
  if (/\b(schema|arguments?|json|property|properties)\b/i.test(message)) return null;
  const code = /^(unsupported_parameter|unknown_parameter|unsupported_tools|unsupported_function_calling)$/.test(e.code || '');
  const target = feature === 'usage' ? '(?:stream_options|include_usage)' : '(?:tools|tool_choice|function calling)';
  const named = new RegExp('(?:unsupported|unknown|unrecognized) (?:parameter|field)[:\\s"\']*' + target + '\\b', 'i').test(message)
    || new RegExp('\\b(?:does not support|not supported|unsupported)\\b.{0,80}\\b' + target + '\\b|\\b' + target + '\\b.{0,80}\\b(?:not supported|unsupported)\\b', 'i').test(message);
  return code || named ? feature : null;
}
async function readError(res, wait) {
  // HTTP错误也有预算；不回显请求正文/密钥，只保留结构化服务错误字段。
  if (!res.body?.getReader) return String(await wait(res.text ? res.text() : Promise.resolve(''))).slice(0, 65536);
  const reader = res.body.getReader(); let bytes = 0, text = ''; const dec = new TextDecoder();
  try {
    for (;;) { const r = await wait(reader.read()); if (r.done) return text + dec.decode(); bytes += r.value.byteLength; if (bytes > 65536) return ''; text += dec.decode(r.value, { stream: true }); }
  } finally { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} try { reader.releaseLock(); } catch {} }
}

function abortChat(requestId) {
  for (const r of requests.values()) if (requestId == null || r.context.requestId === requestId) r.controller.abort();
}

module.exports = { init, chatStream, abortChat };

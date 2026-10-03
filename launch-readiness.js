// 就绪只观察一次运行：命令回显、旧输出和stdout/stderr之间的拼接都不能成为证据。
function normalizeRule(entry) {
  const raw = entry.readiness;
  if (raw == null) return { mode: 'none' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !['none', 'port', 'output'].includes(raw.mode)) throw Error('就绪规则无效');
  if (raw.mode === 'none') return { mode: 'none' };
  const timeoutSeconds = raw.timeoutSeconds == null ? 30 : raw.timeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw Error('就绪等待时间须为1至3600秒的整数');
  if (entry.kind === 'usb-tunnel') throw Error('USB daemon身份尚未核验，暂不支持就绪验证');
  if (raw.mode === 'port') {
    const port = Number(entry.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('端口就绪需要1至65535的终端端口');
    return { mode: 'port', port, timeoutSeconds };
  }
  if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > 256 || /[\r\n]/.test(raw.text)) throw Error('就绪输出须为非空单行文本，最多256字符');
  return { mode: 'output', text: raw.text, timeoutSeconds };
}
function createObservation(rule, runId, now = Date.now) {
  rule = Object.freeze({ ...rule });
  const startedAt = now(); let clock = startedAt, readyAt = null, state = rule.mode === 'none' ? 'none' : 'waiting';
  const tails = { stdout: '', stderr: '' };
  const time = () => (clock = Math.max(clock, now()));
  const expire = () => { if (state === 'waiting' && time() - startedAt >= rule.timeoutSeconds * 1000) state = 'timed-out'; };
  const observe = (stream, text) => {
    if (rule.mode !== 'output' || !(stream in tails)) return;
    expire(); if (state !== 'waiting') return;
    for (const piece of text.split(/([\r\n])/)) {
      if (/^[\r\n]$/.test(piece)) { tails[stream] = ''; continue; }
      const joined = tails[stream] + piece;
      if (joined.includes(rule.text)) { state = 'ready'; readyAt = time(); tails.stdout = tails.stderr = ''; return; }
      tails[stream] = rule.text.length > 1 ? joined.slice(-(rule.text.length - 1)) : '';
    }
  };
  const snapshot = portResponding => {
    expire();
    if (state === 'waiting' && rule.mode === 'port' && portResponding === true) { state = 'ready'; readyAt = time(); }
    // 端口就绪持续要求当前响应；输出就绪则保留本次运行曾观察到的证据。
    const current = state === 'ready' && rule.mode === 'port' && portResponding !== true ? 'unavailable' : state;
    return { state: current, mode: rule.mode, runId, startedAt, readyAt, timeoutSeconds: rule.timeoutSeconds || null };
  };
  return { rule: Object.freeze({ ...rule }), runId, observe, snapshot };
}
module.exports = { normalizeRule, createObservation };

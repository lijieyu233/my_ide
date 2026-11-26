const { EventEmitter } = require('events');
const { TextDecoder } = require('util');

const MiB = 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  maxInboundFrameBytes: 32 * MiB, maxOutboundFrameBytes: 8 * MiB,
  maxMessageBytes: 4 * MiB, maxNotificationBytes: 4 * MiB,
  maxHistoryBytes: 32 * MiB, maxImageBytes: 8 * MiB,
  maxQueuedWriteBytes: 16 * MiB, maxPendingRequests: 128, maxInboundRequests: 64,
  requestTimeoutMs: 45000, inboundRequestTimeoutMs: 120000,
});
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = id => id === null || typeof id === 'string' || Number.isSafeInteger(id);
const historyMethod = method => ['session/load', 'session/list', 'session/resume'].includes(method);

function transportError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, writeState: 'not_written', submissionUnknown: false, rpcNotSent: true }, extra);
}
function withWriteState(error, state, method) {
  const result = transportError(error.code || 'ACP_CLOSED', error.message, {
    writeState: state, rpcMethod: method, submissionUnknown: state !== 'not_written', rpcNotSent: state === 'not_written',
  });
  if (error.rpcResponseReceived) { result.rpcResponseReceived = true; result.submissionUnknown = false; }
  if (error.kind) result.kind = error.kind;
  return result;
}
function safeRemoteError(error, method) {
  const authentication = error.code === -32000 && /^Authentication required(?:\b|$)/i.test(error.message);
  return transportError(error.code, authentication ? 'Antigravity 需要登录' : 'Antigravity 请求失败', {
    rpcMethod: method, rpcResponseReceived: true, kind: authentication ? 'authenticationRequired' : 'remoteError',
  });
}

// ACP v1 is newline-delimited UTF-8 JSON-RPC, never Content-Length framing.
// https://agentclientprotocol.com/protocol/v1/transports
// This module owns framing and RPC only; project/session authority stays in the service.
class AcpTransport extends EventEmitter {
  constructor({ child, generation = 1, limits = {}, onRequest, onDiagnostic } = {}) {
    super();
    if (!child?.stdin || !child?.stdout) throw new TypeError('ACP child must have piped stdin/stdout');
    this.child = child; this.generation = generation;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new TypeError('Invalid ACP limit: ' + key);
    }
    this.onRequest = onRequest; this.onDiagnostic = onDiagnostic;
    this.sequence = 0; this.pending = new Map(); this.inbound = new Map();
    this.writeQueue = []; this.activeWrite = null; this.queuedWriteBytes = 0;
    this.fragments = []; this.frameBytes = 0; this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.closed = false;
    this.stats = { inboundFrames: 0, outboundFrames: 0, unknownResponses: 0, stderrBytes: 0 };
    child.stdout.on('data', chunk => this._read(chunk));
    child.stdout.on('end', () => this.close(transportError(
      this.frameBytes ? 'ACP_TRUNCATED_FRAME' : 'ACP_STDOUT_CLOSED',
      this.frameBytes ? 'Antigravity 协议消息未完整接收' : 'Antigravity 通信已关闭')));
    child.stdout.on('error', () => this.close(transportError('ACP_READ_FAILED', 'Antigravity 标准输出读取失败')));
    child.stdin.on('error', () => this.close(transportError('ACP_WRITE_FAILED', 'Antigravity 标准输入写入失败')));
    child.on('error', () => this.close(transportError('ACP_PROCESS_ERROR', 'Antigravity 进程启动或通信失败')));
    child.on('exit', () => this.close(transportError('ACP_PROCESS_EXIT', 'Antigravity 进程已退出')));
    child.stderr?.on('error', () => {});
    // Consume continuously, retaining no credential-bearing text or unbounded buffer.
    child.stderr?.on('data', chunk => {
      this.stats.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stats.stderrBytes + (Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))));
    });
  }

  setRequestHandler(handler) { this.onRequest = handler; }
  _diagnostic(kind, extra = {}) {
    const record = { kind, generation: this.generation, ...extra };
    try { this.onDiagnostic?.(record); } catch {}
    this.emit('diagnostic', record);
  }
  _read(chunk) {
    if (this.closed) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    // Only scan newly arrived bytes; byte counters avoid rescanning growing frames.
    while (offset < buffer.length && !this.closed) {
      const newline = buffer.indexOf(10, offset), end = newline < 0 ? buffer.length : newline;
      const fragment = buffer.subarray(offset, end);
      this.frameBytes += fragment.length;
      if (this.frameBytes > this.limits.maxInboundFrameBytes) {
        this.close(transportError('ACP_INBOUND_LIMIT', 'Antigravity 协议消息超出接收限制')); return;
      }
      try {
        const decoded = this.decoder.decode(fragment, { stream: true });
        if (decoded) this.fragments.push(decoded);
        if (newline < 0) {
          if (this.fragments.length > 65536) this.fragments = [this.fragments.join('')];
          return;
        }
        const tail = this.decoder.decode();
        if (tail) this.fragments.push(tail);
      } catch {
        this.close(transportError('ACP_INVALID_UTF8', 'Antigravity 返回了无效 UTF-8 协议数据')); return;
      }
      const line = this.fragments.join(''), bytes = this.frameBytes;
      this.fragments = []; this.frameBytes = 0; offset = newline + 1;
      let message;
      try { message = JSON.parse(line); } catch {
        this.close(transportError('ACP_INVALID_JSON', 'Antigravity 返回了无效 JSON 协议数据')); return;
      }
      this._message(message, bytes);
    }
  }

  _message(message, bytes) {
    if (!object(message) || message.jsonrpc !== '2.0') return this._invalid();
    const isCall = has(message, 'method');
    if (isCall) {
      if (typeof message.method !== 'string' || !message.method ||
          (has(message, 'params') && !object(message.params) && !Array.isArray(message.params)) ||
          has(message, 'result') || has(message, 'error') ||
          (has(message, 'id') && !validId(message.id))) return this._invalid();
      const maximum = has(message, 'id') ? this.limits.maxMessageBytes : this.limits.maxNotificationBytes;
      if (bytes > maximum || !this._imagesWithinBudget(message)) return this._limit();
      this.stats.inboundFrames++;
      if (has(message, 'id')) this._incomingRequest(message);
      else this.emit('notification', { method: message.method, params: message.params, generation: this.generation });
      return;
    }
    if (!has(message, 'id') || !validId(message.id) || has(message, 'result') === has(message, 'error') ||
        (has(message, 'error') && (!object(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string'))) return this._invalid();
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.stats.unknownResponses++; this._diagnostic('unknown_response'); return;
    }
    if (pending.writeState === 'not_written') return this._invalid();
    if (bytes > this._methodLimit(pending.method, 'inbound') || !this._imagesWithinBudget(message)) return this._limit();
    this.stats.inboundFrames++;
    this._removePending(pending);
    if (has(message, 'error')) pending.reject(withWriteState(safeRemoteError(message.error, pending.method), pending.writeState, pending.method));
    else pending.resolve(message.result);
  }

  _invalid() { this.close(transportError('ACP_INVALID_MESSAGE', 'Antigravity 返回了无效 JSON-RPC 消息')); }
  _limit() { this.close(transportError('ACP_MESSAGE_LIMIT', 'Antigravity 消息超出内容限制')); }
  _methodLimit(method, direction) {
    const configured = this.limits[direction + 'MethodBytes']?.[method];
    return configured ?? (historyMethod(method) ? this.limits.maxHistoryBytes : this.limits.maxMessageBytes);
  }
  _imagesWithinBudget(value) {
    let imageBytes = 0;
    const stack = [value];
    while (stack.length) {
      const item = stack.pop();
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'image' && typeof item.data === 'string') {
        imageBytes += Buffer.byteLength(item.data);
        if (imageBytes > this.limits.maxImageBytes) return false;
      }
      for (const nested of Object.values(item)) if (nested && typeof nested === 'object') stack.push(nested);
    }
    return true;
  }

  _incomingRequest(message) {
    if (this.inbound.has(message.id)) return this._invalid();
    if (this.inbound.size >= this.limits.maxInboundRequests) {
      this._sendError(message.id, -32001, 'Client request limit exceeded'); return;
    }
    if (typeof this.onRequest !== 'function') {
      this._diagnostic('unsupported_request');
      this._sendError(message.id, -32601, 'Method not found'); return;
    }
    const controller = new AbortController();
    const entry = { controller, timer: null };
    this.inbound.set(message.id, entry);
    const finish = (result, error) => {
      if (this.closed || this.inbound.get(message.id) !== entry) return;
      this.inbound.delete(message.id); clearTimeout(entry.timer);
      if (error) {
        const code = [-32601, -32602, -32800].includes(error.code) ? error.code : -32603;
        const label = code === -32601 ? 'Method not found' : code === -32602 ? 'Invalid params' : code === -32800 ? 'Request cancelled' : 'Internal error';
        this._sendError(message.id, code, label);
      } else {
        this._send({ jsonrpc: '2.0', id: message.id, result: result === undefined ? null : result }).promise.catch(error => this.close(error));
      }
    };
    if (this.limits.inboundRequestTimeoutMs > 0) entry.timer = setTimeout(() => {
      controller.abort(); finish(undefined, { code: -32800 });
    }, this.limits.inboundRequestTimeoutMs);
    Promise.resolve().then(() => {
      if (this.closed || controller.signal.aborted || this.inbound.get(message.id) !== entry) return;
      return this.onRequest({
        id: message.id, method: message.method, params: message.params,
        generation: this.generation, signal: controller.signal,
      });
    }).then(result => finish(result), error => finish(undefined, error || {}));
  }
  _sendError(id, code, message) {
    this._send({ jsonrpc: '2.0', id, error: { code, message } }).promise.catch(error => this.close(error));
  }

  _send(message, hooks = {}) {
    let buffer;
    try {
      buffer = Buffer.from(JSON.stringify(message) + '\n', 'utf8');
      const methodMaximum = has(message, 'method') ? this._methodLimit(message.method, 'outbound') : this.limits.maxMessageBytes;
      if (buffer.length > this.limits.maxOutboundFrameBytes || buffer.length > methodMaximum || !this._imagesWithinBudget(message)) {
        throw transportError('ACP_OUTBOUND_LIMIT', 'Antigravity 请求超出发送限制');
      }
      if (this.closed || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
        throw transportError('ACP_CLOSED', 'Antigravity 通信已关闭');
      }
      if (this.queuedWriteBytes + buffer.length > this.limits.maxQueuedWriteBytes) {
        throw transportError('ACP_WRITE_QUEUE_LIMIT', 'Antigravity 待发送数据超出限制');
      }
    } catch (error) {
      return { task: null, promise: Promise.reject(typeof error.code === 'string' ? error : transportError('ACP_SERIALIZE_FAILED', 'Antigravity 请求无法编码')) };
    }
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const task = { buffer, resolve, reject, hooks, state: 'not_written', settled: false, cleanup: null };
    this.queuedWriteBytes += buffer.length; this.writeQueue.push(task); this._pump();
    return { task, promise };
  }
  _writeState(task, state) {
    task.state = state;
    try { task.hooks.onWriteState?.(state); } catch {
      this._diagnostic('write_state_observer_failed');
    }
  }
  _finishWrite(task, error) {
    if (task.settled) return;
    task.settled = true; task.cleanup?.();
    this.queuedWriteBytes -= task.buffer.length;
    task.buffer = null;
    if (this.activeWrite === task) this.activeWrite = null;
    if (error) task.reject(withWriteState(error, task.state));
    else { this.stats.outboundFrames++; task.resolve({ writeState: task.state }); }
  }
  _pump() {
    if (this.closed || this.activeWrite || !this.writeQueue.length) return;
    const task = this.writeQueue.shift(); this.activeWrite = task;
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      this.close(transportError('ACP_CLOSED', 'Antigravity 通信已关闭')); return;
    }
    let returned = false, callbackDone = false, needsDrain = false, seenDrain = false;
    const finish = () => {
      if (!returned || !callbackDone || (needsDrain && !seenDrain) || task.settled || this.closed) return;
      this._finishWrite(task);
      // Synchronous test streams and small writes must not grow the call stack.
      queueMicrotask(() => this._pump());
    };
    const drain = () => { seenDrain = true; finish(); };
    task.cleanup = () => this.child.stdin.removeListener('drain', drain);
    this.child.stdin.once('drain', drain);
    this._writeState(task, 'possibly_written');
    try {
      const accepted = this.child.stdin.write(task.buffer, error => {
        if (task.settled || this.closed) return;
        if (error) { this.close(transportError('ACP_WRITE_FAILED', 'Antigravity 标准输入写入失败')); return; }
        callbackDone = true; this._writeState(task, 'written'); finish();
      });
      needsDrain = accepted === false; returned = true;
      if (!needsDrain) task.cleanup();
      finish();
    } catch {
      // A throw after invoking write cannot prove that the peer saw no bytes.
      this.close(transportError('ACP_WRITE_FAILED', 'Antigravity 标准输入写入失败'));
    }
  }
  _cancelQueued(task, error) {
    const index = this.writeQueue.indexOf(task);
    if (index < 0) return false;
    this.writeQueue.splice(index, 1); this._finishWrite(task, error); return true;
  }
  _removePending(pending) {
    if (this.pending.get(pending.id) !== pending) return false;
    this.pending.delete(pending.id); clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort); return true;
  }

  request(method, params = {}, options = {}) {
    if (typeof options === 'number') options = { timeoutMs: options };
    if (typeof method !== 'string' || !method || (!object(params) && !Array.isArray(params))) {
      return Promise.reject(transportError('ACP_INVALID_REQUEST', 'Antigravity 请求参数无效'));
    }
    if (this.closed) return Promise.reject(transportError('ACP_CLOSED', 'Antigravity 通信已关闭'));
    if (this.pending.size >= this.limits.maxPendingRequests) return Promise.reject(transportError('ACP_PENDING_LIMIT', 'Antigravity 待处理请求过多'));
    if (options.signal?.aborted) return Promise.reject(transportError('ACP_REQUEST_ABORTED', 'Antigravity 请求已取消'));
    return new Promise((resolve, reject) => {
      const id = 'myide-' + this.generation + '-' + (++this.sequence);
      const pending = { id, method, resolve, reject, timer: null, writeState: 'not_written', signal: options.signal, task: null };
      const fail = error => {
        if (!this._removePending(pending)) return;
        if (pending.task) this._cancelQueued(pending.task, error);
        reject(withWriteState(error, pending.writeState, method));
      };
      pending.onAbort = () => fail(transportError('ACP_REQUEST_ABORTED', 'Antigravity 请求已取消'));
      pending.signal?.addEventListener('abort', pending.onAbort, { once: true });
      this.pending.set(id, pending);
      const timeout = options.timeoutMs ?? this.limits.requestTimeoutMs;
      if (timeout > 0) pending.timer = setTimeout(() => fail(transportError('ACP_REQUEST_TIMEOUT', 'Antigravity 请求超时')), timeout);
      const sent = this._send({ jsonrpc: '2.0', id, method, params }, {
        onWriteState: state => { pending.writeState = state; options.onWriteState?.(state); },
      });
      pending.task = sent.task;
      sent.promise.catch(error => fail(error));
    });
  }

  notify(method, params = {}) {
    if (typeof method !== 'string' || !method || (!object(params) && !Array.isArray(params))) {
      return Promise.reject(transportError('ACP_INVALID_REQUEST', 'Antigravity 通知参数无效'));
    }
    return this._send({ jsonrpc: '2.0', method, params }).promise;
  }

  close(reason) {
    if (this.closed) return;
    const error = typeof reason?.code === 'string' ? reason : transportError('ACP_CLOSED', 'Antigravity 通信已关闭');
    this.closed = true; this.fragments = []; this.frameBytes = 0; this.decoder = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.signal?.removeEventListener('abort', pending.onAbort);
      pending.reject(withWriteState(error, pending.writeState, pending.method));
    }
    this.pending.clear();
    for (const entry of this.inbound.values()) { clearTimeout(entry.timer); entry.controller.abort(); }
    this.inbound.clear();
    if (this.activeWrite) this._finishWrite(this.activeWrite, error);
    for (const task of this.writeQueue.splice(0)) this._finishWrite(task, error);
    // The service owns process retirement; EOF affects only this spawned child.
    try { if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end(); } catch {}
    this._diagnostic('closed', { code: error.code }); this.emit('closed', error);
  }
}

module.exports = { AcpTransport, DEFAULT_LIMITS, transportError };

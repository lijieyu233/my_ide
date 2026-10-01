const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const TextFormat = require('./text-format');
const { snapshotStamp, snapshotVersion } = require('./file-write');

const POLICY = Object.freeze({ maxResults: 200, maxFileBytes: 1024 * 1024, deadlineMs: 10000,
  concurrency: 4, hidden: false, gitIgnore: false, links: false, match: 'literal', columns: 'UTF-16, one-based, end-exclusive' });
const inside = (root, target) => { const relative = path.relative(root, target); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const errorText = error => String(error?.message || error);

function createSearchService(config = {}) {
  const io = config.io || fs.promises, now = config.now || (() => performance.now());
  const concurrency = config.concurrency || POLICY.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw Error('搜索并发必须在1～8之间');
  const jobs = new Map(), active = new Map(), waiters = [];
  let slots = 0, peakSlots = 0;
  function stopped(job) {
    if (job.reason) return true;
    if (job.controller.signal.aborted) job.reason = 'cancelled';
    else if (now() - job.started >= job.deadlineMs) job.reason = 'timeLimit';
    return !!job.reason;
  }
  function fail(job, error, location) {
    job.stats.failed++;
    job.failure ||= { error: location + '：' + errorText(error), errorCode: error?.code || 'SEARCH_FAILED' };
  }
  function release() {
    slots--;
    while (waiters.length) {
      const waiter = waiters.shift(); waiter.cleanup();
      if (stopped(waiter.job)) { waiter.resolve(false); continue; }
      slots++; peakSlots = Math.max(peakSlots, slots); waiter.resolve(true); break;
    }
  }
  async function takeSlot(job) {
    if (stopped(job)) return false;
    if (slots < concurrency) { slots++; peakSlots = Math.max(peakSlots, slots); return true; }
    return new Promise(resolve => {
      const waiter = { job, resolve, cleanup: () => job.controller.signal.removeEventListener('abort', abort) };
      const abort = () => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); waiter.cleanup(); resolve(false); };
      waiters.push(waiter); job.controller.signal.addEventListener('abort', abort, { once: true });
    });
  }
  function envelope(job) { return { requestId: job.requestId, root: job.root, projectGeneration: job.projectGeneration, query: job.query }; }
  function publish(job, hits) {
    if (!hits.length || job.controller.signal.aborted) return;
    // 小批次有上限；没有正文缓存，更不能在取消后重新过滤全库来补造结果。
    for (let i = 0; i < hits.length; i += 32) {
      if (job.controller.signal.aborted) return;
      try { job.onBatch?.({ ...envelope(job), batchNo: ++job.batchNo, results: hits.slice(i, i + 32) }); }
      catch (error) { fail(job, error, '结果接收失败'); job.reason = 'error'; job.controller.abort(); return; }
    }
  }
  function matchFile(job, file, content, version, encoding) {
    const hits = [], query = job.options.caseSensitive ? job.query : job.query.toLowerCase();
    let line = 0;
    for (const item of content.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
      if (stopped(job)) break;
      line++;
      const raw = item[0].replace(/(?:\r\n|\r|\n)$/, ''), folded = job.options.caseSensitive ? raw : raw.toLowerCase();
      let cursor = 0, from = folded.indexOf(query, cursor), mapping;
      if (from < 0) continue;
      if (!job.options.caseSensitive && folded.length !== raw.length) {
        mapping = []; let offset = 0;
        for (const char of raw) {
          for (let i = 0; i < char.toLowerCase().length; i++) mapping.push([offset, offset + char.length]);
          offset += char.length;
        }
      }
      while (from >= 0 && !stopped(job)) {
        const start = mapping ? mapping[from][0] : from, end = mapping ? mapping[from + query.length - 1][1] : from + query.length;
        const relative = path.relative(job.root, file).replace(/\\/g, '/');
        const hit = { hitId: job.requestId + ':' + relative + ':' + (item.index + start), file: relative, path: file,
          line, startColumn: start + 1, endColumn: end + 1, startOffset: item.index + start, endOffset: item.index + end,
          text: raw.slice(Math.max(0, start - 60), Math.max(0, start - 60) + 200), previewStartColumn: Math.max(0, start - 60) + 1,
          match: raw.slice(start, end), version, encoding };
        hits.push(hit); job.results.push(hit);
        if (job.results.length >= job.limit) { job.reason = 'resultLimit'; break; }
        cursor = from + query.length; from = folded.indexOf(query, cursor);
      }
    }
    publish(job, hits);
  }
  async function scanFile(job, file) {
    if (!await takeSlot(job)) return;
    let handle;
    job.stats.inFlight++; job.stats.peakInFlight = Math.max(job.stats.peakInFlight, job.stats.inFlight);
    try {
      if (stopped(job)) return;
      const target = await io.realpath(file); if (stopped(job)) return;
      if (!inside(job.canonicalRoot, target)) throw Object.assign(Error('文件位置已移出搜索项目'), { code: 'SCOPE_CHANGED' });
      handle = await io.open(target, 'r'); if (stopped(job)) return;
      const before = await handle.stat(); if (stopped(job)) return;
      if (!before.isFile()) { job.stats.skipped.special++; return; }
      if (before.size > POLICY.maxFileBytes) { job.stats.skipped.large++; return; }
      if (!before.size) { job.stats.skipped.empty++; return; }
      // 读取上限以打开时尺寸+1固定；外部持续增长不能让readFile分配无界缓冲区。
      const buffer = Buffer.alloc(before.size + 1); let length = 0;
      while (length < buffer.length && !stopped(job)) {
        const read = await handle.read(buffer, length, buffer.length - length, length);
        length += read.bytesRead; job.stats.bytes += read.bytesRead;
        if (stopped(job)) return;
        if (!read.bytesRead) break;
      }
      if (stopped(job)) return;
      const after = await handle.stat(); if (stopped(job)) return;
      const currentTarget = await io.realpath(file); if (stopped(job)) return;
      const currentStat = await io.stat(target); if (stopped(job)) return;
      if (target !== currentTarget || snapshotStamp(before) !== snapshotStamp(after)
        || snapshotStamp(before) !== snapshotStamp(currentStat) || length !== before.size)
        throw Object.assign(Error('文件在搜索读取期间已变化，请重试'), { code: 'VERSION_CONFLICT' });
      const bytes = buffer.subarray(0, length), decoded = TextFormat.decodeText(bytes);
      if (decoded.binary) { job.stats.skipped.binary++; return; }
      job.stats.scanned++; matchFile(job, file, decoded.content, snapshotVersion(target, before, bytes), decoded.encoding);
    } catch (error) { if (!job.controller.signal.aborted) fail(job, error, '读取 ' + file); }
    finally {
      if (handle) { try { await handle.close(); } catch (error) { fail(job, error, '关闭搜索文件 ' + file); } }
      job.stats.inFlight--; release();
    }
  }
  async function run(job) {
    const inFlight = new Set();
    async function walk(dir, depth = 0) {
      if (stopped(job)) return;
      if (depth > 128) { fail(job, Object.assign(Error('目录深度超过128层'), { code: 'SCOPE_LIMIT' }), dir); job.reason = 'error'; return; }
      let directory;
      try {
        const target = await io.realpath(dir); if (stopped(job)) return;
        if (!inside(job.canonicalRoot, target)) throw Object.assign(Error('目录位置已移出搜索项目'), { code: 'SCOPE_CHANGED' });
        directory = await io.opendir(dir, { bufferSize: 32 }); if (stopped(job)) { await directory.close(); return; }
        job.stats.directories++;
        for await (const entry of directory) {
          if (stopped(job)) break;
          if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) { job.stats.skipped.hidden++; continue; }
          if (entry.isSymbolicLink()) { job.stats.skipped.links++; continue; }
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full, depth + 1);
          else if (entry.isFile()) {
            if (job.stats.candidates >= 50000) { fail(job, Object.assign(Error('候选文件达到50000上限，未完整搜索'), { code: 'SCOPE_LIMIT' }), dir); job.reason = 'error'; break; }
            job.stats.candidates++;
            const pending = scanFile(job, full); inFlight.add(pending); pending.finally(() => inFlight.delete(pending));
            if (inFlight.size >= concurrency) await Promise.race(inFlight);
          } else job.stats.skipped.special++;
        }
      } catch (error) { if (!job.controller.signal.aborted) fail(job, error, '读取目录 ' + dir); }
    }
    try {
      job.canonicalRoot = await io.realpath(job.root);
      if (!stopped(job)) await walk(job.root);
    } catch (error) { if (!job.controller.signal.aborted) fail(job, error, '打开搜索项目 ' + job.root); }
    await Promise.allSettled([...inFlight]);
    stopped(job);
    const doneReason = job.reason || (job.failure ? 'error' : 'complete');
    return { ...envelope(job), results: job.results, doneReason, truncated: doneReason !== 'complete',
      elapsed: Math.round(now() - job.started), ...job.failure, stats: { ...job.stats }, policy: POLICY };
  }
  function start(owner, request, onBatch, replace = true) {
    const identity = { requestId: request?.requestId, root: request?.root, projectGeneration: request?.projectGeneration, query: request?.query };
    const reject = (errorCode, error) => Promise.resolve({ ...identity, results: [], doneReason: 'error', truncated: true, errorCode, error });
    if (!request || typeof request.requestId !== 'string' || !request.requestId.length || request.requestId.length > 128
      || typeof request.root !== 'string' || !path.isAbsolute(request.root) || !Number.isSafeInteger(request.projectGeneration) || request.projectGeneration < 0
      || typeof request.query !== 'string' || !request.query.length || request.query.length > 4096 || /[\r\n]/.test(request.query)
      || request.options?.caseSensitive != null && typeof request.options.caseSensitive !== 'boolean')
      return reject('INVALID_SEARCH', '搜索请求需要有效的项目、查询身份和单行字面关键字');
    const jobKey = owner + '\0' + request.requestId;
    if (jobs.has(jobKey)) return reject('REQUEST_EXISTS', '该搜索请求正在运行');
    const limit = request.options?.maxResults ?? POLICY.maxResults, deadlineMs = request.options?.deadlineMs ?? POLICY.deadlineMs;
    if (!Number.isInteger(limit) || limit < 1 || limit > POLICY.maxResults || !Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > POLICY.deadlineMs)
      return reject('INVALID_SEARCH', '搜索预算只能缩小，不能超过默认上限');
    if (replace) active.get(owner)?.controller.abort();
    if (jobs.size >= 8 || [...jobs.values()].filter(job => job.owner === owner).length >= 4) return reject('SEARCH_BUSY', '搜索正在取消或资源繁忙，请稍后重试');
    const job = { ...identity, owner, root: path.resolve(request.root), options: { caseSensitive: !!request.options?.caseSensitive },
      limit, deadlineMs, controller: new AbortController(), results: [], started: now(), onBatch, batchNo: 0,
      stats: { candidates: 0, directories: 0, scanned: 0, bytes: 0, failed: 0, inFlight: 0, peakInFlight: 0,
        skipped: { hidden: 0, links: 0, special: 0, large: 0, empty: 0, binary: 0 } } };
    jobs.set(jobKey, job); if (replace) active.set(owner, job);
    job.done = run(job).finally(() => { jobs.delete(jobKey); if (active.get(owner) === job) active.delete(owner); });
    return job.done;
  }
  async function cancel(owner, requestId) {
    const job = jobs.get(owner + '\0' + requestId);
    if (!job) return { ok: false, requestId, errorCode: 'NOT_RUNNING' };
    job.controller.abort(); const result = await job.done;
    return { ok: true, ...envelope(job), stopped: true, doneReason: result.doneReason, stats: result.stats };
  }
  function cancelOwner(owner) { for (const job of jobs.values()) if (job.owner === owner) job.controller.abort(); }
  return { start, cancel, cancelOwner, get metrics() { return { pending: jobs.size, inFlight: slots, peakInFlight: peakSlots, waiting: waiters.length }; } };
}
module.exports = { createSearchService, POLICY };

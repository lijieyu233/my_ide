// launch-panel.js —— 启动面板（侧栏条目列表 + 主区详情/日志，双区联动，照 db 面板的模式）
// 配置：~/.myide/launch.json（机器级，用户拍板）；运行状态：~/.myide/launch-state.json
// 后台保留靠服务落盘的OS身份恢复；端口响应只说明可连接，不授予停止权限。
const LaunchPanel = (() => {
  const L = () => (window.myIDE && window.myIDE.launch) || null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const q = (id) => document.getElementById(id);
  const setText = (id, value) => { const element = q(id); if (element && element.textContent !== value) element.textContent = value; };

  let cfg = { apiOrigins: [], entries: [] };
  let status = {};           // id -> { alive, by, pid }
  let selectedId = null;     // 主区当前展示的条目
  let collapsed = {};        // 分类折叠
  let timer = null, statusPoll = null;
  let inited = false;
  const operations = new Map(), outcomes = new Map();
  let statusSerial = 0, configSerial = 0, revision = 0, checkedAt = 0, statusError = '', configError = '';
  let batch = null, batchReport = null, configBusy = false, configLoading = false;
  const blockedConfig = () => configBusy || configLoading || !!configError;
  const labels = { start: '启动', stop: '停止', restart: '重启', delete: '删除' };
  const resolvedOpenUrl = e => e.openUrl || (e.port ? 'http://127.0.0.1:' + e.port : '');
  const reason = error => String(error && error.message || error || '操作未确认');
  const fingerprint = e => JSON.stringify(e);
  const ownedRunning = s => s.ownership === 'owned' && (s.processAlive || s.alive && (s.by === 'proc' || s.by === 'pid'));
  function confirmed(result, kind) {
    if (!result || typeof result !== 'object' || result.ok === false || result.accepted === false || result.error || (result.failed && result.failed.length) || (result.remainingOwned && result.remainingOwned.length)) return false;
    return result.ok === true || kind === 'start' && result.accepted === true;
  }
  function capabilities(e) {
    const s = stOf(e.id), fresh = !configLoading && !configError && !statusError && !s.operation && !!status[e.id];
    return { start: fresh && (typeof s.canStart === 'boolean' ? s.canStart : !s.alive),
      stop: fresh && (typeof s.canStop === 'boolean' ? s.canStop : s.alive && (s.by === 'proc' || s.by === 'pid') && s.ownership === 'owned') };
  }
  function stateText(e) {
    const pending = operations.get(e.id), s = stOf(e.id);
    if (pending) return (pending.queued ? '等待' : '正在') + labels[pending.kind];
    if (statusError || !status[e.id]) return '状态暂不可用' + (checkedAt ? ' · 上次确认 ' + new Date(checkedAt).toLocaleTimeString() : '');
    if (s.operation) return '正在' + s.operation;
    if (s.processAlive || s.alive && s.by !== 'port' && s.by !== 'state') {
      const ready = s.readiness || {}, states = { waiting: '等待就绪', ready: ready.mode === 'port' ? '已就绪 · 端口响应（来源未验证）' : '已就绪 · 本次输出已匹配',
        'timed-out': '就绪超时 · 进程仍在运行', unavailable: '就绪端口不再响应 · 进程仍在运行', unknown: '就绪未确认' };
      return '运行中 · ' + (states[ready.state] || '未验证就绪') + (s.ownership !== 'owned' ? ' · 归属未确认' : '');
    }
    if (s.ownership === 'bridge' || s.by === 'state') return '桥接已登记 · 未验证 daemon 存活';
    if (s.ownership === 'unknown' || s.ownership === 'foreign') return '进程归属未确认';
    if (s.portResponding || s.alive && s.by === 'port') return '端口有响应 · 进程归属未确认';
    if (s.phase === 'exited') return s.exitSignal || s.exitCode !== 0 ? '异常退出 · ' + (s.exitSignal || '退出码 ' + s.exitCode) : '已退出 · 退出码 0';
    return '未启动 / 已停止';
  }
  function failureText(id) {
    const value = outcomes.get(id);
    return value && !value.ok ? labels[value.kind] + '失败：' + value.error : '';
  }
  function installOperationUI() {
    const text = document.createElement('span'); text.id = 'lm-state'; text.setAttribute('role', 'status');
    q('lm-name').parentElement.append(text);
    const notice = document.createElement('div'); notice.id = 'lm-operation'; notice.className = 'launch-operation'; notice.hidden = true;
    notice.innerHTML = '<span id="lm-operation-text" role="status"></span><button id="lm-operation-retry" class="lp-foot-btn" hidden>重试操作</button>';
    q('lm-meta').before(notice);
    const global = document.createElement('div'); global.id = 'launch-operation-summary'; global.className = 'launch-operation'; global.hidden = true;
    global.innerHTML = '<span id="launch-summary-text" role="status"></span><button id="launch-status-retry" class="lp-foot-btn" hidden>重试读取</button><button id="launch-batch-retry" class="lp-foot-btn" hidden>重试失败项</button><details id="launch-batch-details" hidden><summary>逐项结果</summary><div id="launch-batch-items"></div></details>';
    q('launch-body').before(global);
    const more = document.createElement('details'); more.className = 'launch-entry-more';
    more.innerHTML = '<summary class="lp-foot-btn">更多操作</summary>';
    q('lm-edit').before(more); more.append(q('lm-edit'), q('lm-del'));
    for (const [id, label] of [['lm-start', '启动'], ['lm-stop', '停止'], ['lm-restart', '重启'], ['lm-open', '打开']]) q(id).textContent = label;
    q('lm-operation-retry').onclick = () => { const e = byId(selectedId), value = e && outcomes.get(e.id); if (e && value && !value.ok) value.kind === 'delete' ? removeEntry(e.id) : act(e, value.kind); };
    q('launch-status-retry').onclick = () => configError ? load() : pollOnce();
    q('launch-batch-retry').onclick = () => { if (batchReport) runBatch(batchReport.kind, batchReport.items.filter(item => !item.ok)); };
    const ready = document.createElement('div'); ready.id = 'launch-readiness-fields';
    ready.innerHTML = '<div class="field"><label for="launch-ready-mode">就绪条件</label><select id="launch-ready-mode" name="readyMode"><option value="none">无需验证</option><option value="port">终端端口响应</option><option value="output">指定输出出现</option></select></div>'
      + '<div class="field" id="launch-ready-text-field" hidden><label for="launch-ready-text">输出字面文本（区分大小写，单行，最多256字符）</label><input id="launch-ready-text" name="readyText" maxlength="256"></div>'
      + '<div class="field" id="launch-ready-timeout-field" hidden><label for="launch-ready-timeout">等待秒数（1至3600）</label><input id="launch-ready-timeout" name="readyTimeout" type="number" min="1" max="3600" value="30"></div>'
      + '<div id="launch-ready-help" role="status">只判断进程存活，不宣称已就绪；保存不会执行命令。</div>';
    q('launch-form').querySelector('.dlg-actions').before(ready);
    q('launch-ready-mode').onchange = readinessFields;
  }
  function readinessFields() {
    const mode = q('launch-ready-mode').value, usb = q('launch-form').elements.kind.value === 'usb-tunnel';
    q('launch-ready-text-field').hidden = mode !== 'output'; q('launch-ready-timeout-field').hidden = mode === 'none';
    q('launch-ready-text').disabled = mode !== 'output'; q('launch-ready-timeout').disabled = mode === 'none';
    q('launch-ready-help').textContent = (usb ? 'USB daemon身份尚未核验，暂只能选择无需验证。' : mode === 'port' ? '只验证127.0.0.1的终端端口响应，不能证明响应来自本次进程；超时不停止进程。' : mode === 'output' ? '只匹配本次运行的stdout或stderr，命令回显不算；超时不停止进程。' : '只判断进程存活，不宣称已就绪；保存不会执行命令。') + ' 条件修改仅在下次启动时生效。';
  }
  function refreshOperationUI() {
    const e = byId(selectedId), pending = e && (operations.get(e.id) || stOf(e.id).operation), caps = e && capabilities(e);
    setText('lm-state', e ? stateText(e) : '');
    if (e) {
      q('lm-start').disabled = !!pending || configBusy || !caps.start;
      q('lm-stop').disabled = !!pending || configBusy || !caps.stop;
      q('lm-restart').disabled = !!pending || configBusy || !caps.stop;
      q('lm-edit').disabled = !!pending || blockedConfig();
      q('lm-del').disabled = !!pending || blockedConfig();
      q('lm-open').disabled = !resolvedOpenUrl(e);
      const s = stOf(e.id), value = outcomes.get(e.id);
      const details = [failureText(e.id), statusError && '状态读取失败：' + statusError,
        s.evidenceError, s.readiness && (s.readiness.reason || (s.readiness.state === 'timed-out' ? '在' + s.readiness.timeoutSeconds + '秒内未确认就绪；可继续查看日志，或手动停止/重启。' : '')), value && value.ok && value.message].filter(Boolean);
      setText('lm-operation-text', details.join('；')); q('lm-operation').hidden = !details.length;
      q('lm-operation-retry').hidden = !(value && !value.ok); q('lm-operation-retry').disabled = !!pending || blockedConfig();
    } else q('lm-operation').hidden = true;
    for (const id of ['launch-start-all', 'launch-stop-all']) if (q(id)) q(id).disabled = !!batch || blockedConfig() || !!operations.size || !!statusError;
    for (const id of ['launch-add', 'launch-import', 'launch-dialog-ok']) if (q(id)) q(id).disabled = blockedConfig() || !!operations.size;
    document.querySelectorAll('.lp-keep').forEach(k => { k.disabled = blockedConfig(); });
    const parts = [configLoading && '正在读取配置，请等待', configError && '配置读取失败，保留上次列表：' + configError, statusError && '状态读取失败，保留上次状态：' + statusError];
    if (batch) parts.push('全部' + labels[batch.kind] + '：' + batch.done + '/' + batch.items.length + '，请等待');
    else if (batchReport) parts.push('全部' + labels[batchReport.kind] + '：目标 ' + batchReport.items.length + '，已确认 ' + batchReport.items.filter(item => item.ok).length + '，失败 ' + batchReport.items.filter(item => !item.ok && item.executed).length + '，未执行 ' + batchReport.items.filter(item => !item.executed).length);
    setText('launch-summary-text', parts.filter(Boolean).join('；')); q('launch-operation-summary').hidden = !parts.some(Boolean);
    q('launch-status-retry').hidden = !configError && !statusError;
    q('launch-batch-retry').hidden = !batchReport || !batchReport.items.some(item => !item.ok);
    q('launch-batch-retry').disabled = !!batch || blockedConfig() || !!operations.size;
    q('launch-batch-details').hidden = !batchReport;
    if (batchReport) setText('launch-batch-items', batchReport.items.map(item => item.name + '：' + (item.ok ? '已确认' : (item.executed ? '失败：' : '未执行：') + item.error)).join('\n'));
  }

  const stOf = (id) => status[id] || { alive: false, by: 'none', pid: 0 };
  const byId = (id) => cfg.entries.find((x) => x.id === id);

  // 日志DOM按本代次seq复用：整块textContent会使阅读位置和原生选区每次轮询都失效。
  const logReader = (() => {
    const views = new Map();
    let current = null, serial = 0, installed = false, composing = false;
    const visible = () => !!q('launch-main') && !q('launch-main').classList.contains('hidden');
    const blocked = () => !!(window.Modal && window.Modal.stack && window.Modal.stack.length) || !!document.querySelector('dialog[open]');
    const state = id => {
      if (!views.has(id)) views.set(id, { id, snapshot: null, follow: true, paused: false, unread: 0, changed: false,
        query: '', sensitive: false, searchOpen: false, active: 0, matches: [], total: 0,
        readError: '', actionError: '', clearing: false, busy: 0, anchor: null });
      return views.get(id);
    };
    const nearBottom = () => { const el = q('lm-log'); return el.scrollHeight - el.scrollTop - el.clientHeight < 30; };
    function selection() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !q('lm-log').contains(sel.anchorNode) || !q('lm-log').contains(sel.focusNode)) return null;
      const point = (node, offset) => {
        const row = (node.nodeType === 1 ? node : node.parentElement).closest('[data-log-seq]');
        if (!row) return null;
        const range = document.createRange(); range.selectNodeContents(row); range.setEnd(node, offset);
        return { seq: row.dataset.logSeq, offset: range.toString().length };
      };
      const anchor = point(sel.anchorNode, sel.anchorOffset), focus = point(sel.focusNode, sel.focusOffset);
      return anchor && focus ? { anchor, focus } : null;
    }
    function restoreSelection(saved) {
      if (!saved) return;
      const point = ({ seq, offset }) => {
        const row = [...q('lm-log').children].find(el => el.dataset.logSeq === seq);
        if (!row) return null;
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let node, last;
        while ((node = walker.nextNode())) { last = node; if (offset <= node.length) return [node, offset]; offset -= node.length; }
        return last ? [last, last.length] : null;
      };
      const a = point(saved.anchor), b = point(saved.focus);
      if (a && b) window.getSelection().setBaseAndExtent(...a, ...b);
    }
    function anchor() {
      const el = q('lm-log'), top = el.getBoundingClientRect().top;
      const row = [...el.children].find(node => node.dataset.logSeq && node.getBoundingClientRect().bottom > top);
      return { seq: row && row.dataset.logSeq, delta: row ? top - row.getBoundingClientRect().top : 0, top: el.scrollTop, left: el.scrollLeft };
    }
    function restoreAnchor(saved) {
      if (!saved) return;
      const el = q('lm-log'), row = [...el.children].find(node => node.dataset.logSeq === saved.seq);
      if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top + saved.delta;
      else el.scrollTop = saved.seq ? 0 : saved.top;
      el.scrollLeft = saved.left;
    }
    function countMatches(view, keep = false) {
      const previous = keep ? activeMatch(view) : null;
      view.matches = []; view.total = 0;
      if (!view.query || !view.snapshot) { view.active = 0; return; }
      const needle = view.sensitive ? view.query : view.query.toLowerCase();
      // İ等小写会扩展UTF16长度；只有这种行才构建边界映射，普通行仍走indexOf线性扫描。
      for (const row of view.snapshot.records) {
        const offsets = [], lengths = [], text = view.sensitive ? row.text : row.text.toLowerCase();
        let boundaries = null;
        if (text.length !== row.text.length) {
          boundaries = new Map([[0, 0]]); let folded = 0, original = 0;
          for (const char of row.text) { folded += char.toLowerCase().length; original += char.length; boundaries.set(folded, original); }
        }
        let offset = 0, hit;
        while ((hit = text.indexOf(needle, offset)) >= 0) {
          if (!boundaries || (boundaries.has(hit) && boundaries.has(hit + needle.length))) {
            offsets.push(boundaries ? boundaries.get(hit) : hit);
            if (boundaries) lengths.push(boundaries.get(hit + needle.length) - boundaries.get(hit));
            offset = hit + needle.length;
          } else offset = hit + 1;
        }
        if (offsets.length) view.matches.push({ seq: row.seq, offsets, lengths });
        view.total += offsets.length;
      }
      view.active = view.total ? Math.min(view.active, view.total - 1) : 0;
      if (previous) {
        let nth = 0, found = false;
        for (const row of view.matches) {
          const offset = row.seq === previous.seq ? row.offsets.indexOf(previous.offset) : -1;
          if (offset >= 0) { view.active = nth + offset; found = true; break; }
          nth += row.offsets.length;
        }
        if (!found) { view.active = 0; view.findNotice = '原命中已不在当前缓冲区，已重新查找。'; }
      }
    }
    function activeMatch(view) {
      let nth = view.active;
      for (const row of view.matches) {
        if (nth < row.offsets.length) return { seq: row.seq, offset: row.offsets[nth], length: row.lengths[nth] || view.query.length };
        nth -= row.offsets.length;
      }
      return null;
    }
    function controls(view) {
      const usable = !!view;
      for (const id of ['lm-find', 'lm-copy', 'lm-clear']) q(id).disabled = !usable || view.clearing;
      q('lm-log-find').hidden = !view || !view.searchOpen;
      if (!composing && q('lm-log-query').value !== (view ? view.query : '')) q('lm-log-query').value = view ? view.query : '';
      q('lm-log-case').checked = !!(view && view.sensitive);
      q('lm-log-prev').disabled = q('lm-log-next').disabled = !view || !view.total;
      q('lm-log-count').textContent = view && view.query ? (view.total ? (view.active + 1) + ' / ' + view.total + ' 处' : '无匹配') : '当前运行缓冲区';
      const following = view && view.follow && !view.query && !selection();
      q('lm-latest').disabled = !view || !!view.query || view.clearing;
      q('lm-latest').textContent = following ? '暂停跟随' : view && view.unread ? '新增' + view.unread + '行 · 回到最新' : view && view.changed ? '有新增输出 · 回到最新' : '回到最新';
      q('lm-latest').setAttribute('aria-pressed', String(!!following));
      q('lm-latest').title = view && view.query ? '清除查找后可以恢复跟随' : '只改变阅读位置，不停止程序';
      q('lm-clear').textContent = view && view.clearing ? '清空中…' : '清空输出';
      q('lm-log-retry').hidden = !view || !view.readError;
      const messages = [];
      if (view && view.readError) messages.push('日志读取失败，仍显示上次输出：' + view.readError);
      if (view && view.actionError) messages.push(view.actionError);
      if (view && view.query && view.findNotice) messages.push(view.findNotice);
      if (view && view.snapshot && view.snapshot.truncated) messages.push('更早输出或超长行已不在缓冲区；复制仅包含当前显示的输出。');
      const text = messages.join(' ');
      if (q('lm-log-status').textContent !== text) q('lm-log-status').textContent = text;
      q('lm-log-notice').hidden = !text;
    }
    function paint(view, savedAnchor = anchor(), savedSelection = selection()) {
      if (current !== view || !visible()) return;
      const el = q('lm-log'), rows = view.snapshot ? view.snapshot.records : [], hit = activeMatch(view);
      const old = new Map([...el.children].map(row => [row.dataset.logSeq, row]));
      if (!rows.length) { el.textContent = '(暂无输出)'; controls(view); return; }
      if (!el.children.length) el.textContent = '';
      let cursor = el.firstChild;
      rows.forEach((record, index) => {
        const key = String(record.seq); let row = old.get(key);
        if (!row) { row = document.createElement('span'); row.dataset.logSeq = key; row.className = 'lm-log-line'; }
        const offset = hit && hit.seq === record.seq ? hit.offset : -1;
        const length = offset >= 0 ? hit.length : 0;
        const newline = index < rows.length - 1 ? '\n' : '';
        if (row.__text !== record.text || row.__hit !== offset || row.__length !== length || row.__query !== view.query || row.__newline !== newline) {
          row.replaceChildren();
          if (offset >= 0) {
            row.append(document.createTextNode(record.text.slice(0, offset)));
            const mark = document.createElement('mark'); mark.textContent = record.text.slice(offset, offset + length); row.append(mark);
            row.append(document.createTextNode(record.text.slice(offset + length) + newline));
          } else row.append(document.createTextNode(record.text + newline));
          Object.assign(row, { __text: record.text, __hit: offset, __length: length, __query: view.query, __newline: newline });
        }
        if (row === cursor) cursor = cursor.nextSibling; else el.insertBefore(row, cursor);
        old.delete(key);
      });
      old.forEach(row => row.remove());
      restoreSelection(savedSelection);
      if (view.follow && !view.query && !savedSelection) { el.scrollTop = el.scrollHeight; view.unread = 0; view.changed = false; }
      else restoreAnchor(savedAnchor);
      controls(view);
    }
    function attach(id) {
      if (current && current.id === id) return current;
      if (current) current.anchor = anchor();
      serial++; composing = false; current = id ? state(id) : null;
      q('lm-log').textContent = ''; controls(current);
      if (current) paint(current, current.anchor, null);
      return current;
    }
    function normalize(value) {
      if (!value || !Array.isArray(value.records) || !Array.isArray(value.lines) || !Number.isSafeInteger(value.version)
        || value.version < 0 || value.records.length > 800 || (value.generation !== null && typeof value.generation !== 'string')
        || (value.runId !== null && typeof value.runId !== 'string')) throw Error('日志快照格式不可用');
      let seq = 0;
      for (const row of value.records) {
        if (!row || !Number.isSafeInteger(row.seq) || row.seq <= seq || typeof row.text !== 'string') throw Error('日志位置数据不可用');
        seq = row.seq;
      }
      return { ...value, records: value.records.map(row => ({ ...row })), lines: value.records.map(row => row.text) };
    }
    async function read(id) {
      if (!visible() || current !== state(id) || current.clearing || current.busy) return;
      const view = current, request = ++serial;
      try {
        const value = normalize(await L().logs(id));
        if (serial !== request || current !== view || !visible()) return;
        const old = view.snapshot;
        if (old && old.runId === value.runId && old.generation === value.generation && old.version > value.version) return;
        const same = old && old.runId === value.runId && old.generation === value.generation;
        const savedAnchor = anchor(), savedSelection = selection();
        if (old && !nearBottom() && !view.query) view.follow = false;
        view.readError = '';
        if (same && value.version === old.version) { controls(view); return; }
        if (!same) {
          q('lm-log').textContent = ''; view.unread = 0; view.changed = false; view.active = 0; view.findNotice = '';
        } else if (!view.follow || view.query || savedSelection) {
          view.unread += Math.max(0, (value.records.at(-1)?.seq || 0) - (old.records.at(-1)?.seq || 0)); view.changed = true;
        }
        view.snapshot = value; countMatches(view, !!same);
        paint(view, same ? savedAnchor : null, same ? savedSelection : null);
      } catch (error) {
        if (serial !== request || current !== view || !visible()) return;
        view.readError = String(error && error.message || error); controls(view);
      }
    }
    function move(delta) {
      if (!current || !current.total || blocked()) return;
      current.active = (current.active + delta + current.total) % current.total;
      current.follow = false; paint(current);
      const mark = q('lm-log').querySelector('mark');
      if (mark) {
        const box = q('lm-log').getBoundingClientRect(), rect = mark.getBoundingClientRect();
        if (rect.top < box.top) q('lm-log').scrollTop += rect.top - box.top;
        else if (rect.bottom > box.bottom) q('lm-log').scrollTop += rect.bottom - box.bottom;
      }
    }
    function find(open) {
      if (!current || blocked()) return;
      current.searchOpen = open;
      if (!open) {
        if (current.query) current.follow = !!current.beforeQuery && !current.paused && nearBottom();
        current.query = ''; current.active = 0; countMatches(current); paint(current); q('lm-log').focus({ preventScroll: true });
      }
      else { controls(current); q('lm-log-query').focus({ preventScroll: true }); q('lm-log-query').select(); }
    }
    async function clear() {
      const view = current; if (!view || view.clearing || blocked()) return;
      q('launch-main').querySelector('.lm-log-more').open = false;
      serial++; view.clearing = true; view.actionError = ''; controls(view);
      try {
        const result = await L().clearLogs(view.id);
        if (!result || result.ok !== true || typeof result.generation !== 'string') throw Error(result && result.error || '未确认清空成功');
        view.snapshot = { records: [], lines: [], runId: result.runId, generation: result.generation, version: 0, truncated: false };
        view.unread = 0; view.changed = false; view.active = 0; view.readError = ''; view.findNotice = ''; countMatches(view);
        if (current === view && visible()) { q('lm-log').textContent = ''; paint(view, null, null); }
      } catch (error) { view.actionError = '清空失败，输出仍保留：' + String(error && error.message || error); }
      finally { view.clearing = false; if (current === view && visible()) { controls(view); read(view.id); } }
    }
    function install() {
      if (installed || !q('lm-log')) return; installed = true;
      const toolbar = document.createElement('div'); toolbar.className = 'lm-log-tools';
      const icon = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="3.5"/><path d="m9 9 4 4"/></svg>';
      toolbar.innerHTML = '<div class="lm-log-bar"><button id="lm-find" type="button">' + icon + '查找</button><button id="lm-latest" type="button" aria-pressed="true">暂停跟随</button><button id="lm-copy" type="button" title="复制当前显示的缓冲输出，截断时不是完整历史">复制全部</button><details class="lm-log-more"><summary>更多</summary><button id="lm-clear" type="button" title="只清空本终端的输出，不停止程序">清空输出</button></details></div>'
        + '<div id="lm-log-find" class="lm-log-find" hidden><input id="lm-log-query" type="search" aria-label="查找当前运行缓冲区" placeholder="查找当前运行缓冲区" autocomplete="off"><label><input id="lm-log-case" type="checkbox">区分大小写</label><button id="lm-log-prev" type="button" title="上一处（Shift+Enter）">上一处</button><button id="lm-log-next" type="button" title="下一处（Enter）">下一处</button><output id="lm-log-count" aria-live="off"></output><button id="lm-log-close" type="button" aria-label="关闭日志查找">关闭</button></div>'
        + '<div id="lm-log-notice" class="lm-log-notice" hidden><span id="lm-log-status" role="status" aria-live="polite"></span><button id="lm-log-retry" type="button" hidden>重试读取</button></div>';
      q('launch-main').insertBefore(toolbar, q('launch-main').querySelector('.launch-logview'));
      const el = q('lm-log'); el.tabIndex = 0; el.setAttribute('aria-label', '终端输出，可选择复制；Ctrl+F查找当前缓冲区');
      q('lm-find').onclick = () => find(true); q('lm-log-close').onclick = () => find(false);
      q('lm-log-prev').onclick = () => move(-1); q('lm-log-next').onclick = () => move(1);
      q('lm-log-retry').onclick = () => { if (current) read(current.id); };
      q('lm-clear').onclick = clear;
      q('lm-latest').onclick = () => {
        if (!current || current.query) return;
        if (current.follow && !selection()) { current.follow = false; current.paused = true; }
        else { current.follow = true; current.paused = false; window.getSelection().removeAllRanges(); el.scrollTop = el.scrollHeight; current.unread = 0; current.changed = false; }
        controls(current);
      };
      q('lm-copy').onclick = async () => {
        const view = current; if (!view || blocked()) return;
        try {
          if (await window.myIDE.clip.copy(view.snapshot ? view.snapshot.lines.join('\n') : '') !== true) throw Error('剪贴板未确认成功');
          if (current === view) { view.actionError = ''; toast(view.snapshot && view.snapshot.truncated ? '已复制当前缓冲输出（已截断）' : '已复制当前缓冲输出', 'ok'); controls(view); }
        } catch (error) { view.actionError = '复制失败：' + String(error && error.message || error); if (current === view) controls(view); }
      };
      const query = () => {
        if (!current || composing) return;
        if (!current.query && q('lm-log-query').value) current.beforeQuery = current.follow;
        current.query = q('lm-log-query').value; current.sensitive = q('lm-log-case').checked; current.active = 0;
        current.findNotice = '';
        if (current.query) current.follow = false;
        else current.follow = !!current.beforeQuery && nearBottom();
        countMatches(current); paint(current); if (current.total) move(0);
      };
      q('lm-log-query').oninput = query; q('lm-log-case').onchange = query;
      q('lm-log-query').addEventListener('compositionstart', () => { composing = true; });
      q('lm-log-query').addEventListener('compositionend', () => { composing = false; query(); });
      q('launch-main').addEventListener('keydown', ev => {
        if (blocked() || composing || ev.isComposing || ev.keyCode === 229) return;
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') { ev.preventDefault(); ev.stopPropagation(); find(true); }
        else if (ev.key === 'Escape' && current && current.searchOpen) { ev.preventDefault(); ev.stopPropagation(); find(false); }
        else if (ev.key === 'Enter' && ev.target === q('lm-log-query')) { ev.preventDefault(); ev.stopPropagation(); move(ev.shiftKey ? -1 : 1); }
      });
      el.addEventListener('scroll', () => {
        if (!current || current.query) return;
        current.follow = !current.paused && nearBottom() && !selection(); if (current.follow) { current.unread = 0; current.changed = false; }
        controls(current);
      });
      document.addEventListener('selectionchange', () => { if (current && selection()) { current.follow = false; current.paused = true; controls(current); } });
      new MutationObserver(() => { if (!visible()) { if (current) current.anchor = anchor(); serial++; current = null; } else renderMain(); })
        .observe(q('launch-main'), { attributes: true, attributeFilter: ['class'] });
      controls(null);
    }
    return { install, show: id => { attach(id); if (id) read(id); }, begin: id => { state(id).busy++; serial++; },
      end: id => { state(id).busy--; }, prune: ids => { for (const id of views.keys()) if (!ids.includes(id)) views.delete(id); } };
  })();

  // ---------- 侧栏 ----------
  function renderList() {
    const body = q('launch-body');
    if (!body) return;
    if (!cfg.entries.length) {
      body.innerHTML = '<div class="launch-empty">还没有终端条目。<br>点右下「⇩」导入 mh_launch_panel 的 '
        + 'panel-config.json，或点「＋」手动添加。</div>';
      return;
    }
    const m = new Map();
    for (const e of cfg.entries) {
      const k = e.category || '未分类';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    body.innerHTML = [...m.entries()].map(([cat, list]) => {
      const isCol = !!collapsed[cat];
      return '<div class="launch-group">'
        + '<div class="launch-cat' + (isCol ? ' col' : '') + '" data-cat="' + esc(cat) + '">'
        + '<span class="launch-caret">' + ICO_CARET + '</span>'
        + '<span class="launch-cat-nm">' + esc(cat) + '</span>'
        + '<span class="launch-cat-n">' + list.length + '</span></div>'
        + (isCol ? '' : '<div class="launch-cards">' + list.map(cardHtml).join('') + '</div>')
        + '</div>';
    }).join('');
    refreshDots();
  }

  // 图标一律内联 SVG（项目规矩：列表/工具条上不用 emoji 或文字字形，字号与基线不受控）。
  // 三角用 .ic 的 1.4px 描边，折叠态交给 CSS rotate(-90deg)，跟收藏侧栏/文件树一致。
  const ICO_CARET = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 6.4L8 10l3.6-3.6"/></svg>';
  const ICO_PLAY = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6L12.2 8z"/></svg>';
  const ICO_STOP = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.2"/></svg>';
  const ICO_OPEN = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M7 9l6-6M9 3h4v4M12 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>';

  function cardStatus(e) {
    const full = stateText(e), s = stOf(e.id);
    const text = { '未启动 / 已停止': '已停止', '端口有响应 · 进程归属未确认': '端口有响应 · 待核验', '进程归属未确认': '归属待核验' }[full] || full;
    const tone = failureText(e.id) || s.phase === 'exited' && (s.exitSignal || s.exitCode !== 0) ? 'error'
      : operations.has(e.id) || s.operation ? 'pending'
      : statusError || !status[e.id] || s.ownership === 'unknown' || s.ownership === 'foreign' || s.portResponding && !ownedRunning(s) ? 'unknown'
      : ownedRunning(s) ? 'running' : 'stopped';
    return { text, full, tone };
  }

  function cardHtml(e) {
    const s = stOf(e.id);
    const sel = e.id === selectedId ? ' sel' : '';
    const run = ownedRunning(s) ? ' run' : '';
    const dot = ownedRunning(s) ? 'launch-dot on' : 'launch-dot';
    const url = resolvedOpenUrl(e), caps = capabilities(e), busy = operations.has(e.id) || configBusy;
    const summary = cardStatus(e);
    return '<div class="launch-card' + run + sel + '" data-id="' + esc(e.id) + '" title="点击在右侧查看详情与日志">'
      + '<div class="launch-card-head">'
      + '<span class="' + dot + '"></span>'
      + '<span class="launch-nm" title="' + esc(e.name) + '">' + esc(e.name) + '</span>'
      + '<span class="launch-acts">'
      + '<button class="vt-btn lp-btn act-idle' + (s.alive ? ' hide' : '') + '" data-act="start" title="启动"' + (busy || !caps.start ? ' disabled' : '') + '>' + ICO_PLAY + '</button>'
      + '<button class="vt-btn lp-btn act-run' + (s.alive ? '' : ' hide') + '" data-act="stop" title="停止（须确认归属）"' + (busy || !caps.stop ? ' disabled' : '') + '>' + ICO_STOP + '</button>'
      + (url ? '<button class="vt-btn lp-btn act-open" data-act="open" title="打开页面 ' + esc(url) + '">' + ICO_OPEN + '</button>' : '')
      + '</span></div><div class="launch-card-meta"><span class="launch-state" data-tone="' + summary.tone + '" title="' + esc(summary.full) + '">' + esc(summary.text) + '</span>'
      + (e.port ? '<span class="launch-port" title="端口 ' + Number(e.port) + '">:' + Number(e.port) + '</span>' : '')
      + '</div><div class="launch-entry-error"' + (failureText(e.id) ? '' : ' hidden') + '>' + esc(failureText(e.id)) + '</div></div>';
  }

  // 轮询只更新状态点与主区（不全量重建，保住选中与滚动位置）
  function refreshDots() {
    const body = q('launch-body');
    if (!body) return;
    for (const el of body.querySelectorAll('.launch-card')) {
      const id = el.getAttribute('data-id');
      const s = stOf(id);
      const dot = el.querySelector('.launch-dot');
      if (dot) { dot.className = !statusError && ownedRunning(s) ? 'launch-dot on' : 'launch-dot'; dot.title = stateText(byId(id)); }
      el.classList.toggle('run', ownedRunning(s));
      const bStart = el.querySelector('.act-idle'), bStop = el.querySelector('.act-run');
      const e = byId(id), caps = capabilities(e), busy = operations.has(id) || !!s.operation || configBusy;
      if (bStart) { bStart.classList.toggle('hide', !!s.alive && !caps.start); bStart.disabled = busy || !caps.start; }
      if (bStop) { bStop.classList.toggle('hide', !s.alive && !caps.stop); bStop.disabled = busy || !caps.stop; }
      const summary = cardStatus(e), state = el.querySelector('.launch-state');
      state.textContent = summary.text; state.title = summary.full; state.dataset.tone = summary.tone;
      const error = el.querySelector('.launch-entry-error'); error.textContent = failureText(id); error.hidden = !error.textContent;
    }
    refreshOperationUI();
  }

  // ---------- 主区（详情 + 日志） ----------
  function renderMain() {
    const main = q('launch-main');
    if (!main || main.classList.contains('hidden')) return;
    const e = selectedId ? byId(selectedId) : null;
    const name = q('lm-name'), port = q('lm-port'), dot = q('lm-dot'), meta = q('lm-meta');
    if (!e) {
      name.textContent = '—';
      port.textContent = '';
      dot.className = 'launch-dot';
      meta.innerHTML = '<span class="launch-empty">从左侧选择一个终端，这里显示它的状态与日志。</span>';
      delete meta.dataset.values;
      q('lm-log').textContent = '';
      logReader.show(null);
      for (const id of ['lm-start', 'lm-stop', 'lm-restart', 'lm-open', 'lm-edit', 'lm-del']) q(id).disabled = true;
      refreshOperationUI();
      return;
    }
    for (const id of ['lm-start', 'lm-stop', 'lm-restart', 'lm-open', 'lm-edit', 'lm-del']) q(id).disabled = false;
    const s = stOf(e.id);
    name.textContent = e.name;
    port.textContent = e.port ? ':' + e.port : '';
    dot.className = !statusError && ownedRunning(s) ? 'launch-dot on' : 'launch-dot';
    name.title = e.name;
    dot.title = stateText(e);
    q('lm-open').style.display = '';
    q('lm-open').title = resolvedOpenUrl(e) || '未配置打开页面的地址或端口';
    // 展开全文可以原生选择复制；轮询不重建details，保住用户展开状态与选区。
    const values = [e.command, e.cwd || '—', e.apiOrigin || (cfg.apiOrigins[0] || '—')];
    if (meta.dataset.values !== JSON.stringify(values)) {
      meta.dataset.values = JSON.stringify(values);
      meta.innerHTML = values.map((value, i) => '<details><summary>' + ['命令', '目录', '后端'][i] + '</summary><div>' + esc(value) + '</div></details>').join('');
    }
    refreshOperationUI();
    logReader.show(e.id);
  }

  // ---------- 动作 ----------
  async function act(e, kind) {
    if (!L() || operations.has(e.id) || blockedConfig()) return;
    const caps = capabilities(e);
    if (!(kind === 'start' ? caps.start : caps.stop)) {
      outcomes.set(e.id, { ok: false, kind, error: '当前状态或进程归属未确认，请先重试读取状态' }); refreshDots(); return;
    }
    const ticket = { kind }; operations.set(e.id, ticket); statusSerial++; refreshDots();
    return execute(e, kind, ticket);
  }

  async function execute(e, kind, ticket) {
    logReader.begin(e.id);
    let outcome;
    try {
      const result = await L()[kind](e);
      if (!confirmed(result, kind)) throw Error(result && result.error || '服务未明确确认' + labels[kind] + '成功' + (result && result.remainingOwned && result.remainingOwned.length ? '，仍有归属进程存活' : ''));
      outcome = { ok: true, kind, message: result.kind === 'usb-tunnel' ? '桥接' + labels[kind] + '脚本已成功返回：' + e.name + '（daemon状态未验证）'
        : kind === 'stop' ? '已确认停止：' + e.name : labels[kind] + '请求已接受：' + e.name + '（运行与就绪以状态为准）' };
      toast(outcome.message, 'ok');
    } catch (error) { outcome = { ok: false, kind, error: reason(error) }; toast(labels[kind] + '失败：' + outcome.error, 'err'); }
    finally {
      logReader.end(e.id);
      if (operations.get(e.id) === ticket) { operations.delete(e.id); outcomes.set(e.id, outcome); statusSerial++; refreshDots(); }
    }
    await pollOnce(); return outcome;
  }

  async function runBatch(kind, retryItems) {
    if (batch || blockedConfig() || operations.size || !L()) return;
    const targets = retryItems ? retryItems.map(item => ({ ...item, ok: false, executed: false }))
      : cfg.entries.map(e => ({ id: e.id, name: e.name, fingerprint: fingerprint(e), ok: false, executed: false }));
    const group = { kind, items: targets, done: 0 }; batch = group; batchReport = null;
    const tickets = new Map();
    for (const item of targets) { const ticket = { kind, queued: true }; tickets.set(item.id, ticket); operations.set(item.id, ticket); }
    statusSerial++; refreshDots();
    try {
      for (const item of targets) {
        const e = byId(item.id), ticket = tickets.get(item.id), caps = e && capabilities(e);
        if (!e || fingerprint(e) !== item.fingerprint) item.error = '配置已变化，请核查后单独操作';
        else if (!(kind === 'start' ? caps.start : caps.stop)) item.error = statusError ? '状态读取失败' : '当前状态无需此操作或归属未确认';
        else {
          ticket.queued = false; refreshDots(); item.executed = true;
          const result = await execute(e, kind, ticket); item.ok = result.ok; item.error = result.error || '';
        }
        if (operations.get(item.id) === ticket) operations.delete(item.id);
        group.done++; refreshDots();
      }
    } finally {
      for (const [id, ticket] of tickets) if (operations.get(id) === ticket) operations.delete(id);
      if (batch === group) { batchReport = group; batch = null; }
      refreshDots(); await pollOnce();
    }
  }

  function toast(msg, type) {
    try { if (window.MI && MI.toast) { MI.toast(msg, type || 'info'); return; } } catch {}
  }

  function pollOnce() {
    // 慢查询跨过轮询间隔时共享请求，避免进程查询堆积和有效结果永久被下一轮作废。
    if (statusPoll) {
      const pending = statusPoll;
      return pending.promise.then(() => {
        if (pending.serial !== statusSerial || pending.version !== revision) return pollOnce();
      });
    }
    const request = { serial: ++statusSerial, version: revision };
    statusPoll = request;
    request.promise = readStatus(request).finally(() => { if (statusPoll === request) statusPoll = null; });
    return request.promise;
  }

  async function readStatus({ serial, version }) {
    const api = L();
    if (!api) return;
    const entries = cfg.entries.slice();
    try {
      const st = entries.length ? await api.status(entries) : [];
      if (serial !== statusSerial || version !== revision) return;
      if (!Array.isArray(st) || st.length !== entries.length || st.some(s => !s || typeof s.alive !== 'boolean' || !entries.some(e => e.id === s.id)) || new Set(st.map(s => s.id)).size !== st.length) throw Error('状态返回格式不完整');
      status = Object.fromEntries(st.map(s => [s.id, s])); statusError = ''; checkedAt = Date.now();
    } catch (error) { if (serial !== statusSerial || version !== revision) return; statusError = reason(error); }
    refreshDots(); renderMain();
    const cnt = q('launch-count');
    if (cnt) { cnt.textContent = statusError ? '状态不可用' : cfg.entries.filter(e => stOf(e.id).processAlive || stOf(e.id).alive && stOf(e.id).by !== 'port' && stOf(e.id).by !== 'state').length + '/' + cfg.entries.length; cnt.title = '确认运行的进程 / 配置总数（端口响应与桥接登记不计入）'; }
  }

  async function load() {
    const api = L();
    if (!api || configBusy) return;
    const serial = ++configSerial;
    configLoading = true; refreshDots();
    try {
      const value = await api.config(); if (serial !== configSerial) return;
      if (!value || !Array.isArray(value.entries) || !Array.isArray(value.apiOrigins)) throw Error('配置返回格式不完整');
      cfg = value; revision++; configError = '';
      syncKeep(cfg.keepOnExit === true);
      logReader.prune(cfg.entries.map(entry => entry.id));
      if (selectedId && !byId(selectedId)) selectedId = null;
    } catch (error) { if (serial !== configSerial) return; configError = reason(error); }
    finally { if (serial === configSerial) configLoading = false; }
    if (serial !== configSerial) return;
    renderList(); await pollOnce(); if (!cfg.entries.length) renderMain();
  }

  // ---------- 对话框 ----------
  function openDialog(entry) {
    if (blockedConfig() || entry && (operations.has(entry.id) || stOf(entry.id).operation)) return;
    const dlg = q('launch-dialog');
    if (!dlg) return;
    const f = q('launch-form');
    const set = (n, v) => { const el = f.elements[n]; if (el) el.value = v == null ? '' : v; };
    set('id', entry && entry.id);
    set('name', entry && entry.name);
    set('category', entry && entry.category);
    set('cwd', entry && entry.cwd);
    set('command', entry && entry.command);
    set('port', entry && entry.port);
    set('apiOrigin', entry && entry.apiOrigin);

    // 后端地址历史下拉（▼ 选历史 / ✕ 移除）
    {
      const of = dlg.querySelector('.origin-field');
      const drop = of.querySelector('.origin-dropdown');
      const inp = of.querySelector('input[name="apiOrigin"]');
      const render = () => {
        drop.innerHTML = '';
        const list = (cfg.apiOrigins || []);
        if (!list.length) { drop.innerHTML = '<div class="origin-empty">暂无历史后端地址</div>'; return; }
        for (const o of list) {
          const it = document.createElement('div');
          it.className = 'origin-item';
          const t = document.createElement('span'); t.className = 'origin-text'; t.textContent = o;
          const x = document.createElement('button'); x.type = 'button'; x.className = 'origin-x'; x.title = '从列表移除'; x.textContent = '✕';
          it.append(t, x);
          it.addEventListener('click', async (ev) => {
            if (ev.target.closest('.origin-x')) {
              await L().removeOrigin(o);
              cfg = await L().config();
              render();
              return;
            }
            inp.value = o;
            drop.hidden = true;
          });
          drop.appendChild(it);
        }
      };
      of.querySelector('.origin-toggle').addEventListener('click', (ev) => {
        ev.stopPropagation();
        const willOpen = drop.hidden;
        if (willOpen) render();
        drop.hidden = !willOpen;
      });
      inp.addEventListener('focus', () => { drop.hidden = true; });
      // 点下拉/对话框以外区域收起（浮层不占流，点了别处还挂着很难看）；只挂一次
      if (!dlg.__originOutside) {
        dlg.__originOutside = true;
        dlg.addEventListener('click', (ev) => {
          const d = dlg.querySelector('.origin-dropdown');
          if (d && !d.hidden && !ev.target.closest('.origin-field')) d.hidden = true;
        });
      }
      // 点下拉/对话框以外区域收起（浮层不占流，点了别处还挂着很难看）；只挂一次
      if (!dlg.__originOutside) {
        dlg.__originOutside = true;
        dlg.addEventListener('click', (ev) => {
          const d = dlg.querySelector('.origin-dropdown');
          if (d && !d.hidden && !ev.target.closest('.origin-field')) d.hidden = true;
        });
      }
    }

    set('openUrl', entry && entry.openUrl);
    set('kind', (entry && entry.kind) || '');
    set('python', (entry && entry.python) || 'python');
    set('script', (entry && entry.script) || '');
    set('readyMode', entry && entry.readiness && entry.readiness.mode || 'none');
    set('readyText', entry && entry.readiness && entry.readiness.text || '');
    set('readyTimeout', entry && entry.readiness && entry.readiness.timeoutSeconds || 30);
    readinessFields(); f.elements.kind.onchange = readinessFields;
    q('launch-dialog-title').textContent = entry ? '编辑终端' : '添加终端';
    dlg.__editing = entry ? entry.id : null;
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  async function submitDialog() {
    if (blockedConfig() || operations.size) return;
    const dlg = q('launch-dialog');
    const f = q('launch-form');
    const v = (n) => { const el = f.elements[n]; return el ? String(el.value || '').trim() : ''; };
    const item = {
      name: v('name'), category: v('category') || '未分类', cwd: v('cwd'),
      command: v('command'), port: Number(v('port')) || 0,
      apiOrigin: v('apiOrigin'), openUrl: v('openUrl'),
      /* 保存后写入历史（addOrigin 去重，服务端处理） */
      kind: v('kind'), script: v('script'), python: v('python') || 'python',
      readiness: { mode: v('readyMode') || 'none' },
    };
    if (!item.name || !item.command) { toast('名称与启动命令必填', 'err'); return; }
    if (item.readiness.mode !== 'none') {
      item.readiness.timeoutSeconds = Number(v('readyTimeout'));
      if (item.kind === 'usb-tunnel') { toast('USB daemon身份尚未核验，暂不支持就绪验证', 'err'); return; }
      if (!Number.isInteger(item.readiness.timeoutSeconds) || item.readiness.timeoutSeconds < 1 || item.readiness.timeoutSeconds > 3600) { toast('就绪等待时间须为1至3600秒的整数', 'err'); return; }
      if (item.readiness.mode === 'port' && (!Number.isInteger(item.port) || item.port < 1 || item.port > 65535)) { toast('端口就绪需要1至65535的终端端口', 'err'); return; }
      if (item.readiness.mode === 'output') {
        item.readiness.text = String(f.elements.readyText.value);
        if (!item.readiness.text.trim() || item.readiness.text.length > 256 || /[\r\n]/.test(item.readiness.text)) { toast('就绪输出须为非空单行文本，最多256字符', 'err'); return; }
      }
    }
    configBusy = true; configSerial++; refreshDots();
    try {
      const editing = dlg.__editing;
      const list = cfg.entries.slice();
      if (editing) {
        const i = list.findIndex((x) => x.id === editing);
        if (i >= 0) list[i] = Object.assign({}, list[i], item);
      } else {
        item.id = 'e' + Date.now().toString(36);
        list.push(item);
      }
      if (item.apiOrigin) await L().addOrigin(item.apiOrigin);
      const saved = await L().save({ apiOrigins: cfg.apiOrigins, entries: list, keepOnExit: cfg.keepOnExit });
      if (!saved || !Array.isArray(saved.entries) || !Array.isArray(saved.apiOrigins)) throw Error('服务未确认配置保存');
      cfg = saved; revision++;
      if (item.apiOrigin) cfg = await L().config();
      dlg.__editing = null;
      if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
      renderList();
      await pollOnce();
    } catch (err) {
      // 兜底：任何一步失败都提示，而不是弹窗无声卡死（历史上 L().load 笔误就是这样卡住的）
      toast('保存失败：' + (err && err.message ? err.message : err), 'err');
    } finally { configBusy = false; configSerial++; refreshDots(); }
  }

  async function removeEntry(id) {
    const e = byId(id);
    if (!e || blockedConfig() || operations.has(id)) return;
    if (!window.confirm('删除终端「' + e.name + '」？（如果它正在运行，会先停止）')) return;
    const ticket = { kind: 'delete' }; operations.set(id, ticket); configBusy = true; configSerial++; statusSerial++; refreshDots(); logReader.begin(id);
    try {
      const stopped = await L().stop(e);
      if (!confirmed(stopped, 'stop') || stopped.ok !== true) throw Error(stopped && stopped.error || '停止未确认，终端配置与日志已保留');
      if (e.kind === 'usb-tunnel' || stopped.kind === 'usb-tunnel') throw Error('桥接脚本成功不证明daemon已停止，配置与日志已保留；需先补齐daemon停止核验');
      const entries = cfg.entries.filter(x => x.id !== id);
      const saved = await L().save({ apiOrigins: cfg.apiOrigins, entries, keepOnExit: cfg.keepOnExit });
      if (!saved || !Array.isArray(saved.entries) || !Array.isArray(saved.apiOrigins) || saved.entries.some(x => x.id === id) || saved.entries.length !== entries.length || entries.some(x => !saved.entries.some(y => y.id === x.id))) throw Error('服务未确认删除配置，保留原列表');
      cfg = saved; revision++; outcomes.delete(id);
      if (selectedId === id) selectedId = null;
      toast('已删除终端：' + e.name, 'ok');
    } catch (error) { outcomes.set(id, { ok: false, kind: 'delete', error: reason(error) }); toast('删除失败：' + reason(error), 'err'); }
    finally {
      logReader.end(id); logReader.prune(cfg.entries.map(x => x.id)); if (operations.get(id) === ticket) operations.delete(id);
      configBusy = false; configSerial++; statusSerial++; renderList(); renderMain(); await pollOnce();
    }
  }

  // ---------- 事件 ----------
  function bind() {
    const body = q('launch-body');
    if (body) {
      body.addEventListener('click', (ev) => {
        const cat = ev.target.closest('.launch-cat');
        if (cat) {
          const k = cat.getAttribute('data-cat');
          collapsed[k] = !collapsed[k];
          renderList();
          return;
        }
        const btn = ev.target.closest('.lp-btn');
        const card = ev.target.closest('.launch-card');
        if (card) {
          const id = card.getAttribute('data-id');
          if (selectedId !== id) { selectedId = id; renderList(); renderMain(); }
        }
        if (btn && card) {
          const id = card.getAttribute('data-id');
          const e = byId(id);
          const kind = btn.getAttribute('data-act');
          if (e && (kind === 'start' || kind === 'stop')) act(e, kind);
          if (e && kind === 'open') {
            const url = e.openUrl || (e.port ? 'http://127.0.0.1:' + e.port : '');
            if (url) L().openUrl(url);
          }
        }
      });
    }
    const add = q('launch-add');
    if (add) add.addEventListener('click', () => openDialog(null));
    const sa = q('launch-start-all');
    if (sa) sa.addEventListener('click', () => runBatch('start'));
    const so = q('launch-stop-all');
    if (so) so.addEventListener('click', () => runBatch('stop'));

    // 主区动作
    const on = (id, fn) => { const el = q(id); if (el) el.addEventListener('click', fn); };
    on('lm-start', () => { const e = byId(selectedId); if (e) act(e, 'start'); });
    on('lm-stop', () => { const e = byId(selectedId); if (e) act(e, 'stop'); });
    on('lm-restart', () => { const e = byId(selectedId); if (e) act(e, 'restart'); });
    on('lm-open', () => { const e = byId(selectedId); if (e && resolvedOpenUrl(e)) L().openUrl(resolvedOpenUrl(e)); });
    on('lm-edit', () => { const e = byId(selectedId); if (e) openDialog(e); });
    on('lm-del', () => { if (selectedId) removeEntry(selectedId); });

    const ok = q('launch-dialog-ok');
    if (ok) ok.addEventListener('click', (ev) => { ev.preventDefault(); submitDialog(); });
    const cancel = q('launch-dialog-cancel');
    if (cancel) cancel.addEventListener('click', () => {
      const dlg = q('launch-dialog');
      if (dlg && typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
    });

    // 保存开关必须同时更新cfg，否则下一次编辑/删除会把缓存中的旧退出策略写回磁盘。
    const keeps = [...document.querySelectorAll('.lp-keep')];
    if (keeps.length) {
      keeps.forEach((k) => k.addEventListener('change', async () => {
        if (blockedConfig()) { syncKeep(cfg.keepOnExit === true); return; }
        const value = k.checked;
        configBusy = true; configSerial++; refreshDots();
        try {
          const saved = await L().setKeep(value);
          if (typeof saved !== 'boolean' || saved !== value) throw Error('服务未确认后台保留设置');
          cfg.keepOnExit = saved; syncKeep(saved);
          toast(saved ? '退出时保留后台进程' : '退出时停止全部终端', 'ok');
        } catch (error) { syncKeep(cfg.keepOnExit === true); toast('后台保留保存失败：' + reason(error), 'err'); }
        finally { configBusy = false; configSerial++; refreshDots(); }
      }));
    }
  }
  function syncKeep(v) { document.querySelectorAll('.lp-keep').forEach((k) => { k.checked = v; }); }

  function init() {
    if (inited) return;
    if (!q('launch-body')) return;
    inited = true;
    installOperationUI();
    logReader.install();
    bind();
    load();
    if (timer) clearInterval(timer);
    timer = setInterval(pollOnce, 1500);
  }

  return { init, refresh: load, isOpen: () => !!(q('panel-launch') && !q('panel-launch').classList.contains('hidden')) };
})();
window.LaunchPanel = LaunchPanel;

// launch-panel.js —— 启动面板（侧栏条目列表 + 主区详情/日志，双区联动，照 db 面板的模式）
// 配置：~/.myide/launch.json（机器级，用户拍板）；运行状态：~/.myide/launch-state.json
// 后台保留靠服务落盘的OS身份恢复；端口响应只说明可连接，不授予停止权限。
const LaunchPanel = (() => {
  const L = () => (window.myIDE && window.myIDE.launch) || null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const q = (id) => document.getElementById(id);

  let cfg = { apiOrigins: [], entries: [] };
  let status = {};           // id -> { alive, by, pid }
  let selectedId = null;     // 主区当前展示的条目
  let collapsed = {};        // 分类折叠
  let timer = null;
  let inited = false;

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
  const ICO_PLAY = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M3.2 1.6v8.8L10.4 6z" fill="currentColor"/></svg>';
  const ICO_STOP = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.6" fill="currentColor"/></svg>';
  const ICO_OPEN = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M5 7 10.2 1.8M6.2 1.8h4v4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.8 7.2v2.6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h2.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  function cardHtml(e) {
    const s = stOf(e.id);
    const sel = e.id === selectedId ? ' sel' : '';
    const run = s.alive ? ' run' : '';
    const dot = s.alive ? 'launch-dot on' : 'launch-dot';
    const url = e.openUrl || (e.port ? 'http://127.0.0.1:' + e.port : '');
    return '<div class="launch-card' + run + sel + '" data-id="' + esc(e.id) + '" title="点击在右侧查看详情与日志">'
      + '<div class="launch-card-head">'
      + '<span class="' + dot + '"></span>'
      + '<span class="launch-nm">' + esc(e.name) + '</span>'
      + (e.port ? '<span class="launch-port">:' + e.port + '</span>' : '')
      + '<span class="launch-acts">'
      + '<button class="vt-btn lp-btn act-idle' + (s.alive ? ' hide' : '') + '" data-act="start" title="启动">' + ICO_PLAY + '</button>'
      + '<button class="vt-btn lp-btn act-run' + (s.alive ? '' : ' hide') + '" data-act="stop" title="停止">' + ICO_STOP + '</button>'
      + (url ? '<button class="vt-btn lp-btn act-open" data-act="open" title="打开页面 ' + esc(url) + '">' + ICO_OPEN + '</button>' : '')
      + '</span></div></div>';
  }

  // 轮询只更新状态点与主区（不全量重建，保住选中与滚动位置）
  function refreshDots() {
    const body = q('launch-body');
    if (!body) return;
    for (const el of body.querySelectorAll('.launch-card')) {
      const id = el.getAttribute('data-id');
      const s = stOf(id);
      const dot = el.querySelector('.launch-dot');
      if (dot) dot.className = s.alive ? 'launch-dot on' : 'launch-dot';
      el.classList.toggle('run', !!s.alive);
      const bStart = el.querySelector('.act-idle'), bStop = el.querySelector('.act-run');
      if (bStart) bStart.classList.toggle('hide', !!s.alive);
      if (bStop) bStop.classList.toggle('hide', !s.alive);
    }
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
      q('lm-log').textContent = '';
      logReader.show(null);
      for (const id of ['lm-start', 'lm-stop', 'lm-restart', 'lm-open', 'lm-edit', 'lm-del']) q(id).disabled = true;
      return;
    }
    for (const id of ['lm-start', 'lm-stop', 'lm-restart', 'lm-open', 'lm-edit', 'lm-del']) q(id).disabled = false;
    const s = stOf(e.id);
    name.textContent = e.name;
    port.textContent = e.port ? ':' + e.port : '';
    dot.className = s.alive ? 'launch-dot on' : 'launch-dot';
    dot.title = s.alive ? '运行中' : '已停止';
    q('lm-open').style.display = e.openUrl ? '' : 'none';
    meta.innerHTML = '<span class="lm-k">命令</span>' + esc(e.command)
      + '<span class="lm-k">目录</span>' + esc(e.cwd || '—')
      + '<span class="lm-k">后端</span>' + esc(e.apiOrigin || (cfg.apiOrigins[0] || '—'));
    logReader.show(e.id);
  }

  // ---------- 动作 ----------
  async function act(e, kind) {
    const api = L();
    if (!api) return;
    logReader.begin(e.id);
    try {
    if (kind === 'start') {
      const r = await api.start(e);
      if (r && r.error) toast('启动失败：' + r.error, 'err'); else toast('已启动：' + e.name, 'ok');
    } else if (kind === 'stop') {
      const r = await api.stop(e);
      if (r && r.error) toast('停止失败：' + r.error, 'err'); else toast('已停止：' + e.name, 'ok');
    } else if (kind === 'restart') {
      const r = await api.restart(e);
      if (r && r.error) toast('重启失败：' + r.error, 'err'); else toast('已重启：' + e.name, 'ok');
    }
    } finally { logReader.end(e.id); }
    await pollOnce();
  }

  function toast(msg, type) {
    try { if (window.MI && MI.toast) { MI.toast(msg, type || 'info'); return; } } catch {}
  }

  async function pollOnce() {
    const api = L();
    if (!api || !cfg.entries.length) return;
    const st = await api.status(cfg.entries);
    const m = {};
    for (const s of (st || [])) m[s.id] = s;
    status = m;
    refreshDots();
    renderMain();
    const run = cfg.entries.filter((e) => stOf(e.id).alive).length;
    const cnt = q('launch-count');
    if (cnt) cnt.textContent = run + '/' + cfg.entries.length;
  }

  async function load() {
    const api = L();
    if (!api) return;
    cfg = await api.config();
    logReader.prune(cfg.entries.map(entry => entry.id));
    if (selectedId && !byId(selectedId)) selectedId = null;
    await pollOnce();
    renderList();
    if (!cfg.entries.length) renderMain();
  }

  // ---------- 对话框 ----------
  function openDialog(entry) {
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
    q('launch-dialog-title').textContent = entry ? '编辑终端' : '添加终端';
    dlg.__editing = entry ? entry.id : null;
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  async function submitDialog() {
    const dlg = q('launch-dialog');
    const f = q('launch-form');
    const v = (n) => { const el = f.elements[n]; return el ? String(el.value || '').trim() : ''; };
    const item = {
      name: v('name'), category: v('category') || '未分类', cwd: v('cwd'),
      command: v('command'), port: Number(v('port')) || 0,
      apiOrigin: v('apiOrigin'), openUrl: v('openUrl'),
      /* 保存后写入历史（addOrigin 去重，服务端处理） */
      kind: v('kind'), script: v('script'), python: v('python') || 'python',
    };
    if (!item.name || !item.command) { toast('名称与启动命令必填', 'err'); return; }
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
      cfg = await L().save({ apiOrigins: cfg.apiOrigins, entries: list, keepOnExit: cfg.keepOnExit });
      if (item.apiOrigin) cfg = await L().config();
      dlg.__editing = null;
      if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
      renderList();
      await pollOnce();
    } catch (err) {
      // 兜底：任何一步失败都提示，而不是弹窗无声卡死（历史上 L().load 笔误就是这样卡住的）
      toast('保存失败：' + (err && err.message ? err.message : err), 'err');
    }
  }

  async function removeEntry(id) {
    const e = byId(id);
    if (!e) return;
    if (!window.confirm('删除终端「' + e.name + '」？（如果它正在运行，会先停止）')) return;
    await L().stop(e);
    cfg = await L().save({ apiOrigins: cfg.apiOrigins, entries: cfg.entries.filter((x) => x.id !== id), keepOnExit: cfg.keepOnExit });
    if (selectedId === id) selectedId = null;
    renderList();
    renderMain();
    await pollOnce();
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
    if (sa) sa.addEventListener('click', async () => { for (const e of cfg.entries) if (!stOf(e.id).alive) await act(e, 'start'); });
    const so = q('launch-stop-all');
    if (so) so.addEventListener('click', async () => { for (const e of cfg.entries) if (stOf(e.id).alive) await act(e, 'stop'); });

    // 主区动作
    const on = (id, fn) => { const el = q(id); if (el) el.addEventListener('click', fn); };
    on('lm-start', () => { const e = byId(selectedId); if (e) act(e, 'start'); });
    on('lm-stop', () => { const e = byId(selectedId); if (e) act(e, 'stop'); });
    on('lm-restart', () => { const e = byId(selectedId); if (e) act(e, 'restart'); });
    on('lm-open', () => { const e = byId(selectedId); if (e && e.openUrl) L().openUrl(e.openUrl); });
    on('lm-edit', () => { const e = byId(selectedId); if (e) openDialog(e); });
    on('lm-del', () => { if (selectedId) removeEntry(selectedId); });

    const ok = q('launch-dialog-ok');
    if (ok) ok.addEventListener('click', (ev) => { ev.preventDefault(); submitDialog(); });
    const cancel = q('launch-dialog-cancel');
    if (cancel) cancel.addEventListener('click', () => {
      const dlg = q('launch-dialog');
      if (dlg && typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
    });

    // 后台保留开关：侧栏底栏和主区底栏各有一个（原来两个都是 id="launch-keep"，
    // getElementById 只拿到第一个 → 主区那个点了没反应也不回显）。现在按类全绑、互相同步。
    const keeps = [...document.querySelectorAll('.lp-keep')];
    if (keeps.length) {
      keeps.forEach((k) => k.addEventListener('change', async () => {
        await L().setKeep(k.checked);
        syncKeep(k.checked);
        toast(k.checked ? '退出时保留后台进程' : '退出时停止全部终端', 'ok');
      }));
      L().getKeep().then((v) => syncKeep(v === true)).catch(() => {});
    }
  }
  function syncKeep(v) { document.querySelectorAll('.lp-keep').forEach((k) => { k.checked = v; }); }

  function init() {
    if (inited) return;
    if (!q('launch-body')) return;
    inited = true;
    logReader.install();
    bind();
    load();
    if (timer) clearInterval(timer);
    timer = setInterval(pollOnce, 1500);
  }

  return { init, refresh: load, isOpen: () => !!(q('panel-launch') && !q('panel-launch').classList.contains('hidden')) };
})();
window.LaunchPanel = LaunchPanel;

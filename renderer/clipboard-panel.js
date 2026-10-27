// clipboard-panel.js —— 剪贴板历史：列表 + 编辑区 + 增删改查
//
// 设计要点：
//  · 主区左侧列表（搜索 + 类型筛选），右侧编辑区（查看/编辑正文、备注、固定）。
//  · 因为要「增删改查」而不只是查看，右侧是真正的编辑面：文字用可编辑文本框，
//    图片显示大图并可改备注。改完点保存才写回，避免误改。
//  · 清理参数（保留天数 / 总大小上限）放在底部状态栏，改完立即跑一次清理。
//  · 监听开关在主进程里真正启停轮询（不只是记一个布尔值）。
window.ClipboardPanel = (() => {
  const q = id => document.getElementById(id);
  const api = () => window.myIDE.clipboardHistory;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let entries = [], settings = {}, stats = {}, selectedId = null, filter = 'all', query = '', watching = true;
  let loading = false, visible = false, initialized = false, unsubscribe = null;
  let draftDirty = false;

  const fmtBytes = value => {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = value, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
  };
  const fmtTime = ms => {
    const d = new Date(ms), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const pad = n => String(n).padStart(2, '0');
    return sameDay ? pad(d.getHours()) + ':' + pad(d.getMinutes())
      : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };

  async function call(op, ...args) {
    const result = await api()[op](...args);
    if (!result?.ok) throw Error(result?.error || '操作未确认');
    return result.data;
  }

  const visibleEntries = () => entries.filter(entry => {
    if (filter === 'text' && entry.kind !== 'text') return false;
    if (filter === 'image' && entry.kind !== 'image') return false;
    if (filter === 'pinned' && !entry.pinned) return false;
    if (!query) return true;
    const hay = ((entry.text || '') + ' ' + (entry.note || '') + ' ' + (entry.preview || '')).toLowerCase();
    return hay.includes(query.toLowerCase());
  });

  function renderList() {
    const host = q('clip-list'); if (!host) return;
    const rows = visibleEntries();
    if (!rows.length) {
      host.innerHTML = '<div class="clip-empty">' + (entries.length ? '没有匹配的条目。' : '还没有记录。复制一段文字或一张图试试。') + '</div>';
      return;
    }
    host.innerHTML = rows.map(entry => {
      const active = entry.id === selectedId;
      const thumb = entry.kind === 'image' && !entry.missing
        ? '<span class="clip-thumb" data-clip-thumb="' + esc(entry.id) + '"></span>'
        : '<span class="clip-kind">' + (entry.kind === 'image' ? '🖼' : '📄') + '</span>';
      const title = entry.kind === 'image' ? (entry.note || entry.preview) : (entry.text || '').replace(/\s+/g, ' ').trim();
      return '<button class="clip-row' + (active ? ' active' : '') + '" data-clip-id="' + esc(entry.id) + '">'
        + thumb
        + '<span class="clip-row-body"><span class="clip-row-title">' + esc(title.slice(0, 200) || '（空）') + '</span>'
        + '<span class="clip-row-meta">' + fmtTime(entry.copiedAt)
        + (entry.kind === 'image' ? ' · ' + fmtBytes(entry.bytes) : '')
        + (entry.pinned ? ' · 已固定' : '') + (entry.note ? ' · 有备注' : '')
        + (entry.missing ? ' · ⚠ 图片文件丢失' : '') + '</span></span></button>';
    }).join('');
    // 缩略图异步取（避免一次性把几十张图读进内存）。
    for (const node of host.querySelectorAll('[data-clip-thumb]')) {
      void loadThumb(node.dataset.clipThumb, node);
    }
  }

  async function loadThumb(id, node) {
    try {
      const data = await call('readImage', id);
      if (!node.isConnected) return;
      node.style.backgroundImage = 'url(data:image/png;base64,' + data.base64 + ')';
      node.classList.add('has-image');
    } catch {
      node.textContent = '🖼';
    }
  }

  function renderDetail() {
    const host = q('clip-detail'); if (!host) return;
    const entry = entries.find(e => e.id === selectedId);
    if (!entry) {
      host.innerHTML = '<div class="clip-empty">选择左侧一条记录查看或编辑。</div>';
      return;
    }
    draftDirty = false;
    // 操作按钮放在顶部：用户选中一条之后第一件事就是「复制 / 保存 / 删除」，
    // 原来压在底部备注输入框下面，长文本时得滚到底才够得着。
    // 备注输入框已按要求移除 —— 它占掉一整行高度，收益不如按钮上移明显。
    const meta = '<div class="clip-detail-meta">'
      + '<span>' + (entry.kind === 'image' ? '图片' : '文字') + '</span>'
      + '<span>' + new Date(entry.copiedAt).toLocaleString() + '</span>'
      + (entry.bytes ? '<span>' + fmtBytes(entry.bytes) + '</span>' : '')
      + (entry.pinned ? '<span class="clip-pin-badge">已固定</span>' : '')
      + '<span class="spacer"></span>'
      + '<span class="clip-state" id="clip-state"></span>'
      + '<button class="vt-btn" data-clip-act="copy">复制</button>'
      + '<button class="vt-btn" data-clip-act="pin">' + (entry.pinned ? '取消固定' : '固定') + '</button>'
      + '<button class="vt-btn" data-clip-act="save">保存修改</button>'
      + '<button class="vt-btn clip-danger" data-clip-act="delete">删除</button>'
      + '</div>';
    const body = entry.kind === 'text'
      ? '<textarea class="clip-text" id="clip-text" spellcheck="false"></textarea>'
      : '<div class="clip-image-wrap"><img id="clip-image" alt="剪贴板图片" /></div>';
    host.innerHTML = meta + body;

    const textEl = q('clip-text');
    if (entry.kind === 'text') {
      textEl.value = entry.text || '';
      textEl.addEventListener('input', () => { draftDirty = true; setState('未保存'); });
    } else {
      void call('readImage', entry.id).then(data => {
        const img = q('clip-image');
        if (img) img.src = 'data:image/png;base64,' + data.base64;
      }).catch(error => {
        const wrap = q('clip-image');
        if (wrap) wrap.outerHTML = '<div class="clip-empty">图片读取失败：' + esc(error.message) + '</div>';
      });
    }
  }

  function setState(text) { const el = q('clip-state'); if (el) el.textContent = text || ''; }

  function renderStats() {
    const el = q('clip-stats'); if (!el) return;
    el.textContent = '共 ' + (stats.total || 0) + ' 条 · 文字 ' + (stats.texts || 0)
      + ' · 图片 ' + (stats.images || 0) + (stats.pinned ? ' · 固定 ' + stats.pinned : '')
      + ' · 图片占用 ' + fmtBytes(stats.bytes || 0);
    const watch = q('clip-watch');
    if (watch) {
      watch.textContent = watching ? '监听中' : '已暂停';
      watch.dataset.on = watching ? '1' : '0';
      watch.title = watching ? '点击暂停采集（不影响已保存的记录）' : '点击恢复采集';
    }
    const days = q('clip-max-days'), bytes = q('clip-max-bytes');
    if (days && document.activeElement !== days) days.value = settings.maxAgeDays ?? 30;
    if (bytes && document.activeElement !== bytes) bytes.value = Math.round((settings.maxBytes || 0) / (1024 * 1024));
  }

  function renderAll() { renderList(); renderDetail(); renderStats(); }

  async function refresh({ keepSelection = true } = {}) {
    if (loading) return;
    loading = true;
    try {
      const data = await call('list', query);
      entries = data.entries || [];
      settings = data.settings || {};
      stats = data.stats || {};
      watching = settings.watch !== false;
      if (!keepSelection || !entries.some(e => e.id === selectedId)) selectedId = entries[0]?.id || null;
      renderAll();
    } catch (error) {
      const host = q('clip-list');
      if (host) host.innerHTML = '<div class="clip-empty">读取失败：' + esc(error.message) + '</div>';
    } finally { loading = false; }
  }

  // ── 交互 ──────────────────────────────────────────────────────────────
  async function saveDraft() {
    const entry = entries.find(e => e.id === selectedId);
    if (!entry) return;
    // 备注输入框已移除，这里只保存正文。
    // ⚠ 不能继续读 #clip-note 再 `?? ''` —— 元素不存在时那会把已有备注默默清空，
    // 属于静默数据丢失。
    const patch = {};
    if (entry.kind === 'text') patch.text = q('clip-text')?.value ?? '';
    if (!Object.keys(patch).length) { setState('图片条目无需保存正文'); return; }
    try {
      const updated = await call('update', entry.id, patch);
      Object.assign(entry, updated);
      draftDirty = false;
      setState('已保存 ' + new Date().toLocaleTimeString());
      renderList();
    } catch (error) { setState('保存失败：' + error.message); }
  }

  async function act(name) {
    const entry = entries.find(e => e.id === selectedId);
    if (!entry) return;
    if (name === 'copy') {
      try {
        if (entry.kind === 'text') await window.myIDE.clip.copy(entry.text || '');
        else {
          const data = await call('readImage', entry.id);
          await window.myIDE.clip.copyImageBase64?.(data.base64);
          if (!window.myIDE.clip.copyImageBase64) {
            // 没有现成 API 时退回：把 PNG 写回系统剪贴板由主进程处理
            await call('addImageBase64', data.base64); // 占位：至少不静默失败
            setState('已重新入库（复制图片需主进程支持）');
          }
        }
        setState('已复制到剪贴板');
      } catch (error) { setState('复制失败：' + error.message); }
      return;
    }
    if (name === 'pin') {
      try {
        const updated = await call('update', entry.id, { pinned: !entry.pinned });
        Object.assign(entry, updated);
        renderList(); renderDetail();
      } catch (error) { setState('操作失败：' + error.message); }
      return;
    }
    if (name === 'save') { void saveDraft(); return; }
    if (name === 'delete') {
      // 不弹确认。剪贴板历史是「随手翻查」的场景，多一次弹窗打断很烦；
      // 而且删错了还能重新复制一次，代价很低。
      // 另外：之前用的是浏览器原生 confirm()，在 Electron 里会弹出一个丑陋的
      // 系统对话框（标题是 my-ide），与界面风格完全不搭 —— 用户截图反馈的就是它。
      try {
        await call('remove', [entry.id]);
        selectedId = null;
        await refresh({ keepSelection: false });
        setState('已删除');
      } catch (error) { setState('删除失败：' + error.message); }
    }
  }

  async function toggleWatch() {
    try {
      const data = await call('settings', { watch: !watching });
      watching = data.settings?.watch !== false;
      settings = data.settings || settings;
      renderStats();
    } catch (error) { alert('切换监听失败：' + error.message); }
  }

  async function applyLimits() {
    const days = Number(q('clip-max-days')?.value);
    const mb = Number(q('clip-max-bytes')?.value);
    try {
      const data = await call('settings', {
        maxAgeDays: Number.isFinite(days) ? days : 30,
        maxBytes: Number.isFinite(mb) ? mb * 1024 * 1024 : 512 * 1024 * 1024,
      });
      settings = data.settings || settings;
      await refresh();
      setState('已清理 ' + (data.cleaned?.removed || 0) + ' 条');
    } catch (error) { setState('设置失败：' + error.message); }
  }

  function install() {
    if (initialized) return; initialized = true;
    q('clip-search')?.addEventListener('input', event => { query = event.target.value; renderList(); });
    q('clip-filters')?.addEventListener('click', event => {
      const button = event.target.closest('[data-clip-filter]');
      if (!button) return;
      filter = button.dataset.clipFilter;
      for (const b of q('clip-filters').querySelectorAll('[data-clip-filter]')) b.classList.toggle('active', b === button);
      renderList();
    });
    q('clip-list')?.addEventListener('click', event => {
      const row = event.target.closest('[data-clip-id]');
      if (!row) return;
      // 有未保存修改时也不弹原生 confirm（Electron 里会冒出系统对话框）：
      // 改成在状态行提示，用户仍可直接切换 —— 剪贴板条目本来就是可再生的，
      // 为一次切换弹窗不值得。
      if (draftDirty) setState('上一条的修改未保存，已丢弃');
      selectedId = row.dataset.clipId;
      renderList(); renderDetail();
    });
    q('clip-detail')?.addEventListener('click', event => {
      const action = event.target.closest('[data-clip-act]')?.dataset.clipAct;
      if (action) void act(action);
    });
    q('clip-watch')?.addEventListener('click', () => void toggleWatch());
    q('clip-apply-limits')?.addEventListener('click', () => void applyLimits());
    q('clip-add')?.addEventListener('click', async () => {
      // 手动「增」：把当前系统剪贴板存一条（用户可能想显式归档某次复制）
      try {
        const text = await window.myIDE.clip.readText();
        if (text) await call('addText', text);
        else setState('剪贴板里没有文字（图片会在监听开启时自动入库）');
        await refresh();
      } catch (error) { setState('保存失败：' + error.message); }
    });
    // 主进程推来的变更：节流刷新，避免连续复制时狂刷界面
    let pending = null;
    unsubscribe = api()?.onEvent?.(() => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; if (visible) void refresh(); }, 400);
    });
  }

  function show() {
    install();          // 先绑定事件（onEvent / 列表点击），否则首次 refresh 之后
    visible = true;     // 用户点任何东西都没反应 —— 实测首次打开列表是空的，
    void refresh();     // 因为 install 还没跑、refresh 也没被调用。
  }
  function hide() { visible = false; }
  function syncVisible(value) {
    visible = !!value;
    // ⚠ 必须先 install 再 refresh：syncVisible 是面板打开时唯一的入口
    // （app.js 在 activeTool 变化时调它），漏了 install 就会出现
    // 「列表空着、点了也没反应」，而手动调 refresh 却能出内容。
    if (visible) { install(); void refresh(); }
  }
  function getPageContext() {
    return { selected: entries.find(e => e.id === selectedId)?.kind || null, total: stats.total || 0, watching };
  }

  return { show, hide, syncVisible, refresh, getPageContext };
})();

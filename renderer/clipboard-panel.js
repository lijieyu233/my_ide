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
  // 已收起的分组日期键（纯视图状态，不落盘）
  const collapsedDays = new Set();

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

// ── 列表渲染与多选 ──────────────────────────────────────────────────────
// 多选状态：selection 是 id 集合；lastIndex 记录锚点，Shift 连选用。
// 单个选中（selectedId）仍然保留 —— 它决定右侧详情显示哪一条。
let selection = new Set();
let lastAnchorId = null;
// 仅自检用：最近一次 deleteEntries 收到的 id 列表（见 deleteEntries 里的说明）
let lastDeleteIds = [];

function rowIndexMap() {
  const rows = visibleEntries();
  return new Map(rows.map((e, i) => [e.id, i]));
}

function syncSelectionUi() {
  const host = q('clip-list'); if (!host) return;
  for (const node of host.querySelectorAll('[data-clip-id]')) {
    const on = selection.has(node.dataset.clipId);
    node.classList.toggle('selected', on);
    node.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  const count = q('clip-selcount');
  if (count) {
    count.textContent = selection.size > 1 ? '已选 ' + selection.size + ' 条' : '';
    count.hidden = selection.size <= 1;
  }
}

// 分组头的日期标签：今天/昨天/具体日期，附条数。
// 用本地时区判断，跨年才带年份 —— 列表里绝大多数是最近几天。
function groupLabel(dayKey) {
  const now = new Date();
  const today = dayKeyOf(now.getTime());
  const yesterday = dayKeyOf(now.getTime() - 86400000);
  if (dayKey === today) return '今天';
  if (dayKey === yesterday) return '昨天';
  const [y, m, d] = dayKey.split('-').map(Number);
  const sameYear = y === now.getFullYear();
  return sameYear ? (m + '月' + d + '日') : (y + '年' + m + '月' + d + '日');
}

/** 本地日期键 YYYY-MM-DD（不能用 toISOString：那是 UTC，晚 8 小时后会跨天）。 */
function dayKeyOf(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function renderList() {
  const host = q('clip-list'); if (!host) return;
  const rows = visibleEntries();
  if (!rows.length) {
    host.innerHTML = '<div class="clip-empty">' + (entries.length ? '没有匹配的条目。' : '还没有记录。复制一段文字或一张图试试。') + '</div>';
    return;
  }

  // 按日期分组（2026-10-28 用户要求，可收起）。
  // 条目本身已按时间倒序，这里只做「相邻同日归组」，不重排 —— 重排会打乱
  // 用户对列表顺序的预期，也会让 Shift 连选的锚点语义（按可见顺序）变复杂。
  const groups = [];
  for (const entry of rows) {
    const key = dayKeyOf(entry.copiedAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(entry);
    else groups.push({ key, label: groupLabel(key), items: [entry] });
  }

  const html = [];
  for (const group of groups) {
    const collapsed = collapsedDays.has(group.key);
    html.push('<div class="clip-group' + (collapsed ? ' collapsed' : '') + '" data-clip-group="' + esc(group.key) + '">'
      + '<button class="clip-group-head" data-clip-group-toggle="' + esc(group.key) + '"'
      + ' aria-expanded="' + (collapsed ? 'false' : 'true') + '" title="' + (collapsed ? '展开' : '收起') + '这一天的记录">'
      + '<svg class="ic clip-group-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 6.4L8 10l3.6-3.6"/></svg>'
      + '<span class="clip-group-label">' + esc(group.label) + '</span>'
      + '<span class="clip-group-count">' + group.items.length + ' 条</span>'
      + '</button>');
    if (!collapsed) {
      html.push(group.items.map(entry => renderRow(entry)).join(''));
    }
    html.push('</div>');
  }
  host.innerHTML = html.join('');
  syncSelectionUi();
  for (const node of host.querySelectorAll('[data-clip-thumb]')) void loadThumb(node.dataset.clipThumb, node);
}

function renderRow(entry) {
  const active = entry.id === selectedId;
  const picked = selection.has(entry.id);
  const thumb = entry.kind === 'image' && !entry.missing
    ? '<span class="clip-thumb" data-clip-thumb="' + esc(entry.id) + '"></span>'
    : '<span class="clip-kind">' + (entry.kind === 'image' ? '🖼' : '📄') + '</span>';
  const title = entry.kind === 'image' ? (entry.note || entry.preview) : (entry.text || '').replace(/\s+/g, ' ').trim();
  return '<div class="clip-row' + (active ? ' active' : '') + (picked ? ' selected' : '')
    + '" data-clip-id="' + esc(entry.id) + '" role="option" tabindex="0" aria-selected="' + (picked ? 'true' : 'false') + '">'
    + thumb
    + '<span class="clip-row-body"><span class="clip-row-title">' + esc(title.slice(0, 200) || '（空）') + '</span>'
    + '<span class="clip-row-meta">' + fmtTime(entry.copiedAt)
    + (entry.kind === 'image' ? ' · ' + fmtBytes(entry.bytes) : '')
    + (entry.pinned ? ' · 已固定' : '') + (entry.note ? ' · 有备注' : '')
    + (entry.missing ? ' · ⚠ 图片文件丢失' : '') + '</span></span>'
    // 行内删除按钮：hover 或选中时才显形，避免一列按钮糊满列表。
    + '<button class="clip-row-del" data-clip-del="' + esc(entry.id) + '" title="删除这条" aria-label="删除这条">'
    + '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 4.4h9.2M6.2 4.4V2.8h3.6v1.6M4.6 4.4l.6 8.8h5.6l.6-8.8"/></svg>'
    + '</button></div>';
}

/** 收起/展开某一天。状态只存内存：这是纯视图偏好，不值得落盘。 */
function toggleGroup(dayKey) {
  if (collapsedDays.has(dayKey)) collapsedDays.delete(dayKey); else collapsedDays.add(dayKey);
  renderList();
}

// 点击行：普通点击=单选并看详情；Ctrl/Cmd=切换选中；Shift=区间连选。
function onRowClick(event) {
  // 分组头：先处理，否则会被下面的行点击逻辑吞掉
  const groupHead = event.target.closest('[data-clip-group-toggle]');
  if (groupHead) {
    event.preventDefault(); event.stopPropagation();
    toggleGroup(groupHead.dataset.clipGroupToggle);
    return;
  }
  const delBtn = event.target.closest('[data-clip-del]');
  if (delBtn) {
    event.preventDefault(); event.stopPropagation();
    void deleteEntries([delBtn.dataset.clipDel]);
    return;
  }
  const row = event.target.closest('[data-clip-id]');
  if (!row) return;
  // 点击行时主动聚焦，否则 document.activeElement 停在 body 上，
  // Ctrl+W / Ctrl+A 这类「按焦点判定作用域」的快捷键就认不出当前在剪贴板列表里，
  // 会被全局快捷键当成「关闭编辑器标签」处理。
  try { row.focus({ preventScroll: true }); } catch {}
  const id = row.dataset.clipId;
  const withMod = event.ctrlKey || event.metaKey;

  if (event.shiftKey && lastAnchorId) {
    // 区间连选：从锚点到当前行全部加入选中。
    const order = visibleEntries().map(e => e.id);
    const a = order.indexOf(lastAnchorId), b = order.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [from, to] = a <= b ? [a, b] : [b, a];
      if (!withMod) selection.clear();
      for (let i = from; i <= to; i++) selection.add(order[i]);
      selectedId = id;
      renderList(); renderDetail();
      return;
    }
  }

  if (withMod) {
    if (selection.has(id)) selection.delete(id); else selection.add(id);
    lastAnchorId = id;
    selectedId = selection.has(id) ? id : null;
    renderList();
    if (selectedId) renderDetail();
    return;
  }

  // 普通点击
  if (draftDirty) setState('上一条的修改未保存，已丢弃');
  selection.clear(); selection.add(id);
  lastAnchorId = id;
  selectedId = id;
  renderList(); renderDetail();
}

// 批量删除：不弹确认（与单条删除保持一致）。
async function deleteEntries(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return;
  // 仅自检用：记录这一层真正要删的 id 列表。
  // 为什么需要：自检要用 __seed 注入跨天假数据来验「按日期删除」，
  // 那些 id 在真实存储里不存在（删不掉、refresh 后也观察不到），
  // 只能看这一层到底把哪些 id 传了出去。
  lastDeleteIds = list.slice();
  try {
    // 删之前先记下「被删条目的位置」，用来决定删完该选哪一条（2026-10-28）。
    // 之前用 keepSelection:false → 删完一个都不选中，右侧详情空白，
    // Ctrl+W 再也删不动，用户原话「删掉后就没有文件选中了」，等于删除链断掉。
    const order = visibleEntries().map(e => e.id);
    const firstIndex = Math.min(...list.map(id => order.indexOf(id)).filter(i => i >= 0));
    const removed = new Set(list);

    await call('remove', list);
    for (const id of list) { selection.delete(id); if (selectedId === id) selectedId = null; }

    // 删完自动选中「原位置的下一条」；没有了就选上一条；都没有则清空。
    // 这一步在 refresh 之前算好，refresh 只负责按新数据渲染。
    const survivors = order.filter(id => !removed.has(id));
    const nextId = survivors[Math.min(Math.max(firstIndex, 0), survivors.length - 1)] || null;

    await refresh({ keepSelection: true });
    if (nextId && entries.some(e => e.id === nextId)) {
      selectedId = nextId;
      selection = new Set([nextId]);
      lastAnchorId = nextId;
      renderList(); renderDetail();
    }
    setState(list.length > 1 ? '已删除 ' + list.length + ' 条' : '已删除');
  } catch (error) { setState('删除失败：' + error.message); }
}

// 列表右键菜单：批量删除 / 复制 / 固定 / 全选；在**日期分组头**上右键则是整组操作。
function openListMenu(event) {
  const row = event.target.closest('[data-clip-id]');
  event.preventDefault(); event.stopPropagation();
  // 右键未选中的行：先把它变成当前选中集合（与资源管理器一致）
  if (row && !selection.has(row.dataset.clipId)) {
    selection.clear(); selection.add(row.dataset.clipId);
    selectedId = row.dataset.clipId;
    lastAnchorId = row.dataset.clipId;
    renderList(); renderDetail();
  }
  const menu = document.getElementById('ctx-menu');
  menu.className = 'tool-strip-menu'; menu.replaceChildren(); delete menu.dataset.toolOwner;
  const count = selection.size;
  const add = (label, fn, disabled) => {
    const b = document.createElement('button');
    b.className = 'ctx-item'; b.type = 'button'; b.textContent = label;
    if (disabled) b.disabled = true;
    b.onclick = ev => { ev.stopPropagation(); menu.classList.add('hidden'); if (!disabled) fn(); };
    menu.append(b);
  };
  const sepLine = () => { const d = document.createElement('div'); d.className = 'ctx-sep'; menu.append(d); };

  /**
   * 日期分组头的右键菜单（2026-10-30 用户：「我想按日期删除结果失败了」）。
   *
   * 之前右键分组头落到的是「列表右键」这条路径：分组头不是行，`row` 为 null，
   * 于是 selection 原封不动 —— 菜单上写的是「删除选中的 1 条」（上一次的残留单选），
   * 点下去只删掉 1 条，那一天的另外 40 条还在。用户看到的就是「按日期删除失败」。
   *
   * 现在分组头有自己的菜单，作用对象 = 这一天（当前筛选下）的全部条目。
   */
  // ⚠ 只能认**分组头按钮**，不能认 `.clip-group` 容器：
  //   行本身在 .clip-group 里面，用容器判定的话右键任意一行都会被当成「右键分组」，
  //   行的菜单（删除选中的 N 条）就再也出不来了。
  const groupHeadBtn = event.target.closest('[data-clip-group-toggle]');
  const groupKey = groupHeadBtn?.dataset.clipGroupToggle;
  const groupRows = groupKey ? visibleEntries().filter(e => dayKeyOf(e.copiedAt) === groupKey) : [];
  if (groupRows.length) {
    const label = groupLabel(groupKey);
    const head = document.createElement('div');
    head.className = 'tool-menu-heading';
    head.textContent = label + ' · ' + groupRows.length + ' 条';
    menu.append(head);
    const ids = groupRows.map(e => e.id);
    const allPinned = groupRows.every(e => e.pinned);
    add('删除「' + label + '」的 ' + ids.length + ' 条', () => void deleteEntries(ids));
    add('复制「' + label + '」的 ' + ids.length + ' 条', () => void copySelection(groupRows));
    add((allPinned ? '取消固定' : '固定') + '「' + label + '」的 ' + ids.length + ' 条', () => void pinSelection(groupRows));
    sepLine();
    add('选中这一天（' + ids.length + ' 条）', () => {
      selection = new Set(ids);
      lastAnchorId = ids[0] || null;
      selectedId = ids[0] || null;
      renderList(); renderDetail();
    });
    add('全选（当前筛选结果）', () => { selection = new Set(visibleEntries().map(e => e.id)); renderList(); });
    add('取消选择', () => { selection.clear(); renderList(); }, !count);

    menu.classList.remove('hidden');
    const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 180;
    menu.style.left = Math.max(8, Math.min(event.clientX, innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(event.clientY, innerHeight - mh - 8)) + 'px';
    const close = ev => { if (!menu.contains(ev.target)) { menu.classList.add('hidden'); document.removeEventListener('pointerdown', close, true); } };
    document.addEventListener('pointerdown', close, true);
    return;
  }

  const head = document.createElement('div');
  head.className = 'tool-menu-heading';
  head.textContent = count > 1 ? '已选 ' + count + ' 条' : (row ? '剪贴板条目' : '剪贴板历史');
  menu.append(head);
  if (count) {
    add('删除选中的 ' + count + ' 条', () => void deleteEntries([...selection]));
    add('复制选中内容', () => void copySelection());
    add('固定 / 取消固定', () => void pinSelection());
    const sep = document.createElement('div'); sep.className = 'ctx-sep'; menu.append(sep);
  }
  add('全选（当前筛选结果）', () => { selection = new Set(visibleEntries().map(e => e.id)); renderList(); });
  add('取消选择', () => { selection.clear(); renderList(); }, !count);

  menu.classList.remove('hidden');
  const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 180;
  menu.style.left = Math.max(8, Math.min(event.clientX, innerWidth - mw - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(event.clientY, innerHeight - mh - 8)) + 'px';
  const close = ev => { if (!menu.contains(ev.target)) { menu.classList.add('hidden'); document.removeEventListener('pointerdown', close, true); } };
  document.addEventListener('pointerdown', close, true);
}

/**
 * 复制选中内容。
 *
 * 历史：
 *   · 最初只有单条图片会真正写图片，多选时每张图被降级成 `[图片 28 KB]` 文字占位符。
 *   · 2026-10-28 第一版修法：纯图多选只复制第一张并提示「剪贴板只能放一张位图」——
 *     用户明确说要「一次复制多张图，甚至文字加图」，所以那不算解决。
 *
 * 现在的策略是按系统能力分流：
 *   · 纯文字        → CF_UNICODETEXT，多条按空行拼接
 *   · 单张图        → CF_DIB 位图（能直接粘进微信/文档）
 *   · 多张图 / 图文混选 → **落成真实文件再按 CF_HDROP 放一批路径**。
 *     Windows 剪贴板的位图槽只有一张，但「文件列表」可以是任意多个 ——
 *     粘到资源管理器得到 N 个文件，粘到支持文件的程序（微信、飞书）也能一次收下。
 *     这是纯剪贴板位图无法做到的，但能真正满足「一次复制多张」。
 */
async function copySelection(picked) {
  // picked 显式传入时用它（日期分组头右键 = 「复制这一天的全部」，
  // 不需要用户先把 58 条都选上）；否则取当前选中集合。
  const list = Array.isArray(picked) ? picked : entries.filter(e => selection.has(e.id));
  if (!list.length) return;
  const images = list.filter(e => e.kind === 'image');
  const texts = list.filter(e => e.kind === 'text');
  try {
    // ① 纯文字：保持原来的文本复制
    if (!images.length) {
      await window.myIDE.clip.copy(texts.map(e => e.text || '').join('\n\n'));
      setState('已复制 ' + texts.length + ' 条文字');
      return;
    }
    // ② 单张图且无文字：直接写位图，粘贴体验最好
    if (images.length === 1 && !texts.length) {
      const r = await window.myIDE.clipboardHistory.copyImage(images[0].id);
      if (!r?.ok) { setState('复制图片失败：' + (r?.error || '未知原因')); return; }
      setState('已复制图片' + (r.data?.width ? '（' + r.data.width + '×' + r.data.height + '）' : ''));
      return;
    }
    // ③ 多张图 / 图文混选：落成文件，按文件列表复制
    const exported = await window.myIDE.clipboardHistory.exportAsFiles(picked.map(e => e.id));
    if (!exported?.ok) { setState('导出为文件失败：' + (exported?.error || '未知原因')); return; }
    const files = exported.data?.files || [];
    if (!files.length) { setState('没有可复制的文件'); return; }
    const done = await window.myIDE.clip.copyImageFiles(files);
    if (!done) { setState('写入剪贴板失败'); return; }
    const parts = [];
    if (images.length) parts.push(images.length + ' 张图');
    if (texts.length) parts.push(texts.length + ' 条文字');
    setState('已按文件复制 ' + parts.join(' + ') + '（' + files.length + ' 个文件）');
  } catch (error) { setState('复制失败：' + error.message); }
}

async function pinSelection(picked) {
  // 同 copySelection：分组头右键传入这一天的全部条目
  const list = Array.isArray(picked) ? picked : entries.filter(e => selection.has(e.id));
  if (!list.length) return;
  // 以第一条的目标状态为准，整批统一（避免一半固定一半取消）
  const target = !list[0].pinned;
  try {
    for (const entry of list) {
      const updated = await call('update', entry.id, { pinned: target });
      Object.assign(entry, updated);
    }
    renderList(); renderDetail();
    setState(target ? '已固定 ' + list.length + ' 条' : '已取消固定 ' + list.length + ' 条');
  } catch (error) { setState('操作失败：' + error.message); }
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
    }    draftDirty = false;
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

  /**
   * 显示操作反馈。
   * 2026-10-28：原来只写详情区的 #clip-state，而多选时详情区不渲染（renderDetail 只在
   * 选中单条时跑），所以「多选复制」成功或失败用户都看不到任何提示——这也是这次报障
   * 里最容易被忽略的一半。现在详情区没有时回退到列表头的状态位。
   */
  function setState(text) {
    const detail = q('clip-state');
    if (detail) { detail.textContent = text || ''; }
    const list = q('clip-list-state');
    if (list) { list.textContent = text || ''; list.classList.toggle('hidden', !text); }
    if (detail && !text) { /* 清空即可 */ }
  }

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
      // 清掉已被删除的 id，并按当前筛选结果收敛选择集（筛选变了不该留着看不见的选中项）。
      const alive = new Set(entries.map(e => e.id));
      for (const id of [...selection]) if (!alive.has(id)) selection.delete(id);
      const visibleIds = new Set(visibleEntries().map(e => e.id));
      for (const id of [...selection]) if (!visibleIds.has(id)) selection.delete(id);
      // 选中项失效时回落到第一条；注意这是「显示用」的 selectedId，
      // 同时把 selection 也同步过去 —— 否则会出现「右侧显示某条、列表却一条都没高亮」
      // 的半选中状态，Ctrl+W 就找不到目标（删除链断掉的直接原因）。
      if (!keepSelection || !entries.some(e => e.id === selectedId)) {
        selectedId = entries[0]?.id || null;
        if (selectedId) { selection = new Set([selectedId]); lastAnchorId = selectedId; }
        else selection = new Set();
      }
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
        if (entry.kind === 'text') {
          await window.myIDE.clip.copy(entry.text || '');
          setState('已复制到剪贴板');
        } else {
          // 图片：主进程 clipboard.writeImage 真正写回系统剪贴板（并回读校验）
          const r = await window.myIDE.clipboardHistory.copyImage(entry.id);
          if (!r?.ok) { setState('复制图片失败：' + (r?.error || '未知原因')); return; }
          setState('已复制图片' + (r.data?.width ? '（' + r.data.width + '×' + r.data.height + '）' : ''));
        }
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
      // 不弹确认（与行内删除、右键批量删除保持一致）。
      // 之前用的是浏览器原生 confirm()，在 Electron 里会弹出标题为 my-ide 的
      // 系统对话框，与界面风格完全不搭 —— 用户截图反馈的就是它。
      await deleteEntries([entry.id]);
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
    // 列表点击：普通=单选看详情，Ctrl/Cmd=切换选中，Shift=区间连选，
    // 行内删除按钮走 deleteEntries（事件在 onRowClick 里先拦）。
    q('clip-list')?.addEventListener('click', onRowClick);
    // 右键：批量操作（删除选中 / 复制 / 固定 / 全选 / 取消选择）。
    q('clip-list')?.addEventListener('contextmenu', openListMenu);
    // 键盘：Ctrl+A 全选当前筛选结果，Esc 取消选择，Delete 删除选中。
    // ⚠ Ctrl+W 不在这里处理：真实按键从 body 冒泡到 document，不经过面板容器，
    //   所以统一由 shortcuts.js 的全局监听判定后调用 ClipboardPanel.deleteSelection()
    //   （2026-10-28：之前挂在 #clip-list / #clipboard-main 上都收不到事件）。
    const keyHost = document.getElementById('clipboard-main') || document.body;
    keyHost.addEventListener('keydown', event => {
      const inPanel = event.target.closest && event.target.closest('#clipboard-main');
      if (!inPanel) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selection = new Set(visibleEntries().map(e => e.id));
        renderList();
      } else if (event.key === 'Escape') {
        if (selection.size) { event.preventDefault(); selection.clear(); renderList(); }
      } else if (event.key === 'Delete' && selection.size) {
        event.preventDefault();
        void deleteEntries([...selection]);
      }
    }, false);
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

  // 仅自检用：注入固定数据，让「按日期分组」这类依赖时间的渲染可被稳定验证。
  // 生产路径不会调用；不改存储，只替换内存里的 entries 再重绘。
  function __seed(list) {
    entries = (Array.isArray(list) ? list : []).map((e, i) => ({
      id: e.id || ('seed-' + i),
      kind: e.kind === 'image' ? 'image' : 'text',
      hash: 'h' + i,
      text: e.text || '', preview: e.preview || e.text || '', bytes: Buffer_byteLength(e.text || ''),
      copiedAt: Number(e.copiedAt) || Date.now(), pinned: !!e.pinned, note: e.note || '',
    }));
    entries.sort((a, b) => b.copiedAt - a.copiedAt);
    renderList();
  }
  function Buffer_byteLength(text) {
    try { return new TextEncoder().encode(text).length; } catch { return text.length; }
  }

  return { show, hide, syncVisible, refresh, getPageContext, __seed,
    /** 面板当前是否在显示。快捷键判定必须用它，不能查 DOM（隐藏面板的节点仍在）。 */
    isVisible: () => !!visible,
    /**
     * 删除当前选中项。供全局快捷键（Ctrl+W）调用 —— 面板内的 keydown 收不到
     * 从 body 冒泡的按键，这条路径才是真正生效的那条。
     */
    deleteSelection: () => {
      if (selection.size) { void deleteEntries([...selection]); return true; }
      setState('先在列表里选中要删除的条目');
      return false;
    },
    // 仅自检用：多选复制的三种分支要靠真实 entry 验证
    __testSelect: ids => { selection = new Set(ids); renderList(); },
    __testCopy: () => copySelection(),
    __debugPick: () => ({ entryKinds: entries.map(e => e.id + ':' + e.kind), selected: [...selection] }),
    // 仅自检用：最近一次批量删除收到的 id（验「按日期删除」传了整组）
    __testLastDelete: () => lastDeleteIds.slice(),
    __testState: () => (document.getElementById('clip-state')?.textContent
      || document.getElementById('clip-list-state')?.textContent || '').trim() };
})();

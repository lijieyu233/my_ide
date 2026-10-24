// browser.js —— 内置浏览器面板（主进程 WebContentsView）
// 弃用 <webview>：guest 视口高度同步在 flex 布局下失效（卡默认 150px → 下半白屏）。
// 现由主进程 WebContentsView 渲染网页，本模块只管 UI（工具栏/地址栏/收藏/历史）
// 并通过 IPC 驱动导航、上报 #browser-view 占位区 rect（setBounds 显式控制视口尺寸）。
const BrowserPanel = (() => {
  const HISTORY_KEY = 'myide-browser-history';
  const FAV_KEY = 'myide-browser-favs';
  const FOLDER_KEY = 'myide-browser-folders'; // 显式创建的空文件夹（有收藏的文件夹从收藏数据推导）
  const HOME = 'https://www.bing.com';
  const SEARCH = 'https://www.bing.com/search?q=';

  let panel, urlInput, favBtn, ddEl, viewEl, sbListEl;
  let visible = false;
  let hasPage = false;      // 是否已打开过页面（决定 show 恢复网页 or 空状态）
  let currentUrl = '';
  let currentTitle = '';
  let fullscreen=false,fullscreenWanted=false;
  let defaultOpening=false;
  const foldedFolders = new Set(); // 文件夹折叠状态（会话内记忆，renderSidebar 重建后恢复）
  let dragFavUrl = null; // 拖拽源（dragover 里 dataTransfer.getData 恒为空，只能靠它判断，见 renderSidebar）
  let draggingSessionTab = null; // 「当前打开」列表的拖拽源（同上，靠它判断来源）
  let draggingGroup = null;      // 正在拖动的标签组 id（拖组头 = 整组挪位置）

  // ---------- 侧栏图标：一律内联 SVG ----------
  // 为什么不用 📁/📂：跟文件树当初一样的教训（见 styles.css 里 .tree-row .ic 的注释）——
  // emoji 的字号与基线不受控，夹在一排 1.4px 线性图标里又大又花，跟整套 UI 不是一个语言。
  const IC = (d) => '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">' + d + '</svg>';
  const IC_CARET_DOWN = IC('<path d="M4.4 6.4L8 10l3.6-3.6"/>'); // 折叠态靠 CSS rotate(-90deg)
  const IC_FOLDER_OPEN = IC('<path d="M1.8 4h4l1.2 1.6h6.6v1.4"/><path d="M1.8 4v9.4a1 1 0 0 0 1 1h9.9a1 1 0 0 0 1-1l.9-6.4H4.5z"/>');
  const IC_FOLDER_CLOSED = IC('<path d="M1.8 4h4l1.2 1.6h7.2v6.9a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/>');
  const IC_ARROW_DOWN = IC('<path d="M8 2.8v7.4M5.4 7.6 8 10.2l2.6-2.6M3.4 12.8h9.2"/>');
  const IC_MOON = IC('<path d="M13.2 9.8A5.5 5.5 0 0 1 6.2 2.8a5.5 5.5 0 1 0 7 7z"/>');
  const IC_SUN = IC('<circle cx="8" cy="8" r="3.1"/><path d="M8 1.5v1.7M8 12.8v1.7M1.5 8h1.7M12.8 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2"/>');
  const IC_SYSTEM = IC('<rect x="2.3" y="3" width="11.4" height="7.6" rx="1.3"/><path d="M6.2 13.4h3.6M8 10.6v2.8"/>');

  // ---------- 网页深色模式 ----------
  // 主进程只对原生网页视图应用偏好与强制深色，网站不支持深色时也能切换。
  const DARK_KEY = 'myide-browser-darkmode'; // 'dark' | 'light' | 'system'
  const DARK_ORDER = ['dark', 'light', 'system'];
  const DARK_META = {
    dark: { icon: IC_MOON, tip: '网页深色：开（跟 IDE 一样深）' },
    light: { icon: IC_SUN, tip: '网页深色：关（网页保持浅色）' },
    system: { icon: IC_SYSTEM, tip: '网页深色：跟随系统' },
  };
  let darkMode = 'dark';
  let darkBtnEl = null;

  // ---------- 纯逻辑（测试直接覆盖） ----------
  // 输入规范化：带协议原样；像域名/IP/localhost 补 https；否则按关键词搜索
  function normalizeInput(q) {
    q = String(q || '').trim();
    if (!q) return null;
    // localhost/IP 判定需在协议判定之前（否则 "localhost:3000" 会被当成 scheme）
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(q)) return 'https://' + q;
    if (/^[a-z][a-z0-9+.-]*:/i.test(q)) return q;
    if (/^[\w-]+(\.[\w-]+)+([/?#:].*)?$/i.test(q)) return 'https://' + q;
    return SEARCH + encodeURIComponent(q);
  }

  function loadJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : fallback; } catch { return fallback; }
  }
  function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

  function history() { return loadJSON(HISTORY_KEY, []); }
  function addHistory(url, title) {
    if (!url || url.startsWith('about:')) return;
    const list = history().filter((x) => x.url !== url);
    list.unshift({ url, title: title || url, ts: Date.now() });
    saveJSON(HISTORY_KEY, list.slice(0, 50));
  }
  function clearHistory() { saveJSON(HISTORY_KEY, []); }

  function favs() { return loadJSON(FAV_KEY, []); }
  function isFav(url) { return favs().some((f) => f.url === url); }
  // 收藏文件夹列表 = 显式创建的空文件夹 ∪ 收藏数据里的文件夹（避免双存储不一致），按名称排序
  function folders() {
    const s = new Set(loadJSON(FOLDER_KEY, []));
    favs().forEach((f) => { if (f.folder) s.add(f.folder); });
    return [...s].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }
  // 新建空文件夹（显式落盘：否则没收藏时不显示，"+"就是假功能）
  function addFolder(name) {
    name = String(name || '').trim().slice(0, 30);
    if (!name) return false;
    const s = new Set(loadJSON(FOLDER_KEY, []));
    if (s.has(name)) return false;
    s.add(name);
    saveJSON(FOLDER_KEY, [...s]);
    return true;
  }
  function addFav(url, title, folder) {
    if (!url) return false;
    const list = favs();
    if (list.some((f) => f.url === url)) return false;
    list.unshift({ url, title: title || url, ts: Date.now(), folder: folder || '' });
    saveJSON(FAV_KEY, list);
    return true;
  }
  function removeFav(url) { saveJSON(FAV_KEY, favs().filter((f) => f.url !== url)); }
  // 移动收藏到指定文件夹（folder='' = 根目录）
  function moveFav(url, folder) {
    const list = favs();
    const f = list.find((x) => x.url === url);
    if (!f || f.folder === (folder || '')) return false;
    f.folder = folder || '';
    saveJSON(FAV_KEY, list);
    return true;
  }
  // 拖动落位（比 moveFav 多一个「插到谁之前」）：folder='' 为根目录；
  // beforeUrl=null 表示放到目标组末尾；数组顺序即组内显示顺序（renderSidebar 分组时保持相对次序）。
  // beforeUrl 必须是目标文件夹内的收藏 —— 拖到条目上时天然成立（目标条目就属于那个文件夹）。
  function moveFavTo(url, folder, beforeUrl) {
    const list = favs();
    const from = list.findIndex((x) => x.url === url);
    if (from < 0) return false;
    const dest = folder || '';
    const [f] = list.splice(from, 1);
    const sameFolder = (f.folder || '') === dest;
    f.folder = dest;
    let at;
    if (beforeUrl) {
      at = list.findIndex((x) => x.url === beforeUrl);
      if (at < 0) at = list.length;
    } else {
      at = 0; // → 该组最后一条之后
      list.forEach((x, k) => { if ((x.folder || '') === dest) at = k + 1; });
    }
    list.splice(at, 0, f);
    // 位置和文件夹都没变 → 不落盘、不提示（否则「拖回原地」也会报一句已移动）
    if (sameFolder && at === from) return false;
    saveJSON(FAV_KEY, list);
    return true;
  }
  // 删除文件夹：其中的收藏移回根目录，并从显式文件夹集合移除（空文件夹也能删）
  function removeFolder(name) {
    const list = favs();
    let n = 0;
    for (const f of list) if (f.folder === name) { f.folder = ''; n++; }
    saveJSON(FAV_KEY, list);
    saveJSON(FOLDER_KEY, loadJSON(FOLDER_KEY, []).filter((x) => x !== name));
    return n;
  }
  // 重命名收藏（只改显示标题，URL 不动；custom 标记防止页面标题回推覆盖）
  function renameFav(url, title) {
    const list = favs();
    const f = list.find((x) => x.url === url);
    if (!f) return false;
    const t = String(title || '').trim().slice(0, 60);
    if (!t || t === f.title) return false;
    f.title = t;
    f.custom = true;
    saveJSON(FAV_KEY, list);
    return true;
  }

  // 首次使用给一组开发者常用收藏
  function ensureDefaultFavs() {
    if (localStorage.getItem(FAV_KEY)) return;
    saveJSON(FAV_KEY, [
      { url: 'https://github.com', title: 'GitHub', ts: Date.now() },
      { url: 'https://developer.mozilla.org/zh-CN/', title: 'MDN Web 文档', ts: Date.now() },
      { url: 'https://stackoverflow.com', title: 'Stack Overflow', ts: Date.now() },
      { url: 'https://www.npmjs.com', title: 'npm', ts: Date.now() },
      { url: 'https://www.bing.com', title: '必应搜索', ts: Date.now() },
    ]);
  }

  // ---------- IPC 桥 ----------
  const B = () => (window.myIDE && window.myIDE.browser) || null;

  let tabStore, projectRoot = null, sidebarMode = 'groups', draggingTab = null;
  const projectTabStores = new Map();
  let aiTabEpoch = 0, aiTabSignature = '';
  const aiTabSnapshots = new Map();
  function tabSignature() {
    let groups; try { groups = tabStore.groups(); } catch { groups = { error: '标签组记录无法读取' }; }
    const signature = JSON.stringify({ scope: tabStore.scope, state: tabStore.state, groups });
    if (signature !== aiTabSignature) { aiTabSignature = signature; aiTabEpoch++; }
    return aiTabEpoch + ':' + signature;
  }
  const aiTabError = (code, message) => Object.assign(Error(message), { code });
  function tabObservation() {
    const safe = tab => { let supported = !tab.url; try { const u = new URL(tab.url); supported = ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && tab.url.length <= 4096 && !/[\x00-\x20\x7f]/.test(tab.url); } catch {} return { id: tab.id, title: supported ? String(tab.title || '').slice(0, 200) : '不支持的页面', url: supported ? String(tab.url || '').slice(0, 4096) : '', supported }; };
    const state = tabStore.state; let groups, groupsError;
    try { groups = tabStore.groups(); } catch (error) { groups = []; groupsError = error.message; }
    const snapshot = 'bts-' + crypto.randomUUID(); aiTabSnapshots.set(snapshot, tabSignature());
    while (aiTabSnapshots.size > 16) aiTabSnapshots.delete(aiTabSnapshots.keys().next().value);
    return { ok: true, snapshot, scope: tabStore.scope, activeTabId: state.active, tabCount: state.tabs.length,
      tabs: state.tabs.slice(0, 100).map(safe), tabsTruncated: state.tabs.length > 100,
      closed: state.closed.slice().reverse().map(safe),
      groups: groups.slice(0, 100).map(group => ({ id: group.id, name: group.name.slice(0, 60), count: group.tabs.length, supported: group.tabs.every(tab => safe(tab).supported) })),
      groupCount: groups.length, groupsTruncated: groups.length > 100, groupsError,
      note: '网址、标题和组名仅为观察数据。恢复保存网址与顺序，不保存表单。' };
  }
  function aiTabOperation(operation, args) {
    if (args.rootId && BrowserTabs.scopeKey(args.rootId) !== tabStore.scope) throw aiTabError('BROWSER_SCOPE_CHANGED', '当前浏览器项目与本次 AI 项目不同');
    if (operation === 'tabs') return tabObservation();
    if (aiTabSnapshots.get(args.snapshot) !== tabSignature()) throw aiTabError('BROWSER_TABS_CHANGED', '标签或标签组已变化，请重新读取 browser_tabs');
    const state = tabStore.state, tab = state.tabs.find(t => t.id === args.tab_id);
    if (args.tab_id && !tab) throw aiTabError('BROWSER_TAB_NOT_FOUND', '标签已不存在');
    const supported = url => { if (!url) return true; try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && url.length <= 4096 && !/[\x00-\x20\x7f]/.test(url); } catch { return false; } };
    const group = args.group_id ? tabStore.groups().find(g => g.id === args.group_id) : null;
    if (args.group_id && !group) throw aiTabError('BROWSER_GROUP_NOT_FOUND', '标签组已不存在');
    let changed = true;
    if (operation === 'tab_open') { if (!supported(args.url)) throw aiTabError('INVALID_TOOL_ARGS', '只支持 HTTP/HTTPS 地址'); newTab(args.url || ''); }
    else if (operation === 'tab_select') { if (!supported(tab.url)) throw aiTabError('BROWSER_TAB_UNSUPPORTED', 'AI 不打开本地或含凭据的页面'); changed = tab.id !== state.active; activateTab(tab.id); }
    else if (operation === 'tab_close') {
      const index = state.tabs.findIndex(t => t.id === tab.id), mode = args.mode || 'current';
      const ids = mode === 'others' ? state.tabs.filter(t => t.id !== tab.id).map(t => t.id) : mode === 'right' ? state.tabs.slice(index + 1).map(t => t.id) : [tab.id]; changed = !!ids.length; closeTabs(ids);
    } else if (operation === 'tab_reopen') { if (!state.closed.length) throw aiTabError('BROWSER_NO_CLOSED_TAB', '没有可恢复的标签'); if (!supported(state.closed.at(-1).url)) throw aiTabError('BROWSER_TAB_UNSUPPORTED', 'AI 不恢复本地或含凭据的页面'); reopenTab(); }
    else if (operation === 'tab_move') { if (!Number.isInteger(args.index) || args.index < 0 || args.index >= state.tabs.length) throw aiTabError('INVALID_TOOL_ARGS', '标签位置超出当前列表'); changed = tabStore.reorder(tab.id, state.tabs[args.index].id); renderTabs(); renderGroups(); storageStatus(); }
    // 活标签组：组不再保存网址快照，所以「保存当前标签为组 / 打开整组」改成了
    // 「把当前打开的标签收进一个新组」与「展开并切到组内第一个标签」。
    // AI 侧沿用同样的语义，避免出现两套互相矛盾的组操作。
    else if (operation === 'tab_group_save') {
      if (!state.tabs.every(t => supported(t.url))) throw aiTabError('BROWSER_TAB_UNSUPPORTED', '组中包含本地或含凭据的页面，未保存');
      const ungrouped = state.tabs.filter(t => t.url && !t.groupId);
      if (!ungrouped.length) throw aiTabError('INVALID_TOOL_ARGS', '没有未分组的标签可以收进新组');
      const result = tabStore.createGroup(ungrouped.map(t => t.id), args.name);
      if (!result.ok) throw aiTabError('BROWSER_SAVE_FAILED', result.error);
      renderTabs(); renderGroups();
    }
    else if (operation === 'tab_group_open') {
      const mates = state.tabs.filter(t => t.groupId === group.id);
      if (!mates.length) throw aiTabError('BROWSER_GROUP_NOT_FOUND', '这个组里没有标签了');
      if (!mates.every(t => supported(t.url))) throw aiTabError('BROWSER_TAB_UNSUPPORTED', '标签组包含本地或含凭据的页面，未打开');
      if (group.folded) tabStore.setGroupFolded(group.id, false);
      activateTab(mates[0].id); changed = true;
    }
    else if (operation === 'tab_group_rename') { const result = tabStore.renameGroup(group.id, args.name); if (!result.ok) throw aiTabError('BROWSER_SAVE_FAILED', result.error); renderTabs(); renderGroups(); }
    else if (operation === 'tab_group_delete') { const result = tabStore.ungroup(group.id); if (!result.ok) throw aiTabError('BROWSER_SAVE_FAILED', result.error); renderTabs(); renderGroups(); }
    else throw aiTabError('INVALID_TOOL_ARGS', '未知标签操作');
    if (['tab_open','tab_select','tab_reopen','tab_group_open'].includes(operation)) App.showTool('browser');
    if (tabStore.error) return { ...tabObservation(), ok: false, changed, committed: changed, errorCode: 'BROWSER_SAVE_FAILED', error: tabStore.error };
    return { ...tabObservation(), changed, committed: changed, note: '标签操作已完成；网页导航仍需 browser_state / browser_read 核对。' };
  }
  const mountedTabs = new Set(), tabRuntime = new Map(), foldedGroups = new Set();
  const IC_PAGE = IC('<rect x="3" y="2" width="10" height="12" rx="1.5"/><path d="M5.5 6h5M5.5 9h5"/>');
  const IC_CLOSE = IC('<path d="M4.5 4.5l7 7m0-7l-7 7"/>');
  const IC_OPEN = IC('<path d="M9 2h5v5m0-5L7 9M6 3H3v10h10v-3"/>');
  function storageStatus() {
    const el = document.getElementById('bw-save-status'); if (!el || !tabStore) return;
    el.hidden = !tabStore.error; el.replaceChildren();
    if (tabStore.error) {
      const text = document.createElement('span'); text.textContent = tabStore.error;
      const retry = document.createElement('button'); retry.className = 'tb-btn'; retry.textContent = '重试保存';
      retry.onclick = () => { const r = tabStore.save(); storageStatus(); if (!r.ok) MI.toast(r.error, 'err'); };
      el.append(text, retry);
    }
  }
  function saveTabs() { const result = tabStore?.save() || { ok: true }; storageStatus(); return result; }
  function setProject(root) {
    if (!tabStore || BrowserTabs.scopeKey(root) === tabStore.scope) { projectRoot = root; return; }
    saveTabs(); projectRoot = root; aiTabEpoch++;
    B()?.viewHide(); clearOverlayImage(); overlayHid = false;
    const key = BrowserTabs.scopeKey(root);
    if (!projectTabStores.has(key)) { const store = BrowserTabs.create(localStorage); store.load(root); projectTabStores.set(key, store); }
    tabStore = projectTabStores.get(key); renderTabs(); renderGroups(); storageStatus(); presentTab();
  }
  function syncTabStrip(reveal = false) {
    const list = document.getElementById('bw-tabs'), prev = document.getElementById('bw-tab-prev'), next = document.getElementById('bw-tab-next');
    if (!list || !prev || !next || !list.clientWidth) return;
    const gap = parseFloat(getComputedStyle(list.parentElement).gap) || 0;
    // 把滚动按钮占用的宽度还原后再判断，避免刚好放得下时按钮反复显隐。
    const available = list.clientWidth + (prev.hidden ? 0 : prev.offsetWidth + gap) + (next.hidden ? 0 : next.offsetWidth + gap);
    const required = [...list.children].reduce((total, item) => total + item.offsetWidth, 0) + Math.max(0, list.children.length - 1) * (parseFloat(getComputedStyle(list).gap) || 0);
    prev.hidden = next.hidden = required <= available + 1;
    if (reveal) {
      const active = list.querySelector('.bw-tab.active');
      if (active) {
        const edge = list.getBoundingClientRect(), tab = active.getBoundingClientRect();
        if (tab.left < edge.left) list.scrollLeft -= edge.left - tab.left;
        else if (tab.right > edge.right) list.scrollLeft += tab.right - edge.right;
      }
    }
    prev.disabled = list.scrollLeft <= 1;
    next.disabled = list.scrollLeft >= list.scrollWidth - list.clientWidth - 1;
  }
  function initTabStrip() {
    const list = document.getElementById('bw-tabs');
    const scroll = direction => { list.scrollLeft += direction * Math.max(176, list.clientWidth * .75); syncTabStrip(); };
    document.getElementById('bw-tab-prev').onclick = () => scroll(-1);
    document.getElementById('bw-tab-next').onclick = () => scroll(1);
    list.addEventListener('scroll', () => syncTabStrip());
    list.addEventListener('wheel', event => {
      if (event.ctrlKey || event.metaKey || list.scrollWidth <= list.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      list.scrollLeft += delta * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? list.clientWidth : 1);
      syncTabStrip();
    }, { passive: false });
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => syncTabStrip(true)).observe(list.parentElement);
    window.addEventListener('resize', () => syncTabStrip(true));
  }
  function renderTabs() {
    if (!tabStore) return;
    tabSignature();
    const list = document.getElementById('bw-tabs'), state = tabStore.state;
    const focused = document.activeElement?.closest('.bw-tab');
    const focusId = focused?.dataset.tabId, focusClose = document.activeElement?.classList.contains('bw-tab-close');
    const previousActive = list.querySelector('.bw-tab.active')?.dataset.tabId;
    const scroll = list.scrollLeft; list.replaceChildren();
    // 组按「首次出现的顺序」排，这样用户把标签拖进组或调顺序时，组不会乱跳。
    // 标签在组里必须连续：渲染时按组归拢，组外的保持原序穿插 —— 与 Edge 一致，
    // 标签栏上一眼就能看出「这几个是一伙的」。
    const groups = tabStore.groups();
    const groupById = new Map(groups.map(g => [g.id, g]));
    const rendered = new Set();
    const makeTab = (tab) => {
      rendered.add(tab.id);
      const group = tab.groupId ? groupById.get(tab.groupId) : null;
      const item = document.createElement('div'); item.className = 'bw-tab' + (state.active === tab.id ? ' active' : ''); item.dataset.tabId = tab.id; item.draggable = true;
      if (group) { item.classList.add('grouped'); item.dataset.groupColor = group.color || 'blue'; }
      const select = document.createElement('button'); select.className = 'bw-tab-select'; select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(state.active === tab.id)); select.tabIndex = visible && state.active === tab.id ? 0 : -1;
      select.title = (tab.title || '新标签页') + (tab.url ? '\n' + tab.url : '') + (group ? '\n组：' + group.name : ''); select.innerHTML = IC_PAGE;
      const favicon = tabRuntime.get(tab.id)?.favicon;
      if (favicon && /^https?:/i.test(favicon)) { const icon = document.createElement('img'); icon.className = 'bw-tab-favicon'; icon.alt = ''; icon.src = favicon; icon.onerror = () => { icon.remove(); select.classList.remove('has-favicon'); }; select.prepend(icon); select.classList.add('has-favicon'); }
      const label = document.createElement('span'); label.className = 'bw-tab-label'; label.textContent = tab.title || '新标签页'; select.append(label);
      select.onclick = () => activateTab(tab.id); select.onkeydown = event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); cycleTab(event.key === 'ArrowLeft' ? -1 : 1); document.querySelector('.bw-tab.active .bw-tab-select')?.focus(); } };
      const close = document.createElement('button'); close.className = 'bw-tab-close'; close.innerHTML = IC_CLOSE; close.title = '关闭标签'; close.setAttribute('aria-label', '关闭 ' + (tab.title || '新标签页')); close.onclick = event => { event.stopPropagation(); closeTabs([tab.id]); };
      item.append(select, close); item.onauxclick = event => { if (event.button === 1) { event.preventDefault(); closeTabs([tab.id]); } };
      item.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); openTabMenu(tab.id, event.clientX, event.clientY); };
      item.ondragstart = event => { draggingTab = tab.id; event.dataTransfer?.setData('text/plain', tab.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; item.classList.add('dragging'); };
      item.ondragover = event => { if (draggingTab) { event.preventDefault(); item.classList.add('drop-tab'); } };
      item.ondragleave = () => item.classList.remove('drop-tab');
      item.ondrop = event => {
        if (!draggingTab) return;
        event.preventDefault(); event.stopPropagation();
        const moving = draggingTab; draggingTab = null;
        // 拖到「属于不同组」的标签上时，连归属一起改 —— Edge 就是这样：位置走到哪、
        // 组籍跟到哪。同一组内拖动只调顺序，不碰 groupId（否则一次拖动会把整组
        // 的成员关系重算一遍，视觉上虽然一样但会多写一次存储）。
        const movingTab = state.tabs.find(t => t.id === moving);
        if (movingTab && moving !== tab.id && (movingTab.groupId || null) !== (tab.groupId || null)) {
          if (tab.groupId) tabStore.addToGroup(tab.groupId, [moving]);
          else tabStore.removeFromGroup([moving]);
        }
        tabStore.reorder(moving, tab.id);
        renderTabs(); renderGroups(); storageStatus();
      };
      item.ondragend = () => { draggingTab = null; document.querySelectorAll('.bw-tab.dragging,.bw-tab.drop-tab').forEach(el => el.classList.remove('dragging', 'drop-tab')); };
      if (tabRuntime.get(tab.id)?.loading) item.classList.add('loading');
      return item;
    };
    for (const tab of state.tabs) {
      if (rendered.has(tab.id)) continue;
      const group = tab.groupId ? groupById.get(tab.groupId) : null;
      if (!group) { list.append(makeTab(tab)); continue; }
      // 组的容器：折叠时只画组头，组内标签完全不渲染（但不会被关闭）。
      const box = document.createElement('div');
      box.className = 'bw-tab-group' + (group.folded ? ' folded' : '');
      box.dataset.groupId = group.id; box.dataset.groupColor = group.color || 'blue';
      const head = document.createElement('button');
      head.className = 'bw-tab-group-head'; head.type = 'button';
      head.title = group.name + '（点击' + (group.folded ? '展开' : '折叠') + '，不会关闭组内标签）';
      head.setAttribute('aria-expanded', String(!group.folded));
      head.innerHTML = '<span class="bw-tg-dot"></span><span class="bw-tg-name"></span><span class="bw-tg-count"></span>';
      head.querySelector('.bw-tg-name').textContent = group.name;
      // 折叠态给一个方向提示：只有圆点时，用户看不出「点了会展开还是收起」。
      const caret = document.createElement('span');
      caret.className = 'bw-tg-caret';
      caret.innerHTML = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="' + (group.folded ? 'M6 4l4 4-4 4' : 'M4 6l4 4 4-4') + '"/></svg>';
      head.append(caret);
      box.append(head);
      // 折叠时只画组头：组内标签完全不进 DOM（但仍在 state.tabs 里，不会被关掉）。
      // 内容仍在但用 CSS 隐藏会让 width/flex 计算把它们算进去，标签栏会留一条空的组带。
      if (!group.folded) for (const mate of state.tabs) {
        if (mate.groupId !== group.id) continue;
        box.append(makeTab(mate));
      }
      head.querySelector('.bw-tg-count').textContent = String(state.tabs.filter(t => t.groupId === group.id).length);
      head.onclick = event => { event.stopPropagation(); tabStore.setGroupFolded(group.id, !group.folded); renderTabs(); renderGroups(); };
      head.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); openGroupMenu(group.id, event.clientX, event.clientY); };
      // 把标签拖到组头上 = 加入这个组（不用先展开、也不用走菜单）。
      // 拖的是组内标签时，等同于「留在这个组」—— 只在位置上有意义，所以不重复处理。
      head.ondragover = event => { if (!draggingTab) return; event.preventDefault(); event.stopPropagation(); box.classList.add('drop-into-group'); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; };
      head.ondragleave = () => box.classList.remove('drop-into-group');
      head.ondrop = event => {
        if (!draggingTab) return;
        event.preventDefault(); event.stopPropagation();
        box.classList.remove('drop-into-group');
        const moving = draggingTab; draggingTab = null;
        const movingTab = state.tabs.find(t => t.id === moving);
        if (!movingTab || movingTab.groupId === group.id) return;
        tabStore.addToGroup(group.id, [moving]);
        renderTabs(); renderGroups(); storageStatus();
        MI.toast('已加入「' + group.name + '」', 'ok');
      };
      list.append(box);
    }
    list.scrollLeft = scroll;
    syncTabStrip(previousActive !== state.active);
    if (focusId && visible) list.querySelector('[data-tab-id="' + focusId + '"] ' + (focusClose ? '.bw-tab-close' : '.bw-tab-select'))?.focus({ preventScroll: true });
  }
  function presentTab() {
    const tab = tabStore.active, runtime = tabRuntime.get(tab.id) || {};
    if (!tab.url || !visible) B()?.selectTab?.(tab.id);
    currentUrl = tab.url; currentTitle = tab.title; hasPage = !!tab.url; urlInput.value = tab.url;
    document.getElementById('browser-empty').classList.toggle('hidden', hasPage);
    document.getElementById('browser-error').classList.toggle('hidden', !runtime.err);
    viewEl.classList.toggle('hidden', !hasPage); renderFavBtn(); renderDefaultButton();
    document.getElementById('bw-back').disabled = !runtime.canBack; document.getElementById('bw-fwd').disabled = !runtime.canFwd;
    setProg(runtime.loading ? '35%' : '0');
    if (!hasPage) { B()?.viewHide(); renderEmpty(); }
    else if (visible && !overlayOpen()) mountView(mountedTabs.has(tab.id) ? null : tab.url);
    if (runtime.err) document.getElementById('bw-err-msg').textContent = '加载失败：' + runtime.err;
  }
  function activateTab(tabId) {
    if (!tabStore.activate(tabId)) return;
    clearOverlayImage(); overlayHid = false; closeDd(); renderTabs(); renderGroups(); storageStatus(); presentTab();
    syncTabStrip(true);
  }
  function newTab(url = '', title = '', afterTabId = null, groupId = null) {
    const normalized = url ? normalizeInput(url) : '';
    if (!BrowserTabs.validURL(normalized)) { MI.toast('不支持的网页地址', 'err'); return; }
    const tab = tabStore.add(normalized, title, true, groupId);
    // 插到指定标签之后：add() 只会追加到末尾，这里用 reorder 把它挪到目标的下一位。
    // reorder(from,to) 的语义是「插到 to 之前」，所以要把目标下一个兄弟当作 to；
    // 目标本来就是最后一个时无需移动。
    if (afterTabId) {
      const tabs = tabStore.state.tabs;
      const target = tabs.findIndex(t => t.id === afterTabId);
      if (target >= 0 && target < tabs.length - 1) {
        const next = tabs[target + 1].id;
        if (next !== tab.id) tabStore.reorder(tab.id, next);
      }
    }
    renderTabs(); renderGroups(); storageStatus(); presentTab();
    if (!normalized) urlInput.focus(); return tab;
  }
  function closeTabs(ids) {
    const state = tabStore.state, existing = ids.filter(id => state.tabs.some(t => t.id === id)); if (!existing.length) return;
    const activeChanged = existing.includes(state.active); tabStore.close(existing);
    existing.forEach(id => { mountedTabs.delete(id); tabRuntime.delete(id); });
    Promise.resolve(B()?.closeTabs?.(existing)).catch(error => MI.toast('标签视图关闭失败：' + error.message, 'err'));
    renderTabs(); renderGroups(); storageStatus(); if (activeChanged) presentTab();
  }
  function reopenTab() { const tab = tabStore.reopen(); if (tab) { renderTabs(); renderGroups(); storageStatus(); presentTab(); } }
  function cycleTab(direction) { const state = tabStore.state, index = state.tabs.findIndex(t => t.id === state.active); activateTab(state.tabs[(index + direction + state.tabs.length) % state.tabs.length].id); }
  // 右键菜单。entry 支持 { label, run, disabled, danger } 与
  // { label, submenu: [{ label, run, color }] } —— 后者按 Edge 的做法在右侧展开一层，
  // 主菜单保持可见（「将标签页添加到组 ▸」就是这个形状，不是把整个菜单替换掉）。
  function tabMenu(items, x, y) {
    const menu = document.getElementById('ctx-menu'); menu.replaceChildren(); const scope = tabStore.scope;
    closeSubmenu(menu);
    for (const entry of items) {
      const button = document.createElement('button');
      button.className = 'ctx-item' + (entry.danger ? ' danger' : '') + (entry.submenu ? ' has-submenu' : '');
      button.disabled = !!entry.disabled;
      const label = document.createElement('span'); label.textContent = entry.label; button.append(label);
      if (entry.submenu) {
        const caret = document.createElement('span'); caret.className = 'ctx-sub-caret'; caret.textContent = '›';
        button.append(caret);
        // 悬停即展开（Edge/Chromium 一致），不要求先点一下
        button.onmouseenter = () => openSubmenu(menu, button, entry.submenu, entry.disabled);
        button.onclick = event => {
          event.stopPropagation();
          if (entry.disabled) return;
          openSubmenu(menu, button, entry.submenu, false);
        };
        menu.append(button);
        continue;
      }
      button.onclick = event => { event.stopPropagation(); closeSubmenu(menu); menu.classList.add('hidden'); if (scope === tabStore.scope) entry.run(); };
      menu.append(button);
    }
    menu.classList.remove('hidden');
    menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
    syncOverlay();
  }
  // 子菜单：复用同一个 ctx-menu 容器之外的独立浮层，避免替换掉主菜单内容。
  function closeSubmenu(menu) {
    const sub = document.getElementById('ctx-submenu');
    if (sub) sub.classList.add('hidden');
    menu?.querySelectorAll('.ctx-item.open').forEach(el => el.classList.remove('open'));
  }
  function openSubmenu(menu, button, items, disabled) {
    closeSubmenu(menu);
    if (disabled) return;
    let sub = document.getElementById('ctx-submenu');
    if (!sub) {
      sub = document.createElement('div');
      sub.id = 'ctx-submenu'; sub.className = 'ctx-submenu hidden'; sub.setAttribute('role', 'menu');
      document.body.append(sub);
    }
    sub.replaceChildren();
    for (const item of items) {
      const b = document.createElement('button');
      b.className = 'ctx-item'; b.type = 'button'; b.setAttribute('role', 'menuitem');
      if (item.color) {
        const dot = document.createElement('span'); dot.className = 'bw-add-group-dot'; dot.dataset.color = item.color;
        b.append(dot);
      }
      const span = document.createElement('span'); span.textContent = item.label; b.append(span);
      b.onclick = ev => {
        ev.stopPropagation();
        closeSubmenu(menu);
        menu.classList.add('hidden');
        item.run();
      };
      sub.append(b);
    }
    button.classList.add('open');
    sub.classList.remove('hidden');
    // 贴着触发项右侧展开；右边放不下就翻到左侧（和 ctx-menu 的贴边逻辑一致）
    const r = button.getBoundingClientRect();
    const w = sub.offsetWidth, h = sub.offsetHeight;
    // 与主菜单右边缘留 1px 重叠，避免中间一条空隙让人以为两个菜单不相干
    let left = r.right - 1;
    if (left + w > innerWidth - 8) left = Math.max(8, r.left - w + 1);
    let top = r.top - 4;
    if (top + h > innerHeight - 8) top = Math.max(8, innerHeight - h - 8);
    sub.style.left = left + 'px'; sub.style.top = top + 'px';
    syncOverlay();
  }
  function openTabMenu(tabId, x, y) {
    const state = tabStore.state, tab = state.tabs.find(t => t.id === tabId) || tabStore.active, index = state.tabs.findIndex(t => t.id === tab.id);
    const faved = !!tab.url && isFav(tab.url);
    const allGroups = tabStore.groups();
    const groupOfThisTab = tab.groupId ? allGroups.find(g => g.id === tab.groupId) : null;
    // 可以并入的组：除了它自己已经在的那个（活标签组里一个标签只属于一个组）。
    const groupTargets = allGroups.filter(g => g.id !== tab.groupId);
    tabMenu([
      // 收藏做成一个开关：已收藏时同一位置能取消，不用绕去侧栏找那一行。
      // 未收藏走 openFavPosMenu（可以顺便选文件夹），已收藏直接移除。
      faved
        ? { label: '🗑 取消收藏', run: () => { removeFav(tab.url); renderSidebar(); renderFavBtn(); renderEmpty(); MI.toast('已取消收藏', 'ok'); } }
        : { label: '⭐ 收藏此页', disabled: !tab.url, run: () => openFavPosMenu(tab.url, x, y, false) },
      { label: '📋 复制网址', disabled: !tab.url, run: () => { try { navigator.clipboard.writeText(tab.url); MI.toast('已复制网址', 'ok'); } catch { MI.toast('复制失败', 'err'); } } },
      { label: '↻ 刷新此标签', disabled: !tab.url, run: () => { activateTab(tab.id); reload(); } },
      // 以下两项对齐 Chrome 标签页右键的习惯位置：
      // 「在下方新建标签页」= 新建一个空白页，插在当前标签之后（不是末尾）；
      // 「复制标签页」= 克隆当前标签（同 url 同标题），插在它后面并切过去。
      { label: '在下方新建标签页', run: () => newTab('', '', tab.id) },
      { label: '复制标签页', disabled: !tab.url, run: () => newTab(tab.url, tab.title, tab.id) },
      // 活标签组：标签只能属于一个组，所以这里按 Edge 的两条路给出。
      // 未分组时是「将标签页添加到组 ▸」子菜单（列出已有组 + 新建组），
      // 已分组时是「从组中删除」—— 与 Edge 标签右键的两项完全对应。
      groupOfThisTab
        ? { label: '从组中删除', run: () => { const r = tabStore.removeFromGroup([tab.id]); if (!r.ok) { MI.toast(r.error, 'err'); return; } renderTabs(); renderGroups(); MI.toast('已从组中移除', 'ok'); } }
        : {
            label: '将标签页添加到组',
            submenu: [
              ...groupTargets.map(g => ({
                label: g.name, color: g.color,
                run: () => {
                  const r = tabStore.addToGroup(g.id, [tab.id]);
                  if (!r.ok) { MI.toast(r.error, 'err'); return; }
                  renderTabs(); renderGroups(); MI.toast('已加入「' + g.name + '」', 'ok');
                },
              })),
              // 「新建组」放在子菜单末尾，带分隔线视觉（CSS :last-child 处理）
              { label: '＋ 新建组', run: () => { openNewGroupPopover([tab], x, y); } },
            ],
          },
      { label: '将所有标签保存为一组…', disabled: !state.tabs.some(t => t.url), run: () => saveTabGroup() },
      { label: '重新打开关闭的标签', disabled: !state.closed.length, run: reopenTab },
      { label: '关闭其他标签', disabled: state.tabs.length < 2, run: () => closeTabs(state.tabs.filter(t => t.id !== tab.id).map(t => t.id)) },
      { label: '关闭右侧标签', disabled: index === state.tabs.length - 1, run: () => closeTabs(state.tabs.slice(index + 1).map(t => t.id)) },
      { label: '关闭标签', run: () => closeTabs([tab.id]) },
    ], x, y);
  }
  // snapshot 省略 = 保存全部已打开标签（顶部 ＋ 按钮与「将所有标签保存为一组…」）；
  // 传入 [tab] = 只把这一个标签存成新组（右键「将标签页添加到新组…」）。
  // 新建组：贴着右键位置弹出的小浮层（颜色圆点 + 组名输入 + 回车确认），
  // 不是屏幕中间的模态框 —— Edge 就是这么做的：新建组是菜单里的一个延续动作，
  // 弹一个带遮罩的居中对话框会让人以为离开了当前上下文。
  function openNewGroupPopover(snapshot, x, y) {
    const picked = (snapshot || [tabStore.active]).filter(t => t && t.url);
    if (!picked.length) { MI.toast('先把网页打开再分组', 'err'); return; }
    const menu = document.getElementById('ctx-menu');
    menu.replaceChildren();
    menu.className = 'bw-new-group-menu';
    delete menu.dataset.toolOwner;
    let color = 'blue';

    const nameInput = document.createElement('input');
    nameInput.type = 'text'; nameInput.className = 'bw-new-group-name';
    nameInput.placeholder = '组名'; nameInput.maxLength = 60;
    nameInput.value = '';
    nameInput.setAttribute('aria-label', '标签组名称');

    const row = document.createElement('div'); row.className = 'bw-color-row';
    const dots = {};
    for (const c of (window.BrowserTabs?.GROUP_COLORS || ['blue', 'cyan', 'purple', 'pink', 'green', 'yellow', 'orange', 'grey'])) {
      const dot = document.createElement('button');
      dot.type = 'button'; dot.className = 'bw-color-dot'; dot.dataset.color = c;
      dot.title = c; dot.setAttribute('aria-label', '颜色 ' + c);
      dot.classList.toggle('sel', c === color);
      dot.onclick = event => {
        event.stopPropagation();
        color = c;
        for (const [key, el] of Object.entries(dots)) el.classList.toggle('sel', key === c);
        nameInput.focus();
      };
      dots[c] = dot; row.append(dot);
    }

    const actions = document.createElement('div'); actions.className = 'bw-new-group-actions';
    const addTabBtn = document.createElement('button');
    addTabBtn.type = 'button'; addTabBtn.className = 'bw-new-group-item';
    addTabBtn.textContent = '在组中新建标签页';
    const createBtn = document.createElement('button');
    createBtn.type = 'button'; createBtn.className = 'bw-new-group-item primary';
    createBtn.textContent = '创建组';
    actions.append(addTabBtn, createBtn);

    const hint = document.createElement('div'); hint.className = 'bw-new-group-hint';
    hint.textContent = picked.length + ' 个标签 · 回车确认';

    menu.append(nameInput, row, actions, hint);

    const submit = (createInner = false) => {
      if (!menu.isConnected || menu.classList.contains('hidden')) return;
      const name = nameInput.value.trim() || '新组';
      const r = tabStore.createGroup(picked.map(t => t.id), name, color);
      menu.classList.add('hidden');
      if (!r.ok) { MI.toast(r.error, 'err'); return; }
      if (createInner) {
        // 「在组中新建标签页」：建组之后再开一个空白页并归入该组
        newTab('', '', null, r.group.id);
      } else {
        renderTabs(); renderGroups();
      }
      MI.toast('已新建组「' + r.group.name + '」', 'ok');
    };
    createBtn.onclick = event => { event.stopPropagation(); submit(false); };
    addTabBtn.onclick = event => { event.stopPropagation(); submit(true); };
    nameInput.onkeydown = event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); submit(false); }
      else if (event.key === 'Escape') { event.preventDefault(); menu.classList.add('hidden'); }
    };
    // 点面板外面关闭（与 ctx-menu 其它用法一致）
    const onDown = event => { if (!menu.contains(event.target)) { menu.classList.add('hidden'); document.removeEventListener('pointerdown', onDown, true); } };
    document.addEventListener('pointerdown', onDown, true);

    menu.classList.remove('hidden');
    menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
    syncOverlay();
    nameInput.focus();
  }

  // 「把标签收进一个组」：Edge 的活标签组语义 —— 标签本身被打上 groupId，
  // 不再另存一份快照。snapshot 省略 = 当前活动标签（右键单个标签 / 顶部 ＋），
  // 传入数组 = 那一批标签（「将所有标签保存为一组…」）。
  // 新建标签组：统一走贴边浮层（openNewGroupPopover），不再弹居中模态框。
  // 第二个参数是浮层出现的坐标；省略时贴着侧栏中部出现（顶部 ＋ 按钮走的路径）。
  function saveTabGroup(snapshot, x, y) {
    const picked = (snapshot || [tabStore.active]).filter(t => t && t.url);
    if (!picked.length) { MI.toast('先把网页打开再分组', 'err'); return; }
    const anchor = document.querySelector('#bw-side-groups') || document.getElementById('bw-tabs');
    const r = anchor ? anchor.getBoundingClientRect() : null;
    openNewGroupPopover(picked,
      Number.isFinite(x) ? x : (r ? Math.round(r.left) + 12 : 40),
      Number.isFinite(y) ? y : (r ? Math.round(r.bottom) + 6 : 80));
  }
  // 点组头 = 折叠/展开，不涉及「打开」。保留这个名字给旧调用点（AI 工具 / 菜单）兜底：
  // 活标签组里「打开整组」已经没有意义了 —— 组内标签本来就在标签栏里。
  function openTabGroup(id) {
    const group = tabStore.groups().find(g => g.id === id);
    if (!group) return;
    const mates = tabStore.state.tabs.filter(t => t.groupId === id);
    if (!mates.length) { MI.toast('这个组里没有标签了', 'err'); return; }
    // 折叠状态下点「打开整组」= 展开并切到第一个标签，行为可预期。
    if (group.folded) tabStore.setGroupFolded(id, false);
    activateTab(mates[0].id);
  }
  // 组头右键：对齐 Edge 的组操作。与「标签右键」是两份菜单 —— 组有自己的生命周期
  // （重命名 / 改色 / 取消组合 / 关闭组内标签），混进标签菜单会让人分不清作用对象。
  function openGroupMenu(groupId, x, y) {
    const group = tabStore.groups().find(g => g.id === groupId);
    if (!group) return;
    const mates = tabStore.state.tabs.filter(t => t.groupId === groupId);
    tabMenu([
      { label: '新标签加入此组', run: () => newTab('', '', mates[mates.length - 1]?.id || null, groupId) },
      { label: '重命名组…', run: async () => { const name = await Modal.prompt('重命名标签组', '组名', group.name); if (!name) return; const r = tabStore.renameGroup(groupId, name); if (!r.ok) { MI.toast(r.error, 'err'); return; } renderTabs(); renderGroups(); } },
      { label: '更改颜色…', run: () => openColorPicker(groupId, x, y) },
      { label: group.folded ? '展开组' : '折叠组（不关闭标签）', run: () => { tabStore.setGroupFolded(groupId, !group.folded); renderTabs(); renderGroups(); } },
      { label: '取消组合', run: async () => { if (!await Modal.confirm('取消组合', '取消「' + group.name + '」的分组？标签会保留在标签栏里。')) return; const r = tabStore.ungroup(groupId); if (!r.ok) { MI.toast(r.error, 'err'); return; } renderTabs(); renderGroups(); MI.toast('已取消组合', 'ok'); } },
      { label: '关闭组内标签', danger: true, run: async () => { if (!await Modal.confirm('关闭组内标签', '关闭「' + group.name + '」里的 ' + mates.length + ' 个标签？此操作不可撤销。')) return; closeTabs(mates.map(t => t.id)); } },
    ], x, y);
  }
  // 组色选择：Edge 是一排圆点。这里用小面板而不是 Modal.prompt —— 颜色是「看一眼就选」
  // 的动作，弹一个带输入框的对话框反而更慢。
  function openColorPicker(groupId, x, y) {
    const group = tabStore.groups().find(g => g.id === groupId);
    if (!group) return;
    const menu = document.getElementById('ctx-menu');
    menu.replaceChildren();
    menu.className = 'bw-color-menu';
    delete menu.dataset.toolOwner;
    const row = document.createElement('div');
    row.className = 'bw-color-row';
    for (const color of (window.BrowserTabs?.GROUP_COLORS || ['blue', 'cyan', 'purple', 'pink', 'green', 'yellow', 'orange', 'grey'])) {
      const dot = document.createElement('button');
      dot.type = 'button'; dot.className = 'bw-color-dot'; dot.dataset.color = color;
      dot.title = color; dot.setAttribute('aria-label', '颜色 ' + color);
      dot.classList.toggle('sel', group.color === color);
      dot.onclick = event => {
        event.stopPropagation();
        const r = tabStore.setGroupColor(groupId, color);
        menu.classList.add('hidden');
        if (!r.ok) { MI.toast(r.error, 'err'); return; }
        renderTabs(); renderGroups();
      };
      row.append(dot);
    }
    menu.append(row);
    menu.classList.remove('hidden');
    menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
  }
  function switchSidebar(mode) {
    sidebarMode = mode;
    document.getElementById('bw-side-groups').setAttribute('aria-selected', String(mode === 'groups'));
    document.getElementById('bw-side-favorites').setAttribute('aria-selected', String(mode === 'favorites'));
    document.getElementById('bw-groups-list').classList.toggle('hidden', mode !== 'groups'); sbListEl.classList.toggle('hidden', mode !== 'favorites');
    const add = document.getElementById('bw-sb-add-folder'); add.title = mode === 'groups' ? '保存当前标签组' : '新建收藏文件夹'; add.setAttribute('aria-label', add.title);
    renderGroups(); renderSidebar();
  }
  // 侧栏「标签组」列表：与 Edge 一样是**内联**的 —— 组头和组内标签在同一个列表里
  // 按标签的真实顺序排，未分组的标签穿插其间；组本身可以拖动改变位置。
  //
  // 之前写成「上面当前打开 / 下面标签组」两块独立区域，是理解错了：那样组的位置
  // 与标签顺序脱钩，用户拖动组时无法预期会落到哪。现在组的位置 = 它第一个成员在
  // state.tabs 里的位置，拖动组头就是把整组挪到目标位置（组内顺序不变）。
  function renderGroups() {
    const list = document.getElementById('bw-groups-list'); if (!list || !tabStore) return; list.replaceChildren();
    tabSignature();
    let groups;
    try { groups = tabStore.groups(); } catch (error) {
      const note = document.createElement('p'); note.className = 'bw-sb-none'; note.textContent = error.message; list.append(note); return;
    }
    const state = tabStore.state;
    const groupById = new Map(groups.map(g => [g.id, g]));
    const captions = document.createElement('div'); captions.className = 'bw-group-caption';
    captions.innerHTML = '<span>当前打开</span><span>自动保留</span>';
    list.append(captions);

    const renderedTabs = new Set(), renderedGroups = new Set();
    // 单条标签行：组内和组外共用同一套骨架，只有内边距不同。
    const tabRow = (tab, inGroup) => {
      const row = document.createElement('div');
      row.className = 'bw-session-tab' + (inGroup ? ' bw-live-tab' : '') + (tab.id === state.active ? ' active' : '');
      row.dataset.tabId = tab.id;
      row.setAttribute('role', 'button'); row.tabIndex = 0;
      const pick = () => activateTab(tab.id);
      row.onclick = pick;
      row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); } };
      const ico = document.createElement('span'); ico.className = 'bw-session-ico'; ico.innerHTML = IC_PAGE;
      const nm = document.createElement('span'); nm.className = 'bw-session-name'; nm.textContent = tab.title || '新标签页';
      const cls = document.createElement('button');
      cls.className = 'bw-session-close'; cls.innerHTML = IC_CLOSE; cls.title = '关闭标签';
      cls.setAttribute('aria-label', '关闭 ' + (tab.title || '新标签页'));
      cls.onclick = event => { event.stopPropagation(); closeTabs([tab.id]); };
      cls.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); };
      row.append(ico, nm, cls);
      row.title = tab.url || '新标签页';
      row.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); openTabMenu(tab.id, event.clientX, event.clientY); };

      // 拖动：既排序也改组籍（与顶部标签栏共用 source 变量，两处拖拽互不干扰）
      row.draggable = true;
      row.addEventListener('dragstart', event => {
        draggingSessionTab = tab.id; draggingGroup = null;
        try { event.dataTransfer.setData('text/plain', tab.id); event.dataTransfer.effectAllowed = 'move'; } catch {}
        row.classList.add('dragging-src');
      });
      row.addEventListener('dragend', () => {
        draggingSessionTab = null; row.classList.remove('dragging-src'); clearSessionDropMarks();
      });
      row.addEventListener('dragover', event => {
        if (!draggingSessionTab || draggingSessionTab === tab.id) return;
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        const r = row.getBoundingClientRect();
        const after = !!r.height && event.clientY - r.top > r.height / 2;
        clearSessionDropMarks();
        row.classList.add(after ? 'drop-after' : 'drop-before');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
      row.addEventListener('drop', event => {
        event.preventDefault(); event.stopPropagation();
        const src = draggingSessionTab; draggingSessionTab = null;
        const r = row.getBoundingClientRect();
        const after = !!r.height && event.clientY - r.top > r.height / 2;
        clearSessionDropMarks();
        if (!src || src === tab.id) return;
        const movingTab = state.tabs.find(t => t.id === src);
        // 落到组籍不同的行上时连归属一起改（拖到组外标签 = 脱离）
        if (movingTab && (movingTab.groupId || null) !== (tab.groupId || null)) {
          if (tab.groupId) tabStore.addToGroup(tab.groupId, [src]);
          else tabStore.removeFromGroup([src]);
        }
        reorderAfter(src, tab.id, after);
        renderTabs(); renderGroups(); storageStatus();
      });
      return row;
    };

    const groupBox = group => {
      const mates = state.tabs.filter(t => t.groupId === group.id);
      const box = document.createElement('div');
      box.className = 'bw-live-group' + (group.folded ? ' folded' : '');
      box.dataset.groupId = group.id; box.dataset.groupColor = group.color || 'blue';
      const head = document.createElement('div'); head.className = 'bw-live-group-head';
      const caret = document.createElement('button');
      caret.className = 'bw-live-caret'; caret.type = 'button';
      caret.setAttribute('aria-expanded', String(!group.folded));
      caret.title = group.folded ? '展开组（不会关闭标签）' : '折叠组（不会关闭标签）';
      caret.innerHTML = IC('<path d="' + (group.folded ? 'M6 4l4 4-4 4' : 'M4 6l4 4 4-4') + '"/>');
      caret.onclick = event => { event.stopPropagation(); const r = tabStore.setGroupFolded(group.id, !group.folded); if (!r.ok) { MI.toast(r.error, 'err'); return; } renderTabs(); renderGroups(); };
      const dot = document.createElement('span'); dot.className = 'bw-live-dot';
      const name = document.createElement('span'); name.className = 'bw-live-name'; name.textContent = group.name; name.title = group.name;
      const count = document.createElement('span'); count.className = 'bw-live-count'; count.textContent = String(mates.length);
      const more = document.createElement('button');
      more.className = 'bw-live-more'; more.type = 'button'; more.title = '组操作';
      more.setAttribute('aria-label', '标签组操作 ' + group.name);
      more.innerHTML = IC('<circle cx="3" cy="8" r=".75"/><circle cx="8" cy="8" r=".75"/><circle cx="13" cy="8" r=".75"/>');
      const openMenu = event => { event.preventDefault(); event.stopPropagation(); openGroupMenu(group.id, event.clientX, event.clientY); };
      more.onclick = openMenu;
      const label = document.createElement('button');
      label.className = 'bw-live-label'; label.type = 'button';
      label.append(dot, name, count);
      label.title = group.name + '（' + mates.length + ' 个标签）';
      label.onclick = () => { const r = tabStore.setGroupFolded(group.id, !group.folded); if (!r.ok) { MI.toast(r.error, 'err'); return; } renderTabs(); renderGroups(); };
      head.append(caret, label, more);
      head.oncontextmenu = openMenu;
      // 组头可拖动：整组挪位置（组内顺序不变）。与标签行共用一套落点标记。
      head.draggable = true;
      head.addEventListener('dragstart', event => {
        draggingSessionTab = null; draggingGroup = group.id;
        try { event.dataTransfer.setData('text/plain', group.id); event.dataTransfer.effectAllowed = 'move'; } catch {}
        box.classList.add('dragging-src');
      });
      head.addEventListener('dragend', () => { draggingGroup = null; box.classList.remove('dragging-src'); clearSessionDropMarks(); });
      head.addEventListener('dragover', event => {
        // 拖标签到组头上 = 加入该组；拖另一组过来 = 当作落点排序。
        if (!draggingSessionTab && !draggingGroup) return;
        if (draggingSessionTab) {
          event.preventDefault(); event.stopPropagation();
          clearSessionDropMarks();
          box.classList.add('drop-into-group');
          return;
        }
        if (draggingGroup === group.id) return;
        event.preventDefault(); event.stopPropagation();
        const r = box.getBoundingClientRect();
        clearSessionDropMarks();
        box.classList.add(event.clientY - r.top > r.height / 2 ? 'drop-after' : 'drop-before');
      });
      head.addEventListener('dragleave', () => { box.classList.remove('drop-into-group'); box.classList.remove('drop-before', 'drop-after'); });
      head.addEventListener('drop', event => {
        event.preventDefault(); event.stopPropagation();
        box.classList.remove('drop-into-group');
        if (draggingSessionTab) {
          const src = draggingSessionTab; draggingSessionTab = null; clearSessionDropMarks();
          const movingTab = state.tabs.find(t => t.id === src);
          if (movingTab && movingTab.groupId !== group.id) {
            tabStore.addToGroup(group.id, [src]);
            renderTabs(); renderGroups(); storageStatus();
            MI.toast('已加入「' + group.name + '」', 'ok');
          }
          return;
        }
        const srcGroup = draggingGroup; draggingGroup = null; clearSessionDropMarks();
        if (!srcGroup || srcGroup === group.id) return;
        moveGroupBefore(srcGroup, group.id);
        renderTabs(); renderGroups(); storageStatus();
      });
      box.append(head);
      if (!group.folded) for (const tab of mates) box.append(tabRow(tab, true));
      return box;
    };

    // 按 state.tabs 的顺序走：遇到组就整组画出并跳过其全部成员，
    // 于是组在列表里的位置 = 它第一个成员的位置，与标签栏顺序一致。
    for (const tab of state.tabs) {
      const group = tab.groupId ? groupById.get(tab.groupId) : null;
      if (group) {
        if (renderedGroups.has(group.id)) continue;
        renderedGroups.add(group.id);
        // ⚠ 必须把组内每个成员都记进 renderedTabs：否则下面的兜底循环
        // 会把它们当成「还没画过」再画一遍，出现同一个标签在组里和组外各一条
        // （实测截图里 b.test 就是这么重复的）。
        for (const mate of state.tabs) if (mate.groupId === group.id) renderedTabs.add(mate.id);
        list.append(groupBox(group));
        continue;
      }
      if (renderedTabs.has(tab.id)) continue;
      renderedTabs.add(tab.id);
      list.append(tabRow(tab, false));
    }
    // 兜底：groupId 指向已不存在的组时仍画成普通标签，别让标签凭空消失。
    for (const tab of state.tabs) {
      if (renderedTabs.has(tab.id)) continue;
      renderedTabs.add(tab.id);
      list.append(tabRow(tab, false));
    }
  }
  function syncBounds() {
    if (!viewEl || viewEl.classList.contains('hidden')) return;
    const r = viewEl.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return; // 布局未就绪/不可见不报
    const b = B(); if (b) b.viewBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
  }
  // 容器刚从 display:none 恢复时 rect 要下一帧才有效
  function mountView(url) {
    const b = B(); if (!b) return;
    const tabId = tabStore?.active.id;
    if (tabId) mountedTabs.add(tabId);
    b.viewOpen(url || null, tabId).then(r => { if (r?.error) { mountedTabs.delete(tabId); if (tabStore?.active.id === tabId) showError(r.error); } }).catch(error => { mountedTabs.delete(tabId); if (tabStore?.active.id === tabId) showError(error.message); });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      syncBounds();
      if (url) { const bb = B(); if (bb) bb.viewNav('focus'); } // 加载新页后聚焦网页（可立即滚轮/键盘）
    }));
  }

  // ---------- HTML 浮层遮挡规避 ----------
  // WebContentsView 是原生层，永远盖在窗口 HTML 之上：Modal 弹窗 / ctx-menu 右键菜单
  // 落到网页区域就被整个盖住（实测：「新建收藏文件夹」弹窗只剩侧栏边上一条）。
  // 通用规避：任何浮层可见期间摘掉 view（实例保留），全部关闭后挂回。
  function overlayOpen() {
    const mask = document.getElementById('modal-mask');
    const menu = document.getElementById('ctx-menu');
    const sub = document.getElementById('ctx-submenu');
    // 子菜单也是浮在网页上的 HTML 层，WebContentsView 会盖住它 —— 必须一起算进 overlay。
    return !!(mask && !mask.classList.contains('hidden'))
      || !!(menu && !menu.classList.contains('hidden'))
      || !!(sub && !sub.classList.contains('hidden'))
      || !!(ddEl && !ddEl.classList.contains('hidden'));
  }
  let overlayHid = false; // 当前因浮层主动摘掉 view（与面板自身隐藏区分开）
  let overlayRevision=0,overlayImage=null;
  function clearOverlayImage(){overlayRevision++;overlayImage?.remove();overlayImage=null;}
  function syncOverlay() {
    if (!visible || !hasPage) return;
    const b = B(); if (!b) return;
    if (overlayOpen()) {
      if (!overlayHid) {
        overlayHid=true;const revision=++overlayRevision;
        Promise.resolve(b.viewHide({snapshot:true,focus:!ddEl||ddEl.classList.contains('hidden')})).then(result=>{
          if(revision!==overlayRevision||!visible||!overlayHid||!overlayOpen()||!result?.image)return;
          overlayImage?.remove();overlayImage=document.createElement('img');overlayImage.className='bw-overlay-snapshot';overlayImage.alt='';overlayImage.setAttribute('aria-hidden','true');overlayImage.src=result.image;viewEl.append(overlayImage);
        }).catch(()=>{});
      }
    } else if (overlayHid) {
      overlayHid = false;
      clearOverlayImage();
      mountView(tabStore && !mountedTabs.has(tabStore.active.id) ? tabStore.active.url : null);
    }
  }

  // ---------- 主进程状态回推 ----------
  function onState(s) {
    if (!s) return;
    if (s.tabId && tabStore) {
      const owner = [...projectTabStores.values()].find(store => store.state.tabs.some(t => t.id === s.tabId));
      if (!owner) return;
      const runtime = {...tabRuntime.get(s.tabId), ...s}; if (s.navigated || s.loading === true) delete runtime.err; tabRuntime.set(s.tabId, runtime);
      const patch = {};
      if (s.navigated && s.url && BrowserTabs.validURL(s.url)) patch.url = s.url;
      if (s.title) patch.title = s.title;
      if (Object.keys(patch).length) owner.update(s.tabId, patch);
      if (owner !== tabStore) return;
      storageStatus();
      renderTabs(); renderGroups();
      if (s.tabId !== tabStore.active.id) return;
    }
    if(s.colorSchemeError)MI.toast('网页深色未生效：'+s.colorSchemeError,'err');
    if(s.fullscreen!=null){if(!s.fullscreen){fullscreenWanted=false;applyFullscreen(false);}else if(visible&&fullscreenWanted)applyFullscreen(true);}
    if (s.err) { showError(s.err); return; }
    if (tabStore && !s.tabId) { const patch = {}; if (s.navigated && s.url && BrowserTabs.validURL(s.url)) patch.url = s.url; if (s.title) patch.title = s.title; if (Object.keys(patch).length) { tabStore.update(tabStore.active.id, patch); renderTabs(); renderGroups(); storageStatus(); } }
    if (s.navigated && s.url) {
      currentUrl = s.url;
      renderDefaultButton();
      if (document.activeElement !== urlInput) urlInput.value = currentUrl;
      document.getElementById('browser-error').classList.add('hidden');
      if (!s.inPage) addHistory(currentUrl, currentTitle);
    }
    if (s.title != null) {
      currentTitle = s.title;
      // 同步最近一条历史的标题
      const list = history();
      if (list[0] && list[0].url === currentUrl) { list[0].title = currentTitle; saveJSON(HISTORY_KEY, list); }
      if (isFav(currentUrl)) { const l = favs(); const f = l.find((x) => x.url === currentUrl); if (f && !f.custom) { f.title = currentTitle || f.title; saveJSON(FAV_KEY, l); } }
    }
    if (s.canBack != null) document.getElementById('bw-back').disabled = !s.canBack;
    if (s.canFwd != null) document.getElementById('bw-fwd').disabled = !s.canFwd;
    renderFavBtn();
    if (s.loading != null) {
      if (s.loading) setProg('35%');
      else { setProg('100%'); setTimeout(() => { if (progEl().style.width === '100%') setProg('0'); }, 250); }
    }
    if (s.progress != null) setProg(Math.round(Math.max(0, Math.min(1, Number(s.progress) || 0)) * 100) + '%');
  }
  const progEl = () => document.getElementById('bw-prog');
  const setProg = (w) => { progEl().style.width = w; };

  function showError(msg) {
    document.getElementById('bw-err-msg').textContent = '加载失败：' + msg;
    document.getElementById('browser-empty').classList.add('hidden');
    viewEl.classList.remove('hidden');
    document.getElementById('browser-error').classList.remove('hidden');
    MI.toast('页面加载失败：' + msg, 'err');
  }
  function renderFavBtn() {
    const faved = currentUrl && isFav(currentUrl);
    favBtn.textContent = faved ? '★' : '☆';
    favBtn.classList.toggle('faved', !!faved);
    favBtn.title = faved ? '取消收藏：' + (currentTitle || currentUrl) : '收藏当前页';
  }
  function renderDefaultButton(){const button=document.getElementById('bw-open-default');if(button)button.disabled=defaultOpening||!/^https?:\/\//i.test(currentUrl);}
  async function openDefault(){
    if(defaultOpening)return;defaultOpening=true;renderDefaultButton();
    try{const b=B();if(!b?.openDefault)throw Error('默认浏览器接口不可用');const result=await b.openDefault();if(!result?.ok)throw Error(result?.error||'打开默认浏览器失败');return result;}
    catch(error){MI.toast(error.message,'err');return {ok:false,error:error.message};}
    finally{defaultOpening=false;renderDefaultButton();}
  }

  // ---------- 网页深色（工具栏按钮三态循环：深色 → 浅色 → 跟随系统） ----------
  function renderDarkBtn() {
    if (!darkBtnEl) return;
    const m = DARK_META[darkMode] || DARK_META.dark;
    darkBtnEl.innerHTML = m.icon;
    darkBtnEl.title = m.tip + '（点击切换）';
    // 「跟随系统」不点亮：只有明确深色才算"开着"，否则看不出当前是哪种
    darkBtnEl.classList.toggle('active', darkMode === 'dark');
  }
  function applyDarkMode(mode, persist) {
    darkMode = DARK_ORDER.includes(mode) ? mode : 'dark';
    if (persist) { try { localStorage.setItem(DARK_KEY, darkMode); } catch {} }
    const b = B();
    if (b && b.setColorScheme) Promise.resolve(b.setColorScheme(darkMode)).then(result=>{if(result?.error)MI.toast('网页深色未生效：'+result.error,'err');}).catch(error=>MI.toast('网页深色未生效：'+error.message,'err'));
    renderDarkBtn();
  }
  function cycleDarkMode() {
    const i = DARK_ORDER.indexOf(darkMode);
    applyDarkMode(DARK_ORDER[(i + 1) % DARK_ORDER.length], true);
  }
  // 首次使用跟着 IDE 主题走（IDE 深色 → 网页也深色），之后听用户自己的
  function initDarkMode() {
    let saved = null;
    try { saved = localStorage.getItem(DARK_KEY); } catch {}
    if (DARK_ORDER.includes(saved)) { applyDarkMode(saved, false); return; }
    let ideDark = true;
    try { ideDark = Theme.current() !== 'light'; } catch {}
    applyDarkMode(ideDark ? 'dark' : 'light', false);
  }

  // ---------- 导航 ----------
  function go(url) {
    const u = normalizeInput(url);
    if (!u) return;
    if (!BrowserTabs.validURL(u)) { MI.toast('不支持的网页地址', 'err'); return; }
    if (tabStore) { tabStore.update(tabStore.active.id, {url:u, ...(u !== currentUrl ? {title:u} : {})}); tabRuntime.delete(tabStore.active.id); renderTabs(); renderGroups(); storageStatus(); }
    document.getElementById('browser-empty').classList.add('hidden');
    document.getElementById('browser-error').classList.add('hidden');
    viewEl.classList.remove('hidden');
    hasPage = true;
    const previousUrl=currentUrl; currentUrl=u;
    if (u === previousUrl && hasPage) { // 同址再回车 = 刷新
      const b = B(); if (b) b.viewNav('reload');
      syncBounds();
    } else {
      mountView(u);
    }
    urlInput.value = u;
    closeDd();
  }
  function back() { const b = B(); if (b) b.viewNav('back'); }
  function forward() { const b = B(); if (b) b.viewNav('forward'); }
  function reload() { if (currentUrl) { const b = B(); if (b) b.viewNav('reload'); } else if (urlInput.value) go(urlInput.value); }
  function home() { go(HOME); }

  // ---------- 面板显隐 ----------
  function syncToolBtn() {
    const b = document.getElementById('tool-browser');
    if (b) b.classList.toggle('active', visible);
  }
  // 周期自愈：bounds 可能因布局时序/DPI 变化残留旧值 → 可见期间定期重报 rect（廉价，修正一切漂移）
  let healTimer = null;
  function startHeal() {
    stopHeal();
    healTimer = setInterval(() => syncBounds(), 1000);
  }
  function stopHeal() {
    if (healTimer) { clearInterval(healTimer); healTimer = null; }
  }
  function show() {
    if (visible) return;
    visible = true;
    panel.classList.remove('hidden');
    syncToolBtn();
    renderSidebar(); // 收藏列表在左侧栏 panel-browser（App.renderToolStrip 控制显隐）
    if (tabStore) { renderTabs(); syncTabStrip(true); renderGroups(); storageStatus(); presentTab(); startHeal(); closeDd(); return; }
    if (hasPage) { // 恢复网页显示（view 实例保留在主进程，登录态不丢）
      document.getElementById('browser-empty').classList.add('hidden');
      viewEl.classList.remove('hidden');
      if (overlayOpen()) { overlayHid = true; } // 浮层开着：先不挂 view，浮层关闭时 syncOverlay 统一恢复
      else mountView(null);
    } else {
      document.getElementById('browser-empty').classList.remove('hidden');
      viewEl.classList.add('hidden');
      renderEmpty();
    }
    startHeal();
    closeDd();
  }
  function hide() {
    if (!visible) return;
    saveTabs();
    visible = false;
    renderTabs();
    if(fullscreen||fullscreenWanted)setFullscreen(false);
    overlayHid = false; // 面板隐藏本身就摘了 view，状态复位
    clearOverlayImage();
    panel.classList.add('hidden');
    syncToolBtn();
    closeDd();
    stopHeal();
    const b = B(); if (b) b.viewHide(); // 只摘掉显示，WebContentsView 保留
  }
  // 所有用户入口都经过 App；只显示原生视图会让 activeTool 留在旧页，之后文件切换无法摘掉它。
  function toggle() { App.switchTool('browser'); }
  function open(url) {
    const normalized=normalizeInput(url);
    if(!normalized||!BrowserTabs.validURL(normalized)){if(normalized)MI.toast('不支持的网页地址','err');return;}
    if(!visible&&tabStore){
      tabStore.update(tabStore.active.id,{url:normalized,title:normalized});mountedTabs.delete(tabStore.active.id);tabRuntime.delete(tabStore.active.id);
      App.showTool('browser');if(!visible)show();return;
    }
    App.showTool('browser');if(!visible)show();go(normalized);
  }

  function applyFullscreen(enabled){
    fullscreen=!!enabled;document.body.classList.toggle('browser-fullscreen',fullscreen);
    const button=document.getElementById('bw-fullscreen');if(button){button.classList.toggle('active',fullscreen);button.setAttribute('aria-pressed',String(fullscreen));button.title=fullscreen?'退出浏览器全屏 (F11 / Esc)':'浏览器全屏 (F11)';button.setAttribute('aria-label',fullscreen?'退出浏览器全屏':'浏览器全屏');}
    requestAnimationFrame(()=>requestAnimationFrame(syncBounds));
  }
  async function setFullscreen(enabled){
    if(enabled&&!visible)return {error:'浏览器未打开'};fullscreenWanted=!!enabled;closeDd();
    if(!enabled)applyFullscreen(false);
    try{const b=B();if(!b?.fullscreen)throw Error('浏览器全屏接口不可用');const result=await b.fullscreen(!!enabled);if(result?.error)throw Error(result.error);if(fullscreenWanted===!!enabled&&(!enabled||visible))applyFullscreen(!!result.fullscreen);return result;}
    catch(error){if(fullscreenWanted===!!enabled){fullscreenWanted=false;applyFullscreen(false);MI.toast(error.message,'err');}return {error:error.message};}
  }

  // ---------- 空状态（收藏 + 最近访问） ----------
  function renderEmpty() {
    ensureDefaultFavs();
    const favWrap = document.getElementById('be-favs');
    const hisWrap = document.getElementById('be-history');
    favWrap.innerHTML = '';
    const list = favs();
    list.forEach((f) => {
      const chip = document.createElement('button');
      chip.className = 'be-chip';
      chip.textContent = f.title || f.url;
      chip.title = f.url;
      chip.onclick = () => go(f.url);
      favWrap.appendChild(chip);
    });
    if (!list.length) favWrap.innerHTML = '<span class="be-none">暂无收藏，浏览网页后点 ☆ 收藏</span>';
    hisWrap.innerHTML = '';
    const his = history().slice(0, 8);
    his.forEach((h) => {
      const row = document.createElement('div');
      row.className = 'be-row';
      row.title = h.url;
      const nm = document.createElement('span');
      nm.className = 'be-nm';
      nm.textContent = h.title || h.url;
      const host = document.createElement('span');
      host.className = 'be-host';
      try { host.textContent = new URL(h.url).hostname; } catch { host.textContent = ''; }
      row.appendChild(nm);
      row.appendChild(host);
      row.onclick = () => go(h.url);
      hisWrap.appendChild(row);
    });
    if (!his.length) hisWrap.innerHTML = '<span class="be-none">暂无浏览记录</span>';
  }

  // ---------- 地址栏下拉（历史 + 收藏 混合建议） ----------
  function closeDd() { ddEl.classList.add('hidden'); ddEl.innerHTML = ''; }
  function renderDd(q) {
    const s = String(q || '').trim().toLowerCase();
    if(!s){closeDd();return;}
    const src = [
      ...favs().map((f) => ({ url: f.url, title: f.title, fav: true })),
      ...history().map((h) => ({ url: h.url, title: h.title, fav: false })),
    ];
    const seen = new Set();
    const items = src.filter((x) => {
      if (seen.has(x.url)) return false;
      seen.add(x.url);
      return !s || x.url.toLowerCase().includes(s) || String(x.title || '').toLowerCase().includes(s);
    }).slice(0, 8);
    ddEl.innerHTML = '';
    if (!items.length) { closeDd(); return; }
    items.forEach((x) => {
      const d = document.createElement('div');
      d.className = 'bw-dd-item';
      const nm = document.createElement('span');
      nm.className = 'bw-dd-nm';
      nm.textContent = (x.fav ? '★ ' : '') + (x.title || x.url);
      const host = document.createElement('span');
      host.className = 'bw-dd-host';
      try { host.textContent = new URL(x.url).hostname; } catch {}
      d.appendChild(nm);
      d.appendChild(host);
      d.title = x.url;
      d.onmousedown = (e) => { e.preventDefault(); go(x.url); };
      ddEl.appendChild(d);
    });
    ddEl.classList.remove('hidden');
  }

  // ---------- 收藏列表菜单 ----------
  // ---------- 收藏列表（左侧主侧栏 panel-browser，App.renderToolStrip 控制显隐） ----------
  // 拖拽落点标记清理：条目上的插入线 + 文件夹标题高亮
  function clearDropMarks() {
    if (!sbListEl) return;
    sbListEl.querySelectorAll('.drop-before, .drop-after, .drop-target')
      .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-target'));
  }
  // 「当前打开」列表的落点标记（与收藏列表分开：两者在同一个侧栏里，但容器不同，
  // 共用一个清理函数会把另一边的标记也抹掉）。
  function clearSessionDropMarks() {
    const l = document.getElementById('bw-groups-list');
    if (!l) return;
    l.querySelectorAll('.drop-before, .drop-after, .drop-into-group')
      .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into-group'));
  }
  // 把 from 标签挪到 to 标签的前/后。tabStore.reorder(from,to) 的语义是「插到 to 之前」，
  // 所以「插到后面」要换成它的下一个兄弟；源在目标之前时目标索引要左移一位。
  function reorderAfter(fromId, toId, after) {
    const tabs = tabStore.state.tabs;
    const fromIndex = tabs.findIndex(t => t.id === fromId);
    let toIndex = tabs.findIndex(t => t.id === toId);
    if (fromIndex < 0 || toIndex < 0 || fromId === toId) return;
    if (after) toIndex += 1;
    if (fromIndex < toIndex) toIndex -= 1;
    const target = tabs[Math.min(toIndex, tabs.length - 1)];
    if (target && target.id !== fromId) tabStore.reorder(fromId, target.id);
  }
  // 把整组挪到目标组所在的位置：取「组」在 state.tabs 里的连续区段，
  // 整段搬到目标组第一个成员的位置之前。组内顺序保持不变。
  function moveGroupBefore(srcGroupId, destGroupId) {
    if (srcGroupId === destGroupId) return;
    const tabs = tabStore.state.tabs;
    const members = tabs.filter(t => t.groupId === srcGroupId);
    const destFirst = tabs.find(t => t.groupId === destGroupId);
    if (!members.length || !destFirst) return;
    // 逐个 reorder 到目标之前：先搬最后一个，保证相对顺序不被打乱。
    for (const tab of [...members].reverse()) tabStore.reorder(tab.id, destFirst.id);
  }
  // 「移回根目录」落点：平时不占位，拖起来才出现（不然用户不知道还能拖出文件夹）
  function showRootZone() {
    if (!sbListEl || sbListEl.querySelector('.bw-sb-rootzone')) return;
    const z = document.createElement('div');
    z.className = 'bw-sb-rootzone';
    z.innerHTML = IC_ARROW_DOWN + '<span>拖到这里 = 移回根目录</span>';
    z.addEventListener('dragover', (e) => {
      if (!dragFavUrl) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      z.classList.add('drop-target');
    });
    z.addEventListener('dragleave', () => z.classList.remove('drop-target'));
    z.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      z.classList.remove('drop-target');
      const src = dragFavUrl;
      dragFavUrl = null;
      hideRootZone();
      if (!src || !moveFavTo(src, '', null)) return;
      renderSidebar();
      renderEmpty();
      MI.toast('已移回根目录', 'ok');
    });
    sbListEl.appendChild(z);
  }
  function hideRootZone() {
    if (!sbListEl) return;
    const z = sbListEl.querySelector('.bw-sb-rootzone');
    if (z) z.remove();
    sbListEl.classList.remove('drop-root');
  }
  function renderSidebar() {
    if (!sbListEl) return;
    ensureDefaultFavs();
    sbListEl.innerHTML = '';
    const list = favs();
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'bw-sb-none';
      d.textContent = '暂无收藏，浏览网页后点 ☆ 收藏';
      sbListEl.appendChild(d);
      return;
    }
    const mkItem = (f) => {
      const it = document.createElement('div');
      it.className = 'bw-sb-item';
      let host = '';
      try { host = new URL(f.url).hostname.replace(/^www\./, ''); } catch {}
      const nm = document.createElement('span');
      nm.className = 'bw-sb-nm';
      nm.textContent = f.title || f.url;
      nm.title = (f.title || f.url) + '\n' + f.url;
      const h = document.createElement('span');
      h.className = 'bw-sb-host';
      h.textContent = host;
      it.appendChild(nm);
      it.appendChild(h);
      // 左键：新开一个标签页，不覆盖当前正在看的页面。
      // 原来这里是 go(f.url)，会直接把当前标签导航走 —— 用户在手头页面里查资料时
      // 点一下收藏，正在读的那页就没了。要在当前页打开用右键菜单的第一项。
      it.onclick = () => newTab(f.url, f.title);
      // 中键也走新标签（浏览器通行习惯），并阻止中键在页面上触发滚动/自动滚动。
      it.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); newTab(f.url, f.title); } };
      // 右键：打开 / 移动到文件夹 / 删除
      it.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const m = document.getElementById('ctx-menu');
        m.innerHTML = '';
        const mk = (label, fn, danger) => {
          const d = document.createElement('div');
          d.className = 'ctx-item' + (danger ? ' danger' : '');
          d.textContent = label;
          d.onclick = () => { m.classList.add('hidden'); fn(); };
          m.appendChild(d);
        };
        // 左键已改成一律新开标签，所以这里把「在当前页打开」单独列出来，
        // 否则一旦当前页被新标签挤到后面，用户就没有回到「用当前页导航」的路。
        mk('🔗 在新标签打开', () => newTab(f.url, f.title));
        mk('📂 在当前标签打开', () => go(f.url));
        mk('✏️ 重命名', async () => {
          const name = await Modal.prompt('重命名收藏', '名称', f.title || f.url);
          if (!name || !name.trim()) return;
          if (!renameFav(f.url, name)) { MI.toast('名称未变化', 'err'); return; }
          renderSidebar();
          renderEmpty();
          renderFavBtn();
          MI.toast('已重命名', 'ok');
        });
        mk('📦 移动到…', () => openFavPosMenu(f.url, e.clientX, e.clientY, true));
        mk('🗑 取消收藏', () => {
          removeFav(f.url);
          renderSidebar();
          renderFavBtn();
          renderEmpty();
          MI.toast('已取消收藏', 'ok');
        }, true);
        m.classList.remove('hidden');
        m.style.left = Math.min(e.clientX, window.innerWidth - 240) + 'px';
        m.style.top = Math.min(e.clientY, window.innerHeight - 180) + 'px';
      };
      // 拖动换位置：拖到条目上 = 插到它的前/后（并跟着它换文件夹）；拖到文件夹标题 = 放进该文件夹
      // 注意：dragover 里 dataTransfer.getData 恒为空（Chromium 安全限制）→ 用模块级 dragFavUrl 判断源
      it.draggable = true;
      it.addEventListener('dragstart', (e) => {
        dragFavUrl = f.url;
        try {
          e.dataTransfer.setData('text/plain', f.url);
          e.dataTransfer.effectAllowed = 'move';
        } catch {}
        it.classList.add('dragging-src');
        showRootZone();
      });
      it.addEventListener('dragend', () => {
        dragFavUrl = null;
        it.classList.remove('dragging-src');
        clearDropMarks();
        hideRootZone();
      });
      it.addEventListener('dragover', (e) => {
        if (!dragFavUrl || dragFavUrl === f.url) return; // 拖到自己身上不算落点
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const r = it.getBoundingClientRect();
        // jsdom / 未布局时高度为 0 → 一律当「插到前面」，行为可预期
        const after = !!r.height && e.clientY - r.top > r.height / 2;
        clearDropMarks();
        it.classList.add(after ? 'drop-after' : 'drop-before');
      });
      it.addEventListener('dragleave', () => it.classList.remove('drop-before', 'drop-after'));
      it.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const src = dragFavUrl;
        dragFavUrl = null;
        const r = it.getBoundingClientRect();
        const after = !!r.height && e.clientY - r.top > r.height / 2;
        clearDropMarks();
        hideRootZone();
        if (!src || src === f.url) return;
        const dest = f.folder || '';
        if (!moveFavTo(src, dest, after ? nextInFolder(list, f) : f.url)) return;
        renderSidebar();
        renderEmpty();
        MI.toast(dest ? '已移到「' + dest + '」' : '已移到根目录', 'ok');
      });
      return it;
    };
    // 「插到这条之后」需要一条同组锚点：取组内下一条，没有就 null（= 放到该组末尾）
    const nextInFolder = (arr, f) => {
      for (let k = arr.indexOf(f) + 1; k < arr.length; k++) {
        if ((arr[k].folder || '') === (f.folder || '')) return arr[k].url;
      }
      return null;
    };
    // 根收藏在前，文件夹分组随后
    list.filter((f) => !f.folder).forEach((f) => sbListEl.appendChild(mkItem(f)));
    folders().forEach((name) => {
      const g = document.createElement('div');
      g.className = 'bw-sb-group';
      const items = list.filter((f) => f.folder === name);
      // 标题拆成 三角 / 图标 / 名称 / 计数 四段（整段 textContent 只剩「名称（n）」）：
      // 三角与图标列宽固定，多个组看下来名称起点才对齐 —— 跟文件树 .tree-row .ic 一个道理
      const gTitle = document.createElement('div');
      gTitle.className = 'bw-sb-gtitle';
      const gCaret = document.createElement('span');
      gCaret.className = 'bw-sb-gcaret';
      gCaret.innerHTML = IC_CARET_DOWN; // 折叠态用 CSS rotate(-90deg)，同工具条折叠箭头
      const gIcon = document.createElement('span');
      gIcon.className = 'bw-sb-gicon';
      const gName = document.createElement('span');
      gName.className = 'bw-sb-gname';
      gName.textContent = name;
      gName.title = name;
      const gCnt = document.createElement('span');
      gCnt.className = 'bw-sb-gcnt';
      // 计数不用全角括号「（2）」：跟本项目其它计数一个口径（.g-count 的「2 个文件」/ #tasks-count），
      // 弱色 + 单位，读起来是一句话而不是「名字后面挂个括号」
      gCnt.textContent = items.length + ' 个收藏';
      gTitle.appendChild(gCaret);
      gTitle.appendChild(gIcon);
      gTitle.appendChild(gName);
      gTitle.appendChild(gCnt);
      const gBody = document.createElement('div');
      gBody.className = 'bw-sb-gbody';
      const paintTitle = () => {
        const folded = foldedFolders.has(name);
        gIcon.innerHTML = folded ? IC_FOLDER_CLOSED : IC_FOLDER_OPEN;
        gTitle.classList.toggle('folded', folded);
        gTitle.classList.toggle('empty', !items.length);
      };
      paintTitle();
      gTitle.title = '点击收起 / 展开 · 右键删除文件夹 · 可把收藏拖进来';
      if (foldedFolders.has(name)) gBody.style.display = 'none';
      items.forEach((f) => gBody.appendChild(mkItem(f)));
      gTitle.onclick = () => {
        const fold = gBody.style.display !== 'none'; // 当前展开 → 折叠
        if (fold) foldedFolders.add(name); else foldedFolders.delete(name);
        gBody.style.display = fold ? 'none' : '';
        paintTitle();
      };
      gTitle.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const m = document.getElementById('ctx-menu');
        m.innerHTML = '';
        const d = document.createElement('div');
        d.className = 'ctx-item danger';
        d.textContent = '🗑 删除文件夹「' + name + '」';
        d.title = '文件夹内收藏移回根目录（收藏本身不删除）';
        d.onclick = () => {
          m.classList.add('hidden');
          const n = removeFolder(name);
          foldedFolders.delete(name);
          renderSidebar();
          renderEmpty();
          MI.toast(n ? '已删除文件夹，' + n + ' 个收藏移回根目录' : '已删除空文件夹「' + name + '」', 'ok');
        };
        m.appendChild(d);
        m.classList.remove('hidden');
        m.style.left = Math.min(e.clientX, window.innerWidth - 240) + 'px';
        m.style.top = Math.min(e.clientY, window.innerHeight - 80) + 'px';
      };
      // 拖进文件夹：标题（折叠着也行）和内容区都是落点 → 放到该组末尾
      const asFolderTarget = (el) => {
        el.addEventListener('dragover', (e) => {
          if (!dragFavUrl) return;
          e.preventDefault();
          e.stopPropagation(); // 别冒泡到列表容器（那是「移回根目录」）
          e.dataTransfer.dropEffect = 'move';
          clearDropMarks();
          gTitle.classList.add('drop-target');
        });
        el.addEventListener('dragleave', (e) => {
          if (el.contains(e.relatedTarget)) return;
          gTitle.classList.remove('drop-target');
        });
        el.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const src = dragFavUrl;
          dragFavUrl = null;
          clearDropMarks();
          hideRootZone();
          if (!src) return;
          // 收着的文件夹被放进东西 → 自动展开，让用户看见东西去哪了
          foldedFolders.delete(name);
          gBody.style.display = '';
          paintTitle();
          if (!moveFavTo(src, name, null)) return;
          renderSidebar();
          renderEmpty();
          MI.toast('已移到「' + name + '」', 'ok');
        });
      };
      asFolderTarget(gTitle);
      asFolderTarget(gBody);
      g.appendChild(gTitle);
      g.appendChild(gBody);
      sbListEl.appendChild(g);
    });
  }

  // ---------- 收藏位置选择（收藏当前页 / 移动收藏共用） ----------
  // move = true 时是「移动已有收藏」：选中文件夹立即移动；
  // 否则是收藏当前页：选完位置落收藏
  function openFavPosMenu(url, x, y, move) {
    const menu = document.getElementById('ctx-menu');
    menu.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ctx-item ctx-head';
    head.textContent = move ? '移动到…' : '收藏到…';
    menu.appendChild(head);
    const pick = (folder) => {
      menu.classList.add('hidden');
      if (move) {
        moveFav(url, folder);
        renderSidebar();
        renderEmpty();
        MI.toast('已移动到' + (folder ? '「' + folder + '」' : '根目录'), 'ok');
      } else {
        addFav(url, currentTitle, folder);
        renderFavBtn();
        renderSidebar();
        renderEmpty();
        MI.toast('已收藏到' + (folder ? '「' + folder + '」' : '根目录') + '：' + (currentTitle || url), 'ok');
      }
    };
    const root = document.createElement('div');
    root.className = 'ctx-item';
    root.textContent = '★ 根目录';
    root.onclick = () => pick('');
    menu.appendChild(root);
    folders().forEach((name) => {
      const d = document.createElement('div');
      d.className = 'ctx-item';
      d.textContent = '📁 ' + name;
      d.onclick = () => pick(name);
      menu.appendChild(d);
    });
    const neo = document.createElement('div');
    neo.className = 'ctx-item';
    neo.textContent = '＋ 新建文件夹…';
    neo.onclick = async () => {
      menu.classList.add('hidden');
      const name = await Modal.prompt('新建收藏文件夹', '文件夹名称', '');
      if (!name || !name.trim()) return;
      const v = name.trim().slice(0, 30);
      pick(v);
    };
    menu.appendChild(neo);
    menu.classList.remove('hidden');
    menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 220) + 'px';
  }

  // ---------- 初始化 ----------
  function init() {
    panel = document.getElementById('browser-panel');
    urlInput = document.getElementById('bw-url');
    favBtn = document.getElementById('bw-fav');
    ddEl = document.getElementById('bw-dd');
    viewEl = document.getElementById('browser-view');
    sbListEl = document.getElementById('bw-sb-list'); // 左侧主侧栏里的收藏列表
    // 网页深色：按钮三态循环 + 启动时把上次的选择推给主进程（nativeTheme）
    darkBtnEl = document.getElementById('bw-dark');
    if (darkBtnEl) darkBtnEl.onclick = (e) => { e.stopPropagation(); cycleDarkMode(); };
    initDarkMode();
    initTabStrip();
    tabStore = BrowserTabs.create(localStorage); projectRoot=window.App?.root || null;
    tabStore.load(projectRoot); projectTabStores.set(tabStore.scope, tabStore); B()?.selectTab?.(tabStore.active.id);
    // 一次性把旧的「快照组」（带 tabs 数组的那种）迁移成活标签组：打开其中的网页
    // 并归入同名组。失败不阻断启动 —— 旧的浏览器不该因为一组数据迁移失败就打不开。
    try { const m = tabStore.migrateLegacyGroups(); if (m?.migrated) MI.toast('已把 ' + m.migrated + ' 个标签组迁移为可折叠的活标签组', 'ok'); } catch {}
    renderTabs(); switchSidebar('groups'); storageStatus();
    document.getElementById('bw-tab-new').onclick = () => newTab();
    document.getElementById('bw-tab-menu').onclick = event => { event.stopPropagation(); const r=event.currentTarget.getBoundingClientRect(); openTabMenu(tabStore.active.id,r.right,r.bottom+4); };
    document.getElementById('bw-side-groups').onclick = () => switchSidebar('groups');
    document.getElementById('bw-side-favorites').onclick = () => switchSidebar('favorites');
    document.getElementById('bw-tabs').oncontextmenu = event => { if (event.target.closest('.bw-tab')) return; event.preventDefault(); event.stopPropagation(); openTabMenu(tabStore.active.id,event.clientX,event.clientY); };
    window.addEventListener('beforeunload',saveTabs);
    // 列表空白处 = 根目录落点（分组外的区域本来就是「根」；子元素都 stopPropagation，不会误判）
    if (sbListEl) {
      sbListEl.addEventListener('dragover', (e) => {
        if (!dragFavUrl) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        sbListEl.classList.add('drop-root');
      });
      sbListEl.addEventListener('dragleave', (e) => {
        if (!sbListEl.contains(e.relatedTarget)) sbListEl.classList.remove('drop-root');
      });
      sbListEl.addEventListener('drop', (e) => {
        sbListEl.classList.remove('drop-root');
        const src = dragFavUrl;
        dragFavUrl = null;
        clearDropMarks();
        hideRootZone();
        if (!src) return; // 外部拖入（文件等）不接管，交给默认行为
        e.preventDefault();
        if (!moveFavTo(src, '', null)) return;
        renderSidebar();
        renderEmpty();
        MI.toast('已移回根目录', 'ok');
      });
    }

    document.getElementById('bw-back').onclick = back;
    document.getElementById('bw-fwd').onclick = forward;
    document.getElementById('bw-reload').onclick = reload;
    document.getElementById('bw-home').onclick = home;
    document.getElementById('bw-fullscreen').onclick = () => setFullscreen(!fullscreenWanted);
    document.getElementById('bw-open-default').onclick = openDefault;
    document.getElementById('bw-close').onclick = () => App.closeBrowser();
    document.getElementById('bw-err-retry').onclick = () => { document.getElementById('browser-error').classList.add('hidden'); reload(); };
    favBtn.onclick = (e) => {
      e.stopPropagation(); // tree.js 全局 click 会关掉刚弹出的菜单（共享单例 ctx-menu）
      if (!currentUrl) { MI.toast('先打开一个网页再收藏', 'err'); return; }
      if (isFav(currentUrl)) { removeFav(currentUrl); MI.toast('已取消收藏', 'ok'); }
      else {
        // 收藏时选择位置（根目录 / 文件夹 / 新建）——点 ☆ 直接弹菜单
        const r = favBtn.getBoundingClientRect();
        openFavPosMenu(currentUrl, r.left, r.bottom + 4, false);
        return;
      }
      renderFavBtn();
      renderSidebar();
      renderEmpty();
    };
    // 收藏列表新建文件夹（真正落盘：空文件夹也常驻显示，右键收藏可移动进去）
    const sbAdd = document.getElementById('bw-sb-add-folder');
    if (sbAdd) sbAdd.onclick = async () => {
      if (sidebarMode === 'groups') { saveTabGroup(); return; }
      const name = await Modal.prompt('新建收藏文件夹', '文件夹名称', '');
      if (!name || !name.trim()) return;
      const v = name.trim().slice(0, 30);
      if (!addFolder(v)) { MI.toast('文件夹「' + v + '」已存在', 'err'); return; }
      renderSidebar();
      MI.toast('文件夹「' + v + '」已创建，右键收藏可移动进去', 'ok');
    };

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(urlInput.value); urlInput.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); urlInput.value = currentUrl; closeDd(); urlInput.blur(); }
    });
    urlInput.addEventListener('focus', () => { urlInput.select(); closeDd(); });
    urlInput.addEventListener('input', () => renderDd(urlInput.value));
    urlInput.addEventListener('blur', () => setTimeout(closeDd, 150));

    // 占位区尺寸变化（窗口 resize / 侧栏拖宽 / 面板显隐）→ 同步 view bounds
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => syncBounds()).observe(viewEl);
    }
    window.addEventListener('resize', () => syncBounds());
    // 浮层（Modal / ctx-menu）显隐 → 摘掉或挂回 WebContentsView（见 syncOverlay 注释）
    const overlayMo = new MutationObserver(syncOverlay);
    const maskEl = document.getElementById('modal-mask');
    const menuEl = document.getElementById('ctx-menu');
    if (maskEl) overlayMo.observe(maskEl, { attributes: true, attributeFilter: ['class'] });
    if (menuEl) overlayMo.observe(menuEl, { attributes: true, attributeFilter: ['class'] });
    if (ddEl) overlayMo.observe(ddEl, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('keydown',event=>{
      if(!visible||event.isComposing||[document.getElementById('modal-mask'),document.getElementById('ctx-menu')].some(el=>el&&!el.classList.contains('hidden')))return;
      if(event.ctrlKey&&!event.altKey&&['t','w','tab'].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopImmediatePropagation();
        const key=event.key.toLowerCase(); if(key==='t'){if(event.shiftKey)reopenTab();else newTab();}else if(key==='w')closeTabs([tabStore.active.id]);else cycleTab(event.shiftKey?-1:1);return;
      }
      if(event.key==='F11'&&!event.ctrlKey&&!event.altKey&&!event.shiftKey){event.preventDefault();event.stopImmediatePropagation();setFullscreen(!fullscreenWanted);}
      else if(event.key==='Escape'&&fullscreenWanted&&ddEl.classList.contains('hidden')){event.preventDefault();event.stopImmediatePropagation();setFullscreen(false);}
    },true);
    // 整窗缩放变化 → CSS↔DIP 映射改变，主进程换算 bounds 需重新上报
    if (window.myIDE && myIDE.win && myIDE.win.onZoom) {
      myIDE.win.onZoom(() => { setTimeout(syncBounds, 30); setTimeout(syncBounds, 200); });
    }

    const b = B();
    if (b) {
      if(b.onNewTab)b.onNewTab(info=>{if(!info||!tabStore.state.tabs.some(t=>t.id===info.sourceTabId))return;if(visible)newTab(info.url);else{tabStore.add(info.url,'',false);renderTabs();renderGroups();storageStatus();}});
      if(b.onTranslate)b.onTranslate(text=>{if(visible&&typeof text==='string'&&window.Translate)Translate.run(text);});
      // 主进程转发的 view 内快捷键（Ctrl+4 / Alt+←→ / Ctrl+R、F5 / Ctrl+L）
      if (b.onCmd) b.onCmd((cmd) => {
        if (cmd === 'toggle') toggle();
        else if (!visible) return;
        else if (cmd === 'new-tab') newTab();
        else if (cmd === 'close-tab') closeTabs([tabStore.active.id]);
        else if (cmd === 'reopen-tab') reopenTab();
        else if (cmd === 'next-tab') cycleTab(1);
        else if (cmd === 'previous-tab') cycleTab(-1);
        else if (cmd === 'back') back();
        else if (cmd === 'forward') forward();
        else if (cmd === 'reload') reload();
        else if (cmd === 'focus-url') { urlInput.focus(); urlInput.select(); }
        else if (cmd === 'fullscreen') setFullscreen(!fullscreenWanted);
        else if (cmd === 'exit-fullscreen') setFullscreen(false);
      });
      // 主进程页面状态回推（url/title/loading/canBack/canFwd/progress/err）
      if (b.onState) b.onState((s) => onState(s));
    }
  }

  function aiOperation(operation,args={}) {
    if(operation==='tabs'||operation.startsWith('tab_'))return aiTabOperation(operation,args);
    if(operation==='state')return {visible,fullscreen,colorScheme:darkMode,favorites:favs().slice(0,100),folders:folders().slice(0,100),favoritesTruncated:favs().length>100};
    if(operation==='fullscreen')return setFullscreen(args.enabled).then(result=>({...result,ok:!result.error,committed:!result.error}));
    if(operation==='color_scheme')return (async()=>{
      const result=await B().setColorScheme(args.scheme);if(!result?.ok)return {ok:false,error:result?.error||'网页显示设置未生效'};
      darkMode=args.scheme;renderDarkBtn();
      try{localStorage.setItem(DARK_KEY,darkMode);}catch{return {ok:false,committed:true,colorScheme:darkMode,errorCode:'BROWSER_SAVE_FAILED',error:'网页显示已生效，但偏好保存失败'};}
      return {...result,committed:true,colorScheme:darkMode};
    })();
    if(operation==='reveal'){
      if(tabStore){tabStore.update(tabStore.active.id,{url:args.url,title:args.url});mountedTabs.add(tabStore.active.id);renderTabs();renderGroups();storageStatus();}
      hasPage=true;currentUrl=args.url;urlInput.value=args.url;
      renderDefaultButton();
      document.getElementById('browser-empty').classList.add('hidden');
      document.getElementById('browser-error').classList.add('hidden');viewEl.classList.remove('hidden');
      App.showTool('browser');if(!overlayOpen())mountView(null);
      // AI导航后解除地址栏焦点，让状态回推能够显示真实的新地址。
      setTimeout(()=>{urlInput.blur();urlInput.value=currentUrl;},0);return {ok:true};
    }
    let changed=false;
    if(operation==='favorite_add')changed=addFav(args.url,args.title,args.folder||'');
    else if(operation==='favorite_remove'){changed=isFav(args.url);if(changed)removeFav(args.url);}
    else throw Error('不支持的浏览器面板操作');
    renderFavBtn();renderSidebar();renderEmpty();return {ok:true,changed,favorite:favs().find(f=>f.url===args.url)||null};
  }

  return {
    aiOperation, newTab, activateTab, closeTabs, reopenTab, saveTabGroup, openTabGroup, switchSidebar, setProject, saveTabs,
    get tabs(){return tabStore?.state.tabs || [];}, get activeTabId(){return tabStore?.state.active;},
    init, show, hide, toggle, open, go, back, forward, reload, home, onState,
    normalizeInput, addHistory, clearHistory, addFav, removeFav, isFav, renderEmpty,
    folders, addFolder, removeFolder, moveFav, moveFavTo, renameFav,
    cycleDarkMode, get darkMode() { return darkMode; },
    setFullscreen,get fullscreen(){return fullscreen;},
    get visible() { return visible; },
    get url() { return currentUrl; },
    get title() { return currentTitle; },
  };
})();
window.BrowserPanel = BrowserPanel;

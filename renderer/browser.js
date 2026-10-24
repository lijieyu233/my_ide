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
    else if (operation === 'tab_group_save') { if (!state.tabs.every(t => supported(t.url))) throw aiTabError('BROWSER_TAB_UNSUPPORTED', '组中包含本地或含凭据的页面，未保存'); const result = tabStore.saveGroup(args.name); if (!result.ok) throw aiTabError('BROWSER_SAVE_FAILED', result.error); renderGroups(); }
    else if (operation === 'tab_group_open') { if (!group.tabs.every(t => supported(t.url))) throw aiTabError('BROWSER_TAB_UNSUPPORTED', '标签组包含本地或含凭据的页面，未打开'); const before = JSON.stringify(tabStore.state); tabStore.openGroup(group.id); changed = before !== JSON.stringify(tabStore.state); renderTabs(); renderGroups(); storageStatus(); if (visible) presentTab(); }
    else if (operation === 'tab_group_rename' || operation === 'tab_group_delete') { const result = tabStore.changeGroup(group.id, operation === 'tab_group_delete' ? null : args.name); if (!result.ok) throw aiTabError('BROWSER_SAVE_FAILED', result.error); renderGroups(); }
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
    for (const tab of state.tabs) {
      const item = document.createElement('div'); item.className = 'bw-tab' + (state.active === tab.id ? ' active' : ''); item.dataset.tabId = tab.id; item.draggable = true;
      const select = document.createElement('button'); select.className = 'bw-tab-select'; select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(state.active === tab.id)); select.tabIndex = visible && state.active === tab.id ? 0 : -1;
      select.title = (tab.title || '新标签页') + (tab.url ? '\n' + tab.url : ''); select.innerHTML = IC_PAGE;
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
      item.ondrop = event => { if (!draggingTab) return; event.preventDefault(); event.stopPropagation(); tabStore.reorder(draggingTab, tab.id); draggingTab = null; renderTabs(); renderGroups(); storageStatus(); };
      item.ondragend = () => { draggingTab = null; document.querySelectorAll('.bw-tab.dragging,.bw-tab.drop-tab').forEach(el => el.classList.remove('dragging', 'drop-tab')); };
      if (tabRuntime.get(tab.id)?.loading) item.classList.add('loading'); list.append(item);
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
  function newTab(url = '', title = '') {
    const normalized = url ? normalizeInput(url) : '';
    if (!BrowserTabs.validURL(normalized)) { MI.toast('不支持的网页地址', 'err'); return; }
    const tab = tabStore.add(normalized, title); renderTabs(); renderGroups(); storageStatus(); presentTab();
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
  function tabMenu(items, x, y) {
    const menu = document.getElementById('ctx-menu'); menu.replaceChildren(); const scope = tabStore.scope;
    for (const entry of items) {
      const button = document.createElement('button'); button.className = 'ctx-item' + (entry.danger ? ' danger' : ''); button.textContent = entry.label; button.disabled = !!entry.disabled;
      button.onclick = event => { event.stopPropagation(); menu.classList.add('hidden'); if (scope === tabStore.scope) entry.run(); }; menu.append(button);
    }
    menu.classList.remove('hidden'); menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px'; menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px'; syncOverlay();
  }
  function openTabMenu(tabId, x, y) {
    const state = tabStore.state, tab = state.tabs.find(t => t.id === tabId) || tabStore.active, index = state.tabs.findIndex(t => t.id === tab.id);
    tabMenu([
      { label: '保存当前标签到收藏', disabled: !tab.url, run: () => openFavPosMenu(tab.url, x, y, false) },
      { label: '将所有标签保存为一组…', disabled: !state.tabs.some(t => t.url), run: saveTabGroup },
      { label: '重新打开关闭的标签', disabled: !state.closed.length, run: reopenTab },
      { label: '关闭其他标签', disabled: state.tabs.length < 2, run: () => closeTabs(state.tabs.filter(t => t.id !== tab.id).map(t => t.id)) },
      { label: '关闭右侧标签', disabled: index === state.tabs.length - 1, run: () => closeTabs(state.tabs.slice(index + 1).map(t => t.id)) },
      { label: '关闭标签', run: () => closeTabs([tab.id]) },
    ], x, y);
  }
  function saveTabGroup() {
    const scope = tabStore.scope, tabs = tabStore.state.tabs.filter(t => t.url); if (!tabs.length) { MI.toast('先打开网页再保存标签组', 'err'); return; }
    const box = document.createElement('div'); box.className = 'bw-save-group modal-panel';
    box.innerHTML = '<div class="m-head">保存标签组<button class="x" aria-label="关闭">×</button></div><form class="m-body"><label for="bw-group-name">名称</label><input id="bw-group-name" maxlength="60" placeholder="例如：项目后台联调" required><p class="bw-group-count"></p><div class="m-foot"><button class="tb-btn m-cancel" type="button">取消</button><button class="tb-btn primary" type="submit">保存</button></div></form>';
    box.querySelector('.bw-group-count').textContent = tabs.length + ' 个标签 · 保留当前顺序';
    const close = () => Modal.hide(); box.querySelector('.x').onclick = close; box.querySelector('.m-cancel').onclick = close;
    box.querySelector('form').onsubmit = event => {
      event.preventDefault(); if (scope !== tabStore.scope) { MI.toast('项目已切换，请重新保存标签组', 'err'); return; }
      try { const result = tabStore.saveGroup(box.querySelector('input').value, tabs); if (!result.ok) throw Error(result.error); close(); switchSidebar('groups'); MI.toast('标签组已保存', 'ok'); }
      catch (error) { MI.toast(error.message, 'err'); }
    };
    Modal.show(box); syncOverlay(); box.querySelector('input').focus();
  }
  function openTabGroup(id) {
    try { if (tabStore.openGroup(id)) { renderTabs(); renderGroups(); storageStatus(); presentTab(); } }
    catch (error) { MI.toast(error.message, 'err'); }
  }
  function switchSidebar(mode) {
    sidebarMode = mode;
    document.getElementById('bw-side-groups').setAttribute('aria-selected', String(mode === 'groups'));
    document.getElementById('bw-side-favorites').setAttribute('aria-selected', String(mode === 'favorites'));
    document.getElementById('bw-groups-list').classList.toggle('hidden', mode !== 'groups'); sbListEl.classList.toggle('hidden', mode !== 'favorites');
    const add = document.getElementById('bw-sb-add-folder'); add.title = mode === 'groups' ? '保存当前标签组' : '新建收藏文件夹'; add.setAttribute('aria-label', add.title);
    renderGroups(); renderSidebar();
  }
  function renderGroups() {
    const list = document.getElementById('bw-groups-list'); if (!list || !tabStore) return; list.replaceChildren();
    tabSignature();
    const caption = document.createElement('div'); caption.className = 'bw-group-caption'; caption.innerHTML = '<span>当前打开</span><span>自动保留</span>'; list.append(caption);
    for (const tab of tabStore.state.tabs) {
      const button = document.createElement('button'); button.className = 'bw-session-tab' + (tab.id === tabStore.state.active ? ' active' : ''); button.innerHTML = IC_PAGE;
      const name = document.createElement('span'); name.textContent = tab.title || '新标签页'; button.append(name); button.title = tab.url || '新标签页'; button.onclick = () => activateTab(tab.id); list.append(button);
    }
    const saved = document.createElement('div'); saved.className = 'bw-group-caption'; saved.textContent = '已保存'; list.append(saved);
    let groups;
    try { groups = tabStore.groups(); } catch (error) { const note = document.createElement('p'); note.className = 'bw-sb-none'; note.textContent = error.message; list.append(note); return; }
    if (!groups.length) { const empty = document.createElement('div'); empty.className = 'bw-groups-empty'; empty.textContent = '把常用网页保存成一组，下次一起打开。'; const button = document.createElement('button'); button.className = 'tb-btn'; button.textContent = '保存当前标签组'; button.onclick = saveTabGroup; empty.append(button); list.append(empty); }
    for (const group of groups) {
      const row = document.createElement('div'); row.className = 'bw-saved-group';
      const header = document.createElement('div'); header.className = 'bw-saved-group-head';
      const toggle = document.createElement('button'); toggle.className = 'bw-group-toggle'; toggle.innerHTML = IC_CARET_DOWN; toggle.classList.toggle('folded', !foldedGroups.has(group.id)); toggle.setAttribute('aria-expanded', String(foldedGroups.has(group.id)));
      const name = document.createElement('span'); name.textContent = group.name; toggle.append(name); const count = document.createElement('span'); count.className = 'bw-group-size'; count.textContent = group.tabs.length; toggle.append(count);
      toggle.onclick = () => { if (foldedGroups.has(group.id)) foldedGroups.delete(group.id); else foldedGroups.add(group.id); renderGroups(); };
      const open = document.createElement('button'); open.className = 'bw-group-open'; open.innerHTML = IC_OPEN; open.title = '打开整组 · 跳过已打开的网址'; open.setAttribute('aria-label', '打开标签组 ' + group.name); open.onclick = () => openTabGroup(group.id);
      header.append(toggle, open); row.append(header);
      const menu = event => { event.preventDefault(); event.stopPropagation(); tabMenu([
        { label: '打开整组', run: () => openTabGroup(group.id) },
        { label: '重命名', run: async () => { const name = await Modal.prompt('重命名标签组', '名称', group.name); if (!name) return; try { const r = tabStore.changeGroup(group.id, name); if (!r.ok) throw Error(r.error); renderGroups(); } catch (error) { MI.toast(error.message, 'err'); } } },
        { label: '删除标签组', danger: true, run: async () => { if (!await Modal.confirm('删除标签组', '删除「' + group.name + '」？已打开的网页会保留。')) return; try { const r = tabStore.changeGroup(group.id, null); if (!r.ok) throw Error(r.error); renderGroups(); } catch (error) { MI.toast(error.message, 'err'); } } },
      ], event.clientX, event.clientY); };
      header.oncontextmenu = menu;
      const more = document.createElement('button'); more.className = 'bw-group-more'; more.innerHTML = IC('<circle cx="3" cy="8" r=".7"/><circle cx="8" cy="8" r=".7"/><circle cx="13" cy="8" r=".7"/>'); more.title = '标签组操作'; more.setAttribute('aria-label', '标签组操作 ' + group.name); more.onclick = menu; header.append(more);
      if (foldedGroups.has(group.id)) for (const tab of group.tabs) { const link = document.createElement('button'); link.className = 'bw-group-page'; link.textContent = tab.title || tab.url; link.title = tab.url; link.onclick = () => { const existing = tabStore.state.tabs.find(t => t.url === tab.url); if (existing) activateTab(existing.id); else newTab(tab.url, tab.title); }; row.append(link); }
      list.append(row);
    }
  }

  // 上报占位区 rect → 主进程 setBounds（WebContentsView 是原生层，尺寸完全由它决定）
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
    return !!(mask && !mask.classList.contains('hidden')) || !!(menu && !menu.classList.contains('hidden')) || !!(ddEl && !ddEl.classList.contains('hidden'));
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
    tabStore.load(projectRoot); projectTabStores.set(tabStore.scope, tabStore); B()?.selectTab?.(tabStore.active.id); renderTabs(); switchSidebar('groups'); storageStatus();
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

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
  // 走主进程 nativeTheme.themeSource（进程级）：网页里的 prefers-color-scheme 跟着变，
  // GitHub / MDN / npm 这类自带深色的站点会直接切过去 —— 比 CSS 反色滤镜干净（图片不会发神经）。
  // 代价：只有声明了 prefers-color-scheme 的站点会变，死写白底的页面仍然白。Chromium 那个
  // 「强制深色」开关用不了：只能启动前设，而且会连本 IDE 自己的界面一起反色。
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
    b.viewOpen(url || null).then((r) => { if (r && r.error) MI.toast(r.error, 'err'); }).catch(() => {});
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
    return !!(mask && !mask.classList.contains('hidden')) || !!(menu && !menu.classList.contains('hidden'));
  }
  let overlayHid = false; // 当前因浮层主动摘掉 view（与面板自身隐藏区分开）
  function syncOverlay() {
    if (!visible || !hasPage) return;
    const b = B(); if (!b) return;
    if (overlayOpen()) {
      if (!overlayHid) { overlayHid = true; b.viewHide(); }
    } else if (overlayHid) {
      overlayHid = false;
      mountView(null); // viewOpen 幂等（addChildView 重复无害），rAF 内重报 bounds
    }
  }

  // ---------- 主进程状态回推 ----------
  function onState(s) {
    if (!s) return;
    if (s.err) { showError(s.err); return; }
    if (s.navigated && s.url) {
      currentUrl = s.url;
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
    if (b && b.setColorScheme) b.setColorScheme(darkMode);
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
    document.getElementById('browser-empty').classList.add('hidden');
    document.getElementById('browser-error').classList.add('hidden');
    viewEl.classList.remove('hidden');
    hasPage = true;
    if (u === currentUrl && hasPage) { // 同址再回车 = 刷新
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
    setTimeout(() => urlInput.focus(), 0);
  }
  function hide() {
    if (!visible) return;
    visible = false;
    overlayHid = false; // 面板隐藏本身就摘了 view，状态复位
    panel.classList.add('hidden');
    syncToolBtn();
    closeDd();
    stopHeal();
    const b = B(); if (b) b.viewHide(); // 只摘掉显示，WebContentsView 保留
  }
  function toggle() { visible ? hide() : show(); }
  function open(url) { show(); go(url); }

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
  function openFavMenu(x, y) {
    const menu = document.getElementById('ctx-menu');
    menu.innerHTML = '';
    const list = favs();
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'ctx-item';
      d.textContent = '暂无收藏';
      menu.appendChild(d);
    }
    list.forEach((f) => {
      const d = document.createElement('div');
      d.className = 'ctx-item';
      d.textContent = (f.folder ? '📁 ' : '★ ') + (f.folder ? f.folder + ' / ' : '') + (f.title || f.url);
      d.title = f.url;
      d.onclick = () => { menu.classList.add('hidden'); go(f.url); };
      menu.appendChild(d);
    });
    const del = document.createElement('div');
    del.className = 'ctx-item';
    del.textContent = '🗑 清空浏览历史';
    del.onclick = () => { menu.classList.add('hidden'); clearHistory(); renderEmpty(); MI.toast('已清空浏览历史', 'ok'); };
    menu.appendChild(del);
    menu.classList.remove('hidden');
    menu.style.left = Math.min(x, window.innerWidth - 260) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 240) + 'px';
  }

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
      it.onclick = () => go(f.url);
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
        mk('📂 打开', () => go(f.url));
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
      gCnt.textContent = '（' + items.length + '）';
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
    document.getElementById('bw-close').onclick = () => App.switchTool('browser'); // 已激活 → 收起
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
    document.getElementById('bw-favs').onclick = (e) => {
      e.stopPropagation(); // 同上：全局 click 关菜单
      const r = e.target.getBoundingClientRect();
      openFavMenu(r.left, r.bottom + 4);
    };
    // 收藏列表新建文件夹（真正落盘：空文件夹也常驻显示，右键收藏可移动进去）
    const sbAdd = document.getElementById('bw-sb-add-folder');
    if (sbAdd) sbAdd.onclick = async () => {
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
    urlInput.addEventListener('focus', () => { urlInput.select(); renderDd(urlInput.value); });
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
    // 整窗缩放变化 → CSS↔DIP 映射改变，主进程换算 bounds 需重新上报
    if (window.myIDE && myIDE.win && myIDE.win.onZoom) {
      myIDE.win.onZoom(() => { setTimeout(syncBounds, 30); setTimeout(syncBounds, 200); });
    }

    const b = B();
    if (b) {
      // 主进程转发的 view 内快捷键（Ctrl+4 / Alt+←→ / Ctrl+R、F5 / Ctrl+L）
      if (b.onCmd) b.onCmd((cmd) => {
        if (cmd === 'toggle') toggle();
        else if (!visible) return;
        else if (cmd === 'back') back();
        else if (cmd === 'forward') forward();
        else if (cmd === 'reload') reload();
        else if (cmd === 'focus-url') { urlInput.focus(); urlInput.select(); }
      });
      // 主进程页面状态回推（url/title/loading/canBack/canFwd/progress/err）
      if (b.onState) b.onState((s) => onState(s));
    }
  }

  return {
    init, show, hide, toggle, open, go, back, forward, reload, home, onState,
    normalizeInput, addHistory, clearHistory, addFav, removeFav, isFav, renderEmpty,
    folders, addFolder, removeFolder, moveFav, moveFavTo, renameFav,
    cycleDarkMode, get darkMode() { return darkMode; },
    get visible() { return visible; },
    get url() { return currentUrl; },
    get title() { return currentTitle; },
  };
})();
window.BrowserPanel = BrowserPanel;

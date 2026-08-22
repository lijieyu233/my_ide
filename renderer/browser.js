// browser.js —— 内置浏览器面板（主进程 WebContentsView）
// 弃用 <webview>：guest 视口高度同步在 flex 布局下失效（卡默认 150px → 下半白屏）。
// 现由主进程 WebContentsView 渲染网页，本模块只管 UI（工具栏/地址栏/收藏/历史）
// 并通过 IPC 驱动导航、上报 #browser-view 占位区 rect（setBounds 显式控制视口尺寸）。
const BrowserPanel = (() => {
  const HISTORY_KEY = 'myide-browser-history';
  const FAV_KEY = 'myide-browser-favs';
  const HOME = 'https://www.bing.com';
  const SEARCH = 'https://www.bing.com/search?q=';

  let panel, urlInput, favBtn, ddEl, viewEl;
  let visible = false;
  let hasPage = false;      // 是否已打开过页面（决定 show 恢复网页 or 空状态）
  let currentUrl = '';
  let currentTitle = '';

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
  function addFav(url, title) {
    if (!url) return false;
    const list = favs();
    if (list.some((f) => f.url === url)) return false;
    list.unshift({ url, title: title || url, ts: Date.now() });
    saveJSON(FAV_KEY, list);
    return true;
  }
  function removeFav(url) { saveJSON(FAV_KEY, favs().filter((f) => f.url !== url)); }

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
      if (isFav(currentUrl)) { const l = favs(); const f = l.find((x) => x.url === currentUrl); if (f) { f.title = currentTitle || f.title; saveJSON(FAV_KEY, l); } }
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
  function show() {
    if (visible) return;
    visible = true;
    panel.classList.remove('hidden');
    syncToolBtn();
    if (hasPage) { // 恢复网页显示（view 实例保留在主进程，登录态不丢）
      document.getElementById('browser-empty').classList.add('hidden');
      viewEl.classList.remove('hidden');
      mountView(null);
    } else {
      document.getElementById('browser-empty').classList.remove('hidden');
      viewEl.classList.add('hidden');
      renderEmpty();
    }
    setTimeout(() => urlInput.focus(), 0);
  }
  function hide() {
    if (!visible) return;
    visible = false;
    panel.classList.add('hidden');
    syncToolBtn();
    closeDd();
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
      d.textContent = '★ ' + (f.title || f.url);
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

  // ---------- 初始化 ----------
  function init() {
    panel = document.getElementById('browser-panel');
    urlInput = document.getElementById('bw-url');
    favBtn = document.getElementById('bw-fav');
    ddEl = document.getElementById('bw-dd');
    viewEl = document.getElementById('browser-view');

    document.getElementById('bw-back').onclick = back;
    document.getElementById('bw-fwd').onclick = forward;
    document.getElementById('bw-reload').onclick = reload;
    document.getElementById('bw-home').onclick = home;
    document.getElementById('bw-close').onclick = hide;
    document.getElementById('bw-err-retry').onclick = () => { document.getElementById('browser-error').classList.add('hidden'); reload(); };
    favBtn.onclick = () => {
      if (!currentUrl) { MI.toast('先打开一个网页再收藏', 'err'); return; }
      if (isFav(currentUrl)) { removeFav(currentUrl); MI.toast('已取消收藏', 'ok'); }
      else { addFav(currentUrl, currentTitle); MI.toast('已收藏 ' + (currentTitle || currentUrl), 'ok'); }
      renderFavBtn();
      renderEmpty();
    };
    document.getElementById('bw-favs').onclick = (e) => {
      const r = e.target.getBoundingClientRect();
      openFavMenu(r.left, r.bottom + 4);
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
    get visible() { return visible; },
    get url() { return currentUrl; },
    get title() { return currentTitle; },
  };
})();
window.BrowserPanel = BrowserPanel;

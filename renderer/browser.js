// browser.js —— 内置浏览器面板（Electron <webview>）
// 内容区覆盖式面板：地址栏（URL/关键词搜索）、前进后退刷新、收藏、最近历史
// 登录态持久（partition persist）；webview 内新窗口 → 系统浏览器（main.js 统一处理）
const BrowserPanel = (() => {
  const HISTORY_KEY = 'myide-browser-history';
  const FAV_KEY = 'myide-browser-favs';
  const HOME = 'https://www.bing.com';
  const SEARCH = 'https://www.bing.com/search?q=';

  let panel, urlInput, wv, favBtn, ddEl;
  let visible = false;
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

  // ---------- webview ----------
  function ensureWv() {
    if (wv) return wv;
    wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:myide-browser'); // 持久 session：保留登录态
    wv.addEventListener('did-navigate', (e) => onNavigated(e.url, false));
    wv.addEventListener('did-navigate-in-page', (e) => onNavigated(e.url, true));
    wv.addEventListener('page-title-updated', (e) => {
      currentTitle = e.title || '';
      // 标题变化时同步最近一条历史的标题
      const list = history();
      if (list[0] && list[0].url === currentUrl) { list[0].title = currentTitle; saveJSON(HISTORY_KEY, list); }
      if (isFav(currentUrl)) { const l = favs(); const f = l.find((x) => x.url === currentUrl); if (f) { f.title = currentTitle || f.title; saveJSON(FAV_KEY, l); } }
    });
    wv.addEventListener('did-start-loading', () => { prog().style.width = '35%'; });
    wv.addEventListener('did-stop-loading', () => {
      prog().style.width = '100%';
      setTimeout(() => { if (prog().style.width === '100%') prog().style.width = '0'; }, 250);
    });
    // loadProgress 若触发则显示精确进度（事件名跨版本行为不一，start/stop 已兜底）
    wv.addEventListener('loadProgress', (e) => {
      const p = Math.max(0, Math.min(1, Number(e.progress) || 0));
      prog().style.width = Math.round(p * 100) + '%';
    });
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return; // ERR_ABORTED：用户发起新导航
      MI.toast('加载失败：' + (e.errorDescription || ('错误码 ' + e.errorCode)), 'err');
    });
    document.getElementById('browser-view').appendChild(wv);
    return wv;
  }
  const prog = () => document.getElementById('bw-prog');
  const wvCan = (m) => wv && typeof wv[m] === 'function';

  function onNavigated(url, inPage) {
    currentUrl = url || '';
    if (document.activeElement !== urlInput) urlInput.value = currentUrl;
    if (!inPage) addHistory(currentUrl, currentTitle);
    updateNavState();
  }
  function updateNavState() {
    document.getElementById('bw-back').disabled = !(wvCan('canGoBack') && wv.canGoBack());
    document.getElementById('bw-fwd').disabled = !(wvCan('canGoForward') && wv.canGoForward());
    renderFavBtn();
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
    // 顺序关键：先让容器可见，再创建 webview（避免在 display:none 容器中 attach 的时序竞态）
    document.getElementById('browser-empty').classList.add('hidden');
    document.getElementById('browser-view').classList.remove('hidden');
    ensureWv();
    // 动态创建的 webview 必须用 setAttribute 设 src：
    // property 赋值在元素未被 Electron upgrade 前只是 expando，不触发导航 → 白屏
    if (wv.getAttribute('src') === u && wvCan('reload')) wv.reload(); // 同址再回车 = 刷新
    else wv.setAttribute('src', u);
    urlInput.value = u;
    closeDd();
  }
  function back() { if (wvCan('goBack') && wv.canGoBack()) wv.goBack(); }
  function forward() { if (wvCan('goForward') && wv.canGoForward()) wv.goForward(); }
  function reload() { if (wvCan('reload') && wv.getAttribute('src')) wv.reload(); else if (currentUrl) go(currentUrl); }
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
    // 视图状态机：有已加载页面显示 webview，否则显示空状态页（收藏/历史）
    const hasPage = !!(wv && wv.getAttribute('src'));
    document.getElementById('browser-empty').classList.toggle('hidden', hasPage);
    document.getElementById('browser-view').classList.toggle('hidden', !hasPage);
    if (!hasPage) renderEmpty();
    setTimeout(() => urlInput.focus(), 0);
  }
  function hide() {
    if (!visible) return;
    visible = false;
    panel.classList.add('hidden');
    syncToolBtn();
    closeDd();
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

    document.getElementById('bw-back').onclick = back;
    document.getElementById('bw-fwd').onclick = forward;
    document.getElementById('bw-reload').onclick = reload;
    document.getElementById('bw-home').onclick = home;
    document.getElementById('bw-close').onclick = hide;
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

    // 主进程转发的 webview 内快捷键（Ctrl+4 切换 / Alt+←→ 导航 / Ctrl+R、F5 刷新 / Ctrl+L 地址栏）
    if (window.myIDE && window.myIDE.browser && window.myIDE.browser.onCmd) {
      window.myIDE.browser.onCmd((cmd) => {
        if (cmd === 'toggle') toggle();
        else if (!visible) return;
        else if (cmd === 'back') back();
        else if (cmd === 'forward') forward();
        else if (cmd === 'reload') reload();
        else if (cmd === 'focus-url') { urlInput.focus(); urlInput.select(); }
      });
    }
  }

  return {
    init, show, hide, toggle, open, go, back, forward, reload, home,
    normalizeInput, addHistory, clearHistory, addFav, removeFav, isFav, renderEmpty,
    get visible() { return visible; },
    get url() { return currentUrl; },
    get title() { return currentTitle; },
  };
})();
window.BrowserPanel = BrowserPanel;

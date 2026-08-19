// theme.js —— 主题切换（深色/浅色/粉红/深红）+ 背景图，最先加载避免闪烁
const Theme = (() => {
  const KEY = 'myide-theme';
  const ORDER = ['dark', 'light', 'pink', 'crimson']; // toggle 循环顺序
  const NAMES = { dark: '深色', light: '浅色', pink: '粉红', crimson: '深红' };
  const CLS = { light: 'theme-light', pink: 'theme-pink', crimson: 'theme-crimson' };

  function apply(t) {
    for (const k in CLS) document.body.classList.toggle(CLS[k], t === k);
  }
  function current() {
    for (const k in CLS) if (document.body.classList.contains(CLS[k])) return k;
    return 'dark';
  }
  function name(t) { return NAMES[t] || t; }
  function toggle() {
    const t = ORDER[(ORDER.indexOf(current()) + 1) % ORDER.length];
    apply(t);
    try { localStorage.setItem(KEY, t); } catch {}
    return t;
  }
  // 显式设置主题（设置页用）
  function set(theme) {
    if (!ORDER.includes(theme)) return;
    apply(theme);
    try { localStorage.setItem(KEY, theme); } catch {}
  }
  function init() {
    let t = null;
    try { t = localStorage.getItem(KEY); } catch {}
    if (ORDER.includes(t) && t !== 'dark') apply(t);
    Bg.init();
  }
  return { toggle, set, current, name, init };
})();

// ---------- 背景图（外观设置：本地图片 + 透明度） ----------
const Bg = (() => {
  const P_KEY = 'myide-bg';        // 图片路径
  const O_KEY = 'myide-bg-opacity'; // 0.05 - 0.5
  function apply() {
    let p = '';
    let op = 0.15;
    try {
      p = localStorage.getItem(P_KEY) || '';
      op = parseFloat(localStorage.getItem(O_KEY) || '0.15') || 0.15;
    } catch {}
    const layer = document.getElementById('bg-layer');
    if (!layer) return;
    if (p) {
      layer.style.backgroundImage = 'url("file:///' + p.split('\\').join('/') + '")';
      layer.style.opacity = String(Math.min(0.5, Math.max(0.05, op)));
      layer.style.display = 'block';
      document.body.classList.add('has-bg');
    } else {
      layer.style.display = 'none';
      layer.style.backgroundImage = '';
      document.body.classList.remove('has-bg');
    }
  }
  function set(path) {
    try { path ? localStorage.setItem(P_KEY, path) : localStorage.removeItem(P_KEY); } catch {}
    apply();
  }
  function setOpacity(op) {
    try { localStorage.setItem(O_KEY, String(op)); } catch {}
    apply();
  }
  function get() {
    let p = '', op = 0.15;
    try { p = localStorage.getItem(P_KEY) || ''; op = parseFloat(localStorage.getItem(O_KEY) || '0.15') || 0.15; } catch {}
    return { path: p, opacity: op };
  }
  function init() { apply(); }
  return { set, setOpacity, get, init };
})();
window.Theme = Theme;
window.Bg = Bg;
Theme.init(); // 立即应用，避免主题/背景闪烁

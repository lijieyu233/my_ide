// theme.js —— 主题切换（深色/浅色/粉红/深红），最先加载避免闪烁
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
  }
  return { toggle, set, current, name, init };
})();
window.Theme = Theme;
Theme.init(); // 立即应用，避免主题闪烁

// theme.js —— 主题切换（深色/浅色），最先加载避免闪烁
const Theme = (() => {
  const KEY = 'myide-theme';

  function apply(t) {
    document.body.classList.toggle('theme-light', t === 'light');
  }
  function current() {
    return document.body.classList.contains('theme-light') ? 'light' : 'dark';
  }
  function toggle() {
    const t = current() === 'light' ? 'dark' : 'light';
    apply(t);
    try { localStorage.setItem(KEY, t); } catch {}
    return t;
  }
  // 显式设置主题（设置页用）
  function set(theme) {
    apply(theme);
    try { localStorage.setItem(KEY, theme); } catch {}
  }
  function init() {
    let t = null;
    try { t = localStorage.getItem(KEY); } catch {}
    if (t === 'light') apply('light');
  }
  return { toggle, set, current, init };
})();
window.Theme = Theme;
Theme.init(); // 立即应用，避免主题闪烁
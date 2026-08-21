// theme.js —— 主题切换（深色/浅色/粉红/深红）+ 自定义强调色 + 背景图，最先加载避免闪烁
const Theme = (() => {
  const KEY = 'myide-theme';
  const A_KEY = 'myide-accent'; // 自定义强调色（空 = 跟随主题默认）
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
  // 自定义强调色：写入 --accent CSS 变量，全主题生效；空值恢复主题默认
  function applyAccent() {
    let c = '';
    try { c = localStorage.getItem(A_KEY) || ''; } catch {}
    document.documentElement.style.setProperty('--accent', c || null);
  }
  function setAccent(color) {
    try { color ? localStorage.setItem(A_KEY, color) : localStorage.removeItem(A_KEY); } catch {}
    applyAccent();
  }
  function getAccent() {
    try { return localStorage.getItem(A_KEY) || ''; } catch { return ''; }
  }
  function init() {
    let t = null;
    try { t = localStorage.getItem(KEY); } catch {}
    if (ORDER.includes(t) && t !== 'dark') apply(t);
    applyAccent();
    Bg.init();
  }
  return { toggle, set, current, name, init, setAccent, getAccent };
})();

// ---------- 背景图（外观设置：本地图片 + 透明度 + 显示方式/位置） ----------
const Bg = (() => {
  const P_KEY = 'myide-bg';        // 图片路径
  const O_KEY = 'myide-bg-opacity'; // 0.05 - 0.5
  const F_KEY = 'myide-bg-fit';    // cover 铺满 / contain 完整显示 / tile 平铺
  const POS_KEY = 'myide-bg-pos';  // 显示位置（center/top/bottom/left/right/九宫格）
  const FITS = ['cover', 'contain', 'tile'];
  const POS_LIST = ['center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'];

  function apply() {
    let p = '';
    let op = 0.15;
    let fit = 'cover';
    let pos = 'center';
    try {
      p = localStorage.getItem(P_KEY) || '';
      op = parseFloat(localStorage.getItem(O_KEY) || '0.15') || 0.15;
      fit = localStorage.getItem(F_KEY) || 'cover';
      pos = localStorage.getItem(POS_KEY) || 'center';
    } catch {}
    if (!FITS.includes(fit)) fit = 'cover';
    if (!POS_LIST.includes(pos)) pos = 'center';
    const layer = document.getElementById('bg-layer');
    if (!layer) return;
    if (p) {
      layer.style.backgroundImage = 'url("file:///' + p.split('\\').join('/') + '")';
      layer.style.opacity = String(Math.min(0.5, Math.max(0.05, op)));
      // 显示方式：铺满 cover / 完整 contain / 平铺 repeat（原图大小）
      layer.style.backgroundSize = fit === 'tile' ? 'auto' : fit;
      layer.style.backgroundRepeat = fit === 'tile' ? 'repeat' : 'no-repeat';
      // 显示位置：九宫格（平铺模式下无意义，仅 cover 裁切时可见差异）
      layer.style.backgroundPosition = pos;
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
  function setFit(fit) {
    if (!FITS.includes(fit)) return;
    try { localStorage.setItem(F_KEY, fit); } catch {}
    apply();
  }
  function setPos(pos) {
    if (!POS_LIST.includes(pos)) return;
    try { localStorage.setItem(POS_KEY, pos); } catch {}
    apply();
  }
  function get() {
    let p = '', op = 0.15, fit = 'cover', pos = 'center';
    try {
      p = localStorage.getItem(P_KEY) || '';
      op = parseFloat(localStorage.getItem(O_KEY) || '0.15') || 0.15;
      fit = localStorage.getItem(F_KEY) || 'cover';
      pos = localStorage.getItem(POS_KEY) || 'center';
    } catch {}
    if (!FITS.includes(fit)) fit = 'cover';
    if (!POS_LIST.includes(pos)) pos = 'center';
    return { path: p, opacity: op, fit, pos };
  }
  function init() { apply(); }
  return { set, setOpacity, setFit, setPos, get, init };
})();
window.Theme = Theme;
window.Bg = Bg;
Theme.init(); // 立即应用，避免主题/背景闪烁

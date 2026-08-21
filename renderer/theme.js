// theme.js —— 主题切换（深色/浅色/粉红/深红）+ UI 动态自定义主题变量 + 背景图，最先加载避免闪烁
const Theme = (() => {
  const KEY = 'myide-theme';
  const A_KEY = 'myide-accent';        // 旧版单独强调色键（迁移兼容）
  const C_KEY = 'myide-custom-theme';  // 自定义主题变量 JSON
  const ORDER = ['dark', 'light', 'pink', 'crimson']; // toggle 循环顺序
  const NAMES = { dark: '深色', light: '浅色', pink: '粉红', crimson: '深红' };
  const CLS = { light: 'theme-light', pink: 'theme-pink', crimson: 'theme-crimson' };

  // UI 可动态调整的变量（字段名 → CSS 变量）
  const FIELDS = {
    accent:     { css: '--accent',      label: '强调色（按钮/链接/光标）' },
    bg:         { css: '--bg',          label: '编辑区背景' },
    bgPanel:    { css: '--bg-panel',    label: '侧边栏背景' },
    bgHover:    { css: '--bg-hover',    label: '悬停背景' },
    bgSelected: { css: '--bg-selected', label: '选中背景' },
    border:     { css: '--border',      label: '边框线' },
    text:       { css: '--text',        label: '正文文字' },
    textBright: { css: '--text-bright', label: '标题亮文字' },
  };

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

  // ---------- UI 动态自定义主题变量 ----------
  function loadCustom() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(C_KEY) || '{}') || {}; } catch {}
    // 旧版 myide-accent 迁移（未写入新键时回退）
    if (!c.accent) {
      try {
        const old = localStorage.getItem(A_KEY);
        if (old) c.accent = old;
      } catch {}
    }
    return c;
  }
  function saveCustom(c) {
    try { localStorage.setItem(C_KEY, JSON.stringify(c)); } catch {}
  }
  // 应用：有值写变量，无值移除（恢复当前预设主题默认）
  function applyCustom() {
    const c = loadCustom();
    const root = document.documentElement;
    for (const k in FIELDS) {
      const v = c[k];
      if (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) root.style.setProperty(FIELDS[k].css, v);
      else root.style.removeProperty(FIELDS[k].css);
    }
  }
  // 设置单项（color 为空 = 该项恢复预设）
  function pick(field, color) {
    if (!FIELDS[field]) return;
    const c = loadCustom();
    if (color) c[field] = color;
    else delete c[field];
    saveCustom(c);
    applyCustom();
  }
  // 清空全部自定义，恢复预设主题
  function clearCustom() {
    try { localStorage.removeItem(C_KEY); localStorage.removeItem(A_KEY); } catch {}
    applyCustom();
  }
  function getCustom() {
    const c = loadCustom();
    const out = {};
    for (const k in FIELDS) out[k] = typeof c[k] === 'string' ? c[k] : '';
    return out;
  }
  function getFields() { return FIELDS; }

  // ---------- 兼容旧接口（强调色） ----------
  function setAccent(color) { pick('accent', color); }
  function getAccent() { return getCustom().accent; }

  function init() {
    let t = null;
    try { t = localStorage.getItem(KEY); } catch {}
    if (ORDER.includes(t) && t !== 'dark') apply(t);
    applyCustom();
    Bg.init();
  }
  return { toggle, set, current, name, init, setAccent, getAccent, pick, clearCustom, getCustom, getFields };
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

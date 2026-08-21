// theme.js —— 主题切换（内置 + 用户自定义主题增删）+ UI 动态调色 + 背景图，最先加载避免闪烁
const Theme = (() => {
  const KEY = 'myide-theme';
  const A_KEY = 'myide-accent';        // 旧版单独强调色键（首次加载迁移后删除）
  const C_KEY = 'myide-custom-theme';  // 当前覆盖层颜色 JSON（用户主题激活时含其配色）
  const UT_KEY = 'myide-user-themes';  // 用户自定义主题列表 [{id, name, base, colors}]
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

  let activeId = 'dark'; // 'dark' | 'light' | ... | 'user:<id>'
  const isUserId = (t) => typeof t === 'string' && t.indexOf('user:') === 0;

  // ---------- 用户自定义主题存储 ----------
  function userThemes() {
    try { return JSON.parse(localStorage.getItem(UT_KEY) || '[]') || []; } catch { return []; }
  }
  function saveUserThemes(list) {
    try { localStorage.setItem(UT_KEY, JSON.stringify(list)); } catch {}
  }
  function findUser(id) {
    return userThemes().find((t) => t && t.id === id) || null;
  }
  function baseOf(t) {
    if (!isUserId(t)) return ORDER.includes(t) ? t : 'dark';
    const ut = findUser(t.slice(5));
    return ut && ORDER.includes(ut.base) ? ut.base : 'dark';
  }
  function applyBase(b) {
    for (const k in CLS) document.body.classList.toggle(CLS[k], b === k);
  }

  // ---------- 覆盖层（当前生效的自定义颜色） ----------
  function loadCustom() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(C_KEY) || '{}') || {}; } catch {}
    // 旧版 myide-accent 一次性迁移（迁移后删旧键，避免清空覆盖层时旧值复活）
    try {
      const old = localStorage.getItem(A_KEY);
      if (old) { if (!c.accent) c.accent = old; localStorage.removeItem(A_KEY); }
    } catch {}
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

  // ---------- 主题切换 ----------
  // set：内置主题 → 恢复其默认配色（清空覆盖层）；用户主题 → 载入其配色快照
  function set(t) {
    if (isUserId(t)) {
      const ut = findUser(t.slice(5));
      if (ut) {
        activeId = 'user:' + ut.id;
        applyBase(ut && ORDER.includes(ut.base) ? ut.base : 'dark');
        saveCustom(ut.colors || {});
        try { localStorage.setItem(KEY, activeId); } catch {}
        applyCustom();
        return activeId;
      }
      t = 'dark'; // 主题已被删除 → 回退深色
    }
    const b = ORDER.includes(t) ? t : 'dark';
    activeId = b;
    applyBase(b);
    saveCustom({});
    try { localStorage.setItem(KEY, b); } catch {}
    applyCustom();
    return b;
  }
  function current() { return activeId; }
  function name(t) {
    if (isUserId(t)) { const ut = findUser(t.slice(5)); return ut ? ut.name : '自定义'; }
    return NAMES[t] || t;
  }
  function toggle() {
    return set(ORDER[(ORDER.indexOf(baseOf(activeId)) + 1) % ORDER.length]);
  }

  // ---------- 用户主题增删 ----------
  // 保存当前配色为新主题：快照 base + 覆盖层颜色
  function addUserTheme(themeName) {
    const list = userThemes();
    const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const cur = getCustom();
    const colors = {};
    for (const k in FIELDS) if (cur[k]) colors[k] = cur[k];
    list.push({ id, name: String(themeName || '自定义主题').slice(0, 30), base: baseOf(activeId), colors });
    saveUserThemes(list);
    return id;
  }
  function removeUserTheme(id) {
    const ut = findUser(id);
    saveUserThemes(userThemes().filter((t) => t && t.id !== id));
    // 删的是当前主题 → 回退到它的 base
    if (activeId === 'user:' + id) set(ut && ORDER.includes(ut.base) ? ut.base : 'dark');
  }
  function getUserThemes() { return userThemes().filter((t) => t && t.id); }

  // ---------- 兼容旧接口（强调色） ----------
  function setAccent(color) { pick('accent', color); }
  function getAccent() { return getCustom().accent; }

  function init() {
    let t = null;
    try { t = localStorage.getItem(KEY); } catch {}
    if (isUserId(t) && findUser(t.slice(5))) {
      // 用户主题：恢复其 base；颜色保持 C_KEY 现值（可能含选中后的微调）
      activeId = t;
      applyBase(baseOf(t));
    } else {
      activeId = ORDER.includes(t) ? t : 'dark';
      applyBase(activeId);
    }
    applyCustom();
    Bg.init();
  }
  return {
    toggle, set, current, name, init,
    setAccent, getAccent, pick, clearCustom, getCustom, getFields,
    addUserTheme, removeUserTheme, getUserThemes,
  };
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
      // 同步透明度控件：状态栏右下角滑条 + 设置页滑条
      const op100 = Math.round(Math.min(0.5, Math.max(0.05, op)) * 100);
      const sb = document.getElementById('sb-bgop-range');
      if (sb) sb.value = String(op100);
      const sv = document.getElementById('bg-op-val');
      if (sv) sv.textContent = String(op100);
      const sr = document.getElementById('bg-op-range');
      if (sr) sr.value = String(op100);
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
  function init() {
    apply();
    // 状态栏右下角透明度滑条（设背景图后显示，随 has-bg 切换可见性）
    const sb = document.getElementById('sb-bgop-range');
    if (sb) sb.addEventListener('input', () => { setOpacity(parseInt(sb.value, 10) / 100); });
  }
  return { set, setOpacity, setFit, setPos, get, init };
})();
window.Theme = Theme;
window.Bg = Bg;
Theme.init(); // 立即应用，避免主题/背景闪烁

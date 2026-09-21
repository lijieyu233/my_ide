// plugin-loader.js —— 渲染器插件机制
// 插件 API：api.registerRenderer(['.ext1', '.ext2'], ({path, name, ext, content}) => HTMLElement)
// 后注册的插件优先；内置渲染器最先注册。
window.MI = window.MI || {};

MI.renderers = []; // [{exts:Set, fn}]

MI.registerRenderer = function (exts, fn) {
  const set = new Set(exts.map((e) => String(e).toLowerCase().replace(/^\./, '')));
  MI.renderers.push({ exts: set, fn });
};

MI.renderFor = function (file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  for (let i = MI.renderers.length - 1; i >= 0; i--) {
    if (MI.renderers[i].exts.has(ext)) return MI.renderers[i].fn;
  }
  return null; // 无匹配 → 走默认文本编辑器
};

// ---------- 使用日志（性能埋点 + 错误捕获，定位卡顿/卡死用）----------
MI.log = function (level, tag, msg) {
  try { if (window.myIDE && window.myIDE.log) window.myIDE.log.write(level, tag, msg); } catch {}
};
MI.logErr = function (tag, e) { MI.log('ERROR', tag, (e && e.stack) || String(e)); };
// 性能埋点：包装 fn（同步/异步皆可），耗时超过 threshold 才记录
MI.perf = function (tag, fn, threshold = 200) {
  const t0 = performance.now();
  const done = () => {
    const ms = performance.now() - t0;
    if (ms >= threshold) MI.log('PERF', tag, ms.toFixed(0) + 'ms');
    return ms;
  };
  let r;
  try { r = fn(); } catch (e) { done(); MI.logErr(tag, e); throw e; }
  if (r && typeof r.then === 'function') {
    return r.then((v) => { done(); return v; }, (e) => { done(); MI.logErr(tag, e); throw e; });
  }
  done();
  return r;
};
window.addEventListener('error', (e) => {
  MI.log('ERROR', 'renderer', (e.message || 'error') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
});
window.addEventListener('unhandledrejection', (e) => {
  MI.log('ERROR', 'renderer-promise', String((e.reason && e.reason.stack) || e.reason));
});

// ---------- 内置渲染器 ----------
// 页内锚点滚动（markdown 链接跳转用）
function scrollToAnchor(container, rawId) {
  if (!container || !rawId) return;
  const id = decodeURIComponent(rawId);
  const target = [...container.querySelectorAll('[id]')].find((el) => el.id === id);
  if (target) { try { target.scrollIntoView({ block: 'start' }); } catch {} }
}
// ---------- 缩放查看器（图片 / SVG 通用，零依赖）----------
// 实现要点：
//   ① 缩放用「显式像素宽高 + 滚动容器」，不用 transform —— 放大后可直接用滚动条 / 拖拽平移，
//      且容器高度真实反映缩放结果（transform 不改变布局尺寸，父容器高度会失效）。
//   ② 居中用「容器 flex + 子元素 margin:auto」而不用 justify-content:center ——
//      后者在内容溢出时会把左上角推到容器外、滚动条也够不着（经典坑）。
//   ③ 尺寸未知（图片未 load 完 / jsdom）时不写死像素，退回 CSS max-width:100%，
//      等 load 事件再 refresh 一次重新适应。
// 返回：{ scale, setScale, zoomBy, fit, reset, refresh, apply, destroy }
MI.createZoomer = function (opts) {
  const stage = opts.stage;
  const el = opts.el;
  const MIN = opts.min || 0.05;
  const MAX = opts.max || 16;
  const STEP = opts.step || 1.25;
  let scale = 1;
  let nat = { w: 0, h: 0 };
  let mode = opts.initial === 1 ? 'free' : 'fit'; // fit：跟随窗口自动重算；free：用户指定倍数

  const bar = opts.bar || null;
  const pct = document.createElement('span');
  pct.className = 'zoom-pct';

  function measure() {
    const tag = String(el.tagName || '').toLowerCase();
    let w = 0, h = 0;
    if (tag === 'svg') {
      try {
        const vb = el.viewBox && el.viewBox.baseVal;
        if (vb && vb.width && vb.height) { w = vb.width; h = vb.height; }
      } catch {}
    } else {
      w = el.naturalWidth || 0;
      h = el.naturalHeight || 0;
    }
    if (!w || !h) {
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      w = (r && r.width) || w;
      h = (r && r.height) || h;
    }
    nat = { w, h };
    return nat;
  }

  function stageSize() {
    const r = stage.getBoundingClientRect ? stage.getBoundingClientRect() : null;
    let w = stage.clientWidth || (r && r.width) || 0;
    let h = stage.clientHeight || (r && r.height) || 0;
    // 减去 padding：clientWidth 含内边距，不减的话「适应」出来的图会刚好溢出、平白多出滚动条
    try {
      const cs = window.getComputedStyle(stage);
      w -= (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      h -= (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    } catch {}
    return { w: Math.max(0, w), h: Math.max(0, h) };
  }

  // 适应窗口：小图不放大（避免糊），大图缩到刚好放得下
  function fitScale() {
    measure();
    const s = stageSize();
    if (!s.w || !s.h || !nat.w || !nat.h) return 1;
    const slack = 4; // 缩放元素按 content-box 计宽（边框不计入），留几像素余量免得「刚好」时冒出滚动条
    return Math.min(1, (s.w - slack) / nat.w, (s.h - slack) / nat.h);
  }

  function apply() {
    if (!nat.w || !nat.h) { // 尺寸未知：交给 CSS
      el.style.maxWidth = '100%';
      el.style.maxHeight = '100%';
      return;
    }
    // content-box：width/height 就是图片内容尺寸（全局 * 是 border-box，会因 1px 边框挤压并轻微变形）
    el.style.boxSizing = 'content-box';
    el.style.width = Math.max(1, Math.round(nat.w * scale)) + 'px';
    el.style.height = Math.max(1, Math.round(nat.h * scale)) + 'px';
    el.style.maxWidth = 'none';
    el.style.maxHeight = 'none';
    pct.textContent = Math.round(scale * 100) + '%';
  }

  // ev 给定时以光标为锚点：缩放前后光标下的那一点保持不动
  function setScale(next, ev) {
    const before = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    scale = Math.min(MAX, Math.max(MIN, next));
    mode = 'free';
    apply();
    if (ev && before && before.width && before.height) {
      const rx = (ev.clientX - before.left) / before.width;
      const ry = (ev.clientY - before.top) / before.height;
      const after = el.getBoundingClientRect();
      stage.scrollLeft += (after.left + rx * after.width) - ev.clientX;
      stage.scrollTop += (after.top + ry * after.height) - ev.clientY;
    }
    return scale;
  }
  function zoomBy(k, ev) { return setScale(scale * k, ev); }
  function fit() { mode = 'fit'; scale = fitScale(); apply(); return scale; }
  function reset() { return setScale(1); }
  function refresh(reFit) {
    if (mode === 'fit' || reFit) return fit();
    measure();
    apply();
    return scale;
  }
  function resized() { if (mode === 'fit') { scale = fitScale(); apply(); } }

  // ---------- 控制条：－ 100% ＋ | 适应 1:1 | 附加按钮 ----------
  if (bar) {
    const mkBtn = (label, title, fn, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'zoom-btn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.title = title;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢焦点（编辑器/快捷键）
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
      return b;
    };
    bar.appendChild(mkBtn('－', '缩小（Ctrl+滚轮向下 / -）', () => zoomBy(1 / STEP)));
    pct.title = '当前缩放比例（点击恢复 100%）';
    pct.addEventListener('click', (e) => { e.stopPropagation(); reset(); });
    bar.appendChild(pct);
    bar.appendChild(mkBtn('＋', '放大（Ctrl+滚轮向上 / +）', () => zoomBy(STEP)));
    bar.appendChild(mkBtn('适应', '适应窗口（0）', () => fit()));
    bar.appendChild(mkBtn('1:1', '原始像素 100%（1）', () => reset()));
    for (const [label, title, fn] of (opts.extra || [])) bar.appendChild(mkBtn(label, title, fn, 'zoom-extra'));
  }

  // ---------- 滚轮：默认滚动（画布习惯），Ctrl/⌘ + 滚轮才缩放 ----------
  // 早期版本无修饰键也缩放，于是"滚轮被缩放抢走了，放大后没法上下滑动"。
  // 现在纯滚轮不拦截 —— 交给容器的原生滚动（放大后就是平移看图），只处理 Ctrl+滚轮：
  const onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return; // 不 preventDefault：垂直/Shift 横滚都按原生行为走
    e.preventDefault(); // 挡掉 Chromium 自己的整页缩放
    zoomBy(e.deltaY < 0 ? STEP : 1 / STEP, e);
  };
  stage.addEventListener('wheel', onWheel, { passive: false });

  // ---------- 拖拽平移（左键：内容溢出才接管；中键：画布习惯，随时可拖） ----------
  let drag = null;
  const canPan = () => stage.scrollWidth > stage.clientWidth + 1 || stage.scrollHeight > stage.clientHeight + 1;
  const onDown = (e) => {
    const mid = e.button === 1;
    if (e.button !== 0 && !mid) return;
    if (!mid && !canPan()) return;
    drag = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
    stage.classList.add('panning');
    e.preventDefault(); // 阻止图片被当作拖拽源、阻止选中、阻止中键自动滚动
  };
  const onMove = (e) => {
    if (!drag) return;
    stage.scrollLeft = drag.sl - (e.clientX - drag.x);
    stage.scrollTop = drag.st - (e.clientY - drag.y);
  };
  const onUp = () => { if (drag) { drag = null; stage.classList.remove('panning'); } };
  stage.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  // ---------- 双击切换「适应 ↔ 100%」 ----------
  const onDblClick = () => { if (mode === 'fit') reset(); else fit(); };
  if (opts.dblclick) el.addEventListener('dblclick', onDblClick);

  // ---------- 窗口尺寸变化：仅 fit 态自动重算 ----------
  let ro = null;
  if (typeof window.ResizeObserver === 'function') {
    ro = new window.ResizeObserver(resized);
    try { ro.observe(stage); } catch {}
  }

  // ---------- 快捷键（全屏浮层用；Esc 由调用方处理） ----------
  const onKey = (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return; // 组合键归应用快捷键（Ctrl+= 字号等）
    const t = String((e.target && e.target.tagName) || '').toLowerCase();
    if (t === 'input' || t === 'textarea') return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(STEP); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / STEP); }
    else if (e.key === '0') { e.preventDefault(); fit(); }
    else if (e.key === '1') { e.preventDefault(); reset(); }
  };
  if (opts.keys) window.addEventListener('keydown', onKey);

  function destroy() {
    stage.removeEventListener('wheel', onWheel);
    stage.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (opts.dblclick) el.removeEventListener('dblclick', onDblClick);
    if (opts.keys) window.removeEventListener('keydown', onKey);
    if (ro) { try { ro.disconnect(); } catch {} }
  }

  measure();
  if (mode === 'fit') scale = fitScale();
  apply();

  return { get scale() { return scale; }, setScale, zoomBy, fit, reset, refresh, apply, destroy };
};

// ---------- 图片查看器（标签页内嵌）：缩放工具条 + 滚轮缩放 + 拖拽平移 ----------
MI.buildImageViewer = function (src, alt) {
  const root = document.createElement('div');
  root.className = 'img-view';
  const stage = document.createElement('div');
  stage.className = 'img-stage';
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt || '图片预览';
  img.draggable = false;
  stage.appendChild(img);
  const bar = document.createElement('div');
  bar.className = 'zoom-bar img-bar';
  root.appendChild(stage);
  root.appendChild(bar);
  const z = MI.createZoomer({
    stage, el: img, bar, dblclick: true,
    extra: [['⛶ 全屏', '全屏查看（Esc 关闭）', () => MI.showImgLightbox(src, alt)]],
  });
  // 图片解码完成才有真实尺寸：重新量一次并按适应态收口
  img.addEventListener('load', () => z.refresh(true));
  root.__zoomer = z; // 供测试/调试直接驱动缩放
  return root;
};

// ---------- 图片全屏查看（lightbox）：md 预览 / Live Preview / 图片查看器共用 ----------
// 滚轮缩放、拖拽平移、双击切换、Esc / 点击空白关闭；同一时刻只有一个实例
MI.showImgLightbox = function (src, alt) {
  const old = document.querySelector('.img-lightbox');
  if (old) old.remove();
  const box = document.createElement('div');
  box.className = 'img-lightbox';
  const stage = document.createElement('div');
  stage.className = 'img-stage img-lb-stage';
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt || '';
  img.draggable = false;
  stage.appendChild(img);
  const bar = document.createElement('div');
  bar.className = 'zoom-bar img-bar img-lb-bar';
  box.appendChild(stage);
  box.appendChild(bar);
  const tip = document.createElement('div');
  tip.className = 'img-lightbox-tip';
  tip.textContent = '滚轮滚动 · Ctrl+滚轮缩放 · 拖动平移 · 双击切换 · Esc 关闭';
  box.appendChild(tip);
  document.body.appendChild(box);
  function close() {
    box.remove();
    window.removeEventListener('keydown', onKey);
    z.destroy();
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
  const z = MI.createZoomer({
    stage, el: img, bar, initial: 'fit', keys: true, dblclick: true,
    extra: [['✕ 关闭', '关闭（Esc）', () => close()]],
  });
  img.addEventListener('load', () => z.refresh(true));
  // 点空白关闭（图本身是拖拽起点，不算空白）
  stage.addEventListener('click', (e) => { if (e.target === stage) close(); });
  window.addEventListener('keydown', onKey);
  return z;
};

// ---------- SVG（mermaid 图）全屏查看 ----------
// md 预览 / Live Preview 两处的 mermaid 图共用：克隆 SVG 进浮层，可缩放、Esc/点空白关闭
MI.showSvgFullscreen = function (svgEl) {
  if (!svgEl) return null;
  const old = document.querySelector('.svg-fullscreen');
  if (old) old.remove();
  const box = document.createElement('div');
  box.className = 'svg-fullscreen';
  const stage = document.createElement('div');
  stage.className = 'img-stage svg-fs-stage';
  const svg = svgEl.cloneNode(true);
  // 清掉原图的尺寸约束（内联 max-width / width 属性），交给缩放器接管
  try {
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.maxWidth = 'none';
    svg.style.maxHeight = 'none';
  } catch {}
  stage.appendChild(svg);
  const bar = document.createElement('div');
  bar.className = 'zoom-bar img-bar svg-fs-bar';
  box.appendChild(stage);
  box.appendChild(bar);
  const tip = document.createElement('div');
  tip.className = 'img-lightbox-tip';
  tip.textContent = '滚轮滚动 · Ctrl+滚轮缩放 · 拖动平移 · Esc 关闭';
  box.appendChild(tip);
  document.body.appendChild(box);
  function close() {
    box.remove();
    window.removeEventListener('keydown', onKey);
    z.destroy();
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
  const z = MI.createZoomer({
    stage, el: svg, bar, initial: 'fit', keys: true,
    extra: [['✕ 关闭', '关闭（Esc）', () => close()]],
  });
  stage.addEventListener('click', (e) => { if (e.target === stage) close(); });
  window.addEventListener('keydown', onKey);
  return z;
};

// 给承载 mermaid 图的容器挂「全屏」按钮（md 预览 .mermaid-box / Live Preview .cm-md-mermaid）
MI.attachMermaidFullscreen = function (container, svg) {
  if (!container || !svg) return;
  container.classList.add('has-fs-btn');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mmd-fs-btn';
  b.textContent = '⛶';
  b.title = '全屏查看此图（Esc 关闭）';
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    MI.showSvgFullscreen(svg);
  });
  container.appendChild(b);
};

// Markdown
MI.registerRenderer(['md', 'markdown'], ({ path, content }) => {
  const wrap = document.createElement('div');
  wrap.className = 'md-view';
  let html = '';
  try {
    if (window.marked && window.marked.parse) {
      let src = content || '';
      // 去掉内嵌的 <!DOCTYPE html> 等声明，避免在预览顶部显示成乱文本
      src = src.replace(/<!DOCTYPE[^>]*>/gi, '');
      // Obsidian 风格 wiki 链接：[[笔记]] / [[笔记|别名]] / ![[图片.png]] → 标准链接
      src = src.replace(/!\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, (m, t) => `![${t.trim()}](${t.trim()})`);
      src = src.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (m, t, _p, alias) => `[${alias ? alias.trim() : t.trim()}](${t.trim()})`);
      html = window.marked.parse(src, { breaks: true, gfm: true });
    } else {
      html = '<pre>' + (content || '') + '</pre>';
    }
  } catch (e) {
    html = '<pre>渲染错误: ' + String(e) + '</pre>';
  }
  wrap.innerHTML = html;
  // 代码块语法高亮 + 复制/运行按钮（运行 = run:code IPC 写临时文件新开 cmd 执行）
  const RUNNABLE = ['js', 'javascript', 'node', 'py', 'python', 'bat', 'cmd', 'batch', 'powershell', 'ps1', 'pwsh', 'sh', 'bash'];
  wrap.querySelectorAll('pre code').forEach((el) => {
    if (window.hljs) { try { window.hljs.highlightElement(el); } catch {} }
    const lang = (el.className.match(/(?:language|lang)-([\w-]+)/) || [])[1] || '';
    const btn = document.createElement('span');
    btn.className = 'code-copy';
    btn.textContent = '复制';
    btn.onclick = () => { MI.copyText(el.innerText); MI.toast('已复制代码块', 'ok'); };
    const pre = el.parentElement;
    pre.style.position = 'relative';
    pre.insertBefore(btn, pre.firstChild);
    if (RUNNABLE.includes(lang.toLowerCase())) {
      const r = document.createElement('span');
      r.className = 'code-copy';
      r.textContent = '▶ 运行';
      r.title = '在新 cmd 窗口中运行此代码块';
      r.style.marginRight = '4px';
      r.onclick = async () => {
        r.textContent = '启动中…';
        try {
          const res = await window.myIDE.shell.runCode(el.innerText, lang);
          if (res && res.error) { r.textContent = '失败'; MI.toast('运行失败: ' + res.error, 'err'); }
          else r.textContent = '已运行';
        } catch (e) {
          r.textContent = '失败';
          MI.toast('运行失败: ' + e, 'err');
        }
        setTimeout(() => { r.textContent = '▶ 运行'; }, 1500);
      };
      pre.insertBefore(r, pre.firstChild);
    }
  });
  // mermaid 图（```mermaid 围栏）：mermaid.render 转 SVG 替换代码块
  if (window.mermaid) {
    const blocks = [...wrap.querySelectorAll('pre code.language-mermaid, pre code.lang-mermaid')];
    if (blocks.length) {
      try { mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: document.body.classList.contains('theme-light') ? 'default' : 'dark' }); } catch {}
      blocks.forEach(async (el) => {
        const code = el.textContent;
        const pre = el.parentElement;
        const div = document.createElement('div');
        div.className = 'mermaid-box';
        pre.replaceWith(div);
        try {
          const id = 'mmd-' + Math.random().toString(36).slice(2);
          const { svg } = await mermaid.render(id, code);
          div.innerHTML = svg;
          MI.attachMermaidFullscreen(div, div.querySelector('svg')); // 右上角「⛶ 全屏」
        } catch (e) {
          // 渲染失败：显示源码（可读可改），不吞错
          const pre2 = document.createElement('pre');
          pre2.className = 'mermaid-err';
          pre2.textContent = 'mermaid 渲染失败:\n' + code + '\n\n' + String((e && e.message) || e);
          div.replaceWith(pre2);
        }
      });
    }
  }
  // 图片相对路径 → 本地文件（以笔记所在目录为基准；交给浏览器规范化编码，避免双重编码）
  wrap.querySelectorAll('img').forEach((img) => {
    const src = (img.getAttribute('src') || '').trim();
    if (!src || /^(https?:|data:|blob:|file:)/i.test(src)) return;
    const baseDir = String(path || '').split(/[\\/]/);
    baseDir.pop(); // 去掉文件名，保留所在目录
    for (const seg of src.split(/[\\/]/)) {
      if (!seg || seg === '.') continue;
      if (seg === '..') baseDir.pop();
      else baseDir.push(seg);
    }
    img.src = 'file:///' + baseDir.join('/');
  });
  // 图片点击 → 全屏查看（lightbox：滚轮缩放/拖动平移/Esc 关闭）
  wrap.querySelectorAll('img').forEach((img) => {
    img.title = '点击全屏查看';
    img.addEventListener('click', (e) => {
      e.preventDefault();
      MI.showImgLightbox(img.src, img.alt);
    });
  });
  // 链接跳转：外链 → 系统浏览器；相对路径 → 打开本地文件；#锚点 → 页内滚动
  const resolveLocal = (rel) => {
    const base = String(path || '');
    const sep = base.includes('\\') ? '\\' : '/';
    const parts = base.split(/[\\/]/);
    parts.pop(); // 去掉文件名，保留所在目录
    for (const seg of rel.split(/[\\/]/)) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join(sep);
  };
  wrap.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', (e) => {
      const href = a.getAttribute('href') || '';
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      if (/^(https?:|mailto:)/i.test(href)) {
        if (window.myIDE && window.myIDE.shell) window.myIDE.shell.openExternal(href);
        return;
      }
      const hashIdx = href.indexOf('#');
      const filePart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
      const anchor = hashIdx >= 0 ? href.slice(hashIdx + 1) : '';
      if (!filePart) { scrollToAnchor(wrap, anchor); return; }
      let target = resolveLocal(filePart);
      // wiki 风格无扩展名 → 默认按 .md 打开（Obsidian 习惯）
      if (target && !/\.[A-Za-z0-9]{1,8}$/.test(target.split(/[\\/]/).pop() || target)) target += '.md';
      if (window.Viewer) Viewer.openFile(target);
      if (anchor) setTimeout(() => scrollToAnchor(document.querySelector('#viewer .md-view'), anchor), 300);
    });
  });
  return wrap;
});

// HTML → 沙箱 iframe 预览
MI.registerRenderer(['html', 'htm'], ({ path, content }) => {
  const frame = document.createElement('iframe');
  frame.className = 'html-frame';
  // allow-same-origin：继承主窗口 file:// 源，页面内相对路径的 CSS/图片才能加载（否则样式全丢）
  // allow-popups(+escape)：window.open / target=_blank 可用（原只能在浏览器实现的弹窗能力）
  // allow-downloads：页面内 a[download] / blob 下载可用
  frame.sandbox = 'allow-scripts allow-modals allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock';
  // 规范化开头（BOM / 前导空白 / "< !DOCTYPE" 写法），避免 DOCTYPE 被当成正文文本显示
  let src = String(content || '').replace(/^\uFEFF/, '');
  src = src.replace(/^\s*< ?!DOCTYPE/i, '<!DOCTYPE');
  // 注入 <base>：srcdoc 文档的默认基准是主窗口路径（renderer/），相对路径资源会指错地方
  // 以该 HTML 文件所在目录为基准后，link/script/img 的相对引用即可正确解析
  const dir = String(path || '').split(/[\\/]/).slice(0, -1).join('/');
  if (dir) {
    const baseTag = '<base href="file:///' + dir + '/">';
    if (/<head[^>]*>/i.test(src)) src = src.replace(/<head[^>]*>/i, (m) => m + baseTag);
    else if (/<!DOCTYPE[^>]*>/i.test(src)) src = src.replace(/(<!DOCTYPE[^>]*>)/i, '$1' + baseTag);
    else src = baseTag + src;
  }
  // 注入按键转发：沙箱 iframe 抢走焦点后 Ctrl+1/2/3 等快捷键仍能触发
  // ★ 必须追加到文档末尾：放在开头会把 DOCTYPE 挤到非首个 token 位置，
  //   浏览器按正文解析它 → 预览顶部显示「OCTYPE html>」碎片
  const forward = '<scr' + 'ipt>document.addEventListener("keydown",function(e){parent.postMessage({__myideKey:1,key:e.key,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey,metaKey:e.metaKey},"*");});<\/scr' + 'ipt>';
  frame.srcdoc = src + forward;
  return frame;
});

// JSON → 美化后的只读文本（可切源码编辑）
MI.registerRenderer(['json'], ({ content }) => {
  try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
});

// 图片（解码交给 Chromium，零依赖；工具条缩放/适应/全屏见 MI.buildImageViewer）
MI.registerRenderer(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'], ({ path }) => {
  return MI.buildImageViewer('file:///' + String(path).split('\\').join('/'), '图片预览');
});

// 视频（Chromium 解码，零依赖）
MI.registerRenderer(['mp4', 'webm', 'ogv', 'm4v', 'mkv', 'mov'], ({ path }) => {
  const wrap = document.createElement('div');
  wrap.className = 'media-view';
  const v = document.createElement('video');
  v.controls = true;
  v.src = 'file:///' + String(path).split('\\').join('/');
  wrap.appendChild(v);
  return wrap;
});

// 音频（Chromium 解码，零依赖）
MI.registerRenderer(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'], ({ path }) => {
  const wrap = document.createElement('div');
  wrap.className = 'media-view audio';
  const a = document.createElement('audio');
  a.controls = true;
  a.src = 'file:///' + String(path).split('\\').join('/');
  wrap.appendChild(a);
  return wrap;
});

// PDF（Chromium 内置查看器，零依赖）
MI.registerRenderer(['pdf'], ({ path }) => {
  const frame = document.createElement('iframe');
  frame.className = 'html-frame';
  frame.src = 'file:///' + String(path).split('\\').join('/');
  return frame;
});

// ---------- Office 预览（docx / xlsx / pptx，只读）----------
// 统一骨架：同步返回滚动容器（loading 态），内部异步 readBuffer → 前端库渲染；
// 失败 → 错误信息 + 重试（容器销毁时仍在跑的异步结果直接丢弃）
function officeShell(kind) {
  const wrap = document.createElement('div');
  wrap.className = 'office-view office-' + kind; // 顶层滚动容器：renderView 滚动恢复自动生效
  const status = document.createElement('div');
  status.className = 'office-status';
  status.textContent = '正在加载…';
  wrap.appendChild(status);
  return { wrap, status };
}
function officeFail(status, msg, retry) {
  status.className = 'office-status office-err';
  status.textContent = '';
  const p = document.createElement('div');
  p.textContent = '预览失败: ' + msg;
  const btn = document.createElement('button');
  btn.className = 'vt-btn office-retry';
  btn.textContent = '↻ 重试';
  btn.onclick = retry;
  status.append(p, btn);
}
async function officeLoad(path) {
  const r = await window.myIDE.fs.readBuffer(path);
  if (r && r.error) throw new Error(r.error);
  if (r && r.tooLarge) throw new Error('文件过大（' + Math.round(r.size / 1048576) + ' MB），超出 50MB 预览上限');
  if (!r || !r.buffer) throw new Error('无法读取文件内容');
  return r.buffer;
}

// Word（.docx）：docx-preview 渲染（分页 + 页眉页脚 + 图片表格）
// useBase64URL：图片/字体走 data: URL（CSP 已放行），容器销毁时无 blob URL 泄漏
MI.registerRenderer(['docx'], ({ path, name }) => {
  const { wrap, status } = officeShell('docx');
  const run = async () => {
    status.className = 'office-status';
    status.textContent = '正在解析文档…';
    try {
      const buf = await officeLoad(path);
      if (!window.docxPreview) throw new Error('docx 渲染库未加载');
      const stale = wrap.querySelector('.docx-body');
      if (stale) stale.remove(); // 重试时清掉旧内容
      const body = document.createElement('div');
      body.className = 'docx-body';
      wrap.appendChild(body);
      await MI.perf('office.docx ' + name, () => window.docxPreview.renderAsync(buf, body, null, {
        className: 'docx',
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: true,
        useBase64URL: true,
      }), 500);
      status.remove();
    } catch (e) {
      MI.logErr('office.docx', e);
      if (status.isConnected) officeFail(status, String((e && e.message) || e), run);
    }
  };
  run();
  return wrap;
});

// Excel（.xlsx）：SheetJS 解析 → sheet 标签条切换 + 只读表格
MI.registerRenderer(['xlsx'], ({ path, name }) => {
  const { wrap, status } = officeShell('xlsx');
  const run = async () => {
    status.className = 'office-status';
    status.textContent = '正在解析表格…（大文件可能需要数秒）';
    try {
      const buf = await officeLoad(path);
      if (!window.XLSX) throw new Error('xlsx 渲染库未加载');
      const book = await MI.perf('office.xlsx.parse ' + name,
        () => window.XLSX.read(buf, { type: 'array' }), 500);
      wrap.querySelectorAll('.sheet-tabs, .sheet-pane').forEach((el) => el.remove());
      if (!book.SheetNames || !book.SheetNames.length) throw new Error('工作簿中没有工作表');
      const tabs = document.createElement('div');
      tabs.className = 'sheet-tabs';
      const pane = document.createElement('div');
      pane.className = 'sheet-pane';
      const show = (i) => {
        [...tabs.children].forEach((b, j) => b.classList.toggle('active', i === j));
        // sheet_to_html 返回完整 HTML 文档串，截取 <table> 片段注入
        const html = String(window.XLSX.utils.sheet_to_html(book.Sheets[book.SheetNames[i]]) || '');
        const s = html.indexOf('<table'), e = html.lastIndexOf('</table>');
        pane.innerHTML = s >= 0 && e > s ? html.slice(s, e + 8) : '';
        const tb = pane.querySelector('table');
        if (tb) tb.className = 'sheet-table';
      };
      book.SheetNames.forEach((n, i) => {
        const b = document.createElement('button');
        b.className = 'sheet-tab';
        b.textContent = n;
        b.title = n;
        b.onclick = () => show(i);
        tabs.appendChild(b);
      });
      wrap.append(tabs, pane);
      show(0);
      status.remove();
    } catch (e) {
      MI.logErr('office.xlsx', e);
      if (status.isConnected) officeFail(status, String((e && e.message) || e), run);
    }
  };
  run();
  return wrap;
});

// PowerPoint（.pptx）：pptx-preview 渲染（幻灯片纵向排列）
// 宽度按容器自适应初始化一次；窗口后续缩放靠横向滚动兜底
MI.registerRenderer(['pptx'], ({ path, name }) => {
  const { wrap, status } = officeShell('pptx');
  const run = async () => {
    status.className = 'office-status';
    status.textContent = '正在解析幻灯片…（大文件可能需要数秒）';
    try {
      const buf = await officeLoad(path);
      if (!window.pptxPreview) throw new Error('pptx 渲染库未加载');
      const stale = wrap.querySelector('.pptx-body');
      if (stale) stale.remove();
      const body = document.createElement('div');
      body.className = 'pptx-body';
      wrap.appendChild(body);
      // 异步 IPC 往返后节点已插入 DOM，clientWidth 可靠
      const w = Math.max(Math.min((wrap.clientWidth || 960) - 48, 1280) || 960, 320);
      await MI.perf('office.pptx ' + name, async () => {
        const previewer = window.pptxPreview.init(body, { width: w, height: Math.round(w * 9 / 16) });
        await previewer.preview(buf);
      }, 500);
      status.remove();
    } catch (e) {
      MI.logErr('office.pptx', e);
      if (status.isConnected) officeFail(status, String((e && e.message) || e), run);
    }
  };
  run();
  return wrap;
});

// ---------- 加载用户插件（支持热重载去重）----------
let builtinCount = 0; // 内置渲染器数量（用户插件重载时截断用）
MI.loadPlugins = async function () {
  try {
    if (!builtinCount) builtinCount = MI.renderers.length; // 首次记录内置数量
    else MI.renderers.length = builtinCount; // 重载：丢弃旧的用户插件注册
    const list = await window.myIDE.plugins.loadAll();
    for (const p of list) {
      try {
        new Function('api', '"use strict";\n' + p.code)(MI);
        console.log('[plugin] loaded:', p.name);
      } catch (e) {
        console.error('[plugin] failed:', p.name, e);
        MI.toast('插件加载失败: ' + p.name + ' — ' + String(e.message || e), 'err');
      }
    }
  } catch (e) {
    console.error('[plugin] loadAll failed:', e);
  }
};

// ---------- 工具 ----------
MI.toast = function (msg, type) {
  const wrap = document.getElementById('toast-wrap');
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  wrap.appendChild(t);
  while (wrap.childElementCount > 5) wrap.firstChild.remove(); // 上限 5 条
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2200);
  setTimeout(() => t.remove(), 2600);
};

MI.copyText = function (text) {
  return window.myIDE.clip.copy(text);
};

MI.activeRoot = null; // 当前项目根目录（app.js 维护）
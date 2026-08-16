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

// ---------- 内置渲染器 ----------
// 页内锚点滚动（markdown 链接跳转用）
function scrollToAnchor(container, rawId) {
  if (!container || !rawId) return;
  const id = decodeURIComponent(rawId);
  const target = [...container.querySelectorAll('[id]')].find((el) => el.id === id);
  if (target) { try { target.scrollIntoView({ block: 'start' }); } catch {} }
}
// Markdown
MI.registerRenderer(['md', 'markdown'], ({ path, content }) => {
  const wrap = document.createElement('div');
  wrap.className = 'md-view';
  let html = '';
  try {
    if (window.marked && window.marked.parse) {
      html = window.marked.parse(content || '', { breaks: true, gfm: true });
    } else {
      html = '<pre>' + (content || '') + '</pre>';
    }
  } catch (e) {
    html = '<pre>渲染错误: ' + String(e) + '</pre>';
  }
  wrap.innerHTML = html;
  // 代码块语法高亮
  if (window.hljs) {
    wrap.querySelectorAll('pre code').forEach((el) => {
      try { window.hljs.highlightElement(el); } catch {}
      const btn = document.createElement('span');
      btn.className = 'code-copy';
      btn.textContent = '复制';
      btn.onclick = () => { MI.copyText(el.innerText); MI.toast('已复制代码块', 'ok'); };
      const pre = el.parentElement;
      pre.style.position = 'relative';
      pre.insertBefore(btn, pre.firstChild);
    });
  }
  // 图片相对路径 → 本地文件
  wrap.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src && !/^(https?:|data:|blob:)/.test(src)) {
      img.src = 'file:///' + String(window.MI.activeRoot || '').split('\\\\').join('/') + '/' + encodeURIComponent(src.replace(/^[\\\\/]+/, ''));
    }
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
      const target = resolveLocal(filePart);
      if (window.Viewer) Viewer.openFile(target);
      if (anchor) setTimeout(() => scrollToAnchor(document.querySelector('#viewer .md-view'), anchor), 300);
    });
  });
  return wrap;
});

// HTML → 沙箱 iframe 预览
MI.registerRenderer(['html', 'htm'], ({ content }) => {
  const frame = document.createElement('iframe');
  frame.className = 'html-frame';
  frame.sandbox = 'allow-scripts allow-modals allow-forms';
  frame.srcdoc = content || '';
  return frame;
});

// JSON → 美化后的只读文本（可切源码编辑）
MI.registerRenderer(['json'], ({ content }) => {
  try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
});

// 图片（解码交给 Chromium，零依赖）
MI.registerRenderer(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'], ({ path }) => {
  const wrap = document.createElement('div');
  wrap.className = 'img-view';
  const img = document.createElement('img');
  img.src = 'file:///' + String(path).split('\\').join('/');
  img.alt = '图片预览';
  wrap.appendChild(img);
  return wrap;
});

// PDF（Chromium 内置查看器，零依赖）
MI.registerRenderer(['pdf'], ({ path }) => {
  const frame = document.createElement('iframe');
  frame.className = 'html-frame';
  frame.src = 'file:///' + String(path).split('\\').join('/');
  return frame;
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
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
// Markdown
MI.registerRenderer(['md', 'markdown'], ({ content }) => {
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

// ---------- 加载用户插件 ----------
MI.loadPlugins = async function () {
  try {
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
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2200);
  setTimeout(() => t.remove(), 2600);
};

MI.copyText = function (text) {
  return window.myIDE.clip.copy(text);
};

MI.activeRoot = null; // 当前项目根目录（app.js 维护）
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
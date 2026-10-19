// 尺寸存在Markdown本身，避免换模式/重开后丢失；只在松手时写一次，撤销能还原整次拖动。
window.MarkdownImages = (() => {
  const size = label => {
    const match = /\|(\d{1,5})(?:x(\d{1,5}))?$/.exec(label || '');
    let escapes=0;if(match)for(let i=match.index-1;i>=0&&label[i]==='\\';i--)escapes++;
    return match && escapes%2===0 && +match[1] > 0 ? { width: Math.min(8192, +match[1]), label: label.slice(0, match.index) } : { width: null, label: label || '' };
  };
  function parse(raw) {
    const wiki = /^!\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]$/.exec(raw);
    if (wiki) {
      const label = wiki[2] || '', dimensions = /^\d+(?:x\d+)?$/.test(label) ? size('|' + label) : size(label);
      return { src: wiki[1].trim(), alt: dimensions.label || wiki[1], width: dimensions.width,
        resize: width => '![[' + wiki[1] + (dimensions.label ? '|' + dimensions.label : '') + (width ? '|' + width : '') + ']]' };
    }
    const head = /^!\[((?:\\.|[^\]\\])*)\]/.exec(raw);
    if (!head) return null;
    const token = window.marked?.Lexer?.lexInline(raw)?.[0];
    if (token?.type !== 'image' || token.raw !== raw) return null;
    const dimensions = size(head[1]);
    return { src: token.href, alt: size(token.text).label, width: dimensions.width,
      resize: width => '![' + dimensions.label + (width ? '|' + width : '') + raw.slice(head[0].length - 1) };
  }
  const toast = (message, bad = false) => window.MI?.toast(message, bad ? 'err' : undefined);
  function bind(img, options = {}) {
    const host = options.host || img.parentElement;
    const model = options.model || size(img.alt);
    if (model.width) img.style.width = model.width + 'px';
    img.alt = model.alt ?? model.label ?? img.alt;
    img.draggable = false;
    const valid = () => img.isConnected && (!options.valid || options.valid());
    let drag = null, suppressClick = false;
    function stop(commit = false) {
      if (!drag) return;
      const state = drag; drag = null; state.controller.abort();
      try { handle.releasePointerCapture(state.pointerId); } catch {}
      host.classList.remove('md-image-dragging');
      img.style.width = state.original;
      options.measure?.();
      if (commit && state.moved && valid()) {
        suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
        // 菜单/指针事件不应把光标送进图片源码，也不能向已切走的文档提交旧坐标。
        if (options.resize?.(state.width) === false) toast('图片位置或文档状态已变化，请重试', true);
      }
    }
    const handle = document.createElement('button');
    handle.type = 'button'; handle.className = 'md-image-resize'; handle.title = '拖动调整图片大小（保持比例）';
    handle.setAttribute('aria-label', '调整图片大小');
    handle.innerHTML = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13L13 3M7 13h6V7"/></svg>';
    if (options.resize) { host.classList.add('md-image-frame'); host.appendChild(handle); }
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !valid() || options.editable?.() === false || !img.naturalWidth) return;
      e.preventDefault(); e.stopPropagation(); stop();
      const controller = new AbortController(), rect = img.getBoundingClientRect();
      drag = { controller, pointerId:e.pointerId, original: img.style.width, width: Math.round(rect.width), x: e.clientX, y: e.clientY, start: rect.width, ratio: rect.width / rect.height, moved: false };
      host.classList.add('md-image-dragging');
      try { handle.setPointerCapture(e.pointerId); } catch {}
      const on = (type, fn) => window.addEventListener(type, fn, { signal: controller.signal, capture: true });
      on('pointermove', event => {
        if (event.pointerId !== e.pointerId) return;
        if (!valid() || options.editable?.() === false) { stop(); return; }
        event.preventDefault();
        const dx = event.clientX - drag.x, dy = (event.clientY - drag.y) * drag.ratio;
        drag.width = Math.round(Math.max(24, Math.min(8192, drag.start + (Math.abs(dx) >= Math.abs(dy) ? dx : dy))));
        drag.moved ||= Math.abs(dx) + Math.abs(dy) > 2;
        img.style.width = drag.width + 'px'; options.measure?.();
      });
      on('pointerup', event => { if (event.pointerId === e.pointerId) { event.preventDefault(); event.stopPropagation(); stop(true); } });
      on('lostpointercapture', event => { if(event.pointerId===e.pointerId)stop(); });
      on('pointercancel', () => stop()); on('blur', () => stop());
      on('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); stop(); } });
    });
    handle.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
    img.addEventListener('click', e => { if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
    img.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation(); if (!valid()) return;
      const menu = document.getElementById('ctx-menu'); if (!menu) return;
      stop(); menu.replaceChildren();
      const item = (label, fn, enabled = true) => {
        const row = document.createElement('div'); row.className = 'ctx-item'; row.textContent = label;
        row.setAttribute('aria-disabled', String(!enabled));
        row.onclick = () => { menu.classList.add('hidden'); if (enabled && valid()) Promise.resolve().then(fn).catch(error => toast(error.message || String(error), true)); };
        menu.append(row);
      };
      item('📋 复制图片', async () => {
        await new Promise(resolve => requestAnimationFrame(resolve)); if (!valid()) return;
        // 长图中心可能在滚动容器外；使用实际右击点，避免复制到被工具栏遮住的位置。
        const x = Math.floor(e.clientX), y = Math.floor(e.clientY);
        if (document.elementFromPoint(x, y) !== img) throw Error('图片已移出可见区域，请重新右键复制');
        const result = await window.myIDE.clip.copyImageAt(x, y);
        if (!result?.ok) throw Error(result?.error || '复制图片失败'); toast('已复制图片');
      }, !!img.naturalWidth);
      if (options.resize) item('↔ 恢复默认大小', () => { if (options.resize(null) === false) throw Error('图片位置或文档状态已变化，请重试'); }, options.editable?.() !== false);
      menu.classList.remove('hidden');
      menu.style.left = Math.max(0, Math.min(e.clientX, innerWidth - menu.offsetWidth)) + 'px';
      menu.style.top = Math.max(0, Math.min(e.clientY, innerHeight - menu.offsetHeight)) + 'px';
    });
    return () => { stop(); handle.remove(); };
  }
  return { parse, size, bind };
})();

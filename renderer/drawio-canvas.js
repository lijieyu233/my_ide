window.DrawioCanvas = (() => {
  const { coordinate, worldCoordinate, textColorDefault, textBackgroundDefault } = DrawioCanvasDocument;
  const maxBytes = 8 * 1024 * 1024;
  const formats = new Map([
    ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'], ['webp', 'image/webp'], ['bmp', 'image/bmp'],
  ]);


  function mimeOf(name) {
    return formats.get(name.split('.').at(-1).toLowerCase());
  }

  async function decodeImage(file) {
    if (file.size > maxBytes * 0.75) throw Error('单张图片太大，请缩小后再粘贴');
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(Error('无法读取图片'));
      reader.readAsDataURL(file);
    });
    const image = new Image();
    image.src = url;
    try { await image.decode(); } catch { throw Error('无法解码图片'); }
    return { mime: file.type, data: url.split(',')[1], width: image.naturalWidth, height: image.naturalHeight };
  }

  async function clipboardImages() {
    const { clip, fs } = window.myIDE;
    const image = await clip.readImage();
    if (image?.ok && !image.empty && image.png) {
      return [{ mime: 'image/png', data: image.png, width: image.width, height: image.height }];
    }
    const paths = (await clip.getFiles()).filter(path => mimeOf(path));
    return readBatch(paths, async path => {
      const mime = mimeOf(path);
      const result = await fs.readBuffer(path);
      if (!result.buffer) throw Error(result.tooLarge ? '单张图片太大，请缩小后再粘贴' : result.error || '无法读取图片');
      return decodeImage(new Blob([result.buffer], { type: mime }));
    });
  }

  async function readBatch(values, readImage) {
    const images = [];
    let bytes = 0;
    for (const value of values) {
      const image = await readImage(value);
      bytes += image.data.length;
      if (bytes >= maxBytes) throw Error('这批图片超过画布容量，请缩小图片或分到另一个画布');
      images.push(image);
    }
    return images;
  }

  function mount(parent, { canvas, isCurrent, onChange, onDispose, viewState }) {
    const panel = document.createElement('div');
    panel.className = 'diagram-canvas-panel';
    const toolbar = document.createElement('div');
    toolbar.className = 'diagram-canvas-toolbar';
    const viewport = document.createElement('div'), board = document.createElement('div');
    const layer = document.createElement('div');
    viewport.className = 'diagram-canvas-scroll';
    board.className = 'diagram-canvas-board';
    layer.className = 'diagram-canvas-content';
    board.append(layer);
    board.tabIndex = 0;
    board.setAttribute('aria-label', '图文画布');
    viewport.append(board);
    panel.append(toolbar, viewport);
    parent.append(panel);

    let { items, background, grid } = canvas;
    let selected = null, pasteBusy = false, zoom = viewState?.zoom || 1, textSession = null;
    let originX = viewState?.originX || 0, originY = viewState?.originY || 0;
    let spaceDown = false, cancelGesture = null, disposed = false;
    const undo = viewState?.undo || [], redo = viewState?.redo || [];
    const nodes = new Map();
    const focus = () => board.focus({ preventScroll: true });
    const position = (x, y) => ({ x: worldCoordinate(x), y: worldCoordinate(y) });
    const camera = () => ({
      x: originX + viewport.scrollLeft / zoom, y: originY + viewport.scrollTop / zoom,
    });
    const svgNS = 'http://www.w3.org/2000/svg';
    const wireLayer = document.createElementNS(svgNS, 'svg');
    wireLayer.classList.add('diagram-canvas-edges');
    wireLayer.setAttribute('aria-hidden', 'true');

    function group(label) {
      const container = document.createElement('div');
      container.className = 'diagram-canvas-tools';
      container.setAttribute('role', 'group');
      container.setAttribute('aria-label', label);
      toolbar.append(container);
      return container;
    }
    function button(container, text, title, action) {
      const element = document.createElement('button');
      element.className = 'vt-btn';
      element.textContent = text;
      element.title = title;
      element.setAttribute('aria-label', title);
      element.onclick = action;
      container.append(element);
      return element;
    }
    function control(container, text, type, change) {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = type;
      input.onchange = () => change(input);
      label.append(text, input);
      container.append(label);
      return input;
    }

    const insertion = group('插入');
    const pasteButton = button(insertion, '粘贴图片', '粘贴图片（Ctrl+V）', () => void paste());
    button(insertion, '添加文字', '添加文字', () => {
      const view = camera();
      addText(position((selected?.x ?? view.x) + 24, (selected?.y ?? view.y) + 24));
    });
    const editing = group('编辑');
    const undoButton = button(editing, '撤销', '撤销（Ctrl+Z）', () => history(undo, redo));
    const redoButton = button(editing, '重做', '重做（Ctrl+Y）', () => history(redo, undo));
    const deleteButton = button(editing, '删除元素', '删除选中项（Delete）', removeSelected);
    const view = group('画布视图');
    button(view, '−', '缩小画布', () => setZoom(zoom - 0.1));
    const zoomButton = button(view, '', '实际大小（100%）', () => setZoom(1));
    button(view, '+', '放大画布', () => setZoom(zoom + 0.1));
    button(view, '适应', '适应内容', fitContent);
    const appearance = group('画布外观');
    appearance.classList.add('diagram-canvas-appearance');
    const backgroundButton = button(appearance, '背景', '画布背景', () => {
      const open = backgroundPanel.hidden;
      backgroundPanel.hidden = !open;
      backgroundButton.setAttribute('aria-expanded', String(open));
      if (open) {
        colorInput.value = background;
        colorInput.setCustomValidity('');
      }
    });
    backgroundButton.setAttribute('aria-expanded', 'false');
    const swatch = document.createElement('span');
    swatch.className = 'diagram-canvas-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    backgroundButton.append(swatch);
    const backgroundPanel = document.createElement('div');
    backgroundPanel.className = 'diagram-canvas-palette';
    backgroundPanel.hidden = true;
    const palette = document.createElement('div');
    palette.className = 'diagram-canvas-colors';
    for (const [name, color] of [
      ['白', '#ffffff'], ['浅灰', '#f6f7fa'], ['米色', '#fff3d9'], ['浅蓝', '#dfebfa'],
      ['浅绿', '#dcefe1'], ['浅粉', '#f9e2e9'], ['深灰', '#252d38'], ['黑', '#14171c'],
    ]) {
      const choice = button(palette, '', name + '色背景', () => applyBackground(color));
      choice.dataset.color = color;
      choice.style.backgroundColor = color;
    }
    const custom = document.createElement('div');
    custom.className = 'diagram-canvas-custom-color';
    const colorInput = document.createElement('input');
    colorInput.type = 'text';
    colorInput.autocomplete = 'off';
    colorInput.spellcheck = false;
    colorInput.maxLength = 7;
    colorInput.setAttribute('aria-label', '自定义背景色');
    colorInput.placeholder = '#RRGGBB';
    colorInput.oninput = () => colorInput.setCustomValidity('');
    custom.append(colorInput);
    button(custom, '应用', '应用背景色', () => applyBackground(colorInput.value));
    backgroundPanel.append(palette, custom);
    appearance.append(backgroundPanel);
    button(appearance, '还原', '还原打开文件时的背景', () => change(() => { background = canvas.background; }));
    const gridInput = control(appearance, '网格', 'checkbox', input => change(() => { grid = input.checked; }));
    const textTools = group('文字样式');
    const fontInput = control(textTools, '字号', 'number', input => updateFont({
      fontSize: Math.max(8, Math.min(96, Number(input.value) || 16)),
    }));
    fontInput.min = '8';
    fontInput.max = '96';
    const fontColorInput = control(textTools, '文字颜色', 'color', input => updateFont({ color: input.value }));
    const imageTools = group('图片尺寸');
    const widthInput = control(imageTools, '宽', 'number', input => resizeSelectedImage('width', input.value));
    const heightInput = control(imageTools, '高', 'number', input => resizeSelectedImage('height', input.value));
    for (const [input, label] of [[widthInput, '图片宽度'], [heightInput, '图片高度']]) {
      input.min = '1';
      input.max = '100000';
      input.setAttribute('aria-label', label);
      input.title = '以像素计，调整时保持图片比例';
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          input.blur();
          focus();
        }
      });
    }
    const originalSize = button(imageTools, '原始大小', '恢复图片原始大小', () => {
      const image = nodes.get(selected?.id)?.querySelector('img');
      if (!image?.naturalWidth || !image.naturalHeight) return;
      const { naturalWidth: width, naturalHeight: height } = image;
      const limit = Math.min(1, 100000 / Math.max(width, height));
      change(() => updateImageSize(selected, width, height, limit));
    });

    function closeBackground() {
      backgroundPanel.hidden = true;
      backgroundButton.setAttribute('aria-expanded', 'false');
    }
    function applyBackground(input) {
      let color = input.trim().toLowerCase();
      if (!color.startsWith('#')) color = '#' + color;
      if (/^#[0-9a-f]{3}$/.test(color)) color = '#' + [...color.slice(1)].map(c => c + c).join('');
      if (!/^#[0-9a-f]{6}$/.test(color)) {
        colorInput.setCustomValidity('请输入 3 位或 6 位十六进制颜色');
        colorInput.reportValidity?.();
        return;
      }
      closeBackground();
      if (color === background) focus();
      else change(() => { background = color; });
    }
    backgroundPanel.onkeydown = event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeBackground();
        backgroundButton.focus();
      } else if (event.key === 'Enter' && event.target === colorInput) {
        event.preventDefault();
        event.stopPropagation();
        applyBackground(colorInput.value);
      }
    };
    const dismissBackground = event => {
      if (!backgroundPanel.hidden && !backgroundPanel.contains(event.target) && !backgroundButton.contains(event.target)) closeBackground();
    };
    document.addEventListener('pointerdown', dismissBackground);

    function bounds() {
      let left = 0, top = 0, right = 0, bottom = 0;
      for (const item of items) {
        if (item.type === 'edge') continue;
        left = Math.min(left, item.x);
        top = Math.min(top, item.y);
        right = Math.max(right, item.x + item.width);
        bottom = Math.max(bottom, item.y + item.height);
      }
      return { left, top, right, bottom };
    }
    function fit(point = camera()) {
      // 滚动坐标始终为正，画布坐标可在原点左侧和上方继续扩展。
      const { left, top, right, bottom } = bounds();
      const x = Math.min(100000, Math.max(-100048, point.x));
      const y = Math.min(100000, Math.max(-100048, point.y));
      originX = Math.min(originX, x, left < 0 ? left - 48 : 0);
      originY = Math.min(originY, y, top < 0 ? top - 48 : 0);
      layer.style.transform = 'translate(' + -originX + 'px,' + -originY + 'px)';
      board.style.width = Math.ceil(Math.max(x + viewport.clientWidth / zoom, right + 48) - originX) + 'px';
      board.style.height = Math.ceil(Math.max(y + viewport.clientHeight / zoom, bottom + 48) - originY) + 'px';
      board.style.zoom = zoom;
      viewport.scrollLeft = (x - originX) * zoom;
      viewport.scrollTop = (y - originY) * zoom;
      zoomButton.textContent = Math.round(zoom * 100) + '%';
    }
    function setZoom(value, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
      cancelGesture?.();
      const old = zoom;
      const current = camera();
      zoom = Math.min(4, Math.max(0.1, Math.round(value * 100) / 100));
      fit({ x: current.x + x / old - x / zoom, y: current.y + y / old - y / zoom });
      if (!textSession) focus();
    }
    function fitContent() {
      const { left, top, right, bottom } = bounds();
      const width = right - left, height = bottom - top;
      const ratio = Math.min(viewport.clientWidth / (width + 48), viewport.clientHeight / (height + 48), 2);
      setZoom(width && height ? ratio : 1, 0, 0);
      fit({ x: left < 0 ? left - 24 : 0, y: top < 0 ? top - 24 : 0 });
    }
    function syncTools() {
      undoButton.disabled = !undo.length;
      redoButton.disabled = !redo.length;
      deleteButton.disabled = !selected;
      swatch.style.backgroundColor = background;
      for (const choice of palette.children) choice.setAttribute('aria-pressed', String(choice.dataset.color === background));
      gridInput.checked = grid;
      board.style.backgroundColor = background;
      board.classList.toggle('show-grid', grid);
      textTools.hidden = !selected || !['text', 'rectangle'].includes(selected.type);
      if (!textTools.hidden) {
        fontInput.value = selected.fontSize;
        fontColorInput.value = selected.color;
      }
      imageTools.hidden = selected?.type !== 'image';
      if (!imageTools.hidden) {
        widthInput.value = selected.width;
        heightInput.value = selected.height;
        originalSize.disabled = !nodes.get(selected.id)?.querySelector('img')?.naturalWidth;
      }
    }
    function select(item) {
      nodes.get(selected?.id)?.classList.remove('selected');
      selected = item;
      nodes.get(item?.id)?.classList.add('selected');
      syncTools();
    }
    const state = () => ({ items: items.filter(item => item.cell || item.type !== 'text' || item.text)
      .map(item => ({ ...item })), background, grid, selected: selected?.id });

    function save() {
      if (!isCurrent()) return false;
      if (onChange(DrawioCanvasDocument.serialize(canvas, state()), maxBytes)) return true;
      MI.toast('图文画布超过 8 MiB，请缩小图片或分到另一个画布', 'err');
      return false;
    }
    function remember(before) {
      undo.push(before);
      if (undo.length > 40) undo.shift();
      redo.length = 0;
      syncTools();
    }
    function restore(snapshot) {
      ({ background, grid } = snapshot);
      items = snapshot.items.map(item => ({ ...item }));
      nodes.clear();
      layer.replaceChildren(wireLayer);
      items.filter(item => item.type !== 'edge').forEach(add);
      select(items.find(item => item.id === snapshot.selected) || null);
      fit();
      drawEdges();
    }
    function change(update) {
      cancelGesture?.();
      finishText();
      const before = state();
      update();
      if (save()) remember(before);
      else restore(before);
      syncTools();
      focus();
    }
    function history(from, to) {
      cancelGesture?.();
      finishText();
      const snapshot = from.at(-1);
      if (!snapshot) return;
      const before = state();
      restore(snapshot);
      if (save()) {
        from.pop();
        to.push(before);
      } else restore(before);
      syncTools();
      focus();
    }
    function removeSelected() {
      if (!selected) return;
      change(() => {
        const id = selected?.id;
        items = items.filter(item => item.id !== id && item.source !== id && item.target !== id);
        restore({ items, background, grid });
      });
    }
    function updateFont(values) {
      if (!selected || textTools.hidden) return;
      change(() => {
        if (!selected) return;
        Object.assign(selected, { ...values, fontChanged: true });
        const element = nodes.get(selected.id);
        place(element, selected);
        if (selected.type === 'text' && values.fontSize) {
          element.style.height = '0';
          selected.height = coordinate(Math.max(42, element.scrollHeight,
            Math.ceil(selected.fontSize * 1.45) * selected.text.split('\n').length + 12));
          place(element, selected);
          fit();
        }
      });
    }
    function updateImageSize(item, width, height, factor) {
      const ratio = Math.max(1 / Math.min(width, height), Math.min(100000 / Math.max(width, height), factor));
      item.width = Math.round(width * ratio);
      item.height = Math.round(height * ratio);
      place(nodes.get(item.id), item);
      fit();
      drawEdges();
    }
    function resizeSelectedImage(dimension, value) {
      if (selected?.type !== 'image') return;
      const next = Number(value);
      if (!value || !Number.isFinite(next) || next < 1) {
        syncTools();
        return;
      }
      if (next === selected[dimension]) return;
      const { width, height } = selected, factor = next / selected[dimension];
      change(() => updateImageSize(selected, width, height, factor));
    }

    function drawEdges() {
      const byId = new Map(items.map(item => [item.id, item]));
      const lines = items.filter(item => item.type === 'edge').map(edge => {
        const a = byId.get(edge.source), b = byId.get(edge.target);
        const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
        const bx = b.x + b.width / 2, by = b.y + b.height / 2;
        const horizontal = Math.abs(bx - ax) >= Math.abs(by - ay);
        const direction = horizontal ? Math.sign(bx - ax) || 1 : Math.sign(by - ay) || 1;
        const start = horizontal ? [ax + direction * a.width / 2, ay] : [ax, ay + direction * a.height / 2];
        const end = horizontal ? [bx - direction * b.width / 2, by] : [bx, by - direction * b.height / 2];
        const via = horizontal ? [[(start[0] + end[0]) / 2, ay], [(start[0] + end[0]) / 2, by]] :
          [[ax, (start[1] + end[1]) / 2], [bx, (start[1] + end[1]) / 2]];
        const points = [start, ...(edge.orthogonal ? via : []), end];
        const path = document.createElementNS(svgNS, 'path');
        const [x, y] = end;
        const [px, py] = [...points].reverse().find(point => point[0] !== x || point[1] !== y) || start;
        const angle = Math.atan2(y - py, x - px);
        const wing = side => [x - 9 * Math.cos(angle + side * 0.47), y - 9 * Math.sin(angle + side * 0.47)];
        const arrow = edge.arrow ? ' M ' + wing(-1).join(' ') + ' L ' + end.join(' ') + ' L ' + wing(1).join(' ') : '';
        path.setAttribute('d', 'M ' + points.map(point => point.join(' ')).join(' L ') + arrow);
        path.setAttribute('stroke', edge.stroke);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-width', '1.4');
        return path;
      });
      wireLayer.replaceChildren(...lines);
    }
    function place(element, item) {
      Object.assign(element.style, {
        left: item.x + 'px', top: item.y + 'px', width: item.width + 'px', height: item.height + 'px',
      });
      if (item.type === 'image') return;
      Object.assign(element.style, {
        fontSize: item.fontSize + 'px', color: item.color, backgroundColor: item.fill,
        borderColor: item.stroke || '', borderRadius: item.rounded ? '8px' : '',
      });
    }
    function finishText() {
      if (textSession) textSession.input.blur();
    }
    function editText(item) {
      if (textSession?.item === item) return;
      finishText();
      select(item);
      const element = nodes.get(item.id);
      const input = document.createElement('textarea');
      const before = state();
      let remembered = false;
      input.value = item.text;
      input.setAttribute('aria-label', '文字标注');
      input.placeholder = '输入文字';
      element.replaceChildren(input);
      textSession = { input, item };
      input.oninput = () => {
        const previous = { text: item.text, height: item.height };
        item.text = input.value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '');
        if (item.type === 'text') {
          input.style.height = '0px';
          item.height = coordinate(Math.max(42, input.scrollHeight, Math.ceil(item.fontSize * 1.45) * item.text.split('\n').length + 12));
          input.style.height = '';
        }
        if (!save()) {
          Object.assign(item, previous);
          input.value = previous.text;
        } else if (!remembered && previous.text !== item.text) {
          remember(before);
          remembered = true;
        }
        place(element, item);
        fit();
        drawEdges();
      };
      input.onblur = () => {
        textSession = null;
        if (item.type === 'text' && !item.text && !item.cell) {
          items.splice(items.indexOf(item), 1);
          nodes.delete(item.id);
          element.remove();
          select(null);
          fit();
        } else element.textContent = item.text;
      };
      input.onkeydown = event => {
        if (!event.isComposing && (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey)))) {
          event.stopPropagation();
          event.preventDefault();
          focus();
        }
      };
      input.focus();
    }
    function trackPointer(element, event, update, finish, scrollAtEdge = false) {
      const id = event.pointerId;
      let scrollTimer = 0, pointer = event;
      element.setPointerCapture(id);
      const move = () => update(pointer.clientX - event.clientX, pointer.clientY - event.clientY);
      function scroll() {
        scrollTimer = 0;
        const rect = viewport.getBoundingClientRect(), margin = 28;
        const speed = (point, start, end) => {
          if (point < start + margin) return -Math.min(20, (start + margin - point) / 2);
          if (point > end - margin) return Math.min(20, (point - end + margin) / 2);
          return 0;
        };
        const dx = speed(pointer.clientX, rect.left, rect.right), dy = speed(pointer.clientY, rect.top, rect.bottom);
        if (!dx && !dy) return;
        const current = camera();
        fit({ x: current.x + dx / zoom, y: current.y + dy / zoom });
        move();
        scrollTimer = setTimeout(scroll, 16);
      }
      const stop = cancelled => {
        clearTimeout(scrollTimer);
        element.onpointermove = element.onpointerup = element.onpointercancel = element.onlostpointercapture = null;
        cancelGesture = null;
        if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
        finish(cancelled);
      };
      cancelGesture = () => stop(true);
      element.onpointermove = next => {
        if (next.pointerId !== id) return;
        pointer = next;
        if (scrollAtEdge && !scrollTimer) scrollTimer = setTimeout(scroll, 16);
        move();
      };
      element.onpointerup = end => { if (end.pointerId === id) stop(false); };
      element.onpointercancel = end => { if (end.pointerId === id) stop(true); };
      element.onlostpointercapture = end => { if (end.pointerId === id) stop(true); };
    }
    function add(item) {
      const element = document.createElement('div');
      element.className = 'diagram-canvas-item ' + item.type;
      place(element, item);
      let handle;
      if (item.type === 'image') {
        const image = document.createElement('img');
        image.alt = '画布图片';
        image.draggable = false;
        image.onload = () => { if (selected === item) syncTools(); };
        image.src = 'data:' + item.mime + ';base64,' + item.data;
        handle = document.createElement('span');
        handle.className = 'diagram-canvas-resize';
        handle.title = '拖动调整图片大小（保持比例）';
        element.append(image, handle);
      } else {
        element.textContent = item.text;
        element.ondblclick = () => editText(item);
      }
      element.onpointerdown = event => {
        if (event.button !== 0 || spaceDown || cancelGesture || event.target.tagName === 'TEXTAREA') return;
        focus();
        select(item);
        const resizing = event.target === handle;
        const { x, y, width, height } = item, before = state(), origin = camera();
        trackPointer(element, event, (dx, dy) => {
          const current = camera();
          dx = dx / zoom + current.x - origin.x;
          dy = dy / zoom + current.y - origin.y;
          if (resizing) {
            const factor = Math.abs(dx / width) > Math.abs(dy / height) ? 1 + dx / width : 1 + dy / height;
            updateImageSize(item, width, height, factor);
            syncTools();
          } else {
            Object.assign(item, position(x + dx, y + dy));
            place(element, item);
            drawEdges();
          }
        }, cancelled => {
          const changed = x !== item.x || y !== item.y || width !== item.width || height !== item.height;
          if (cancelled || (changed && !save())) Object.assign(item, { x, y, width, height });
          else if (changed) remember(before);
          place(element, item);
          fit();
          drawEdges();
          syncTools();
        }, true);
      };
      nodes.set(item.id, element);
      layer.append(element);
    }
    function addText(where) {
      if (!isCurrent()) return;
      finishText();
      const item = { id: crypto.randomUUID(), type: 'text', text: '', width: 240, height: 42,
        fontSize: 16, color: textColorDefault, fill: textBackgroundDefault, ...where };
      items.push(item);
      add(item);
      fit();
      editText(item);
    }
    async function paste(files = []) {
      if (pasteBusy || !isCurrent()) return;
      pasteBusy = pasteButton.disabled = true;
      try {
        const images = files.length ? await readBatch(files, decodeImage) : await clipboardImages();
        if (!isCurrent()) return;
        if (!images.length) {
          MI.toast('剪贴板中没有可粘贴的图片', 'err');
          return;
        }
        cancelGesture?.();
        finishText();
        const before = state();
        const view = camera();
        let y = Math.max(view.y + 32, bounds().bottom + 24);
        const additions = images.map(image => {
          const scale = Math.min(1, 600 / image.width, 400 / image.height);
          const height = Math.max(1, Math.round(image.height * scale));
          const item = { ...image, id: crypto.randomUUID(), type: 'image', ...position(view.x + 32, y),
            width: Math.max(1, Math.round(image.width * scale)), height };
          y += height + 24;
          return item;
        });
        items.push(...additions);
        if (!save()) {
          items.splice(-additions.length);
          return;
        }
        additions.forEach(add);
        fit();
        focus();
        select(additions[0]);
        remember(before);
        nodes.get(additions[0].id).scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      } catch (error) {
        if (isCurrent()) MI.toast(String(error.message || error), 'err');
      } finally {
        pasteBusy = pasteButton.disabled = false;
      }
    }
    board.ondblclick = event => {
      if (event.target !== board) return;
      const rect = board.getBoundingClientRect();
      addText(position(originX + (event.clientX - rect.left) / zoom, originY + (event.clientY - rect.top) / zoom));
    };
    board.onpointerdown = event => {
      if ((spaceDown && event.button === 0 || event.button === 1) && !cancelGesture) {
        event.preventDefault();
        focus();
        const start = camera();
        trackPointer(board, event, (dx, dy) => {
          fit({ x: start.x - dx / zoom, y: start.y - dy / zoom });
        }, () => {});
      } else if (event.target === board && event.button === 0) {
        focus();
        select(null);
      }
    };
    viewport.addEventListener('wheel', event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = viewport.getBoundingClientRect();
      setZoom(zoom + (event.deltaY < 0 ? 0.1 : -0.1), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    panel.onpaste = event => {
      if (event.target.tagName === 'TEXTAREA') return;
      const files = [...(event.clipboardData?.files || [])].filter(file => [...formats.values()].includes(file.type));
      event.preventDefault();
      event.stopPropagation();
      void paste(files);
    };
    panel.onkeydown = event => {
      if (event.isComposing || event.target.tagName === 'TEXTAREA' || event.target.tagName === 'INPUT') return;
      const command = (event.ctrlKey || event.metaKey) && event.key.toLowerCase();
      if (command === 'v') {
        event.preventDefault();
        event.stopPropagation();
        void paste();
      } else if (command === 'z' || command === 'y') {
        event.preventDefault();
        event.stopPropagation();
        const backward = command === 'z' && !event.shiftKey;
        history(backward ? undo : redo, backward ? redo : undo);
      } else if (command === 'c' || command === 'x') {
        event.stopPropagation();
      } else if (event.key === ' ' && event.target === board) {
        event.preventDefault();
        spaceDown = true;
        board.classList.add('pan');
      } else if (event.key === 'Enter' && event.target === board && selected && selected.type !== 'image') {
        event.preventDefault();
        editText(selected);
      } else if (event.key === 'Delete') {
        event.preventDefault();
        event.stopPropagation();
        removeSelected();
      } else if (event.target === board && selected && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        change(() => {
          Object.assign(selected, position(selected.x + dx, selected.y + dy));
          place(nodes.get(selected.id), selected);
          fit();
          drawEdges();
        });
      }
    };
    const stopPan = () => { spaceDown = false; board.classList.remove('pan'); };
    board.onblur = stopPan;
    board.onkeyup = event => { if (event.key === ' ') stopPan(); };
    restore({ items, background, grid });
    if (viewState) {
      fit({ x: originX + viewState.left / zoom, y: originY + viewState.top / zoom });
    }
    let resize;
    if (typeof ResizeObserver === 'function') {
      resize = new ResizeObserver(() => { if (!disposed) fit(); });
      resize.observe(viewport);
    }
    panel.focusEditor = focus;
    panel.previewDispose = () => {
      disposed = true;
      resize?.disconnect();
      document.removeEventListener('pointerdown', dismissBackground);
      cancelGesture?.();
      onDispose({ zoom, originX, originY, left: viewport.scrollLeft, top: viewport.scrollTop, undo, redo });
    };
    return panel;
  }

  return { read: DrawioCanvasDocument.read, mount };
})();

window.DrawioCanvas = (() => {
  const { coordinate, textColorDefault, textBackgroundDefault } = DrawioCanvasDocument;
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
    viewport.className = 'diagram-canvas-scroll';
    board.className = 'diagram-canvas-board';
    board.tabIndex = 0;
    board.setAttribute('aria-label', '图文画布');
    viewport.append(board);
    panel.append(toolbar, viewport);
    parent.append(panel);

    let { items, background, grid } = canvas;
    let selected = null, pasteBusy = false, zoom = viewState?.zoom || 1, textSession = null;
    let spaceDown = false, cancelGesture = null, disposed = false;
    const undo = viewState?.undo || [], redo = viewState?.redo || [];
    const nodes = new Map();
    const focus = () => board.focus({ preventScroll: true });
    const position = (x, y) => ({ x: coordinate(x), y: coordinate(y) });
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
      addText(position((selected?.x ?? viewport.scrollLeft / zoom) + 24, (selected?.y ?? viewport.scrollTop / zoom) + 24));
    });
    const editing = group('编辑');
    const undoButton = button(editing, '撤销', '撤销（Ctrl+Z）', () => history(undo, redo));
    const redoButton = button(editing, '重做', '重做（Ctrl+Y）', () => history(redo, undo));
    const deleteButton = button(editing, '删除', '删除选中项（Delete）', removeSelected);
    const view = group('画布视图');
    button(view, '−', '缩小画布', () => setZoom(zoom - 0.1));
    const zoomButton = button(view, '', '实际大小（100%）', () => setZoom(1));
    button(view, '+', '放大画布', () => setZoom(zoom + 0.1));
    button(view, '适应', '适应内容', fitContent);
    const appearance = group('画布外观');
    const backgroundInput = control(appearance, '背景', 'color', input => change(() => { background = input.value; }));
    button(appearance, '还原', '还原打开文件时的背景', () => change(() => { background = canvas.background; }));
    const gridInput = control(appearance, '网格', 'checkbox', input => change(() => { grid = input.checked; }));
    const textTools = group('文字样式');
    const fontInput = control(textTools, '字号', 'number', input => updateFont({
      fontSize: Math.max(8, Math.min(96, Number(input.value) || 16)),
    }));
    fontInput.min = '8';
    fontInput.max = '96';
    const fontColorInput = control(textTools, '文字颜色', 'color', input => updateFont({ color: input.value }));

    function bounds() {
      let width = 0, height = 0;
      for (const item of items) {
        if (item.type === 'edge') continue;
        width = Math.max(width, item.x + item.width);
        height = Math.max(height, item.y + item.height);
      }
      return { width, height };
    }
    function fit() {
      const { width, height } = bounds();
      board.style.width = Math.max(viewport.clientWidth / zoom, width + 48) + 'px';
      board.style.height = Math.max(viewport.clientHeight / zoom, height + 48) + 'px';
      board.style.zoom = zoom;
      zoomButton.textContent = Math.round(zoom * 100) + '%';
    }
    function setZoom(value, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
      cancelGesture?.();
      const old = zoom;
      zoom = Math.min(4, Math.max(0.1, Math.round(value * 100) / 100));
      const left = (viewport.scrollLeft + x) / old, top = (viewport.scrollTop + y) / old;
      fit();
      viewport.scrollLeft = left * zoom - x;
      viewport.scrollTop = top * zoom - y;
      if (!textSession) focus();
    }
    function fitContent() {
      const { width, height } = bounds();
      const ratio = Math.min(viewport.clientWidth / (width + 40), viewport.clientHeight / (height + 40), 2);
      setZoom(width && height ? ratio : 1, 0, 0);
      viewport.scrollTo?.(0, 0);
    }
    function syncTools() {
      undoButton.disabled = !undo.length;
      redoButton.disabled = !redo.length;
      deleteButton.disabled = !selected;
      backgroundInput.value = background;
      gridInput.checked = grid;
      board.style.backgroundColor = background;
      board.classList.toggle('show-grid', grid);
      textTools.hidden = !selected || !['text', 'rectangle'].includes(selected.type);
      if (!textTools.hidden) {
        fontInput.value = selected.fontSize;
        fontColorInput.value = selected.color;
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
      board.replaceChildren(wireLayer);
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
    function trackPointer(element, event, update, finish) {
      const id = event.pointerId;
      element.setPointerCapture(id);
      const stop = cancelled => {
        element.onpointermove = element.onpointerup = element.onpointercancel = element.onlostpointercapture = null;
        cancelGesture = null;
        if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
        finish(cancelled);
      };
      cancelGesture = () => stop(true);
      element.onpointermove = move => {
        if (move.pointerId === id) update(move.clientX - event.clientX, move.clientY - event.clientY);
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
        const { x, y, width, height } = item, before = state();
        trackPointer(element, event, (dx, dy) => {
          if (resizing) {
            const factor = Math.max(10 / Math.min(width, height), Math.min(100000 / Math.max(width, height),
              Math.abs(dx / width) > Math.abs(dy / height) ? 1 + dx / zoom / width : 1 + dy / zoom / height));
            item.width = Math.round(width * factor);
            item.height = Math.round(height * factor);
          } else Object.assign(item, position(x + dx / zoom, y + dy / zoom));
          place(element, item);
          drawEdges();
        }, cancelled => {
          const changed = x !== item.x || y !== item.y || width !== item.width || height !== item.height;
          if (cancelled || (changed && !save())) Object.assign(item, { x, y, width, height });
          else if (changed) remember(before);
          place(element, item);
          fit();
          drawEdges();
        });
      };
      nodes.set(item.id, element);
      board.append(element);
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
        let y = Math.max(32, bounds().height + 24);
        const additions = images.map(image => {
          const scale = Math.min(1, 600 / image.width, 400 / image.height);
          const height = Math.max(1, Math.round(image.height * scale));
          const item = { ...image, id: crypto.randomUUID(), type: 'image', ...position(32, y),
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
      addText(position((event.clientX - rect.left) / zoom, (event.clientY - rect.top) / zoom));
    };
    board.onpointerdown = event => {
      if ((spaceDown && event.button === 0 || event.button === 1) && !cancelGesture) {
        event.preventDefault();
        focus();
        const left = viewport.scrollLeft, top = viewport.scrollTop;
        trackPointer(board, event, (dx, dy) => {
          viewport.scrollLeft = left - dx;
          viewport.scrollTop = top - dy;
        }, () => {});
      } else if (event.target === board && event.button === 0) select(null);
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
      } else if (event.key === 'Delete' && selected) {
        event.preventDefault();
        removeSelected();
      }
    };
    const stopPan = () => { spaceDown = false; board.classList.remove('pan'); };
    board.onblur = stopPan;
    board.onkeyup = event => { if (event.key === ' ') stopPan(); };
    restore({ items, background, grid });
    if (viewState) {
      viewport.scrollLeft = viewState.left;
      viewport.scrollTop = viewState.top;
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
      cancelGesture?.();
      onDispose({ zoom, left: viewport.scrollLeft, top: viewport.scrollTop, undo, redo });
    };
    return panel;
  }

  return { read: DrawioCanvasDocument.read, mount };
})();

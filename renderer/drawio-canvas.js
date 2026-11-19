window.DrawioCanvas = (() => {
  const { coordinate, worldCoordinate, angle, points, textColorDefault, textBackgroundDefault } = DrawioCanvasDocument;
  const assets = DrawioCanvasAssets;
  const sides = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
  const directions = { n: [0.5, 0], e: [1, 0.5], s: [0.5, 1], w: [0, 0.5] };
  const styleKey = 'myide-drawio-default-styles';
  const backgroundColorsKey = 'myide-drawio-background-colors';
  const cleanText = value => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '');
  const turn = (x, y, degrees) => {
    const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [c * x - s * y, s * x + c * y];
  };
  function defaultStyle(type) {
    try {
      const value = JSON.parse(localStorage.getItem(styleKey) || '{}')?.[type] || {};
      const hex = s => /^#[0-9a-f]{6}$/i.test(s || '');
      const result = {};
      if (Number.isFinite(value.opacity)) result.opacity = Math.max(0, Math.min(100, value.opacity));
      if (type === 'text') {
        if (Number.isFinite(value.fontSize)) result.fontSize = Math.max(8, Math.min(96, value.fontSize));
        if (hex(value.color)) result.color = value.color;
        if (hex(value.fill)) result.fill = value.fill;
      }
      return result;
    } catch { return {}; }
  }
  function normalizeBackgroundColor(value) {
    const hex = value.trim().toLowerCase().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/.test(hex)) return '#' + [...hex].map(c => c + c).join('');
    return /^[0-9a-f]{6}$/.test(hex) ? '#' + hex : null;
  }
  function savedBackgroundColors() {
    try {
      const colors = JSON.parse(localStorage.getItem(backgroundColorsKey) || '[]');
      if (!Array.isArray(colors)) return [];
      return [...new Set(colors.filter(color => typeof color === 'string').map(normalizeBackgroundColor).filter(Boolean))];
    } catch { return []; }
  }
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

  function mount(parent, { canvas, isCurrent, onChange, onSave, onDispose, viewState }) {
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
    let selected = null, pasteBusy = false, zoom = viewState?.zoom || 1, textSession = null, imagePreview = null;
    let originX = viewState?.originX || 0, originY = viewState?.originY || 0;
    let spaceDown = false, cancelGesture = null, disposed = false, revision = 0, connector = null;
    const undo = viewState?.undo || [], redo = viewState?.redo || [];
    const nodes = new Map();
    const focus = () => board.focus({ preventScroll: true });
    const contextMenu = DrawioCanvasMenu.create(focus);
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
    button(editing, '保存', '保存画布（Ctrl+S）', () => {
      finishText();
      onSave();
    });
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
      if (!backgroundPanel.hidden) { closeBackground(); return; }
      backgroundPanel.hidden = false;
      backgroundButton.setAttribute('aria-expanded', 'true');
      colorInput.value = background;
      colorInput.setCustomValidity('');
      colorPicker.set(background);
      renderBackgroundFavorites(savedBackgroundColors());
    });
    backgroundButton.setAttribute('aria-expanded', 'false');
    const swatch = document.createElement('span');
    swatch.className = 'diagram-canvas-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    backgroundButton.append(swatch);
    const backgroundPanel = document.createElement('div');
    backgroundPanel.className = 'diagram-canvas-palette';
    backgroundPanel.hidden = true;
    function addColorChoice(container, color, label) {
      const choice = button(container, '', label, () => applyBackground(color));
      choice.dataset.color = color;
      choice.style.backgroundColor = color;
      choice.setAttribute('aria-pressed', String(color === background.toLowerCase()));
    }
    const palette = document.createElement('div');
    palette.className = 'diagram-canvas-colors';
    for (const [name, color] of [
      ['白', '#ffffff'], ['浅灰', '#f6f7fa'], ['米色', '#fff3d9'], ['浅蓝', '#dfebfa'],
      ['浅绿', '#dcefe1'], ['浅粉', '#f9e2e9'], ['深灰', '#252d38'], ['黑', '#14171c'],
    ]) {
      addColorChoice(palette, color, name + '色背景');
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
    colorInput.oninput = () => {
      colorInput.setCustomValidity('');
      syncFavoriteButton();
    };
    custom.append(colorInput);
    button(custom, '应用', '应用背景色', () => applyBackground(colorInput.value));
    const colorPicker = DrawioColorPicker.create(color => {
      board.style.backgroundColor = color || background;
      colorInput.value = color || background;
      syncFavoriteButton();
    }, color => applyBackground(color, true));
    const favoriteHeader = document.createElement('div');
    favoriteHeader.className = 'diagram-canvas-favorites-header';
    const favoriteTitle = document.createElement('span');
    favoriteTitle.textContent = '收藏色';
    favoriteHeader.append(favoriteTitle);
    const favoriteButton = button(favoriteHeader, '收藏当前色', '收藏当前色', toggleBackgroundFavorite);
    const favorites = document.createElement('div');
    favorites.className = 'diagram-canvas-colors diagram-canvas-favorites';
    favorites.setAttribute('role', 'group');
    favorites.setAttribute('aria-label', '收藏的背景色');
    backgroundPanel.append(colorPicker.root, palette, custom, favoriteHeader, favorites);
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
    const sizeTools = group('元素尺寸');
    const widthInput = control(sizeTools, '宽', 'number', input => resizeSelected('width', input.value));
    const heightInput = control(sizeTools, '高', 'number', input => resizeSelected('height', input.value));
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
    const originalSize = button(sizeTools, '原始大小', '恢复图片原始大小', () => {
      const image = nodes.get(selected?.id)?.querySelector('img');
      if (!image?.naturalWidth || !image.naturalHeight) return;
      const { naturalWidth: width, naturalHeight: height } = image;
      const limit = Math.min(1, 100000 / Math.max(width, height));
      change(() => updateImageSize(selected, width, height, limit));
    });
    const previewButton = button(sizeTools, '放大查看', '放大查看图片（Enter）', () => previewImage(selected));

    function previewImage(item) {
      if (!isCurrent() || item?.type !== 'image') return;
      const image = nodes.get(item.id)?.querySelector('img');
      if (!image) return;
      closeBackground();
      imagePreview = MI.showImgLightbox(image.src, image.alt, () => { imagePreview = null; });
    }

    function closeBackground() {
      backgroundPanel.hidden = true;
      backgroundButton.setAttribute('aria-expanded', 'false');
      board.style.backgroundColor = background;
    }
    function syncFavoriteButton() {
      const color = normalizeBackgroundColor(colorInput.value);
      const saved = [...favorites.children].some(choice => choice.dataset.color === color);
      const label = saved ? '取消收藏' : '收藏当前色';
      favoriteButton.textContent = favoriteButton.title = label;
      favoriteButton.setAttribute('aria-label', label);
      favoriteButton.disabled = !color;
    }
    function renderBackgroundFavorites(colors) {
      favorites.replaceChildren();
      for (const color of colors) addColorChoice(favorites, color, '应用收藏色 ' + color);
      syncFavoriteButton();
    }
    function toggleBackgroundFavorite() {
      const color = normalizeBackgroundColor(colorInput.value);
      if (!color) return;
      const colors = savedBackgroundColors();
      const next = colors.includes(color) ? colors.filter(value => value !== color) : [color, ...colors];
      try {
        localStorage.setItem(backgroundColorsKey, JSON.stringify(next));
      } catch {
        MI.toast('无法保存背景色收藏', 'err');
        return;
      }
      renderBackgroundFavorites(next);
    }
    function applyBackground(input, keepOpen = false) {
      const color = normalizeBackgroundColor(input);
      if (!color) {
        colorInput.setCustomValidity('请输入 3 位或 6 位十六进制颜色');
        colorInput.reportValidity?.();
        return;
      }
      if (!keepOpen) closeBackground();
      if (color !== background) change(() => { background = color; }, !keepOpen);
      if (keepOpen) {
        colorInput.value = background;
        colorPicker.set(background);
        syncFavoriteButton();
      }
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
        const [c, s] = turn(1, 0, item.rotation || 0).map(Math.abs);
        const dx = (item.width * c + item.height * s) / 2, dy = (item.width * s + item.height * c) / 2;
        const x = item.x + item.width / 2, y = item.y + item.height / 2;
        left = Math.min(left, x - dx);
        top = Math.min(top, y - dy);
        right = Math.max(right, x + dx);
        bottom = Math.max(bottom, y + dy);
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
      for (const choice of [...palette.children, ...favorites.children]) {
        choice.setAttribute('aria-pressed', String(choice.dataset.color === background.toLowerCase()));
      }
      gridInput.checked = grid;
      board.style.backgroundColor = background;
      board.classList.toggle('show-grid', grid);
      textTools.hidden = !selected || !['text', 'rectangle'].includes(selected.type);
      if (!textTools.hidden) {
        fontInput.value = selected.fontSize;
        fontColorInput.value = selected.color;
      }
      sizeTools.hidden = !selected;
      if (!sizeTools.hidden) {
        const isImage = selected.type === 'image', subject = isImage ? '图片' : selected.type === 'text' ? '文本框' : '矩形';
        widthInput.value = selected.width;
        heightInput.value = selected.height;
        widthInput.setAttribute('aria-label', subject + '宽度');
        heightInput.setAttribute('aria-label', subject + '高度');
        widthInput.title = heightInput.title = isImage ? '以像素计，调整时保持图片比例' : '以像素计，可单独调整宽度或高度';
        originalSize.hidden = !isImage;
        originalSize.disabled = !isImage || !!selected.locked || !nodes.get(selected.id)?.querySelector('img')?.naturalWidth;
        previewButton.hidden = !isImage;
      }
      deleteButton.disabled = !selected || !!selected.locked;
      for (const input of [fontInput, fontColorInput, widthInput, heightInput]) input.disabled = !!selected?.locked;
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
      if (onChange(DrawioCanvasDocument.serialize(canvas, state()), maxBytes)) {
        revision++;
        return true;
      }
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
    function change(update, restoreFocus = true) {
      cancelGesture?.();
      finishText();
      const before = state();
      update();
      if (save()) remember(before);
      else restore(before);
      syncTools();
      if (restoreFocus) focus();
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
      if (!selected || selected.locked) return;
      change(() => {
        const id = selected?.id;
        items = items.filter(item => item.id !== id && item.source !== id && item.target !== id);
        restore({ items, background, grid });
      });
    }
    function updateFont(values) {
      if (!selected || selected.locked || textTools.hidden) return;
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
    function resizeSelected(dimension, value) {
      if (!selected || selected.locked) return;
      const next = Number(value);
      if (!value || !Number.isFinite(next) || next < 1) {
        syncTools();
        return;
      }
      if (next === selected[dimension]) return;
      const { width, height } = selected, factor = next / selected[dimension];
      change(() => {
        if (selected.type === 'image') updateImageSize(selected, width, height, factor);
        else {
          selected[dimension] = coordinate(Math.max(18, next));
          place(nodes.get(selected.id), selected);
          fit();
          drawEdges();
        }
      });
    }

    function atPointer(x, y) {
      const rect = board.getBoundingClientRect();
      return position(originX + (x - rect.left) / zoom, originY + (y - rect.top) / zoom);
    }
    function portAt(item, point) {
      const [x, y] = turn(point.x - (item.x + item.width / 2), point.y - (item.y + item.height / 2), -(item.rotation || 0));
      return [x / item.width + 0.5, y / item.height + 0.5].map(value => Math.max(0, Math.min(1, Math.round(value * 100) / 100)));
    }
    function insertCopy(item, point = position(item.x + 24, item.y + 24)) {
      change(() => {
        const copy = { ...item, ...point, id: crypto.randomUUID(), locked: false, lockChanged: true };
        items.push(copy);
        add(copy);
        select(copy);
        fit();
      });
    }
    const matching = (item, version) => isCurrent() && items.includes(item) && revision === version;
    async function copyObject(item, cut = false) {
      if (!item || cut && item.locked) return;
      const version = revision;
      if (!await window.myIDE.clip.copy(assets.pack(item))) throw Error('剪贴板暂不可用');
      if (cut && matching(item, version)) {
        select(item);
        removeSelected();
      }
    }
    function order(item, target) {
      const vertices = items.filter(value => value.type !== 'edge');
      const current = vertices.indexOf(item);
      if (target === current || target < 0 || target >= vertices.length) return;
      change(() => {
        vertices.splice(current, 1);
        vertices.splice(target, 0, item);
        let i = 0;
        items = items.map(value => value.type === 'edge' ? value : vertices[i++]);
        restore(state());
      });
    }
    function saveDefault(item) {
      let styles;
      try { styles = JSON.parse(localStorage.getItem(styleKey) || '{}') || {}; } catch { styles = {}; }
      const { opacity, fontSize, color, fill, type } = item;
      styles[type === 'rectangle' ? 'text' : type] = { opacity: opacity ?? 100, fontSize, color, fill };
      localStorage.setItem(styleKey, JSON.stringify(styles));
      MI.toast('默认样式已设置', 'ok');
    }
    async function editStyle(item) {
      const version = revision;
      const numeric = (min, max) => ({ min, max, step: 1, required: '' });
      const fields = [
        ['rotation', '旋转角度', 'number', item.rotation || 0, numeric(0, 359)],
        ['opacity', '不透明度（%）', 'number', item.opacity ?? 100, numeric(0, 100)],
      ];
      if (item.type !== 'image') fields.push(
        ['fontSize', '字号', 'number', item.fontSize, numeric(8, 96)],
        ['color', '文字颜色', 'color', item.color],
        ['fill', '填充颜色', 'color', item.fill],
      );
      const result = await DrawioCanvasMenu.form('编辑样式', fields);
      if (!result || !matching(item, version)) return;
      change(() => {
        Object.assign(item, { rotation: angle(result.rotation), opacity: +result.opacity, appearanceChanged: true });
        if (item.type !== 'image') Object.assign(item, { fontSize: +result.fontSize, color: result.color,
          fill: result.fill, fontChanged: true, fillChanged: true });
        place(nodes.get(item.id), item);
        fit();
        drawEdges();
      });
    }
    const webLink = value => {
      try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
    };
    async function editProperty(item, key, heading, label, type) {
      const version = revision;
      const result = await DrawioCanvasMenu.form(heading, [['value', label, type, item[key], { maxlength: 16000 }]], {
        validate: values => key === 'link' && values.value.trim() && !webLink(values.value.trim()) ? '请输入有效的 HTTP 或 HTTPS 链接' : '',
      });
      if (result && matching(item, version)) change(() => { item[key] = cleanText(result.value.trim()); });
    }
    async function replaceImage(item) {
      const version = revision;
      const file = await window.myIDE.fs.pickFile('替换画布图片', [{ name: '图片', extensions: [...formats.keys()] }]);
      if (!file || !matching(item, version)) return;
      const mime = mimeOf(file);
      if (!mime) throw Error('请选择支持的图片格式');
      const result = await window.myIDE.fs.readBuffer(file);
      if (!result.buffer) throw Error(result.error || '图片太大或无法读取');
      const image = await decodeImage(new Blob([result.buffer], { type: mime }));
      if (matching(item, version)) updateImage(item, { mime, data: image.data });
    }
    function updateImage(item, values) {
      change(() => {
        Object.assign(item, values, { imageChanged: true });
        restore(state());
      });
    }
    async function cropImage(item) {
      const version = revision, result = await assets.crop(item);
      if (result && matching(item, version)) updateImage(item, result);
    }
    async function editPoints(item) {
      const version = revision;
      const value = (item.points || []).map(point => point.join(', ')).join('\n');
      const parse = source => source.trim() ? source.trim().split(/\n/).map(row => row.trim().split(/\s*,\s*/).map(part =>
        part ? Number(part) : NaN)) : [];
      const result = await DrawioCanvasMenu.form('编辑连接点', [['value', '每行一个连接点，横纵坐标范围为 0–1', 'textarea', value]], {
        validate: values => {
          const list = parse(values.value);
          return points(JSON.stringify(list)).length === list.length ? '' : '请输入有效的连接点，最多 32 个';
        },
      });
      if (result && matching(item, version)) setPoints(item, parse(result.value));
    }
    function setPoints(item, list) {
      change(() => { item.points = list; restore(state()); });
    }
    function connect(item, start = null) {
      connector = { item, start };
      board.classList.add('connecting');
      MI.toast('请选择连线的目标元素', 'ok');
    }
    function stopConnect() {
      connector = null;
      board.classList.remove('connecting');
    }
    function endConnection(target, end = null) {
      if (!connector) return false;
      const { item, start } = connector;
      if (item === target) return true;
      stopConnect();
      if (!items.includes(item)) return true;
      change(() => {
        items.push({ id: crypto.randomUUID(), type: 'edge', source: item.id, target: target.id, start, end,
          stroke: '#4b5563', arrow: true, orthogonal: true });
        drawEdges();
      });
      return true;
    }
    function openContext(x, y, item) {
      cancelGesture?.();
      finishText();
      closeBackground();
      if (item && !items.includes(item)) item = null;
      const point = atPointer(x, y);
      select(item);
      const action = (label, run, shortcut, disabled = false, danger = false) => ({ label, run, shortcut, disabled, danger });
      if (!item) {
        const scratch = assets.scratchItems().map(entry => action('插入便签 · ' + entry.label, () => insertCopy(assets.unpack(entry.data), point)));
        contextMenu.open(x, y, [
          [action('粘贴', () => paste([], point), 'Ctrl+V'), action('添加文字', () => addText(point))],
          [action('撤销', () => history(undo, redo), 'Ctrl+Z', !undo.length), action('重做', () => history(redo, undo), 'Ctrl+Y', !redo.length)],
          scratch,
        ]);
        return;
      }
      const disabled = !!item.locked, isImage = item.type === 'image';
      const vertices = items.filter(value => value.type !== 'edge'), index = vertices.indexOf(item);
      const chosenPort = portAt(item, point);
      contextMenu.open(x, y, [
        isImage ? [action('放大查看', () => previewImage(item), 'Enter')] : [],
        [action('删除', removeSelected, 'Delete', disabled, true)],
        [action('剪切', () => copyObject(item, true), 'Ctrl+X', disabled),
          action('复制', () => copyObject(item), 'Ctrl+C'),
          action('复制为图像', async () => {
            if (!await window.myIDE.clip.writePng(await assets.renderPng(item))) throw Error('复制图像失败');
            MI.toast('图像已复制', 'ok');
          }),
          action('复制为 SVG', async () => {
            if (!await window.myIDE.clip.copy(assets.makeSvg(item).xml)) throw Error('复制 SVG 失败');
            MI.toast('SVG 已复制', 'ok');
          }),
          action('创建副本', () => insertCopy(item), 'Ctrl+D')],
        [action(item.locked ? '解锁' : '锁定', () => change(() => {
          Object.assign(item, { locked: !item.locked, lockChanged: true });
          place(nodes.get(item.id), item);
        })), action('设置为默认样式', () => saveDefault(item))],
        [action('移至最前', () => order(item, vertices.length - 1), '', disabled || index === vertices.length - 1),
          action('移至最后', () => order(item, 0), '', disabled || index === 0),
          action('上移一层', () => order(item, index + 1), '', disabled || index === vertices.length - 1),
          action('下移一层', () => order(item, index - 1), '', disabled || index === 0)],
        [action('编辑样式…', () => editStyle(item), '', disabled), action('编辑数据…', () => editProperty(item, 'dataText', '编辑数据', '元素数据', 'textarea'), '', disabled),
          action('编辑链接…', () => editProperty(item, 'link', '编辑链接', '链接地址', 'text'), '', disabled),
          ...(webLink(item.link) ? [action('打开链接', () => window.myIDE.shell.openExternal(item.link))] : [])],
        isImage ? [action('替换图片…', () => replaceImage(item), '', disabled), action('裁剪…', () => cropImage(item), '', disabled)] :
          [action('编辑文字', () => editText(item), 'Enter', disabled)],
        [action('连接到元素', () => connect(item), '', disabled), action('添加连接点', () => {
          if ((item.points || []).length >= 32) throw Error('连接点最多 32 个');
          setPoints(item, [...(item.points || []), chosenPort]);
        }, '', disabled), action('编辑连接点…', () => editPoints(item), '', disabled)],
        [action('添加到便签本', () => { assets.addScratch(item, assets.pack(item)); MI.toast('已添加到便签本', 'ok'); })],
      ]);
    }

    function drawEdges() {
      const byId = new Map(items.map(item => [item.id, item]));
      const lines = items.filter(item => item.type === 'edge').map(edge => {
        const a = byId.get(edge.source), b = byId.get(edge.target);
        const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
        const bx = b.x + b.width / 2, by = b.y + b.height / 2;
        const horizontal = Math.abs(bx - ax) >= Math.abs(by - ay);
        const direction = horizontal ? Math.sign(bx - ax) || 1 : Math.sign(by - ay) || 1;
        const port = (item, point) => {
          const [x, y] = turn((point[0] - 0.5) * item.width, (point[1] - 0.5) * item.height, item.rotation || 0);
          return [item.x + item.width / 2 + x, item.y + item.height / 2 + y];
        };
        const start = port(a, edge.start || (horizontal ? [(1 + direction) / 2, 0.5] : [0.5, (1 + direction) / 2]));
        const end = port(b, edge.end || (horizontal ? [(1 - direction) / 2, 0.5] : [0.5, (1 - direction) / 2]));
        const via = horizontal ? [[(start[0] + end[0]) / 2, start[1]], [(start[0] + end[0]) / 2, end[1]]] :
          [[start[0], (start[1] + end[1]) / 2], [end[0], (start[1] + end[1]) / 2]];
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
        transform: item.rotation ? 'rotate(' + item.rotation + 'deg)' : '',
      });
      element.style.setProperty('--diagram-opacity', (item.opacity ?? 100) / 100);
      element.classList.toggle('locked', !!item.locked);
      if (item.type === 'image') return;
      Object.assign(element.style, {
        fontSize: item.fontSize + 'px', color: item.color,
        backgroundColor: 'color-mix(in srgb, ' + item.fill + ' ' + (item.opacity ?? 100) + '%, transparent)',
        borderColor: item.stroke || '', borderRadius: item.rounded ? '8px' : '',
      });
    }
    function finishText() {
      if (textSession) textSession.input.blur();
    }
    function editText(item) {
      if (item.locked || textSession?.item === item) return;
      finishText();
      select(item);
      const element = nodes.get(item.id);
      const input = document.createElement('textarea');
      const before = state();
      let remembered = false;
      input.value = item.text;
      input.setAttribute('aria-label', '文字标注');
      input.placeholder = '输入文字';
      const label = element.querySelector('.diagram-item-label');
      label.replaceChildren(input);
      textSession = { input, item };
      input.oninput = () => {
        const previous = { text: item.text, height: item.height };
        item.text = cleanText(input.value);
        if (item.type === 'text') {
          input.style.height = '0px';
          item.height = coordinate(Math.max(42, input.scrollHeight, previous.height, Math.ceil(item.fontSize * 1.45) * item.text.split('\n').length + 12));
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
        } else label.textContent = item.text;
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
      const move = () => update(pointer.clientX - event.clientX, pointer.clientY - event.clientY, pointer);
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
      let pressedImage = false;
      element.className = 'diagram-canvas-item ' + item.type;
      place(element, item);
      if (item.type === 'image') {
        const image = document.createElement('img');
        image.alt = '画布图片';
        image.draggable = false;
        image.onload = () => { if (selected === item) syncTools(); };
        image.src = 'data:' + item.mime + ';base64,' + item.data;
        element.append(image);
        element.ondblclick = event => {
          if (event.target === image || event.target === element && pressedImage) previewImage(item);
        };
      } else {
        const label = document.createElement('span');
        label.className = 'diagram-item-label';
        label.textContent = item.text;
        element.append(label);
        element.ondblclick = () => editText(item);
      }
      for (const side of sides) {
        const handle = document.createElement('span');
        handle.className = 'diagram-canvas-resize';
        handle.dataset.resize = side;
        handle.title = item.type === 'image' ? '拖动调整图片大小（保持比例）' : '拖动调整文本框大小';
        element.append(handle);
      }
      const rotate = document.createElement('span');
      rotate.className = 'diagram-canvas-rotate';
      rotate.title = '拖动旋转，Shift 按 15° 吸附';
      element.append(rotate);
      for (const [side, point] of Object.entries(directions)) {
        const arrow = document.createElement('span');
        arrow.className = 'diagram-canvas-connect';
        arrow.dataset.side = side;
        arrow.title = '从此方向连接到元素';
        arrow.onclick = event => {
          event.stopPropagation();
          if (!item.locked) { focus(); connect(item, point); }
        };
        element.append(arrow);
      }
      for (const point of item.points || []) {
        const port = document.createElement('span');
        port.className = 'diagram-canvas-port';
        port.style.left = point[0] * 100 + '%';
        port.style.top = point[1] * 100 + '%';
        port.title = '连接点';
        port.onpointerdown = event => {
          if (event.button !== 0) return;
          event.stopPropagation();
          if (!endConnection(item, point) && !item.locked) { focus(); connect(item, point); }
        };
        element.append(port);
      }
      element.oncontextmenu = event => {
        event.preventDefault();
        event.stopPropagation();
        openContext(event.clientX, event.clientY, item);
      };
      element.onpointerdown = event => {
        // 图片本身不接收指针事件，捕获指针也会把缩放手柄的双击重定向到元素。
        pressedImage = item.type === 'image' && event.button === 0 && event.target === element && !connector && !spaceDown;
        if (event.button !== 0 || spaceDown || cancelGesture || event.target.tagName === 'TEXTAREA' ||
          event.target.classList.contains('diagram-canvas-connect')) return;
        if (endConnection(item)) return;
        focus();
        select(item);
        if (item.locked) return;
        const side = event.target.dataset.resize, rotating = event.target === rotate;
        const { x, y, width, height, rotation, appearanceChanged } = item, before = state(), origin = camera();
        const degrees = rotation || 0, cx = x + width / 2, cy = y + height / 2;
        const pointerAngle = pointer => {
          const p = atPointer(pointer.clientX, pointer.clientY);
          return Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI;
        };
        const startAngle = rotating ? pointerAngle(event) : 0;
        trackPointer(element, event, (dx, dy, pointer) => {
          const current = camera();
          dx = dx / zoom + current.x - origin.x;
          dy = dy / zoom + current.y - origin.y;
          if (rotating) {
            const next = degrees + pointerAngle(pointer) - startAngle;
            item.rotation = angle(pointer.shiftKey ? Math.round(next / 15) * 15 : next);
            item.appearanceChanged = item.rotation !== degrees || appearanceChanged;
          } else if (side) {
            const [localX, localY] = turn(dx, dy, -degrees);
            const sx = side.includes('e') ? 1 : side.includes('w') ? -1 : 0;
            const sy = side.includes('s') ? 1 : side.includes('n') ? -1 : 0;
            if (item.type === 'image' || pointer.shiftKey) {
              const rx = sx * localX / width, ry = sy * localY / height;
              const delta = sx && (!sy || Math.abs(rx) >= Math.abs(ry)) ? rx : ry;
              const factor = Math.max(1 / Math.min(width, height), Math.min(100000 / Math.max(width, height), 1 + delta));
              item.width = Math.round(width * factor);
              item.height = Math.round(height * factor);
            } else {
              item.width = coordinate(Math.max(18, width + sx * localX));
              item.height = coordinate(Math.max(18, height + sy * localY));
            }
            const [shiftX, shiftY] = turn(sx * (item.width - width) / 2, sy * (item.height - height) / 2, degrees);
            Object.assign(item, position(cx + shiftX - item.width / 2, cy + shiftY - item.height / 2));
            syncTools();
          } else Object.assign(item, position(x + dx, y + dy));
          place(element, item);
          drawEdges();
        }, cancelled => {
          const changed = x !== item.x || y !== item.y || width !== item.width || height !== item.height || (item.rotation || 0) !== degrees;
          if (cancelled || (changed && !save())) Object.assign(item, { x, y, width, height, rotation, appearanceChanged });
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
        fontSize: 16, color: textColorDefault, fill: textBackgroundDefault, ...defaultStyle('text'), ...where };
      items.push(item);
      add(item);
      fit();
      editText(item);
    }
    async function paste(files = [], where = null) {
      if (pasteBusy || !isCurrent()) return;
      pasteBusy = pasteButton.disabled = true;
      try {
        const text = files.length ? '' : (await window.myIDE.clip.readText?.())?.text || '';
        const copied = assets.unpack(text);
        if (copied && isCurrent()) {
          const view = camera();
          insertCopy(copied, where || position(view.x + 24, view.y + 24));
          return;
        }
        const images = files.length ? await readBatch(files, decodeImage) : await clipboardImages();
        if (!isCurrent()) return;
        if (!images.length) {
          MI.toast('剪贴板中没有可粘贴的图片', 'err');
          return;
        }
        cancelGesture?.();
        finishText();
        const before = state();
        const view = camera(), style = defaultStyle('image');
        let y = where ? where.y : Math.max(view.y + 32, bounds().bottom + 24);
        const additions = images.map(image => {
          const scale = Math.min(1, 600 / image.width, 400 / image.height);
          const height = Math.max(1, Math.round(image.height * scale));
          const item = { ...image, ...style, id: crypto.randomUUID(), type: 'image', ...position(where?.x ?? view.x + 32, y),
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
      addText(atPointer(event.clientX, event.clientY));
    };
    board.oncontextmenu = event => {
      event.preventDefault();
      event.stopPropagation();
      stopConnect();
      openContext(event.clientX, event.clientY, null);
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
        stopConnect();
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
      } else if (command === 'c' || command === 'x' || command === 'd') {
        event.preventDefault();
        event.stopPropagation();
        if (selected) {
          if (command === 'd') insertCopy(selected);
          else void copyObject(selected, command === 'x').catch(error => MI.toast(error.message, 'err'));
        }
      } else if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        const rect = (nodes.get(selected?.id) || viewport).getBoundingClientRect();
        openContext(rect.left + 16, rect.top + 16, selected);
      } else if (event.key === 'Escape' && connector) {
        event.preventDefault();
        event.stopPropagation();
        stopConnect();
      } else if (event.key === ' ' && event.target === board) {
        event.preventDefault();
        spaceDown = true;
        board.classList.add('pan');
      } else if (event.key === 'Enter' && event.target === board && selected) {
        event.preventDefault();
        if (selected.type === 'image') previewImage(selected);
        else editText(selected);
      } else if (event.key === 'Delete') {
        event.preventDefault();
        event.stopPropagation();
        removeSelected();
      } else if (event.target === board && selected && !selected.locked && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
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
      imagePreview?.close();
      resize?.disconnect();
      contextMenu.dispose();
      document.removeEventListener('pointerdown', dismissBackground);
      cancelGesture?.();
      onDispose({ zoom, originX, originY, left: viewport.scrollLeft, top: viewport.scrollTop, undo, redo });
    };
    return panel;
  }

  return { read: DrawioCanvasDocument.read, mount };
})();

window.DrawioCanvas = (() => {
  const marker = 'image-text-v1';
  const maxBytes = 8 * 1024 * 1024;
  const formats = new Map([
    ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'], ['webp', 'image/webp'], ['bmp', 'image/bmp'],
  ]);
  const textStyle = 'text;html=0;align=left;verticalAlign=top;whiteSpace=wrap;fontSize=16;fontColor=#222222;fillColor=#fffdf0;';
  const imageStyle = 'shape=image;imageAspect=0;aspect=fixed;image=';
  const inlineImage = /^data:(image\/(?:png|jpeg|gif|webp|bmp)),([A-Za-z0-9+/=]+)$/;
  const coordinate = value => Math.min(100000, Math.max(0, Math.round(value)));
  const position = (x, y) => ({ x: coordinate(x), y: coordinate(y) });

  function read(xml) {
    if (!xml.trim()) return { items: [] };
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const file = doc.documentElement;
    if (!file.hasAttribute('myideCanvas')) return null;
    if (file.getAttribute('myideCanvas') !== marker) return { items: null };
    const page = file.firstElementChild, model = page?.firstElementChild, root = model?.firstElementChild;
    if (doc.doctype || file.tagName !== 'mxfile' || page?.tagName !== 'diagram' || model?.tagName !== 'mxGraphModel' ||
      root?.tagName !== 'root' || [file, page, model].some(node => node.children.length !== 1)) return { items: null };
    const cells = [...root.children];
    if (cells[0]?.getAttribute('id') !== '0' || cells[1]?.getAttribute('id') !== '1') return { items: null };
    const items = [];
    for (const cell of cells.slice(2)) {
      const geometry = cell.firstElementChild;
      if (cell.tagName !== 'mxCell' || cell.getAttribute('vertex') !== '1' || cell.getAttribute('parent') !== '1' ||
        geometry?.tagName !== 'mxGeometry' || cell.children.length !== 1 || geometry.children.length) return { items: null };
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(name => Number(geometry.getAttribute(name)));
      if (![x, y, width, height].every(n => Number.isFinite(n) && n >= 0 && n <= 100000) || width < 1 || height < 1) return { items: null };
      const style = cell.getAttribute('style') || '';
      const image = style.startsWith(imageStyle) && inlineImage.exec(style.slice(imageStyle.length, -1));
      if (image) items.push({ type: 'image', mime: image[1], data: image[2], x, y, width, height });
      else if (style === textStyle) items.push({ type: 'text', text: cell.getAttribute('value') || '', x, y, width, height });
      else return { items: null };
    }
    return { items };
  }

  function serialize(items) {
    const doc = document.implementation.createDocument(null, 'mxfile');
    const append = (parent, tag, attrs = {}) => {
      const element = doc.createElement(tag);
      for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
      return parent.appendChild(element);
    };
    const file = doc.documentElement;
    file.setAttribute('myideCanvas', marker);
    const page = append(file, 'diagram', { id: 'myide-canvas', name: '第 1 页' });
    const model = append(page, 'mxGraphModel', { grid: 0, page: 0 });
    const root = append(model, 'root');
    append(root, 'mxCell', { id: 0 });
    append(root, 'mxCell', { id: 1, parent: 0 });
    for (const [index, item] of items.entries()) {
      if (item.type === 'text' && !item.text) continue;
      const style = item.type === 'image' ? imageStyle + 'data:' + item.mime + ',' + item.data + ';' : textStyle;
      const cell = append(root, 'mxCell', { id: index + 2, value: item.text || '', style, vertex: 1, parent: 1 });
      append(cell, 'mxGeometry', { x: item.x, y: item.y, width: item.width, height: item.height, as: 'geometry' });
    }
    return new XMLSerializer().serializeToString(doc);
  }

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

  function mount(parent, { items, isCurrent, onChange, onDispose }) {
    const panel = document.createElement('div');
    panel.className = 'diagram-canvas-panel';
    const toolbar = document.createElement('div');
    toolbar.className = 'diagram-canvas-toolbar';
    const pasteButton = document.createElement('button'), textButton = document.createElement('button');
    pasteButton.className = textButton.className = 'vt-btn';
    pasteButton.textContent = '粘贴图片';
    pasteButton.title = 'Ctrl+V 粘贴截图或复制的图片文件';
    textButton.textContent = '添加文字';
    toolbar.append(pasteButton, textButton);
    const viewport = document.createElement('div'), board = document.createElement('div');
    viewport.className = 'diagram-canvas-scroll';
    board.className = 'diagram-canvas-board';
    board.tabIndex = 0;
    board.setAttribute('aria-label', '图文画布');
    viewport.append(board);
    panel.append(toolbar, viewport);
    parent.append(panel);

    let selected = null, pasteBusy = false;
    const nodes = new Map();
    const focus = () => board.focus({ preventScroll: true });
    const place = (element, item) => Object.assign(element.style, {
      left: item.x + 'px', top: item.y + 'px', width: item.width + 'px', height: item.height + 'px',
    });
    function fit() {
      let width = 0, height = 0;
      for (const item of items) {
        width = Math.max(width, item.x + item.width);
        height = Math.max(height, item.y + item.height);
      }
      board.style.width = width + 48 + 'px';
      board.style.height = height + 48 + 'px';
    }
    function select(item) {
      nodes.get(selected)?.classList.remove('selected');
      selected = item;
      nodes.get(item)?.classList.add('selected');
    }
    function commit() {
      if (!isCurrent()) return false;
      const xml = serialize(items);
      if (!onChange(xml, maxBytes)) {
        MI.toast('图文画布超过 8 MiB，请缩小图片或分到另一个画布', 'err');
        return false;
      }
      return true;
    }
    function editText(item) {
      const element = nodes.get(item);
      if (element.querySelector('textarea')) return;
      select(item);
      const input = document.createElement('textarea');
      input.value = item.text;
      input.setAttribute('aria-label', '文字标注');
      input.placeholder = '输入文字';
      element.replaceChildren(input);
      input.oninput = () => {
        const before = { text: item.text, height: item.height };
        item.text = input.value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '');
        item.height = coordinate(Math.max(42, input.scrollHeight, 24 * item.text.split('\n').length + 12));
        if (!commit()) {
          Object.assign(item, before);
          input.value = before.text;
        }
        place(element, item);
        fit();
      };
      input.onblur = () => {
        if (!item.text) {
          items.splice(items.indexOf(item), 1);
          nodes.delete(item);
          element.remove();
          fit();
        } else element.textContent = item.text;
      };
      input.onkeydown = event => {
        if (event.isComposing) return;
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
          event.stopPropagation();
          event.preventDefault();
          focus();
        }
      };
      input.focus();
    }
    function add(item) {
      const element = document.createElement('div');
      element.className = 'diagram-canvas-item ' + item.type;
      place(element, item);
      if (item.type === 'image') {
        const image = document.createElement('img');
        image.alt = '画布图片';
        image.draggable = false;
        image.src = 'data:' + item.mime + ';base64,' + item.data;
        element.append(image);
      } else element.textContent = item.text;
      element.onpointerdown = event => {
        if (event.button !== 0 || event.target.tagName === 'TEXTAREA') return;
        focus();
        select(item);
        const before = { x: item.x, y: item.y };
        const startX = event.clientX, startY = event.clientY;
        element.setPointerCapture(event.pointerId);
        element.onpointermove = move => {
          Object.assign(item, position(before.x + move.clientX - startX, before.y + move.clientY - startY));
          place(element, item);
        };
        const finish = cancelled => {
          element.onpointermove = element.onpointerup = element.onpointercancel = null;
          if (cancelled || ((item.x !== before.x || item.y !== before.y) && !commit())) Object.assign(item, before);
          place(element, item);
          fit();
        };
        element.onpointerup = () => finish(false);
        element.onpointercancel = () => finish(true);
      };
      if (item.type === 'text') element.ondblclick = () => editText(item);
      nodes.set(item, element);
      board.append(element);
    }
    function addText(where) {
      if (!isCurrent()) return;
      const item = { type: 'text', text: '', width: 240, height: 42, ...where };
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
        let y = items.reduce((bottom, item) => Math.max(bottom, item.y + item.height + 24), 32);
        const additions = images.map(image => {
          const scale = Math.min(1, 600 / image.width, 400 / image.height);
          const height = Math.max(1, Math.round(image.height * scale));
          const item = { ...image, type: 'image', ...position(32, y), width: Math.max(1, Math.round(image.width * scale)), height };
          y += height + 24;
          return item;
        });
        items.push(...additions);
        if (!commit()) {
          items.splice(-additions.length);
          return;
        }
        additions.forEach(add);
        fit();
        focus();
        select(additions[0]);
        nodes.get(additions[0]).scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      } catch (error) {
        if (isCurrent()) MI.toast(String(error.message || error), 'err');
      } finally {
        pasteBusy = pasteButton.disabled = false;
      }
    }
    pasteButton.onclick = () => void paste();
    textButton.onclick = () => addText(position((selected?.x ?? viewport.scrollLeft) + 24, (selected?.y ?? viewport.scrollTop) + 24));
    board.ondblclick = event => {
      if (event.target === board) addText(position(event.offsetX, event.offsetY));
    };
    board.onpointerdown = event => {
      if (event.target === board) select(null);
    };
    panel.onpaste = event => {
      if (event.target.tagName === 'TEXTAREA') return;
      const files = [...(event.clipboardData?.files || [])].filter(file => [...formats.values()].includes(file.type));
      event.preventDefault();
      event.stopPropagation();
      void paste(files);
    };
    panel.onkeydown = event => {
      if (event.isComposing || event.target.tagName === 'TEXTAREA') return;
      const command = (event.ctrlKey || event.metaKey) && event.key.toLowerCase();
      if (command === 'v') {
        event.preventDefault();
        event.stopPropagation();
        void paste();
      } else if (['c', 'x', 'z', 'y'].includes(command)) {
        // 画布拥有焦点时，文件树的撤销和剪切不应被触发。
        event.stopPropagation();
      } else if (event.key === 'Enter' && selected?.type === 'text') {
        event.preventDefault();
        editText(selected);
      } else if (event.key === 'Delete' && selected) {
        event.preventDefault();
        const item = selected, index = items.indexOf(item);
        items.splice(index, 1);
        if (commit()) {
          nodes.get(item).remove();
          nodes.delete(item);
          select(null);
          fit();
        } else items.splice(index, 0, item);
      }
    };
    items.forEach(add);
    fit();
    panel.focusEditor = focus;
    panel.previewDispose = onDispose;
    return panel;
  }

  return { read, mount };
})();

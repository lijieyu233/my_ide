window.DrawioCanvasAssets = (() => {
  const cap = 8 * 1024 * 1024;
  const clipboardPrefix = 'MyIDE 图文元素\n';
  const scratchKey = 'myide-drawio-scratchpad';

  function pack(item) {
    return clipboardPrefix + DrawioCanvasDocument.serialize({}, {
      items: [item], background: DrawioCanvasDocument.backgroundDefault, grid: false,
    });
  }
  function unpack(text) {
    if (typeof text !== 'string' || text.length > cap || !text.startsWith(clipboardPrefix)) return null;
    const result = DrawioCanvasDocument.read(text.slice(clipboardPrefix.length));
    return result?.items?.length === 1 && result.items[0].type !== 'edge' ? result.items[0] : null;
  }
  function scratchItems() {
    try {
      const items = JSON.parse(localStorage.getItem(scratchKey) || '[]');
      return Array.isArray(items) ? items.slice(0, 6).filter(item => typeof item.label === 'string' && unpack(item.data)) : [];
    } catch { return []; }
  }
  function addScratch(item, data) {
    const label = item.type === 'image' ? '图片 ' + item.width + ' × ' + item.height :
      (item.text.trim().replace(/\s+/g, ' ').slice(0, 28) || '矩形');
    try {
      const next = JSON.stringify([{ label, data }, ...scratchItems()].slice(0, 6));
      if (next.length > 2 * 1024 * 1024) throw Error('便签本中的图片体积过大');
      localStorage.setItem(scratchKey, next);
    } catch (error) { throw Error('无法保存便签本：' + error.message); }
  }
  const dataUrl = item => 'data:' + item.mime + ';base64,' + item.data;
  function makeSvg(item) {
    const ns = 'http://www.w3.org/2000/svg';
    const { width, height } = item, degrees = item.rotation || 0, radians = degrees * Math.PI / 180;
    const w = Math.ceil(Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians)) - 1e-8);
    const h = Math.ceil(Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians)) - 1e-8);
    const doc = document.implementation.createDocument(ns, 'svg');
    const append = (target, tag, attrs) => {
      const node = doc.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      return target.appendChild(node);
    };
    const svg = doc.documentElement;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    const group = append(svg, 'g', {
      transform: 'translate(' + (w - width) / 2 + ' ' + (h - height) / 2 + ') rotate(' + degrees + ' ' + width / 2 + ' ' + height / 2 + ')',
      opacity: (item.opacity ?? 100) / 100,
    });
    if (item.type === 'image') {
      append(group, 'image', { width, height, href: dataUrl(item), preserveAspectRatio: 'xMidYMid meet' });
    } else {
      append(group, 'rect', { width, height, fill: item.fill, rx: item.rounded ? 8 : 3,
        stroke: item.type === 'rectangle' ? item.stroke : 'none' });
      const text = append(group, 'text', { fill: item.color, 'font-size': item.fontSize, 'font-family': 'sans-serif' });
      const measure = document.createElement('canvas').getContext('2d');
      measure.font = item.fontSize + 'px sans-serif';
      const lines = [];
      for (const paragraph of item.text.split('\n')) {
        let line = '';
        for (const character of paragraph) {
          if (line && measure.measureText(line + character).width > Math.max(1, width - 16)) {
            lines.push(line);
            line = '';
          }
          line += character;
        }
        lines.push(line);
      }
      for (const [i, line] of lines.entries()) {
        if (item.fontSize + 6 + Math.ceil(item.fontSize * 1.45) * i > height) break;
        append(text, 'tspan', { x: 8, y: item.fontSize + 6 + Math.ceil(item.fontSize * 1.45) * i }).textContent = line;
      }
    }
    return { xml: new XMLSerializer().serializeToString(doc), width: w, height: h };
  }
  async function load(url) {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  }
  async function renderPng(item) {
    const svg = makeSvg(item);
    const image = await load('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.xml));
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 4096 / Math.max(svg.width, svg.height));
    canvas.width = Math.max(1, Math.round(svg.width * scale));
    canvas.height = Math.max(1, Math.round(svg.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const output = canvas.toDataURL('image/png');
    if (output.length > cap) throw Error('复制的图像太大');
    return output.split(',')[1];
  }
  async function crop(item) {
    const image = await load(dataUrl(item));
    const { naturalWidth: width, naturalHeight: height } = image;
    image.className = 'diagram-crop-preview';
    image.draggable = false;
    const preview = document.createElement('div'), selection = document.createElement('span');
    preview.className = 'diagram-crop-surface';
    preview.title = '拖动框选要保留的区域';
    preview.append(image, selection);
    const labels = [['left', '左'], ['top', '上'], ['right', '右'], ['bottom', '下']];
    const fields = labels.map(([key, label]) => [key, label + '侧裁掉的像素', 'number', 0, { min: 0, step: 1, required: '' }]);
    const values = await DrawioCanvasMenu.form('裁剪图片 · ' + width + ' × ' + height, fields, {
      preview,
      validate: v => +v.left + +v.right >= width || +v.top + +v.bottom >= height ? '裁剪后须保留至少一个像素' : '',
      ready: controls => {
        const redraw = () => {
          for (const [side] of labels) selection.style[side] =
            Math.max(0, Number(controls.get(side).value) || 0) / (side === 'left' || side === 'right' ? width : height) * 100 + '%';
        };
        for (const input of controls.values()) input.oninput = redraw;
        let start;
        const point = event => {
          const r = preview.getBoundingClientRect();
          return [
            Math.round(Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)) * width),
            Math.round(Math.max(0, Math.min(1, (event.clientY - r.top) / r.height)) * height),
          ];
        };
        preview.onpointerdown = event => {
          if (event.button !== 0) return;
          event.preventDefault();
          start = point(event);
          preview.setPointerCapture(event.pointerId);
        };
        preview.onpointermove = event => {
          if (!start || !preview.hasPointerCapture(event.pointerId)) return;
          const end = point(event);
          controls.get('left').value = Math.min(start[0], end[0]);
          controls.get('top').value = Math.min(start[1], end[1]);
          controls.get('right').value = width - Math.max(start[0], end[0]);
          controls.get('bottom').value = height - Math.max(start[1], end[1]);
          redraw();
        };
        preview.onpointerup = preview.onpointercancel = () => { start = null; };
        redraw();
      },
    });
    if (!values) return null;
    const w = width - +values.left - +values.right, h = height - +values.top - +values.bottom;
    if (w === width && h === height) return null;
    if (w * h > 32 * 1024 * 1024) throw Error('裁剪区域太大');
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(image, +values.left, +values.top, w, h, 0, 0, w, h);
    const nextWidth = Math.max(1, Math.round(w / width * item.width)), nextHeight = Math.max(1, Math.round(h / height * item.height));
    const dx = (+values.left - +values.right) / width * item.width / 2;
    const dy = (+values.top - +values.bottom) / height * item.height / 2;
    const radians = (item.rotation || 0) * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
    return { mime: 'image/png', data: canvas.toDataURL('image/png').split(',')[1],
      x: DrawioCanvasDocument.worldCoordinate(item.x + (item.width - nextWidth) / 2 + c * dx - s * dy),
      y: DrawioCanvasDocument.worldCoordinate(item.y + (item.height - nextHeight) / 2 + s * dx + c * dy),
      width: nextWidth, height: nextHeight };
  }
  return { pack, unpack, scratchItems, addScratch, makeSvg, renderPng, crop };
})();

window.DrawioCanvasDocument = (() => {
  const backgroundDefault = '#f6f7fa';
  const textColorDefault = '#222222';
  const textBackgroundDefault = '#fffdf0';
  const marker = 'image-text-v1';
  const inlineImage = /^data:(image\/(?:png|jpeg|gif|webp|bmp))(?:;base64)?,([A-Za-z0-9+/=]+)$/;
  const coordinate = value => Math.min(100000, Math.max(0, Math.round(value)));
  const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
  const entries = style => new Map((style || '').replace(/;base64,/g, ',').split(';').filter(Boolean).map(part => {
    const split = part.indexOf('=');
    return split < 0 ? [part, null] : [part.slice(0, split), part.slice(split + 1)];
  }));

  function getModel(file) {
    if (file.tagName === 'mxGraphModel') return file;
    const page = file.firstElementChild;
    if (file.tagName === 'mxfile' && file.children.length === 1 && page?.tagName === 'diagram' &&
      page.children.length === 1 && page.firstElementChild.tagName === 'mxGraphModel') return page.firstElementChild;
    return null;
  }

  function plainText(value, html) {
    if (!html) return value;
    const fragment = document.createElement('template');
    fragment.innerHTML = value.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:div|p)>/gi, '\n');
    return fragment.content.textContent.trimEnd();
  }

  function read(xml) {
    if (!xml.trim()) return { items: [], background: backgroundDefault, grid: true };
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const file = doc.documentElement;
    const owned = file.hasAttribute('myideCanvas');
    const unsupported = owned ? { items: null } : null;
    const model = getModel(file), root = model?.firstElementChild;
    if (doc.doctype || (owned && file.getAttribute('myideCanvas') !== marker) ||
      root?.tagName !== 'root' || model.children.length !== 1) return unsupported;
    const [rootCell, layer, ...cells] = root.children;
    if (rootCell?.tagName !== 'mxCell' || rootCell.getAttribute('id') !== '0' ||
      layer?.tagName !== 'mxCell' || layer.getAttribute('id') !== '1' || layer.getAttribute('parent') !== '0') return unsupported;

    const items = [], seen = new Set(['0', '1']);
    for (const cell of cells) {
      const id = cell.getAttribute('id'), geometry = cell.firstElementChild;
      if (cell.tagName !== 'mxCell' || !id || seen.has(id) || cell.getAttribute('parent') !== '1' ||
        geometry?.tagName !== 'mxGeometry' || cell.children.length !== 1 ||
        cell.getAttribute('visible') === '0' || cell.getAttribute('collapsed') === '1') return unsupported;
      seen.add(id);
      const style = entries(cell.getAttribute('style'));
      const value = cell.getAttribute('value') || '';
      if (cell.getAttribute('edge') === '1') {
        const source = cell.getAttribute('source'), target = cell.getAttribute('target');
        if (!source || !target || geometry.children.length || value ||
          ![undefined, 'orthogonalEdgeStyle'].includes(style.get('edgeStyle'))) return unsupported;
        items.push({ id, type: 'edge', source, target, cell, stroke: color(style.get('strokeColor'), '#4b5563'),
          arrow: (style.get('endArrow') || 'classic') !== 'none', orthogonal: style.has('edgeStyle') });
        continue;
      }
      if (cell.getAttribute('vertex') !== '1' || geometry.children.length || geometry.getAttribute('relative') === '1' ||
        style.has('rotation') || style.has('sketch')) return unsupported;
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(name => Number(geometry.getAttribute(name)));
      if (![x, y, width, height].every(n => Number.isFinite(n) && n >= 0 && n <= 100000) || width < 1 || height < 1) return unsupported;
      const bounds = { id, cell, x, y, width, height };
      const shape = style.get('shape');
      const image = shape === 'image' && inlineImage.exec(style.get('image') || '');
      if (image && !value) {
        items.push({ ...bounds, type: 'image', mime: image[1], data: image[2] });
        continue;
      }
      const isText = style.has('text') && !shape;
      if ((!isText && shape && shape !== 'rectangle') ||
        [...style].some(([key, setting]) => setting === null && key !== 'text')) return unsupported;
      items.push({ ...bounds, type: isText ? 'text' : 'rectangle', rounded: style.get('rounded') === '1',
        text: plainText(value, style.get('html') === '1'),
        fontSize: Math.max(8, Math.min(96, Number(style.get('fontSize')) || (isText ? 16 : 12))),
        color: color(style.get('fontColor'), textColorDefault),
        fill: color(style.get('fillColor'), isText ? textBackgroundDefault : '#ffffff'),
        stroke: color(style.get('strokeColor'), '#444444') });
    }
    const vertices = new Set(items.filter(item => item.type !== 'edge').map(item => item.id));
    if (items.some(item => item.type === 'edge' && (!vertices.has(item.source) || !vertices.has(item.target)))) return unsupported;
    return { doc, items, background: color(model.getAttribute('background'), owned ? backgroundDefault : '#ffffff'),
      grid: model.hasAttribute('myideGrid') ? model.getAttribute('myideGrid') !== '0' :
        owned || model.getAttribute('grid') !== '0' };
  }

  function serialize(source, { items, background, grid }) {
    const doc = source.doc?.cloneNode(true) || document.implementation.createDocument(null, 'mxfile');
    const append = (parent, tag, attrs = {}) => {
      const element = doc.createElement(tag);
      for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
      return parent.appendChild(element);
    };
    let model = getModel(doc.documentElement);
    if (!model) {
      const file = doc.documentElement;
      file.setAttribute('myideCanvas', marker);
      const page = append(file, 'diagram', { id: 'myide-canvas', name: '第 1 页' });
      model = append(page, 'mxGraphModel', { page: 0 });
      const root = append(model, 'root');
      append(root, 'mxCell', { id: 0 });
      append(root, 'mxCell', { id: 1, parent: 0 });
    }
    if (!source.doc || background !== source.background) model.setAttribute('background', background);
    if (!source.doc || grid !== source.grid) {
      model.setAttribute('grid', grid ? '1' : '0');
      model.setAttribute('myideGrid', grid ? '1' : '0');
    }
    const root = model.firstElementChild;
    for (const cell of [...root.children].slice(2)) cell.remove();
    for (const item of items) {
      if (item.type === 'text' && !item.text && !item.cell) continue;
      const cell = item.cell ? root.appendChild(doc.importNode(item.cell, true)) :
        append(root, 'mxCell', { id: item.id, vertex: 1, parent: 1 });
      if (item.type === 'edge') continue;
      const geometry = cell.firstElementChild || append(cell, 'mxGeometry', { as: 'geometry' });
      for (const key of ['x', 'y', 'width', 'height']) {
        if (Number(geometry.getAttribute(key)) !== item[key] || !item.cell) geometry.setAttribute(key, item[key]);
      }
      if (!item.cell && item.type === 'image') {
        cell.setAttribute('style', 'shape=image;imageAspect=0;aspect=fixed;image=data:' + item.mime + ',' + item.data + ';');
      }
      if (item.type !== 'text' && item.type !== 'rectangle') continue;
      const original = cell.getAttribute('value') || '';
      const style = entries(cell.getAttribute('style'));
      if (!item.cell) {
        style.set('text', null);
        style.set('align', 'left');
        style.set('verticalAlign', 'top');
        style.set('whiteSpace', 'wrap');
        style.set('fillColor', item.fill);
      }
      const textChanged = !item.cell || item.text !== plainText(original, style.get('html') === '1');
      if (textChanged) {
        cell.setAttribute('value', item.text);
        style.set('html', '0');
      }
      if (!item.cell || item.fontChanged) {
        style.set('fontSize', item.fontSize);
        style.set('fontColor', item.color);
      }
      if (textChanged || item.fontChanged) {
        cell.setAttribute('style', [...style].map(([key, value]) => value === null ? key : key + '=' + value).join(';') + ';');
      }
    }
    return new XMLSerializer().serializeToString(doc);
  }

  return { read, serialize, coordinate, backgroundDefault, textColorDefault, textBackgroundDefault };
})();

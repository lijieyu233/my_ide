window.DrawioColorPicker = (() => {
  function create(preview, commit) {
    const root = document.createElement('div');
    root.className = 'diagram-color-picker';
    const plane = document.createElement('div');
    plane.className = 'diagram-color-plane';
    plane.setAttribute('aria-label', '拖动选择颜色的饱和度和亮度');
    const cursor = document.createElement('span');
    plane.append(cursor);
    const hue = document.createElement('input');
    hue.className = 'diagram-color-hue';
    hue.type = 'range';
    hue.min = 0;
    hue.max = 359;
    hue.setAttribute('aria-label', '色相');
    root.append(plane, hue);
    let h = 0, s = 0, v = 1;
    function color() {
      const channel = offset => {
        const k = (offset + h / 60) % 6;
        return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))).toString(16).padStart(2, '0');
      };
      return '#' + channel(5) + channel(3) + channel(1);
    }
    function render() {
      plane.style.setProperty('--picker-hue', 'hsl(' + h + ' 100% 50%)');
      cursor.style.left = s * 100 + '%';
      cursor.style.top = (1 - v) * 100 + '%';
      cursor.style.backgroundColor = color();
      hue.value = h;
    }
    function set(hex) {
      const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
      v = Math.max(r, g, b);
      const delta = v - Math.min(r, g, b);
      s = v ? delta / v : 0;
      if (delta) {
        const segment = v === r ? (g - b) / delta : v === g ? 2 + (b - r) / delta : 4 + (r - g) / delta;
        h = Math.round((segment * 60 + 360) % 360) % 360;
      }
      render();
    }
    hue.oninput = () => {
      h = Number(hue.value);
      // 灰色起点也能立即看到所选色相。
      if (s < 0.05 || v < 0.05) { s = 0.75; v = Math.max(v, 0.8); }
      render();
      preview(color());
    };
    hue.onchange = () => commit(color());
    const point = event => {
      const bounds = plane.getBoundingClientRect();
      s = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      v = 1 - Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
      render();
      preview(color());
    };
    plane.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault();
      plane.setPointerCapture(event.pointerId);
      point(event);
    };
    plane.onpointermove = event => { if (plane.hasPointerCapture(event.pointerId)) point(event); };
    plane.onpointerup = event => {
      point(event);
      commit(color());
    };
    plane.onpointercancel = () => preview(null);
    return { root, set };
  }
  return { create };
})();

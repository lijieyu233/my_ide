window.DrawioEditor = (() => {
  const origin = 'https://embed.diagrams.net';
  const url = origin + '/?embed=1&proto=json&lang=zh&spin=1&lockdown=1&plugins=0' +
    '&suppressNewWindows=1&noExitBtn=1&saveAndExit=0&modified=unsavedChanges&keepmodified=1';

  function isDiagram(xml) {
    if (typeof xml !== 'string' || !xml.trim()) return false;
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const root = doc.documentElement;
    if (!root || doc.doctype || doc.querySelector('parsererror')) return false;
    const childTag = { mxfile: 'diagram', mxGraphModel: 'root' }[root.tagName];
    return Array.from(root.children).some(child => child.tagName === childTag);
  }

  function mount(parent, { getXml, title, onChange, onFocus, onDispose }) {
    const panel = document.createElement('div');
    panel.className = 'drawio-editor';
    const notice = document.createElement('div');
    notice.className = 'viewer-msg drawio-notice';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const retry = document.createElement('button');
    retry.className = 'vt-btn';
    retry.textContent = '打开在线 draw.io';
    notice.append(status, retry);
    panel.append(notice);
    parent.append(panel);

    let frame, timer, loadingPeer, ready;
    const send = message => frame?.contentWindow?.postMessage(JSON.stringify(message), origin);
    function resetFrame() {
      clearTimeout(timer);
      frame?.remove();
      frame = null;
      loadingPeer = null;
      ready = false;
    }
    function showError(message, canRetry) {
      resetFrame();
      notice.hidden = false;
      status.textContent = message;
      retry.hidden = !canRetry;
    }
    function waitForEditor() {
      clearTimeout(timer);
      timer = setTimeout(() => showError('draw.io 加载超时。请检查网络，也可切换到「查看源码」。', true), 20000);
    }
    function start() {
      resetFrame();
      const xml = getXml();
      if (xml.trim() && !isDiagram(xml)) {
        showError('无法识别图表 XML。可切换到「查看源码」检查内容。', false);
        return;
      }
      notice.hidden = false;
      status.textContent = '正在连接 draw.io…';
      retry.textContent = '重试加载';
      retry.hidden = true;
      frame = document.createElement('iframe');
      frame.title = 'draw.io 画布';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads');
      frame.referrerPolicy = 'no-referrer';
      frame.addEventListener('focus', onFocus);
      frame.src = url;
      panel.append(frame);
      waitForEditor();
    }
    function receive(event) {
      if (!frame || !panel.isConnected || event.origin !== origin || event.source !== frame.contentWindow || typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message?.event === 'init') {
        if (loadingPeer === event.source) return;
        // 分屏移动视图容器会重建 iframe 的浏览上下文，重新载入标签里最新的 XML。
        loadingPeer = event.source;
        ready = false;
        waitForEditor();
        send({ action: 'load', xml: getXml(), title, autosave: 1 });
      } else if (message?.event === 'load' && loadingPeer === event.source) {
        if (message.error) {
          showError('draw.io 无法打开图表。可切换到「查看源码」检查内容。', true);
          return;
        }
        clearTimeout(timer);
        loadingPeer = null;
        ready = true;
        notice.hidden = true;
      } else if (ready && (message?.event === 'save' || message?.event === 'autosave')) {
        if (isDiagram(message.xml)) onChange(message.xml, message.event === 'save');
        else if (message.event === 'save') send({ action: 'status', message: '图表内容无效，原文件已保留', modified: true });
      }
    }

    // 跨域画布获得焦点时，鼠标事件不会冒泡到编辑组。
    function frameFocus() {
      if (frame && document.activeElement === frame) onFocus();
    }
    window.addEventListener('blur', frameFocus);
    window.addEventListener('message', receive);
    panel.previewDispose = () => {
      resetFrame();
      window.removeEventListener('message', receive);
      window.removeEventListener('blur', frameFocus);
      onDispose();
    };
    panel.setSaveStatus = (message, modified) => {
      if (ready) send({ action: 'status', message, modified });
    };
    retry.onclick = start;
    status.textContent = '此文件使用 draw.io 图表格式，可切换到「查看源码」或打开在线编辑器。';
    return panel;
  }

  return { mount };
})();

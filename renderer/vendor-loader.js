// Office 与流程图库合计约 6MB；空白启动页无需解析这些库，首次预览时再加载。
window.VendorLoader = (() => {
  const sources = {
    mermaid: ['vendor/mermaid.min.js', 'mermaid'],
    docx: ['vendor/docx-preview.min.js', 'docxPreview'],
    xlsx: ['vendor/xlsx.min.js', 'XLSX'],
    pptx: ['vendor/pptx-preview.min.js', 'pptxPreview'],
  };
  const pending = new Map();
  function load(name) {
    if (!Object.hasOwn(sources, name)) return Promise.reject(Error('未知预览库：' + name));
    const source = sources[name];
    if (window[source[1]]) return Promise.resolve(window[source[1]]);
    if (pending.has(name)) return pending.get(name);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = source[0];
      const finish = error => {
        clearTimeout(timer); script.onload = script.onerror = null;
        if (error) { script.remove(); pending.delete(name); reject(error); }
        else resolve(window[source[1]]);
      };
      const timer = setTimeout(() => finish(Error('预览库加载超时：' + name)), 30000);
      script.onload = () => finish(window[source[1]] ? null : Error('预览库初始化失败：' + name));
      script.onerror = () => finish(Error('预览库加载失败：' + name));
      document.head.appendChild(script);
    });
    pending.set(name, promise); return promise;
  }
  return { load };
})();

// csv.js —— 示例插件：把 .csv 渲染成表格
// 说明：放到 plugins/ 目录，保存后重启应用（或 Ctrl+R 刷新应用？目前需重启）即可生效。
api.registerRenderer(['csv', 'tsv'], ({ content, name }) => {
  const sep = name.toLowerCase().endsWith('.tsv') ? '\t' : ',';
  const lines = (content || '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) {
    const d = document.createElement('div');
    d.className = 'viewer-msg';
    d.textContent = '空文件';
    return d;
  }
  const parse = (line) => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const table = document.createElement('table');
  table.style.cssText = 'border-collapse:collapse;margin:12px 20px;font-size:12.5px;user-select:text;';
  lines.forEach((line, i) => {
    const tr = document.createElement('tr');
    parse(line).forEach((cell) => {
      const td = document.createElement(i === 0 ? 'th' : 'td');
      td.textContent = cell;
      td.style.cssText = 'border:1px solid #4b4e52;padding:3px 10px;' + (i === 0 ? 'background:#3c3f41;color:#e6e6e6;' : '');
      if (i % 2 === 0 && i !== 0) td.style.background = 'rgba(255,255,255,0.03)';
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  const wrap = document.createElement('div');
  wrap.style.cssText = 'overflow:auto;height:100%;';
  wrap.appendChild(table);
  return wrap;
});
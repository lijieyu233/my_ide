// 路径段决定归属；foo不能误命中foobar，大小写规则只在Windows生效。
(function(root) {
  const windows = typeof process !== 'undefined' ? process.platform === 'win32' : /win/i.test(navigator.platform);
  const normalize = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const key = (p) => windows ? normalize(p).toLowerCase() : normalize(p);
  const contains = (parent, child) => key(child) === key(parent) || key(child).startsWith(key(parent) + '/');
  const map = (p, from, to) => {
    if(!contains(from,p))return p;
    const mapped=normalize(to)+normalize(p).slice(normalize(from).length);
    // Tree的展开/cache使用IPC原路径；保留输入分隔符，避免状态虽迁移但可见目录收起。
    return String(p).includes('\\')?mapped.replace(/\//g,'\\'):mapped;
  };
  const api = { normalize, key, contains, map };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DocumentPaths = api;
})(typeof window === 'undefined' ? globalThis : window);

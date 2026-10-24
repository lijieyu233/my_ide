// 展开/收起图标一致性：四个面板必须共用 icons.js 的那一份。
//
// 为什么值得单独测：UI 文案/图标的「一个功能一个名字」是仓库约定（AGENTS.md 第六节），
// 但图标没有文案那么好 grep —— 之前同一个「展开全部」在项目树是方框加号、Git 面板
// 是双箭头、大纲是另一种双箭头、搜索面板是单三角，四处各不相同，用户得逐个试。
// 这条测试把「不许再各画一套」钉死。
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok ' + name); }

test('icons.js 提供四枚语义图标，且不依赖任何其他模块', () => {
  const src = read('icons.js');
  // 不 require / 不读 window 上的别的东西：它会被 index.html 里 scripts 顺序最先加载，
  // 依赖任何后加载的模块都会在某些入口下变成 undefined。
  assert(!/require\(/.test(src), 'icons.js 不能 require 其他模块');
  const sandbox = {};
  new Function('window', 'globalThis', 'module', src.replace(/\(function \(host\) \{/, '(function (host) {').replace(/\}\)\(typeof window === .undefined. \? globalThis : window\);/, '})(window);'))(sandbox, sandbox, undefined);
  for (const key of ['expandAll', 'collapseAll', 'foldOpen', 'foldClose']) {
    assert.equal(typeof sandbox.Icons[key], 'string', '缺少 ' + key);
    assert(/^<svg class="ic" viewBox="0 0 16 16"/.test(sandbox.Icons[key]), key + ' 必须是 16×16 的内联 SVG（仓库 svg.ic 规范）');
  }
  // 展开与收起必须成对：形状相同、方向相反，否则扫一眼配不上对
  assert.notEqual(sandbox.Icons.expandAll, sandbox.Icons.collapseAll, '展开/收起不能是同一张图');
});

test('项目树、Git 面板、大纲、搜索面板共用同一份展开/收起图标', () => {
  const icons = (() => {
    const sandbox = {};
    const src = read('icons.js');
    new Function('window', 'globalThis', 'module', src.replace(/\}\)\(typeof window === .undefined. \? globalThis : window\);/, '})(window);'))(sandbox, sandbox, undefined);
    return sandbox.Icons;
  })();
  // 每个调用点都必须引用 window.Icons，而不是自己写死路径
  const sites = [
    ['index.html', /tree-collapse[\s\S]{0,400}?window\.Icons|tree-collapse/],
  ];
  // 项目树在 HTML 里静态写死同一份路径（模板字符串进不了 HTML），
  // 所以那边验证的是「路径与 icons.js 完全一致」。
  const html = read('index.html');
  const treeCollapse = html.match(/id="tree-collapse"[^>]*>(<svg[\s\S]*?<\/svg>)/);
  const treeExpand = html.match(/id="tree-expand"[^>]*>(<svg[\s\S]*?<\/svg>)/);
  assert(treeCollapse && treeExpand, '项目树的展开/收起按钮存在');
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  assert.equal(norm(treeCollapse[1]), norm(icons.collapseAll), '项目树「收起全部」必须与 icons.js 一致');
  assert.equal(norm(treeExpand[1]), norm(icons.expandAll), '项目树「展开全部」必须与 icons.js 一致');
  assert(!/rect x="2\.6" y="2\.6"/.test(treeCollapse[1]), '不再使用方框加减号');

  // 三个 JS 面板必须走 window.Icons（保留 fallback 允许，但主路径必须是共享图标）
  for (const [file, label] of [['git-panel.js', 'Git 面板'], ['outline.js', '大纲'], ['search.js', '搜索面板']]) {
    const src = read(file);
    assert(/window\.Icons/.test(src) || /\(window\.Icons \|\| \{\}\)\./.test(src),
      label + ' 应引用 window.Icons 而不是自己写死图标');
  }
  // 旧的三套形状必须消失
  const all = ['git-panel.js', 'outline.js', 'search.js', 'index.html'].map(read).join('\n');
  assert(!/M4\.6 3\.6L8 7l3\.4-3\.4/.test(all), '大纲的旧双箭头应已移除');
  assert(!/M4 10l4-4 4 4/.test(all), '搜索面板的旧单箭头应已移除');
});

test('index.html 在其余面板之前加载 icons.js', () => {
  const html = read('index.html');
  const at = html.indexOf('src="icons.js"');
  assert(at > 0, 'index.html 必须引入 icons.js');
  for (const later of ['src="outline.js"', 'src="git-panel.js"', 'src="search.js"', 'src="app.js"']) {
    const pos = html.indexOf(later);
    if (pos > 0) assert(at < pos, 'icons.js 必须在 ' + later + ' 之前加载，否则 window.Icons 还是 undefined');
  }
});

console.log('展开收起图标一致性 ' + passed + ' 通过 / 0 失败');

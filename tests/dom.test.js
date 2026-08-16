// tests/dom.test.js —— 渲染层无头测试（jsdom + 假 myIDE 桥）
// 运行：node tests/dom.test.js
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ok', name); }
  catch (e) { failed++; console.log('  FAIL', name, '->', e.message); }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok', name); }
  catch (e) { failed++; console.log('  FAIL', name, '->', e.message); }
}
const tick = () => new Promise((r) => setTimeout(r, 10));
const g = (dom, expr) => dom.window.eval(expr);

// ---------- 假文件系统与假 Git（统一正斜杠路径）----------
const P = 'C:/proj';
const FAKE_FS = {
  [P]: { type: 'dir', children: [P + '/README.md', P + '/src', P + '/data.csv', P + '/notes.txt'] },
  [P + '/src']: { type: 'dir', children: [P + '/src/app.js'] },
  [P + '/README.md']: { type: 'file', content: '# 标题\n\n这是 **Markdown** 测试\n\n```js\nconst x = 1;\n```\n' },
  [P + '/src/app.js']: { type: 'file', content: 'const a = 1;\n' },
  [P + '/data.csv']: { type: 'file', content: '名称,数量\n苹果,3\n香蕉,5\n' },
  [P + '/notes.txt']: { type: 'file', content: 'hello notes\n' },
  [P + '/page.html']: { type: 'file', content: '<h1>Hi HTML</h1><script>document.title = "ok";<\/script>' },
  [P + '/QuickOpen.js']: { type: 'file', content: 'const q = 1;\n' },
  [P + '/pic.png']: { type: 'file', content: '' },
  ['C:/proj2']: { type: 'dir', children: ['C:/proj2/other.md'] },
  ['C:/proj2/other.md']: { type: 'file', content: '# 项目二文档\n' },
  ['C:/proj/gbk-old.txt']: { type: 'file', content: '中文老文件内容', encoding: 'gbk' },
  ['C:/proj/manual.pdf']: { type: 'file', content: '' },
  ['C:/proj/crlf-file.txt']: { type: 'file', content: 'line1\r\nline2\r\n' },
};
const FAKE_GIT = {
  changed: [
    { file: 'README.md', status: 'modified', label: '已修改' },
    { file: 'data.csv', status: 'added', label: '已新增' },
    { file: 'src/app.js', status: 'modified', label: '已修改' },
    { file: 'src/deep/file.ts', status: 'added', label: '已新增' },
  ],
  commits: [
    { oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', short: 'aaaaaaa', message: '第二次提交：改文档', fullMessage: '第二次提交：改文档', author: 'me', timestamp: Date.now() - 3600e3, parents: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] },
    { oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', short: 'bbbbbbb', message: '合并提交', fullMessage: '合并提交', author: 'me', timestamp: Date.now() - 7200e3, parents: ['cccccccccccccccccccccccccccccccccccccccc', 'dddddddddddddddddddddddddddddddddddddddd'] },
    { oid: 'cccccccccccccccccccccccccccccccccccccccc', short: 'ccccccc', message: '分支上的提交', fullMessage: '分支上的提交', author: 'me', timestamp: Date.now() - 10800e3, parents: [] },
  ],
};
const calls = { copy: [], commit: [], commitFiles: [], diffWorkdir: [], diffCommit: [] };
let fakeCopied = [];   // 内部复制的文件
calls.setUserConfig = [];
calls.checkout = [];
calls.logRef = null;
calls.logAll = false;
calls.logDepth = null;
let fakePluginCb = null; // 插件热重载回调
let fakeExternal = []; // 模拟系统剪贴板的外部文件

function makeDom() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  // 注入真实样式表：让 getComputedStyle 反映 display，防「类存在但 CSS 没定义」盲区
  const st = w.document.createElement('style');
  st.textContent = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  w.document.head.appendChild(st);
  w.myIDE = {
    fs: {
      openFolder: async () => P,
      getRecent: async () => null,
      setRecent: async () => {},
      readDir: async (p) => (FAKE_FS[p] ? FAKE_FS[p].children.map((c) => ({ name: c.split('/').pop(), type: FAKE_FS[c].type, path: c })) : []),
      listAll: async (root) => ({ files: Object.keys(FAKE_FS).filter((f) => FAKE_FS[f].type === 'file'), truncated: false }),
      grep: async (root, q) => ({ results: [{ file: 'README.md', line: 1, text: '# 标题' }, { file: 'notes.txt', line: 2, text: '关键词命中' }], truncated: false, elapsed: 5 }),
      readFile: async (p) => (FAKE_FS[p] ? { content: FAKE_FS[p].content, encoding: FAKE_FS[p].encoding || 'utf8' } : { error: 'not found' }),
      writeFile: async (p, content) => {
        if (!FAKE_FS[p]) {
          FAKE_FS[p] = { type: 'file', content };
          const parts = p.split('/');
          const parent = parts.slice(0, -1).join('/');
          if (FAKE_FS[parent] && FAKE_FS[parent].type === 'dir' && !FAKE_FS[parent].children.includes(p)) FAKE_FS[parent].children.push(p);
        } else FAKE_FS[p].content = content;
        return { ok: true };
      },
      rename: async () => ({ ok: true }),
      mkdir: async (p) => {
        const parts = p.split('/');
        FAKE_FS[p] = { type: 'dir', children: [] };
        const parent = parts.slice(0, -1).join('/');
        if (FAKE_FS[parent] && FAKE_FS[parent].type === 'dir') FAKE_FS[parent].children.push(p);
        return { ok: true };
      },
      remove: async () => ({ ok: true }),
    },
    shell: { showInFolder: async () => {} },
    clip: {
      copy: async (t) => { calls.copy.push(t); return true; },
      copyFiles: async (paths) => { fakeCopied = paths.slice(); return true; },
      getFiles: async () => (fakeExternal.length ? fakeExternal.slice() : []),
    },
    fsCopy: async (src, destDir) => {
      const name = src.split('/').pop();
      const extIdx = name.lastIndexOf('.');
      const ext = extIdx > 0 ? name.slice(extIdx) : '';
      const base = extIdx > 0 ? name.slice(0, extIdx) : name;
      let target = destDir + '/' + name;
      for (let i = 1; FAKE_FS[target]; i++) target = destDir + '/' + base + ' (' + i + ')' + ext;
      const srcEntry = FAKE_FS[src] || { type: 'file', content: 'external content' };
      FAKE_FS[target] = { type: srcEntry.type, content: srcEntry.content || '', children: srcEntry.children ? srcEntry.children.slice() : undefined };
      if (FAKE_FS[destDir] && FAKE_FS[destDir].type === 'dir') FAKE_FS[destDir].children.push(target);
      return { ok: true, target };
    },
    git: {
      init: async () => ({ ok: true }),
      status: async () => ({ isRepo: true, root: P, branch: 'main', changed: FAKE_GIT.changed }),
      log: async (d, depth, ref) => {
        calls.logRef = ref || 'HEAD';
        calls.logDepth = depth;
        let commits = FAKE_GIT.commits;
        if (ref === 'dev') commits = Array.from({ length: 100 }, (_, i) => ({ oid: 'd' + String(i).padStart(39, '0'), short: 'd' + i, message: 'commit ' + i, fullMessage: 'commit ' + i, author: 'me', timestamp: Date.now() - i * 1000, parents: [] }));
        return { isRepo: true, root: P, branch: 'main', commits, ref: ref || 'HEAD' };
      },
      logAll: async () => { calls.logAll = true; return { isRepo: true, root: P, branch: 'main', commits: FAKE_GIT.commits, ref: '__all__' }; },
      commit: async (d, o) => { calls.commit.push(o); return { ok: true, oid: 'cccccccccccccccccccccccccccccccccccccccc' }; },
      diffWorkdir: async (d, f) => { calls.diffWorkdir.push(f); return { file: f, oldText: 'old line\n', newText: 'new line\n', hunks: [
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, rows: [{ type: 'del', aText: 'old line', bText: '', aNum: 1, bNum: 0 }, { type: 'add', aText: '', bText: 'new line', aNum: 0, bNum: 1 }] },
        { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, rows: [{ type: 'ctx', aText: 'ctx line', bText: 'ctx line', aNum: 10, bNum: 10 }] },
      ] }; },
      diffCommit: async (d, oid, f) => { calls.diffCommit.push(oid + ':' + f); return { file: f, oldText: 'old\n', newText: 'new\n', hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, rows: [{ type: 'del', aText: 'old', bText: '', aNum: 1, bNum: 0 }, { type: 'add', aText: '', bText: 'new', aNum: 0, bNum: 1 }] }] }; },
      commitFiles: async (d, oid) => { calls.commitFiles.push(oid); return { files: ['README.md', 'data.csv'] }; },
      branches: async () => ({ isRepo: true, branches: ['dev', 'main'], current: 'main' }),
      checkout: async (d, ref) => { calls.checkout.push(ref); return { ok: true }; },
      getUserConfig: async () => ({ name: 'tester', email: 't@example.com', isRepo: true }),
      setUserConfig: async (d, cfg) => { calls.setUserConfig.push(cfg); return { ok: true }; },
    },
    appInfo: async () => ({ version: '0.2.0', commit: 'test123' }),
    plugins: {
      onChanged: (cb) => { fakePluginCb = cb; },
      loadAll: async () => [
        { name: 'csv', code: 'api.registerRenderer(["csv"], ({ content }) => {\n  const t = document.createElement("table");\n  t.id = "csv-table";\n  (content || "").split("\\n").filter((l) => l.trim() !== "").forEach((l) => { const tr = document.createElement("tr"); l.split(",").forEach((c) => { const td = document.createElement("td"); td.textContent = c; tr.appendChild(td); }); t.appendChild(tr); });\n  return t;\n});' },
      ],
    },
  };
  return dom;
}

async function loadApp(dom) {
  const w = dom.window;
  const evalFile = (f) => w.eval(fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'theme.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vendor', 'marked.min.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vendor', 'highlight.min.js'), 'utf8'));
  evalFile('plugin-loader.js');
  evalFile('tree.js');
  evalFile('viewer.js');
  evalFile('outline.js');
  evalFile('git-panel.js');
  evalFile('quickopen.js');
  evalFile('search.js');
  evalFile('session.js');
  evalFile('shortcuts.js');
  evalFile('settings.js');
  evalFile('help.js');
  evalFile('app.js');
  await g(dom, 'App.init()'); // const 声明不在 window 上，用 eval 访问
  await tick();
}

const $ = (dom, sel) => dom.window.document.querySelector(sel);
const $allIn = (el, sel) => [...el.querySelectorAll(sel)];
const $$ = (dom, sel) => [...dom.window.document.querySelectorAll(sel)];

const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (dom, k, opts = {}) => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ctrlKey: opts.ctrl || false, altKey: opts.alt || false, shiftKey: opts.shift || false }));
function assert_(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

(async () => {
  console.log('[渲染层测试]');
  const dom = makeDom();
  await loadApp(dom);

  await okAsync('打开文件夹 → 文件树渲染出根节点与子文件', async () => {
    await g(dom, 'App.setRoot("' + P + '")');
    await tick(); await tick();
    const names = $$(dom, '.tree-row .nm').map((n) => n.textContent);
    assert_(names.some((n) => n.includes('proj')), '根目录存在, got: ' + names.join(','));
    assert_(names.includes('README.md'), 'README.md 存在, got: ' + names.join(','));
    assert_(names.includes('src'), 'src 目录存在');
  });

  await okAsync('★ 单击文件 → 复制完整路径 + 打开文件', async () => {
    const row = $$(dom, '.tree-row').find((r) => r.querySelector('.nm').title === P + '/README.md');
    assert_(row, '找到 README.md 行');
    click(row);
    await tick(); await tick(); await tick();
    assert_(calls.copy[calls.copy.length - 1] === P + '/README.md', '剪贴板收到完整路径, got: ' + calls.copy[calls.copy.length - 1]);
    assert_($(dom, '.tab.active .tname'), '标签已打开');
  });

  await okAsync('Markdown 渲染 → .md-view 且标题/加粗/代码块生效', async () => {
    const md = $(dom, '.md-view');
    assert_(md, '存在 md-view');
    assert_(md.querySelector('h1') && md.querySelector('h1').textContent.includes('标题'), 'h1 渲染');
    assert_(md.querySelector('strong') && md.querySelector('strong').textContent === 'Markdown', '加粗渲染');
    assert_(md.querySelector('pre code'), '代码块渲染');
  });

  await okAsync('查看源码 ⇄ 预览切换', async () => {
    const btns = $allIn($(dom, '.viewer-toolbar'), 'button');
    click(btns.find((b) => b.textContent.includes('源码')));
    await tick();
    assert_($(dom, 'textarea.editor'), '源码模式出现 textarea');
    const ta = $(dom, 'textarea.editor');
    ta.value = '# 改过的标题';
    ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    click($allIn($(dom, '.viewer-toolbar'), 'button').find((b) => b.textContent.includes('预览')));
    await tick();
    const md = $(dom, '.md-view');
    assert_(md && md.querySelector('h1').textContent.includes('改过的标题'), '预览使用最新内容');
  });

  await okAsync('Ctrl+Shift+C 复制当前文件路径', async () => {
    const before = calls.copy.length;
    key(dom, 'C', { ctrl: true, shift: true });
    await tick();
    assert_(calls.copy.length === before + 1, '触发复制');
    assert_(calls.copy[calls.copy.length - 1] === P + '/README.md', '复制的是当前标签路径');
  });

  await okAsync('插件机制：csv 插件渲染表格', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/data.csv")');
    await tick(); await tick();
    const t = $(dom, '#csv-table');
    assert_(t, 'csv 插件渲染出表格');
    assert_(t.rows.length === 3, '3 行数据, got ' + t.rows.length);
  });

  await okAsync('Git 面板：本地修改与提交历史', async () => {
    await g(dom, 'GitPanel.refresh()');
    await tick();
    const body = $(dom, '#git-body').textContent;
    assert_(body.includes('README.md'), '修改列表含 README.md');
    assert_(body.includes('第二次提交：改文档'), '日志含最新提交');
    assert_(body.includes('aaaaaaa'), '日志含短哈希');
    assert_($(dom, '#git-branch').textContent.includes('main'), '分支显示 main');
    assert_($(dom, '#tb-git').textContent.includes('4 处修改'), '工具栏显示修改数');
  });

  await okAsync('点击本地修改文件 → 左右分栏 diff', async () => {
    click($allIn($(dom, '#git-body'), '.git-file').find((x) => x.textContent.includes('README.md')));
    await tick(); await tick();
    const table = $(dom, '.diff-table');
    assert_(table, 'diff 表格出现');
    assert_($allIn($(dom, '.diff-table'), 'td.del').some((td) => td.textContent === 'old line'), '左侧删除行');
    assert_($allIn($(dom, '.diff-table'), 'td.add').some((td) => td.textContent === 'new line'), '右侧新增行');
    assert_($(dom, '#df-back'), '有返回按钮');
  });

  await okAsync('Ctrl+K → 提交面板；勾选提交 → git.commit 收到消息', async () => {
    click($(dom, '#df-back'));
    await tick();
    key(dom, 'k', { ctrl: true });
    await tick();
    assert_($(dom, '#commit-msg'), '提交面板打开');
    assert_($allIn($(dom, '#commit-files'), '.cf-check').length === 4, '4 个文件复选框');
    $(dom, '#commit-msg').value = '测试提交信息';
    click($(dom, '#cm-ok'));
    await tick(); await tick();
    assert_(calls.commit.length === 1, '调用了 git.commit');
    assert_(calls.commit[0].message === '测试提交信息', '消息正确');
    assert_(calls.commit[0].files.length === 4, '四个文件被提交');
    assert_($(dom, '#modal-mask').classList.contains('hidden'), '提交后弹窗关闭');
  });

  await okAsync('Git Log：分支图 + HEAD 徽标 + 过滤', async () => {
    await g(dom, 'GitPanel.refresh()');
    await tick();
    const graphs = $allIn($(dom, '#git-history'), '.gc-graph').map((x) => x.textContent);
    assert_(graphs.length === 3, '3 行提交, got ' + graphs.length);
    assert_(graphs[0].includes('●'), 'HEAD 行有圆点: ' + JSON.stringify(graphs[0]));
    assert_(graphs.some((x) => x.includes('│')), '存在分支线: ' + JSON.stringify(graphs));
    assert_($(dom, '.badge.head'), 'HEAD 徽标存在');
    // 过滤
    const filter = $(dom, '#git-filter');
    filter.value = '分支';
    filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    const msgs = $allIn($(dom, '#git-history'), '.cmsg').map((x) => x.textContent);
    assert_(msgs.length === 1 && msgs[0].includes('分支上的提交'), '过滤后只剩一条: ' + JSON.stringify(msgs));
    filter.value = '';
    filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
  });

  await okAsync('点击提交 → 详情双栏（文件列表 + diff，无弹窗）', async () => {
    click($allIn($(dom, '#git-history'), '.git-commit').find((x) => x.textContent.includes('第二次提交')));
    await tick(); await tick();
    assert_(calls.commitFiles.length >= 1, '调用了 commitFiles');
    assert_($(dom, '.cd-wrap'), '详情双栏出现');
    const files = $allIn($(dom, '.cd-files'), '.cd-file');
    assert_(files.length === 2, '2 个变更文件');
    assert_(files[0].classList.contains('sel'), '默认选中第一个');
    assert_($(dom, '.cd-diff .diff-table'), '右侧默认渲染 diff');
    assert_(calls.diffCommit.length >= 1, '调用了 diffCommit');
    assert_(calls.diffCommit[0].startsWith('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:'), '对比的是点击的提交');
    // 点击第二个文件切换
    click(files[1]);
    await tick(); await tick();
    assert_(files[1].classList.contains('sel'), '选中切换');
    // 返回
    click($(dom, '#cd-back'));
    await tick();
    assert_(!$(dom, '.cd-wrap'), '返回后详情关闭');
  });

  await okAsync('Ctrl+R 刷新（无异常）', async () => {
    key(dom, 'r', { ctrl: true });
    await tick(); await tick();
    ok('Ctrl+R 无异常', () => {});
  });

  await okAsync('HTML 预览：iframe 渲染', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/page.html")');
    await tick(); await tick();
    const frame = $(dom, '.html-frame');
    assert_(frame, 'iframe 出现');
    assert_(frame.srcdoc.includes('<h1>Hi HTML</h1>'), 'srcdoc 包含内容');
  });

  await okAsync('工具窗口切换：Ctrl+2 大纲 / Ctrl+1 项目 / 再按收起（计算样式验证）', async () => {
    const display = (sel) => dom.window.getComputedStyle($(dom, sel)).display;
    key(dom, '2', { ctrl: true });
    await tick();
    assert_(display('#panel-project') === 'none', '项目面板 display:none, got: ' + display('#panel-project'));
    assert_(display('#panel-outline') !== 'none', '大纲面板可见, got: ' + display('#panel-outline'));
    assert_($(dom, '#tool-outline').classList.contains('active'), '大纲按钮激活');
    key(dom, '1', { ctrl: true });
    await tick();
    assert_(display('#panel-project') !== 'none', '项目面板恢复');
    key(dom, '1', { ctrl: true });
    await tick();
    assert_(display('#panel-project') === 'none', '再按 Ctrl+1 收起');
    key(dom, '1', { ctrl: true }); // 恢复展开
    await tick();
  });

  await okAsync('Markdown 大纲：标题条目 + 点击跳转', async () => {
    // 当前激活是 page.html，切回 README.md
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await tick(); await tick();
    key(dom, '2', { ctrl: true });
    await tick(); await tick();
    const items = $allIn($(dom, '#outline'), '.outline-item');
    assert_(items.length >= 1, '大纲有条目, got ' + items.length);
    assert_(items[0].textContent.includes('标题'), '条目文本正确: ' + items[0].textContent);
    // 切源码模式再点大纲 → 应自动切回预览
    click($allIn($(dom, '.viewer-toolbar'), 'button').find((b) => b.textContent.includes('源码')));
    await tick();
    assert_($(dom, 'textarea.editor'), '已切源码');
    click(items[0]);
    await tick();
    assert_($(dom, '.md-view'), '点击大纲自动切回预览');
  });

  await okAsync('Ctrl+P 快速打开：面板 + 过滤 + 回车打开', async () => {
    key(dom, 'p', { ctrl: true });
    await tick(); await tick();
    const input = $(dom, '#qo-input');
    assert_(input, '面板打开且有输入框');
    input.value = 'readme';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    const names = $allIn($(dom, '#qo-list'), '.qo-name').map((n) => n.textContent);
    assert_(names.includes('README.md'), '匹配 README.md, got: ' + names.join(','));
    assert_(!names.includes('notes.txt'), '不匹配的文件被过滤');
    // 回车打开
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick(); await tick();
    const tab = $(dom, '.tab.active .tname');
    assert_(tab && tab.textContent.includes('README.md'), '回车打开 README.md, got: ' + (tab && tab.textContent));
    assert_($(dom, '#modal-mask').classList.contains('hidden'), '面板已关闭');
  });

  await okAsync('快速打开：分散匹配 + Esc 关闭 + 第二次打开不崩', async () => {
    key(dom, 'p', { ctrl: true });
    await tick();
    const input = $(dom, '#qo-input');
    input.value = 'qk';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    const names = $allIn($(dom, '#qo-list'), '.qo-name').map((n) => n.textContent);
    assert_(names.includes('QuickOpen.js'), 'qk 分散匹配命中 QuickOpen.js, got: ' + names.join(','));
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    assert_($(dom, '#modal-mask').classList.contains('hidden'), 'Esc 关闭');
    // 第二次打开（回归：Modal.show 不再依赖 #modal-box）
    key(dom, 'p', { ctrl: true });
    await tick();
    assert_($(dom, '#qo-input'), '第二次打开正常');
    input.value = '';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
  });

  await okAsync('Ctrl+K 连续打开两次提交面板不崩（回归）', async () => {
    key(dom, 'k', { ctrl: true });
    await tick();
    assert_($(dom, '#commit-msg'), '第一次提交面板');
    click($(dom, '#cm-cancel'));
    await tick();
    key(dom, 'k', { ctrl: true });
    await tick();
    assert_($(dom, '#commit-msg'), '第二次提交面板（Modal.show 修复）');
    click($(dom, '#cm-cancel'));
    await tick();
  });

  await okAsync('会话记忆：标签页 + 活动标签 + 工具窗口恢复', async () => {
    dom.window.localStorage.clear(); // 清掉旧会话，避免 setRoot 的 restore 干扰
    // 先把历史测试遗留的 dirty 标签保存，避免 closeTab 弹确认框
    for (let i = 0; i < g(dom, 'Viewer.openTabs.length'); i++) {
      if (g(dom, 'Viewer.openTabs[' + i + '].dirty')) await g(dom, 'Viewer.saveTab(' + i + ')');
    }
    await tick();
    // 准备会话：打开两个文件，切到 git 工具窗口
    await g(dom, 'App.setRoot("' + P + '")');
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await g(dom, 'App.switchTool("git")');
    await tick();
    await new Promise((r) => setTimeout(r, 500)); // 等防抖保存
    // 清空
    while (g(dom, 'Viewer.openTabs.length') > 0) {
      g(dom, 'Viewer.closeTab(0)');
      await tick();
    }
    assert_(g(dom, 'Viewer.openTabs.length') === 0, '标签已清空');
    // 恢复
    await g(dom, 'Session.restore()');
    await tick(); await tick();
    const paths = g(dom, 'Viewer.openTabs.map(t => t.path)');
    assert_(paths.includes(P + '/README.md') && paths.includes(P + '/notes.txt'), '两个标签恢复, got: ' + JSON.stringify(paths));
    assert_(g(dom, 'Viewer.activeTab.path') === P + '/notes.txt', '活动标签恢复为 notes.txt');
    assert_(!$(dom, '#panel-git').classList.contains('hidden'), 'git 工具窗口恢复');
    await g(dom, 'App.switchTool("project")');
    await tick();
  });

  await okAsync('会话记忆：dirty 标签不写入保存', async () => {
    // 打开文件并弄脏
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await tick(); await tick();
    const btns = $allIn($(dom, '.viewer-toolbar'), 'button');
    click(btns.find((b) => b.textContent.includes('源码')));
    await tick();
    const ta = $(dom, 'textarea.editor');
    ta.value = 'dirty content';
    ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    assert_(g(dom, 'Viewer.activeTab.dirty') === true, '标签已变 dirty');
    await new Promise((r) => setTimeout(r, 500)); // 等防抖保存
    // 直接检查 localStorage 里的会话数据
    const raw = dom.window.localStorage.getItem('myide-session:' + P);
    const state = JSON.parse(raw || '{}');
    assert_(!(state.tabs || []).includes(P + '/README.md'), 'dirty 标签未写入, got: ' + JSON.stringify(state.tabs));
    // 清理：先保存（写入 fake），恢复 fake 内容，再精确定位关闭该 tab
    const ridx = g(dom, "Viewer.openTabs.findIndex(t => t.path === '" + P + "/README.md')");
    await g(dom, 'Viewer.saveTab(' + ridx + ')');
    FAKE_FS[P + '/README.md'].content = '# 标题\n\n这是 **Markdown** 测试\n\n```js\nconst x = 1;\n```\n';
    await g(dom, 'Viewer.closeTab(' + ridx + ')');
    await tick();
  });

  await okAsync('主题切换：默认深色 → toggle 浅色 → 快捷键', async () => {
    assert_(!$(dom, 'body').classList.contains('theme-light'), '默认深色');
    g(dom, 'Theme.toggle()');
    await tick();
    assert_($(dom, 'body').classList.contains('theme-light'), '切换后为浅色');
    assert_(dom.window.localStorage.getItem('myide-theme') === 'light', 'localStorage 已记录');
    key(dom, 'T', { ctrl: true, shift: true });
    await tick();
    assert_(!$(dom, 'body').classList.contains('theme-light'), '快捷键切回深色');
    assert_(dom.window.localStorage.getItem('myide-theme') === 'dark', 'localStorage 更新');
  });

  await okAsync('diff hunk 折叠：点击切换展开/收起', async () => {
    // 打开一个本地修改的 diff（fake 数据 1 个 hunk 2 行）
    await g(dom, 'App.switchTool("git")');
    await tick();
    const target = $allIn($(dom, '#git-body'), '.git-file').find((x) => x.textContent.includes('README.md'));
    click(target);
    await tick(); await tick();
    const sep = $(dom, '.diff-hunk-gap');
    assert_(sep, 'hunk 分隔行存在');
    assert_(sep.dataset.open === '1', '2 行 hunk 默认展开');
    click(sep);
    await tick();
    // 只收集第一个 hunk 的行（到下一个分隔行为止）
    const rows = [];
    let node = sep.nextElementSibling;
    while (node && !node.classList.contains('diff-hunk-gap')) {
      if (node.querySelector('td.ln')) rows.push(node);
      node = node.nextElementSibling;
    }
    assert_(rows.length > 0 && rows.every((tr) => tr.style.display === 'none'), '折叠后行隐藏');
    assert_(sep.textContent.includes('点击展开'), '显示展开提示');
    click(sep);
    await tick();
    assert_($allIn($(dom, '.diff-table'), 'tr').some((tr) => tr.style.display !== 'none' && tr.querySelector('td.ln')), '再次点击恢复');
  });

  await okAsync('内容搜索：Ctrl+Shift+F 面板 + 结果 + 点击打开', async () => {
    key(dom, 'F', { ctrl: true, shift: true });
    await tick();
    const input = $(dom, '#sr-input');
    assert_(input, '搜索面板打开');
    input.value = '标题';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400)); // 等防抖+搜索
    const items = $allIn($(dom, '#sr-list'), '.qo-item');
    assert_(items.length === 2, '2 条结果, got ' + items.length);
    assert_(items[0].textContent.includes('README.md:1'), '结果含文件:行号');
    assert_($(dom, '.sr-stat').textContent.includes('2 条结果'), '统计行显示');
    // 点击第一条 → 打开文件 + 面板关闭
    click(items[0]);
    await tick(); await tick();
    const tab = $(dom, '.tab.active .tname');
    assert_(tab && tab.textContent.includes('README.md'), '点击结果打开文件, got: ' + (tab && tab.textContent));
    assert_($(dom, '#modal-mask').classList.contains('hidden'), '面板关闭');
  });

  await okAsync('状态栏：文件/行数/分支/行列号', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    let sb = $(dom, '#statusbar').textContent;
    assert_(sb.includes('notes.txt'), '状态栏含文件名, got: ' + sb);
    assert_(sb.includes('2 行'), '状态栏含行数, got: ' + sb);
    assert_(sb.includes('main'), '状态栏含分支, got: ' + sb);
    // 光标行列
    const ta = $(dom, 'textarea.editor');
    ta.selectionStart = 3;
    ta.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    await tick();
    sb = $(dom, '#statusbar').textContent;
    assert_(sb.includes('行 1，列 4'), '行列号更新, got: ' + sb);
  });

  await okAsync('图片预览：img 渲染 + 无源码按钮', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/pic.png")');
    await tick(); await tick();
    const img = $(dom, '.img-view img');
    assert_(img, 'img 元素出现');
    assert_(img.src.includes('pic.png'), 'src 指向图片文件, got: ' + img.src);
    const hasSrc = $allIn($(dom, '.viewer-toolbar'), 'button').some((b) => b.textContent.includes('源码'));
    assert_(!hasSrc, '图片无「查看源码」按钮');
  });

  await okAsync('回归：先切大纲面板再打开 md → 大纲有内容', async () => {
    // 先保存所有 dirty 并关闭全部标签，保证 activeTab 为 null
    for (let i = 0; i < g(dom, 'Viewer.openTabs.length'); i++) {
      if (g(dom, 'Viewer.openTabs[' + i + '].dirty')) await g(dom, 'Viewer.saveTab(' + i + ')');
    }
    while (g(dom, 'Viewer.openTabs.length') > 0) { g(dom, 'Viewer.closeTab(0)'); await tick(); }
    await g(dom, 'App.switchTool("outline")');
    await tick();
    assert_($(dom, '#outline').textContent.includes('打开 Markdown 文件'), '无文件时提示, got: ' + $(dom, '#outline').textContent);
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await tick(); await tick(); await tick();
    const items = $allIn($(dom, '#outline'), '.outline-item');
    assert_(items.length >= 1, '大纲有条目, got ' + items.length);
    assert_(items[0].textContent.includes('标题'), '条目为标题: ' + items[0].textContent);
    await g(dom, 'App.switchTool("project")');
    await tick();
  });

  await okAsync('回归：先开 md 再切大纲 → 大纲有内容', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    await g(dom, 'App.switchTool("outline")');
    await tick();
    assert_($(dom, '#outline').textContent.includes('没有大纲'), '非 md 提示');
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await tick(); await tick(); await tick();
    assert_($allIn($(dom, '#outline'), '.outline-item').length >= 1, '切回 md 后大纲有内容');
    await g(dom, 'App.switchTool("project")');
    await tick();
  });

  await okAsync('版本号显示在状态栏右侧', async () => {
    await tick(); await tick();
    const el = $(dom, '#sb-version');
    assert_(el && el.textContent.includes('0.2.0'), '版本号显示, got: ' + (el && el.textContent));
    assert_(el.textContent.includes('test123'), '提交哈希显示');
  });

  await okAsync('设置：Ctrl+Alt+S 打开面板，列出动作', async () => {
    key(dom, 'S', { ctrl: true, alt: true });
    await tick();
    assert_($(dom, '#set-box'), '设置面板打开');
    const rows = $allIn($(dom, '#set-list'), '.set-row');
    assert_(rows.length >= 10, '动作列表完整, got ' + rows.length);
    assert_($(dom, '#set-list').textContent.includes('快速打开文件'), '含快速打开动作');
  });

  await okAsync('设置：修改快捷键为 Ctrl+Q 并生效', async () => {
    const qoRow = $allIn($(dom, '#set-list'), '.set-row').find((r) => r.textContent.includes('快速打开文件'));
    click(qoRow.querySelector('.set-combo'));
    await tick();
    assert_($(dom, '.set-combo.listening'), '进入监听态');
    key(dom, 'Q', { ctrl: true });
    await tick();
    assert_(!$(dom, '.set-combo.listening'), '监听结束');
    const qoRow2 = $allIn($(dom, '#set-list'), '.set-row').find((r) => r.textContent.includes('快速打开文件'));
    assert_(qoRow2.querySelector('.set-combo').textContent.includes('ctrl + q'), '显示新按键: ' + qoRow2.querySelector('.set-combo').textContent);
    // 关闭设置，用 Ctrl+Q 触发
    click($(dom, '#set-x'));
    await tick();
    key(dom, 'Q', { ctrl: true });
    await tick(); await tick();
    assert_($(dom, '#qo-input'), 'Ctrl+Q 触发快速打开');
    key(dom, 'Escape', {});
    await tick();
  });

  await okAsync('设置：冲突检测（绑定到已占用的 Ctrl+1）', async () => {
    key(dom, 'S', { ctrl: true, alt: true });
    await tick();
    const qoRow = $allIn($(dom, '#set-list'), '.set-row').find((r) => r.textContent.includes('快速打开文件'));
    click(qoRow.querySelector('.set-combo'));
    await tick();
    key(dom, '1', { ctrl: true });
    await tick();
    const toasts = $allIn(dom.window.document, '.toast');
    assert_(toasts.some((t) => t.textContent.includes('冲突')), '冲突提示出现');
    assert_($(dom, '#set-list').textContent.includes('工具窗口'), '面板仍正常');
  });

  await okAsync('设置：恢复默认', async () => {
    click($(dom, '#set-reset-all'));
    await tick();
    const qoRow2 = $allIn($(dom, '#set-list'), '.set-row').find((r) => r.textContent.includes('快速打开文件'));
    assert_(qoRow2.querySelector('.set-combo').textContent.includes('ctrl + p'), '恢复 Ctrl+P');
    // 验证 Ctrl+Q 不再触发
    click($(dom, '#set-x'));
    await tick();
    key(dom, 'Q', { ctrl: true });
    await tick();
    assert_(!$(dom, '#qo-input'), 'Ctrl+Q 已失效');
    // 确认 Ctrl+P 恢复
    key(dom, 'P', { ctrl: true });
    await tick();
    assert_($(dom, '#qo-input'), 'Ctrl+P 恢复生效');
    key(dom, 'Escape', {});
    await tick();
  });

  await okAsync('文件复制粘贴：Ctrl+C / Ctrl+V + 重名改名', async () => {

    // 清除可能残留的输入框焦点（jsdom 的 blur() 无效，改用 body.focus()）
    dom.window.document.body.focus();
    await tick();
    // 点选 README.md
    click($allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/README.md'));
    await tick();
    key(dom, 'c', { ctrl: true });
    await tick();
    assert_(fakeCopied.length === 1 && fakeCopied[0] === P + '/README.md', 'Ctrl+C 记录文件');
    // 选中 src 目录 → Ctrl+V 粘贴到该目录
    click($allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src'));
    await tick();
    key(dom, 'v', { ctrl: true });
    await tick(); await tick();
    assert_(FAKE_FS[P + '/src/README.md'], '副本出现在 src 目录');
    // 再次粘贴（选中态保持，无需重复点击）→ 重名自动改名
    key(dom, 'v', { ctrl: true });
    await tick(); await tick();
    assert_(FAKE_FS[P + '/src/README (1).md'], '重名自动改名');
    // 选中文件时粘贴 → 粘贴到其所在目录（src 展开状态在刷新后保持，直接点子文件）
    click($allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src/README.md'));
    await tick();
    key(dom, 'v', { ctrl: true });
    await tick(); await tick();
    assert_(FAKE_FS[P + '/src/README (2).md'], '选中文件时粘贴到所在目录');
  });

  await okAsync('文本区聚焦时 Ctrl+C 不触发文件复制', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    const ta = $(dom, 'textarea.editor');
    ta.focus();
    await tick();
    const before = fakeCopied.length;
    key(dom, 'c', { ctrl: true });
    await tick();
    assert_(fakeCopied.length === before, 'textarea 中 Ctrl+C 未触发文件复制');
  });

  await okAsync('外部剪贴板文件粘贴到目录', async () => {
    fakeExternal = ['C:/external/from-explorer.txt'];
    const dirRow = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src');
    click(dirRow);
    await tick();
    key(dom, 'v', { ctrl: true });
    await tick(); await tick();
    assert_(FAKE_FS[P + '/src/from-explorer.txt'], '外部文件粘贴成功');
    fakeExternal = [];
  });

  await okAsync('右键菜单：复制文件 / 粘贴到此处', async () => {
    const row = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/notes.txt');
    row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    const menu = $(dom, '#ctx-menu');
    assert_(!menu.classList.contains('hidden'), '右键菜单出现');
    const items = $allIn(menu, '.ctx-item').map((x) => x.textContent);
    assert_(items.includes('📋 复制文件') && items.includes('📌 粘贴到此处'), '菜单含复制/粘贴, got: ' + JSON.stringify(items));
  });

  await okAsync('多项目：项目栏按钮 + 点击切换', async () => {
    await g(dom, 'App.openProject("C:/proj2")');
    await tick(); await tick();
    let btns = $allIn($(dom, '#project-bar'), '.proj-btn');
    assert_(btns.length >= 2, '项目栏出现多个按钮, got ' + btns.length);
    assert_($(dom, '#tb-path').textContent.includes('C:/proj2'), '当前是项目二');
    // 点击切换到项目一
    click($allIn($(dom, '#project-bar'), '.proj-btn').find((b) => b.textContent.includes('proj') && b.title === P));
    await tick(); await tick();
    assert_($(dom, '#tb-path').textContent.includes('C:/proj'), '切换回项目一');
    const active = $allIn($(dom, '#project-bar'), '.proj-btn').find((b) => b.classList.contains('active'));
    assert_(active && active.title === P, '高亮跟随切换');
    // 切回项目二，验证树内容不同
    click($allIn($(dom, '#project-bar'), '.proj-btn').find((b) => b.title === 'C:/proj2'));
    await tick(); await tick();
    const names = $allIn($(dom, '#tree'), '.tree-row .nm').map((n) => n.textContent);
    assert_(names.includes('other.md'), '树切换到项目二内容: ' + JSON.stringify(names));
  });

  await okAsync('多项目：会话按项目独立记忆', async () => {
    // 项目二打开 other.md
    await g(dom, 'Viewer.openFile("C:/proj2/other.md")');
    await tick(); await tick();
    await new Promise((r) => setTimeout(r, 500)); // 防抖保存
    // 切到项目一，打开 README.md
    click($allIn($(dom, '#project-bar'), '.proj-btn').find((b) => b.title === P));
    await tick(); await tick();
    assert_($(dom, '#tb-path').textContent.includes('C:/proj'), '已切到项目一');
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await tick(); await tick();
    await new Promise((r) => setTimeout(r, 500)); // 防抖保存
    // 切回项目二 → 应恢复 other.md（项目二自己的会话）
    click($allIn($(dom, '#project-bar'), '.proj-btn').find((b) => b.title === 'C:/proj2'));
    await tick(); await tick();
    const tabs = g(dom, 'Viewer.openTabs.map(t => t.name)');
    assert_(tabs.includes('other.md'), '项目二恢复自己的标签: ' + JSON.stringify(tabs));
  });

  await okAsync('多项目：右键移除项目', async () => {
    const btn = $allIn($(dom, '#project-bar'), '.proj-btn').find((b) => b.title === P);
    btn.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    assert_($(dom, '#modal-mask:not(.hidden)') || $(dom, '#modal-mask'), '确认弹窗出现');
    // 点击确认（弹窗里的确定按钮）
    const yesBtn = $allIn($(dom, '#modal-mask'), 'button').find((b) => b.textContent.includes('确定'));
    click(yesBtn);
    await tick();
    const still = $allIn($(dom, '#project-bar'), '.proj-btn').some((b) => b.title === P);
    assert_(!still, '项目一从列表移除');
  });

  await okAsync('Git 刷新防抖：连续保存只刷一次', async () => {
    dom.window.__rc = 0;
    g(dom, 'GitPanel.refresh = () => { window.__rc++; return Promise.resolve(); }');
    // 准备一个 dirty 标签
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    const btns = $allIn($(dom, '.viewer-toolbar'), 'button');
    click(btns.find((b) => b.textContent.includes('保存')));
    await tick();
    click($allIn($(dom, '.viewer-toolbar'), 'button').find((b) => b.textContent.includes('保存')));
    await tick();
    assert_(dom.window.__rc === 0, '防抖窗口内未立即刷新');
    await new Promise((r) => setTimeout(r, 700));
    assert_(dom.window.__rc === 1, '防抖合并为一次刷新, got ' + dom.window.__rc);
  });

  await okAsync('设置：Git 配置分类（预填 + 保存）', async () => {
    key(dom, 'S', { ctrl: true, alt: true });
    await tick();
    // 切到 Git 分类
    click($allIn($(dom, '#set-box'), '.set-cat').find((x) => x.textContent.includes('Git')));
    await tick(); await tick();
    assert_($(dom, '#git-cfg-name'), 'Git 表单出现');
    assert_($(dom, '#git-cfg-name').value === 'tester', '预填用户名: ' + $(dom, '#git-cfg-name').value);
    assert_($(dom, '#git-cfg-email').value === 't@example.com', '预填邮箱');
    // 修改并保存
    $(dom, '#git-cfg-name').value = '张三';
    $(dom, '#git-cfg-email').value = 'zhangsan@x.com';
    click($(dom, '#git-cfg-save'));
    await tick();
    assert_(calls.setUserConfig.length === 1, '调用了 setUserConfig');
    assert_(calls.setUserConfig[0].name === '张三' && calls.setUserConfig[0].email === 'zhangsan@x.com', '配置值正确');
    // 切回快捷键分类仍正常
    click($allIn($(dom, '#set-box'), '.set-cat').find((x) => x.textContent.includes('快捷键')));
    await tick();
    assert_($allIn($(dom, '#set-list'), '.set-row').length >= 10, '快捷键列表恢复');
    click($(dom, '#set-x'));
    await tick();
  });

  await okAsync('标签页增强：中键关闭 / 关闭其他 / 关闭全部', async () => {
    // 清空历史标签（dirty 先保存）
    for (let i = 0; i < g(dom, 'Viewer.openTabs.length'); i++) {
      if (g(dom, 'Viewer.openTabs[' + i + '].dirty')) await g(dom, 'Viewer.saveTab(' + i + ')');
    }
    while (g(dom, 'Viewer.openTabs.length') > 0) { g(dom, 'Viewer.closeTab(0)'); await tick(); }
    await tick();
    // 打开 3 个标签
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await g(dom, 'Viewer.openFile("' + P + '/data.csv")');
    await tick(); await tick();
    assert_(g(dom, 'Viewer.openTabs.length') === 3, '3 个标签');
    // 中键关闭第一个
    const tabs0 = $allIn($(dom, '#tabbar'), '.tab');
    tabs0[0].dispatchEvent(new dom.window.MouseEvent('auxclick', { bubbles: true, button: 1 }));
    await tick();
    assert_(g(dom, 'Viewer.openTabs.length') === 2, '中键关闭后剩 2 个: ' + g(dom, 'Viewer.openTabs.length'));
    // 右键「关闭其他」
    const tabs1 = $allIn($(dom, '#tabbar'), '.tab');
    tabs1[0].dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    const menuItems = $allIn($(dom, '#ctx-menu'), '.ctx-item').map((x) => x.textContent);
    assert_(menuItems.includes('🗂 关闭其他') && menuItems.includes('🗑 关闭全部'), '菜单含关闭其他/全部');
    click($allIn($(dom, '#ctx-menu'), '.ctx-item').find((x) => x.textContent.includes('关闭其他')));
    await tick();
    assert_(g(dom, 'Viewer.openTabs.length') === 1, '关闭其他后剩 1 个');
    // 关闭全部
    const tabs2 = $allIn($(dom, '#tabbar'), '.tab');
    tabs2[0].dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    click($allIn($(dom, '#ctx-menu'), '.ctx-item').find((x) => x.textContent.includes('关闭全部')));
    await tick();
    assert_(g(dom, 'Viewer.openTabs.length') === 0, '关闭全部后清空');
  });

  await okAsync('分支切换：弹窗列出 + 点击切换', async () => {
    await g(dom, 'App.switchTool("git")');
    await tick();
    const branchBtn = $(dom, '#git-branch-btn');
    assert_(branchBtn, '分支按钮存在');
    click(branchBtn);
    await tick(); await tick();
    assert_($(dom, '#br-box'), '分支弹窗打开');
    const items = $allIn($(dom, '#br-list'), '.br-item');
    assert_(items.length === 2, '列出 2 个分支, got ' + items.length);
    assert_($(dom, '.br-item.current').textContent.includes('main'), '当前分支标记');
    // 点击 dev 切换
    click($allIn($(dom, '#br-list'), '.br-item').find((x) => x.textContent.includes('dev')));
    await tick(); await tick();
    assert_(calls.checkout.length === 1 && calls.checkout[0] === 'dev', 'checkout(dev) 被调用');
    assert_($(dom, '#modal-mask').classList.contains('hidden'), '弹窗关闭');
    await g(dom, 'App.switchTool("project")');
    await tick();
  });

  await okAsync('插件热重载：变更通知重载且不重复注册', async () => {
    assert_(fakePluginCb, 'onChanged 已订阅');
    const before = g(dom, 'MI.renderers.length');
    fakePluginCb(); // 模拟 plugins/ 目录文件变更
    await tick(); await tick();
    const after = g(dom, 'MI.renderers.length');
    assert_(after === before, '重载后渲染器数量不变（无重复）: ' + before + ' -> ' + after);
    // csv 插件功能仍可用
    await g(dom, 'Viewer.openFile("' + P + '/data.csv")');
    await tick(); await tick();
    assert_($(dom, '#csv-table'), '热重载后 csv 渲染仍正常');
  });

  await okAsync('标签拖拽排序：拖到目标位置 + 未移动保持点击', async () => {
    // 清空并打开 3 个标签
    for (let i = 0; i < g(dom, 'Viewer.openTabs.length'); i++) {
      if (g(dom, 'Viewer.openTabs[' + i + '].dirty')) await g(dom, 'Viewer.saveTab(' + i + ')');
    }
    while (g(dom, 'Viewer.openTabs.length') > 0) { g(dom, 'Viewer.closeTab(0)'); await tick(); }
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await g(dom, 'Viewer.openFile("' + P + '/data.csv")');
    await tick(); await tick();
    // mock 每个标签的矩形（jsdom getBoundingClientRect 全 0）
    const tabs = $allIn($(dom, '#tabbar'), '.tab');
    tabs.forEach((t, j) => { t.getBoundingClientRect = () => ({ left: j * 100, width: 100, top: 0, height: 24, right: j * 100 + 100, bottom: 24 }); });
    // 拖 tab0 到 tab1 之后：mousedown(50) → mousemove(160) → mouseup
    tabs[0].dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 50 }));
    dom.window.document.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, clientX: 160 }));
    dom.window.document.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, clientX: 160 }));
    await tick();
    const order = g(dom, 'Viewer.openTabs.map(t => t.path.split("/").pop())');
    assert_(JSON.stringify(order) === JSON.stringify(['notes.txt', 'README.md', 'data.csv']), '拖拽后顺序: ' + JSON.stringify(order));
    // 未移动的按下/抬起 → 顺序不变
    const tabs2 = $allIn($(dom, '#tabbar'), '.tab');
    tabs2[0].dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 50 }));
    dom.window.document.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, clientX: 52 }));
    await tick();
    const order2 = g(dom, 'Viewer.openTabs.map(t => t.path.split("/").pop())');
    assert_(JSON.stringify(order2) === JSON.stringify(['notes.txt', 'README.md', 'data.csv']), '未移动顺序不变: ' + JSON.stringify(order2));
  });

  await okAsync('文件树虚拟滚动：大目录只渲染可视窗口', async () => {
    // 构造 350 个文件的目录
    const big = 'C:/big';
    FAKE_FS[big] = { type: 'dir', children: [] };
    for (let i = 0; i < 350; i++) {
      const fp = big + '/f' + i + '.txt';
      FAKE_FS[fp] = { type: 'file', content: 'x' };
      FAKE_FS[big].children.push(fp);
    }
    await g(dom, 'App.openProject("C:/big")');
    await tick(); await tick();
    const rows = $allIn($(dom, '#tree'), '.tree-row');
    assert_(rows.length > 0 && rows.length < 350, '虚拟模式未全量渲染: ' + rows.length);
    const spacer = $(dom, '#tree > div');
    assert_(spacer && spacer.style.height === (351 * 22) + 'px', 'spacer 高度正确: ' + (spacer && spacer.style.height));
    // 滚动后重绘窗口
    $(dom, '#tree').scrollTop = 3000;
    $(dom, '#tree').dispatchEvent(new dom.window.Event('scroll'));
    await tick();
    const rows2 = $allIn($(dom, '#tree'), '.tree-row');
    assert_(rows2.length > 0 && rows2.length < 350, '滚动后仍窗口渲染: ' + rows2.length);
    const firstTitle = rows2[0].querySelector('.nm').title;
    assert_(firstTitle.includes('f'), '滚动后渲染新窗口内容: ' + firstTitle);
    // 切回原项目
    await g(dom, 'App.openProject("' + P + '")');
    await tick();
  });

  await okAsync('帮助页：F1 打开 + 快捷键表 + 自定义反映', async () => {
    key(dom, 'F1', {});
    await tick();
    assert_($(dom, '#help-box'), '帮助弹窗打开');
    const tableText = $(dom, '.help-table').textContent;
    assert_(tableText.includes('快速打开文件'), '表格含动作');
    assert_(tableText.includes('ctrl + p'), '表格含默认快捷键');
    // 自定义后表格反映（把快速打开改成 ctrl+q）
    click($(dom, '#help-x'));
    await tick();
    key(dom, 'S', { ctrl: true, alt: true });
    await tick();
    click($allIn($(dom, '#set-box'), '.set-cat').find((x) => x.textContent.includes('快捷键')));
    await tick();
    const qoRow = $allIn($(dom, '#set-list'), '.set-row').find((r) => r.textContent.includes('快速打开文件'));
    click(qoRow.querySelector('.set-combo'));
    await tick();
    key(dom, 'Q', { ctrl: true });
    await tick();
    click($(dom, '#set-x'));
    await tick();
    key(dom, 'F1', {});
    await tick();
    const tableText2 = $(dom, '.help-table').textContent;
    assert_(tableText2.includes('ctrl + q'), '自定义后帮助页反映: ' + JSON.stringify(tableText2.slice(0, 120)));

    // 恢复默认
    click($(dom, '#help-x'));
    await tick();
    key(dom, 'S', { ctrl: true, alt: true });
    await tick();
    click($(dom, '#set-reset-all'));
    await tick();
    click($(dom, '#set-x'));
    await tick();
  });

  await okAsync('文件编码：GBK 文件打开 + 状态栏 + 保存回写', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/gbk-old.txt")');
    await tick(); await tick();
    const ta = $(dom, 'textarea.editor');
    assert_(ta && ta.value.includes('中文老文件内容'), 'GBK 内容正常显示');
    assert_($(dom, '#sb-info').textContent.includes('GBK'), '状态栏显示 GBK 编码: ' + $(dom, '#sb-info').textContent);
    assert_(g(dom, 'Viewer.activeTab.encoding') === 'gbk', 'tab 记录编码');
    // 修改并保存 → writeFile 收到 encoding
    ta.value = '中文老文件内容 已编辑';
    ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    await g(dom, 'Viewer.saveTab(' + g(dom, 'Viewer.openTabs.findIndex(t => t.path === "' + P + '/gbk-old.txt")') + ')');
    await tick();
    assert_(FAKE_FS[P + '/gbk-old.txt'].content === '中文老文件内容 已编辑', '保存内容更新');
  });

  await okAsync('编辑器行号：显示 + 换行增加 + 滚动同步', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/gbk-old.txt")');
    await tick(); await tick();
    const gutter = $(dom, '.editor-gutter');
    assert_(gutter, '行号 gutter 存在');
    assert_(gutter.textContent.includes('1'), '含行号 1');
    const ta = $(dom, 'textarea.editor');
    const before = gutter.textContent.split('\n').length;
    // 输入换行 → 行号增加
    ta.value = ta.value + '\n\n新行';

    ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    const after = gutter.textContent.split('\n').length;
    assert_(after > before, '行号随行数增加: ' + before + ' -> ' + after);
    // 滚动同步
    ta.scrollTop = 123;
    ta.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    await tick();
    assert_(gutter.scrollTop === 123, 'gutter 滚动同步: ' + gutter.scrollTop);
  });

  await okAsync('PDF 预览：iframe 加载 file:// 路径', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/manual.pdf")');
    await tick(); await tick();
    const frame = $(dom, 'iframe.html-frame');
    assert_(frame, 'PDF iframe 出现');
    assert_(frame.src.includes('manual.pdf'), 'src 指向 PDF: ' + frame.src);
  });

  await okAsync('diff hunk 导航：按钮 + 循环切换', async () => {
    await g(dom, 'App.switchTool("git")');
    await tick();
    click($allIn($(dom, '#git-body'), '.git-file').find((x) => x.textContent.includes('README.md')));
    await tick(); await tick();
    const nav = $(dom, '.df-nav');
    assert_(nav, '导航按钮组存在');
    assert_($(dom, '.df-nav-label').textContent.includes('/'), '序号显示: ' + $(dom, '.df-nav-label').textContent);
    const before = $(dom, '.df-nav-label').textContent;
    click($allIn(nav, 'button').find((b) => b.textContent.includes('⤓')));
    await tick();
    assert_($(dom, '.df-nav-label').textContent !== before, '点击后序号变化');
    // 返回
    click($(dom, '#df-back'));
    await tick();
    await g(dom, 'App.switchTool("project")');
    await tick();
  });

  await okAsync('Git 日志分支视图：下拉 + 切换 ref', async () => {
    await g(dom, 'App.switchTool("git")');
    await tick();
    const sel = $(dom, '#git-ref');
    assert_(sel, '分支下拉存在');
    const opts = $allIn(sel, 'option').map((o) => o.value);
    assert_(opts.includes('__all__') && opts.includes('HEAD') && opts.includes('dev'), '选项完整: ' + JSON.stringify(opts));
    // 选「所有分支」
    sel.value = '__all__';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick(); await tick();
    assert_(calls.logAll === true, 'logAll 被调用');
    assert_($allIn($(dom, '#git-history'), '.git-commit').length === 3, '列表刷新');
    // 选具体分支 dev
    const sel2 = $(dom, '#git-ref');
    sel2.value = 'dev';
    sel2.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick(); await tick();
    assert_(calls.logRef === 'dev', 'log 收到 ref=dev, got: ' + calls.logRef);
    await g(dom, 'App.switchTool("project")');
    await tick();
  });

  await okAsync('新建文件/文件夹：右键菜单创建', async () => {
    // 右键 src 目录 → 新建文件
    const srcRow = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src');
    srcRow.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    const menuItems = $allIn($(dom, '#ctx-menu'), '.ctx-item').map((x) => x.textContent);
    assert_(menuItems.includes('✨ 新建文件') && menuItems.includes('📁 新建文件夹'), '菜单含新建项');
    // 新建文件（Modal.prompt 输入）
    click($allIn($(dom, '#ctx-menu'), '.ctx-item').find((x) => x.textContent.includes('新建文件')));
    await tick();
    const input = $(dom, '#pf-input');
    assert_(input, '名称输入框出现');
    input.value = 'newfile.txt';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick(); await tick();
    const newPath = P + '/src\\newfile.txt'; // 产品用反斜杠拼接（Windows 语义）
    assert_(FAKE_FS[newPath], '文件已创建');
    assert_(g(dom, 'Viewer.activeTab.path') === newPath, '自动打开新文件');
    // 新建文件夹（选中 src 内）
    const srcRow2 = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src');
    srcRow.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    click($allIn($(dom, '#ctx-menu'), '.ctx-item').find((x) => x.textContent.includes('新建文件夹')));
    await tick();
    const input2 = $(dom, '#pf-input');
    input2.value = 'sub';
    input2.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick(); await tick();
    assert_(FAKE_FS[P + '/src\\sub'] && FAKE_FS[P + '/src\\sub'].type === 'dir', '文件夹已创建');
  });

  await okAsync('编辑器查找替换：Ctrl+F 计数/循环 + Ctrl+H 替换', async () => {
    // 打开文本并构造多匹配内容
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    const ta = $(dom, 'textarea.editor');
    ta.value = 'foo bar foo baz foo';
    ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    // Ctrl+F
    key(dom, 'f', { ctrl: true });
    await tick();
    const input = $(dom, '#find-input');
    assert_(input, '查找条出现');
    input.value = 'foo';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    assert_($(dom, '#find-count').textContent === '1/3', '计数 1/3: ' + $(dom, '#find-count').textContent);
    assert_(ta.selectionStart === 0 && ta.selectionEnd === 3, '选中第一个匹配');
    // Enter → 下一个
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick();
    assert_($(dom, '#find-count').textContent === '2/3', 'Enter 后 2/3');
    assert_(ta.selectionStart === 8, '选中第二个匹配: ' + ta.selectionStart);
    // Ctrl+H 替换
    key(dom, 'h', { ctrl: true });
    await tick();
    assert_($(dom, '#find-replace-row').style.display !== 'none', '替换行展开');
    $(dom, '#find-replace-input').value = 'X';
    click($(dom, '#find-rep-one'));
    await tick();
    assert_(ta.value === 'foo bar X baz foo', '替换当前匹配: ' + ta.value);
    // 全部替换
    click($(dom, '#find-rep-all'));
    await tick();
    assert_(ta.value === 'X bar X baz X', '全部替换: ' + ta.value);
    // 关闭
    click($(dom, '#find-close'));
    await tick();
    assert_(!$(dom, '.find-bar'), '查找条关闭');
  });

  await okAsync('树定位：打开深层文件自动展开并高亮', async () => {
    // 先收起 src（确保展开动作可观察）
    const srcRow = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src');
    if (srcRow) { click(srcRow); await tick(); }
    assert_(!$allIn($(dom, '#tree'), '.tree-row').some((r) => r.querySelector('.nm').title === P + '/src/app.js'), 'src 已收起');
    // 打开深层文件 → 自动展开
    await g(dom, 'Viewer.openFile("' + P + '/src/app.js")');
    await tick(); await tick(); await tick();
    const titles = $allIn($(dom, '#tree'), '.tree-row').map((r) => r.querySelector('.nm').title);
    assert_(titles.includes(P + '/src/app.js'), '树中出现 app.js: ' + JSON.stringify(titles));
    assert_(titles.includes(P + '/src'), 'src 已展开');
    // 高亮选中
    assert_($allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src/app.js').classList.contains('selected'), '文件行高亮');
  });

  await okAsync('状态栏分支点击 + 快速打开最近文件', async () => {
    // 状态栏分支可点击 → 弹窗
    const br = $(dom, '#sb-branch');
    assert_(br && br.textContent.includes('main'), '状态栏分支存在');
    click(br);
    await tick(); await tick();
    assert_($(dom, '#br-box'), '点击分支打开切换弹窗');
    click($(dom, '#br-x'));
    await tick();
    // 最近文件：打开一个文件 → 快速打开无输入显示
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    key(dom, 'p', { ctrl: true });
    await tick();
    const qo = $(dom, '#qo-input');
    assert_(qo, '快速打开打开');
    await tick();
    const stat = $allIn($(dom, '#qo-list'), '.sr-stat');
    assert_(stat.length > 0 && stat[0].textContent.includes('最近打开'), '显示最近打开');
    const recentRows = $allIn($(dom, '#qo-list'), '.qo-item');
    assert_(recentRows.length >= 1, '最近文件列表');
    // 点击最近项 → 打开
    click(recentRows[0]);
    await tick(); await tick();
    assert_($(dom, '.tab.active .tname'), '最近项打开文件');
  });

  await okAsync('diff 内容复制：旧版/新版按钮', async () => {
    await g(dom, 'App.switchTool("git")');
    await tick();
    click($allIn($(dom, '#git-body'), '.git-file').find((x) => x.textContent.includes('README.md')));
    await tick(); await tick();
    const before = calls.copy.length;
    click($(dom, '#df-copy-old'));
    await tick();
    assert_(calls.copy.length === before + 1, '旧版复制触发');
    assert_(calls.copy[calls.copy.length - 1] === 'old line\n', '旧版内容正确');
    click($(dom, '#df-copy-new'));
    await tick();
    assert_(calls.copy[calls.copy.length - 1] === 'new line\n', '新版内容正确');
    click($(dom, '#df-back'));
    await tick();
    await g(dom, 'App.switchTool("project")');
    await tick();
  });

  await okAsync('编辑配对补全：自动配对/跳过/包裹/删除配对', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    const ta = $(dom, 'textarea.editor');
    ta.value = '';
    ta.selectionStart = 0; ta.selectionEnd = 0;
    const type = (k) => ta.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    // 1) 输入 ( → 自动补全
    type('(');
    await tick();
    assert_(ta.value === '()', '自动补全: ' + JSON.stringify(ta.value));
    assert_(ta.selectionStart === 1, '光标在中间: ' + ta.selectionStart);
    // 2) 输入 ) → 跳过
    type(')');
    await tick();
    assert_(ta.value === '()', '闭符号跳过不重复: ' + JSON.stringify(ta.value));
    assert_(ta.selectionStart === 2, '光标右移');
    // 3) 选中文本包裹
    ta.value = 'abc';
    ta.selectionStart = 1; ta.selectionEnd = 2;
    type('[');
    await tick();
    assert_(ta.value === 'a[b]c', '包裹选中: ' + JSON.stringify(ta.value));
    // 4) Backspace 删除配对
    ta.value = '()';
    ta.selectionStart = 1; ta.selectionEnd = 1; // 光标在配对中间
    type('Backspace');
    await tick();
    assert_(ta.value === '', '退格删除配对: ' + JSON.stringify(ta.value));
  });

  await okAsync('换行符显示：CRLF 文件状态栏标记，LF 不显示', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/crlf-file.txt")');
    await tick(); await tick();
    assert_($(dom, '#sb-info').textContent.includes('(CRLF)'), 'CRLF 标记: ' + $(dom, '#sb-info').textContent);
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    assert_(!$(dom, '#sb-info').textContent.includes('CRLF'), 'LF 文件无标记');
  });

  await okAsync('帮助页版本信息显示', async () => {
    key(dom, 'F1', {});
    await tick(); await tick();
    const ver = $(dom, '#help-ver');
    assert_(ver && ver.textContent.includes('0.2.0'), '版本显示: ' + (ver && ver.textContent));
    click($(dom, '#help-x'));
    await tick();
  });

  await okAsync('设置页主题分类 + 空状态最近项目', async () => {
    // 主题分类
    key(dom, 'S', { ctrl: true, alt: true });
    await tick();
    click($allIn($(dom, '#set-box'), '.set-cat').find((x) => x.textContent.includes('主题')));
    await tick();
    assert_($(dom, '.theme-opt'), '主题选项出现');
    assert_($allIn(dom.window.document, '.theme-opt').find((b) => b.classList.contains('sel')).textContent.includes('深色'), '当前主题高亮');
    click($allIn(dom.window.document, '.theme-opt').find((b) => b.dataset.th === 'light'));
    await tick();
    assert_($(dom, 'body').classList.contains('theme-light'), '浅色即时生效');
    click($(dom, '#set-x'));
    await tick();
    // 恢复深色（避免影响后续）
    g(dom, 'Theme.set("dark")');
    await tick();
    // 空状态最近项目（多项目测试已建 projects）
    await g(dom, 'App.setRoot("C:/proj2")');
    await tick(); await tick();
    const recent = $(dom, '#empty-recent');
    // 清空标签触发空状态（先保存 dirty，避免确认弹窗卡循环）
    for (let i = 0; i < g(dom, 'Viewer.openTabs.length'); i++) {
      if (g(dom, 'Viewer.openTabs[' + i + '].dirty')) await g(dom, 'Viewer.saveTab(' + i + ')');
    }
    while (g(dom, 'Viewer.openTabs.length') > 0) { g(dom, 'Viewer.closeTab(0)'); await tick(); }
    await tick();
    assert_(recent && $allIn(recent, '.proj-btn').length >= 1, '空状态最近项目出现');
    await g(dom, 'App.openProject("' + P + '")');
    await tick(); await tick();
  });

  await okAsync('Git 修改目录分组 + 折叠 + Toast 上限', async () => {
    await g(dom, 'App.switchTool("git")');
    await tick(); await tick();
    const groups = $allIn($(dom, '#git-body'), '.git-group');
    assert_(groups.length === 2, '两个分组: ' + JSON.stringify(groups.map((x) => x.textContent)));
    assert_(groups[0].textContent.includes('根目录'), '根目录组');
    assert_(groups[1].textContent.includes('src'), 'src 组');
    // 折叠
    click(groups[1]);
    await tick();
    assert_(groups[1].textContent.includes('▸'), '组已折叠');
    click(groups[1]);
    await tick();
    assert_(groups[1].textContent.includes('▾'), '组已展开');
    await g(dom, 'App.switchTool("project")');
    await tick();
    // Toast 上限
    for (let i = 0; i < 8; i++) g(dom, 'MI.toast("t' + i + '", "ok")');
    await tick();
    assert_($allIn(dom.window.document, '.toast').length <= 5, 'toast 上限 5: ' + $allIn(dom.window.document, '.toast').length);
  });

  await okAsync('字号缩放 + diff hunk 快捷键', async () => {
    // 字号
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    const rootStyle = dom.window.document.documentElement.style;
    key(dom, '=', { ctrl: true });
    await tick();
    assert_(rootStyle.getPropertyValue('--editor-font-size') === '14px', '字号 14px: ' + rootStyle.getPropertyValue('--editor-font-size'));
    assert_(dom.window.localStorage.getItem('myide-editor-font') === '14', '字号持久化');
    key(dom, '-', { ctrl: true });
    await tick();
    assert_(rootStyle.getPropertyValue('--editor-font-size') === '13px', '字号回到 13px');
    // hunk 快捷键（diff 视图）
    await g(dom, 'App.switchTool("git")');
    await tick();
    click($allIn($(dom, '#git-body'), '.git-file').find((x) => x.textContent.includes('README.md')));
    await tick(); await tick();
    const before = $(dom, '.df-nav-label').textContent;
    key(dom, 'ArrowDown', { alt: true });
    await tick();
    assert_($(dom, '.df-nav-label').textContent !== before, 'Alt+↓ 切换 hunk');
    click($(dom, '#df-back'));
    await tick();
    await g(dom, 'App.switchTool("project")');
    await tick();
  });

  await okAsync('Git 日志分页：加载更多', async () => {
    await g(dom, 'App.switchTool("git")');
    await tick();
    // 切到 dev（100 条）
    const sel = $(dom, '#git-ref');
    sel.value = 'dev';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick(); await tick();
    const more = $(dom, '#git-load-more');
    assert_(more, '加载更多按钮出现');
    click(more);
    await tick(); await tick();
    assert_(calls.logDepth === 200, '深度增加到 200: ' + calls.logDepth);
    // 切回默认
    const sel2 = $(dom, '#git-ref');
    sel2.value = 'HEAD';
    sel2.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick(); await tick();
    assert_(!$(dom, '#git-load-more'), '默认视图无加载更多（3 条 < 100）');
    await g(dom, 'App.switchTool("project")');
    await tick();
  });

  await okAsync('设置页快捷键搜索过滤', async () => {
    key(dom, 'S', { ctrl: true, alt: true });
    await tick();
    click($allIn($(dom, '#set-box'), '.set-cat').find((x) => x.textContent.includes('快捷键')));
    await tick();
    const filter = $(dom, '#set-keys-filter');
    assert_(filter, '过滤框存在');
    const total = $allIn($(dom, '#set-list'), '.set-row').length;
    filter.value = '快速打开';
    filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    const rows = $allIn($(dom, '#set-list'), '.set-row');
    assert_(rows.length === 1 && rows[0].textContent.includes('快速打开文件'), '过滤后只剩匹配: ' + rows.length);
    filter.value = '';
    filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    assert_($allIn($(dom, '#set-list'), '.set-row').length === total, '清空恢复全部');
    click($(dom, '#set-x'));
    await tick();
  });

  await okAsync('帮助页快捷键过滤', async () => {
    key(dom, 'F1', {});
    await tick();
    const filter = $(dom, '#help-filter');
    assert_(filter, '过滤框存在');
    const total = $allIn($(dom, '.help-table'), 'tr').length - 1; // 去掉表头
    filter.value = '快速打开';
    filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    const visible = $allIn($(dom, '.help-table'), 'tr').filter((tr) => tr.style.display !== 'none').length - 1;
    assert_(visible === 1, '过滤后 1 行可见: ' + visible);
    filter.value = '';
    filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    click($(dom, '#help-x'));
    await tick();
  });

  await okAsync('状态栏路径点击复制', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    const before = calls.copy.length;
    click($(dom, '#sb-info'));
    await tick();
    assert_(calls.copy.length === before + 1, '复制触发');
    assert_(calls.copy[calls.copy.length - 1] === P + '/notes.txt', '复制的是当前文件路径: ' + calls.copy[calls.copy.length - 1]);
  });

  await okAsync('提交面板 diff 预览', async () => {
    await g(dom, 'App.switchTool("git")');
    await tick();
    key(dom, 'k', { ctrl: true });
    await tick(); await tick();
    assert_($(dom, '#commit-preview'), '预览区存在');
    assert_($(dom, '#commit-preview .diff-table'), '默认预览第一个文件');
    const before = calls.diffWorkdir.length;
    // 点击第二个文件行（非 checkbox）
    const rows = $allIn($(dom, '#commit-files'), '.commit-file');
    const second = rows[1].querySelector('.nm');
    click(second);
    await tick(); await tick();
    assert_(calls.diffWorkdir.length === before + 1, '点击触发了 diffWorkdir');
    assert_($(dom, '#commit-preview .diff-table'), '预览更新');
    click($(dom, '#cm-cancel'));
    await tick();
    await g(dom, 'App.switchTool("project")');
    await tick();
  });

  await okAsync('toast 提示正常', async () => {
    g(dom, 'MI.toast("测试提示", "ok")');
    await tick();
    assert_($allIn(dom.window.document, '.toast').some((t) => t.textContent.includes('测试提示')), 'toast 出现');
  });

  console.log('');
  console.log('结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
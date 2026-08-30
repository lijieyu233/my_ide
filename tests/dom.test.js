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
  [P + '/src']: { type: 'dir', children: [P + '/src/app.js', P + '/src/demo.exe'] },
  [P + '/src/demo.exe']: { type: 'file', content: '' },
  [P + '/README.md']: { type: 'file', content: '# 标题\n\n这是 **Markdown** 测试\n\n```js\nconst x = 1;\n```\n', mtime: 2000, ctime: 3000, size: 60 },
  [P + '/src/app.js']: { type: 'file', content: 'const a = 1;\n', mtime: 9000, ctime: 5000, size: 15 },
  [P + '/data.csv']: { type: 'file', content: '名称,数量\n苹果,3\n香蕉,5\n', mtime: 5000, ctime: 1000, size: 40 },
  [P + '/notes.txt']: { type: 'file', content: 'hello notes\n', mtime: 1000, ctime: 9000, size: 12 },
  [P + '/page.html']: { type: 'file', content: '<h1>Hi HTML</h1><script>document.title = "ok";<\/script>' },
  [P + '/QuickOpen.js']: { type: 'file', content: 'const q = 1;\n' },
  [P + '/pic.png']: { type: 'file', content: '' },
  ['C:/proj2']: { type: 'dir', children: ['C:/proj2/other.md'] },
  ['C:/proj2/other.md']: { type: 'file', content: '# 项目二文档\n' },
  ['C:/proj/gbk-old.txt']: { type: 'file', content: '中文老文件内容', encoding: 'gbk' },
  ['C:/proj/manual.pdf']: { type: 'file', content: '' },
  ['C:/proj/crlf-file.txt']: { type: 'file', content: 'line1\r\nline2\r\n' },
  ['C:/proj/link.md']: { type: 'file', content: '# 链接测试\n\n[外部链接](https://example.com)\n[本地文件](./notes.txt)\n[锚点](#链接测试)\n\n[[README]]\n\n![[pic.png]]\n' },
};
const FAKE_GIT = {
  changed: [
    { file: 'README.md', status: 'modified', label: '已修改' },
    { file: 'data.csv', status: 'added', label: '已新增' },
    { file: 'src/app.js', status: 'modified', label: '已修改' },
    { file: 'src/deep/file.ts', status: 'added', label: '已新增' },
  ],
  commits: [
    { oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', short: 'aaaaaaa', message: '第二次提交：改文档', fullMessage: '第二次提交：改文档', author: 'me', email: 'me@x.com', timestamp: Date.now() - 3600e3, parents: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] },
    { oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', short: 'bbbbbbb', message: '合并提交', fullMessage: '合并提交', author: 'me', email: 'me@x.com', timestamp: Date.now() - 7200e3, parents: ['cccccccccccccccccccccccccccccccccccccccc', 'dddddddddddddddddddddddddddddddddddddddd'] },
    { oid: 'cccccccccccccccccccccccccccccccccccccccc', short: 'ccccccc', message: '分支上的提交', fullMessage: '分支上的提交', author: 'me', email: 'me@x.com', timestamp: Date.now() - 10800e3, parents: [] },
  ],
  branchHeads: {
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': ['main'],
    'cccccccccccccccccccccccccccccccccccccccc': ['dev'],
  },
  headOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};
const calls = { copy: [], commit: [], commitFiles: [], diffWorkdir: [], diffCommit: [] };
const stateCb = {}; // 各模块状态回调（browser 等）
let fakeCopied = [];   // 内部复制的文件
calls.setUserConfig = [];
calls.checkout = [];
calls.discard = [];
calls.createBranch = [];
calls.logRef = null;
calls.logAll = false;
calls.logDepth = null;
let fakePluginCb = null; // 插件热重载回调
let fakeExternal = []; // 模拟系统剪贴板的外部文件

function makeDom() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  // jsdom 无布局：给 Range 补 getClientRects stub，防 CM6 measure 崩溃噪音
  if (w.Range && !w.Range.prototype.getClientRects) {
    const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    w.Range.prototype.getClientRects = function () { return [rect]; };
  }
  // 注入真实样式表：让 getComputedStyle 反映 display，防「类存在但 CSS 没定义」盲区
  const st = w.document.createElement('style');
  st.textContent = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  w.document.head.appendChild(st);
  w.myIDE = {
    fs: {
      openFolder: async () => P,
      getRecent: async () => null,
      setRecent: async () => {},
      readDir: async (p) => (FAKE_FS[p] ? FAKE_FS[p].children.map((c) => ({ name: c.split('/').pop(), type: FAKE_FS[c].type, path: c, mtime: FAKE_FS[c].mtime, ctime: FAKE_FS[c].ctime, size: FAKE_FS[c].size })) : []),
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
      remove: async (p) => {
        delete FAKE_FS[p];
        const parent = p.split('/').slice(0, -1).join('/');
        if (FAKE_FS[parent] && FAKE_FS[parent].type === 'dir') FAKE_FS[parent].children = FAKE_FS[parent].children.filter((c) => c !== p);
        return { ok: true };
      },
      move: async (src, destDir) => {
        const name = src.split('/').pop();
        const extIdx = name.lastIndexOf('.');
        const ext = extIdx > 0 ? name.slice(extIdx) : '';
        const base = extIdx > 0 ? name.slice(0, extIdx) : name;
        let target = destDir + '/' + name;
        for (let i = 1; FAKE_FS[target]; i++) target = destDir + '/' + base + ' (' + i + ')' + ext;
        const entry = FAKE_FS[src];
        if (!entry) return { error: 'not found' };
        delete FAKE_FS[src];
        const srcParent = src.split('/').slice(0, -1).join('/');
        if (FAKE_FS[srcParent]) FAKE_FS[srcParent].children = FAKE_FS[srcParent].children.filter((c) => c !== src);
        FAKE_FS[target] = entry;
        if (FAKE_FS[destDir] && FAKE_FS[destDir].type === 'dir') FAKE_FS[destDir].children.push(target);
        return { ok: true, target };
      },
    },
    shell: { showInFolder: async () => {}, openExternal: async (url) => { (calls.openExternal = calls.openExternal || []).push(url); return true; }, openTerminal: async (dir) => { (calls.openTerminal = calls.openTerminal || []).push(dir); return { ok: true }; }, runFile: async (p) => { (calls.runFile = calls.runFile || []).push(p); return { ok: true, how: 'exe' }; } },
    browser: {
      viewOpen: async (url) => { (calls.viewOpen = calls.viewOpen || []).push(url); return { ok: true }; },
      viewBounds: async (r) => { (calls.viewBounds = calls.viewBounds || []).push(r); },
      viewHide: async () => { (calls.viewHide = calls.viewHide || 0); calls.viewHide++; },
      viewNav: async (cmd) => { (calls.viewNav = calls.viewNav || []).push(cmd); },
      onCmd: () => {},
      onState: (cb) => { stateCb.browser = cb; },
    },
    db: {
      connect: async () => ({ ok: true, data: { id: 'c1' } }),
      close: async () => ({ ok: true }),
      tables: async () => ({ ok: true, data: [{ name: 'users' }, { name: 'orders' }] }),
      columns: async () => ({ ok: true, data: [{ name: 'id', pk: 1 }, { name: 'name', pk: 0 }] }),
      select: async () => ({ ok: true, data: { columns: ['id', 'name'], rows: [{ id: 1, name: 'alice' }], total: 1, pk: ['id'] } }),
      query: async () => ({ ok: true, data: { columns: [], rows: [], affected: 0 } }),
      updateCell: async () => ({ ok: true }),
      deleteRows: async () => ({ ok: true }),
      insertRow: async () => ({ ok: true }),
      ddl: async () => ({ ok: true, data: { ddl: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)' } }),
      explain: async () => ({ ok: true, data: { ok: 'select', columns: ['id', 'detail'], rows: [{ id: 1, detail: 'SCAN TABLE users' }] } }),
      er: async () => ({
        ok: true, data: {
          tables: [
            { name: 'users', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'name', type: 'TEXT', pk: false }] },
            { name: 'orders', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'user_id', type: 'INTEGER', pk: false }] },
          ],
          relations: [{ from: 'orders', fromCol: 'user_id', to: 'users', toCol: 'id' }],
        },
      }),
      exportCsv: async () => ({ ok: true, data: { rows: 1, file: 'C:/t.csv' } }),
      importCsv: async () => ({ ok: true, data: { inserted: 1 } }),
    },
    win: { minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {}, isMaximized: async () => false, zoom: async (d) => { (calls.zoom = calls.zoom || []).push(d); } },
    clip: {
      copy: async (t) => { calls.copy.push(t); return true; },
      copyFiles: async (paths) => { fakeCopied = paths.slice(); return true; },
      getFiles: async () => (fakeExternal.length ? fakeExternal.slice() : []),
    },
    fsCopy: async (src, destDir, overwrite) => {
      const name = src.split('/').pop();
      const target = destDir + '/' + name;
      // 同名：默认 conflict（前端弹确认框），overwrite=true 才覆盖——对齐主进程 fs:copy
      if (!overwrite && FAKE_FS[target]) return { conflict: true, target };
      const srcEntry = FAKE_FS[src] || { type: 'file', content: 'external content' };
      FAKE_FS[target] = { type: srcEntry.type, content: srcEntry.content || '', children: srcEntry.children ? srcEntry.children.slice() : undefined };
      if (FAKE_FS[destDir] && FAKE_FS[destDir].type === 'dir') {
        if (!FAKE_FS[destDir].children.includes(target)) FAKE_FS[destDir].children.push(target);
      }
      return { ok: true, target };
    },
    checkConflict: async (srcPaths, destDir) => {
      return srcPaths.map((s) => s.split('/').pop()).filter((n) => !!FAKE_FS[destDir + '/' + n]);
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
      logGraph: async (d, limit = 500, ref = null) => {
        calls.logGraphRef = ref;
        calls.logGraphLimit = limit;
        let commits = FAKE_GIT.commits;
        let truncated = false;
        if (ref === 'dev') {
          // dev 分支：100 条 + truncated（分页测试用）
          commits = Array.from({ length: 100 }, (_, i) => ({ oid: 'd' + String(i).padStart(39, '0'), short: 'd' + i, message: 'commit ' + i, fullMessage: 'commit ' + i, author: 'me', email: 'me@x.com', timestamp: Date.now() - i * 1000, parents: i === 0 ? [] : ['d' + String(i - 1).padStart(39, '0')] }));
          truncated = true;
        }
        return { isRepo: true, root: P, branch: 'main', commits, branchHeads: FAKE_GIT.branchHeads, headOid: FAKE_GIT.headOid, truncated };
      },
      commit: async (d, o) => { calls.commit.push(o); return { ok: true, oid: 'cccccccccccccccccccccccccccccccccccccccc' }; },
      diffWorkdir: async (d, f) => { calls.diffWorkdir.push(f); return { file: f, oldText: 'old line\n', newText: 'new line\n', hunks: [
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, rows: [{ type: 'del', aText: 'old line', bText: '', aNum: 1, bNum: 0 }, { type: 'add', aText: '', bText: 'new line', aNum: 0, bNum: 1 }] },
        { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, rows: [{ type: 'ctx', aText: 'ctx line', bText: 'ctx line', aNum: 10, bNum: 10 }] },
      ] }; },
      diffCommit: async (d, oid, f) => { calls.diffCommit.push(oid + ':' + f); return { file: f, oldText: 'old\n', newText: 'new\n', hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, rows: [{ type: 'del', aText: 'old', bText: '', aNum: 1, bNum: 0 }, { type: 'add', aText: '', bText: 'new', aNum: 0, bNum: 1 }] }] }; },
      commitFiles: async (d, oid) => { calls.commitFiles.push(oid); return { files: [{ file: 'README.md', status: 'modified' }, { file: 'data.csv', status: 'added' }] }; },
      branches: async () => ({ isRepo: true, branches: ['dev', 'main'], current: 'main' }),
      checkout: async (d, ref) => { calls.checkout.push(ref); return { ok: true }; },
      createBranch: async (d, name) => { calls.createBranch.push(name); return { ok: true }; },
      discard: async (d, f) => { calls.discard.push(f); return { ok: true }; },
      discardFiles: async (d, files) => { (calls.discardFiles = calls.discardFiles || []).push(files.slice()); return { ok: files.length, failed: [] }; },
      getUserConfig: async () => ({ name: 'tester', email: 't@example.com', isRepo: true }),
      setUserConfig: async (d, cfg) => { calls.setUserConfig.push(cfg); return { ok: true }; },
      // 远程 / 标签 / 还原 / 文件历史 / blame（PyCharm 式 Git 二期）
      listRemotes: async () => ({ remotes: [] }),
      addRemote: async () => ({ ok: true }),
      removeRemote: async () => ({ ok: true }),
      fetch: async () => ({ ok: true }),
      pull: async () => ({ ok: true }),
      push: async () => ({ ok: true }),
      listPushCommits: async () => ({
        ok: true, branch: 'main', first: false, count: 2,
        commits: [
          { oid: 'a'.repeat(40), short: 'aaaaaaa', message: 'first change', author: 'me', timestamp: Date.now() - 86400000 },
          { oid: 'b'.repeat(40), short: 'bbbbbbb', message: 'second change', author: 'me', timestamp: Date.now() },
        ],
      }),
      aheadBehind: async () => ({ ahead: 0, behind: 0 }),
      shelveCreate: async (d, cfg) => { calls.shelveCreate = cfg; return { ok: true, id: 'sv1', files: cfg.files.length }; },
      shelveList: async () => ({
        ok: true, shelves: [
          { id: 'sv0', name: '昨天的搁置', createdAt: Date.now() - 86400000, branch: 'main', files: [{ path: 'x.js', status: 'modified' }] },
        ],
      }),
      shelveApply: async () => ({ ok: true, files: 1 }),
      shelveDelete: async () => ({ ok: true }),
      listTags: async () => ({ tags: [] }),
      createTag: async () => ({ ok: true }),
      revert: async (d, oid) => { calls.revert = (calls.revert || []).concat(oid); return { ok: true, oid: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr' }; },
      logFile: async () => ({ commits: [] }),
      blame: async () => ({ lines: [] }),
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
  try {
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vendor', 'cm6-bundle.min.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'md-editor.js'), 'utf8'));
    evalFile('code-editor.js');
  } catch (e) { /* CM6 加载失败：viewer 内部有降级 */ }
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vendor', 'marked.min.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vendor', 'highlight.min.js'), 'utf8'));
  evalFile('plugin-loader.js');
  evalFile('pet.js');
  evalFile('tree.js');
  evalFile('viewer.js');
  evalFile('outline.js');
  evalFile('git-panel.js');
  evalFile('git-log.js');
  evalFile('quickopen.js');
  evalFile('search.js');
  evalFile('session.js');
  evalFile('shortcuts.js');
  evalFile('settings.js');
  evalFile('help.js');
  evalFile('browser.js');
  evalFile('db-panel.js');
  evalFile('app.js');
  await g(dom, 'App.init()'); // const 声明不在 window 上，用 eval 访问
  await g(dom, 'App.gitRefreshDelay = 0'); // 测试中禁用 Git 扫描延迟，保证断言即时可见
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

  await okAsync('★ 单击文件 → 打开文件，但不复制路径', async () => {
    const row = $$(dom, '.tree-row').find((r) => r.querySelector('.nm').title === P + '/README.md');
    assert_(row, '找到 README.md 行');
    const before = calls.copy.length;
    click(row);
    await tick(); await tick(); await tick();
    assert_(calls.copy.length === before, '单击不再自动复制路径');
    assert_($(dom, '.tab.active .tname'), '标签已打开');
  });

  await okAsync('Markdown 渲染 → .md-view 且标题/加粗/代码块生效', async () => {
    // md 默认 live（CM6），先切「◉ 预览」再断言渲染
    click($allIn($(dom, '.viewer-toolbar'), 'button').find((b) => b.textContent.includes('◉ 预览')));
    await tick();
    const md = $(dom, '.md-view');
    assert_(md, '存在 md-view');
    assert_(md.querySelector('h1') && md.querySelector('h1').textContent.includes('标题'), 'h1 渲染');
    assert_(md.querySelector('strong') && md.querySelector('strong').textContent === 'Markdown', '加粗渲染');
    assert_(md.querySelector('pre code'), '代码块渲染');
    // 切回实时预览，保持后续用例默认态
    click($allIn($(dom, '.viewer-toolbar'), 'button').find((b) => b.textContent.includes('实时预览')));
    await tick();
  });

  await okAsync('Markdown 默认实时预览（Obsidian 式 CM6）+ 模式切换', async () => {
    // md 现在默认「实时预览」：CM6 编辑器（标记粒度显示模型：仅紧邻标记显示源码）
    assert_($(dom, '.editor-cm-wrap'), 'md 打开即 CM6 实时预览容器');
    assert_($(dom, '.editor-cm-wrap .cm-editor'), 'CM 编辑器挂载');
    assert_($(dom, '.editor-cm-wrap .cm-content').textContent.includes('Markdown'), '编辑器含文档内容');
    // 直接编辑（CM6 内联编辑，无块切换）
    g(dom, 'Viewer.cm.setValue("# 改过的标题\\n\\n这是 **Markdown** 测试\\n")');
    await tick();
    assert_(g(dom, 'Viewer.activeTab.content').includes('改过的标题'), '编辑实时写入 tab.content');
    assert_(g(dom, 'Viewer.activeTab.dirty') === true, '编辑后标脏');
    // 切纯预览
    click($allIn($(dom, '.viewer-toolbar'), 'button').find((b) => b.textContent.includes('◉ 预览')));
    await tick();
    const md = $(dom, '.md-view');
    assert_(!$(dom, '.editor-cm-wrap'), '纯预览无实时预览容器');
    assert_(md && md.querySelector('h1') && md.querySelector('h1').textContent.includes('改过的标题'), '纯预览使用最新内容');
    // 预览里切回实时预览
    click($allIn($(dom, '.viewer-toolbar'), 'button').find((b) => b.textContent.includes('实时预览')));
    await tick();
    assert_($(dom, '.editor-cm-wrap'), '切回实时预览');
    assert_($(dom, '.editor-cm-wrap .cm-content').textContent.includes('改过的标题'), '切回后内容保留');
    // Ctrl+E ↔ 源码模式
    g(dom, 'Viewer.toggleMdMode()');
    await tick();
    assert_($(dom, '.editor-cm-wrap'), '源码模式同为 CM 容器');
    g(dom, 'Viewer.toggleMdMode()');
    await tick();
    assert_($(dom, '.editor-cm-wrap'), 'Ctrl+E 切回实时预览');
  });

  await okAsync('Live Preview 渲染细节：Obsidian 对齐（标记隐藏/空行保留/行级块渲染）', async () => {
    assert_($(dom, '.editor-cm-wrap'), 'CM 容器在');
    // 覆盖全元素文档（光标默认在第 1 行 → 第 1 行显示源码，其余行渲染）
    const LIVE_DOC = [
      '# 一级标题', '',
      '正文 ~~删除线~~ 与 [链接](https://a.b)', '',
      '- [ ] 待办', '',
      '- 无序列表项', '',
      '![alt文字](pic.png)', '',
      '```js', 'const a = 1;', '```', '',
      '| 表头 |', '| - |', '| 数据 |', '',
      '---', '',
      '==高亮文字== 与 \\*转义星号\\*', '',
      '结尾', '',
    ].join('\n');
    g(dom, 'Viewer.cm.setValue(' + JSON.stringify(LIVE_DOC) + ')');
    await tick(); await tick();
    const lines = [...$$(dom, '.cm-content > div')];
    const textOf = (i) => (lines[i] ? lines[i].textContent : null);
    // 1) 删除线标记隐藏（StrikethroughMark 曾被漏掉 → ~~ 一直显示）
    const paraLine = lines.find((l) => l.textContent.includes('删除线'));
    assert_(paraLine && paraLine.textContent.includes('删除线') && !paraLine.textContent.includes('~~'),
      '非光标行 ~~ 标记隐藏，got: ' + (paraLine ? JSON.stringify(paraLine.textContent) : 'null'));
    // 2) 链接 URL 隐藏
    assert_(paraLine && !paraLine.textContent.includes('https://'), '链接 URL 隐藏');
    // 3) 标题无前导空格（HeaderMark 连空格一起隐藏）
    const h2less = lines.filter((l) => l.textContent.includes('一级标题'));
    assert_(h2less.length >= 1, '标题行存在');
    // 光标在第 1 行（标题行本身）→ 显示 # 源码；断言第二处（无）改用表格后段落验证
    // 4) task checkbox：渲染为勾选框（widget），源码 [ ] 被替换
    const taskLine = lines.find((l) => l.textContent.includes('待办'));
    assert_(taskLine && $(dom, '.cm-md-task') !== null, 'task checkbox widget 渲染');
    assert_(taskLine && !taskLine.textContent.includes('[ ]'), 'task 源码标记隐藏');
    // 5) 围栏行 block replace 真移除（光标不在代码块内）+ 内容行背景类
    const contentText = $(dom, '.cm-content').textContent;
    assert_(!contentText.includes('```'), '围栏行 ``` 文本不显示（block replace 移除）');
    assert_($(dom, '.cm-md-fence-line') !== null, '代码内容行有背景类（fence-line）');
    // 6) 代码块后空行保留（行边界完整）
    const constIdx = lines.findIndex((l) => l.textContent.includes('const a = 1;'));
    assert_(constIdx >= 0 && lines.slice(constIdx + 1, constIdx + 3).some((l) => l && l.textContent.trim() === ''),
      '代码块后的空行保留在 DOM（行边界完整）');
    // 7) 表格逐行线框渲染（Obsidian 式行常渲染：光标进单元格不整块退化源码）
    assert_($(dom, '.cm-md-tr-head') !== null, '表头行线框渲染');
    assert_($(dom, '.cm-md-tr-row') !== null, '数据行线框渲染');
    const sepLine = $(dom, '.cm-md-tr-sep');
    assert_(sepLine !== null, '分隔行压缩为细线');
    assert_($(dom, '.cm-md-tpipe') !== null, '| 弱化 mark 渲染');
    const rowLine = [...$$(dom, '.cm-content > div')].find((l) => l.textContent.includes('数据'));
    assert_(rowLine && rowLine.textContent.includes('|'), '表格行常渲染（不退化为无样式源码，行内容保留）');
    // 8) 分隔线 ---：文本替换为 1px 线 widget（行高不变防点击偏移）
    assert_($(dom, '.cm-md-hr') !== null, '分隔线 widget 渲染（cm-md-hr）');
    assert_($(dom, '.cm-md-hr-line') !== null, '分隔线行级渲染（hr-line）');
    // 8b) 拼写检查关闭（红波浪下划线根因）
    assert_($(dom, '.cm-content') && $(dom, '.cm-content').getAttribute('spellcheck') === 'false', 'spellcheck 关闭');
    // 8c) 无序 bullet 圆点渲染（用户报告：无序列表没有渲染 / task 多渲染了 -）
    const liLine = lines.find((l) => l.textContent.includes('无序列表项'));
    assert_($(dom, '.cm-md-bullet') !== null, '无序 bullet 圆点 widget 渲染');
    assert_(liLine && !/-\s无序/.test(liLine.textContent) && liLine.textContent.includes('•'),
      '列表行源码 - 隐藏渲染为 •，got: ' + (liLine ? JSON.stringify(liLine.textContent) : 'null'));
    assert_(taskLine && !/-\s*\[/.test(taskLine.textContent),
      'task 行无源码 -（bullet 已替换），got: ' + (taskLine ? JSON.stringify(taskLine.textContent) : 'null'));
    // 8d) 图片 widget（用户报告：图片没有显示）
    const imgEl = $(dom, '.cm-md-img img');
    assert_(imgEl !== null, '图片 img widget 渲染');
    assert_(imgEl && (imgEl.getAttribute('src') || '').includes('pic.png'), '图片 src 解析相对路径');
    // 8e) 代码块复制按钮 + 语言标签（用户报告：代码块添加复制按钮）
    const copyBtn = $(dom, '.cm-md-copybtn');
    assert_(copyBtn !== null, '复制按钮 widget 渲染');
    assert_(copyBtn && copyBtn.querySelector('button') !== null, '复制按钮内含 button');
    assert_(copyBtn && (copyBtn.querySelector('.cm-md-copybtn-lang') || {}).textContent === 'js', '语言标签显示 js');
    // 9) 光标行显示源码：光标在第 1 行 → # 标记可见
    assert_(lines[0] && lines[0].textContent.includes('#'), '光标行（第 1 行）显示 # 源码标记');
    // 10) 标记粒度显示模型（Obsidian 式）：光标在行内但不紧邻标记 → 标记保持隐藏
    //    （旧行粒度模型：光标进该行整行闪源码 —— 多次修复失败的根因）
    g(dom, 'Viewer.cm.gotoLine(3)');
    await tick(); await tick();
    let lines2 = [...$$(dom, '.cm-content > div')];
    let para2 = lines2.find((l) => l.textContent.includes('删除线'));
    assert_(para2 && !para2.textContent.includes('~~'),
      '光标在行首（不紧邻 ~~）标记保持隐藏，got: ' + (para2 ? JSON.stringify(para2.textContent) : 'null'));
    // 光标离开第 1 行 → 标题标记隐藏
    const head2 = lines2.find((l) => l.textContent.includes('一级标题'));
    assert_(head2 && !head2.textContent.includes('#') && !head2.textContent.startsWith(' '),
      '光标离开后标题标记隐藏且无前导空格，got: ' + (head2 ? JSON.stringify(head2.textContent) : 'null'));
    // 15) ==高亮== 隐藏标记 + 转义 \* 显示字面量（Obsidian 扩展行为）
    const hlLine = lines2.find((l) => l.textContent.includes('高亮文字'));
    assert_(hlLine && !hlLine.textContent.includes('==') && hlLine.textContent.includes('*转义星号*') && !hlLine.textContent.includes('\\*'),
      '==高亮== 标记隐藏且转义 \\* 渲染为字面量，got: ' + (hlLine ? JSON.stringify(hlLine.textContent) : 'null'));
    // 11) 光标紧邻 ~~（内容首字符处）→ 该标记显形（Obsidian：贴着星号才出现）
    const markFrom = LIVE_DOC.indexOf('~~');
    g(dom, 'Viewer.cm.setCursor(' + (markFrom + 2) + ')');
    await tick(); await tick();
    lines2 = [...$$(dom, '.cm-content > div')];
    para2 = lines2.find((l) => l.textContent.includes('删除线'));
    assert_(para2 && para2.textContent.includes('~~'), '光标紧邻 ~~ 时标记显形（可编辑）');
    // 12) 光标移到内容中间（离开标记 1 字符）→ 标记重新隐藏
    g(dom, 'Viewer.cm.setCursor(' + (LIVE_DOC.indexOf('删除线') + 1) + ')');
    await tick(); await tick();
    lines2 = [...$$(dom, '.cm-content > div')];
    para2 = lines2.find((l) => l.textContent.includes('删除线'));
    assert_(para2 && !para2.textContent.includes('~~'), '光标移入内容中部 → 标记重新隐藏');
    // 13) 拖选跨行（选区覆盖多段）→ 全部保持渲染态（旧模型整段闪源码 = 闪烁根因）
    g(dom, 'Viewer.cm.setCursor(' + LIVE_DOC.indexOf('正文') + ', ' + (LIVE_DOC.indexOf('待办') + 2) + ')');
    await tick(); await tick();
    lines2 = [...$$(dom, '.cm-content > div')];
    para2 = lines2.find((l) => l.textContent.includes('删除线'));
    assert_(para2 && !para2.textContent.includes('~~'), '多行选择时 ~~ 保持隐藏（不闪源码）');
    assert_(!para2.textContent.includes('https://'), '多行选择时链接 URL 保持隐藏');
    assert_($(dom, '.cm-md-task') !== null, '多行选择时 task 勾选框保持渲染');
    // 14) 光标进入链接构造内部 → 完整源码显形（Obsidian 编辑链接行为）
    g(dom, 'Viewer.cm.setCursor(' + (LIVE_DOC.indexOf('链接') + 1) + ')');
    await tick(); await tick();
    lines2 = [...$$(dom, '.cm-content > div')];
    para2 = lines2.find((l) => l.textContent.includes('删除线'));
    assert_(para2 && para2.textContent.includes('[') && para2.textContent.includes('https://'),
      '光标进入链接内部 → 显示完整 [链接](url) 源码');
    // 15) 光标进表格单元格 → 行常渲染不退化源码（Obsidian 式逐行线框）；移出仍渲染
    g(dom, 'Viewer.cm.setCursor(' + (LIVE_DOC.indexOf('| 数据') + 2) + ')');
    await tick(); await tick();
    assert_($(dom, '.cm-md-tr-row') !== null && $(dom, '.cm-md-tpipe') !== null,
      '光标进表格单元格行仍线框渲染（不退化源码）');
    g(dom, 'Viewer.cm.setCursor(' + LIVE_DOC.length + ')');
    await tick(); await tick();
    assert_($(dom, '.cm-md-tr-head') !== null && $(dom, '.cm-md-tr-row') !== null, '光标移出表格保持渲染');
    // 16) 光标进代码块内容行 → 围栏显形（Obsidian：光标进块整块变源码态）
    g(dom, 'Viewer.cm.setCursor(' + (LIVE_DOC.indexOf('const a') + 2) + ')');
    await tick(); await tick();
    assert_($(dom, '.cm-content').textContent.includes('```'), '光标进代码块围栏显形');
    g(dom, 'Viewer.cm.setCursor(' + LIVE_DOC.length + ')');
    await tick(); await tick();
    assert_(!$(dom, '.cm-content').textContent.includes('```'), '光标移出代码块围栏隐藏');
    // 17) task 勾选框点击切换（用户报告：无法通过点击切换）—— 不进源码态直接改文档
    {
      const taskEl = $(dom, '.cm-md-task');
      assert_(taskEl !== null, 'task 勾选框存在（可点击）');
      if (taskEl) {
        const ME = dom.window.MouseEvent;
        taskEl.dispatchEvent(new ME('mousedown', { bubbles: true, cancelable: true }));
        taskEl.dispatchEvent(new ME('click', { bubbles: true, cancelable: true }));
        await tick(); await tick();
        assert_(g(dom, 'Viewer.cm.getValue()').includes('- [x] 待办'), '点击勾选框 [ ] → [x]');
        const taskEl2 = $(dom, '.cm-md-task');
        if (taskEl2) {
          taskEl2.dispatchEvent(new ME('mousedown', { bubbles: true, cancelable: true }));
          taskEl2.dispatchEvent(new ME('click', { bubbles: true, cancelable: true }));
          await tick(); await tick();
          assert_(g(dom, 'Viewer.cm.getValue()').includes('- [ ] 待办'), '再次点击 [x] → [ ]（切回）');
        }
      }
    }
    // 18) 表格新模型：行常渲染 → 单元格像普通文本一样直接编辑（无独立 widget）
    {
      const rowLine = [...$$(dom, '.cm-content > div')].find((l) => l.textContent.includes('| 数据'));
      assert_(rowLine !== null && String(rowLine.className).includes('cm-md-tr-row'),
        '数据行以行级渲染存在（直接编辑，无需点击 widget）');
    }
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

  await okAsync('Git 提交工具窗口：变更列表 + 分节 + 分支 + 状态栏', async () => {
    await g(dom, 'GitPanel.refresh()');
    await tick();
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    const body = $(dom, '#cd-files').textContent;
    assert_(body.includes('README.md'), '修改列表含 README.md');
    assert_(body.includes('未版本控制的文件'), '未版本控制分节存在');
    assert_($(dom, '#cd-branch').textContent.includes('main'), '分支显示 main');
    assert_(!$(dom, '#panel-git').classList.contains('hidden'), '提交面板可见（左侧停靠）');
    assert_($(dom, '#sb-branch').textContent.includes('4 处修改'), '状态栏显示修改数');
  });

  await okAsync('Push 预览：推送按钮 → 待推送提交清单 → 确认后推送', async () => {
    await g(dom, 'GitPanel.openCommit()');
    await tick();
    click($(dom, '#cd-push'));
    await tick(); await tick();
    const box = $(dom, '#pp-box');
    assert_(box, 'Push 预览弹窗出现');
    assert_(box.textContent.includes('2 个提交'), '弹窗显示待推送数量');
    assert_(box.textContent.includes('origin/main'), '显示目标 origin/分支');
    const rows = $allIn(box, '#pp-list > div');
    assert_(rows.length === 2, '列出 2 条提交, got ' + rows.length);
    assert_(rows[0].textContent.includes('first change') && rows[1].textContent.includes('second change'), '旧→新排序');
    click($(dom, '#pp-ok'));
    await tick(); await tick();
    assert_(!$(dom, '#pp-box'), '确认后弹窗关闭');
    await g(dom, 'GitPanel.closeDialog()');
  });

  await okAsync('Shelve 搁置：弹窗（文件勾选 + 已搁置列表）→ 搁置/恢复', async () => {
    await g(dom, 'GitPanel.openCommit()');
    await tick();
    click($(dom, '#cd-shelve'));
    await tick(); await tick(); await tick();
    const box = $(dom, '#sv-box');
    assert_(box, '搁置弹窗出现');
    // 上半：当前更改勾选列表（4 个改动文件）
    const checks = $allIn(box, '#sv-files input[type=checkbox]');
    assert_(checks.length === 4, '搁置区列出 4 个更改文件, got ' + checks.length);
    // 下半：已有搁置列表（mock 返回 1 条）
    assert_(box.textContent.includes('昨天的搁置'), '已搁置列表显示已有搁置');
    const applyBtn = $allIn(box, 'button').find((b) => b.textContent.includes('恢复'));
    assert_(applyBtn, '恢复按钮存在');
    // 填名称搁置 → shelveCreate 收到勾选文件
    $(dom, '#sv-name').value = '测试搁置';
    click($(dom, '#sv-create'));
    await tick(); await tick();
    assert_(calls.shelveCreate && calls.shelveCreate.name === '测试搁置', '搁置名称已传递');
    assert_(calls.shelveCreate.files.length === 4, '搁置全部勾选文件');
    assert_(!$(dom, '#sv-box'), '搁置后弹窗关闭');
    await g(dom, 'GitPanel.closeDialog()');
  });

  await okAsync('点击本地修改文件 → 编辑区 diff 预览', async () => {
    click($allIn($(dom, '#cd-files'), '.git-file').find((x) => x.textContent.includes('README.md')));
    await tick(); await tick();
    const table = $(dom, '#viewer .diff-wrap .diff-table');
    assert_(table, 'diff 表格出现');
    assert_($(dom, '.diff-table colgroup') && $allIn($(dom, '.diff-table'), 'col').length === 4, 'colgroup 定列宽（防行号列撑满回归）');
    assert_($allIn(table, 'td.del').some((td) => td.textContent === 'old line'), '左侧删除行');
    assert_($allIn(table, 'td.add').some((td) => td.textContent === 'new line'), '右侧新增行');
  });

  await okAsync('Ctrl+K → 提交工具窗口；勾选提交 → git.commit 收到消息', async () => {
    key(dom, 'k', { ctrl: true });
    await tick(); await tick();
    assert_($(dom, '#commit-msg'), '提交窗口打开（左侧面板）');
    assert_(!$(dom, '#panel-git').classList.contains('hidden'), '提交面板可见');
    assert_($allIn($(dom, '#commit-list'), '.cf-check').length === 4, '4 个文件复选框');
    $(dom, '#commit-msg').value = '测试提交信息';
    click($(dom, '#cm-ok'));
    await tick(); await tick();
    assert_(calls.commit.length >= 1, '调用了 git.commit');
    assert_(calls.commit[calls.commit.length - 1].message === '测试提交信息', '消息正确');
    assert_(calls.commit[calls.commit.length - 1].files.length === 4, '四个文件被提交（新文件默认勾选）');
    // 收尾：关闭 diff 视图并收起面板
    await g(dom, 'GitPanel.closeDiffView()');
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
    assert_($(dom, '#panel-git').classList.contains('hidden'), '面板收起');
  });

  await okAsync('Alt+9 → Git 日志窗口：SVG 提交图 + HEAD/分支徽标 + 过滤', async () => {
    key(dom, '9', { alt: true });
    await tick(); await tick();
    assert_(!$(dom, '#git-log-panel').classList.contains('hidden'), 'Alt+9 打开日志窗口');
    const rows = $allIn($(dom, '#gl-list'), '.gl-row');
    assert_(rows.length === 3, '3 行提交, got ' + rows.length);
    assert_($(dom, '#gl-list svg.gl-svg'), 'SVG 提交图存在');
    assert_($allIn($(dom, '#gl-list'), 'svg circle').length >= 4, '提交点 + HEAD 外圈存在');
    assert_($(dom, '.gl-row .gl-head'), 'HEAD 徽标存在');
    assert_($(dom, '.gl-row .gl-branch.cur'), '当前分支徽标（main）');
    assert_($(dom, '.gl-row .gl-branch:not(.cur)'), '其他分支徽标（dev）');
    // 消息过滤（过滤只隐藏行，图不动）
    const search = $(dom, '#gl-search');
    search.value = '分支';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    const visible = $allIn($(dom, '#gl-list'), '.gl-row').filter((el) => el.style.display !== 'none');
    assert_(visible.length === 1 && visible[0].textContent.includes('分支上的提交'), '过滤后只剩一条: ' + JSON.stringify(visible.map((v) => v.textContent)));
    search.value = '';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    // 作者过滤
    const author = $(dom, '#gl-author');
    author.value = 'nobody';
    author.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    assert_($allIn($(dom, '#gl-list'), '.gl-row').every((el) => el.style.display === 'none'), '作者不匹配全部隐藏');
    author.value = '';
    author.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
  });

  await okAsync('点击提交 → 右侧详情（文件列表 + diff，无弹窗）', async () => {
    click($allIn($(dom, '#gl-list'), '.gl-row').find((x) => x.textContent.includes('第二次提交')));
    await tick(); await tick();
    assert_(calls.commitFiles.length >= 1, '调用了 commitFiles');
    assert_($(dom, '#gl-right .gl-dhead'), '详情头部出现');
    assert_($(dom, '#gl-right .gl-dmsg').textContent.includes('第二次提交'), '详情显示提交信息');
    const files = $allIn($(dom, '#gl-right'), '.gl-dfile');
    assert_(files.length === 2, '2 个变更文件');
    assert_($(dom, '#viewer .diff-wrap .diff-table'), '主区默认渲染第一个文件的 diff（PyCharm 式）');
    assert_(calls.diffCommit.length >= 1, '调用了 diffCommit');
    assert_(calls.diffCommit[calls.diffCommit.length - 1].startsWith('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:'), '对比的是点击的提交');
    // 点击第二个文件切换 diff
    click(files[1]);
    await tick(); await tick();
    assert_(files[1].classList.contains('sel'), '选中切换到第二个文件');
    assert_(calls.diffCommit[calls.diffCommit.length - 1].endsWith(':data.csv'), 'diff 切换到 data.csv');
    // 关闭窗口（Shift+Esc），不干扰后续测试的键盘导航
    key(dom, 'Escape', { shift: true });
    await tick();
    assert_($(dom, '#git-log-panel').classList.contains('hidden'), 'Shift+Esc 关闭日志窗口');
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

  await okAsync('工具窗口切换：Ctrl+2 大纲 / Ctrl+1 项目（快捷键始终显示，不再收起）', async () => {
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
    assert_(display('#panel-project') !== 'none', 'Ctrl+1 已激活时仍保持显示（Bug8 修复）');
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
    // md 默认实时预览（CM6），点大纲 → live 模式就地滚动（不切换模式）
    assert_($(dom, '.editor-cm-wrap'), '实时预览容器存在');
    click(items[0]);
    await tick();
    assert_($(dom, '.editor-cm-wrap'), 'live 模式点击大纲不切换模式');
  });

  await okAsync('大纲解析：代码块内的 # 行不算标题（跳转错位根因）', async () => {
    const md = '# 真标题\n\n```bash\n# 这是注释不是标题\n```\n\n## 第二个\n';
    const hs = g(dom, 'JSON.stringify(Outline.parse(' + JSON.stringify(md) + ').map(h => h.text))');
    const arr = JSON.parse(hs);
    assert_(arr.length === 2 && arr[0] === '真标题' && arr[1] === '第二个', '只解析真标题: ' + hs);
  });

  await okAsync('HTML 预览：base 注入相对路径解析 + 按键转发脚本在末尾（不破坏 DOCTYPE）', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/page.html")');
    await tick(); await tick();
    const frame = $(dom, 'iframe.html-frame');
    assert_(frame, 'iframe 存在');
    const doc = frame.getAttribute('srcdoc') || '';
    assert_(doc.includes('<base href="file:///'), '注入 base href（相对路径 CSS 可解析）');
    const dIdx = doc.toLowerCase().indexOf('<!doctype');
    const fIdx = doc.indexOf('__myideKey');
    // 转发脚本必须在 DOCTYPE 之后（开头会挤掉 DOCTYPE 显示「OCTYPE html>」）
    assert_(dIdx < 0 || fIdx > dIdx, '转发脚本位于 DOCTYPE 之后');
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

  await okAsync('Ctrl+K 连续打开两次提交对话框不崩（回归）', async () => {
    key(dom, 'k', { ctrl: true });
    await tick(); await tick();
    assert_($(dom, '#commit-msg'), '第一次提交窗口');
    key(dom, 'k', { ctrl: true });
    await tick(); await tick();
    assert_($(dom, '#commit-msg'), '第二次提交窗口（幂等，不重复构建）');
    // 收尾：关闭提交对话框
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
  });

  await okAsync('会话记忆：标签页 + 活动标签 + 工具窗口恢复', async () => {
    dom.window.localStorage.clear(); // 清掉旧会话，避免 setRoot 的 restore 干扰
    // 先把历史测试遗留的 dirty 标签保存，避免 closeTab 弹确认框
    for (let i = 0; i < g(dom, 'Viewer.openTabs.length'); i++) {
      if (g(dom, 'Viewer.openTabs[' + i + '].dirty')) await g(dom, 'Viewer.saveTab(' + i + ')');
    }
    await tick();
    // 准备会话：打开两个文件，切到大纲工具窗口（git 提交是对话框，不再占工具位）
    await g(dom, 'App.setRoot("' + P + '")');
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await g(dom, 'App.showTool("outline")'); // showTool 语义：始终显示（switchTool 在已激活时会收起）
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
    assert_(!$(dom, '#panel-outline').classList.contains('hidden'), '大纲工具窗口恢复');
    await g(dom, 'App.switchTool("project")');
    await tick();
  });

  await okAsync('会话记忆：dirty 标签不写入保存', async () => {
    // 打开文件并弄脏（md 默认实时预览 CM6，直接编辑）
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await tick(); await tick();
    assert_($(dom, '.editor-cm-wrap'), '实时预览容器存在');
    g(dom, 'Viewer.cm.setValue("dirty content")');
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

  await okAsync('主题切换：默认深色 → 浅色 → 粉红 → 深红 → 回深色', async () => {
    assert_(!$(dom, 'body').classList.contains('theme-light') && !$(dom, 'body').classList.contains('theme-pink') && !$(dom, 'body').classList.contains('theme-crimson'), '默认深色');
    g(dom, 'Theme.toggle()');
    await tick();
    assert_($(dom, 'body').classList.contains('theme-light'), '切换后为浅色');
    assert_(dom.window.localStorage.getItem('myide-theme') === 'light', 'localStorage 已记录');
    key(dom, 'T', { ctrl: true, shift: true }); // 浅色 → 粉红（四主题循环）
    await tick();
    assert_($(dom, 'body').classList.contains('theme-pink'), '快捷键切到粉红');
    assert_(dom.window.localStorage.getItem('myide-theme') === 'pink', 'localStorage 更新为 pink');
    g(dom, 'Theme.toggle()'); // 粉红 → 深红
    await tick();
    assert_($(dom, 'body').classList.contains('theme-crimson'), '切到深红');
    assert_(dom.window.localStorage.getItem('myide-theme') === 'crimson', 'localStorage 更新为 crimson');
    g(dom, 'Theme.toggle()'); // 深红 → 深色
    await tick();
    assert_(!$(dom, 'body').classList.contains('theme-light') && !$(dom, 'body').classList.contains('theme-pink') && !$(dom, 'body').classList.contains('theme-crimson'), '回到深色');
    assert_(dom.window.localStorage.getItem('myide-theme') === 'dark', 'localStorage 更新');
  });

  await okAsync('diff hunk 折叠：点击切换展开/收起', async () => {
    // 打开提交面板并点击本地修改行（fake 数据 2 个 hunk，diff 渲染在编辑区）
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    click($allIn($(dom, '#cd-files'), '.git-file').find((x) => x.textContent.includes('README.md')));
    await tick(); await tick();
    const sep = $(dom, '#viewer .diff-wrap .diff-hunk-gap');
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
    await g(dom, 'GitPanel.closeDiffView()');
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
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

  await okAsync('状态栏：行数/分支/行列号（路径已移除）', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    let sb = $(dom, '#statusbar').textContent;
    assert_(!sb.includes('notes.txt'), '状态栏不含文件路径, got: ' + sb);
    assert_(sb.includes('2 行'), '状态栏含行数, got: ' + sb);
    assert_(sb.includes('main'), '状态栏含分支, got: ' + sb);
    // 光标行列（CM6：setCursor 触发 onCursor → 状态栏）
    g(dom, 'Viewer.cm.setCursor(3)');
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

  await okAsync('状态栏不再显示版本号（已移除）', async () => {
    await tick(); await tick();
    assert_(!$(dom, '#sb-version'), '版本号元素已移除');
    assert_(!$(dom, '#statusbar').textContent.includes('0.2.0'), '状态栏无版本文本');
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

  await okAsync('文件复制粘贴：Ctrl+C / Ctrl+V + 重名弹确认框', async () => {

    // 清除可能残留的输入框焦点（jsdom 的 blur() 无效，改用 body.focus()）
    dom.window.document.body.focus();
    await tick();
    // 点选 README.md
    click($allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/README.md'));
    await tick();
    key(dom, 'c', { ctrl: true });
    await tick();
    assert_(fakeCopied.length === 1 && fakeCopied[0] === P + '/README.md', 'Ctrl+C 记录文件');
    // 选中 src 目录 → Ctrl+V 粘贴到该目录（无冲突直接粘贴）
    click($allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src'));
    await tick();
    key(dom, 'v', { ctrl: true });
    await tick(); await tick();
    assert_(FAKE_FS[P + '/src/README.md'], '副本出现在 src 目录');
    // 再次粘贴（选中态保持）→ 重名弹确认框（不再静默自动改名）
    key(dom, 'v', { ctrl: true });
    await tick(); await tick();
    const mask = $(dom, '#modal-mask');
    assert_(!mask.classList.contains('hidden'), '重名粘贴弹出确认框');
    assert_(mask.textContent.includes('同名') && mask.textContent.includes('README.md'), '确认框提示冲突文件名');
    // 点「确定」→ 覆盖（仍只有一份，无 (1) 副本）
    click($allIn(mask, 'button').find((b) => b.textContent.includes('确定')));
    await tick(); await tick();
    assert_(FAKE_FS[P + '/src/README.md'], '覆盖后文件存在');
    assert_(!FAKE_FS[P + '/src/README (1).md'], '不再自动改名');
    // 第三次粘贴 → 确认框点「取消」→ 不粘贴
    key(dom, 'v', { ctrl: true });
    await tick(); await tick();
    assert_(!$(dom, '#modal-mask').classList.contains('hidden'), '再次弹出确认框');
    click($allIn($(dom, '#modal-mask'), 'button').find((b) => b.textContent.includes('取消')));
    await tick(); await tick();
    assert_($(dom, '#modal-mask').classList.contains('hidden'), '取消后确认框关闭');
    // 选中文件时粘贴 → 粘贴到其所在目录（点 src 下子文件 app.js，目标 = src）
    click($allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src/app.js'));
    await tick();
    key(dom, 'v', { ctrl: true });
    await tick(); await tick();
    // src/README.md 重名 → 确认覆盖
    assert_(!$(dom, '#modal-mask').classList.contains('hidden'), '选中文件粘贴同样弹确认框');
    click($allIn($(dom, '#modal-mask'), 'button').find((b) => b.textContent.includes('确定')));
    await tick(); await tick();
    assert_(FAKE_FS[P + '/src/README.md'], '选中文件时粘贴到所在目录（覆盖成功）');
  });

  await okAsync('代码编辑器聚焦时 Ctrl+C 不触发文件复制', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    // 代码文件现为 CM6 编辑器（contenteditable 豁免）
    g(dom, 'document.querySelector(".cm-content").setAttribute("contenteditable","true")');
    g(dom, 'document.querySelector(".cm-content").focus()');
    await tick();
    const before = fakeCopied.length;
    key(dom, 'c', { ctrl: true });
    await tick();
    assert_(fakeCopied.length === before, '代码编辑器中 Ctrl+C 未触发文件复制');
  });

  await okAsync('CM6 编辑器内 Ctrl+C 不触发文件复制（contenteditable 豁免）', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await tick(); await tick();
    g(dom, 'document.querySelector(".cm-content").setAttribute("contenteditable","true")');
    g(dom, 'document.querySelector(".cm-content").focus()');
    await tick();
    const before = fakeCopied.length;
    key(dom, 'c', { ctrl: true });
    await tick();
    assert_(fakeCopied.length === before, 'CM6 编辑器中 Ctrl+C 未触发文件复制');
  });

  await okAsync('剪切粘贴：Ctrl+X 后 Ctrl+V 移动文件（源被移走）', async () => {
    dom.window.document.body.focus();
    await tick();
    // 选中 src/README.md（由复制测试创建）→ Ctrl+X
    click($allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src/README.md'));
    await tick();
    key(dom, 'x', { ctrl: true });
    await tick();
    assert_(fakeCopied.length === 1 && fakeCopied[0] === P + '/src/README.md', 'Ctrl+X 记录文件');
    // 选中根目录行 → Ctrl+V 粘贴到根目录 = 移动
    click($allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P));
    await tick();
    key(dom, 'v', { ctrl: true });
    await tick(); await tick();
    assert_(FAKE_FS[P + '/README (1).md'], '文件移动到根目录（重名递增）');
    assert_(!FAKE_FS[P + '/src/README.md'], '源位置已被移走');
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

  await okAsync('多选复制粘贴：Ctrl+点击多文件 → Ctrl+C → Ctrl+V 全部粘贴', async () => {
    dom.window.document.body.focus();
    await tick();
    const ctrlClick = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    // 先普通点击 README.md 重置为单选（清掉上一用例残留的目录选中）
    click($allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/README.md'));
    await tick();
    // Ctrl+点击 notes.txt 加入多选（Ctrl+点击文件行不打开文件）
    ctrlClick($allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/notes.txt'));
    await tick();
    key(dom, 'c', { ctrl: true });
    await tick();
    assert_(fakeCopied.length === 2, 'Ctrl+C 记录 2 个文件, got: ' + JSON.stringify(fakeCopied));
    // 选中 src → Ctrl+V 粘贴全部
    click($allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src'));
    await tick();
    key(dom, 'v', { ctrl: true });
    await tick(); await tick(); await tick();
    assert_(FAKE_FS[P + '/src/README.md'], '第一个文件粘贴成功');
    assert_(FAKE_FS[P + '/src/notes.txt'], '第二个文件也粘贴成功（多文件粘贴）');
    // 清理：删除粘贴出的 notes.txt 副本（后续「拖拽移动+撤销」用例依赖 src 下无 notes.txt）
    delete FAKE_FS[P + '/src/notes.txt'];
    if (FAKE_FS[P + '/src']) FAKE_FS[P + '/src'].children = FAKE_FS[P + '/src'].children.filter((c) => c !== P + '/src/notes.txt');
    // 恢复单选（多选残留会让后续右键菜单显示「（3 项）」）
    click($allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/notes.txt'));
    await tick();
  });

  await okAsync('资源管理器拖入：drop 多文件复制到目录（含同名确认）', async () => {
    // 模拟 Chromium drop：dataTransfer.files 带 path 的完整列表 + types 含 'Files'
    const mkFile = (p) => ({ path: p, name: p.split('/').pop() });
    const mkDrop = (files) => {
      const ev = new dom.window.Event('drop', { bubbles: true, cancelable: true });
      ev.dataTransfer = { files, types: ['Files'], getData: () => '', setData: () => {} };
      return ev;
    };
    // 拖到 src 目录行 → 复制进去（多文件完整列表）
    const srcRow = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src');
    srcRow.dispatchEvent(mkDrop([mkFile('C:/external/drag-a.txt'), mkFile('C:/external/drag-b.txt')]));
    await tick(); await tick(); await tick();
    assert_(FAKE_FS[P + '/src/drag-a.txt'], '拖入文件 A 复制成功');
    assert_(FAKE_FS[P + '/src/drag-b.txt'], '拖入文件 B 复制成功（多文件拖入不再只进一个）');
    // 再拖入同名 drag-a.txt → 弹确认框 → 取消 → 不覆盖
    srcRow.dispatchEvent(mkDrop([mkFile('C:/external/drag-a.txt')]));
    await tick(); await tick();
    assert_(!$(dom, '#modal-mask').classList.contains('hidden'), '同名拖入弹确认框');
    assert_($(dom, '#modal-mask').textContent.includes('drag-a.txt'), '确认框列出冲突文件');
    click($allIn($(dom, '#modal-mask'), 'button').find((b) => b.textContent.includes('取消')));
    await tick(); await tick();
    assert_($(dom, '#modal-mask').classList.contains('hidden'), '取消后关闭');
    // 树空白处 drop（根目录目标；真实流程 dragover 先于 drop 反复触发，mock 需先发 dragover 置位）
    const mkOver = (files) => {
      const ev = new dom.window.Event('dragover', { bubbles: true, cancelable: true });
      ev.dataTransfer = { files, types: ['Files'], getData: () => '', setData: () => {}, dropEffect: '' };
      return ev;
    };
    $(dom, '#tree').dispatchEvent(mkOver([mkFile('C:/external/drag-root.txt')]));
    $(dom, '#tree').dispatchEvent(mkDrop([mkFile('C:/external/drag-root.txt')]));
    await tick(); await tick(); await tick();
    assert_(FAKE_FS[P + '/drag-root.txt'], '拖到树空白处 = 复制到根目录');
    // 清理：删掉拖入的副本，不影响后续用例（含父目录 children 引用，防悬空路径渲染崩树）
    for (const f of [P + '/src/drag-a.txt', P + '/src/drag-b.txt', P + '/drag-root.txt']) {
      delete FAKE_FS[f];
      const parent = f.slice(0, f.lastIndexOf('/'));
      if (FAKE_FS[parent] && FAKE_FS[parent].children) {
        FAKE_FS[parent].children = FAKE_FS[parent].children.filter((c) => c !== f);
      }
    }
  });

  await okAsync('拖到文件行 = 移入其所在目录（文件夹下方也能放进去）', async () => {
    const mkDrag = (type, path) => {
      const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
      ev.dataTransfer = { getData: () => path, setData: () => {}, effectAllowed: '', dropEffect: '' };
      return ev;
    };
    // 确保目录链展开并渲染出 app.js 行
    await g(dom, 'Tree.reveal("' + P + '/src/app.js")');
    await tick(); await tick();
    // 拖 data.csv 到 src/app.js（文件行）→ 应移入 app.js 所在目录 src
    const fileRow = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src/app.js');
    assert_(fileRow, 'src/app.js 行存在（目录链已展开）');
    fileRow.dispatchEvent(mkDrag('dragover', P + '/data.csv'));
    await tick();
    assert_(fileRow.classList.contains('drop-target'), '文件行悬停高亮');
    fileRow.dispatchEvent(mkDrag('drop', P + '/data.csv'));
    await tick(); await tick();
    assert_(FAKE_FS[P + '/src/data.csv'], '文件移入文件行所在目录 src');
    assert_(!FAKE_FS[P + '/data.csv'], '源位置已被移走');
    // 还原 data.csv 到根目录（后续用例仍依赖根目录下的 data.csv）
    delete FAKE_FS[P + '/src/data.csv'];
    if (FAKE_FS[P + '/src']) FAKE_FS[P + '/src'].children = FAKE_FS[P + '/src'].children.filter((c) => c !== P + '/src/data.csv');
    FAKE_FS[P + '/data.csv'] = { type: 'file', content: '名称,数量\n苹果,3\n香蕉,5\n', mtime: 5000, ctime: 1000, size: 40 };
    if (FAKE_FS[P] && !FAKE_FS[P].children.includes(P + '/data.csv')) FAKE_FS[P].children.push(P + '/data.csv');
  });

  await okAsync('目录树排序：名称 / 修改时间 / 创建时间 / 大小（目录恒在前）', async () => {
    // 清理前面用例的临时产物（剪切测试的 README (1).md），保证断言的固定项集
    delete FAKE_FS[P + '/README (1).md'];
    if (FAKE_FS[P]) FAKE_FS[P].children = FAKE_FS[P].children.filter((c) => c !== P + '/README (1).md');
    const names = () => $allIn($(dom, '#tree'), '.tree-row')
      .filter((r) => r.dataset.depth === '1')
      .map((r) => r.querySelector('.nm').title.split('/').pop());
    // 按修改时间（新→旧）：data.csv(5000) > README(2000) > notes(1000)；首个 setSortMode 同时失效旧缓存
    await g(dom, 'Tree.setSortMode("mtime")');
    await tick(); await tick();
    let n = names();
    assert_(n[0] === 'src' && n[1] === 'data.csv' && n[2] === 'README.md' && n[3] === 'notes.txt',
      '修改时间新→旧，got ' + JSON.stringify(n));
    // 按创建时间（新→旧）：notes(9000) > README(3000) > data.csv(1000)
    await g(dom, 'Tree.setSortMode("ctime")');
    await tick(); await tick();
    n = names();
    assert_(n[0] === 'src' && n[1] === 'notes.txt' && n[2] === 'README.md' && n[3] === 'data.csv',
      '创建时间新→旧，got ' + JSON.stringify(n));
    // 按大小（大→小）：README(60) > data.csv(40) > notes(12)
    await g(dom, 'Tree.setSortMode("size")');
    await tick(); await tick();
    n = names();
    assert_(n[0] === 'src' && n[1] === 'README.md' && n[2] === 'data.csv' && n[3] === 'notes.txt',
      '大小大→小，got ' + JSON.stringify(n));
    // 持久化：localStorage 写入
    assert_(g(dom, 'localStorage.getItem("myide-tree-sort")') === 'size', '排序模式持久化到 localStorage');
    // 排序按钮存在且高亮（非默认模式）
    const sb = $(dom, '#tree-sort');
    assert_(sb !== null, '排序按钮存在');
    assert_(sb && sb.classList.contains('active'), '非默认模式按钮高亮');
    // 还原默认名称序（后续用例依赖）：src(目录) 在前，文件按字节序（大写在前）
    await g(dom, 'Tree.setSortMode("name")');
    await tick(); await tick();
    n = names();
    assert_(n[0] === 'src' && n[1] === 'README.md' && n[2] === 'data.csv' && n[3] === 'notes.txt',
      '名称序 A→Z（目录优先，大写字节序在前），got ' + JSON.stringify(n));
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

  await okAsync('右键运行 exe：exe 有「运行」项并调用 runFile，txt 无', async () => {
    // 展开 src 令 demo.exe 行可见
    await g(dom, 'Tree.reveal("' + P + '/src/demo.exe")');
    await tick();
    const menu = $(dom, '#ctx-menu');
    const openMenuOn = async (p) => {
      const row = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === p);
      row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await tick();
      return $allIn(menu, '.ctx-item').map((x) => x.textContent);
    };
    // exe：菜单含「▶ 运行」，点击 → runFile 收到完整路径
    const items = await openMenuOn(P + '/src/demo.exe');
    assert_(items.includes('▶ 运行'), 'exe 右键菜单含「运行」, got: ' + JSON.stringify(items));
    click($allIn(menu, '.ctx-item').find((x) => x.textContent === '▶ 运行'));
    await tick(); await tick();
    assert_((calls.runFile || []).includes(P + '/src/demo.exe'), 'runFile 收到 exe 路径, got: ' + JSON.stringify(calls.runFile));
    // 负例：txt 不出现「运行」
    const items2 = await openMenuOn(P + '/notes.txt');
    assert_(!items2.includes('▶ 运行'), 'txt 右键菜单无「运行」项, got: ' + JSON.stringify(items2));
  });

  await okAsync('多项目：项目栏按钮 + 点击切换', async () => {
    await g(dom, 'App.openProject("C:/proj2")');
    await tick(); await tick();
    let btns = $allIn($(dom, '#project-bar'), '.proj-btn');
    assert_(btns.length >= 2, '项目栏出现多个按钮, got ' + btns.length);
    assert_($(dom, '.root-path').textContent.includes('C:/proj2'), '当前是项目二');
    // 点击切换到项目一
    click($allIn($(dom, '#project-bar'), '.proj-btn').find((b) => b.textContent.includes('proj') && b.title === P));
    await tick(); await tick();
    assert_($(dom, '.root-path').textContent.includes('C:/proj'), '切换回项目一');
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
    assert_($(dom, '.root-path').textContent.includes('C:/proj'), '已切到项目一');
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await tick(); await tick();
    await new Promise((r) => setTimeout(r, 500)); // 防抖保存
    // 切回项目二 → 应恢复 other.md（项目二自己的会话）
    click($allIn($(dom, '#project-bar'), '.proj-btn').find((b) => b.title === 'C:/proj2'));
    await tick(); await tick();
    const tabs = g(dom, 'Viewer.openTabs.map(t => t.name)');
    assert_(tabs.includes('other.md'), '项目二恢复自己的标签: ' + JSON.stringify(tabs));
  });

  await okAsync('多项目：右键弹菜单关闭项目（右键不误删 + 其余保留）', async () => {
    // 当前是项目二：右键项目二按钮 → 应弹菜单而非直接移除（旧实现右键即删，误触把项目删光）
    const btn = $allIn($(dom, '#project-bar'), '.proj-btn').find((b) => b.title === 'C:/proj2');
    btn.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    const menu = $(dom, '#ctx-menu');
    assert_(!menu.classList.contains('hidden'), '右键弹出菜单（不再直接移除）');
    assert_($allIn($(dom, '#project-bar'), '.proj-btn').some((b) => b.title === 'C:/proj2'), '右键未直接移除项目');
    const close = $allIn(menu, '.ctx-item').find((x) => x.textContent.includes('关闭项目'));
    assert_(close, '菜单含「关闭项目」项');
    click(close);
    await tick(); await tick(); await tick();
    // 关掉的是当前项目 → 自动切到剩余项目一；关闭一个其余不消失
    assert_($(dom, '.root-path').textContent.includes('C:/proj'), '自动切换到剩余项目一');
    assert_($allIn($(dom, '#project-bar'), '.proj-btn').some((b) => b.title === P), '剩余项目按钮保留（不全消失）');
    assert_(!$allIn($(dom, '#project-bar'), '.proj-btn').some((b) => b.title === 'C:/proj2'), '被关项目已移除');
  });

  await okAsync('多项目：拖拽排序持久化（dragend 固化，切换后不弹回）', async () => {
    await g(dom, 'App.openProject("C:/proj2")');
    await tick(); await tick();
    const bar = $(dom, '#project-bar');
    let btns = $allIn(bar, '.proj-btn');
    assert_(btns.length === 2, '两个项目按钮, got ' + btns.length);
    // 记录初始顺序（localStorage）
    const before = JSON.parse(dom.window.localStorage.getItem('myide-projects')).map((p) => p.path);
    // 把第一个按钮拖到第二个按钮之后：dragstart → dragover → dragend（不触发 drop，模拟拖到空白释放）
    const dt = { setData: () => {}, effectAllowed: 'move' };
    const ds = new dom.window.MouseEvent('dragstart', { bubbles: true, cancelable: true });
    ds.dataTransfer = dt;
    btns[0].dispatchEvent(ds);
    const dov = new dom.window.MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: 500 });
    dov.dataTransfer = dt;
    btns[1].dispatchEvent(dov);
    const de = new dom.window.MouseEvent('dragend', { bubbles: true, cancelable: true });
    btns[0].dispatchEvent(de);
    await tick(); await tick();
    // DOM 已重排 + localStorage 已固化
    btns = $allIn(bar, '.proj-btn');
    const afterDom = btns.map((b) => b.title);
    const afterSaved = JSON.parse(dom.window.localStorage.getItem('myide-projects')).map((p) => p.path);
    assert_(JSON.stringify(afterDom) === JSON.stringify(afterSaved), 'DOM 顺序与存储一致: ' + JSON.stringify({ afterDom, afterSaved }));
    assert_(JSON.stringify(afterSaved) !== JSON.stringify(before), '顺序已变化（拖拽生效）');
    // 切换项目（多次 renderProjectBar）后顺序不弹回
    await g(dom, 'App.openProject("' + P + '")');
    await tick(); await tick();
    const finalOrder = $allIn($(dom, '#project-bar'), '.proj-btn').map((b) => b.title);
    assert_(JSON.stringify(finalOrder) === JSON.stringify(afterSaved), '切换后顺序保持不弹回: ' + JSON.stringify(finalOrder));
    // 恢复初始顺序（P 在前），避免影响后续「全部项目」/「溢出」测试的项目状态
    const dt2 = { setData: () => {}, effectAllowed: 'move' };
    const b2 = $allIn($(dom, '#project-bar'), '.proj-btn');
    const ds2 = new dom.window.MouseEvent('dragstart', { bubbles: true, cancelable: true });
    ds2.dataTransfer = dt2;
    b2[0].dispatchEvent(ds2);
    const dov2 = new dom.window.MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: 500 });
    dov2.dataTransfer = dt2;
    b2[1].dispatchEvent(dov2);
    const de2 = new dom.window.MouseEvent('dragend', { bubbles: true, cancelable: true });
    b2[0].dispatchEvent(de2);
    await tick(); await tick();
  });

  await okAsync('玩宠：左键卖萌不弹菜单，右键弹菜单', async () => {
    const pet = $(dom, '#pet');
    assert_(pet, '玩宠存在');
    const menu = $(dom, '#ctx-menu');
    // 先确保菜单关闭；清空 toast（上限 5 条，不清空计数会被截断）
    dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    $(dom, '#toast-wrap').innerHTML = '';
    click(pet); // 左键 = 卖萌
    await tick();
    assert_(menu.classList.contains('hidden'), '左键不弹菜单');
    const toasts = $allIn($(dom, '#toast-wrap'), '.toast');
    assert_(toasts.length >= 1, '左键触发挥手说话（toast）');
    // 右键 = 菜单
    pet.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    assert_(!menu.classList.contains('hidden'), '右键弹出菜单');
    assert_($allIn(menu, '.ctx-item').some((x) => x.textContent.includes('退出玩偶')), '菜单含退出项');
    assert_($allIn(menu, '.ctx-item').some((x) => x.textContent.includes('橘猫')), '菜单含切换玩偶项');
    dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
  });

  await okAsync('目录树右键：在命令行中打开（目录用自身，文件用所在目录）', async () => {
    // 右键项目根目录（目录行）
    const dirRow = $allIn($(dom, '#tree'), '.tree-row').find((r) => (r.querySelector('.nm') || {}).title.endsWith('src'));
    assert_(dirRow, '找到 src 目录行');
    dirRow.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    const menu = $(dom, '#ctx-menu');
    const termItem = $allIn(menu, '.ctx-item').find((x) => x.textContent.includes('命令行'));
    assert_(termItem, '菜单含「在命令行中打开」项');
    calls.openTerminal = [];
    click(termItem);
    await tick();
    assert_(JSON.stringify(calls.openTerminal) === JSON.stringify([P + '/src']), '目录 → 命令行打开其自身, got ' + JSON.stringify(calls.openTerminal));
    // 右键文件行（根目录的 README.md，精确匹配 —— src/README.md 也是合法文件）→ 打开其所在目录
    const fileRow = $allIn($(dom, '#tree'), '.tree-row').find((r) => (r.querySelector('.nm') || {}).title === P + '/README.md');
    fileRow.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    const termItem2 = $allIn(menu, '.ctx-item').find((x) => x.textContent.includes('命令行'));
    click(termItem2);
    await tick();
    assert_(calls.openTerminal.length === 2 && calls.openTerminal[1] === P, '文件 → 命令行打开所在目录, got ' + JSON.stringify(calls.openTerminal));
  });

  await okAsync('「全部项目」入口：no-drag 可点击 + 下拉切换项目', async () => {
    const all = $(dom, '.proj-all');
    assert_(all, '「全部项目」按钮存在');
    // 曾因不在 no-drag 白名单被窗口拖拽区拦截 → 点击无反应
    //（jsdom 的 getComputedStyle 不解析 -webkit-app-region → 直接校验样式表规则）
    const cssText = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
    const ndRules = cssText.match(/[^{}]+\{[^}]*-webkit-app-region:\s*no-drag[^}]*\}/g) || [];
    assert_(ndRules.some((r) => r.includes('.proj-all')), '「全部项目」在 no-drag 白名单（点击不被拖拽区拦截）');
    click(all);
    await tick();
    const menu = $(dom, '#ctx-menu');
    assert_(!menu.classList.contains('hidden'), '点击弹出全部项目下拉');
    const item = $allIn(menu, '.ctx-item').find((x) => x.textContent.includes('proj'));
    assert_(item, '下拉含项目项');
    click(item);
    await tick(); await tick(); await tick();
    assert_($(dom, '.root-path').textContent.includes('C:/proj'), '下拉点击切换项目');
  });

  await okAsync('项目栏溢出：滚轮横向滚动 + 当前项目自动滚入可视区', async () => {
    const bar = $(dom, '#project-bar');
    assert_(bar, '项目栏存在');
    // 模拟横向溢出（jsdom 无布局，手动注入 scrollWidth/clientWidth）
    Object.defineProperty(bar, 'scrollWidth', { configurable: true, value: 800 });
    Object.defineProperty(bar, 'clientWidth', { configurable: true, value: 300 });
    bar.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 120, cancelable: true }));
    assert_(bar.scrollLeft === 120, '垂直滚轮转横向滚动（末尾项目可达）, got ' + bar.scrollLeft);
    bar.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -60, cancelable: true }));
    assert_(bar.scrollLeft === 60, '反向滚动回退, got ' + bar.scrollLeft);
    // 新开项目按钮在末尾：渲染后自动滚入可视区（此前被截断看不到、点不到 ✕）
    const proto = dom.window.HTMLElement.prototype;
    const origSI = proto.scrollIntoView;
    let siOpts = null;
    proto.scrollIntoView = function (o) { siOpts = o; };
    await g(dom, 'App.openProject("C:/proj2")');
    await tick(); await tick();
    if (origSI) proto.scrollIntoView = origSI; else delete proto.scrollIntoView;
    assert_(siOpts && siOpts.inline === 'nearest', '当前项目按钮 scrollIntoView(inline nearest)');
    // 清理：切回项目一
    await g(dom, 'App.openProject("' + P + '")');
    await tick(); await tick();
  });

  await okAsync('Git 刷新防抖：连续保存只刷一次', async () => {
    dom.window.__rc = 0;
    g(dom, 'window.__origGitRefresh = GitPanel.refresh');
    g(dom, 'GitPanel.refresh = () => { window.__rc++; return Promise.resolve(); }');
    // 准备一个 dirty 标签（保存按钮已移除 → 直接调用 saveTab）
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    await g(dom, 'Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
    await tick();
    await g(dom, 'Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
    await tick();
    assert_(dom.window.__rc === 0, '防抖窗口内未立即刷新');
    await new Promise((r) => setTimeout(r, 700));
    assert_(dom.window.__rc === 1, '防抖合并为一次刷新, got ' + dom.window.__rc);
    // 恢复原 refresh，避免污染后续测试（Bug6 依赖真实 refresh 着色文件树）
    g(dom, 'GitPanel.refresh = window.__origGitRefresh');
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
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    const branchBtn = $(dom, '#cd-branch');
    assert_(branchBtn, '分支入口存在（对话框头部）');
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
    assert_(!$(dom, '#br-box'), '分支弹窗关闭');
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
    assert_($(dom, '#modal-mask').classList.contains('hidden'), '无弹窗残留');
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
    const val = g(dom, 'Viewer.cm.getValue()');
    assert_(val && val.includes('中文老文件内容'), 'GBK 内容正常显示');
    assert_($(dom, '#sb-info').textContent.includes('GBK'), '状态栏显示 GBK 编码: ' + $(dom, '#sb-info').textContent);
    assert_(g(dom, 'Viewer.activeTab.encoding') === 'gbk', 'tab 记录编码');
    // 修改并保存 → writeFile 收到 encoding
    g(dom, 'Viewer.cm.setValue("中文老文件内容 已编辑")');
    await tick();
    await g(dom, 'Viewer.saveTab(' + g(dom, 'Viewer.openTabs.findIndex(t => t.path === "' + P + '/gbk-old.txt")') + ')');
    await tick();
    assert_(FAKE_FS[P + '/gbk-old.txt'].content === '中文老文件内容 已编辑', '保存内容更新');
  });

  await okAsync('编辑器行号：显示 + 行数联动（CM6）', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/gbk-old.txt")');
    await tick(); await tick();
    const gutter = $(dom, '.editor-code-wrap .cm-gutters');
    assert_(gutter, '行号 gutter 存在');
    assert_(gutter.textContent.includes('1'), '含行号 1');
    const countNums = () => $allIn($(dom, '.editor-code-wrap .cm-gutters'), '.cm-gutterElement').length;
    const before = countNums();
    // 增加行 → 行号联动（CM6 gutter 与内容同滚动容器，无需手动同步）
    g(dom, 'Viewer.cm.setValue("a\\n\\nb\\n\\nc\\n\\nd\\n\\ne")');
    await tick(); await tick();
    const after = countNums();
    assert_(after > before, '行号随行数增加: ' + before + ' -> ' + after);
  });

  await okAsync('PDF 预览：iframe 加载 file:// 路径', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/manual.pdf")');
    await tick(); await tick();
    const frame = $(dom, 'iframe.html-frame');
    assert_(frame, 'PDF iframe 出现');
    assert_(frame.src.includes('manual.pdf'), 'src 指向 PDF: ' + frame.src);
  });

  await okAsync('diff hunk 导航：按钮 + 循环切换', async () => {
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    click($allIn($(dom, '#cd-files'), '.git-file').find((x) => x.textContent.includes('README.md')));
    await tick(); await tick();
    const nav = $(dom, '#viewer .diff-wrap .df-nav');
    assert_(nav, '导航按钮组存在');
    assert_($(dom, '.df-nav-label').textContent.includes('/'), '序号显示: ' + $(dom, '.df-nav-label').textContent);
    const before = $(dom, '.df-nav-label').textContent;
    click($allIn(nav, 'button').find((b) => b.textContent.includes('⤓')));
    await tick();
    assert_($(dom, '.df-nav-label').textContent !== before, '点击后序号变化');
    await g(dom, 'GitPanel.closeDiffView()');
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
  });

  await okAsync('Git 日志分支视图：下拉 + 切换 ref', async () => {
    await g(dom, 'App.switchTool("log")');
    await tick(); await tick();
    const sel = $(dom, '#gl-ref');
    assert_(sel, '分支下拉存在');
    const opts = $allIn(sel, 'option').map((o) => o.value);
    assert_(opts.includes('__all__') && opts.includes('HEAD') && opts.includes('dev'), '选项完整: ' + JSON.stringify(opts));
    // 选「所有分支」
    sel.value = '__all__';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick(); await tick();
    assert_(calls.logGraphRef === null, 'logGraph ref=null（所有分支）, got: ' + calls.logGraphRef);
    assert_($allIn($(dom, '#gl-list'), '.gl-row').length === 3, '列表刷新');
    // 选具体分支 dev → 100 条（mock）
    const sel2 = $(dom, '#gl-ref');
    sel2.value = 'dev';
    sel2.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick(); await tick();
    assert_(calls.logGraphRef === 'dev', 'logGraph 收到 ref=dev, got: ' + calls.logGraphRef);
    assert_($allIn($(dom, '#gl-list'), '.gl-row').length === 100, 'dev 分支 100 条, got: ' + $allIn($(dom, '#gl-list'), '.gl-row').length);
    // 切回 HEAD 收尾
    sel2.value = 'HEAD';
    sel2.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick(); await tick();
    await g(dom, 'GitLog.hide()');
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

  await okAsync('编辑器查找：Ctrl+F 搜索面板（CM6 内建）', async () => {
    // 打开文本并构造多匹配内容
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    g(dom, 'Viewer.cm.setValue("foo bar foo baz foo")');
    await tick();
    key(dom, 'f', { ctrl: true });
    await tick(); await tick();
    const panel = $(dom, '.cm-panel.cm-search');
assert_(panel, 'CM6 搜索面板出现');
    assert_($(dom, '.cm-panels-top .cm-panel.cm-search'), '搜索面板在编辑器顶部');
    const input = panel && panel.querySelector('.cm-textfield');
    assert_(input, '查询输入框存在');
    // 输入查询 → 3 处匹配高亮（CM6 搜索框在 change/keyup 时提交 query）
    input.value = 'foo';
    input.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'o', bubbles: true }));
    await tick(); await tick();
    const matches = $$(dom, '.cm-searchMatch');
    assert_(matches.length === 3, '3 处匹配高亮: ' + matches.length);
    // Enter → 选中下一个匹配（面板 keydown 以 keyCode 13 判定 Enter）
    const enterEv = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(enterEv, 'keyCode', { get: () => 13 });
    input.dispatchEvent(enterEv);
    await tick(); await tick();
    const sel = g(dom, 'Viewer.cm.getSelection()');
    assert_(sel && sel.from === 0 && sel.to === 3, 'Enter 选中匹配: ' + JSON.stringify(sel));
    // Esc 关闭面板
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick(); await tick();
    assert_(!$(dom, '.cm-panel.cm-search'), 'Esc 关闭搜索面板');
  });

  await okAsync('树定位：打开深层文件自动展开并高亮', async () => {
    // 确保 src 收起（不依赖之前的展开状态，目录展开现在会跨项目持久化）
    const srcRow = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src');
    if (srcRow && $allIn($(dom, '#tree'), '.tree-row').some((r) => r.querySelector('.nm').title === P + '/src/app.js')) {
      click(srcRow); await tick();
    }
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

  await okAsync('diff 头部：无旧版/新版按钮（已移除无意义复制）+ 左右分栏行号', async () => {
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    click($allIn($(dom, '#cd-files'), '.git-file').find((x) => x.textContent.includes('README.md')));
    await tick(); await tick();
    assert_(!$(dom, '#df-copy-old') && !$(dom, '#df-copy-new'), '旧版/新版按钮已移除');
    // PyCharm 式左右分栏：[旧内容|旧行号 ‖ 新行号|新内容]，行号列在两个面板中间
    const delRow = $allIn($(dom, '.diff-table'), 'tr').find((tr) => tr.querySelector('td.old.del'));
    assert_(delRow, '存在删除行');
    const tds = delRow ? [...delRow.querySelectorAll('td')] : [];
    assert_(tds.length === 4, '4 列结构（旧内容|旧行号|新行号|新内容）, got ' + tds.length);
    assert_(tds[0].className.includes('old') && tds[0].textContent !== '', '旧内容在最左');
    assert_(tds[1].className.includes('ln'), '旧行号紧贴中缝');
    assert_(tds[2].className.includes('num'), '新行号紧贴中缝');
    assert_(tds[3].className.includes('new'), '新内容在最右');
    // 上下文行：两侧行号都有值
    const ctxRow = $allIn($(dom, '.diff-table'), 'tr').find((tr) => tr.querySelector('td.ctx') && [...tr.querySelectorAll('td')].length === 4);
    const ctxTds = ctxRow ? [...ctxRow.querySelectorAll('td')] : [];
    assert_(ctxTds[1] && ctxTds[1].textContent !== '' && ctxTds[2] && ctxTds[2].textContent !== '', '上下文行两侧行号有值');
    await g(dom, 'GitPanel.closeDiffView()');
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
  });

  await okAsync('编辑配对补全：自动配对/跳过/包裹/删除配对（CM6 closeBrackets）', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    const ce = $(dom, '.editor-code-wrap .cm-content');
    assert_(ce, 'CM6 编辑器内容区存在');
    g(dom, 'Viewer.cm.setValue("")');
    await tick();
    // jsdom 无真实输入：直接修改 contentDOM 文本节点，CM6 经 MutationObserver 读取变化
    // （closeBrackets 挂在 inputHandler 上，只在真实 DOM 输入链路触发，beforeinput 派发无效）
    const insertAt = (pos, ch) => {
      const p = g(dom, 'Viewer.cm.view.domAtPos(' + pos + ')');
      if (p.node.nodeType === 3) p.node.data = p.node.data.slice(0, p.offset) + ch + p.node.data.slice(p.offset);
      else p.node.insertBefore(dom.window.document.createTextNode(ch), p.node.childNodes[p.offset] || null);
    };
    const sel = () => g(dom, 'Viewer.cm.getSelection()');
    const val = () => g(dom, 'Viewer.cm.getValue()');
    // 1) 输入 ( → 自动补全
    insertAt(0, '(');
    await tick(); await tick(); await tick();
    assert_(val() === '()', '自动补全: ' + JSON.stringify(val()));
    assert_(sel().from === 1 && sel().to === 1, '光标在中间: ' + JSON.stringify(sel()));
    // 2) 输入 ) → 跳过
    insertAt(1, ')');
    await tick(); await tick(); await tick();
    assert_(val() === '()', '闭符号跳过不重复: ' + JSON.stringify(val()));
    assert_(sel().from === 2, '光标右移: ' + JSON.stringify(sel()));
    // 3) 选中文本包裹（模拟浏览器：选区内容被输入字符替换）
    g(dom, 'Viewer.cm.setValue("abc")');
    await tick();
    g(dom, 'Viewer.cm.setCursor(1, 2)');
    await tick(); await tick();
    const a = g(dom, 'Viewer.cm.view.domAtPos(1)');
    const b = g(dom, 'Viewer.cm.view.domAtPos(2)');
    assert_(a.node === b.node && a.node.nodeType === 3, '同行文本节点');
    a.node.data = a.node.data.slice(0, a.offset) + '[' + a.node.data.slice(b.offset);
    await tick(); await tick(); await tick();
    assert_(val() === 'a[b]c', '包裹选中: ' + JSON.stringify(val()));
    // 4) Backspace 删除配对（closeBracketsKeymap）
    g(dom, 'Viewer.cm.setValue("()")');
    await tick();
    g(dom, 'Viewer.cm.setCursor(1)');
    await tick(); await tick();
    ce.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    await tick(); await tick(); await tick();
    assert_(val() === '', '退格删除配对: ' + JSON.stringify(val()));
  });
  await okAsync('代码折叠：Ctrl+-/= 单个块，Ctrl+Shift+-/= 全部（CM6）', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/src/app.js")');
    await tick(); await tick();
    g(dom, 'Viewer.cm.setValue("function f() {\\n  return 1;\\n}\\nfunction g() {\\n  return 2;\\n}\\n")');
    await tick(); await tick();
    const ce = $(dom, '.editor-code-wrap .cm-content');
    assert_(ce, 'CM6 内容区存在');
    const kd = (k, mods) => ce.dispatchEvent(new dom.window.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods)));
    const ph = () => $$(dom, '.cm-foldPlaceholder').length;
    // 光标在函数体内 → Ctrl+- 折叠该函数（官方 foldCode 只认起始行，自定义命令覆盖块内任意位置）
    g(dom, 'Viewer.cm.setCursor(16)');
    await tick(); await tick();
    kd('-', { ctrlKey: true });
    await tick(); await tick();
    assert_(ph() === 1, '单个折叠: ' + ph());
    // Ctrl+= 展开
    kd('=', { ctrlKey: true });
    await tick(); await tick();
    assert_(ph() === 0, '单个展开: ' + ph());
    // Ctrl+Shift+- 全部折叠
    kd('_', { ctrlKey: true, shiftKey: true });
    await tick(); await tick();
    assert_(ph() === 2, '全部折叠: ' + ph());
    // Ctrl+Shift+= 全部展开
    kd('+', { ctrlKey: true, shiftKey: true });
    await tick(); await tick();
    assert_(ph() === 0, '全部展开: ' + ph());
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
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    // 变更（README.md、src/app.js）与未版本控制（data.csv、src/deep/file.ts）两节，各按顶层目录分组
    const secs = $allIn($(dom, '#cd-files'), '.git-sec-title').map((x) => x.textContent);
    assert_(secs.length === 2, '两个分节: ' + JSON.stringify(secs));
    assert_(secs[0].includes('变更 (2)'), '变更分节 2 个文件');
    assert_(secs[1].includes('未版本控制的文件 (2)'), '未版本控制分节 2 个文件');
    const groups = $allIn($(dom, '#cd-files'), '.git-group');
    // 递归树：变更节 src(1)；未跟踪节 src(1) → deep(1)（根级文件不产生分组行）
    assert_(groups.length === 3, '三个目录行（src / src / deep）: ' + JSON.stringify(groups.map((x) => x.textContent)));
    assert_(groups[0].textContent.includes('src'), '变更节 src 目录行');
    assert_(groups[2].textContent.includes('deep'), '未跟踪节 deep 嵌套目录行');
    assert_(parseInt(groups[2].style.paddingLeft) > parseInt(groups[1].style.paddingLeft), 'deep 相对 src 缩进');
    // 折叠
    click(groups[1]);
    await tick();
    assert_(groups[1].textContent.includes('▸'), '组已折叠');
    click(groups[1]);
    await tick();
    assert_(groups[1].textContent.includes('▾'), '组已展开');
    await g(dom, 'GitPanel.closeDialog()');
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
    key(dom, '+', { ctrl: true, shift: true });
    await tick();
    assert_(rootStyle.getPropertyValue('--editor-font-size') === '14px', '字号 14px: ' + rootStyle.getPropertyValue('--editor-font-size'));
    assert_(dom.window.localStorage.getItem('myide-editor-font') === '14', '字号持久化');
    key(dom, '_', { ctrl: true, shift: true });
    await tick();
    assert_(rootStyle.getPropertyValue('--editor-font-size') === '13px', '字号回到 13px');
    // hunk 快捷键（提交面板 → 编辑区 diff）
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    click($allIn($(dom, '#cd-files'), '.git-file').find((x) => x.textContent.includes('README.md')));
    await tick(); await tick();
    const before = $(dom, '.df-nav-label').textContent;
    key(dom, 'ArrowDown', { alt: true });
    await tick();
    assert_($(dom, '.df-nav-label').textContent !== before, 'Alt+↓ 切换 hunk');
    await g(dom, 'GitPanel.closeDiffView()');
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
  });

  await okAsync('Git 日志分页：加载更多', async () => {
    await g(dom, 'App.switchTool("log")');
    await tick(); await tick();
    // 切到 dev（mock 返回 100 条 + truncated）
    const sel = $(dom, '#gl-ref');
    sel.value = 'dev';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick(); await tick();
    const more = $(dom, '#gl-load-more');
    assert_(more, '加载更多按钮出现');
    click(more);
    await tick(); await tick();
    assert_(calls.logGraphLimit === 1000, 'limit 增加到 1000: ' + calls.logGraphLimit);
    // 切回默认（HEAD：3 条且非 truncated）
    const sel2 = $(dom, '#gl-ref');
    sel2.value = 'HEAD';
    sel2.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick(); await tick();
    assert_(!$(dom, '#gl-load-more'), '默认视图无加载更多（3 条且未截断）');
    await g(dom, 'GitLog.hide()');
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

  await okAsync('状态栏不再显示文件路径（已移除）', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    assert_(!$(dom, '#sb-info').textContent.includes('notes.txt'), '状态栏无文件路径: ' + $(dom, '#sb-info').textContent);
    const before = calls.copy.length;
    click($(dom, '#sb-info'));
    await tick();
    assert_(calls.copy.length === before, '点击状态栏不再触发复制');
  });

  await okAsync('提交面板：点击文件行 → 编辑区差异预览', async () => {
    await g(dom, 'GitPanel.refresh()');
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    const before = calls.diffWorkdir.length;
    // 单击行（非勾选框/操作按钮）→ 编辑区预览工作区 vs HEAD
    const row = $allIn($(dom, '#cd-files'), '.git-file').find((x) => x.textContent.includes('README.md'));
    click(row);
    await tick(); await tick();
    assert_(calls.diffWorkdir.length === before + 1, '点击触发了 diffWorkdir');
    assert_($(dom, '#viewer .diff-wrap .diff-table'), '编辑区差异表格出现');
    assert_(row.classList.contains('sel'), '行显示选中态');
    await g(dom, 'GitPanel.closeDiffView()');
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
  });

  await okAsync('toast 提示正常', async () => {
    g(dom, 'MI.toast("测试提示", "ok")');
    await tick();
    assert_($allIn(dom.window.document, '.toast').some((t) => t.textContent.includes('测试提示')), 'toast 出现');
  });

  await okAsync('右下角玩宠：toast 由它播报（跳跃动画 + 头顶气泡位置）', async () => {
    const pet = $(dom, '#pet');
    assert_(pet, '玩宠 #pet 存在');
    assert_(pet.querySelector('svg'), '玩宠是 SVG 小猫');
    g(dom, 'MI.toast("喵播报", "ok")');
    await tick();
    assert_(pet.classList.contains('speaking'), 'toast 触发玩宠说话动画');
    const wrapCss = dom.window.getComputedStyle($(dom, '#toast-wrap'));
    assert_(parseInt(wrapCss.bottom, 10) >= 80, '气泡定位在玩宠头顶（bottom ≥ 80px）, got: ' + wrapCss.bottom);
  });

  await okAsync('大纲面板键盘导航：↑↓ 选择 + Enter 跳转', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await tick(); await tick();
    key(dom, '2', { ctrl: true }); // Ctrl+2 切到大纲面板
    await tick(); await tick();
    const items = $allIn($(dom, '#outline'), '.outline-item');
    assert_(items.length >= 1, '大纲有条目, got ' + items.length);
    dom.window.document.body.focus();
    key(dom, 'ArrowDown');
    await tick();
    assert_($(dom, '.outline-item.key-nav-sel'), '↓ 后有键盘选中高亮');
    key(dom, 'ArrowDown');
    await tick();
    const selCount = $allIn($(dom, '#outline'), '.outline-item.key-nav-sel').length;
    assert_(selCount === 1, '选中项唯一, got ' + selCount);
    key(dom, 'Enter');
    await tick();
    assert_($(dom, '.editor-cm-wrap'), 'Enter 跳转不破坏编辑器');
  });

  await okAsync('背景图显示方式与位置：fit + pos 持久化并应用', async () => {
    // 背景图只在编辑区显示：bg-layer 挂在 #content 内
    const layer0 = $(dom, '#bg-layer');
    assert_(layer0 && layer0.parentElement && layer0.parentElement.id === 'content', 'bg-layer 在编辑区 #content 内, parent: ' + (layer0 && layer0.parentElement && layer0.parentElement.id));
    await g(dom, 'Bg.set("' + P + '/pic.png")');
    await g(dom, 'Bg.setFit("tile")');
    await g(dom, 'Bg.setPos("top left")');
    await tick();
    const layer = $(dom, '#bg-layer');
    assert_(layer.style.backgroundRepeat === 'repeat', '平铺模式 repeat, got: ' + layer.style.backgroundRepeat);
    assert_(layer.style.backgroundSize === 'auto', '平铺模式原尺寸, got: ' + layer.style.backgroundSize);
    assert_(layer.style.backgroundPosition === 'left top' || layer.style.backgroundPosition === 'top left', '位置左上, got: ' + layer.style.backgroundPosition);
    const bg = g(dom, 'JSON.stringify(Bg.get())');
    const o = JSON.parse(bg);
    assert_(o.fit === 'tile' && o.pos === 'top left', 'get() 返回 fit/pos: ' + bg);
    await g(dom, 'Bg.setFit("cover")');
    await tick();
    assert_($(dom, '#bg-layer').style.backgroundSize === 'cover', '切回铺满 cover');
    await g(dom, 'Bg.set("")'); // 清理，不影响后续测试
  });

  await okAsync('状态栏背景透明度滑条（最右端，设背景图后显示）', async () => {
    await g(dom, 'Bg.set("' + P + '/pic.png")');
    await tick();
    assert_($(dom, 'body').classList.contains('has-bg'), 'has-bg 激活（滑条可见）');
    const sb = $(dom, '#sb-bgop-range');
    assert_(sb, '状态栏滑条存在');
    // 位置：滑条在字号控件之后（状态栏最右端）
    const bar = $(dom, '#statusbar');
    const kids = [...bar.children].filter((x) => x.id);
    assert_(kids.indexOf(bar.querySelector('#sb-bgop')) > kids.indexOf(bar.querySelector('#sb-font')), '滑条在字号控件右侧（最右端）');
    assert_(sb.value === '15', '初始值同步 15, got: ' + sb.value);
    await g(dom, 'Bg.setOpacity(0.3)');
    await tick();
    assert_(sb.value === '30', '透明度变化同步滑条, got: ' + sb.value);
    // 滑条拖动 → Bg 生效
    sb.value = '40';
    sb.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    const bg = JSON.parse(g(dom, 'JSON.stringify(Bg.get())'));
    assert_(Math.abs(bg.opacity - 0.4) < 0.001, '拖动滑条写入透明度, got: ' + bg.opacity);
    await g(dom, 'Bg.set("")'); // 清理
    await tick();
  });

  await okAsync('主题自定义强调色：setAccent 生效 + 空值恢复默认', async () => {
    await g(dom, 'Theme.setAccent("#ff6600")');
    await tick();
    assert_(dom.window.document.body.style.getPropertyValue('--accent') === '#ff6600', '强调色写入 CSS 变量');
    await g(dom, 'Theme.setAccent("")');
    await tick();
    assert_(dom.window.document.body.style.getPropertyValue('--accent') === '', '空值恢复主题默认');
  });

  await okAsync('UI 动态自定义主题：pick 多项变量 + clearCustom 恢复', async () => {
    await g(dom, 'Theme.pick("bg", "#101010")');
    await g(dom, 'Theme.pick("text", "#cccccc")');
    await g(dom, 'Theme.pick("bgPanel", "#141414")');
    await tick();
    const st = dom.window.document.body.style;
    assert_(st.getPropertyValue('--bg') === '#101010', '编辑区背景写入, got: ' + st.getPropertyValue('--bg'));
    assert_(st.getPropertyValue('--text') === '#cccccc', '正文文字写入, got: ' + st.getPropertyValue('--text'));
    assert_(st.getPropertyValue('--bg-panel') === '#141414', '侧栏背景写入, got: ' + st.getPropertyValue('--bg-panel'));
    const c = JSON.parse(g(dom, 'JSON.stringify(Theme.getCustom())'));
    assert_(c.bg === '#101010' && c.text === '#cccccc' && c.bgPanel === '#141414', 'getCustom 返回全部自定义项: ' + JSON.stringify(c));
    // 单项恢复：pick 空值 → 变量移除，其余保留
    await g(dom, 'Theme.pick("bg", "")');
    await tick();
    assert_(st.getPropertyValue('--bg') === '', '单项恢复后变量移除');
    assert_(st.getPropertyValue('--text') === '#cccccc', '其余自定义项保留');
    // 全部恢复
    await g(dom, 'Theme.clearCustom()');
    await tick();
    assert_(st.getPropertyValue('--text') === '' && st.getPropertyValue('--bg-panel') === '', 'clearCustom 全部恢复预设');
    const c2 = JSON.parse(g(dom, 'JSON.stringify(Theme.getCustom())'));
    assert_(!c2.bg && !c2.text && !c2.bgPanel, '存储已清空: ' + JSON.stringify(c2));
  });

  await okAsync('设置页动态自定义主题 UI：调色即时生效 + 逐项恢复', async () => {
    key(dom, 'S', { ctrl: true, alt: true }); // Ctrl+Alt+S 打开设置
    await tick();
    click($allIn($(dom, '#set-box'), '.set-cat').find((x) => x.textContent.includes('主题')));
    await tick();
    const rows = $allIn(dom.window.document, '.custom-theme-row');
    assert_(rows.length >= 16, '动态自定义表单 ≥ 16 项, got ' + rows.length);
    assert_($allIn(dom.window.document, '.ct-group-title').length >= 4, '按分组渲染 ≥ 4 组');
    // 改强调色：input 事件 → CSS 变量即时写入
    const accentRow = rows.find((r) => r.dataset.field === 'accent');
    const input = accentRow.querySelector('.ct-color');
    input.value = '#00aa88';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    assert_(dom.window.document.body.style.getPropertyValue('--accent') === '#00aa88', '调色即时生效写入 --accent');
    const c = JSON.parse(g(dom, 'JSON.stringify(Theme.getCustom())'));
    assert_(c.accent === '#00aa88', '选色持久化: ' + JSON.stringify(c));
    // 逐项恢复 ×
    click(accentRow.querySelector('.ct-reset'));
    await tick();
    assert_(dom.window.document.body.style.getPropertyValue('--accent') === '', '× 恢复该项预设');
    // 全部恢复
    await g(dom, 'Theme.pick("bg", "#123456")');
    await tick();
    click($(dom, '#custom-theme-reset-all'));
    await tick();
    assert_(dom.window.document.body.style.getPropertyValue('--bg') === '', '全部恢复预设');
    click($(dom, '#set-x')); // 关闭设置
    await tick();
  });

  await okAsync('Bug 修复：浅色/粉红主题下调色立即生效（变量写入 body 覆盖 body.theme-*）', async () => {
    // 此前 bug：覆盖层写 documentElement，被 body.theme-light 的变量定义覆盖 → 调色无效
    await g(dom, 'Theme.set("light")');
    await tick();
    await g(dom, 'Theme.pick("bg", "#221122")');
    await g(dom, 'Theme.pick("accent", "#00cc66")');
    await tick();
    const bs = dom.window.document.body.style;
    assert_(bs.getPropertyValue('--bg') === '#221122', '浅色主题下背景调色写入 body inline');
    assert_(bs.getPropertyValue('--accent') === '#00cc66', '浅色主题下强调色写入 body inline');
    // 粉红主题同样生效
    await g(dom, 'Theme.set("pink")');
    await tick();
    await g(dom, 'Theme.pick("text", "#abcdef")');
    await tick();
    assert_(dom.window.document.body.style.getPropertyValue('--text') === '#abcdef', '粉红主题下调色生效');
    // 恢复
    await g(dom, 'Theme.clearCustom()');
    await g(dom, 'Theme.set("dark")');
    await tick();
    assert_(dom.window.document.body.style.getPropertyValue('--bg') === '', '恢复后覆盖层清空');
  });

  await okAsync('自定义主题 API：保存 / 应用 / 删除', async () => {
    await g(dom, 'Theme.pick("accent", "#123456")');
    await g(dom, 'Theme.pick("bg", "#0a0a0a")');
    const id = g(dom, 'Theme.addUserTheme("测试蓝")');
    await tick();
    assert_(id && String(id).indexOf('u') === 0, '返回主题 id: ' + id);
    // 应用：载入配色快照
    await g(dom, 'Theme.set("user:' + id + '")');
    await tick();
    const st = dom.window.document.body.style;
    assert_(g(dom, 'Theme.current()') === 'user:' + id, 'current 返回用户主题');
    assert_(st.getPropertyValue('--accent') === '#123456', '配色快照载入');
    assert_(st.getPropertyValue('--bg') === '#0a0a0a', '背景快照载入');
    // 切回内置 → 恢复其默认配色
    await g(dom, 'Theme.set("dark")');
    await tick();
    assert_(st.getPropertyValue('--accent') === '' && st.getPropertyValue('--bg') === '', '内置主题恢复默认配色');
    // 再切回用户主题 → 快照恢复
    await g(dom, 'Theme.set("user:' + id + '")');
    await tick();
    assert_(st.getPropertyValue('--accent') === '#123456', '重新应用快照恢复');
    // 删除当前用户主题 → 回退 base
    await g(dom, 'Theme.removeUserTheme("' + id + '")');
    await tick();
    assert_(g(dom, 'Theme.current()') === 'dark', '删除当前主题回退 dark');
    assert_(st.getPropertyValue('--accent') === '', '配色恢复默认');
    assert_(JSON.parse(g(dom, 'JSON.stringify(Theme.getUserThemes())')).length === 0, '主题列表已清空');
  });

  await okAsync('设置页自定义主题管理：保存 / 应用 / 删除', async () => {
    g(dom, 'Theme.addUserTheme("预设橙")');
    await tick();
    key(dom, 'S', { ctrl: true, alt: true });
    await tick();
    click($allIn($(dom, '#set-box'), '.set-cat').find((x) => x.textContent.includes('主题')));
    await tick();
    let card = $allIn(dom.window.document, '.theme-opt.ut').find((b) => b.textContent.includes('预设橙'));
    assert_(card, '用户主题卡片出现');
    // 点击卡片应用
    click(card);
    await tick();
    assert_(String(g(dom, 'Theme.current()')).indexOf('user:') === 0, '点击卡片应用用户主题');
    assert_($allIn(dom.window.document, '.theme-opt.ut').some((b) => b.classList.contains('sel')), '应用后卡片高亮');
    // 保存为自定义主题（Modal.prompt 流程）
    click($(dom, '#ut-save'));
    await tick();
    const input = $(dom, '#pf-input');
    assert_(input, '命名弹窗出现');
    input.value = '我的新主题';
    click($(dom, '#pf-yes'));
    await tick(); await tick();
    const card2 = $allIn(dom.window.document, '.theme-opt.ut').find((b) => b.textContent.includes('我的新主题'));
    assert_(card2, '新主题卡片出现');
    // 删除（Modal.confirm 流程）
    click(card2.querySelector('.ut-del'));
    await tick();
    assert_($(dom, '#cf-yes'), '删除确认弹窗出现');
    click($(dom, '#cf-yes'));
    await tick(); await tick();
    assert_(!$allIn(dom.window.document, '.theme-opt.ut').some((b) => b.textContent.includes('我的新主题')), '删除后卡片消失');
    // 清理 + 关闭
    g(dom, 'Theme.removeUserTheme(Theme.getUserThemes()[0].id)');
    await tick();
    click($(dom, '#set-x'));
    await tick();
  });

  await okAsync('Git 面板键盘导航：↑↓ 选择本地修改行', async () => {
    await g(dom, 'GitPanel.refresh()');
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    const files = $allIn($(dom, '#cd-files'), '.git-file');
    assert_(files.length >= 1, '有变更文件行, got ' + files.length);
    dom.window.document.body.focus();
    key(dom, 'ArrowDown');
    await tick();
    assert_($(dom, '.git-file.key-nav-sel'), '↓ 后有键盘选中高亮');
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
  });

  await okAsync('侧栏分隔线实色不透明', async () => {
    // jsdom 不解析 CSS 变量（computed 恒为透明），直接断言样式表源码
    const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
    const m = /^#sidebar-resizer\s*\{[^}]*\}/m.exec(cssSrc);
    assert_(m, '找到 #sidebar-resizer 规则');
    assert_(/background:\s*var\(--border\)/.test(m[0]) && !/transparent/.test(m[0]), '分隔线背景为实色 var(--border), got: ' + m[0].replace(/\s+/g, ' '));
  });

  await okAsync('Bug1：空状态只覆盖内容区（#content 定位）', async () => {
    const pos = dom.window.getComputedStyle($(dom, '#content')).position;
    assert_(pos === 'relative', '#content 应为 relative 以约束空状态覆盖范围, got: ' + pos);
    // 清空标签触发空状态后，侧边栏与工具栏仍在可交互区（未被绝对定位覆盖到 viewport）
    for (let i = 0; i < g(dom, 'Viewer.openTabs.length'); i++) {
      if (g(dom, 'Viewer.openTabs[' + i + '].dirty')) await g(dom, 'Viewer.saveTab(' + i + ')');
    }
    while (g(dom, 'Viewer.openTabs.length') > 0) { g(dom, 'Viewer.closeTab(0)'); await tick(); }
    await tick();
    assert_($(dom, '#empty-state').classList.contains('visible'), '空状态可见');
    assert_($(dom, '#tool-project') && !$(dom, '#tool-project').classList.contains('hidden'), '工具条仍可用');
  });

  await okAsync('Bug2：文件名过长不换行（nowrap）', async () => {
    await g(dom, 'App.setRoot("' + P + '")');
    await tick(); await tick();
    const nm = $allIn($(dom, '#tree'), '.tree-row .nm').find((n) => n.title === P + '/README.md');
    assert_(nm, 'README.md 行存在');
    assert_(dom.window.getComputedStyle(nm).whiteSpace === 'nowrap', '文件名 nowrap, got: ' + dom.window.getComputedStyle(nm).whiteSpace);
  });

  await okAsync('Bug3：弹窗不透明面板', async () => {
    key(dom, 'p', { ctrl: true });
    await tick();
    const panel = $(dom, '#qo-box');
    assert_(panel, '弹窗面板存在');
    assert_(panel.classList.contains('modal-panel'), '弹窗带 modal-panel 类（统一不透明面板样式）');
    const css = $allIn(dom.window.document, 'style').map((s) => s.textContent).join('\n');
    assert_(css.includes('.modal-panel') && css.includes('background'), '样式表含 .modal-panel 背景规则');
    key(dom, 'Escape', {});
    await tick();
  });

  await okAsync('Bug4：图片查看器无格子背景', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/pic.png")');
    await tick(); await tick();
    const img = $(dom, '.img-view');
    assert_(img, '图片查看器存在');
    const bg = dom.window.getComputedStyle(img).backgroundImage;
    assert_(bg === 'none', '无 checkerboard 背景, got: ' + bg);
  });

  await okAsync('Bug5：目录树一键收起/展开', async () => {
    await g(dom, 'App.setRoot("' + P + '")');
    await tick(); await tick();
    // 先收起全部（前序测试可能残留展开态，点击会变成收起）
    await g(dom, 'Tree.collapseAll()');
    await tick(); await tick();
    // 展开 src
    const srcRow = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src');
    click(srcRow);
    await tick(); await tick();
    assert_($allIn($(dom, '#tree'), '.tree-row').some((r) => r.querySelector('.nm').title === P + '/src/app.js'), 'src 已展开');
    await g(dom, 'Tree.collapseAll()');
    await tick(); await tick();
    assert_(!$allIn($(dom, '#tree'), '.tree-row').some((r) => r.querySelector('.nm').title === P + '/src/app.js'), '收起后 app.js 不可见');
    await g(dom, 'Tree.expandAll()');
    await tick(); await tick();
    assert_($allIn($(dom, '#tree'), '.tree-row').some((r) => r.querySelector('.nm').title === P + '/src/app.js'), '展开后 app.js 可见');
  });

  await okAsync('Bug6：文件树 Git 状态着色', async () => {
    await g(dom, 'App.setRoot("' + P + '")');
    await g(dom, 'GitPanel.refresh()');
    await tick(); await tick();
    const nm = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/README.md').querySelector('.nm');
    assert_(nm.classList.contains('git-modified'), 'README.md 显示修改色（git-modified）');
  });

  await okAsync('Bug7：Git 放弃修改（revert）', async () => {
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    const file = $allIn($(dom, '#cd-files'), '.git-file').find((x) => x.textContent.includes('README.md'));
    assert_(file, '找到 README.md 变更行');
    const before = calls.discard.length;
    click(file.querySelector('.git-revert'));
    await tick();
    const yesBtn = $allIn($(dom, '#modal-mask'), 'button').find((b) => b.textContent.includes('确定'));
    assert_(yesBtn, '确认弹窗出现');
    click(yesBtn);
    await tick(); await tick();
    assert_(calls.discard.length === before + 1, '调用了 git.discard');
    assert_(calls.discard[calls.discard.length - 1] === 'README.md', '丢弃的是 README.md');
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
  });

  await okAsync('Bug10：目录区宽度拖拽调整并持久化', async () => {
    const sidebar = $(dom, '#sidebar');
    const resizer = $(dom, '#sidebar-resizer');
    assert_(resizer, 'resizer 存在');
    resizer.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, clientX: 200 }));
    dom.window.document.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, clientX: 320 }));
    dom.window.document.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, clientX: 320 }));
    await tick();
    assert_(sidebar.style.width === '320px', '宽度更新为 320px: ' + sidebar.style.width);
    assert_(dom.window.localStorage.getItem('myide-sidebar-width') === '320', '宽度持久化');
  });

  await okAsync('Bug11：Markdown 分屏模式（工具栏切换 + 实时预览）', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await tick(); await tick();
    assert_($(dom, '.editor-cm-wrap'), '默认实时预览（CM6）');
    // 切到分屏
    click($allIn($(dom, '.viewer-toolbar'), 'button').find((b) => b.textContent.includes('◫ 分屏')));
    await tick();
    assert_($(dom, '.md-split'), '切分屏后容器出现');
    assert_($(dom, '.md-split-preview .md-view'), '预览面板渲染 markdown');
    const ta = $(dom, 'textarea.editor');
    ta.value = '# 实时标题\n\n新内容';
    ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 320)); // 等 200ms 防抖
    const md = $(dom, '.md-split-preview .md-view');
    assert_(md && md.querySelector('h1') && md.querySelector('h1').textContent.includes('实时标题'), '预览实时更新');
    click($allIn($(dom, '.viewer-toolbar'), 'button').find((b) => b.textContent.includes('{ } 源码')));
    await tick();
    assert_(!$(dom, '.md-split'), '切源码后无分屏');
    assert_($(dom, '.editor-cm-wrap .cm-editor'), '源码模式有 CM 编辑器');
  });

  await okAsync('Bug2：Markdown 链接跳转（外链/相对路径/锚点）', async () => {
    calls.openExternal = [];
    await g(dom, 'Viewer.openFile("' + P + '/link.md")');
    await tick(); await tick();
    // live（CM6）无 .md-view，切「◉ 预览」后断言渲染链接
    click($allIn($(dom, '.viewer-toolbar'), 'button').find((b) => b.textContent.includes('◉ 预览')));
    await tick();
    const md = $(dom, '.md-view');
    const links = $allIn(md, 'a');
    // 外链 → openExternal
    const ext = links.find((a) => a.textContent === '外部链接');
    assert_(ext, '外链存在');
    click(ext);
    await tick();
    assert_((calls.openExternal || []).includes('https://example.com'), '外链调用 openExternal');
    // 相对路径 → 打开本地文件
    const local = links.find((a) => a.textContent === '本地文件');
    assert_(local, '相对链接存在');
    click(local);
    await tick(); await tick();
    const tab = $(dom, '.tab.active .tname');
    assert_(tab && tab.textContent.includes('notes.txt'), '相对链接打开 notes.txt');
    // 锚点 → 不切换文件
    const anchor = links.find((a) => a.textContent === '锚点');
    assert_(anchor, '锚点链接存在');
    click(anchor);
    await tick();
    assert_($(dom, '.tab.active .tname') && $(dom, '.tab.active .tname').textContent.includes('notes.txt'), '锚点不切换文件');
    // wiki 链接 [[README]] → 标准链接并可打开
    const wiki = links.find((a) => a.textContent === 'README' && a.getAttribute('href') === 'README');
    assert_(wiki, 'wiki 链接已转换');
    click(wiki);
    await tick(); await tick();
    assert_($(dom, '.tab.active .tname') && $(dom, '.tab.active .tname').textContent.includes('README'), 'wiki 链接打开 README.md');
    // ![[pic.png]] 嵌入 → 本地图片
    const wikiImg = $allIn(md, 'img').find((im) => (im.src || '').includes('pic.png'));
    assert_(wikiImg, 'wiki 图片嵌入渲染');
  });

  await okAsync('Bug3：目录展开结构按项目持久化（切换项目后恢复）', async () => {
    await g(dom, 'App.setRoot("' + P + '")');
    await tick(); await tick();
    // 先收起全部（前序测试可能残留展开态，点击会变成收起）
    await g(dom, 'Tree.collapseAll()');
    await tick(); await tick();
    const srcRow = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src');
    click(srcRow);
    await tick(); await tick();
    assert_($allIn($(dom, '#tree'), '.tree-row').some((r) => r.querySelector('.nm').title === P + '/src/app.js'), 'src 已展开');
    await new Promise((r) => setTimeout(r, 500)); // 等防抖保存
    // 清理 dirty 标签，避免 openProject 触发确认弹窗卡住
    for (let i = 0; i < g(dom, 'Viewer.openTabs.length'); i++) {
      if (g(dom, 'Viewer.openTabs[' + i + '].dirty')) await g(dom, 'Viewer.saveTab(' + i + ')');
    }
    await tick();
    // 切到 proj2 再切回，验证目录结构恢复
    await g(dom, 'App.openProject("C:/proj2")');
    await tick(); await tick();
    await g(dom, 'App.openProject("' + P + '")');
    await tick(); await tick();
    assert_($allIn($(dom, '#tree'), '.tree-row').some((r) => r.querySelector('.nm').title === P + '/src/app.js'), '切回后 src 仍展开');
  });

  await okAsync('Bug5：提交窗口分节（变更 / 未版本控制的文件，旧分页签已移除）', async () => {
    await g(dom, 'GitPanel.refresh()');
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    assert_($allIn($(dom, '#cd-files'), '.git-tab').length === 0, '旧分页签已移除');
    const secs = $allIn($(dom, '#cd-files'), '.git-sec-title').map((x) => x.textContent);
    assert_(secs.length === 2, '两个分节: ' + JSON.stringify(secs));
    assert_(secs[0].includes('变更'), '变更分节');
    assert_(secs[1].includes('未版本控制'), '未版本控制分节');
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
  });

  await okAsync('Bug6：目录树嵌套缩进（PyCharm 提交窗口式）', async () => {
    await g(dom, 'GitPanel.refresh()');
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    const nm = $allIn($(dom, '#cd-files'), '.git-file .nm').find((x) => x.title === 'src/app.js');
    assert_(nm, '找到 src/app.js 变更行');
    assert_(nm.textContent.trim() === 'app.js', '只显示文件名（层级由目录树表达）, got: ' + nm.textContent);
    // src 目录行存在且文件行缩进大于目录行
    const srcGroup = $allIn($(dom, '#cd-files'), '.git-group').find((x) => x.textContent.includes('src'));
    assert_(srcGroup, 'src 目录行存在');
    const srcRow = nm.closest('.git-file');
    assert_(parseInt(srcRow.style.paddingLeft) > parseInt(srcGroup.style.paddingLeft), '子文件相对父目录缩进');
    // 未版本控制分节也有嵌套
    const untrackedFile = $allIn($(dom, '#cd-files'), '.git-file .nm').find((x) => x.title.includes('newdir'));
    if (untrackedFile) {
      const row = untrackedFile.closest('.git-file');
      assert_(parseInt(row.style.paddingLeft) >= 24, '二级目录文件缩进 ≥ 24px');
    }
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
  });

  await okAsync('提交窗口右键菜单：查看差异 / 回滚 / 打开 / 复制路径', async () => {
    await g(dom, 'GitPanel.refresh()');
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    const fileRowEl = $allIn($(dom, '#cd-files'), '.git-file').find((x) => x.textContent.includes('README.md'));
    assert_(fileRowEl, 'README.md 变更行存在');
    fileRowEl.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    const items = $allIn($(dom, '#ctx-menu'), '.ctx-item').map((x) => x.textContent);
    assert_(items.some((t) => t.includes('查看差异')), '菜单含查看差异');
    assert_(items.some((t) => t.includes('回滚') || t.includes('删除文件')), '菜单含回滚/删除');
    assert_(items.some((t) => t.includes('打开文件')), '菜单含打开文件');
    assert_(items.some((t) => t.includes('复制完整路径')), '菜单含复制完整路径');
    // 点击回滚 → 确认弹窗 → discard 调用
    const before = calls.discard.length;
    click($allIn($(dom, '#ctx-menu'), '.ctx-item').find((x) => x.textContent.includes('回滚') || x.textContent.includes('删除文件')));
    await tick();
    assert_(!$(dom, '#modal-mask').classList.contains('hidden'), '回滚确认弹窗出现');
    click($(dom, '#cf-yes'));
    await tick(); await tick();
    assert_(calls.discard.length === before + 1, 'discard 被调用');
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
  });

  await okAsync('Bug7：Git 新建分支（PyCharm Branches → New Branch）', async () => {
    await g(dom, 'GitPanel.refresh()');
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    const branchBtn = $(dom, '#cd-branch');
    assert_(branchBtn, '分支入口存在');
    click(branchBtn);
    await tick(); await tick();
    const input = $(dom, '#br-new-input');
    assert_(input, '新建分支输入框存在');
    input.value = 'feature-x';
    click($(dom, '#br-new-btn'));
    await tick(); await tick();
    assert_((calls.createBranch || []).includes('feature-x'), 'createBranch 被调用');
    assert_(!$(dom, '#br-box'), '分支弹窗关闭');
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
  });

  await okAsync('Git 变更行：双击打开文件（单击看 diff）', async () => {
    await g(dom, 'GitPanel.refresh()');
    await g(dom, 'GitPanel.openCommit()');
    await tick(); await tick();
    // 双击行 → 打开文件
    const file = $allIn($(dom, '#cd-files'), '.git-file').find((x) => x.textContent.includes('README.md'));
    file.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await tick(); await tick();
    const tab = $(dom, '.tab.active .tname');
    assert_(tab && tab.textContent.includes('README.md'), '双击打开 README.md, got: ' + (tab && tab.textContent));
    await g(dom, 'GitPanel.closeDialog()');
    await tick();
  });

  await okAsync('Ctrl+Z 撤销新建文件', async () => {
    // 右键 src → 新建文件 undome.txt
    const srcRow = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src');
    srcRow.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    click($allIn($(dom, '#ctx-menu'), '.ctx-item').find((x) => x.textContent.includes('新建文件')));
    await tick();
    const input = $(dom, '#pf-input');
    input.value = 'undome.txt';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick(); await tick();
    const created = P + '/src\\undome.txt';
    assert_(FAKE_FS[created], '文件已创建');
    // Ctrl+Z 撤销
    dom.window.document.body.focus();
    await tick();
    key(dom, 'z', { ctrl: true });
    await tick(); await tick();
    assert_(!FAKE_FS[created], 'Ctrl+Z 撤销新建');
  });

  await okAsync('树内拖拽移动文件 + Ctrl+Z 撤销移动', async () => {
    const mkDrag = (type, path) => {
      const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
      ev.dataTransfer = { getData: () => path, setData: () => {}, effectAllowed: '', dropEffect: '' };
      return ev;
    };
    const srcRow = $allIn($(dom, '#tree'), '.tree-row').find((r) => r.querySelector('.nm').title === P + '/src');
    assert_(srcRow, 'src 行存在');
    srcRow.dispatchEvent(mkDrag('dragover', P + '/notes.txt'));
    await tick();
    assert_(srcRow.classList.contains('drop-target'), '拖拽悬停高亮');
    srcRow.dispatchEvent(mkDrag('drop', P + '/notes.txt'));
    await tick(); await tick();
    assert_(FAKE_FS[P + '/src/notes.txt'], '文件已移动到 src');
    // Ctrl+Z 撤销移动
    dom.window.document.body.focus();
    await tick();
    key(dom, 'z', { ctrl: true });
    await tick(); await tick();
    assert_(FAKE_FS[P + '/notes.txt'] && !FAKE_FS[P + '/src/notes.txt'], '撤销移动回原位');
  });

  await okAsync('视频/音频预览', async () => {
    FAKE_FS[P + '/movie.mp4'] = { type: 'file', content: '' };
    FAKE_FS[P + '/song.mp3'] = { type: 'file', content: '' };
    await g(dom, 'Viewer.openFile("' + P + '/movie.mp4")');
    await tick(); await tick();
    assert_($(dom, '.media-view video'), 'video 元素出现');
    await g(dom, 'Viewer.openFile("' + P + '/song.mp3")');
    await tick(); await tick();
    assert_($(dom, '.media-view audio'), 'audio 元素出现');
  });

  await okAsync('HTML 浏览器打开按钮', async () => {
    calls.openExternal = [];
    await g(dom, 'Viewer.openFile("' + P + '/page.html")');
    await tick(); await tick();
    const btn = $allIn($(dom, '.viewer-toolbar'), 'button').find((b) => b.textContent.includes('浏览器打开'));
    assert_(btn, '浏览器打开按钮存在');
    click(btn);
    await tick();
    assert_((calls.openExternal || []).some((u) => u.includes('page.html')), '调用 openExternal, got: ' + JSON.stringify(calls.openExternal));
  });

  await okAsync('内置浏览器：URL 规范化', async () => {
    const n = (s) => g(dom, 'BrowserPanel.normalizeInput(' + JSON.stringify(s) + ')');
    assert_(n('baidu.com') === 'https://baidu.com', '裸域名补 https, got ' + n('baidu.com'));
    assert_(n('github.com/electron/electron') === 'https://github.com/electron/electron', '域名带路径');
    assert_(n('localhost:3000') === 'https://localhost:3000', 'localhost 带端口');
    assert_(n('192.168.1.1:8080/admin') === 'https://192.168.1.1:8080/admin', 'IP 带端口路径');
    assert_(n('https://a.b/c') === 'https://a.b/c', '已带协议原样');
    assert_(n('file:///C:/x.html') === 'file:///C:/x.html', 'file 协议原样');
    assert_(n('vue3 watch 用法').startsWith('https://www.bing.com/search?q='), '关键词转搜索');
    assert_(n('') === null, '空输入返回 null');
  });

  await okAsync('内置浏览器：面板开关 + 默认收藏空状态', async () => {
    click($(dom, '#tool-browser'));
    await tick();
    assert_(!$(dom, '#browser-panel').classList.contains('hidden'), '工具条按钮打开面板');
    assert_($(dom, '#tool-browser').classList.contains('active'), '按钮高亮');
    const chips = $allIn($(dom, '#be-favs'), '.be-chip');
    assert_(chips.length === 5, '默认收藏 5 个, got ' + chips.length);
    assert_(chips.some((c) => c.textContent === 'GitHub'), '默认收藏含 GitHub');
    click($(dom, '#tool-browser'));
    await tick();
    assert_($(dom, '#browser-panel').classList.contains('hidden'), '再点一次收起面板');
    assert_(!$(dom, '#tool-browser').classList.contains('active'), '按钮取消高亮');
  });

  await okAsync('内置浏览器：Ctrl+6 快捷键切换', async () => {
    key(dom, '6', { ctrl: true });
    await tick();
    assert_(!$(dom, '#browser-panel').classList.contains('hidden'), 'Ctrl+6 打开');
    key(dom, '6', { ctrl: true });
    await tick();
    assert_($(dom, '#browser-panel').classList.contains('hidden'), 'Ctrl+6 关闭');
  });

  await okAsync('内置浏览器：open 导航（WebContentsView IPC）+ 历史', async () => {
    await g(dom, 'BrowserPanel.open("baidu.com")');
    await tick(); await tick();
    assert_(!$(dom, '#browser-panel').classList.contains('hidden'), 'open 显示面板');
    assert_($(dom, '#bw-url').value === 'https://baidu.com', '地址栏规范化, got ' + $(dom, '#bw-url').value);
    assert_(!$(dom, '#browser-view').classList.contains('hidden'), '占位区可见');
    assert_($(dom, '#browser-empty').classList.contains('hidden'), '空状态隐藏');
    assert_(JSON.stringify(calls.viewOpen) === JSON.stringify(['https://baidu.com']), 'viewOpen 收到规范化 URL, got ' + JSON.stringify(calls.viewOpen));
    // 模拟主进程状态回推（导航完成）→ 更新地址栏 + 写历史
    stateCb.browser({ navigated: true, url: 'https://baidu.com', title: '百度', canBack: false, canFwd: false, loading: false });
    await tick();
    assert_($(dom, '#bw-url').value === 'https://baidu.com', '状态回推更新地址栏');
    let his = JSON.parse(dom.window.localStorage.getItem('myide-browser-history'));
    assert_(his.length === 1 && his[0].url === 'https://baidu.com', '导航写入历史');
    stateCb.browser({ navigated: true, url: 'https://github.com', title: 'GitHub' });
    stateCb.browser({ navigated: true, url: 'https://baidu.com', title: '百度' }); // 重复访问 → 去重置顶
    await tick();
    his = JSON.parse(dom.window.localStorage.getItem('myide-browser-history'));
    assert_(his.length === 2 && his[0].url === 'https://baidu.com', '历史去重置顶, got ' + JSON.stringify(his));
    assert_(his[0].title === '百度', '标题随状态更新');
    // 上限 50
    for (let i = 0; i < 60; i++) g(dom, 'BrowserPanel.addHistory("https://x' + i + '.com")');
    his = JSON.parse(dom.window.localStorage.getItem('myide-browser-history'));
    assert_(his.length === 50, '历史上限 50, got ' + his.length);
    await g(dom, 'BrowserPanel.clearHistory()');
    his = JSON.parse(dom.window.localStorage.getItem('myide-browser-history'));
    assert_(his.length === 0, '清空历史');
    // 导航按钮可用性由状态驱动
    stateCb.browser({ navigated: true, url: 'https://baidu.com', canBack: true, canFwd: false });
    await tick();
    assert_(!$(dom, '#bw-back').disabled && $(dom, '#bw-fwd').disabled, 'canBack/canFwd 驱动按钮状态');
  });

  await okAsync('内置浏览器：收藏切换', async () => {
    await g(dom, 'BrowserPanel.open("https://example.com/x")');
    await tick();
    const favBtn = $(dom, '#bw-fav');
    assert_(favBtn.textContent === '☆', '初始未收藏');
    stateCb.browser({ navigated: true, url: 'https://example.com/x', title: 'Example' });
    await tick();
    click(favBtn);
    await tick();
    assert_(favBtn.textContent === '★', '点击后已收藏');
    let favs = JSON.parse(dom.window.localStorage.getItem('myide-browser-favs'));
    assert_(favs.some((f) => f.url === 'https://example.com/x'), '收藏写入 localStorage');
    click(favBtn);
    await tick();
    assert_(favBtn.textContent === '☆', '再次点击取消收藏');
    favs = JSON.parse(dom.window.localStorage.getItem('myide-browser-favs'));
    assert_(!favs.some((f) => f.url === 'https://example.com/x'), '收藏已移除');
    // 错误状态 → 错误占位页
    stateCb.browser({ err: 'ERR_NAME_NOT_RESOLVED' });
    await tick();
    assert_(!$(dom, '#browser-error').classList.contains('hidden'), '加载失败显示错误页');
    assert_($(dom, '#bw-err-msg').textContent.includes('ERR_NAME_NOT_RESOLVED'), '错误信息展示');
    await g(dom, 'BrowserPanel.hide()');
  });

  await okAsync('HTML 内置浏览器打开按钮', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/page.html")');
    await tick(); await tick();
    const btn = $allIn($(dom, '.viewer-toolbar'), 'button').find((b) => b.textContent.includes('内置浏览器'));
    assert_(btn, '内置浏览器按钮存在');
    calls.viewOpen = [];
    click(btn);
    await tick(); await tick();
    assert_(!$(dom, '#browser-panel').classList.contains('hidden'), '点击打开内置浏览器面板');
    assert_($(dom, '#bw-url').value.startsWith('file:///') && $(dom, '#bw-url').value.includes('page.html'), '加载 file URL, got ' + $(dom, '#bw-url').value);
    assert_((calls.viewOpen || []).some((u) => String(u).startsWith('file:///') && u.includes('page.html')), 'viewOpen 收到 file URL, got ' + JSON.stringify(calls.viewOpen));
    await g(dom, 'BrowserPanel.hide()');
  });

  await okAsync('侧栏收起时点击工具项：自动展开侧栏', async () => {
    await g(dom, 'App.switchTool("project")'); // 归一化起点
    await g(dom, 'App.toggleSidebar(true)');
    assert_(dom.window.document.body.classList.contains('sidebar-collapsed'), '侧栏已收起');
    click($(dom, '#tool-outline'));
    await tick();
    assert_(!dom.window.document.body.classList.contains('sidebar-collapsed'), '点击工具项自动展开侧栏');
    assert_(!$(dom, '#panel-outline').classList.contains('hidden'), '大纲面板显示');
    // 未收起时再点一次 → 收起面板（互斥点击行为保留）
    click($(dom, '#tool-outline'));
    await tick();
    assert_($(dom, '#panel-outline').classList.contains('hidden'), '再点一次收起面板');
    // 面板收起 + 侧栏整体收起时点击当前工具 → 只展开侧栏，不进入收起分支
    await g(dom, 'App.toggleSidebar(true)');
    click($(dom, '#tool-project'));
    await tick();
    assert_(!dom.window.document.body.classList.contains('sidebar-collapsed'), '点击激活项也展开侧栏');
    assert_(!$(dom, '#panel-project').classList.contains('hidden'), '项目面板显示');
  });

  await okAsync('打开文件时浏览器让位（切回编辑区）', async () => {
    await g(dom, 'App.showTool("browser")');
    await tick();
    assert_(!$(dom, '#browser-panel').classList.contains('hidden'), '浏览器面板打开');
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    assert_($(dom, '#browser-panel').classList.contains('hidden'), '打开文件后浏览器让位');
    assert_(!$(dom, '#tool-browser').classList.contains('active'), '按钮取消高亮');
    await g(dom, 'App.switchTool("project")'); // 归一化收尾
  });

  await okAsync('工具窗口状态按项目记忆（互不串扰）', async () => {
    dom.window.localStorage.setItem('myide-tool-state:C:/tsA', JSON.stringify({ activeTool: 'outline', sideTool: 'outline' }));
    await g(dom, 'App.setRoot("C:/tsA")');
    await tick(); await tick();
    assert_(!$(dom, '#panel-outline').classList.contains('hidden'), '项目A恢复大纲面板');
    await g(dom, 'App.setRoot("C:/tsB")');
    await tick(); await tick();
    assert_($(dom, '#panel-outline').classList.contains('hidden'), '项目B默认不显示大纲');
    assert_(!$(dom, '#panel-project').classList.contains('hidden'), '项目B默认项目面板');
    // B 切到大纲 → A/B 各自记忆互不覆盖
    await g(dom, 'App.switchTool("outline")');
    await g(dom, 'App.setRoot("C:/tsA")');
    await tick(); await tick();
    assert_(!$(dom, '#panel-outline').classList.contains('hidden'), 'A 仍是大纲');
    await g(dom, 'App.setRoot("C:/tsB")');
    await tick(); await tick();
    assert_(!$(dom, '#panel-outline').classList.contains('hidden'), 'B 记住自己切到大纲');
    // 收尾：回到 P / 项目面板；关掉两个测试假项目并清理最近打开记录（不污染后续用例）
    await g(dom, 'App.switchTool("project")');
    await g(dom, 'App.setRoot("' + P + '")');
    await tick();
    for (const t of ['C:/tsA', 'C:/tsB']) {
      const btn = $allIn($(dom, '#project-bar'), '.proj-btn').find((b) => b.dataset.path === t);
      if (btn) { click(btn.querySelector('.proj-close')); await tick(); }
    }
    try {
      const rec = JSON.parse(dom.window.localStorage.getItem('myide-recent-projects') || '[]')
        .filter((x) => x !== 'C:/tsA' && x !== 'C:/tsB');
      dom.window.localStorage.setItem('myide-recent-projects', JSON.stringify(rec));
    } catch {}
  });

  await okAsync('自动保存：停止输入 3 秒后写盘', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/notes.txt")');
    await tick(); await tick();
    g(dom, 'Viewer.cm.setValue("autosave content")');
    await new Promise((r) => setTimeout(r, 3400));
    assert_(FAKE_FS[P + '/notes.txt'].content === 'autosave content', '自动保存写入');
    assert_(g(dom, 'Viewer.activeTab.dirty') === false, '自动保存后不再 dirty');
  });

  await okAsync('Markdown 模式全局统一：切换模式后新开 md 沿用', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/README.md")');
    await tick(); await tick();
    // 切到「◉ 预览」
    click($allIn($(dom, '.viewer-toolbar'), 'button').find((b) => b.textContent.includes('◉ 预览')));
    await tick();
    assert_($(dom, '.md-view'), '切到预览模式');
    // 打开另一个 md → 应保持预览模式（不重置回 live）
    await g(dom, 'Viewer.openFile("' + P + '/link.md")');
    await tick(); await tick();
    assert_(g(dom, 'Viewer.activeTab.mode') === 'preview', '新开 md 沿用全局模式 preview, got ' + g(dom, 'Viewer.activeTab.mode'));
    // 恢复 live（末尾清理，不影响其他用例）
    dom.window.localStorage.setItem('myide-md-mode', 'live');
  });

  await okAsync('关闭最后一个项目：目录树清空 + 回到空状态', async () => {
    // 逐个移除剩余项目（最后一个移除时无剩余项目 → 清空树回到空状态）
    let guard = 0;
    while ($allIn($(dom, '#project-bar'), '.proj-btn').length && guard++ < 6) {
      const b = $allIn($(dom, '#project-bar'), '.proj-btn')[0];
      const x = b.querySelector('.proj-close');
      if (!x) break;
      click(x);
      await tick(); await tick(); await tick();
    }
    assert_($allIn($(dom, '#project-bar'), '.proj-btn').length === 0, '项目全部移除');
    assert_($allIn($(dom, '#tree'), '.tree-row').length === 0, '目录树已清空');
    assert_($(dom, '#empty-state') && $(dom, '#empty-state').classList.contains('visible'), '空状态显示');
  });

  await okAsync('关闭全部项目后空状态显示最近项目（一键重开）', async () => {
    // 前一组已全部关闭：空状态应出现「最近项目」按钮（历史来自 pushRecent）
    // 注：doRemove 修复后，关闭当前项目切换到剩余项目也会记入历史 → 大项目测试的 C:/big 可能在最前
    const recBtns = $allIn($(dom, '#empty-recent'), '.proj-btn');
    assert_(recBtns.length >= 1, '空状态显示最近项目按钮, got ' + recBtns.length);
    const known = [P, 'C:/proj2', 'C:/big'];
    assert_(known.includes(recBtns[0].title), '历史含已关闭项目: ' + recBtns[0].title);
    // 点击历史按钮重新打开项目（用 App.root 断言：大项目虚拟滚动下 .root-path 元素可能不在可视窗口）
    const t = recBtns[0].title;
    click(recBtns[0]);
    await tick(); await tick(); await tick();
    assert_(g(dom, 'App.root') === t, '点击历史重新打开项目: ' + g(dom, 'App.root'));
    // 清理：再关掉，回到空状态供后续用例
    const b = $allIn($(dom, '#project-bar'), '.proj-btn')[0];
    const x = b && b.querySelector('.proj-close');
    if (x) { click(x); await tick(); await tick(); await tick(); }
  });

  await okAsync('目录树三态隐藏按钮：文字标识当前视角', async () => {
    const btn = $(dom, '#tree-hide-mode');
    assert_(btn, '三态按钮存在');
    assert_(btn.textContent === '常规', '默认视角显示「常规」, got ' + btn.textContent);
    assert_(btn.classList.contains('hm-normal'), '常规态样式类');
    click(btn); await tick();
    assert_(btn.textContent === '仅隐藏', '切换后显示「仅隐藏」, got ' + btn.textContent);
    assert_(btn.classList.contains('hm-hidden'), '仅隐藏态样式类');
    click(btn); await tick();
    assert_(btn.textContent === '全部', '再切显示「全部」, got ' + btn.textContent);
    assert_(btn.classList.contains('hm-all'), '全部态样式类');
    click(btn); await tick();
    assert_(btn.textContent === '常规', '回到常规');
  });

  await okAsync('弹窗打开时方向键归弹窗：设置页 ↑↓ 切换分类', async () => {
    await g(dom, 'App.setRoot("' + P + '")');
    await tick(); await tick();
    // 树选中一行（无弹窗时方向键归目录树）
    const row = $$(dom, '.tree-row')[0];
    if (row) click(row);
    // 打开设置
    key(dom, 's', { ctrl: true, alt: true });
    await tick();
    const box = $(dom, '#set-box');
    assert_(box, '设置面板打开');
    const activeCat = () => $allIn(box, '.set-cat').find((c) => c.classList.contains('active'));
    assert_(activeCat() && activeCat().dataset.cat === 'keys', '默认快捷键分类');
    // 按 ↓：应切到「外观」且目录树选中不被方向键滚动（树不接管）
    key(dom, 'ArrowDown');
    await tick();
    assert_(activeCat() && activeCat().dataset.cat === 'font', '↓ 切到外观分类, got ' + (activeCat() && activeCat().dataset.cat));
    key(dom, 'ArrowDown');
    await tick();
    assert_(activeCat() && activeCat().dataset.cat === 'git', '↓ 再切到 Git 分类');
    key(dom, 'ArrowUp');
    await tick();
    assert_(activeCat() && activeCat().dataset.cat === 'font', '↑ 切回外观分类');
    // 关闭设置
    key(dom, 'Escape');
    await tick();
    assert_(!$(dom, '#set-box'), '设置已关闭');
  });

  await okAsync('数据库工具双区布局：连接/表在侧栏，数据/SQL 在右侧', async () => {
    // 预存一个连接配置；重新 init 让 DbPanel 读到（模块 conns 在 init 时从 localStorage 载入）
    dom.window.localStorage.setItem('myide-db-conns', JSON.stringify([{ name: '测试库', type: 'sqlite', file: 'C:/t.db' }]));
    await g(dom, 'DbPanel.init()');
    await g(dom, 'App.switchTool("db")');
    await tick();
    const side = $(dom, '#panel-db');
    const main = $(dom, '#db-panel');
    assert_(side && !side.classList.contains('hidden'), '侧栏 panel-db 可见');
    assert_(main && !main.classList.contains('hidden'), '右侧 db-panel 可见');
    assert_($(dom, '#tool-db').classList.contains('active'), '工具条按钮高亮');
    // 连接管理 + 表列表在侧栏内
    assert_(side.contains($(dom, '#db-conn-select')), '连接选择器在侧栏');
    assert_(side.contains($(dom, '#db-connect-btn')), '连接按钮在侧栏');
    assert_(side.contains($(dom, '#db-status')), '状态指示在侧栏');
    assert_(side.contains($(dom, '#db-tables')), '表列表在侧栏');
    // 数据表格 + SQL 在右侧主区
    assert_(main.contains($(dom, '#db-data')), '数据表格在右侧');
    assert_(main.contains($(dom, '#db-sql')), 'SQL 区在右侧');
    assert_(main.contains($(dom, '#db-close')), '关闭按钮在右侧');
    // 连接 → 侧栏渲染表列表
    const sel = $(dom, '#db-conn-select');
    assert_(sel.options.length >= 2, '连接选择器含已存连接 + 新建项, got ' + sel.options.length);
    click($(dom, '#db-connect-btn'));
    await tick(); await tick();
    const items = $allIn($(dom, '#db-tables'), '.db-table-item');
    assert_(items.length === 2, '连接后侧栏显示表列表, got ' + items.length);
    assert_($(dom, '#db-status').textContent.includes('测试库'), '状态显示连接名');
    // 点表 → 右侧渲染数据表格
    click(items[0]);
    await tick(); await tick();
    const cells = $allIn($(dom, '#db-data'), 'table.db-grid td');
    assert_(cells.length >= 3, '右侧渲染数据单元格, got ' + cells.length);
    // 切回项目工具：双区同时隐藏
    await g(dom, 'App.switchTool("project")');
    await tick();
    assert_($(dom, '#panel-db').classList.contains('hidden'), '切走后侧栏隐藏');
    assert_($(dom, '#db-panel').classList.contains('hidden'), '切走后右侧隐藏');
    assert_(!$(dom, '#panel-project').classList.contains('hidden'), '项目面板恢复显示');
  });

  await okAsync('数据库：结构标签（列定义 + DDL）与 SQL 编辑器', async () => {
    await g(dom, 'App.switchTool("db")');
    await tick();
    const items = $allIn($(dom, '#db-tables'), '.db-table-item');
    if (items.length) { click(items[0]); await tick(); await tick(); }
    // 结构标签：列定义表 + DDL 文本
    click($(dom, '#db-tab-ddl'));
    await tick(); await tick();
    assert_(!$(dom, '#db-ddl').classList.contains('hidden'), '结构标签页可见');
    const ddlPre = $(dom, '#db-ddl .db-ddl-pre');
    assert_(ddlPre && ddlPre.textContent.includes('CREATE TABLE'), '结构页显示 DDL');
    assert_($allIn($(dom, '#db-ddl'), 'table.db-grid th').length >= 4, '结构页列定义表');
    // SQL 标签：编辑器容器 + 运行按钮
    // 禁用 CodeEditor 并移除预建的 wrap，强制 renderSql 走 textarea 回退路径（可注入值测 EXPLAIN/历史）
    const savedCE = dom.window.CodeEditor;
    dom.window.CodeEditor = undefined;
    const oldWrap = $(dom, '#db-sql-input-wrap');
    if (oldWrap) oldWrap.remove();
    click($(dom, '#db-tab-sql'));
    await tick();
    await tick();
    assert_(!$(dom, '#db-sql').classList.contains('hidden'), 'SQL 标签页可见');
    assert_($(dom, '#db-sql-input-wrap'), 'SQL 编辑器容器存在');
    assert_($(dom, '#db-sql-run'), '运行按钮存在');
    assert_($(dom, '#db-sql-explain'), 'EXPLAIN 按钮存在');
    assert_($(dom, '#db-sql-history'), '历史按钮存在');
    // EXPLAIN：填入 SELECT 后结果区渲染计划表格
    const ta = $(dom, '#db-sql-input');
    if (ta) ta.value = 'SELECT * FROM users';
    click($(dom, '#db-sql-explain'));
    await tick(); await tick();
    assert_($(dom, '#db-sql-result table.db-grid'), 'EXPLAIN 结果渲染表格');
    // 查询历史：运行后记录 + 历史弹窗可打开并载入
    click($(dom, '#db-sql-run'));
    await tick(); await tick();
    click($(dom, '#db-sql-history'));
    await tick();
    const qhItems = dom.window.document.querySelectorAll('.qh-item');
    assert_(qhItems.length >= 1, '历史弹窗列出执行记录, got ' + qhItems.length);
    click(qhItems[0]);
    await tick();
    assert_($(dom, '#db-sql-input') && $(dom, '#db-sql-input').value.includes('SELECT'), '点击历史载入编辑器');
    dom.window.CodeEditor = savedCE; // 恢复
    // ER 图：表节点 + FK 连线 + 工具栏
    click($(dom, '#db-tab-er'));
    await tick(); await tick(); await tick();
    assert_(!$(dom, '#db-er').classList.contains('hidden'), 'ER 图标签页可见');
    assert_($(dom, '#db-er .er-canvas'), 'ER 画布存在');
    const nodes = dom.window.document.querySelectorAll('#db-er g.er-node');
    assert_(nodes.length === 2, 'ER 渲染 2 个表节点, got ' + nodes.length);
    const edges = dom.window.document.querySelectorAll('#db-er path.er-edge');
    assert_(edges.length === 1, 'ER 渲染 1 条 FK 连线, got ' + edges.length);
    assert_($(dom, '#er-relayout') && $(dom, '#er-fit'), 'ER 工具栏按钮（布局/适应窗口）');
    // 切回数据标签
    click($(dom, '#db-tab-data'));
    await tick();
    assert_(!$(dom, '#db-data-wrap').classList.contains('hidden'), '数据标签页可见');
    await g(dom, 'App.switchTool("project")');
  });

  console.log('');
  console.log('结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
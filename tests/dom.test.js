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
};
const FAKE_GIT = {
  changed: [
    { file: 'README.md', status: 'modified', label: '已修改' },
    { file: 'data.csv', status: 'added', label: '已新增' },
  ],
  commits: [
    { oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', short: 'aaaaaaa', message: '第二次提交：改文档', fullMessage: '第二次提交：改文档', author: 'me', timestamp: Date.now() - 3600e3, parents: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] },
    { oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', short: 'bbbbbbb', message: '首次提交', fullMessage: '首次提交', author: 'me', timestamp: Date.now() - 7200e3, parents: [] },
  ],
};
const calls = { copy: [], commit: [], commitFiles: [], diffWorkdir: [], diffCommit: [] };

function makeDom() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///D:/proj/renderer/index.html' });
  const w = dom.window;
  w.myIDE = {
    fs: {
      openFolder: async () => P,
      getRecent: async () => null,
      setRecent: async () => {},
      readDir: async (p) => (FAKE_FS[p] ? FAKE_FS[p].children.map((c) => ({ name: c.split('/').pop(), type: FAKE_FS[c].type, path: c })) : []),
      readFile: async (p) => (FAKE_FS[p] ? { content: FAKE_FS[p].content } : { error: 'not found' }),
      writeFile: async (p, content) => { if (FAKE_FS[p]) FAKE_FS[p].content = content; return { ok: true }; },
      rename: async () => ({ ok: true }),
      remove: async () => ({ ok: true }),
    },
    shell: { showInFolder: async () => {} },
    clip: { copy: async (t) => { calls.copy.push(t); return true; } },
    git: {
      init: async () => ({ ok: true }),
      status: async () => ({ isRepo: true, root: P, branch: 'main', changed: FAKE_GIT.changed }),
      log: async () => ({ isRepo: true, root: P, branch: 'main', commits: FAKE_GIT.commits }),
      commit: async (d, o) => { calls.commit.push(o); return { ok: true, oid: 'cccccccccccccccccccccccccccccccccccccccc' }; },
      diffWorkdir: async (d, f) => { calls.diffWorkdir.push(f); return { file: f, oldText: 'old line\n', newText: 'new line\n', hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, rows: [{ type: 'del', aText: 'old line', bText: '', aNum: 1, bNum: 0 }, { type: 'add', aText: '', bText: 'new line', aNum: 0, bNum: 1 }] }] }; },
      diffCommit: async (d, oid, f) => { calls.diffCommit.push(oid + ':' + f); return { file: f, oldText: 'old\n', newText: 'new\n', hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, rows: [{ type: 'del', aText: 'old', bText: '', aNum: 1, bNum: 0 }, { type: 'add', aText: '', bText: 'new', aNum: 0, bNum: 1 }] }] }; },
      commitFiles: async (d, oid) => { calls.commitFiles.push(oid); return { files: ['README.md', 'data.csv'] }; },
    },
    plugins: {
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
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vendor', 'marked.min.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vendor', 'highlight.min.js'), 'utf8'));
  evalFile('plugin-loader.js');
  evalFile('tree.js');
  evalFile('viewer.js');
  evalFile('git-panel.js');
  evalFile('shortcuts.js');
  evalFile('app.js');
  await g(dom, 'App.init()'); // const 声明不在 window 上，用 eval 访问
  await tick();
}

const $ = (dom, sel) => dom.window.document.querySelector(sel);
const $allIn = (el, sel) => [...el.querySelectorAll(sel)];
const $$ = (dom, sel) => [...dom.window.document.querySelectorAll(sel)];

const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (dom, k, opts = {}) => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ctrlKey: opts.ctrl || false, shiftKey: opts.shift || false }));
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
    assert_($(dom, '#tb-git').textContent.includes('2 处修改'), '工具栏显示修改数');
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
    assert_($allIn($(dom, '#commit-files'), '.cf-check').length === 2, '2 个文件复选框');
    $(dom, '#commit-msg').value = '测试提交信息';
    click($(dom, '#cm-ok'));
    await tick(); await tick();
    assert_(calls.commit.length === 1, '调用了 git.commit');
    assert_(calls.commit[0].message === '测试提交信息', '消息正确');
    assert_(calls.commit[0].files.length === 2, '两个文件被提交');
    assert_($(dom, '#modal-mask').classList.contains('hidden'), '提交后弹窗关闭');
  });

  await okAsync('点击提交历史 → 文件列表弹窗 → diff 视图', async () => {
    click($allIn($(dom, '#git-body'), '.git-commit').find((x) => x.textContent.includes('第二次提交')));
    await tick(); await tick();
    assert_(calls.commitFiles.length >= 1, '调用了 commitFiles');
    assert_($(dom, '#commit-files'), '文件列表弹窗');
    const rows = $allIn($(dom, '#commit-files'), '.commit-file');
    assert_(rows.length === 2, '2 个变更文件');
    click(rows[0]);
    await tick(); await tick();
    assert_($(dom, '.diff-table'), '进入 diff 视图');
    assert_(calls.diffCommit.length >= 1, '调用了 diffCommit');
    assert_(calls.diffCommit[0].startsWith('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:'), '对比的是点击的提交');
  });

  await okAsync('Ctrl+R 刷新（无异常）', async () => {
    key(dom, 'r', { ctrl: true });
    await tick(); await tick();
    ok('Ctrl+R 无异常', () => {});
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
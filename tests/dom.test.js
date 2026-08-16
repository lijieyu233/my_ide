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
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  w.myIDE = {
    fs: {
      openFolder: async () => P,
      getRecent: async () => null,
      setRecent: async () => {},
      readDir: async (p) => (FAKE_FS[p] ? FAKE_FS[p].children.map((c) => ({ name: c.split('/').pop(), type: FAKE_FS[c].type, path: c })) : []),
      listAll: async (root) => ({ files: Object.keys(FAKE_FS).filter((f) => FAKE_FS[f].type === 'file'), truncated: false }),
      grep: async (root, q) => ({ results: [{ file: 'README.md', line: 1, text: '# 标题' }, { file: 'notes.txt', line: 2, text: '关键词命中' }], truncated: false, elapsed: 5 }),
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

  await okAsync('HTML 预览：iframe 渲染', async () => {
    await g(dom, 'Viewer.openFile("' + P + '/page.html")');
    await tick(); await tick();
    const frame = $(dom, '.html-frame');
    assert_(frame, 'iframe 出现');
    assert_(frame.srcdoc.includes('<h1>Hi HTML</h1>'), 'srcdoc 包含内容');
  });

  await okAsync('工具窗口切换：Ctrl+2 大纲 / Ctrl+1 项目 / 再按收起', async () => {
    key(dom, '2', { ctrl: true });
    await tick();
    assert_($(dom, '#panel-project').classList.contains('hidden'), '项目面板隐藏');
    assert_(!$(dom, '#panel-outline').classList.contains('hidden'), '大纲面板显示');
    assert_($(dom, '#tool-outline').classList.contains('active'), '大纲按钮激活');
    key(dom, '1', { ctrl: true });
    await tick();
    assert_(!$(dom, '#panel-project').classList.contains('hidden'), '项目面板恢复');
    key(dom, '1', { ctrl: true });
    await tick();
    assert_($(dom, '#panel-project').classList.contains('hidden'), '再按 Ctrl+1 收起');
    key(dom, '1', { ctrl: true }); // 恢复展开，避免影响后续
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
    const raw = dom.window.localStorage.getItem('myide-session-v1');
    const state = JSON.parse(raw || '{}');
    assert_(!(state.tabs || []).includes(P + '/README.md'), 'dirty 标签未写入, got: ' + JSON.stringify(state.tabs));
    // 清理 dirty 状态（避免影响后续）
    await g(dom, 'Viewer.saveTab(0)');
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
    if (!target) { console.log('DEBUG: 没有找到 .git-file, git-body =', $(dom, '#git-body').innerHTML.slice(0, 300)); }
    click(target);
    await tick(); await tick();
    const sep = $(dom, '.diff-hunk-gap');
    if (!sep) { console.log('DEBUG: #viewer =', $(dom, '#viewer').innerHTML.slice(0, 300)); }
    assert_(sep, 'hunk 分隔行存在');
    assert_(sep.dataset.open === '1', '2 行 hunk 默认展开');
    click(sep);
    await tick();
    const rows = $allIn($(dom, '.diff-table'), 'tr').filter((tr) => tr.querySelector('td.ln'));
    assert_(rows.every((tr) => tr.style.display === 'none'), '折叠后行隐藏');
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
    console.log('DEBUG tabs:', JSON.stringify(g(dom, 'Viewer.openTabs.map(t => t.path)')), 'active:', g(dom, 'Viewer.activeTab && Viewer.activeTab.path'));
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

  await okAsync('toast 提示正常', async () => {
    g(dom, 'MI.toast("测试提示", "ok")');
    await tick();
    assert_($allIn(dom.window.document, '.toast').some((t) => t.textContent.includes('测试提示')), 'toast 出现');
  });

  console.log('');
  console.log('结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
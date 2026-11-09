const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../renderer/git-log.js'), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(fn) { for (let i = 0; i < 150; i++) { if (fn()) return; await wait(10); } throw Error('等待 Git 日志导航超时'); }
const commit = (oid, author = 'Alice') => ({ oid, short: oid, parents: [], message: oid, fullMessage: oid, author, timestamp: 1 });
const history = (...ids) => ({ isRepo: true, commits: ids.map(oid => commit(oid)), branch: 'main', branchHeads: {} });
const comparison = () => ({ aOnly: [], bOnly: [], files: ['A', 'B'].map(file => ({ file, status: 'modified' })) });
function fixture(overrides = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost' });
  const w = dom.window, shown = [], notices = [], calls = { log: [], logFile: [], files: [], diffs: [] };
  let tool = 'project';
  w.MI = { toast: (...args) => notices.push(args), copyText() {} };
  w.App = { getTool: () => tool, showTool(name) { tool = name; if (name === 'log') w.GitLog.open(); } };
  w.GitPanel = { esc: s => String(s), fmtDate: () => '', renderDiffView: (r, label) => shown.push({ r, label }) };
  w.myIDE = { git: Object.assign({
    logGraph: async (root, limit, ref) => { calls.log.push({ root, limit, ref }); return history('a', 'b', 'c'); },
    logFile: async (root, file, limit) => { calls.logFile.push({ root, file, limit }); return history('file-history'); },
    branches: async () => ({ branches: ['main', 'topic'] }),
    commitFiles: async (root, oid) => { calls.files.push({ root, oid }); return { files: [{ file: 'one', status: 'modified' }, { file: 'two', status: 'added' }] }; },
    diffCommit: async (root, oid, file) => { calls.diffs.push({ root, oid, file }); return { file, hunks: [] }; },
    compareRefs: async () => comparison(), diffRefs: async (_root, _a, _b, file) => ({ file, hunks: [] }),
  }, overrides) };
  w.eval(source);
  return { w, dom, shown, notices, calls, setTool: name => { tool = name; }, close: () => w.close() };
}
const last = h => h.shown.at(-1)?.r;
async function open(h) { h.w.GitLog.setRoot('D:/repo'); h.w.App.showTool('log'); await until(() => last(h)?.file === 'one' && !last(h).loading); }
const bar = h => h.w.document.querySelector('.gl-cmp-bar');
const run = h => bar(h).querySelector('button');
const exit = h => bar(h).querySelector('button:last-child');
async function chooseCompare(h) { h.w.document.getElementById('gl-compare').click(); await until(() => bar(h)?.querySelectorAll('option').length === 4); }
async function showCompare(h) { await chooseCompare(h); run(h).click(); await until(() => h.w.document.querySelector('.gl-cmp-summary')); }
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('缓存日志隐藏后文件历史入口自动调用 logFile，并可退出/再次进入同一文件', async () => {
  const h = fixture(); try {
    await open(h); h.w.GitLog.hide(); h.setTool('project');
    h.w.GitLog.showFileHistory('D:/repo/src/one.js');
    await until(() => h.w.document.querySelector('[data-oid="file-history"]'));
    assert.equal(h.calls.logFile.length, 1); assert.equal(h.calls.logFile[0].file, 'src/one.js');
    assert(!h.w.document.querySelector('[data-oid="a"]'));
    await until(() => last(h)?.file === 'one' && !last(h).loading);
    h.w.GitLog.showFileHistory('D:/repo/src/one.js');
    await until(() => h.calls.logFile.length === 2 && h.w.document.querySelector('.gl-row.sel'));
    h.w.document.getElementById('gl-path-chip').click();
    await until(() => h.w.document.querySelector('[data-oid="a"]'));
    assert(h.w.document.getElementById('gl-path-chip').classList.contains('hidden'));
  } finally { h.close(); }
});

test('连续文件查询、隐藏以及换项目拒绝旧历史响应，项目不继承 pathFilter', async () => {
  const held = [], h = fixture({ logFile: (root, file) => { const d = defer(); held.push({ root, file, ...d }); return d.promise; } });
  try {
    await open(h); h.w.GitLog.showFileHistory('first'); h.w.GitLog.showFileHistory(['second', 'third']);
    held[1].resolve(history('new-file')); await until(() => h.w.document.querySelector('[data-oid="new-file"]'));
    held[0].resolve(history('old-file')); await wait(20); assert(!h.w.document.querySelector('[data-oid="old-file"]'));
    h.w.GitLog.showFileHistory('hidden-file'); h.w.GitLog.hide();
    held[2].resolve(history('hidden-response')); await wait(20); assert(!h.w.document.querySelector('[data-oid="hidden-response"]'));
    h.w.GitLog.open(); assert.equal(held.length, 4); h.w.GitLog.setRoot('D:/other');
    await until(() => h.calls.log.at(-1)?.root === 'D:/other'); held[3].resolve(history('wrong-project'));
    await until(() => h.w.document.querySelector('[data-oid="a"]')); assert(!h.w.document.querySelector('[data-oid="wrong-project"]'));
  } finally { h.close(); }
});

test('对比 pending/异常/后端错误保留实用重试和退出控件', async () => {
  const held = [], h = fixture({ compareRefs: () => { const d = defer(); held.push(d); return d.promise; } });
  try {
    await open(h); await chooseCompare(h); run(h).click(); assert(bar(h)); assert(exit(h));
    held[0].reject(Error('worker rejected')); await until(() => h.w.document.getElementById('gl-list').textContent.includes('worker rejected'));
    assert.equal(bar(h).querySelectorAll('select').length, 2);
    run(h).click(); held[1].resolve({ error: 'backend failure' }); await until(() => h.w.document.getElementById('gl-list').textContent.includes('backend failure'));
    run(h).click(); held[2].resolve(comparison()); await until(() => h.w.document.querySelector('.gl-cmp-summary'));
    exit(h).click(); await until(() => h.w.document.querySelector('[data-oid="a"]')); assert(!bar(h));
  } finally { h.close(); }
});

test('分支加载失败可在原操作栏重试', async () => {
  const h = fixture(); try {
    await open(h); let tries = 0;
    h.w.myIDE.git.branches = async () => { if (++tries === 1) throw Error('branches failed'); return { branches: ['main', 'topic'] }; };
    h.w.document.getElementById('gl-compare').click();
    await until(() => h.w.document.getElementById('gl-list').textContent.includes('branches failed'));
    run(h).click(); await until(() => bar(h)?.querySelectorAll('option').length === 4); assert.equal(tries, 2);
  } finally { h.close(); }
});

test('比较文件 A/B 独立 ticket：迟到 A 不覆盖 B，异常在当前 diff 内显示', async () => {
  const held = [], h = fixture({ diffRefs: (_root, a, b, file) => { const d = defer(); held.push({ a, b, file, ...d }); return d.promise; } });
  try {
    await open(h); await showCompare(h);
    const rows = h.w.document.querySelectorAll('#gl-list .gl-dfile'); rows[0].click(); rows[1].click();
    held[1].resolve({ file: 'B', hunks: [] }); await until(() => last(h)?.file === 'B' && !last(h).loading);
    held[0].resolve({ file: 'A', hunks: [] }); await wait(20); assert.equal(last(h).file, 'B');
    assert(rows[1].classList.contains('sel')); rows[0].click(); held[2].reject(Error('diff failed'));
    await until(() => last(h)?.message === 'diff failed'); assert.equal(last(h).file, 'A');
    assert.equal(h.notices.length, 0);
  } finally { h.close(); }
});

test('退出比较隔离在途整对比和文件 diff，恢复普通选择', async () => {
  const request = defer(), diff = defer(), h = fixture({ compareRefs: () => request.promise, diffRefs: () => diff.promise });
  try {
    await open(h); await chooseCompare(h); run(h).click(); exit(h).click();
    await until(() => h.w.document.querySelector('[data-oid="a"]')); request.resolve(comparison()); await wait(20); assert(!bar(h));
    h.w.myIDE.git.compareRefs = async () => comparison(); await showCompare(h);
    h.w.document.querySelector('#gl-list .gl-dfile').click(); exit(h).click();
    await until(() => last(h)?.file === 'one' && !last(h).loading); const count = h.shown.length;
    diff.resolve({ file: 'old-compare', hunks: [] }); await wait(20); assert.equal(h.shown.length, count); assert(!bar(h));
  } finally { h.close(); }
});

test('分支选择请求跨项目迟到无效；整对比项目往返也不能复活', async () => {
  const branch = defer(), compare = defer(), h = fixture(); try {
    await open(h); const normalBranches = h.w.myIDE.git.branches; let first = true;
    h.w.myIDE.git.branches = root => { if (first) { first = false; return branch.promise; } return normalBranches(root); };
    h.w.document.getElementById('gl-compare').click(); h.w.GitLog.setRoot('D:/other');
    await until(() => h.calls.log.at(-1)?.root === 'D:/other'); branch.resolve({ branches: ['stale', 'branch'] });
    await until(() => h.w.document.querySelector('[data-oid="a"]')); assert(!bar(h));
    h.w.myIDE.git.compareRefs = () => compare.promise; await chooseCompare(h); run(h).click();
    h.w.GitLog.setRoot('D:/repo'); h.w.GitLog.setRoot('D:/other');
    await until(() => h.w.document.querySelector('[data-oid="a"]')); compare.resolve(comparison()); await wait(20); assert(!bar(h));
  } finally { h.close(); }
});

test('隐藏隔离分支加载/整对比/文件差异的迟到响应，重新打开自动重跑比较', async () => {
  const h = fixture(); try {
    await open(h); const branch = defer(), normalBranches = h.w.myIDE.git.branches;
    h.w.myIDE.git.branches = () => branch.promise; h.w.document.getElementById('gl-compare').click(); h.w.GitLog.hide();
    branch.resolve({ branches: ['hidden', 'old'] }); await wait(20); assert.equal(bar(h).querySelectorAll('option').length, 0);
    h.w.myIDE.git.branches = normalBranches; h.w.GitLog.open(); await until(() => bar(h)?.querySelectorAll('option').length === 4);
    const compare = defer(); h.w.myIDE.git.compareRefs = () => compare.promise; run(h).click(); h.w.GitLog.hide();
    compare.resolve(comparison()); await wait(20); assert(!h.w.document.querySelector('.gl-cmp-summary'));
    h.w.myIDE.git.compareRefs = async () => comparison(); h.w.GitLog.open(); await until(() => h.w.document.querySelector('.gl-cmp-summary'));
    const diff = defer(); h.w.myIDE.git.diffRefs = () => diff.promise; h.w.document.querySelector('#gl-list .gl-dfile').click();
    h.w.GitLog.hide(); const count = h.shown.length; diff.reject(Error('hidden rejection')); await wait(20); assert.equal(h.shown.length, count);
  } finally { h.close(); }
});

test('普通详情跨项目拒绝迟到文件清单和 diff，保留原有选择缓存隔离', async () => {
  const detail = defer(), diff = defer(), h = fixture(); try {
    await open(h); h.w.myIDE.git.commitFiles = async (root, oid) => root === 'D:/repo' && oid === 'b' ? detail.promise : { files: [{ file: root, status: 'modified' }] };
    h.w.document.querySelector('[data-oid="b"]').click(); await wait(90); h.w.GitLog.setRoot('D:/other');
    await until(() => last(h)?.file === 'D:/other' && !last(h).loading); const count = h.shown.length;
    detail.resolve({ files: [{ file: 'stale-detail', status: 'modified' }] }); await wait(20); assert.equal(h.shown.length, count);
    h.w.myIDE.git.diffCommit = () => diff.promise; h.w.document.querySelector('[data-oid="b"]').click();
    await until(() => last(h)?.file === 'D:/other' && last(h).loading); h.w.GitLog.setRoot('D:/new');
    h.w.myIDE.git.diffCommit = async (_root, _oid, file) => ({ file, hunks: [] });
    await until(() => last(h)?.file === 'D:/new' && !last(h).loading); const after = h.shown.length;
    diff.resolve({ file: 'stale-diff', hunks: [] }); await wait(20); assert.equal(h.shown.length, after);
  } finally { h.close(); }
});

test('紧凑筛选的文本/SVG按同一可见索引，清除恢复全集与原选择/滚动', async () => {
  const h = fixture({ logGraph: async () => ({ ...history(), commits: [commit('a', 'Alice'), commit('b', 'Bob'), commit('c', 'Alice')] }) });
  try {
    await open(h); h.w.document.querySelector('[data-oid="b"]').click(); await wait(90);
    const list = h.w.document.getElementById('gl-list'), search = h.w.document.getElementById('gl-search'), author = h.w.document.getElementById('gl-author'); list.scrollTop = 38;
    search.value = 'b'; search.dispatchEvent(new h.w.Event('input'));
    assert.deepEqual([...list.querySelectorAll('.gl-row')].map(row => row.dataset.oid), ['b']);
    assert.equal(list.querySelector('.gl-svg').getAttribute('height'), '38');
    assert.deepEqual([...list.querySelectorAll('.gl-svg circle')].map(dot => dot.getAttribute('cy')), ['19']);
    assert(list.querySelector('[data-oid="b"]').classList.contains('sel')); assert.equal(list.scrollTop, 38);
    search.value = '/[ac]/i'; search.dispatchEvent(new h.w.Event('input')); author.value = 'alice'; author.dispatchEvent(new h.w.Event('input'));
    assert.deepEqual([...list.querySelectorAll('.gl-row')].map(row => row.dataset.oid), ['a', 'c']);
    assert.equal(list.querySelector('.gl-svg').getAttribute('height'), '76');
    assert.deepEqual([...list.querySelectorAll('.gl-svg circle')].map(dot => dot.getAttribute('cy')), ['19', '57']);
    search.value = ''; author.value = ''; search.dispatchEvent(new h.w.Event('input')); author.dispatchEvent(new h.w.Event('input'));
    assert.equal(list.querySelectorAll('.gl-row').length, 3); assert(list.querySelector('[data-oid="b"]').classList.contains('sel'));
  } finally { h.close(); }
});

test('文件历史真实变化保留第二文件，文件模式比较默认选不同分支且旧比较不能覆盖历史', async () => {
  const h = fixture(); try {
    await open(h); h.w.GitLog.showFileHistory('one');
    await until(() => h.w.document.querySelector('.gl-dhash')?.textContent === 'file-history' && h.w.document.querySelector('.gl-dfile.sel'));
    h.w.document.querySelectorAll('#gl-right .gl-dfile')[1].click(); await until(() => last(h)?.file === 'two' && !last(h).loading);
    const detail = h.w.document.querySelector('.gl-dfiles'), count = h.shown.length;
    h.w.myIDE.git.logFile = async () => history('file-head', 'file-history'); await h.w.GitLog.refresh();
    assert.equal(h.w.document.querySelector('.gl-dfiles'), detail); assert.equal(h.shown.length, count); assert.equal(h.w.document.querySelector('.gl-dfile.sel .nm').textContent, 'two');
    await chooseCompare(h); const selects = bar(h).querySelectorAll('select'); assert.notEqual(selects[0].value, selects[1].value);
    const stale = defer(); h.w.myIDE.git.compareRefs = () => stale.promise; run(h).click();
    h.w.GitLog.showFileHistory('another'); await until(() => h.w.document.querySelector('[data-oid="file-head"]'));
    stale.resolve(comparison()); await wait(20); assert(!bar(h)); assert(h.w.document.querySelector('[data-oid="file-head"]'));
  } finally { h.close(); }
});

test('隐藏的普通历史响应无效，重新打开自动重载且完成被中断的文件选择', async () => {
  const h = fixture(); try {
    await open(h); const delayed = defer(), originalLog = h.w.myIDE.git.logGraph;
    h.w.myIDE.git.logGraph = () => delayed.promise; const refreshing = h.w.GitLog.refresh(); h.w.GitLog.hide();
    delayed.resolve(history('hidden-history')); await refreshing; assert(!h.w.document.querySelector('[data-oid="hidden-history"]'));
    h.w.myIDE.git.logGraph = originalLog; h.w.GitLog.open(); await until(() => h.w.document.querySelector('[data-oid="a"]'));
    const diff = defer(); h.w.myIDE.git.diffCommit = () => diff.promise; h.w.document.querySelectorAll('#gl-right .gl-dfile')[1].click();
    h.w.GitLog.hide(); const count = h.shown.length; diff.resolve({ file: 'two', hunks: [] }); await wait(20); assert.equal(h.shown.length, count);
    h.w.GitLog.open(); await until(() => last(h)?.file === 'two' && !last(h).loading); assert.equal(h.w.document.querySelector('.gl-dfile.sel .nm').textContent, 'two');
  } finally { h.close(); }
});

test('上下键只属于日志列表，不劫编辑器、select、输入和已有处理事件', async () => {
  const h = fixture(); try {
    await open(h); const doc = h.w.document, list = doc.getElementById('gl-list');
    const key = (target, extra = {}) => { const e = new h.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true, ...extra }); target.dispatchEvent(e); return e; };
    const editor = doc.createElement('div'); editor.className = 'cm-editor'; editor.innerHTML = '<div contenteditable="true"><span>edit</span></div>'; doc.body.appendChild(editor);
    for (const target of [doc.body, editor.querySelector('span'), doc.getElementById('gl-ref'), doc.getElementById('gl-search')]) assert(!key(target).defaultPrevented);
    const localSelect = doc.createElement('select'); list.appendChild(localSelect); assert(!key(localSelect).defaultPrevented);
    const editable = doc.createElement('div'); editable.setAttribute('contenteditable', 'true'); editable.innerHTML = '<span>inside</span>'; list.appendChild(editable); assert(!key(editable.firstChild).defaultPrevented);
    assert(!key(list, { ctrlKey: true }).defaultPrevented); const handled = new h.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }); handled.preventDefault(); list.dispatchEvent(handled);
    assert(doc.querySelector('[data-oid="a"]').classList.contains('sel')); assert(key(list).defaultPrevented); assert(doc.querySelector('[data-oid="b"]').classList.contains('sel'));
    const search = doc.getElementById('gl-search'); search.value = '/^[ac] /i'; search.dispatchEvent(new h.w.Event('input')); key(list); assert(doc.querySelector('[data-oid="a"]').classList.contains('sel')); key(list); assert(doc.querySelector('[data-oid="c"]').classList.contains('sel'));
    await chooseCompare(h); assert(!key(list).defaultPrevented);
  } finally { h.close(); }
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('PASS ' + name); }
  console.log(`Git 日志导航：${passed} 组通过 / 0 失败`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

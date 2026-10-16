const fs = require('fs'), path = require('path'), assert = require('assert/strict'), { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let passed = 0;
function fixture() {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8'), { url: 'https://git.test', runScripts: 'outside-only' });
  const w = dom.window, notices = [], calls = [];
  w.MI = { toast: text => notices.push(text), copyText() {} };
  w.App = { updateStatusbar() {}, showTool: tool => calls.push(tool), getTool: () => 'git' };
  w.Viewer = { openTabs: [] }; w.Tree = { setGitStatus() {} };
  w.Modal = { show: box => { w.document.querySelector('#br-box')?.remove(); w.document.body.append(box); }, hide() {}, confirm: async () => false };
  w.myIDE = { readFile: async () => ({ error: 'missing' }), git: new Proxy({
    status: async () => ({ isRepo: true, root: 'C:/repo', branch: 'dev', completeness: 'complete', changed: [{ file: 'src/a.txt', status: 'modified' }] }),
    aheadBehind: async () => ({ ahead: 0, behind: 0 }), opState: async () => ({ state: 'NORMAL' }), conflicts: async () => ({ files: [] }),
    listRemotes: async () => ({ remotes: [{ name: 'origin', url: 'https://user:secret@git.test/repo.git', branches: [] }] })
  }, { get: (target, key) => target[key] || (async () => ({ ok: true })) }) };
  w.eval(fs.readFileSync(path.join(__dirname, '../renderer/git-panel.js'), 'utf8')); w.GitPanel.rootDir = 'C:/repo';
  return { w, notices, calls, q: selector => w.document.querySelector(selector) };
}
async function test(name, run) {
  const f = fixture(); try { await f.w.GitPanel.refresh(); await run(f); passed++; console.log('ok ' + name); } finally { f.w.close(); }
}
(async () => {
  await test('菜单展开收起、历史、显示选项及刷新实际执行', async ({ w, q, calls }) => {
    const choose = async label => { q('#cd-tools-more').click(); const item = [...w.document.querySelectorAll('#git-float-menu .ctx-item')].find(x => x.textContent === label); assert(item, label); item.click(); await tick(); };
    await choose('收起全部'); assert([...w.document.querySelectorAll('.git-sec-body')].every(x => x.style.display === 'none'));
    await choose('展开全部'); assert([...w.document.querySelectorAll('.git-sec-body')].some(x => x.style.display !== 'none'));
    await choose('提交历史'); assert(calls.includes('log')); await choose('显示选项'); assert(q('#git-float-menu').textContent.includes('分组'));
    let confirmed = false, discarded = false;
    w.Modal.confirm = async () => { confirmed = true; return false; }; w.myIDE.git.discardFiles = async () => { discarded = true; return { ok: 1, failed: [] }; };
    await choose('放弃改动'); assert(confirmed); assert(!discarded);
    await choose('搁置改动'); assert(q('#sv-box'));
    q('#cd-tools-more').click(); const menu = q('#git-float-menu'); menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert(!q('#git-float-menu'));
    q('#cd-tools-more').click(); const oldItem = [...w.document.querySelectorAll('#git-float-menu .ctx-item')].find(x => x.textContent === '提交历史');
    const count = calls.length; w.GitPanel.rootDir = 'C:/other'; oldItem.click(); assert.equal(calls.length, count); assert(!q('#git-float-menu')); w.GitPanel.rootDir = 'C:/repo'; await w.GitPanel.refresh();
    let refreshed = false; w.myIDE.git.status = async () => { refreshed = true; return { isRepo: true, changed: [], completeness: 'complete' }; }; await q('#cd-refresh').onclick(); assert(refreshed);
  });
  await test('差异读取勾选文件并展示正文，异常有反馈且恢复按钮', async ({ w, q, notices }) => {
    const cb = q('.cf-check'); cb.checked = true; cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    let read = false; w.myIDE.git.diffUnstaged = async (root, file) => { assert.equal(root, 'C:/repo'); assert.equal(file, 'src/a.txt'); read = true; return { file, oldText: '旧正文', newText: '新正文', hunks: [{ oldStart: 1, newStart: 1, rows: [{ type: 'del', aNum: 1, aText: '旧正文' }, { type: 'add', bNum: 1, bText: '新正文' }] }] }; };
    await q('#cd-diff').onclick(); assert(read); assert(q('.diff-wrap').textContent.includes('旧正文')); assert(q('.diff-wrap').textContent.includes('新正文'));
    w.myIDE.git.diffUnstaged = async () => { throw Error('网络 https://user:secret@host/repo'); }; await q('#cd-diff').onclick(); assert(notices.some(t => t.includes('差异读取失败'))); assert(!notices.join().includes('secret')); assert(!q('#cd-diff').disabled); assert(!q('#cd-diff').hasAttribute('aria-busy'));
  });
  await test('远程地址遮蔽密码，跨主机切换保留草稿与已保存认证', async ({ w, q }) => {
    await q('#cd-remote').onclick(); assert(!q('#br-box').textContent.includes('secret')); assert(q('#rm-auth-summary').textContent.includes('地址或系统')); assert(!q('#rm-auth').open); assert(q('#rm-add-form').hidden);
    q('.rm-config').click(); assert(q('#rm-auth').open); q('#rm-user').value = 'alice'; q('#rm-pass').value = 'draft-one';
    const host = h => { q('#rm-host').value = h; q('#rm-host').dispatchEvent(new w.Event('change')); };
    host('other.test'); q('#rm-user').value = 'bob'; q('#rm-pass').value = 'draft-two'; host('git.test'); assert.equal(q('#rm-pass').value, 'draft-one');
    q('#rm-auth-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); host('other.test'); assert.equal(q('#rm-pass').value, 'draft-two'); host('git.test'); assert.equal(q('#rm-user').value, 'alice'); assert(q('#rm-auth-note').textContent.includes('已保存'));
    assert.equal(JSON.parse(w.localStorage.getItem('myide-git-auth-map'))['git.test'].password, 'draft-one');
  });
  await test('添加与移除调用正确仓库，切项目后旧弹窗失效', async ({ w, q }) => {
    let remotes = [{ name: 'origin', url: 'https://git.test/repo', branches: [] }], added = 0, removed = 0;
    w.myIDE.git.listRemotes = async () => ({ remotes });
    w.myIDE.git.addRemote = async (root, r) => { assert.equal(root, 'C:/repo'); added++; remotes = [...remotes, { ...r, branches: [] }]; return { ok: true }; };
    w.myIDE.git.removeRemote = async (root, name) => { assert.equal(root, 'C:/repo'); removed++; remotes = remotes.filter(r => r.name !== name); return { ok: true }; };
    await q('#cd-remote').onclick(); q('#rm-toggle-add').click(); q('#rm-name').value = 'backup'; q('#rm-url').value = 'https://backup.test/repo'; await q('#rm-add-form').onsubmit({ preventDefault() {} }); assert.equal(added, 1); assert.equal(w.document.querySelectorAll('.rm-item').length, 2);
    w.Modal.confirm = async () => true; await w.document.querySelectorAll('.rm-del')[1].onclick(); assert.equal(removed, 1); assert.equal(w.document.querySelectorAll('.rm-item').length, 1);
    w.GitPanel.rootDir = 'C:/other'; await q('.rm-del').onclick(); assert.equal(removed, 1); await q('#rm-add-form').onsubmit({ preventDefault() {} }); assert.equal(added, 1);
  });
  await test('保存失败不报告成功，删除确认期间切项目不执行', async ({ w, q, notices }) => {
    await q('#cd-remote').onclick(); q('#rm-user').value = 'user'; w.Storage.prototype.setItem = () => { throw Error('disk full'); }; q('#rm-auth-form').dispatchEvent(new w.Event('submit', { cancelable: true })); assert(notices.some(t => t.includes('保存失败'))); assert(!notices.some(t => t.startsWith('已保存')));
    let removed = false; w.myIDE.git.removeRemote = async () => { removed = true; return { ok: true }; }; w.Modal.confirm = async () => { w.GitPanel.rootDir = 'C:/other'; return true; }; await q('.rm-del').onclick(); assert(!removed);
  });
  console.log('Git操作入口 ' + passed + ' 通过 / 0 失败');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

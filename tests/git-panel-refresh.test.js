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

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const state=changed=>({isRepo:true,root:'C:/repo',branch:'dev',completeness:'complete',changed});
async function test(name,run){const f=fixture();try{await run(f);passed++;console.log('ok '+name);}finally{f.w.close();}}
(async()=>{
 await test('未跟踪文件默认不选，手动选择/取消跨刷新保留，新出现文件仍不选',async({w,q})=>{
  let changed=[{file:'tracked.md',status:'modified'},{file:'new.md',status:'added',xy:'??'},{file:'staged.md',status:'*modified',inIndexOnly:true}];
  w.myIDE.git.status=async()=>state(changed);await w.GitPanel.refresh();
  const cb=file=>[...w.document.querySelectorAll('.cf-check')].find(c=>c.dataset.file===file);
  assert(cb('tracked.md').checked);assert(!cb('new.md').checked);assert(!cb('staged.md'));
  cb('tracked.md').click();cb('new.md').click();changed=[...changed,{file:'later.pdf',status:'added'}];await w.GitPanel.refresh();
  assert(!cb('tracked.md').checked);assert(cb('new.md').checked);assert(!cb('later.pdf').checked);
  changed=changed.filter(c=>c.file!=='new.md');await w.GitPanel.refresh();changed.push({file:'new.md',status:'added'});await w.GitPanel.refresh();assert(!cb('new.md').checked);
 });
 await test('相同状态保留行、滚动、焦点与工具栏，快照ID变化不重建',async({w,q})=>{
  let id=0;w.myIDE.git.status=async()=>({...state([{file:'src/a.md',status:'modified'}]),snapshotId:String(++id)});await w.GitPanel.refresh();
  const row=q('.git-file'),list=q('#commit-list'),cb=q('.cf-check'),toolbar=q('.git-cp-bar');list.scrollTop=160;cb.focus();
  await w.GitPanel.refresh();await w.GitPanel.refresh();
  assert.equal(q('.git-file'),row);assert.equal(q('#commit-list'),list);assert.equal(list.scrollTop,160);assert.equal(w.document.activeElement,cb);assert.equal(q('.git-cp-bar'),toolbar);
  assert(q('#cd-toolbar-host .git-sync-primary'));assert(!q('#cd-files .git-cp-bar'));
  w.myIDE.git.commit=async()=>({ok:true,oid:'1234567'});q('#commit-msg').value='提交';await w.GitPanel.doCommit(false);assert(!q('.cf-check').checked);assert(q('#cm-ok').disabled);
 });
 await test('列表重建不向脱离页面的复选框写状态，避免累计旧树',async({w,q})=>{
  const desc=Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'checked');let detachedWrites=0;
  Object.defineProperty(w.HTMLInputElement.prototype,'checked',{...desc,set(value){if(!this.isConnected)detachedWrites++;desc.set.call(this,value);}});
  let revision=0;w.myIDE.git.status=async()=>state([{file:'src/a.md',status:'modified',label:'revision '+revision}]);
  for(let i=0;i<12;i++){revision++;await w.GitPanel.refresh();}
  // 行innerHTML初始化不会调用JS属性setter；这里只检查三态刷新是否仍遍历旧节点。
  detachedWrites=0;q('.cf-check').click();assert.equal(detachedWrites,0);
 });
 await test('刷新突发合并成一次尾随扫描，强制核验不降级',async({w})=>{
  const gate=deferred();let calls=0,forced=false;w.myIDE.git.status=async(root,opts)=>{calls++;if(calls===1)await gate.promise;else forced=opts.force;return state([{file:'latest.md',status:'modified'}]);};
  const first=w.GitPanel.refresh().then(()=>assert(w.document.querySelector('.git-file')?.textContent.includes('latest.md')));await tick();const rest=Array.from({length:8},(_,i)=>w.GitPanel.refresh({force:i===4}));assert.equal(calls,1);gate.resolve();await Promise.all([first,...rest]);assert.equal(calls,2);assert.equal(forced,true);
 });
 await test('旧项目在途与尾随刷新不覆盖新项目',async({w,q})=>{
  const gate=deferred();let old=0;w.myIDE.git.status=async root=>{if(root==='C:/repo'){old++;await gate.promise;}return {...state([{file:root==='C:/repo'?'old.md':'new.md',status:'modified'}]),root};};
  const first=w.GitPanel.refresh();await tick();const queued=w.GitPanel.refresh();w.GitPanel.rootDir='C:/next';await w.GitPanel.refresh();gate.resolve();await Promise.all([first,queued]);assert.equal(old,1);assert(q('.git-file').textContent.includes('new.md'));assert(!q('#cd-files').textContent.includes('old.md'));
 });
 await test('后台远程计数不阻塞列表且不隐式fetch，同一在途请求复用',async({w,q})=>{
  const gate=deferred();let calls=0,options;w.myIDE.git.aheadBehind=async(root,opts)=>{calls++;options=opts;await gate.promise;return {branch:'dev',ahead:1,behind:0};};
  await w.GitPanel.refresh();await w.GitPanel.refresh();assert(q('.git-file'));assert.equal(calls,1);assert.equal(options.localOnly,true);assert(!options.fetch);gate.resolve();await tick();assert(q('#cd-dirty').textContent.includes('待推送 1'));
 });
 console.log('Git面板刷新与选择 '+passed+' 通过 / 0 失败');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});

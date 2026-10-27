// 端到端：远程文件编辑弹框的完整链路。
//
// 解决「只跑单测、没跑真链路」的问题。全链路是真的：
//   真实 SSH 服务器 → remote-service → remote-fs 路由 → 真实 fs:* IPC
//   → 真实 Modal 弹框 DOM → CodeMirror 读取 → 改内容 → 保存 → 回读服务器文件校验
//
// 用法：MYIDE_AUTO_TRUST_HOST=1 electron.exe . --check-remote-edit --disable-gpu --no-sandbox
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const { start } = require('../tests/fixtures/remote-ssh');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-e2e-'));
const serverRoot = path.join(home, 'server');
const project = path.join(home, 'project');
fs.mkdirSync(serverRoot, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'a.md'), '# a\n');
const ORIGINAL = 'log.level = "info"\nwebServer.port = 7000\n';
fs.writeFileSync(path.join(serverRoot, 'frps.toml'), ORIGINAL);

const norm = p => p.split(path.sep).join('/');
process.argv.push('--headless');
os.homedir = () => home;
app.setPath('userData', path.join(home, 'profile'));

let win, server, passed = 0;
const check = (name, ok, extra) => {
  if (!ok) throw Error('FAIL: ' + name + (extra !== undefined ? ' | ' + extra : ''));
  passed++; console.log('ok ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const probe = s => win.webContents.executeJavaScript(s, true);
const wait = async s => { for (let n = 0; n < 500; n++) { if (await probe(s)) return; await sleep(30); } throw Error('wait ' + s); };

(async () => {
  try {
    server = await start(serverRoot, {});
    require('../main');
    await app.whenReady();
    for (let n = 0; n < 200 && !BrowserWindow.getAllWindows().length; n++) await sleep(50);
    win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1500, 950); await sleep(500); win.setContentSize(1500, 950);
    await wait('!!window.App&&!!window.Theme&&!!window.RemotePanel&&!!window.CodeEditor');
    await probe(`Theme.set('crimson');App.openProject(${JSON.stringify(norm(project))})`);
    await wait(`App.root===${JSON.stringify(norm(project))}`);

    // ① 真实 IPC 建配置 + 连接。
    // 首次连接会弹「确认主机指纹」模态框，无人点击会挂到 readyTimeout；
    // 自检通过 MYIDE_AUTO_TRUST_HOST=1 让主进程自动接受（见 main.js 的 verifyHost）。
    const connected = await probe(`(async () => {
      const api = window.myIDE.remote;
      const loaded = await api.load();
      const saved = await api.save({
        name: 'E2E', host: '127.0.0.1', port: ${server.port},
        username: 'fixture', auth: 'password', remember: true, password: 'fixture-secret'
      }, loaded.data.version);
      if (!saved.ok) return { error: saved.error };
      const profile = saved.data.profiles.find(p => p.name === 'E2E');
      const session = await api.connect(profile.id);
      return { ok: session.ok, sessionId: session.data?.id, error: session.error };
    })()`);
    check('真实 IPC 连上 SSH fixture', connected?.ok && !!connected.sessionId, connected?.error || ('sid=' + connected.sessionId));
    const sid = connected.sessionId;

    // ② 真实 fs 路由读
    const virtual = await probe(`window.myIDE.remote.virtualPath(${JSON.stringify(sid)}, '/frps.toml')`);
    const read = await probe(`(async () => {
      const r = await window.myIDE.fs.readFile(${JSON.stringify(virtual)});
      // 字段是 content（TextFormat.decodeText 的返回），不是 text
      return { content: r.content, version: r.version, error: r.error };
    })()`);
    check('fs:readFile 经 remote:// 读到服务器原文', read?.content === ORIGINAL, JSON.stringify(read?.content || read?.error));
    check('版本指纹形如 remote:<mtime>:<size>', /^remote:\d+:\d+$/.test(read?.version || ''), read?.version);

    // ③ 先让 RemotePanel 同步到这个会话（真实路径：面板 refresh 会拉 snapshot
    //    并填充 sessions，connected() 依赖它判断）。再开远程面板。
    await probe(`(async () => { await window.RemotePanel.refresh(); })()`);
    await sleep(900);
    const panelState = await probe(`(() => {
      const sel = document.getElementById('remote-sessions');
      return { options: sel ? [...sel.options].map(o => o.value) : null,
               selected: sel?.value, notice: document.getElementById('remote-notice')?.textContent };
    })()`);
    console.log('PANEL_STATE ' + JSON.stringify(panelState));
    // 真实用户会在「连接会话」下拉里选这条会话；自检里代他选中，
    // 让面板的 sid 指过去（openRemoteEditor 依赖 connected()）。
    await probe(`(() => {
      const sel = document.getElementById('remote-sessions');
      if (!sel) return false;
      sel.value = ${JSON.stringify(sid)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()`);
    await sleep(600);

    // ④ 真实弹框：openRemoteEditor 的公开入口
    const opened = await probe(`(async () => {
      await window.RemotePanel.openRemoteEditor({ name: 'frps.toml', path: '/frps.toml', directory: false });
      return true;
    })()`);
    await sleep(900);
    const dlg = await probe(`(() => {
      const box = document.querySelector('.re-box');
      if (!box) return { exists: false };
      const r = box.getBoundingClientRect();
      const cm = box.querySelector('.cm-content');
      return {
        exists: true, w: Math.round(r.width), h: Math.round(r.height),
        title: box.querySelector('.re-title')?.textContent,
        sub: box.querySelector('.re-sub')?.textContent,
        state: box.querySelector('.re-state')?.textContent,
        error: box.querySelector('.re-error')?.textContent || null,
        text: cm ? cm.textContent : (box.querySelector('.re-textarea')?.value ?? null),
        hasSaveBtn: !!box.querySelector('[data-re="save"]'),
        modalStack: Modal.stack.length,
      };
    })()`);
    check('弹框真的出现了', dlg?.exists === true);
    check('弹框尺寸是 1040 级别（不是被压成 560）', dlg.w > 700, dlg.w + '×' + dlg.h);
    check('弹框标题显示文件名', dlg.title === 'frps.toml', dlg.title);
    check('弹框副标题显示远程绝对路径', dlg.sub === '/frps.toml', dlg.sub);
    check('弹框没有报错（canEdit 之类）', !dlg.error, dlg.error || '');
    check('编辑器里是服务器上的原文', (dlg.text || '').includes('webServer.port = 7000'), JSON.stringify((dlg.text || '').slice(0, 60)));
    check('有保存按钮', dlg.hasSaveBtn === true);

    // ④ 改内容 + 保存（点真实按钮）
    const NEWTEXT = 'log.level = "debug"\nwebServer.port = 7000\nauth.token = "changed-by-e2e"\n';
    const savedOk = await probe(`(async () => {
      const box = document.querySelector('.re-box');
      // 用编辑器实例的公开 setValue（EditRemoteBox 把实例挂在 box.__editor 上），
      // 不去碰 CodeMirror 的内部属性 —— 那个挂点在不同版本里不一样。
      const ed = box.__editor;
      if (!ed?.setValue) return { error: 'no editor instance' };
      ed.setValue(${JSON.stringify(NEWTEXT)});
      await new Promise(r => setTimeout(r, 150));
      box.querySelector('[data-re="save"]').click();
      await new Promise(r => setTimeout(r, 1000));
      return { state: box.querySelector('.re-state')?.textContent,
               toast: [...document.querySelectorAll('*')].filter(e=>/保存失败|写入失败|STALE|已被他人/.test(e.textContent||'')&&e.children.length===0).map(e=>e.textContent).slice(0,3) };
    })()`);
    console.log('SAVE_RESULT ' + JSON.stringify(savedOk));
    const onDisk = fs.readFileSync(path.join(serverRoot, 'frps.toml'), 'utf8');
    check('服务器上的文件内容真的变了', onDisk === NEWTEXT, JSON.stringify(onDisk.slice(0, 60)));
    check('保存后没有残留 .part/.bak', !fs.readdirSync(serverRoot).some(n => /\.(part|bak)$/.test(n)));

    // ⑤ 关闭弹框
    const closed = await probe(`(() => {
      const box = document.querySelector('.re-box');
      box.querySelector('[data-re="close"]').click();
      return { stillOpen: !!document.querySelector('.re-box'), stack: Modal.stack.length };
    })()`);
    check('关闭按钮能关掉弹框', closed.stillOpen === false && closed.stack === 0, JSON.stringify(closed));

    // ⑥ 断线后再编辑必须明确报错（不能静默）
    await probe(`(async () => { await window.myIDE.remote.disconnect(${JSON.stringify(sid)}); })()`);
    await sleep(300);
    const afterDisconnect = await probe(`(async () => {
      const r = await window.myIDE.fs.readFile(${JSON.stringify(virtual)});
      return { error: r.error, code: r.errorCode };
    })()`);
    check('断线后读远程文件明确报错', /断开/.test(afterDisconnect?.error || ''), afterDisconnect?.error);

    console.log('\n端到端：' + passed + ' 通过 / 0 失败');
    try { server.close(); } catch {}
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { server?.close(); } catch {}
    app.exit(1);
  }
})();
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
setTimeout(() => { console.error('超时'); app.exit(2); }, 150000).unref();

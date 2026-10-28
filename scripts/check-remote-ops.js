// 运维台 UI 端到端自检：真实点击 → 真实 preload/IPC → 真实 SSH 夹具 → 界面回执
//
// 与 tests/remote-ops-e2e.test.js 的分工（重要）：
//   · tests/remote-ops-e2e.test.js 直接调 service.op()，验证「命令拼装 + 结果解析」
//   · 本脚本从 DOM 按钮点下去，验证「点击 → IPC → 执行 → 回执」整条链路
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { start } = require('../tests/fixtures/remote-ssh');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-ops-ui-'));
const remote = path.join(home, 'server'), output = path.join(__dirname, '..', '.ui-check-trash', 'ops-' + process.pid);
for (const p of [remote, output]) fs.mkdirSync(p, { recursive: true });
os.homedir = () => home;
app.setPath('userData', path.join(home, 'profile'));
process.argv.push('--headless');

let win, server, passed = 0; const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const probe = async source => {
  try { return await win.webContents.executeJavaScript(source, true); }
  catch (e) { throw Error(e.message + '\n脚本：' + source + '\n控制台：' + errors.join('\n')); }
};
const check = (name, value) => { assert(value, name); passed++; console.log('ok ' + name); };
const wait = async source => {
  for (let n = 0; n < 400; n++) { if (await probe(source)) return; await sleep(30); }
  throw Error('等待失败：' + source + '\n' + await probe('document.getElementById("remote-notice")?.textContent'));
};

const MARK = '@@MYIDE-OVERVIEW:';
const TAB = String.fromCharCode(9), NL = String.fromCharCode(10);
const overviewOut = [
  MARK + 'os', 'NAME="Ubuntu"', 'VERSION_ID="22.04"', 'PRETTY_NAME="Ubuntu 22.04.5 LTS"',
  MARK + 'kernel', '5.15.0-179-generic', 'x86_64', 'fixture-host', '1700000000',
  MARK + 'cpu', '4', '0.10 0.20 0.30 1/200 1234',
  MARK + 'mem', 'MemTotal: 8000000 kB', 'MemFree: 2000000 kB', 'MemAvailable: 4000000 kB',
  MARK + 'uptime', '3540.12',
  MARK + 'stat', 'cpu  100 0 50 150 0 0 0 0 0 0',
  MARK + 'net', '1000 2000',
  MARK + 'disk', '/dev/vda1  10485760  5242880  5242880  50% /',
  MARK + 'listen', 'tcp   LISTEN 0 128 0.0.0.0:23333 0.0.0.0:* users:(("node",pid=923,fd=3))',
  MARK + 'services', 'docker.service loaded active running Docker Engine',
  MARK + 'docker',
  ['demo-api', 'r/x:1', 'Up 2 days (healthy)'].join(TAB),
  ['stopped-one', 'r/y:1', 'Exited (1) 3 days ago'].join(TAB),
  MARK + 'procs', 'PID %CPU %MEM RSS ELAPSED COMMAND', '923 9.2 0.2 196000 3-12:00 node',
  MARK + 'du', '1048576' + TAB + '/home/fixture/projects',
  MARK + 'end',
].join(NL) + NL;

const nativeDialog = dialog.showMessageBox.bind(dialog);
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  if (options.title === '确认服务器指纹' && options.detail.startsWith('127.0.0.1:')) return { response: 1 };
  return nativeDialog(...args);
};

require('../main');

app.whenReady().then(async () => {
  try {
    server = await start(remote);
    server.control.execReply = [
      { match: '@@MYIDE-OVERVIEW:os', out: overviewOut, code: 0 },
      { match: 'docker system df', out: 'TYPE' + TAB + 'TOTAL' + TAB + 'RECLAIMABLE' + NL + 'Images' + TAB + '166' + TAB + '2.408GB (23%)' + NL, code: 0 },
      { match: 'docker logs --tail', out: 'log-line-1' + NL + 'log-line-2' + NL, code: 0 },
      { match: 'docker restart', out: 'demo-api' + NL, code: 0 },
      { match: 'docker ps --filter', out: 'running Up 1 second' + NL, code: 0 },
      { match: 'apt-get clean', out: '', code: 0 },
      { match: 'du -sh /var/cache/apt', out: '137M' + NL, code: 0 },
      { match: 'journalctl --disk-usage', out: 'Archived and active journals take up 920.0M.' + NL, code: 0 },
    ];

    for (let n = 0; n < 100 && !BrowserWindow.getAllWindows().length; n++) await sleep(50);
    win = BrowserWindow.getAllWindows()[0];
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    await wait('!!window.App && !!window.RemotePanel && !!window.myIDE?.remote');
    win.setContentSize(1280, 850);

    await probe('document.getElementById("tool-remote").click(); undefined;');
    await probe('document.getElementById("remote-add").click()');
    await probe(`(()=>{const f=document.querySelector('.remote-form form');
      const v={name:'运维夹具',host:'127.0.0.1',port:${server.port},username:'fixture',password:'fixture-secret'};
      for(const [k,val] of Object.entries(v)) f.elements[k].value=val;
      f.elements.remember.checked=true; f.requestSubmit()})()`);
    await wait('!document.querySelector(".remote-form") && document.querySelectorAll(".remote-profile").length===1');

    await probe('document.getElementById("remote-connect").click()');
    await wait('!document.getElementById("remote-new-terminal").disabled');
    check('点击连接后建立真实 SSH 会话', await probe('!!document.getElementById("remote-sessions").value'));

    await probe('document.getElementById("remote-tab-overview").click()');
    await wait('document.querySelectorAll(".remote-ops-row").length > 0');
    check('概览页画出运维台行', await probe('document.querySelectorAll(".remote-ops-row").length >= 2'));
    check('Docker 计数来自真实采集',
      await probe('/Docker2/.test(document.querySelector("[data-ops-cat=docker]").textContent)'));

    await probe('[...document.querySelectorAll(".remote-ops-act")].find(b=>b.textContent.trim()==="日志").click()');
    await wait('!!document.querySelector(".remote-drawer")');
    check('点日志打开右侧抽屉', await probe('!!document.querySelector(".remote-drawer")'));
    check('日志内容来自真实 IPC 返回',
      await probe('/log-line-1/.test(document.querySelector(".remote-drawer-lines").textContent)'));
    check('日志带行号', await probe('!!document.querySelector(".remote-drawer-no")'));
    check('日志可级别筛选', await probe('!!document.querySelector(\'[data-drw="level"]\')'));
    check('日志可开启跟随', await probe('!!document.querySelector(\'[data-drw="follow"]\')'));
    await probe('document.querySelector(\'[data-drw="close"]\').click()');
    await wait('!document.querySelector(".remote-drawer")');

    await probe('[...document.querySelectorAll(".remote-ops-act")].find(b=>b.textContent.trim()==="重启").click()');
    await wait('!!document.querySelector(".remote-ops-dlg h3")');
    check('点重启先弹确认框', await probe('/重启容器/.test(document.querySelector(".remote-ops-dlg h3").textContent)'));
    check('确认框写明影响与当前状态',
      await probe('(()=>{const t=document.querySelector(".remote-ops-dlg-body").textContent;return /影响/.test(t)&&/当前状态/.test(t)})()'));

    const before = server.control.execLog.filter(e => e.command.includes('docker restart')).length;
    await probe('document.querySelector(\'.remote-ops-dlg [data-dlg="1"]\').click()');
    await wait('(()=>{const s=document.getElementById("remote-ops-state");return s&&/已执行|执行失败/.test(s.textContent)})()');
    check('确认后真正发出了重启命令',
      server.control.execLog.filter(e => e.command.includes('docker restart')).length === before + 1);
    check('界面回执含退出码',
      await probe('/退出码 0/.test(document.getElementById("remote-ops-state").textContent)'));
    check('界面回执含状态回读',
      await probe('/回读：running/.test(document.getElementById("remote-ops-state").textContent)'));

    check('已停止容器显示启动按钮',
      await probe(`(()=>{const rows=[...document.querySelectorAll('.remote-ops-row')];
        const stopped=rows.find(r=>/stopped-one/.test(r.textContent));
        return !!stopped && [...stopped.querySelectorAll('.remote-ops-act')].some(b=>b.textContent.trim()==='启动')})()`));

    await probe('document.querySelector(\'[data-ops-cat="disk"]\').click()');
    await wait('document.querySelectorAll(".remote-ops-row").length >= 4');
    check('磁盘分类列出可清理项', await probe('document.querySelectorAll(".remote-ops-row").length >= 4'));
    await probe('[...document.querySelectorAll(".remote-ops-act")].find(b=>b.textContent.trim()==="清理").click()');
    await wait('!!document.querySelector(".remote-ops-dlg h3")');
    check('清理确认框显示预计可释放空间',
      await probe('/预计可释放/.test(document.querySelector(".remote-ops-dlg-body").textContent)'));
    await probe('document.querySelector(\'.remote-ops-dlg [data-dlg="0"]\').click()');

    await probe('document.querySelector(\'[data-ops-cat="proc"]\').click()');
    await wait('document.querySelectorAll(".remote-ops-row").length >= 1');
    // 表格化后：进程名一列、PID 一列、CPU 一列
    check('进程分类显示真实 ps 数据', await probe(
      '(()=>{const t=document.querySelector(".remote-ops-list").textContent;'
      + 'const h=document.querySelector(".remote-ops-thead").textContent;'
      + 'return t.includes("node") && t.includes("923") && /PID/.test(h)})()'));
    check('进程行显示 CPU 占比',
      await probe('/9\\.2%/.test(document.querySelector(".remote-ops-list").textContent)'));

    await probe('document.getElementById("remote-disconnect").click()');
    await sleep(700);
    check('断开后无控制台错误', errors.length === 0);


    console.log('\n运维台 UI 端到端：' + passed + ' 通过 / 0 失败');
    console.log('截图：' + path.join(output, 'ops-panel.png'));
    await server.close();
    app.exit(0);
  } catch (e) {
    console.error(e.stack || e);
    try { await server?.close(); } catch {}
    app.exit(1);
  }
});
setTimeout(() => { console.error('超时'); app.exit(2); }, 150000);

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
  MARK + 'procs', 'PID %CPU %MEM RSS ELAPSED COMMAND COMMAND', '923 9.2 0.2 196000 3-12:00 node node server.js',
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

    // ⑫ 顶部告警带（2026-10-29 P1-2）：夹具里有 1 个 Exited(1) 容器，
    // 真实采集 → 解析 → 告警带应出现并计数 1。
    await wait('!!document.querySelector("#remote-ov-alert")');
    check('真实数据触发告警带',
      await probe('/1 个容器异常/.test(document.querySelector("#remote-ov-alert").textContent)'));
    check('告警项可点（带分类）',
      await probe('!!document.querySelector("#remote-ov-alert [data-alert-cat]")'));
    // 点告警项 → 切到 Docker 并自动只看异常，此时列表只剩那 1 条
    await probe('document.querySelector("#remote-ov-alert [data-alert-cat=docker]").click()');
    await wait('/Docker/.test(document.querySelector(".remote-ops-segs .active").textContent)');
    check('点告警项切到 Docker 分类',
      await probe('/Docker/.test(document.querySelector(".remote-ops-segs .active").textContent)'));
    check('点告警项自动勾上只看异常',
      await probe('document.querySelector("[data-ops-onlybad]").checked === true'));
    check('只看异常后只剩异常容器',
      await probe(`(()=>{const rows=[...document.querySelectorAll('#remote-ops-list .remote-ops-row')];
        return rows.length===1 && /stopped-one/.test(rows[0].textContent)})()`));
    // 关掉只看异常，恢复正常视图供后续用例使用
    await probe('document.querySelector("[data-ops-onlybad]").click()');
    await wait('document.querySelectorAll("#remote-ops-list .remote-ops-row").length >= 2');

    // ⑬ 搜索与排序（方案 241 §4.1/§4.2）
    await probe(`(()=>{const i=document.querySelector('[data-ops-search]');
      i.value='stopped';i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await wait('document.querySelectorAll("#remote-ops-list .remote-ops-row").length === 1');
    check('搜索能筛到目标行',
      await probe('/stopped-one/.test(document.querySelector("#remote-ops-list").textContent)'));
    await probe(`(()=>{const i=document.querySelector('[data-ops-search]');
      i.value='';i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await wait('document.querySelectorAll("#remote-ops-list .remote-ops-row").length >= 2');
    check('清空搜索恢复全部行',
      await probe('document.querySelectorAll("#remote-ops-list .remote-ops-row").length >= 2'));

    // ⑭ 服务分类的分组折叠（方案 241 §4.3）：夹具只有 1 个 running 服务
    await probe('document.querySelector("[data-ops-cat=svc]").click()');
    await wait('document.querySelectorAll(".remote-ops-group").length > 0');
    check('服务分类出现分组头',
      await probe('/运行中/.test(document.querySelector(".remote-ops-group").textContent)'));
    const rowsBefore = await probe('document.querySelectorAll("#remote-ops-list .remote-ops-row").length');
    await probe('document.querySelector(".remote-ops-group").click()');
    await wait('document.querySelectorAll(".remote-ops-group.is-collapsed").length === 1');
    check('点组头能收起该组',
      await probe(`document.querySelectorAll('#remote-ops-list .remote-ops-row').length === 0`));
    check('收起后组头仍在（可再展开）',
      await probe('document.querySelectorAll(".remote-ops-group").length === 1'));
    await probe('document.querySelector(".remote-ops-group").click()');
    await wait(`document.querySelectorAll('#remote-ops-list .remote-ops-row').length === ${rowsBefore}`);
    check('再点能展开回来',
      await probe(`document.querySelectorAll('#remote-ops-list .remote-ops-row').length === ${rowsBefore}`));

    // ⑮ 刷新不打断（方案 241 §7.2）：结构未变时走补丁，DOM 节点实例保留
    await probe('document.querySelector("[data-ops-cat=docker]").click()');
    await wait('document.querySelectorAll("#remote-ops-list .remote-ops-row").length >= 2');
    await probe('document.querySelector("#remote-ops-list .remote-ops-row").__marker="kept"');
    // 主动触发一次刷新（与轮询同一条路径）
    await probe('window.RemotePanel.refresh()');
    await sleep(1200);
    check('刷新后 DOM 节点实例被保留（走增量补丁）',
      await probe('document.querySelector("#remote-ops-list .remote-ops-row").__marker === "kept"'));

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

    // 磁盘分类已移除（2026-10-29 用户：「感觉还是看不出来什么东西，删掉吧」），
    // 对应的「清理项 / 预计可释放空间」两条用例一并去掉。
    // 磁盘容量在顶部资源监控的磁盘条里仍然可见，这里补一条断言守住它。
    check('资源监控里仍有磁盘用量条', await probe(
      '(()=>{const t=document.querySelector(".remote-ov-minis")?.textContent||"";return /磁盘/.test(t)})()'));

    await probe('document.querySelector(\'[data-ops-cat="proc"]\').click()');
    await wait('document.querySelectorAll(".remote-ops-row").length >= 1');
    // 表格化后：进程名一列、PID 一列、CPU 一列
    check('进程分类显示真实 ps 数据', await probe(
      '(()=>{const t=document.querySelector(".remote-ops-list").textContent;'
      + 'const h=document.querySelector(".remote-ops-thead").textContent;'
      + 'return t.includes("node") && t.includes("923") && /PID/.test(h)})()'));
    check('进程行显示 CPU 占比',
      await probe('/9\\.2%/.test(document.querySelector(".remote-ops-list").textContent)'));

    // 截图留证（必须在断开之前截，断开后概览会被清空）。
    // 原来这里只打印一行「截图：…png」，从来没有真正 capturePage ——
    // 打印了不存在的文件路径，等于谎报取证（2026-10-29 修）。
    //
    // ⚠ headless 窗口不会重绘，capturePage 拿到的永远是启动那一帧（实测：
    // 截出来是「新建服务器」弹框 + 未连接状态）。所以截图时临时 showInactive()
    // 让合成器出帧，截完立刻 hide() —— 不抢焦点、不打断用户。
    try {
      // 先切回「概览」页签：前面几个用例跑过终端/文件，当前可能停在别的页签
      await probe('document.getElementById("remote-tab-overview")?.click()');
      await sleep(400);
      await probe('document.querySelector("[data-ops-cat=docker]")?.click()');
      await sleep(300);
      win.showInactive();
      await sleep(500);
      fs.writeFileSync(path.join(output, 'ops-alert.png'), (await win.webContents.capturePage()).toPNG());
      await probe('document.querySelector("[data-ops-cat=svc]")?.click()');
      await sleep(400);
      fs.writeFileSync(path.join(output, 'ops-groups.png'), (await win.webContents.capturePage()).toPNG());
      win.hide();
      console.log('截图：' + path.join(output, 'ops-alert.png'));
      console.log('截图：' + path.join(output, 'ops-groups.png'));
    } catch (e) { console.log('截图失败：' + e.message); try { win.hide(); } catch {} }

    await probe('document.getElementById("remote-disconnect").click()');
    await sleep(700);
    check('断开后无控制台错误', errors.length === 0);

    console.log('\n运维台 UI 端到端：' + passed + ' 通过 / 0 失败');
    await server.close();
    app.exit(0);
  } catch (e) {
    console.error(e.stack || e);
    try { await server?.close(); } catch {}
    app.exit(1);
  }
});
setTimeout(() => { console.error('超时'); app.exit(2); }, 150000);

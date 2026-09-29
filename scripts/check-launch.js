// 启动面板自检 —— `npm run check:launch`（真实 Electron 窗口 + headless 不抢焦点）
// 覆盖：面板可见 · 导入 mh 配置 · 分组渲染 · 启动/停止/状态 · 日志 · 配置持久化 · 状态落盘
const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

const REPORT = path.join(__dirname, '..', 'launch-check-report.txt');
const lines = [];
const say = (s) => { lines.push(s); try { fs.writeFileSync(REPORT, lines.join('\n')); } catch {} console.log(s); };

app.setPath('userData', path.join(os.tmpdir(), 'myide-launchcheck-' + process.pid));
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (js) => `(function(){ try { ${js} } catch(e) { return { err: String(e && e.message || e) } } })()`;

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { say('WATCHDOG TIMEOUT'); app.exit(3); }, 180000);
  const R = [];
  const add = (name, ok, detail) => {
    R.push({ name, ok, detail });
    say((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  };
  try {
    require(path.join(ROOT, 'main.js'));
    let win = null;
    for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await sleep(250); }
    const wc = win.webContents;
    try { win.hide(); } catch {}
    await sleep(2600);

    // ---------- ① 工具条与面板可见 ----------
    {
      const r = await wc.executeJavaScript(probe(`
        const btn = document.getElementById('tool-launch');
        if (!btn) return { err: '没有 tool-launch 按钮' };
        if (window.App) App.showTool('launch');
        return { hasBtn: true, tools: null };
      `), true);
      await sleep(900);
      // ⚠ 别用宽度判可见：headless（窗口 hide）下整份文档的布局尺寸都可能是 0。
      //   改用**相对可见性**：切到 launch 后 panel-launch 摘掉 hidden，其余侧栏面板挂上 hidden。
      const v = await wc.executeJavaScript(probe(`
        const p = document.getElementById('panel-launch');
        if (!p) return { err: '没有 panel-launch' };
        const others = ['project', 'outline', 'git', 'tasks'].map(function(t){
          const el = document.getElementById('panel-' + t);
          return { t: t, hidden: el ? el.classList.contains('hidden') : null };
        });
        return { hidden: p.classList.contains('hidden'), others: others,
                 body: !!document.getElementById('launch-body'),
                 foot: !!document.getElementById('launch-foot') };
      `), true);
      const othersHidden = v && v.others && v.others.every((o) => o.hidden === true);
      add('① 工具条有「启动面板」入口且能切过去（launch 显示、其余侧栏隐藏）',
        !!(r && r.hasBtn) && v && !v.hidden && othersHidden,
        'launch.hidden=' + (v && v.hidden) + ' 其它=' + JSON.stringify(v && v.others) + (v && v.err ? ' err=' + v.err : ''));
      add('①b 面板结构完整（body + 底部工具行）', !!(v && v.body && v.foot),
        'body=' + (v && v.body) + ' foot=' + (v && v.foot));
    }

    // ---------- ② 导入 mh_launch_panel 配置 ----------
    let entryCount = 0;
    {
      const src = 'D:\\document\\code\\tools\\mh_launch_panel\\panel-config.json';
      // ⚠ 别用 probe 包：probe 模板不 return，Promise 结果会拿不到（返回 undefined）
      const r = await wc.executeJavaScript('window.myIDE.launch.import(' + JSON.stringify(src) + ')', true);
      add('② 导入 mh_launch_panel 配置', !!(r && r.ok), 'ok=' + (r && r.ok) + ' 条数=' + (r && r.count) + (r && r.error ? ' err=' + r.error : ''));
      entryCount = (r && r.count) || 0;
      await wc.executeJavaScript(probe(`window.LaunchPanel.refresh(); return true;`), true);
      await sleep(1200);
      const dom = await wc.executeJavaScript(probe(`
        const cards = document.querySelectorAll('#launch-body .launch-card');
        const cats = Array.from(document.querySelectorAll('#launch-body .launch-cat-nm')).map((x) => x.textContent);
        return { cards: cards.length, cats: cats };
      `), true);
      add('②b 卡片按分类渲染', dom.cards === entryCount && dom.cats.length >= 2,
        '卡片=' + dom.cards + '/' + entryCount + ' 分类=' + JSON.stringify(dom.cats));
    }

    // ---------- ③ 启动 / 状态 / 停止（用一个短命测试条目，不动真实终端） ----------
    const TEST_ID = 'selftest-' + process.pid;
    {
      const cfg = await wc.executeJavaScript(probe(`
        const c = await 0; // 占位
        return null;
      `).replace('const c = await 0; // 占位\n        return null;', 'return null;'), true);
      // 添加测试条目：打印两行后 sleep 8 秒（够我们取日志和查状态）
      const saved = await wc.executeJavaScript(`(async () => {
        const cur = await window.myIDE.launch.config();
        const entries = cur.entries.concat([{ id: ${JSON.stringify(TEST_ID)}, name: '自检测试进程',
          category: '自检', cwd: '', command: 'echo hello-selfcheck && ping -n 8 127.0.0.1 > nul',
          port: 0, apiOrigin: '', openUrl: '', kind: '', script: '', python: '' }]);
        return await window.myIDE.launch.save({ apiOrigins: cur.apiOrigins, entries });
      })()`, true);
      add('③ 添加测试条目并保存', !!(saved && saved.entries && saved.entries.some((e) => e.id === TEST_ID)),
        '条目数=' + (saved && saved.entries && saved.entries.length));

      await wc.executeJavaScript(probe(`window.LaunchPanel.refresh(); return true;`), true);
      await sleep(1000);

      const started = await wc.executeJavaScript(`(async () => {
        const cur = await window.myIDE.launch.config();
        const e = cur.entries.find((x) => x.id === ${JSON.stringify(TEST_ID)});
        return await window.myIDE.launch.start(e);
      })()`, true);
      add('③b 启动进程', !!(started && started.ok), 'pid=' + (started && started.pid) + (started && started.error ? ' err=' + started.error : ''));
      await sleep(1500);

      const alive = await wc.executeJavaScript(`(async () => {
        const cur = await window.myIDE.launch.config();
        const e = cur.entries.find((x) => x.id === ${JSON.stringify(TEST_ID)});
        return await window.myIDE.launch.alive(e);
      })()`, true);
      add('③c 状态判定：运行中', !!(alive && alive.alive), JSON.stringify(alive));

      const lg = await wc.executeJavaScript(`window.myIDE.launch.logs(${JSON.stringify(TEST_ID)})`, true);
      add('③d 日志可取且非空（含 $ 命令行）',
        !!(lg && lg.lines && lg.lines.length && lg.lines.join('').indexOf('hello-selfcheck') >= 0),
        '行数=' + (lg && lg.lines && lg.lines.length) + ' 首行=' + (lg && lg.lines && lg.lines[0]));

      const stFile = await wc.executeJavaScript(`window.myIDE.launch.paths()`, true);
      const statePath = stFile && stFile.stateFile;
      let hasState = false;
      try { hasState = statePath && JSON.parse(fs.readFileSync(statePath, 'utf8'))[TEST_ID] != null; } catch {}
      add('③e 运行状态已落盘（后台保留：重开 my_ide 仍能停止）', hasState, 'state=' + statePath);

      const stopped = await wc.executeJavaScript(`(async () => {
        const cur = await window.myIDE.launch.config();
        const e = cur.entries.find((x) => x.id === ${JSON.stringify(TEST_ID)});
        return await window.myIDE.launch.stop(e);
      })()`, true);
      await sleep(1200);
      const dead = await wc.executeJavaScript(`(async () => {
        const cur = await window.myIDE.launch.config();
        const e = cur.entries.find((x) => x.id === ${JSON.stringify(TEST_ID)});
        return await window.myIDE.launch.alive(e);
      })()`, true);
      add('③f 停止生效（整树杀，不留孤儿）', !!(stopped && stopped.ok) && dead && !dead.alive,
        'killed=' + (stopped && stopped.killed) + ' 停止后 alive=' + (dead && dead.alive));

      // 清理测试条目
      await wc.executeJavaScript(`(async () => {
        const cur = await window.myIDE.launch.config();
        return await window.myIDE.launch.save({ apiOrigins: cur.apiOrigins,
          entries: cur.entries.filter((x) => x.id !== ${JSON.stringify(TEST_ID)}) });
      })()`, true);
      await wc.executeJavaScript(probe(`window.LaunchPanel.refresh(); return true;`), true);
      await sleep(800);
    }

    // ---------- ③g 后台保留开关：持久化到 launch.json ----------
    {
      const setR = await wc.executeJavaScript(`window.myIDE.launch.setKeep(true)`, true);
      const gotR = await wc.executeJavaScript(`window.myIDE.launch.getKeep()`, true);
      let inFile = false;
      try { inFile = JSON.parse(fs.readFileSync((await wc.executeJavaScript('window.myIDE.launch.paths()', true)).configFile, 'utf8')).keepOnExit === true; } catch {}
      add('③g 后台保留开关持久化（setKeep→getKeep→文件）', setR === true && gotR === true && inFile,
          'set=' + setR + ' get=' + gotR + ' 文件.keepOnExit=' + inFile);
      // 关掉开关不影响其它字段
      const cfgAfter = await wc.executeJavaScript(`window.myIDE.launch.config()`, true);
      add('③g2 开关写入不破坏条目', (cfgAfter.entries || []).length === entryCount,
          '条数=' + (cfgAfter.entries || []).length + '/' + entryCount);
      await wc.executeJavaScript(`window.myIDE.launch.setKeep(false)`, true);
    }

    // ---------- ③h 添加/编辑对话框：USB 隧道字段存在 ----------
    {
      const f = await wc.executeJavaScript(probe(`
        const form = document.getElementById('launch-form');
        if (!form) return { err: 'no form' };
        const names = ['name','category','cwd','command','port','apiOrigin','openUrl','kind','python','script'];
        const missing = names.filter((n) => !form.elements[n]);
        const dlg = document.getElementById('launch-dialog');
        return { missing: missing, hasDialog: !!dlg };
      `), true);
      add('③h 对话框字段齐全（含 USB 隧道的 kind/python/script）',
          !f.err && f.missing.length === 0 && f.hasDialog, JSON.stringify(f));
    }

    // ---------- ③g 后台保留开关：持久化到 launch.json ----------
    {
      const setR = await wc.executeJavaScript(`window.myIDE.launch.setKeep(true)`, true);
      const gotR = await wc.executeJavaScript(`window.myIDE.launch.getKeep()`, true);
      let inFile = false;
      try { inFile = JSON.parse(fs.readFileSync((await wc.executeJavaScript('window.myIDE.launch.paths()', true)).configFile, 'utf8')).keepOnExit === true; } catch {}
      add('③g 后台保留开关持久化（setKeep→getKeep→文件）', setR === true && gotR === true && inFile,
          'set=' + setR + ' get=' + gotR + ' 文件.keepOnExit=' + inFile);
      // 关掉开关不影响其它字段
      const cfgAfter = await wc.executeJavaScript(`window.myIDE.launch.config()`, true);
      add('③g2 开关写入不破坏条目', (cfgAfter.entries || []).length === entryCount,
          '条数=' + (cfgAfter.entries || []).length + '/' + entryCount);
      await wc.executeJavaScript(`window.myIDE.launch.setKeep(false)`, true);
    }

    // ---------- ③h 添加/编辑对话框：USB 隧道字段存在 ----------
    {
      const f = await wc.executeJavaScript(probe(`
        const form = document.getElementById('launch-form');
        if (!form) return { err: 'no form' };
        const names = ['name','category','cwd','command','port','apiOrigin','openUrl','kind','python','script'];
        const missing = names.filter((n) => !form.elements[n]);
        const dlg = document.getElementById('launch-dialog');
        return { missing: missing, hasDialog: !!dlg };
      `), true);
      add('③h 对话框字段齐全（含 USB 隧道的 kind/python/script）',
          !f.err && f.missing.length === 0 && f.hasDialog, JSON.stringify(f));
    }

    // ---------- ④ 配置持久化（机器级 ~/.myide/launch.json） ----------
    {
      const p = await wc.executeJavaScript(`window.myIDE.launch.paths()`, true);
      let okFile = false, cnt = 0;
      try { const j = JSON.parse(fs.readFileSync(p.configFile, 'utf8')); okFile = Array.isArray(j.entries); cnt = j.entries.length; } catch {}
      add('④ 机器级配置落盘 ~/.myide/launch.json', okFile && cnt === entryCount,
        p.configFile + ' 条数=' + cnt);
    }

    // ---------- ⑤ 面板不报错（控制台无异常） ----------
    {
      const errs = await wc.executeJavaScript(probe(`
        return { cards: document.querySelectorAll('#launch-body .launch-card').length };
      `), true);
      add('⑤ 自检后面板仍在（条目已恢复为导入的那些）', (errs && errs.cards) === entryCount,
        '卡片=' + (errs && errs.cards) + '/' + entryCount);
    }

    // 截图
    if (!wc.debugger.isAttached()) { try { wc.debugger.attach('1.3'); } catch {} }
    const shot = await Promise.race([
      wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true }),
      new Promise((r) => setTimeout(() => r(null), 8000)),
    ]);
    if (shot && shot.data) {
      fs.writeFileSync(path.join(__dirname, '..', 'launch-check.png'), Buffer.from(shot.data, 'base64'));
      say('shot saved');
    }

    const bad = R.filter((x) => !x.ok);
    say('');
    say('================ 汇总 ================');
    say('共 ' + R.length + ' 项：通过 ' + (R.length - bad.length) + ' / 失败 ' + bad.length);
    bad.forEach((b, i) => say('  ' + (i + 1) + '. ' + b.name + '  →  ' + (b.detail || '')));
    clearTimeout(watchdog);
    app.exit(bad.length ? 1 : 0);
  } catch (e) {
    say('EXC: ' + (e && e.message || e));
    clearTimeout(watchdog);
    app.exit(2);
  }
});

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

// ⚠ 这个自检会把**用户真实**的 ~/.myide/launch.json 覆盖成「导入的 mh 配置」（步骤②），
//   而步骤⑤只把条目恢复到"导入的那一套"，用户自己加过的条目就没了 —— 实测踩过：
//   跑一次 check:launch，用户第 12 条（原型 :8899）丢失，且没有任何备份可回滚。
//   所以开跑前把两份机器级文件读进内存，退出前（正常 / 异常 / 看门狗三条路）原样写回。
const USER_CFG = path.join(os.homedir(), '.myide', 'launch.json');
const USER_STATE = path.join(os.homedir(), '.myide', 'launch-state.json');
const userBackup = {};
for (const f of [USER_CFG, USER_STATE]) { try { userBackup[f] = fs.readFileSync(f, 'utf8'); } catch {} }
function restoreUserFiles() {
  for (const f of Object.keys(userBackup)) {
    try { fs.writeFileSync(f, userBackup[f]); } catch {}
  }
}
function finish(code) { restoreUserFiles(); app.exit(code); }

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { say('WATCHDOG TIMEOUT'); finish(3); }, 180000);
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
        // 🔴 祖先链真实可见性：本面板任何祖先挂 hidden / display:none，自己就是看不见
        //    （本轮 panel-launch 被嵌进 panel-tasks，class 检查全绿但视觉空白 —— 就是漏在这）
        const chain = [];
        let n = p.parentElement;
        while (n && n !== document.body) {
          if (n.classList && n.classList.contains('hidden')) chain.push(n.id || n.className);
          const d = getComputedStyle(n).display;
          if (d === 'none') chain.push((n.id || n.className) + '(display:none)');
          n = n.parentElement;
        }
        return { hidden: p.classList.contains('hidden'), others: others, chain: chain,
                 parent: p.parentElement ? p.parentElement.id || p.parentElement.className : '',
                 rect: (function(){ const b = p.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })(),
                 body: !!document.getElementById('launch-body'),
                 foot: !!document.getElementById('launch-foot') };
      `), true);
      const othersHidden = v && v.others && v.others.every((o) => o.hidden === true);
      const chainClean = v && v.chain && v.chain.length === 0;
      const parentOk = v && /sidebar|^\s*$/.test(String(v.parent).trim()) || (v && String(v.parent).indexOf('sidebar') >= 0);
      add('① 工具条有「启动面板」入口且能切过去（launch 显示、其余侧栏隐藏）',
        !!(r && r.hasBtn) && v && !v.hidden && othersHidden && chainClean,
        'launch.hidden=' + (v && v.hidden) + ' 其它=' + JSON.stringify(v && v.others) + ' 祖先链=' + JSON.stringify(v && v.chain));
      add('①b panel-launch 必须是侧栏直接子级（防嵌套进别的面板）',
        !!parentOk && v && v.rect && v.rect.h > 0,
        'parent=' + (v && v.parent) + ' rect=' + JSON.stringify(v && v.rect));
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

    // ---------- ③i 后端地址历史下拉：展开 / 选中填入 ----------
    {
      const r = await wc.executeJavaScript(probe(`
        const dlg = document.getElementById('launch-dialog');
        if (!dlg) return { err: 'no dialog' };
        // 走真实入口：先选中第一张卡片，再点主区「编辑」→ openDialog 绑定下拉监听
        const card = document.querySelector('#launch-body .launch-card');
        if (card) card.click();
        const editBtn = document.getElementById('lm-edit');
        if (!editBtn) return { err: 'no lm-edit' };
        editBtn.click();
        if (!dlg.hasAttribute('open') && typeof dlg.showModal === 'function') { try { dlg.showModal(); } catch {} }
        const of = dlg.querySelector('.origin-field');
        if (!of) return { err: 'no origin-field' };
        const drop = of.querySelector('.origin-dropdown');
        const inp = of.querySelector('input[name="apiOrigin"]');
        const tg = of.querySelector('.origin-toggle');
        if (!drop || !inp || !tg) return { err: 'missing parts' };
        tg.click();
        const items = [...drop.querySelectorAll('.origin-item')];
        const cnt = items.length;
        const first = items[0] && items[0].querySelector('.origin-text');
        const firstVal = first ? first.textContent : '';
        if (items[0]) items[0].click();   // 选中第一项（不带 ✕）
        const filled = inp.value;
        const stillOpen = !drop.hidden;
        inp.value = '';
        if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
        return { cnt, firstVal, filled, stillOpen };
      `), true);
      add('③i 后端地址下拉：历史项可选可填入',
          !r.err && r.cnt >= 1 && r.filled === r.firstVal && !r.stillOpen,
          JSON.stringify(r));
    }

    // ---------- ③j 侧栏卡片：双态互斥 + 跳转按钮 + 三角尺寸 ----------
    {
      const r = await wc.executeJavaScript(probe(`
        const cards = [...document.querySelectorAll('#launch-body .launch-card')];
        let badState = 0, withPort = 0, withOpen = 0;
        for (const c of cards) {
          const idle = c.querySelector('.act-idle'), run = c.querySelector('.act-run');
          const vIdle = idle && !idle.classList.contains('hide');
          const vRun = run && !run.classList.contains('hide');
          if (vIdle === vRun) badState++;
          if (c.querySelector('.act-open')) withOpen++;
          const portEl = c.querySelector('.launch-port');
          if (portEl) withPort++;
        }
        const caret = document.querySelector('.launch-caret');
        // 三角已从文字字形（▸/▾）换成内联 SVG → 量 SVG 的实际宽度，别再量字号
        const csvg = caret ? caret.querySelector('svg') : null;
        const fs = csvg ? csvg.getBoundingClientRect().width : 0;
        return { n: cards.length, badState, withPort, withOpen, caretPx: Math.round(fs * 10) / 10 };
      `), true);
      add('③j 卡片双态互斥（启动/停止恰一个可见）',
          !r.err && r.n > 0 && r.badState === 0, JSON.stringify(r));
      add('③j 有端口的条目都有跳转按钮', !r.err && r.withPort === r.withOpen && r.withPort > 0,
          'port=' + r.withPort + ' open=' + r.withOpen);
      add('③j 分组三角 ≥11px（原 9px 太小）', !r.err && r.caretPx >= 11, 'caret=' + r.caretPx + 'px');
    }

    // ---------- ④ 配置持久化（机器级 ~/.myide/launch.json） ----------
    {
      const p = await wc.executeJavaScript(`window.myIDE.launch.paths()`, true);
      let okFile = false, cnt = 0;
      try { const j = JSON.parse(fs.readFileSync(p.configFile, 'utf8')); okFile = Array.isArray(j.entries); cnt = j.entries.length; } catch {}
      add('④ 机器级配置落盘 ~/.myide/launch.json', okFile && cnt === entryCount,
        p.configFile + ' 条数=' + cnt);
    }

    // ---------- ④b 主区 #launch-main：可见 + 选中渲染（本轮新增的双区视图） ----------
    {
      const selR = await wc.executeJavaScript(probe(`
        const v = (window.Viewer.cm.view || window.Viewer.cm);
        const d = v.state.doc ? v.state.doc.toString() : '';
        return true;
      `), true);
      // 让 LaunchPanel 选中第一个条目：直接点侧栏第一张卡片
      await wc.executeJavaScript(probe(`
        const card = document.querySelector('#launch-body .launch-card');
        if (card) card.click();
        return true;
      `), true);
      await sleep(900);
      const m = await wc.executeJavaScript(probe(`
        const main = document.getElementById('launch-main');
        if (!main) return { err: 'no launch-main' };
        const b = main.getBoundingClientRect();
        const cs = getComputedStyle(main);
        const chain = [];
        let n = main.parentElement;
        while (n && n !== document.body) {
          if (n.classList && n.classList.contains('hidden')) chain.push(n.id || n.className);
          if (getComputedStyle(n).display === 'none') chain.push((n.id || n.className) + ':none');
          n = n.parentElement;
        }
        return { hidden: main.classList.contains('hidden'), w: Math.round(b.width), h: Math.round(b.height),
                 chain: chain, name: document.getElementById('lm-name').textContent,
                 hasLog: !!document.getElementById('lm-log') };
      `), true);
      add('④b 主区 launch-main 可见（切到 launch 时）',
          m && !m.hidden && m.w > 300 && m.chain.length === 0,
          'hidden=' + (m && m.hidden) + ' rect=' + JSON.stringify(m && { w: m.w, h: m.h }) + ' 祖先链=' + JSON.stringify(m && m.chain));
      add('④c 选中条目后主区显示名称与日志容器',
          m && m.name && m.name !== '—' && m.hasLog, 'name=' + JSON.stringify(m && m.name));
    }

    // ---------- ④b 主区 #launch-main：可见 + 选中渲染（本轮新增的双区视图） ----------
    {
      const selR = await wc.executeJavaScript(probe(`
        const v = (window.Viewer.cm.view || window.Viewer.cm);
        const d = v.state.doc ? v.state.doc.toString() : '';
        return true;
      `), true);
      // 让 LaunchPanel 选中第一个条目：直接点侧栏第一张卡片
      await wc.executeJavaScript(probe(`
        const card = document.querySelector('#launch-body .launch-card');
        if (card) card.click();
        return true;
      `), true);
      await sleep(900);
      const m = await wc.executeJavaScript(probe(`
        const main = document.getElementById('launch-main');
        if (!main) return { err: 'no launch-main' };
        const b = main.getBoundingClientRect();
        const cs = getComputedStyle(main);
        const chain = [];
        let n = main.parentElement;
        while (n && n !== document.body) {
          if (n.classList && n.classList.contains('hidden')) chain.push(n.id || n.className);
          if (getComputedStyle(n).display === 'none') chain.push((n.id || n.className) + ':none');
          n = n.parentElement;
        }
        return { hidden: main.classList.contains('hidden'), w: Math.round(b.width), h: Math.round(b.height),
                 chain: chain, name: document.getElementById('lm-name').textContent,
                 hasLog: !!document.getElementById('lm-log') };
      `), true);
      add('④b 主区 launch-main 可见（切到 launch 时）',
          m && !m.hidden && m.w > 300 && m.chain.length === 0,
          'hidden=' + (m && m.hidden) + ' rect=' + JSON.stringify(m && { w: m.w, h: m.h }) + ' 祖先链=' + JSON.stringify(m && m.chain));
      add('④c 选中条目后主区显示名称与日志容器',
          m && m.name && m.name !== '—' && m.hasLog, 'name=' + JSON.stringify(m && m.name));
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
    say('用户机器级配置：' + (userBackup[USER_CFG] ? '已在退出时还原（自检期间的导入不外泄）' : '原本不存在（自检留下的 launch.json 会被删）'));
    if (!userBackup[USER_CFG]) { try { fs.unlinkSync(USER_CFG); } catch {} }
    clearTimeout(watchdog);
    finish(bad.length ? 1 : 0);
  } catch (e) {
    say('EXC: ' + (e && e.message || e));
    clearTimeout(watchdog);
    finish(2);
  }
});

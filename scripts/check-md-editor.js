// md 编辑器全量自检 —— `npm run check:md`（真实 Electron 窗口 + headless 不抢焦点）
// 覆盖：选区几何(段落/列表/跨表/源码) · 表格渲染三态 · mermaid 主题 · 选中色单层 · 行盒高度
const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

const REPORT = path.join(__dirname, '..', 'md-check-report.txt');
const lines = [];
const say = (s) => { lines.push(s); try { fs.writeFileSync(REPORT, lines.join('\n')); } catch {} console.log(s); };

app.setPath('userData', path.join(os.tmpdir(), 'myide-mdcheck-' + process.pid));
const ROOT = path.join(__dirname, '..');   // 项目根（scripts/ 的上一级）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOC = [
  '# 数字人接入方案',
  '',
  '设计约束：主体模型假名化优先，敏感标识走信封加密，租户绑定与用途分离，这一段故意写长一点用来验证折行后的选区几何。',
  '',
  '- 十大流程',
  '- 数字管理端展示',
  '- 数字人功能扩展 对话保存等',
  '',
  '- [ ] 待办事项一',
  '- [x] 待办事项二',
  '',
  '| 使用者 | 可以做什么 | 不可以做什么 |',
  '| --- | --- | --- |',
  '| 平台管理员 | 在数字人后台创建通用形象和通用智能体并绑定 | 直接修改某机构已发布智能体的提示词 |',
  '| 终端 | 查询本机生效的数字人形象与智能体 | 选择未分配形象；调用管理写接口 |',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[平台后端] --> B[数字人服务]',
  '  B --> C[终端 A12]',
  '```',
  '',
  '## 4. 两套数据库分别存什么',
  '',
  '例如：平台授权"小玲形象 v2"给甲机构：甲机构创建"心理陪伴助手"，配置开场白和对话设定，发布智能体 v1；A12 绑定"小玲形象 v2 + 心理陪伴助手 v1"。',
].join('\n');

const probe = (js) => `(function(){ try { ${js} } catch(e) { return { err: String(e && e.message || e) } } })()`;

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { say('WATCHDOG TIMEOUT'); app.exit(3); }, 180000);
  const R = [];   // 断言
  const add = (name, ok, detail) => { R.push({ name, ok, detail }); say((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   [' + detail + ']' : '')); };
  try {
    require(path.join(ROOT, 'main.js'));
    let win = null;
    for (let i = 0; i < 40; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await sleep(250); }
    const wc = win.webContents;
    try { win.hide(); } catch {}
    await sleep(2500);

    const tmpMd = path.join(os.tmpdir(), 'mdcheck-' + process.pid + '.md');
    fs.writeFileSync(tmpMd, DOC, 'utf8');
    const openR = await wc.executeJavaScript(
      'window.Viewer.openFile(' + JSON.stringify(tmpMd) + ').then(() => "ok").catch(e => "ERR:" + e.message)', true);
    say('openFile: ' + openR);
    await sleep(3000);

    // 通用：选区 + 几何
    const selAndGeom = async (aKey, bKey) => {
      const s = await wc.executeJavaScript(probe(`
        const v = (window.Viewer.cm.view || window.Viewer.cm);
        const d = v.state.doc.toString();
        const a = d.indexOf(${JSON.stringify(aKey)});
        const b = d.indexOf(${JSON.stringify(bKey)}) + ${JSON.stringify(bKey)}.length;
        if (a < 0 || b < 0) return { err: 'pos', a: a, b: b };
        v.dispatch({ selection: { anchor: a, head: b }, scrollIntoView: true });
        return { a: a, b: b };`), true);
      await sleep(900);
      const g = await wc.executeJavaScript(probe(`
        const v = (window.Viewer.cm.view || window.Viewer.cm);
        const rects = Array.from(v.dom.querySelectorAll('.cm-selectionBackground')).map(function(r){
          const b = r.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) };
        });
        const sel = v.state.selection.main;
        const lineBox = [];
        for (let pos = sel.from; pos <= sel.to;) {
          const line = v.state.doc.lineAt(pos);
          const n = v.domAtPos(line.from).node;
          const el = n.nodeType === 1 ? n : n.parentElement;
          const le = el && el.closest ? el.closest('.cm-line') : null;
          if (le) { const b = le.getBoundingClientRect(); lineBox.push({ top: Math.round(b.top), h: Math.round(b.height), cls: le.className.replace('cm-line','').trim().slice(0,30) }); }
          if (line.to >= sel.to) break;
          pos = line.to + 1;
        }
        return { rects: rects, lines: lineBox, selText: v.state.doc.sliceString(sel.from, Math.min(sel.to, sel.from + 20)) };
      `), true);
      return { s, g };
    };

    // ---------- ① 段落选区：色带应落在行的垂直范围内 ----------
    {
      const { s, g } = await selAndGeom('例如：平台授权', '心理陪伴助手 v1');   // 段落
      if (s.err || g.err) add('① 段落选区几何', false, JSON.stringify(s.err || g.err));
      else {
        const rs = g.rects, ls = g.lines;
        const first = rs[0], lastR = rs[rs.length - 1];
        const l0 = ls[0], lN = ls[ls.length - 1];
        const okTop = l0 && first.top >= l0.top - 3 && first.top <= l0.top + l0.h;
        const okBot = lN && (lastR.top + lastR.h) >= (lN.top + lN.h) - 4 && (lastR.top + lastR.h) <= lN.top + lN.h + 4;
        add('① 段落选区：色带上下边界落在行盒内', !!(okTop && okBot),
          'rect0.top=' + first.top + ' 行顶=' + (l0 && l0.top) + ' 行高=' + (l0 && l0.h) + ' | rectN.bottom=' + (lastR.top + lastR.h) + ' 行底=' + (lN && (lN.top + lN.h)));
        add('①b 段落选区：色带连续（段与段首尾相接，不重叠不闪缝）',
          rs.every((r, i) => i === 0 || Math.abs(r.top - (rs[i - 1].top + rs[i - 1].h)) <= 2),
          rs.map((r) => r.top + '+' + r.h).join(' → '));
      }
    }

    // ---------- ② 列表行盒高度 = 正文行盒高度 ----------
    {
      const g = await wc.executeJavaScript(probe(`
        const v = (window.Viewer.cm.view || window.Viewer.cm);
        const all = Array.from(v.dom.querySelectorAll('.cm-line')).map(function(l){
          const b = l.getBoundingClientRect(); return { h: Math.round(b.height), t: l.textContent.slice(0,12),
            bullet: !!l.querySelector('.cm-md-bullet'), task: !!l.querySelector('.cm-md-task') };
        }).filter(function(x){ return x.t.trim().length; });
        const body = all.filter(function(x){ return !x.bullet && !x.task && !/^#/.test(x.t) && !/^\\|/.test(x.t) && !/^\`\`\`/.test(x.t); });
        const list = all.filter(function(x){ return x.bullet || x.task; });
        return { bodyH: body.map(function(x){return x.h}), listH: list.map(function(x){return x.h}), listN: list.length };
      `), true);
      // ⚠ 基准取正文的 min（单显示行 = line-height 22），不能用 max —— 折行段落是 44/46
      const bodyMin = Math.min.apply(null, g.bodyH.concat([99]));
      const listMax = g.listH.length ? Math.max.apply(null, g.listH) : 0;
      add('② 列表行盒高度 == 正文单显示行高（bullet/task 不再撑高）', Math.abs(listMax - bodyMin) <= 1,
        '正文单行=' + bodyMin + ' 列表 max=' + listMax + ' 正文样本=' + g.bodyH.join(',') + ' 列表样本=' + g.listH.join(','));
    }

    // ---------- ③ 光标不在表内 → 真表格 ----------
    const tableState = async () => wc.executeJavaScript(probe(`
      const v = (window.Viewer.cm.view || window.Viewer.cm);
      return { widgetTable: v.dom.querySelectorAll('.cm-md-table table').length,
               srcRows: v.dom.querySelectorAll('.cm-md-tr-head, .cm-md-tr-row').length,
               mermaidSvg: v.dom.querySelectorAll('.cm-md-mermaid svg').length,
               fenceLines: v.dom.querySelectorAll('.cm-md-fence-line').length };
    `), true);

    await wc.executeJavaScript(probe(`
      const v = (window.Viewer.cm.view || window.Viewer.cm);
      const d = v.state.doc.toString();
      v.dispatch({ selection: { anchor: d.indexOf('设计约束'), head: d.indexOf('设计约束') }, scrollIntoView: true });
      return true;`), true);
    await sleep(900);
    {
      const t = await tableState();
      add('③ 光标不在表内 → 表格渲染成真 <table>', t.widgetTable >= 1 && t.srcRows === 0,
        '<table>=' + t.widgetTable + ' 源码表行=' + t.srcRows);
      add('③b mermaid 渲染成 SVG（暗色主题路径）', t.mermaidSvg >= 1, 'svg=' + t.mermaidSvg);
    }

    // ---------- ④ 拖选跨表格 → 表格仍渲染 ----------
    {
      const { s } = await selAndGeom('# 数字人接入方案', '心理陪伴助手 v1');
      const t = await tableState();
      add('④ 拖选跨越表格 → 表格保持渲染（不退源码）', t.widgetTable >= 1 && t.srcRows === 0,
        '选区=' + JSON.stringify(s) + ' <table>=' + t.widgetTable + ' 源码表行=' + t.srcRows);
      add('④b 拖选跨越 mermaid → 图保持渲染', t.mermaidSvg >= 1 && t.fenceLines === 0,
        'svg=' + t.mermaidSvg + ' fence 行=' + t.fenceLines);
    }

    // ---------- ⑤ 光标点进表格 → 源码态可编辑 ----------
    {
      await wc.executeJavaScript(probe(`
        const v = (window.Viewer.cm.view || window.Viewer.cm);
        const d = v.state.doc.toString();
        const p = d.indexOf('平台管理员 | 在数字人后台');
        v.dispatch({ selection: { anchor: p, head: p }, scrollIntoView: true });
        return true;`), true);
      await sleep(900);
      const t = await tableState();
      add('⑤ 光标点进表格 → 网格内直接编辑单元格', t.widgetTable >= 1 && t.srcRows === 0,
        '源码表行=' + t.srcRows + ' <table>=' + t.widgetTable);
    }

    // ---------- ⑥ 表格样式：表头与数据行有区分 ----------
    {
      await wc.executeJavaScript(probe(`
        const v = (window.Viewer.cm.view || window.Viewer.cm);
        const d = v.state.doc.toString();
        v.dispatch({ selection: { anchor: d.indexOf('设计约束'), head: d.indexOf('设计约束') }, scrollIntoView: true });
        return true;`), true);
      await sleep(900);
      const st = await wc.executeJavaScript(probe(`
        const v = (window.Viewer.cm.view || window.Viewer.cm);
        const th = v.dom.querySelector('.cm-md-table th'), td = v.dom.querySelector('.cm-md-table td');
        if (!th || !td) return { err: 'no th/td' };
        const cs = getComputedStyle(th), cd = getComputedStyle(td);
        return { thBg: cs.backgroundColor, thColor: cs.color, thWeight: cs.fontWeight,
                 tdBg: cd.backgroundColor, copy: !!v.dom.querySelector('.cm-md-tablecopy') };
      `), true);
      add('⑥ 表头有独立底色与字重（与数据行区分）',
        st.thBg && st.tdBg && st.thBg !== st.tdBg && Number(st.thWeight) >= 700,
        'th=' + st.thBg + '/' + st.thWeight + ' td=' + st.tdBg);
      add('⑥b 表格带「复制 TSV」按钮', !!st.copy, 'copy=' + st.copy);
    }

    // ---------- ⑦ 选中色：编辑器内只有 CM6 一层 ----------
    {
      // ⚠ 必须先真的设一个选区，否则 .cm-selectionBackground 根本不存在（上一版就栽在这）
      await wc.executeJavaScript(probe(`
        const v = (window.Viewer.cm.view || window.Viewer.cm);
        const d = v.state.doc.toString();
        const a = d.indexOf('设计约束');
        v.dispatch({ selection: { anchor: a, head: a + 12 }, scrollIntoView: true });
        return true;`), true);
      await sleep(700);
      let c = null;
      for (let i = 0; i < 6; i++) {
        c = await wc.executeJavaScript(probe(`
        const v = (window.Viewer.cm.view || window.Viewer.cm);
        const line = v.dom.querySelector('.cm-line');
        const sb = v.dom.querySelector('.cm-selectionBackground');
        const selBg = sb ? getComputedStyle(sb).backgroundColor : null;
        const nativeSel = getComputedStyle(line, '::selection').backgroundColor;
        const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim();
        return { selBg: selBg, nativeSel: nativeSel, accent: accent };
      `), true);
        if (c && c.selBg) break;          // 隐藏窗口下装饰层更新会节流 → 轮询等它出现
        await sleep(700);
      }
      add('⑦ 原生 ::selection 在编辑器内透明（不再和 CM6 层叠加成双色）',
        String(c.nativeSel).replace(/\s/g, '') === 'rgba(0,0,0,0)' || String(c.nativeSel) === 'transparent',
        'nativeSel=' + c.nativeSel);
      add('⑦b CM6 选区层有颜色（accent tint）', !!c.selBg && c.selBg !== 'rgba(0, 0, 0, 0)', 'selBg=' + c.selBg + ' accent=' + c.accent);
    }

    // ---------- ⑧ mermaid 容器不再画底色 ----------
    {
      const m = await wc.executeJavaScript(probe(`
        const v = (window.Viewer.cm.view || window.Viewer.cm);
        const box = v.dom.querySelector('.cm-md-mermaid');
        if (!box) return { err: 'no mermaid box' };
        const cs = getComputedStyle(box);
        const before = getComputedStyle(box, '::before');
        return { margin: cs.margin, padding: cs.padding, beforeContent: before.content, beforeBg: before.backgroundColor,
                 beforeDisplay: before.display };
      `), true);
      const noBg = !m.beforeBg || m.beforeBg === 'rgba(0, 0, 0, 0)' || m.beforeContent === 'none';
      add('⑧ mermaid 容器不画底色（用户要求隐藏背景）', noBg, '::before content=' + m.beforeContent + ' bg=' + m.beforeBg);
      add('⑧b mermaid 容器用 padding 而非 margin（CM6 高度模型）', String(m.margin).startsWith('0px'),
        'margin=' + m.margin + ' padding=' + m.padding);
    }

    // ---------- ⑨ 源码模式（live 关）一切正常 ----------
    {
      await wc.executeJavaScript('(window.Viewer.cm.setLive ? (window.Viewer.cm.setLive(false), 1) : 0)', true);
      await sleep(1200);
      const { s, g } = await selAndGeom('- 十大流程', '对话保存等');
      const ok = !s.err && !g.err && g.lines.every((l) => l.h >= 20 && l.h <= 46);
      add('⑨ 源码模式：选区行盒整齐（20~46px，无异常撑高）', ok,
        ok ? '行高=' + g.lines.map((l) => l.h).join(',') : JSON.stringify(s.err || g.err || g.lines));
      await wc.executeJavaScript('(window.Viewer.cm.setLive ? window.Viewer.cm.setLive(true) : 0)', true);
      await sleep(600);
    }

    // 截图
    if (!wc.debugger.isAttached()) { try { wc.debugger.attach('1.3'); } catch {} }
    const shot = await Promise.race([
      wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true }),
      new Promise((r) => setTimeout(() => r(null), 8000)),
    ]);
    if (shot && shot.data) { fs.writeFileSync(path.join(__dirname, '..', 'md-check.png'), Buffer.from(shot.data, 'base64')); say('shot saved'); }

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

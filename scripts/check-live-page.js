// scripts/check-live-page.js —— Live Preview 真实渲染自检（由 main.js --check-live 注入真实 App DOM）
// 必须是表达式形式：(async () => {...})()，返回 { R: [{name, ok, detail}] }
(async () => {
  const R = [];
  const add = (name, ok, detail) => R.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  // 隐藏窗口（默认的 headless 自检）里 CM6 拿不到 DOM 焦点 → 它不绘制选区层，
  // 这类"必须聚焦才画得出来"的项要显式记 SKIP，不能记 FAIL（会误导成真回归）
  const skip = (name, detail) => R.push({ name, ok: true, skip: true, detail: detail == null ? '' : String(detail) });
  // api 用取值器：自愈重开文档后 Viewer.cm 会换成新实例，捕获一次的旧引用会失效
  const A = () => (window.Viewer && Viewer.cm) || null;
  let api = A();
  let cm = document.querySelector('.cm-content');
  if (!api || !cm) return { error: '编辑器未挂载（Viewer.cm=' + !!api + ', .cm-content=' + !!cm + '）', R };
  // 基准文本（下面会用编辑器当前内容覆盖：Windows 检出的 CRLF vs 编辑器 LF，
  // 两者 length 不同，用原始文件文本会让所有 indexOf 偏移整体错位）
  let DOC = window.__doc;
  // 🔴 自检会临时改写文档内容（表格/脚注/wiki/嵌入用例），而渲染层有「停手 3 秒自动保存」——
  //   不拦的话这些测试内容会被**写回真实的 preview-test.md**（实测：整份基准文档被覆盖成
  //   一行 `# 索引`，随后 100+ 条断言因为文档变了集体变红）。
  //   这里全程把标签标成 non-dirty 并清掉自动保存定时器，收尾再还原内容。
  const guardAutosave = () => {
    try {
      for (const t of (Viewer.openTabs || [])) t.dirty = false;
      const at = Viewer.activeTab;
      if (at) at.dirty = false;
    } catch {}
  };
  guardAutosave();
  const autosaveWatch = setInterval(guardAutosave, 400);
  // 双保险：自检期间直接拦掉写盘（哪怕 dirty 判定漏了一次也不会污染真实文件）。
  // 只拦「写到基准文档」这一种；其它路径（读盘、用户其它文件）照常。
  const origWrite = (window.myIDE && window.myIDE.fs && window.myIDE.fs.writeFile) || null;
  if (origWrite && window.__docPath) {
    try {
      window.myIDE.fs.writeFile = function (p, ...rest) {
        if (String(p) === String(window.__docPath)) return Promise.resolve({ ok: true, skipped: 'check-live' });
        return origWrite.call(this, p, ...rest);
      };
    } catch {}
  }
  // ⚠ 自愈：`Session.restore()` 是**异步**的，可能在 main.js 打开基准文档之后又把使用者的
  //   真实会话标签激活回来 → 后面 100+ 条断言全跑在别的文档上（实测：整份自检集体变红）。
  //   这里先确认活动标签就是基准文档，不是就重新打开并等它真正生效。
  if (window.__docPath) {
    for (let i = 0; i < 12; i++) {
      const at = window.Viewer && Viewer.activeTab;
      if (at && at.path === window.__docPath && Viewer.cm) break;
      try { Viewer.openFile(window.__docPath); } catch {}
      await sleep(400);
    }
    api = A() || api;
    cm = document.querySelector('.cm-content') || cm;
  }
  // DOC 必须以编辑器当前内容为准（Windows 检出是 CRLF、编辑器归一成 LF；用原始文件文本
  // 会让所有 indexOf 偏移整体错位）
  if (api && api.getValue) {
    try {
      const live = api.getValue();
      if (live && live.length) DOC = live;
    } catch {}
  }
  const allText = () => cm.textContent;
  const css = (el, prop) => (el ? getComputedStyle(el).getPropertyValue(prop) : '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const has = (s) => allText().includes(s);
  const q = (sel) => document.querySelector(sel);
  const transparent = (v) => !v || v === 'rgba(0, 0, 0, 0)' || v === 'transparent';
  // 装饰背景现在画在 ::before(z:-3) 上（见 md-editor.js liveTheme 头部注释：让选区可见）。
  // 只测元素自身的 background-color 会永远得到 transparent —— 假的"没背景"。
  const bgOf = (el) => {
    if (!el) return '';
    const own = css(el, 'background-color');
    if (!transparent(own)) return own;
    try { return getComputedStyle(el, '::before').backgroundColor || own; } catch { return own; }
  };
  const lineEl = (txt) => [...document.querySelectorAll('.cm-content .cm-line')].find((el) => el.textContent.includes(txt));
  const lineNoOf = (key) => DOC.slice(0, DOC.indexOf(key)).split('\n').length; // 动态行号（文档增删行仍稳）
  const click = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.x + Math.min(60, r.width / 2), y = r.y + r.height / 2;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail: 1 }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail: 1 }));
  };
  // 滚动让目标行进入视口（CM6 视口虚拟化：视口外的行不在 DOM —— 必须先滚过去才能测）
  const ensureVisible = async (el) => {
    el.scrollIntoView({ block: 'center' });
    await sleep(250); // 等 CM6 挂载行 + 应用装饰
  };
  // 光标层只在编辑器持有 DOM 焦点时绘制；隐藏窗口（headless 自检）拿不到焦点，
  // 量到 cursor=[0,0] 是环境限制（不是点击错位），记 SKIP；真聚焦了就必须量准 ——
  // 这才是「点哪光标在哪」的回归线。
  const cursorFits = (cr, lineR, label) => {
    if (!viewFocused()) return { skip: true, detail: label + ' 隐藏窗口无 DOM 焦点，CM6 不绘制光标层' };
    return {
      ok: !!cr && cr.height > 0 && cr.top >= lineR.top - 3 && cr.bottom <= lineR.bottom + 3,
      detail: 'cursor=[' + (cr && Math.round(cr.top)) + ',' + (cr && Math.round(cr.bottom)) + '] line=[' + Math.round(lineR.top) + ',' + Math.round(lineR.bottom) + ']',
    };
  };

  // ---------- 环境 ----------
  add('环境: live 模式 CM 编辑器挂载', !!document.querySelector('.editor-cm-wrap'));
  add('环境: 状态栏版本号显示', (document.getElementById('sb-ver').textContent || '').length > 0, document.getElementById('sb-ver').textContent);
  // 视图是否真正持有 DOM 焦点（隐藏窗口里拿不到）—— 选区层/光标高度这类绘制依赖它
  const viewFocused = () => !!api.view.hasFocus;
  const VIEW_FOCUSED = viewFocused();

  // ---------- 文本层（光标在文末） ----------
  for (const lv of ['一级标题 H1', '二级标题 H2', '三级标题 H3', '四级标题 H4', '五级标题 H5', '六级标题 H6']) {
    add('文本: ' + lv + ' 前缀 # 隐藏', has(lv) && !has('# ' + lv));
  }
  add('文本: ** 加粗标记隐藏', has('加粗文字') && !allText().includes('**'));
  add('文本: * 斜体标记隐藏', has('斜体文字') && !/\*斜体/.test(allText()));
  add('文本: ~~ 删除线标记隐藏', has('删除线文字') && !allText().includes('~~'));
  add('文本: ` 行内代码标记隐藏', has('行内代码') && !/`/.test(allText()));
  add('文本: == 高亮标记隐藏', has('高亮文字') && !allText().includes('=='));
  add('文本: 链接 URL 隐藏', has('行内链接文字') && !has('https://example.com)'));
  // 网址消失回归（用户报告）：空文字链接 URL 应作为显示文字（Obsidian 行为）
  add('文本: 空文字链接显示 URL', has('https://empty-label.example.com'));
  add('文本: 裸网址正常显示', has('https://bare-url.example.com/plain'), '行内容=' + (lineEl('裸网址') ? lineEl('裸网址').textContent : '(行不存在)'));
  {
    // 引用块在初始视口外（文档较长）→ 滚过去，光标移出引用行（光标行显形是设计行为）再检查
    const quoteLineNo = DOC.slice(0, DOC.indexOf('引用第一行')).split('\n').length;
    api.gotoLine(quoteLineNo); await sleep(300);
    api.setCursor(DOC.length); await sleep(150); // 光标移出引用行 → 恢复渲染态（不滚动）
    const quoteOk = has('引用第一行') && !has('> 引用第一行');
    add('文本: 引用 > 标记隐藏', quoteOk, quoteOk ? '' : '引用第一行可见=' + has('引用第一行') + ' 源码>可见=' + has('> 引用第一行'));
    api.gotoLine(1); await sleep(300);
  }
  add('文本: 围栏行 ``` 隐藏', !/```/.test(allText()));
  add('文本: 表格分隔行隐藏', !has('| :--- | :---: | ---: |'));
  add('文本: 分隔线 --- 文本隐藏', !has('---'));
  add('文本: 拼写检查关闭(无红波浪下划线)', cm.spellcheck === false, String(cm.spellcheck));
  add('文本: 转义 \\* 显示为字面量', has('*不是斜体*'));

  // ---------- 列表渲染（用户报告：无序列表没有渲染 / task 多渲染了 -） ----------
  {
    // 列表区在初始视口外 → 滚过去（bullet/task widget 与光标无关，光标行也常渲染）
    api.gotoLine(lineNoOf('无序列表一')); await sleep(350);
    const bullets = document.querySelectorAll('.cm-md-bullet');
    add('列表: 无序 bullet 圆点渲染', bullets.length >= 3, 'count=' + bullets.length);
    // 渲染态列表行不得残留源码 "- "
    const liLine = lineEl('无序列表一');
    add('列表: 无序行无源码 - ', liLine ? !/-\s无序/.test(liLine.textContent) && liLine.textContent.includes('•') : false,
      liLine ? JSON.stringify(liLine.textContent.slice(0, 12)) : '行不在 DOM');
    // ⚠ task 区（第 61~63 行）与无序列表（第 45~50 行）相隔十几行：视口高度一变
    //   （隐藏窗口会被系统按工作区压矮）它就不在 DOM 里 → 必须单独滚过去再断言，
    //   否则会量成 count=0 的假失败（实测 headless 下就是这么红的）
    api.gotoLine(lineNoOf('未完成任务')); await sleep(400);
    add('文本: task 源码 [ ] 隐藏', !has('[ ]') && !has('[x]'));
    add('文本: task checkbox widget 存在', document.querySelector('.cm-md-task') !== null);
    const tasks = document.querySelectorAll('.cm-md-task');
    add('列表: task 勾选框渲染', tasks.length >= 3, 'count=' + tasks.length);
    const doneTask = document.querySelector('.cm-md-task.done');
    add('列表: 已完成 task 勾选样式', doneTask !== null, '');
    // task 行不残留 "-"（`- ` 整体隐藏后接勾选框，不是「• ☐」）
    const taskLine = lineEl('未完成任务');
    add('列表: task 行无源码 - ', taskLine ? !/-\s*\[/.test(taskLine.textContent) && !taskLine.textContent.includes('•') : false,
      taskLine ? JSON.stringify(taskLine.textContent.slice(0, 12)) : '行不在 DOM');
    // 点击勾选框切换（用户报告：无法通过点击切换）
    if (tasks.length) {
      const t0 = tasks[0];
      const before = api.getValue();
      t0.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      t0.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(150);
      const after = api.getValue();
      const toggled = before.includes('- [ ] 未完成任务') && after.includes('- [x] 未完成任务');
      add('行为: 点击 task 勾选框切换状态', toggled,
        'before[ ]→after[x]=' + toggled + (toggled ? '' : ' after片段=' + JSON.stringify(after.slice(after.indexOf('未完成') - 8, after.indexOf('未完成') + 6))));
      // 切回（保持文档原状）
      const tasks2 = document.querySelectorAll('.cm-md-task');
      if (tasks2.length) {
        tasks2[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        tasks2[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(120);
      }
    }
  }

  // ---------- 图片渲染（用户报告：图片没有显示） ----------
  {
    // 远程图（视口滚到该行；光标行首不进构造 → widget 渲染）
    api.gotoLine(lineNoOf('测试图片')); await sleep(350);
    const remote = [...document.querySelectorAll('.cm-md-img img')].find((im) => (im.getAttribute('src') || '').includes('example.com'));
    add('图片: 远程图 widget 渲染', remote !== null, remote ? remote.getAttribute('src') : '未找到');
    // 远程占位图（example.com 404）→ 虚线占位框（不显示裂图）
    await sleep(600);
    const broken = q('.cm-md-img-broken');
    add('图片: 加载失败显示占位框', broken !== null, broken ? broken.textContent.slice(0, 20) : '占位未出现');
    // 本地相对路径图（单独滚到该行 —— 视口虚拟化）
    api.gotoLine(lineNoOf('本地图标')); await sleep(350);
    const local = [...document.querySelectorAll('.cm-md-img img')].find((im) => (im.getAttribute('src') || '').includes('build/icon.png'));
    add('图片: 本地图 widget 渲染', local !== null, local ? '' : '未找到本地图');
    add('图片: 本地相对路径解析为 file:///', local && /^file:\/\/\//.test(local.getAttribute('src') || ''),
      local ? local.getAttribute('src') : '未找到本地图');
  }

  // ---------- 样式层（视口内元素；先滚回文首 —— 前面的测试滚走了视口） ----------
  api.gotoLine(1); await sleep(350);
  const h1 = q('.cm-md-h1');
  // 字号不再写死绝对值：编辑区字号可调（--editor-font-size），写死就会在用户调大字号时
  // 变成"标题比正文还小"。这里锁「层级关系」与「跨模式一致」（后者见文件末尾的一致性块）。
  const bodyFont = parseFloat(css(q('.cm-line:not([class*="cm-md-h"])'), 'font-size') || '0');
  const h1Font = parseFloat(css(h1, 'font-size') || '0');
  add('样式: h1 字号 > 正文字号', h1 && h1Font > bodyFont && bodyFont > 0, 'h1=' + css(h1, 'font-size') + ' 正文=' + bodyFont + 'px');
  const h2 = q('.cm-md-h2'), h3 = q('.cm-md-h3'), h4 = q('.cm-md-h4'), h5 = q('.cm-md-h5'), h6 = q('.cm-md-h6');
  const sizes = [h2, h3, h4, h5, h6].map((e) => parseFloat(css(e, 'font-size') || '0'));
  add('样式: 标题层级不塌（h2≥h3≥h4≥h5=h6≥正文）',
    sizes.every((s) => s >= bodyFont - 0.1) && sizes[0] >= sizes[1] && sizes[1] >= sizes[2] && sizes[2] >= sizes[3] && sizes[3] >= sizes[4],
    'body=' + bodyFont + ' h2..h6=' + sizes.join('/'));
  const h1line = q('.cm-md-h1-line');
  add('样式: h1 行无下划线', h1line && (css(h1line, 'border-bottom-style') === 'none' || parseFloat(css(h1line, 'border-bottom-width') || '0') === 0),
    css(h1line, 'border-bottom-style') + '/' + css(h1line, 'border-bottom-width'));
  const strong = q('.cm-md-strong');
  add('样式: 加粗 700', strong && (css(strong, 'font-weight') === '700' || css(strong, 'font-weight') === 'bold'), css(strong, 'font-weight'));
  const em = q('.cm-md-em');
  add('样式: 斜体 italic', em && css(em, 'font-style') === 'italic', css(em, 'font-style'));
  const strike = q('.cm-md-strike');
  add('样式: 删除线', strike && css(strike, 'text-decoration-line').includes('line-through'), css(strike, 'text-decoration-line'));
  const code = q('.cm-md-code');
  add('样式: 行内代码背景', code && !transparent(bgOf(code)), code ? bgOf(code) : '元素不存在');
  const hl = q('.cm-md-highlight');
  add('样式: ==高亮== 背景', !!hl && !transparent(bgOf(hl)), hl ? bgOf(hl) : '元素不存在');

  // ---------- 行为层 ----------
  api.setCursor(DOC.length); await sleep(150);
  const boldMark = DOC.indexOf('**');
  api.setCursor(boldMark + 1); await sleep(120);
  add('行为: 光标紧邻 ** 显形', allText().includes('**'));
  api.setCursor(DOC.indexOf('加粗文字') + 2); await sleep(120);
  add('行为: 光标移开 ** 重新隐藏', !allText().includes('**'));
  api.setCursor(DOC.indexOf('行内链接文字') + 2); await sleep(120);
  add('行为: 光标进链接显示完整源码', has('[行内链接文字]') && has('(https://example.com)'));
  api.setCursor(DOC.indexOf('# 一级标题') + 1); await sleep(120);
  add('行为: 光标在标题行 # 显形', has('# 一级标题 H1'));
  api.setCursor(DOC.length); await sleep(120);
  add('行为: 光标离开标题行 # 重新隐藏', !has('# 一级标题 H1'));
  api.setCursor(DOC.indexOf('正文包含'), DOC.indexOf('混排') + 2); await sleep(120);
  add('行为: 多行选择保持渲染态', !allText().includes('**'));
  api.setCursor(DOC.length); await sleep(120);

  // ---------- 选区可见性（用户报告：多选文字没有 UI 显示，根本不知道选了哪里） ----------
  // ⚠ CM6 的 drawSelection 只在编辑器持有焦点时画选区层：隐藏窗口（headless 自检）里
  //   拿不到 DOM 焦点 → 选区层根本不存在，记 FAIL 是假回归。此时记 SKIP，
  //   要全量校验就用 --check-live-show（窗口真正显示的那次跑）。
  if (!viewFocused()) {
    skip('选区: 多行选择背景块渲染', '隐藏窗口无 DOM 焦点，CM6 不绘制选区层');
    skip('选区: 背景色非透明', '同上');
    skip('选区: 渲染态正文选区可见', '同上');
  } else {
    // 跨多行渲染态选区（第21行段首 → 第23行段中，跨空行）：每行一块背景，drawSelection 必须都画
    const a = DOC.indexOf('正文包含');
    const b = DOC.indexOf('删除线与') + 3;
    api.setCursor(a, b); await sleep(200);
    const selEls = [...document.querySelectorAll('.cm-selectionBackground')];
    const vis = selEls.filter((s) => {
      const c = css(s, 'background-color');
      const r = s.getBoundingClientRect();
      return !transparent(c) && r.width > 0 && r.height > 0;
    });
    add('选区: 多行选择背景块渲染', vis.length >= 2, '可见块=' + vis.length + '/总=' + selEls.length);
    add('选区: 背景色非透明', vis.length > 0 && !transparent(css(vis[0], 'background-color')),
      vis.length ? css(vis[0], 'background-color') : '无选区块');
    // 选区覆盖渲染态文字（选区两端落在正文中段，远离标记间隙）：正文文字上必须有背景
    const c1 = DOC.indexOf('正文包含') + 2;
    const c2 = DOC.indexOf('正文包含') + 6;
    api.setCursor(c1, c2); await sleep(150);
    const vis2 = [...document.querySelectorAll('.cm-selectionBackground')]
      .filter((s) => s.getBoundingClientRect().width > 0 && !transparent(css(s, 'background-color')));
    add('选区: 渲染态正文选区可见', vis2.length >= 1, '块数=' + vis2.length);
    api.setCursor(DOC.length); await sleep(100);
  }

  // 下划线全面扫描（用户报告"还是有下划线"）：编辑器内任何元素不得出现
  // text-decoration: underline（spellcheck 红波浪已由属性关闭，这里兜底样式层）
  {
    api.setCursor(DOC.length); await sleep(150);
    const bad = [...cm.querySelectorAll('*')].filter((el) => {
      const d = getComputedStyle(el).textDecorationLine;
      return d && d.includes('underline');
    }).slice(0, 3).map((el) => el.className + ':' + getComputedStyle(el).textDecorationLine);
    add('样式: 全编辑器无 underline 下划线', bad.length === 0, bad.join(' | ') || '');
  }

  // ---------- 滚动后元素检查（CM6 视口虚拟化：表格/代码块初始在视口外，gotoLine 滚过去再测） ----------
  // 表格（用户报告：表格没有渲染）
  api.gotoLine(lineNoOf('左对齐列')); await sleep(350); // 滚到表格区（gotoLine 会把光标放进表格 → 源码态）
  api.setCursor(DOC.length); await sleep(250); // 光标移出表格（setCursor 不滚动）→ 恢复 widget 态
  {
    const tbl = q('.cm-md-table');
    add('表格: block widget 真表格渲染', !!tbl, tbl ? '' : '元素不存在');
    if (tbl) {
      const ths = tbl.querySelectorAll('thead th');
      add('表格: 表头 3 列', ths.length === 3, 'th=' + ths.length);
      add('表格: 列对齐 left/center/right',
        css(ths[0], 'text-align') === 'left' && css(ths[1], 'text-align') === 'center' && css(ths[2], 'text-align') === 'right',
        [0, 1, 2].map((i) => css(ths[i], 'text-align')).join('/'));
      add('表格: 数据 3 行', tbl.querySelectorAll('tbody tr').length === 3, 'tr=' + tbl.querySelectorAll('tbody tr').length);
      add('表格: 表头背景', !transparent(css(ths[0], 'background-color')), css(ths[0], 'background-color'));
      const td0 = tbl.querySelector('tbody td');
      add('表格: 单元格边框', parseFloat(css(td0, 'border-top-width') || '0') > 0, css(td0, 'border-top-width'));
      add('表格: 内容完整(单元格A1..C3)', tbl.textContent.includes('单元格A1') && tbl.textContent.includes('C3'), tbl.textContent.slice(0, 30));
    }
    // 光标进表格 → 对应单元格保持网格编辑
    api.setCursor(DOC.indexOf('单元格A1') + 3); await sleep(150);
    add('表格: 光标进表格保持网格编辑', q('.cm-md-cell-editor')?._cellView?.state.doc.toString() === '单元格A1' && q('.cm-md-table') !== null, '');
    api.setCursor(DOC.length); await sleep(150);
    add('表格: 光标移出恢复渲染', q('.cm-md-table') !== null, '');
    // 点击单元格 → 光标精确进入对应源码格（用户报告：表格没有直接操作功能）
    const tbl2 = q('.cm-md-table');
    if (tbl2) {
      await ensureVisible(tbl2);
      // 第 1 数据行第 1 列（单元格A1）→ 光标应落在源码 "| 单元格A1" 的 A1 前
      const td = tbl2.querySelectorAll('tbody td')[0];
      if (td) {
        const r = td.getBoundingClientRect();
        td.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + r.height / 2, button: 0, detail: 1 }));
        await sleep(120);
        const sel = api.getSelection();
        const li = DOC.indexOf('| 单元格A1');
        const le = DOC.indexOf('\n', li);
        add('行为: 点击单元格光标精确进入该格', sel.head >= li && sel.head <= le,
          'head=' + sel.head + ' 格行范围=[' + li + ',' + le + ']');
      } else add('行为: 点击单元格光标精确进入该格', false, '无 td');
    }
  }
  // 代码块（用户报告：代码块无法操作 / 要复制按钮和语法高亮）
  api.gotoLine(lineNoOf('const msg')); await sleep(350);
  let codeLine = lineEl('const msg');
  if (!codeLine) codeLine = lineEl('function greet');
  {
    const fence2 = q('.cm-md-fence-line');
    add('代码块(滚动后): 行背景', fence2 && !transparent(bgOf(fence2)), fence2 ? bgOf(fence2) : '元素不存在');
    // 复制按钮 + 语言标签（用户报告：代码块添加复制按钮）
    const copyBtn = q('.cm-md-copybtn');
    add('代码块: 复制按钮渲染', copyBtn !== null, copyBtn ? '' : '元素不存在');
    const langLabel = copyBtn && copyBtn.querySelector('.cm-md-copybtn-lang');
    add('代码块: 语言标签显示', langLabel && langLabel.textContent.toLowerCase() === 'js',
      langLabel ? langLabel.textContent : '无标签');
    const copyBtnEl = copyBtn && copyBtn.querySelector('button');
    add('代码块: 复制按钮可点击结构', copyBtnEl && copyBtnEl.textContent === '复制', copyBtnEl ? copyBtnEl.textContent : '无按钮');
    // 真语法高亮（用户报告：识别语法显示不同颜色）：语言包异步加载后 fence 行内
    // 出现彩色 token span；关键字 function 应为 One Dark 紫 #c678dd = rgb(198,120,221)
    await sleep(900);
    const fenceSpans = [...document.querySelectorAll('.cm-md-fence-line span[class^="ͼ"]')];
    add('代码块: 语法 token 渲染', fenceSpans.length >= 5, 'tokens=' + fenceSpans.length);
    const colors = new Set(fenceSpans.map((s) => css(s, 'color')));
    const multiColor = [...colors].filter((c) => c && c !== 'rgb(171, 178, 191)');
    add('代码块: 多色语法高亮', multiColor.length >= 3, 'colors=' + multiColor.slice(0, 5).join(','));
    add('代码块: 关键字紫色(#c678dd)', colors.has('rgb(198, 120, 221)'),
      'hasPurple=' + colors.has('rgb(198, 120, 221)') + ' 全部=' + [...colors].slice(0, 6).join(','));
    // 光标进代码块内容行 → 围栏显形（Obsidian：光标进块整块变源码态）
    api.setCursor(DOC.indexOf('const msg') + 3); await sleep(150);
    add('代码块: 光标进块围栏显形', allText().includes('```'), '');
    api.setCursor(DOC.length); await sleep(150);
    add('代码块: 光标移出围栏隐藏', !allText().includes('```'), '');
  }

  // ---------- 点击命中（用户报告：点击高度与选中不一致 / 代码块无法操作） ----------
  // 1. 点击代码块内容行 → 光标落入该行
  api.setCursor(DOC.indexOf('const msg') + 3); await sleep(150); // 源码态（围栏可见）
  if (codeLine) {
    await ensureVisible(codeLine);
    api.focus(); await sleep(80);
    click(codeLine);
    await sleep(250);
    const sel = api.getSelection();
    const i = DOC.indexOf('const msg');
    const lineEnd = DOC.indexOf('\n', i);
    add('行为: 点击代码块内容光标进入', sel && sel.head >= i - 1 && sel.head <= lineEnd, JSON.stringify(sel));
    const cur = [...document.querySelectorAll('.cm-cursor')].find((c) => c.getBoundingClientRect().height > 0) || q('.cm-cursor');
    const cr = cur && cur.getBoundingClientRect();
    const lineR = codeLine.getBoundingClientRect();
    const fit = cursorFits(cr, lineR, '代码行');
    if (fit.skip) skip('行为: 点击高度与光标高度一致(代码行)', fit.detail);
    else add('行为: 点击高度与光标高度一致(代码行)', fit.ok, fit.detail);
  } else add('行为: 点击代码块内容光标进入', false, '未找到代码行');

  // 2. 点击标题行（有 padding，最易出现命中偏移）
  api.setCursor(DOC.length); await sleep(150);
  api.gotoLine(lineNoOf('一级标题 H1')); await sleep(350);
  const h1El = lineEl('一级标题 H1');
  if (h1El) {
    await ensureVisible(h1El);
    api.focus(); await sleep(80);
    click(h1El);
    await sleep(250);
    const sel = api.getSelection();
    const i = DOC.indexOf('# 一级标题');
    const lineEnd = DOC.indexOf('\n', i);
    add('行为: 点击标题行光标进入', sel && sel.from === sel.to && sel.head >= i && sel.head <= lineEnd, JSON.stringify(sel));
    const cur = [...document.querySelectorAll('.cm-cursor')].find((c) => c.getBoundingClientRect().height > 0) || q('.cm-cursor');
    const cr = cur && cur.getBoundingClientRect();
    const lineR = h1El.getBoundingClientRect();
    const fit = cursorFits(cr, lineR, '标题行');
    if (fit.skip) skip('行为: 点击高度与光标高度一致(标题行)', fit.detail);
    else add('行为: 点击高度与光标高度一致(标题行)', fit.ok, fit.detail);
  }
  // 3. 表格区点击映射（源码态下逐行点击 → 光标必须精确命中该行）
  //    先把光标放进表格（widget → 源码态），顺序：表格内行优先，表格外的行最后
  //    （点表格外的行会让表格恢复 widget，之后表格行就不在 DOM 了）
  api.setCursor(DOC.indexOf('单元格A1') + 2); await sleep(200); // 进源码态
  api.gotoLine(lineNoOf('单元格A1')); await sleep(350);
  {
    const lineOf = (pos) => DOC.slice(0, pos).split('\n').length;
    // ⚠ 隐藏窗口（headless 自检）里 Chromium 不跑 rAF → CM6 的 measure 循环可能滞后一拍，
    //   第一次按 rect 点击会落到上一行的位置（实测偶发：「单元格A2」落到 A1 那行）。
    //   命中失败才重试一次（先 scrollIntoView + 等一拍），而不是无条件点两次。
    const clickLine = async (key, el) => {
      const i = DOC.indexOf(key), lineEnd = DOC.indexOf('\n', i);
      let sel = api.getSelection();
      for (let attempt = 0; attempt < 2; attempt++) {
        await ensureVisible(el);
        await sleep(150);
        click(el);
        await sleep(180);
        sel = api.getSelection();
        if (sel.head >= i - 1 && sel.head <= lineEnd) return sel;
      }
      return sel;
    };
    for (const key of ['单元格A2', '内容较长的一格', '左对齐列', '单元格A1', '七、表格', '八、其他块级']) {
      const el = [...document.querySelectorAll('.cm-md-table th,.cm-md-table td')].find(e => e.textContent.includes(key) || e.querySelector('.cm-md-cell-editor')?._cellView?.state.doc.toString().includes(key)) || lineEl(key);
      if (!el) { add('映射: ' + key, false, '行不在 DOM'); continue; }
      const sel = await clickLine(key, el);
      const i = DOC.indexOf(key);
      const lineEnd = DOC.indexOf('\n', i);
      add('映射: 点击「' + key.slice(0, 6) + '」行 → 落在第 ' + lineOf(sel.head) + ' 行',
        sel.head >= i - 1 && sel.head <= lineEnd,
        'head=' + sel.head + ' 行范围=[' + (i - 1) + ',' + lineEnd + '] 期望行=' + lineOf(i));
    }
  }
  // 4. 表格源码行点击：光标命中 + 高度一致
  api.setCursor(DOC.indexOf('单元格A1') + 2); await sleep(150); // 保持源码态
  const trEl = q('.cm-md-cell-editor')?.closest('td');
  if (trEl) {
    await ensureVisible(trEl);
    api.focus(); await sleep(80);
    click(trEl);
    await sleep(250);
    const sel = api.getSelection();
    const i = DOC.indexOf('单元格A1');
    const lineEnd = DOC.indexOf('\n', i);
    add('行为: 点击表格单元格光标进入', sel && sel.head >= i - 1 && sel.head <= lineEnd, JSON.stringify(sel));
    const input = q('.cm-md-cell-editor'), rect = input?.getBoundingClientRect(), cellRect = trEl.getBoundingClientRect();
    add('行为: 表格输入框位于对应单元格内', rect && rect.top >= cellRect.top && rect.bottom <= cellRect.bottom, '');
  } else add('行为: 点击表格单元格光标进入', false, '未找到表格行');

  // ---------- 一致性：同一份文档「实时预览」与「预览」的排版必须对得上 ----------
  // 用户报告的原话：「markdown 的实时预览和预览差别非常大，实时预览根本没法看，样式非常差」。
  // 根因是两边各写一套绝对 px，且只有 live 跟随 --editor-font-size → 字号一调层级就塌。
  // 这里把两边的计算样式逐项对比锁死：以后谁再把 px 写回去，这里立刻红。
  {
    // 预览侧：临时把 .md-view 渲染到屏幕外（仍有布局 → 计算样式有效），不切模式即可同屏对比
    // ⚠ 容器宽度必须取「编辑区实际宽度」：固定 900px 时预览会拿到满 820 的列宽，而 live 那边
    //   受编辑区实际宽度限制（实测 800 → 正文列 732）→ 会量出一个假差异
    const tmp = document.createElement('div');
    const editorW = (() => { const e = document.querySelector('.editor-cm-wrap'); return e ? Math.round(e.getBoundingClientRect().width) : 900; })();
    tmp.style.cssText = 'position:fixed;left:-100000px;top:0;width:' + (editorW || 900) + 'px;';
    document.body.appendChild(tmp);
    let pv = null;
    try {
      const fn = MI.renderFor({ path: 'x.md', name: 'x.md', ext: 'md' });
      pv = fn && fn({ path: 'x.md', name: 'x.md', ext: 'md', content: DOC });
      if (pv) tmp.appendChild(pv);
    } catch (e) { pv = null; }
    add('一致性: 预览侧渲染成功（对照基准）', !!pv, pv ? '' : '渲染失败');
    if (pv) {
      const num = (el, prop) => (el ? parseFloat(css(el, prop)) || 0 : 0);
      const show = (el, prop) => (el ? css(el, prop) : '缺');
      // 行内元素（加粗/斜体/行内代码/高亮）在两边的**同一个源行**里取，否则会拿 live 的
      // 引用块内加粗去比预览正文里的加粗（实测踩过：颜色对不上是取错元素，不是真差异）
      const findLive = (c) => (c.scope ? (lineEl(c.scope) || { querySelector: () => null }).querySelector(c.live) : q(c.live));
      const findPv = (c) => {
        if (!c.scope) return pv.querySelector(c.pv);
        const holder = [...pv.querySelectorAll('p,li,blockquote,td,th')].find((e) => e.textContent.includes(c.scope));
        return holder ? (holder.matches(c.pv) ? holder : holder.querySelector(c.pv)) : null;
      };
      // live 元素可能因视口虚拟化不在 DOM → 先滚到该行（光标随后移开，恢复渲染态）
      const ensureLive = async (c) => {
        if (!findLive(c)) {
          api.gotoLine(lineNoOf(c.doc || c.scope)); await sleep(320);
          api.setCursor(DOC.length); await sleep(180);
        }
      };
      const CASES = [
        { name: 'h1', live: '.cm-md-h1', pv: 'h1', doc: '一级标题 H1' },
        { name: 'h2', live: '.cm-md-h2', pv: 'h2', doc: '二级标题 H2' },
        { name: 'h3', live: '.cm-md-h3', pv: 'h3', doc: '三级标题 H3' },
        { name: 'h4', live: '.cm-md-h4', pv: 'h4', doc: '四级标题 H4' },
        { name: 'h5', live: '.cm-md-h5', pv: 'h5', doc: '五级标题 H5' },
        { name: 'h6', live: '.cm-md-h6', pv: 'h6', doc: '六级标题 H6' },
        { name: '正文', live: '.cm-line:not([class*="cm-md-"])', pv: 'p', doc: '正文包含' },
        { name: '加粗', live: '.cm-md-strong', pv: 'strong', scope: '正文包含' },
        { name: '斜体', live: '.cm-md-em', pv: 'em', scope: '正文包含' },
        { name: '行内代码', live: '.cm-md-code', pv: 'code', scope: '删除线与' },
        { name: '高亮', live: '.cm-md-highlight', pv: 'mark', scope: '高亮文字' },
        { name: '引用', live: '.cm-line.cm-md-quote-line', pv: 'blockquote', doc: '引用第一行' },
        { name: '代码块', live: '.cm-line.cm-md-fence-line', pv: 'pre code', doc: 'const msg' },
        { name: '表头格', live: '.cm-md-table th', pv: 'th', doc: '左对齐列' },
        { name: '数据格', live: '.cm-md-table td', pv: 'td', doc: '左对齐列' },
      ];
      api.gotoLine(1); await sleep(320);
      for (const c of CASES) {
        await ensureLive(c);
        const le = findLive(c), ve = findPv(c);
        const lf = num(le, 'font-size'), vf = num(ve, 'font-size');
        add('一致性: ' + c.name + ' 字号两边相同', !!(le && ve) && Math.abs(lf - vf) <= 0.75,
          'live=' + (le ? show(le, 'font-size') : '元素不在视口') + ' preview=' + (ve ? show(ve, 'font-size') : '缺'));
      }
      // 颜色也必须一致：只锁字号是不够的 —— 用户报的「文字几乎全是白色」就是颜色漂移
      // （实时预览正文用 --editor-text、加粗用 --text-bright，预览用 --text，crimson 下差一档亮度）。
      // 两边可能一个给 rgb()、一个给 color(srgb …)（color-mix 的结果），这里统一归一化后比。
      const parseColor = (c) => {
        if (!c) return null;
        let m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?/.exec(c);
        if (m) return [1, 2, 3].map((i) => parseFloat(m[i]) * 255).concat(m[4] != null ? [parseFloat(m[4]) * 255] : []);
        m = /^rgba?\(([^)]+)\)/.exec(c);
        if (m) return m[1].split(',').map((v) => parseFloat(v)).slice(0, 4);
        return null;
      };
      const closeColor = (a, b) => {
        const x = parseColor(a), y = parseColor(b);
        if (!x || !y) return String(a) === String(b);
        if (Math.abs(x.length - y.length) > 1) return false;
        for (let i = 0; i < 3; i++) if (Math.abs((x[i] || 0) - (y[i] || 0)) > 2) return false;
        return true;
      };
      // ⚠ 颜色循环前必须滚回文首：上一轮已经滚到表格，视口外的标题不在 DOM（会量成「缺」）
      api.gotoLine(1); await sleep(320);
      for (const c of CASES) {
        await ensureLive(c);
        const le = findLive(c), ve = findPv(c);
        const lc = show(le, 'color'), vc = show(ve, 'color');
        add('一致性: ' + c.name + ' 颜色两边相同', !!(le && ve) && closeColor(lc, vc),
          'live=' + lc + ' preview=' + vc);
      }
      // 嵌套列表缩进量：实时预览用 IndentWidget 撑出与预览 ul padding-left 同宽的缩进
      // （历史：源码里的 2 空格在比例字体下只有 9px vs 预览 24px → 子项看起来跟父项齐平）
      {
        const textLeft = (el) => {
          if (!el) return null;
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = w.nextNode())) {
            if (n.textContent.trim()) {
              const rg = document.createRange();
              rg.setStart(n, 0); rg.setEnd(n, 1);
              return Math.round(rg.getBoundingClientRect().left);
            }
          }
          return null;
        };
        api.gotoLine(lineNoOf('无序列表一')); await sleep(400);
        const dLive = textLeft(lineEl('嵌套列表二一')) - textLeft(lineEl('无序列表一'));
        const pvParent = [...pv.querySelectorAll('li')].find((e) => e.textContent.includes('无序列表一') && !e.textContent.includes('嵌套'));
        const pvChild = [...pv.querySelectorAll('li')].find((e) => e.textContent.trim().startsWith('嵌套列表二一'));
        const dPv = textLeft(pvChild) - textLeft(pvParent);
        add('一致性: 嵌套列表缩进量相同', Number.isFinite(dLive) && Number.isFinite(dPv) && Math.abs(dLive - dPv) <= 3,
          'live=' + dLive + 'px preview=' + dPv + 'px');
        api.gotoLine(1); await sleep(250);
      }
      // 字重/列宽/内边距也一并锁：层级感与行长都靠它们
      // ⚠ 必须先把视口滚回文首 —— 上面的字号循环会滚到引用/代码块/表格处，
      //   视口虚拟化后 .cm-md-h1 不在 DOM 里，量到的是「缺」而不是真值
      api.gotoLine(1); await sleep(320);
      for (const [n, sel, tag] of [['h1', '.cm-md-h1', 'h1'], ['h2', '.cm-md-h2', 'h2'], ['h3', '.cm-md-h3', 'h3']]) {
        const lw = show(q(sel), 'font-weight'), vw2 = show(pv.querySelector(tag), 'font-weight');
        add('一致性: ' + n + ' 字重两边相同', lw === vw2, 'live=' + lw + ' preview=' + vw2);
      }
      api.gotoLine(1); await sleep(300);
      const cw = document.querySelector('.cm-content');
      // 正文档位现在挂在 scroller 上（`.cm-content` 不能吃横向内边距 —— 那会让 CM6 的
      // 整行选区矩形比正文列宽出这段，见 md-editor.js baseTheme 的注释）
      const sc = q('.editor-cm-wrap .cm-scroller');
      // live 把左侧滚动条 gutter 换成等宽普通 padding，避免 CM6 图层原点偏移。
      // 比较时扣掉这一段补偿；仍检查左右基础间距、列宽上限与预览同源。
      const gutter = sc.offsetWidth - sc.clientWidth - num(sc, 'border-left-width') - num(sc, 'border-right-width');
      const baseLeft = num(sc, 'padding-left') - gutter;
      add('一致性: 正文列宽上限与左右基础间距同源（扣除滚动条补偿）',
        num(sc, 'max-width') === num(pv, 'max-width') && num(sc, 'max-width') > 0
        && Math.abs(baseLeft - num(pv, 'padding-left')) <= 1 && num(sc, 'padding-right') === num(pv, 'padding-right'),
        'live=' + show(sc, 'max-width') + '/' + baseLeft + 'px/' + show(sc, 'padding-right') + ' gutter=' + gutter
        + ' preview=' + show(pv, 'max-width') + '/' + show(pv, 'padding-left') + '/' + show(pv, 'padding-right'));
      add('一致性: .cm-content 不吃横向内边距（否则选区色块会宽出这段）',
        num(cw, 'padding-left') === 0 && num(cw, 'padding-right') === 0,
        'content=' + show(cw, 'padding-left') + '/' + show(cw, 'padding-right'));
      add('坐标: scroller 左侧无 gutter（光标与选区原点一致）',
        sc.clientLeft === num(sc, 'border-left-width'), 'clientLeft=' + sc.clientLeft);
      // 预览必须跟随「编辑区字号」：状态栏那个 − 17 + 调的就是它，不跟随 = 用户改了字号没反应
      add('一致性: 预览跟随编辑区字号',
        Math.abs(num(pv, 'font-size') - num(cw, 'font-size')) <= 0.75,
        '预览正文=' + show(pv, 'font-size') + ' 编辑器基准=' + show(cw, 'font-size'));
      // 预览的语法渲染必须补上 live 有的扩展语法（==高亮== 曾是 live 有、预览没有）
      add('一致性: 预览渲染 ==高亮== 为 <mark>', !!pv.querySelector('mark'), pv.querySelector('mark') ? '' : '未渲染（显示为裸 ==文本==）');
      add('一致性: 预览的空文字链接显示 URL',
        [...pv.querySelectorAll('a')].some((a) => a.getAttribute('href') === 'https://empty-label.example.com' && a.textContent.trim()),
        '');
    }
    tmp.remove();
  }

  // ---------- 表格 Excel 式编辑（Tab 换格 / 末行末格增行 / Enter 下行 / 自动对齐） ----------
  // 用户原话：「表格也不能像 excel 那样的表格使用」。旧实现 Tab 只在本行找下一个 `|`，
  // 行尾就停住；Enter 会把一行表格劈成两行。这里按键盘真实路径验（合成 keydown → CM6 keymap）。
  {
    const pressKey = (k, keyCode) => {
      const ev = new KeyboardEvent('keydown', { key: k, keyCode, which: keyCode, bubbles: true, cancelable: true });
      (q('.cm-md-cell-editor')?._cellView.contentDOM || document.querySelector('.cm-content')).dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const tblOrig = api.getValue();
    // 等宽显示宽度（CJK 算 2 列）——判断"各行竖线是否落在同一列"
    const dw = (s) => { let n = 0; for (const ch of s) n += /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1; return n; };
    const tableLines = () => api.getValue().split('\n').filter((l) => /^\s*\|/.test(l));
    const gridAligned = () => {
      const pos = tableLines().map((l) => { const p = []; for (let k = 0; k < l.length; k++) if (l[k] === '|') p.push(dw(l.slice(0, k))); return p; });
      return pos.length > 1 && pos.every((p) => JSON.stringify(p) === JSON.stringify(pos[0]));
    };
    const cursorCell = () => {
      const st = api.view.state, line = st.doc.lineAt(st.selection.main.head);
      const rel = st.selection.main.head - line.from;
      return { col: (line.text.slice(0, rel).match(/\|/g) || []).length - 1, lineNo: line.number, line };
    };
    api.gotoLine(lineNoOf('左对齐列') + 2); await sleep(350);   // 第 1 数据行
    api.setCursor(DOC.indexOf('| 单元格A1') + 2); await sleep(250);
    const startCell = cursorCell();
    add('表格: 光标初始在第 1 格', startCell.col === 0, 'col=' + startCell.col);
    const handled = pressKey('Tab', 9); await sleep(300);
    const cell2 = cursorCell();
    add('表格: Tab 被表格接管', handled, '');
    add('表格: Tab 换到下一格', cell2.col === 1 && cell2.lineNo === startCell.lineNo,
      'row ' + startCell.lineNo + '→' + cell2.lineNo + ' col ' + startCell.col + '→' + cell2.col);
    add('表格: Tab 换格不修改正文', api.getValue() === tblOrig, '');
    // 末行末格 Tab → 追加一行并对齐
    const lastRowText = tableLines().filter((l) => !/^\s*\|[\s:|-]*\|/.test(l)).pop();
    const lastIdx = api.getValue().lastIndexOf(lastRowText);
    api.setCursor(lastIdx + 2); await sleep(250);
    const linesBefore = api.view.state.doc.lines;
    for (let i = 0; i < 4; i++) { pressKey('Tab', 9); await sleep(200); }
    const linesAfter = api.view.state.doc.lines;
    add('表格: 末行末格 Tab 追加一行', linesAfter === linesBefore + 1, 'lines ' + linesBefore + '→' + linesAfter);
    add('表格: 追加后仍对齐', gridAligned(), tableLines().map((l) => dw(l)).join('/'));
    // Enter：表内下移一行（不劈裂表格）
    api.setCursor(api.getValue().indexOf('| 单元格A2') + 2); await sleep(250);
    const beforeEnter = { lines: api.view.state.doc.lines, cell: cursorCell() };
    pressKey('Enter', 13); await sleep(300);
    const afterEnter = { lines: api.view.state.doc.lines, cell: cursorCell() };
    add('表格: Enter 表内下移一行不劈裂', afterEnter.lines === beforeEnter.lines && afterEnter.cell.lineNo === beforeEnter.cell.lineNo + 1,
      'lines ' + beforeEnter.lines + '→' + afterEnter.lines + ' 行 ' + beforeEnter.cell.lineNo + '→' + afterEnter.cell.lineNo);
    // 还原文档（自检不得改用户文件：还原后自动保存写回的还是原文）
    api.setValue(tblOrig);
    await sleep(200);
    add('表格: 自检后文档已还原', api.getValue() === tblOrig, '');
  }

  // ---------- Callout（Obsidian > [!note] 提示块）两种模式对照 ----------
  {
    // live：滚到 callout 区（视口虚拟化）
    api.gotoLine(lineNoOf('自定义标题')); await sleep(400);
    api.setCursor(DOC.length); await sleep(250);   // 光标移开 → 渲染态
    const coLines = [...document.querySelectorAll('.cm-line.cm-md-callout-line')];
    add('Callout(live): 逐行渲染成 callout', coLines.length >= 5, 'count=' + coLines.length);
    add('Callout(live): 图标 widget 渲染', document.querySelectorAll('.cm-md-callout-ic').length >= 3,
      'count=' + document.querySelectorAll('.cm-md-callout-ic').length);
    add('Callout(live): 标题用类型色', document.querySelectorAll('.cm-md-callout-title').length >= 2,
      'count=' + document.querySelectorAll('.cm-md-callout-title').length);
    const noteLine = coLines.find((e) => e.className.includes('co-note'));
    add('Callout(live): 左竖线/底色画在 ::before 且非透明',
      !!noteLine && (() => {
        const b = getComputedStyle(noteLine, '::before');
        return parseFloat(b.borderLeftWidth || '0') >= 2 && !transparent(b.backgroundColor);
      })(),
      noteLine ? getComputedStyle(noteLine, '::before').borderLeftWidth + '/' + getComputedStyle(noteLine, '::before').backgroundColor : '无 co-note 行');
    // 源码标记 `> [!note]` 在渲染态应隐藏（光标移开后）
    add('Callout(live): 渲染态隐藏 [!type] 标记', !allText().includes('[!note]') && !allText().includes('[!warning]'),
      '');
    // 普通引用不受影响（引用竖线仍在）
    add('Callout(live): 普通引用仍是引用样式', document.querySelector('.cm-line.cm-md-quote-line') !== null, '');
    // 预览：同屏对照（屏幕外渲染）
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:900px;';
    document.body.appendChild(holder);
    try {
      const fn = MI.renderFor({ path: 'x.md', name: 'x.md', ext: 'md' });
      const node = fn({ path: 'x.md', name: 'x.md', ext: 'md', content: DOC });
      holder.appendChild(node);
      const boxes = [...node.querySelectorAll('.md-callout')];
      add('Callout(preview): 渲染成容器', boxes.length === 3, 'count=' + boxes.length);
      add('Callout(preview): 标题行含图标', boxes.length > 0 && boxes.every((b) => (b.querySelector('.md-callout-title') || {}).textContent),
        boxes.map((b) => (b.querySelector('.md-callout-title') || {}).textContent).join(' / '));
      add('Callout(preview): 默认标题用类型名', boxes.some((b) => /Warning/.test((b.querySelector('.md-callout-title') || {}).textContent || '')), '');
      add('Callout(preview): 正文没被标题吞掉', boxes[0] && boxes[0].textContent.includes('callout 正文第二行'), boxes[0] ? boxes[0].textContent.replace(/\s+/g, ' ').slice(0, 50) : '');
      // 普通引用必须原样保留（不能被误判成 callout）—— 按内容找那一条，别按总数猜
      // （preview-test.md 里本来就有好几条普通引用：引用示例 / 嵌套引用 / 这条）
      const plain = [...node.querySelectorAll('blockquote')].find((b) => b.textContent.includes('普通引用不该变成 callout'));
      add('Callout(preview): 普通引用没变 callout', !!plain && !plain.classList.contains('md-callout'), '');
      add('Callout(preview): 未知类型退回普通引用',
        [...node.querySelectorAll('blockquote')].some((b) => b.textContent.includes('[!unknown-type]')), '');
      // 两种模式同类型同色
      const pvNote = boxes.find((b) => b.className.includes('co-note'));
      const pvColor = pvNote ? getComputedStyle(pvNote).borderLeftColor : '';
      const liveColor = noteLine ? getComputedStyle(noteLine, '::before').borderLeftColor : '';
      add('Callout: 同类型颜色两边相同', !!pvColor && !!liveColor && pvColor === liveColor, 'live=' + liveColor + ' preview=' + pvColor);
    } catch (e) {
      add('Callout(preview): 渲染成容器', false, String(e));
    }
    holder.remove();
    api.gotoLine(1); await sleep(250);
  }

  // ---------- 脚注（Obsidian 的 [^1]）：两种模式编号必须一致、定义不得丢 ----------
  {
    api.gotoLine(lineNoOf('正文里引用脚注甲')); await sleep(400);
    api.setCursor(DOC.length); await sleep(250);
    const liveRefs = [...document.querySelectorAll('.cm-md-fnref')].map((e) => e.textContent);
    const liveNos = [...document.querySelectorAll('.cm-md-fnno')].map((e) => e.textContent);
    add('脚注(live): 行内引用渲染成上标', liveRefs.length >= 3, 'refs=' + liveRefs.join(','));
    add('脚注(live): 定义行渲染成 [N] 条目', liveNos.length >= 3, 'nos=' + liveNos.join(','));
    add('脚注(live): 渲染态隐藏 [^label] 源码',
      !allText().includes('[^fn-a]') && !allText().includes('[^fn-b]'), '');
    // 预览：同屏对照
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:900px;';
    document.body.appendChild(holder);
    try {
      const fn = MI.renderFor({ path: 'x.md', name: 'x.md', ext: 'md' });
      const node = fn({ path: 'x.md', name: 'x.md', ext: 'md', content: DOC });
      holder.appendChild(node);
      const pvRefs = [...node.querySelectorAll('.md-fnref')].map((e) => e.textContent);
      const pvNotes = [...node.querySelectorAll('.md-footnote')];
      add('脚注(preview): 渲染成脚注区', pvNotes.length >= 3, 'count=' + pvNotes.length);
      add('脚注(preview): 脚注正文不丢', pvNotes.some((n) => n.textContent.includes('脚注甲的内容')), '');
      add('脚注(preview): 没有残留 [^label] 源码', !node.textContent.includes('[^fn-a]'), '');
      add('脚注: 两模式编号一致', liveRefs.length > 0 && JSON.stringify(liveRefs) === JSON.stringify(pvRefs),
        'live=' + liveRefs.join(',') + ' preview=' + pvRefs.join(','));
      add('脚注(preview): 编号与条目一一对应',
        pvNotes.length === pvRefs.length && pvNotes.every((n, i) => n.querySelector('.md-footnote-no').textContent === pvRefs[i]),
        'notes=' + pvNotes.length + ' refs=' + pvRefs.length);
    } catch (e) {
      add('脚注(preview): 渲染成脚注区', false, String(e));
    }
    holder.remove();
    api.gotoLine(1); await sleep(250);
  }

  // ---------- wiki 链接：补全（文档 046 §1.6）+ 渲染态只显示别名 ----------
  {
    // 补全需要项目文件表：main.js 已把 MdEditor.__wikiFiles 注入（不切项目、不碰会话）
    const saved = api.getValue();
    const setDoc = (text) => { api.setValue(text); };
    if (window.__wikiProj && window.MdEditor && Array.isArray(MdEditor.__wikiFiles)) {
      if (MdEditor.invalidateWikiIndex) MdEditor.invalidateWikiIndex();
      MdEditor.__wikiFiles = MdEditor.__wikiFiles;   // 保留注入的表
      await MdEditor.loadWikiFiles();
      await sleep(300);
      add('wiki(live): 项目文件索引建好', true, '');
    } else {
      add('wiki(live): 项目文件索引建好', false, '没有 __wikiProj / __wikiFiles（main.js 未注入）');
    }
    // 渲染：写一行四种形式，渲染态文本里不应再有 `[[` 或 `|别名` 残留
    setDoc('# 索引\n\n[[alpha]] 与 [[beta|贝塔]] 与 [[notes/gamma#细节说明|G]]\n');
    api.setCursor(api.view.state.doc.length); await sleep(450);
    const rendered = document.querySelector('.cm-content').textContent;
    add('wiki(live): 渲染态隐藏 [[ ]] 与别名竖线',
      !rendered.includes('[[') && !rendered.includes('|贝塔') && !rendered.includes('#细节说明'),
      JSON.stringify(rendered.slice(Math.max(0, rendered.indexOf('alpha') - 4), rendered.indexOf('alpha') + 30)));
    add('wiki(live): 无别名时显示目标名', rendered.includes('alpha'), '');
    add('wiki(live): 有别名时显示别名', rendered.includes('贝塔') && rendered.includes('G'), '');
    // 补全：[[ 触发候选（文件索引由 MdEditor.loadWikiFiles 建好）
    setDoc('# 索引\n\n[[al');
    api.setCursor(api.view.state.doc.length); await sleep(150);
    const A = window.CM6.Autocomplete;
    A.startCompletion(api.view);
    await sleep(600);
    const panel = document.querySelector('.cm-tooltip-autocomplete');
    const labels = panel ? [...panel.querySelectorAll('li')].map((li) => li.textContent) : [];
    add('wiki(live): [[ 触发补全候选', labels.length > 0, 'labels=' + labels.slice(0, 5).join(','));
    add('wiki(live): 候选按输入过滤', labels.some((t) => /alpha/.test(t)), 'labels=' + labels.slice(0, 5).join(','));
    // 接受补全 → 文本变成 [[alpha]]
    const okAcc = A.acceptCompletion(api.view);
    await sleep(250);
    add('wiki(live): 接受补全写入 [[文件]]', !!okAcc && /\[\[alpha\]\]/.test(api.getValue()), JSON.stringify(api.getValue().slice(-20)));
    // [[文件# 触发该文件的标题候选
    setDoc('# 索引\n\n[[alpha#第');
    api.setCursor(api.view.state.doc.length); await sleep(150);
    A.startCompletion(api.view);
    await sleep(800);
    const panel2 = document.querySelector('.cm-tooltip-autocomplete');
    const labels2 = panel2 ? [...panel2.querySelectorAll('li')].map((li) => li.textContent) : [];
    add('wiki(live): [[文件# 触发标题候选', labels2.some((t) => /第一节|第二节/.test(t)), 'labels=' + labels2.slice(0, 5).join(','));
    // 预览侧：别名显示 + 目标不丢（`[[beta|贝塔别名]]` → 文字"贝塔别名"、href 指向 beta）
    {
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:900px;';
      document.body.appendChild(holder);
      try {
        const fn = MI.renderFor({ path: 'x.md', name: 'x.md', ext: 'md' });
        const node = fn({ path: 'x.md', name: 'x.md', ext: 'md', content: DOC });
        holder.appendChild(node);
        const links = [...node.querySelectorAll('a')].filter((a) => /beta|notes\/gamma/.test(decodeURIComponent(a.getAttribute('href') || '')));
        add('wiki(preview): 别名显示为目标别名', links.some((a) => a.textContent === '贝塔别名'), links.map((a) => a.textContent).join(','));
        // 无别名时只显示笔记名（`[[notes/gamma#细节说明]]` → 文字 notes/gamma，不带 #标题）
        add('wiki(preview): 无别名时只显示笔记名（不带 #标题）',
          [...node.querySelectorAll('a')].some((a) => a.textContent === 'notes/gamma'),
          [...node.querySelectorAll('a')].map((a) => a.textContent).join(','));
        // href 里的 #标题 会被 URL 编码（%E7%BB%86…），断言前先解码
        add('wiki(preview): 链接目标保留 #标题',
          links.some((a) => decodeURIComponent(a.getAttribute('href') || '').includes('#细节说明')),
          links.map((a) => decodeURIComponent(a.getAttribute('href'))).join(','));
      } catch (e) { add('wiki(preview): 别名显示为目标别名', false, String(e)); }
      holder.remove();
    }
    // 嵌入笔记 ![[x]] / ![[x#标题]]（文档 046 §2.4）
    // ⚠ 不切标签页：直接把 index.md 的内容写进当前编辑器（上一步的 setDoc 已经在做这件事），
    //   跑完用 saved 还原 —— 早先版本用 Viewer.openFile 切文档，后面的断言会全跑错文档。
    {
      const embDir = window.__wikiProj;
      const sep = (embDir || '').includes('\\') ? '\\' : '/';
      const embPath = embDir + sep + 'index.md';
      let embContent = '';
      try {
        const r = await window.myIDE.fs.readFile(embPath);
        embContent = (r && r.content) || '';
      } catch {}
      if (embContent) {
        // live：当前编辑器基准目录要指向 wikiproj（嵌入按 baseDir 相对解析）
        const prevBase = MdEditor.__baseDir;
        MdEditor.__baseDir = embDir;
        setDoc(embContent);
        api.setCursor(api.view.state.doc.length);
        for (let i = 0; i < 20; i++) {
          if (document.querySelector('.cm-md-embed')) break;
          await sleep(300);
        }
        await sleep(500);
        const boxes = [...document.querySelectorAll('.cm-md-embed')];
        add('嵌入(live): ![[笔记]] 渲染成内嵌卡片', boxes.length >= 2, 'count=' + boxes.length);
        add('嵌入(live): 嵌入内容真的读进来了',
          boxes.some((b) => b.textContent.includes('这是被嵌入的正文')), boxes.map((b) => b.textContent.replace(/\s+/g, ' ').slice(0, 24)).join(' | '));
        add('嵌入(live): ![[x#标题]] 只切该节',
          boxes.some((b) => b.textContent.includes('细节正文') && !b.textContent.includes('这是被嵌入的正文')),
          boxes.map((b) => b.textContent.replace(/\s+/g, ' ').slice(0, 18)).join(' | '));
        add('嵌入(live): 嵌入内容保留行内格式', boxes.some((b) => b.querySelector('strong')), '');
        add('嵌入(live): 读不到时给错误卡片而不是裂图',
          document.querySelectorAll('.cm-md-embed-err').length >= 1, 'errs=' + document.querySelectorAll('.cm-md-embed-err').length);
        add('嵌入(live): 渲染态不残留 ![[]] 源码', !document.querySelector('.cm-content').textContent.includes('![['), '');
        MdEditor.__baseDir = prevBase;
        // 预览侧同一份文档
        const holder = document.createElement('div');
        holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:900px;';
        document.body.appendChild(holder);
        try {
          const fn = MI.renderFor({ path: embPath, name: 'index.md', ext: 'md' });
          const node = fn({ path: embPath, name: 'index.md', ext: 'md', content: embContent });
          holder.appendChild(node);
          // 嵌入卡片是异步读盘后填充的：轮询等它出现（固定等待在慢盘上不够，实测会 count=0）
          for (let i = 0; i < 20; i++) {
            if (node.querySelector('.md-embed') && node.querySelector('.md-embed').textContent.length > 12) break;
            await sleep(300);
          }
          await sleep(300);
          const pvBoxes = [...node.querySelectorAll('.md-embed')];
          add('嵌入(preview): ![[笔记]] 渲染成内嵌卡片', pvBoxes.length >= 2, 'count=' + pvBoxes.length);
          add('嵌入(preview): 与 live 内容一致',
            pvBoxes.some((b) => b.textContent.includes('这是被嵌入的正文')) && pvBoxes.some((b) => b.textContent.includes('细节正文')),
            pvBoxes.map((b) => b.textContent.replace(/\s+/g, ' ').slice(0, 20)).join(' | '));
          add('嵌入(preview): 不残留 ![[]] 源码', !node.textContent.includes('![['), '');
        } catch (e) { add('嵌入(preview): ![[笔记]] 渲染成内嵌卡片', false, String(e)); }
        holder.remove();
      } else {
        add('嵌入(live): ![[笔记]] 渲染成内嵌卡片', false, '读不到 wikiproj/index.md');
      }
    }
    setDoc(saved);
    api.setCursor(DOC.length); await sleep(200);
  }

  // 收尾：解除自动保存拦截 + 还原真实 writeFile
  clearInterval(autosaveWatch);
  if (origWrite) { try { window.myIDE.fs.writeFile = origWrite; } catch {} }
  api.setCursor(DOC.length);
  await sleep(80);
  return { R };
})()

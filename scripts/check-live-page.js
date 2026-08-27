// scripts/check-live-page.js —— Live Preview 真实渲染自检（由 main.js --check-live 注入真实 App DOM）
// 必须是表达式形式：(async () => {...})()，返回 { R: [{name, ok, detail}] }
(async () => {
  const R = [];
  const add = (name, ok, detail) => R.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  const api = window.Viewer && Viewer.cm;
  const cm = document.querySelector('.cm-content');
  if (!api || !cm) return { error: '编辑器未挂载（Viewer.cm=' + !!api + ', .cm-content=' + !!cm + '）', R };
  const DOC = window.__doc;
  const allText = () => cm.textContent;
  const css = (el, prop) => (el ? getComputedStyle(el).getPropertyValue(prop) : '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const has = (s) => allText().includes(s);
  const q = (sel) => document.querySelector(sel);
  const transparent = (v) => !v || v === 'rgba(0, 0, 0, 0)' || v === 'transparent';
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

  // ---------- 环境 ----------
  add('环境: live 模式 CM 编辑器挂载', !!document.querySelector('.editor-cm-wrap'));
  add('环境: 状态栏版本号显示', (document.getElementById('sb-ver').textContent || '').length > 0, document.getElementById('sb-ver').textContent);

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
    add('文本: task 源码 [ ] 隐藏', !has('[ ]') && !has('[x]'));
    add('文本: task checkbox widget 存在', document.querySelector('.cm-md-task') !== null);
    const bullets = document.querySelectorAll('.cm-md-bullet');
    add('列表: 无序 bullet 圆点渲染', bullets.length >= 3, 'count=' + bullets.length);
    // 渲染态列表行不得残留源码 "- "
    const liLine = lineEl('无序列表一');
    add('列表: 无序行无源码 - ', liLine ? !/-\s无序/.test(liLine.textContent) && liLine.textContent.includes('•') : false,
      liLine ? JSON.stringify(liLine.textContent.slice(0, 12)) : '行不在 DOM');
    const tasks = document.querySelectorAll('.cm-md-task');
    add('列表: task 勾选框渲染', tasks.length >= 3, 'count=' + tasks.length);
    const doneTask = document.querySelector('.cm-md-task.done');
    add('列表: 已完成 task 勾选样式', doneTask !== null, '');
    // task 行不残留 "-"（bullet 已替换圆点）
    const taskLine = lineEl('未完成任务');
    add('列表: task 行无源码 - ', taskLine ? !/-\s*\[/.test(taskLine.textContent) : false,
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
  add('样式: h1 字号 26px', h1 && css(h1, 'font-size') === '26px', css(h1, 'font-size'));
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
  add('样式: 行内代码背景', code && !transparent(css(code, 'background-color')), css(code, 'background-color'));
  const hl = q('.cm-md-highlight');
  add('样式: ==高亮== 背景', !!hl && !transparent(css(hl, 'background-color')), hl ? css(hl, 'background-color') : '元素不存在');

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
  {
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
    // 光标进表格 → 回退源码（Obsidian 行为）
    api.setCursor(DOC.indexOf('单元格A1') + 3); await sleep(150);
    add('表格: 光标进表格回退源码', has('单元格A1') && q('.cm-md-table') === null, '');
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
    add('代码块(滚动后): 行背景', fence2 && !transparent(css(fence2, 'background-color')), fence2 ? css(fence2, 'background-color') : '元素不存在');
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
    add('行为: 点击高度与光标高度一致(代码行)', cr && cr.height > 0 && cr.top >= lineR.top - 3 && cr.bottom <= lineR.bottom + 3,
      'cursor=[' + (cr && Math.round(cr.top)) + ',' + (cr && Math.round(cr.bottom)) + '] line=[' + Math.round(lineR.top) + ',' + Math.round(lineR.bottom) + ']');
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
    add('行为: 点击高度与光标高度一致(标题行)', cr && cr.height > 0 && cr.top >= lineR.top - 3 && cr.bottom <= lineR.bottom + 3,
      'cursor=[' + (cr && Math.round(cr.top)) + ',' + (cr && Math.round(cr.bottom)) + '] line=[' + Math.round(lineR.top) + ',' + Math.round(lineR.bottom) + ']');
  }
  // 3. 表格区点击映射（源码态下逐行点击 → 光标必须精确命中该行）
  //    先把光标放进表格（widget → 源码态），顺序：表格内行优先，表格外的行最后
  //    （点表格外的行会让表格恢复 widget，之后表格行就不在 DOM 了）
  api.setCursor(DOC.indexOf('单元格A1') + 2); await sleep(200); // 进源码态
  api.gotoLine(lineNoOf('单元格A1')); await sleep(350);
  {
    const lineOf = (pos) => DOC.slice(0, pos).split('\n').length;
    for (const key of ['单元格A2', '内容较长的一格', '左对齐列', '单元格A1', '七、表格', '八、其他块级']) {
      const el = lineEl(key);
      if (!el) { add('映射: ' + key, false, '行不在 DOM'); continue; }
      await ensureVisible(el);
      click(el);
      await sleep(60);
      const sel = api.getSelection();
      const i = DOC.indexOf(key);
      const lineEnd = DOC.indexOf('\n', i);
      add('映射: 点击「' + key.slice(0, 6) + '」行 → 落在第 ' + lineOf(sel.head) + ' 行',
        sel.head >= i - 1 && sel.head <= lineEnd,
        'head=' + sel.head + ' 行范围=[' + (i - 1) + ',' + lineEnd + '] 期望行=' + lineOf(i));
    }
  }
  // 4. 表格源码行点击：光标命中 + 高度一致
  api.setCursor(DOC.indexOf('单元格A1') + 2); await sleep(150); // 保持源码态
  const trEl = lineEl('单元格A1');
  if (trEl) {
    await ensureVisible(trEl);
    api.focus(); await sleep(80);
    click(trEl);
    await sleep(250);
    const sel = api.getSelection();
    const i = DOC.indexOf('单元格A1');
    const lineEnd = DOC.indexOf('\n', i);
    add('行为: 点击表格单元格光标进入', sel && sel.head >= i - 1 && sel.head <= lineEnd, JSON.stringify(sel));
    const cur = [...document.querySelectorAll('.cm-cursor')].find((c) => c.getBoundingClientRect().height > 0) || q('.cm-cursor');
    const cr = cur && cur.getBoundingClientRect();
    const lineR = trEl.getBoundingClientRect();
    add('行为: 点击高度与光标高度一致(表格行)', cr && cr.top >= lineR.top - 3 && cr.bottom <= lineR.bottom + 3,
      'cursor=[' + (cr && Math.round(cr.top)) + ',' + (cr && Math.round(cr.bottom)) + '] line=[' + Math.round(lineR.top) + ',' + Math.round(lineR.bottom) + ']');
  } else add('行为: 点击表格单元格光标进入', false, '未找到表格行');

  api.setCursor(DOC.length);
  await sleep(80);
  return { R };
})()

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
  add('文本: 引用 > 标记隐藏', has('引用第一行') && !has('> 引用第一行'));
  add('文本: 围栏行 ``` 隐藏', !/```/.test(allText()));
  add('文本: 表格分隔行隐藏', !has('| :--- | :---: | ---: |'));
  add('文本: 分隔线 --- 文本隐藏', !has('---'));
  add('文本: 拼写检查关闭(无红波浪下划线)', cm.spellcheck === false, String(cm.spellcheck));
  add('文本: task 源码 [ ] 隐藏', !has('[ ]') && !has('[x]'));
  add('文本: task checkbox widget 存在', document.querySelector('.cm-md-task') !== null);
  add('文本: 转义 \\* 显示为字面量', has('*不是斜体*'));
  add('文本: 无序 bullet 保留', has('无序列表一'));

  // ---------- 样式层（视口内元素；表格/代码块在滚动后单独检查） ----------
  const h1 = q('.cm-md-h1');
  add('样式: h1 字号 22px', h1 && css(h1, 'font-size') === '22px', css(h1, 'font-size'));
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
  // 表格（用户报告：表格没有渲染）—— preview-test.md 表格在第 88-96 行附近
  api.gotoLine(90); await sleep(350); // 滚到表格区（gotoLine 会把光标放进表格 → 源码态）
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
    // 点击 widget → 光标进入表格范围（自动变源码可编辑）
    const tbl2 = q('.cm-md-table');
    if (tbl2) {
      await ensureVisible(tbl2);
      click(tbl2);
      await sleep(120);
      const sel = api.getSelection();
      const tFrom = DOC.indexOf('| 左对齐列');
      const tTo = DOC.indexOf('内容较长的一格') + 20;
      add('行为: 点击表格widget光标进入表格', sel.head >= tFrom - 1 && sel.head <= tTo, JSON.stringify(sel));
    }
  }
  // 代码块（用户报告：代码块无法操作）—— preview-test.md js 代码块在第 68-74 行
  api.gotoLine(70); await sleep(350);
  let codeLine = lineEl('const msg');
  if (!codeLine) codeLine = lineEl('function greet');
  {
    const fence2 = q('.cm-md-fence-line');
    add('代码块(滚动后): 行背景', fence2 && !transparent(css(fence2, 'background-color')), fence2 ? css(fence2, 'background-color') : '元素不存在');
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
    click(codeLine);
    await sleep(100);
    const sel = api.getSelection();
    const i = DOC.indexOf('const msg');
    const lineEnd = DOC.indexOf('\n', i);
    add('行为: 点击代码块内容光标进入', sel && sel.head >= i - 1 && sel.head <= lineEnd, JSON.stringify(sel));
    const cur = q('.cm-cursor');
    const cr = cur && cur.getBoundingClientRect();
    const lineR = codeLine.getBoundingClientRect();
    add('行为: 点击高度与光标高度一致(代码行)', cr && cr.top >= lineR.top - 3 && cr.bottom <= lineR.bottom + 3,
      'cursor=[' + (cr && Math.round(cr.top)) + ',' + (cr && Math.round(cr.bottom)) + '] line=[' + Math.round(lineR.top) + ',' + Math.round(lineR.bottom) + ']');
  } else add('行为: 点击代码块内容光标进入', false, '未找到代码行');

  // 2. 点击标题行（有 padding，最易出现命中偏移）—— 第 7 行
  api.setCursor(DOC.length); await sleep(150);
  api.gotoLine(7); await sleep(350);
  const h1El = lineEl('一级标题 H1');
  if (h1El) {
    await ensureVisible(h1El);
    click(h1El);
    await sleep(100);
    const sel = api.getSelection();
    const i = DOC.indexOf('# 一级标题');
    const lineEnd = DOC.indexOf('\n', i);
    add('行为: 点击标题行光标进入', sel && sel.from === sel.to && sel.head >= i && sel.head <= lineEnd, JSON.stringify(sel));
    const cur = q('.cm-cursor');
    const cr = cur && cur.getBoundingClientRect();
    const lineR = h1El.getBoundingClientRect();
    add('行为: 点击高度与光标高度一致(标题行)', cr && cr.top >= lineR.top - 3 && cr.bottom <= lineR.bottom + 3,
      'cursor=[' + (cr && Math.round(cr.top)) + ',' + (cr && Math.round(cr.bottom)) + '] line=[' + Math.round(lineR.top) + ',' + Math.round(lineR.bottom) + ']');
  }
  // 3. 表格区点击映射（源码态下逐行点击 → 光标必须精确命中该行）
  //    先把光标放进表格（widget → 源码态），顺序：表格内行优先，表格外的行最后
  //    （点表格外的行会让表格恢复 widget，之后表格行就不在 DOM 了）
  api.setCursor(DOC.indexOf('单元格A1') + 2); await sleep(200); // 进源码态
  api.gotoLine(92); await sleep(350);
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
    click(trEl);
    await sleep(100);
    const sel = api.getSelection();
    const i = DOC.indexOf('单元格A1');
    const lineEnd = DOC.indexOf('\n', i);
    add('行为: 点击表格单元格光标进入', sel && sel.head >= i - 1 && sel.head <= lineEnd, JSON.stringify(sel));
    const cur = q('.cm-cursor');
    const cr = cur && cur.getBoundingClientRect();
    const lineR = trEl.getBoundingClientRect();
    add('行为: 点击高度与光标高度一致(表格行)', cr && cr.top >= lineR.top - 3 && cr.bottom <= lineR.bottom + 3,
      'cursor=[' + (cr && Math.round(cr.top)) + ',' + (cr && Math.round(cr.bottom)) + '] line=[' + Math.round(lineR.top) + ',' + Math.round(lineR.bottom) + ']');
  } else add('行为: 点击表格单元格光标进入', false, '未找到表格行');

  api.setCursor(DOC.length);
  await sleep(80);
  return { R };
})()

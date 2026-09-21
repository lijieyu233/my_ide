// scripts/check-ui-steps.js —— UI 自检的「页内步骤」（在渲染进程里执行，返回断言清单）
// 约定：
//   ① 每个函数必须自包含（不许引用本文件的 Node 作用域变量），
//      main.js 用 `(${fn})(${JSON.stringify(arg)})` 注入页面执行；
//   ② 返回 { R: [{name, ok, detail}], hover?: {x,y} } —— hover 用于截图前把鼠标移到目标上
//      （CSS :hover 无法用脚本触发，只能靠真实输入事件）；
//   ③ 「打开浮层」与「关闭浮层」拆成两步，中间留给主进程截图（关掉再截就只能拍到已关闭的画面）。
module.exports = {
  // ---------- ⓪ 启动页（空状态）：无项目打开时的卡片 ----------
  emptyState: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 30 && !q('.empty-card'); i++) await sleep(150);
    const card = q('.empty-card');
    add('空状态可见 + 卡片式容器存在', !!card && q('#empty-state').classList.contains('visible'),
      card ? 'card=' + Math.round(card.getBoundingClientRect().width) + 'px' : 'no-card');
    if (!card) return { R };
    const w = Math.round(card.getBoundingClientRect().width);
    add('卡片宽度受控（不铺满整屏）', w > 240 && w <= 440, 'w=' + w);
    add('图标改为内联 SVG（不再用 emoji）', !!q('.empty-mark svg'),
      q('.empty-mark') ? (q('.empty-mark').textContent.trim() || 'svg-only') : 'no-mark');
    const txt = q('#empty-state').textContent || '';
    add('空状态无 emoji 残留', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(txt), JSON.stringify(txt.slice(0, 40)));
    const cta = q('.empty-cta');
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    add('主操作用主题色（不再是灰按钮）',
      !!cta && getComputedStyle(cta).backgroundColor !== 'rgba(0, 0, 0, 0)',
      cta ? getComputedStyle(cta).backgroundColor + ' / accent=' + accent : 'no-cta');
    add('快捷键提示为 kbd 胶囊', qa('.kbd-chip kbd').length >= 2, qa('.kbd-chip').length + ' 条');
    const items = qa('.empty-item');
    add('最近项目为纵向列表（≤6 行）', items.length >= 1 && items.length <= 6, 'count=' + items.length);
    add('每行显示父目录（区分同名项目）', !!q('.empty-item-dir') && q('.empty-item-dir').textContent.length > 0,
      q('.empty-item-dir') ? q('.empty-item-dir').textContent : '无');
    add('超出上限时有「还有 N 个」入口', items.length < 6 || !!q('.empty-more'),
      items.length + ' 行 / ' + (q('.empty-more') ? q('.empty-more').textContent : '无入口'));
    const lefts = new Set();
    for (const it of items) lefts.add(Math.round(it.getBoundingClientRect().left));
    add('列表行左对齐（不再是居中 chips）', lefts.size <= 1, '左边界种类=' + lefts.size);
    return { R };
  },

  // ---------- 外壳：图标统一 / 分组 / 状态栏字号可辨识 ----------
  chrome: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const ids = ['tool-sidebar', 'tool-project', 'tool-outline', 'tool-git', 'tool-log', 'tool-browser', 'tool-db', 'tool-tasks', 'tool-sidebar-r', 'tool-ai'];
    const bad = ids.filter((id) => {
      const el = document.getElementById(id);
      return !el || !el.querySelector('svg') || /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(el.textContent || '');
    });
    add('工具条 10 个按钮全改为内联 SVG', bad.length === 0, bad.length ? '未改：' + bad.join(',') : '全部 OK');
    add('工具栏 4 个功能按钮也是 SVG', ['btn-search', 'btn-theme', 'btn-settings', 'btn-help'].every((id) => {
      const el = document.getElementById(id);
      return el && el.querySelector('svg');
    }), 'search/theme/settings/help');
    add('工具栏有分组分隔线', qa('#toolbar .tb-sep').length >= 3, qa('#toolbar .tb-sep').length + ' 条');
    const sizes = new Set(qa('#tool-strip .tool-btn svg').map((s) => Math.round(s.getBoundingClientRect().width)));
    add('工具条图标尺寸一致（16px）', sizes.size === 1 && sizes.has(16), [...sizes].join('/'));
    add('状态栏字号控件带「侧栏 / 编辑」标签',
      (q('#sb-tool-font .sb-font-tag') || {}).textContent === '侧栏' && (q('#sb-font .sb-font-tag') || {}).textContent === '编辑',
      '标签已加');
    add('状态栏有分组分隔线', !!q('#statusbar .sb-sep'));
    add('侧栏字号控件仍贴最左端', [...q('#statusbar').children].filter((x) => x.id)[0].id === 'sb-tool-font');
    const hasFocusRule = Array.from(document.styleSheets).flatMap((s) => { try { return Array.from(s.cssRules); } catch { return []; } })
      .some((r) => r.selectorText === ':focus-visible');
    add('统一焦点态规则存在', hasFocusRule, hasFocusRule ? ':focus-visible' : '缺失');
    const sbBorder = getComputedStyle(q('#statusbar')).borderTopColor;
    add('主分界线不再是近黑（--border-pane 生效）', sbBorder !== 'rgb(16, 16, 16)',
      getComputedStyle(document.documentElement).getPropertyValue('--border-pane').trim() + ' → ' + sbBorder);
    return { R };
  },

  // ---------- 项目面板顶部工具条（对齐 PyCharm 工具窗口） ----------
  treeHead: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const head = q('#tree-head');
    add('搜索框内嵌 SVG 放大镜', !!q('.tree-search-wrap svg.ic'), q('.tree-search-wrap svg') ? 'svg' : '无');
    add('搜索框 placeholder 无 emoji', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(q('#tree-search').placeholder), q('#tree-search').placeholder);
    add('搜索框静态无描边（focus 才描主色）', getComputedStyle(q('#tree-search')).borderTopColor === 'rgba(0, 0, 0, 0)',
      getComputedStyle(q('#tree-search')).borderTopColor);
    const btns = qa('#tree-head .vt-btn');
    const bordered = btns.filter((b) => getComputedStyle(b).borderTopStyle !== 'none');
    add('工具条按钮全部去边框', bordered.length === 0, bordered.length ? bordered.length + ' 个仍有边框' : btns.length + ' 个均无边框');
    add('图标按钮是内联 SVG（非 emoji/符号）', ['tree-sort', 'tree-collapse', 'tree-expand'].every((id) => {
      const el = document.getElementById(id);
      return el && el.querySelector('svg');
    }), 'sort/collapse/expand');
    add('三态视角按钮保留文字（可读性）', /常规|仅隐藏|全部/.test(q('#tree-hide-mode').textContent), q('#tree-hide-mode').textContent);
    const r = head.getBoundingClientRect();
    return { R, hover: { x: Math.round(r.width - 40), y: Math.round(r.top + r.height / 2) } };
  },

  // ---------- 提交工具窗口（对齐 PyCharm 提交窗口） ----------
  commitPanel: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.App.showTool('git');
    for (let i = 0; i < 40 && !q('#cd-files .git-file'); i++) await sleep(200);
    const files = qa('#cd-files .git-file');
    add('提交面板渲染出变更列表', files.length >= 1, 'files=' + files.length);
    if (!files.length) return { R };
    // 徽章：单字母（老版每行整句「已删除（已暂存）」）
    const badges = qa('#cd-files .git-file .badge');
    const bad = badges.filter((b) => !/^[AMD?U]$/.test(b.textContent.trim()));
    add('状态徽章为单字母', bad.length === 0, bad.length ? '异常：' + bad.slice(0, 3).map((b) => b.textContent).join('|') : badges.length + ' 个徽章');
    const longText = files.filter((f) => /（已暂存）|已暂存/.test(f.textContent));
    add('行内不再重复整句状态文案', longText.length === 0, longText.length + ' 行仍含长文案');
    add('完整状态文案保留在 tooltip', badges.length > 0 && !!badges[0].title, badges[0] && badges[0].title);
    add('已暂存 / 未暂存视觉可区分（实底 vs 描边）',
      badges.every((b) => (b.classList.contains('staged') ? getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)' : getComputedStyle(b).backgroundColor === 'rgba(0, 0, 0, 0)')),
      'staged=' + badges.filter((b) => b.classList.contains('staged')).length + '/' + badges.length);
    // 标题栏按钮：无边框 + SVG
    const tb = qa('#panel-git .panel-title-actions .vt-btn');
    add('标题栏按钮去边框', tb.length >= 4 && tb.every((b) => getComputedStyle(b).borderTopStyle === 'none'), tb.length + ' 个');
    add('标题栏按钮为 SVG 图标（不再用 emoji）',
      tb.every((b) => b.querySelector('svg') || /拉取|推送/.test(b.textContent)),
      tb.map((b) => b.textContent.trim() || 'icon').join(' | '));
    // 操作行：PyCharm 式纯图标按钮（文字进 tooltip），无边框
    const gb = qa('#cd-files .git-cp-bar .vt-btn');
    add('操作行按钮：图标化 + 无边框 + 无文字', gb.length >= 5 && gb.every((b) => getComputedStyle(b).borderTopStyle === 'none' && b.querySelector('svg') && !b.textContent.trim()),
      gb.length + ' 个: ' + gb.slice(0, 3).map((b) => b.title.slice(0, 8)).join(' | '));
    const r = q('#cd-files').getBoundingClientRect();
    return { R, hover: { x: Math.round(r.left + 80), y: Math.round(r.top + 24) } };
  },

  // ---------- ① 顶部项目栏（挤压 / 覆盖 / 截断） ----------
  projectBar: async (dir) => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 8000)) { const v = fn(); if (v) return v; await sleep(100); }
      return null;
    };
    await waitFor(() => qa('#project-bar .proj-btn').length >= 10, 6000);
    const bar = q('#project-bar');
    const pill = q('.proj-all');
    const btns = qa('#project-bar .proj-btn');
    add('项目栏渲染出多个项目按钮', btns.length >= 10, 'count=' + btns.length);
    add('「全部项目」入口显示项目数', pill && /1\d\s*项目/.test(pill.textContent), pill && pill.textContent);
    // 结构性回归：入口必须在横向滚动容器之外（老实现 sticky 浮在滚动层上 → 按钮从它底下钻过去 = 覆盖）
    add('「全部项目」在滚动容器之外', !!pill && pill.parentElement && pill.parentElement.id === 'project-bar-wrap' && !bar.contains(pill),
      pill && ('父=' + (pill.parentElement && pill.parentElement.id) + ' 在bar内=' + bar.contains(pill)));
    add('「全部项目」不再是 sticky 悬浮层', pill && getComputedStyle(pill).position !== 'sticky', pill && getComputedStyle(pill).position);
    add('不再重复显示当前项目名（高亮按钮就在旁边）', pill && pill.querySelectorAll('.proj-all-cur').length === 0, pill && pill.textContent);
    if (!btns.length) return { R };
    // 高度：挤压会让按钮不等高 / 文字贴边
    const hs = [...new Set(btns.map((b) => Math.round(b.getBoundingClientRect().height)))];
    add('所有项目按钮等高', hs.length === 1, 'heights=' + hs.join('/'));
    const bh = btns[0].getBoundingClientRect().height;
    const th = btns[0].querySelector('span').getBoundingClientRect().height;
    add('按钮内文字有上下留白（不再挤压）', bh - th >= 4, 'btn=' + Math.round(bh) + ' text=' + Math.round(th));
    add('长名字省略号截断（不撑爆栏）', btns[0].querySelector('span').scrollWidth <= 181, 'spanW=' + btns[0].querySelector('span').scrollWidth);
    // 溢出淡出提示
    const overflowing = bar.scrollWidth > bar.clientWidth + 1;
    add('溢出时右侧有淡出提示', !overflowing || bar.classList.contains('scroll-r'),
      'scrollW=' + bar.scrollWidth + ' clientW=' + bar.clientWidth + ' cls=' + bar.className);
    // 关键回归：把当前项目按钮滚出可视区 → 重渲染后必须自动滚回
    bar.scrollLeft = 600;
    await sleep(150);
    await window.App.setRoot(dir);
    await sleep(500);
    // ⚠ 重渲染会重建 DOM：pill 必须重新取（旧引用已脱离文档，rect 恒为 0）
    const pill2 = q('.proj-all');
    const act = q('#project-bar .proj-btn.active');
    const pillR = pill2.getBoundingClientRect();
    const barR = bar.getBoundingClientRect();
    // 一律用 rect 差值判位置（offsetLeft 的 offsetParent 是 body，混着 scrollLeft 用会算错）
    const actR = act.getBoundingClientRect();
    const relL = Math.round(actR.left - barR.left);
    const relR = Math.round(actR.right - barR.left);
    add('「全部项目」入口宽度正常（未塌陷）', pillR.width > 60, 'pillW=' + Math.round(pillR.width));
    add('重渲染后当前项目滚回可视区', relL >= -1 && relR <= bar.clientWidth + 1,
      '当前=' + String(act.textContent || '').replace('✕', '') + ' 相对=[' + relL + ',' + relR + '] 容器宽=' + bar.clientWidth
      + ' scrollLeft=' + Math.round(bar.scrollLeft)
      + ' bar=[' + Math.round(barR.left) + ',' + Math.round(barR.right) + '] act=[' + Math.round(actR.left) + ',' + Math.round(actR.right) + ']'
      + ' 页面横滚=' + Math.round(document.scrollingElement.scrollLeft));
    add('入口与项目按钮分区清晰（不同容器 + 有间距）', barR.left - pillR.right >= 4,
      'gap=' + Math.round(barR.left - pillR.right) + 'px');
    add('项目栏没有把页面撑出横向滚动', document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1,
      'doc=' + document.scrollingElement.scrollWidth + '/' + document.scrollingElement.clientWidth);
    let overlap = 0;
    for (let i = 1; i < btns.length; i++) {
      if (btns[i].getBoundingClientRect().left < btns[i - 1].getBoundingClientRect().right - 1) overlap++;
    }
    add('项目按钮之间无重叠', overlap === 0, 'overlap=' + overlap);
    return { R };
  },

  // ---------- ② 图片查看器：缩放工具条 ----------
  imageViewer: async (dir) => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 8000)) { const v = fn(); if (v) return v; await sleep(120); }
      return null;
    };
    window.Viewer.closeAll();
    await sleep(150);
    await window.Viewer.openFile(dir + '\\_ui_big.png');
    const img = await waitFor(() => { const i = q('.img-view img'); return i && i.naturalWidth ? i : null; }, 8000);
    add('大图已解码（1200×800）', !!img, img && img.naturalWidth + '×' + img.naturalHeight);
    const tbar = q('.img-view .img-bar');
    add('图片缩放工具条存在', !!tbar, tbar && tbar.className);
    if (!tbar || !img) return { R };
    const labels = [...tbar.querySelectorAll('.zoom-btn')].map((b) => b.textContent.trim());
    add('工具条含：－ ＋ 适应 1:1', ['－', '＋', '适应', '1:1'].every((x) => labels.includes(x)), labels.join(' | '));
    add('工具条含：全屏', labels.some((x) => x.includes('全屏')), labels.join(' | '));
    add('工具条含：缩放比例显示', !!q('.img-view .zoom-pct'), q('.img-view .zoom-pct') && q('.img-view .zoom-pct').textContent);
    const btn = (t) => [...tbar.querySelectorAll('.zoom-btn')].find((b) => b.textContent.trim() === t);
    const el = () => q('.img-view img');
    const dispW = () => Math.round(el().getBoundingClientRect().width);
    const natW = () => el().clientWidth; // content-box：即图片内容宽度（不含 1px 边框）
    const stageW = Math.round(q('.img-view .img-stage').getBoundingClientRect().width) - 40; // 减去 padding
    const pct = () => (q('.img-view .zoom-pct') || {}).textContent;
    const fitW = dispW();
    add('默认适应窗口（不超出可视宽度）', fitW <= stageW + 2, 'fit=' + fitW + ' 可用宽=' + stageW);
    add('默认不放大过 100%', fitW <= img.naturalWidth, 'fit=' + fitW + ' nat=' + img.naturalWidth);
    click(btn('＋'));
    await sleep(250);
    add('点「＋」放大一档', dispW() > fitW, fitW + ' → ' + dispW() + '（' + pct() + '）');
    add('放大后不被 max-width 卡住', el().style.maxWidth === 'none', el().style.maxWidth);
    click(btn('1:1'));
    await sleep(250);
    add('点「1:1」回到原始像素', natW() === img.naturalWidth, '内容宽=' + natW() + ' nat=' + img.naturalWidth);
    add('100% 时比例文本正确', pct() === '100%', pct());
    click(btn('适应'));
    await sleep(250);
    // 允许 ≤14px 偏差：上一状态浮出的滚动条占了 10px，适应是按「当前可见区域」重算的
    add('点「适应」回到适应尺寸', Math.abs(dispW() - fitW) <= 14, 'w=' + dispW() + ' 首次适应=' + fitW);
    // ---------- 滚轮语义（画布习惯）：纯滚轮滚动、Ctrl+滚轮缩放 ----------
    const stageEl = q('.img-view .img-stage');
    const w0 = dispW();
    const wev = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true, clientX: 400, clientY: 300 });
    stageEl.dispatchEvent(wev);
    await sleep(200);
    add('纯滚轮不缩放（不再抢走滚轮）', dispW() === w0, w0 + ' → ' + dispW());
    add('纯滚轮不拦截（留给容器原生滚动）', wev.defaultPrevented === false, 'defaultPrevented=' + wev.defaultPrevented);
    const cev = new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true, clientX: 400, clientY: 300 });
    stageEl.dispatchEvent(cev);
    await sleep(250);
    add('Ctrl+滚轮向上放大', dispW() > w0, w0 + ' → ' + dispW() + '（' + pct() + '）');
    add('Ctrl+滚轮拦截（挡掉整页缩放）', cev.defaultPrevented === true, 'defaultPrevented=' + cev.defaultPrevented);
    add('按钮 tooltip 标注 Ctrl+滚轮', /Ctrl\+滚轮/.test(btn('＋').title), btn('＋').title);
    // 放大后必须"有东西可滚"（纯滚轮才有意义）
    click(btn('1:1'));
    await sleep(300);
    add('放大后容器可滚动（可上下滑动看画面）', stageEl.scrollHeight > stageEl.clientHeight + 1 || stageEl.scrollWidth > stageEl.clientWidth + 1,
      'scroll=' + stageEl.scrollWidth + 'x' + stageEl.scrollHeight + ' client=' + stageEl.clientWidth + 'x' + stageEl.clientHeight);
    // 交给主进程发真实滚轮事件（合成事件不会触发原生滚动，只有真实输入才能验证）
    const sr = stageEl.getBoundingClientRect();
    return { R, hover: { x: Math.round(sr.left + sr.width / 2), y: Math.round(sr.top + sr.height / 2) }, wheel: { deltaY: 400 } };
  },

  // 主进程发过真实滚轮事件后：画面必须真的滚下去了，且缩放不变
  imageWheelScrollCheck: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const st = q('.img-view .img-stage');
    const img = q('.img-view img');
    add('真实滚轮事件 → 画面上下滑动', st.scrollTop > 0, 'scrollTop=' + st.scrollTop);
    add('滚动过程不改变缩放', img.clientWidth === img.naturalWidth, '内容宽=' + img.clientWidth + ' nat=' + img.naturalWidth);
    return { R };
  },

  // 注入点：把鼠标放到图片舞台中心，并声明要发的真实滚轮事件（合成事件不触发原生滚动，只能走真实输入）
  imageWheelInject: async (ctrl) => {
    const st = document.querySelector('.img-view .img-stage');
    const sr = st.getBoundingClientRect();
    return {
      R: [{ name: (ctrl ? 'Ctrl+滚轮' : '滚轮') + '注入点：图片舞台中心', ok: true, detail: Math.round(sr.left + sr.width / 2) + ',' + Math.round(sr.top + sr.height / 2) }],
      hover: { x: Math.round(sr.left + sr.width / 2), y: Math.round(sr.top + sr.height / 2) },
      wheel: { deltaY: ctrl ? -120 : 400, ctrl: !!ctrl },
    };
  },

  // 主进程发真实 Ctrl+滚轮：必须缩放
  imageWheelZoomCheck: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const pct = (q('.img-view .zoom-pct') || {}).textContent;
    const img = q('.img-view img');
    add('真实 Ctrl+滚轮 → 放大（超过原始像素）', img.clientWidth > img.naturalWidth,
      '内容宽=' + img.clientWidth + ' / ' + img.naturalWidth + '（' + pct + '）');
    // 收尾：回到适应，留给后续截图
    const fitBtn = [...q('.img-view .img-bar').querySelectorAll('.zoom-btn')].find((b) => b.textContent.trim() === '适应');
    fitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { R };
  },

  // ---------- ③ 图片全屏浮层：打开（保持打开，留给主进程截图） ----------
  imageFullscreenOpen: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tbar = q('.img-view .img-bar');
    click([...tbar.querySelectorAll('.zoom-btn')].find((b) => b.textContent.includes('全屏')));
    await sleep(600);
    const lb = q('.img-lightbox');
    add('点「全屏」打开浮层', !!lb);
    if (!lb) return { R };
    const li = q('.img-lightbox img');
    add('浮层图片已解码', !!(li && li.naturalWidth), li && li.naturalWidth + '×' + li.naturalHeight);
    const lbBtns = [...lb.querySelectorAll('.zoom-btn')].map((b) => b.textContent.trim());
    add('浮层内同样有缩放按钮', ['－', '＋', '适应', '1:1'].every((x) => lbBtns.includes(x)), lbBtns.join(' | '));
    add('浮层有关闭按钮', lbBtns.some((x) => x.includes('关闭')), lbBtns.join(' | '));
    const w0 = Math.round(li.getBoundingClientRect().width);
    click([...lb.querySelectorAll('.zoom-btn')].find((b) => b.textContent.trim() === '＋'));
    await sleep(300);
    add('浮层内可放大', Math.round(li.getBoundingClientRect().width) > w0, w0 + ' → ' + Math.round(li.getBoundingClientRect().width));
    const r = q('.img-lightbox .img-bar').getBoundingClientRect();
    return { R, hover: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } };
  },

  // ---------- ④ 图片全屏浮层：关闭 ----------
  imageFullscreenClose: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    add('Esc 关闭浮层', !document.querySelector('.img-lightbox'));
    return { R };
  },

  // ---------- ⑤ mermaid（md 预览模式）：渲染 + 按钮就位（保持打开，留给主进程截图） ----------
  mermaidPreviewStatic: async (dir) => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 15000)) { const v = fn(); if (v) return v; await sleep(150); }
      return null;
    };
    window.Viewer.closeAll();
    localStorage.setItem('myide-md-mode', 'preview');
    await sleep(150);
    await window.Viewer.openFile(dir + '\\_ui_mmd.md');
    const box = await waitFor(() => q('.md-view .mermaid-box svg') && q('.md-view .mermaid-box'), 15000);
    add('md 预览中 mermaid 渲染成 SVG', !!box, box && box.querySelectorAll('svg').length + ' svg');
    if (!box) return { R };
    add('两处 mermaid 图都渲染出来', document.querySelectorAll('.md-view .mermaid-box svg').length === 2,
      'got ' + document.querySelectorAll('.md-view .mermaid-box svg').length);
    const fsb = q('.mermaid-box .mmd-fs-btn');
    add('图上挂载「⛶ 全屏」按钮', !!fsb, fsb && fsb.textContent);
    add('全屏按钮默认隐藏（hover 才浮现，不干扰阅读）', fsb && getComputedStyle(fsb).opacity === '0', fsb && getComputedStyle(fsb).opacity);
    const r = fsb ? fsb.getBoundingClientRect() : null;
    return { R, hover: r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : undefined };
  },

  // ---------- ⑥ mermaid（md 预览模式）：点全屏 → 浮层（保持打开） ----------
  mermaidPreviewFs: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const fsb = q('.mermaid-box .mmd-fs-btn');
    if (!fsb) { add('全屏按钮存在', false); return { R }; }
    fsb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(600);
    const ov = q('.svg-fullscreen');
    add('点全屏打开浮层', !!ov);
    if (!ov) return { R };
    const sv = q('.svg-fullscreen svg');
    add('浮层内是同一张图（SVG 克隆）', !!sv, sv && sv.getAttribute('viewBox'));
    add('浮层内有缩放控件 + 关闭', ov.querySelectorAll('.zoom-btn').length >= 5,
      [...ov.querySelectorAll('.zoom-btn')].map((b) => b.textContent.trim()).join(' | '));
    const w0 = Math.round(sv.getBoundingClientRect().width);
    [...ov.querySelectorAll('.zoom-btn')].find((b) => b.textContent.trim() === '＋')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(300);
    add('全屏图可放大', Math.round(q('.svg-fullscreen svg').getBoundingClientRect().width) > w0,
      w0 + ' → ' + Math.round(q('.svg-fullscreen svg').getBoundingClientRect().width));
    // 滚轮语义与图片一致（同一套缩放器）：纯滚轮不缩放、留给平移
    const ovStage = q('.svg-fullscreen .img-stage');
    const sw = Math.round(q('.svg-fullscreen svg').getBoundingClientRect().width);
    ovStage.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    await sleep(250);
    add('全屏图：纯滚轮不缩放（留给平移）', Math.round(q('.svg-fullscreen svg').getBoundingClientRect().width) === sw, sw + ' → ' + Math.round(q('.svg-fullscreen svg').getBoundingClientRect().width));
    // 继续放大直到溢出（mermaid 图小，按适应/100% 都还在窗口内，要放到几倍才需要滚动）
    const plus = [...ov.querySelectorAll('.zoom-btn')].find((b) => b.textContent.trim() === '＋');
    const hasOv = () => ovStage.scrollWidth > ovStage.clientWidth + 1 || ovStage.scrollHeight > ovStage.clientHeight + 1;
    for (let i = 0; i < 12 && !hasOv(); i++) {
      plus.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(120);
    }
    add('全屏图：放大到超出窗口后可滚动', hasOv(),
      '图片=' + Math.round(q('.svg-fullscreen svg').getBoundingClientRect().width) + 'x' + Math.round(q('.svg-fullscreen svg').getBoundingClientRect().height)
      + ' scroll=' + ovStage.scrollWidth + 'x' + ovStage.scrollHeight + ' client=' + ovStage.clientWidth + 'x' + ovStage.clientHeight);
    // 缩回适应，留给截图
    const fitB = [...ov.querySelectorAll('.zoom-btn')].find((b) => b.textContent.trim() === '适应');
    fitB.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(200);
    const r = q('.svg-fullscreen .img-bar').getBoundingClientRect();
    return { R, hover: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } };
  },

  // ---------- ⑦ mermaid 全屏：关闭 ----------
  mermaidFsClose: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    add('Esc 关闭全屏浮层', !document.querySelector('.svg-fullscreen'));
    return { R };
  },

  // ---------- ⑧ mermaid（Live Preview，CM6 widget）：渲染 + 按钮就位 ----------
  mermaidLiveStatic: async (dir) => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 15000)) { const v = fn(); if (v) return v; await sleep(150); }
      return null;
    };
    window.Viewer.closeAll();
    localStorage.setItem('myide-md-mode', 'live');
    await sleep(150);
    await window.Viewer.openFile(dir + '\\_ui_mmd.md');
    const box = await waitFor(() => q('.cm-md-mermaid svg') && q('.cm-md-mermaid'), 15000);
    add('Live Preview 中 mermaid 渲染成 SVG', !!box, box && box.className);
    if (!box) return { R };
    const fsb = q('.cm-md-mermaid .mmd-fs-btn');
    add('Live Preview 图上挂载「⛶ 全屏」按钮', !!fsb, fsb && fsb.textContent);
    const r = fsb ? fsb.getBoundingClientRect() : null;
    return { R, hover: r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : undefined };
  },

  // ---------- ⑨ mermaid（Live Preview）：点全屏 → 浮层（保持打开） ----------
  mermaidLiveFs: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const fsb = q('.cm-md-mermaid .mmd-fs-btn');
    if (!fsb) { add('全屏按钮存在', false); return { R }; }
    fsb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(600);
    add('Live Preview 点全屏打开浮层', !!q('.svg-fullscreen'));
    add('浮层内含 SVG', !!q('.svg-fullscreen svg'));
    const r = q('.svg-fullscreen .img-bar') ? q('.svg-fullscreen .img-bar').getBoundingClientRect() : null;
    return { R, hover: r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : undefined };
  },

  // ---------- 提交窗口：PyCharm 复刻第二轮（图标工具行 / 节点三态 / 展开收起 / 平铺 / 内嵌预览 / 忽略节点 / 消息历史）----------
  commitPanelParity: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.App.showTool('git');
    for (let i = 0; i < 40 && !q('#cd-files .git-file'); i++) await sleep(200);
    const bar = q('#cd-files .git-cp-bar');
    add('工具行存在', !!bar);
    if (!bar) return { R };
    const btns = qa('#cd-files .git-cp-bar .vt-btn');
    add('工具行 8 个纯图标按钮', btns.length === 8 && btns.every((b) => b.querySelector('svg') && !b.textContent.trim()),
      btns.map((b) => String(b.title).split('（')[0]).join(' | '));

    // 节点三态
    const heads = qa('#cd-files .git-sec-title');
    add('分节标题都带三态复选框', heads.length >= 2 && heads.every((h) => h.querySelector('input[type=checkbox]')), heads.length + ' 个分节：' + heads.map((h) => h.textContent).join(' / '));
    const groups = qa('#cd-files .git-group');
    add('目录行都带三态复选框', groups.length > 0 && groups.every((g) => g.querySelector('input[type=checkbox]')), groups.length + ' 个目录行');
    if (heads.length) {
      const cb = heads[0].querySelector('input');
      const body = heads[0].nextElementSibling;
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(200);
      const inner = [...body.querySelectorAll('.cf-check')];
      add('勾选分节 → 该节文件全选', inner.length > 0 && inner.every((c) => c.checked), inner.length + ' 个文件');
      inner[0].checked = false; inner[0].dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(200);
      add('部分勾选 → 节点半选（indeterminate）', heads[0].querySelector('input').indeterminate === true);
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(200);
      add('再勾分节 → 恢复全选', [...body.querySelectorAll('.cf-check')].every((c) => c.checked));
    }

    // 展开 / 收起全部 + 平铺切换
    const visible = () => qa('#cd-files .git-file').filter((r) => {
      let n = r.parentElement;
      while (n && n !== q('#cd-files')) { if (n.style && n.style.display === 'none') return false; n = n.parentElement; }
      return true;
    });
    const before = visible().length;
    btns[6].click(); await sleep(400);
    add('收起全部 → 无可见文件行', visible().length === 0, '收起前 ' + before);
    btns[5].click(); await sleep(900);
    add('展开全部 → 文件行恢复', visible().length >= before, '恢复 ' + visible().length);
    btns[7].click(); await sleep(400);
    add('切到平铺：目录行消失 + 显示父目录', qa('#cd-files .git-group').length === 0 && qa('#cd-files .git-file .dir').length > 0,
      '父目录列 ' + qa('#cd-files .git-file .dir').length + ' 个');
    btns[7].click(); await sleep(400);
    add('切回按目录：目录行恢复', qa('#cd-files .git-group').length > 0);

    // 忽略的文件节点（懒加载）
    const ignHead = qa('#cd-files .git-sec-title').find((h) => h.textContent.includes('忽略的文件'));
    add('存在「忽略的文件」节点', !!ignHead, ignHead ? ignHead.textContent : '');
    if (ignHead) {
      if (!ignHead.textContent.includes('▸')) { ignHead.click(); await sleep(300); }
      ignHead.click();
      await sleep(2000);
      const ib = ignHead.nextElementSibling;
      const rows = [...ib.querySelectorAll('.git-file')];
      add('展开后列出被忽略项', rows.length > 0, rows.length + ' 项：' + rows.slice(0, 4).map((r) => r.dataset.file).join(', '));
      add('忽略行没有回滚按钮（回滚=删除，语义不对）', ib.querySelectorAll('.git-revert').length === 0);
    }

    // 内嵌 diff 预览
    const ey = qa('#cd-files .git-cp-bar .vt-btn')[4];
    ey.click();
    await sleep(800);
    // 显式点一个文本文件行：默认取到的可能是二进制 / 超大文件（kiosk_patches 之类），那样预览只有提示没有 diff 行
    const TEXTY = /\.(js|json|md|css|html|txt|yml|yaml|ts)$/;
    const pick = qa('#cd-files .git-file').find((r) => TEXTY.test(r.dataset.file || ''));
    if (pick) { pick.click(); await sleep(1200); }
    const pre = q('#commit-preview');
    add('预览打开：面板内出现 diff 行', !!pre && !pre.classList.contains('hidden') && qa('#cp-body .cp-line').length > 0,
      (q('#cp-stats') ? q('#cp-stats').textContent : '') + ' · hunk=' + qa('#cp-body .cp-hunk').length);
    add('预览按钮高亮', ey.classList.contains('active'));

    // 提交消息历史 + amend 回填
    const msg = q('#commit-msg');
    try { localStorage.setItem('myide-commit-msgs', JSON.stringify(['fix: 医疗终端追问降级', 'docs: 更新说明'])); } catch {}
    const hb = q('#commit-history');
    add('提交消息历史按钮存在', !!hb);
    if (hb) {
      hb.click(); await sleep(400);
      const menu = q('#git-float-menu');
      add('历史下拉弹出', !!menu, menu ? [...menu.querySelectorAll('.ctx-item')].map((x) => x.textContent).join(' | ') : '');
      const item = menu && [...menu.querySelectorAll('.ctx-item')].find((x) => x.textContent.indexOf('fix:') === 0);
      if (item) { item.click(); await sleep(300); }
      add('点历史条目填充输入框', String(msg.value).indexOf('fix:') === 0, String(msg.value).slice(0, 40));
    }
    const beforeAmend = String(msg.value);
    const amend = q('#commit-amend');
    amend.checked = true; amend.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1200);
    add('勾 amend → 自动回填上次提交消息',
      !!msg.value && String(msg.value) !== beforeAmend,
      '填入：' + String(msg.value).slice(0, 60).replace(/\n/g, ' '));
    amend.checked = false; amend.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    add('取消 amend → 还原原输入', String(msg.value).indexOf('fix:') === 0, String(msg.value).slice(0, 30));

    // 「提交并推送 ▾」选项菜单
    const pm = q('#cm-ok-push-menu');
    add('存在「提交并推送」的下拉箭头按钮', !!pm);
    if (pm) {
      pm.click(); await sleep(400);
      const pmenu = q('#git-float-menu');
      add('下拉弹出选项（其他远程 / 强制推送）', !!pmenu,
        pmenu ? [...pmenu.querySelectorAll('.ctx-item')].map((x) => x.textContent).join(' | ') : '');
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await sleep(200);
    }
    return { R };
  },

  // ---------- 侧栏字号：确认面板内部文字也一起缩放（此前大量写死 px 不跟动）----------
  toolFontScale: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.App.showTool('git');
    for (let i = 0; i < 40 && !q('#cd-files .git-file'); i++) await sleep(200);
    const SAMPLES = [
      ['提交·分节标题', '#cd-files .git-sec-title'],
      ['提交·文件行', '#cd-files .git-file'],
      ['提交·状态徽章', '#cd-files .git-file .badge'],
      ['提交·勾选计数', '#commit-count'],
      ['提交·消息框', '#commit-msg'],
      ['提交·面板标题', '#panel-git .panel-title'],
      ['提交·ahead/behind', '#cd-dirty'],
      ['目录树·行', '#tree .tree-row'],
      ['目录树·搜索框', '#tree-search'],
      ['目录树·图标列', '#tree .tree-row .ic'],
    ];
    const sizeOf = (sel) => {
      const el = q(sel);
      return el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100 : null;
    };
    const before = SAMPLES.map(([l, s]) => ({ l, s, v: sizeOf(s) }));
    const miss = before.filter((b) => b.v == null);
    add('采样点齐全', miss.length === 0, miss.length ? '缺失：' + miss.map((m) => m.l).join(',') : before.length + ' 处');
    if (miss.length) return { R };
    const inc = q('#sb-tf-inc');
    add('状态栏「侧栏 A+」按钮存在', !!inc);
    if (!inc) return { R };
    for (let i = 0; i < 3; i++) { inc.click(); await sleep(150); }
    await sleep(500);
    const pairs = before.map((b) => ({ ...b, a: sizeOf(b.s) }));
    const stuck = pairs.filter((x) => Math.abs(x.a - x.v) < 0.01);
    add('字号 +3 后面板内部文字全部跟着变', stuck.length === 0,
      stuck.length ? '没变：' + stuck.map((x) => x.l).join(', ')
                   : pairs.map((x) => x.l + ' ' + x.v + '→' + x.a).join(' | '));
    const ratio = pairs[0].v ? pairs[0].a / pairs[0].v : 0;
    add('放大比例符合 16/13', ratio > 1.15 && ratio < 1.35, 'ratio=' + ratio.toFixed(3));
    const dec = q('#sb-tf-dec');
    for (let i = 0; i < 3; i++) { dec.click(); await sleep(150); }
    await sleep(400);
    const back = before.map((b) => sizeOf(b.s));
    add('还原后回到原字号', back.every((v, i) => Math.abs(v - before[i].v) < 0.01), back.join(', '));
    return { R };
  },

  // ---------- 大纲面板：PyCharm Structure 形态 + 右键复制章节 ----------
  outlineStructure: async (dir) => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.Viewer.openFile(dir + '\\_ui_outline.md');
    await sleep(600);
    window.App.showTool('outline');
    for (let i = 0; i < 40 && !q('#outline .outline-item'); i++) await sleep(150);
    const rows = qa('#outline .outline-item');
    add('大纲渲染出 4 个标题（一级 / 二级A / 三级A1 / 二级B）', rows.length === 4, 'rows=' + rows.length);
    if (rows.length !== 4) return { R };

    const act = qa('#panel-outline .panel-title-actions .vt-btn');
    add('顶栏 2 个图标按钮（展开全部 / 收起全部）',
      act.length === 2 && act.every((b) => b.querySelector('svg') && !b.textContent.trim()),
      act.map((b) => b.title).join(' | '));
    add('旧的「全展 / H1..H4」工具条已移除（语义易误读）', !q('.outline-tools'));

    const arrows = qa('#outline .ol-arrow:not(.ol-pad)');
    const pads = qa('#outline .ol-arrow.ol-pad');
    add('只有含子层的行才有箭头', arrows.length === 2 && pads.length === 2,
      '箭头 ' + arrows.length + '（一级/二级A） / 占位 ' + pads.length + '（三级A1/二级B）');
    add('叶子行箭头列留空（不再画 · 占位符）',
      pads.every((p) => !p.textContent.trim()), JSON.stringify(pads.map((p) => p.textContent)));
    const textLeft = (r) => Math.round(r.querySelector('.ol-text').getBoundingClientRect().left);
    add('文本起点按层级递进', textLeft(rows[1]) > textLeft(rows[0]) && textLeft(rows[2]) > textLeft(rows[1]),
      [textLeft(rows[0]), textLeft(rows[1]), textLeft(rows[2])].join(' < '));
    const sizes = [...new Set(rows.map((r) => Math.round(parseFloat(getComputedStyle(r).fontSize) * 10) / 10))];
    add('各层级字号一致（只降对比不缩字号）', sizes.length === 1, 'sizes=' + sizes.join(','));
    const hs = [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height)))];
    add('行高一致', hs.length === 1, 'heights=' + hs.join(','));
    const rowH = rows[0].getBoundingClientRect().height;
    add('行高足够（≥1.7em，点得中）', rowH >= 20, 'rowH=' + Math.round(rowH));

    rows[1].click();
    await sleep(250);
    add('点击后整行高亮（选中带铺满）',
      getComputedStyle(rows[1]).backgroundColor !== 'rgba(0, 0, 0, 0)',
      getComputedStyle(rows[1]).backgroundColor);

    rows[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 70, clientY: 130 }));
    await sleep(350);
    const menu = q('#ctx-menu');
    const items = menu ? [...menu.querySelectorAll('.ctx-item')].map((x) => x.textContent) : [];
    add('右键章节名弹出菜单', !!menu && items.length > 0, items.join(' | '));
    add('菜单含「复制本章节」（emoji 前缀不影响判定）', items.some((t) => t.includes('复制本章节')));
    add('另有「只复制本节正文」「复制标题文本」',
      items.some((t) => t.includes('只复制本节正文')) && items.some((t) => t.includes('复制标题文本')));
    add('原编辑器折叠能力移入菜单（不再占顶部一排按钮）',
      items.some((t) => t.includes('在编辑器中折叠到此层级')));
    const copyItem = menu && [...menu.querySelectorAll('.ctx-item')].find((x) => x.textContent.includes('复制本章节'));
    if (copyItem) { copyItem.click(); await sleep(400); }
    add('点「复制本章节」有反馈（toast）', !!q('.toast'),
      q('.toast') ? q('.toast').textContent.slice(0, 44) : '');

    const visNow = () => qa('#outline .outline-item').filter((r) => !r.classList.contains('ol-hidden')).length;
    const before = visNow();
    rows[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await sleep(450);
    add('双击标题行折叠其子层（小箭头之外的大目标）', visNow() < before, before + ' → ' + visNow());
    qa('#panel-outline .panel-title-actions .vt-btn')[0].click();
    await sleep(450);
    add('顶栏「展开全部」恢复 4 个', visNow() === 4, 'visible=' + visNow());
    qa('#panel-outline .panel-title-actions .vt-btn')[1].click();
    await sleep(450);
    add('顶栏「收起全部」只留 H1', visNow() === 1, 'visible=' + visNow());
    qa('#panel-outline .panel-title-actions .vt-btn')[0].click();
    await sleep(350);
    const r1 = qa('#outline .outline-item')[1];
    return { R, hover: { x: Math.round(r1.getBoundingClientRect().left + 50), y: Math.round(r1.getBoundingClientRect().top + r1.getBoundingClientRect().height / 2) } };
  },

  // ---------- AI 助手：空状态卡片 + 场景入口 + 顶栏/输入栏一致性 ----------
  aiAssistant: async (dir) => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

    // 自检 profile 是干净的 → 先放一份 AI 配置，才会渲染出带场景入口的卡片
    try {
      localStorage.setItem('myide-ai-cfg', JSON.stringify({
        baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '',
        permWrite: 'confirm', permRun: 'deny',
      }));
    } catch {}
    window.App.setAiOpen(true);
    await sleep(500);
    const panel = q('#ai-panel');
    const pw = panel ? Math.round(panel.getBoundingClientRect().width) : 0;
    add('AI 面板已展开（以下断言的前提）',
      !!panel && !panel.classList.contains('hidden') && pw > 0,
      panel ? 'hidden=' + panel.classList.contains('hidden') + ' 宽=' + pw : '面板不存在');
    const nw = q('#ai-new');
    if (nw) { nw.click(); await sleep(400); }

    const card = q('.ai-welcome .ai-card');
    add('空状态是卡片（不再是大 emoji 飘在虚空）', !!card);
    add('旧的大 emoji 元素已移除', !q('.ai-logo'));
    add('卡片内无 emoji', !!card && !EMOJI.test(card.textContent), card ? JSON.stringify(card.textContent.slice(0, 40)) : '');
    const quick = qa('.ai-quick .ai-quick-btn');
    add('渲染出 4 个场景入口', quick.length === 4, quick.map((b) => b.textContent).join(' | '));
    add('场景入口都带 tooltip', quick.length === 4 && quick.every((b) => !!b.title));

    const title = q('.ai-head .ai-title');
    add('顶栏标题 = SVG 图标 + 文字（无 emoji）',
      !!title && !!title.querySelector('svg') && !EMOJI.test(title.textContent),
      title ? JSON.stringify(title.textContent) : '');
    const tb = qa('.ai-head .panel-title-actions .vt-btn');
    add('顶栏 4 个按钮全为 SVG 且无文字',
      tb.length === 4 && tb.every((b) => b.querySelector('svg') && !b.textContent.trim()),
      tb.map((b) => String(b.title).split('（')[0]).join(' | '));

    const ph = q('#ai-input').placeholder;
    add('placeholder 已中文化', !/Ask anything/.test(ph) && /整理/.test(ph), ph);
    const chip = q('#ai-file-chip');
    add('附件按钮图标化（回形针，无文字）',
      !!chip && !!chip.querySelector('svg') && !chip.textContent.trim(), chip ? 'title=' + chip.title.slice(0, 20) : '');
    const barW = q('.ai-input-bar').getBoundingClientRect().width;
    const inpW = q('#ai-input').getBoundingClientRect().width;
    add('输入框占输入栏宽度 ≥ 70%（不再被按钮挤窄）', inpW / barW >= 0.7,
      '输入框 ' + Math.round(inpW) + ' / 栏 ' + Math.round(barW));

    // 场景入口要真能用：打开文档后点「整理当前文档」→ 填指令 + 自动挂上当前文件
    await window.Viewer.openFile(dir + '\\_ui_outline.md');
    await sleep(700);
    window.App.setAiOpen(true);
    const nw2 = q('#ai-new');
    if (nw2) { nw2.click(); await sleep(500); }
    const first = qa('.ai-quick .ai-quick-btn')[0];
    add('场景入口就绪', !!first, first ? first.textContent : '');
    if (first) {
      first.click();
      await sleep(1000);
      add('点「整理当前文档」→ 指令填入输入框', /整理/.test(q('#ai-input').value),
        JSON.stringify(String(q('#ai-input').value).slice(0, 26)));
      // 当前文件可以有两种形态：自动跟随（显示在上方「正在看」条）或手动附加（chips）
      const chips = qa('.ai-ctx-chip');
      const fbNow = q('#ai-follow');
      const viaFollow = !!fbNow && !fbNow.classList.contains('hidden') && /_ui_outline/.test(fbNow.textContent);
      const viaChip = chips.length === 1 && /_ui_outline/.test(chips[0].textContent);
      add('整理类指令一定带上了当前文件（跟随或手动附都算）', viaFollow || viaChip,
        '跟随条=' + (viaFollow ? '有' : '无') + ' / chips=' + (chips.map((c) => c.textContent).join(' | ') || '(无)'));
    }
    const hoverRect = q('.ai-quick .ai-quick-btn');
    return {
      R,
      hover: hoverRect ? {
        x: Math.round(hoverRect.getBoundingClientRect().left + 40),
        y: Math.round(hoverRect.getBoundingClientRect().top + 12),
      } : undefined,
    };
  },

  // ---------- AI 面板：人对它说一句话 → 它改文档 → 人看改动 → 不满意撤销 ----------
  aiPanelFlow: async (arg) => {
    const dir = arg; // 模型已由主进程打桩，这里只需项目目录
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 20000)) { const v = fn(); if (v) return v; await sleep(150); }
      return null;
    };
    const FILE = '_ui_outline.md';
    const tidy = (el) => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

    // 自检环境没有真 API key → 指向本地假服务（这样验证的仍是真实链路，不是打桩的 DOM）
    // baseUrl 只用来让面板认为「已配置」，实际请求被主进程的桩接管
    window.AiPanel.setConfig({ baseUrl: 'http://stub.local/v1', model: 'stub', apiKey: 'x', permWrite: 'confirm' });
    await window.Viewer.openFile(dir + '\\' + FILE);
    await sleep(700);
    window.App.setAiOpen(true);
    await sleep(600);

    // —— 人的第一眼：我打开了一份文档，它知道我在看哪份吗 ——
    const fb = q('#ai-follow');
    add('打开文档后，面板自己显示「正在看 这份文件」（不用手动附）',
      !!fb && !fb.classList.contains('hidden') && fb.textContent.includes(FILE),
      fb ? tidy(fb) : '(没有这条)');

    // —— 我打一句话，回车 ——
    q('#ai-input').value = '把「二级 B」这个标题加个备注';
    q('#ai-send').click();

    const yes = await waitFor(() => q('#dw-yes'), 20000);
    add('它要动文件之前，先给我看 diff 让我决定（没有偷偷改）', !!yes);
    if (yes) yes.click();

    const card = await waitFor(() => {
      const all = qa('#ai-msgs .ai-edit');
      return all.length ? all[all.length - 1] : null;
    }, 20000);
    add('改完之后，聊天里出现一张「改动卡片」', !!card, card ? tidy(card).slice(0, 46) : '(没有卡片)');

    if (card) {
      add('卡片一眼看出：改了哪个文件、加了几行减了几行（带 +N -M）',
        card.textContent.includes(FILE) && /\+\d/.test(card.textContent) && /-\d/.test(card.textContent),
        tidy(card).slice(0, 40));

      const tg = card.querySelector('.e-toggle');
      if (tg) {
        tg.click();
        await sleep(400);
        const body = card.querySelector('.ai-edit-body');
        const adds = body.querySelectorAll('.d-add').length;
        const dels = body.querySelectorAll('.d-del').length;
        add('点「看改动」能就地展开红绿对比', !body.classList.contains('hidden') && adds > 0,
          '新增 ' + adds + ' 行 / 删除 ' + dels + ' 行');
        add('展开后按钮变成「收起」，能收回去', tg.textContent === '收起', tg.textContent);
        tg.click();
        await sleep(250);
      }

    }
    return { R, hover: fb ? { x: Math.round(fb.getBoundingClientRect().left + 60), y: Math.round(fb.getBoundingClientRect().top + 10) } : undefined };
  },

  // ---------- 接着上一步：人回头看了一眼，决定把刚才那处改回去 ----------
  aiPanelUndo: async (arg) => {
    const dir = arg;
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tidy = (el) => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

    const card = qa('#ai-msgs .ai-edit').pop();
    add('回头还能看到上次改动（卡片留在聊天里，不是一闪而过）', !!card);
    if (!card) return { R };
    const un = card.querySelector('.e-undo');
    add('卡片上有「撤销」按钮（能只改回这一处）', !!un);
    if (!un) return { R };
    un.click();
    await sleep(1000);
    add('点撤销后，卡片明确标记为已撤销', card.classList.contains('undone'), tidy(card).slice(0, 44));
    const back = await window.myIDE.fs.readFile(dir + '\\' + '_ui_outline.md');
    add('文件内容真的回到改之前（不是只改界面）',
      !!back && !/备注/.test(String(back.content || '')),
      '现在开头: ' + String((back && back.content) || '').slice(0, 22).replace(/\n/g, ' '));
    return { R };
  },
};

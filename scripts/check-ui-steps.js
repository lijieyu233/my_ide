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
    await sleep(1500);
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
    const amend = q('#commit-amend');
    amend.checked = true; amend.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1200);
    add('勾 amend → 自动回填上次提交消息', !!msg.value && String(msg.value).indexOf('fix:') !== 0, String(msg.value).slice(0, 60).replace(/\n/g, ' '));
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
};

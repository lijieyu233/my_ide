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
    // 分隔线是 JS 按「信息有几项」插的：只有一项时不需要分隔线，所以两种都算通过
    add('状态栏组间有分隔线', (q('#sb-info') && q('#sb-info').childNodes.length) <= 1 || !!q('#statusbar .sb-d') || !!q('#statusbar .sb-sep'));
    // 左边留给光标/分支，字号控件整体靠右（与 VS Code / PyCharm 一致）
    add('字号控件在状态栏右侧（左侧让给光标/分支）',
      [...q('#statusbar').children].filter((x) => x.id).map((x) => x.id).indexOf('sb-tool-font') >= 2,
      [...q('#statusbar').children].filter((x) => x.id).map((x) => x.id).join(' | '));
    add('状态栏信息在前（光标位置优先于行数/编码）',
      (() => {
        const ids = [...q('#statusbar').children].filter((x) => x.id).map((x) => x.id);
        return ids[0] === 'sb-info' && ids[1] === 'sb-branch';
      })(), '');
    const hasFocusRule = Array.from(document.styleSheets).flatMap((s) => { try { return Array.from(s.cssRules); } catch { return []; } })
      .some((r) => r.selectorText === ':focus-visible');
    add('统一焦点态规则存在', hasFocusRule, hasFocusRule ? ':focus-visible' : '缺失');
    // 布局尺寸只有一个来源：CSS 的默认宽度必须等于 App.LAYOUT 里的默认值，
    // 否则「双击分隔线复位」会跳到另一个宽度上（数字分散在两处必然漂移）。
    const cssW = (sel) => { const e = q(sel); return e ? getComputedStyle(e).width : ''; };
    const LO = window.App.LAYOUT;
    add('侧栏默认宽度 = App.LAYOUT.sidebar.def', cssW('#sidebar') === LO.sidebar.def + 'px',
      cssW('#sidebar') + ' vs ' + LO.sidebar.def + 'px');
    add('AI 面板默认宽度 = App.LAYOUT.ai.def', cssW('#ai-panel') === LO.ai.def + 'px',
      cssW('#ai-panel') + ' vs ' + LO.ai.def + 'px');
    add('侧栏钳制范围写进 CSS（min / max 与 LAYOUT 一致）',
      getComputedStyle(q('#sidebar')).minWidth === LO.sidebar.min + 'px'
      && getComputedStyle(q('#sidebar')).maxWidth === LO.sidebar.max + 'px',
      getComputedStyle(q('#sidebar')).minWidth + ' ~ ' + getComputedStyle(q('#sidebar')).maxWidth);
    add('右侧栏比左侧栏略宽（AI 要能读长文档片段）', LO.ai.def > LO.sidebar.def, LO.sidebar.def + ' / ' + LO.ai.def);

    // 标签栏：隐藏原生滚动条（一条灰滚动条比标签本身还抢眼 —— 用户截图反馈）
    const ts = q('#tab-scroll');
    add('标签栏不显示原生横向滚动条', !!ts && getComputedStyle(ts).scrollbarWidth === 'none',
      ts ? 'scrollbar-width=' + getComputedStyle(ts).scrollbarWidth : '无 #tab-scroll');

    // ---------- 区域之间用「缝」，不是「线」----------
    // 1px 的**浅色**描边读起来是"边框"：几块面板排在一起就成了"一个个方块只隔一条线"，
    // 又紧又粘、缺乏区分。换成 4px 的深色条（比所有区域都暗）之后，读起来是"间距"——
    // 区域各自成块，而线条数量并没有增加。
    const cssVar = (el, k) => getComputedStyle(el).getPropertyValue(k).trim();
    const hexToRgb = (hex) => {
      const h = String(hex || '').replace('#', '').trim();
      const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const v = parseInt(full, 16);
      return isNaN(v) ? '' : 'rgb(' + (v >> 16 & 255) + ', ' + (v >> 8 & 255) + ', ' + (v & 255) + ')';
    };
    const lumNorm = (str) => {
      const v = (String(str).match(/[\d.]+/g) || []).map(Number);
      return v.length >= 3 ? (v[0] + v[1] + v[2]) / 3 : -1;
    };
    const titleLum = lumNorm(hexToRgb(cssVar(document.body, '--bg-title')));
    const mainCS = getComputedStyle(q('#main'));
    const rzCS = getComputedStyle(q('#sidebar-resizer'));
    const aiCS = getComputedStyle(q('#ai-panel'));
    const tsCS = getComputedStyle(q('#tool-strip'));
    const seamLum = lumNorm(mainCS.borderTopColor);
    add('区域之间的缝 = 4px 深色条（不是 1px 浅色描边）',
      mainCS.borderTopWidth === '4px' && mainCS.borderBottomWidth === '4px',
      '上下=' + mainCS.borderTopWidth + '/' + mainCS.borderBottomWidth + ' 色=' + mainCS.borderTopColor);
    add('缝比所有区域都暗（这才读起来是"间距"）',
      seamLum >= 0 && seamLum + 2 < titleLum,
      '缝=' + Math.round(seamLum) + ' 最外层底=' + Math.round(titleLum));
    add('四道缝同宽同色（顶/底、侧栏分隔线、AI、工具条）',
      rzCS.width === '4px' && rzCS.backgroundColor === mainCS.borderTopColor
        && aiCS.borderLeftWidth === '4px' && aiCS.borderLeftColor === mainCS.borderTopColor
        && tsCS.borderRightWidth === '4px' && tsCS.borderRightColor === mainCS.borderTopColor,
      '侧栏=' + rzCS.backgroundColor + ' AI=' + aiCS.borderLeftColor + ' 工具条=' + tsCS.borderRightColor);
    add('顶栏 / 状态栏 / 侧栏不再有浅色描边（靠缝 + 明度分层，不靠线框）',
      getComputedStyle(q('#statusbar')).borderTopStyle === 'none'
        && getComputedStyle(q('#toolbar')).borderBottomStyle === 'none'
        && getComputedStyle(q('#sidebar')).borderRightStyle === 'none',
      'statusbar=' + getComputedStyle(q('#statusbar')).borderTopStyle
        + ' toolbar=' + getComputedStyle(q('#toolbar')).borderBottomStyle
        + ' sidebar=' + getComputedStyle(q('#sidebar')).borderRightStyle);

    // ---------- 整体视觉的「结构」层面（不是某个图标，是分层的骨架） ----------
    // ① 顶栏以下只该有「标签栏 → 内容」两段。原来还夹了一条编辑器工具条
    //    （左边 500px 全空、只为右侧摆 4 个小按钮），chrome 一共占掉 99px。
    add('编辑区没有独立的工具条行（chrome 4 行 → 3 行）', !q('.viewer-toolbar'),
      q('.viewer-toolbar') ? '仍有独立工具条行' : '无 ✓');
    // ② 标题行等高 —— 原来侧栏 32 / 标签栏 28 / AI 助手 30 三种，交界处的底线对不齐。
    //    AI 面板在这一步可能收着（高度 0），三处齐平留到 aiAssistant 步骤测。
    const hOf = (sel) => { const e = q(sel); return e ? Math.round(e.getBoundingClientRect().height) : -1; };
    const visTitle = qa('#sidebar .panel-title').find((e) => e.getBoundingClientRect().height > 0);
    const hs = [hOf('#tabbar'), visTitle ? Math.round(visTitle.getBoundingClientRect().height) : -1];
    add('侧栏标题与标签栏等高（三处齐平在 AI 面板展开时测）', hs.every((x) => x > 0) && new Set(hs).size === 1, hs.join(' / '));
    // ③ 明度阶梯：内容最亮、越靠外越暗。分层该靠明度而不是 1px 黑线画格子
    const L = (v) => parseInt(getComputedStyle(document.documentElement).getPropertyValue(v).trim().slice(1, 3), 16);
    const lv = { bg: L('--bg'), tabbar: L('--bg-tabbar'), panel: L('--bg-panel'), title: L('--bg-title') };
    add('明度阶梯 内容 > 标签栏 > 工具窗口 > 外框',
      lv.bg > lv.tabbar && lv.tabbar > lv.panel && lv.panel > lv.title,
      lv.bg + ' > ' + lv.tabbar + ' > ' + lv.panel + ' > ' + lv.title);
    const gap = Math.abs(lv.bg - lv.panel);
    add('内容 ↔ 工具窗口明度差 ≥ 8 级（原来只有 5 级，肉眼分不出）', gap >= 8, gap + ' 级');
    // ② 跨主题的两个不变量：内容比标签栏亮（选中标签能"并进"内容）、
    //    外框比工具窗口暗（最外层退到最后）。浅色/粉色主题是同一套关系，方向一致。
    const lum = (hex) => { const v = parseInt(hex.slice(1), 16); return ((v >> 16 & 255) + (v >> 8 & 255) + (v & 255)) / 3; };
    const raw = {};
    ['--bg', '--bg-tabbar', '--bg-panel', '--bg-title'].forEach((k) => {
      const mm = getComputedStyle(document.documentElement).getPropertyValue(k).trim();
      raw[k] = mm.startsWith('#') ? lum(mm) : -1;
    });
    add('内容比标签栏亮（选中标签能与内容连成一片）', raw['--bg'] > raw['--bg-tabbar'],
      Math.round(raw['--bg']) + ' > ' + Math.round(raw['--bg-tabbar']));
    add('外框比工具窗口暗（最外层退到最后）', raw['--bg-title'] < raw['--bg-panel'],
      Math.round(raw['--bg-title']) + ' < ' + Math.round(raw['--bg-panel']));
    // ③ 守卫：任何定义了 --bg-panel 的主题都必须同时定义 --bg-title，
    //    否则该主题的顶栏/状态栏会掉回默认深色（浅色主题直接变黑条）
    const themeRules = Array.from(document.styleSheets).flatMap((ss) => { try { return Array.from(ss.cssRules); } catch { return []; } })
      .filter((r) => r.style && (r.style.getPropertyValue('--bg-panel') || '').trim());
    const missing = themeRules.filter((r) => !(r.style.getPropertyValue('--bg-title') || '').trim()).map((r) => r.selectorText);
    add('每个主题都定义了 --bg-title（否则该主题顶栏变黑条）', missing.length === 0,
      missing.length ? '缺失：' + missing.join(',') : themeRules.length + ' 个主题全有');
    // ④ 跨主题实测：切到每个主题量一次「外框 vs 工具窗口」的明度关系。
    //    只检查 CSS 变量不够 —— 变量名漏了的主题会静默掉回默认深色（浅色主题直接变黑条）。
    const lumOf = (rgb) => { const m = rgb.match(/\d+/g) || [0, 0, 0]; return (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3; };
    const themeBad = [];
    const themeSeen = [];
    const keep = document.body.className;
    ['', 'theme-light', 'theme-pink', 'theme-crimson'].forEach((t) => {
      document.body.className = keep.replace(/theme-\w+/g, '').trim() + (t ? ' ' + t : '');
      const tb = lumOf(getComputedStyle(q('#toolbar')).backgroundColor);
      const sb = lumOf(getComputedStyle(q('#sidebar')).backgroundColor);
      themeSeen.push((t || '默认') + ' ' + Math.round(tb) + '/' + Math.round(sb));
      if (!(tb < sb)) themeBad.push(t || '默认');
    });
    document.body.className = keep;
    add('每个主题的顶栏都比侧栏暗（外框退到最后；漏定义变量会静默掉回深色）',
      themeBad.length === 0, '顶栏/侧栏明度：' + themeSeen.join('  '));

    // ⑤ 选中态只留一个指示（原来左侧 accent 边框 + 右侧 accent 竖条，同一个按钮两个标记）
    const act0 = q('#tool-strip .tool-btn.active');
    const after = act0 ? getComputedStyle(act0, '::after').content : '';
    add('左侧工具条选中态只有一个 accent 指示', after === 'none' || after === '',
      'active::after content=' + after);
    // ⑤ 标签区与操作区分离：文件多了操作按钮不跟着滚走
    add('标签栏拆成「滚动区 + 操作区」且是兄弟节点',
      !!q('#tab-scroll') && !!q('#tab-actions') && q('#tab-actions').parentElement.id === 'tabbar');
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

    // ---------- 切换文件不该让整棵树重建 ----------
    // 重建 = 先清空 DOM 再 await 加载目录 → 中间会白一帧，用户看到的"闪"就是它。
    // 判据用「DOM 节点身份」：真重建了，旧节点必然 isConnected === false。
    const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
    const dirP = window.__CHECK_P;
    const pickRow = (name) => qa('#tree .tree-row')
      .find((r) => (((r.querySelector('.nm') || {}).title) || '').endsWith(name));
    await sleep2(600);
    const rootRow0 = q('#tree').firstElementChild; // 根行：整树重建时一定被换掉
    const rowA = pickRow('_ui_mmd.md');
    const rowB = pickRow('_ui_outline.md');
    add('根目录下两个 fixture 都在树里（以下断言的前提）', !!rootRow0 && !!rowA && !!rowB,
      'root=' + !!rootRow0 + ' A=' + !!rowA + ' B=' + !!rowB);
    if (rootRow0 && rowA && rowB) {
      rowA.click();
      await sleep2(800);
      add('打开文件后树没有被重建（根行仍是同一个 DOM 节点）',
        rootRow0 === q('#tree').firstElementChild && rootRow0.isConnected, '同一节点=' + (rootRow0 === q('#tree').firstElementChild));
      const rowA2 = pickRow('_ui_mmd.md');
      rowB.click();
      await sleep2(800);
      add('切换文件时树不重建（只换高亮，不清空重画）',
        rootRow0 === q('#tree').firstElementChild && rootRow0.isConnected && !!rowA2 && rowA2.isConnected,
        '根行同节点=' + (rootRow0 === q('#tree').firstElementChild) + ' 旧行仍在=' + !!(rowA2 && rowA2.isConnected));
      const sel = qa('#tree .tree-row.selected').map((r) => ((r.querySelector('.nm') || {}).title) || '');
      add('切换后高亮跟到新文件', sel.some((t) => t.endsWith('_ui_outline.md')), sel.join(' | ').slice(0, 90));
    }

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
    const opened = await waitFor(() => window.App.getProjects().length >= 5, 8000);
    const n = window.App.getProjects().length;
    add('已打开多个项目（以下断言的前提）', !!opened && n >= 5, 'n=' + n);

    const bar = q('#project-bar');
    const btns = qa('#project-bar .proj-btn');
    // 平铺是刻意的：这排按钮的用途是"一眼看到、一下点过去"。曾经 >3 个项目就收成一个
    // 「当前项目 ▾」—— 结果是"我是谁"留下了、"切到别处"的能力没了（用户原话：
    // "你不能为了保留这个删除我的功能"）。
    add('项目始终平铺（每个项目一个按钮，不再收成「当前项目 ▾」）',
      btns.length === n && !q('#project-bar .proj-btn.proj-current'),
      '按钮=' + btns.length + ' / 项目=' + n);
    add('有且只有一个按钮是 active，且指向当前项目',
      btns.filter((b) => b.classList.contains('active')).length === 1
        && btns.some((b) => b.classList.contains('active') && b.dataset.path === window.App.root));
    add('当前项目用弱背景 + 强调边线（不是实心 accent 块，也不至于看不出是哪个）',
      (() => { const a = q('#project-bar .proj-btn.active'); if (!a) return false;
        const s2 = getComputedStyle(a); return s2.backgroundColor !== 'rgb(217, 104, 125)' && s2.borderStyle !== 'none'; })());
    add('「关闭项目 ✕」默认隐藏（顶栏不常驻危险动作）',
      btns.every((b) => { const x = b.querySelector('.proj-close'); return !x || getComputedStyle(x).visibility === 'hidden'; }));
    add('「全部项目」入口在（图标 + 数量，负责"最近打开"）',
      !!q('.proj-all') && !!q('.proj-all .proj-all-n')
        && q('.proj-all .proj-all-n').textContent === String(n),
      q('.proj-all') ? q('.proj-all').textContent : '无');

    // 点「全部项目」图标 → 弹切换菜单（完整列表 + 最近打开 + 当前项目动作）
    q('.proj-all').click();
    await sleep(300);
    const menu = q('#ctx-menu');
    add('点击当前项目弹出切换菜单', !!menu && !menu.classList.contains('hidden'), menu ? menu.className : '无菜单');
    const items = menu ? [...menu.querySelectorAll('.ctx-item:not(.ctx-title)')] : [];
    add('菜单里有可切换的其他项目', items.length >= 2, '条目=' + items.length);
    add('菜单底部有当前项目的操作（复制路径 / 定位）',
      items.some((x) => /复制项目路径/.test(x.textContent)) && items.some((x) => /在资源管理器中显示/.test(x.textContent)),
      items.map((x) => x.textContent).join(' | ').slice(0, 90));
    // 菜单里点另一个项目 → 真的切过去
    const before = window.App.root;
    const other = items.find((x) => x.title && x.title !== before && /[\\/]/.test(x.title));
    if (other) {
      other.click();
      await sleep(1200);
      add('从菜单切换项目生效', window.App.root === other.title, before + ' → ' + window.App.root);
    } else {
      add('从菜单切换项目生效', false, '菜单里没找到可切换的项目');
    }
    add('项目栏没有把页面撑出横向滚动',
      document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1,
      'doc=' + document.scrollingElement.scrollWidth + '/' + document.scrollingElement.clientWidth);

    // ⚠ 收尾必须切回自检的 demo 项目：后面所有步骤的 fixture 都在 dir 里，
    //   而 AI 面板解析工具路径用的是「当前项目根」—— 不还原的话它会去错误的目录里找文件，
    //   表现成一堆莫名其妙的"文件不存在"（这一步踩过：AI 流程的 replace_edit 全挂）。
    window.App.showTool('project');
    if (window.App.root !== dir) await window.App.openProject(dir);
    await sleep(700);
    add('收尾：切回 demo 项目（后续步骤的 fixture 都在这里）', window.App.root === dir, 'root=' + window.App.root);
    return { R };
  },

  // ---------- 正文阅读版式：收窄后的实际观感（产物截图用）----------
  // 放最后 + 故意收起 AI 助手：编辑区足够宽，才看得出"正文列收窄、内容浮在工作区里"。
  mdReading: async (dir) => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.App.setAiOpen(false);
    localStorage.setItem('myide-md-mode', 'live');
    window.Viewer.closeAll();
    await sleep(200);
    await window.Viewer.openFile(dir + '\\_ui_mmd.md');
    await sleep(2000);
    const content = q('.editor-cm-wrap .cm-content');
    const ed = q('#viewer');
    if (content && ed) {
      const cR = content.getBoundingClientRect(), eR = ed.getBoundingClientRect();
      add('正文列收窄后在宽编辑区里居中（截图用）', cR.width <= 860,
        '列宽=' + Math.round(cR.width) + ' 编辑区=' + Math.round(eR.width)
        + ' 左=' + Math.round(cR.left - eR.left) + ' 右=' + Math.round(eR.right - cR.right));
    } else {
      add('正文列收窄后在宽编辑区里居中（截图用）', false, '没找到正文列');
    }
    return { R };
  },

  // ---------- 侧栏面板：项目工具窗口只放项目树（不做上下分栏）----------
  // 曾经在项目树下面挂过「大纲 / Structure」下半区；用户要求去掉。大纲仍是独立工具窗口。
  sidePanelOnly: async (dir) => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const hOf = (sel) => Math.round(q(sel).getBoundingClientRect().height);

    window.App.showTool('project');
    await sleep(700);
    add('项目工具窗口 = 只有项目树（下面不再挂大纲）',
      !q('#panel-project').classList.contains('hidden') && q('#panel-outline').classList.contains('hidden'),
      '项目树=' + !q('#panel-project').classList.contains('hidden')
        + ' 大纲=' + !q('#panel-outline').classList.contains('hidden'));
    add('上下分隔线已彻底移除（DOM 里没有 #side-hsplit）', !q('#side-hsplit'));
    add('项目树独占整栏（不是上面半截）',
      Math.abs(hOf('#panel-project') - hOf('#sidebar')) <= 2,
      hOf('#panel-project') + ' vs ' + hOf('#sidebar'));

    // 大纲没被删掉：它仍是独立工具窗口，单独打开时独占整栏
    window.App.showTool('outline');
    await sleep(700);
    const olTxt = (q('#outline') ? q('#outline').textContent : '').trim();
    add('大纲仍是独立工具窗口（从左侧工具条可打开，功能没被删）',
      !q('#panel-outline').classList.contains('hidden') && q('#panel-project').classList.contains('hidden'));
    add('大纲独占整栏', Math.abs(hOf('#panel-outline') - hOf('#sidebar')) <= 2,
      hOf('#panel-outline') + ' vs ' + hOf('#sidebar'));
    add('大纲有内容（当前文档的标题）', olTxt.length > 0, olTxt.slice(0, 40) || '(空)');

    window.App.showTool('project');
    await sleep(500);
    return { R };
  },

  // ---------- 主题：「红色只做强调色，不做环境光」的量化守卫 ----------
  // 放在自检最后一步，故意不还原主题 —— 产物截图就是酒红主题的实际观感。
  themeGraphite: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const hex2rgb = (h) => { const v = parseInt(h.replace('#', '').slice(0, 6), 16); return [v >> 16 & 255, v >> 8 & 255, v & 255]; };
    // 颜色字符串解析：color-mix 在现代 Chromium 里会算成 `color(srgb 0.83 0.86 0.88)`，
    // 直接按 0-255 读会得到 0.83 这种数（踩过：跨度算成 0.05，断言全错）
    // ⚠ 必须认 hex：getComputedStyle 读自定义属性返回的是 `#f06292` 这种写法，
    //   只抓 [\d.]+ 会把 `#f06292` 抓成单个数字 6292 → 返回空数组 → 与全零比较时
    //   任何深色都"匹配"，断言变成空转（踩过：焦点普查把所有中性容器都算成 accent 实心块，
    //   主题步骤里几个"底色是否中性"的检查也一直空转）。
    const parseColorRgb = (str) => {
      const t = String(str || '').trim();
      if (!t || t === 'none' || t === 'transparent') return [];
      const hx = t.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
      if (hx) {
        let h = hx[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      }
      const nums = (t.match(/[\d.]+/g) || []).map(Number);
      if (nums.length < 3) return [];
      const k = /^color\(/.test(t) ? 255 : 1;
      return nums.slice(0, 3).map((x) => x * k);
    };
    const spreadOf = (str) => { const c = parseColorRgb(str); return c.length === 3 ? Math.max(...c) - Math.min(...c) : -1; };
    // 主题变量挂在 body 上，必须从 body 读（documentElement 只有 :root 的默认值）
    const readVar = (k) => getComputedStyle(document.body).getPropertyValue(k).trim();
    const lum = (h) => { const c = hex2rgb(h); return (c[0] + c[1] + c[2]) / 3; };
    const spread = (h) => { const c = hex2rgb(h); return Math.max(...c) - Math.min(...c); };

    // ⚠ 主题变量定义在 body 上（不是 :root）—— 必须从 document.body 读，
    //   读 documentElement 会永远拿到默认主题的值（假通过/假失败各踩过一次）。
    const keep = document.body.className;
    const setTheme = (t) => { document.body.className = keep.replace(/theme-\w+/g, '').trim() + (t ? ' ' + t : ''); };
    // 通用守卫：每个主题都要满足「明度阶梯」和「内容 ↔ 工具窗口 ≥ 8 级」
    const gapBad = [];
    const tintBad = [];
    const seen = [];
    // 深色主题（默认 / 深红 / 石墨）要求严格单调阶梯；浅色主题只要「内容最亮 + 与工具窗口区分得开」
    const DARK_T = ['', 'theme-crimson', 'theme-graphite'];
    for (const t of ['', 'theme-light', 'theme-pink', 'theme-crimson', 'theme-graphite']) {
      setTheme(t);
      await sleep(120);
      const bv = (k) => getComputedStyle(document.body).getPropertyValue(k).trim();
      const l = (k) => lum(bv(k));
      const gap = l('--bg') - l('--bg-panel');
      if (DARK_T.includes(t)) {
        // 深色主题：四档严格单调递减（内容 > 标签栏 > 工具窗口 > 外框）+ 内容↔工具窗口 ≥ 8 级
        if (!(l('--bg') > l('--bg-tabbar') && l('--bg-tabbar') > l('--bg-panel') && l('--bg-panel') > l('--bg-title'))) {
          gapBad.push((t || '默认') + '阶梯乱');
        }
        if (gap < 8) gapBad.push((t || '默认') + '差' + Math.round(gap));
      } else {
        // 浅色主题：内容必须是最亮的一档，且与工具窗口区分得开（浅色主题不强制单调 ——
        // 用户明确要求"粉红主题尽量回退"，原样就是标签栏比面板略深）
        const all = [l('--bg'), l('--bg-tabbar'), l('--bg-panel'), l('--bg-title')];
        if (Math.max(...all) !== all[0]) gapBad.push((t || '默认') + '内容不是最亮');
        if (gap < 5) gapBad.push((t || '默认') + '差' + Math.round(gap));
      }
      // 只有默认（深色中性）要求底色中性；深红是刻意的暖调、浅色/粉色本来就彩色
      if (t === '' && spread(bv('--bg')) > 3) tintBad.push(t || '默认');
      seen.push((t || '默认') + ' ' + [l('--bg'), l('--bg-tabbar'), l('--bg-panel'), l('--bg-title')].map((x) => Math.round(x)).join('>'));
    }
    add('每个主题都满足各自的明度阶梯规则', gapBad.length === 0, seen.join('  '));
    add('默认深色主题的底色是中性的', tintBad.length === 0, tintBad.join(',') || '中性');

    // 收尾切到石墨（本步截图 + 后面的断言都在这个主题下）
    setTheme('theme-graphite');
    await sleep(500);

    const bgVars = ['--bg', '--bg-tabbar', '--bg-panel', '--bg-title'];
    const tinted = bgVars.filter((k) => spread(readVar(k)) > 3);
    add('石墨主题的底色是中性黑灰（红只做强调色，不做环境光）', tinted.length === 0,
      bgVars.map((k) => k + '=' + readVar(k)).join(' '));
    add('石墨主题正文色也中性', spread(readVar('--text')) <= 6, '--text=' + readVar('--text'));
    const ac = hex2rgb(readVar('--accent'));
    add('石墨主题强调色是玫瑰红（品牌感保留）', ac[0] - ac[1] >= 40, '--accent=' + readVar('--accent'));

    const lv = bgVars.map((k) => lum(readVar(k)));
    add('明度阶梯在石墨主题里同样成立（内容 > 标签栏 > 工具窗口 > 外框）',
      lv[0] > lv[1] && lv[1] > lv[2] && lv[2] > lv[3], lv.map((x) => Math.round(x)).join(' > '));

    // 选中态减重：弱背景 + 2px accent 左线，而不是整块实心色
    const tr = q('.tree-row.selected') || q('.outline-item.key-nav-sel');
    if (tr) {
      const raw = getComputedStyle(tr).backgroundColor;
      const m = (raw.match(/[\d.]+/g) || []).map(Number);
      const alpha = m.length >= 4 ? m[3] : 1;
      add('侧栏当前项是弱背景（半透明），不是整块实心色', alpha < 0.25, raw);
      const bar = getComputedStyle(tr, '::before');
      add('侧栏当前项带 2px 强调色左线', bar.width === '2px' && bar.backgroundColor !== 'rgba(0, 0, 0, 0)',
        '宽=' + bar.width + ' 色=' + bar.backgroundColor);
    } else {
      add('侧栏有选中项可供检查', false, '没有 .tree-row.selected / .outline-item.key-nav-sel');
    }

    // Markdown 排版收紧 + 标题不再是同一种强调色
    const box = document.createElement('div');
    box.className = 'md-view';
    box.style.cssText = 'position:absolute;left:-9999px;top:0;width:600px';
    box.innerHTML = '<h1>一级</h1><h2>二级</h2><h3>三级</h3><p>正文</p>';
    document.body.appendChild(box);
    const sz = [...box.querySelectorAll('h1,h2,h3')].map((e) => Math.round(parseFloat(getComputedStyle(e).fontSize)));
    const c1 = getComputedStyle(box.querySelector('h1')).color;
    const c3 = getComputedStyle(box.querySelector('h3')).color;
    const bt = getComputedStyle(document.body).getPropertyValue('--text-bright').trim();
    box.remove();
    add('Markdown 标题字号收紧（h1 ≤ 22 / h2 ≤ 18 / h3 ≤ 16）', sz[0] <= 22 && sz[1] <= 18 && sz[2] <= 16, sz.join(' / '));
    add('标题不再全用同一个颜色（h1 用正文亮色，h3 带强调色调）', c1 !== c3, 'h1=' + c1 + ' h3=' + c3);

    // ⚠ 上面是"造一个 .md-view 探针"测的，测不到编辑器真实渲染路径 ——
    //   实测过一次假通过：探针里的 h1 是中性色，而编辑器里的 h1 因为 heading token
    //   被硬编码成 One Dark 红 #e06c75，在酒红主题下依然是玫瑰色。
    //   所以这里必须直接量编辑器里真实存在的标题元素。
    const realH = q('.cm-md-h1') || q('#viewer .md-view h1') || q('.cm-content h1');
    if (!realH) {
      add('量到编辑器里真实的 Markdown 标题（真实渲染路径）', false, '没找到 .cm-md-h1 / .md-view h1');
    } else {
      const rc = getComputedStyle(realH).color;
      // 不再硬编码 One Dark 红，但也不能是"纯白"（用户原话：「纯白的 md 样式很难看」）：
      // 期望是"偏亮的正文色 + 一点主题色调"，因此要求色相跨度既不太大（不是全红）也不为 0（不是纯灰白）
      const sp = spreadOf(rc);
      add('编辑器里的标题带主题色调（既不是硬编码红，也不是纯白/纯灰）', sp >= 3 && sp < 60,
        'h1=' + rc + ' 跨度=' + Math.round(sp));
    }

    await sleep(300);
    return { R };
  },

  // ---------- 主题：深红回退（用户要求"尽量回退"成原来的暖调） ----------
  // 同样放最后，故意把主题留在深红上 —— 产物截图就是它的实际观感。
  themeCrimsonRevert: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const hex2rgb = (h) => { const v = parseInt(h.replace('#', '').slice(0, 6), 16); return [v >> 16 & 255, v >> 8 & 255, v & 255]; };
    // 颜色字符串解析：color-mix 在现代 Chromium 里会算成 `color(srgb 0.83 0.86 0.88)`，
    // 直接按 0-255 读会得到 0.83 这种数（踩过：跨度算成 0.05，断言全错）
    // ⚠ 必须认 hex：getComputedStyle 读自定义属性返回的是 `#f06292` 这种写法，
    //   只抓 [\d.]+ 会把 `#f06292` 抓成单个数字 6292 → 返回空数组 → 与全零比较时
    //   任何深色都"匹配"，断言变成空转（踩过：焦点普查把所有中性容器都算成 accent 实心块，
    //   主题步骤里几个"底色是否中性"的检查也一直空转）。
    const parseColorRgb = (str) => {
      const t = String(str || '').trim();
      if (!t || t === 'none' || t === 'transparent') return [];
      const hx = t.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
      if (hx) {
        let h = hx[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      }
      const nums = (t.match(/[\d.]+/g) || []).map(Number);
      if (nums.length < 3) return [];
      const k = /^color\(/.test(t) ? 255 : 1;
      return nums.slice(0, 3).map((x) => x * k);
    };
    const spreadOf = (str) => { const c = parseColorRgb(str); return c.length === 3 ? Math.max(...c) - Math.min(...c) : -1; };
    const readVar = (k) => getComputedStyle(document.body).getPropertyValue(k).trim();
    const lum = (h) => { const c = hex2rgb(h); return (c[0] + c[1] + c[2]) / 3; };
    const spread = (h) => { const c = hex2rgb(h); return Math.max(...c) - Math.min(...c); };

    const keep = document.body.className;
    document.body.className = keep.replace(/theme-\w+/g, '').trim() + ' theme-crimson';
    await sleep(500);

    const bgVars = ['--bg', '--bg-tabbar', '--bg-panel', '--bg-title'];
    // 深红是"暖调"主题：底色必须带酒红/玫瑰的偏色（与石墨的"中性"正好相反）
    const warm = bgVars.filter((k) => spread(readVar(k)) > 3);
    add('深红主题的底色保留酒红暖调（回退成功，红是环境的一部分）', warm.length === 4,
      bgVars.map((k) => k + '=' + readVar(k)).join(' '));
    add('深红主题正文/标题也保留暖调', spread(readVar('--text')) > 3 && spread(readVar('--text-bright')) > 3,
      '--text=' + readVar('--text') + ' --text-bright=' + readVar('--text-bright'));
    const ac = hex2rgb(readVar('--accent'));
    add('深红强调色是原样的玫瑰粉', ac[0] - ac[1] >= 40, '--accent=' + readVar('--accent'));
    const lv = bgVars.map((k) => lum(readVar(k)));
    add('深红也满足深色主题的单调阶梯（内容 > 标签栏 > 工具窗口 > 外框）',
      lv[0] > lv[1] && lv[1] > lv[2] && lv[2] > lv[3], lv.map((x) => Math.round(x)).join(' > '));

    // Markdown 标题在深红下应当是暖色（不是纯白）
    const realH = q('.cm-md-h1') || q('#viewer .md-view h1');
    if (realH) {
      const rc = getComputedStyle(realH).color;
      const sp = spreadOf(rc);
      const c = parseColorRgb(rc);
      // 暖色 = 红分量高于绿分量（玫瑰/酒红系），既不是纯白也不是默认蓝
      add('深红下的 Markdown 标题是暖色（不是纯白 / 不是默认蓝）',
        sp >= 3 && c.length === 3 && c[0] - c[1] > 0, 'h1=' + rc + ' 跨度=' + Math.round(sp));
    } else {
      add('深红下量到真实的 Markdown 标题', false, '没找到标题元素');
    }
    await sleep(200);
    return { R };
  },

  // ---------- 长行换行：正文列限宽后，长行必须在列内折行（不能横向溢出被切掉） ----------
  // 背景：CM6 **默认不换行**。正文列限到 820px 之后，长段落 / 表格源码 / 长路径
  // 就从列右边溢出被切掉了 —— 用户原话「你调低了框度 但是它没有在这个框度换行」。
  textWrapping: async (dir) => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 8000)) { const v = fn(); if (v) return v; await sleep(120); }
      return null;
    };
    const overflow = (el) => (el ? el.scrollWidth - el.clientWidth : -1);

    async function openIn(mode) {
      window.Viewer.closeAll();
      localStorage.setItem('myide-md-mode', mode);
      await sleep(200);
      await window.Viewer.openFile(dir + '\\_ui_wrap.md');
      await waitFor(() => q('#viewer .cm-content') || q('#viewer .md-view'), 8000);
      await sleep(350);
    }
    async function wrapCheck(mode, label) {
      const sc = q('#viewer .cm-scroller');
      const colW = sc ? Math.round(sc.getBoundingClientRect().width) : -1;
      add(label + '：正文列限宽生效（≤ 876px）', colW > 0 && colW <= 877, '列宽=' + colW);
      add(label + '：长行在列内折行，没有横向溢出', !!sc && overflow(sc) <= 1,
        '溢出=' + overflow(sc) + 'px（scrollWidth=' + (sc ? sc.scrollWidth : -1) + '）');
      const hs = [...document.querySelectorAll('#viewer .cm-line')]
        .map((l) => Math.round(l.getBoundingClientRect().height)).filter((h) => h > 0).sort((a, b) => a - b);
      // 用中位数当"单行高度"：最小值可能是折叠行/空行（实测出现过 2px），会把基准算歪
      const base = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
      const maxH = hs.length ? hs[hs.length - 1] : 0;
      add(label + '：确认有长行被折成了多行（行高 > 单行的 1.8 倍）',
        base > 0 && maxH >= base * 1.8, '单行=' + base + 'px 最高=' + maxH + 'px');
    }

    await openIn('live');
    await wrapCheck('live', 'Live Preview');
    await openIn('source');
    await wrapCheck('source', '源码模式');

    // 静态预览：表格是真实 <table>，允许它自己横向滚动，但不能撑破正文列
    await openIn('preview');
    const mv = q('#viewer .md-view');
    add('静态预览：.md-view 不横向溢出（内容不出列）', !!mv && overflow(mv) <= 1,
      '溢出=' + overflow(mv) + 'px');

    // 「真正的溢出」= 内容从列右边漏出去、且自己不能滚（= 会撑破版心 / 被切掉）。
    // ⚠ 必须排除"自己就在滚动容器里"的（pre / code / 宽表格）：它们的内部溢出是设计如此，
    //   上一版没排除，把 `code.language-python` 那 500px（本来就是横向滚动的代码块）报成了溢出项。
    const inScroller = (el) => {
      for (let n = el.parentElement; n && n !== mv; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
      }
      return false;
    };
    const chain = (el) => {
      const out = [];
      for (let n = el; n && n !== mv && out.length < 4; n = n.parentElement) {
        out.unshift(n.tagName.toLowerCase() +
          (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\s+/)[0] : ''));
      }
      return out.join('>');
    };
    const spill = mv ? [...mv.querySelectorAll('*')]
      .map((e) => ({ el: e, over: e.scrollWidth - e.clientWidth }))
      .filter((x) => x.over > 1 && !inScroller(x.el)) : [];
    add('静态预览：没有任何"漏出列外"的元素（代码块与宽表格在滚动容器里，不计）',
      !!mv && spill.length === 0,
      spill.length ? spill.slice(0, 4).map((x) => chain(x.el) + ' +' + x.over + 'px').join(' | ')
                   : '0 个（代码块/表格内部滚动已排除）');

    // 点名那条长路径：它是这一轮的真凶（\ 不是断行机会点，整段从列右边漏出去）
    const pathP = mv ? [...mv.querySelectorAll('p')].find((p) => /source_timeline_rolling_playback/.test(p.textContent)) : null;
    add('静态预览：无空格的长路径在列内折断（overflow-wrap:anywhere）',
      !!pathP && pathP.scrollWidth <= pathP.clientWidth + 1,
      pathP ? '路径段溢出=' + (pathP.scrollWidth - pathP.clientWidth) + 'px 高=' +
        Math.round(pathP.getBoundingClientRect().height) + 'px 折行设置=' + getComputedStyle(pathP).overflowWrap
        : '没找到那段长路径');

    const tbl = q('#viewer .md-view table');
    add('静态预览：宽表格自己在列内滚动（不是撑破布局）',
      !!tbl && tbl.scrollWidth >= tbl.clientWidth && getComputedStyle(tbl).overflowX === 'auto',
      tbl ? 'overflowX=' + getComputedStyle(tbl).overflowX + ' 表宽=' + Math.round(tbl.getBoundingClientRect().width) : '无表格');
    add('静态预览：长段落折行（段落高度 > 单行）',
      !!mv && [...mv.querySelectorAll('p')].some((p) => p.getBoundingClientRect().height > 34),
      mv ? mv.querySelectorAll('p').length + ' 段' : '无');

    // ⚠ 收尾：**故意不关**这个文档 —— 截图在步骤返回之后才拍，关掉的话产物只剩空状态
    //   （上一版就踩了：check-ui-10-wrap.png 拍到的是一张"最近项目"首页）。
    //   静态预览留在这里，截图能直接看见长段落 / 长路径 / 宽表格都在 820px 列内。
    //   文档的 md 模式复位成 live，避免影响后面步骤（当前已渲染的这个不受影响）。
    localStorage.setItem('myide-md-mode', 'live');
    return { R };
  },

  // ---------- 翻译弹窗：居中 / 原文可自己填 / 未选中文本也能打开 ----------
  // llm:chat 已在主进程打桩（返回 "译:<原文>"），这里验的是弹窗本身的三条交互。
  translateDialog: async (dir) => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    localStorage.setItem('myide-translate-cfg', JSON.stringify({ baseUrl: 'http://stub', model: 'stub', target: '中文' }));

    // ① 未选中文本按快捷键 → 也要弹（原实现只弹 toast 就 return）
    window.Translate.run('');
    await sleep(500);
    const box = q('.tr-box');
    add('未选中文本也能弹出翻译框（不再只弹 toast）', !!box);
    if (!box) return { R };
    const src = q('#tr-src'), dst = q('#tr-dst'), mask = q('#modal-mask');
    add('原文是可编辑的输入框（以前是只读 div）', !!src && src.tagName === 'TEXTAREA',
      src ? src.tagName : '无 #tr-src');
    add('空框进来是空的、且已聚焦（直接打字就能填）', src.value === '' && document.activeElement === src,
      'value=' + JSON.stringify(src.value) + ' focused=' + (document.activeElement === src));
    add('译文区为空态（占位文案，不是上一轮的残留）', dst.textContent === '', JSON.stringify(dst.textContent.slice(0, 20)));

    // ② 居中：根因是 #modal-mask 里遗留过一个 560px 宽的空 #modal-box，把弹窗整体挤偏
    const mR = mask.getBoundingClientRect(), bR = box.getBoundingClientRect();
    const dx = Math.abs((bR.left + bR.right) / 2 - (mR.left + mR.width / 2));
    const dy = Math.abs((bR.top + bR.bottom) / 2 - (mR.top + mR.height / 2));
    add('弹窗在遮罩里水平居中', dx <= 3, '偏差=' + dx.toFixed(1) + 'px');
    add('弹窗在遮罩里垂直居中', dy <= 3, '偏差=' + dy.toFixed(1) + 'px');
    add('遮罩盖满整窗', mR.width >= window.innerWidth - 1 && mR.height >= window.innerHeight - 1,
      Math.round(mR.width) + 'x' + Math.round(mR.height) + ' vs ' + window.innerWidth + 'x' + window.innerHeight);
    add('遮罩里只有弹窗一个子节点（遗留空容器已删）',
      !q('#modal-box') && mask.children.length === 1,
      'children=' + mask.children.length);

    // ③ 自己填文本 → 点「翻译」→ 出结果
    src.value = '页面设置';
    q('#tr-do').click();
    await sleep(700);
    add('手动填的文本能翻译（llm:chat 已打桩）',
      dst.textContent === '译:页面设置', JSON.stringify(dst.textContent.slice(0, 30)));

    // ⑤ 选中文本进来的老路径：预填 + 自动翻译
    window.Translate.run('你好');
    await sleep(800);
    add('带选中文本进来仍会自动翻译', !!q('#tr-dst') && q('#tr-dst').textContent === '译:你好',
      q('#tr-dst') ? q('#tr-dst').textContent.slice(0, 30) : '(无弹窗)');
    add('原文框预填了选中的文本', q('#tr-src').value === '你好', JSON.stringify(q('#tr-src').value));

    // 收尾：留一个"填了原文、翻出译文"的状态给截图（截图在步骤结束后才拍，
    // 这里关掉的话产物就只剩背景了 —— 060 那轮踩过同样的坑）
    window.Translate.run('页面设置');
    await sleep(800);
    add('收尾：弹窗留在打开状态（截图用）',
      !!q('.tr-box') && q('#tr-src').value === '页面设置' && q('#tr-dst').textContent === '译:页面设置',
      '原文=' + JSON.stringify(q('#tr-src').value) + ' 译文=' + JSON.stringify(q('#tr-dst').textContent.slice(0, 20)));
    return { R };
  },

  // ---------- 翻译弹窗（关闭）：Esc 与 ✕ 都能收 ----------
  translateDialogClose: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    add('上一步留下的弹窗还在', !!q('.tr-box'));

    // Esc（焦点在原文框里也要能关 —— 自管 Esc）
    const src = q('#tr-src');
    if (src) src.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    add('Esc 关闭翻译框（焦点在输入框里也一样）', !q('.tr-box'));
    add('遮罩随之隐藏', q('#modal-mask').classList.contains('hidden'));

    // ✕ 也能关
    window.Translate.run('再开一次');
    await sleep(500);
    if (q('#tr-x')) q('#tr-x').click();
    await sleep(300);
    add('右上角 ✕ 也能关闭', !q('.tr-box'));
    return { R };
  },

  // ---------- 同屏「强焦点」普查：强调色同时用在多少个地方喊 ----------
  // 「乱」= 元素密度 × 区域明度差。密度这一半里最刺眼的是「同屏有几个东西在用 accent 喊」。
  // 判定口径：实心 accent 填充（α≥.5 且面积 ≥150px²）/ ≥2px 的 accent 边或伪元素条 /
  // 大号粗体 accent 文字（≥13px 且 weight≥600）。半透明 tint、1px 边框、普通正文里的 accent 只算「弱」。
  // 浮层（菜单 / 弹窗 / 空状态）不算「同屏」。
  focusCensus: async () => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // —— 进入「典型工作状态」：项目工具窗口 + 打开一篇 md + AI 面板打开 ——
    window.App.showTool('project');
    await sleep(400);
    const mdRow = qa('#tree .tree-row').find((r) => /\.md$/.test(r.dataset.path || '') && !r.querySelector('.nm-dir'));
    if (mdRow) { mdRow.click(); await sleep(900); }
    window.App.setAiOpen(true);
    await sleep(900);
    // 清掉前面步骤留下的残留（历史消息 / 待确认浮层）—— 普查要量「干净基线」，
    // 否则量到的是"跑了一半的调试状态"，数字不可复现。
    const noBtn = q('#cr-no') || q('#dw-no');
    if (noBtn) { noBtn.click(); await sleep(400); }
    const newBtn = q('#ai-new');
    if (newBtn) { newBtn.click(); await sleep(700); }
    add('基线干净：AI 面板无历史消息、无待确认浮层',
      !q('.ai-confirm') && !q('#ai-msgs .ai-tool'),
      '确认浮层=' + !!q('.ai-confirm') + ' 工具行=' + qa('#ai-msgs .ai-tool').length);

    // 带 alpha 的颜色解析（hex / rgb() / rgba() / color(srgb …) 都认）
    const pc = (str) => {
      const t = String(str || '').trim();
      if (!t || t === 'none' || t === 'transparent') return [0, 0, 0, 0];
      const hx = t.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
      if (hx) {
        let h = hx[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
      }
      const nums = (t.match(/[\d.]+/g) || []).map(Number);
      if (nums.length < 3) return [0, 0, 0, 0];
      const k = /^color\(/.test(t) ? 255 : 1;
      return [nums[0] * k, nums[1] * k, nums[2] * k, nums.length >= 4 ? nums[3] : 1];
    };
    const A = pc(getComputedStyle(document.body).getPropertyValue('--accent'));
    if (A[3] === 0) { add('诊断：accent 变量读到了', false, '--accent 解析失败=' + getComputedStyle(document.body).getPropertyValue('--accent')); return { R }; }
    const isAcc = (str, minA) => {
      const c = pc(str);
      if (c[3] < minA) return false;
      return Math.max(Math.abs(c[0] - A[0]), Math.abs(c[1] - A[1]), Math.abs(c[2] - A[2])) <= 42;
    };

    // 区域：越具体越靠前（#main 包着 sidebar / tabbar / viewer）
    const RG = ['#ai-panel', '#sidebar', '#tabbar', '#statusbar', '#tool-strip', '#toolbar', '#viewer'];
    const regions = RG.map((sel) => ({ sel, el: q(sel) })).filter((r) => r.el && r.el.getBoundingClientRect().width > 0);
    const regionOf = (el) => { for (const r of regions) if (r.el.contains(el)) return r.sel; return null; };
    const OVERLAY = ['#ctx-menu', '#modal-mask', '.ai-at-pop', '.ai-confirm', '#empty-state', '#settings', '#help', '#search-overlay'];
    const inOverlay = (el) => OVERLAY.some((s) => { const o = q(s); return !!o && o.contains(el); });

    const strong = [];
    const weakList = [];
    const counted = [];   // 已计入的「载体」：它的后代不再重复计数（继承来的 color 不算新的一处）
    const desc = (el) => (el.id ? '#' + el.id : '') +
      (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');

    for (const el of document.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4 || rect.bottom < 0 || rect.right < 0) continue;
      if (inOverlay(el)) continue;
      const region = regionOf(el);
      if (!region) continue;
      if (counted.some((c) => c !== el && c.contains(el))) continue;   // 继承来的，不算新的一处
      const cs = getComputedStyle(el);
      let hit = null;
      if (isAcc(cs.backgroundColor, 0.5) && rect.width * rect.height >= 150) {
        hit = { kind: '实心填充', detail: Math.round(rect.width) + '×' + Math.round(rect.height) };
      }
      if (!hit) {
        const sides = [['borderLeftWidth', 'borderLeftColor', rect.height],
                       ['borderRightWidth', 'borderRightColor', rect.height],
                       ['borderTopWidth', 'borderTopColor', rect.width],
                       ['borderBottomWidth', 'borderBottomColor', rect.width]];
        for (const [wp, cp, len] of sides) {
          if (parseFloat(cs[wp]) >= 2 && len >= 12 && isAcc(cs[cp], 0.5)) {
            hit = { kind: '强调边', detail: wp.replace('border', '').replace('Width', '') + ' ' + cs[wp] };
            break;
          }
        }
      }
      if (!hit) {
        for (const psel of ['::before', '::after']) {
          const p = getComputedStyle(el, psel);
          if (!p || p.content === 'none' || p.display === 'none') continue;
          const pw = parseFloat(p.width), ph = parseFloat(p.height);
          if ((pw >= 0 && pw <= 5 && ph >= 12) || (ph >= 0 && ph <= 5 && pw >= 12)) {
            if (isAcc(p.backgroundColor, 0.5)) { hit = { kind: '伪元素条', detail: psel + ' ' + Math.round(pw) + '×' + Math.round(ph) }; break; }
          }
        }
      }
      // 盲区①：`box-shadow: inset 2px 0 0 accent`（树行 focus / 弹窗选中项都是这么写的）
      // —— 只查 border 会看不见它
      if (!hit && cs.boxShadow && cs.boxShadow !== 'none' && /inset/.test(cs.boxShadow)) {
        const off = (cs.boxShadow.match(/-?[\d.]+px/g) || []).map((x) => Math.abs(parseFloat(x)));
        const col = cs.boxShadow.replace(/inset/g, '').replace(/-?[\d.]+px/g, '').trim();
        if (off.some((x) => x >= 2) && isAcc(col, 0.5)) hit = { kind: '强调阴影', detail: cs.boxShadow.slice(0, 44) };
      }
      // 盲区②：图标按钮的强调色在 `color`（SVG 用 currentColor），且它**有子节点**
      // —— 「只查无子节点的文字」会漏掉所有强调图标按钮
      if (!hit && !(el.textContent || '').trim() && el.querySelector && el.querySelector('svg')
          && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && isAcc(cs.color, 0.85)) {
        hit = { kind: '强调图标', detail: Math.round(rect.width) + '×' + Math.round(rect.height) };
      }
      if (!hit && el.children.length === 0 && (el.textContent || '').trim() && isAcc(cs.color, 0.85)
          && parseInt(cs.fontWeight, 10) >= 600 && parseFloat(cs.fontSize) >= 13) {
        hit = { kind: '强调文字', detail: parseFloat(cs.fontSize) + 'px/' + cs.fontWeight + ' ' + (el.textContent || '').trim().slice(0, 12) };
      }
      if (hit) { strong.push({ region, sel: desc(el), kind: hit.kind, detail: hit.detail }); counted.push(el); }
      else if (isAcc(cs.backgroundColor, 0.05) || isAcc(cs.color, 0.5)) { weakList.push({ region, sel: desc(el) }); counted.push(el); }
    }

    const weak = weakList.length;
    const byRegion = {};
    for (const s of strong) byRegion[s.region] = (byRegion[s.region] || 0) + 1;
    const brief = Object.entries(byRegion).map(([k, v]) => k.replace('#', '') + '×' + v).join('  ');

    // —— 候选元素实测（验证检测器没瞎：这些是"最可能被当成焦点"的地方）——
    const CAND = ['#ai-send', '#ai-perm', '#ai-model', '.ai-ctx-chip.follow', '.ai-ctx-chip.pinned',
                  '.ai-ctx-x', '.proj-btn.active', '.proj-all', '.tab.active', '.tab-all', '.tab-locate',
                  '.tool-btn.active', '.tree-row.selected', '.outline-item.key-nav-sel',
                  '.sb-font button', '.panel-title', '.ai-head', '#ai-stop'];
    const cand = [];
    for (const sel of CAND) {
      const el = q(sel);
      if (!el) { cand.push(sel + '=无'); continue; }
      const cs = getComputedStyle(el);
      const pre = getComputedStyle(el, '::before');
      const bit = (str, minA) => (pc(str)[3] >= minA && Math.max(Math.abs(pc(str)[0] - A[0]), Math.abs(pc(str)[1] - A[1]), Math.abs(pc(str)[2] - A[2])) <= 42 ? '●' : '·');
      cand.push(sel + ' bg' + bit(cs.backgroundColor, 0.5) + ' tx' + bit(cs.color, 0.85)
        + ' bl' + bit(cs.borderLeftColor, 0.5) + ' bt' + bit(cs.borderTopColor, 0.5)
        + (pre.content !== 'none' ? ' pre' + bit(pre.backgroundColor, 0.5) : ''));
    }
    add('诊断：候选元素 accent 命中（●=算强焦点 ·=不算）', true, cand.join(' ').slice(0, 1400));

    add('诊断：同屏 accent 强焦点总数', true,
      '强=' + strong.length + '  弱(仅提示)=' + weak + '  [' + (brief || '无') + ']');
    add('诊断：弱用清单（只做提示、不算焦点）', true,
      weakList.map((s) => s.region.replace('#', '') + '|' + s.sel).join(' ; ').slice(0, 1100));
    add('诊断：强焦点清单', true,
      strong.map((s) => s.region.replace('#', '') + '|' + s.kind + '|' + s.sel + '|' + s.detail).join(' ; ').slice(0, 1100));

    // —— 正式守卫：这轮普查定下来的规则 ——
    // ① 每个区域最多 1 个 accent 强焦点（一个区域里只有一个"当前项"才是对的）
    const over = Object.entries(byRegion).filter(([, v]) => v > 1);
    add('每个区域最多 1 个 accent 强焦点（一个区域只该有一个"当前项"）', over.length === 0,
      over.length ? '超标：' + over.map(([k, v]) => k + '×' + v).join(' ') : (brief || '无强焦点'));
    // ② 同屏总数上限：3 个区域各 1 个 = 3，留 1 个余量给"帮助 / 搜索"这类临时态
    add('同屏 accent 强焦点总数 ≤ 4', strong.length <= 4, '强=' + strong.length + ' [' + (brief || '无') + ']');
    // ③ 弱用（半透明 tint / 1px 边 / 普通 accent 文字）也不能失控 —— 它们加起来会重新变成"处处都在喊"
    // 弱用按「载体」计数（继承来的不算新的一处），阈值留了余量 ——
    // 它是「强调色有没有在当环境光用」的粗筛，不该卡在临界值上造成假警报。
    const weakBy = weakList.reduce((a, s2) => (a[s2.region] = (a[s2.region] || 0) + 1, a), {});
    add('accent 的弱用（载体数）不超过 10 处', weak <= 10, '弱=' + weak + '  [' +
      Object.entries(weakBy).map(([k, v]) => k.replace('#', '') + 'x' + v).join('  ') + ']');

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
    // 编辑器操作区挂在标签栏右端：图片这类文件只剩「定位」，不该有视图按钮
    add('图片文件在标签栏右端没有多余视图按钮（只剩「定位」）', !q('#tab-actions .vt-btn'),
      q('#tab-actions .vt-btn') ? '仍有视图按钮' : '无 ✓');
    add('标签页左侧有文件类型图标（SVG，不是 emoji）', !!q('.tab.active .tic svg'));
    add('标签栏右端「在资源管理器显示」只有 1 个', document.querySelectorAll('.tab-locate').length === 1,
      document.querySelectorAll('.tab-locate').length + ' 个');
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
    // 颜色解析：兼容 rgb()/rgba() 与 color-mix 算出来的 color(srgb r g b / a)
    const parseC = (str) => {
      if (!str) return null;
      const v = (str.match(/[\d.]+/g) || []).map(Number);
      if (v.length < 3) return null;
      return /^color\(/.test(str)
        ? { r: v[0] * 255, g: v[1] * 255, b: v[2] * 255, a: v.length > 3 ? v[3] : 1 }
        : { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 };
    };
    const lum = (c) => (c ? (c.r + c.g + c.b) / 3 : -1);
    const pageBgLum = () => lum(parseC(getComputedStyle(document.body).backgroundColor));

    // ---- 纯视觉：正文列"收窄 + 居中"、流程图"独立成块" ----
    // 要看出"列宽上限"需要一块足够宽的编辑区：临时收起 AI 助手，量完原样还原
    const aiEl = q('#ai-panel');
    const aiWas = !!aiEl && !aiEl.classList.contains('hidden');
    if (aiWas) { window.App.setAiOpen(false); await sleep(800); }
    {
      const mv = q('#viewer > .md-view') || q('.md-view');
      const ed = q('#viewer');
      const mvR = mv.getBoundingClientRect(), edR = ed.getBoundingClientRect();
      const lGap = Math.round(mvR.left - edR.left), rGap = Math.round(edR.right - mvR.right);
      add('正文列有可读宽度上限（<= 860px，不再满宽铺开）', mvR.width <= 860,
        '列宽=' + Math.round(mvR.width) + ' 编辑区=' + Math.round(edR.width));
      add('编辑区变宽时列宽被上限托住（不是跟着内容缩水）',
        edR.width <= 860 || mvR.width >= 700,
        '编辑区=' + Math.round(edR.width) + ' 列宽=' + Math.round(mvR.width));
      add('正文列在编辑区里居中（左右留白对称）', Math.abs(lGap - rGap) <= 2, '左=' + lGap + ' 右=' + rGap);
      add('正文两侧留白足够（呼吸区，不贴边）',
        edR.width <= 860 || Math.min(lGap, rGap) >= 60, '左=' + lGap + ' 右=' + rGap);
      const bR = box.getBoundingClientRect();
      add('流程图块不超出正文列（不再铺满整宽 / 贴窗口边）',
        bR.left >= mvR.left - 1 && bR.right <= mvR.right + 1,
        '块=' + Math.round(bR.left) + '~' + Math.round(bR.right) + ' 列=' + Math.round(mvR.left) + '~' + Math.round(mvR.right));
      const boxLum = lum(parseC(getComputedStyle(box).backgroundColor));
      add('流程图底色贴近正文（不是页面中间的大黑块）',
        boxLum >= 0 && Math.abs(boxLum - pageBgLum()) <= 12,
        '图=' + Math.round(boxLum) + ' 正文=' + Math.round(pageBgLum()));
    }
    if (aiWas) { window.App.setAiOpen(true); await sleep(700); }

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
    // 颜色解析：兼容 rgb()/rgba() 与 color-mix 算出来的 color(srgb r g b / a)
    const parseC = (str) => {
      if (!str) return null;
      const v = (str.match(/[\d.]+/g) || []).map(Number);
      if (v.length < 3) return null;
      return /^color\(/.test(str)
        ? { r: v[0] * 255, g: v[1] * 255, b: v[2] * 255, a: v.length > 3 ? v[3] : 1 }
        : { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 };
    };
    const lum = (c) => (c ? (c.r + c.g + c.b) / 3 : -1);
    const pageBgLum = () => lum(parseC(getComputedStyle(document.body).backgroundColor));

    // ---- 纯视觉：正文列"收窄 + 居中"、流程图"独立成块" ----
    // 要看出"列宽上限"需要一块足够宽的编辑区：临时收起 AI 助手，量完原样还原
    const aiEl = q('#ai-panel');
    const aiWas = !!aiEl && !aiEl.classList.contains('hidden');
    if (aiWas) { window.App.setAiOpen(false); await sleep(800); }
    {
      const mv = q('.editor-cm-wrap .cm-content');
      const ed = q('#viewer');
      const mvR = mv.getBoundingClientRect(), edR = ed.getBoundingClientRect();
      const lGap = Math.round(mvR.left - edR.left), rGap = Math.round(edR.right - mvR.right);
      add('Live Preview 正文列有可读宽度上限（<= 860px，不再满宽铺开）', mvR.width <= 860,
        '列宽=' + Math.round(mvR.width) + ' 编辑区=' + Math.round(edR.width));
      add('Live Preview 编辑区变宽时列宽被上限托住（不是跟着内容缩水）',
        edR.width <= 860 || mvR.width >= 700,
        '编辑区=' + Math.round(edR.width) + ' 列宽=' + Math.round(mvR.width));
      add('Live Preview 正文列在编辑区里居中（左右留白对称）', Math.abs(lGap - rGap) <= 2, '左=' + lGap + ' 右=' + rGap);
      add('Live Preview 正文两侧留白足够（呼吸区，不贴边）',
        edR.width <= 860 || Math.min(lGap, rGap) >= 60, '左=' + lGap + ' 右=' + rGap);
      const bR = box.getBoundingClientRect();
      add('Live Preview 流程图块不超出正文列（不再铺满整宽 / 贴窗口边）',
        bR.left >= mvR.left - 1 && bR.right <= mvR.right + 1,
        '块=' + Math.round(bR.left) + '~' + Math.round(bR.right) + ' 列=' + Math.round(mvR.left) + '~' + Math.round(mvR.right));
      const boxLum = lum(parseC(getComputedStyle(box, '::before').backgroundColor));
      add('Live Preview 流程图底色贴近正文（不是页面中间的大黑块）',
        boxLum >= 0 && Math.abs(boxLum - pageBgLum()) <= 12,
        '图=' + Math.round(boxLum) + ' 正文=' + Math.round(pageBgLum()));
    }
    if (aiWas) { window.App.setAiOpen(true); await sleep(700); }

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
    add('顶栏 6 个按钮全为 SVG 且无文字（含访问权限）',
      tb.length === 6 && tb.every((b) => b.querySelector('svg') && !b.textContent.trim()),
      tb.map((b) => String(b.title).split('（')[0]).join(' | '));

    const ph = q('#ai-input').placeholder;
    add('placeholder 已中文化', !/Ask anything/.test(ph) && /整理/.test(ph), ph);
    // 回形针按钮已移除：它的作用（附当前文件）与「跟随当前文件」+ @ 引用完全重叠
    add('输入区不再有功能重复的回形针按钮', !q('#ai-file-chip'));
    // 底部尺寸一致性。核心是：**输入框和发送按钮不再是两个并排的框**，
    // 而是同一个卡片（.ai-input-box）里的 textarea + 按钮 —— 结构上就没有"高度对比"这回事。
    const hv = (sel) => { const e = q(sel); return e ? Math.round(e.getBoundingClientRect().height) : -1; };
    const radiusOf = (sel) => getComputedStyle(q(sel)).borderRadius;
    const chipH = hv('#ai-chips .ai-ctx-chip');
    // 清空必须派发 input 事件：输入框高度由 autoGrow 在 input 时算出来，直接赋 value 不会重算
    const setVal0 = q('#ai-input');
    setVal0.value = '';
    setVal0.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    add('输入框与发送按钮在同一个卡片里（不再是两个框比高度）',
      !!q('.ai-input-box') && !!q('.ai-input-box #ai-send') && !!q('.ai-input-box #ai-input'));
    add('空输入时输入卡片高 40px（= 1 行文字 + 上下内边距）', hv('.ai-input-box') === 40,
      '卡片=' + hv('.ai-input-box') + ' 输入框=' + hv('#ai-input') + ' 按钮=' + hv('#ai-send'));
    add('卡片与发送按钮圆角统一 8px', radiusOf('.ai-input-box') === '8px' && radiusOf('#ai-send') === '8px',
      '卡片=' + radiusOf('.ai-input-box') + ' 按钮=' + radiusOf('#ai-send'));
    const bb = q('.ai-input-box').getBoundingClientRect();
    const sb2 = q('#ai-send').getBoundingClientRect();
    const rb = bb.right - sb2.right, btm = bb.bottom - sb2.bottom;
    add('发送按钮贴卡片内右下角（右边距 = 下边距）', Math.abs(rb - btm) <= 1,
      '右=' + rb.toFixed(1) + ' 下=' + btm.toFixed(1));
    // 多行输入：卡片长高，按钮仍在框内右下 —— 不再出现"输入框 57 / 按钮 38"那种落差
    const setVal = (v) => {
      const el = q('#ai-input');
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal('第一行\n第二行\n第三行');
    await sleep(350);
    const boxH = hv('.ai-input-box');
    const btnIn = q('.ai-input-box #ai-send').getBoundingClientRect();
    const boxR = q('.ai-input-box').getBoundingClientRect();
    add('多行输入时卡片长高、按钮仍在卡片内（不会掉到框外）',
      boxH > 40 && btnIn.bottom <= boxR.bottom + 0.5 && btnIn.top >= boxR.top - 0.5,
      '卡片=' + boxH + ' 按钮 ' + Math.round(btnIn.top - boxR.top) + '~' + Math.round(btnIn.bottom - boxR.top) + 'px');
    setVal('');
    await sleep(200);
    if (chipH > 0) {
      const chip0 = q('#ai-chips .ai-ctx-chip');
      const cr = chip0.getBoundingClientRect();
      const svg = chip0.querySelector('svg.ic');
      if (svg) {
        const sr = svg.getBoundingClientRect();
        const d = Math.abs((sr.top + sr.height / 2) - (cr.top + cr.height / 2));
        add('chip 里图标与文字垂直居中（中心偏差 ≤ 1px）', d <= 1,
          '偏差=' + d.toFixed(1) + 'px（图标 ' + Math.round(sr.height) + 'px / chip ' + Math.round(cr.height) + 'px）');
      }
    }
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
      add('长指令填进去后输入框自动增高（不被 1 行的框裁掉）',
        q('#ai-input').getBoundingClientRect().height > 28,
        '输入框高=' + Math.round(q('#ai-input').getBoundingClientRect().height) + 'px');
      // 当前文件是 chips 里那条「跟随」项（.follow），也可能是手动 @ 附加的
      const chips = qa('.ai-ctx-chip');
      const viaFollow = chips.some((c) => c.classList.contains('follow') && /_ui_outline/.test(c.textContent));
      const viaChip = chips.some((c) => /_ui_outline/.test(c.textContent));
      add('整理类指令一定带上了当前文件（跟随或手动附都算）', viaFollow || viaChip,
        '跟随 chip=' + (viaFollow ? '有' : '无') + ' / chips=' + (chips.map((c) => c.textContent).join(' | ') || '(无)'));
    }
    // 三栏比例：编辑区必须是主角。原来是"左中右三块平分存在感"——
    // 左 440 + 右 460 把中央挤到 52%，用户的原话是"PyCharm 中间大、周围退，你的是三块平分"。
    const LO = window.App.LAYOUT;
    const sbW = Math.round(q('#sidebar').getBoundingClientRect().width);
    const aiW = Math.round(panel.getBoundingClientRect().width);
    const edW = Math.round(q('#tabbar').getBoundingClientRect().width);
    add('编辑区是三栏里最宽的一块', edW > sbW && edW > aiW, '编辑=' + edW + ' 侧栏=' + sbW + ' AI=' + aiW);
    add('编辑区 ≥ 两侧各自 1.3 倍（不再"三块平分存在感"）',
      edW >= sbW * 1.3 && edW >= aiW * 1.3,
      '编辑/侧栏=' + (edW / sbW).toFixed(2) + ' 编辑/AI=' + (edW / aiW).toFixed(2));
    add('两侧都在钳制范围内', sbW >= LO.sidebar.min && sbW <= LO.sidebar.max && aiW >= LO.ai.min && aiW <= LO.ai.max,
      '侧栏=' + sbW + '(' + LO.sidebar.min + '~' + LO.sidebar.max + ') AI=' + aiW + '(' + LO.ai.min + '~' + LO.ai.max + ')');

    // 三处面板标题行等高（侧栏 / 标签栏 / AI 助手）—— 交界处的横向底线必须对齐
    const hh = (sel) => { const e = q(sel); return e ? Math.round(e.getBoundingClientRect().height) : -1; };
    const vt = qa('#sidebar .panel-title').find((e) => e.getBoundingClientRect().height > 0);
    const h3 = [hh('#tabbar'), vt ? Math.round(vt.getBoundingClientRect().height) : -1, hh('.ai-head')];
    add('侧栏标题 / 标签栏 / AI 助手标题 三行等高', h3.every((x) => x > 0) && new Set(h3).size === 1, h3.join(' / '));

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
    const fb = q('.ai-ctx-chip.follow');
    add('打开文档后，面板自己把当前文件放进上下文（不用手动附）',
      !!fb && fb.textContent.includes(FILE),
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

  // ---------- 拖文件进面板 + 授权记忆（都在解决「少点几下」）----------
  aiDropAndPerm: async (dir) => {
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
    const mkDt = (types, get) => ({ types, getData: get, files: [], dropEffect: '', setData() {}, clearData() {} });
    const mkEv = (type, dt) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: dt });
      return e;
    };

    window.AiPanel.setConfig({ baseUrl: 'http://stub.local/v1', model: 'stub', apiKey: 'x', permWrite: 'confirm' });
    window.App.setAiOpen(true);
    await sleep(400);
    if (q('#ai-new')) { q('#ai-new').click(); await sleep(300); }

    // —— ① 把文件拖到面板上 ——
    const dropPath = dir + '\\_ui_drop.md';
    await window.myIDE.fs.writeFile(dropPath, '# 拖拽测试\n第一行\n');
    const panel = q('#ai-panel');
    panel.dispatchEvent(mkEv('dragover', mkDt(['text/myide-path'], () => '')));
    await sleep(250);
    add('拖到面板上时整块高亮（不让人猜松手会怎样）', panel.classList.contains('drop-active'),
      panel.classList.contains('drop-active') ? '已高亮' : '没反应');
    panel.dispatchEvent(mkEv('drop', mkDt(['text/myide-path'], (k) => (k === 'text/myide-path' ? dropPath : ''))));
    await waitFor(() => qa('#ai-chips .ai-ctx-chip').some((c) => c.textContent.indexOf('_ui_drop') >= 0), 8000);
    const chips = qa('#ai-chips .ai-ctx-chip');
    add('松手之后文件进了上下文', chips.some((c) => c.textContent.indexOf('_ui_drop') >= 0),
      chips.map((c) => String(c.textContent).replace(/\s+/g, ' ')).join(' | ') || '(没有 chip)');

    // —— ② 第一次改文件：选「本项目内都允许」——
    if (q('#ai-new')) { q('#ai-new').click(); await sleep(300); }
    q('#ai-input').value = '第一次改这个文件';
    q('#ai-send').click();
    const always = await waitFor(() => q('#dw-always'), 25000);
    add('改文件前的确认弹窗，多了一个「本项目内都允许」的出口', !!always,
      always ? String(always.textContent).trim() : '没看到这个按钮');
    if (always) always.click();
    const c1 = await waitFor(() => qa('#ai-msgs .ai-edit').pop(), 25000);
    add('第一次改完，出现改动卡片', !!c1, c1 ? String(c1.textContent).replace(/\s+/g, ' ').slice(0, 36) : '(没有)');

    // —— ③ 第二次改同一个文件：不该再问 ——
    q('#ai-input').value = '第二次改这个文件';
    q('#ai-send').click();
    const c2 = await waitFor(() => (qa('#ai-msgs .ai-edit').length >= 2 ? true : null), 25000);
    add('记住授权后，第二次改文件不再弹确认，直接改完', !!c2 && !q('#dw-always'),
      c2 ? '改动卡片共 ' + qa('#ai-msgs .ai-edit').length + ' 张' : '第二张卡片没出现');
    return { R };
  },
  // ---------- AI 助手：能力对齐（@ 特殊来源 / 斜杠命令 / 历史会话 / 代码块插入 / 危险命令闸）----------
  aiParityUi: async (dir) => {
    const R = [];
    const add = (n, ok, d) => R.push({ name: n, ok: !!ok, detail: d == null ? '' : String(d) });
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const chipTx = () => qa('#ai-chips .ai-ctx-chip').map((c) => c.textContent).join(',');
    const tidy = (el) => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
    const lastReply = () => {
      const rows = qa('#ai-msgs .ai-msg.ai-assistant');
      return rows.length ? String(rows[rows.length - 1].textContent).replace(/\s+/g, ' ').slice(0, 50) : '(无回复)';
    };
    // 本步骤自带配置（前面的步骤把 permRun 设成了 deny，会掩盖危险命令闸）
    window.AiPanel.setConfig({ baseUrl: 'http://stub.local/v1', model: 'stub', apiKey: 'x', permWrite: 'confirm', permRun: 'confirm', allowPaths: [], denyCmds: [] });
    if (window.App && App.showAi) App.showAi();
    await sleep(400);
    await window.Viewer.openFile(dir + '\\_ui_outline.md');
    await sleep(600);
    q('#ai-new').click();            // 干净起点：清空对话与临时上下文
    await sleep(400);
    try { window.Viewer.cm.setCursor(0, 8); } catch {}   // 选中一段，供「@当前选区」使用
    await sleep(300);
    const inp = q('#ai-input');
    const type = (v) => {
      inp.value = v;
      try { inp.setSelectionRange(v.length, v.length); } catch {}
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const ask = async (text, waitMs) => {
      type(text);
      await sleep(200);
      q('#ai-send').click();
      await sleep(waitMs || 1800);
    };
    // ① @ 菜单：特殊来源排最前
    type('@');
    await sleep(500);
    let items = qa('.ai-at-pop .ai-at-item').map((x) => x.textContent);
    add('@ 菜单有 4 个特殊来源（选区 / 标签页 / Git 变更 / 剪贴板）',
      ['当前选区', '标签页', 'Git 变更', '剪贴板'].every((k) => items.some((t) => t.includes(k))),
      items.slice(0, 5).join(' | '));
    const selItem = qa('.ai-at-pop .ai-at-item').find((x) => x.textContent.includes('当前选区'));
    if (selItem) { selItem.click(); await sleep(500); }
    add('点「当前选区」进上下文（且不往输入框插 @token）',
      chipTx().includes('当前选区') && inp.value === '', 'chips=' + chipTx() + ' input=' + JSON.stringify(inp.value));
    // ② Git 变更
    type('@Git');
    await sleep(400);
    const gi = qa('.ai-at-pop .ai-at-item').find((x) => x.textContent.includes('Git'));
    if (gi) { gi.click(); await sleep(2000); }
    add('「Git 变更」把未提交改动带进来', chipTx().includes('Git 变更'), 'chips=' + chipTx());
    // ③ 上下文预算明细
    q('#ai-usage').click();
    await sleep(400);
    const bd = qa('#modal-mask .ai-bd-row');
    add('点用量条 → 列出每条上下文占多少', bd.length >= 2,
      bd.length + ' 行：' + bd.slice(0, 3).map((x) => x.textContent.replace(/\s+/g, ' ').slice(0, 24)).join(' / '));
    add('有占比条（一眼看出谁占地方）', qa('#modal-mask .ai-bd-bar').length >= 2);
    if (q('#cb-x')) { q('#cb-x').click(); await sleep(300); }
    // ④ 固定：跨新对话保留
    const selChip = qa('#ai-chips .ai-ctx-chip').find((c) => c.textContent.includes('当前选区'));
    add('上下文 chip 上有固定按钮', !!selChip && !!selChip.querySelector('.ai-ctx-pin'));
    if (selChip) {
      selChip.querySelector('.ai-ctx-pin').click();
      await sleep(250);
      add('固定后 chip 标为 pinned', !!qa('#ai-chips .ai-ctx-chip').find((c) => c.textContent.includes('当前选区') && c.classList.contains('pinned')));
      const before = chipTx();
      q('#ai-new').click();
      await sleep(450);
      add('固定的上下文在新对话里保留、未固定的被清掉',
        chipTx().includes('当前选区') && !chipTx().includes('Git 变更'),
        before + '  →  ' + chipTx());
      if (chipTx().includes('当前选区')) {
        qa('#ai-chips .ai-ctx-chip').find((c) => c.textContent.includes('当前选区')).querySelector('.ai-ctx-x').click();
        await sleep(250);
      }
    }
    // ⑤ 斜杠命令
    type('/');
    await sleep(500);
    items = qa('.ai-at-pop .ai-at-item').map((x) => x.textContent);
    add('打 / 弹出命令菜单', items.length >= 8, items.length + ' 条：' + items.slice(0, 3).join(' | '));
    add('命令里有内容整理类动作（精简 / 统一术语）', items.some((t) => t.includes('精简')) && items.some((t) => t.includes('统一术语')));
    add('命令里有动作类（生成提交信息 / yolo）', items.some((t) => t.includes('生成提交信息')) && items.some((t) => t.includes('yolo')));
    type('/yolo');
    await sleep(400);
    const yolo = qa('.ai-at-pop .ai-at-item').find((x) => x.textContent.includes('yolo'));
    if (yolo) { yolo.click(); await sleep(300); }
    add('/yolo 选完就把本次对话放行', !!(window.AiPanel && AiPanel.sessionPerm && AiPanel.sessionPerm.write),
      JSON.stringify(window.AiPanel ? AiPanel.sessionPerm : {}));
    // ⑥ 历史会话
    add('顶栏有「历史会话」按钮', !!q('#ai-history'));
    q('#ai-history').click();
    await sleep(350);
    add('历史下拉能打开', !!q('.ai-hist-pop'),
      q('.ai-hist-pop') ? q('.ai-hist-pop').textContent.replace(/\s+/g, ' ').slice(0, 46) : '');
    if (q('#ai-history')) { q('#ai-history').click(); await sleep(250); }
    add('输入区有贴图缩略图容器（贴图直接进下一条消息）', !!q('#ai-images'));
    // ⑦ 代码块 → 插入编辑器
    const docLen = () => { try { const v = window.Viewer.cm && window.Viewer.cm.view; return v ? v.state.doc.length : -1; } catch (e) { return -1; } };
    const before = docLen();
    await ask('给我一段代码', 2400);
    const acts = qa('#ai-msgs .ai-code-acts');
    add('回复里的代码块挂了「复制 / 插入到编辑器」',
      acts.length >= 1 && acts[0].querySelectorAll('button').length === 2,
      acts.length + ' 个代码块 · 末条回复=' + lastReply());
    if (acts.length) {
      const btn = [...acts[0].querySelectorAll('button')].find((b) => b.textContent.includes('插入'));
      if (btn) { btn.click(); await sleep(700); }
    }
    add('点「插入到编辑器」后编辑器内容真的变长', docLen() > before, before + ' → ' + docLen());
    // ⑧ 危险命令闸：/yolo 已放行，rm 仍要问且不给「总是允许」
    add('内置危险命令判定为 danger（不受 /yolo 影响）',
      window.AiPanel && AiPanel.runNeedsConfirm && AiPanel.runNeedsConfirm('rm -rf node_modules') === 'danger',
      window.AiPanel && AiPanel.runNeedsConfirm ? String(AiPanel.runNeedsConfirm('rm -rf node_modules')) : 'n/a');
    // 路径白名单：只放行你点头过的目录，其余照问。
    // 注意先把 /yolo 的效果摘掉再验，否则测到的是 sessionPerm 而不是白名单。
    const saveW = AiPanel.sessionPerm.write;
    const savePerms = AiPanel.loadPerms();
    AiPanel.sessionPerm.write = false;
    AiPanel.savePerms({});                       // 前面的步骤可能点过「本项目内都允许」，先清掉
    AiPanel.setConfig({ allowPaths: ['docs/**'] });
    add('写入白名单：docs/** 放行、其他路径仍要问',
      AiPanel.writeNeedsConfirm('docs/a.md') === 'no' && AiPanel.writeNeedsConfirm('src/a.js') === 'yes',
      'docs/a.md=' + AiPanel.writeNeedsConfirm('docs/a.md') + ' · src/a.js=' + AiPanel.writeNeedsConfirm('src/a.js'));
    AiPanel.setConfig({ allowPaths: [] });
    AiPanel.sessionPerm.write = saveW;
    AiPanel.savePerms(savePerms || {});
    await ask('危险命令', 2400);
    const lastUser = (() => { const rs = qa('#ai-msgs .ai-msg.ai-user'); return rs.length ? String(rs[rs.length - 1].textContent).slice(-16) : '(无)'; })();
    add('危险命令仍然弹确认（/yolo 也不豁免）', !!q('#cr-yes'),
      q('#cr-yes') ? q('#cr-yes').textContent : ('没弹窗 · 末条回复=' + lastReply() + ' · 末条用户消息=' + lastUser
        + ' · 判定=' + (window.AiPanel && AiPanel.runNeedsConfirm ? AiPanel.runNeedsConfirm('rm -rf node_modules') : 'n/a')));
    add('危险命令不给「总是允许」', !q('#cr-always'));
    if (q('#cr-no')) { q('#cr-no').click(); await sleep(400); }
    // ⑨ 项目规则文件
    const rules = await (window.AiPanel && AiPanel.loadProjectRules ? AiPanel.loadProjectRules(true) : Promise.resolve(''));
    add('读到项目规则文件 .myide/ai-rules.md', !!rules && String(rules).includes('变更列表'), String(rules).slice(0, 40));
    // ⑩ 底部只有一条上下文线（不再「正在看」一行 + chips 换行 + 回形针，堆三层）
    add('去掉了功能重复的回形针按钮（@ 已能引用一切）', !q('#ai-file-chip'));
    add('「正在看」不再独占一整行', !q('#ai-follow'));
    const fchip = q('#ai-chips .ai-ctx-chip.follow');
    add('当前文件是 chips 里带图标的跟随项（不是 emoji 文字）',
      !!fchip && !!fchip.querySelector('svg.ic') && !fchip.querySelector('.ai-ctx-pin'),
      fchip ? tidy(fchip) : '(没有跟随 chip)');
    const chipEl = q('#ai-chips .ai-ctx-chip');
    const nChip = qa('#ai-chips .ai-ctx-chip').length;
    if (chipEl) { chipEl.click(); await sleep(250); }
    add('点 chip 本体不会误删（只有 ✕ 才移除）', qa('#ai-chips .ai-ctx-chip').length === nChip,
      '点击前 ' + nChip + ' → 点击后 ' + qa('#ai-chips .ai-ctx-chip').length);
    // ⑪ 预设权限：头部盾牌按钮（不用每次改文件都点确认）
    add('头部有「访问权限」入口（不用钻设置页改下拉）', !!q('#ai-perm'));
    if (q('#ai-perm')) { q('#ai-perm').click(); await sleep(400); }
    const pseg = qa('.ai-perm-pop .ai-seg');
    add('权限浮层：两个维度 × 三档（每次确认 / 自动 / 禁止）',
      pseg.length === 2 && qa('.ai-perm-pop .ai-seg button').length === 6,
      pseg.length + ' 组 / ' + qa('.ai-perm-pop .ai-seg button').length + ' 个档位');
    add('权限浮层写明危险命令不豁免', !!q('.ai-perm-pop .ai-perm-note'));
    if (pseg.length) {
      const seg0 = () => qa('.ai-perm-pop .ai-seg')[0];   // 每次重查：切档会重渲染浮层
      seg0().querySelectorAll('button')[1].click();
      await sleep(300);
      add('点「自动」档位真的切了', AiPanel.permWrite() === 'auto', 'permWrite=' + AiPanel.permWrite());
      seg0().querySelectorAll('button')[0].click();
      await sleep(300);
      add('能改回「每次确认」', AiPanel.permWrite() === 'confirm', 'permWrite=' + AiPanel.permWrite());
    }
    if (q('#ai-perm')) { q('#ai-perm').click(); await sleep(300); }
    add('权限浮层可收起', !q('.ai-perm-pop'));
    // ⑫ 改动确认：贴在面板底部的浮层，不再用居中大模态把编辑器整个盖住
    q('#ai-new').click();
    await sleep(350);
    AiPanel.savePerms({});
    AiPanel.sessionPerm.write = false;
    AiPanel.setConfig({ permWrite: 'confirm', permRun: 'confirm', allowPaths: [] });
    await ask('第一次改', 2800);
    const cf = q('.ai-confirm');
    add('改动确认是贴面板底部的浮层（不是居中大模态）', !!cf,
      cf ? '浮层在' + (q('#ai-panel .ai-confirm') ? '面板内' : '面板外') : ('没出现 · 末条回复=' + lastReply()));
    add('弹浮层时没有全屏遮罩（编辑器不被盖住）', !q('#modal-mask:not(.hidden)'));
    add('浮层里有文件名 + 加减行数', !!cf && !!cf.querySelector('.ai-cf-nm') && !!cf.querySelector('.ai-cf-stat'),
      cf && cf.querySelector('.ai-cf-nm') ? cf.querySelector('.ai-cf-nm').textContent + ' · ' + cf.querySelector('.ai-cf-stat').textContent : '');
    add('diff 直接铺在浮层里（不用再点开）', !!cf && !!cf.querySelector('.ai-cf-body .d-add'));
    add('有「收起 / 展开 diff」折叠按钮', !!q('#dw-fold'));
    if (q('#dw-no')) { q('#dw-no').click(); await sleep(400); }
    add('拒绝后浮层收起', !q('.ai-confirm'));
    // 再弹一次并留着：自检产物是给人看的，浮层到底长什么样得能看见（步骤结束后才截图）
    await ask('第一次改', 2800);
    add('确认浮层可再次唤起（截图用）', !!q('.ai-confirm'));
    return { R };
  },
};
// scripts/check-page.js —— 在真实渲染进程执行的自检（main.js --check 模式调用）
// 返回 {checkName: result} 对象，主进程打印。window.__CHECK_P 为测试项目路径。
(async () => {
  const P = window.__CHECK_P;
  const out = {};
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  try {
    // Bug1: 内容区定位（空状态约束）
    out.contentPos = getComputedStyle(q('#content')).position;
    // 文件名 nowrap
    const nm = q('.tree-row .nm');
    out.nmNowrap = nm ? getComputedStyle(nm).whiteSpace : 'no-row';
    // Git 树着色（notes.txt 是 demo 里的已修改文件）
    const n1 = qa('.tree-row .nm').find((x) => (x.title || '').includes('notes.txt'));
    out.treeGitCls = n1 ? n1.className : 'no-notes-row';
    // 收起/展开按钮 + 拖拽手柄
    out.collapseBtns = !!(q('#tree-collapse') && q('#tree-expand'));
    out.resizer = !!q('#sidebar-resizer');
    if (q('#tree-collapse')) {
      click(q('#tree-collapse'));
      await wait(400);
      out.collapsedRows = qa('.tree-row').length;
      click(q('#tree-expand'));
      await wait(600);
      out.expandedRows = qa('.tree-row').length;
      click(q('#tree-collapse')); // 收起，让后续测试的 README 行回到可视窗口
      await wait(400);
    }
    // 侧栏拖拽调宽
    const resizer = q('#sidebar-resizer');
    if (resizer) {
      resizer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 420 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 420 }));
      await wait(200);
      out.sidebarWidth = q('#sidebar').style.width;
    }
    // Ctrl+1 始终显示项目面板
    App.showTool('outline');
    await wait(100);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(200);
    out.ctrl1ProjectVisible = getComputedStyle(q('#panel-project')).display !== 'none';
    // 单击文件不复制路径
    window.__copied = 0;
    const origCopy = MI.copyText;
    MI.copyText = () => { window.__copied++; };
    const row = qa('.tree-row').find((r) => (r.querySelector('.nm').title || '').endsWith('README.md'));
    out.readmeRowFound = !!row;
    if (row) click(row);
    await wait(500);
    out.clickNoCopy = window.__copied === 0;
    out.afterClick = { active: (Viewer.activeTab || {}).path, mode: (Viewer.activeTab || {}).mode, md: !!q('.md-view'), err: (Viewer.activeTab || {}).error };
    MI.copyText = origCopy;
    // 高亮切换：点击 notes.txt 后高亮应移过去，README 不再高亮
    const nrow = qa('.tree-row').find((r) => (r.querySelector('.nm').title || '').endsWith('notes.txt'));
    if (nrow) click(nrow);
    await wait(400);
    out.highlightSwitched = (() => {
      const selRows = qa('.tree-row.selected').map((r) => (r.querySelector('.nm') || {}).title);
      return { notesSel: selRows.some((t) => t && t.endsWith('notes.txt')), readmeSel: selRows.some((t) => t && t.endsWith('README.md')), count: selRows.length };
    })();
    // Markdown 默认「实时预览」（Obsidian 式块编辑）；工具栏可切分屏
    await Viewer.openFile(P + '\\README.md');
    await wait(600);
    out.mdLiveDefault = !!q('.md-live');
    out.mdLiveBlocks = qa('.md-live .md-block').length;
    // 点击块 → 进入编辑；Esc 提交回渲染
    const firstBlock = q('.md-live .md-block');
    if (firstBlock) {
      firstBlock.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      await wait(200);
      out.mdBlockEdit = !!q('.md-block-edit');
      const et = q('.md-block-edit');
      if (et) {
        et.value = '# 实时标题检查';
        et.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(100);
        et.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await wait(300);
      }
    } else out.mdBlockEdit = false;
    out.mdBlockH1 = (() => { const h = q('.md-live .md-block h1'); return h ? h.textContent : null; })();
    // 切分屏模式
    const splitBtn = qa('.viewer-toolbar .vt-btn').find((b) => b.textContent.includes('◧ 分屏'));
    if (splitBtn) { click(splitBtn); await wait(400); }
    out.mdSplitMode = !!q('.md-split');
    out.mdSplitPreview = !!q('.md-split-preview .md-view');
    out.mdPreviewPane = !!q('.md-view');
    // wiki 链接 + 远程图片（CSP）
    await Viewer.openFile(P + '\\_shot测试.md');
    await wait(1200);
    out.wikiAnchors = qa('.md-view a').map((a) => (a.textContent || '').trim() + '→' + a.getAttribute('href'));
    const rim = q('.md-view img');
    out.remoteImg = rim ? { complete: rim.complete, naturalWidth: rim.naturalWidth } : 'no-img';
    // 子目录相对图片（离线可验证路径解析）
    const lim = qa('.md-view img').find((im) => (im.getAttribute('src') || '').includes('src'));
    out.localImg = lim ? { src: lim.getAttribute('src'), ok: lim.complete && lim.naturalWidth > 0 } : 'no-local-img';
    // wiki 链接点击 → 打开 .md
    const wikiA = qa('.md-view a').find((a) => (a.textContent || '').includes('README'));
    if (wikiA) click(wikiA);
    await wait(600);
    out.wikiClickActiveTab = (Viewer.activeTab || {}).name || null;
    // 弹窗不透明
    QuickOpen.open();
    await wait(400);
    out.modalBg = getComputedStyle(q('#qo-box')).backgroundColor;
    Modal.hide();
    await wait(100);
    // 图片查看器背景（无格子）
    await Viewer.openFile(P + '\\_shot图.png');
    await wait(600);
    const iv = q('.img-view');
    out.imgBgImage = iv ? getComputedStyle(iv).backgroundImage : 'no-img-view';
    // Git 提交工具窗口（PyCharm 式左侧停靠：上半文件树 · 下半提交信息）
    App.showTool('git');
    await wait(800);
    out.commitPanelVisible = !q('#panel-git').classList.contains('hidden');
    out.branchLabel = q('#cd-branch') ? q('#cd-branch').textContent : null;
    // 本地修改：只显示文件名
    const nmG = qa('#cd-files .git-file .nm').find((x) => x.title === 'src\\app.js');
    out.gitFileName = nmG ? { text: nmG.textContent, title: nmG.title } : 'no-src-app-row';
    // 单击行 → 编辑区差异预览
    const gf = qa('#cd-files .git-file').find((x) => x.textContent.includes('notes.txt'));
    if (gf) click(gf);
    await wait(600);
    out.gitClickDiff = !!q('#viewer .diff-wrap .diff-table');
    out.gitSecTitles = qa('#cd-files .git-sec-title').map((s) => s.textContent);
    if (out.gitClickDiff) GitPanel.closeDiffView();
    App.switchTool('git'); // 已激活 → 收起
    await wait(100);
    // 大目录性能（2000 文件，验证不卡死）
    const t0 = Date.now();
    await App.setRoot(P + '\\_bigdir');
    await wait(1000);
    out.bigDir = {
      rows: qa('.tree-row').length,
      totalTimeMs: Date.now() - t0,
      spacer: q('#tree > div') ? q('#tree > div').style.height : null,
    };
    let heartbeats = 0;
    const hb = setInterval(() => { heartbeats++; }, 50);
    await wait(500);
    clearInterval(hb);
    out.bigDir.heartbeats500ms = heartbeats; // ~10 说明事件循环健康
    // 回到 demo，验证空状态只覆盖内容区（不遮工具栏）+ 页面无滚动溢出
    await App.setRoot(P);
    await wait(1200);
    // 自绘标题栏窗口控制按钮
    out.winBtns = !!(q('#win-min') && q('#win-max') && q('#win-close'));
    // 编码修复验证（无 BOM UTF-8 / 无 BOM UTF-16LE / GBK）
    await Viewer.openFile(P + '\\_enc_utf8.md');
    await wait(500);
    out.encUtf8 = (() => { const t = Viewer.activeTab; return { mode: t.mode, binary: t.binary, head: (t.content || '').slice(0, 12) }; })();
    await Viewer.openFile(P + '\\_enc_u16le.py');
    await wait(500);
    out.encU16le = (() => { const t = Viewer.activeTab; return { mode: t.mode, binary: t.binary, head: (t.content || '').slice(0, 16), enc: t.encoding }; })();
    await Viewer.openFile(P + '\\_enc_gbk.txt');
    await wait(500);
    out.encGbk = (() => { const t = Viewer.activeTab; return { mode: t.mode, binary: t.binary, head: (t.content || '').slice(0, 10), enc: t.encoding }; })();
    // DOCTYPE 规范化 + HTML 浏览器打开按钮
    await Viewer.openFile(P + '\\_enc_html.html');
    await wait(600);
    const hframe = q('.html-frame');
    out.htmlDoctype = hframe ? (hframe.getAttribute('srcdoc') || '').slice(0, 60) : 'no-frame';
    out.htmlBrowserBtn = qa('.viewer-toolbar .vt-btn').some((b) => b.textContent.includes('浏览器打开'));
    // iframe 按键转发：模拟 iframe 发来的 Ctrl+1
    App.showTool('outline');
    await wait(100);
    window.postMessage({ __myideKey: 1, key: '1', ctrlKey: true }, '*');
    await wait(200);
    out.iframeCtrl1 = getComputedStyle(q('#panel-project')).display !== 'none';
    // 标签「▾ 全部」下拉（打开文件过多时的合并入口）
    out.tabAllBtn = !!q('.tab-all');
    Viewer.closeAll();
    await wait(300);
    const es = q('#empty-state').getBoundingClientRect();
    const ct = q('#content').getBoundingClientRect();
    out.emptyState = { top: Math.round(es.top), contentTop: Math.round(ct.top), width: Math.round(es.width), contentWidth: Math.round(ct.width) };
    document.scrollingElement.scrollTop = 0;
    document.body.scrollTop = 0;
    await wait(100);
    out.pageScroll = {
      doc: document.scrollingElement.scrollTop,
      body: document.body.scrollTop,
      toolbarTop: Math.round(q('#toolbar').getBoundingClientRect().top),
      viewportH: document.documentElement.clientHeight,
      bodyScrollH: document.body.scrollHeight,
    };
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  return out;
})()

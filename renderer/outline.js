// outline.js —— Markdown / JSON 大纲面板（对齐 PyCharm Structure：树形展开 + 右键「复制本章节」）
//
// 与 PyCharm Structure 的对应关系：
//   · 行 = 固定宽度箭头列 + 文本，箭头独占点击区（点箭头只折叠，点文本只跳转）
//   · 选中项整行铺满高亮（跟随键盘导航）
//   · 顶部「展开全部 / 收起全部」，JSON 可开启「同步折叠」双向联动
//     —— 原来那排「全展 / H1 / H2 / H3 / H4」按钮语义是"折叠编辑器"，摆在树形大纲里
//        很容易被理解成"按层级过滤大纲"，已移到右键菜单（右键某章节 → 在编辑器中折叠到此层级）
//   · 右键章节名 → 复制本章节（标题 + 正文 + 子章节，另有「只复制正文」「只复制标题」）
const Outline = (() => {
  const el = document.getElementById('outline');
  const panel = document.getElementById('panel-outline');
  let headings = [];          // [{level, text, line}]
  let collapsed = new Set();  // 被收起的标题 key（行号+文本）
  let selIdx = -1;            // 当前选中项（键盘导航 / 点击）
  let selKey = '';            // 选中项 key，刷新后尽量保持在同一条目上
  let owner=null;
  let composing = false;
  // 焦点入口留在稳定容器上，折叠重绘不会移除用户正在操作的节点。
  el.tabIndex = 0;
  el.setAttribute('role', 'tree');
  el.setAttribute('aria-label', '文档大纲');
  el.addEventListener('compositionstart', () => { composing = true; });
  el.addEventListener('compositionend', () => { composing = false; });
  el.addEventListener('blur', () => { composing = false; });
  el.addEventListener('focus', () => ensureVisibleSelection());

  const LS_KEY = 'myide-outline-collapsed';
  const SYNC_KEY = 'myide-outline-json-sync';
  let syncEnabled=false;
  try { syncEnabled=localStorage.getItem(SYNC_KEY)==='true'; } catch {}
  const isJson = () => /\.json$/i.test(Viewer.activeTab?.name||'');
  const syncActive = () => syncEnabled&&isJson();
  const hKey = (h) => h.key || h.line + '|' + h.text;
  // 折叠三角（内联 SVG，1.4px 描边，见 styles.css 的 svg.ic）—— 与文件树 dirIcon 同一套画法
  const ICO_CHEV = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 6.4L8 9.8l3.4-3.4"/></svg>';

  // 从 Markdown 源码解析标题（不依赖渲染 DOM，源码/预览模式都可用）
  // ★ 跳过 ``` 围栏代码块：代码块内的「# 注释」不是标题，计入会导致大纲与渲染错位、跳转位置不对
  function parse(content) {
    const out = [];
    const lines = String(content || '').split('\n');
    let inFence = false;
    const re = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = re.exec(line);
      if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
    }
    return out;
  }

  // ---------- 章节范围 ----------
  // 标题 i 的直接子层范围 [cs, ce)（直到遇到 level <= 自身的标题）
  function childrenRange(i) {
    let j = i + 1;
    while (j < headings.length && headings[j].level > headings[i].level) j++;
    return [i + 1, j];
  }
  const hasChildren = i => childrenRange(i)[1]>i+1;
  const hasJsonFold = i => !!headings[i]?.key?.startsWith('json:')&&headings[i].fold?.to>headings[i].fold?.from;
  const leafFold = i => hasJsonFold(i)&&!hasChildren(i);
  const canToggle = i => hasChildren(i)||hasJsonFold(i);
  // 标题 i 整节结束后、下一个「不浅于自身」的标题下标（headings.length 表示到文末）
  function sectionEnd(i) {
    const lv = headings[i].level;
    let j = i + 1;
    while (j < headings.length && headings[j].level > lv) j++;
    return j;
  }
  // 行是否被收起：任一祖先标题被收起即隐藏
  function isHidden(i) {
    let lv = headings[i].level;
    for (let k = i - 1; k >= 0; k--) {
      if (headings[k].level < lv) {
        if (collapsed.has(hKey(headings[k]))) return true;
        lv = headings[k].level;
        if (lv === 1) break;
      }
    }
    return false;
  }
  const trimBlank = (arr) => {
    let a = 0, b = arr.length;
    while (a < b && !arr[a].trim()) a++;
    while (b > a && !arr[b - 1].trim()) b--;
    return arr.slice(a, b).join('\n');
  };

  // ---------- 复制章节 ----------
  // mode: 'full' 标题+正文+子章节（默认）｜'body' 只本节正文（不含子标题）｜'title' 只标题
  function sectionText(i, mode) {
    const h = headings[i];
    if (!h) return '';
    if (mode === 'title') return h.text;
    if(h.key?.startsWith('json:'))return String(Viewer.activeTab?.content||'').replace(/\r\n?/g,'\n').slice(h.from,h.to);
    const lines = String((Viewer.activeTab && Viewer.activeTab.content) || '').split('\n');
    const end = sectionEnd(i);
    const secEnd = end < headings.length ? headings[end].line - 1 : lines.length; // 0-based 排他
    const [cs] = childrenRange(i);
    const bodyEnd = cs < headings.length ? headings[cs].line - 1 : secEnd;
    if (mode === 'body') return trimBlank(lines.slice(h.line, bodyEnd));       // 标题行之后 → 第一个子标题前
    return trimBlank(lines.slice(h.line - 1, secEnd));                          // 标题行 → 整节结束
  }
  function copySection(i, mode) {
    const h = headings[i];
    if (!h) return;
    const text = sectionText(i, mode);
    if (!text) { MI.toast('本节没有内容可复制', 'err'); return; }
    MI.copyText(text);
    const label = h.text.length > 16 ? h.text.slice(0, 16) + '…' : h.text;
    const lines = text.split('\n').length;
    MI.toast(mode === 'title' ? '已复制标题：' + label : '已复制「' + label + '」' + (mode === 'body' ? '正文' : '整节') + '（' + lines + ' 行）', 'ok');
  }

  // ---------- 右键菜单 ----------
  function showMenu(i, e) {
    const menu = document.getElementById('ctx-menu');
    if (!menu) return;
    const h = headings[i], menuOwner=owner;
    const valid=()=>owner===menuOwner&&headings[i]===h&&ownsDocument();
    const [cs, ce] = childrenRange(i);
    const hasKids = ce > cs;
    const isCol = collapsed.has(hKey(h));
    menu.innerHTML = '';
    const mk = (label, fn) => {
      const d = document.createElement('div');
      d.className = 'ctx-item';
      d.textContent = label;
      d.onclick = () => { menu.classList.add('hidden'); if(valid())fn(); };
      menu.appendChild(d);
    };
    const sep = () => {
      const d = document.createElement('div');
      d.className = 'ctx-sep';
      menu.appendChild(d);
    };
    const json=h.key?.startsWith('json:');
    mk(json?'📋 复制此项 JSON':'📋 复制本章节（含子章节）', () => copySection(i,'full'));
    if(!json)mk('📋 只复制本节正文',()=>copySection(i,'body'));
    mk(json?'📋 复制字段文本':'📋 复制标题文本',()=>copySection(i,'title'));
    if(!json||h.fold&&h.fold.to>h.fold.from){
      sep();
      mk('▾ 折叠本级（Ctrl+NumPad −）',()=>foldItem(i,true,false));
      mk('▸ 展开本级（Ctrl+NumPad +）',()=>foldItem(i,false,false));
      mk('▾ 折叠本级及内部（Ctrl+Alt+NumPad −）',()=>foldItem(i,true,true));
      mk('▸ 展开本级及内部（Ctrl+Alt+NumPad +）',()=>foldItem(i,false,true));
    }
    if(hasKids||!json)sep();
    if(hasKids)mk(isCol?'▸ 大纲列表：展开子级':'▾ 大纲列表：折叠子级',()=>toggleCollapse(i));
    if(!json){mk('⇥ 在编辑器中折叠到此层级（H'+h.level+'）',()=>applyFold(h.level));mk('⇤ 展开编辑器中全部标题节',()=>applyFold(0));}
    menu.classList.remove('hidden');
    const w = menu.offsetWidth, hh = menu.offsetHeight;
    menu.style.left = Math.min(e.clientX, Math.max(0, window.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.min(e.clientY, Math.max(0, window.innerHeight - hh - 8)) + 'px';
  }

  function ownsDocument() {
    const tab=Viewer.activeTab;
    return !!tab&&!!owner&&tab.id===owner.documentId&&tab.path===owner.path&&tab.editRevision===owner.revision;
  }
  function editorRange(i) {
    const h=headings[i],cm=Viewer.cm;
    if(!h||!cm?.view||cm.__tab!==Viewer.activeTab)return null;
    if(h.key)return h.fold;
    const doc=cm.view.state.doc,end=sectionEnd(i);
    return {from:doc.line(h.line).to+1,to:end<headings.length?doc.line(headings[end].line-1).to:doc.length};
  }
  function foldItem(i,folded,recursive=false) {
    if(!ownsDocument()||!headings[i])return false;
    const cm=Viewer.cm;
    if(!cm?.fold||cm.__tab!==Viewer.activeTab){MI.toast('请先切换到可折叠的编辑视图','err');return false;}
    const range=editorRange(i);
    if(!range||range.to<=range.from)return false;
    cm.fold({folded,recursive,range});
    const end=recursive?sectionEnd(i):i+1;
    for(let k=i;k<end;k++){if(folded)collapsed.add(hKey(headings[k]));else collapsed.delete(hKey(headings[k]));}
    saveCollapsed();refresh(Viewer.activeTab);return true;
  }
  function foldAll(folded) {
    if(!ownsDocument())return false;
    const cm=Viewer.cm;if(!cm?.fold||cm.__tab!==Viewer.activeTab)return false;
    cm.fold({folded,all:true});
    if(syncActive())syncFromEditor(cm.view);else setAllCollapsed(folded);
    return true;
  }
  function controlFold(index,expanded,scope='current') {
    const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
    if(!ownsDocument()||!Viewer.cm?.fold||Viewer.cm.__tab!==Viewer.activeTab)fail('OUTLINE_FOLD_UNAVAILABLE','请先打开当前文件的可折叠编辑视图');
    if(typeof expanded!=='boolean'||!['current','recursive','all'].includes(scope)||(scope==='all'?index!=null:!Number.isInteger(index)||!headings[index]))fail('INVALID_TOOL_ARGS','折叠范围或目标无效');
    if(scope==='all')return foldAll(!expanded);
    const range=editorRange(index);
    if(!range||range.to<=range.from)fail('OUTLINE_NOT_FOLDABLE','此项没有可折叠的内部内容');
    return foldItem(index,!expanded,scope==='recursive');
  }
  function controlState() {
    const canFold=!!(ownsDocument()&&Viewer.cm?.fold&&Viewer.cm.__tab===Viewer.activeTab),folded=new Set();
    if(canFold)CM6.Language.foldedRanges(Viewer.cm.view.state).between(0,Viewer.cm.view.state.doc.length,(from,to)=>folded.add(from+':'+to));
    return {syncEnabled:syncActive(),canFold,items:headings.map((h,i)=>{
      const range=canFold?editorRange(i):null,editorFoldable=!!range&&range.to>range.from;
      return {...h,expanded:!collapsed.has(hKey(h)),visible:!isHidden(i),selected:i===selIdx,hasChildren:hasChildren(i),foldable:canToggle(i),editorFoldable,editorFolded:editorFoldable?folded.has(range.from+':'+range.to):null};
    })};
  }

  function readEditorFolds(view) {
    const folded=new Set();
    CM6.Language.foldedRanges(view.state).between(0,view.state.doc.length,(from,to)=>folded.add(from+':'+to));
    if(syncEnabled)collapsed=new Set(headings.filter(h=>h.fold&&folded.has(h.fold.from+':'+h.fold.to)).map(hKey));
    else headings.forEach((h,i)=>{if(leafFold(i)){if(folded.has(h.fold.from+':'+h.fold.to))collapsed.add(hKey(h));else collapsed.delete(hKey(h));}});
  }
  function syncFromEditor(view) {
    if(!isJson()||!ownsDocument()||Viewer.cm?.__tab!==Viewer.activeTab||Viewer.cm?.view!==view)return false;
    readEditorFolds(view);saveCollapsed();
    // 折叠没有改正文：只更新已有树行，不能每次按键都重新解析整个 JSON 或重置滚动。
    itemRows().forEach((row,i)=>{
      const closed=collapsed.has(hKey(headings[i])),arrow=row.querySelector('.ol-arrow:not(.ol-pad)');
      if(!filterText.trim())row.classList.toggle('ol-hidden',isHidden(i));  // 过滤态下显示由 applyFilter 说了算
      if(arrow){row.setAttribute('aria-expanded',String(!closed));arrow.classList.toggle('closed',closed);arrow.title=leafFold(i)?(closed?'展开本级':'折叠本级'):(closed?'展开子级':'收起子级');}
    });
    ensureVisibleSelection();return true;
  }
  function setSync(enabled) {
    if(!isJson())return false;
    const cm=Viewer.cm;
    if(enabled&&(!ownsDocument()||!cm?.fold||cm.__tab!==Viewer.activeTab)){MI.toast('请先切换到可折叠的编辑视图','err');return false;}
    syncEnabled=!!enabled;
    try { localStorage.setItem(SYNC_KEY,String(syncEnabled)); } catch {}
    mountHeaderActions();
    if(syncEnabled)syncFromEditor(cm.view);
    return true;
  }

  // ---------- 编辑器折叠（按标题层级） ----------
  function applyFold(lv) {
    const tab = Viewer.activeTab;
    if (tab && Viewer.cm && Viewer.cm.foldToLevel) {
      Viewer.cm.foldToLevel(lv === 0 ? 0 : lv + 1);
      if (window.MI) MI.toast(lv === 0 ? '已展开全部标题节' : '已收至 H' + lv, 'ok');
    } else if (window.MI) {
      MI.toast('请先在实时预览 / 源码 / 分屏模式下打开 Markdown', 'err');
    }
  }

  // ---------- 面板标题栏动作（展开全部 / 收起全部）----------
  // 双折线（chevrons）而不是「+ / −」：这对按钮贴着标题文字，裸十字会被读成「新建」、
  // 裸横线会被读成「删除 / 收起面板」（文件树那两个带方框的 ± 才是那个语义，别混）。
  // 上下叠两条折线在 VS Code / GitHub 里就是「全部展开 / 全部收起」的固定画法。
  // ⚠ 两条折线之间必须留 ≥ 1 个 viewBox 单位的空隙：早先 4.4/7.8/8.6/12 那一版两线首尾相接，
  //   渲染成 14px 后糊成一个 "X"/单箭头（截图 8 倍放大实测），完全读不出是"两条折线"。
  const IC_EXPAND = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 3.6L8 7l3.4-3.4M4.6 8.8L8 12.2l3.4-3.4"/></svg>';
  const IC_COLLAPSE = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 7.4L8 4l3.4 3.4M4.6 12.6L8 9.2l3.4 3.4"/></svg>';
  const IC_SYNC = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5h9M9 2l3 3-3 3M13 11H4m3-3-3 3 3 3"/></svg>';
  function mountHeaderActions() {
    const t = panel && panel.querySelector('.panel-title');
    if (!t) return;
    let box=t.querySelector('.panel-title-actions');
    if(box){updateSyncButton(box);return;}
    box = document.createElement('span');
    box.className = 'panel-title-actions';
    const mk = (svg, title, fn) => {
      const b = document.createElement('button');
      b.className = 'vt-btn';
      b.innerHTML = svg;
      b.title = title;
      // 只有 title＝hover 才看得到；读屏 / 键盘用户拿不到，必须同时给 aria-label。
      b.setAttribute('aria-label', title);
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      box.appendChild(b);
    };
    mk(IC_EXPAND, '展开全部章节', () => setAllCollapsed(false));
    mk(IC_COLLAPSE, '收起全部章节', () => setAllCollapsed(true));
    t.appendChild(box);
    updateSyncButton(box);
  }
  function updateSyncButton(box) {
    let button=box.querySelector('#outline-sync');
    if(!isJson()){button?.remove();return;}
    if(!button){button=document.createElement('button');button.id='outline-sync';button.className='vt-btn';button.innerHTML=IC_SYNC;button.setAttribute('aria-label','同步折叠');button.onclick=e=>{e.stopPropagation();setSync(!syncEnabled);};box.prepend(button);}
    button.classList.toggle('active',syncEnabled);
    button.setAttribute('aria-pressed',String(syncEnabled));
    button.title='同步折叠：'+(syncEnabled?'已开启（点击关闭）':'已关闭（点击与编辑区双向同步）');
  }
  function setAllCollapsed(v) {
    if(syncActive())return foldAll(v);
    if (v) {
      for (let i=0;i<headings.length;i++) {
        const h=headings[i];
        const [cs, ce] = childrenRange(i);
        if (ce > cs) collapsed.add(hKey(h));
      }
    } else collapsed.clear();
    saveCollapsed();
    refresh(Viewer.activeTab);
  }

  // ---------- 过滤标题（长文档定位）----------
  // 文件树早有搜索框，大纲一直没有：十几节的文档只能靠滚。这里复用文件树那套
  // `.tree-search-wrap`（内嵌放大镜 + 静态无边框 + focus 才描主色），不另起一套控件语言。
  const IC_SEARCH = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.4"/><path d="M10.4 10.4L14 14"/></svg>';
  let filterText = '';
  function mountFilter() {
    if (!panel) return null;
    let wrap = panel.querySelector('#outline-filter');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'outline-filter';
      wrap.className = 'tree-search-wrap';
      wrap.innerHTML = IC_SEARCH +
        '<input id="outline-search" type="text" placeholder="过滤标题…" autocomplete="off" spellcheck="false" aria-label="过滤大纲标题">';
      panel.insertBefore(wrap, el);   // 标题栏之下、树之上
      const input = wrap.querySelector('input');
      input.value = filterText;
      input.addEventListener('input', (ev) => {
        if (ev.isComposing) return;   // 拼音组合中不按半成品字母过滤
        filterText = input.value;
        applyFilter();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setFilter(''); el.focus(); return; }
        // ↓ / Enter 把操作交回树：过滤只是定位手段，跳转仍走大纲自己的键盘语义
        if (e.key === 'ArrowDown' || e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          el.focus(); ensureVisibleSelection();
          if (e.key === 'ArrowDown') moveSel(1); else if (selIdx >= 0) jump(selIdx);
        }
      });
    }
    return wrap;
  }
  function setFilter(v) {
    filterText = v;
    const input = panel && panel.querySelector('#outline-search');
    if (input && input.value !== v) input.value = v;
    applyFilter();
  }
  // 过滤命中 + 祖先链一起留下（否则命中项和它的父章节断开，看不出属于哪一节）。
  // 命中路径无视折叠态：收起的父节点下面藏着命中项，等于什么都没过滤出来。
  function applyFilter() {
    const rows = itemRows();
    const q = filterText.trim().toLowerCase();
    const noMatch = panel && panel.querySelector('#outline-no-match');
    if (!rows.length) { noMatch?.remove(); return; }
    if (!q) {
      rows.forEach((r, i) => { r.classList.remove('ol-filtered'); r.classList.toggle('ol-hidden', isHidden(i)); });
      noMatch?.remove();
      return;
    }
    const keep = new Set();
    headings.forEach((h, i) => {
      if (!h.text.toLowerCase().includes(q)) return;
      keep.add(i);
      let lv = h.level;
      for (let k = i - 1; k >= 0 && lv > 1; k--) {
        if (headings[k].level < lv) { keep.add(k); lv = headings[k].level; }
      }
    });
    rows.forEach((r, i) => {
      const hit = keep.has(i);
      r.classList.toggle('ol-filtered', !hit);
      r.classList.toggle('ol-hidden', !hit);
    });
    // 选中项被滤掉时落到第一条命中项：否则 ↑↓ / ←→ 会从一个看不见的行出发，像"按了没反应"。
    if (selIdx >= 0 && rows[selIdx] && rows[selIdx].classList.contains('ol-filtered')) {
      select(rows.findIndex((r) => !r.classList.contains('ol-filtered')));
    }
    if (!keep.size) {
      if (!noMatch) {
        const d = document.createElement('div');
        d.id = 'outline-no-match';
        d.className = 'tree-search-empty';
        el.appendChild(d);
      }
      el.querySelector('#outline-no-match').textContent = '没有匹配「' + filterText.trim() + '」的标题';
    } else noMatch?.remove();
  }

  // ---------- 跟随光标 ----------
  // 反方向同步：编辑器滚到哪一节，大纲就把哪一行点亮（PyCharm Structure / VS Code Outline 的默认行为）。
  // 只改高亮 + 滚动，不重建树、不动 selKey 以外的状态，所以每次光标移动都能调。
  function followCursor(line) {
    if (!headings.length || !panel || panel.classList.contains('hidden')) return false;
    if (filterText.trim()) return false;                 // 过滤态下目标行可能被滤掉，别留个看不见的高亮
    if (document.activeElement === el) return false;      // 用户正在大纲里按 ↑↓ 浏览，别被编辑器拽回去
    let lo = 0, hi = headings.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (headings[mid].line <= line) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx < 0 || idx === selIdx) return false;
    if (isHidden(idx)) return false;                      // 藏在收起节点里的项，点亮也看不见
    select(idx);
    try { itemRows()[idx]?.scrollIntoView({ block: 'nearest' }); } catch {}
    return true;
  }

  // ---------- 持久化 ----------
  function loadCollapsed() {
    try { collapsed = new Set(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); } catch { collapsed = new Set(); }
  }
  function saveCollapsed() {
    try { localStorage.setItem(LS_KEY, JSON.stringify([...collapsed])); } catch {}
  }

  // ---------- 渲染 ----------
  function renderEmpty(msg) {
    const d = document.createElement('div');
    d.className = 'git-empty';
    d.textContent = msg;
    el.appendChild(d);
  }

  async function refresh(tab) {
    // 打字时每 300ms 重建一次整棵树（viewer.js 的 cmOutlineTimer）；不把 scrollTop 接住，
    // 大纲就会被一次次弹回顶部 —— 正滚到下半段看结构的人等于被踹了一脚。
    const prevDoc = owner && owner.documentId;
    const prevScroll = el.scrollTop;
    const sameDoc = !!tab && prevDoc === tab.id;
    if (!sameDoc) setFilter('');           // 换文件时过滤条件跟着换，别残留到下一篇
    el.innerHTML = '';
    el.removeAttribute('aria-activedescendant');
    headings = [];
    owner=tab?{documentId:tab.id,revision:tab.editRevision,path:tab.path}:null;
    if(tab?.reader){owner=null;const title=document.querySelector('#panel-outline .panel-title');if(title?.firstChild?.nodeType===3)title.firstChild.textContent='阅读目录';document.querySelector('#panel-outline .panel-title-actions')?.setAttribute('hidden','');document.querySelector('#outline-filter')?.setAttribute('hidden','');window.Reader?.renderOutline(el,tab);return;}
    const readerTitle=document.querySelector('#panel-outline .panel-title');if(readerTitle?.firstChild?.nodeType===3)readerTitle.firstChild.textContent='大纲';
    document.querySelector('#panel-outline .panel-title-actions')?.removeAttribute('hidden');
    loadCollapsed();
    mountHeaderActions();
    const isMd = tab && /\.(md|markdown)$/i.test(tab.name || ''),isJson=tab&&/\.json$/i.test(tab.name||'');
    if (!isMd&&!isJson) {
      selIdx = -1; selKey = '';
      document.querySelector('#outline-filter')?.setAttribute('hidden','');
      renderEmpty(tab ? '当前文件没有大纲' : '打开 Markdown 或 JSON 文件查看大纲');
      return;
    }
    headings = isJson?(window.CodeEditor?.parseJsonOutline(tab.content)||[]):parse(tab.content);
    if(isJson&&ownsDocument()&&Viewer.cm?.__tab===tab)readEditorFolds(Viewer.cm.view);
    if (!headings.length) {
      selIdx = -1; selKey = '';
      setFilter('');
      document.querySelector('#outline-filter')?.setAttribute('hidden','');
      renderEmpty(isJson?'未找到可识别的 JSON 结构':'未找到标题');
      return;
    }
    mountFilter()?.removeAttribute('hidden');
    // 内容变化后行号/文本对不上 → 丢弃失效的收起 key
    const validKeys = new Set(headings.map(hKey));
    let pruned = false;
    for (const k of collapsed) if (!validKeys.has(k)) { collapsed.delete(k); pruned = true; }
    if (pruned) saveCollapsed();

    const wrap = document.createElement('div');
    wrap.className = 'outline-list';
    headings.forEach((h, i) => {
      const [cs, ce] = childrenRange(i);
      const hasKids = ce > cs;
      // JSON 大纲隐藏了普通字段；没有结构子项仍可能有正文可折叠，不能当作无操作的叶子。
      const toggleable = hasKids||hasJsonFold(i);
      const isCol = collapsed.has(hKey(h));
      const row = document.createElement('div');
      row.className = 'outline-item' + (h.level > 1 ? ' lv' + h.level : '');
      // 缩进：箭头列固定宽度，文本起点按层级递进（PyCharm 同款）。
      // ⚠ 必须用 em：面板字号是 --tool-font（状态栏 A−/A+ 改），行高与箭头列都是 em ——
      //   原来这里写死 13px，字号调到 18px 时一级台阶只剩 0.72em，六个层级渐渐挤成一片。
      //   0.5em 的基数是给箭头留出的左内边（原来 4px 让 ▾ 直接压在面板边缘 / 选中竖线上）。
      row.style.paddingLeft = ((h.level - 1) + 0.5) + 'em';
      row.title = h.text + '\n右键：复制 / 折叠本级或本级及内部 · 双击：'+(leafFold(i)?'折叠/展开本级':'大纲列表折叠展开');
      row.dataset.idx = String(i);
      row.id = 'outline-heading-' + i;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(h.level));
      row.setAttribute('aria-selected', 'false');
      if (toggleable) row.setAttribute('aria-expanded', String(!isCol));
      if (isHidden(i)) row.classList.add('ol-hidden');
      if (selKey && hKey(h) === selKey) row.classList.add('key-nav-sel');

      const arrow = document.createElement('span');
      arrow.className = 'ol-arrow' + (toggleable ? (isCol ? ' closed' : '') : ' ol-pad');
      if (toggleable) {
        // 三角用内联 SVG（同文件树 / 启动面板）：▾▸ 字符的字号与基线不受控，
        // 混在一列里会随字号变粗变笨重，宽度也对不齐 —— 实测 16px 下 13.6px 字形撑不满 1.15em 列。
        // 折叠态由 CSS 的 `.closed svg` 旋转 -90° 表示（不做两套路径，旋转动画也更顺）。
        arrow.innerHTML = ICO_CHEV;
        arrow.title = leafFold(i)?(isCol?'展开本级':'折叠本级'):(isCol?'展开子级':'收起子级');
        arrow.onclick = (ev) => { ev.stopPropagation(); el.focus(); toggleCollapse(i); };
      }
      const txt = document.createElement('span');
      txt.className = 'ol-text';
      txt.textContent = h.text;

      row.appendChild(arrow);
      row.appendChild(txt);
      row.onclick = () => { el.focus(); select(i); jump(i); };
      row.ondblclick = () => { el.focus(); if (toggleable) toggleCollapse(i); };   // 双击=折叠/展开（箭头太小，给个大目标）
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        el.focus();select(i);
        showMenu(i, ev);
      };
      wrap.appendChild(row);
    });
    el.appendChild(wrap);
    // 选中项在刷新后尽量还原（否则键盘导航每次刷新都从 0 开始）
    const keep = selKey ? headings.findIndex((h) => hKey(h) === selKey) : -1;
    select(keep);
    if (keep >= 0 || document.activeElement === el) ensureVisibleSelection();
    applyFilter();   // 重建后按当前过滤词重裁一遍（编辑触发的 refresh 不该把过滤清掉）
    if (sameDoc && prevScroll) el.scrollTop = prevScroll;
  }

  function select(i) {
    selIdx = i;
    selKey = headings[i] ? hKey(headings[i]) : '';
    itemRows().forEach((r, k) => {
      r.classList.toggle('key-nav-sel', k === i);
      r.setAttribute('aria-selected', String(k === i));
    });
    if (i >= 0 && headings[i]) el.setAttribute('aria-activedescendant', 'outline-heading-' + i);
    else el.removeAttribute('aria-activedescendant');
  }

  // 收起/展开标题 i 的子层
  function toggleCollapse(i) {
    if(syncActive()||leafFold(i))return foldItem(i,!collapsed.has(hKey(headings[i])),false);
    const k = hKey(headings[i]);
    if (collapsed.has(k)) collapsed.delete(k);
    else collapsed.add(k);
    saveCollapsed();
    refresh(Viewer.activeTab);
  }

  // 点击大纲项 → 按当前模式定位标题
  // live/source：CM 编辑器跳行；preview：滚动渲染标题；split：滚动预览面板里的标题
  function jump(i) {
    const tab = Viewer.activeTab;
    const h = headings[i];
    if (!tab || !h || !owner) return;
    Viewer.navigateTo({...owner,line:h.line,headingIndex:i,...(h.key?{offset:h.from}:{})});
  }

  // ---------- 键盘导航（↑↓ 选择 · Enter 跳转 · ←→ 折叠展开）----------
  const itemRows = () => [...el.querySelectorAll('.outline-item')];
  // 过滤掉的行走的是另一个类（ol-filtered）：ol-hidden 专表「被祖先收起」，
  // 两个状态混用会被 syncFromEditor / applyFilter 互相覆盖。
  const visibleRows = () => itemRows().filter((r) => !r.classList.contains('ol-hidden') && !r.classList.contains('ol-filtered'));
  function ensureVisibleSelection() {
    const rows = visibleRows();
    if (!rows.length) { select(-1); return; }
    if (selIdx >= 0 && headings[selIdx] && !isHidden(selIdx)) return;
    // 标题栏/箭头可以收起当前项的祖先，键盘下一步须从可见祖先出发。
    if (selIdx >= 0 && headings[selIdx]) {
      let level = headings[selIdx].level;
      for (let i = selIdx - 1; i >= 0; i--) {
        if (headings[i].level < level) {
          if (!isHidden(i)) { select(i); return; }
          level = headings[i].level;
        }
      }
    }
    select(Number(rows[0].dataset.idx));
  }
  function moveSel(delta) {
    const rows = visibleRows();
    if (!rows.length) return;
    const cur = rows.findIndex((r) => r.classList.contains('key-nav-sel'));
    let next = cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta;
    next = Math.max(0, Math.min(next, rows.length - 1));
    const i = Number(rows[next].dataset.idx);
    select(i);
    try { rows[next].scrollIntoView({ block: 'nearest' }); } catch {}
  }
  el.addEventListener('keydown', (e) => {
    // 面板可见不等于树获得焦点；工具栏、编辑器与输入确认保留自己的按键。
    if (e.target !== el || document.activeElement !== el || composing || e.isComposing || e.keyCode === 229) return;
    if(window.Modal?.stack.length||window.Shortcuts?.isCapturing())return;
    const folding=window.CodeEditor?.foldingShortcut(e);
    if(folding&&panel&&!panel.classList.contains('hidden')&&headings.length){
      e.preventDefault();e.stopImmediatePropagation();ensureVisibleSelection();
      if(folding.all)foldAll(folding.folded);else foldItem(selIdx,folding.folded,folding.recursive);
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(e.key)) return;
    if (!panel || panel.classList.contains('hidden')) return;
    if (!visibleRows().length) return;
    ensureVisibleSelection();
    e.preventDefault();
    if (e.key === 'ArrowDown') return moveSel(1);
    if (e.key === 'ArrowUp') return moveSel(-1);
    if (e.key === 'Home' || e.key === 'End') {
      const rows = visibleRows();
      const row = rows[e.key === 'Home' ? 0 : rows.length - 1];
      select(Number(row.dataset.idx));
      try { row.scrollIntoView({ block: 'nearest' }); } catch {}
      return;
    }
    if (e.key === 'ArrowRight') {           // 展开；已展开则进入第一个子项
      const i = selIdx;
      const [cs, ce] = childrenRange(i);
      if (!canToggle(i)) return;
      if (collapsed.has(hKey(headings[i]))) return toggleCollapse(i);
      if(ce>cs)return select(cs);
      return;
    }
    if (e.key === 'ArrowLeft') {            // 收起；已收起则回到父级
      const i = selIdx;
      if (canToggle(i) && !collapsed.has(hKey(headings[i]))) return toggleCollapse(i);
      for (let k = i - 1; k >= 0; k--) if (headings[k].level < headings[i].level) return select(k);
      return;
    }
    if (e.key === 'Enter' && selIdx >= 0) return jump(selIdx);
  });

  return {
    refresh, parse, copySection, sectionText, setAllCollapsed, foldItem, foldAll, setSync, syncFromEditor, controlFold, controlState, followCursor,
    async controlExpand(index,value){if(index==null){if(syncActive())controlFold(null,value,'all');else setAllCollapsed(!value);return;}if(!headings[index])throw Error('章节不存在');if(isJson()&&!canToggle(index))throw Object.assign(Error('此项没有可折叠的内部内容'),{code:'OUTLINE_NOT_FOLDABLE'});if(syncActive()||leafFold(index)){controlFold(index,value);return;}const k=hKey(headings[index]);if(value)collapsed.delete(k);else collapsed.add(k);saveCollapsed();await refresh(Viewer.activeTab);},
    async controlJump(index){const h=headings[index];if(!h||!owner)return {ok:false,error:'章节已失效'};for(let k=index-1,lv=h.level;k>=0;k--)if(headings[k].level<lv){collapsed.delete(hKey(headings[k]));lv=headings[k].level;}saveCollapsed();await refresh(Viewer.activeTab);select(index);return await Viewer.navigateTo({...owner,line:h.line,headingIndex:index,...(h.key?{offset:h.from}:{})});},
    get headings() { return headings; },
  };
})();
window.Outline = Outline;

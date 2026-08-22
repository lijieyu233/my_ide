// md-editor.js —— CodeMirror 6 Markdown 编辑器（Obsidian 式 Live Preview）
// 依赖 renderer/vendor/cm6-bundle.min.js（全局 CM6）
// 文档模型始终是纯 Markdown；Live Preview 只是装饰层（标记粒度显示模型）：
//   行级构造（标题#/引用>/围栏行/分隔线）光标落在该行才显示源码；
//   行内标记（** ~~ ` 等）仅光标紧邻该标记时才显形，光标在同行其他位置、
//   拖选跨段时保持渲染态（对齐 Obsidian：移动光标/选择不引起整行闪源码）；
//   链接/图片整构造在光标进入构造内部时显示完整源码。
window.MdEditor = (() => {
  const CM = window.CM6;
  if (!CM) return null;
  const { State, View, Language, Commands, Md, Autocomplete, Search } = CM;
  const { Decoration, ViewPlugin, WidgetType, EditorView, keymap } = View;
  const { Compartment, EditorState } = State;

  // ---------- 主题（CSS 变量适配四主题） ----------
  const baseTheme = EditorView.theme({
    '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--editor-text)', fontSize: 'var(--editor-font-size, 13px)' },
    // 正文用 UI 无衬线字体 —— 与 .md-view 预览同源（Obsidian 编辑态也是 UI 字体，非等宽）
    '.cm-scroller': { fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif', lineHeight: '1.7', overflow: 'auto', paddingLeft: '28px', paddingRight: '20px' },
    '.cm-content': { padding: '10px 0', caretColor: 'var(--accent)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': { display: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(127,127,127,0.07)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--bg-selected) !important' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-panels': { backgroundColor: 'var(--panel-strong)', color: 'var(--text)', borderColor: 'var(--border)' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': {
      background: 'var(--bg-input)', color: 'var(--text)', border: '1px solid var(--btn-border)', borderRadius: '3px',
    },
    '.cm-panel.cm-search button:hover': { background: 'var(--btn-hover)' },
    '.cm-searchMatch': { backgroundColor: 'var(--bg-selected)' },
    '.cm-searchMatch-selected': { backgroundColor: 'var(--accent)', color: '#fff' },
  });

  // Live Preview 渲染态样式 —— 与 .md-view 预览逐项同源对齐
  // 字号取 .md-view 的绝对值（h1 22 / h2 18 / h3 15 / 正文 13px）
  const liveTheme = EditorView.theme({
    // 标题内容样式（光标行也保留字号，只显示源码标记 —— Obsidian 行为）
    '.cm-md-h1': { fontSize: '22px', fontWeight: '700', color: 'var(--text-bright)', lineHeight: '1.35' },
    '.cm-md-h2': { fontSize: '18px', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.35' },
    '.cm-md-h3': { fontSize: '15px', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.4' },
    '.cm-md-h4': { fontSize: '13px', fontWeight: '600', color: 'var(--text-bright)' },
    '.cm-md-h5': { fontSize: '13px', fontWeight: '600', color: 'var(--text-bright)' },
    '.cm-md-h6': { fontSize: '13px', fontWeight: '500', color: 'var(--text-dim)' },
    // 标题行：行高 + padding 模拟 .md-view margin 18px 0 8px（叠加空行压缩后的间距）
    '.cm-line.cm-md-h1-line': { paddingTop: '10px', paddingBottom: '5px', borderBottom: '1px solid var(--border)' },
    '.cm-line.cm-md-h2-line': { paddingTop: '8px', paddingBottom: '3px', borderBottom: '1px solid var(--border)' },
    '.cm-line.cm-md-h3-line': { paddingTop: '5px' },
    '.cm-line.cm-md-h4-line, .cm-line.cm-md-h5-line, .cm-line.cm-md-h6-line': { paddingTop: '3px' },
    // 空行压缩：段落间空行不再占整行高（对齐 .md-view p margin 8px 的视觉间隙）
    '.cm-line.cm-md-blank': { lineHeight: '0.9' },
    '.cm-md-strong': { fontWeight: '700', color: 'var(--text-bright)' },
    '.cm-md-em': { fontStyle: 'italic' },
    '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--text-dim)' },
    '.cm-md-highlight': { backgroundColor: 'var(--bg-selected)', borderRadius: '2px' },
    // 行内代码（对齐 .md-view code：12px + padding 1px 5px + btn-bg 背景）
    '.cm-md-code': {
      fontFamily: 'var(--font-mono)', backgroundColor: 'var(--btn-bg)', color: 'var(--code-text)',
      borderRadius: '3px', padding: '1px 5px', fontSize: '12px',
    },
    '.cm-md-link': { color: 'var(--accent)', cursor: 'pointer' },
    '.cm-md-img': { display: 'inline-block', verticalAlign: 'middle' },
    '.cm-md-img img': { maxWidth: '100%', borderRadius: '4px' },
    // 列表标记弱化（Obsidian 式：bullet 变暗，内容正常色）
    '.cm-md-listmark': { color: 'var(--text-dim)' },
    // task checkbox（对齐 preview 渲染的 input[type=checkbox] 视觉）
    '.cm-md-task': {
      display: 'inline-block', width: '13px', height: '13px',
      border: '1.5px solid var(--text-dim)', borderRadius: '3px',
      verticalAlign: 'middle', margin: '0 5px 0 1px', position: 'relative',
    },
    '.cm-md-task.done': { background: 'var(--accent)', borderColor: 'var(--accent)' },
    '.cm-md-task.done::after': {
      content: '""', position: 'absolute', left: '3.5px', top: '0px',
      width: '4px', height: '8px', border: 'solid #fff', borderWidth: '0 2px 2px 0',
      transform: 'rotate(45deg)',
    },
    // 引用块（对齐 .md-view blockquote：左竖线 + 弱化色 + 上下间距）
    '.cm-line.cm-md-quote-line': {
      borderLeft: '3px solid var(--accent)', paddingLeft: '12px',
      color: 'var(--text-dim)', paddingTop: '2px', paddingBottom: '2px',
    },
    '.cm-line.cm-md-quote-first': { paddingTop: '8px' },
    '.cm-line.cm-md-quote-last': { paddingBottom: '8px' },
    // 围栏代码块（对齐 .md-view pre：背景块 + 圆角 6 + padding 12 + 12.5px/1.6）
    '.cm-line.cm-md-fence-line': {
      backgroundColor: 'var(--code-bg)', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)',
      fontFamily: 'var(--font-mono)', fontSize: '12.5px', lineHeight: '1.6', padding: '1px 12px',
    },
    '.cm-line.cm-md-fence-first': { borderTop: '1px solid var(--border)', borderTopLeftRadius: '6px', borderTopRightRadius: '6px', paddingTop: '12px', marginTop: '6px' },
    '.cm-line.cm-md-fence-last': { borderBottom: '1px solid var(--border)', borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px', paddingBottom: '12px', marginBottom: '6px' },
    // 围栏行（```js）：文本已隐藏，行高压到 0 —— 代码块背景从内容首行开始（Obsidian 式）
    '.cm-line.cm-md-fence-hidden': { lineHeight: '0px', fontSize: '0px', paddingTop: '0', paddingBottom: '0' },
    // 分隔线 ---：隐藏文本，行 border-top 画线（对齐 .md-view hr 的间距感）
    '.cm-line.cm-md-hr-line': { borderTop: '1px solid var(--border-mid)', lineHeight: '0px', fontSize: '0px', marginTop: '9px', marginBottom: '9px' },
    // 表格逐行线框（Obsidian 式：不整块 widget，光标可直接进任意行编辑）
    '.cm-line.cm-md-tr': {
      borderLeft: '1px solid var(--border-mid)', borderRight: '1px solid var(--border-mid)',
      paddingLeft: '10px', paddingRight: '10px', paddingTop: '3px', paddingBottom: '3px',
    },
    '.cm-line.cm-md-tr-head': { borderTop: '1px solid var(--border-mid)', background: 'var(--bg-panel)', color: 'var(--text-bright)', fontWeight: '600', marginTop: '4px' },
    '.cm-line.cm-md-tr-last': { borderBottom: '1px solid var(--border-mid)', marginBottom: '6px' },
    '.cm-line.cm-md-tr-sep': { lineHeight: '0px', fontSize: '0px', paddingTop: '0', paddingBottom: '0' },
    '.cm-md-pipe': { color: 'var(--text-dim)' },
  });

  // ---------- 图片 widget：![alt](src) → 内联 <img> ----------
  class ImgWidget extends WidgetType {
    constructor(src, alt) { super(); this.src = src; this.alt = alt; }
    eq(other) { return other.src === this.src && other.alt === this.alt; }
    toDOM() {
      const wrap = document.createElement('span');
      wrap.className = 'cm-md-img';
      const img = document.createElement('img');
      img.src = resolveImgSrc(this.src);
      img.alt = this.alt || '';
      img.draggable = false;
      wrap.appendChild(img);
      return wrap;
    }
    ignoreEvent() { return false; }
  }

  // ---------- 分隔线 / 围栏隐藏 / 表格：不用 block widget ----------
  // block replace 会吞掉换行符：紧邻行的 line 装饰失效、紧跟的空行整个消失
  // （块后间距塌陷 + 行号错位）。改为「普通 replace 隐藏文本 + line 类画样式」，
  // 所有行边界保留 —— 与 Obsidian 的实现思路一致。

  // ---------- task checkbox widget：- [ ] / - [x] → 勾选框 ----------
  class TaskWidget extends WidgetType {
    constructor(done) { super(); this.done = done; }
    eq(other) { return other.done === this.done; }
    toDOM() {
      const d = document.createElement('span');
      d.className = 'cm-md-task' + (this.done ? ' done' : '');
      return d;
    }
    ignoreEvent() { return false; }
  }

  // 相对路径 → file:///（以笔记所在目录为基准）
  function resolveImgSrc(src) {
    const s = String(src || '').trim();
    if (!s || /^(https?:|data:|blob:|file:)/i.test(s)) return s;
    return 'file:///' + (MdEditor.__baseDir ? String(MdEditor.__baseDir).replace(/\\/g, '/') + '/' : '') + s.split('\\').join('/');
  }

  // ---------- Live Preview decoration 构建 ----------
  // 规则：光标行不装饰（显示源码）；其余行隐藏标记 + 内容加渲染样式
  // 块级元素（代码块/表格/分隔线）全部用「普通 replace + line 类」渲染 ——
  // 不用 block widget（吞换行符会导致：相邻行 line 装饰失效、紧跟空行消失、
  // 行号错位）。单一 ViewPlugin 提供全部装饰，无需 StateField 双轨。

  // 内联装饰（ViewPlugin 用）
  // Obsidian 核心行为：光标行保留渲染样式、只显示源码标记；
  // 非光标行隐藏标记。因此「样式 mark / 行类」对所有行生效，
  // 「标记隐藏 / URL 隐藏 / 图片 widget / task checkbox / 空行压缩」仅非光标行。
  function buildDecorations(view) {
    // 先序遍历会先 add 父节点内部范围、再 add 子节点标记 → 直接用 RangeSetBuilder
    // 会因乱序抛 "Ranges must be added sorted"（异常被吞 → 装饰丢失，live 预览退化为源码）。
    // 改为数组收集 + Decoration.set(…, true) 统一排序。
    const decos = [];
    const doc = view.state.doc;
    // Obsidian 式「标记粒度」显示模型（取代旧的行粒度"光标行=源码"）：
    //   1. 行级构造（标题#/引用>/围栏行/分隔线/表格分隔行）→ 光标落在该行才显示源码；
    //   2. 行内标记（** ~~ ` 等）→ 仅光标紧邻该标记（前后 1 字符内）或选区完整
    //      落在标记内部时才显形 —— 光标在同行其他位置、拖选跨段时一律保持渲染态
    //      （消除整行闪源码 / 多行选择闪烁）；
    //   3. 链接/图片整构造 → 光标在构造内部时显示完整源码（Obsidian 编辑链接的行为）。
    const sel = view.state.selection.main;
    const selFrom = Math.min(sel.from, sel.to), selTo = Math.max(sel.from, sel.to);
    const selFromLine = doc.lineAt(selFrom), selToLine = doc.lineAt(selTo);
    const isCursor = selFrom === selTo; // 空选区 = 光标

    // 行级构造判定：光标/选区与该行相交
    const onLine = (pos) => {
      const l = doc.lineAt(pos);
      return !(l.to < selFromLine.from || l.from > selToLine.to);
    };
    // 行内标记判定：光标紧邻标记（间隙 ∈ [from, to]，含标记前/内部/标记后三个贴身位）
    // 或选区完整落在标记内部；否则保持隐藏
    const revealsMark = (from, to) =>
      isCursor ? (selFrom >= from && selFrom <= to) : (selFrom >= from && selTo <= to);
    // 构造判定（链接/图片）：光标在构造内部（非边界）或选区完整落在构造内
    const revealsConstruct = (from, to) =>
      isCursor ? (selFrom > from && selFrom < to) : (selFrom >= from && selTo <= to);

    // 确保语法树解析到文档末尾（CM6 分片解析是异步的：初始/滚动后未解析区域的
    // 装饰会缺失 → live 预览局部退化成源码）。给 30ms 预算：小文档同步补全，
    // 大文档解析推进后 CM6 会再触发 update 刷新装饰。
    try { Language.ensureSyntaxTree(view.state, doc.length, 30); } catch {}
    // 装饰不依赖 visibleRanges（viewport）：全文档遍历（树已解析时遍历成本极低），
    // 滚动零重建、视口外装饰常驻 —— 消除滚动时的"源码闪烁"。
    // 先收集围栏代码块范围：块内空行不压缩（保持背景连续）、块内 "- " 不是列表
    const fenceRanges = [];
    try {
      Language.syntaxTree(view.state).iterate({
        from: 0, to: doc.length,
        enter: (node) => {
          if (node.name === 'FencedCode') { fenceRanges.push([node.from, node.to]); return false; }
        },
      });
    } catch {}
    const inFence = (pos) => fenceRanges.some(([a, b]) => pos >= a && pos <= b);
    {
      const from = 0, to = doc.length;
      // ---- 行级预处理：空行压缩 / task checkbox / 列表标记弱化（不依赖语法树、与光标无关） ----
      // Obsidian 行为：bullet 常显但弱化、task 勾选框任何时候都是渲染态（可直接点击）——
      // 不再随光标位置切换，消除光标扫过列表行时的源码/渲染跳变。
      let pos = from;
      while (pos < to) {
        const l = doc.lineAt(pos);
        if (!inFence(l.from)) {
          if (!l.text.trim()) {
            decos.push(Decoration.line({ class: 'cm-md-blank' }).range(l.from));
          } else {
            const m = /^(\s*)([-*+]|\d+\.)( +)/.exec(l.text);
            if (m) {
              // bullet 弱化（常显）
              const bFrom = l.from + m[1].length;
              decos.push(Decoration.mark({ class: 'cm-md-listmark' }).range(bFrom, bFrom + m[2].length));
              // task checkbox：- [ ] / - [x] → 勾选框（连尾随空格一起替换，避免渲染态双空格）
              const t = /^(\s*)([-*+]|\d+\.)( +)\[( |x|X)\]( |$)/.exec(l.text);
              if (t) {
                const cbFrom = l.from + t[1].length + t[2].length + t[3].length;
                const cbTo = cbFrom + 3 + (t[5] === ' ' ? 1 : 0);
                decos.push(Decoration.replace({ widget: new TaskWidget(t[4] !== ' ') }).range(cbFrom, cbTo));
              }
            }
          }
        }
        pos = l.to + 1;
      }

      Language.syntaxTree(view.state).iterate({
        from, to,
        enter: (node) => {
          const name = node.name;
          const parent = node.node.parent;
          const parentName = parent ? parent.name : '';
          try {
            // ---- 块级元素（全部行级渲染，无 block widget） ----
            // 围栏代码块：围栏行隐藏+压缩（非光标行），内容行背景块（所有行）
            if (name === 'FencedCode') {
              const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
              for (let n = first.number; n <= last.number; n++) {
                const l = doc.line(n);
                if (/^\s*(```|~~~)/.test(l.text)) {
                  // 围栏行：普通 replace 隐藏文本 + line 类压到 0 高（不吞换行）
                  // 行级规则：光标落在围栏行本身才展开（内容行编辑时围栏保持折叠 —— Obsidian 行为）
                  if (!onLine(l.from)) {
                    decos.push(Decoration.replace({}).range(l.from, l.to));
                    decos.push(Decoration.line({ class: 'cm-md-fence-hidden' }).range(l.from));
                  }
                } else {
                  decos.push(Decoration.line({ class: 'cm-md-fence-line' }).range(l.from));
                }
              }
              for (let n = first.number + 1; n < last.number; n++) {
                if (/^\s*(```|~~~)/.test(doc.line(n).text)) continue;
                decos.push(Decoration.line({ class: 'cm-md-fence-first' }).range(doc.line(n).from));
                break;
              }
              for (let n = last.number - 1; n > first.number; n--) {
                if (/^\s*(```|~~~)/.test(doc.line(n).text)) continue;
                decos.push(Decoration.line({ class: 'cm-md-fence-last' }).range(doc.line(n).from));
                break;
              }
              return;
            }
            // 分隔线 ---：隐藏文本 + 行 border-top 画线（光标落在该行才显示源码）
            if (name === 'HorizontalRule') {
              const l = doc.lineAt(node.from);
              if (!onLine(l.from)) {
                decos.push(Decoration.replace({}).range(l.from, l.to));
                decos.push(Decoration.line({ class: 'cm-md-hr-line' }).range(l.from));
              }
              return;
            }
            // 表格：逐行线框渲染（Obsidian 做法 —— 不整块 widget 化）。
            // 表头行背景+上边框、数据行侧边框、末行下边框、分隔行隐藏压缩、| 常显弱化。
            // 光标进单元格时行保持线框渲染（不再整行退化成源码 —— Obsidian 行为）。
            if (name === 'Table') {
              const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
              for (let n = first.number; n <= last.number; n++) {
                const l = doc.line(n);
                if (/^[\s|:\-]+$/.test(l.text)) {
                  // 分隔行 | --- | --- |：隐藏 + 压缩（光标落在分隔行本身才显示源码）
                  if (!onLine(l.from)) {
                    decos.push(Decoration.replace({}).range(l.from, l.to));
                    decos.push(Decoration.line({ class: 'cm-md-tr-sep' }).range(l.from));
                  }
                } else {
                  let cls = 'cm-md-tr';
                  if (n === first.number) cls += ' cm-md-tr-head';
                  if (n === last.number) cls += ' cm-md-tr-last';
                  decos.push(Decoration.line({ class: cls }).range(l.from));
                  // | 分隔符弱化（常显 —— Obsidian 表格竖线不隐藏）
                  for (let i = 0; i < l.text.length; i++) {
                    if (l.text[i] === '|') decos.push(Decoration.mark({ class: 'cm-md-pipe' }).range(l.from + i, l.from + i + 1));
                  }
                }
              }
              return;
            }
            // 引用块：行级左竖线（光标行也保留竖线 —— Obsidian 行为）
            if (name === 'Blockquote') {
              const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
              for (let n = first.number; n <= last.number; n++) {
                const l = doc.line(n);
                decos.push(Decoration.line({ class: 'cm-md-quote-line' }).range(l.from));
              }
              decos.push(Decoration.line({ class: 'cm-md-quote-first' }).range(first.from));
              decos.push(Decoration.line({ class: 'cm-md-quote-last' }).range(last.from));
              return;
            }
            // 图片：整块替换为 img widget（构造粒度 —— 光标不在构造内部时）
            if (name === 'Image' && !revealsConstruct(node.from, node.to)) {
              const src = doc.sliceString(node.from, node.to);
              const m = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(src);
              if (m) {
                decos.push(Decoration.replace({
                  widget: new ImgWidget(m[2], m[1]),
                }).range(node.from, node.to));
                return;
              }
            }
            // 标记隐藏：HeaderMark(#)/EmphasisMark(** *)/StrikethroughMark(~~)/
            // CodeMark(` 围栏)/LinkMark([]())/QuoteMark(>)。
            // 注意：lezer-markdown 中删除线标记节点名是 StrikethroughMark（非 EmphasisMark）。
            // 显形规则（标记粒度显示模型）：
            //   HeaderMark/QuoteMark → 行级：光标落在该行
            //   EmphasisMark/StrikethroughMark/CodeMark → 标记级：光标紧邻该标记
            //   LinkMark → 标记级 或 光标在所属 Link 构造内部（Obsidian：点进链接显示完整源码）
            if (/^(HeaderMark|EmphasisMark|StrikethroughMark|CodeMark|LinkMark|QuoteMark)$/.test(name)) {
              // 围栏代码块内的 CodeMark：围栏行已被整行 replace 隐藏，跳过（防嵌套 replace 冲突）
              if (name === 'CodeMark' && parentName === 'FencedCode') return;
              let show;
              if (name === 'HeaderMark' || name === 'QuoteMark') {
                show = onLine(node.from); // 行级构造
              } else if (name === 'LinkMark') {
                const pl = parent; // 所属 Link 构造
                show = revealsMark(node.from, node.to) || (pl && pl.name === 'Link' && revealsConstruct(pl.from, pl.to));
              } else {
                show = revealsMark(node.from, node.to); // 行内标记：仅紧邻显形
              }
              if (!show) {
                const text = doc.sliceString(node.from, node.to);
                if (!text.trim()) return; // 空白不处理
                // 标题/引用标记：连同后面的空格一起隐藏 ——
                // 否则渲染态残留前导空格（" 标题"/" 引用"），视觉多一层缩进
                let hideEnd = node.to;
                if (name === 'HeaderMark' || name === 'QuoteMark') {
                  if (doc.sliceString(hideEnd, hideEnd + 1) === ' ') hideEnd += 1;
                }
                decos.push(Decoration.replace({}).range(node.from, hideEnd));
              }
              return;
            }
            // 链接目标 URL（Link 的 (url) 部分）：光标在所属 Link 构造内部时显示（可编辑目标）
            if (name === 'URL') {
              const pl = parent;
              if (!(pl && pl.name === 'Link' && revealsConstruct(pl.from, pl.to))) {
                decos.push(Decoration.replace({}).range(node.from, node.to));
              }
              return;
            }
            // 内容样式：标题/加粗/斜体/删除线/行内代码/链接文字
            // 所有行生效（光标行保留样式 —— Obsidian 行为）
            {
              if (/^ATXHeading[1-6]$/.test(name)) {
                const h = name.slice(-1);
                let start = node.from;
                // 跳过 HeaderMark（已隐藏），从文本起加样式
                const first = node.node.firstChild;
                if (first && first.name === 'HeaderMark') start = first.to;
                if (start < node.to) decos.push(Decoration.mark({ class: 'cm-md-h' + h }).range(start, node.to));
                // 标题行高 + 边框（h1/h2 有下边框）
                decos.push(Decoration.line({ class: 'cm-md-h' + h + '-line' }).range(doc.lineAt(node.from).from));
              } else if (name === 'StrongEmphasis' || name === 'Emphasis') {
                const cls = name === 'StrongEmphasis' ? 'cm-md-strong' : 'cm-md-em';
                let start = node.from, end = node.to;
                const f = node.node.firstChild, l = node.node.lastChild;
                if (f && f.name === 'EmphasisMark') start = f.to;
                if (l && l.name === 'EmphasisMark' && l.from > start) end = l.from;
                if (start < end) decos.push(Decoration.mark({ class: cls }).range(start, end));
              } else if (name === 'Strikethrough') {
                // mark 只覆盖内容（跳过首尾 ~~ 标记）—— 光标行标记可见时样式不覆盖标记
                let start = node.from, end = node.to;
                const f = node.node.firstChild, l = node.node.lastChild;
                if (f && f.name === 'StrikethroughMark') start = f.to;
                if (l && l.name === 'StrikethroughMark' && l.from > start) end = l.from;
                if (start < end) decos.push(Decoration.mark({ class: 'cm-md-strike' }).range(start, end));
              } else if (name === 'InlineCode') {
                decos.push(Decoration.mark({ class: 'cm-md-code' }).range(node.from, node.to));
              } else if (name === 'Link' && parentName !== 'Image') {
                decos.push(Decoration.mark({ class: 'cm-md-link' }).range(node.from, node.to));
              }
            }
          } catch (e) { /* 装饰构建失败不影响编辑 */ }
        },
      });
    }
    return Decoration.set(decos, true);
  }

  const livePlugin = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = buildDecorations(view); }
    update(u) {
      // 只在影响装饰的变化时重建（文档/选区/视口）——
      // 无条件重建会让每次 measure 都全文档扫描，大文件输入卡顿
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = buildDecorations(u);
    }
  }, {
    decorations: (v) => v.decorations,
    eventHandlers: {
      // 链接点击（渲染态）：Ctrl/Cmd+点击 或 修饰键 → 打开；普通点击进入编辑
      mousedown(e, view) {
        if (!(e.ctrlKey || e.metaKey)) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const node = Language.syntaxTree(view.state).resolveInner(pos, -1);
        let target = null;
        for (let n = node; n; n = n.parent) {
          if (n.name === 'Link' || n.name === 'Image') { target = n; break; }
        }
        if (!target) return false;
        const raw = view.state.doc.sliceString(target.from, target.to);
        if (n_isWiki(raw)) return false;
        const href = extractHref(raw);
        if (href && window.MdEditor.__openLink) {
          e.preventDefault();
          MdEditor.__openLink(href);
          return true;
        }
        return false;
      },
    },
  });

  // ---------- wiki 链接与 URL 提取 ----------
  function n_isWiki(raw) { return /\[\[/.test(raw); }
  function extractHref(raw) {
    const m = /^!?\[([^\]]*)\]\(([^)]*)\)/.exec(raw);
    return m ? m[2] : null;
  }

  // ---------- 格式快捷键：选中文字包装/解包（Ctrl+B/I/H/K） ----------
  function wrapSelection(view, before, after) {
    const { state } = view;
    const changes = state.changeByRange((range) => {
      const pre = state.sliceDoc(Math.max(0, range.from - before.length), range.from);
      const post = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + after.length));
      // 已被包裹 → 解包（toggle）
      if (pre === before && post === after) {
        return {
          changes: [
            { from: range.from - before.length, to: range.from },
            { from: range.to, to: range.to + after.length },
          ],
          range: State.EditorSelection.range(range.from - before.length, range.to - before.length),
        };
      }
      return {
        changes: [
          { from: range.from, insert: before },
          { from: range.to, insert: after },
        ],
        range: State.EditorSelection.range(range.from + before.length, range.to + before.length),
      };
    });
    view.dispatch(changes, { scrollIntoView: true, userEvent: 'input.format' });
    return true;
  }

  // Ctrl+K：无选区插入 [](（光标在括号中)；有选区包 [x]()
  function linkSelection(view) {
    const { state } = view;
    const range = state.selection.main;
    if (range.empty) {
      view.dispatch({
        changes: { from: range.from, insert: '[]()' },
        selection: { anchor: range.from + 1 },
        scrollIntoView: true,
      });
    } else {
      const sel = state.sliceDoc(range.from, range.to);
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: '[' + sel + ']()' },
        selection: { anchor: range.to + 3 },
        scrollIntoView: true,
      });
    }
    return true;
  }

  // ---------- 列表/引用续行（Enter） ----------
  function listContinue(view) {
    const { state } = view;
    const range = state.selection.main;
    if (!range.empty) return false;
    const line = state.doc.lineAt(range.from);
    const m = /^(\s*)([-*+] |\d+\. |> )/.exec(line.text);
    if (!m) return false;
    const rest = line.text.slice(m[0].length);
    // 空项回车 → 清空前缀退出列表
    if (!rest.trim()) {
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '' }, scrollIntoView: true });
      return true;
    }
    // 有序列表编号递增
    const prefix = /^(\d+)\./.test(m[2]) ? (parseInt(m[2], 10) + 1) + '. ' : m[2];
    const insert = '\n' + m[1] + prefix;
    view.dispatch({
      changes: { from: range.from, insert },
      selection: { anchor: range.from + insert.length },
      scrollIntoView: true,
    });
    return true;
  }

  // Markdown 专用 keymap（优先于默认 keymap）
  const mdKeymap = keymap.of([
    { key: 'Mod-b', run: (v) => wrapSelection(v, '**', '**') },
    { key: 'Mod-i', run: (v) => wrapSelection(v, '*', '*') },
    { key: 'Mod-h', run: (v) => wrapSelection(v, '==', '==') },
    { key: 'Mod-k', run: (v) => linkSelection(v) },
    { key: 'Enter', run: listContinue },
  ]);

  // ---------- Live Preview 开关（Compartment） ----------
  const liveComp = new Compartment();

  function baseExtensions(opts) {
    const ext = [
      Commands.history(),
      mdKeymap,
      View.drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      Language.syntaxHighlighting(Language.defaultHighlightStyle, { fallback: true }),
      Language.bracketMatching(),
      Md.markdown({ base: Md.markdownLanguage }),
      baseTheme,
      liveTheme,
      keymap.of([
        ...Autocomplete.closeBracketsKeymap,
        ...Commands.defaultKeymap,
        ...Search.searchKeymap,
        ...Commands.historyKeymap,
        ...Autocomplete.completionKeymap,
        Commands.indentWithTab,
      ]),
      Autocomplete.closeBrackets(),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && opts.onChange) opts.onChange(u.state.doc.toString());
        if ((u.docChanged || u.selectionSet) && opts.onCursor) {
          const head = u.state.selection.main.head;
          const before = u.state.doc.sliceString(0, head);
          const line = before.split('\n').length;
          const col = head - before.lastIndexOf('\n');
          opts.onCursor(line, col, head);
        }
      }),
    ];
    return ext;
  }

  function create(opts) {
    const parent = opts.parent;
    const liveOn = opts.live !== false;
    // live 开启时的扩展集：单一 ViewPlugin 提供全部装饰（行级渲染，无 block widget）
    const liveExts = [livePlugin];
    // 支持复用旧 EditorState（标签/模式切换时保留撤销历史）
    const state = opts.state || EditorState.create({
      doc: opts.doc || '',
      extensions: [
        ...baseExtensions(opts),
        liveComp.of(liveOn ? liveExts : []),
      ],
    });
    const view = new EditorView({ state, parent });
    if (opts.state) {
      // 复用 state 后按需调整 live 开关
      view.dispatch({ effects: liveComp.reconfigure(liveOn ? liveExts : []) });
    }

    return {
      view,
      focus() { view.focus(); },
      getValue() { return view.state.doc.toString(); },
      getState() { return view.state; },
      setValue(text) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: String(text == null ? '' : text) },
        });
      },
      setLive(on) {
        view.dispatch({ effects: liveComp.reconfigure(on ? liveExts : []) });
      },
      // 大纲跳转：光标移到指定行并滚动到可视区（live/source 模式用）
      gotoLine(line) {
        const n = Math.max(1, Math.min(line, view.state.doc.lines));
        const l = view.state.doc.line(n);
        view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
        view.focus();
      },
      // 精确置光标/选区（测试用：验证标记粒度显形）
      setCursor(pos, head) {
        const p = Math.max(0, Math.min(pos, view.state.doc.length));
        const h = head == null ? p : Math.max(0, Math.min(head, view.state.doc.length));
        view.dispatch({ selection: { anchor: p, head: h } });
      },
      find() { try { Search.openSearchPanel(view); } catch {} },
      destroy() { try { view.destroy(); } catch {} },
    };
  }

  return { create, resolveImgSrc };
})();

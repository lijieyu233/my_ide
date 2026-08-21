// md-editor.js —— CodeMirror 6 Markdown 编辑器（Obsidian 式 Live Preview）
// 依赖 renderer/vendor/cm6-bundle.min.js（全局 CM6）
// 文档模型始终是纯 Markdown；Live Preview 只是装饰层：
//   光标所在行显示源码标记，其余行隐藏标记并按渲染样式显示。
window.MdEditor = (() => {
  const CM = window.CM6;
  if (!CM) return null;
  const { State, View, Language, Commands, Md, Autocomplete, Search } = CM;
  const { Decoration, ViewPlugin, WidgetType, EditorView, keymap } = View;
  const { Compartment, EditorState } = State;

  // ---------- 主题（CSS 变量适配四主题） ----------
  const baseTheme = EditorView.theme({
    '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--editor-text)', fontSize: 'var(--editor-font-size, 13px)' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7', overflow: 'auto', paddingLeft: '28px', paddingRight: '20px' },
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

  // Live Preview 渲染态样式 —— 与 .md-view 预览样式系统性对齐（字号/边框/背景/行距同源）
  const liveTheme = EditorView.theme({
    // 标题字号（对齐 .md-view h1 22px / h2 18px / h3 15px，正文 13px）
    '.cm-md-h1': { fontSize: '1.7em', fontWeight: '700', color: 'var(--text-bright)', lineHeight: '1.3' },
    '.cm-md-h2': { fontSize: '1.4em', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.3' },
    '.cm-md-h3': { fontSize: '1.16em', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.35' },
    '.cm-md-h4': { fontSize: '1.08em', fontWeight: '600', color: 'var(--text-bright)' },
    '.cm-md-h5': { fontSize: '1em', fontWeight: '600', color: 'var(--text-bright)' },
    '.cm-md-h6': { fontSize: '1em', fontWeight: '500', color: 'var(--text-dim)' },
    // 标题行下边框（对齐 .md-view h1/h2 border-bottom）
    '.cm-line.cm-md-h1-line': { borderBottom: '1px solid var(--border)', paddingBottom: '5px', marginTop: '6px' },
    '.cm-line.cm-md-h2-line': { borderBottom: '1px solid var(--border)', paddingBottom: '3px', marginTop: '4px' },
    '.cm-md-strong': { fontWeight: '700' },
    '.cm-md-em': { fontStyle: 'italic' },
    '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--text-dim)' },
    '.cm-md-highlight': { backgroundColor: 'var(--bg-selected)', borderRadius: '2px' },
    // 行内代码（对齐 .md-view code：btn-bg 背景 + 圆角 + 内边距）
    '.cm-md-code': {
      fontFamily: 'var(--font-mono)', backgroundColor: 'var(--btn-bg)', color: 'var(--code-text)',
      borderRadius: '3px', padding: '0 5px', fontSize: '0.92em',
    },
    '.cm-md-link': { color: 'var(--accent)', cursor: 'pointer' },
    '.cm-md-img': { display: 'inline-block', verticalAlign: 'middle' },
    '.cm-md-img img': { maxWidth: '100%', borderRadius: '4px' },
    // 引用块（对齐 .md-view blockquote：左竖线 + 弱化色）
    '.cm-line.cm-md-quote-line': { borderLeft: '3px solid var(--accent)', paddingLeft: '12px', color: 'var(--text-dim)' },
    // 围栏代码块（对齐 .md-view pre：背景块 + 边框 + 圆角）
    '.cm-line.cm-md-fence-line': {
      backgroundColor: 'var(--code-bg)', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)',
      fontFamily: 'var(--font-mono)', fontSize: '0.95em', padding: '0 12px',
    },
    '.cm-line.cm-md-fence-first': { borderTop: '1px solid var(--border)', borderTopLeftRadius: '6px', borderTopRightRadius: '6px', paddingTop: '6px', marginTop: '4px' },
    '.cm-line.cm-md-fence-last': { borderBottom: '1px solid var(--border)', borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px', paddingBottom: '6px', marginBottom: '4px' },
    // 分隔线 widget（对齐 .md-view hr）
    '.cm-md-hr': { borderTop: '1px solid var(--border)', margin: '8px 0' },
    // 表格 widget（对齐 .md-view table）
    '.cm-md-table-wrap': { padding: '4px 0', overflowX: 'auto' },
    '.cm-md-table': { borderCollapse: 'collapse' },
    '.cm-md-table th, .cm-md-table td': { border: '1px solid var(--border-mid)', padding: '4px 10px', fontSize: '0.95em' },
    '.cm-md-table th': { background: 'var(--bg-panel)', color: 'var(--text-bright)' },
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

  // ---------- 分隔线 widget：--- → 一条线（对齐 .md-view hr） ----------
  class HrWidget extends WidgetType {
    eq() { return true; }
    toDOM() { const d = document.createElement('div'); d.className = 'cm-md-hr'; return d; }
  }

  // ---------- 隐藏整行 widget（围栏 ``` 行隐藏，代码块更像渲染态） ----------
  class HideLineWidget extends WidgetType {
    eq() { return true; }
    toDOM() { const d = document.createElement('div'); d.style.display = 'none'; return d; }
  }

  // ---------- 表格 widget：| a | b | → 渲染表格（对齐 .md-view table） ----------
  class TableWidget extends WidgetType {
    constructor(src) { super(); this.src = src; }
    eq(other) { return other.src === this.src; }
    toDOM() {
      const wrap = document.createElement('div');
      wrap.className = 'cm-md-table-wrap';
      const table = document.createElement('table');
      table.className = 'cm-md-table';
      // 过滤分隔行（| --- | --- |）
      const rows = this.src.split('\n').map((s) => s.trim()).filter((l) => l && !/^[\s|:\-]+$/.test(l));
      rows.forEach((line, idx) => {
        const tr = document.createElement('tr');
        const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|');
        for (const c of cells) {
          const el = document.createElement(idx === 0 ? 'th' : 'td');
          el.textContent = c.trim();
          tr.appendChild(el);
        }
        table.appendChild(tr);
      });
      wrap.appendChild(table);
      return wrap;
    }
    ignoreEvent() { return false; } // 点击表格 → CM 定位光标进表内显示源码
  }

  // 相对路径 → file:///（以笔记所在目录为基准）
  function resolveImgSrc(src) {
    const s = String(src || '').trim();
    if (!s || /^(https?:|data:|blob:|file:)/i.test(s)) return s;
    return 'file:///' + (MdEditor.__baseDir ? String(MdEditor.__baseDir).replace(/\\/g, '/') + '/' : '') + s.split('\\').join('/');
  }

  // ---------- Live Preview decoration 构建 ----------
  // 规则：光标行不装饰（显示源码）；其余行隐藏标记 + 内容加渲染样式
  // 块级元素（代码块/表格/分隔线）光标不在块内时整体渲染，与 preview 视觉对齐。
  // 注意：block 装饰（block: true 的 replace）不能由 ViewPlugin 提供（CM6 限制），
  // 必须走 StateField + EditorView.decorations facet → 拆分为两套构建。

  // 块级装饰（StateField 用，只依赖 state，处理整个文档）
  function buildBlockDecorations(state) {
    const decos = [];
    const cursor = state.selection.main.head;
    const doc = state.doc;
    try {
      Language.syntaxTree(state).iterate({
        from: 0, to: doc.length,
        enter: (node) => {
          const name = node.name;
          try {
            // 分隔线 ---：整行替换为一条线
            if (name === 'HorizontalRule' && !(cursor >= doc.lineAt(node.from).from && cursor <= doc.lineAt(node.from).to)) {
              const l = doc.lineAt(node.from);
              const end = l.to < doc.length ? l.to + 1 : l.to;
              decos.push(Decoration.replace({ widget: new HrWidget(), block: true }).range(l.from, end));
              return;
            }
            // 围栏代码块：``` 行隐藏 + 内容行背景块（行级样式走内联装饰）
            if (name === 'FencedCode' && !(cursor > node.from && cursor < node.to)) {
              const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
              for (let n = first.number; n <= last.number; n++) {
                const l = doc.line(n);
                if (/^\s*(```|~~~)/.test(l.text)) {
                  const end = l.to < doc.length ? l.to + 1 : l.to;
                  decos.push(Decoration.replace({ widget: new HideLineWidget(), block: true }).range(l.from, end));
                }
              }
              return;
            }
            // 表格：整块替换为渲染表格
            if (name === 'Table' && !(cursor > node.from && cursor < node.to)) {
              const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
              const end = last.to < doc.length ? last.to + 1 : last.to;
              decos.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(node.from, node.to)), block: true }).range(first.from, end));
              return;
            }
          } catch (e) { /* 单节点失败不影响整体 */ }
        },
      });
    } catch (e) { /* 装饰构建失败不影响编辑 */ }
    return Decoration.set(decos, true);
  }

  // 内联装饰（ViewPlugin 用，依赖 visibleRanges 优化可视区）
  function buildDecorations(view) {
    // 先序遍历会先 add 父节点内部范围、再 add 子节点标记 → 直接用 RangeSetBuilder
    // 会因乱序抛 "Ranges must be added sorted"（异常被吞 → 装饰丢失，live 预览退化为源码）。
    // 改为数组收集 + Decoration.set(…, true) 统一排序。
    const decos = [];
    const cursor = view.state.selection.main.head;
    const doc = view.state.doc;
    const cursorLine = doc.lineAt(cursor);

    const onCursorLine = (pos) => {
      const l = doc.lineAt(pos);
      return cursorLine.from <= l.to && cursorLine.to >= l.from; // 光标行 = 节点行
    };
    const inTable = (n) => {
      for (let p = n.node.parent; p; p = p.parent) if (p.name === 'Table') return true;
      return false;
    };

    // jsdom 等无布局环境：visibleRanges 缺失时回退全文档范围
    const ranges = (view.visibleRanges && view.visibleRanges.length)
      ? view.visibleRanges
      : [{ from: 0, to: doc.length }];
    for (const { from, to } of ranges) {
      Language.syntaxTree(view.state).iterate({
        from, to,
        enter: (node) => {
          const name = node.name;
          const parent = node.node.parent;
          const parentName = parent ? parent.name : '';
          try {
            // ---- 块级行样式（block replace 已由 StateField 处理，这里只加行级类） ----
            // 围栏代码块内容行：背景块 + 首尾圆角
            if (name === 'FencedCode' && !(cursor > node.from && cursor < node.to)) {
              const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
              for (let n = first.number; n <= last.number; n++) {
                const l = doc.line(n);
                if (!/^\s*(```|~~~)/.test(l.text)) decos.push(Decoration.line({ class: 'cm-md-fence-line' }).range(l.from));
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
            // 引用块：行级左竖线（对齐 .md-view blockquote）
            if (name === 'Blockquote') {
              const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
              for (let n = first.number; n <= last.number; n++) {
                const l = doc.line(n);
                if (!onCursorLine(l.from)) decos.push(Decoration.line({ class: 'cm-md-quote-line' }).range(l.from));
              }
              return;
            }
            // 图片：整块替换为 img widget（光标不在行内时）
            if (name === 'Image' && !onCursorLine(node.from)) {
              const src = doc.sliceString(node.from, node.to);
              const m = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(src);
              if (m) {
                decos.push(Decoration.replace({
                  widget: new ImgWidget(m[2], m[1]),
                }).range(node.from, node.to));
                return;
              }
            }
            // 标记隐藏：HeaderMark(#)/EmphasisMark(** * ~~ ==)/CodeMark(` 围栏)/LinkMark([]())
            if (/^(HeaderMark|EmphasisMark|CodeMark|LinkMark|QuoteMark|ListMark)$/.test(name) && !onCursorLine(node.from)) {
              // 围栏代码块内的 CodeMark：块级渲染已隐藏整行，跳过
              if (name === 'CodeMark' && parentName === 'FencedCode') return;
              // 列表标记保留可见（弱化由样式处理），不隐藏
              if (name === 'ListMark') return;
              const text = doc.sliceString(node.from, node.to);
              if (!text.trim()) return; // 空白不处理
              decos.push(Decoration.replace({}).range(node.from, node.to));
              return;
            }
            // 链接目标 URL（Link 的 (url) 部分）：光标不在行内时隐藏
            if (name === 'URL' && !onCursorLine(node.from)) {
              decos.push(Decoration.replace({}).range(node.from, node.to));
              return;
            }
            // 内容样式：标题/加粗/斜体/删除线/行内代码/链接文字
            if (!onCursorLine(node.from) && !inTable(node)) {
              if (/^ATXHeading[1-6]$/.test(name)) {
                const h = name.slice(-1);
                let start = node.from;
                // 跳过 HeaderMark（已隐藏），从文本起加样式
                const first = node.node.firstChild;
                if (first && first.name === 'HeaderMark') start = first.to;
                if (start < node.to) decos.push(Decoration.mark({ class: 'cm-md-h' + h }).range(start, node.to));
                // 标题行下边框（h1/h2）
                if (h === '1' || h === '2') decos.push(Decoration.line({ class: 'cm-md-h' + h + '-line' }).range(doc.lineAt(node.from).from));
              } else if (name === 'StrongEmphasis' || name === 'Emphasis') {
                const cls = name === 'StrongEmphasis' ? 'cm-md-strong' : 'cm-md-em';
                let start = node.from, end = node.to;
                const f = node.node.firstChild, l = node.node.lastChild;
                if (f && f.name === 'EmphasisMark') start = f.to;
                if (l && l.name === 'EmphasisMark' && l.from > start) end = l.from;
                if (start < end) decos.push(Decoration.mark({ class: cls }).range(start, end));
              } else if (name === 'Strikethrough') {
                decos.push(Decoration.mark({ class: 'cm-md-strike' }).range(node.from, node.to));
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
    update(u) { this.decorations = buildDecorations(u); }
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

  // ---------- 块级装饰 StateField（block 装饰必须走 facet，不能走 plugin） ----------
  const blockDecoField = State.StateField.define({
    create(state) { return buildBlockDecorations(state); },
    update(value, tr) {
      // 文档或选择变化时重建（光标进/出块需要切换渲染态）
      if (tr.docChanged || tr.selection) return buildBlockDecorations(tr.state);
      return value.map(tr.changes);
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
      blockDecoField, // 块级装饰 field 始终注册（facet 提供者按 live 开关挂载）
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
    // live 开启时的扩展集：内联装饰 plugin + 块级装饰 facet（field 本体在 baseExtensions 注册）
    const liveExts = [livePlugin, EditorView.decorations.from(blockDecoField)];
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
      find() { try { Search.openSearchPanel(view); } catch {} },
      destroy() { try { view.destroy(); } catch {} },
    };
  }

  return { create, resolveImgSrc };
})();

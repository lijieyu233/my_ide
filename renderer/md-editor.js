// md-editor.js —— CodeMirror 6 Markdown 编辑器（Obsidian 式 Live Preview）
// 依赖 renderer/vendor/cm6-bundle.min.js（全局 CM6）
// 文档模型始终是纯 Markdown；Live Preview 只是装饰层：
//   光标所在行显示源码标记，其余行隐藏标记并按渲染样式显示。
window.MdEditor = (() => {
  const CM = window.CM6;
  if (!CM) return null;
  const { State, View, Language, Commands, Md, Autocomplete, Search } = CM;
  const { Decoration, ViewPlugin, WidgetType, EditorView, keymap } = View;
  const { RangeSetBuilder, Compartment, EditorState } = State;

  // ---------- 主题（CSS 变量适配四主题） ----------
  const baseTheme = EditorView.theme({
    '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--editor-text)', fontSize: 'var(--editor-font-size, 13px)' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto', paddingLeft: '8px', paddingRight: '14px' },
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

  // Live Preview 渲染态样式（标记被隐藏后的内容样式）
  const liveTheme = EditorView.theme({
    '.cm-md-h1': { fontSize: '1.7em', fontWeight: '700', color: 'var(--text-bright)', lineHeight: '1.3' },
    '.cm-md-h2': { fontSize: '1.45em', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.3' },
    '.cm-md-h3': { fontSize: '1.25em', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.35' },
    '.cm-md-h4': { fontSize: '1.1em', fontWeight: '600', color: 'var(--text-bright)' },
    '.cm-md-h5': { fontSize: '1em', fontWeight: '600', color: 'var(--text-bright)' },
    '.cm-md-h6': { fontSize: '1em', fontWeight: '500', color: 'var(--text-dim)' },
    '.cm-md-strong': { fontWeight: '700', color: 'var(--text-bright)' },
    '.cm-md-em': { fontStyle: 'italic' },
    '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--text-dim)' },
    '.cm-md-highlight': { backgroundColor: 'var(--bg-selected)', borderRadius: '2px' },
    '.cm-md-code': {
      fontFamily: 'var(--font-mono)', backgroundColor: 'var(--code-bg)', color: 'var(--code-text)',
      borderRadius: '3px', padding: '0 3px', fontSize: '0.92em',
    },
    '.cm-md-link': { color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' },
    '.cm-md-img': { display: 'inline-block', verticalAlign: 'middle' },
    '.cm-md-img img': { maxWidth: '100%', borderRadius: '4px' },
    '.cm-md-quote': { color: 'var(--text-dim)', fontStyle: 'italic' },
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

  // 相对路径 → file:///（以笔记所在目录为基准）
  function resolveImgSrc(src) {
    const s = String(src || '').trim();
    if (!s || /^(https?:|data:|blob:|file:)/i.test(s)) return s;
    return 'file:///' + (MdEditor.__baseDir ? String(MdEditor.__baseDir).replace(/\\/g, '/') + '/' : '') + s.split('\\').join('/');
  }

  // ---------- Live Preview decoration 构建 ----------
  // 规则：光标行不装饰（显示源码）；其余行隐藏标记 + 内容加渲染样式
  function buildDecorations(view) {
    const builder = new RangeSetBuilder();
    const cursor = view.state.selection.main.head;
    const doc = view.state.doc;
    const cursorLine = doc.lineAt(cursor);

    const onCursorLine = (pos) => {
      const l = doc.lineAt(pos);
      return cursorLine.from <= l.to && cursorLine.to >= l.from; // 光标行 = 节点行
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
            // 图片：整块替换为 img widget（光标不在行内时）
            if (name === 'Image' && !onCursorLine(node.from)) {
              const src = doc.sliceString(node.from, node.to);
              const m = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(src);
              if (m) {
                builder.add(node.from, node.to, Decoration.replace({
                  widget: new ImgWidget(m[2], m[1]),
                }));
                return;
              }
            }
            // 标记隐藏：HeaderMark(#)/EmphasisMark(** * ~~ ==)/CodeMark(` 围栏)/LinkMark([]())
            if (/^(HeaderMark|EmphasisMark|CodeMark|LinkMark|QuoteMark|ListMark)$/.test(name) && !onCursorLine(node.from)) {
              // 围栏行（FencedCode 内的 CodeMark）→ 光标不在整个代码块内才隐藏
              if (name === 'CodeMark' && parentName === 'FencedCode') {
                if (cursor > parent.from && cursor < parent.to) return; // 光标在代码块内
              }
              // 列表标记保留可见（弱化由样式处理），不隐藏
              if (name === 'ListMark') return;
              // 引用标记 > 保留可见
              if (name === 'QuoteMark') return;
              const text = doc.sliceString(node.from, node.to);
              if (!text.trim()) return; // 空白不处理
              builder.add(node.from, node.to, Decoration.replace({}));
              return;
            }
            // 链接目标 URL（Link 的 (url) 部分）：光标不在行内时隐藏
            if (name === 'URL' && !onCursorLine(node.from)) {
              builder.add(node.from, node.to, Decoration.replace({}));
              return;
            }
            // 内容样式：标题/加粗/斜体/删除线/行内代码/链接文字
            if (!onCursorLine(node.from)) {
              if (/^ATXHeading[1-6]$/.test(name)) {
                const h = name.slice(-1);
                let start = node.from;
                // 跳过 HeaderMark（已隐藏），从文本起加样式
                const first = node.node.firstChild;
                if (first && first.name === 'HeaderMark') start = first.to;
                if (start < node.to) builder.add(start, node.to, Decoration.mark({ class: 'cm-md-h' + h }));
              } else if (name === 'StrongEmphasis' || name === 'Emphasis') {
                const cls = name === 'StrongEmphasis' ? 'cm-md-strong' : 'cm-md-em';
                let start = node.from, end = node.to;
                const f = node.node.firstChild, l = node.node.lastChild;
                if (f && f.name === 'EmphasisMark') start = f.to;
                if (l && l.name === 'EmphasisMark' && l.from > start) end = l.from;
                if (start < end) builder.add(start, end, Decoration.mark({ class: cls }));
              } else if (name === 'Strikethrough') {
                builder.add(node.from, node.to, Decoration.mark({ class: 'cm-md-strike' }));
              } else if (name === 'InlineCode') {
                builder.add(node.from, node.to, Decoration.mark({ class: 'cm-md-code' }));
              } else if (name === 'Link' && parentName !== 'Image') {
                builder.add(node.from, node.to, Decoration.mark({ class: 'cm-md-link' }));
              } else if (name === 'Blockquote') {
                builder.add(node.from, node.to, Decoration.mark({ class: 'cm-md-quote' }));
              }
            }
          } catch (e) { /* 装饰构建失败不影响编辑 */ }
        },
      });
    }
    return builder.finish();
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
    // 支持复用旧 EditorState（标签/模式切换时保留撤销历史）
    const state = opts.state || EditorState.create({
      doc: opts.doc || '',
      extensions: [
        ...baseExtensions(opts),
        liveComp.of(liveOn ? [livePlugin] : []),
      ],
    });
    const view = new EditorView({ state, parent });
    if (opts.state) {
      // 复用 state 后按需调整 live 开关
      view.dispatch({ effects: liveComp.reconfigure(liveOn ? [livePlugin] : []) });
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
        view.dispatch({ effects: liveComp.reconfigure(on ? [livePlugin] : []) });
      },
      find() { try { Search.openSearchPanel(view); } catch {} },
      destroy() { try { view.destroy(); } catch {} },
    };
  }

  return { create, resolveImgSrc };
})();

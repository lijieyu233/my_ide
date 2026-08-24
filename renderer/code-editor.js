// code-editor.js —— CodeMirror 6 代码文件编辑器（.js/.py/.css/... 语法高亮）
// 依赖 renderer/vendor/cm6-bundle.min.js（全局 CM6）
// 与 md-editor.js 同一 CM6 基座：One Dark 高亮配色 + 主题 CSS 变量适配。
// API 形状与 MdEditor.create 一致（view/focus/getValue/getState/setValue/gotoLine/find/destroy），
// viewer.js 的 cmApi 管理（状态保存/销毁/搜索）直接复用。
window.CodeEditor = (() => {
  const CM = window.CM6;
  if (!CM) return null;
  const { State, View, Language, Commands, Search, Autocomplete, Highlight, CodeLangs } = CM;
  const { EditorView, keymap } = View;
  const { EditorState } = State;

  // ---------- 语法高亮配色（One Dark，与 md-editor.js / 预览 atom-one-dark 同源） ----------
  const T = Highlight.tags;
  const oneDarkHighlight = Language.HighlightStyle.define([
    { tag: T.keyword, color: '#c678dd' },
    { tag: [T.controlKeyword, T.moduleKeyword], color: '#c678dd' },
    { tag: [T.string, T.special(T.string)], color: '#98c379' },
    { tag: [T.number, T.bool, T.null, T.atom], color: '#d19a66' },
    { tag: T.comment, color: '#7f848e', fontStyle: 'italic' },
    { tag: T.variableName, color: '#e06c75' },
    { tag: T.function(T.variableName), color: '#61afef' },
    { tag: T.definition(T.variableName), color: '#e5c07b' },
    { tag: [T.typeName, T.className], color: '#e5c07b' },
    { tag: T.propertyName, color: '#e06c75' },
    { tag: T.operator, color: '#56b6c2' },
    { tag: [T.punctuation, T.bracket], color: '#abb2bf' },
    { tag: T.tagName, color: '#e06c75' },
    { tag: T.attributeName, color: '#d19a66' },
  ]);

  // ---------- 语言映射（扩展名 → CM6 语言扩展，与围栏代码块 codeLanguages 同源） ----------
  function codeLangOf(ext) {
    switch ((ext || '').toLowerCase()) {
      case 'js': case 'mjs': case 'cjs': case 'jsx': return CodeLangs.javascript();
      case 'ts': case 'tsx': return CodeLangs.javascript({ typescript: true });
      case 'json': return CodeLangs.json();
      case 'css': case 'scss': case 'less': return CodeLangs.css();
      case 'html': case 'htm': case 'xml': case 'svg': case 'vue': case 'svelte': return CodeLangs.html();
      case 'py': return CodeLangs.python();
      case 'java': return CodeLangs.java();
      case 'c': case 'h': case 'cpp': case 'hpp': return CodeLangs.cpp();
      default: return null; // 未知扩展：纯文本（无高亮，仍有行号/编辑能力）
    }
  }

  // ---------- 主题（CSS 变量适配四主题；代码文件用等宽字体 + 行号 gutter） ----------
  const codeTheme = EditorView.theme({
    '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--editor-text)', fontSize: 'var(--editor-font-size, 13px)' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto' },
    '.cm-content': { padding: '8px 0', caretColor: 'var(--accent)' },
    '&.cm-focused': { outline: 'none' },
    // 行号 gutter（对齐旧 .editor-gutter 视觉：右对齐 + 分隔线）
    '.cm-gutters': {
      backgroundColor: 'transparent', color: 'var(--num-dim)', border: 'none',
      borderRight: '1px solid var(--border)', paddingLeft: '6px', paddingRight: '8px',
      userSelect: 'none', textAlign: 'right',
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
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
    '.cm-foldPlaceholder': {
      background: 'var(--btn-bg)', border: 'none', color: 'var(--text-dim)',
      padding: '0 6px', margin: '0 2px', borderRadius: '3px',
    },
  });

  // ---------- 折叠（Ctrl+-/= 单个块，Ctrl+Shift+-/= 全部） ----------
  // 官方 foldCode 仅在折叠块「起始行」生效；自定义：光标在块内任意位置
  // 都能折叠包含它的最内层块（函数/if/类…，VSCode 式体验）
  function foldCurrent(view) {
    const head = view.state.selection.main.head;
    const tree = Language.syntaxTree(view.state);
    if (tree) {
      let node = tree.resolveInner(head, head > 0 ? -1 : 1);
      while (node) {
        const fn = node.type.prop(Language.foldNodeProp);
        if (fn) {
          const r = typeof fn === 'function' ? fn(node) : Language.foldInside(node);
          if (r && r.to > r.from) {
            view.dispatch({ effects: Language.foldEffect.of(r) });
            return true;
          }
        }
        node = node.parent;
      }
    }
    return Language.foldCode(view); // 兜底：光标在起始行（md 标题等）
  }
  // 展开包含光标（或紧邻）的折叠范围
  function unfoldCurrent(view) {
    const head = view.state.selection.main.head;
    const folded = Language.foldedRanges(view.state);
    let found = null;
    folded.between(0, view.state.doc.length, (from, to) => { if (from <= head && to >= head) found = { from, to }; });
    if (!found) folded.between(Math.max(0, head - 1), Math.min(view.state.doc.length, head + 1), (from, to) => { found = { from, to }; });
    if (!found) return Language.unfoldCode(view);
    view.dispatch({ effects: Language.unfoldEffect.of(found) });
    return true;
  }

  // ---------- 创建编辑器 ----------
  function create(opts) {
    const parent = opts.parent;
    const lang = codeLangOf(opts.ext);
    const state = opts.state || EditorState.create({
      doc: opts.doc || '',
      extensions: [
        View.lineNumbers(),
        View.highlightActiveLineGutter(),
        View.highlightActiveLine(),
        Commands.history(),
        Language.foldGutter(),
        Language.indentOnInput(),
        Language.bracketMatching(),
        Language.syntaxHighlighting(oneDarkHighlight),
        View.rectangularSelection(),
        codeTheme,
        keymap.of([
          // Ctrl+-/= 折叠/展开当前块；Ctrl+Shift+-/= 全部折叠/展开
          // （Shift 变体的事件 key 是 '+' / '_'，绑定写法须与之对应）
          { key: 'Mod--', preventDefault: true, run: foldCurrent },
          { key: 'Mod-=', preventDefault: true, run: unfoldCurrent },
          { key: 'Mod-_', preventDefault: true, run: Language.foldAll },
          { key: 'Mod-+', preventDefault: true, run: Language.unfoldAll },
          ...Autocomplete.closeBracketsKeymap,
          ...Commands.defaultKeymap,
          ...Search.searchKeymap,
          ...Commands.historyKeymap,
          ...Autocomplete.completionKeymap,
          Commands.indentWithTab,
          { key: 'Mod-s', preventDefault: true, run: () => { if (opts.onSave) opts.onSave(); return true; } },
        ]),
        Autocomplete.closeBrackets(),
        Search.search({ top: true }), // Ctrl+F / Ctrl+H 搜索面板置顶
        lang || [],
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
      ],
    });
    const view = new EditorView({ state, parent });
    // 关闭 Chromium 拼写检查（代码文件不需要下划线拼写提示）
    view.contentDOM.spellcheck = false;
    view.contentDOM.setAttribute('autocorrect', 'off');
    view.contentDOM.setAttribute('autocapitalize', 'off');

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
      gotoLine(line) {
        const n = Math.max(1, Math.min(line, view.state.doc.lines));
        const l = view.state.doc.line(n);
        view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
        view.focus();
      },
      // 精确置光标/选区（测试用：与 MdEditor 同款接口）
      setCursor(pos, head) {
        const p = Math.max(0, Math.min(pos, view.state.doc.length));
        const h = head == null ? p : Math.max(0, Math.min(head, view.state.doc.length));
        view.dispatch({ selection: { anchor: p, head: h } });
      },
      // 读当前选区（测试用）
      getSelection() {
        const s = view.state.selection.main;
        return { from: s.from, to: s.to, head: s.head };
      },
      find() { try { Search.openSearchPanel(view); } catch {} },
      destroy() { try { view.destroy(); } catch {} },
    };
  }

  return { create };
})();
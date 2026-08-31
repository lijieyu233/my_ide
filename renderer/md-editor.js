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
  const { State, View, Language, Commands, Md, Autocomplete, Search, Highlight, CodeLangs } = CM;
  const { Decoration, ViewPlugin, WidgetType, EditorView, keymap } = View;
  const { Compartment, EditorState } = State;

  // ---------- 代码语法高亮（One Dark 配色，与预览的 atom-one-dark 同源） ----------
  // 覆盖 CM6 defaultHighlightStyle（它给 heading 注入 underline —— 已定位的下划线根因）
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
    // markdown 结构 token（live 装饰已处理视觉，这里给低调色兜底 source 模式）
    { tag: T.heading, color: '#e06c75', fontWeight: 'bold' },
    { tag: T.strong, fontWeight: 'bold', color: '#abb2bf' },
    { tag: T.emphasis, fontStyle: 'italic' },
    { tag: T.link, color: '#61afef' },
    { tag: T.monospace, color: '#98c379' },
    { tag: T.strikethrough, textDecoration: 'line-through' },
  ]);

  // 围栏代码块语言（```js / ```python / ...）：LanguageDescription 懒加载
  const codeLanguages = [
    { name: 'javascript', alias: ['js', 'jsx', 'mjs', 'cjs'], load: async () => CodeLangs.javascript() },
    { name: 'typescript', alias: ['ts', 'tsx'], load: async () => CodeLangs.javascript({ typescript: true }) },
    { name: 'python', alias: ['py'], load: async () => CodeLangs.python() },
    { name: 'java', load: async () => CodeLangs.java() },
    { name: 'css', alias: ['scss'], load: async () => CodeLangs.css() },
    { name: 'html', alias: ['xml', 'svg'], load: async () => CodeLangs.html() },
    { name: 'json', load: async () => CodeLangs.json() },
    { name: 'cpp', alias: ['c', 'c++', 'hpp'], load: async () => CodeLangs.cpp() },
  ].map((d) => Language.LanguageDescription.of(d));

  // ---------- 主题（CSS 变量适配四主题） ----------
  const baseTheme = EditorView.theme({
    // 清除 CM6 defaultHighlightStyle 给 heading token 的 text-decoration: underline
    // （用户报告的"下划线"根因）。只匹配 CM6 高亮 token 的自动 class（ͼ 前缀），
    // 不碰自有的 cm-md-* class —— 删除线 line-through 不受影响
    '& .cm-content [class^="ͼ"]': { textDecorationLine: 'none' },
    '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--editor-text)', fontSize: 'var(--editor-font-size, 13px)' },
    // 正文用 UI 无衬线字体 —— 与 .md-view 预览同源（Obsidian 编辑态也是 UI 字体，非等宽）
    '.cm-scroller': { fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif', lineHeight: '1.7', overflow: 'auto', paddingLeft: '28px', paddingRight: '20px' },
    '.cm-content': { padding: '10px 0', caretColor: 'var(--accent)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': { display: 'none' },
    // activeLine / searchMatch 背景必须画在 ::before(z:-3)：drawSelection 的
    // selectionLayer z=-2 在内容之下，元素自身背景会盖住选区高亮
    '.cm-activeLine': { position: 'relative' },
    '.cm-activeLine::before': { content: '""', position: 'absolute', inset: '0', zIndex: '-3', backgroundColor: 'rgba(127,127,127,0.07)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--bg-selected) !important' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-panels': { backgroundColor: 'var(--panel-strong)', color: 'var(--text)', borderColor: 'var(--border)' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': {
      background: 'var(--bg-input)', color: 'var(--text)', border: '1px solid var(--btn-border)', borderRadius: '3px',
    },
    '.cm-panel.cm-search button:hover': { background: 'var(--btn-hover)' },
    '.cm-searchMatch': { position: 'relative' },
    '.cm-searchMatch::before': { content: '""', position: 'absolute', inset: '0', zIndex: '-3', backgroundColor: 'var(--bg-selected)' },
    '.cm-searchMatch-selected': { position: 'relative', color: '#fff' },
    '.cm-searchMatch-selected::before': { content: '""', position: 'absolute', inset: '0', zIndex: '-3', backgroundColor: 'var(--accent)' },
  });

  // Live Preview 渲染态样式 —— 与 .md-view 预览逐项同源对齐
  // 字号取 .md-view 的绝对值（h1 26 / h2 22 / h3 18 / h4 15 / 正文 13px，与 styles.css 同步调大）
  const liveTheme = EditorView.theme({
    // ===== 选区可见性修复（老问题根因）=====
    // CM6 drawSelection 的 selectionLayer z-index=-2，绘制在 .cm-content 之下：
    // 行级/行内装饰的背景·边框若直接设在 .cm-line / mark 元素上，会盖住选区高亮
    // （表格、代码块、==高亮==、行内代码内选中无颜色的根因）。
    // 统一方案：背景/边框全部移到 z-index:-3 的 ::before 上 —— 绘制顺序变为
    // 装饰背景(-3) → 选区(-2) → 文字(最上层)，视觉零变化且选区全格式可见。
    '.cm-line.cm-md-tr-head, .cm-line.cm-md-tr-row, .cm-line.cm-md-tr-sep, .cm-line.cm-md-fence-line, .cm-line.cm-md-quote-line': { position: 'relative' },
    '.cm-line.cm-md-tr-head::before, .cm-line.cm-md-tr-row::before, .cm-line.cm-md-tr-sep::before, .cm-line.cm-md-fence-line::before, .cm-line.cm-md-quote-line::before': {
      content: '""', position: 'absolute', inset: '0', zIndex: '-3',
    },
    // 标题内容样式（光标行也保留字号，只显示源码标记 —— Obsidian 行为）
    '.cm-md-h1': { fontSize: '26px', fontWeight: '700', color: 'var(--text-bright)', lineHeight: '1.35' },
    '.cm-md-h2': { fontSize: '22px', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.35' },
    '.cm-md-h3': { fontSize: '18px', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.4' },
    '.cm-md-h4': { fontSize: '15px', fontWeight: '600', color: 'var(--text-bright)' },
    '.cm-md-h5': { fontSize: '13px', fontWeight: '600', color: 'var(--text-bright)' },
    '.cm-md-h6': { fontSize: '13px', fontWeight: '500', color: 'var(--text-dim)' },
    // 标题行：行高 + padding 模拟 .md-view margin 18px 0 8px（叠加空行压缩后的间距）
    // Obsidian 默认主题标题无下划线（GitHub 风格才有）—— 不加 border-bottom
    '.cm-line.cm-md-h1-line': { paddingTop: '10px', paddingBottom: '5px' },
    '.cm-line.cm-md-h2-line': { paddingTop: '8px', paddingBottom: '3px' },
    '.cm-line.cm-md-h3-line': { paddingTop: '5px' },
    '.cm-line.cm-md-h4-line, .cm-line.cm-md-h5-line, .cm-line.cm-md-h6-line': { paddingTop: '3px' },
    // 空行压缩：段落间空行不再占整行高（对齐 .md-view p margin 8px 的视觉间隙）
    '.cm-line.cm-md-blank': { lineHeight: '0.9' },
    '.cm-md-strong': { fontWeight: '700', color: 'var(--text-bright)' },
    '.cm-md-em': { fontStyle: 'italic' },
    '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--text-dim)' },
    // ==高亮== / 行内代码：背景画在 ::before(z:-3)，选区在文字下、高亮在选区下均可见
    '.cm-md-highlight': { position: 'relative' },
    '.cm-md-highlight::before': {
      content: '""', position: 'absolute', inset: '0', zIndex: '-3',
      backgroundColor: 'var(--bg-selected)', borderRadius: '2px',
    },
    // 行内代码（对齐 .md-view code：12px + padding 1px 5px + btn-bg 背景）
    '.cm-md-code': {
      position: 'relative', fontFamily: 'var(--font-mono)', color: 'var(--code-text)',
      padding: '1px 5px', fontSize: '12px',
    },
    '.cm-md-code::before': {
      content: '""', position: 'absolute', inset: '0', zIndex: '-3',
      backgroundColor: 'var(--btn-bg)', borderRadius: '3px',
    },
    '.cm-md-link': { color: 'var(--accent)', cursor: 'pointer' },
    '.cm-md-img': { display: 'inline-block', verticalAlign: 'middle' },
    '.cm-md-img img': { maxWidth: '100%', borderRadius: '4px' },
    // 图片加载失败占位（不显示裂图 —— 明确可见的图名提示）
    '.cm-md-img-broken': {
      display: 'inline-block', padding: '4px 10px', border: '1px dashed var(--border-mid)',
      borderRadius: '4px', color: 'var(--text-dim)', fontSize: '12px', verticalAlign: 'middle',
    },
    // 列表标记弱化（Obsidian 式：bullet 变暗，内容正常色）
    '.cm-md-listmark': { color: 'var(--text-dim)' },
    // 无序 bullet 圆点（Obsidian 式 • 渲染，替换源码 -/+/*）
    '.cm-md-bullet': {
      display: 'inline-block', width: '16px', textAlign: 'center',
      color: 'var(--text-dim)', verticalAlign: 'middle', userSelect: 'none',
    },
    // 有序编号小间距
    '.cm-md-listnum': { display: 'inline-block', minWidth: '16px' },
    // task checkbox（对齐 preview 渲染的 input[type=checkbox] 视觉）
    '.cm-md-task': {
      display: 'inline-block', width: '13px', height: '13px',
      border: '1.5px solid var(--text-dim)', borderRadius: '3px',
      verticalAlign: 'middle', margin: '0 5px 0 1px', position: 'relative',
    },
    '.cm-md-task.done': { borderColor: 'var(--accent)' },
    '.cm-md-task.done::before': {
      content: '""', position: 'absolute', inset: '0', zIndex: '-3',
      background: 'var(--accent)', borderRadius: '2px',
    },
    '.cm-md-task.done::after': {
      content: '""', position: 'absolute', left: '3.5px', top: '0px',
      width: '4px', height: '8px', border: 'solid #fff', borderWidth: '0 2px 2px 0',
      transform: 'rotate(45deg)',
    },
    // 引用块（对齐 .md-view blockquote：左竖线 + 弱化色 + 上下间距）
    '.cm-line.cm-md-quote-line': {
      paddingLeft: '12px',
      color: 'var(--text-dim)', paddingTop: '2px', paddingBottom: '2px',
    },
    '.cm-line.cm-md-quote-line::before': { borderLeft: '3px solid var(--accent)' },
    '.cm-line.cm-md-quote-first': { paddingTop: '8px' },
    '.cm-line.cm-md-quote-last': { paddingBottom: '8px' },
    // 围栏代码块（对齐 .md-view pre：背景块 + 圆角 6 + padding 12 + 12.5px/1.6）
    // 注意：全部用 padding 不用 margin —— CM6 行高测量不含 margin，margin 会让
    // heightmap 与 DOM 错位 → 点击偏移（fence-first/last 同理）
    // 背景/边框画在 ::before(z:-3)，选区可见（见 liveTheme 头部注释）
    '.cm-line.cm-md-fence-line': {
      fontFamily: 'var(--font-mono)', fontSize: '12.5px', lineHeight: '1.6', padding: '1px 12px',
    },
    '.cm-line.cm-md-fence-line::before': {
      backgroundColor: 'var(--code-bg)', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)',
    },
    '.cm-line.cm-md-fence-first': { paddingTop: '12px', position: 'relative' },
    '.cm-line.cm-md-fence-first::before': { borderTop: '1px solid var(--border)', borderTopLeftRadius: '6px', borderTopRightRadius: '6px' },
    // 代码块复制按钮（hover 浮现右上角：语言名 + 复制）
    '.cm-md-copybtn': {
      position: 'absolute', right: '10px', top: '5px', display: 'flex', alignItems: 'center', gap: '6px',
      opacity: '0', transition: 'opacity .12s', zIndex: '5',
    },
    '.cm-line.cm-md-fence-first:hover .cm-md-copybtn': { opacity: '1' },
    '.cm-md-copybtn-lang': {
      fontSize: '10px', color: 'var(--text-dim)', textTransform: 'uppercase',
      letterSpacing: '0.5px', userSelect: 'none',
    },
    '.cm-md-copybtn button': {
      fontSize: '11px', padding: '1px 9px', background: 'var(--btn-bg)', color: 'var(--text)',
      border: '1px solid var(--btn-border)', borderRadius: '3px', cursor: 'pointer', lineHeight: '1.5',
    },
    '.cm-md-copybtn button:hover': { background: 'var(--btn-hover)' },
    '.cm-line.cm-md-fence-last': { paddingBottom: '12px' },
    '.cm-line.cm-md-fence-last::before': { borderBottom: '1px solid var(--border)', borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px' },
    // 分隔线 ---：文本替换为 1px 线 widget（行高不变 —— 行高压 0 会让 CM6 高度
    // 模型错位导致点击偏移），间距用行 padding 表达
    '.cm-line.cm-md-hr-line': { paddingTop: '9px', paddingBottom: '9px' },
    '.cm-md-hr': { position: 'relative', display: 'inline-block', width: '100%', height: '1px', verticalAlign: 'middle' },
    '.cm-md-hr::before': { content: '""', position: 'absolute', inset: '0', zIndex: '-3', background: 'var(--border-mid)' },
    // 表格逐行线框（Obsidian 式行常渲染：光标进单元格不整块退化源码）
    // 表头行/数据行 = 行背景+边框+左右 padding；分隔行 block replace 后压成 2px 细线
    // 背景/边框在 ::before(z:-3)——表格内选区可见（老问题根因修复）
    '.cm-line.cm-md-tr-head': { color: 'var(--text-bright)', fontWeight: '600', padding: '3px 10px' },
    '.cm-line.cm-md-tr-head::before': {
      background: 'var(--bg-panel)', border: '1px solid var(--border-mid)', borderBottom: 'none',
      borderRadius: '6px 6px 0 0',
    },
    '.cm-line.cm-md-tr-row': { padding: '3px 10px' },
    '.cm-line.cm-md-tr-row::before': { background: 'var(--code-bg)', border: '1px solid var(--border-mid)', borderTop: 'none' },
    '.cm-line.cm-md-tr-row.cm-md-tr-last::before': { borderRadius: '0 0 6px 6px' },
    '.cm-line.cm-md-tr-sep': { height: '2px', padding: '0' },
    '.cm-line.cm-md-tr-sep::before': { background: 'var(--border-mid)' },
    '.cm-md-tpipe': { opacity: '0.35', color: 'var(--text-dim)' },
    // mermaid 实时渲染图（block widget）：居中 + 背景容器
    '.cm-md-mermaid': { position: 'relative', padding: '10px', textAlign: 'center', margin: '6px 0' },
    '.cm-md-mermaid::before': { content: '""', position: 'absolute', inset: '0', zIndex: '-3', background: 'var(--code-bg)', borderRadius: '6px' },
    '.cm-md-mermaid svg': { maxWidth: '100%' },
    '.cm-md-mermaid .mermaid-err': { textAlign: 'left', color: 'var(--del-text)', whiteSpace: 'pre-wrap' },
    // 标题折叠箭头（Obsidian 式）：hover 标题行浮现，已折叠时常显 ▸
    '.cm-md-foldctrl': {
      display: 'inline-block', width: '18px', textAlign: 'center', fontSize: '10px',
      color: 'var(--text-dim)', cursor: 'pointer', userSelect: 'none', verticalAlign: 'middle',
      marginLeft: '-18px', opacity: '0', transition: 'opacity .1s',
    },
    '.cm-line:hover .cm-md-foldctrl, .cm-md-foldctrl.folded': { opacity: '1' },
    '.cm-md-foldctrl:hover': { color: 'var(--accent)' },
    // 折叠占位符样式（CM6 foldWidget 默认 "…"，弱化显示）
    '.cm-foldPlaceholder': {
      background: 'var(--btn-bg)', border: '1px solid var(--btn-border)', color: 'var(--text-dim)',
      borderRadius: '3px', margin: '0 3px', padding: '0 6px', fontSize: '11px', cursor: 'pointer',
    },
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
      // 加载失败（路径错/网络图不存在）：隐藏裂图 → 虚线占位框显示 alt/文件名
      img.addEventListener('error', () => {
        img.style.display = 'none';
        if (wrap.querySelector('.cm-md-img-broken')) return;
        const ph = document.createElement('span');
        ph.className = 'cm-md-img-broken';
        ph.textContent = '🖼 ' + (this.alt || this.src);
        wrap.appendChild(ph);
      });
      wrap.appendChild(img);
      return wrap;
    }
    ignoreEvent() { return false; }
  }

  // ---------- 无序 bullet 圆点 widget：-/+/* + 空格 → • ----------
  class BulletWidget extends WidgetType {
    eq() { return true; }
    toDOM() {
      const s = document.createElement('span');
      s.className = 'cm-md-bullet';
      s.textContent = '•';
      return s;
    }
    ignoreEvent() { return false; }
  }

  // ---------- 分隔线 widget：--- → 1px 水平线（行高不变，防止高度模型错位） ----------
  class HrWidget extends WidgetType {
    constructor(h) { super(); this.h = h || 1; }
    eq(other) { return other.h === this.h; }
    toDOM() {
      const d = document.createElement('span');
      d.className = 'cm-md-hr';
      if (this.h !== 1) d.style.height = this.h + 'px';
      return d;
    }
    ignoreEvent() { return false; }
  }

  // ---------- 标题折叠箭头 widget（Obsidian 式）：▾ 展开态 / ▸ 折叠态 ----------
  // 点击折叠该标题节（到下一个同级/更高级标题前），折叠切换由 foldEffect 驱动，
  // liveField 监听 fold/unfold effect 重建装饰 → 箭头方向同步翻转。
  class FoldCtrlWidget extends WidgetType {
    constructor(from, to) { super(); this.from = from; this.to = to; }
    eq(other) { return other.from === this.from && other.to === this.to; }
    toDOM(view) {
      const b = document.createElement('span');
      let folded = false;
      try {
        // 当前折叠范围是否完整覆盖本节（from/to 是内容范围：标题行末+1 → 节末行末）
        Language.foldedRanges(view.state).between(this.from - 1, this.to, (f, t) => {
          if (f <= this.from && t >= this.to) folded = true;
        });
      } catch {}
      b.className = 'cm-md-foldctrl' + (folded ? ' folded' : '');
      b.textContent = folded ? '▸' : '▾';
      b.title = folded ? '展开此节' : '收起此节';
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (folded) view.dispatch({ effects: Language.unfoldEffect.of({ from: this.from, to: this.to }) });
        else view.dispatch({ effects: Language.foldEffect.of({ from: this.from, to: this.to }) });
      });
      return b;
    }
    ignoreEvent() { return true; } // 点击由自身处理
  }

  // ---------- 表格：逐行线框渲染（见装饰器 Table 分支），无 widget ----------

  // ---------- Mermaid 图 widget（```mermaid 围栏 → SVG 实时渲染） ----------
  // 光标不在块内：整块替换为渲染图；光标进入：回退源码编辑（Obsidian 同款交互）。
  // 渲染结果按 code 缓存（图不闪烁）；mermaid 库缺失（如测试环境）→ 不渲染，保持源码。
  const mermaidCache = new Map(); // code -> svg string（含失败标记 null）
  class MermaidWidget extends WidgetType {
    constructor(code) { super(); this.code = code; }
    eq(other) { return other.code === this.code; }
    toDOM() {
      const wrap = document.createElement('div');
      wrap.className = 'cm-md-mermaid';
      const cached = mermaidCache.get(this.code);
      if (cached != null) { wrap.innerHTML = cached; return wrap; }
      wrap.textContent = '渲染中…';
      (async () => {
        try {
          if (!window.mermaid || !mermaid.render) throw new Error('mermaid 未加载');
          const id = 'mmd-lp-' + Math.random().toString(36).slice(2);
          const { svg } = await mermaid.render(id, this.code);
          mermaidCache.set(this.code, svg);
          if (wrap.isConnected) wrap.innerHTML = svg;
        } catch (e) {
          const msg = String((e && e.message) || e);
          mermaidCache.set(this.code, null);
          if (wrap.isConnected) wrap.innerHTML = '<pre class="mermaid-err">mermaid 渲染失败: ' + msg.replace(/</g, '&lt;') + '</pre>';
        }
      })();
      return wrap;
    }
    ignoreEvent() { return true; }
  }

  // ---------- 代码块复制/运行按钮 widget（fence 首内容行行首，absolute 右上浮层） ----------
  // 可运行语言（run:code IPC 同款映射）：点「▶ 运行」写临时文件并在新 cmd 窗口执行
  const RUNNABLE_LANGS = ['js', 'javascript', 'node', 'py', 'python', 'bat', 'cmd', 'batch', 'powershell', 'ps1', 'pwsh', 'sh', 'bash'];
  class CopyBtnWidget extends WidgetType {
    constructor(code, lang) { super(); this.code = code; this.lang = lang; }
    eq(other) { return other.code === this.code && other.lang === this.lang; }
    toDOM() {
      const s = document.createElement('span');
      s.className = 'cm-md-copybtn';
      const lang = document.createElement('span');
      lang.className = 'cm-md-copybtn-lang';
      lang.textContent = this.lang || 'text';
      const b = document.createElement('button');
      b.textContent = '复制';
      b.title = '复制代码';
      b.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢编辑器焦点
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        let ok = false;
        try { await navigator.clipboard.writeText(this.code); ok = true; } catch {}
        if (!ok) {
          try {
            const ta = document.createElement('textarea');
            ta.value = this.code;
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            ok = document.execCommand('copy');
            ta.remove();
          } catch {}
        }
        b.textContent = ok ? '已复制' : '复制失败';
        setTimeout(() => { b.textContent = '复制'; }, 1200);
      });
      s.appendChild(lang);
      s.appendChild(b);
      // ▶ 运行（仅可执行语言显示）：新开 cmd 窗口执行，窗口保留可看输出
      if (RUNNABLE_LANGS.includes(String(this.lang || '').toLowerCase())) {
        const r = document.createElement('button');
        r.textContent = '▶ 运行';
        r.title = '在新 cmd 窗口中运行此代码块';
        r.addEventListener('mousedown', (e) => e.preventDefault());
        r.addEventListener('click', async (e) => {
          e.stopPropagation();
          r.textContent = '启动中…';
          try {
            const res = await window.myIDE.shell.runCode(this.code, this.lang);
            if (res && res.error) { r.textContent = '失败'; MI.toast('运行失败: ' + res.error, 'err'); }
            else r.textContent = '已运行';
          } catch (err) {
            r.textContent = '失败';
            MI.toast('运行失败: ' + err, 'err');
          }
          setTimeout(() => { r.textContent = '▶ 运行'; }, 1500);
        });
        s.appendChild(r);
      }
      return s;
    }
    ignoreEvent() { return true; }
  }

  // ---------- task checkbox widget：- [ ] / - [x] → 可点击勾选框 ----------
  class TaskWidget extends WidgetType {
    constructor(done, from, to) { super(); this.done = done; this.from = from; this.to = to; }
    eq(other) { return other.done === this.done && other.from === this.from; }
    toDOM(view) {
      const d = document.createElement('span');
      d.className = 'cm-md-task' + (this.done ? ' done' : '');
      d.title = this.done ? '点击标记为未完成' : '点击标记为已完成';
      // 点击直接切换勾选（不进源码态 —— Obsidian 同款交互）
      d.addEventListener('mousedown', (e) => e.preventDefault());
      d.addEventListener('click', () => {
        if (!view) return;
        view.dispatch({ changes: { from: this.from, to: this.to, insert: this.done ? '[ ]' : '[x]' } });
      });
      return d;
    }
    ignoreEvent() { return true; } // 点击由自身处理（切换勾选），不透传 CM6
  }

  // 相对路径 → file:///（以笔记所在目录为基准）
  function resolveImgSrc(src) {
    const s = String(src || '').trim();
    if (!s || /^(https?:|data:|blob:|file:)/i.test(s)) return s;
    return 'file:///' + (MdEditor.__baseDir ? String(MdEditor.__baseDir).replace(/\\/g, '/') + '/' : '') + s.split('\\').join('/');
  }

  // ---------- Live Preview decoration 构建 ----------
  // 规则：光标行不装饰（显示源码）；其余行隐藏标记 + 内容加渲染样式。
  // 块级渲染方式（关键：CM6 高度模型必须与 DOM 一致，否则点击偏移）：
  //   围栏行/表格分隔行 → block replace（含换行符）真移除该行；
  //   表格 → block widget 真表格（光标进入回退源码）；
  //   分隔线 → inline widget 画线（行高不变）；
  //   行间距一律用 padding 不用 margin（CM6 行高测量不含 margin）。
  // 禁止用 CSS line-height:0 压缩行高 —— 0 高行不进 heightmap，点击会系统性偏移。
  // 单一 ViewPlugin 提供全部装饰，无需 StateField 双轨。

  // 装饰构建（StateField 用 —— block 装饰只能来自 state field，CM6 硬性限制）
  // Obsidian 核心行为：光标行保留渲染样式、只显示源码标记；
  // 非光标行隐藏标记。因此「样式 mark / 行类」对所有行生效，
  // 「标记隐藏 / URL 隐藏 / 图片 widget / task checkbox / 空行压缩」仅非光标行。
  function buildDecorations(state) {
    // 先序遍历会先 add 父节点内部范围、再 add 子节点标记 → 直接用 RangeSetBuilder
    // 会因乱序抛 "Ranges must be added sorted"（异常被吞 → 装饰丢失，live 预览退化为源码）。
    // 改为数组收集 + Decoration.set(…, true) 统一排序。
    const decos = [];
    const doc = state.doc;
    // Obsidian 式「标记粒度」显示模型（取代旧的行粒度"光标行=源码"）：
    //   1. 行级构造（标题#/引用>/围栏行/分隔线/表格分隔行）→ 光标落在该行才显示源码；
    //   2. 行内标记（** ~~ ` 等）→ 仅光标紧邻该标记（前后 1 字符内）或选区完整
    //      落在标记内部时才显形 —— 光标在同行其他位置、拖选跨段时一律保持渲染态
    //      （消除整行闪源码 / 多行选择闪烁）；
    //   3. 链接/图片整构造 → 光标在构造内部时显示完整源码（Obsidian 编辑链接的行为）。
    const sel = state.selection.main;
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
    // 大文档由 livePlugin 兜底刷新（解析推进后 dispatch 触发重建）。
    try { Language.ensureSyntaxTree(state, doc.length, 30); } catch {}
    // 装饰不依赖 visibleRanges（viewport）：全文档遍历（树已解析时遍历成本极低），
    // 滚动零重建、视口外装饰常驻 —— 消除滚动时的"源码闪烁"。
    // 先收集围栏代码块范围：块内空行不压缩（保持背景连续）、块内 "- " 不是列表
    const fenceRanges = [];
    try {
      Language.syntaxTree(state).iterate({
        from: 0, to: doc.length,
        enter: (node) => {
          if (node.name === 'FencedCode') { fenceRanges.push([node.from, node.to]); return false; }
        },
      });
    } catch {}
    const inFence = (pos) => fenceRanges.some(([a, b]) => pos >= a && pos <= b);
    {
      const from = 0, to = doc.length;
      // ---- 行级预处理：空行压缩 / task checkbox / 列表 bullet 圆点 / 标题行收集 ----
      // （前四项不依赖语法树、与光标无关）
      // Obsidian 行为：无序 bullet 渲染成 •、task 勾选框任何时候都是渲染态（可直接点击）——
      // 不再随光标位置切换，消除光标扫过列表行时的源码/渲染跳变。
      const headingLines = []; // [{l, level}] —— 标题折叠范围计算用（跳过围栏内 #）
      let pos = from;
      while (pos < to) {
        const l = doc.lineAt(pos);
        if (!inFence(l.from)) {
          const hm = /^(#{1,6})\s/.exec(l.text);
          if (hm) headingLines.push({ l, level: hm[1].length });
          if (!l.text.trim()) {
            decos.push(Decoration.line({ class: 'cm-md-blank' }).range(l.from));
          } else {
            const m = /^(\s*)([-*+]|\d+\.)( +)(?:(\[( |x|X)\])( |$))?/.exec(l.text);
            if (m) {
              const bFrom = l.from + m[1].length;
              const bTo = bFrom + m[2].length + m[3].length; // bullet + 尾随空格
              if (m[4]) {
                // task 行：bullet+空格 → 圆点（用户报告"多渲染了 -"），再接可点击勾选框
                decos.push(Decoration.replace({ widget: new BulletWidget() }).range(bFrom, bTo));
                const cbFrom = bTo;
                const cbTo = cbFrom + 3 + (m[6] === ' ' ? 1 : 0);
                decos.push(Decoration.replace({ widget: new TaskWidget(m[5] !== ' ', cbFrom, cbFrom + 3) }).range(cbFrom, cbTo));
              } else if (/^[-*+]$/.test(m[2])) {
                // 无序列表：-/+/* + 空格 → • 圆点（Obsidian 式渲染）
                decos.push(Decoration.replace({ widget: new BulletWidget() }).range(bFrom, bTo));
              } else {
                // 有序列表：编号保留（弱化显示）
                decos.push(Decoration.mark({ class: 'cm-md-listmark' }).range(bFrom, bFrom + m[2].length));
              }
            }
            // ==高亮==（Obsidian 扩展语法，lezer 无对应节点 → 行级正则处理）：
            // 隐藏首尾 == 标记 + 内容加 cm-md-highlight 背景。光标紧邻时显示源码（标记粒度规则）。
            const hRe = /==(?=\S)([\s\S]*?\S)==/g;
            let hm;
            while ((hm = hRe.exec(l.text))) {
              const mFrom = l.from + hm.index;
              const mTo = mFrom + hm[0].length;
              if (!revealsMark(mFrom, mTo)) {
                decos.push(Decoration.replace({}).range(mFrom, mFrom + 2));
                decos.push(Decoration.replace({}).range(mTo - 2, mTo));
                decos.push(Decoration.mark({ class: 'cm-md-highlight' }).range(mFrom + 2, mTo - 2));
              }
            }
          }
        }
        pos = l.to + 1;
      }

      Language.syntaxTree(state).iterate({
        from, to,
        enter: (node) => {
          const name = node.name;
          const parent = node.node.parent;
          const parentName = parent ? parent.name : '';
          try {
            // ---- 块级元素 ----
            // 围栏代码块：围栏行 block replace（含换行符）真移除 —— CM6 高度模型精确
            // 感知，点击不偏移。光标在代码块内任意行时围栏显示源码（Obsidian：光标
            // 进代码块整块变源码态），内容行保持背景块样式。
            if (name === 'FencedCode') {
              const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
              const cursorIn = !(last.to < selFromLine.from || first.from > selToLine.to);
              // mermaid 块（```mermaid）：光标不在 → 整块 block replace 渲染 SVG；
              // 光标进入 → 走下方普通围栏源码模式（可编辑）。库缺失（测试环境）→ 源码模式
              const langM0 = /^\s*(```|~~~)\s*(\S+)/.exec(first.text);
              const isMermaid = langM0 && langM0[2].toLowerCase() === 'mermaid' && window.mermaid;
              if (isMermaid && !cursorIn) {
                // 去掉首尾围栏行，只传图源码给 mermaid.render
                let code = doc.sliceString(node.from, node.to);
                code = code.replace(/^\s*(```|~~~)\s*\S*[^\n]*\n?/, '').replace(/\n?\s*(```|~~~)\s*$/, '');
                decos.push(Decoration.replace({
                  block: true,
                  widget: new MermaidWidget(code),
                }).range(node.from, node.to));
                return;
              }
              let firstContent = null, lastContent = null;
              for (let n = first.number; n <= last.number; n++) {
                const l = doc.line(n);
                if (/^\s*(```|~~~)/.test(l.text)) {
                  if (!cursorIn) {
                    // 范围不含换行符：block 覆盖 [行首, 行尾]（合法行边界），
                    // 行变空容器（高 0）且下一行行首的 line 装饰不受影响
                    // （含换行符会吞掉下一行行首 → fence-line 等行类失效）
                    decos.push(Decoration.replace({ block: true }).range(l.from, l.to));
                  }
                } else {
                  decos.push(Decoration.line({ class: 'cm-md-fence-line' }).range(l.from));
                  if (!firstContent) firstContent = l;
                  lastContent = l;
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
              // 复制按钮 + 语言名（常显挂首内容行行首，hover 浮现右上角）
              if (firstContent && lastContent) {
                const langM = /^\s*(```|~~~)\s*(\S+)/.exec(first.text);
                const code = doc.sliceString(firstContent.from, lastContent.to);
                decos.push(Decoration.widget({ widget: new CopyBtnWidget(code, langM ? langM[2] : '') }).range(firstContent.from));
              }
              return;
            }
            // 分隔线 ---：文本替换为 1px 线 widget（行高不变，光标落在该行显示源码）
            if (name === 'HorizontalRule') {
              const l = doc.lineAt(node.from);
              if (!onLine(l.from)) {
                decos.push(Decoration.replace({ widget: new HrWidget() }).range(l.from, l.to));
                decos.push(Decoration.line({ class: 'cm-md-hr-line' }).range(l.from));
              }
              return;
            }
            // 表格：逐行线框渲染（Obsidian 式行常渲染）—— 光标进单元格不整块退化源码。
            // 表头行/数据行保持行样式（背景/边框/圆角），| 常显弱化，分隔行压缩成细线。
            if (name === 'Table') {
              const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
              const SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
              for (let n = first.number; n <= last.number; n++) {
                const l = doc.line(n);
                if (SEP_RE.test(l.text)) {
                  // 分隔行：内容替换为细线 widget（行保留 —— block replace 会吞行导致
                  // line class 失效）+ line class 压高度，视觉上是表头下的分隔线
                  decos.push(Decoration.replace({ widget: new HrWidget(2) }).range(l.from, l.to));
                  decos.push(Decoration.line({ class: 'cm-md-tr-sep' }).range(l.from));
                  continue;
                }
                const isHead = n === first.number || SEP_RE.test(doc.line(n + 1).text);
                const cls = isHead ? 'cm-md-tr-head' : 'cm-md-tr-row';
                decos.push(Decoration.line({ class: cls + (n === last.number ? ' cm-md-tr-last' : '') }).range(l.from));
                // | 弱化（跳过 \| 转义）：视觉上是单元格分隔，不再是刺眼的源码竖线
                for (let i = 0; i < l.text.length; i++) {
                  if (l.text[i] === '|' && (i === 0 || l.text[i - 1] !== '\\')) {
                    decos.push(Decoration.mark({ class: 'cm-md-tpipe' }).range(l.from + i, l.from + i + 1));
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
            // 转义 \x（Escape 节点）：渲染态隐藏反斜杠、显示字面字符（Obsidian 行为）。
            // 光标紧邻时显示源码 \*（标记粒度规则）。
            if (name === 'Escape') {
              if (!revealsMark(node.from, node.to)) {
                decos.push(Decoration.replace({}).range(node.from, node.from + 1));
              }
              return;
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
            // URL 节点分三类处理：
            //   1) 裸网址 / <autolink>（parent 非 Link）：常显 + 链接样式（用户报告「网址消失」的根因：
            //      旧逻辑对非 Link 的 URL 一律隐藏 → 裸网址被吞掉只剩两侧空格）
            //   2) Link 内的目标 URL：光标进入构造时显示（可编辑目标），否则隐藏
            //   3) 空文字链接 [](url)：URL 作为显示文字（Obsidian 行为）
            if (name === 'URL') {
              const pl = parent;
              if (!(pl && (pl.name === 'Link' || pl.name === 'Autolink'))) {
                decos.push(Decoration.mark({ class: 'cm-md-link' }).range(node.from, node.to));
                return;
              }
              if (pl.name === 'Autolink') return; // <url>：URL 常显（尖括号由 Autolink 自身隐藏）
              const emptyLabel = /^!?\[\s*\]\(/.test(doc.sliceString(pl.from, pl.to));
              if (!emptyLabel && !revealsConstruct(pl.from, pl.to)) {
                decos.push(Decoration.replace({}).range(node.from, node.to));
              }
              return;
            }
            // <autolink> 的尖括号（Autolink 内的 LinkMark）隐藏，只留 URL 本体
            if (name === 'LinkMark' && parentName === 'Autolink') {
              decos.push(Decoration.replace({}).range(node.from, node.to));
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
                // 折叠箭头（Obsidian 式标题节收起）：范围 = 本标题下一行行首 → 下一
                // 个同级/更高级标题前一行的行末；无内容节（标题紧跟标题）不显示箭头
                const hIdx = headingLines.findIndex((x) => x.l.from === node.from);
                if (hIdx >= 0) {
                  const cur = headingLines[hIdx];
                  let next = null;
                  for (let k = hIdx + 1; k < headingLines.length; k++) {
                    if (headingLines[k].level <= cur.level) { next = headingLines[k]; break; }
                  }
                  const endLine = next ? doc.line(next.l.number - 1) : doc.line(doc.lines);
                  if (endLine.number > cur.l.number) {
                    decos.push(Decoration.widget({
                      widget: new FoldCtrlWidget(cur.l.to + 1, endLine.to),
                      side: -1,
                    }).range(cur.l.from));
                  }
                }
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

  // ---------- 装饰载体：StateField（block 装饰的 CM6 硬性要求） ----------
  // CM6 规定：block replace/block widget 只能由 StateField 提供（ViewPlugin 仅允许
  // 行内装饰 —— "Block decorations may not be specified via plugins"）。
  // StateField 装饰在 transaction 时同步更新，高度模型与 DOM 始终一致 → 点击精确。
  const liveRefresh = State.StateEffect.define();
  const liveField = State.StateField.define({
    create(state) { return buildDecorations(state); },
    update(value, tr) {
      // 折叠/展开也要重建：标题折叠箭头的 ▾/▸ 方向随折叠状态翻转
      const foldToggled = tr.effects.some((e) => e.is(Language.foldEffect) || e.is(Language.unfoldEffect));
      if (tr.docChanged || tr.selection || foldToggled || tr.effects.some((e) => e.is(liveRefresh))) {
        return buildDecorations(tr.state);
      }
      return value;
    },
    provide: (f) => View.EditorView.decorations.from(f),
  });

  // ViewPlugin 只负责：链接 Ctrl+点击 + 语法树后台解析推进后的兜底刷新
  // （大文档：ensureSyntaxTree 30ms 预算未解析完 → 解析推进后这里 dispatch 触发重算）
  const livePlugin = ViewPlugin.fromClass(class {
    constructor() { this._t = 0; }
    update(u) {
      if (u.docChanged || u.selectionSet) return; // StateField 已重算
      if (Language.syntaxTreeAvailable(u.state, u.state.doc.length)) return;
      clearTimeout(this._t);
      this._t = setTimeout(() => {
        try { u.view.dispatch({ effects: liveRefresh.of(null) }); } catch {}
      }, 150);
    }
    destroy() { clearTimeout(this._t); }
  }, {
    eventHandlers: {
      // 链接点击（渲染态）：Ctrl/Cmd+点击 或 修饰键 → 打开；普通点击进入编辑
      mousedown(e, view) {
        if (!(e.ctrlKey || e.metaKey)) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const node = Language.syntaxTree(view.state).resolveInner(pos, -1);
        let target = null;
        for (let n = node; n; n = n.parent) {
          if (n.name === 'Link' || n.name === 'Image' || n.name === 'Autolink') { target = n; break; }
        }
        // 裸网址（URL 节点，无 Link 构造）：直接以 URL 文本为目标
        if (!target && node && node.name === 'URL') {
          const raw = view.state.doc.sliceString(node.from, node.to);
          if (/^https?:\/\//i.test(raw) && window.MdEditor.__openLink) {
            e.preventDefault();
            MdEditor.__openLink(raw);
            return true;
          }
          return false;
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
    // 表格源码行内 Tab → 跳到下一单元格（| 之后）；行尾 Tab 走默认缩进
    {
      key: 'Tab',
      run: (v) => {
        const sel = v.state.selection.main;
        if (!sel.empty) return false;
        const line = v.state.doc.lineAt(sel.head);
        if (!line.text.includes('|')) return false;
        const rel = sel.head - line.from;
        const next = line.text.indexOf('|', rel + 1);
        if (next >= 0 && next < line.text.length - 1) {
          v.dispatch({ selection: { anchor: line.from + next + 1 }, scrollIntoView: true });
          return true;
        }
        return false;
      },
    },
    // Shift+Tab：前一单元格（| 之前）
    {
      key: 'Shift-Tab',
      run: (v) => {
        const sel = v.state.selection.main;
        if (!sel.empty) return false;
        const line = v.state.doc.lineAt(sel.head);
        if (!line.text.includes('|')) return false;
        const rel = sel.head - line.from;
        const prev = line.text.lastIndexOf('|', Math.max(0, rel - 1));
        if (prev > 0) {
          v.dispatch({ selection: { anchor: line.from + prev }, scrollIntoView: true });
          return true;
        }
        return false;
      },
    },
  ]);

  // ---------- Live Preview 开关（Compartment） ----------
  const liveComp = new Compartment();

  // ---------- 折叠（Ctrl+-/= 单个块，Ctrl+Shift+-/= 全部） ----------
  // 官方 foldCode 仅在折叠块「起始行」生效；自定义：光标在块内任意位置
  // 都能折叠包含它的最内层块（md 标题 section 等，VSCode 式体验）
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
    return Language.foldCode(view); // 兜底：光标在起始行
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

  function baseExtensions(opts) {
    const ext = [
      Commands.history(),
      mdKeymap,
      View.drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      Language.syntaxHighlighting(oneDarkHighlight),
      Language.bracketMatching(),
      Md.markdown({ base: Md.markdownLanguage, codeLanguages }),
      baseTheme,
      liveTheme,
      // 粘贴图片（Obsidian 式）：剪贴板含图片 → 写入笔记目录并插入 ![]() 引用
      // MdEditor.__onPasteImage(file) 由 viewer.js 注入（返回相对路径或 null）
      EditorView.domEventHandlers({
        paste(e, view) {
          const items = [...(e.clipboardData ? e.clipboardData.items : [])];
          const imgs = items.filter((it) => it.kind === 'file' && /^image\//.test(it.type));
          if (!imgs.length || typeof MdEditor.__onPasteImage !== 'function') return false;
          e.preventDefault();
          (async () => {
            const inserts = [];
            for (const it of imgs) {
              const f = it.getAsFile();
              if (!f) continue;
              try {
                const rel = await MdEditor.__onPasteImage(f);
                if (rel) inserts.push('![](' + rel + ')\n');
              } catch {}
            }
            if (inserts.length) {
              const pos = view.state.selection.main.head;
              view.dispatch({
                changes: { from: pos, insert: inserts.join('\n') },
                selection: { anchor: pos + inserts.join('\n').length },
                scrollIntoView: true,
              });
            }
          })();
          return true;
        },
      }),
      keymap.of([
        // Ctrl+-/= 折叠/展开当前块；Ctrl+Shift+-/= 全部折叠/展开
        // （Shift 变体的事件 key 是 '+' / '_'，绑定写法须与之对应）
        { key: 'Mod--', preventDefault: true, run: foldCurrent },
        { key: 'Mod-=', preventDefault: true, run: unfoldCurrent },
        { key: 'Mod-_', preventDefault: true, run: Language.foldAll },
        { key: 'Mod-+', preventDefault: true, run: Language.unfoldAll },
        { key: 'Mod-d', preventDefault: true, run: Commands.deleteLine }, // Ctrl+D 删除当前行
        ...Autocomplete.closeBracketsKeymap,
        ...Commands.defaultKeymap,
        ...Search.searchKeymap,
        ...Commands.historyKeymap,
        ...Autocomplete.completionKeymap,
        Commands.indentWithTab,
      ]),
      Autocomplete.closeBrackets(),
      Language.codeFolding(), // foldState（折叠命令依赖）
      Search.search({ top: true }), // Ctrl+F / Ctrl+H 搜索面板置顶
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
    // live 开启时的扩展集：StateField 提供全部装饰（含 block）+ ViewPlugin 事件兜底
    const liveExts = [liveField, livePlugin];
    // 支持复用旧 EditorState（标签/模式切换时保留撤销历史）
    const state = opts.state || EditorState.create({
      doc: opts.doc || '',
      extensions: [
        ...baseExtensions(opts),
        liveComp.of(liveOn ? liveExts : []),
      ],
    });
    const view = new EditorView({ state, parent });
    // 关闭 Chromium 拼写检查（否则英文/代码下标红波浪"下划线"—— Obsidian 同款关闭）
    view.contentDOM.spellcheck = false;
    view.contentDOM.setAttribute('autocorrect', 'off');
    view.contentDOM.setAttribute('autocapitalize', 'off');
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
      // 大纲跳转：光标移到指定行并滚动到可视区中间（live/source 模式用）
      gotoLine(line) {
        const n = Math.max(1, Math.min(line, view.state.doc.lines));
        const l = view.state.doc.line(n);
        view.dispatch({
          selection: { anchor: l.from },
          effects: EditorView.scrollIntoView(l.from, { y: 'center' }),
        });
        view.focus();
      },
      // 按层级收起标题节：n=0 全部展开；n>=1 折叠所有 level>=n 的标题节（外层优先，
      // 嵌套节被外层折叠覆盖不再重复折叠 —— foldState 的 RangeSet 不允许重叠范围）
      foldToLevel(n) {
        const doc = view.state.doc;
        const hs = []; // [{l, level}]（跳过围栏内 #）
        let inFence = false;
        for (let i = 1; i <= doc.lines; i++) {
          const l = doc.line(i);
          if (/^\s*(```|~~~)/.test(l.text)) { inFence = !inFence; continue; }
          if (inFence) continue;
          const m = /^(#{1,6})\s/.exec(l.text);
          if (m) hs.push({ l, level: m[1].length });
        }
        const effects = [];
        // 先清空现有折叠（重放目标层级，避免残留/嵌套混乱）
        Language.foldedRanges(view.state).between(0, doc.length, (from, to) => {
          effects.push(Language.unfoldEffect.of({ from, to }));
        });
        if (n >= 1) {
          let foldEnd = -1;
          for (let i = 0; i < hs.length; i++) {
            const cur = hs[i];
            if (cur.level < n || cur.l.from < foldEnd) continue;
            let next = null;
            for (let k = i + 1; k < hs.length; k++) {
              if (hs[k].level <= cur.level) { next = hs[k]; break; }
            }
            const endLine = next ? doc.line(next.l.number - 1) : doc.line(doc.lines);
            if (endLine.number > cur.l.number) {
              // 范围与 FoldCtrlWidget 一致：标题行末+1 → 节末行行末
              effects.push(Language.foldEffect.of({ from: cur.l.to + 1, to: endLine.to }));
              foldEnd = endLine.to;
            }
          }
        }
        if (effects.length) view.dispatch({ effects });
      },
      // 精确置光标/选区（测试用：验证标记粒度显形）
      setCursor(pos, head) {
        const p = Math.max(0, Math.min(pos, view.state.doc.length));
        const h = head == null ? p : Math.max(0, Math.min(head, view.state.doc.length));
        view.dispatch({ selection: { anchor: p, head: h } });
      },
      // 读当前选区（测试用：点击命中验证）
      getSelection() {
        const s = view.state.selection.main;
        return { from: s.from, to: s.to, head: s.head };
      },
      find() { try { Search.openSearchPanel(view); } catch {} },
      destroy() { try { view.destroy(); } catch {} },
    };
  }

  return { create, resolveImgSrc };
})();

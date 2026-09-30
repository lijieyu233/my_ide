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
    // markdown 结构 token —— 必须走 CSS 变量，不能硬编码 One Dark 色。
    // 踩过：heading 写死 #e06c75（One Dark 红）→ 所有主题下标题永远玫瑰红，
    // 既跟 .cm-md-* 的变量染色打架，换主题也不跟随（用户原话："标题不要全用强调色"）。
    // 代码 token（keyword/string/number…）继续用 One Dark：那是代码配色，本来就该独立于界面主题。
    { tag: T.heading, color: 'var(--md-heading)', fontWeight: 'bold' },
    // 加粗**不另上色**：预览那边 <strong> 继承正文色，只有字重变化 —— 之前这里写
    // --text-bright，同一份文档在实时预览里"加粗的地方更白"，用户看到的就是"文字几乎全是白色"
    { tag: T.strong, fontWeight: 'bold' },
    { tag: T.emphasis, fontStyle: 'italic' },
    { tag: T.link, color: 'var(--accent)' },
    { tag: T.monospace, color: 'var(--code-text)' },
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
    '.cm-scroller': { fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif', lineHeight: '1.7', overflow: 'auto' },
    // 正文列：可读宽度 + 居中（与 .md-view 同一套数字）→ 见 styles.css 的 scroller 规则。
    // 🔴 左右内边距只能是 0：CM6 画整行选区矩形（RectangleMarker.forRange）时，横向边界取
    //   `.cm-content` 的**边框盒** + 首个 .cm-line 的 padding，**不扣 content 自己的左右 padding**
    //   （实测：CM6 的选区几何只读 `.cm-line` 的 paddingLeft/Right）。所以 content 一旦有横向
    //   内边距，选区色块就比正文列左右各宽出这一段 —— 用户原话「选中 UI 覆盖的范围不对」就是它。
    //   列宽上限与左右内边距因此都交给 scroller（它不在 content 的边框盒里，不进选区几何）。
    // 🔴 前景色取 --text（= .md-view 预览正文色），不是 --editor-text：两者多数主题差一档亮度
    //   （crimson 实测 #d8b3c0 vs #e8cdd6），实时预览整体更白 → 用户原话「文字几乎全是白色」。
    '.cm-content': { padding: '22px 0 38px', maxWidth: 'none', margin: '0 auto', caretColor: 'var(--accent)', color: 'var(--text)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': { display: 'none' },
    // activeLine / searchMatch 背景必须画在 ::before(z:-3)：drawSelection 的
    // selectionLayer z=-2 在内容之下，元素自身背景会盖住选区高亮
    '.cm-activeLine': { position: 'relative' },
    '.cm-activeLine::before': { content: '""', position: 'absolute', inset: '0', zIndex: '-3', backgroundColor: 'rgba(127,127,127,0.07)' },
    // 选区颜色：不能用 --bg-selected（#2d4f6b 实心蓝）。跨行选中时 CM6 会给**每一行**
    // 画一整条（含行尾空白与空行），实心重色叠起来就是用户截图里那条 818px 的"大蓝块"，
    // 看起来像渲染坏了。改成主题强调色的半透明 tint —— 与全应用「选中态减重」同一套语言，
    // 空行/行尾的那截也就不刺眼了。
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground':
      { backgroundColor: 'color-mix(in srgb, var(--accent) 20%, transparent) !important' },
    // 🔴 编辑器内的**原生选区必须透明**：drawSelection 已经画了整行选区层，而全局
    //   `::selection`（styles.css）还会再画一层只盖文字的 —— 两层颜色不一致时，文字处
    //   双层叠加、行尾只有一层，看起来就是"一段选区两种颜色"（2026-09-28 用户截图）。
    //   编辑器里只留 CM6 这一层，颜色才均匀；全局 ::selection 留给 AI 面板等非 CM6 区域。
    '& .cm-content ::selection': { backgroundColor: 'transparent' },
    '& .cm-content::selection': { backgroundColor: 'transparent' },
    '& .cm-line::selection': { backgroundColor: 'transparent' },
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
  // 🔴 尺寸单位铁律：这里**只能写相对单位（em）**，绝对值只允许出现在 1px 级细节上。
  //   原因（用户原话：「实时预览和预览差别非常大」「实时预览根本没法看」「样式非常差」）：
  //   编辑区字号是可调的（--editor-font-size，状态栏 编辑 −/+），正文跟随变量，
  //   而标题/行内代码曾写死 px → 字号调到 17px 时 h3 以下（15/14/12.5px）全都比正文小，
  //   层级整个塌掉；预览那边又不跟随字号 → 同一文档两种模式长得完全不一样。
  //   现在两边的字号与间距都以 13px 时代的 px ÷ 13 换算成 em，任意字号下层级一致。
  const liveTheme = EditorView.theme({
    // ===== 选区可见性修复（老问题根因）=====
    // CM6 drawSelection 的 selectionLayer z-index=-2，绘制在 .cm-content 之下：
    // 行级/行内装饰的背景·边框若直接设在 .cm-line / mark 元素上，会盖住选区高亮
    // （表格、代码块、==高亮==、行内代码内选中无颜色的根因）。
    // 统一方案：背景/边框全部移到 z-index:-3 的 ::before 上 —— 绘制顺序变为
    // 装饰背景(-3) → 选区(-2) → 文字(最上层)，视觉零变化且选区全格式可见。
    '.cm-line.cm-md-tr-head, .cm-line.cm-md-tr-row, .cm-line.cm-md-tr-sep, .cm-line.cm-md-fence-line, .cm-line.cm-md-quote-line, .cm-line.cm-md-callout-line': { position: 'relative' },
    '.cm-line.cm-md-tr-head::before, .cm-line.cm-md-tr-row::before, .cm-line.cm-md-tr-sep::before, .cm-line.cm-md-fence-line::before, .cm-line.cm-md-quote-line::before, .cm-line.cm-md-callout-line::before': {
      content: '""', position: 'absolute', inset: '0', zIndex: '-3',
    },
    // 标题内容样式（光标行也保留字号，只显示源码标记 —— Obsidian 行为）
    // 数值 = .md-view 的 em 值（21/18/15/14px ÷ 13，h5/h6 保底 1em 不得小于正文）
    '.cm-md-h1': { fontSize: '1.62em', fontWeight: '700', color: 'var(--md-heading)', lineHeight: '1.3' },
    '.cm-md-h2': { fontSize: '1.38em', fontWeight: '600', color: 'var(--md-heading)', lineHeight: '1.3' },
    '.cm-md-h3': { fontSize: '1.15em', fontWeight: '600', color: 'color-mix(in srgb, var(--accent) 34%, var(--md-heading))', lineHeight: '1.35' },
    '.cm-md-h4': { fontSize: '1.08em', fontWeight: '600', color: 'var(--md-heading)' },
    '.cm-md-h5': { fontSize: '1em', fontWeight: '600', color: 'var(--md-heading)' },
    '.cm-md-h6': { fontSize: '1em', fontWeight: '500', color: 'var(--text-dim)' },
    // 标题行：行 padding 模拟 .md-view margin（18px 0 8px / h1 24px / h2 20px，÷13 得 em）
    // Obsidian 默认主题标题无下划线（GitHub 风格才有）—— 不加 border-bottom
    // ⚠ em 取的是 .cm-line 自身的字号（= 基准字号），不是标题 span 的：所以数值与 .md-view 同源
    '.cm-line.cm-md-h1-line': { paddingTop: '0.92em', paddingBottom: '0.46em' },
    '.cm-line.cm-md-h2-line': { paddingTop: '0.69em', paddingBottom: '0.31em' },
    '.cm-line.cm-md-h3-line': { paddingTop: '0.46em' },
    '.cm-line.cm-md-h4-line, .cm-line.cm-md-h5-line, .cm-line.cm-md-h6-line': { paddingTop: '0.15em' },
    // 空行保留半行间距，但字体也要同比缩小：只减 line-height 时，浏览器仍返回
    // 正文字号的 caret rect（17px 字号下高 22px），会越过 14px 空行、侵入相邻段落。
    '.cm-line.cm-md-blank': { fontSize: '0.5em', lineHeight: '1.7' },
    '.cm-md-strong': { fontWeight: '700' },
    '.cm-md-em': { fontStyle: 'italic' },
    '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--text-dim)' },
    // ==高亮== / 行内代码：背景画在 ::before(z:-3)，选区在文字下、高亮在选区下均可见
    '.cm-md-highlight': { position: 'relative' },
    '.cm-md-highlight::before': {
      content: '""', position: 'absolute', inset: '0', zIndex: '-3',
      backgroundColor: 'var(--bg-selected)', borderRadius: '2px',
    },
    // 行内代码（对齐 .md-view code：0.92em + padding 0.08/0.38em + btn-bg 背景）
    '.cm-md-code': {
      position: 'relative', fontFamily: 'var(--font-mono)', color: 'var(--code-text)',
      padding: '0.08em 0.38em', fontSize: '0.92em',
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
      display: 'inline-block', padding: '0.31em 0.77em', border: '1px dashed var(--border-mid)',
      borderRadius: '4px', color: 'var(--text-dim)', fontSize: '0.92em', verticalAlign: 'middle',
    },
    // 列表标记弱化（Obsidian 式：bullet 变暗，内容正常色）
    '.cm-md-listmark': { color: 'var(--text-dim)' },
    // 嵌套列表缩进宽度（IndentWidget 内联设定宽度，这里只兜底 display）
    '.cm-md-indent': { display: 'inline-block' },
    // 无序 bullet 圆点（Obsidian 式 • 渲染，替换源码 -/+/*）
    // ⚠ vertical-align 必须用 baseline：middle 会把行盒撑高 ~2px（实测列表行 24 vs 正文 22），
    //   而 CM6 的高度模型按 line-height 记账 → 选区色带与行盒每行差 2~5px，列表区一累积
    //   就出现"色带压住上一行 / 下面少一截"（2026-09-28 实测量化的根因）
    '.cm-md-bullet': {
      display: 'inline-block', width: '1.23em', textAlign: 'center',
      color: 'var(--text-dim)', verticalAlign: 'baseline', userSelect: 'none',
    },
    // 有序编号小间距
    '.cm-md-listnum': { display: 'inline-block', minWidth: '1.23em' },
    // task checkbox（对齐 preview 渲染的 input[type=checkbox] 视觉：styles.css 里
    // .md-view input[type=checkbox] 同为 0.95em / margin 0.38em —— 两边尺寸同源）
    // ⚠ 同上：baseline + 相对位移回正，不能 middle（撑行盒 → 选区错位）
    '.cm-md-task': {
      display: 'inline-block', width: '0.95em', height: '0.95em',
      border: '1.5px solid var(--text-dim)', borderRadius: '3px',
      verticalAlign: 'baseline', position: 'relative', top: '0.08em',
      margin: '0 0.38em 0 0.08em',
    },
    '.cm-md-task.done': { borderColor: 'var(--accent)' },
    '.cm-md-task.done::before': {
      content: '""', position: 'absolute', inset: '0', zIndex: '-3',
      background: 'var(--accent)', borderRadius: '2px',
    },
    '.cm-md-task.done::after': {
      content: '""', position: 'absolute', left: '0.27em', top: '0px',
      width: '0.31em', height: '0.62em', border: 'solid #fff', borderWidth: '0 2px 2px 0',
      transform: 'rotate(45deg)',
    },
    // 引用块（对齐 .md-view blockquote：左竖线 + 弱化色 + 上下间距）
    '.cm-line.cm-md-quote-line': {
      paddingLeft: '0.92em',
      color: 'var(--text-dim)', paddingTop: '0.15em', paddingBottom: '0.15em',
    },
    '.cm-line.cm-md-quote-line::before': { borderLeft: '2px solid color-mix(in srgb, var(--accent) 55%, transparent)' },
    '.cm-line.cm-md-quote-first': { paddingTop: '0.62em' },
    '.cm-line.cm-md-quote-last': { paddingBottom: '0.62em' },
    // Callout（Obsidian > [!note] 提示块）：整块用类型色左竖线 + 极淡底色 + 标题行
    // 与预览 .md-view .md-callout 同源（同一套 .co-* 变量，见 styles.css）
    '.cm-line.cm-md-callout-line': { paddingLeft: '0.92em', color: 'var(--text)', paddingTop: '0.15em', paddingBottom: '0.15em' },
    '.cm-line.cm-md-callout-line::before': {
      borderLeft: '3px solid var(--co-color, var(--callout-note))',
      backgroundColor: 'color-mix(in srgb, var(--co-color, var(--callout-note)) 8%, transparent)',
      borderRadius: '0 6px 6px 0',
    },
    '.cm-line.cm-md-callout-first': { paddingTop: '0.62em', borderTopLeftRadius: '6px' },
    '.cm-line.cm-md-callout-last': { paddingBottom: '0.62em', borderBottomLeftRadius: '6px' },
    // 标题行（> [!note] 标题）：类型色 + 加粗；图标由 widget 画
    '.cm-md-callout-title': { color: 'var(--co-color, var(--callout-note))', fontWeight: '700' },
    '.cm-md-callout-ic': { marginRight: '0.31em', userSelect: 'none' },
    // 围栏代码块（对齐 .md-view pre：背景块 + 圆角 6 + padding 1em/1.23em + 0.96em/1.6）
    // 注意：全部用 padding 不用 margin —— CM6 行高测量不含 margin，margin 会让
    // heightmap 与 DOM 错位 → 点击偏移（fence-first/last 同理）
    // 背景/边框画在 ::before(z:-3)，选区可见（见 liveTheme 头部注释）
    '.cm-line.cm-md-fence-line': {
      fontFamily: 'var(--font-mono)', fontSize: '0.96em', lineHeight: '1.6', padding: '0.08em 0.92em',
    },
    '.cm-line.cm-md-fence-line::before': { backgroundColor: 'var(--code-bg)' },
    '.cm-line.cm-md-fence-first': { paddingTop: '0.92em', position: 'relative' },
    '.cm-line.cm-md-fence-first::before': { borderTopLeftRadius: '8px', borderTopRightRadius: '8px' },
    // 代码块复制按钮（hover 浮现右上角：语言名 + 复制）
    '.cm-md-copybtn': {
      position: 'absolute', right: '0.77em', top: '0.38em', display: 'flex', alignItems: 'center', gap: '6px',
      opacity: '0', transition: 'opacity .12s', zIndex: '5',
    },
    '.cm-line.cm-md-fence-first:hover .cm-md-copybtn': { opacity: '1' },
    '.cm-md-copybtn-lang': {
      fontSize: '0.77em', color: 'var(--text-dim)', textTransform: 'uppercase',
      letterSpacing: '0.5px', userSelect: 'none',
    },
    '.cm-md-copybtn button': {
      fontSize: '0.85em', padding: '0.08em 0.69em', background: 'var(--btn-bg)', color: 'var(--text)',
      border: '1px solid var(--btn-border)', borderRadius: '3px', cursor: 'pointer', lineHeight: '1.5',
    },
    '.cm-md-copybtn button:hover': { background: 'var(--btn-hover)' },
    '.cm-line.cm-md-fence-last': { paddingBottom: '0.92em' },
    '.cm-line.cm-md-fence-last::before': { borderBottomLeftRadius: '8px', borderBottomRightRadius: '8px' },
    // 分隔线 ---：文本替换为 1px 线 widget（行高不变 —— 行高压 0 会让 CM6 高度
    // 模型错位导致点击偏移），间距用行 padding 表达（.md-view hr margin 1.38em 同源）
    '.cm-line.cm-md-hr-line': { paddingTop: '0.69em', paddingBottom: '0.69em' },
    '.cm-md-hr': { position: 'relative', display: 'inline-block', width: '100%', height: '1px', verticalAlign: 'middle' },
    '.cm-md-hr::before': { content: '""', position: 'absolute', inset: '0', zIndex: '-3', background: 'color-mix(in srgb, var(--text) 10%, transparent)' },
    // 表格逐行线框（Obsidian 式行常渲染：光标进单元格不整块退化源码）
    // 表头行/数据行 = 行背景+边框+左右 padding；分隔行 block replace 后压成 2px 细线
    // 背景/边框在 ::before(z:-3)——表格内选区可见（老问题根因修复）
    // 表头文字：--text-bright 在暗色主题下几乎等于正文白（用户："起码标题颜色不同"）→
    // 换成标题色 + 700，与正文一眼分得开
    // ⚠ 等宽字体 + 不换行：Tab/Enter 会把管道按显示宽度重排（tableEdit），只有等宽字体下
    //   那些补位空格才真的让各行的 `|` 对齐成网格（用户要的"像 excel 那样"）；
    //   而一旦折行，对齐就散了（实测窄编辑区里表头末尾的 `|` 会被挤到下一行）
    //   → 表格行不参与折行，过长时由 scroller 横向滚动（表格本来就该横向滚）
    '.cm-line.cm-md-tr-head': { color: 'var(--md-heading)', fontWeight: '700', padding: '0.23em 0.77em', fontFamily: 'var(--font-mono)', whiteSpace: 'pre' },
    '.cm-line.cm-md-tr-head::before': {
      background: 'var(--bg-panel)', border: '1px solid color-mix(in srgb, var(--text) 12%, transparent)', borderBottom: 'none',
      borderRadius: '6px 6px 0 0',
    },
    '.cm-line.cm-md-tr-row': { padding: '0.23em 0.77em', fontFamily: 'var(--font-mono)', whiteSpace: 'pre' },
    '.cm-line.cm-md-tr-row::before': { background: 'var(--code-bg)', border: '1px solid color-mix(in srgb, var(--text) 12%, transparent)', borderTop: 'none' },
    '.cm-line.cm-md-tr-row.cm-md-tr-last::before': { borderRadius: '0 0 6px 6px' },
    '.cm-line.cm-md-tr-sep': { height: '2px', padding: '0' },
    '.cm-line.cm-md-tr-sep::before': { background: 'color-mix(in srgb, var(--text) 12%, transparent)' },
    // 源码态（光标进表内）里的 `|`：不再显示半透明源码字符，改画一条 1px 细竖线 ——
    // 用户原话"显示太奇怪"，半透明的竖线字符看着就像没渲染完
    '.cm-md-tpipe': { position: 'relative', color: 'transparent', display: 'inline-block', width: '0.38em' },
    '.cm-md-tpipe::before': {
      content: '""', position: 'absolute', left: '0.15em', top: '1px', bottom: '1px',
      width: '1px', background: 'color-mix(in srgb, var(--text) 22%, transparent)',
    },
    // ===== 表格 widget（光标不在表内时的真 <table>）=====
    // 表头刻意用 --md-heading + 面板底色 + 700：用户要的"起码标题颜色不同"就在这里
    // ⚠ block widget 的垂直间距**只能用 padding 不能用 margin**：CM6 行高测量不含 margin，
    //   widget 实际占位会比高度模型高 → 下方所有行的选区/点击坐标整体错位
    //   （用户看到的"选区前面少一截、后面多一截"就是它，与 fence 用 padding 是同一条铁律）
    '.cm-md-table': { position: 'relative', padding: '0.77em 0' },
    '.cm-md-table table': { borderCollapse: 'collapse', width: '100%', fontSize: '0.96em' },
    // ⚠ 表头底色别用纯 --bg-panel：它比正文底色只暗一点，截图里几乎看不出"这是表头"
    //   → 掺一层 accent tint（用户要的"起码标题颜色不同"要一眼看得出来）
    '.cm-md-table th': {
      background: 'color-mix(in srgb, var(--accent) 16%, var(--bg-panel))',
      color: 'var(--md-heading)', fontWeight: '700',
      padding: '0.38em 0.77em', textAlign: 'left', whiteSpace: 'nowrap',
      border: '1px solid color-mix(in srgb, var(--text) 22%, transparent)',
    },
    '.cm-md-table td': {
      padding: '0.31em 0.77em', color: 'var(--text)', verticalAlign: 'top',
      border: '1px solid color-mix(in srgb, var(--text) 13%, transparent)',
    },
    '.cm-md-table tbody tr:nth-child(even) td': { background: 'color-mix(in srgb, var(--bg-panel) 85%, transparent)' },
    '.cm-md-table tbody tr:hover td': { background: 'var(--btn-hover)' },
    '.cm-md-table td code, .cm-md-table th code': {
      fontFamily: 'var(--font-mono)', fontSize: '0.92em', padding: '0.08em 0.38em',
      background: 'var(--btn-bg)', color: 'var(--code-text)', borderRadius: '3px',
    },
    '.cm-md-tlink': { color: 'var(--accent)' },
    '.cm-md-tablecopy': {
      position: 'absolute', right: '0.15em', top: '-1.31em', fontSize: '0.85em', padding: '0.08em 0.69em',
      background: 'var(--btn-bg)', color: 'var(--text)', border: '1px solid var(--btn-border)',
      borderRadius: '3px', cursor: 'pointer', opacity: '0', transition: 'opacity .12s',
    },
    '.cm-md-table:hover .cm-md-tablecopy': { opacity: '1' },
    // mermaid 实时渲染图（block widget）：居中，**不画容器底色**
    // （用户 2026-09-28：图外面那块底色"有视觉影响" —— 面积一大就在正文中间压出一整块灰，
    //   而且图本身已经有自己的方框，外面再套一层纯属多余）
    '.cm-md-mermaid': { position: 'relative', padding: '1.08em 0 0.77em', textAlign: 'center' },
    '.cm-md-mermaid svg': { maxWidth: '100%' },
    '.cm-md-mermaid .mermaid-err': { textAlign: 'left', color: 'var(--del-text)', whiteSpace: 'pre-wrap' },
    // 标题折叠箭头（Obsidian 式）：hover 标题行浮现，已折叠时常显 ▸
    '.cm-md-foldctrl': {
      display: 'inline-block', width: '1.38em', textAlign: 'center', fontSize: '0.77em',
      color: 'var(--text-dim)', cursor: 'pointer', userSelect: 'none', verticalAlign: 'middle',
      marginLeft: '-1.38em', opacity: '0', transition: 'opacity .1s',
    },
    '.cm-line:hover .cm-md-foldctrl, .cm-md-foldctrl.folded': { opacity: '1' },
    '.cm-md-foldctrl:hover': { color: 'var(--accent)' },
    // 折叠占位符样式（CM6 foldWidget 默认 "…"，弱化显示）
    '.cm-foldPlaceholder': {
      background: 'var(--btn-bg)', border: '1px solid var(--btn-border)', color: 'var(--text-dim)',
      borderRadius: '3px', margin: '0 3px', padding: '0 6px', fontSize: '0.85em', cursor: 'pointer',
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
      // 图片异步加载完高度才确定 → 触发重测（否则下方内容的选区/点击坐标错位）
      img.addEventListener('load', remeasureSoon);
      // 加载失败（路径错/网络图不存在）：隐藏裂图 → 虚线占位框显示 alt/文件名
      img.addEventListener('error', () => {
        img.style.display = 'none';
        if (wrap.querySelector('.cm-md-img-broken')) return;
        const ph = document.createElement('span');
        ph.className = 'cm-md-img-broken';
        ph.textContent = '🖼 ' + (this.alt || this.src);
        wrap.appendChild(ph);
      });
      // 点击 → 全屏查看（lightbox 由 plugin-loader 提供；运行时一定已定义）
      img.title = '点击全屏查看';
      img.addEventListener('click', () => {
        if (window.MI && MI.showImgLightbox) MI.showImgLightbox(img.src, this.alt);
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

  // ---------- Callout（Obsidian 的 > [!note] 提示块） ----------
  // 语法：块首行 `> [!type] 可选标题`（type 大小写不敏感，支持折叠标记 - / +，这里忽略折叠）。
  // 两种模式共用同一张表：live 用行 class + 图标 widget，预览用容器 + 标题行。
  // 图标沿用项目惯例用内联 SVG？—— 这里刻意用 emoji：Obsidian 自己的 callout 图标就是图形符号，
  // 且它在标题行内是"内容"而不是工具条图标（UI 文案约定里的两套图标规矩针对的是列表/工具条）。
  const CALLOUT_TYPES = {
    note: ['📘', 'Note'], info: ['ℹ️', 'Info'], tip: ['🔥', 'Tip'], hint: ['🔥', 'Hint'],
    important: ['🔥', 'Important'], success: ['✅', 'Success'], check: ['✅', 'Check'], done: ['✅', 'Done'],
    question: ['❓', 'Question'], help: ['❓', 'Help'], faq: ['❓', 'FAQ'],
    warning: ['⚠️', 'Warning'], caution: ['⚠️', 'Caution'], attention: ['⚠️', 'Attention'],
    danger: ['⛔', 'Danger'], error: ['⛔', 'Error'],
    failure: ['❌', 'Failure'], fail: ['❌', 'Fail'], missing: ['❌', 'Missing'],
    example: ['📋', 'Example'], quote: ['💬', 'Quote'], cite: ['💬', 'Cite'],
    bug: ['🐛', 'Bug'], abstract: ['📄', 'Abstract'], summary: ['📄', 'Summary'], tldr: ['📄', 'TLDR'],
    todo: ['🕐', 'Todo'],
  };
  // 类型名 → 颜色 class（与 styles.css 的 .co-* 一一对应，两边共用）
  const CALLOUT_CLS = {
    note: 'co-note', info: 'co-info', tip: 'co-tip', hint: 'co-hint', important: 'co-tip',
    success: 'co-success', check: 'co-success', done: 'co-success',
    question: 'co-question', help: 'co-question', faq: 'co-question',
    warning: 'co-warning', caution: 'co-warning', attention: 'co-warning',
    danger: 'co-danger', error: 'co-danger',
    failure: 'co-failure', fail: 'co-failure', missing: 'co-failure',
    example: 'co-example', quote: 'co-quote', cite: 'co-quote',
    bug: 'co-bug', abstract: 'co-abstract', summary: 'co-abstract', tldr: 'co-abstract',
    todo: 'co-todo',
  };
  // 解析块首行 `[!type]`（允许 `> [!note]-` 折叠标记与 `> [!note] 自定义标题`）
  function parseCallout(text) {
    const m = /^\s*>\s*\[!([A-Za-z]+)\][-+]?\s*(.*)$/.exec(String(text));
    if (!m) return null;
    const type = m[1].toLowerCase();
    const meta = CALLOUT_TYPES[type];
    if (!meta) return null;
    return { type, icon: meta[0], title: (m[2] || '').trim() || meta[1], cls: CALLOUT_CLS[type] || 'co-note' };
  }
  // 标题行里的 `[!type]` 与可选标题 → 图标 + 标题（保留标题文本可编辑）
  class CalloutIconWidget extends WidgetType {
    constructor(text, cls) { super(); this.text = text; this.cls = cls || 'cm-md-callout-ic'; }
    eq(other) { return other.text === this.text && other.cls === this.cls; }
    toDOM() {
      const s = document.createElement('span');
      s.className = this.cls;
      s.textContent = this.text;
      return s;
    }
    ignoreEvent() { return false; }
  }

  // 脚注序号：按**定义行出现顺序**编号（Obsidian 同款；引用在前、定义在后也按定义序）。
  // 两种模式必须用同一套规则，否则 live 显示 [1]、预览显示 [2] 就对不上了。
  // 做成纯函数（传文本进来）而不是读 liveView：预览模式下 liveView 已销毁，
  // 读它会退回"序号=标签文本"，两边立刻不一致（实测踩过）。
  function footnoteNoIn(text, label) {
    const re = /^ {0,3}\[\^([^\]]+)\]:/gm;
    let m, i = 0;
    while ((m = re.exec(String(text)))) {
      i++;
      if (m[1] === label) return i;
    }
    return i + 1;
  }
  // 一次构建里把"标签 → 序号"算好（避免每行每标记都全文扫一遍）
  function footnoteIndex(text) {
    const map = new Map();
    const re = /^ {0,3}\[\^([^\]]+)\]:/gm;
    let m, i = 0;
    while ((m = re.exec(String(text)))) { i++; if (!map.has(m[1])) map.set(m[1], i); }
    return map;
  }
  // 预览侧用同一套规则（plugin-loader 的 marked 扩展调它）
  window.MI = window.MI || {};
  MI.footnoteNoIn = footnoteNoIn;
  // 嵌入笔记的 `#标题` 切片规则也共用（两模式切出同一段，否则内容对不上）
  MI.sliceMdSection = sliceSection;

  // ---------- 嵌入 widget：![[笔记]] / ![[笔记#标题]] → 内嵌只读卡片 ----------
  // 文档 046 §2.4。不做的话 `![[笔记]]` 会走图片分支变成**裂图**（实测），比不做还糟。
  // 深度限 1 层防递归；被嵌入内容用同一套预览渲染（MI.renderFor），保证与预览模式同款排版。
  const embedCache = new Map();   // path|heading -> HTMLElement
  function resolveEmbedPath(target) {
    const base = String(MdEditor.__baseDir || '');
    const t = String(target || '').trim().replace(/\\/g, '/');
    if (!t) return '';
    const sep = base.includes('\\') ? '\\' : '/';
    const parts = base.split(/[\\/]/).filter(Boolean);
    for (const seg of t.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    let p = parts.join(sep);
    if (!/\.[A-Za-z0-9]{1,8}$/.test(p.split(/[\\/]/).pop() || '')) p += '.md';
    return p;
  }
  class EmbedWidget extends WidgetType {
    constructor(target, heading, key) { super(); this.target = target; this.heading = heading || ''; this.key = key; }
    eq(other) { return other.key === this.key; }
    toDOM(view) {
      const box = document.createElement('div');
      box.className = 'cm-md-embed';
      const cached = embedCache.get(this.key);
      if (cached) { box.appendChild(cached.cloneNode(true)); return box; }
      box.textContent = '载入中…';
      (async () => {
        try {
          const p = resolveEmbedPath(this.target);
          const r = await window.myIDE.fs.readFile(p);
          if (!r || typeof r.content !== 'string') throw new Error('读不到 ' + p);
          let content = r.content;
          if (this.heading) content = sliceSection(content, this.heading);
          const node = (window.MI && MI.renderFor)
            ? MI.renderFor({ path: p, name: p.split(/[\\/]/).pop(), ext: 'md' })({ path: p, name: p.split(/[\\/]/).pop(), ext: 'md', content })
            : null;
          const body = node || document.createElement('pre');
          if (!node) body.textContent = content;
          body.classList.add('md-embed-body');
          embedCache.set(this.key, body);
          if (box.isConnected) { box.innerHTML = ''; box.appendChild(body); remeasureSoon(); }
        } catch (e) {
          box.className = 'cm-md-embed cm-md-embed-err';
          box.textContent = '嵌入失败：' + this.target + '（' + ((e && e.message) || e) + '）';
          remeasureSoon();
        }
      })();
      return box;
    }
    ignoreEvent() { return false; }
  }
  // 取 `#标题` 那一段（到下一个同级或更高级标题为止）；找不到就整篇
  // 导出给预览侧复用（嵌入笔记 `![[x#标题]]` 两边必须切出同一段）
  function sliceSection(content, heading) {
    const lines = String(content).split('\n');
    const want = String(heading).trim();
    let start = -1, level = 0, fence = null;
    for (let i = 0; i < lines.length; i++) {
      const fm = /^\s*(```+|~~~+)/.exec(lines[i]);
      if (fm) { const m = fm[1][0]; if (!fence) fence = m; else if (fence === m) fence = null; continue; }
      if (fence) continue;
      const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
      if (!h) continue;
      if (start < 0) {
        if (h[2].trim() === want) { start = i; level = h[1].length; }
      } else if (h[1].length <= level) {
        return lines.slice(start, i).join('\n');
      }
    }
    return start < 0 ? content : lines.slice(start).join('\n');
  }

  // ---------- 嵌套列表缩进 widget：源码前导空格 → 固定宽度缩进 ----------
  // 为什么不能只留着源码里的空格：正文是比例字体，2 个空格实测只有 9px，而预览那边是
  // `ul { padding-left: 1.85em }`（17px 字号下 31px）—— 用户的嵌套子项看起来跟父项齐平
  // （原话「这里缩进也没有」）。这里按**语法树里的真实层级**换算宽度，与预览同源。
  class IndentWidget extends WidgetType {
    constructor(level) { super(); this.level = level; }
    eq(other) { return other.level === this.level; }
    toDOM() {
      const s = document.createElement('span');
      s.className = 'cm-md-indent';
      s.style.width = (1.85 * this.level) + 'em';
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

  // ---------- 表格 widget：光标不在表内 → 渲染成真 <table>；光标进入 → 逐行源码态 ----------
  // 2026-09-28 用户反馈："表格显示太奇怪 / 功能也不完善 / 一般 md 表格能当 excel 表格操作 /
  // 起码标题颜色不同"。旧实现是"逐行线框渲染"（| 半透明可见、表头与正文几乎同色、列完全
  // 不对齐）→ 改成 Obsidian 同款：光标不在表内时整块替换为真表格（列对齐、表头底色+强调色、
  // 斑马纹、按 :---: 对齐、可一键复制成 TSV 粘进 Excel）；点一下表格 → CM6 把光标落到表内
  // → 装饰器重算 → 自动切回逐行源码态，单元格仍能像普通文本一样直接编辑。
  const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  function splitRow(line) {
    const s = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = []; let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
      if (s[i] === '|') { cells.push(cur); cur = ''; continue; }
      cur += s[i];
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  }
  function parseTable(src) {
    const lines = String(src).split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2 || !TABLE_SEP_RE.test(lines[1])) return null;
    const head = splitRow(lines[0]);
    const aligns = splitRow(lines[1]).map((c) => {
      const l = c.startsWith(':'), r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    return { head, aligns, rows: lines.slice(2).map(splitRow) };
  }
  // 单元格内联：只支持最常见的几种（**粗** *斜* `码` ~~删~~ [文字](链接)）——
  // 表格里不值得为此引一个解析器，目标是"看起来像表格"，不是富文本
  function cellInline(text) {
    const frag = document.createDocumentFragment();
    const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(~~([^~]+)~~)|(\[([^\]]*)\]\([^)]*\))/g;
    let last = 0, m;
    const push = (s) => { if (s) frag.appendChild(document.createTextNode(s)); };
    while ((m = re.exec(text))) {
      push(text.slice(last, m.index));
      let el = null;
      if (m[2] != null) { el = document.createElement('strong'); el.textContent = m[2]; }
      else if (m[4] != null) { el = document.createElement('em'); el.textContent = m[4]; }
      else if (m[6] != null) { el = document.createElement('code'); el.textContent = m[6]; }
      else if (m[8] != null) { el = document.createElement('del'); el.textContent = m[8]; }
      else if (m[10] != null) { el = document.createElement('span'); el.className = 'cm-md-tlink'; el.textContent = m[10]; }
      if (el) frag.appendChild(el);
      last = m.index + m[0].length;
    }
    push(text.slice(last));
    return frag;
  }
  // 表格源码行里各单元格的起始偏移（用于「点哪个格，光标就落在哪个格」）
  // 规则与 splitRow 对齐：可省略首尾竖线、\| 是转义、单元格内容前的空格不计。
  function cellOffsets(line) {
    const s = String(line);
    const offs = [];
    let end = s.length;
    while (end > 0 && /\s/.test(s[end - 1])) end--;      // 尾部空白不算内容
    let i = 0;
    while (i < end && /\s/.test(s[i])) i++;              // 行首缩进
    if (s[i] === '|') { i++; offs.push(i); }             // 首竖线后的第一格
    else offs.push(i);
    for (; i < end; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === '|') {
        if (i >= end - 1) break;                         // 尾竖线：后面没有格了
        offs.push(i + 1);
      }
    }
    return offs.map((o) => { let k = o; while (k < s.length && s[k] === ' ') k++; return k; });
  }

  // ================= 表格编辑（Excel 式：Tab 换格 / 末格增行 / Enter 下行 / 自动对齐） =================
  // 用户原话：「表格也不能像 excel 那样的表格使用」。旧的 Tab 只在**本行**里找下一个 `|`：
  // 走到行尾就停住、不会换行、不会增行，Enter 还会把一行表格劈成两行（结构坏掉）。
  // 这里按「整张表」来算：光标所在行列 → 目标行列 → 需要时补一行 → 顺手把管道对齐重排。
  // 显示宽度：CJK 全角按 2 列算 —— 光标进表时逐行按等宽字体渲染，源码对齐了才真的是网格。
  function dispWidth(s) {
    let w = 0;
    for (const ch of String(s)) {
      w += /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
    }
    return w;
  }
  function parseAlignCell(c) {
    const s = String(c).trim();
    const l = s.startsWith(':'), r = s.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  }
  // 光标所在的整张表；不在表内（或结构不标准）→ null
  function tableContext(state, pos) {
    let node = null;
    try {
      let n = Language.syntaxTree(state).resolveInner(pos, -1);
      for (; n; n = n.parent) if (n.name === 'Table') { node = n; break; }
    } catch { node = null; }
    if (!node) return null;
    const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
    const lines = [];
    for (let k = first.number; k <= last.number; k++) lines.push(state.doc.line(k));
    if (lines.length < 2 || !TABLE_SEP_RE.test(lines[1].text)) return null;
    // 只处理"每行都以 | 开头"的标准写法：行首可能是 `> ` 的引用内表格一律不动（重排会拆掉结构）
    if (lines.some((l) => !/^\s*\|/.test(l.text))) return null;
    const rows = lines.map((l, i) => ({ line: l, isSep: i === 1, cells: splitRow(l.text) }));
    const sepAligns = rows[1].cells.map(parseAlignCell);
    let cur = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].isSep) continue;
      if (pos >= rows[i].line.from && pos <= rows[i].line.to) { cur = i; break; }
    }
    if (cur < 0) return null;
    const offs = cellOffsets(rows[cur].line.text);
    const rel = pos - rows[cur].line.from;
    let col = 0;
    for (let i = 0; i < offs.length; i++) if (offs[i] <= rel) col = i;
    // 行列按"去掉分隔行后的数据序"给：row 0 = 表头
    const row = cur === 0 ? 0 : cur - 1;
    return { from: node.from, to: node.to, lines, rows, sepAligns, row, col, nCols: Math.max(...rows.map((r) => r.cells.length)) };
  }
  // 用单元格矩阵重建整张表：返回文本 + 每行各格内容起点偏移（光标重定位用）
  function buildTable(matrix, aligns) {
    const nCols = Math.max(...matrix.map((r) => r.length));
    const widths = [];
    for (let c = 0; c < nCols; c++) widths[c] = Math.max(3, ...matrix.map((r) => dispWidth(r[c] || '')));
    const outLines = [], offsets = [];
    const mkRow = (cells) => {
      let s = '|'; const offs = [];
      for (let c = 0; c < nCols; c++) {
        const cell = String(cells[c] == null ? '' : cells[c]).trim().split('|').join('\\|');
        const pad = widths[c] - dispWidth(cell);
        offs.push(s.length + 2);              // 「| 」之后就是内容起点
        s += ' ' + cell + ' '.repeat(pad) + ' |';
      }
      outLines.push(s); offsets.push(offs);
      return s;
    };
    const sep = (() => {
      let s = '|';
      for (let c = 0; c < nCols; c++) {
        const a = aligns[c] || '';
        const w = widths[c];
        // 每格占「1 空格 + w 列 + 1 空格」——与内容行同宽，各行的 `|` 才会落在同一列
        // （踩过：分隔行写 w+2 个横线 → 比内容行宽 2 列，整张表的竖线错开）
        const dash = a === 'center' ? ':' + '-'.repeat(Math.max(1, w - 2)) + ':'
          : a === 'right' ? '-'.repeat(Math.max(2, w - 1)) + ':'
            : a === 'left' ? ':' + '-'.repeat(Math.max(2, w - 1))
              : '-'.repeat(w);
        s += ' ' + dash + ' |';
      }
      return s;
    })();
    // 生成文本的行序：第 0 行 = 表头、第 1 行 = 分隔行、第 2 行起 = 数据行
    mkRow(matrix[0]);
    outLines.push(sep); offsets.push(null);
    for (let i = 1; i < matrix.length; i++) mkRow(matrix[i]);
    return { text: outLines.join('\n'), offsets };
  }
  // dCol：横向换格；dRow：纵向换行；addIfLast：越界时补一行（Excel 里 Tab/Enter 到末行会新建）
  function tableEdit(view, opts) {
    const state = view.state, sel = state.selection.main;
    if (!sel.empty) return false;
    const t = tableContext(state, sel.head);
    if (!t) return false;
    const matrix = t.rows.filter((r) => !r.isSep).map((r) => r.cells.slice());
    const nCols = t.nCols;
    for (const r of matrix) while (r.length < nCols) r.push('');
    let row = t.row + (opts.dRow || 0), col = t.col + (opts.dCol || 0);
    if (col >= nCols) { col = 0; row += 1; }
    if (col < 0) { col = nCols - 1; row -= 1; }
    if (row < 0) { row = 0; col = 0; }
    if (row > matrix.length - 1) {
      if (opts.addIfLast === false) { row = matrix.length - 1; col = nCols - 1; }
      else matrix.push(new Array(nCols).fill(''));
    }
    const built = buildTable(matrix, t.sepAligns);
    const gen = built.text.split('\n');
    // 生成文本里：矩阵第 0 行（表头）→ 下标 0；数据行 row → 下标 row + 1（中间隔着分隔行）
    const genIdx = row === 0 ? 0 : row + 1;
    let pos = t.from;
    for (let i = 0; i < genIdx; i++) pos += gen[i].length + 1;
    const offs = built.offsets[genIdx];
    pos += offs ? offs[col] : 1;
    view.dispatch({
      changes: { from: t.from, to: t.to, insert: built.text },
      selection: { anchor: pos },
      scrollIntoView: true,
      userEvent: 'input.table',
    });
    return true;
  }
  class TableWidget extends WidgetType {
    constructor(src, from) { super(); this.src = src; this.from = from || 0; }
    eq(other) { return other.src === this.src && other.from === this.from; }
    // 点击的单元格 → 源码里的绝对位置。
    // 🔴 为什么必须自己做映射：整块表格是 block widget，CM6 只把点击换算成**该块的起止位置**，
    //   点第 3 行第 2 列也会把光标丢到表格首行 —— 用户原话「没法编辑」。
    //   （自检里「点击单元格光标精确进入该格」长期是红的，就是这条。）
    cellPos(cell) {
      const row = cell.closest('tr');
      if (!row) return null;
      const cellsInRow = [...row.children];
      const col = cellsInRow.indexOf(cell);
      if (col < 0) return null;
      let lineIdx = 0;                                   // 表头 = 源码第 0 行
      if (!cell.closest('thead')) {
        const tbody = cell.closest('tbody');
        const rows = tbody ? [...tbody.children] : [];
        // +2：源码里数据行前面还有「表头行 + |---| 分隔行」，index 0 是表头、
        // index 1 是分隔行，第一行数据从 2 开始（踩过：写成 +1 会整体落到分隔行上）
        lineIdx = rows.indexOf(row) + 2;
      }
      const rawLines = this.src.split('\n');
      const idxMap = [];
      rawLines.forEach((l, i) => { if (l.trim() !== '') idxMap.push(i); });
      const rawNo = idxMap[lineIdx];
      if (rawNo == null) return null;
      let off = 0;
      for (let i = 0; i < rawNo; i++) off += rawLines[i].length + 1;
      const line = rawLines[rawNo];
      const offs = cellOffsets(line);
      const inLine = offs[col] != null ? offs[col] : Math.max(0, line.length - 1);
      return this.from + off + Math.min(inLine, line.length);
    }
    toDOM(view) {
      const parsed = parseTable(this.src);
      const wrap = document.createElement('div');
      wrap.className = 'cm-md-table';
      if (!parsed) { wrap.textContent = this.src; return wrap; }
      const cols = Math.max(parsed.head.length, ...parsed.rows.map((r) => r.length));
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const htr = document.createElement('tr');
      for (let i = 0; i < cols; i++) {
        const th = document.createElement('th');
        if (parsed.aligns[i]) th.style.textAlign = parsed.aligns[i];
        th.appendChild(cellInline(parsed.head[i] != null ? parsed.head[i] : ''));
        htr.appendChild(th);
      }
      thead.appendChild(htr); table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const r of parsed.rows) {
        const tr = document.createElement('tr');
        for (let i = 0; i < cols; i++) {
          const td = document.createElement('td');
          if (parsed.aligns[i]) td.style.textAlign = parsed.aligns[i];
          td.appendChild(cellInline(r[i] != null ? r[i] : ''));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody); wrap.appendChild(table);
      // 复制整表（TSV —— 能直接粘进 Excel / 表格软件）
      const btn = document.createElement('button');
      btn.className = 'cm-md-tablecopy';
      btn.textContent = '复制';
      btn.title = '复制整表（TSV，可直接粘进 Excel）';
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tsv = [parsed.head, ...parsed.rows].map((r) => r.join('\t')).join('\n');
        let ok = false;
        try { await navigator.clipboard.writeText(tsv); ok = true; } catch {}
        btn.textContent = ok ? '已复制' : '失败';
        setTimeout(() => { btn.textContent = '复制'; }, 1200);
      });
      wrap.appendChild(btn);
      // 点击 → 光标精确落到该单元格的源码位置（捕获阶段：必须抢在 CM6 自己的
      // mousedown 换算之前，否则会被它按"整块起点"覆盖掉）
      if (view) {
        wrap.addEventListener('mousedown', (e) => {
          const cell = e.target && e.target.closest ? e.target.closest('th,td') : null;
          if (!cell) return; // 复制按钮等：走默认行为
          const pos = this.cellPos(cell);
          if (pos == null) return;
          e.preventDefault();
          e.stopPropagation();
          view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
          view.focus();
        }, true);
      }
      return wrap;
    }
    // false = 事件穿透：点表格 → CM6 把光标放进表内 → 装饰器重算 → 自动切成可编辑的源码态
    // （精确到单元格的位置由上面的 mousedown 捕获处理）
    ignoreEvent() { return false; }
  }

  // ---------- Mermaid 图 widget（```mermaid 围栏 → SVG 实时渲染） ----------
  // 光标不在块内：整块替换为渲染图；光标进入：回退源码编辑（Obsidian 同款交互）。
  // 渲染结果按 code 缓存（图不闪烁）；mermaid 库缺失（如测试环境）→ 不渲染，保持源码。
  // 当前活动的编辑器视图（create() 里赋值）：widget 异步改高度后用它触发重测量
  let liveView = null;
  const remeasureSoon = () => { if (liveView) { try { liveView.requestMeasure(); } catch {} } };
  const mermaidCache = new Map(); // code -> svg string（含失败标记 null）
  // ⚠ mermaid 的**全局主题**原先只在 md 预览那条路上按需 initialize（plugin-loader 只在
  //   页面里真有 mermaid 块时才调）→ Live Preview 这条路径**从来没初始化过**，于是暗色主题下
  //   渲染出来的图是「白底白框」那种浅色配色（用户截图里的图就是）。这里在渲染前按当前主题
  //   惰性初始化；主题变了要重新 initialize 并**清空缓存**（已渲染的 SVG 配色是固化的）。
  let mmdTheme = null;
  function ensureMermaidTheme() {
    if (!window.mermaid || !mermaid.initialize) return;
    const want = document.body.classList.contains('theme-light') ? 'default' : 'dark';
    if (mmdTheme === want) return;
    try { mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: want }); } catch {}
    mmdTheme = want;
    mermaidCache.clear();
  }
  // 渲染完成/命中缓存后挂「⛶ 全屏」按钮（浮层与缩放逻辑见 plugin-loader 的 MI.showSvgFullscreen）
  function attachFs(wrap) {
    if (window.MI && MI.attachMermaidFullscreen) MI.attachMermaidFullscreen(wrap, wrap.querySelector('svg'));
  }
  class MermaidWidget extends WidgetType {
    constructor(code) { super(); this.code = code; }
    eq(other) { return other.code === this.code; }
    toDOM() {
      const wrap = document.createElement('div');
      wrap.className = 'cm-md-mermaid';
      const cached = mermaidCache.get(this.code);
      if (cached != null) { wrap.innerHTML = cached; attachFs(wrap); return wrap; }
      wrap.textContent = '渲染中…';
      (async () => {
        try {
          if (!window.mermaid || !mermaid.render) throw new Error('mermaid 未加载');
          ensureMermaidTheme();                 // 按当前主题初始化（首次 / 换主题后）
          const id = 'mmd-lp-' + Math.random().toString(36).slice(2);
          const { svg } = await mermaid.render(id, this.code);
          mermaidCache.set(this.code, svg);
          if (wrap.isConnected) { wrap.innerHTML = svg; attachFs(wrap); remeasureSoon(); }
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
    // 脚注序号表（按定义行出现顺序）：一次构建只扫一遍全文，行内引用与定义行都用它
    const fnIdx = footnoteIndex(doc.toString());
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
    // 🔴 块级 widget（表格/mermaid）的"源码态"判定只看**光标（head）**，不看选区范围：
    //   用范围判定时，用户拖选一大段、只要**经过**表格/图，它们就整块退回源码（满屏 |），
    //   看起来像"渲染修复无效"（2026-09-28 用户实测）。正确交互（Obsidian 同款）：光标
    //   点进块内才编辑源码；选择跨越时块保持渲染。
    const selHeadLine = doc.lineAt(sel.head);

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
                // task 行：`- ` 整体隐藏，**不画圆点** —— 预览那边是原生 <input type=checkbox>，
                // 勾选框前面没有 bullet；这里再补一个 • 就成了「• ☐ 任务」，两种模式对不上
                // （历史：为了消掉源码里的 "-" 反而多渲染了一个圆点）
                decos.push(Decoration.replace({}).range(bFrom, bTo));
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
            // wiki 链接（Obsidian 语法）：`[[目标]]` / `[[目标|别名]]` / `[[目标#标题]]` / `![[图片]]`。
            // ⚠ 必须在**行级正则**里做，不能靠语法树：lezer 把 `[[alpha]]` 解析成
            //   `Link` 节点只覆盖 `[alpha]`（外层方括号是普通文本，实测），按节点处理会
            //   剩下 `[`/`]` 残留。渲染态只留别名（没别名用目标名），与预览侧
            //   plugin-loader 的 wiki 预处理（→ `[别名](目标)`）视觉一致。
            if (true) {
              const wRe = /(!?)\[\[([^\]\n|#]+)(#[^\]\n|]*)?(\|([^\]\n]*))?\]\]/g;
              let wm2;
              while ((wm2 = wRe.exec(l.text))) {
                const wFrom = l.from + wm2.index;
                const wTo = wFrom + wm2[0].length;
                if (revealsConstruct(wFrom, wTo)) continue;
                const alias = (wm2[5] || '').trim();
                const target = wm2[2].trim() + (wm2[3] || '');
                const label = alias || wm2[2].trim();
                const isEmbed = wm2[1] === '!';
                // 嵌入图片 ![[x.png]] 交给图片渲染；这里只处理链接
                if (isEmbed && /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(target)) continue;
                // 嵌入笔记 ![[笔记]] / ![[笔记#标题]]：整行就是它 → 块级 widget 内嵌渲染
                // （不做的话会走图片分支变裂图，比不做还糟 —— 文档 046 §2.4）
                if (isEmbed && !alias) {
                  const only = /^\s*!\[\[[^\]\n]+\]\]\s*$/.test(l.text);
                  if (only && !revealsConstruct(wFrom, wTo)) {
                    decos.push(Decoration.replace({
                      block: true,
                      widget: new EmbedWidget(wm2[2].trim(), (wm2[3] || '').replace(/^#/, ''), target),
                    }).range(l.from, l.to));
                    continue;
                  }
                }
                // 隐藏 `[[目标#标题|` 与 `]]`，只显示 label
                const pipe = wm2[0].indexOf('|');
                const labelStart = pipe >= 0 ? wFrom + pipe + 1 : wFrom + (isEmbed ? 3 : 2);
                const labelEnd = labelStart + label.length;
                if (labelStart > wFrom) decos.push(Decoration.replace({}).range(wFrom, labelStart));
                if (wTo > labelEnd) decos.push(Decoration.replace({}).range(labelEnd, wTo));
                if (labelEnd > labelStart) decos.push(Decoration.mark({ class: 'cm-md-link' }).range(labelStart, labelEnd));
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
            // 脚注（Obsidian 的 [^1]）：lezer 无对应节点 → 行级正则。
            // 定义行 `[^1]: 内容` → 标记换序号上标 + 正文弱化（与预览的 .md-footnotes 同源）；
            // 行内 `[^1]` → 上标 widget。光标落在定义行时显示源码，方便改内容。
            const fnDef = /^ {0,3}\[\^([^\]]+)\]:[ \t]*(.*)$/.exec(l.text);
            if (fnDef) {
              const label = fnDef[1];
              const no = fnIdx.get(label) || label;
              const markerFrom = l.from + l.text.indexOf('[^');
              const markerTo = markerFrom + fnDef[0].length - fnDef[2].length;   // 含 `]:` 与空白
              if (!onLine(l.from)) {
                decos.push(Decoration.replace({}).range(markerFrom, markerTo));
                decos.push(Decoration.widget({
                  widget: new CalloutIconWidget('[' + no + ']', 'cm-md-fnno'), side: -1,
                }).range(markerFrom));
              }
              decos.push(Decoration.line({ class: 'cm-md-fnline' }).range(l.from));
            } else {
              // 行内引用：跳过定义行与代码（代码块内容行在围栏内，fence 状态用 l.text 判断）
              const fnRefRe = /\[\^([^\]]+)\]/g;
              let fm2;
              while ((fm2 = fnRefRe.exec(l.text))) {
                const rFrom = l.from + fm2.index;
                const rTo = rFrom + fm2[0].length;
                if (revealsMark(rFrom, rTo)) continue;
                const no = fnIdx.get(fm2[1]) || fm2[1];
                decos.push(Decoration.replace({
                  widget: new CalloutIconWidget('[' + no + ']', 'cm-md-fnref'),
                }).range(rFrom, rTo));
              }
            }
          }
        }
        pos = l.to + 1;
      }

      // 列表嵌套深度（按语法树数，比"猜前导空格几格 = 一级"可靠）：
      // 进入 BulletList/OrderedList 记 +1，离开 -1；ListItem 用它换算缩进宽度
      let listDepth = 0;
      Language.syntaxTree(state).iterate({
        from, to,
        enter: (node) => {
          const name = node.name;
          const parent = node.node.parent;
          const parentName = parent ? parent.name : '';
          try {
            if (name === 'BulletList' || name === 'OrderedList') { listDepth++; return; }
            // 嵌套列表项：前导空白替换成与预览同宽的缩进（见 IndentWidget 注释）
            if (name === 'ListItem' && listDepth > 1) {
              const l = doc.lineAt(node.from);
              const ind = /^[ \t]*/.exec(l.text)[0].length;
              if (ind > 0 && l.from + ind <= node.from) {
                decos.push(Decoration.replace({ widget: new IndentWidget(listDepth - 1) }).range(l.from, l.from + ind));
              }
            }
            // ---- 块级元素 ----
            // 围栏代码块：围栏行 block replace（含换行符）真移除 —— CM6 高度模型精确
            // 感知，点击不偏移。光标在代码块内任意行时围栏显示源码（Obsidian：光标
            // 进代码块整块变源码态），内容行保持背景块样式。
            if (name === 'FencedCode') {
              const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
              const cursorIn = !(last.to < selHeadLine.from || first.from > selHeadLine.to);
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
              // 光标不在表内 → 整块渲染成真表格（TableWidget）；光标进入 → 落到下面的逐行源码态
              // （所以"点一下表格就能编辑单元格"这条体验没丢，只是不再常显源码符号）
              if (!(last.to < selHeadLine.from || first.from > selHeadLine.to)) { /* 光标在表内：源码态（只看 head，选区经过不算）*/ }
              else {
                const tsrc = doc.sliceString(node.from, node.to);
                if (parseTable(tsrc)) {
                  decos.push(Decoration.replace({ block: true, widget: new TableWidget(tsrc, node.from) }).range(node.from, node.to));
                  return;
                }
              }
              const SEP_RE = TABLE_SEP_RE;
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
            // 块首行是 `> [!type]` 时按 Callout 渲染：类型色竖线 + 淡底色 + 图标标题
            if (name === 'Blockquote') {
              const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
              const co = parseCallout(first.text);
              if (co) {
                for (let n = first.number; n <= last.number; n++) {
                  const l = doc.line(n);
                  decos.push(Decoration.line({ class: 'cm-md-callout-line ' + co.cls }).range(l.from));
                }
                decos.push(Decoration.line({ class: 'cm-md-callout-first' }).range(first.from));
                decos.push(Decoration.line({ class: 'cm-md-callout-last' }).range(last.from));
                // 首行的 `> [!type]` → 图标 + 标题样式（标题文本保留可编辑；
                // 光标落在首行时整段源码显形，方便改类型/标题）
                const m = /^(\s*>\s*)(\[![A-Za-z]+\][-+]?\s*)(.*)$/.exec(first.text);
                if (m && !onLine(first.from)) {
                  const markerFrom = first.from + m[1].length;
                  const markerTo = markerFrom + m[2].length;
                  decos.push(Decoration.replace({}).range(markerFrom, markerTo));
                  decos.push(Decoration.widget({ widget: new CalloutIconWidget(co.icon), side: -1 }).range(markerFrom));
                  const titleFrom = markerTo, titleTo = first.to;
                  if (titleTo > titleFrom) {
                    decos.push(Decoration.mark({ class: 'cm-md-callout-title' }).range(titleFrom, titleTo));
                  } else {
                    // 没写自定义标题 → 补类型默认名（Obsidian 行为：`> [!warning]` 显示 "⚠️ Warning"）
                    decos.push(Decoration.widget({
                      widget: new CalloutIconWidget(co.title, 'cm-md-callout-title cm-md-callout-ic'), side: 1,
                    }).range(markerTo));
                  }
                }
                return;
              }
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
        // 离开列表节点 → 深度回退（enter 里 return false 的分支不会进列表，无副作用）
        leave: (node) => {
          if (node.name === 'BulletList' || node.name === 'OrderedList') listDepth--;
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

  // ---------- wiki 链接补全（[[笔记]] / [[笔记|别名]] / [[笔记#标题]]） ----------
  // 数据源：项目内 .md 文件（走 window.myIDE.fs.listAll，与 QuickOpen 同一个接口；
  // 单独缓存一份，避免每次敲 [[ 都全盘扫描）。文件树/新建文件后由 viewer 调
  // MdEditor.invalidateWikiIndex() 让它失效。
  let wikiFiles = null;      // [{ name, rel, path }]
  let wikiLoading = null;
  async function loadWikiFiles() {
    // 自检用钩子：允许外部直接给一份文件表。自检**不能**去 App.setRoot 临时项目 ——
    // 那会触发 Session.restore() 把使用者的会话标签拉起来，后面的断言全跑错文档（实测 108 条集体变红）。
    if (Array.isArray(MdEditor.__wikiFiles)) { wikiFiles = MdEditor.__wikiFiles; return wikiFiles; }
    if (wikiFiles) return wikiFiles;
    if (wikiLoading) return wikiLoading;
    const root = window.App && App.root;
    if (!root) { wikiFiles = []; return wikiFiles; }
    wikiLoading = (async () => {
      try {
        const r = await window.myIDE.fs.listAll(root, false);
        wikiFiles = (r.files || [])
          .filter((f) => /\.(md|markdown)$/i.test(f))
          .map((full) => {
            const rel = String(full).slice(root.length).replace(/^[\\/]/, '');
            const name = rel.split(/[\\/]/).pop().replace(/\.(md|markdown)$/i, '');
            return { name, rel, path: full };
          });
      } catch { wikiFiles = []; }
      wikiLoading = null;
      return wikiFiles;
    })();
    return wikiLoading;
  }
  // 标题候选：当前文件用 Outline 已解析的 headings；其他文件按需读盘（只读一次并缓存）
  const headingCache = new Map();   // path -> [text]
  function headingsOfCurrent() {
    try {
      if (window.Outline && Outline.headings) return Outline.headings.map((h) => h.text);
    } catch {}
    return [];
  }
  async function headingsOf(path) {
    if (headingCache.has(path)) return headingCache.get(path);
    let out = [];
    try {
      const r = await window.myIDE.fs.readFile(path);
      if (r && typeof r.content === 'string') {
        const lines = r.content.split('\n');
        let fence = null;
        for (const line of lines) {
          const fm = /^\s*(```+|~~~+)/.exec(line);
          if (fm) { const m = fm[1][0]; if (!fence) fence = m; else if (fence === m) fence = null; continue; }
          if (fence) continue;
          const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
          if (h) out.push(h[1].trim());
        }
      }
    } catch {}
    headingCache.set(path, out);
    return out;
  }
  // CM6 补全源
  function wikiCompletion(ctx) {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = ctx.state.sliceDoc(line.from, ctx.pos);
    // `#` 之后：补当前文件（或 `[[文件#`）的标题
    const inHeading = /\[\[([^\]#|]*)#([^\]|]*)$/.exec(before);
    if (inHeading) {
      const filePart = inHeading[1].trim();
      const q = inHeading[2];
      const from = ctx.pos - q.length;
      if (!filePart) {
        // 当前文件的标题：同步给（Outline 已经解析过）
        const hs = headingsOfCurrent().filter((t) => !q || t.toLowerCase().includes(q.toLowerCase()));
        if (!hs.length) return null;
        return { from, options: hs.slice(0, 50).map((t) => ({ label: t, type: 'keyword', apply: t + ']]' })), filter: false };
      }
      // 指定文件的标题：异步读盘
      const f = (wikiFiles || []).find((x) => x.name === filePart || x.rel === filePart);
      if (!f) return null;
      return headingsOf(f.path).then((hs) => {
        const hit = hs.filter((t) => !q || t.toLowerCase().includes(q.toLowerCase()));
        if (!hit.length) return null;
        return { from, options: hit.slice(0, 50).map((t) => ({ label: t, type: 'keyword', apply: t + ']]' })), filter: false };
      });
    }
    // `[[` 之后：补文件名
    const m = /(!?\[\[)([^\]\n]*)$/.exec(before);
    if (!m) return null;
    const q = m[2];
    const from = ctx.pos - q.length;
    const files = wikiFiles;
    if (!files) {
      // 索引还没建好：先触发加载，同时给一个"正在索引"的提示项
      loadWikiFiles();
      return {
        from,
        options: [{ label: '正在索引项目文件…', type: 'text', apply: '' }],
        filter: false,
      };
    }
    const ql = q.toLowerCase();
    const hit = files
      .filter((f) => !ql || f.name.toLowerCase().includes(ql) || f.rel.toLowerCase().includes(ql))
      .sort((a, b) => {
        const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
        const as = an.startsWith(ql) ? 0 : an.includes(ql) ? 1 : 2;
        const bs = bn.startsWith(ql) ? 0 : bn.includes(ql) ? 1 : 2;
        return as - bs || a.name.length - b.name.length;
      })
      .slice(0, 50);
    if (!hit.length) return null;
    return {
      from,
      options: hit.map((f) => ({
        label: f.name,
        detail: f.rel.includes('\\') ? f.rel.split('\\').slice(0, -1).join('/') : f.rel.split('/').slice(0, -1).join('/'),
        type: 'text',
        apply: f.name + ']]',
      })),
      filter: false,
    };
  }
  // 文件增删/重命名后让索引失效（viewer 在树变化时调用）
  function invalidateWikiIndex() {
    wikiFiles = null;
    headingCache.clear();
  }

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
    // Enter：表格内 → 下移一行（末行补一行）；列表/引用 → 续行；否则走默认
    {
      key: 'Enter',
      run: (v) => tableEdit(v, { dRow: 1 }) || listContinue(v),
    },
    // Tab / Shift-Tab：表格内换格（末格 → 下一行首格，末行末格 → 追加一行并重排对齐）
    { key: 'Tab', run: (v) => tableEdit(v, { dCol: 1 }) },
    { key: 'Shift-Tab', run: (v) => tableEdit(v, { dCol: -1, addIfLast: false }) },
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
      // ⚠ 必须显式开启：CodeMirror 6 **默认不换行**（长行横向滚动）。
      // 正文列限到 820px 之后，长行（长段落 / 表格源码 / 长路径）就不再是"刚好放得下"，
      // 而是直接从列右边溢出被切掉 —— 用户原话「你调低了框度 但是它没有在这个框度换行」。
      EditorView.lineWrapping,
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
      // wiki 链接补全（文档 046 §1.6）：输入 `[[` / `![[` 触发，数据源 = 项目内 .md 文件
      // （复用 QuickOpen 的文件索引），`#` 之后补当前文件的标题（复用 Outline.headings）。
      // Obsidian 的核心手感：`[[` 一敲就出候选列表，Enter 直接补全。
      Autocomplete.autocompletion({
        override: [wikiCompletion],
        activateOnTyping: true,
        closeOnBlur: true,
        icons: false,
      }),
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
    // widget（mermaid/图片）异步把高度撑大后，必须让 CM6 立刻重测 —— 否则它对
    // viewport 外的行仍用估算高度，下方内容的选区/点击坐标整体错位
    liveView = view;
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

  // Callout 类型表对预览侧开放（plugin-loader 后加载）：两边共用一张表，
  // 不会出现"实时预览认得这个类型、预览不认"的漂移。
  // ⚠ `window.MI` 是 plugin-loader.js（后加载）建的 → 这里必须自己兜底建出来，
  //   否则 `if (window.MI)` 永远为假，预览侧拿不到表（实测：预览一个 callout 都不渲染）。
  window.MI = window.MI || {};
  MI.calloutMeta = (type) => {
    const t = String(type || '').toLowerCase();
    const meta = CALLOUT_TYPES[t];
    return meta ? { icon: meta[0], title: meta[1], cls: CALLOUT_CLS[t] || 'co-note' } : null;
  };

  return { create, resolveImgSrc, invalidateWikiIndex, loadWikiFiles };
})();

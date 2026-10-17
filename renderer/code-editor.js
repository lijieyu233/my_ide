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
  const readOnlyComp = new State.Compartment();

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
    // activeLine / searchMatch 背景画在 ::before(z:-3)：drawSelection 的
    // selectionLayer z=-2 在内容之下，元素自身背景会盖住选区高亮（与 md-editor 同源修复）
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
    '.cm-foldPlaceholder': {
      background: 'var(--btn-bg)', border: 'none', color: 'var(--text-dim)',
      padding: '0 6px', margin: '0 2px', borderRadius: '3px',
    },
  });

  // 原生foldAll按可见行跳过外层内部；递归折叠必须把隐藏子块也记入foldState。
  function foldRanges(view) {
    const state=view.state,doc=state.doc,out=new Map(),headings=[];
    const add=r=>{if(r&&r.to>r.from&&r.from>=0&&r.to<=doc.length)out.set(r.from+':'+r.to,r);};
    Language.ensureSyntaxTree(state,doc.length,100);
    Language.syntaxTree(state).iterate({enter(ref){const node=ref.node,fn=node.type.prop(Language.foldNodeProp);if(fn)add(fn(node,state));
      const heading=/^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);if(heading)headings.push({level:Number(heading[1]),line:doc.lineAt(node.from)});}});
    const headingRanges=new Map();
    for(let i=0;i<headings.length;i++){const h=headings[i];let next=i+1;while(next<headings.length&&headings[next].level>h.level)next++;
      const end=next<headings.length?doc.line(headings[next].line.number-1).to:doc.length;
      if(end>h.line.to+1)headingRanges.set(h.line.number,{from:h.line.to+1,to:end,line:h.line.number});}
    for(let n=1;n<=doc.lines;n++){const line=doc.line(n);add(headingRanges.get(n)||Language.foldable(state,line.from,line.to));}
    return [...out.values()].sort((a,b)=>a.from-b.from||b.to-a.to);
  }
  function setFold(view,{folded=true,recursive=false,all=false,range=null,line=null,selection=false}={}) {
    const state=view.state,doc=state.doc,existing=[];
    Language.foldedRanges(state).between(0,doc.length,(from,to)=>existing.push({from,to}));
    if(!all&&!range&&line==null){
      const head=state.selection.main.head;
      // 全文折叠会保留隐藏区内的光标；先操作遮住光标的最外层，否则展开了内部也看不到变化。
      range=existing.filter(r=>r.from<=head&&r.to>=head).sort((a,b)=>(b.to-b.from)-(a.to-a.from))[0]||null;
      if(!range&&!folded&&view.lineBlockAt){
        // 折叠后的闭括号与占位符在同一可见行，不能按闭括号原来的逻辑行寻找展开目标。
        const block=view.lineBlockAt(head);
        range=existing.filter(r=>r.from>=block.from&&r.to<=head&&r.to<=block.to).sort((a,b)=>b.to-a.to||a.from-b.from)[0]||null;
      }
    }
    const ranges=folded||!range&&!all?foldRanges(view):[];
    if(!all&&!range){
      const current=line==null?doc.lineAt(state.selection.main.head):doc.line(Math.max(1,Math.min(line,doc.lines)));
      // 单行JSON的键位于对象范围之前；仅找包含光标的范围会误折叠整个父对象。
      const node=Language.syntaxTree(state).resolveInner(state.selection.main.head,1),property=node.name==='PropertyName'?node.parent:null;
      const value=property?.name==='Property'?property.lastChild:null;
      range=line==null&&value&&['Object','Array'].includes(value.name)?Language.foldInside(value):null;
      range ||= ranges.find(r=>r.line===current.number)||Language.foldable(state,current.from,current.to);
      if(!range){const head=line==null?state.selection.main.head:current.from;
        range=[...existing,...ranges].filter(r=>r.from<=head&&r.to>=head).sort((a,b)=>(a.to-a.from)-(b.to-b.from))[0];}
      if(!range)range=existing.find(r=>doc.lineAt(r.from).number===current.number);
    }
    if(!all&&(!range||range.from<0||range.to>doc.length||range.to<=range.from))return false;
    const selected=selection&&all?state.selection.ranges.filter(r=>!r.empty):[];
    const inside=r=>all?(!selected.length||selected.some(s=>r.from>=s.from&&r.to<=s.to)):r.from===range.from&&r.to===range.to||recursive&&r.from>=range.from&&r.to<=range.to;
    const targets=folded?(all?ranges.filter(inside):recursive?[range,...ranges.filter(inside)]:[range]):existing.filter(inside);
    const effects=[...new Map(targets.map(r=>[r.from+':'+r.to,r])).values()].map(r=>(folded?Language.foldEffect:Language.unfoldEffect).of(r));
    if(effects.length){if(!state.field(Language.foldState,false))effects.unshift(State.StateEffect.appendConfig.of(Language.codeFolding()));view.dispatch({effects});}
    return effects.length>0;
  }
  // PyCharm Windows：Ctrl小键盘±本级，Shift为选区/全文，Alt为当前块递归。
  // 用code识别小键盘，不能把没有Shift的NumpadAdd当成“展开全部”。
  function foldingShortcut(event) {
    if(event.defaultPrevented||event.isComposing||event.keyCode===229||!(event.ctrlKey||event.metaKey)||event.shiftKey&&event.altKey)return null;
    const minus=event.code==='NumpadSubtract'||event.code==='Minus'||['-','_'].includes(event.key);
    const plus=event.code==='NumpadAdd'||event.code==='Equal'||['+','='].includes(event.key);
    if(!minus&&!plus)return null;
    return {folded:minus,all:!!event.shiftKey,recursive:!!event.altKey,selection:!!event.shiftKey};
  }
  function foldingKeys() {
    return EditorView.domEventHandlers({keydown(event,view){
      if(window.Modal?.stack.length||window.Shortcuts?.isCapturing?.())return false;
      const options=foldingShortcut(event);if(!options)return false;
      event.preventDefault();event.stopPropagation();setFold(view,options);return true;
    }});
  }
  function parseJsonOutline(content) {
    const text=String(content||'').replace(/\r\n?/g,'\n'),tree=CodeLangs.json().language.parser.parse(text),entries=[];
    const starts=[0];for(let n=0;n<text.length;n++)if(text[n]==='\n')starts.push(n+1);
    const lineAt=pos=>{let lo=0,hi=starts.length;while(lo+1<hi){const mid=(lo+hi)>>1;if(starts[mid]<=pos)lo=mid;else hi=mid;}return lo+1;};
    const valueTypes=new Set(['Object','Array','String','Number','True','False','Null']);
    const decode=n=>{const value=text.slice(n.from,n.to);try{return JSON.parse(value);}catch{return value;}};
    const structure=node=>node&&(node.name==='Object'||node.name==='Array');
    const stack=[];for(let n=tree.topNode.lastChild;n;n=n.prevSibling)if(structure(n))stack.push({node:n,level:1,label:n.name==='Array'?'根数组':'根对象',from:n.from});
    while(stack.length){const {node,level,label,from}=stack.pop();
      entries.push({level,text:label,line:lineAt(from),from,to:node.to,key:'json:'+from+':'+label,type:node.name,fold:Language.foldInside(node)});
      const children=[];let index=0;
      for(let child=node.firstChild;child;child=child.nextSibling){
        if(node.name==='Object'&&child.name==='Property'){const key=child.firstChild,value=child.lastChild;if(key?.name==='PropertyName'&&structure(value))children.push({node:value,level:level+1,label:String(decode(key)),from:key.from});}
        else if(node.name==='Array'&&valueTypes.has(child.name)){const label='['+(index++)+']';if(structure(child))children.push({node:child,level:level+1,label,from:child.from});}
      }
      for(let i=children.length-1;i>=0;i--)stack.push(children[i]);
    }
    return entries;
  }

  // ---------- Git Blame 注解 gutter（PyCharm Annotate 式，viewer 调 setBlame 开关） ----------
  // Compartment 动态挂载：无 blame 数据时不占 gutter 宽度；编辑文档后由 viewer 主动清空（行号会错位）
  function blameFmtDate(ts) {
    const d = new Date(ts || 0); // git blame 行注解的 timestamp 已是毫秒
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // ---------- AI 行内补全（ghost text，Copilot 式：Tab 接受 / 任意编辑即隐） ----------
  // 模块级单建议模型：同一时刻最多一个活跃 ghost（哪个编辑器触发的就存哪个 view）
  let ghostTimer = null; // 防抖句柄
  let ghostBusy = false; // 请求进行中（防重入）
  let curGhost = null;   // { view, pos, text } 活跃建议

  // ghost 文本装饰 widget（行内灰色斜体，不可聚焦、不拦截事件）
  class GhostWidget extends View.WidgetType {
    constructor(text) { super(); this.text = text; }
    eq(o) { return o.text === this.text; }
    toDOM() {
      const span = document.createElement('span');
      span.className = 'cm-ghost-text';
      span.textContent = this.text;
      return span;
    }
    ignoreEvent() { return true; }
  }

  function ghostEnabled() {
    try {
      const cfg = window.AiPanel && AiPanel.getConfig ? AiPanel.getConfig() : null;
      return !!(cfg && cfg.inlineComplete && cfg.baseUrl && cfg.model);
    } catch { return false; }
  }

  function ghostDeco(view, text) {
    const pos = view.state.selection.main.head;
    return View.Decoration.set([View.Decoration.widget({ widget: new GhostWidget(text), side: 1 }).range(pos)]);
  }

  function ghostClear(view) {
    curGhost = null;
    if (view && view._ghostConf) {
      try { view.dispatch({ effects: view._ghostConf.reconfigure(EditorView.decorations.of(View.Decoration.none)) }); } catch {}
    }
  }

  // 防抖触发一次补全：取光标前 2000 / 后 500 字符作上下文（伪 FIM）
  function ghostSchedule(view) {
    clearTimeout(ghostTimer);
    ghostTimer = setTimeout(() => ghostRequest(view), 700);
  }

  function ghostRequest(view) {
    if (!view || !view.dom || ghostBusy || !ghostEnabled()) return;
    ghostBusy = true;
    const cfg = window.AiPanel.getConfig();
    const pos = view.state.selection.main.head;
    const prefix = view.state.doc.sliceString(Math.max(0, pos - 2000), pos);
    const suffix = view.state.doc.sliceString(pos, Math.min(view.state.doc.length, pos + 500));
    const lastLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
    if (!lastLine.trim() && !suffix.trim()) { ghostBusy = false; return; } // 空行空后缀不请求
    const msgs = [
      { role: 'system', content: '你是代码补全引擎。根据光标前后的代码补全光标处应插入的内容。只输出要插入的代码本身，不要解释、不要代码块围栏、不要重复光标前的内容，最多 3 行。' },
      { role: 'user', content: '光标前：\n' + prefix + '\n⟨光标⟩\n光标后：\n' + suffix },
    ];
    window.myIDE.ai.chat(cfg, msgs, []).then((r) => {
      ghostBusy = false;
      if (!r || r.error || !r.text) return;
      let sug = String(r.text).replace(/^```[\w]*\n?|```$/g, '').trimEnd();
      if (!sug || sug.length > 300) return;
      // 等待期间光标动了 / 编辑器已销毁 → 丢弃
      if (!view.dom || view.state.selection.main.head !== pos) return;
      curGhost = { view, pos, text: sug };
      view.dispatch({ effects: view._ghostConf.reconfigure(EditorView.decorations.of(ghostDeco(view, sug))) });
    }).catch(() => { ghostBusy = false; });
  }

  // Tab 接受建议（必须在 indentWithTab 之前绑定才优先生效）
  function ghostAccept(view) {
    if (!curGhost || curGhost.view !== view) return false;
    if (view.state.selection.main.head !== curGhost.pos) { ghostClear(view); return false; }
    view.dispatch({
      changes: { from: curGhost.pos, insert: curGhost.text },
      selection: { anchor: curGhost.pos + curGhost.text.length },
    });
    ghostClear(view);
    return true;
  }

  // ---------- 创建编辑器 ----------
  function create(opts) {
    const parent = opts.parent;
    const lang = codeLangOf(opts.ext);
    let blameRows = null; // [{ oid, short, author, timestamp, uncommitted }] 按行号索引
    const blameConf = new State.Compartment();
    const ghostConf = new State.Compartment();
    const blameGutter = View.gutter({
      class: 'cm-blame-gutter',
      lineMarker(view, line) {
        if (!blameRows) return null;
        const row = blameRows[line.number - 1];
        if (!row) return null;
        // 同一提交的连续行只标首行（PyCharm 式，避免整屏重复）
        const prev = blameRows[line.number - 2];
        if (prev && !row.uncommitted && !prev.uncommitted && row.oid && prev.oid === row.oid) return null;
        const el = document.createElement('div');
        el.className = 'cm-blame-item' + (row.uncommitted ? ' uncommitted' : '');
        if (row.uncommitted) {
          el.textContent = '未提交';
          el.title = '工作区未提交的更改';
        } else {
          const ds = blameFmtDate(row.timestamp || 0);
          el.textContent = (row.author || '未知') + ' ' + ds;
          el.title = (row.author || '') + ' · ' + ds + ' · ' + (row.short || row.oid || '');
        }
        return el;
      },
    });
    const state = opts.state || EditorState.create({
      doc: opts.doc || '',
      extensions: [
        ...TextLines.extension(CM, opts.doc || ''),
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
        foldingKeys(),
        keymap.of([
          // Tab 优先接受 AI 行内补全（ghost text），否则落到缩进 Tab
          { key: 'Tab', run: ghostAccept },
          { key: 'Mod-d', preventDefault: true, run: Commands.deleteLine }, // Ctrl+D 删除当前行
          ...Autocomplete.closeBracketsKeymap,
          ...Commands.defaultKeymap,
          ...Search.searchKeymap,
          ...Commands.historyKeymap,
          ...Autocomplete.completionKeymap,
          Commands.indentWithTab,
          // Viewer的保存键由Shortcuts统一消费，不能让CM默认Ctrl+S抢掉用户改过的键位。
          ...(opts.saveKeysInShortcuts ? [] : [{ key: 'Mod-s', preventDefault: true, run: () => { if (opts.onSave) opts.onSave(); return true; } }]),
          { key: 'Mod-Enter', preventDefault: true, run: () => { if (opts.onRun) { opts.onRun(); return true; } return false; } },
        ]),
        Autocomplete.closeBrackets(),
        opts.completions ? Autocomplete.autocompletion({ override: [opts.completions] }) : [], // 自定义补全源（SQL 等）
        Search.search({ top: true }), // Ctrl+F / Ctrl+H 搜索面板置顶
        blameConf.of([]), // Git Blame 注解（setBlame 动态挂载）
        ghostConf.of(EditorView.decorations.of(View.Decoration.none)), // AI 行内补全 ghost text
        lang || [],
        EditorView.updateListener.of((u) => {
          if(!u.docChanged&&Language.foldedRanges(u.startState)!==Language.foldedRanges(u.state))window.Outline?.syncFromEditor?.(u.view);
          // AI 行内补全：文档变化先清建议，防抖后重新请求；纯移动光标只清除
          if (u.docChanged || u.selectionSet) {
            if (curGhost && curGhost.view === view) ghostClear(view);
          }
          if (u.docChanged && ghostEnabled()) ghostSchedule(view);
          if ((u.docChanged || TextLines.raw(u.startState) !== TextLines.raw(u.state)) && opts.onChange) opts.onChange(TextLines.raw(u.state),u.changes);
          if ((u.docChanged || u.selectionSet) && opts.onCursor) {
            const head = u.state.selection.main.head;
            const before = u.state.doc.sliceString(0, head);
            const line = before.split('\n').length;
            const col = head - before.lastIndexOf('\n');
            opts.onCursor(line, col, head, u.state);
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent, dispatchTransactions(trs, current) {
      // 搜索按钮、快捷键和迟到补全都可能直接派发事务；DOM禁用不能代替正文归属检查。
      if (opts.canEdit && !opts.canEdit() && trs.some(tr => tr.docChanged || TextLines.raw(tr.startState) !== TextLines.raw(tr.state))) return;
      current.update(trs);
    } });
    view.dispatch({ effects: readOnlyComp.get(view.state) === undefined
      ? State.StateEffect.appendConfig.of(readOnlyComp.of([])) : readOnlyComp.reconfigure([]) });
    view._ghostConf = ghostConf; // ghost 补全 dispatch 用（模块级函数取）
    // 关闭 Chromium 拼写检查（代码文件不需要下划线拼写提示）
    view.contentDOM.spellcheck = false;
    view.contentDOM.setAttribute('autocorrect', 'off');
    view.contentDOM.setAttribute('autocapitalize', 'off');

    return {
      view,
      fold(options) { return setFold(view,options); },
      setReadOnly(on) { view.dispatch({ effects: readOnlyComp.reconfigure(on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) }); },
      focus() { view.focus(); },
      getValue() { return view.state.doc.toString(); },
      getState() { return view.state; },
      setValue(text) {
        view.dispatch({
          effects: TextLines.reset(String(text == null ? '' : text)),
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
      // Git Blame 注解：rows = git blame 返回的 lines（null 关闭）
      setBlame(rows) {
        blameRows = Array.isArray(rows) ? rows : null;
        view.dispatch({ effects: blameConf.reconfigure(blameRows ? [blameGutter] : []) });
      },
      hasBlame() { return !!blameRows; },
      destroy() { try { view.destroy(); } catch {} },
    };
  }

  return { create, setFold, foldRanges, foldingShortcut, foldingKeys, parseJsonOutline };
})();

(()=>{
  const W=AiWorkbench,F=W.fail;
  const tabs=()=>Viewer.openTabs.map(t=>({id:String(t.id),path:t.path,name:t.name,dirty:!!t.dirty,revision:t.editRevision,mode:t.mode,error:t.error||null}));
  const find=id=>{const t=id?Viewer.openTabs.find(t=>String(t.id)===id):Viewer.activeTab;if(!t)F('TAB_NOT_FOUND','标签不存在，请先读取editor_state');return t;};
  function range(t){const cm=Viewer.cm;if(cm?.__tab===t){const s=cm.view.state.selection.main;return {from:s.from,to:s.to,head:s.head};}return {from:t.ta?.selectionStart||0,to:t.ta?.selectionEnd||0,head:t.ta?.selectionEnd||0};}
  function editorState(){const t=Viewer.activeTab;return {project:W.root(),tabs:tabs(),active:t?String(t.id):null,selection:t?range(t):null,content:t?.content??null};}
  function headings(t){let at=0,fence=null;const out=[];for(const line of String(t.content||'').split('\n')){const marker=/^\s*(`{3,}|~{3,})/.exec(line);if(marker){if(!fence)fence=marker[1][0];else if(fence===marker[1][0])fence=null;}const m=!fence&&/^(#{1,6})\s+(.+?)\s*$/.exec(line);if(m)out.push({id:'heading-'+out.length,title:m[2],level:m[1].length,from:at,to:at+line.length});at+=line.length+1;}return out;}
  function select(t,from,to){if(from>to||to>String(t.content||'').length)F('INVALID_SELECTION','选区超出文档');const cm=Viewer.cm;if(cm?.__tab===t){cm.setCursor(from,to);return;}if(!t.ta)F('EDITOR_READ_ONLY','请先切换到源码或编辑模式');t.ta.setSelectionRange(from,to);}
  function replace(t,from,to,text){const cm=Viewer.cm;if(cm?.__tab===t){if(cm.view.state.readOnly)F('EDITOR_READ_ONLY','编辑器只读');cm.view.dispatch({changes:{from,to,insert:text},selection:{anchor:from+text.length},userEvent:'input.ai'});return;}
    if(!t.ta||t.ta.readOnly)F('EDITOR_READ_ONLY','请先切换到编辑模式');t.ta.focus();t.ta.setSelectionRange(from,to);if(!document.execCommand?.('insertText',false,text)){t.ta.setRangeText(text,from,to,'end');t.ta.dispatchEvent(new Event('input',{bubbles:true}));}}
  W.register('editor',{state:editorState,async operate(call){
    const a=call.args,t=find(a.tab);
    if(call.name==='editor_state'){const content=String(t.content??''),offset=a.offset||0,limit=a.limit||30000;return W.observe('editor',{tabs:tabs(),active:String(Viewer.activeTab?.id||''),tab:String(t.id),path:t.path,revision:t.editRevision,dirty:!!t.dirty,mode:t.mode,selection:range(t),offset,text:content.slice(offset,offset+limit),nextOffset:Math.min(offset+limit,content.length),total:content.length,complete:offset+limit>=content.length,headings:headings(t)});}
    if(call.name==='outline_change'){
      if(!/\.(md|markdown)$/i.test(t.name))F('NOT_MARKDOWN','当前文档不是Markdown');const list=headings(t),h=list.find(h=>h.id===a.heading);if(!h)F('HEADING_NOT_FOUND','标题不在当前文档');
      if(a.operation==='rename'||a.operation==='level'){const title=a.operation==='rename'?a.title:h.title,level=a.operation==='level'?a.level:h.level;if(!title?.trim()||/[\r\n]/.test(title)||!level)F('INVALID_HEADING','标题或层级无效');replace(t,h.from,h.to,'#'.repeat(level)+' '+title);}
      else {const dest=list.find(h=>h.id===a.before);if(!dest)F('HEADING_NOT_FOUND','缺少目标标题');const end=list.find(v=>v.from>h.from&&v.level<=h.level)?.from||t.content.length;if(dest.from>=h.from&&dest.from<end)F('INVALID_MOVE','章节不能移入自身');const body=t.content,section=body.slice(h.from,end),removed=body.slice(0,h.from)+body.slice(end),at=dest.from<h.from?dest.from:dest.from-(end-h.from);replace(t,0,body.length,removed.slice(0,at)+section.replace(/\n?$/,'\n')+removed.slice(at));}
      await Outline.refresh(t);return {ok:true,committed:true,tab:String(t.id),revision:t.editRevision,headings:headings(t)};
    }
    const index=Viewer.openTabs.indexOf(t);
    if(a.operation==='activate'){await Viewer.activate(index);if(t.loadPromise)await t.loadPromise;return {ok:Viewer.activeTab===t,active:String(Viewer.activeTab?.id)};}
    if(a.operation==='close'){if(t.dirty){if(!a.save)return {ok:false,errorCode:'UNSAVED_CHANGES',error:'标签有未保存内容，已保留；可先save或指定save=true',choices:['save','keep']};const saved=await Viewer.saveTab(index,true);if(!saved?.ok)return saved;}await Viewer.closeTab(index);return {ok:!Viewer.openTabs.includes(t),closed:String(t.id)};}
    if(a.operation==='save_all')return Viewer.saveAllDirty();
    if(a.operation==='save')return Viewer.saveTab(index,true);
    if(t!==Viewer.activeTab)F('TAB_NOT_ACTIVE','请先激活目标标签，再读取新的快照');
    if(a.operation==='select')select(t,a.from??0,a.to??a.from??0);
    else if(a.operation==='replace_selection'){if(typeof a.text!=='string')F('INVALID_TOOL_ARGS','缺少替换文本');const r=range(t);replace(t,r.from,r.to,a.text);}
    else if(a.operation==='goto'){if(!a.line)F('INVALID_TOOL_ARGS','缺少行号');const lines=String(t.content||'').split('\n');if(a.line>lines.length)F('INVALID_SELECTION','行号超出文档');const pos=lines.slice(0,a.line-1).reduce((n,s)=>n+s.length+1,0)+Math.min((a.column||1)-1,lines[a.line-1].length);select(t,pos,pos);Viewer.revealLine(a.line);}
    else if(['undo','redo'].includes(a.operation)){if(Viewer.cm?.__tab===t){if(!CM6.Commands[a.operation](Viewer.cm.view))return {ok:false,errorCode:'HISTORY_EMPTY',error:'没有可'+a.operation+'的编辑'};}else if(!t.ta||!document.execCommand?.(a.operation))return {ok:false,errorCode:'HISTORY_UNAVAILABLE',error:'此编辑模式没有可用撤销记录'};}
    return {ok:true,committed:['replace_selection','undo','redo'].includes(a.operation),tab:String(t.id),revision:t.editRevision,selection:range(t),dirty:!!t.dirty};
  }});
  W.register('project',{state:()=>({root:W.root(),projects:App.getProjects(),tabs:tabs(),expanded:Tree.getExpandedPaths()}),async operate(call){
    const a=call.args;if(a.operation==='open'){if(!a.directory)F('INVALID_TOOL_ARGS','缺少项目绝对路径');const ok=await App.openProject(a.directory);return {ok:ok===true,root:W.root(),preserved:ok===true};}
    if(a.operation==='close'){const directory=a.directory||W.root();if(!App.getProjects().some(p=>W.key(p.path)===W.key(directory)))F('PROJECT_NOT_FOUND','项目不在已打开列表');const ok=await App.removeProject(directory);return {ok:ok===true,root:W.root()};}
    return Tree.aiControl(a);
  }});
  const STYLE_KEY='myide-md-reading-style';
  function reading(){try{return JSON.parse(localStorage.getItem(STYLE_KEY)||'{}');}catch{return {};}}
  function applyReading(value){const style=document.documentElement.style;for(const [key,name,suffix]of [['titleColor','--md-title',''],['lineHeight','--md-line-height',''],['readingWidth','--md-reading-width','em']]){if(value[key]!=null)style.setProperty(name,value[key]+suffix);else style.removeProperty(name);}if(value.fontSize)Viewer.applyFontSize(value.fontSize);}
  document.addEventListener('DOMContentLoaded',()=>applyReading(reading()));
  W.register('markdown',{state:()=>({root:W.root(),tab:Viewer.activeTab?{id:String(Viewer.activeTab.id),path:Viewer.activeTab.path,revision:Viewer.activeTab.editRevision,mode:Viewer.activeTab.mode}:null,style:reading()}),async operate(call){
    if(call.name==='markdown_state')return W.observe('markdown');const a=call.args,t=find();
    if(a.operation==='style'){const fields=Object.fromEntries(['titleColor','fontSize','lineHeight','readingWidth'].filter(k=>a[k]!=null).map(k=>[k,a[k]]));const next={...reading(),...fields};localStorage.setItem(STYLE_KEY,JSON.stringify(next));applyReading(next);return {ok:true,style:next};}
    if(a.operation==='mode'){if(!/\.(md|markdown)$/i.test(t.name)||!a.mode)F('NOT_MARKDOWN','需要Markdown文档与有效模式');t.mode=a.mode;localStorage.setItem('myide-md-mode',a.mode);Viewer.renderActive();return {ok:Viewer.activeTab.mode===a.mode,mode:t.mode};}
    if(a.operation==='refresh'){Viewer.renderActive();return {ok:true,mode:t.mode};}
    if(a.operation==='heading'){const h=headings(t).find(h=>h.id===a.heading);if(!h)F('HEADING_NOT_FOUND','标题已变化');Viewer.revealLine(t.content.slice(0,h.from).split('\n').length);return {ok:true,heading:h};}
    if(!/\.html?$/i.test(t.name))F('NOT_HTML','当前文档不是HTML');
    const url='file:///'+t.path.replace(/\\/g,'/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/,'$1:');
    if(a.operation==='browser'){await BrowserPanel.open(url);return {ok:App.getTool()==='browser',url};}
    if(a.operation==='external'){await myIDE.shell.openExternal(url);return {ok:true,dispatched:true,url};}
    F('INVALID_TOOL_ARGS','未知预览操作');
  }});
})();

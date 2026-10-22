// 编辑草稿跟随书籍模型而非DOM；关闭面板、换标签和项目恢复都不能丢掉正在输入的内容。
window.ReaderNotes=(()=>{
 const cache=new Map(),loading=new Map(),actions=new Set();let active=null;
 const clone=value=>JSON.parse(JSON.stringify(value));
 const identity=c=>c?c.root.replace(/\\/g,'/').toLowerCase()+'|'+c.book:'';
 function context(){const c=Reader.notesContext();if(!c)throw Error('请先打开工作区内的书籍，再使用阅读笔记');return c;}
 function current(c){return identity(Reader.notesContext())===identity(c.ctx);}
 async function get(ctx=context()){
  const key=identity(ctx);if(cache.has(key))return cache.get(key);if(loading.has(key))return loading.get(key);
  const task=(async()=>{await Reader.ensureWorkspace(ctx.root);await Reader.syncProgress(ctx.root);const result=await myIDE.reader.notesRead(ctx.root,ctx.book);if(!result.ok)throw Error(result.error||'笔记读取失败');const c={ctx,notes:result.notes,version:result.version,revision:0,error:null,draft:null,open:false};cache.set(key,c);return c;})();
  loading.set(key,task);try{return await task;}finally{loading.delete(key);}
 }
 function status(c){if(active?.c!==c||!active.panel.isConnected)return;const out=active.panel.querySelector('.reader-notes-status');out.textContent=c.error?'保存失败：'+c.error:c.draft?.dirty?'正在保存…':c.saving?'正在保存…':c.notes.length?'已保存到工作区':'输入内容后自动保存';out.classList.toggle('error',!!c.error);active.panel.querySelector('[data-note-retry]').hidden=!c.error;active.panel.querySelector('[data-note-reload]').hidden=!c.error;}
 function queue(c){const notes=clone(c.notes);c.saves=(c.saves||0)+1;c.saving=true;status(c);c.pending=(c.pending||Promise.resolve()).then(async()=>{if(c.error)throw Error(c.error);const result=await myIDE.reader.notesSave(c.ctx.root,c.ctx.book,notes,c.version);if(!result.ok)throw Error(result.error||'笔记未保存');c.version=result.version;}).catch(e=>{if(c.error!==e.message)MI.toast('阅读笔记保存失败：'+e.message+'；输入已保留，可复制后重试','err');c.error=e.message;}).finally(()=>{c.saves--;c.saving=c.saves>0;status(c);});}
 function commit(c){clearTimeout(c.timer);const d=c.draft;if(!d?.dirty)return;const index=c.notes.findIndex(n=>n.id===d.id);if(index<0&&!d.title.trim()&&!d.body.trim()&&!d.quote.trim()){d.dirty=false;status(c);return;}if(index<0&&c.notes.length>=200)throw Error('每本书最多200条笔记');const note=clone({...d,updated:Date.now()});delete note.dirty;if(index<0)c.notes.unshift(note);else c.notes[index]=note;d.updated=note.updated;d.dirty=false;c.revision++;queue(c);drawList(c);}
 async function drain(c){let pending;do{pending=c.pending;await pending;}while(pending!==c.pending);if(c.error)throw Error(c.error);}
 async function flushAll(){await Promise.allSettled([...actions]);for(const c of cache.values())commit(c);for(const c of cache.values())await drain(c);}
 async function retry(){const c=await get();commit(c);await c.pending;c.error=null;queue(c);await drain(c);}
 async function reload(){const ctx=context(),c=await get(ctx),revision=c.revision;if(!await Modal.confirm('重新载入笔记','重新载入会放弃当前未保存的笔记修改。请先复制需要保留的内容，再继续。'))return;if(!current(c)||c.revision!==revision)throw Error('笔记已变化，请重新载入');await c.pending;const result=await myIDE.reader.notesRead(ctx.root,ctx.book);if(!result.ok)throw Error(result.error||'笔记读取失败');if(!current(c)||c.revision!==revision)throw Error('笔记已变化，请重新载入');const selected=c.draft?.id;c.notes=result.notes;c.version=result.version;c.error=null;c.draft=clone(c.notes.find(n=>n.id===selected)||c.notes[0]||null);if(c.draft)c.draft.dirty=false;c.revision++;draw(c);}
 function snapshot(){const ctx=Reader.notesContext(),c=cache.get(identity(ctx));return {book:ctx?.book||null,root:ctx?.root||null,ready:!!c,revision:c?.revision||0,version:c?.version||null,error:c?.error||null};}
 async function read(offset=0,limit=20,kind='all',query=''){const ctx=context(),c=await get(ctx);if(!current(c))throw Error('阅读书籍已切换');commit(c);await drain(c);if(!current(c))throw Error('阅读书籍已切换');const records=c.notes.filter(n=>(kind==='all'||(kind==='excerpt'?isExcerpt(n):!isExcerpt(n)&&n.kind===kind))&&(!query||(n.title+' '+n.quote+' '+n.body+' '+n.source.chapterTitle).toLowerCase().includes(query.toLowerCase())));return {book:ctx.book,workspace:ctx.root,total:records.length,notes:clone(records.slice(offset,offset+limit)),offset,nextOffset:Math.min(records.length,offset+limit)};}
 async function write(args){const ctx=context(),c=await get(ctx);if(!current(c))throw Error('阅读书籍已切换');commit(c);const revision=c.revision;await drain(c);if(!current(c)||revision!==c.revision)throw Error('阅读笔记已变化，请重新读取');
  if(args.operation==='save'&&!args.note&&![args.title,args.body,args.quote].some(v=>typeof v==='string'&&v.trim()))throw Error('新建笔记需要标题、内容或摘录');
  const index=c.notes.findIndex(n=>n.id===args.note);
  if(args.operation==='remove'){if(index<0)throw Error('笔记不存在或不属于当前书籍');c.notes.splice(index,1);if(c.draft?.id===args.note)c.draft=null;}
  else{if(args.note&&index<0)throw Error('笔记不存在或不属于当前书籍');if(index<0&&c.notes.length>=200)throw Error('每本书最多200条笔记');const old=index<0?null:c.notes[index],note={id:old?.id||crypto.randomUUID(),kind:args.kind||old?.kind||'note',title:args.title??old?.title??ctx.chapterTitle,body:args.body??old?.body??'',quote:args.quote??old?.quote??'',source:old?.source||source(ctx),created:old?.created||Date.now(),updated:Date.now()};if(!note.title.trim()&&!note.body.trim()&&!note.quote.trim())throw Error('请先输入笔记内容');if(note.kind==='excerpt'&&!note.quote.trim())throw Error('摘录需要原文');if(index<0)c.notes.unshift(note);else c.notes[index]=note;if(c.draft?.id===note.id)c.draft={...clone(note),dirty:false};args={...args,note:note.id};}
  c.revision++;queue(c);draw(c);await drain(c);return {ok:true,book:ctx.book,note:args.note,total:c.notes.length};
 }
 const source=c=>({index:c.index,chapterTitle:c.chapterTitle,version:c.version,anchor:c.anchor});
 const isExcerpt=note=>note.kind==='excerpt'||(note.kind==='note'&&!!note.quote);
 const modeOf=note=>isExcerpt(note)?'excerpts':'notes';
 const matching=c=>c.notes.filter(n=>modeOf(n)===(c.mode||'notes')&&(!c.query||(n.title+' '+n.quote+' '+n.body+' '+n.source.chapterTitle).toLowerCase().includes(c.query.toLowerCase())));
 function action(label,fn,cls=''){const b=document.createElement('button');b.type='button';b.className='reader-button '+cls;b.textContent=label;b.onclick=()=>{if(!b.isConnected)return;const pending=Promise.resolve().then(fn).catch(e=>MI.toast(e.message,'err')).finally(()=>actions.delete(pending));actions.add(pending);};return b;}
 function edit(c,note){commit(c);c.draft=clone(note);c.draft.dirty=false;c.mode=modeOf(note);c.screen='edit';c.revision++;draw(c);}
 function begin(c,quote='',at,ctx=context(),range){
  commit(c);if(identity(ctx)!==identity(c.ctx))throw Error('阅读书籍已切换');
  if(quote){const existing=c.notes.find(n=>isExcerpt(n)&&n.quote===quote&&n.source.version===ctx.version&&n.source.index===ctx.index&&JSON.stringify(n.source.range||null)===JSON.stringify(range||null));if(existing){edit(c,existing);return existing;}}
  if(c.notes.length>=200)throw Error('每本书最多200条记录，请先删除不需要的记录');
  c.draft={id:crypto.randomUUID(),kind:quote?'excerpt':'note',title:'',body:'',quote,source:{...source(ctx),anchor:at||ctx.anchor,...(range?{range}: {})},created:Date.now(),updated:Date.now(),dirty:!!quote};c.mode=quote?'excerpts':'notes';c.screen='edit';c.query='';c.revision++;if(quote)commit(c);draw(c);return c.draft;
 }
 function drawList(c){
  if(active?.c!==c||!active.panel.isConnected)return;const panel=active.panel,list=panel.querySelector('.reader-notes-list');list.replaceChildren();const entries=matching(c);
  for(const mode of ['excerpts','notes']){const tab=panel.querySelector('[data-record-mode="'+mode+'"]');tab.textContent=(mode==='excerpts'?'摘录':'笔记')+' '+c.notes.filter(n=>modeOf(n)===mode).length;tab.setAttribute('aria-pressed',String(c.mode===mode));}
  if(!entries.length){const empty=document.createElement('p');empty.className='reader-notes-empty';empty.textContent=c.query?'没有匹配的记录':c.mode==='excerpts'?'选中正文后，点击“保存摘录”；也可以为摘录写下想法。':'这里保存独立的阅读笔记与章节总结。点击“新建笔记”开始记录。';list.append(empty);}
  for(const note of entries){const card=document.createElement('div');card.className='reader-record-card';card.dataset.record=note.id;const b=action('',()=>edit(c,note),'reader-note-item');b.dataset.note=note.id;const tag=document.createElement('small');tag.textContent=isExcerpt(note)?'摘录':note.kind==='summary'?'章节总结':'笔记';const title=document.createElement('strong');title.textContent=note.title|| (isExcerpt(note)?note.quote.slice(0,60):note.body.slice(0,60)) ||'未命名笔记';const preview=document.createElement('span');preview.className='reader-record-preview';preview.textContent=isExcerpt(note)?note.quote:note.body;const meta=document.createElement('small');meta.textContent=note.source.chapterTitle+(note.body&&isExcerpt(note)?' · 已有想法':'');b.append(tag);if(note.title)b.append(title);b.append(preview,meta);const jump=action('回到原文',()=>jumpTo(c,note));jump.dataset.recordJump=note.id;jump.disabled=note.source.version!==Reader.notesContext()?.version;jump.title=jump.disabled?'原书已更新，旧记录仍保留':'跳到记录的章节和段落';card.append(b,jump);list.append(card);}
  panel.querySelector('[data-note-search]').value=c.query||'';panel.querySelector('[data-note-new]').hidden=c.mode==='excerpts';painted(active);
 }
 function draw(c){
  if(active?.c!==c||!active.panel.isConnected)return;c.mode||='notes';drawList(c);const panel=active.panel,d=c.draft,editing=c.screen==='edit'&&!!d,form=panel.querySelector('.reader-note-form');form.hidden=!editing;panel.dataset.screen=editing?'edit':'list';panel.querySelector('.reader-notes-header strong').textContent=c.mode==='excerpts'?'摘录':'阅读笔记';panel.querySelector('[data-note-back]').hidden=!editing;panel.querySelector('[data-note-new]').hidden=editing||c.mode==='excerpts';
  active.toggle.setAttribute('aria-expanded',String(!panel.hidden&&c.mode==='notes'));active.excerpt.setAttribute('aria-expanded',String(!panel.hidden&&c.mode==='excerpts'));
  if(editing){const excerpt=isExcerpt(d);form.querySelector('[data-note-kind]').value=excerpt?'note':d.kind;form.querySelector('[data-note-kind]').closest('label').hidden=excerpt;form.querySelector('[data-note-title]').value=d.title;form.querySelector('[data-note-title]').placeholder=excerpt?'摘录标题（可选）':'笔记标题（可选）';form.querySelector('[data-note-body]').value=d.body;form.querySelector('[data-note-body]').placeholder=excerpt?'写下对这段原文的想法（可选）…':'写下阅读想法，内容自动保存…';form.querySelector('[data-note-body-label]').textContent=excerpt?'想法（可选）':'笔记内容';const quote=form.querySelector('blockquote');quote.textContent=d.quote;quote.hidden=!d.quote;const link=form.querySelector('[data-note-source]');link.textContent='回到原文 · '+d.source.chapterTitle;link.disabled=d.source.version!==Reader.notesContext()?.version;link.title=link.disabled?'原书已更新，旧记录仍保留':'回到记录时的章节和段落';form.querySelector('[data-note-clear-comment]').hidden=!excerpt||!d.body;form.querySelector('[data-note-delete]').textContent=excerpt?'删除摘录':'删除笔记';}
  status(c);
 }
 async function show(view,mode='notes',resume=false){
  const ctx=Reader.notesContext(view.tab);if(!ctx)throw Error('记录保存在工作区，请先将书籍放入工作区');const c=await get(ctx);if(view.disposed||!view.body.isConnected||!current(c))return;
  if(active&&active!==view)detach(active);view.c=c;active=view;commit(c);c.open=true;if(!resume){c.mode=mode;c.screen='list';c.draft=null;c.query='';}c.mode||='notes';view.panel.hidden=false;view.bubble.hidden=true;draw(c);
 }
 async function capture(view,comment=false,saved){
  const ctx=saved?.ctx||Reader.notesContext(view.tab);if(!ctx)throw Error('记录保存在工作区，请先将书籍放入工作区');const selection=saved?.selection||Reader.selectedText(view.tab),c=await get(ctx);
  // 异步载入后只保存到当时的书籍，不能把旧选文附到后来打开的章节。
  const visible=!view.disposed&&view.body.isConnected&&current(c);if(visible){if(active&&active!==view)detach(active);view.c=c;active=view;view.bubble.hidden=true;}
  const note=begin(c,selection.text,selection.anchor,ctx,selection.range);await drain(c);if(!visible)return;
  if(comment){c.open=true;view.panel.hidden=false;draw(c);view.panel.querySelector('[data-note-body]').focus();}
  else{c.screen='list';c.draft=null;if(!view.panel.hidden)draw(c);painted(view);MI.toast('已保存摘录');}
  window.getSelection()?.removeAllRanges();return note;
 }
 function hide(view,focus=false){if(view.c){commit(view.c);view.c.open=false;}view.panel.hidden=true;view.toggle.setAttribute('aria-expanded','false');view.excerpt.setAttribute('aria-expanded','false');if(active===view)active=null;if(focus)(view.c?.mode==='excerpts'?view.excerpt:view.toggle).focus();}
 let highlightOwner=null;
 function clearHighlights(view){if(highlightOwner===view){window.CSS?.highlights?.delete('reader-excerpts');window.CSS?.highlights?.delete('reader-focused-excerpt');highlightOwner=null;}}
 function detach(view){if(!view||view.disposed)return;if(view.c)commit(view.c);view.closeMenu?.();view.disposed=true;view.events.abort();clearHighlights(view);if(active===view)active=null;}
 function rangeFor(view,note){
  const ctx=Reader.notesContext(view.tab);if(!ctx||note.source.version!==ctx.version||note.source.index!==ctx.index||!note.quote)return null;
  const article=view.body.querySelector('.reader-article');if(!article)return null;let saved=note.source.range;
  if(!saved){let found;for(const [i,p]of [...article.children].entries()){const at=p.textContent.indexOf(note.quote);if(at<0)continue;if(found||p.textContent.indexOf(note.quote,at+1)>=0)return null;found={startBlock:i,endBlock:i,startOffset:at,endOffset:at+note.quote.length};}saved=found;}
  if(!saved)return null;const point=(block,offset)=>{const el=article.children[block];if(!el)return null;const walker=document.createTreeWalker(el,4);let node;while((node=walker.nextNode())){if(offset<=node.textContent.length)return [node,offset];offset-=node.textContent.length;}return null;};
  const start=point(saved.startBlock,saved.startOffset),end=point(saved.endBlock,saved.endOffset);if(!start||!end)return null;const range=document.createRange();try{range.setStart(...start);range.setEnd(...end);if(range.toString().trim()!==note.quote)return null;return range;}catch{return null;}
 }
 async function painted(view){
  view?.closeMenu?.();if(!view||view.disposed||!Reader.notesContext(view.tab))return;try{const c=await get(Reader.notesContext(view.tab));if(view.disposed||!current(c))return;view.c=c;view.ranges=c.notes.filter(isExcerpt).map(note=>({note,range:rangeFor(view,note)})).filter(item=>item.range);if(window.CSS?.highlights&&window.Highlight){CSS.highlights.set('reader-excerpts',new Highlight(...view.ranges.map(item=>item.range)));highlightOwner=view;}}catch(e){if(!view.disposed)MI.log?.('WARN','reader-notes',e.message);}
 }
 async function jumpTo(c,note){if(!current(c)||note.source.version!==Reader.notesContext()?.version)return;await Reader.goto(note.source.index,note.source.anchor);const view=active;if(!view||view.c!==c)return;const range=rangeFor(view,note);if(range){const scroll=view.body.querySelector('.reader-scroll'),rect=range.getBoundingClientRect();scroll.scrollTop+=rect.top-scroll.getBoundingClientRect().top-40;if(window.CSS?.highlights&&window.Highlight)CSS.highlights.set('reader-focused-excerpt',new Highlight(range));}if(view.body.getBoundingClientRect().width<720)hide(view);}
 async function removeRecord(view,c,id){
  if(view.disposed||!current(c))return;commit(c);const note=c.notes.find(n=>n.id===id);if(!note)return;const revision=c.revision,excerpt=isExcerpt(note);
  if(!await Modal.confirm(excerpt?'删除摘录':'删除阅读笔记',excerpt?'删除这段摘录及其想法？独立笔记不会被删除。':'删除这条阅读笔记？摘录不会被删除。'))return;
  if(view.disposed||!current(c))return;if(c.revision!==revision)throw Error('记录已变化，请重新确认删除');c.notes=c.notes.filter(n=>n.id!==id);if(c.draft?.id===id){c.draft=null;c.screen='list';}c.revision++;queue(c);draw(c);await painted(view);
 }
 function contextMenu(view,event){
  const {body,tab}=view,scroll=body.querySelector('.reader-scroll'),card=event.target.closest('[data-record]');
  if(event.target.closest('input,textarea,select,[contenteditable=true]')||(!scroll?.contains(event.target)&&!card))return;
  if(view.disposed||Viewer.activeTab!==tab||!tab.readerInfo||!tab.readerPage||window.Modal?.stack?.length)return;
  event.preventDefault();event.stopPropagation();view.closeMenu?.();view.bubble.hidden=true;
  const menuEvents=new AbortController(),menu=document.createElement('div');menu.className='reader-context-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','阅读操作');
  const host=body.closest('.reader-view'),before=Reader.state(),session=tab.readerInfo.session,revision=view.c?.revision,origin=document.activeElement;
  const valid=()=>!view.disposed&&body.isConnected&&Viewer.activeTab===tab&&tab.readerInfo?.session===session&&tab.readerIndex===before.index&&tab.readerInfo?.version===before.version;
  const close=(focus=false)=>{if(view.menu!==menu)return;menuEvents.abort();menu.remove();view.menu=null;if(focus&&valid()){if(origin?.isConnected&&origin!==document.body)origin.focus({preventScroll:true});else scroll.focus({preventScroll:true});}};
  view.menu=menu;view.closeMenu=close;
  const add=(id,label,run,disabled=false,danger=false)=>{const b=document.createElement('button');b.type='button';b.className='ctx-item'+(danger?' danger':'');b.textContent=label;b.dataset.readerAction=id;b.setAttribute('role','menuitem');b.disabled=disabled;b.tabIndex=-1;b.onclick=e=>{e.preventDefault();e.stopPropagation();if(view.menu!==menu)return;if(!valid()){close();return;}close();const pending=Promise.resolve().then(()=>{if(valid())return run();}).catch(error=>MI.toast(error.message,'err')).finally(()=>actions.delete(pending));actions.add(pending);};menu.append(b);};
  const sep=()=>{const line=document.createElement('div');line.className='ctx-sep';line.setAttribute('role','separator');menu.append(line);};
  const atPoint=()=>view.ranges.find(item=>[...item.range.getClientRects()].some(r=>event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom));
  const hit=card?{note:view.c?.notes.find(n=>n.id===card.dataset.record)}:atPoint();
  let selection=null,selectedCopy='';try{selection=Reader.selectedText(tab);}catch{}const picked=window.getSelection();if(picked?.rangeCount&&!picked.isCollapsed){const r=picked.getRangeAt(0),article=body.querySelector('.reader-article');if(article?.contains(r.startContainer)&&article.contains(r.endContainer))selectedCopy=picked.toString();}
  const openRecord=async(note)=>{await show(view,modeOf(note));if(valid()&&view.c?.notes.some(n=>n.id===note.id)){edit(view.c,view.c.notes.find(n=>n.id===note.id));view.panel.querySelector('[data-note-body]').focus();}};
  if(card||(!selectedCopy&&hit?.note)){
    const note=hit?.note,c=view.c;if(note&&c){
      add('record-copy',isExcerpt(note)?'📋 复制摘录':'📋 复制笔记',()=>myIDE.clip.copy([note.title,note.quote,note.body].filter(Boolean).join('\n\n')));
      add('record-edit',isExcerpt(note)?'✏️ 写想法':'✏️ 编辑笔记',()=>openRecord(note));
      add('record-source','📍 回到原文',async()=>{await show(view,modeOf(note));if(valid())await jumpTo(c,note);},note.source.version!==before.version);
      sep();add('record-remove',isExcerpt(note)?'🗑 删除摘录':'🗑 删除笔记',()=>{if(c.revision!==revision)throw Error('记录已变化，请重新打开菜单');return removeRecord(view,c,note.id);},false,true);
    }
  }else if(selectedCopy){
    const saved={ctx:Reader.notesContext(tab),selection};add('copy','📋 复制选中文字',()=>myIDE.clip.copy(selectedCopy));
    add('excerpt','🖍 保存摘录',()=>capture(view,false,saved),!saved.ctx||!selection);add('comment','✏️ 写想法',()=>capture(view,true,saved),!saved.ctx||!selection);sep();
  }
  if(!card){
    const top=scroll.scrollTop,max=Math.max(0,scroll.scrollHeight-scroll.clientHeight);
    add('previous','← 上一屏',()=>Reader.turnPage(-1,false),before.index===0&&top<=2);
    add('next','→ 下一屏',()=>Reader.turnPage(1,false),before.index>=before.total-1&&top>=max-2);sep();
    add('bookmark','🔖 添加书签',()=>Reader.bookmark());
    add('new-note','📝 新建笔记',async()=>{await show(view,'notes');if(valid()&&view.c){begin(view.c);view.panel.querySelector('[data-note-body]').focus();}},!Reader.notesContext(tab));
    add('records','📒 查看摘录和笔记',()=>show(view,'excerpts'),!Reader.notesContext(tab));sep();
    add('settings','Aa 阅读设置',()=>{const details=host.querySelector('.reader-settings');details.open=true;details.querySelector('summary').focus();});
    add('outline','☷ 阅读目录',()=>App.showTool('outline'));
  }
  if(!menu.children.length)return;host.querySelectorAll('.reader-settings,.reader-more').forEach(m=>m.open=false);document.body.append(menu);
  menu.style.maxWidth=Math.max(80,innerWidth-16)+'px';menu.style.maxHeight=Math.max(60,innerHeight-16)+'px';menu.style.left=Math.max(8,Math.min(event.clientX,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(event.clientY,innerHeight-menu.offsetHeight-8))+'px';
  menu.addEventListener('pointerdown',e=>e.preventDefault());menu.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
  document.addEventListener('keydown',e=>{if(view.menu!==menu||e.isComposing)return;const keys=['ArrowDown','ArrowUp','Home','End','Escape','Tab','Enter',' '];if(!keys.includes(e.key))return;e.preventDefault();e.stopImmediatePropagation();const items=[...menu.querySelectorAll('button:not(:disabled)')],i=items.indexOf(document.activeElement);if(e.key==='Escape'||e.key==='Tab'){close(true);return;}if(e.key==='Enter'||e.key===' '){document.activeElement?.click();return;}const index=e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowUp'?-1:1)+items.length)%items.length;items[index]?.focus();},{capture:true,signal:menuEvents.signal});
 }
 function mount(tab,body,toolbar){
  const panel=document.createElement('aside');panel.className='reader-notes';panel.hidden=true;panel.setAttribute('aria-label','阅读记录');
  panel.innerHTML='<header class="reader-notes-header"><strong>阅读笔记</strong></header><div class="reader-record-tabs" role="group" aria-label="记录分类"></div><div class="reader-notes-actions"></div><label class="reader-record-search">搜索记录<input data-note-search type="search" placeholder="搜索原文、想法或章节"></label><div class="reader-notes-list"></div><div class="reader-note-form" hidden><label>类型<select data-note-kind><option value="note">笔记</option><option value="summary">章节总结</option></select></label><label>标题<input data-note-title maxlength="120"></label><blockquote hidden></blockquote><button class="reader-button" type="button" data-note-source></button><label class="reader-note-body-label"><span data-note-body-label>笔记内容</span><textarea data-note-body maxlength="10000"></textarea></label><div class="reader-note-edit-actions"></div></div><footer><span class="reader-notes-status" role="status" aria-live="polite"></span></footer>';
  const bubble=document.createElement('div');bubble.className='reader-selection-actions';bubble.hidden=true;bubble.setAttribute('role','toolbar');bubble.setAttribute('aria-label','选文操作');body.append(panel,bubble);const view={tab,body,panel,bubble,events:new AbortController(),disposed:false,c:null,ranges:[]},signal=view.events.signal;
  view.excerpt=action('摘录',()=>!panel.hidden&&view.c?.mode==='excerpts'?hide(view):show(view,'excerpts'));view.toggle=action('笔记',()=>!panel.hidden&&view.c?.mode==='notes'?hide(view):show(view,'notes'));for(const b of [view.excerpt,view.toggle])b.setAttribute('aria-expanded','false');toolbar.append(view.excerpt,view.toggle);view.excerpt.title='查看与管理原文摘录';view.toggle.title='独立阅读笔记与章节总结';
  if(!Reader.notesContext(tab)){view.toggle.disabled=view.excerpt.disabled=true;view.toggle.title=view.excerpt.title='记录保存到工作区，请先将书籍放入工作区';}
  const close=action('',()=>hide(view,true));close.setAttribute('aria-label','关闭阅读记录');close.innerHTML='<svg class="ic" viewBox="0 0 16 16"><path d="m4 4 8 8m0-8-8 8"/></svg>';panel.querySelector('header').append(close);
  for(const [mode,name]of [['excerpts','摘录'],['notes','笔记']]){const b=action(name,()=>show(view,mode));b.dataset.recordMode=mode;panel.querySelector('.reader-record-tabs').append(b);}
  const back=action('返回列表',()=>{commit(view.c);view.c.draft=null;view.c.screen='list';draw(view.c);});back.dataset.noteBack='';back.hidden=true;const add=action('新建笔记',()=>{begin(view.c);panel.querySelector('[data-note-body]').focus();});add.dataset.noteNew='';panel.querySelector('.reader-notes-actions').append(back,add);
  const copy=action('复制',()=>{const d=view.c?.draft;if(d)return myIDE.clip.copy([d.title,d.quote,d.body].filter(Boolean).join('\n\n'));});
  const remove=action('删除笔记',()=>{const c=view.c;if(c?.draft)return removeRecord(view,c,c.draft.id);});remove.dataset.noteDelete='';
  const clearComment=action('删除想法',async()=>{const c=view.c;if(!c?.draft||!isExcerpt(c.draft))return;commit(c);const id=c.draft.id,revision=c.revision;if(!await Modal.confirm('删除想法','只删除这条摘录的想法，保留摘录原文与位置？'))return;if(view.disposed||!current(c)||c.draft?.id!==id||c.revision!==revision)throw Error('记录已变化，请重新确认');c.draft.body='';c.draft.dirty=true;c.revision++;commit(c);draw(c);});clearComment.dataset.noteClearComment='';panel.querySelector('.reader-note-edit-actions').append(copy,clearComment,remove);
  const retryButton=action('重试保存',retry);retryButton.dataset.noteRetry='';retryButton.hidden=true;const reloadButton=action('重新载入',reload);reloadButton.dataset.noteReload='';reloadButton.hidden=true;panel.querySelector('footer').append(retryButton,reloadButton);
  panel.querySelector('[data-note-source]').onclick=()=>{const c=view.c;if(c?.draft)jumpTo(c,c.draft).catch(e=>MI.toast(e.message,'err'));};
  panel.querySelector('[data-note-search]').oninput=e=>{if(!view.c)return;view.c.query=e.target.value;drawList(view.c);};
  for(const [selector,field]of [['[data-note-kind]','kind'],['[data-note-title]','title'],['[data-note-body]','body']]){panel.querySelector(selector).addEventListener(field==='kind'?'change':'input',e=>{const c=view.c;if(view.disposed||!c?.draft||!current(c))return;if(field==='kind'&&isExcerpt(c.draft))return;c.draft[field]=e.target.value;if(field==='body')panel.querySelector('[data-note-clear-comment]').hidden=!isExcerpt(c.draft)||!c.draft.body;c.draft.dirty=true;c.revision++;clearTimeout(c.timer);c.timer=setTimeout(()=>{try{commit(c);}catch(error){c.error=error.message;status(c);}},400);status(c);});}
  const saveExcerpt=action('保存摘录',()=>capture(view));saveExcerpt.dataset.selectionExcerpt='';const comment=action('写想法',()=>capture(view,true));comment.dataset.selectionNote='';const copySelection=action('复制',async()=>{const selection=Reader.selectedText(tab);await myIDE.clip.copy(selection.text);bubble.hidden=true;});copySelection.dataset.selectionCopy='';bubble.append(saveExcerpt,comment,copySelection);bubble.addEventListener('pointerdown',e=>e.preventDefault(),{signal});
  const updateSelection=()=>{if(view.disposed||view.menu||!Reader.notesContext(tab))return;if(document.activeElement?.closest('input,textarea,select,[contenteditable=true]')){bubble.hidden=true;return;}let selection;try{selection=Reader.selectedText(tab);}catch{bubble.hidden=true;return;}if(!window.getSelection()?.rangeCount){bubble.hidden=true;return;}const range=window.getSelection().getRangeAt(0),scrollEl=body.querySelector('.reader-scroll');if(!range.getBoundingClientRect||!scrollEl){bubble.hidden=true;return;}const rect=range.getBoundingClientRect(),area=body.getBoundingClientRect(),scroll=scrollEl.getBoundingClientRect();if(rect.bottom<scroll.top||rect.top>scroll.bottom){bubble.hidden=true;return;}view.selection=selection;bubble.hidden=false;const width=bubble.offsetWidth;const max=Math.max(4,area.width-width-4);bubble.style.left=Math.max(4,Math.min(max,rect.left-area.left+(rect.width-width)/2))+'px';bubble.style.top=Math.max(4,Math.min(area.height-bubble.offsetHeight-4,rect.top-area.top-bubble.offsetHeight-8))+'px';};
  body.querySelector('.reader-scroll')?.addEventListener('scroll',()=>{bubble.hidden=true;view.closeMenu?.();},{signal,passive:true});document.addEventListener('focusin',e=>{if(!body.querySelector('.reader-article')?.contains(e.target)&&!bubble.contains(e.target))bubble.hidden=true;},{signal});
  body.addEventListener('pointerup',()=>requestAnimationFrame(updateSelection),{signal});body.addEventListener('keyup',()=>requestAnimationFrame(updateSelection),{signal});document.addEventListener('selectionchange',()=>requestAnimationFrame(updateSelection),{signal});
  body.addEventListener('contextmenu',e=>contextMenu(view,e),{signal});
  document.addEventListener('pointerdown',e=>{if(view.menu&&!view.menu.contains(e.target))view.closeMenu();},{capture:true,signal});window.addEventListener('blur',()=>view.closeMenu?.(),{signal});window.addEventListener('resize',()=>view.closeMenu?.(),{signal});
  body.addEventListener('click',e=>{if(!body.querySelector('.reader-article')?.contains(e.target)||!window.getSelection()?.isCollapsed)return;const hit=view.ranges.find(item=>[...item.range.getClientRects()].some(r=>e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom));if(hit)show(view,'excerpts').then(()=>{if(!view.disposed&&current(view.c))edit(view.c,hit.note);}).catch(error=>MI.toast(error.message,'err'));},{signal});
  document.addEventListener('keydown',e=>{if(e.key!=='Escape'||e.isComposing||view.disposed||window.Modal?.stack?.length)return;if(view.menu)return;else if(!bubble.hidden){bubble.hidden=true;e.preventDefault();e.stopImmediatePropagation();}else if(!panel.hidden){e.preventDefault();e.stopImmediatePropagation();if(view.c?.screen==='edit'){commit(view.c);view.c.draft=null;view.c.screen='list';draw(view.c);}else hide(view,true);}},{capture:true,signal});
  const existing=cache.get(identity(Reader.notesContext(tab)));if(existing?.open)show(view,existing.mode,true).catch(e=>MI.toast(e.message,'err'));painted(view);return view;
 }
 return {mount,detach,painted,flushAll,retry,reload,snapshot,read,write};
})();

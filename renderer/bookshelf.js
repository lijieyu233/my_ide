// 书架复用当前项目，扫描仅枚举支持的格式，不在首屏批量解包书籍。
window.Bookshelf=(()=>{
  const icons={book:'<path d="M8 3.5C5.8 2.1 3.5 2 1.5 2.8v10C3.6 12 5.8 12.2 8 13.5c2.2-1.3 4.4-1.5 6.5-.7v-10C12.5 2 10.2 2.1 8 3.5zM8 3.5v10"/>',
    refresh:'<path d="M13 6a5 5 0 1 0 .1 4M13 2v4H9"/>',plus:'<path d="M8 3v10M3 8h10"/>',back:'<path d="M13 8H3m4-4L3 8l4 4"/>',
    search:'<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3"/>',remove:'<path d="M3 4.5h10M6 4.5V2.7h4v1.8M4.5 4.5l.6 9h5.8l.6-9M6.8 7v4M9.2 7v4"/>'};
  const svg=name=>'<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">'+icons[name]+'</svg>';
  let host,query='',filter='all',sort='recent',adding=false,scanningRoot=null,removed=null,origin=null,search;
  const opening=new Set(),inert=new Map();
  const visible=()=>!!host&&!host.classList.contains('hidden');
  const text=(tag,value,cls)=>{const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el;};
  function button(label,action,icon,cls=''){
    const el=document.createElement('button');el.type='button';el.className='shelf-button '+cls;
    if(icon)el.innerHTML=svg(icon);if(label)el.append(text('span',label));
    el.onclick=()=>{if(!el.isConnected||el.disabled)return;Promise.resolve().then(action).catch(error=>feedback(error.message,true));};return el;
  }
  function position(book){const unit=book.kind==='comic'?'页':'章';return book.total?'第 '+(book.index+1)+' / '+book.total+' '+unit:'第 '+(book.index+1)+' '+unit+' · 总数待读取';}
  function timeLabel(value){if(!value)return '尚未阅读';const date=new Date(value);return Number.isNaN(date.getTime())?'尚未阅读':new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date);}
  function progress(book){const line=document.createElement('progress');line.max=book.total||1;line.value=book.updated&&book.total?Math.min(book.index+1,book.total):0;line.setAttribute('aria-label',book.updated?position(book):'尚未阅读');return line;}
  function feedback(message,error=false,undo=false){
    if(!host)return;const box=host.querySelector('.shelf-feedback');box.replaceChildren();box.classList.toggle('error',error);box.setAttribute('role',error?'alert':'status');
    if(message)box.append(text('span',message));if(undo)box.append(button('撤销',()=>{if(!removed)return;Reader.setListed(removed,true);removed=null;feedback('已恢复到书架');}));
  }
  async function add(){
    if(!App.root){const root=await myIDE.fs.openFolder();if(root&&await App.openProject(root))App.showTool('bookshelf');return;}
    const root=App.root;if(adding&&scanningRoot===root)return;scanningRoot=root;adding=true;syncAdd();feedback('正在扫描工作区…');
    try{await Reader.retrySave();await Reader.ensureWorkspace(root,true);if(App.root!==root)return;refresh();const info=Reader.workspaceInfo();feedback(info.truncated?'书籍较多，已达到本次扫描上限；可拆分工作区。':info.warnings.length?'部分目录无法读取：'+info.warnings.join('；'):'阅读数据保存于 '+info.directory,!!info.warnings.length);}
    catch(error){if(App.root===root)feedback(error.message,true);}
    finally{if(scanningRoot===root){adding=false;scanningRoot=null;syncAdd();}}
  }
  function syncAdd(){if(!host)return;for(const b of host.querySelectorAll('[data-shelf-add]')){b.disabled=adding;const icon=b.querySelector('svg');if(icon)icon.innerHTML=icons[App.root?'refresh':'plus'];b.querySelector('span').textContent=adding?'正在扫描…':App.root?'刷新书架':'打开工作区';}}
  async function openBook(id){
    const book=Reader.library().find(b=>b.id===id);if(!book)throw Error('书籍已移出书架，请刷新后重试');if(opening.has(id))return {ok:false,error:'书籍正在打开'};
    opening.add(id);feedback('正在打开「'+book.title+'」…');refresh();const root=App.root;
    try{const result=await Reader.open(book.path);
      if(result?.ok===false&&App.root===root&&Viewer.activeTab?.path===book.path&&App.getTool()==null){App.showTool('bookshelf');feedback('无法打开「'+book.title+'」：'+(result.error||'请检查文件是否仍在原位置')+'。书架记录已保留。',true);}
      return result;
    }finally{opening.delete(id);refresh();}
  }
  function removeBook(id){const book=Reader.library().find(b=>b.id===id);if(!book)throw Error('书籍已移出书架');if(opening.has(id))throw Error('请等待这本书打开后再移出');removed=id;Reader.setListed(id,false);feedback('已移出「'+book.title+'」，原文件和阅读记录保留。',false,true);return {ok:true,removed:id};}
  function cover(book,large=false){
    const el=document.createElement('div');el.className='shelf-cover'+(large?' large':'');el.dataset.format=book.format;
    el.append(text('span',book.format,'shelf-format'));const mark=document.createElement('span');mark.className='shelf-book-mark';mark.innerHTML=svg('book');el.append(mark,text('span',book.title,'shelf-cover-title'));return el;
  }
  function renderContinue(books){
    const area=host.querySelector('.shelf-continue');area.replaceChildren();const book=books.find(b=>b.updated>0);
    area.hidden=!book||!!query||filter!=='all';if(area.hidden)return;
    const body=document.createElement('div');body.className='shelf-continue-body';body.append(text('p','继续上次阅读','shelf-eyebrow'),text('h2',book.title));
    body.append(text('p',position(book)+(book.chapterTitle?' · '+book.chapterTitle:''),'shelf-position'),progress(book),text('p','上次阅读 '+timeLabel(book.updated),'shelf-time'));
    const resume=button(opening.has(book.id)?'正在打开…':'继续阅读',()=>openBook(book.id),'book','shelf-primary');resume.disabled=opening.has(book.id);resume.dataset.shelfResume=book.id;body.append(resume);area.append(cover(book,true),body);
  }
  function refresh(){
    if(!visible())return;const info=Reader.workspaceInfo();host.querySelector('.shelf-workspace').textContent=info.root?info.root+' · TXT / EPUB / CBZ':'复用项目工作区，书籍与阅读资料保存在一起';const books=Reader.library();renderContinue(books);
    const needle=query.trim().toLocaleLowerCase();const selected=books.filter(b=>(filter==='all'||(filter==='comic'?b.kind==='comic':b.kind!=='comic'))&&(!needle||(b.title+' '+b.path).toLocaleLowerCase().includes(needle)));
    if(sort==='title')selected.sort((a,b)=>a.title.localeCompare(b.title,'zh-CN',{numeric:true}));
    host.querySelector('.shelf-count').textContent=books.length+' 本';host.querySelector('.shelf-results').textContent=needle||filter!=='all'?'找到 '+selected.length+' 本书':'全部书籍';
    for(const b of host.querySelectorAll('[data-shelf-filter]'))b.setAttribute('aria-pressed',String(b.dataset.shelfFilter===filter));
    const grid=host.querySelector('.shelf-grid');grid.replaceChildren();
    if(!selected.length){const empty=document.createElement('div');empty.className='shelf-empty';const mark=document.createElement('span');mark.className='shelf-empty-icon';mark.innerHTML=svg('book');empty.append(mark,text('h2',books.length?'没有找到这本书':App.root?'当前工作区还没有书籍':'打开一个工作区开始阅读'),text('p',books.length?'试试其他书名、路径或分类。':App.root?'将 TXT、EPUB 小说或 CBZ 漫画放入工作区，刷新后自动显示。PDF 暂不支持。':'已有项目可以直接切到书架；书签与进度保存在工作区 .myide/reader 中。'));
      if(!books.length){const b=button(App.root?'刷新书架':'打开工作区',add,App.root?'refresh':'plus','shelf-primary');b.dataset.shelfAdd='';empty.append(b);}grid.append(empty);syncAdd();return;}
    for(const book of selected){const card=document.createElement('article');card.className='shelf-card';card.dataset.book=book.id;
      const read=button('',()=>openBook(book.id),null,'shelf-open');read.append(cover(book));read.disabled=opening.has(book.id);read.setAttribute('aria-label',(book.updated?'继续阅读：':'开始阅读：')+book.title);read.title=book.title+'\n'+book.path;
      const title=text('h3',book.title);title.title=book.title;read.append(title,text('p',book.updated?position(book):'尚未阅读','shelf-position'),progress(book));card.append(read);
      const foot=document.createElement('div');foot.className='shelf-card-foot';foot.append(text('span',book.updated?timeLabel(book.updated):'添加于 '+timeLabel(book.addedAt),'shelf-time'));const remove=button('',()=>removeBook(book.id),'remove','shelf-remove');remove.title='移出书架，保留原文件和阅读记录';remove.setAttribute('aria-label','移出书架：'+book.title);remove.disabled=opening.has(book.id);foot.append(remove);card.append(foot);grid.append(card);
    }syncAdd();
  }
  function init(){
    if(host)return;host=document.createElement('section');host.id='bookshelf-main';host.className='hidden';host.setAttribute('aria-label','书架');
    host.innerHTML='<header class="shelf-header"><div class="shelf-heading"><h1>书架</h1><span class="shelf-count"></span><p class="shelf-workspace"></p></div><div class="shelf-actions"></div></header><div class="shelf-body"><section class="shelf-continue" aria-label="继续阅读"></section><div class="shelf-controls"><div class="shelf-filters" aria-label="书籍分类"></div><label class="shelf-search"></label><label class="shelf-sort">排序 <select aria-label="书架排序"><option value="recent">最近阅读</option><option value="title">书名</option></select></label></div><p class="shelf-results"></p><div class="shelf-grid"></div></div><div class="shelf-feedback" role="status" aria-live="polite"></div>';
    const actions=host.querySelector('.shelf-actions');actions.append(button('返回工作区',()=>{App.backToEditor();if(origin?.isConnected)origin.focus();},'back'));
    const addButton=button('刷新书架',add,'refresh','shelf-primary');addButton.dataset.shelfAdd='';actions.append(addButton);
    for(const [id,label]of [['all','全部'],['novel','小说'],['comic','漫画']]){const b=button(label,()=>{filter=id;refresh();});b.dataset.shelfFilter=id;host.querySelector('.shelf-filters').append(b);}
    const searchBox=host.querySelector('.shelf-search');searchBox.innerHTML=svg('search');search=document.createElement('input');search.type='search';search.placeholder='搜索书名或路径';search.setAttribute('aria-label','搜索书架');searchBox.append(search);search.oninput=()=>{query=search.value;refresh();};
    search.onkeydown=e=>{if(e.isComposing||e.keyCode===229||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey)return;if(e.key==='Escape'&&query){e.preventDefault();e.stopPropagation();search.value=query='';refresh();}};
    host.querySelector('.shelf-sort select').onchange=e=>{sort=e.target.value;refresh();};document.getElementById('content').append(host);
  }
  function show(){Reader.flush();init();origin=document.activeElement;for(const id of ['editor-panes','viewer','tabbar','empty-state']){const el=document.getElementById(id);if(el){inert.set(el,el.inert);el.inert=true;}}host.classList.remove('hidden');refresh();if(App.root)add().catch(error=>feedback(error.message,true));search.focus();}
  function hide(){host?.classList.add('hidden');for(const [el,value]of inert)el.inert=value;inert.clear();}
  function projectChanged(){removed=null;refresh();if(visible()&&App.root)add();}
  return {show,hide,refresh,projectChanged,openBook,removeBook,get visible(){return visible();}};
})();

(()=>{
  const W=AiWorkbench;
  W.register('reader',{state:()=>Reader.workbenchState(),async operate(call){
    const a=call.args;
    await Reader.ensureWorkspace();
    if(call.name==='reader_state')return W.observe('reader',Reader.state());
    if(call.name==='reader_notes'){Reader.state();return W.observe('reader',await ReaderNotes.read(a.offset||0,a.limit||10));}
    if(call.name==='reader_note_write'){Reader.state();return ReaderNotes.write(a);}
    if(call.name==='reader_library'){
      const query=(a.query||'').toLowerCase(),all=Reader.library(a.includeRemoved===true).filter(b=>!query||(b.title+' '+b.path).toLowerCase().includes(query)),offset=a.offset||0,limit=a.limit||30;
      return W.observe('reader',{page:W.page().id,workspace:Reader.workspaceInfo(),total:all.length,books:all.slice(offset,offset+limit).map(b=>({...b,path:b.path.slice(0,512),pathTruncated:b.path.length>512})),offset,nextOffset:Math.min(all.length,offset+limit)});
    }
    if(call.name==='reader_library_control'){
      if(a.operation==='show'){App.showTool('bookshelf');return {ok:true,page:'bookshelf',total:Reader.library().length};}
      if(!a.book)W.fail('INVALID_TOOL_ARGS','缺少书架中的book标识');
      if(a.operation==='open'){const result=await Bookshelf.openBook(a.book);if(!result?.ok)return {ok:false,error:result?.error||'书籍未打开'};await Reader.sync();return {ok:true,...Reader.state()};}
      if(a.operation==='remove'){const result=Bookshelf.removeBook(a.book);await Reader.sync();return result;}
      Reader.setListed(a.book,true);await Reader.sync();return {ok:true,restored:a.book,total:Reader.library().length};
    }
    if(call.name==='reader_read'){
      if(a.query==='toc'){const state=Reader.state(),offset=a.offset||0,limit=Math.min(a.limit||200,200),chapters=Viewer.activeTab.readerInfo.chapters;return {ok:true,...state,chapters:chapters.slice(offset,offset+limit),offset,nextOffset:Math.min(chapters.length,offset+limit)};}
      return {ok:true,...await Reader.read(a.offset||0,a.limit||12000)};
    }
    const state=Reader.state();
    if(a.operation==='goto'){if(a.index==null)W.fail('INVALID_TOOL_ARGS','缺少章节或页码（从0开始）');await Reader.goto(a.index);}
    else if(a.operation==='next')await Reader.goto(state.index+1);
    else if(a.operation==='previous')await Reader.goto(state.index-1);
    else if(a.operation==='preferences')Reader.setPreferences(a);
    else if(a.operation==='bookmark_add')Reader.bookmark();
    else if(a.operation==='bookmark_remove'){if(!state.bookmarks.some(b=>b.id===a.bookmark))W.fail('BOOKMARK_NOT_FOUND','书签不属于当前书籍');Reader.bookmark(true,a.bookmark);}
    await Reader.sync();return {ok:true,...Reader.state()};
  }});
})();

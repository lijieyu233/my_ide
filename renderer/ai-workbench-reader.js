(()=>{
  const W=AiWorkbench;
  W.register('reader',{state:()=>Reader.state(),async operate(call){
    const a=call.args;
    if(call.name==='reader_state')return W.observe('reader');
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
    return {ok:true,...Reader.state()};
  }});
})();

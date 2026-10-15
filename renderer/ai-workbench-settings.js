(()=>{
  const W=AiWorkbench,F=W.fail;
  const keys=['myide-theme','myide-custom-theme','myide-editor-font','myide-sidebar-width:v2','myide-ai-width:v2','myide-ai-open','myide-keys'];
  const stored=()=>Object.fromEntries(keys.map(k=>[k,localStorage.getItem(k)]));
  const restoreStorage=values=>{for(const [k,v]of Object.entries(values))if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v);};
  let previous=null;
  function state(){const rect=id=>Math.round((document.getElementById(id)?.getBoundingClientRect().width||0)*10)/10;
    return {theme:Theme.current(),custom:Theme.getCustom(),themes:['dark','light','pink','crimson','graphite',...Theme.getUserThemes().map(t=>'user:'+t.id)],fontSize:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size'))||13,
      layout:{sidebarWidth:rect('sidebar'),aiWidth:rect('ai-panel'),sidebarStyle:document.getElementById('sidebar').style.width,aiStyle:document.getElementById('ai-panel').style.width,sidebarVisible:!document.body.classList.contains('sidebar-collapsed'),aiVisible:!document.getElementById('ai-panel').classList.contains('hidden'),rightCollapsed:document.body.classList.contains('rsb-collapsed')},
      shortcuts:Shortcuts.bindings(),stored:stored(),allowed:{fontSize:[10,20],width:'0至当前窗口可用宽度',pages:['keys','markdown','appearance','editor','git','translate','ai','theme','local']}};
  }
  async function restore(change){
    if(!change)F('NOTHING_TO_RESTORE','没有本接口的上一次变更');if(await W.stateHash(state())!==change.after)F('STATE_CHANGED','设置已有后续变更，未覆盖');
    const p=change.before;Theme.set(p.theme);for(const [k,v]of Object.entries(p.custom))if(v)Theme.pick(k,v);Viewer.applyFontSize(p.fontSize);
    document.getElementById('sidebar').style.width=p.layout.sidebarStyle;document.getElementById('ai-panel').style.width=p.layout.aiStyle;
    App.toggleSidebar(!p.layout.sidebarVisible);App.setAiOpen(p.layout.aiVisible);App.toggleRightSidebar(p.layout.rightCollapsed);restoreStorage(p.stored);Shortcuts.load();previous=null;
  }
  W.register('settings',{state,async operate(call,context){
    const a=call.args;if(call.name==='settings_state')return W.observe('settings',{...state(),controlJobs:W.jobList('settings').filter(j=>j.root===W.root())});await W.checkpoint(call,context);
    if(a.operation==='restore'){await restore(previous);return {ok:true,committed:true,...state()};}
    if(a.operation==='open'){Settings.open(({appearance:'font',local:'storage'})[a.page]||a.page||'keys',a.filter);const box=document.getElementById('set-box');if(!box)F('DIALOG_BLOCKED','上层弹窗阻止打开设置');if(a.filter&&a.page!=='keys'){const target=[...box.querySelectorAll('label,.set-section-title,.set-row')].find(el=>el.textContent.includes(a.filter));target?.scrollIntoView({block:'center'});}return {ok:true,page:box.dataset.category};}
    const perform=async()=>{await W.guard(call,context);const before=state();
    if(a.operation==='appearance'){if(a.theme&&!before.themes.includes(a.theme))F('INVALID_TOOL_ARGS','主题不存在');if(a.theme)Theme.set(a.theme);if(a.fontSize!==undefined)Viewer.applyFontSize(a.fontSize);}
    else if(a.operation==='layout'){if(a.sidebarVisible!==undefined)App.toggleSidebar(!a.sidebarVisible);if(a.aiVisible!==undefined){App.setAiOpen(a.aiVisible);if(a.aiVisible)App.toggleRightSidebar(false);}if(a.sidebarWidth!==undefined)App.resizeColumn('sidebar',a.sidebarWidth);if(a.aiWidth!==undefined)App.resizeColumn('ai-panel',a.aiWidth);App.saveColumnWidths();}
    else if(a.operation==='shortcut'){
      if(!a.shortcut)F('INVALID_TOOL_ARGS','缺少动作ID');const combos=a.reset?Shortcuts.defaultsFor(a.shortcut):a.keys||[],conflicts=Shortcuts.bindingConflicts(a.shortcut,combos);
      if(conflicts.length)return {ok:false,errorCode:'SHORTCUT_CONFLICT',error:'快捷键已被占用，原配置保留',conflicts};
      if(a.reset)Shortcuts.reset(a.shortcut);else Shortcuts.setBindings(a.shortcut,combos);
    }
    if(a.persistent===false)restoreStorage(before.stored);
    const actual=state();previous={before,after:await W.stateHash(actual)};return {ok:true,committed:true,persistent:a.persistent!==false,...actual};};
    return AiPanel.aiAfterResult(call,context,perform);
  }});
})();

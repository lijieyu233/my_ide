// 原生网页只接受宿主登记的工具和面板快捷键。
const panelToggles = new Set(['toggle-sidebar', 'button:btn-editor-collapse', 'toggle-sidebar-right']);
const allowed=new Set(['tool-sessions','tool-clipboard','tool-project','tool-outline','search-panel','commit-tool-window','tool-browser','tool-bookshelf','tool-remote','tool-db','tool-tasks','tool-launch','tool-quick-launch','git-log',...panelToggles]);
function createService(){
 let keys=new Map();
 return {
  set(entries){
   if(!Array.isArray(entries)||entries.length>allowed.size)return {ok:false};
   const next=new Map(),seen=new Set();
   for(const item of entries){
    if(!item||!allowed.has(item.id)||seen.has(item.id)||!Array.isArray(item.combos)||item.combos.length>10)return {ok:false};seen.add(item.id);
    for(const combo of item.combos){if(typeof combo!=='string'||combo.length>80||!(/^(?:ctrl\+|alt\+)|^f(?:[1-9]|1[0-2])$/.test(combo))||next.has(combo))return {ok:false};next.set(combo,item.id);}
   }
   keys=next;return {ok:true};
  },
  match(input){if(input.type!=='keyDown'||input.isComposing)return null;const modifiers=[input.control||input.meta?'ctrl':'',input.alt?'alt':'',input.shift?'shift':''].filter(Boolean);
    const key=(input.key||'').toLowerCase();
    const exact=keys.get([...modifiers,key===' '?'space':key].join('+'));
    if(exact)return exact;
    if(input.code==='Backquote'&&(input.control||input.meta||input.alt)){
      const fallback=keys.get([...modifiers,'`'].join('+'));
      if(panelToggles.has(fallback))return fallback;
    }
    return null;}
 };
}
module.exports={createService};

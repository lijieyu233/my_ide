// 原生网页只接受宿主登记的工具跳转，不把网页传来的动作或脚本作为命令执行。
const allowed=new Set(['tool-project','tool-outline','search-panel','commit-tool-window','tool-browser','tool-bookshelf','tool-remote','tool-db','tool-tasks','tool-launch','tool-quick-launch','git-log']);
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
  match(input){if(input.type!=='keyDown'||input.isComposing)return null;let k=(input.key||'').toLowerCase();if(k===' ')k='space';const combo=[input.control||input.meta?'ctrl':'',input.alt?'alt':'',input.shift?'shift':'',k].filter(Boolean).join('+');return keys.get(combo)||null;}
 };
}
module.exports={createService};

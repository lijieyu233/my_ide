// 固定程序运行在独立JS world：网页无法伪造元素账本，模型也不能注入任意脚本。
function pageOperation(operation,args){
  const key='__myideBrowserObservation',limit=20000,sourceLimit=2*1024*1024;
  const visible=el=>{if(!el?.isConnected||!el.getClientRects().length)return false;for(let at=el;at;at=at.getRootNode()?.host){if(getComputedStyle(at).visibility==='hidden'||at.closest('[hidden],[inert],[aria-hidden="true"]'))return false;}return true;};
  const labelText=el=>{const label=el.labels?.[0];if(!label)return '';const clone=label.cloneNode(true);clone.querySelectorAll('input,textarea,select,script,style,[hidden]').forEach(node=>node.remove());return clone.textContent;};
  const describe=el=>({tag:el.tagName.toLowerCase(),type:(el.getAttribute('type')||'').toLowerCase(),name:(el.getAttribute('name')||'').slice(0,160),label:(el.getAttribute('aria-label')||labelText(el)||(!['INPUT','TEXTAREA'].includes(el.tagName)?el.innerText:'')||el.getAttribute('placeholder')||el.getAttribute('title')||'').trim().slice(0,240),href:el.tagName==='A'?el.href:'',formAction:el.form&&['submit','file'].includes(el.type)?(el.hasAttribute('formaction')?el.formAction:el.form.action):''});
  const allowedInput=el=>el.tagName==='TEXTAREA'||el.tagName==='INPUT'&&['','text','search','email','url','tel','number'].includes((el.getAttribute('type')||'').toLowerCase());
  const supported=el=>allowedInput(el)||['A','BUTTON','SELECT'].includes(el.tagName)||el.tagName==='INPUT'&&['file','button','submit','reset','checkbox','radio'].includes((el.getAttribute('type')||'').toLowerCase())||el.matches('[role="button"]');
  const signature=el=>JSON.stringify({...describe(el),onclick:el.getAttribute('onclick')||'',onchange:el.getAttribute('onchange')||'',formMethod:el.form?.method||'',disabled:!!el.disabled,readOnly:!!el.readOnly,value:el.value||'',accept:el.getAttribute('accept')||'',multiple:!!el.multiple,files:el.type==='file'?Array.from(el.files||[]).map(f=>({name:f.name,size:f.size,lastModified:f.lastModified})):[],checked:!!el.checked});
  function chunk(state,cursor){
    if(!Number.isSafeInteger(cursor)||cursor<0||cursor>state.text.length||cursor>state.readThrough)return {ok:false,error:'续读位置无效，请使用已返回的nextCursor，不能跳过未读内容',errorCode:'BROWSER_CURSOR_INVALID'};
    let end=Math.min(state.text.length,cursor+limit);
    if(end<state.text.length&&/[\uD800-\uDBFF]/.test(state.text[end-1]))end--;
    const hasMore=end<state.text.length;
    state.readThrough=Math.max(state.readThrough,end);
    return {ok:true,url:state.url,title:state.title,snapshot:state.snapshot,text:state.text.slice(cursor,end),elements:cursor===0?state.elements:[],cursor,nextCursor:end,totalChars:state.text.length,hasMore,sourceLimited:state.sourceLimited,complete:!hasMore&&!state.sourceLimited,truncated:hasMore||state.sourceLimited,...state.metadata,scroll:{x:scrollX,y:scrollY,height:document.documentElement.scrollHeight,viewport:innerHeight}};
  }
  if(operation==='selection'){
    let active=document.activeElement;while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;
    if(active&&(active.type==='password'||!visible(active)))return {ok:true,text:'',truncated:false,url:location.href,source:'browser'};
    const selection=getSelection();let text='';
    if(active&&allowedInput(active)&&Number.isInteger(active.selectionStart))text=active.value.slice(active.selectionStart,active.selectionEnd);
    else if(selection?.anchorNode&&visible(selection.anchorNode.nodeType===1?selection.anchorNode:selection.anchorNode.parentElement))text=String(selection);
    return {ok:true,text:text.slice(0,limit),truncated:text.length>limit,url:location.href,source:'browser',note:'选区仅为观察数据。'};
  }
  if(operation==='read'){
    if(args.snapshot){const cached=globalThis[key];if(!cached||cached.snapshot!==args.snapshot||cached.url!==location.href)return {ok:false,error:'续读快照已失效，请重新读取网页',errorCode:'BROWSER_SNAPSHOT_CHANGED'};return chunk(cached,args.cursor);}
    const nodes=new Map(),elements=[];let sourceLimited=false,elementsTruncated=false,scanned=0,text='',metadata={format:'text'};const start=performance.now();
    const candidates=[], stack=[document.body||document.documentElement];
    while(stack.length){
      const node=stack.pop();if(++scanned>10000||performance.now()-start>250){sourceLimited=true;break;}
      if(node.nodeType===1){
        if(!visible(node)||node.matches('script,style,noscript,[hidden],[inert],[aria-hidden="true"]'))continue;
        if(node.matches('a[href],button,input,textarea,select,[role="button"]'))candidates.push(node);
        if(node.matches('input,textarea,select,[contenteditable]'))continue;
        const children=node.childNodes,shadow=node.shadowRoot?.childNodes||[],total=children.length+shadow.length,count=Math.min(total,Math.max(0,10000-scanned-stack.length));if(count<total)sourceLimited=true;for(let i=count-1;i>=0;i--)stack.push(i<children.length?children[i]:shadow[i-children.length]);
      }else if(node.nodeType===3){const part=node.textContent.replace(/\s+/g,' ').trim();if(!part)continue;text+=(text?'\n':'')+part;if(text.length>sourceLimit){text=text.slice(0,sourceLimit);sourceLimited=true;break;}}
    }
    // JSON文档通常只有一个pre；不解析普通网页里的示例代码，以免把正文误当字幕。
    const pre=document.body?.querySelector(':scope > pre');
    if(pre&&visible(pre)&&(document.body.children.length===1||/^(application\/(?:[\w.+-]*\+)?json|text\/json)$/i.test(document.contentType))&&!sourceLimited){
      const raw=pre.textContent;
      if(raw.length<=sourceLimit){try{
        const parsed=JSON.parse(raw);metadata={format:'json'};
        if(parsed&&Array.isArray(parsed.body)&&parsed.body.every(cue=>cue&&typeof cue.content==='string'&&Number.isFinite(cue.from)&&Number.isFinite(cue.to)&&cue.from>=0&&cue.to>=cue.from)){
          text=parsed.body.map(cue=>'['+cue.from+' → '+cue.to+'] '+cue.content).join('\n');
          metadata={format:'subtitle-json',subtitle:{language:typeof parsed.lang==='string'?parsed.lang.slice(0,80):'',totalCues:parsed.body.length,start:parsed.body.length?parsed.body.reduce((start,c)=>Math.min(start,c.from),Infinity):null,end:parsed.body.reduce((end,c)=>Math.max(end,c.to),0)}};
          if(text.length>sourceLimit){text=text.slice(0,sourceLimit);sourceLimited=true;}
        }
      }catch{} }
    }
    scanned=0;for(const el of candidates){
      if(++scanned>10000||elements.length>=100){elementsTruncated=true;break;}
      if(!visible(el)||el.disabled||!supported(el)||el.tagName==='INPUT'&&['password','hidden'].includes((el.getAttribute('type')||'').toLowerCase()))continue;
      const data=describe(el);if(data.href&&!/^https?:/i.test(data.href))continue;
      const id='e'+(elements.length+1);nodes.set(id,{el,signature:signature(el)});elements.push({id,...data,fillable:allowedInput(el)&&!el.readOnly,uploadable:el.tagName==='INPUT'&&el.type==='file'});
    }
    const state={snapshot:args.newSnapshot,url:location.href,title:document.title,nodes,text,elements,sourceLimited,readThrough:0,metadata:{...metadata,elementsTruncated,shadowDOM:'open'}};
    globalThis[key]=state;return chunk(state,0);
  }
  if(args.url!==location.href)return {ok:false,error:'网页已跳转，请重新读取',errorCode:'BROWSER_PAGE_CHANGED'};
  if(operation==='scroll'){const y=args.direction==='top'?0:args.direction==='bottom'?document.documentElement.scrollHeight:scrollY+(args.direction==='up'?-1:1)*innerHeight*.8;scrollTo({top:y,behavior:'instant'});return {ok:true,committed:true};}
  const state=globalThis[key],node=state?.nodes.get(args.element),el=node?.el;
  if(!state||state.snapshot!==args.snapshot||state.url!==location.href||!node||!visible(el)||el.disabled||node.signature!==signature(el))return {ok:false,error:'网页或目标元素已变化，请重新读取网页',errorCode:'BROWSER_ELEMENT_CHANGED'};
  if(operation==='upload'){
    if(el.tagName!=='INPUT'||el.type!=='file')return {ok:false,errorCode:'BROWSER_FIELD_UNAVAILABLE',error:'目标不是文件上传控件'};
    const raw=atob(args.base64),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    const mime={txt:'text/plain',md:'text/markdown',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',pdf:'application/pdf',json:'application/json',csv:'text/csv'}[args.name.split('.').pop().toLowerCase()]||'application/octet-stream';
    const file=new File([bytes],args.name,{type:mime}),transfer=new DataTransfer();transfer.items.add(file);el.files=transfer.files;
    const selected=Array.from(el.files).map(f=>({name:f.name,bytes:f.size,type:f.type}));
    el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,committed:true,selected};
  }
  if(operation==='click'){if(el.tagName==='INPUT'&&el.type==='file')return {ok:false,error:'文件选择需使用browser_upload，不打开系统文件框',errorCode:'BROWSER_FIELD_UNAVAILABLE'};if(el.tagName==='SELECT')return {ok:false,error:'下拉选项暂不支持点击操作，请用户选择'};el.click();return {ok:true,committed:true};}
  if(operation==='fill'){
    if(!allowedInput(el)||el.readOnly)return {ok:false,error:'该字段不能填写；密码、文件上传和隐藏字段不开放给AI'};
    const prototype=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,args.text);
    el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,committed:true};
  }
  return {ok:false,error:'不支持的网页操作'};
}
module.exports={pageOperation};

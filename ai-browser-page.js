// 固定程序运行在独立JS world：网页无法伪造元素账本，模型也不能注入任意脚本。
function pageOperation(operation,args){
  const key='__myideBrowserObservation',limit=20000;
  const visible=el=>!!el?.isConnected&&!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&!el.closest('[hidden],[inert],[aria-hidden="true"]');
  const labelText=el=>{const label=el.labels?.[0];if(!label)return '';const clone=label.cloneNode(true);clone.querySelectorAll('input,textarea,select,script,style,[hidden]').forEach(node=>node.remove());return clone.textContent;};
  const describe=el=>({tag:el.tagName.toLowerCase(),type:(el.getAttribute('type')||'').toLowerCase(),name:(el.getAttribute('name')||'').slice(0,160),label:(el.getAttribute('aria-label')||labelText(el)||(!['INPUT','TEXTAREA'].includes(el.tagName)?el.innerText:'')||el.getAttribute('placeholder')||el.getAttribute('title')||'').trim().slice(0,240),href:el.tagName==='A'?el.href:'',formAction:el.form&&el.type==='submit'?(el.hasAttribute('formaction')?el.formAction:el.form.action):''});
  const allowedInput=el=>el.tagName==='TEXTAREA'||el.tagName==='INPUT'&&['','text','search','email','url','tel','number'].includes((el.getAttribute('type')||'').toLowerCase());
  const supported=el=>allowedInput(el)||['A','BUTTON','SELECT'].includes(el.tagName)||el.tagName==='INPUT'&&['button','submit','reset','checkbox','radio'].includes((el.getAttribute('type')||'').toLowerCase())||el.matches('[role="button"]');
  const signature=el=>JSON.stringify({...describe(el),onclick:el.getAttribute('onclick')||'',formMethod:el.form?.method||'',disabled:!!el.disabled,readOnly:!!el.readOnly,value:el.value||'',checked:!!el.checked});
  if(operation==='read'){
    const nodes=new Map(),elements=[];let truncated=false,scanned=0,text='';const start=performance.now();
    const walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT,{acceptNode(node){
      // 空元素也消耗扫描预算，否则一次nextNode可遍历大量没有文本的节点。
      if(++scanned>10000||performance.now()-start>250)return NodeFilter.FILTER_ACCEPT;
      if(node.nodeType===1){if(node.matches('script,style,noscript,input,textarea,select,[contenteditable],[hidden],[inert],[aria-hidden="true"]')||!visible(node))return NodeFilter.FILTER_REJECT;return NodeFilter.FILTER_SKIP;}
      return NodeFilter.FILTER_ACCEPT;
    }});
    while(walker.nextNode()){
      if(scanned>10000||performance.now()-start>250){truncated=true;break;}
      const part=walker.currentNode.textContent.replace(/\s+/g,' ').trim();if(!part)continue;
      text+=(text?'\n':'')+part;if(text.length>limit){text=text.slice(0,limit);truncated=true;break;}
    }
    scanned=0;for(const el of document.querySelectorAll('a[href],button,input,textarea,select,[role="button"]')){
      if(++scanned>10000||elements.length>=100){truncated=true;break;}
      if(!visible(el)||el.disabled||!supported(el)||el.tagName==='INPUT'&&['password','file','hidden'].includes((el.getAttribute('type')||'').toLowerCase()))continue;
      const data=describe(el);if(data.href&&!/^https?:/i.test(data.href))continue;
      const id='e'+(elements.length+1);nodes.set(id,{el,signature:signature(el)});elements.push({id,...data,fillable:allowedInput(el)&&!el.readOnly});
    }
    globalThis[key]={snapshot:args.snapshot,url:location.href,nodes};
    return {ok:true,url:location.href,title:document.title,snapshot:args.snapshot,text,elements,truncated,scroll:{x:scrollX,y:scrollY,height:document.documentElement.scrollHeight,viewport:innerHeight}};
  }
  if(args.url!==location.href)return {ok:false,error:'网页已跳转，请重新读取',errorCode:'BROWSER_PAGE_CHANGED'};
  if(operation==='scroll'){const y=args.direction==='top'?0:args.direction==='bottom'?document.documentElement.scrollHeight:scrollY+(args.direction==='up'?-1:1)*innerHeight*.8;scrollTo({top:y,behavior:'instant'});return {ok:true,committed:true};}
  const state=globalThis[key],node=state?.nodes.get(args.element),el=node?.el;
  if(!state||state.snapshot!==args.snapshot||state.url!==location.href||!node||!visible(el)||el.disabled||node.signature!==signature(el))return {ok:false,error:'网页或目标元素已变化，请重新读取网页',errorCode:'BROWSER_ELEMENT_CHANGED'};
  if(operation==='click'){if(el.tagName==='SELECT')return {ok:false,error:'下拉选项暂不支持点击操作，请用户选择'};el.click();return {ok:true,committed:true};}
  if(operation==='fill'){
    if(!allowedInput(el)||el.readOnly)return {ok:false,error:'该字段不能填写；密码、文件上传和隐藏字段不开放给AI'};
    const prototype=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,args.text);
    el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,committed:true};
  }
  return {ok:false,error:'不支持的网页操作'};
}
module.exports={pageOperation};

// 仅--check-ui注册；普通产品没有这个代点击通道。快照来自真正独立页面，镜像不挂到宿主DOM。
const path=require('path'),{pathToFileURL}=require('url');
function install({ipcMain,webContents,win}){
  const url=pathToFileURL(path.join(__dirname,'../renderer/ai-approval.html')).href;
  const trusted=e=>{if(win.isDestroyed()||e.sender.isDestroyed())return false;if(e.sender!==win.webContents||e.senderFrame!==e.sender.mainFrame)throw Error('invalid test sender');return true;};
  const current=()=>webContents.getAllWebContents().find(w=>!w.isDestroyed()&&w.getURL()===url);
  ipcMain.handle('ai:testApprovalSnapshot',async e=>{
    if(!trusted(e))return null;const wc=current();if(!wc)return null;
    // 页面关闭时Electron的executeJavaScript可能永远不settle，必须先监听destroyed。
    // 活页面读取失败不是“用户已关闭确认”，不得伪造null放过waitClosed。
    let onDestroyed;
    const closed=new Promise(resolve=>{onDestroyed=()=>resolve(null);wc.once('destroyed',onDestroyed);});
    try{
      if(wc.isDestroyed())return null;
      const reading=Promise.resolve().then(()=>wc.executeJavaScript(`({html:document.documentElement.outerHTML,title:document.getElementById('title').textContent,width:innerWidth,height:innerHeight})`)).then(result=>wc.isDestroyed()?null:{id:wc.id,...result});
      return await Promise.race([closed,reading]);
    }catch(error){if(wc.isDestroyed())return null;throw error;}
    finally{wc.removeListener('destroyed',onDestroyed);}
  });
  ipcMain.handle('ai:testApprovalClick',async(e,id,selector)=>{if(!trusted(e))return false;const wc=current();if(!wc||wc.id!==id)return false;if(!['#accept','#reject','#always','#stop','#fold','#close'].includes(selector))throw Error('invalid test click');const b=await wc.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hidden:e.hidden,disabled:e.disabled};})()`);if(b.hidden||b.disabled)return false;if(!wc.debugger.isAttached())wc.debugger.attach('1.3');await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:b.x,y:b.y,button:'left',clickCount:1});await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:b.x,y:b.y,button:'left',clickCount:1});return true;});
}
function renderer(){
  const api=window.myIDE.ai.testing,TIMEOUT=15000,POLL=20;
  let snapshot=null,doc=null,refreshTicket=0,appliedTicket=0;
  const failure=(code,message)=>Object.assign(Error(message),{code});
  const annotate=(error,details)=>{
    if(!error||typeof error!=='object')return error;
    Object.assign(error,details);error.probeMessage??=error.message;
    error.message=error.probeMessage+' · '+JSON.stringify(Object.fromEntries(['operation','phase','expectedTitle','lastTitle','lastPromptId','clickedPromptId','selector'].filter(k=>error[k]!==undefined).map(k=>[k,error[k]])));
    return error;
  };
  const timeout=()=>annotate(failure('AI_APPROVAL_TEST_TIMEOUT','AI approval test timed out'),{lastTitle:snapshot?.title??null,lastPromptId:snapshot?.id??null});
  // IPC也可能不返回；只限制轮询次数仍会让整个headless验收永久挂住。
  const bounded=async(fn,deadline)=>{
    const remaining=deadline-Date.now();if(remaining<=0)throw timeout();
    let timer;
    try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(timeout()),remaining);})]);}
    finally{clearTimeout(timer);}
  };
  const pause=async deadline=>{const remaining=deadline-Date.now();if(remaining<=0)throw timeout();await new Promise(r=>setTimeout(r,Math.min(POLL,remaining)));};
  const refresh=async(deadline=Date.now()+TIMEOUT)=>{
    const ticket=++refreshTicket;
    try{
      const next=await bounded(()=>api.snapshot(),deadline),parsed=next?new DOMParser().parseFromString(next.html,'text/html'):null;
      // 比较已完成而非已发出的ticket：慢IPC与20/40ms轮询交错时也要持续更新缓存。
      // 更旧的IPC迟到仍不能覆盖已经应用的新结果。
      if(ticket>appliedTicket){appliedTicket=ticket;snapshot=next;doc=parsed;}
      return next;
    }catch(error){
      if(ticket>appliedTicket){appliedTicket=ticket;snapshot=null;doc=null;}
      throw annotate(error,{phase:'snapshot'});
    }
  };
  const map=s=>({'#dw-yes':'#accept','#cr-yes':'#accept','#dw-no':'#reject','#cr-no':'#reject','#dw-always':'#always','#cr-always':'#always','#dw-fold':'#fold','.ai-cf-nm':'#target','.ai-cf-stat':'#summary','.ai-cf-body .d-add':'#preview .add'})[s]||s;
  const waitClosed=async(id,deadline)=>{
    for(;;){const current=await refresh(deadline);if(!current||current.id!==id)return;await pause(deadline);}
  };
  const click=async(id,selector,deadline=Date.now()+TIMEOUT)=>{
    let phase='click';
    try{
      const accepted=await bounded(()=>api.click(id,selector),deadline);
      if(accepted!==true)throw failure('AI_APPROVAL_TEST_CLICK_REJECTED','AI approval test click rejected: '+selector);
      // CDP已发送不等于主进程已消费；折叠按钮例外，它本来就不会关闭确认页。
      phase=selector!=='#fold'?'wait-close':'refresh-fold';
      if(selector!=='#fold')await waitClosed(id,deadline);
      else await refresh(deadline);
      return true;
    }catch(error){throw annotate(error,{operation:'query.click',phase,clickedPromptId:id,selector});}
  };
  const query=selector=>{
    if(!doc)return null;
    const run=snapshot.title.includes('命令');if(/^#dw-/.test(selector)&&run||/^#cr-/.test(selector)&&!run)return null;
    const node=doc.querySelector(map(selector));if(!node||node.hidden)return null;
    const id=snapshot.id;node.click=()=>click(id,map(selector));
    const original=node.querySelector.bind(node);node.querySelector=s=>original(map(s));return node;
  };
  const approve=async title=>{
    const deadline=Date.now()+TIMEOUT;let last=snapshot;
    try{for(;;){const current=await refresh(deadline);last=current;if(current?.title===title)return await click(current.id,'#accept',deadline);await pause(deadline);}}
    catch(error){throw annotate(error,{operation:'approve',phase:error?.phase||'wait-title',expectedTitle:title,lastTitle:last?.title??null,lastPromptId:last?.id??null});}
  };
  const configure=async c=>{
    const deadline=Date.now()+TIMEOUT,seen=new Set();let outcome=null,active=true,rejectConfig,last=snapshot;
    const rejected=new Promise((_,reject)=>{rejectConfig=reject;});
    Promise.resolve().then(()=>AiPanel.setConfig(c)).then(value=>{outcome={ok:true,value};},error=>{outcome={ok:false,error};rejectConfig(error);});
    const monitor=async()=>{
      while(active){
        if(Date.now()>=deadline)throw timeout();
        if(outcome){if(!outcome.ok)throw outcome.error;return outcome.value;}
        const current=await refresh(deadline);last=current;
        if(!active)return;
        if(outcome&&!outcome.ok)throw outcome.error;
        if(current?.title==='更改 AI 访问权限'){
          if(seen.has(current.id))throw failure('AI_APPROVAL_TEST_STALE_PROMPT','AI approval test prompt appeared again');
          seen.add(current.id);await click(current.id,'#accept',deadline);
        }else await pause(deadline);
      }
    };
    try{return await Promise.race([monitor(),rejected]);}
    catch(error){throw annotate(error,{operation:'configure',phase:error?.phase||'wait-config-or-policy',expectedTitle:'更改 AI 访问权限',lastTitle:last?.title??null,lastPromptId:last?.id??null});}
    finally{active=false;}
  };
  window.__aiApprovalProbe={query,refresh,configure,approve};
  // 缓存轮询允许失败；所有显式approve/configure/click仍向验收调用者传播失败。
  let running=false;setInterval(async()=>{if(running)return;running=true;try{await refresh();}catch{}finally{running=false;}},40);
}
module.exports={install,renderer};

// 仅--check-ui注册；普通产品没有这个代点击通道。快照来自真正独立页面，镜像不挂到宿主DOM。
const path=require('path'),{pathToFileURL}=require('url');
function install({ipcMain,webContents,win}){
  const url=pathToFileURL(path.join(__dirname,'../renderer/ai-approval.html')).href;
  const trusted=e=>{if(win.isDestroyed()||e.sender.isDestroyed())return false;if(e.sender!==win.webContents||e.senderFrame!==e.sender.mainFrame)throw Error('invalid test sender');return true;};
  const current=()=>webContents.getAllWebContents().find(w=>!w.isDestroyed()&&w.getURL()===url);
  ipcMain.handle('ai:testApprovalSnapshot',async e=>{if(!trusted(e))return null;const wc=current();if(!wc)return null;try{return {id:wc.id,...await wc.executeJavaScript(`({html:document.documentElement.outerHTML,title:document.getElementById('title').textContent,width:innerWidth,height:innerHeight})`)};}catch{return null;}});
  ipcMain.handle('ai:testApprovalClick',async(e,id,selector)=>{if(!trusted(e))return false;const wc=current();if(!wc||wc.id!==id)return false;if(!['#accept','#reject','#always','#stop','#fold','#close'].includes(selector))throw Error('invalid test click');const b=await wc.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hidden:e.hidden,disabled:e.disabled};})()`);if(b.hidden||b.disabled)return false;if(!wc.debugger.isAttached())wc.debugger.attach('1.3');await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:b.x,y:b.y,button:'left',clickCount:1});await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:b.x,y:b.y,button:'left',clickCount:1});return true;});
}
function renderer(){
  let snapshot=null,doc=null;const api=window.myIDE.ai.testing;
  const refresh=async()=>{snapshot=await api.snapshot();doc=snapshot?new DOMParser().parseFromString(snapshot.html,'text/html'):null;};
  const map=s=>({'#dw-yes':'#accept','#cr-yes':'#accept','#dw-no':'#reject','#cr-no':'#reject','#dw-always':'#always','#cr-always':'#always','#dw-fold':'#fold','.ai-cf-nm':'#target','.ai-cf-stat':'#summary','.ai-cf-body .d-add':'#preview .add'})[s]||s;
  const query=selector=>{
    if(!doc)return null;
    const run=snapshot.title.includes('命令');if(/^#dw-/.test(selector)&&run||/^#cr-/.test(selector)&&!run)return null;
    const node=doc.querySelector(map(selector));if(!node||node.hidden)return null;
    const id=snapshot.id;node.click=()=>api.click(id,map(selector));
    const original=node.querySelector.bind(node);node.querySelector=s=>original(map(s));return node;
  };
  const approve=async(title)=>{for(let i=0;i<100;i++){await refresh();if(snapshot?.title===title){await api.click(snapshot.id,'#accept');return;}await new Promise(r=>setTimeout(r,20));}};
  const configure=async c=>{let done=false;const result=AiPanel.setConfig(c).finally(()=>done=true);result.catch(()=>{});for(let i=0;i<100&&!done;i++){await refresh();if(snapshot?.title==='更改 AI 访问权限')await api.click(snapshot.id,'#accept');await new Promise(r=>setTimeout(r,20));}return result;};
  window.__aiApprovalProbe={query,refresh,configure,approve};
  let running=false;setInterval(async()=>{if(running)return;running=true;try{await refresh();}catch{snapshot=null;doc=null;}finally{running=false;}},40);
}
module.exports={install,renderer};

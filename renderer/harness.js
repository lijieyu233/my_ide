const HarnessPanel=(()=>{
  const api=()=>window.myIDE?.harness,panel=()=>document.getElementById('harness-main'),host=()=>document.getElementById('harness-view');
  let visible=false,ready=false,sequence=0,pending=null;
  function config(){return {launcher:window.AiPanel?.getConfig().dshPath||undefined,cwd:window.App?.root||undefined};}
  function status(value){const element=document.getElementById('harness-status');if(element)element.textContent=value;}
  function overlay(){return ['modal-mask','ctx-menu'].some(id=>{const element=document.getElementById(id);return element&&!element.classList.contains('hidden');});}
  function bounds(){if(!visible||!ready||overlay())return;const r=host().getBoundingClientRect();api()?.bounds({x:r.x,y:r.y,width:r.width,height:r.height});}
  async function mount(){if(!visible||!ready||overlay())return;await api()?.mount();requestAnimationFrame(()=>requestAnimationFrame(bounds));}
  async function show(){
    visible=true;panel().classList.remove('hidden');const own=++sequence;
    if(ready){mount();return;}
    status('正在启动完整 DeepSeek Harness…');
    pending ||= api()?.start(config());let result;try{result=await pending;}catch(error){result={ok:false,error:error.message};}finally{pending=null;}
    if(result?.ok)ready=true;
    if(!visible||own!==sequence)return;
    if(!result?.ok){status(result?.error||'Harness 接口不可用');return;}
    status('原生 Harness · 会话与任务在切页后继续保留');mount();
  }
  function hide(){visible=false;sequence++;panel().classList.add('hidden');api()?.hide();}
  function open(){App.setAiOpen(false);App.showTool('harness');}
  function init(){
    document.getElementById('tool-harness').onclick=open;
    document.getElementById('harness-standard').onclick=async()=>{await AiPanel.setConfig({engine:'standard'});App.backToEditor();App.showAi();};
    document.getElementById('harness-close').onclick=()=>App.backToEditor();
    document.getElementById('harness-reload').onclick=()=>{if(ready)api()?.reload();else show();};
    document.getElementById('harness-external').onclick=async()=>{const result=await api()?.external();if(!result?.ok)MI.toast(result?.error||'Harness 尚未启动','err');};
    document.getElementById('harness-desktop').onclick=async()=>{const result=await api()?.desktop(config().launcher);if(!result?.ok)MI.toast(result?.error||'桌面版启动失败','err');};
    if(typeof ResizeObserver==='function')new ResizeObserver(bounds).observe(host());window.addEventListener('resize',bounds);
    api()?.onState(value=>{if(value.status==='ready')ready=true;if(['failed','stopped'].includes(value.status)){ready=false;status(value.error||'Harness 已停止；点击刷新重试');}if(value.status==='starting')status('正在启动完整 DeepSeek Harness…');});
    const observer=new MutationObserver(()=>{if(!visible)return;if(overlay())api()?.hide();else mount();});
    for(const id of ['modal-mask','ctx-menu']){const element=document.getElementById(id);if(element)observer.observe(element,{attributes:true,attributeFilter:['class']});}
    window.myIDE?.win?.onZoom?.(()=>requestAnimationFrame(bounds));
  }
  return {init,open,show,hide,get visible(){return visible;}};
})();
window.HarnessPanel=HarnessPanel;

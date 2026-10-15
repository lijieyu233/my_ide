(()=>{const W=AiWorkbench;W.register('ai',{state:()=>{const s=AiPanel.aiState();return {...s,tasks:s.tasks.map(({pendingTools,pendingPermission,...t})=>t)};},async operate(call,context){
  if(call.name==='ai_session_state'){const detail=await AiPanel.aiInspect(call.args),pending=await myIDE.ai.workbenchAiPending(context,call);if(!pending.ok)W.fail(pending.errorCode||'AI_STATE',pending.error);return W.observe('ai',{...detail,pendingApprovals:pending.pending});}
  await W.checkpoint(call,context);return AiPanel.aiControl(call,context);
}});})();

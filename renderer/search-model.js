// 两种搜索界面共用一次请求与命中身份；视图移位不能重搜或把局部结果改称完整。
const SearchModel = (() => {
  let sequence = 0;
  const sameVersion = (a,b) => !!a && !!b && a.schema===1 && b.schema===1 && !a.absent && !b.absent
    && ['target','stamp','hash'].every(key=>typeof a[key]==='string'&&typeof b[key]==='string')
    && DocumentPaths.key(a.target)===DocumentPaths.key(b.target)&&a.stamp===b.stamp&&a.hash===b.hash;
  function create(root,generation,alive,bridge=window.myIDE.fs) {
    const state={root,generation,query:'',caseSensitive:false,phase:'empty',results:[],ids:new Set(),selectedHitId:null,
      collapsed:new Set(),error:'',protocolError:'',navigationError:'',navigationCode:'',nav:0,request:null,stats:null,batchNo:0};
    const listeners=new Set();let timer,disposed=false;
    const valid=()=>!disposed&&alive(),emit=()=>{if(valid())for(const listener of listeners)listener(state);};
    const same=response=>valid()&&state.request&&response?.requestId===state.request.requestId&&response.projectGeneration===generation
      &&DocumentPaths.key(response.root)===DocumentPaths.key(root)&&response.query===state.request.query;
    const cancel=request=>request?bridge.cancelSearch(request.requestId).catch(()=>null):Promise.resolve(null);
    function add(results) {
      if(!Array.isArray(results))throw Error('搜索返回了无效结果集合');
      for(const hit of results){
        if(!hit||typeof hit.hitId!=='string'||typeof hit.file!=='string'||typeof hit.encoding!=='string'||typeof hit.path!=='string'||!DocumentPaths.contains(root,hit.path)
          ||typeof hit.text!=='string'||typeof hit.match!=='string'||!hit.match.length||!sameVersion(hit.version,hit.version)
          ||!Number.isSafeInteger(hit.line)||hit.line<1||!Number.isSafeInteger(hit.startColumn)||hit.startColumn<1
          ||!Number.isSafeInteger(hit.endColumn)||hit.endColumn<=hit.startColumn||!Number.isSafeInteger(hit.previewStartColumn)||hit.previewStartColumn<1
          ||!Number.isSafeInteger(hit.startOffset)||hit.startOffset<0||!Number.isSafeInteger(hit.endOffset)||hit.endOffset<=hit.startOffset
          ||hit.endColumn-hit.startColumn!==hit.match.length||hit.endOffset-hit.startOffset!==hit.match.length||hit.previewStartColumn>hit.startColumn)
          throw Error('搜索返回了无效的文件位置');
        if(state.ids.has(hit.hitId))continue;if(state.results.length>=200)throw Error('搜索结果超过预算');state.ids.add(hit.hitId);state.results.push(hit);
      }
      state.selectedHitId ||= state.results[0]?.hitId || null;
    }
    async function run(){
      if(!valid()||!state.query)return;
      const request={requestId:'search-'+Date.now()+'-'+(++sequence),root,projectGeneration:generation,query:state.query,options:{caseSensitive:state.caseSensitive}};
      state.request=request;state.batchNo=0;state.phase='searching';state.error=state.protocolError=state.navigationError=state.navigationCode='';state.results=[];state.ids.clear();state.selectedHitId=null;emit();
      try{const response=await bridge.search(request);if(!same(response)){if(valid()&&state.request===request)throw Error('搜索回复的项目或查询身份不一致');return;}
        if(state.protocolError)throw Error(state.protocolError);add(response.results);
        if(!['complete','resultLimit','timeLimit','cancelled','error'].includes(response.doneReason)||response.truncated!==(response.doneReason!=='complete'))throw Error('搜索回复没有有效的结束原因');
        state.phase=response.doneReason;state.error=response.error||'';state.stats=response.stats;emit();
      }catch(error){if(valid()&&state.request===request){state.phase='error';state.error=String(error?.message||error);cancel(request);emit();}}
    }
    function query(query,caseSensitive=state.caseSensitive,composing=false){
      if(!valid())return;clearTimeout(timer);cancel(state.request);state.request=null;state.nav++;
      Object.assign(state,{query,caseSensitive,phase:query?'waiting':'empty',results:[],selectedHitId:null,error:'',protocolError:'',navigationError:'',navigationCode:'',stats:null});state.ids.clear();state.collapsed.clear();emit();
      if(query&&!composing)timer=setTimeout(run,300);
    }
    async function stop(){
      if(!valid())return;if(state.phase==='waiting'){clearTimeout(timer);state.phase='cancelled';emit();return;}
      const request=state.request;if(state.phase!=='searching'||!request)return;state.phase='cancelling';emit();
      try{const ack=await bridge.cancelSearch(request.requestId);if(!valid()||state.request!==request)return;if(!ack?.stopped&&state.phase==='cancelling'){state.phase='error';state.error='停止尚未确认，请重试';emit();}}
      catch(error){if(valid()&&state.request===request){state.phase='error';state.error='停止失败：'+String(error?.message||error);emit();}}
    }
    const off=bridge.onSearchBatch(batch=>{if(!same(batch)||state.protocolError||!['searching','cancelling'].includes(state.phase)||batch.batchNo<=state.batchNo)return;
      try{if(batch.batchNo!==state.batchNo+1)throw Error('搜索批次缺失，请重试');add(batch.results);state.batchNo=batch.batchNo;emit();}
      catch(error){state.phase='error';state.protocolError=state.error=String(error?.message||error);cancel(state.request);emit();}});
    return {state,query,run,stop,valid,subscribe(fn){listeners.add(fn);fn(state);return()=>listeners.delete(fn);},
      select(id){if(valid()&&state.ids.has(id)){state.selectedHitId=id;emit();}},
      collapse(path){if(!valid())return;const key=DocumentPaths.key(path);state.collapsed.has(key)?state.collapsed.delete(key):state.collapsed.add(key);emit();},
      navigation(error='',code=''){state.navigationError=error;state.navigationCode=code;emit();},
      suspend(){state.nav++;clearTimeout(timer);stop();},
      reset(){query('');},
      dispose(){if(disposed)return;clearTimeout(timer);cancel(state.request);state.nav++;disposed=true;off();listeners.clear();state.results=[];state.ids.clear();state.request=null;}
    };
  }
  return {create,sameVersion};
})();
window.SearchModel=SearchModel;

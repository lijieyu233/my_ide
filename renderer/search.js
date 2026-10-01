// 请求/批次/导航都绑定打开时的项目代次，不能借当前App.root解释旧路径。
const Search = (() => {
  let generation = 0, sequence = 0, panel = null;
  const current = state => panel === state && state.box.isConnected && state.generation === generation
    && DocumentPaths.key(state.root) === DocumentPaths.key(App.root);
  const top = state => Modal.stack.at(-1) === state.box;
  const sameRequest = (state, response) => current(state) && state.request && response?.requestId === state.request.requestId
    && response.projectGeneration === state.generation && DocumentPaths.key(response.root) === DocumentPaths.key(state.root) && response.query === state.request.query;
  const sameVersion = (a, b) => !!a && !!b && a.schema === 1 && b.schema === 1 && !a.absent && !b.absent
    && typeof a.target === 'string' && typeof b.target === 'string' && typeof a.stamp === 'string' && typeof b.stamp === 'string'
    && typeof a.hash === 'string' && typeof b.hash === 'string'
    && DocumentPaths.key(a.target) === DocumentPaths.key(b.target) && a.stamp === b.stamp && a.hash === b.hash;
  const cancel = request => { if (request) return window.myIDE.fs.cancelSearch(request.requestId).catch(() => null); };
  function setSel(state, index) {
    state.selected = state.results.length ? Math.max(0, Math.min(index, state.results.length - 1)) : -1;
    const rows = [...state.list.querySelectorAll('.qo-item')];
    rows.forEach((row, i) => { row.classList.toggle('sel', i === state.selected); row.setAttribute('aria-selected', String(i === state.selected)); });
    const row = rows[state.selected];
    if (row) { state.input.setAttribute('aria-activedescendant', row.id); row.scrollIntoView?.({ block: 'nearest' }); }
    else state.input.removeAttribute('aria-activedescendant');
  }
  function status(state) {
    const count = state.results.length;
    const phases = { empty: '输入关键字开始搜索…', waiting: '等待搜索…', searching: '搜索中，已找到 ' + count + ' 处', cancelling: '正在停止，已找到 ' + count + ' 处',
      complete: count ? '搜索完成：' + count + ' 处' : '搜索完成，没有匹配内容', resultLimit: '达到结果上限：' + count + ' 处，未完整搜索',
      timeLimit: '搜索超时：已找到 ' + count + ' 处，未完整搜索', cancelled: '搜索已取消：已找到 ' + count + ' 处', error: '搜索失败：' + state.error };
    const skipped = state.stats?.skipped, excluded = skipped ? Object.entries(skipped).filter(([,n]) => n).map(([reason,n]) =>
      ({hidden:'隐藏项',links:'链接',special:'特殊文件',large:'大文件',empty:'空文件',binary:'二进制'}[reason] || reason) + ' ' + n).join('、') : '';
    state.status.textContent = (phases[state.phase] || '搜索状态不可用') + (excluded ? '；略过 ' + excluded : '') + (state.error && state.phase !== 'error' ? '；' + state.error : '')
      + (state.navigationError ? '；定位失败：' + state.navigationError : '');
    state.stop.disabled = !['waiting','searching'].includes(state.phase);
    state.retry.hidden = !state.navigationError && !['error','timeLimit','resultLimit','cancelled'].includes(state.phase);
  }
  function render(state, preserve = true) {
    if (!current(state)) return;
    const selected = state.results[state.selected]?.hitId; state.list.replaceChildren();
    const head = document.createElement('div'); head.className = 'sr-stat'; head.textContent = state.results.length + ' 条结果'; state.list.appendChild(head);
    state.results.forEach((hit,i) => {
      const row = document.createElement('div'); row.className = 'qo-item'; row.id = 'search-hit-' + i; row.dataset.hitId = hit.hitId;
      row.setAttribute('role','option'); row.title = hit.path + ':' + hit.line + ':' + hit.startColumn;
      const file = document.createElement('span'); file.className = 'sr-file'; file.textContent = hit.file + ':' + hit.line + ':' + hit.startColumn;
      const text = document.createElement('span'); text.className = 'sr-text';
      const from = Math.max(0, hit.startColumn - hit.previewStartColumn), mark = document.createElement('mark'); mark.className = 'sr-hit';
      mark.textContent = hit.text.slice(from, from + hit.match.length); text.append(document.createTextNode(hit.text.slice(0,from)),mark,document.createTextNode(hit.text.slice(from+hit.match.length)));
      row.append(file,text); row.onmouseenter = () => { if(current(state)&&top(state))setSel(state,i); };
      row.onclick = () => pick(state,hit.hitId); state.list.appendChild(row);
    });
    setSel(state,preserve ? Math.max(0,state.results.findIndex(hit=>hit.hitId===selected)) : 0); status(state);
  }
  function addResults(state, results) {
    if (!Array.isArray(results)) throw Error('搜索返回了无效结果集合');
    for (const hit of results) {
      if (!hit || typeof hit.hitId !== 'string' || typeof hit.file !== 'string' || typeof hit.encoding !== 'string' || typeof hit.path !== 'string' || !DocumentPaths.contains(state.root,hit.path)
        || typeof hit.text !== 'string' || typeof hit.match !== 'string' || !hit.match.length || !sameVersion(hit.version,hit.version)
        || !Number.isSafeInteger(hit.line) || hit.line<1 || !Number.isSafeInteger(hit.startColumn) || hit.startColumn<1
        || !Number.isSafeInteger(hit.endColumn) || hit.endColumn<=hit.startColumn || !Number.isSafeInteger(hit.previewStartColumn) || hit.previewStartColumn<1
        || !Number.isSafeInteger(hit.startOffset) || hit.startOffset<0 || !Number.isSafeInteger(hit.endOffset) || hit.endOffset<=hit.startOffset
        || hit.endColumn-hit.startColumn!==hit.match.length || hit.endOffset-hit.startOffset!==hit.match.length || hit.previewStartColumn>hit.startColumn)
        throw Error('搜索返回了无效的文件位置');
      if (state.ids.has(hit.hitId)) continue;
      if (state.results.length >= 200) throw Error('搜索结果超过预算');
      state.ids.add(hit.hitId); state.results.push(hit);
    }
  }
  async function run(state) {
    if (!current(state) || !state.input.value || state.composing) return;
    const request = { requestId:'search-'+Date.now()+'-'+(++sequence),root:state.root,projectGeneration:state.generation,query:state.input.value,
      options:{caseSensitive:state.caseSensitive.checked} };
    state.request=request;state.batchNo=0;state.phase='searching';state.error='';state.protocolError='';state.navigationError='';state.results=[];state.ids.clear();render(state,false);
    try {
      const response=await window.myIDE.fs.search(request);
      if(!sameRequest(state,response)) { if(current(state)&&state.request===request)throw Error('搜索回复的项目或查询身份不一致');return; }
      if(state.protocolError)throw Error(state.protocolError);
      addResults(state,response.results);
      if(!['complete','resultLimit','timeLimit','cancelled','error'].includes(response.doneReason) || response.truncated !== (response.doneReason!=='complete'))throw Error('搜索回复没有有效的结束原因');
      state.phase=response.doneReason;state.error=response.error||'';state.stats=response.stats;render(state);
    }catch(error){if(current(state)&&state.request===request){state.phase='error';state.error=String(error?.message||error);cancel(request);render(state);}}
  }
  function queryChanged(state) {
    if(!current(state))return;
    clearTimeout(state.timer);cancel(state.request);state.request=null;state.nav++;
    state.results=[];state.ids.clear();state.error='';state.protocolError='';state.navigationError='';state.stats=null;state.phase=state.input.value?'waiting':'empty';render(state,false);
    if(state.input.value&&!state.composing)state.timer=setTimeout(()=>run(state),300);
  }
  async function stop(state) {
    if(!current(state))return;
    if(state.phase==='waiting'){clearTimeout(state.timer);state.phase='cancelled';status(state);return;}
    const request=state.request;if(state.phase!=='searching'||!request)return;
    state.phase='cancelling';status(state);
    try{const ack=await window.myIDE.fs.cancelSearch(request.requestId);if(!current(state)||state.request!==request)return;
      if(!ack?.stopped&&state.phase==='cancelling'){state.phase='error';state.error='停止尚未确认，请重试';status(state);}
    }catch(error){if(current(state)&&state.request===request){state.phase='error';state.error='停止失败：'+String(error?.message||error);status(state);}}
  }
  function restoreFocus(state) {
    if(DocumentPaths.key(App.root)!==DocumentPaths.key(state.root))return;
    const other=Modal.stack.at(-1),origin=state.origin;
    if(origin?.isConnected&&origin!==document.body&&(!other||other.contains(origin))&&(!origin.closest('.cm-editor')||Viewer.activeTab?.id===state.documentId))origin.focus();
    else if(other){other.tabIndex=-1;other.focus();}
    else if(Viewer.cm?.__tab===Viewer.activeTab&&Viewer.cm.view?.dom.isConnected)Viewer.cm.focus();
    else document.querySelector('#btn-search')?.focus();
  }
  function cleanup(state) {
    if(state.closed)return;state.closed=true;state.nav++;clearTimeout(state.timer);cancel(state.request);state.request=null;state.results=[];state.unsubscribe?.();
    document.removeEventListener('keydown',state.onKey,true);document.removeEventListener('focusin',state.onFocus,true);state.mask.removeEventListener('click',state.onMask);
    state.inert.forEach(([element,previous])=>previous?element.setAttribute('inert',''):element.removeAttribute('inert'));
    if(panel===state)panel=null;if(state.restore)restoreFocus(state);
  }
  function close(state,restore=true){if(!current(state)||!top(state))return;state.restore=restore;Modal.hide();}
  async function pick(state,id=state.results[state.selected]?.hitId) {
    if(!current(state)||!top(state)||!id)return;
    const hit=state.results.find(hit=>hit.hitId===id);if(!hit||state.input.value!==state.request?.query)return;
    const token=++state.nav,request=state.request,valid=()=>current(state)&&top(state)&&state.nav===token&&state.request===request;
    state.navigationError='';status(state);
    try{
      const version=await window.myIDE.fs.fileVersion(hit.path);if(!valid())return;
      if(version.error||!sameVersion(version.version,hit.version))throw Error(version.error||'文件已改变，请重新搜索');
      const opened=Viewer.openTabs.find(tab=>DocumentPaths.key(tab.path)===DocumentPaths.key(hit.path));
      if(opened?.dirty)throw Error('目标文件有未保存的输入，磁盘搜索位置已过期');
      await Viewer.openFile(hit.path);if(!valid())return;
      const tab=Viewer.activeTab;if(DocumentPaths.key(tab?.path)!==DocumentPaths.key(hit.path)||tab.error||tab.mode==null||tab.content==null)throw Error(tab?.error||'目标文件没有成功打开');
      if(tab.dirty||!sameVersion(tab.diskVersion,hit.version)||tab.encoding!==hit.encoding||tab.content.slice(hit.startOffset,hit.endOffset)!==hit.match)
        throw Error('当前文档与搜索版本不一致，请重新搜索');
      const cm=Viewer.cm;if(cm?.__tab!==tab||!cm.view?.dom.isConnected||typeof cm.setCursor!=='function')throw Error('当前视图不支持精确文本定位，请切到编辑、源码或实时预览后重试');
      const line=cm.view.state.doc.line(hit.line),from=line.from+hit.startColumn-1,to=line.from+hit.endColumn-1;
      if(to>line.to||cm.view.state.doc.sliceString(from,to)!==hit.match)throw Error('文本位置已变化，请重新搜索');
      Viewer.revealLine(hit.line);cm.setCursor(from,to);close(state,false);
      if(DocumentPaths.key(App.root)===DocumentPaths.key(state.root)&&Viewer.activeTab===tab&&!Modal.stack.length)cm.focus();
    }catch(error){if(valid()){state.navigationError=String(error?.message||error);status(state);state.input.focus();}}
  }
  function open() {
    if(!App.root){MI.toast('请先打开一个文件夹','err');return;}
    if(panel&&current(panel)){if(top(panel))panel.input.focus();return;}
    const box=document.createElement('div');box.id='sr-box';box.dataset.selfEsc='1';box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby','sr-title');
    box.innerHTML='<div class="qo-head"><span id="sr-title">搜索内容</span><button id="sr-close" class="tb-btn">关闭</button></div>'
      +'<input id="sr-input" placeholder="输入关键字…" aria-label="搜索内容" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="sr-list" aria-describedby="sr-status" autocomplete="off" spellcheck="false">'
      +'<div class="sr-controls"><label><input id="sr-case" type="checkbox">区分大小写</label><button id="sr-stop" class="tb-btn" disabled>停止</button><button id="sr-retry" class="tb-btn" hidden>重新搜索</button></div>'
      +'<div id="sr-status" role="status"></div><div id="sr-list" role="listbox" aria-label="搜索结果"></div><div class="qo-foot">↑↓ 选择 · Enter 定位 · Esc 关闭</div>';
    const state={box,root:App.root,generation,origin:document.activeElement,documentId:Viewer.activeTab?.id,mask:document.querySelector('#modal-mask'),
      input:box.querySelector('#sr-input'),list:box.querySelector('#sr-list'),status:box.querySelector('#sr-status'),caseSensitive:box.querySelector('#sr-case'),
      stop:box.querySelector('#sr-stop'),retry:box.querySelector('#sr-retry'),results:[],ids:new Set(),selected:-1,phase:'empty',nav:0,restore:true};
    panel=state;state.inert=[...document.body.children,...Modal.stack].filter(el=>!['modal-mask','toast-wrap'].includes(el.id)).map(el=>[el,el.hasAttribute('inert')]);
    state.inert.forEach(([el])=>el.setAttribute('inert',''));box.onModalHide=()=>cleanup(state);Modal.show(box);
    state.unsubscribe=window.myIDE.fs.onSearchBatch(batch=>{if(!sameRequest(state,batch)||state.protocolError||!['searching','cancelling'].includes(state.phase)||batch.batchNo<=state.batchNo)return;
      try{if(batch.batchNo!==state.batchNo+1)throw Error('搜索批次缺失，请重试');addResults(state,batch.results);state.batchNo=batch.batchNo;render(state);}
      catch(error){state.phase='error';state.protocolError=state.error=String(error?.message||error);cancel(state.request);render(state);}});
    state.onKey=event=>{if(!current(state)||!top(state))return;if(state.composing||event.isComposing||event.keyCode===229){event.stopImmediatePropagation();return;}
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close(state);}
      else if(event.key==='Tab'){event.preventDefault();event.stopImmediatePropagation();const controls=[box.querySelector('#sr-close'),state.input,state.caseSensitive,state.stop,state.retry].filter(el=>!el.disabled&&!el.hidden);const i=controls.indexOf(document.activeElement);controls[(i+(event.shiftKey?-1:1)+controls.length)%controls.length].focus();}
      else if(event.target===state.input&&['ArrowDown','ArrowUp','Enter'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();if(event.key==='Enter')pick(state);else setSel(state,state.selected+(event.key==='ArrowDown'?1:-1));}
      else if(event.ctrlKey||event.metaKey||event.altKey)event.stopImmediatePropagation();};
    state.onFocus=event=>{if(current(state)&&top(state)&&!box.contains(event.target))state.input.focus();};state.onMask=event=>{if(event.target===state.mask)close(state);};
    document.addEventListener('keydown',state.onKey,true);document.addEventListener('focusin',state.onFocus,true);state.mask.addEventListener('click',state.onMask);
    state.input.addEventListener('input',()=>queryChanged(state));state.caseSensitive.onchange=()=>queryChanged(state);
    state.input.addEventListener('compositionstart',()=>{state.composing=true;queryChanged(state);});state.input.addEventListener('compositionend',()=>{state.composing=false;queryChanged(state);});
    box.querySelector('#sr-close').onclick=()=>close(state);state.stop.onclick=()=>stop(state);state.retry.onclick=()=>queryChanged(state);
    render(state);state.input.focus();
  }
  function setRoot() {
    generation++;if(!panel)return;const state=panel;state.restore=false;
    if(top(state))Modal.hide();else{const i=Modal.stack.indexOf(state.box);if(i>=0)Modal.stack.splice(i,1);state.box.remove();cleanup(state);}
  }
  return {open,setRoot};
})();
window.Search=Search;

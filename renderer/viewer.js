// viewer.js —— 标签页 + 内容区：打开/编辑/保存/预览切换
const Viewer = (() => {
  const tabbar = document.getElementById('tabbar');
  const tabScroll = document.getElementById('tab-scroll');
  const tabActions = document.getElementById('tab-actions');
  // 标签栏隐藏了原生滚动条（CSS），滚动交给滚轮：鼠标在标签上上下滚 = 左右滚。
  // IDE 惯例；一条灰滚动条比它下面的几个标签还抢眼（用户截图反馈）。
  if (tabScroll) {
    tabScroll.addEventListener('wheel', (e) => {
      if (tabScroll.scrollWidth <= tabScroll.clientWidth + 1) return;
      const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!d) return;
      e.preventDefault();
      tabScroll.scrollLeft += d;
    }, { passive: false });
  }
  const viewer = document.getElementById('viewer');
  const empty = document.getElementById('empty-state');
  const tabs = []; // {path, name, dirty, content, mode}
  let nextTabId = 0;
  const saveQueues = new Map();
  const navigationFocus = new Map();
  const pathChanges = new Set();
  const pathBusy = (p) => [...pathChanges].some(change => change.ranges.some(range => DocumentPaths.contains(range,p)));
  let activeTabId = null;
  let focusedTabId=null;
  const currentTab = () => tabs.find(t => t.id === activeTabId) || null;
  let saveTimer = null;

  function extOf(name) { return (name.split('.').pop() || '').toLowerCase(); }
  function formatLabel(tab) {
    const format = tab.textFormat || { encoding: tab.encoding || 'utf8' };
    const names = { utf8: 'UTF-8', utf16le: 'UTF-16LE', utf16be: 'UTF-16BE', gbk: 'GBK' };
    return (names[format.encoding] || format.encoding) + (format.bom ? ' BOM' : '')
      + (format.detection === 'fallback' ? '（推测）' : format.detection === 'heuristic' ? '（启发式）' : '');
  }
  function canChooseEncoding(tab) {
    const ext = extOf(tab.name);
    return !tab.tooLarge && tab.mode != null && !IMG_EXTS.has(ext) && !MEDIA_EXTS.has(ext) && !OFFICE_EXTS.has(ext) && !OFFICE_OLD_EXTS.has(ext);
  }
  function updateFormatStatus(tab) {
    if (tab === currentTab() && window.App) App.updateStatusbar({
      encoding: formatLabel(tab), encodingEnabled: canChooseEncoding(tab),
      eol: tab.eol, lines: tab.content ? tab.content.split('\n').length : 0,
    });
  }
  function validFormatTarget(tab, path, revision) {
    return tabs.includes(tab) && tab.path === path && tab.editRevision === revision && !pathBusy(path);
  }
  async function saveWithEncoding(encoding, bom, tab = currentTab()) {
    if (!tab || tab.content == null || tab.binary || tab.tooLarge) return { ok: false, errorCode: 'NO_CONTENT' };
    if (!['utf8', 'utf16le', 'utf16be', 'gbk'].includes(encoding) || encoding === 'gbk' && bom) return { ok: false, errorCode: 'INVALID_FORMAT' };
    tab.textFormat = { encoding, bom: !!bom, detection: 'selected', eol: tab.eol };
    tab.encoding = encoding;
    markEdited(tab);
    updateFormatStatus(tab);
    return saveSnapshot(tab, false);
  }
  async function reopenWithEncoding(encoding, tab = currentTab()) {
    if (!tab || tab.tooLarge || tab.mode == null) return { ok: false, errorCode: 'NO_CONTENT' };
    const path = tab.path, revision = tab.editRevision;
    if (tab.dirty || saveQueues.has(DocumentPaths.key(path))) {
      MI.toast('当前文件仍有未保存修改或保存正在进行，请先保存；重新打开未执行', 'err');
      return { ok: false, errorCode: 'UNSAVED_CHANGES' };
    }
    const sequence = tab.formatRead = (tab.formatRead || 0) + 1;
    tab.formatBusy = true;
    try {
      const r = await window.myIDE.fs.readFile(path, encoding);
      if (!validFormatTarget(tab, path, revision) || tab.dirty || sequence !== tab.formatRead) return { ok: false, errorCode: 'STALE_READ' };
      if (r.error || r.binary || r.content == null) {
        MI.toast('重新打开失败: ' + (r.error || '无法解码为文本') + '；当前内容已保留', 'err');
        return { ok: false, errorCode: r.errorCode || 'READ_FAILED' };
      }
      tab.content = r.content; tab.encoding = r.encoding || encoding; tab.diskVersion = r.version;
      tab.textFormat = r.textFormat || { encoding: tab.encoding, bom: false };
      tab.eol = r.textFormat && r.textFormat.eol;
      tab.error = null; tab.binary = false; tab.saveError = null; tab.saveErrorCode = null;
      tab.editRevision++; tab.savedRevision = tab.editRevision;
      tab.cmState = null; tab.ta = null;
      if (tab.mode === 'error') tab.mode = MD_EXTS.has(extOf(tab.name)) ? 'source' : 'edit';
      if (tab === currentTab()) {
        // renderView会保存旧state；重新解码必须丢弃绑定旧正文的历史，再重建。
        if (cmApi && cmApi.__tab === tab) { cmApi.destroy(); cmApi = null; }
        renderView();
      }
      renderTabs(); updateFormatStatus(tab);
      return { ok: true };
    } catch (e) {
      MI.toast('重新打开失败: ' + String(e.message || e) + '；当前内容已保留', 'err');
      return { ok: false, errorCode: 'READ_FAILED' };
    } finally { if (sequence === tab.formatRead) tab.formatBusy = false; }
  }
  function showEncoding() {
    const tab = currentTab();
    if (!tab || tab.tooLarge || tab.mode == null || IMG_EXTS.has(extOf(tab.name)) || MEDIA_EXTS.has(extOf(tab.name)) || OFFICE_EXTS.has(extOf(tab.name))) return;
    const path = tab.path, revision = tab.editRevision, box = document.createElement('div');
    box.className = 'encoding-dialog'; box.dataset.selfEsc = '1';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', '文件编码');
    box.innerHTML = '<div class="m-head">文件编码<button class="encoding-close" aria-label="关闭">×</button></div>'
      + '<div class="m-body"><div class="encoding-file"></div><p class="encoding-current"></p>'
      + '<label>编码 <select class="encoding-choice"><option value="utf8">UTF-8</option><option value="utf16le">UTF-16LE</option><option value="utf16be">UTF-16BE</option><option value="gbk">GBK</option></select></label>'
      + '<label class="encoding-bom"><input type="checkbox">保留 BOM</label>'
      + '<p class="encoding-note">以指定编码保存会转换当前内存正文。重新打开只读取磁盘，需先保存未保存修改。GBK无法表示的字符会拒绝写入。</p></div>'
      + '<div class="m-foot"><button class="tb-btn m-cancel">取消</button><button class="tb-btn encoding-reopen">按此编码重新打开</button><button class="tb-btn m-ok encoding-save">以此编码保存</button></div>';
    box.querySelector('.encoding-file').textContent = path;
    box.querySelector('.encoding-current').textContent = '当前：' + formatLabel(tab);
    const choice = box.querySelector('select'), checkbox = box.querySelector('input');
    choice.value = tab.encoding || 'utf8'; checkbox.checked = !!tab.textFormat?.bom;
    const sync = () => { checkbox.disabled = choice.value === 'gbk'; if (checkbox.disabled) checkbox.checked = false; };
    choice.onchange = sync; sync();
    box.querySelector('.encoding-save').disabled = tab.content == null || tab.binary;
    const origin = document.activeElement;
    Modal.show(box);
    const finish = () => { if (Modal.stack[Modal.stack.length - 1] === box) Modal.hide(); if (origin && origin.isConnected) origin.focus(); };
    const action = (run) => {
      if (!validFormatTarget(tab, path, revision)) { finish(); MI.toast('文档已变化，请重新打开文件编码面板', 'err'); return; }
      const encoding = choice.value, bom = checkbox.checked;
      finish(); run(encoding, bom);
    };
    box.querySelector('.m-cancel').onclick = finish; box.querySelector('.encoding-close').onclick = finish;
    box.querySelector('.encoding-save').onclick = () => action((encoding, bom) => saveWithEncoding(encoding, bom, tab));
    box.querySelector('.encoding-reopen').onclick = () => action((encoding) => reopenWithEncoding(encoding, tab));
    box.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); }
      if (e.key === 'Tab') {
        const controls = [...box.querySelectorAll('button,select,input')].filter((el) => !el.disabled);
        const index = controls.indexOf(document.activeElement);
        if (e.shiftKey && index <= 0 || !e.shiftKey && index === controls.length - 1) {
          e.preventDefault(); controls[e.shiftKey ? controls.length - 1 : 0].focus();
        }
      }
    });
    box.querySelector('.m-cancel').focus();
  }

  async function saveCopy(tab = currentTab()) {
    if (!tab || tab.content == null || tab.binary || tab.tooLarge) return { ok: false, errorCode: 'NO_CONTENT' };
    const path = tab.path, revision = tab.editRevision, content = tab.content, format = { ...tab.textFormat };
    try {
      const dest = await window.myIDE.fs.pickSave('另存副本', path);
      if (!dest) return { ok: false, errorCode: 'CANCELLED' };
      if (!validFormatTarget(tab, path, revision)) return { ok: false, errorCode: 'STALE_COPY' };
      if (dest.replace(/\\/g, '/').toLowerCase() === path.replace(/\\/g, '/').toLowerCase()) {
        MI.toast('请选择其他路径；原文件请通过比较后的覆盖操作保存', 'err');
        return { ok: false, errorCode: 'SAME_PATH' };
      }
      const observed = await window.myIDE.fs.fileVersion(dest);
      if (!observed || observed.error || !observed.version) throw Error(observed?.error || '不能读取目标版本');
      if (tab.diskVersion && observed.version.target.toLowerCase() === tab.diskVersion.target.toLowerCase()) {
        MI.toast('所选路径指向原文件，请选择其他路径', 'err');
        return { ok: false, errorCode: 'SAME_PATH' };
      }
      if (!observed.absent) {
        const yes = await Modal.confirm('覆盖副本目标', '所选文件已经存在。确定用本次正文替换此目标吗？');
        if (!yes) return { ok: false, errorCode: 'CANCELLED' };
      }
      if (!validFormatTarget(tab, path, revision)) return { ok: false, errorCode: 'STALE_COPY' };
      const r = await window.myIDE.fs.writeFile(dest, content, format, { expectedVersion: observed.version });
      if (!r || !r.ok) throw Error(r?.error || '副本未保存');
      MI.toast('副本已保存：' + dest + '；原文件的修改仍未保存', 'ok');
      return { ok: true, path: dest, savedRevision: revision };
    } catch (e) {
      MI.toast('另存副本失败：' + String(e.message || e) + '；当前输入已保留', 'err');
      return { ok: false, errorCode: 'COPY_FAILED' };
    }
  }
  async function showSaveRecovery(tab = currentTab()) {
    if (!tab || tab.content == null) return;
    const path = tab.path, revision = tab.editRevision, content = tab.content;
    const sequence = tab.recoveryRead = (tab.recoveryRead || 0) + 1;
    let disk;
    try { disk = await window.myIDE.fs.readFile(path, tab.textFormat?.detection === 'selected' ? tab.encoding : undefined); }
    catch (e) { disk = { error: String(e.message || e) }; }
    disk ||= { error: '读取磁盘未返回结果' };
    if (!validFormatTarget(tab, path, revision) || sequence !== tab.recoveryRead) { MI.toast('文档已变化，请重新比较', 'err'); return; }
    const box = document.createElement('div'); box.className = 'save-recovery'; box.dataset.selfEsc = '1';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', '保存恢复');
    box.innerHTML = '<div class="m-head">保存恢复</div><div class="m-body"><div class="save-recovery-path"></div><p class="save-recovery-note"></p>'
      + '<div class="save-compare"><section><h3>当前输入（未保存）</h3><pre class="save-memory"></pre></section><section><h3>磁盘版本（只读）</h3><pre class="save-disk"></pre></section></div></div>'
      + '<div class="m-foot"><button class="tb-btn m-cancel">保留并关闭</button><button class="tb-btn save-copy">另存副本…</button><button class="tb-btn save-overwrite">用当前输入覆盖此磁盘版本</button></div>';
    box.querySelector('.save-recovery-path').textContent = path;
    box.querySelector('.save-recovery-note').textContent = '比较不会修改文件。覆盖仅针对这里读取到的磁盘版本；磁盘再次变化会拒绝保存。';
    box.querySelector('.save-memory').textContent = content;
    box.querySelector('.save-disk').textContent = disk.content ?? (disk.version?.absent ? '文件已被移除' : disk.error || '磁盘不是可比较文本');
    box.querySelector('.save-overwrite').disabled = !disk.version || disk.binary || disk.tooLarge;
    const origin = document.activeElement;
    const finish = () => { if (Modal.stack.at(-1) === box) Modal.hide(); if (origin?.isConnected) origin.focus(); };
    Modal.show(box);
    box.querySelector('.m-cancel').onclick = finish;
    box.querySelector('.save-copy').onclick = () => {
      if (!validFormatTarget(tab, path, revision)) { finish(); MI.toast('输入或路径已变化，请重新比较', 'err'); return; }
      finish(); saveCopy(tab);
    };
    box.querySelector('.save-overwrite').onclick = () => {
      if (!validFormatTarget(tab, path, revision)) { finish(); MI.toast('输入或路径已变化，请重新比较', 'err'); return; }
      finish(); saveSnapshot(tab, false, disk.version);
    };
    box.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229 || Modal.stack.at(-1) !== box) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); }
      if (e.key === 'Tab') {
        const controls = [...box.querySelectorAll('button')].filter((el) => !el.disabled), index = controls.indexOf(document.activeElement);
        if (e.shiftKey && index <= 0 || !e.shiftKey && index === controls.length - 1) { e.preventDefault(); controls[e.shiftKey ? controls.length - 1 : 0].focus(); }
      }
    });
    box.querySelector('.m-cancel').focus();
  }

  const TEXT_EXTS = new Set(['txt', 'log', 'ini', 'cfg', 'conf', 'env', 'gitignore', 'yml', 'yaml', 'toml', 'xml', 'bat', 'cmd', 'sh', 'ps1', 'sql', 'csv', 'tsv', 'properties', 'lock']);
  const CODE_EXTS = new Set(['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'css', 'scss', 'less', 'html', 'htm', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'vue', 'svelte']);
  const PREVIEW_EXTS = new Set(['md', 'markdown', 'html', 'htm', 'csv', 'json']);
  const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'pdf']);
  const MEDIA_EXTS = new Set(['mp4', 'webm', 'ogv', 'm4v', 'mkv', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
  const MD_EXTS = new Set(['md', 'markdown']);
  const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx']); // Office 新格式：只读预览（二进制解析交给渲染器）
  const OFFICE_OLD_EXTS = new Set(['doc', 'xls', 'ppt']); // 老版二进制格式：前端无法解析

  // 最近打开记录（快速打开面板用）
  const RECENT_KEY = 'myide-recent';
  function recordRecent(path) {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      const rest = list.filter((x) => x.path !== path);
      rest.unshift({ path, ts: Date.now() });
      localStorage.setItem(RECENT_KEY, JSON.stringify(rest.slice(0, 10)));
    } catch {}
  }
  function recentFiles() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
  }

  function openFile(path, options = {}) {return navigateTo({path},options);}
  async function navigateTo(location,options={}) {
    if(location.hit)return navigateToHit(location.hit,options);
    if(location.saved)return restoreLocation(location.saved,options.isCurrent,options.origin,options.source);
    const path=location.path;
    if(options.history===false)return openFileRaw(path,options);
    const ticket=NavigationHistory.begin();
    if(location.line!=null&&(currentTab()?.id!==location.documentId||currentTab()?.editRevision!==location.revision))return {ok:false,error:'章节所属文档已变化，请重新打开大纲'};
    await openFileRaw(path,options);
    const tab=currentTab();if(tab?.mode==null&&tab.loadPromise)await tab.loadPromise;
    if(DocumentPaths.key(tab?.path)!==DocumentPaths.key(path))return {ok:false,error:'目标文档已变化'};
    if(location.line!=null){
      const fail=error=>{NavigationHistory.failed(ticket,error);MI.toast(error,'err');return {ok:false,error};};
      if(tab.id!==location.documentId||tab.editRevision!==location.revision)return fail('章节所属文档已变化，请重新打开大纲');
      if(cmApi?.__tab===tab&&cmApi.view?.dom.isConnected){
        if(!Number.isSafeInteger(location.line)||location.line<1||location.line>cmApi.view.state.doc.lines)return fail('原章节位置已过期');
        const from=cmApi.view.state.doc.line(location.line).from;cmApi.view.dispatch({selection:{anchor:from},scrollIntoView:true});cmApi.focus();
      }else{
        const md=tab.mode==='split'?viewer.querySelector('.md-split-preview .md-view'):viewer.querySelector('.md-view'),target=md?.querySelectorAll('h1,h2,h3,h4,h5,h6')[location.headingIndex];
        if(!target)return fail('当前视图无法定位原章节');
        target.scrollIntoView?.({block:'center'});target.style.outline='2px solid var(--accent)';setTimeout(()=>{target.style.outline='';},1500);
      }
    }
    NavigationHistory.finish(ticket,captureLocation());return tab?.error?{ok:false,error:tab.error}:{ok:true};
  }
  async function openFileRaw(path, options = {}) {
    if(pathBusy(path)){MI.toast('路径迁移正在进行，请完成后再打开', 'err');return;}
    // 占据主区的工具窗口（浏览器 / 任务依赖图）会盖住编辑区：打开文件先让位（PyCharm 式）
    // 注意只限真正挡编辑区的工具：log 是底部停靠不挡，db 是既有行为不动
    if (window.App) {
      const tool = App.getTool();
      if (tool === 'browser' || (tool === 'tasks' && window.Tasks && Tasks.view === 'dag')) App.backToEditor();
    }
    recordRecent(path);
    const name = path.split(/[\\/]/).pop();
    const i = tabs.findIndex((t) => DocumentPaths.key(t.path) === DocumentPaths.key(path));
    if (i >= 0) {
      if(options.focusRequest)navigationFocus.set(tabs[i].id,options.focusRequest);
      activate(i,{history:false});
      // 已打开的标签也要同步树高亮（否则高亮不切换）
      if (window.Tree) Tree.reveal(path);
      return;
    }
    const tab = { id: ++nextTabId, editRevision: 0, savedRevision: 0, path, name, dirty: false, content: null, mode: null, error: null, tooLarge: false, binary: false, encoding: 'utf8' };
    if(options.focusRequest)navigationFocus.set(tab.id,options.focusRequest);
    tabs.push(tab);
    renderTabs();
    activate(tabs.length - 1,{history:false});
    // 树定位（打开文件后展开目录链并高亮）
    if (window.Tree) Tree.reveal(path);
    tab.loadPromise = MI.perf('viewer.openFile ' + name, () => loadTab(tab), 500);
    await tab.loadPromise;
  }

  async function loadTab(tab) {
    // 图片 / 音视频 / Office 新格式：二进制无需读取文本，直接走预览渲染器
    if (IMG_EXTS.has(extOf(tab.name)) || MEDIA_EXTS.has(extOf(tab.name)) || OFFICE_EXTS.has(extOf(tab.name))) {
      tab.content = '';
      tab.mode = 'preview';
      renderTabs();
      if(tab===currentTab())renderView();
      return;
    }
    // 老版 Office（.doc/.xls/.ppt）：前端无法解析 → 错误视图 + 系统默认程序打开
    if (OFFICE_OLD_EXTS.has(extOf(tab.name))) {
      tab.content = '';
      tab.binary = true;
      tab.officeOld = true;
      tab.mode = 'error';
      renderTabs();
      if(tab===currentTab())renderView();
      return;
    }
    const readPath = tab.path, generation = tab.pathGeneration || 0;
    let r;
    try { r = await window.myIDE.fs.readFile(readPath); }
    catch(e) { r={error:String(e?.message||e||'读取文件失败')}; }
    if (!tabs.includes(tab)) return;
    if (tab.path !== readPath || (tab.pathGeneration || 0) !== generation) return tab.mode == null ? loadTab(tab) : undefined;
    if (r.error) { tab.error = r.error; tab.mode = 'error'; }
    else if (r.tooLarge) { tab.tooLarge = true; tab.mode = 'error'; }
    else if (r.binary) { tab.binary = true; tab.mode = 'error'; }
    else {
      tab.content = r.content;
      tab.diskVersion = r.version;
      tab.encoding = r.encoding || 'utf8';
      tab.textFormat = r.textFormat || { encoding: tab.encoding, bom: tab.encoding.startsWith('utf16') };
      tab.eol = r.textFormat ? r.textFormat.eol : r.content && r.content.includes('\r\n') ? 'CRLF' : null;
      // Markdown 默认「实时预览」（Obsidian 式块编辑）；其他可预览格式走纯预览
      if (MD_EXTS.has(extOf(tab.name))) {
        // 模式全局统一：记住上次使用的 md 模式，切换标签/新开文件不再重置
        let pref = 'live';
        try { pref = localStorage.getItem('myide-md-mode') || 'live'; } catch {}
        tab.mode = ['live', 'split', 'source', 'preview'].includes(pref) ? pref : 'live';
      } else {
        tab.mode = PREVIEW_EXTS.has(extOf(tab.name)) ? 'preview' : 'edit';
      }
    }
    renderTabs();
    if(tab===currentTab())renderView();
  }

  function activate(i,options={}) {
    if(options.history===false)return activateRaw(i);
    const ticket=NavigationHistory.begin(),target=tabs[i];activateRaw(i);
    if(target?.mode==null&&target.loadPromise)return target.loadPromise.then(()=>{if(currentTab()===target)NavigationHistory.finish(ticket,captureLocation());});
    NavigationHistory.finish(ticket,captureLocation());
  }
  function activateRaw(i) {
    const target = tabs[i];
    if (!target) return;
    activeTabId = target.id;
    focusedTabId=target.id;
    renderTabs();
    renderView();
    revealTab(target.id);
    // 通知 AI 面板「当前在看哪个文件」：面板据此自动把这份文档带进上下文
    try { if (window.AiPanel && AiPanel.followActive) AiPanel.followActive(); } catch {}
    // 会话恢复的浏览位置：编辑器渲染完成后跳到上次光标行
    const t = target;
    if (t && t.lazy) {
      // 懒恢复标签首次切入才读盘（会话恢复只登记，切换项目不再逐个打开全部文件）
      t.lazy = false;
      t.loadPromise = loadTab(t).then(() => {
        if (t === currentTab() && t.restoreLine) { revealLine(t.restoreLine); delete t.restoreLine; } // 编辑器就绪后再跳行
      });
      return; // 内容未载入（renderView 对 mode=null 直接返回）→ 常规跳行等加载完成
    }
    if (t && t.restoreLine) { revealLine(t.restoreLine); delete t.restoreLine; }
  }

  // 会话懒恢复：只登记标签条（不读盘不建编辑器），激活时才真正加载。
  // 切换项目恢复会话用：旧实现逐个 openFile（读盘+建编辑器），标签多时切换卡数秒
  function addLazyTab(path, opts) {
    if(pathBusy(path))return;
    if (tabs.some((t) => DocumentPaths.key(t.path) === DocumentPaths.key(path))) return;
    const name = path.split(/[\\/]/).pop();
    const tab = { id: ++nextTabId, editRevision: 0, savedRevision: 0, path, name, dirty: false, content: null, mode: null, error: null, tooLarge: false, binary: false, encoding: 'utf8', lazy: true };
    if (opts && opts.scrollTop) tab.scrollTop = opts.scrollTop;
    if (opts && opts.line) tab.restoreLine = opts.line;
    tabs.push(tab);
    renderTabs();
  }

  // 当前活动编辑器滚动到指定行（会话恢复用）
  function revealLine(n) {
    try {
      if (cmApi && cmApi.gotoLine) cmApi.gotoLine(n);
    } catch {}
  }

  // 搜索定位不猜预览DOM列，也不借旧CM操作新标签；调用方取消/换项目会使整个导航失效。
  async function navigateToHit(hit, options = {}) {
    const history=NavigationHistory.begin();
    const root=window.App?.root,focusRequest={isCurrent:options.isCurrent||(()=>true),focusTarget:options.focusTarget};
    const valid=()=>focusRequest.isCurrent()&&DocumentPaths.key(root)===DocumentPaths.key(window.App?.root);
    const reject=(error,errorCode)=>({ok:false,error,errorCode});
    try {
      if(!valid())return {stale:true};
      if(!hit||!DocumentPaths.contains(root,hit.path)||!SearchModel.sameVersion(hit.version,hit.version))return reject('搜索位置不属于当前项目或没有有效版本','INVALID_LOCATION');
      const version=await window.myIDE.fs.fileVersion(hit.path);if(!valid())return {stale:true};
      if(version.error||!SearchModel.sameVersion(version.version,hit.version))return reject(version.error||'文件已改变，请重新搜索','VERSION_CONFLICT');
      const prior=tabs.find(tab=>DocumentPaths.key(tab.path)===DocumentPaths.key(hit.path));
      if(prior?.dirty)return reject('目标文件有未保存的输入，磁盘搜索位置已过期','DIRTY_DOCUMENT');
      await openFile(hit.path,{focusRequest,history:false});if(!valid())return {stale:true};
      const tab=currentTab();if(DocumentPaths.key(tab?.path)!==DocumentPaths.key(hit.path))return reject('目标文件没有成功打开','NO_DOCUMENT');
      if(tab.loadPromise&&tab.mode==null)await tab.loadPromise;if(!valid()||currentTab()!==tab)return {stale:true};
      if(tab.error||tab.mode==null||tab.content==null)return reject(tab.error||'目标文件没有成功打开','READ_FAILED');
      if(tab.dirty||!SearchModel.sameVersion(tab.diskVersion,hit.version)||tab.encoding!==hit.encoding||tab.content.slice(hit.startOffset,hit.endOffset)!==hit.match)
        return reject('当前文档与搜索版本不一致，请重新搜索','VERSION_CONFLICT');
      if(options.allowSource&&tab.mode==='preview'&&!tab.binary&&!tab.tooLarge){
        tab.mode=MD_EXTS.has(extOf(tab.name))?'source':'edit';navigationFocus.set(tab.id,focusRequest);renderView();
      }
      const cm=cmApi;
      if(cm?.__tab===tab&&cm.view?.dom.isConnected&&typeof cm.setCursor==='function'){
        if(hit.line>cm.view.state.doc.lines)return reject('文本位置已变化，请重新搜索','POSITION_CHANGED');
        const line=cm.view.state.doc.line(hit.line),from=line.from+hit.startColumn-1,to=line.from+hit.endColumn-1;
        if(to>line.to||cm.view.state.doc.sliceString(from,to)!==hit.match)return reject('文本位置已变化，请重新搜索','POSITION_CHANGED');
        cm.view.dispatch({selection:{anchor:from,head:to},scrollIntoView:true});
        NavigationHistory.finish(history,captureLocation());
        return {ok:true,focus:()=>{if(currentTab()===tab&&cmApi===cm&&cm.view.dom.isConnected)cm.focus();}};
      }
      const ta=tab.ta;
      if(ta?.isConnected&&viewer.contains(ta)){
        const lines=ta.value.split('\n'),line=lines[hit.line-1],from=lines.slice(0,hit.line-1).reduce((n,line)=>n+line.length+1,0)+hit.startColumn-1,to=from+hit.match.length;
        if(line==null||hit.endColumn-1>line.length||ta.value.slice(from,to)!==hit.match)return reject('文本位置已变化，请重新搜索','POSITION_CHANGED');
        ta.setSelectionRange(from,to);const height=parseFloat(getComputedStyle(ta).lineHeight)||parseFloat(getComputedStyle(ta).fontSize)*1.5;
        ta.scrollTop=Math.max(0,(hit.line-1)*height-ta.clientHeight/2);
        NavigationHistory.finish(history,captureLocation());
        return {ok:true,focus:()=>{if(currentTab()===tab&&tab.ta===ta&&ta.isConnected)ta.focus();}};
      }
      return reject('当前视图不支持精确文本定位，可选择以源码定位','UNSUPPORTED_VIEW');
    }catch(error){return valid()?reject(String(error?.message||error),'NAVIGATION_FAILED'):{stale:true};}
    finally{for(const [id,request] of navigationFocus)if(request===focusRequest)navigationFocus.delete(id);}
  }

  function locationScrollers(tab=currentTab()) {
    if(!tab||tab!==currentTab())return {};
    const primary=cmApi?.__tab===tab?cmApi.view.scrollDOM:tab.ta?.isConnected?tab.ta:viewer.querySelector('.md-view')||viewer.firstElementChild;
    const preview=tab.mode==='split'?viewer.querySelector('.md-split-preview'):null;
    return {primary,preview};
  }
  function captureLocation() {
    const tab=currentTab(),root=window.App?.root;
    if(!tab||!root||!DocumentPaths.contains(root,tab.path)||tab.mode==null||tab.mode==='error'||tab.error)return null;
    let selection=null;
    if(cmApi?.__tab===tab&&cmApi.view?.dom.isConnected){
      const current=cmApi.view.state.selection;if(current.ranges.length>64)return null;
      selection={ranges:current.ranges.map(range=>({anchor:range.anchor,head:range.head})),mainIndex:current.mainIndex};
    }else if(tab.ta?.isConnected)selection={ranges:[{anchor:tab.ta.selectionDirection==='backward'?tab.ta.selectionEnd:tab.ta.selectionStart,head:tab.ta.selectionDirection==='backward'?tab.ta.selectionStart:tab.ta.selectionEnd}],mainIndex:0};
    const {primary,preview}=locationScrollers(tab);let anchor=null;
    if(cmApi?.__tab===tab&&cmApi.view.dom.isConnected){try{const block=cmApi.view.lineBlockAtHeight(primary.scrollTop);anchor={offset:block.from,delta:primary.scrollTop-block.top};}catch{}}
    return {root,documentId:tab.id,path:tab.path,pathGeneration:tab.pathGeneration||0,revision:tab.editRevision,version:tab.diskVersion||null,dirty:tab.dirty,mode:tab.mode,selection,
      scroll:{top:primary?.scrollTop||0,left:primary?.scrollLeft||0,anchor,previewTop:preview?.scrollTop||0,previewLeft:preview?.scrollLeft||0}};
  }
  async function restoreLocation(location,isCurrent,origin,source) {
    const fail=error=>({ok:false,error}),same=SearchModel.sameVersion;
    if(location.invalid)return fail(location.invalid);
    if(!DocumentPaths.contains(App.root,location.path)||DocumentPaths.key(App.root)!==DocumentPaths.key(location.root))return fail('原位置不属于当前项目');
    if(pathBusy(location.path))return fail('路径迁移正在进行，请完成后再返回或前进');
    const sourceValid=()=>{const current=captureLocation();return isCurrent()&&!!current&&!!source&&current.documentId===source.documentId&&current.revision===source.revision
      &&current.pathGeneration===source.pathGeneration&&current.mode===source.mode&&JSON.stringify(current.selection)===JSON.stringify(source.selection)
      &&(document.activeElement===origin||document.activeElement===document.body);};
    const version=await window.myIDE.fs.fileVersion(location.path);
    if(!sourceValid())return fail('当前位置已变化，导航未执行');
    if(version.error||version.absent||version.version?.absent)return fail(version.error||'原文件已删除，请重新选择文件');
    if(location.version&&!same(version.version,location.version))return fail('原文件已变化，位置已过期；请重新搜索或选择位置');
    let tab=tabs.find(tab=>tab.id===location.documentId);
    if(tab&&DocumentPaths.key(tab.path)!==DocumentPaths.key(location.path))return fail('原文档路径已变化，请重新选择位置');
    tab ||= tabs.find(tab=>DocumentPaths.key(tab.path)===DocumentPaths.key(location.path));
    if(location.dirty&&(!tab||tab.id!==location.documentId))return fail('原位置含未保存的输入，原标签已经关闭');
    if(tab&&tab.id===location.documentId&&tab.editRevision!==location.revision)return fail('原文档内容已变化，位置已过期');
    if(!tab){addLazyTab(location.path);tab=tabs.find(tab=>DocumentPaths.key(tab.path)===DocumentPaths.key(location.path));}
    if(!tab)return fail('原文件没有成功打开');
    if(tab.mode==='error'&&!tab.dirty&&!tab.binary&&!tab.tooLarge){tab.error=null;tab.mode=null;tab.loadPromise=null;}
    if(tab.mode==null){tab.lazy=false;tab.loadPromise ||= loadTab(tab);await tab.loadPromise;}
    if(!sourceValid())return fail('当前位置已变化，导航未执行');
    if(tab.error||tab.mode==null||tab.mode==='error')return fail(tab.error||'原文件没有成功打开');
    if(location.version&&!same(tab.diskVersion,location.version)||tab.id===location.documentId&&tab.editRevision!==location.revision)
      return fail('原文档与位置记录不一致，请重新选择位置');
    if(tab.dirty&&tab.id!==location.documentId)return fail('当前同名标签有未保存的输入，原位置已过期');
    const text=String(tab.content||'').replace(/\r\n?|\n/g,'\n'),ranges=location.selection?.ranges;
    if(ranges?.some(range=>!Number.isSafeInteger(range.anchor)||!Number.isSafeInteger(range.head)||range.anchor<0||range.head<0||range.anchor>text.length||range.head>text.length))return fail('原文本位置已过期');
    const markdown=/\.(md|markdown)$/i.test(tab.name),needsCm=['live','source'].includes(location.mode)||['edit','split'].includes(location.mode)&&!markdown;
    if(ranges&&(!['live','source','edit','split'].includes(location.mode)||needsCm&&(!window.CM6||!(markdown?window.MdEditor:window.CodeEditor))))return fail('当前视图无法恢复文本选区');
    const focusRequest={isCurrent,focusTarget:origin?.closest?.('#panel-search')?origin:null};navigationFocus.set(tab.id,focusRequest);
    try{
      if(['live','source','split','edit','preview'].includes(location.mode))tab.mode=location.mode;
      activate(tabs.indexOf(tab),{history:false});
      const cm=cmApi?.__tab===tab?cmApi:null,ta=tab.ta;
      if(ranges){
        if(cm?.view?.dom.isConnected)cm.view.dispatch({selection:CM6.State.EditorSelection.create(ranges.map(range=>CM6.State.EditorSelection.range(range.anchor,range.head)),location.selection.mainIndex)});
        else if(ta?.isConnected){const range=ranges[0];ta.setSelectionRange(Math.min(range.anchor,range.head),Math.max(range.anchor,range.head),range.anchor>range.head?'backward':'forward');}
        else return fail('当前视图无法恢复文本选区');
      }
      const restoredRevision=tab.editRevision;
      const applyScroll=()=>{if(!isCurrent()||currentTab()!==tab||tab.editRevision!==restoredRevision)return;const {primary,preview}=locationScrollers(tab);
        let top=location.scroll.top;if(location.scroll.anchor&&cm?.view.dom.isConnected){try{top=cm.view.lineBlockAt(location.scroll.anchor.offset).top+location.scroll.anchor.delta;}catch{}}
        if(primary){primary.scrollTop=top;primary.scrollLeft=location.scroll.left;}if(preview){preview.scrollTop=location.scroll.previewTop;preview.scrollLeft=location.scroll.previewLeft;}tab.scrollTop=top;};
      applyScroll();
      // CM挂载后的测量会重新约束滚动范围；等实际布局再恢复，而不是只写一个尚无高度的DOM。
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{applyScroll();resolve();})));
      if(!isCurrent()||currentTab()!==tab)return {stale:true};
      return {ok:true,focus:()=>{if(!isCurrent()||currentTab()!==tab||tab.editRevision!==restoredRevision||document.activeElement!==origin&&document.activeElement!==document.body)return;if(focusRequest.focusTarget?.isConnected)focusRequest.focusTarget.focus({preventScroll:true});else if(cm===cmApi&&cm?.view.dom.isConnected)cm.focus();else if(ta?.isConnected)ta.focus({preventScroll:true});else{viewer.tabIndex=-1;viewer.focus({preventScroll:true});}}};
    }finally{if(navigationFocus.get(tab.id)===focusRequest)navigationFocus.delete(tab.id);}
  }
  function mapTextChange(before,after) {
    before=String(before||'').replace(/\r\n?|\n/g,'\n');after=String(after||'').replace(/\r\n?|\n/g,'\n');
    let from=0,oldTo=before.length,newTo=after.length;while(from<oldTo&&from<newTo&&before[from]===after[from])from++;
    while(oldTo>from&&newTo>from&&before[oldTo-1]===after[newTo-1]){oldTo--;newTo--;}
    return (position,assoc)=>position<from?position:position>oldTo?position+newTo-oldTo:position===from&&assoc<0?from:newTo;
  }
  function scheduleEditorFocus(api,tab) {
    const request=navigationFocus.get(tab.id),origin=document.activeElement;
    setTimeout(()=>{
      if(cmApi!==api||currentTab()!==tab||!api.view?.dom.isConnected)return;
      if(request){if(request.isCurrent()&&request.focusTarget?.isConnected&&(document.activeElement===origin||document.activeElement===document.body))request.focusTarget.focus({preventScroll:true});return;}
      // 挂载后用户已经转到别处输入，迟到focus不得再抢回编辑器。
      if(document.activeElement===origin||document.activeElement===document.body)api.focus();
    },0);
  }

  const closePending = new Set();
  const closeDecisions = new Set();
  function closeTab(i) { return requestClose(tabs[i] ? [tabs[i]] : []); }
  async function requestClose(candidates) {
    const selected = [...new Set(candidates)].filter(t => tabs.includes(t));
    if (!selected.length || selected.some(t => closePending.has(t.id))) return false;
    const root = MI.activeRoot;
    const snapshots = selected.map(t => ({ t, path: t.path, generation: t.pathGeneration || 0, revision: t.editRevision, content: t.content }));
    const valid = () => MI.activeRoot === root && snapshots.every(s => tabs.includes(s.t) && s.t.path === s.path
      && (s.t.pathGeneration || 0) === s.generation && s.t.editRevision === s.revision && s.t.content === s.content);
    selected.forEach(t => closePending.add(t.id));
    try {
      const dirty = selected.filter(t => t.dirty);
      let choice = 'discard';
      if (dirty.length) {
        choice = await chooseClose(dirty);
      }
      if (choice === 'cancel') return false;
      if (!valid()) { MI.toast('文档或项目已变化，标签已保留，请重新关闭', 'err'); return false; }
      if (choice === 'save') {
        const results = await Promise.all(dirty.map(t => saveSnapshot(t, true)));
        if (results.some(r => !r.ok) || dirty.some(t => t.dirty)) {
          MI.toast('部分文件未保存，所有标签已保留：' + dirty.filter((t,i) => !results[i].ok || t.dirty).map(t => t.name).join('、'), 'err');
          return false;
        }
      }
      // 已派发的保存不能随标签消失；等待结束后还要拒绝确认/保存期间新增的输入。
      const pending=selected.map(t => saveQueues.get(DocumentPaths.key(t.path))).filter(Boolean);
      if(pending.length)await Promise.all(pending);
      if (!valid()) { MI.toast('关闭等待期间文档已变化，所有标签已保留', 'err'); return false; }
      commitClose(selected);
      return true;
    } catch (e) {
      MI.toast('关闭未完成，标签已保留：' + String(e?.message || e), 'err'); return false;
    } finally { selected.forEach(t => closePending.delete(t.id)); }
  }
  function chooseClose(dirty) {
    return new Promise(resolve => {
      const box=document.createElement('div');box.dataset.selfEsc='1';box.className='close-tabs-dialog';
      box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-label','关闭标签');
      box.innerHTML='<div class="m-head">关闭标签</div><div class="m-body"><p>以下文件有未保存的修改。取消会保留全部标签。</p><ul class="close-tabs-list"></ul></div>'
        +'<div class="m-foot"><button class="tb-btn m-cancel">取消</button><button class="tb-btn close-tabs-discard">放弃并关闭</button><button class="tb-btn m-ok close-tabs-save">保存并关闭</button></div>';
      for(const t of dirty){const li=document.createElement('li');li.textContent=t.path;box.querySelector('ul').appendChild(li);}
      const origin=document.activeElement;let settled=false;
      const cancel=()=>finish('cancel',true);
      const finish=(choice,force=false)=>{
        if(settled||!force&&Modal.stack.at(-1)!==box)return;
        settled=true;closeDecisions.delete(cancel);
        const i=Modal.stack.indexOf(box);if(i>=0)Modal.stack.splice(i,1);box.remove();
        if(!Modal.stack.length)document.getElementById('modal-mask').classList.add('hidden');
        if(!force&&origin?.isConnected)origin.focus();resolve(choice);
      };
      box.querySelector('.m-cancel').onclick=()=>finish('cancel');box.querySelector('.close-tabs-discard').onclick=()=>finish('discard');box.querySelector('.close-tabs-save').onclick=()=>finish('save');
      box.addEventListener('keydown',e=>{
        if(e.isComposing||e.keyCode===229||Modal.stack.at(-1)!==box)return;
        if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finish('cancel');}
        if(e.key==='Tab'){const controls=[...box.querySelectorAll('button')],i=controls.indexOf(document.activeElement);if(e.shiftKey&&i<=0||!e.shiftKey&&i===controls.length-1){e.preventDefault();controls[e.shiftKey?controls.length-1:0].focus();}}
      });
      closeDecisions.add(cancel);Modal.show(box);box.querySelector('.m-cancel').focus();
    });
  }
  // 强制关闭全部标签（切换项目用，调用方负责 dirty 确认）
  function closeAll() {
    window.TabPicker?.invalidate();
    clearTimeout(autosaveTimer);
    for(const cancel of [...closeDecisions])cancel();
    tabs.length = 0;
    activeTabId = null;
    empty.classList.add('visible');
    renderTabs();
    renderView();
  }
  function doClose(i) {
    if(tabs[i])commitClose([tabs[i]]);
  }
  function commitClose(selected) {
    const before=[...tabs], current=currentTab(), at=before.indexOf(current), removed=new Set(selected);
    const origin=document.activeElement;
    const fromTabs=!!origin?.closest?.('#tab-scroll');
    const successor=removed.has(current) ? before.slice(at+1).find(t=>!removed.has(t)) || before.slice(0,at).reverse().find(t=>!removed.has(t)) : current;
    for(let i=tabs.length-1;i>=0;i--)if(removed.has(tabs[i]))tabs.splice(i,1);
    activeTabId=successor?.id ?? null;
    renderTabs();
    if(current!==currentTab()){
      if(successor)activate(tabs.indexOf(successor),{history:false});else{renderView();document.getElementById('btn-open')?.focus();}
    }else if(origin&&!origin.isConnected&&!fromTabs){cmApi?.focus?.();currentTab()?.ta?.focus();}
    if(fromTabs&&tabs.length)focusTab(successor?.id);
  }

  // 标签页上的文件类型图标（小尺寸用线条 SVG，比 emoji 尺寸稳定）
  const FT_IC = {
    md: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.6"/><path d="M4.8 10.4V6.2l1.8 2.2 1.8-2.2v4.2M10.6 6.2v4.2h1.4"/></svg>',
    code: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.6 4.6L2.4 8l3.2 3.4M10.4 4.6L13.6 8l-3.2 3.4"/></svg>',
    json: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 2.6c-1.4 0-1.8.7-1.8 1.6v1.7c0 .9-.5 1.3-1.3 1.5.8.2 1.3.6 1.3 1.5v1.7c0 .9.4 1.6 1.8 1.6M9.8 2.6c1.4 0 1.8.7 1.8 1.6v1.7c0 .9.5 1.3 1.3 1.5-.8.2-1.3.6-1.3 1.5v1.7c0 .9-.4 1.6-1.8 1.6"/></svg>',
    img: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.5"/><circle cx="5.8" cy="6.4" r="1.1"/><path d="M3 11.4l3.2-3 2.4 2.2 1.8-1.6 2.4 2.4"/></svg>',
    csv: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.4" y="3" width="11.2" height="10" rx="1.4"/><path d="M2.4 6.4h11.2M6.6 6.4V13"/></svg>',
    file: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 2.3h4.1l3 3v8.4H4.4z"/><path d="M8.5 2.3v3h3"/></svg>',
  };
  function ftIcon(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (['md', 'markdown'].includes(ext)) return FT_IC.md;
    if (ext === 'json') return FT_IC.json;
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return FT_IC.img;
    if (['csv', 'xlsx', 'xls'].includes(ext)) return FT_IC.csv;
    if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'css', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'sh'].includes(ext)) return FT_IC.code;
    return FT_IC.file;
  }

  // 编辑器工具条图标（内联 SVG）。
  // 原来用 '⧉' '◉' '⌖' 这类字符 —— Windows 默认字体没有这些字形，fallback 之后
  // 会变成完全不相干的符号（用户看到的「+ 定位」就是 '⌖' 掉字形后的样子）。
  const ACT_IC = {
    copy: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.6" y="5.6" width="8" height="8" rx="1.3"/><path d="M10.4 5.6V3.5a1.3 1.3 0 0 0-1.3-1.3H3.5A1.3 1.3 0 0 0 2.2 3.5v5.6a1.3 1.3 0 0 0 1.3 1.3h1.7"/></svg>',
    eye: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.7 8s2.4-4.2 6.3-4.2S14.3 8 14.3 8s-2.4 4.2-6.3 4.2S1.7 8 1.7 8z"/><circle cx="8" cy="8" r="1.9"/></svg>',
    code: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.6 4.4L2.2 8l3.4 3.6M10.4 4.4L13.8 8l-3.4 3.6"/></svg>',
    edit: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 2.6l2.2 2.2-7 7-2.6.4.4-2.6z"/><path d="M9.6 4.2l2.2 2.2"/></svg>',
    split: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.2"/><path d="M8 3.2v9.6"/></svg>',
    globe: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M2.6 8h10.8"/><path d="M8 2.4c1.5 1.6 2.3 3.5 2.3 5.6S9.5 12 8 13.6C6.5 12 5.7 10.1 5.7 8s.8-4 2.3-5.6z"/></svg>',
    external: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.4 2.6h4v4"/><path d="M13.4 2.6L7.6 8.4"/><path d="M12.2 9.6v3.2a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V5.2a1 1 0 0 1 1-1h3.2"/></svg>',
    locate: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.4 5.4V3.8a1.4 1.4 0 0 1 1.4-1.4h1.6M13.6 5.4V3.8a1.4 1.4 0 0 0-1.4-1.4h-1.6M2.4 10.6v1.6a1.4 1.4 0 0 0 1.4 1.4h1.6M13.6 10.6v1.6a1.4 1.4 0 0 1-1.4 1.4h-1.6"/><circle cx="8" cy="8" r="1.7"/></svg>',
  };

  // 编辑器操作区（Markdown 模式切换 / 查看源码 / 内置浏览器）+「定位」—— 统一挂在标签栏右端。
  // ⚠ 必须跟 renderTabs() 同生命周期：标签栏这一片会被 renderTabs 清空，
  //   而「标脏点」等路径只调 renderTabs 不调 renderView —— 挂在 renderView 里会被清掉
  //   （症状：右端按钮"有时有一个有时没有"，之前踩过）。
  function renderTabActions() {
    tabActions.innerHTML = '';
    const tab = currentTab();
    if (!tab) return;
    const acts = document.createElement('div');
    acts.className = 'ed-actions';
    if (tab.saveError) {
      const recover = document.createElement('button'); recover.className = 'tb-btn save-recovery-button';
      recover.textContent = tab.saveErrorCode === 'VERSION_CONFLICT' ? '保存冲突' : '保存失败';
      recover.title = '查看磁盘版本、另存副本或明确覆盖'; recover.onclick = () => showSaveRecovery(tab);
      acts.appendChild(recover);
    }

    const isMarkdown = /\.(md|markdown)$/i.test(tab.name);
    const ext = extOf(tab.name);

    // Markdown：模式切换（实时预览 / 分屏 / 源码 / 预览）
    if (isMarkdown && !tab.binary && !tab.tooLarge) {
      const seg = document.createElement('div');
      seg.className = 'md-mode-seg';
      const MODES = [
        ['live', ACT_IC.edit, '实时预览', 'Obsidian 式：点击文字直接编辑，其余实时渲染'],
        ['split', ACT_IC.split, '分屏', '左侧源码 + 右侧实时预览'],
        ['source', ACT_IC.code, '源码', '纯 Markdown 源码编辑'],
        ['preview', ACT_IC.eye, '预览', '只读渲染视图'],
      ];
      const cur = ['live', 'split', 'source', 'preview'].includes(tab.mode) ? tab.mode : 'live';
      for (const [m, ic, label, tip] of MODES) {
        const b = document.createElement('button');
        b.className = 'vt-btn' + (cur === m ? ' active' : '');
        b.innerHTML = ic + label;
        b.title = tip;
        b.onclick = (e) => {
          e.stopPropagation();
          if (tab.mode !== m) {
            tab.mode = m;
            // 模式全局统一：写入偏好，之后打开/切换其他 md 也保持该模式
            try { localStorage.setItem('myide-md-mode', m); } catch {}
            renderView();
          }
        };
        seg.appendChild(b);
      }
      acts.appendChild(seg);
    } else if (PREVIEW_EXTS.has(ext) && tab.mode === 'preview') {
      const btnToggle = document.createElement('button');
      btnToggle.className = 'vt-btn';
      btnToggle.innerHTML = ACT_IC.code + '查看源码';
      btnToggle.title = '以源码方式编辑';
      btnToggle.onclick = (e) => { e.stopPropagation(); tab.mode = 'edit'; renderView(); };
      acts.appendChild(btnToggle);
    } else if (PREVIEW_EXTS.has(ext) && tab.mode === 'edit' && !tab.binary && !tab.tooLarge) {
      // 查看源码后提供恢复入口：切回预览模式
      const btnBack = document.createElement('button');
      btnBack.className = 'vt-btn';
      btnBack.innerHTML = ACT_IC.eye + '预览';
      btnBack.title = '切回预览渲染';
      btnBack.onclick = (e) => { e.stopPropagation(); tab.mode = 'preview'; renderView(); };
      acts.appendChild(btnBack);
    }

    // HTML：内置浏览器 / 系统默认浏览器打开
    if (/\.(html|htm)$/i.test(tab.name)) {
      const fileUrl = 'file:///' + tab.path.split('\\').join('/');
      const btnInner = document.createElement('button');
      btnInner.className = 'vt-btn';
      btnInner.innerHTML = ACT_IC.globe + '内置浏览器';
      btnInner.title = '在 IDE 内置浏览器中打开该页面';
      btnInner.onclick = (e) => { e.stopPropagation(); if (window.BrowserPanel) BrowserPanel.open(fileUrl); };
      acts.appendChild(btnInner);

      const btnBrowser = document.createElement('button');
      btnBrowser.className = 'vt-btn';
      btnBrowser.innerHTML = ACT_IC.external + '浏览器打开';
      btnBrowser.title = '用系统默认浏览器打开该页面';
      btnBrowser.onclick = (e) => { e.stopPropagation(); try { window.myIDE.shell.openExternal(fileUrl); } catch {} };
      acts.appendChild(btnBrowser);
    }

    // Office（新旧格式）：系统默认程序打开（预览保真度有限时的兜底出口）
    if (OFFICE_EXTS.has(ext) || OFFICE_OLD_EXTS.has(ext)) {
      const btnOffice = document.createElement('button');
      btnOffice.className = 'vt-btn';
      btnOffice.innerHTML = ACT_IC.external + '系统打开';
      btnOffice.title = '用系统默认程序打开该文件';
      btnOffice.onclick = (e) => { e.stopPropagation(); try { window.myIDE.shell.openExternal('file:///' + tab.path.split('\\').join('/')); } catch {} };
      acts.appendChild(btnOffice);
    }

    if (acts.children.length) tabActions.appendChild(acts);

    // 「定位」属于文件操作，跟标签放一起最顺手；常驻最右端
    const loc = document.createElement('button');
    loc.className = 'tab-locate';
    loc.innerHTML = ACT_IC.locate;
    loc.title = '在资源管理器中显示：' + tab.path;
    loc.onclick = (e) => { e.stopPropagation(); window.myIDE.shell.showInFolder(tab.path); };
    tabActions.appendChild(loc);
  }

  function focusEditor(){
    if(cmApi?.__tab===currentTab()&&cmApi.view?.dom.isConnected)cmApi.focus();
    else if(currentTab()?.ta?.isConnected)currentTab().ta.focus({preventScroll:true});
    else viewer.focus({preventScroll:true});
  }
  function tabButton(id){return tabScroll.querySelector('[role="tab"][data-tab-id="'+Number(id)+'"]');}
  function revealTab(id){
    const row=tabButton(id)?.closest('.tab');if(!row)return;
    const viewport=tabScroll.getBoundingClientRect(),rect=row.getBoundingClientRect(),all=tabScroll.querySelector('.tab-all')?.getBoundingClientRect();if(!viewport.width)return;
    // sticky“全部标签”会盖住滚动区右缘；DOM的nearest并不知道那一块不能展示名字。
    const right=viewport.right-(all?.width||0);
    if(rect.left<viewport.left)tabScroll.scrollLeft+=rect.left-viewport.left;else if(rect.right>right)tabScroll.scrollLeft+=rect.right-right;
  }
  function focusTab(id=activeTabId){
    const target=tabs.find(tab=>tab.id===Number(id))||currentTab()||tabs[0];if(!target)return document.getElementById('btn-open')?.focus();
    focusedTabId=target.id;for(const button of tabScroll.querySelectorAll('[role="tab"]'))button.tabIndex=Number(button.dataset.tabId)===target.id?0:-1;
    const button=tabButton(target.id);button?.focus({preventScroll:true});revealTab(target.id);
  }
  function fitTabLabels(){
    if(!tabScroll.isConnected)return;
    const entries=TabDescriptions.describe(tabs,window.App?.root),label=tabScroll.querySelector('.tab-label'),width=label?.getBoundingClientRect().width||108;
    let context=null;if(!/jsdom/i.test(navigator.userAgent)){try{context=document.createElement('canvas').getContext('2d');}catch{}}
    const measure=(value,font)=>{if(context){context.font=font;return context.measureText(value).width;}return Array.from(value).reduce((sum,char)=>sum+(/[\u0000-\u00ff]/.test(char)?6:12),0);};
    const nameFont=getComputedStyle(tabScroll.querySelector('.tname')||tabScroll).font||'12px sans-serif',pathFont=getComputedStyle(tabScroll.querySelector('.tpath')||tabScroll).font||'10px sans-serif';
    const names=TabDescriptions.compact(entries.map(entry=>entry.name),width,value=>measure(value,nameFont));
    const hints=TabDescriptions.compact(entries.map(entry=>entry.pathHint),width,value=>measure(value,pathFont));
    entries.forEach((entry,i)=>{const row=tabScroll.querySelector('.tab[data-tab-id="'+entry.id+'"]');if(!row)return;
      row.querySelector('.tname').textContent=names[i];const path=row.querySelector('.tpath');if(path)path.textContent=hints[i];});
  }
  if(window.ResizeObserver)new ResizeObserver(fitTabLabels).observe(tabScroll);
  window.addEventListener('resize',fitTabLabels);
  tabScroll.addEventListener('keydown',e=>{
    if(e.isComposing||e.keyCode===229||window.Modal?.stack.length||window.Shortcuts?.isCapturing())return;
    if(e.target.closest('.tclose')&&['Enter',' '].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();e.target.closest('.tclose').click();return;}
    const button=e.target.closest('[role="tab"]');if(!button)return;const tab=tabs.find(tab=>tab.id===Number(button.dataset.tabId));if(!tab)return;
    if(e.shiftKey&&e.key==='F10'){e.preventDefault();e.stopImmediatePropagation();const rect=button.getBoundingClientRect();ctxTabMenu(rect.left,rect.bottom,tab,true);return;}
    if(e.ctrlKey||e.metaKey||e.altKey||e.shiftKey)return;
    if(['Enter',' '].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();activate(tabs.indexOf(tab));}
    else if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();const at=tabs.indexOf(tab);focusTab(e.key==='Home'?tabs[0].id:e.key==='End'?tabs.at(-1).id:tabs[(at+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length].id);}
    else if(e.key==='Tab'){if(!e.shiftKey){e.preventDefault();e.stopImmediatePropagation();focusEditor();}}
    else if(e.key==='Delete'){e.preventDefault();e.stopImmediatePropagation();requestClose([tab]);}
  });
  function renderTabs() {
    cancelDrag(false);
    const oldFocus=document.activeElement,oldTab=oldFocus?.closest?.('.tab'),focusId=Number(oldTab?.dataset.tabId),wasTabFocus=!!oldTab,wasAll=oldFocus?.classList.contains('tab-all');
    const descriptors=TabDescriptions.describe(tabs,window.App?.root);
    tabbar.classList.toggle('disambiguated',descriptors.some(entry=>entry.pathHint));
    if(!tabs.some(tab=>tab.id===focusedTabId))focusedTabId=activeTabId||tabs[0]?.id;
    tabScroll.innerHTML = '';
    tabActions.innerHTML = '';
    tabs.forEach((t, i) => {
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === activeTabId ? ' active' : '');
      const description=descriptors[i],select=document.createElement('button');select.type='button';select.className='tab-select';select.id='file-tab-'+t.id;select.dataset.tabId=String(t.id);select.setAttribute('role','tab');select.setAttribute('aria-controls','viewer');select.setAttribute('aria-selected',String(t.id===activeTabId));select.setAttribute('aria-label',description.name+'，'+description.path+(description.status?'，'+description.status:''));select.tabIndex=t.id===focusedTabId?0:-1;
      select.onfocus=()=>{focusedTabId=t.id;for(const button of tabScroll.querySelectorAll('[role="tab"]'))button.tabIndex=button===select?0:-1;};
      const ti = document.createElement('span');
      ti.className = 'tic';
      // 与侧栏树共用同一套类型图标（App.ftIcon），两处观感一致
      ti.innerHTML = (window.App && App.ftIcon) ? App.ftIcon(t.name) : ftIcon(t.name);
      ti.setAttribute('aria-hidden','true');select.appendChild(ti);
      const state=document.createElement('span');state.className='tab-state';state.setAttribute('aria-hidden','true');state.textContent=t.mode==null?'…':t.error||t.mode==='error'?'!':t.dirty?'●':'';state.title=t.mode==null?'加载中':t.error||t.mode==='error'?'读取失败':t.dirty?'未保存':'';select.appendChild(state);
      const label=document.createElement('span');label.className='tab-label';
      const nm = document.createElement('span');
      nm.className = 'tname';
      // 中段省略：保住编号前缀与扩展名（末尾省略会让一排 tab 全长得一样）
      nm.textContent = t.name;label.appendChild(nm);
      if(description.pathHint){const hint=document.createElement('span');hint.className='tpath';hint.textContent=description.pathHint;label.appendChild(hint);}select.appendChild(label);el.appendChild(select);
      const x = document.createElement('button');x.type='button';x.tabIndex=-1;x.setAttribute('aria-label','关闭 '+description.name+'，'+description.path);
      x.className = 'tclose';
      x.textContent = '✕';
      x.onclick = (e) => { e.stopPropagation(); requestClose([t]); };
      el.appendChild(x);
      el.onclick = () => { if(tabs.includes(t))activate(tabs.indexOf(t)); };
      // 拖拽排序（手动实现：mousedown → mousemove → mouseup）
      el.dataset.path = t.path;
      el.dataset.tabId = String(t.id);
      el.onmousedown = (e) => startDrag(e, el, t);
      // 中键关闭（浏览器/PyCharm 习惯）
      el.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); requestClose([t]); } };
      el.oncontextmenu = (e) => { e.preventDefault(); ctxTabMenu(e.clientX, e.clientY, t); };
      el.title = t.path;
      tabScroll.appendChild(el);
    });
    // 打开文件过多时合并：右侧「▾ 全部标签」下拉
    if (tabs.length > 1) {
      const all = document.createElement('button');all.type='button';all.setAttribute('aria-label','全部打开的标签，'+tabs.length+' 个');all.setAttribute('aria-haspopup','dialog');
      all.className = 'tab-all';
      all.textContent = '▾ ' + tabs.length;
      all.title = '全部打开的标签';
      all.onclick = (e) => {
        e.stopPropagation();
        window.TabPicker.open(all);
      };
      tabScroll.appendChild(all);
    }
    renderTabActions();
    if(activeTabId!=null)viewer.setAttribute('aria-labelledby','file-tab-'+activeTabId);else viewer.removeAttribute('aria-labelledby');
    fitTabLabels();window.TabPicker?.refresh();
    if(wasTabFocus)focusTab(tabs.some(tab=>tab.id===focusId)?focusId:activeTabId);
    else if(wasAll)tabScroll.querySelector('.tab-all')?.focus({preventScroll:true});
    empty.classList.toggle('visible', tabs.length === 0);
    if (window.Session) Session.save();
  }

  // ---------- 标签拖拽排序 ----------
  let dragState = null;
  let clickRelease = null;
  function cancelDrag(restore=true) {
    if(!dragState)return;
    const state=dragState;dragState=null;state.cleanup();state.el.classList.remove('dragging');
    if(restore&&state.moved)renderTabs();
  }
  function suppressReleaseClick() {
    clickRelease?.();
    const onClick=e=>{if(e.detail===0||!tabScroll.contains(e.target))return;e.preventDefault();e.stopImmediatePropagation();clear();};
    const clear=()=>{clearTimeout(timer);document.removeEventListener('click',onClick,true);if(clickRelease===clear)clickRelease=null;};
    const timer=setTimeout(clear,400);clickRelease=clear;document.addEventListener('click',onClick,true);
  }
  function startDrag(e, el, tab) {
    clickRelease?.();cancelDrag();
    if (e.button !== 0 || e.target.closest('.tclose') || !tabs.includes(tab)) return;
    const state={el,tab,startX:e.clientX,moved:false,root:MI.activeRoot,cleanup:null};dragState=state;
    const onMove = (ev) => {
      if (dragState!==state) return;
      if(!el.isConnected||!tabs.includes(tab)||MI.activeRoot!==state.root){cancelDrag();return;}
      if (!state.moved && Math.abs(ev.clientX - state.startX) > 5) {
        state.moved = true;
        el.classList.add('dragging');
      }
      if (!state.moved) return;
      // 按鼠标位置与各标签中心找到插入点，实时移动 DOM（只考虑 .tab，忽略右侧「▾ 全部」按钮）
      const tabsEl = [...tabScroll.querySelectorAll('.tab')].filter(t=>t!==el);
      let insertAfter = -1;
      tabsEl.forEach((t, j) => {
        const r = t.getBoundingClientRect();
        if (ev.clientX > r.left + r.width / 2) insertAfter = j;
      });
      const ref = tabsEl[insertAfter + 1];
      if (ref) tabScroll.insertBefore(el, ref);
      else tabScroll.insertBefore(el,tabScroll.querySelector('.tab-all'));
    };
    const onUp = ev => {
      if(dragState!==state)return;
      const r=tabScroll.getBoundingClientRect(),inside=ev.clientX>=r.left&&ev.clientX<=r.right&&ev.clientY>=r.top&&ev.clientY<=r.bottom;
      const moved=state.moved;cancelDrag(false);
      if(moved){suppressReleaseClick();if(inside&&tabs.includes(tab)&&MI.activeRoot===state.root)finishDrag();else renderTabs();}
    };
    const onCancel=()=>cancelDrag();
    const onKey=ev=>{if(ev.key==='Escape'&&!ev.isComposing&&dragState===state){ev.preventDefault();ev.stopImmediatePropagation();cancelDrag();suppressReleaseClick();}};
    state.cleanup=()=>{document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);document.removeEventListener('pointercancel',onCancel);document.removeEventListener('keydown',onKey,true);window.removeEventListener('blur',onCancel);};
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('pointercancel',onCancel);
    document.addEventListener('keydown',onKey,true);
    window.addEventListener('blur',onCancel);
  }
  // 按 DOM 顺序重建 tabs（触发重渲染与会话保存）
  function finishDrag() {
    const order = [...tabScroll.querySelectorAll('.tab')].map((t) => Number(t.dataset.tabId));
    if(order.length!==tabs.length||new Set(order).size!==tabs.length||tabs.some(t=>!order.includes(t.id))){renderTabs();return;}
    tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    renderTabs();
  }

  let tabMenuCleanup=null;
  function ctxTabMenu(x, y, tab, keyboard=false) {
    tabMenuCleanup?.();
    if(!tabs.includes(tab))return;
    const menu = document.getElementById('ctx-menu');
    menu.innerHTML = '';
    const mk = (label, fn) => {
      const d = document.createElement('div');
      d.className = 'ctx-item';
      d.textContent = label;
      d.tabIndex=-1;d.setAttribute('role','menuitem');
      d.onclick = async() => { menu.classList.add('hidden');tabMenuCleanup?.(); if(tabs.includes(tab)){const result=await fn();if(keyboard&&!window.Modal?.stack.length&&(document.activeElement===document.body||menu.contains(document.activeElement)))focusTab(tab.id);return result;} };
      menu.appendChild(d);
    };
    mk('📋 复制完整路径', () => { MI.copyText(tab.path); MI.toast('已复制路径', 'ok'); });
    mk('📄 查看完整路径', () => window.TabPicker.open(tabButton(tab.id),tab.id));
    if (window.GitLog && GitLog.showFileHistory) mk('🕘 显示文件历史', () => Shortcuts.execute('file-history', Shortcuts.context(tab)));
    if (tab.mode === 'edit') mk('⑂ Blame 注解', () => { if (tab !== currentTab()) activate(tabs.indexOf(tab)); toggleBlame(); });
    // 以所在文件夹为项目根打开；文件就在当前项目根下时无意义，不显示
    const pdir = (tab.path || '').replace(/[\\/][^\\/]+$/, '');
    if (pdir && pdir !== MI.activeRoot) mk('🗃 作为项目打开（所在文件夹）', () => { if (window.App) App.openProject(tab.path.replace(/[\\/][^\\/]+$/, '')); });
    mk('✕ 关闭', () => requestClose([tab]));
    mk('🗂 关闭其他', () => requestClose(tabs.filter(t=>t!==tab)));
    mk('🗑 关闭全部', () => requestClose([...tabs]));
    menu.classList.remove('hidden');
    menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 80) + 'px';
    if(keyboard){menu.setAttribute('role','menu');menu.setAttribute('aria-label','标签操作');const rows=[...menu.children];rows[0]?.focus();
      const onKey=e=>{if(menu.classList.contains('hidden')||!tabs.includes(tab)){tabMenuCleanup?.();return;}if(e.isComposing||e.keyCode===229||window.Modal?.stack.length)return;
        if(['ArrowDown','ArrowUp','Home','End','Enter',' ','Escape','Tab'].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();const at=rows.indexOf(document.activeElement);
          if(e.key==='Escape'||e.key==='Tab'){menu.classList.add('hidden');tabMenuCleanup?.();if(e.key==='Tab')focusEditor();else focusTab(tab.id);}
          else if(e.key==='Enter'||e.key===' ')rows[Math.max(0,at)]?.click();
          else rows[e.key==='Home'?0:e.key==='End'?rows.length-1:(at+(e.key==='ArrowUp'?-1:1)+rows.length)%rows.length]?.focus();}
      };tabMenuCleanup=()=>{document.removeEventListener('keydown',onKey,true);menu.removeAttribute('role');menu.removeAttribute('aria-label');tabMenuCleanup=null;};document.addEventListener('keydown',onKey,true);
    }
  }

  // ---------- 视图渲染 ----------
  let viewGeneration = 0;
  function editorScope(tab, parent) {
    const epoch=viewGeneration, project=MI.activeRoot, path=tab.path, generation=tab.pathGeneration||0, mode=tab.mode;
    return () => epoch===viewGeneration && MI.activeRoot===project && currentTab()===tab && tabs.includes(tab)
      && tab.path===path && (tab.pathGeneration||0)===generation && tab.mode===mode && parent.isConnected;
  }
  function renderView() {
    viewGeneration++;
    closeFind();
    blameOn = false; // 切换标签/视图后 gutter 已重建，注解需重新开启
    // ⚠ 先判断「这一帧有没有内容可画」，再销毁旧编辑器 / 清空容器。
    //   新标签是「先 activate 再 loadTab」，而 loadTab 要 await 读盘 —— 旧写法上来就
    //   viewer.innerHTML = ''，于是"正在读盘"的那段时间编辑区是**空白的**：
    //   切成一个还没打开过的文件时看到的那一帧闪，就是它。
    //   现在内容没就绪就保留旧画面（编辑器也不销毁），loadTab 完成后会再调一次
    //   renderView 把新内容画上 —— 体验与 VS Code / Cursor 一致。
    if (currentTab() && currentTab().mode == null) {
      cmApi?.setReadOnly?.(true);
      for (const ta of viewer.querySelectorAll('textarea.editor')) ta.readOnly=true;
      for(const child of viewer.children)child.inert=true;
      viewer.querySelector('.viewer-loading')?.remove();
      const loading=document.createElement('div');loading.className='viewer-loading';loading.setAttribute('role','status');
      loading.textContent='正在加载「'+currentTab().name+'」'+(cmApi?.__tab?'；「'+cmApi.__tab.name+'」画面只读':'；原画面只读');
      viewer.prepend(loading);return;
    }
    // 切换视图前保存 CM 编辑器状态（撤销历史/光标）
    if (cmApi) {
      if (cmApi.__tab) cmApi.__tab.cmState = cmApi.getState();
      cmApi.destroy();
      cmApi = null;
    }
    for (const tab of tabs) tab.ta=null;
    viewer.innerHTML = '';
    if (!currentTab()) { empty.classList.add('visible'); return; }
    empty.classList.remove('visible');
    const tab = currentTab();
    const isMarkdown = /\.(md|markdown)$/i.test(tab.name);
    // 编辑器操作按钮（模式切换 / 查看源码 / 内置浏览器）不再单独占一整行 ——
    // 跟「定位」一起挂在标签栏右端。原来那一行左边 500px 全空，只为右侧摆 4 个小按钮。
    // 模式切换后要刷新按钮的 active 态，所以这里也重建一次。
    renderTabActions();

    // 状态栏：文件 + 行数（公共区域，edit/preview/error 都更新）
    if (window.App) App.updateStatusbar({
      file: tab.path,
      lines: tab.content ? tab.content.split('\n').length : 0,
      encoding: formatLabel(tab),
      encodingEnabled: canChooseEncoding(tab),
      eol: tab.eol,
    });
    // 刷新大纲（md 文件）
    if (window.App) App.refreshOutline(tab);

    if (tab.mode === 'error') {
      const msg = document.createElement('div');
      msg.className = 'viewer-msg';
      if (tab.officeOld) {
        // 老版 Office 二进制格式：前端无法解析
        msg.innerHTML = `<div class="big-ic">📄</div>` +
          `老版 Office 格式（.${extOf(tab.name)}）暂不支持预览<br>` +
          `建议转换为 .${extOf(tab.name)}x 新格式后查看`;
        const btnOld = document.createElement('button');
        btnOld.className = 'vt-btn';
        btnOld.style.marginTop = '12px';
        btnOld.textContent = '↗ 用系统默认程序打开';
        btnOld.title = '调用系统关联程序打开该文件';
        btnOld.onclick = () => { try { window.myIDE.shell.openExternal('file:///' + tab.path.split('\\').join('/')); } catch {} };
        msg.appendChild(btnOld);
      } else {
        msg.innerHTML = `<div class="big-ic">${tab.binary ? '🧱' : '📦'}</div>` +
          (tab.binary ? `二进制文件（${fmtSize(tab.size)}），不支持预览` : tab.tooLarge ? `文件过大（${fmtSize(tab.size)}），超出 8MB 预览限制` : '');
        if(!tab.binary&&!tab.tooLarge){
          msg.appendChild(document.createTextNode('读取失败: '+tab.error));
          const retry=document.createElement('button');retry.className='vt-btn';retry.textContent='重试读取';
          retry.onclick=()=>{if(currentTab()!==tab||!msg.isConnected)return;tab.error=null;tab.mode=null;renderTabs();renderView();tab.loadPromise=loadTab(tab);};
          msg.appendChild(retry);
        }
      }
      viewer.appendChild(msg);
      return;
    }

    if (tab.mode === 'live') {
      tab.ta = null;
      renderMarkdownCm(tab, true);
      return;
    }

    if (tab.mode === 'source') {
      tab.ta = null;
      renderMarkdownCm(tab, false);
      return;
    }

    if (tab.mode === 'edit' || tab.mode === 'split') {
      // 代码文件（非 Markdown）：CM6 语法高亮编辑器（替代 textarea）
      if (!isMarkdown) { renderCodeCm(tab); return; }
      const splitOn = tab.mode === 'split' || (tab.mode === 'edit' && isMarkdown && tab.splitPreview !== false);
      // 行号 gutter + textarea
      const wrap = document.createElement('div');
      wrap.className = 'editor-wrap';
      const gutter = document.createElement('div');
      gutter.className = 'editor-gutter';
      wrap.appendChild(gutter);
      const ta = document.createElement('textarea');
      const ownsEditor=editorScope(tab,wrap);
      ta.className = 'editor';
      ta.value = tab.content ?? '';
      ta.spellcheck = false;
      const reportPos = () => {
        if (!window.App) return;
        const pos = ta.selectionStart;
        const before = ta.value.slice(0, pos);
        const line = before.split('\n').length;
        const col = pos - before.lastIndexOf('\n');
        App.updateStatusbar({ pos: line + ':' + col });
      };
      const lineCount = () => ta.value.split('\n').length;
      let lastLines = -1; // 强制首次渲染
      const renderGutter = () => {
        const n = lineCount();
        if (n === lastLines) return; // 行数未变不重建
        lastLines = n;
        gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
      };
      renderGutter();
      // Markdown 分屏：右侧实时预览（预览下修改）
      let previewPane = null;
      let mdRefreshTimer = null;
      const refreshPreview = () => {
        if (!previewPane) return;
        const fn = MI.renderFor({ path: tab.path, name: tab.name, ext: extOf(tab.name) });
        previewPane.innerHTML = '';
        const node = fn ? fn({ path: tab.path, name: tab.name, ext: extOf(tab.name), content: ta.value }) : null;
        if (node instanceof HTMLElement) previewPane.appendChild(node);
        else previewPane.textContent = node == null ? '' : String(node);
      };
      // 滚动同步：行号跟随 + 预览按比例跟随（Obsidian 式分屏阅读体验）
      ta.addEventListener('scroll', () => {
        gutter.scrollTop = ta.scrollTop;
        tab.scrollTop = ta.scrollTop; // 切换文件后恢复上次位置
        if (previewPane && !previewScrolling) {
          const maxTa = ta.scrollHeight - ta.clientHeight;
          if (maxTa > 0) {
            const ratio = ta.scrollTop / maxTa;
            previewPane.scrollTop = ratio * (previewPane.scrollHeight - previewPane.clientHeight);
          }
        }
      });
      // 用户滚预览 → 暂停跟随 800ms（避免双向抖动）
      let previewScrolling = false;
      let previewScrollTimer = null;
      ta.addEventListener('input', () => {
        if (tab.__extLoading) return;
        if(!ownsEditor()||tab.ta!==ta){ta.value=tab.content||'';return;}
        const change=mapTextChange(tab.content,ta.value);tab.content = TextLines.reconcile(tab.content || '', ta.value);
        markEdited(tab,change);
        scheduleAutosave(); // 自动保存：停止输入 3 秒后写盘
        reportPos();
        renderGutter();
        if (previewPane) {
          clearTimeout(mdRefreshTimer);
          mdRefreshTimer = setTimeout(refreshPreview, 200);
        }
      });
      ta.addEventListener('keyup', reportPos);
      ta.addEventListener('click', reportPos);
      ta.addEventListener('keydown', (e) => {
        handlePairing(e, ta);
        if (e.defaultPrevented) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveSnapshot(tab, false); }
        if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          const s = ta.selectionStart, en = ta.selectionEnd;
          ta.setRangeText('    ', s, en, 'end');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      wrap.appendChild(ta);
      // 恢复上次滚动位置（用户报告：每次点击文件都回到开头）
      if (tab.scrollTop) { try { ta.scrollTop = tab.scrollTop; } catch {} }
      if (splitOn) {
        const split = document.createElement('div');
        split.className = 'md-split';
        // 可拖动分割条（比例持久化）
        const divider = document.createElement('div');
        divider.className = 'md-split-divider';
        divider.title = '拖动调整分屏比例';
        try {
          const savedRatio = parseFloat(localStorage.getItem('myide-md-split'));
          if (savedRatio >= 0.2 && savedRatio <= 0.8) wrap.style.flex = '0 0 ' + (savedRatio * 100) + '%';
        } catch {}
        divider.addEventListener('mousedown', (e) => {
          e.preventDefault();
          divider.classList.add('dragging');
          const overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:col-resize;';
          document.body.appendChild(overlay);
          const rect = split.getBoundingClientRect();
          const apply = (x) => {
            const ratio = Math.min(0.8, Math.max(0.2, (x - rect.left) / rect.width));
            wrap.style.flex = '0 0 ' + (ratio * 100) + '%';
          };
          const onMove = (ev) => apply(ev.clientX);
          const onUp = () => {
            overlay.remove();
            divider.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const m = /^([\d.]+)%$/.exec(wrap.style.flexBasis || wrap.style.flex || '');
            if (m) { try { localStorage.setItem('myide-md-split', String(parseFloat(m[1]) / 100)); } catch {} }
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
        split.appendChild(wrap);
        split.appendChild(divider);
        previewPane = document.createElement('div');
        previewPane.className = 'md-split-preview';
        // 用户滚预览 → 暂停「编辑→预览」跟随，防抖恢复
        previewPane.addEventListener('scroll', () => {
          previewScrolling = true;
          clearTimeout(previewScrollTimer);
          previewScrollTimer = setTimeout(() => { previewScrolling = false; }, 800);
        });
        split.appendChild(previewPane);
        viewer.appendChild(split);
        refreshPreview();
      } else {
        viewer.appendChild(wrap);
      }
      tab.ta = ta;
      return;
    }

    // 预览模式：交给插件渲染
    const fn = MI.renderFor({ path: tab.path, name: tab.name, ext: extOf(tab.name) });
    const node = fn ? fn({ path: tab.path, name: tab.name, ext: extOf(tab.name), content: tab.content }) : null;
    if (node instanceof HTMLElement) {
      viewer.appendChild(node);
      // 滚动位置：恢复上次 + 实时记录（切回文件不回开头）
      const scroller = node.matches('.md-view') ? node : (node.querySelector('.md-view') || node);
      try {
        if (tab.scrollTop) scroller.scrollTop = tab.scrollTop;
        scroller.addEventListener('scroll', () => { tab.scrollTop = scroller.scrollTop; }, { passive: true });
      } catch {}
    }
    else {
      // 插件返回字符串（如美化 JSON）→ 源码编辑
      tab.content = node ?? tab.content;
      tab.mode = 'edit';
      renderView();
    }
  }

  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB'; }

  // ---------- Markdown 编辑（CodeMirror 6） ----------
  // live：Obsidian 式 Live Preview（光标行源码 / 其余行渲染）
  // source：纯源码模式（同一编辑器，关闭装饰层）
  let cmApi = null;
  let cmOutlineTimer = null;
  let blameOn = false; // Git Blame 注解开关（仅代码编辑模式；编辑即失效）

  // ---------- Git Blame 注解（PyCharm Annotate 式，编辑器 gutter 显示每行作者/日期） ----------
  async function toggleBlame() {
    const tab = currentTab();
    if (!tab || !cmApi || !cmApi.setBlame) { MI.toast('Blame 注解仅支持代码编辑模式', 'err'); return; }
    if (blameOn) { blameOn = false; cmApi.setBlame(null); return; }
    const root = window.App && App.root;
    if (!root) { MI.toast('请先打开一个项目', 'err'); return; }
    const fp = String(tab.path).replace(/\\/g, '/');
    const rp = String(root).replace(/\\/g, '/');
    if (fp.toLowerCase().indexOf(rp.toLowerCase() + '/') !== 0) { MI.toast('文件不在当前项目内', 'err'); return; }
    const rel = fp.slice(rp.length + 1);
    const r = await window.myIDE.git.blame(root, rel);
    if (r.error) { MI.toast(r.error, 'err'); return; }
    blameOn = true;
    cmApi.setBlame(r.lines);
  }
  function closeBlame() { blameOn = false; if (cmApi && cmApi.setBlame) cmApi.setBlame(null); }

  // 编辑器右键菜单（代码编辑区）：Blame 注解 / 文件历史
  function showEditorMenu(x, y) {
    const menu = document.getElementById('ctx-menu');
    menu.innerHTML = '';
    const mk = (label, fn) => {
      const d = document.createElement('div');
      d.className = 'ctx-item';
      d.textContent = label;
      d.onclick = () => { menu.classList.add('hidden'); fn(); };
      menu.appendChild(d);
    };
    mk(blameOn ? '✕ 关闭 Blame 注解' : '⑂ Git Blame 注解', () => toggleBlame());
    mk('🕘 显示文件历史', () => { if (window.GitLog) return Shortcuts.execute('file-history'); });
    // 交给 AI：内容整理最顺手的入口 —— 选中一段右键就够，不用去面板里描述「哪一段」
    if (window.AiPanel && AiPanel.fromEditor) {
      mk('✨ 用 AI 解释选中内容', () => AiPanel.fromEditor('explain'));
      mk('✏️ 用 AI 修正选中内容', () => AiPanel.fromEditor('fix'));
      mk('🔧 用 AI 改进选中内容', () => AiPanel.fromEditor('improve'));
      mk('📄 用 AI 整理这个文件', () => AiPanel.fromEditor('doc'));
    }
    menu.classList.remove('hidden');
    menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 100) + 'px';
  }

  function renderMarkdownCm(tab, live) {
    const wrap = document.createElement('div');
    wrap.className = 'editor-cm-wrap';
    viewer.appendChild(wrap);
    if (!window.MdEditor) {
      wrap.innerHTML = '<div class="viewer-msg">CM6 未加载（vendor/cm6-bundle.min.js 缺失）</div>';
      return;
    }
    MdEditor.__baseDir = tab.path ? tab.path.split(/[\\/]/).slice(0, -1).join('/') : '';
    MdEditor.__openLink = (href) => openMdLink(tab, href);
    // 粘贴图片：写入笔记目录（存在 assets/ 子目录则放入）→ 返回相对路径插入 MD
    MdEditor.__onPasteImage = async (file) => {
      try {
        const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' };
        const ext = extMap[file.type] || 'png';
        const ts = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        const name = '粘贴图片-' + ts.getFullYear() + p2(ts.getMonth() + 1) + p2(ts.getDate())
          + '-' + p2(ts.getHours()) + p2(ts.getMinutes()) + p2(ts.getSeconds()) + '.' + ext;
        const dir = String(MdEditor.__baseDir || '').replace(/\//g, '\\');
        if (!dir || !window.myIDE.fs.writeBinary) return null;
        let targetDir = dir, inAssets = false;
        try {
          const items = await window.myIDE.fs.readDir(dir, true);
          if (items.some((x) => x.type === 'dir' && x.name === 'assets')) { targetDir = dir + '\\assets'; inAssets = true; }
        } catch {}
        const buf = new Uint8Array(await file.arrayBuffer());
        let b64 = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < buf.length; i += CHUNK) b64 += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
        const r = await window.myIDE.fs.writeBinary(targetDir + '\\' + name, btoa(b64));
        if (!r || !r.ok) { MI.toast('图片保存失败: ' + ((r && r.error) || ''), 'err'); return null; }
        return (inAssets ? 'assets/' : '') + name;
      } catch { return null; }
    };
    cmApi = MdEditor.create({
      parent: wrap,
      canEdit: editorScope(tab,wrap),
      doc: tab.content || '',
      state: tab.cmState || null,
      live,
      onChange: (val,changes) => {
        if (tab.__extLoading) return; // 外部重载写入：不标 dirty、不触发自动保存（防写回抖动）
        tab.content = val;
        markEdited(tab,changes?(position,assoc)=>changes.mapPos(position,assoc):null);
        scheduleAutosave();
        clearTimeout(cmOutlineTimer);
        cmOutlineTimer = setTimeout(() => { if (window.App) App.refreshOutline(tab); }, 300);
      },
      onCursor: (line, col) => {
        if (window.App) App.updateStatusbar({ pos: line + ':' + col });
      },
    });
    cmApi.__tab = tab;
    tab.ta = null;
    // 滚动位置实时记录 + 切回恢复（用户报告：每次点击文件都回到开头）
    try {
      const sd = cmApi.view.scrollDOM;
      sd.addEventListener('scroll', () => { tab.scrollTop = sd.scrollTop; }, { passive: true });
      if (tab.scrollTop) sd.scrollTop = tab.scrollTop;
    } catch {}
    scheduleEditorFocus(cmApi,tab);
  }

  // ---------- 代码文件编辑（CodeMirror 6 + 语法高亮） ----------
  function renderCodeCm(tab) {
    const wrap = document.createElement('div');
    wrap.className = 'editor-code-wrap';
    viewer.appendChild(wrap);
    if (!window.CodeEditor) {
      wrap.innerHTML = '<div class="viewer-msg">CM6 未加载（vendor/cm6-bundle.min.js 缺失）</div>';
      return;
    }
    cmApi = CodeEditor.create({
      parent: wrap,
      canEdit: editorScope(tab,wrap),
      doc: tab.content || '',
      state: tab.cmState || null,
      ext: extOf(tab.name),
      onChange: (val,changes) => {
        if (tab.__extLoading) return;
        tab.content = val;
        markEdited(tab,changes?(position,assoc)=>changes.mapPos(position,assoc):null);
        if (blameOn) closeBlame(); // 编辑后行号错位，自动关闭 Blame 注解
        scheduleAutosave(); // 自动保存：停止输入 3 秒后写盘
      },
      onCursor: (line, col) => {
        if (window.App) App.updateStatusbar({ pos: line + ':' + col });
      },
      saveKeysInShortcuts: true,
    });
    cmApi.__tab = tab;
    tab.ta = null;
    // 编辑器右键菜单：Blame 注解 / 文件历史（PyCharm Annotate with Git Blame 入口）
    wrap.oncontextmenu = (e) => { e.preventDefault(); showEditorMenu(e.clientX, e.clientY); };
    const scroller=cmApi.view.scrollDOM;
    scroller.addEventListener('scroll',()=>{tab.scrollTop=scroller.scrollTop;tab.scrollLeft=scroller.scrollLeft;},{passive:true});
    if(tab.scrollTop)scroller.scrollTop=tab.scrollTop;if(tab.scrollLeft)scroller.scrollLeft=tab.scrollLeft;
    scheduleEditorFocus(cmApi,tab);
  }

  // 渲染态链接点击（Ctrl+点击）→ 外链浏览器 / 本地相对路径打开
  function openMdLink(tab, href) {
    if (/^(https?:|mailto:)/i.test(href)) {
      if (window.myIDE && window.myIDE.shell) window.myIDE.shell.openExternal(href);
      return;
    }
    const parts = String(tab.path || '').split(/[\\/]/);
    parts.pop();
    for (const seg of String(href || '').split(/[\\/]/)) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    let target = parts.join('\\');
    if (target && !/\.[A-Za-z0-9]{1,8}$/.test(target.split(/[\\/]/).pop() || '')) target += '.md';
    if (target) openFile(target);
  }

  // ---------- 字号缩放（只调文档编辑/阅读区，侧栏与界面字号不变）----------
  const FONT_KEY = 'myide-editor-font';
  function applyFontSize(size) {
    size = Math.min(20, Math.max(10, parseInt(size, 10) || 13));
    try { localStorage.setItem(FONT_KEY, String(size)); } catch {}
    document.documentElement.style.setProperty('--editor-font-size', size + 'px');
    const val = document.getElementById('sb-font-val');
    if (val) val.textContent = String(size);
    return size;
  }
  function zoomFont(delta) {
    let size = 13;
    try { size = parseInt(localStorage.getItem(FONT_KEY) || '13', 10); } catch {}
    size = applyFontSize(size + delta);
    MI.toast('字号 ' + size + 'px', 'ok');
  }
  try {
    const saved = parseInt(localStorage.getItem(FONT_KEY) || '13', 10);
    if (saved && saved !== 13) applyFontSize(saved);
  } catch {}

  // 初始化/外部调用：同步状态栏字号显示
  function syncFontLabel() {
    let size = 13;
    try { size = parseInt(localStorage.getItem(FONT_KEY) || '13', 10) || 13; } catch {}
    const val = document.getElementById('sb-font-val');
    if (val) val.textContent = String(size);
  }

  // ---------- 括号/引号配对自动补全 ----------
  const PAIRS = { '(': ')', '[': ']', '{': '}', "'": "'", '"': '"' };
  function handlePairing(e, ta) {
    const key = e.key;
    // Backspace：删除配对（光标位于 close 前且前一个是 open）——不要求单字符
    if (key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const bs = ta.selectionStart, ben = ta.selectionEnd;
      const bval = ta.value;
      if (bs === ben && bs > 0) {
        const prev = bval[bs - 1];
        if (PAIRS[prev] && bval[bs] === PAIRS[prev]) {
          e.preventDefault();
          ta.setRangeText('', bs - 1, bs + 1, 'end');
          ta.selectionStart = bs - 1;
          ta.selectionEnd = bs - 1;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey || key.length !== 1) return; // 组合键/功能键/IME 不处理
    const s = ta.selectionStart, en = ta.selectionEnd;
    const val = ta.value;
    // 1) 输入开符号
    if (PAIRS[key]) {
      e.preventDefault();
      const close = PAIRS[key];
      if (s !== en) {
        // 包裹选中文本
        const selected = val.slice(s, en);
        ta.setRangeText(key + selected + close, s, en, 'select');
        ta.selectionStart = s + 1;
        ta.selectionEnd = en + 1;
      } else {
        ta.setRangeText(key + close, s, en, 'end');
        ta.selectionStart = s + 1;
        ta.selectionEnd = s + 1;
      }
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // 2) 输入闭符号且下一个字符相同 → 跳过
    if (Object.values(PAIRS).includes(key) && val[s] === key) {
      e.preventDefault();
      ta.selectionStart = s + 1;
      ta.selectionEnd = s + 1;
      return;
    }
  }

  // ---------- 查找 / 替换（Ctrl+F / Ctrl+H）----------
  let findState = null;
  function collectMatches(ta, q) {
    const matches=[];if(!q)return matches;
    for(let from=0;;){const at=ta.value.indexOf(q,from);if(at<0)break;matches.push([at,at+q.length]);from=at+q.length;}
    return matches;
  }
  function closeFind() {
    const state=findState;findState=null;
    if(state){state.tab.findQuery={query:state.input.value,replacement:state.replacement.value};state.dispose();state.bar.remove();}
  }
  function openFind(showReplace) {
    const tab=currentTab();
    if(!tab){MI.toast('没有打开的文件','err');return;}
    if(tab.mode==null){MI.toast('文档正在加载，请稍后查找','err');return;}
    if(cmApi && cmApi.__tab===tab && cmApi.view.dom.isConnected && !tab.ta){cmApi.find();return;}
    const ta=tab.ta;
    if(!ta || !ta.isConnected || ta.readOnly || !['split','edit'].includes(tab.mode)){MI.toast('请在编辑视图中查找','err');return;}
    if(findState?.ta===ta && findState.bar.isConnected){findState.bar.querySelector('#find-replace-row').style.display=showReplace?'':'none';findState.input.focus();findState.input.select();return;}
    closeFind();
    const bar=document.createElement('div');bar.className='find-bar';
    bar.innerHTML='<input id="find-input" type="text" placeholder="查找…" spellcheck="false"><span class="find-count" id="find-count">0/0</span>'
      +'<button class="vt-btn" id="find-prev" title="上一个 (Shift+Enter)">⬆</button><button class="vt-btn" id="find-next" title="下一个 (Enter)">⬇</button>'
      +'<span id="find-replace-row"><input id="find-replace-input" type="text" placeholder="替换为…" spellcheck="false"><button class="vt-btn" id="find-rep-one" title="替换当前">替换</button><button class="vt-btn" id="find-rep-all" title="全部替换">全部</button></span>'
      +'<button class="vt-btn" id="find-close" title="关闭 (Esc)">✕</button>';
    viewer.insertBefore(bar,viewer.firstChild);
    bar.querySelector('#find-replace-row').style.display=showReplace?'':'none';
    const input=bar.querySelector('#find-input'),replacement=bar.querySelector('#find-replace-input'),count=bar.querySelector('#find-count');
    input.value=tab.findQuery?.query||'';replacement.value=tab.findQuery?.replacement||'';
    const owns=editorScope(tab,ta);
    const state={tab,ta,bar,input,replacement,matches:[],idx:-1,text:null,query:null,revision:-1,dispose:()=>ta.removeEventListener('input',changed)};
    findState=state;
    const valid=()=>findState===state && owns() && tab.ta===ta && bar.isConnected && !ta.readOnly;
    const updateCount=()=>{count.textContent=state.matches.length?(state.idx+1)+'/'+state.matches.length:'0/0';for(const id of ['find-prev','find-next','find-rep-one','find-rep-all'])bar.querySelector('#'+id).disabled=!state.matches.length;};
    const refresh=(position=ta.selectionStart,select=false)=>{
      if(!valid())return false;
      state.matches=collectMatches(ta,input.value);state.text=ta.value;state.query=input.value;state.revision=tab.editRevision;
      state.idx=state.matches.findIndex(([from])=>from>=position);if(state.idx<0)state.idx=state.matches.length-1;
      if(select && state.idx>=0){const [from,to]=state.matches[state.idx];ta.setSelectionRange(from,to);}
      updateCount();return true;
    };
    const fresh=()=>valid() && ((state.text===ta.value && state.query===input.value && state.revision===tab.editRevision)||refresh());
    state.refresh=refresh;
    const go=dir=>{if(!fresh()||!state.matches.length)return;state.idx=(state.idx+dir+state.matches.length)%state.matches.length;ta.setSelectionRange(...state.matches[state.idx]);updateCount();};
    const replaceOne=()=>{
      if(!fresh()||state.idx<0||!input.value)return;
      const [from,to]=state.matches[state.idx];
      if(ta.value.slice(from,to)!==input.value){refresh();return;}
      if(replacement.value===input.value)return;
      ta.setRangeText(replacement.value,from,to,'select');ta.dispatchEvent(new Event('input',{bubbles:true}));refresh(from,true);
    };
    const replaceAll=()=>{
      if(!fresh()||!state.matches.length)return;
      // 同一完整集合构造一次变更；替换文本含查询词时也不会重新匹配自己插入的内容。
      const original=ta.value,replace=replacement.value,matches=state.matches;let next='',end=0;
      for(const [from,to] of matches){next+=original.slice(end,from)+replace;end=to;}next+=original.slice(end);
      if(next===original)return;
      ta.value=next;ta.dispatchEvent(new Event('input',{bubbles:true}));refresh(0,false);
    };
    function changed(){refresh(ta.selectionStart,false);}
    ta.addEventListener('input',changed);
    input.addEventListener('input',()=>refresh(0,true));
    const close=()=>{if(!valid())return;closeFind();ta.focus();};
    input.addEventListener('keydown',e=>{if(e.isComposing)return;if(e.key==='Enter'){e.preventDefault();go(e.shiftKey?-1:1);}else if(e.key==='Escape'){e.preventDefault();close();}});
    replacement.addEventListener('keydown',e=>{if(e.isComposing)return;if(e.key==='Enter'){e.preventDefault();replaceOne();}else if(e.key==='Escape'){e.preventDefault();close();}});
    bar.querySelector('#find-next').onclick=()=>go(1);bar.querySelector('#find-prev').onclick=()=>go(-1);
    bar.querySelector('#find-rep-one').onclick=replaceOne;bar.querySelector('#find-rep-all').onclick=replaceAll;bar.querySelector('#find-close').onclick=close;
    input.focus();refresh(0,true);
  }

  // ---------- 自动保存（停止输入 3 秒后写盘）----------
  let autosaveTimer = null;
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      for (let i = 0; i < tabs.length; i++) {
        if (tabs[i].dirty) saveTab(i, true);
      }
    }, 3000);
  }

  function markEdited(tab,map) {
    NavigationHistory.edited(tab,map);
    tab.editRevision++;
    const endings = TextLines.endings(tab.content || '').map((run) => run[0]);
    tab.eol = endings.length > 1 ? 'MIXED' : endings[0] === '\r\n' ? 'CRLF' : endings[0] === '\r' ? 'CR' : endings.length ? 'LF' : null;
    if (tab.textFormat) tab.textFormat.eol = tab.eol;
    updateFormatStatus(tab);
    if (!tab.dirty) { tab.dirty = true; renderTabs(); }
  }

  function saveTab(i, quiet) {
    return saveSnapshot(tabs[i], quiet);
  }

  function saveSnapshot(tab, quiet, overwriteVersion) {
    if (!tab || tab.content == null) return Promise.resolve({ ok: false, errorCode: 'NO_CONTENT', error: '标签内容未就绪' });
    if (pathBusy(tab.path)) {
      if (!quiet) MI.toast('路径迁移正在进行，输入已保留；完成后请保存', 'err');
      return Promise.resolve({ok:false,errorCode:'PATH_BUSY',error:'路径迁移正在进行',path:tab.path,tabId:tab.id});
    }
    const snapshot = { tabId: tab.id, path: tab.path, content: tab.content,
      encoding: { ...(tab.textFormat || { encoding: tab.encoding, bom: tab.encoding.startsWith('utf16') }) }, revision: tab.editRevision };
    const key = DocumentPaths.key(snapshot.path);
    const previous = saveQueues.get(key) || Promise.resolve();
    // 在调用时固定正文，不能等前一次写完再读取新正文，否则 Ctrl+S 等待的版本会漂移。
    const pending = previous.then(async () => {
      let r;
      try {
        if (!tabs.includes(tab)) r = { errorCode: 'TAB_CLOSED', error: '标签已关闭' };
        else if (tab.path !== snapshot.path) r = { errorCode: 'PATH_CHANGED', error: '文件路径已变化，请重新保存' };
        else if (!overwriteVersion && !tab.diskVersion) r = { errorCode: 'VERSION_REQUIRED', error: '缺少读取时的磁盘版本，请通过保存恢复查看磁盘' };
        else r = await window.myIDE.fs.writeFile(snapshot.path, snapshot.content, snapshot.encoding, { expectedVersion: overwriteVersion || tab.diskVersion });
      } catch (e) {
        r = { errorCode: (e && e.code) || 'WRITE_FAILED', error: String((e && e.message) || e) };
      }
      if (r && r.ok && tab.path !== snapshot.path) r = { errorCode: 'PATH_CHANGED', error: '保存期间文件路径已变化，请重新保存' };
      const result = { ok: !!(r && r.ok), tabId: snapshot.tabId, path: snapshot.path,
        savedRevision: r && r.ok ? snapshot.revision : tab.savedRevision,
        errorCode: r && r.ok ? null : (r && r.errorCode) || 'WRITE_FAILED',
        error: r && r.ok ? null : (r && r.error) || '写入未返回成功结果' };
      if (tabs.includes(tab)) {
        if (result.ok) {
          tab.savedRevision = snapshot.revision;
          tab.dirty = tab.editRevision !== snapshot.revision;
          tab.saveError = null;
          tab.saveErrorCode = null;
          tab.diskVersion = r.version || tab.diskVersion;
          NavigationHistory.saved(tab);
          if (tab.editRevision === snapshot.revision && r.textFormat) {
            tab.textFormat = r.textFormat; tab.encoding = r.textFormat.encoding; tab.eol = r.textFormat.eol;
          }
          updateFormatStatus(tab);
          renderTabs();
          if (!quiet) MI.toast(tab.dirty ? '已保存先前版本，仍有未保存的修改' : '💾 已保存 ' + tab.name, 'ok');
          if (window.App) App.refreshGit();
        } else {
          // 自动保存失败也必须可见；同一错误不每三秒重复提示，正文始终留在内存中。
          if (!quiet || tab.saveError !== result.error) MI.toast('保存失败: ' + result.error + '；修改仍未保存，可按 Ctrl+S 重试', 'err');
          tab.saveError = result.error;
          tab.saveErrorCode = result.errorCode;
          tab.dirty = true;
          renderTabs();
          MI.log('ERROR', 'viewer.save', '写入失败 ' + snapshot.path + ' → ' + result.error);
        }
      }
      return result;
    });
    // UI 刷新异常也不能毒化队列，后一次显式重试仍可派发。
    const tail = pending.catch(() => {});
    saveQueues.set(key, tail);
    tail.then(() => { if (saveQueues.get(key) === tail) saveQueues.delete(key); });
    return pending;
  }

  // 只保存本次快照；等待中出现新输入时保留当前项目，让下一次 Ctrl+S 明确保存新版本。
  async function saveAllDirty() {
    const selected = tabs.filter((t) => t.dirty);
    const results = await Promise.all(selected.map((t) => saveSnapshot(t, true)));
    const saved = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const stillDirty = tabs.filter((t) => t.dirty).map((t) => ({ tabId: t.id, path: t.path }));
    return { ok: failed.length === 0 && stillDirty.length === 0, saved, failed, stillDirty };
  }

  // ---------- 重命名/移动同步：树里改名后标签路径跟着变 ----------
  // 不同步的后果：① 标签仍指向旧路径，自动保存把旧文件"复活"（改名后原文件还在的根因）
  //             ② 标签标题与磁盘文件脱节
  function renamed(oldPath, newPath, documents = []) {
    if (!oldPath || !newPath || oldPath === newPath) return;
    let touched = false;
    for (const t of tabs) {
      if (DocumentPaths.contains(oldPath,t.path)) {
        const before=t.path, known=documents.find(doc=>DocumentPaths.key(doc.oldPath)===DocumentPaths.key(before));
        t.path = DocumentPaths.map(before,oldPath,newPath);
        t.name = t.path.split(/[\\/]/).pop();
        t.pathGeneration = (t.pathGeneration || 0) + 1;
        t.editRevision++; t.savedRevision++;
        t.diskVersion = known?.version || null;
        touched = true;
      }
    }
    try { localStorage.setItem(RECENT_KEY,JSON.stringify(recentFiles().map(item=>({...item,path:DocumentPaths.map(item.path,oldPath,newPath)})))); } catch {}
    if(window.Session?.pathsMoved)Session.pathsMoved(oldPath,newPath);
    NavigationHistory.pathsMoved(oldPath,newPath,documents);
    if(window.AiPanel?.pathsMoved)AiPanel.pathsMoved(oldPath,newPath);
    if (!touched) return;
    renderTabs();
    const at = currentTab();
    if (at && DocumentPaths.contains(newPath,at.path)) renderView();
  }
  async function withPathChange(oldPath, targetRange, perform) {
    const ranges=[oldPath,targetRange].filter(Boolean);
    if([...pathChanges].some(change=>change.ranges.some(a=>ranges.some(b=>DocumentPaths.contains(a,b)||DocumentPaths.contains(b,a)))))
      return {error:'相关路径已有迁移操作，请等待完成',errorCode:'PATH_BUSY'};
    const change={ranges};pathChanges.add(change);
    try {
      const affected=tabs.filter(t=>DocumentPaths.contains(oldPath,t.path));
      const pending=[...saveQueues].filter(([p])=>DocumentPaths.contains(oldPath,p)).map(([,tail])=>tail);
      await Promise.all([...pending,...affected.map(t=>t.loadPromise).filter(Boolean)]);
      const documents=affected.filter(t=>tabs.includes(t)&&t.content!=null&&canChooseEncoding(t)&&!t.binary).map(t=>({path:t.path,version:t.diskVersion}));
      if(documents.some(doc=>!doc.version))return {error:'打开文档缺少可靠磁盘基线，请先处理保存恢复',errorCode:'VERSION_REQUIRED'};
      const result=await perform(documents,tabs.filter(t=>!DocumentPaths.contains(oldPath,t.path)).map(t=>t.path));
      if(result?.ok&&!result.noop)renamed(oldPath,result.newPath||result.path||result.target,result.documents||[]);
      return result;
    } catch(e) {return {error:String(e.message||e),errorCode:e.code||'MOVE_FAILED'};}
    finally {pathChanges.delete(change);}
  }
  async function withCreatedPathRemoval(path, perform) {
    if ([...pathChanges].some(change=>change.ranges.some(range=>DocumentPaths.contains(range,path)||DocumentPaths.contains(path,range))))
      return {error:'相关路径已有操作，请等待完成',errorCode:'PATH_BUSY'};
    const change={ranges:[path]};pathChanges.add(change);
    try {
      const affected=tabs.filter(t=>DocumentPaths.contains(path,t.path));
      const pending=[...saveQueues].filter(([p])=>DocumentPaths.contains(path,p)).map(([,tail])=>tail);
      await Promise.all([...pending,...affected.map(t=>t.loadPromise).filter(Boolean)]);
      if(affected.some(t=>tabs.includes(t)&&(t.dirty||t.formatBusy)))return {error:'新建项有未保存的输入，请先保存或另存；未撤销',errorCode:'DIRTY_DOCUMENT'};
      const revisions=new Map(affected.map(t=>[t,t.editRevision]));
      const result=await perform();
      if(result?.ok) {
        for(const t of affected) {
          if(!tabs.includes(t))continue;
          t.pathGeneration=(t.pathGeneration||0)+1;
          if(!t.dirty && t.editRevision===revisions.get(t))doClose(tabs.indexOf(t));
          else {
            // 删除等待中仍允许输入；保留正文和旧磁盘版本，旧保存不能据此创建原路径。
            t.saveError='磁盘上的新建项已撤销，输入仍保留，请另存副本';t.saveErrorCode='VERSION_CONFLICT';
            if(t===currentTab())renderView();
            MI.toast(t.saveError,'err');
          }
        }
        renderTabs();
      }
      return result;
    } catch(e) {return {error:String(e.message||e),errorCode:e.code||'REMOVE_FAILED'};}
    finally {pathChanges.delete(change);}
  }

  async function withCopyChange(readRanges, writeRanges, perform, action='复制或恢复') {
    const ranges=[...readRanges,...writeRanges];
    const contains=(p,list=ranges)=>list.some(range=>DocumentPaths.contains(range,p));
    if([...pathChanges].some(change=>change.ranges.some(a=>ranges.some(b=>DocumentPaths.contains(a,b)||DocumentPaths.contains(b,a)))))
      return {error:'相关路径已有操作，请等待完成',errorCode:'PATH_BUSY'};
    const change={ranges};pathChanges.add(change);
    try {
      const affected=tabs.filter(t=>contains(t.path));
      await Promise.all([...saveQueues].filter(([p])=>contains(p)).map(([,tail])=>tail).concat(affected.map(t=>t.loadPromise).filter(Boolean)));
      if(affected.some(t=>tabs.includes(t)&&t.formatBusy))return {error:'相关文档正在切换编码，请完成后重试',errorCode:'PATH_BUSY'};
      const revisions=new Map(affected.map(t=>[t,t.editRevision]));
      const result=await perform(affected.filter(t=>tabs.includes(t)&&t.dirty).map(t=>({path:t.path,target:contains(t.path,writeRanges)})));
      const changed=result?.changedPaths||[];
      for(const t of affected.filter(t=>tabs.includes(t)&&contains(t.path,changed))) {
        t.pathGeneration=(t.pathGeneration||0)+1;
        // 磁盘发布改变了版本身份；重新绑定当前编辑器，保留dirty输入仍能继续编辑。
        if(t===currentTab())renderView();
        const keepInput=()=>{t.saveError=(result.ok?'磁盘文件已'+action:'磁盘操作未完成')+'，输入仍保留，请比较磁盘或另存副本';t.saveErrorCode='VERSION_CONFLICT';};
        if(t.dirty||t.editRevision!==revisions.get(t)){keepInput();continue;}
        const originalPath=t.path,generation=t.pathGeneration;
        const r=await window.myIDE.fs.readFile(originalPath,t.textFormat?.detection==='selected'?t.encoding:undefined);
        if(!tabs.includes(t)||t.path!==originalPath||t.pathGeneration!==generation)continue;
        // 等待复制/重载仍允许输入；迟到的磁盘正文不能覆盖这个窗口内的新输入。
        if(t.dirty||t.editRevision!==revisions.get(t)){keepInput();continue;}
        if(r.errorCode==='ENOENT'){doClose(tabs.indexOf(t));continue;}
        if(r.error||r.binary||r.tooLarge||r.content==null){t.saveError=r.error||'复制/恢复后暂不能重载，请重新打开';t.saveErrorCode='VERSION_CONFLICT';continue;}
        t.content=r.content;t.diskVersion=r.version;t.textFormat=r.textFormat;t.encoding=r.encoding||t.encoding;t.eol=r.textFormat?.eol;
        t.saveError=null;t.saveErrorCode=null;t.cmState=null;
        if(t===currentTab()) {
          if(cmApi?.__tab===t){t.__extLoading=true;try{cmApi.setValue(r.content);}finally{t.__extLoading=false;}}
          else if(t.ta){t.ta.value=r.content;if(findState?.tab===t)findState.refresh();}else renderView();
          updateFormatStatus(t);window.App?.refreshOutline(t);
        }
      }
      renderTabs();return result;
    }catch(e){return {error:String(e.message||e),errorCode:e.code||'COPY_FAILED'};}
    finally{pathChanges.delete(change);}
  }

  // ---------- 外部修改同步：文件在磁盘上被外部程序改动 → 未保存的标签自动重载 ----------
  // dirty（有未保存修改）的标签不动，防丢用户输入。CM 模式就地 setValue（保留撤销历史与光标），
  // __extLoading 抑制 onChange 把重载误判为用户编辑（防 dirty 闪烁与自动保存写回抖动）。
  let extReloadTimer = null;
  if (window.myIDE && window.myIDE.fs && window.myIDE.fs.onChanged) {
    window.myIDE.fs.onChanged(() => {
      clearTimeout(extReloadTimer);
      extReloadTimer = setTimeout(reloadExternal, 600); // 防抖：编辑器连续保存自身不触发（watcher 已过滤断言）
    });
  }
  async function reloadExternal() {
    for (const t of tabs) {
      if (t.dirty || t.error || t.binary || t.tooLarge || t.formatBusy || pathBusy(t.path) || saveQueues.has(DocumentPaths.key(t.path))) continue;
      if (t.content == null) continue;
      if (IMG_EXTS.has(extOf(t.name)) || MEDIA_EXTS.has(extOf(t.name)) || OFFICE_EXTS.has(extOf(t.name)) || OFFICE_OLD_EXTS.has(extOf(t.name))) continue;
      try {
        const path = t.path, revision = t.editRevision, generation = t.pathGeneration || 0;
        // 用户明确选过编码后，watcher不能再用启发式把无BOM纯中文UTF-16误读为GBK。
        const r = await window.myIDE.fs.readFile(path, t.textFormat?.detection === 'selected' ? t.encoding : undefined);
        if (!tabs.includes(t) || t.path !== path || t.dirty || t.editRevision !== revision || t.formatBusy || pathBusy(path) || (t.pathGeneration || 0)!==generation || saveQueues.has(DocumentPaths.key(path))) continue;
        if (r.error || r.tooLarge || r.binary || r.content == null) continue;
        if (r.version) t.diskVersion = r.version;
        const sameContent = r.content === t.content;
        const sameFormat = JSON.stringify(t.textFormat) === JSON.stringify(r.textFormat);
        if (sameContent && sameFormat) continue;
        t.content = r.content;
        if (t !== currentTab()) t.cmState = null;
        t.encoding = r.encoding || t.encoding;
        t.textFormat = r.textFormat || { encoding: t.encoding, bom: t.encoding.startsWith('utf16') };
        t.eol = r.textFormat && r.textFormat.eol;
        if (t === currentTab()) {
          if (cmApi && cmApi.__tab === t) {
            t.__extLoading = true;
            try { cmApi.setValue(r.content); } finally { t.__extLoading = false; }
          } else if (t.ta) {
            t.__extLoading = true;
            try {
              const start=t.ta.selectionStart,end=t.ta.selectionEnd;
              t.ta.value = r.content;
              // 赋值会把 textarea 光标移到末尾，先保留原位置再选附近匹配，避免重载后跳到最后一项。
              t.ta.setSelectionRange(start,end);
              if(findState?.tab===t)findState.refresh();
              t.ta.dispatchEvent(new Event('input', { bubbles: true }));
            } finally { t.__extLoading = false; }
          } else {
            renderView();
          }
          updateFormatStatus(t);
          if (window.App) App.refreshOutline(t);
        }
      } catch {}
    }
  }

  // Ctrl+E：Markdown live ↔ source 模式切换（对齐 Obsidian）
  function toggleMdMode() {
    const tab = currentTab();
    if (!tab || !/\.(md|markdown)$/i.test(tab.name)) { MI.toast('仅 Markdown 文件支持模式切换', 'err'); return; }
    tab.mode = tab.mode === 'live' ? 'source' : 'live';
    try { localStorage.setItem('myide-md-mode', tab.mode); } catch {} // 模式全局统一
    renderView();
  }

  return {
    openFile, navigateTo, closeTab, closeAll, activate, addLazyTab, saveTab, saveAllDirty, openFind, recentFiles, revealLine, navigateToHit, captureLocation, restoreLocation, focusTab, focusEditor,
    zoomFont, applyFontSize, syncFontLabel, toggleMdMode, renamed, withPathChange, withCreatedPathRemoval, withCopyChange, toggleBlame, showEncoding, saveWithEncoding, reopenWithEncoding, showSaveRecovery, saveCopy,
    get cm() { return cmApi; },
    renderActive: () => renderView(),
    get activeTab() { return currentTab() || null; },
    get openTabs() { return tabs; },
  };
})();
window.Viewer = Viewer;

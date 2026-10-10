(() => {
  let request = null, settled = false;
  const $ = id => document.getElementById(id), line = (text, className = '') => { const node = document.createElement('div'); node.className = className; node.textContent = text; $('preview').appendChild(node); };
  async function answer(approved, scope = 'once') {
    if (!request || settled) return; settled = true;
    document.querySelectorAll('button').forEach(b => b.disabled = true);
    const result = await window.aiApproval.answer(request.id, approved, scope).catch(() => ({ ok: false }));
    if (!result.ok) { settled = false; $('note').textContent = '确认已失效，请拒绝后重新申请'; $('close').disabled = false; $('reject').disabled = false; }
  }
  window.aiApproval.show(data => {
    if (request) return; request = data;
    document.body.classList.toggle('light', data.appearance?.light === true);
    $('stop').hidden=data.type!=='operation';
    $('target').textContent = data.type === 'policy' ? 'AI 访问权限' : data.type === 'session' ? data.root : data.effect.target;
    $('note').classList.toggle('danger', data.danger === true);
    if (data.type === 'session') {
      $('title').textContent = '放行本次 AI 对话'; $('accept').textContent = '放行本次对话';
      $('note').textContent = '允许本次对话修改项目文件、执行命令。危险命令、清空文件和禁止项仍受保护；关闭面板、切项目或开始新对话时恢复。';
      line('仅限上方项目与当前对话，不保存为永久授权。');
    } else if (data.type === 'policy') {
      $('title').textContent = '更改 AI 访问权限'; $('accept').textContent = '保存权限';
      $('note').textContent = '保存后即时生效，旧操作批准将失效。';
      const names = { confirm: '每次确认', auto: '自动', deny: '禁止' };
      for (const [key, label] of [['permWrite', '改文件'], ['permRun', '执行命令']]) line(label + '：' + names[data.before[key]] + ' → ' + names[data.after[key]]);
      line('写入路径白名单：\n' + (data.after.allowPaths.join('\n') || '无')); line('始终确认的命令前缀：\n' + (data.after.denyCmds.join('\n') || '无'));
    } else if(data.effect.remote){
      $('title').textContent=data.effect.label;$('accept').textContent=data.danger?'仍然执行':'确认操作';
      const s=data.effect.session;$('target').textContent=s.name+' · '+s.username+'@'+s.host+':'+s.port;
      $('note').textContent=data.danger?'此远程命令可能有破坏性，必须逐次批准。':'仅批准本次SSH会话和终端操作；终端收到其它输入后批准会失效。';
      line('连接会话：'+s.id);if(data.effect.terminal)line('终端：'+data.effect.terminal);if(data.effect.command)line(data.effect.command);
      if(data.effect.operation==='open')line('新建独立终端，不复用正在操作的终端。');
      if(['interrupt','close'].includes(data.effect.operation))line('中断或关闭终端不保证远程后台进程停止。','muted');
    } else if (data.effect.application) {
      $('title').textContent=data.effect.label; $('accept').textContent=data.danger?'仍然执行':'确认'+({add:'添加',update:'保存',start:'启动',stop:'停止',restart:'重启'}[data.effect.operation]||'操作');
      $('target').textContent=(data.effect.after?.name||'程序')+' · '+data.effect.entryId;
      $('note').textContent=data.danger?'启动命令可能有破坏性，必须逐次批准。':'批准仅对应当前程序和配置；改动期间配置变化将取消本次操作。';
      const fields=[['name','名称'],['category','分类'],['cwd','工作目录'],['command','启动命令'],['port','端口'],['openUrl','页面地址'],['script','桥接脚本'],['python','Python解释器']];
      for(const [key,label]of fields){if(!Object.hasOwn(data.effect.after||{},key))continue;const before=data.effect.before?.[key],after=data.effect.after?.[key];if(data.effect.operation==='update'&&before===after)continue;line(label+'：'+(data.effect.operation==='update'?String(before??'')+' → ':'')+String(after??''));}
      if(['add','update'].includes(data.effect.operation))line('保存配置后不会自动启动或重启。','muted');
    } else if (data.effect.kind === 'run') {
      $('title').textContent = data.danger ? '危险命令，请确认' : 'AI 请求执行命令'; $('accept').textContent = data.danger ? '仍然执行' : '运行一次';
      $('note').textContent = data.danger ? '这条命令可能是破坏性的，必须逐次批准。' : '在上方项目目录执行。';
      line(data.effect.command);
      if (!data.danger) { $('always').hidden = false; $('always').textContent = '总是允许「' + data.call.args.command.trim().split(/\s+/)[0] + '」'; $('always').onclick = () => answer(true, 'command'); }
    } else {
      $('title').textContent = data.effect.wipe ? '确认清空文件' : 'AI 请求修改文件'; $('accept').textContent = data.effect.wipe ? '确认清空' : '应用修改';
      $('note').textContent = data.effect.wipe ? '已有内容将被清空，这一步不提供永久授权。' : '批准仅对应本次正文与原文件版本。';
      const old = data.effect.oldText.split('\n'), next = data.effect.content.split('\n'); let start = 0, end = 0;
      while (start < old.length && start < next.length && old[start] === next[start]) start++;
      while (end < old.length - start && end < next.length - start && old[old.length - end - 1] === next[next.length - end - 1]) end++;
      $('summary').hidden = false; $('summary').textContent = '+' + (next.length - start - end) + ' −' + (old.length - start - end);
      if (start) line('⋯ ' + start + ' 行未改动 ⋯', 'muted');
      const rows = [...old.slice(start, old.length - end).map(s => ['− ' + s, 'del']), ...next.slice(start, next.length - end).map(s => ['+ ' + s, 'add'])];
      let bytes = 0, count = 0;
      for (const [text, cls] of rows) { if (++count > 1200 || (bytes += text.length) > 120000) { line('预览过长，显示部分差异；实际修改仍为本次完整正文。', 'muted'); break; } line(text, cls); }
      if (end) line('⋯ ' + end + ' 行未改动 ⋯', 'muted');
      if (!data.danger) { $('always').hidden = false; $('always').textContent = '本项目内都允许'; $('always').onclick = () => answer(true, 'project'); }
      $('fold').hidden = false;
    }
    $('reject').focus();
  });
  $('accept').onclick = () => answer(true); $('reject').onclick = $('close').onclick = () => answer(false);
  $('stop').onclick=()=>{if(request&&!settled){settled=true;window.aiApproval.stop(request.id).catch(()=>{});}};
  $('fold').onclick=()=>{const hidden=$('preview').hidden=!$('preview').hidden;$('fold').textContent=hidden?'展开 diff':'收起 diff';};
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); answer(false); } });
})();

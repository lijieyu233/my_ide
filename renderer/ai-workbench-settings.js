// ai-workbench-settings.js —— settings 模块（键注册表驱动）
//
// 2026-10-27 改成注册表模式：本文件不再为「主题/字号/栏宽/快捷键」写专用参数，
// 而是把每一类配置声明成 SettingKeys 的一组键，工具侧只剩 settings_keys /
// settings_values 两个固定入口。新增功能（本次就是粘贴图片的 COS 图床）只要在
// 这里 register 一次就能被 AI 读写，工具清单不再变化。
//
// 保留的语义（与改造前对齐，避免功能倒退）：
//   · persistent=false：临时生效，写完立刻把 localStorage 还原成调用前的值
//   · restore：只撤销本接口的上一次变更，且当前状态必须仍是那次变更后的样子，
//     否则拒绝——否则会静默覆盖用户后续的手动修改
//   · 快捷键冲突：抛 SHORTCUT_CONFLICT 并保留原绑定。注意 Shortcuts.setBindings
//     自己会「顺手把冲突动作的键削掉」，所以必须先查冲突再决定，不能交给它兜底
//   · snapshot 校验 / 项目校验 / 主进程审批：由 AiWorkbench.guard 统一处理
(()=>{
  const W=AiWorkbench,F=W.fail;

  // ---------- 外观：主题 + 正文字号 ----------
  SettingKeys.register({
    module:'appearance',group:'外观',
    read:()=>({theme:Theme.current(),fontSize:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size'))||13}),
    write:v=>{
      if(v.theme!==undefined){Theme.set(v.theme);if(Theme.current()!==v.theme)return false;}
      if(v.fontSize!==undefined)Viewer.applyFontSize(v.fontSize);
      return true;
    },
    keys:{
      'appearance.theme':{type:'string',label:'主题',description:'dark / light / pink / crimson / graphite，或 user:<id> 自建主题',param:'theme'},
      'appearance.fontSize':{type:'number',label:'正文字号',minimum:10,maximum:20,param:'fontSize'},
    },
  });

  // ---------- 布局 ----------
  const layoutRead=()=>{
    const rect=id=>Math.round((document.getElementById(id)?.getBoundingClientRect().width||0)*10)/10;
    const el=id=>document.getElementById(id);
    return {sidebarWidth:rect('sidebar'),aiWidth:rect('ai-panel'),
      // 原始内联样式一并留着：restore 要靠它精确还原（空串表示当时没写死宽度）
      sidebarStyle:el('sidebar')?.style.width??'',aiStyle:el('ai-panel')?.style.width??'',
      sidebarVisible:!document.body.classList.contains('sidebar-collapsed'),
      aiVisible:!el('ai-panel').classList.contains('hidden'),
      rightCollapsed:document.body.classList.contains('rsb-collapsed')};
  };
  SettingKeys.register({
    module:'layout',group:'布局',read:layoutRead,
    write:v=>{
      if(v.sidebarVisible!==undefined)App.toggleSidebar(!v.sidebarVisible);
      if(v.aiVisible!==undefined){App.setAiOpen(v.aiVisible);if(v.aiVisible)App.toggleRightSidebar(false);}
      if(v.sidebarWidth!==undefined)App.resizeColumn('sidebar',v.sidebarWidth);
      if(v.aiWidth!==undefined)App.resizeColumn('ai-panel',v.aiWidth);
      App.saveColumnWidths();return true;
    },
    keys:{
      'layout.sidebarWidth':{type:'integer',label:'侧栏宽度',optional:true,minimum:0,maximum:10000,param:'sidebarWidth'},
      'layout.aiWidth':{type:'integer',label:'AI 面板宽度',optional:true,minimum:0,maximum:10000,param:'aiWidth'},
      'layout.sidebarVisible':{type:'boolean',label:'侧栏可见',param:'sidebarVisible'},
      'layout.aiVisible':{type:'boolean',label:'AI 面板可见',param:'aiVisible'},
    },
  });

  // ---------- 快捷键（按动作逐个成键） ----------
  // read 只回 bindings 的公开投影（id/desc/combos），不回 run 函数等内部字段。
  // params 里带 action：写某一项时必须知道改的是哪个动作。
  let shortcutAction='';
  SettingKeys.register({
    module:'shortcut',group:'快捷键',
    read:()=>({params:{action:shortcutAction||'save',keys:[]},
      values:{'shortcut.combos':Shortcuts.bindings().find(b=>b.id===(shortcutAction||'save'))?.combos||[],
        'shortcut.actions':Shortcuts.bindings().map(b=>b.id)}}),
    write:v=>{
      const action=String(v.action||'');if(!action)F('INVALID_TOOL_ARGS','缺少快捷键动作ID');
      if(v.reset){Shortcuts.reset(action);return true;}
      const combos=Array.isArray(v.keys)?v.keys:[];
      // 先查冲突：setBindings 会把冲突动作的键直接削掉，不能让它兜底
      if(Shortcuts.bindingConflicts(action,combos).length)F('SHORTCUT_CONFLICT','快捷键已被占用，原配置保留');
      Shortcuts.setBindings(action,combos);
      return true;
    },
    keys:{
      'shortcut.combos':{type:'array',label:'当前动作的组合键',param:'keys',
        description:'先读 shortcut.actions 取动作ID，再用 settings_values 写入 {"shortcut.set":"action:save","shortcut.combos":["ctrl+s"]}；reset 见 shortcut.reset'},
      'shortcut.reset':{type:'boolean',label:'恢复该动作默认键',optional:true,param:'reset'},
    },
  });

  // ---------- 粘贴图片 / 腾讯云 COS 图床 ----------
  // 这是本次改造的直接动因：图床六项此前没有任何 AI 入口。
  SettingKeys.register({
    module:'editor',group:'粘贴图片 / 图床',
    read:()=>window.MdPasteImage?.readSetting?.()||{},
    write:v=>{if(!window.MdPasteImage?.writeSetting)return false;return window.MdPasteImage.writeSetting(v)!==false;},
    keys:{
      'pasteImage.mode':{type:'string',label:'图片保存位置',enum:['project','assets','custom','cos'],param:'mode',
        description:'project=项目根 assets；assets=笔记同目录 assets；custom=固定目录；cos=腾讯云对象存储'},
      'pasteImage.dir':{type:'string',label:'固定目录',optional:true,param:'dir',description:'mode=custom 时生效'},
      // 注意 value 与 param 都要显式写成 cos.xxx：readSetting() 返回的是嵌套结构
      // {mode,dir,cos:{secretId,...}}，只按末段取会拿到 undefined。
      'pasteImage.cos.secretId':{type:'string',label:'COS SecretId',secret:true,param:'cos.secretId',value:'cos.secretId',description:'只保存在本机，读取不回明文'},
      'pasteImage.cos.secretKey':{type:'string',label:'COS SecretKey',secret:true,param:'cos.secretKey',value:'cos.secretKey',description:'只保存在本机，读取不回明文'},
      'pasteImage.cos.bucket':{type:'string',label:'COS 存储桶',optional:true,pattern:'^[a-z0-9-]+-\\d+$',param:'cos.bucket',value:'cos.bucket',description:'形如 名称-APPID'},
      'pasteImage.cos.region':{type:'string',label:'COS 地域',optional:true,pattern:'^[a-z0-9-]+$',param:'cos.region',value:'cos.region',description:'形如 ap-beijing'},
      'pasteImage.cos.prefix':{type:'string',label:'COS 对象前缀',optional:true,param:'cos.prefix',value:'cos.prefix'},
      'pasteImage.cos.publicBase':{type:'string',label:'COS 自定义域名',optional:true,param:'cos.publicBase',value:'cos.publicBase'},
    },
  });

  // ---------- 状态 ----------
  const keys=['myide-theme','myide-custom-theme','myide-editor-font','myide-sidebar-width:v2','myide-ai-width:v2','myide-ai-open','myide-keys'];
  const stored=()=>Object.fromEntries(keys.map(k=>[k,localStorage.getItem(k)]));
  const restoreStorage=values=>{for(const [k,v]of Object.entries(values))if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v);};

  async function state(){
    // 注意：这里只放「可稳定比对」的字段。keyCount/modules 会随注册表变化，
    // 但它们是常量；真正不能进哈希的是各键的实时值（宽度会被窗口夹回去，
    // 只要哈希含它就必然误报 STATE_CHANGED）。键值统一由 settings_keys 读。
    return {theme:Theme.current(),custom:Theme.getCustom(),
      themes:['dark','light','pink','crimson','graphite',...Theme.getUserThemes().map(t=>'user:'+t.id)],
      fontSize:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size'))||13,
      layout:layoutRead(),shortcuts:Shortcuts.bindings(),stored:stored(),
      modules:SettingKeys.modules,
      allowed:{fontSize:[10,20],pages:['keys','markdown','appearance','editor','git','translate','ai','theme','local']}};
  }

  let previous=null;
  async function restore(change){
    if(!change)F('NOTHING_TO_RESTORE','没有本接口的上一次变更');
    // 逐字段比对，把「到底哪变了」带回错误里：只报 STATE_CHANGED 时现场无从下手
    const now=await state();
    if(await W.stateHash(now)!==change.after){
      const was=change.afterState||{};
      const changed=[...new Set([...Object.keys(now),...Object.keys(was)])]
        .filter(k=>JSON.stringify(now[k])!==JSON.stringify(was[k]));
      F('STATE_CHANGED','设置已有后续变更（'+changed.join('、')+'），未覆盖');
    }
    const p=change.before;
    Theme.set(p.theme);for(const [k,v]of Object.entries(p.custom||{}))if(v)Theme.pick(k,v);
    Viewer.applyFontSize(p.fontSize);
    document.getElementById('sidebar').style.width=p.layout.sidebarStyle??'';
    document.getElementById('ai-panel').style.width=p.layout.aiStyle??'';
    App.toggleSidebar(!p.layout.sidebarVisible);App.setAiOpen(p.layout.aiVisible);App.toggleRightSidebar(p.layout.rightCollapsed);
    restoreStorage(p.stored);Shortcuts.load();previous=null;
  }

  W.register('settings',{state,async operate(call,context){
    const a=call.args;
    // ---- 读侧：不带 snapshot、不要求审批 ----
    if(call.name==='settings_keys')return W.observe('settings',{keys:SettingKeys.list(a.module),modules:SettingKeys.modules});
    if(call.name==='settings_values'){
      // 快捷键按动作读：把 action 交给 read 上下文
      if(a.keys.some(k=>k.startsWith('shortcut.'))&&a.action)shortcutAction=String(a.action);
      return W.observe('settings',{values:SettingKeys.readValues(a.keys)});
    }

    // ---- 写侧：settings_write，需要主进程审批与快照校验 ----
    await W.checkpoint(call,context);
    if(a.operation==='open'){
      Settings.open(({appearance:'font',local:'storage'})[a.page]||a.page||'keys',a.filter);
      const box=document.getElementById('set-box');
      if(!box)F('DIALOG_BLOCKED','上层弹窗阻止打开设置');
      if(a.filter&&a.page!=='keys'){
        const target=[...box.querySelectorAll('label,.set-section-title,.set-row')].find(el=>el.textContent.includes(a.filter));
        target?.scrollIntoView({block:'center'});
      }
      return {ok:true,page:box.dataset.category,...(await state())};
    }
    if(a.operation==='restore'){await restore(previous);return {ok:true,committed:true,...(await state())};}
    if(!a.values)F('INVALID_TOOL_ARGS','缺少 values');

    const before=await state();
    await W.guard(call,context);
    // 走 aiAfterResult：设置写入会改界面（隐藏面板、改宽度），必须和旧的
    // settings_control 一样经 AI 运行队列串行执行，结果才带 accepted/job，
    // 面板隐藏前也能先把工具结果记进会话（self-hide 用例就是测这个）。
    const perform=async()=>{
      if(a.action&&(Object.hasOwn(a.values,'shortcut.combos')||Object.hasOwn(a.values,'shortcut.reset')))shortcutAction=String(a.action);
      const written=SettingKeys.writeValues(a.values);
      if(a.persistent===false)restoreStorage(before.stored);
      const actual=await state();previous={before,after:await W.stateHash(actual),afterState:actual};
      return {ok:true,committed:true,persistent:a.persistent!==false,values:written,...actual};
    };
    return AiPanel.aiAfterResult(call,context,perform);
  }});
})();

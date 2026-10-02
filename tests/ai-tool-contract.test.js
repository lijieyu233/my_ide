const assert=require('assert/strict'),path=require('path');
const C=require('../ai-tool-contract'); let passed=0;
const call=(name,args,id='call-1')=>({id,name,args});
function test(name,fn){fn();passed++;console.log('  ok '+name);}
const rejects=fn=>assert.throws(fn,e=>e.code==='INVALID_TOOL_ARGS');
test('六种工具完整字段可用，list默认根，保留正文/命令原值',()=>{
  for(const [name,args] of [['list_files',{}],['read_file',{path:'./中文\\one.md'}],['search_files',{query:'  needle  '}],['write_file',{path:'one.md',content:''}],['replace_edit',{path:'one.md',search:' ',replace:'',replace_all:false}],['run_command',{command:'node --version'}]]){
    const r=C.validate(call(name,args)); assert.equal(r.name,name); assert(Object.isFrozen(r.args));
  }
  assert.equal(C.validate(call('list_files',{})).args.path,'.'); assert.equal(C.validate(call('search_files',{query:'  needle  '})).args.query,'  needle  ');
});
test('数字、null、数组、缺字段和未知字段均拒绝，不能降成空内容',()=>{
  for(const content of [0,null,[],{},false,undefined])rejects(()=>C.validate(call('write_file',{path:'one.md',content})));
  for(const args of [null,[],{}, {path:'one.md'},{path:'one.md',content:'x',encoding:'utf8'}])rejects(()=>C.validate(call('write_file',args)));
});
test('所有必填/可选字段严格检查，替换布尔不隐式转换',()=>{
  for(const [name,args] of [['read_file',{}],['list_files',{path:1}],['search_files',{query:3}],['search_files',{query:' '}],['run_command',{command:{}}],['run_command',{command:' '}],['replace_edit',{path:'a',search:'',replace:'b'}],['replace_edit',{path:'a',search:'b'}],['replace_edit',{path:'a',search:'b',replace:'c',replace_all:'false'}]])rejects(()=>C.validate(call(name,args)));
});
test('名称/id/调用形状不可伪造，不接原型和多余元数据',()=>{
  for(const id of ['', ' ', 'x'.repeat(201), 'bad\0id', 1])rejects(()=>C.validate(call('list_files',{},id)));
  for(const name of ['constructor','__proto__','unknown',1])rejects(()=>C.validate(call(name,{})));
  rejects(()=>C.validate({...call('list_files',{}),extra:true}));rejects(()=>C.validate(call('list_files',new Date())));
});
test('Windows驱动器/UNC/设备名/ADS/父段/尾点空格均拒绝',()=>{
  for(const p of ['../out','a/../out','C:\\a','C:a','\\\\server\\share','/etc/file','a:stream','a/CON.txt','LPT1','a.','a ','a\0b','a?b','.'])rejects(()=>C.validate(call('write_file',{path:p,content:'x'})));
  assert.equal(C.relativePath('.\\中文//file.md',false),'中文/file.md');
});
test('UTF8实际字节预算拦超长正文/搜索/命令且边界可用',()=>{
  C.validate(call('write_file',{path:'a',content:'x'.repeat(256*1024)}));
  rejects(()=>C.validate(call('write_file',{path:'a',content:'中'.repeat(100000)})));
  rejects(()=>C.validate(call('search_files',{query:'x'.repeat(4097)})));rejects(()=>C.validate(call('run_command',{command:'x'.repeat(8193)})));
});
test('主进程写入核对目标和正文，直接桥无调用也拒绝',()=>{
  const root=path.resolve('fixture'),target=path.join(root,'a.md'),c=call('write_file',{path:'a.md',content:'MODEL'});
  C.assertWrite(root,target,'MODEL',c); rejects(()=>C.assertWrite(root,target,'',c));rejects(()=>C.assertWrite(root,path.join(root,'b.md'),'MODEL',c));rejects(()=>C.assertWrite(root,target,'MODEL',undefined));
});
test('替换核对可靠原文/唯一匹配/replace_all和实际全文',()=>{
  const root=path.resolve('fixture'),p=path.join(root,'a.md'),c=call('replace_edit',{path:'a.md',search:'OLD',replace:'NEW'});
  C.assertWrite(root,p,'before NEW after',c,'before OLD after');rejects(()=>C.assertWrite(root,p,'NEW',c,'OTHER'));rejects(()=>C.assertWrite(root,p,'NEW NEW',c,'OLD OLD'));
  C.assertWrite(root,p,'NEW NEW',{...c,args:{...c.args,replace_all:true}},'OLD OLD');rejects(()=>C.assertWrite(root,p,'WRONG',c,'OLD'));
});
test('命令正文/cwd须对应调用，项目子目录不能冒充登记根',()=>{
  const root=path.resolve('fixture'),context={rootId:root},c=call('run_command',{command:'node --version'});
  C.assertCommand('node --version',root,context,c);rejects(()=>C.assertCommand('other',root,context,c));rejects(()=>C.assertCommand('node --version',path.join(root,'sub'),context,c));rejects(()=>C.assertCommand('node --version',root,context,null));
});
console.log('工具合同：'+passed+' 通过 / 0 失败');

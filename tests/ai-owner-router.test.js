const assert=require('assert/strict'),path=require('path');
const {createRouter}=require('../src/main/ai/ai-owner-router'),{createRegistry}=require('../src/main/ai/ai-runs');
const router=createRouter(),registry=createRegistry();
const a={requestId:'a',rootId:path.resolve('A'),sessionId:'a-chat',generation:1,round:0};
const b={...a,requestId:'b',rootId:path.resolve('B'),sessionId:'b-chat',generation:3};
const oa=router.register(1,a,'dsh'),ob=router.register(1,b,'dsh');
assert.notEqual(oa,ob);assert.equal(router.host(oa),1);assert.equal(router.owner(1,a),oa);
registry.begin(oa,a);registry.begin(ob,b);registry.assert(oa,a);registry.assert(ob,b);
registry.finish(ob,b,'cancelled');registry.assert(oa,a);
assert.throws(()=>registry.assert(ob,b),{code:'CANCELLED_AI_REQUEST'});
assert.throws(()=>registry.assert(oa,{...a,rootId:b.rootId}),{code:'CANCELLED_AI_REQUEST'});
assert.throws(()=>router.register(1,{...a,rootId:b.rootId},'dsh'));
assert.throws(()=>router.register(1,{...a,requestId:'invalid',rootId:'relative-root'},'dsh'),{code:'INVALID_AI_REQUEST'});
const preapproval=router.owner(1,{engine:'dsh',rootId:a.rootId,sessionId:a.sessionId});assert.equal(preapproval,oa);
assert.equal(router.register(2,a,'dsh'),JSON.stringify([2,'dsh',a.rootId,a.sessionId]));
assert(router.reset(1).includes(oa));assert.equal(router.owner(1,a),1);assert.notEqual(router.owner(2,a),2);

const isolation=createRouter(),runs=createRegistry(),contexts=new Map(),owners=new Map();
for(const engine of ['standard','dsh','codex']){
  for(const project of ['A','B']){
    const context={...a,rootId:path.resolve(project),sessionId:'same-local-id',requestId:engine+'-'+project,generation:project==='A'?10:20};
    const owner=isolation.register(10,context,engine);contexts.set(engine+project,context);owners.set(engine+project,owner);
    runs.begin(owner,context);assert.equal(isolation.engine(10,context),engine);
    assert.equal(isolation.owner(10,{engine,rootId:context.rootId,sessionId:context.sessionId}),owner);
  }
}
assert.equal(owners.get('standardA'),10);assert.equal(owners.get('standardB'),10);
assert.equal(isolation.register(11,{...a,requestId:'implicit'}),11);
assert.equal(isolation.owner(11,{rootId:a.rootId,sessionId:a.sessionId}),11);
assert.equal(new Set(owners.values()).size,5,'两原生引擎各隔离两个项目；普通助手保持宿主单账本');
for(const engine of ['dsh','codex'])for(const project of ['A','B'])runs.assert(owners.get(engine+project),contexts.get(engine+project));
const codex=contexts.get('codexA'),codexOwner=owners.get('codexA'),nextRound={...codex,round:1};
runs.begin(codexOwner,nextRound);
assert.throws(()=>runs.assert(codexOwner,codex),{code:'CANCELLED_AI_REQUEST'});
assert.throws(()=>runs.begin(codexOwner,codex),{code:'STALE_AI_REQUEST'});
for(const key of ['dshA','dshB','codexB'])runs.assert(owners.get(key),contexts.get(key));
runs.finish(codexOwner,nextRound,'cancelled');
for(const key of ['dshA','dshB','codexB'])runs.assert(owners.get(key),contexts.get(key));
assert.throws(()=>isolation.register(10,{...codex,round:1},'dsh'));
assert.throws(()=>isolation.owner(10,{...codex,engine:'dsh'}));
assert.throws(()=>isolation.register(10,{...a,requestId:'unknown'},'other'),{code:'INVALID_AI_ENGINE'});
assert.throws(()=>isolation.owner(10,{engine:'other',rootId:a.rootId,sessionId:a.sessionId}),{code:'INVALID_AI_ENGINE'});
assert.throws(()=>isolation.owner(10,{engine:'codex',rootId:'relative',sessionId:a.sessionId}),{code:'INVALID_AI_REQUEST'});
const reset=isolation.reset(10);assert.equal(new Set(reset).size,5);assert(reset.includes(codexOwner));
assert.equal(isolation.engine(10,codex),undefined);assert.equal(isolation.host(codexOwner),codexOwner);
assert.equal(isolation.owner(11,{requestId:'implicit'}),11);
console.log('AI项目运行归属：三引擎、双项目、无请求授权、旧轮次拒绝与宿主清理通过');

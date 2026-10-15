const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {createService}=require('../src/main/db/ai-query-jobs'),{statement}=require('../src/main/db/ai-query-worker');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'myide-ai-database-')),file=path.join(directory,'fixture.sqlite'),context={rootId:directory,sessionId:'fixture'};
const pause=()=>new Promise(r=>setTimeout(r,25));
async function wait(service,id){for(let i=0;i<400;i++){const r=await service.operate(context,{name:'database_job',args:{operation:'read',job:id}},null,()=>{});if(r.job.state!=='running')return r.job;await pause();}throw Error('查询未结算');}
(async()=>{const SQL=await require('sql.js')(),db=new SQL.Database();db.run('CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO items(value) VALUES (\'原值\')');fs.writeFileSync(file,db.export());db.close();
  const service=createService({configuration:()=>({type:'sqlite',file})});
  assert.throws(()=>statement('SELECT 1; DELETE FROM items',false));assert.throws(()=>statement('WITH x AS (SELECT 1) DELETE FROM items',false));
  let r=await service.operate(context,{name:'database_query',args:{sql:'SELECT * FROM items'}},'fixture',()=>{}),job=await wait(service,r.job.id);assert.equal(job.state,'completed');assert.equal(job.rows[0].value,'原值');
  r=await service.operate(context,{name:'database_query',args:{sql:'UPDATE items SET value=?',params:['已写入'],write:true}},'fixture',()=>{});job=await wait(service,r.job.id);assert.equal(job.state,'completed',job.error);assert(job.committed);let actual=new SQL.Database(fs.readFileSync(file));assert.equal(actual.exec('SELECT value FROM items')[0].values[0][0],'已写入');actual.close();
  const exported=await service.operate(context,{name:'database_job',args:{operation:'export',job:r.job.id,destination:'result.json'}},null,()=>{});assert(exported.ok);assert.equal(JSON.parse(fs.readFileSync(exported.path,'utf8')).rows.length,0);await assert.rejects(service.operate(context,{name:'database_job',args:{operation:'export',job:r.job.id,destination:'result.json'}},null,()=>{}),/变化|创建/);
  let allowed=true;r=await service.operate(context,{name:'database_query',args:{sql:'UPDATE items SET value=\'禁止\'',write:true}},'fixture',()=>{if(!allowed)throw Error('任务已取消');});allowed=false;job=await wait(service,r.job.id);assert.equal(job.state,'failed');actual=new SQL.Database(fs.readFileSync(file));assert.equal(actual.exec('SELECT value FROM items')[0].values[0][0],'已写入');actual.close();
  r=await service.operate(context,{name:'database_query',args:{sql:'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n'}},'fixture',()=>{});await service.operate(context,{name:'database_job',args:{operation:'cancel',job:r.job.id}},null,()=>{});assert.equal((await wait(service,r.job.id)).state,'cancelled');
  await assert.rejects(service.operate({...context,sessionId:'other'},{name:'database_job',args:{operation:'read',job:r.job.id}},null,()=>{}),/不属于/);
  console.log('数据库AI：SQL限制、真实只读/写入、取消前发布校验、无限查询取消、会话隔离通过');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{try{fs.rmSync(directory,{recursive:true,force:true});}catch{}});

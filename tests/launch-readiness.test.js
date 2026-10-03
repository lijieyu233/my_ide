const assert=require('assert/strict'),{normalizeRule,createObservation}=require('../launch-readiness');let count=0;
const test=(name,run)=>{run();count++;console.log('ok '+name);};
test('缺省/无需验证不伪造已就绪；规则类型、文本、端口、超时和USB边界在执行前拒绝',()=>{
  assert.deepEqual(normalizeRule({}),{mode:'none'});assert.equal(createObservation({mode:'none'},'r').snapshot().state,'none');
  for(const readiness of [7,[],{mode:'bad'},{mode:'output',text:''},{mode:'output',text:'a\nb'},{mode:'output',text:'x'.repeat(257)},{mode:'output',text:'ok',timeoutSeconds:0},{mode:'output',text:'ok',timeoutSeconds:1.5},{mode:'port'}])assert.throws(()=>normalizeRule({readiness}));
  assert.throws(()=>normalizeRule({kind:'usb-tunnel',readiness:{mode:'output',text:'done'}}));assert.equal(normalizeRule({port:3000,readiness:{mode:'port'}}).port,3000);
});
test('分片UTF16文本在同一输出流中匹配；大小写/系统回显/跨流/跨行都不误认',()=>{
  let time=0;const obs=createObservation({mode:'output',text:'就绪🙂',timeoutSeconds:3},'a',()=>time);
  obs.observe('system','就绪🙂');obs.observe('stdout','就绪');obs.observe('stderr','🙂');assert.equal(obs.snapshot().state,'waiting');
  obs.observe('stdout','\n🙂');assert.equal(obs.snapshot().state,'waiting');obs.observe('stderr','就绪\ud83d');obs.observe('stderr','\ude42');assert.equal(obs.snapshot().state,'ready');
  const other=createObservation({mode:'output',text:'READY',timeoutSeconds:3},'b',()=>time);other.observe('stdout','ready');assert.equal(other.snapshot().state,'waiting');
});
test('超时有界、迟到输出不变成功、时钟回退不延长等待；规则快照不随配置对象变动',()=>{
  let time=0;const raw={mode:'output',text:'ready',timeoutSeconds:2},obs=createObservation(raw,'r',()=>time);raw.text='different';time=1999;assert.equal(obs.snapshot().state,'waiting');time=2000;assert.equal(obs.snapshot().state,'timed-out');time=-500;obs.observe('stdout','ready');assert.equal(obs.snapshot().state,'timed-out');
});
test('端口仍响应才显示当前就绪，失去响应明确不可用而不杀进程；同运行可重新响应',()=>{
  let time=0;const obs=createObservation({mode:'port',port:3000,timeoutSeconds:2},'r',()=>time);
  assert.equal(obs.snapshot(false).state,'waiting');time=100;assert.equal(obs.snapshot(true).state,'ready');time=3000;assert.equal(obs.snapshot(false).state,'unavailable');assert.equal(obs.snapshot(true).state,'ready');
  const late=createObservation({mode:'port',port:3000,timeoutSeconds:1},'late',()=>time);time=4000;assert.equal(late.snapshot(true).state,'timed-out');
});
console.log('就绪观察：'+count+' 通过 / 0 失败');

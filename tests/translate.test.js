const assert=require('assert/strict'),fs=require('fs'),path=require('path'),{JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../renderer/translate.js'),'utf8');let passed=0;
function fixture(){const dom=new JSDOM('<div id="mask"></div>',{url:'http://fixture.invalid',runScripts:'outside-only'}),w=dom.window,calls=[],pending=[],keys=[];
  w.MI={toast(){},copyText:async text=>calls.push({copied:text})};w.Settings={open(){}};
  w.Modal={stack:[],show(box){this.stack.push(box);w.document.getElementById('mask').append(box);},hide(){this.stack.pop()?.remove();}};
  w.Shortcuts={register(){},bindings:()=>[{id:'translate',effectiveCombos:['ctrl+alt+t']}],onChanged:fn=>{w.keysChanged=fn;}};
  w.myIDE={browser:{setTranslationKeys:async k=>keys.push(k)},llm:{chat:(cfg,messages)=>{calls.push({cfg,messages});return new Promise(resolve=>pending.push(resolve));}}};
  w.AiPanel={PROVIDERS:[{id:'fixture',name:'厂商',baseUrl:'http://provider.invalid/v1',models:['model']}]};w.eval(source);
  return {dom,w,api:w.Translate,calls,pending,keys,q:s=>w.document.querySelector(s),change(s,value){const e=this.q(s);e.value=value;e.dispatchEvent(new w.Event('change'));},tick:()=>new Promise(r=>setImmediate(r))};
}
async function test(name,fn){await fn();passed++;console.log('ok '+name);}
(async()=>{
  await test('旧单服务配置无损迁移，多配置切换分别保留Key和模型，重载仍生效',async()=>{const f=fixture();try{
    f.api.setConfig({baseUrl:'http://old.invalid/v1',apiKey:'test-only',model:'old',target:'法文'});
    const profiles=f.api.getProfiles();assert.equal(profiles[0].apiKey,'test-only');profiles.push({id:'new',name:'新服务',baseUrl:'http://new.invalid/v1',apiKey:'second',model:'new'});
    f.api.saveProfiles(profiles,'new');assert.equal(f.api.getConfig().model,'new');f.api.selectProfile('legacy');assert.equal(f.api.getConfig().apiKey,'test-only');assert.equal(f.api.getConfig().target,'法文');
    f.w.eval(source);assert.equal(f.api.getConfig().model,'old');assert.equal(f.api.getProfiles().length,2);assert.equal(f.keys.length,2);
  }finally{f.dom.window.close();}});
  await test('语言/厂商切换发起新翻译，旧响应与关闭后响应不污染当前结果',async()=>{const f=fixture();try{
    f.api.saveProfiles([{id:'a',name:'甲',baseUrl:'http://a.invalid',model:'a'},{id:'b',name:'乙',baseUrl:'http://b.invalid',model:'b'}],'a');
    f.api.run('granite');assert.equal(f.pending.length,1);f.change('#tr-target','日文');assert.equal(f.pending.length,2);assert(f.calls[1].messages[0].content.includes('日文'));
    f.change('#tr-source','英文');f.change('#tr-provider','b');assert.equal(f.calls.at(-1).cfg.model,'b');assert(f.calls.at(-1).messages[0].content.includes('原文语言是英文'));
    f.pending[0]({text:'旧结果'});await f.tick();assert(!f.q('#tr-dst').textContent.includes('旧结果'));
    f.pending.at(-1)({text:'新结果'});await f.tick();assert.equal(f.q('#tr-dst').textContent,'新结果');
    f.api.closeBox();f.api.run('new');f.pending[1]({text:'迟到'});await f.tick();assert(!f.q('#tr-dst').textContent.includes('迟到'));
    f.pending.at(-1)({error:'测试失败'});await f.tick();f.q('#tr-copy').click();assert(!f.calls.some(c=>c.copied));
  }finally{f.dom.window.close();}});
  await test('原文编辑使在途译文失效，无选区也能打开，语言支持自定义值',async()=>{const f=fixture();try{
    f.api.setConfig({baseUrl:'http://a.invalid',model:'a'});f.api.run('old');f.q('#tr-src').value='edited';f.q('#tr-src').dispatchEvent(new f.w.Event('input'));f.pending[0]({text:'old translation'});await f.tick();assert.equal(f.q('#tr-dst').textContent,'');assert(!f.q('#tr-do').disabled);
    f.change('#tr-target','繁体中文');assert.equal(f.api.getConfig().target,'繁体中文');f.api.closeBox();f.api.run('');assert.equal(f.q('#tr-src').value,'');
  }finally{f.dom.window.close();}});
  await test('网页快捷键匹配完整修饰键并跟随改键/解绑，IME与重复按键不触发',async()=>{
    const wc=new(require('events').EventEmitter)(),translated=[];let keys=['ctrl+alt+t'],prevented=0,script;
    wc.isDestroyed=()=>false;wc.executeJavaScript=async value=>{script=value;return '';};
    require('../browser-context-menu').bindTranslationShortcut(wc,{getKeys:()=>keys,translate:value=>translated.push(value)});
    const send=input=>wc.emit('before-input-event',{preventDefault:()=>prevented++},{type:'keyDown',key:'t',control:true,alt:true,...input});
    send({shift:true});send({isComposing:true});send({isAutoRepeat:true});assert.equal(prevented,0);send({});await new Promise(r=>setImmediate(r));assert.deepEqual(translated,['']);assert(script.includes("e.type==='password'"));
    keys=['ctrl+alt+y'];send({});assert.equal(prevented,1);send({key:'y'});await new Promise(r=>setImmediate(r));assert.equal(prevented,2);
    keys=[];send({key:'y'});assert.equal(prevented,2);
  });
  console.log('翻译：'+passed+' 通过 / 0 失败');
})().catch(e=>{console.error(e);process.exitCode=1;});

const assert=require('assert/strict'),{EventEmitter}=require('events'),{createService}=require('../browser-color-scheme');
(async()=>{
 const theme=new EventEmitter();theme.shouldUseDarkColors=false;theme.themeSource='system';const errors=[],service=createService({nativeTheme:theme,onError:e=>errors.push(e)});
 assert((await service.set('dark')).pending);const wc=new EventEmitter(),commands=[];let attached=false;
 wc.isDestroyed=()=>false;wc.debugger={isAttached:()=>attached,attach:()=>attached=true,sendCommand:async(name,args)=>commands.push({name,args})};service.bind(wc);
 await service.set('dark');assert.equal(commands.at(-1).args.enabled,true);assert.equal(commands.at(-2).args.features[0].value,'dark');assert.equal(theme.themeSource,'system');
 await service.set('light');assert.equal(commands.at(-1).args.enabled,false);assert.equal(commands.at(-2).args.features[0].value,'light');
 await service.set('system');assert.equal(commands.at(-1).args.enabled,false);assert.equal(commands.at(-2).args.features[0].value,'');
 theme.shouldUseDarkColors=true;theme.emit('updated');await service.set('system');assert.equal(commands.at(-1).args.enabled,true);
 attached=false;wc.emit('dom-ready');await service.set('dark');assert(attached);assert.equal(commands.at(-1).args.enabled,true);
 await Promise.all([service.set('dark'),service.set('light'),service.set('dark'),service.set('light')]);assert.equal(commands.at(-1).args.enabled,false);
 wc.debugger.sendCommand=async()=>{throw Error('protocol failed');};wc.emit('did-finish-load');await new Promise(r=>setImmediate(r));assert.equal(errors.length,1);
 await assert.rejects(service.set('dark'),/protocol failed/);service.dispose();assert.equal(theme.listenerCount('updated'),0);
 console.log('网页深色：三态、独立视图、重导航、快速切换和错误反馈通过');
})().catch(e=>{console.error(e);process.exitCode=1;});

const assert=require('assert/strict'),{EventEmitter}=require('events'),{createService}=require('../browser-fullscreen');let passed=0;
function fixture(original=false,headless=false){const win=new EventEmitter(),calls=[],states=[];Object.assign(win,{native:original,isDestroyed:()=>false,isFullScreen(){return this.native;},setFullScreen(value){calls.push(value);this.native=value;},webContents:{send:(_ch,state)=>states.push(state)}});return {win,calls,states,service:createService({getWindow:()=>win,headless})};}
function test(name,fn){fn();passed++;console.log('ok '+name);}
test('进入退出恢复原生窗口模式，重复操作不重复切换',()=>{const f=fixture();assert(f.service.set(true).fullscreen);f.service.set(true);assert.deepEqual(f.calls,[true]);assert.equal(f.service.set(false).fullscreen,false);assert.deepEqual(f.calls,[true,false]);assert.equal(f.states.at(-1).fullscreen,false);});
test('原先已全屏的窗口退出浏览器专注显示后仍保持原生全屏',()=>{const f=fixture(true);f.service.set(true);f.service.set(false);assert(f.win.native);assert.deepEqual(f.calls,[true,true]);});
test('系统退出全屏同步状态，窗口关闭重置临时模式',()=>{const f=fixture();f.service.set(true);f.win.emit('leave-full-screen');assert(!f.service.active);assert.equal(f.states.at(-1).fullscreen,false);f.service.set(true);f.win.emit('closed');assert(!f.service.active);});
test('隐藏验证只改变浏览器布局，不改变桌面模式或显示窗口',()=>{const f=fixture(false,true);f.service.set(true);assert(f.service.active);f.service.set(false);assert.equal(f.calls.length,0);});
test('原生切换失败不保留虚假全屏状态，非法参数拒绝',()=>{const f=fixture();f.win.setFullScreen=()=>{throw Error('失败');};assert.throws(()=>f.service.set(true));assert(!f.service.active);assert.throws(()=>f.service.set('true'));});
console.log('浏览器全屏：'+passed+' 通过 / 0 失败');

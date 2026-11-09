const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../src/main/git/git-native.js'),'utf8');
function functionSource(name){const start=source.indexOf('async function '+name+'('),end=source.indexOf('\n}',start);assert(start>=0&&end>start);return source.slice(start,end+2);}
function fixture(replies){const calls=[],context={NO_EDIT:{GIT_OPTIONAL_LOCKS:'0'},setTimeout:fn=>setImmediate(fn),run:async(args,opts)=>{calls.push({args,opts});return replies.shift()||{ok:true,stdout:'',stderr:'',error:''};}};vm.createContext(context);vm.runInContext(functionSource('runRetry')+'\n'+functionSource('addPath')+'\nthis.add=addPath;',context);return {calls,add:context.add};}
const fail={ok:false,stdout:'',stderr:'',error:'offline transient read failure'},pass=stdout=>({ok:true,stdout,stderr:'',error:''});
(async()=>{
 let f=fixture([fail,pass('tracked.txt\0'),pass('')]);assert((await f.add('synthetic-root','tracked.txt',true)).ok);assert.equal(f.calls.length,3);assert(f.calls[0].args.includes('ls-files'));assert(f.calls[1].args.includes('ls-files'));assert(f.calls[2].args.includes('--renormalize'));assert(f.calls[2].args.includes('--force'));
 f=fixture([fail,fail]);assert.equal((await f.add('synthetic-root','tracked.txt',true)).ok,false);assert.equal(f.calls.length,2);assert(f.calls.every(call=>call.args.includes('ls-files')));
 f=fixture([fail,pass(''),pass('')]);assert((await f.add('synthetic-root','-literal[1].txt',false)).ok);assert.equal(f.calls.length,3);assert(!f.calls[2].args.includes('--renormalize'));assert(!f.calls[2].args.includes('--force'));assert.equal(f.calls[2].args.at(-2),'--');assert.equal(f.calls[2].args.at(-1),'-literal[1].txt');
 console.log('暂存前只读查询：瞬时重试、持久失败不写入、未跟踪/字面路径/force语义 3组通过');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});

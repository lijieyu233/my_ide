const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),git=require('isomorphic-git');
const G=require('../src/main/git/git-service'),N=require('../src/main/git/git-native');
(async()=>{
 const parent=path.resolve('.ui-check-trash'),root=fs.mkdtempSync(path.join(parent,'git-ahead-')),file='note.txt',author={name:'Fixture',email:'fixture@example.invalid'};
 const run=N.run,read=git.readCommit;let remoteReads=0,commitReads=0;
 try{
  await git.init({fs,dir:root,defaultBranch:'main'});fs.writeFileSync(path.join(root,file),'first');await git.add({fs,dir:root,filepath:file});const first=await git.commit({fs,dir:root,message:'first',author});await git.addRemote({fs,dir:root,remote:'origin',url:'https://example.invalid/repo.git'});
  N.run=async args=>{if(args[0]==='ls-remote'){remoteReads++;throw Error('日常刷新不允许触网');}return run(args,{cwd:root});};
  const absent=await G.aheadBehind(root,{localOnly:true});assert.equal(absent.ahead,null);assert.equal(remoteReads,0);console.log('ok 远程引用缺失时返回未知，不隐式ls-remote');
  await git.writeRef({fs,dir:root,ref:'refs/remotes/origin/main',value:first,force:true});fs.writeFileSync(path.join(root,file),'second');await git.add({fs,dir:root,filepath:file});await git.commit({fs,dir:root,message:'second',author});
  git.readCommit=async args=>{commitReads++;return read(args);};const changed=await G.aheadBehind(root,{localOnly:true});assert.equal(changed.ahead,1);assert.equal(changed.behind,0);const before=commitReads;assert(before>0);
  const cached=await G.aheadBehind(root,{localOnly:true});assert.equal(cached.ahead,1);assert.equal(commitReads,before);console.log('ok 引用相同时复用提交计数，不重复走历史');
  fs.writeFileSync(path.join(root,file),'third');await git.add({fs,dir:root,filepath:file});await git.commit({fs,dir:root,message:'third',author});const newer=await G.aheadBehind(root,{localOnly:true});assert.equal(newer.ahead,2);assert(commitReads>before);assert.equal(remoteReads,0);console.log('ok HEAD改变后重新计算，仍不联网');
  await git.deleteRef({fs,dir:root,ref:'refs/remotes/origin/main'});fs.writeFileSync(path.join(root,'.git/FETCH_HEAD'),first+"\t\tbranch 'main' of https://example.invalid/repo.git\n");const fetched=await G.aheadBehind(root,{localOnly:true});assert.equal(fetched.ahead,2);assert.equal(remoteReads,0);console.log('ok 本地FETCH_HEAD回落保留且不触网');
  console.log('Git本地提交计数 4 通过 / 0 失败');
 }finally{N.run=run;git.readCommit=read;if(path.dirname(root)!==parent)throw Error('Unsafe cleanup');fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});

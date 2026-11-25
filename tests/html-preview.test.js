const assert=require('assert/strict'),fs=require('fs/promises'),os=require('os'),path=require('path');
const {createService}=require('../src/main/browser/html-preview');
(async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'myide-html-test-')),root=path.join(temp,'project'),file=path.join(root,'pages','中文 #100%.html'),service=createService();let passed=0;
  const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
  const request=url=>({url,method:'GET'});
  try{
    await fs.mkdir(path.dirname(file),{recursive:true});await fs.mkdir(path.join(root,'assets'));
    await fs.writeFile(file,'磁盘版本');await fs.writeFile(path.join(root,'assets','site.css'),'body{color:red}');await fs.writeFile(path.join(root,'assets','module.mjs'),'export const ready=true;');await fs.writeFile(path.join(temp,'private.txt'),'不可访问');
    let lease;
    await test('超过8MB的磁盘HTML直接预览，含图片脚本且不写回文件',async()=>{
      const big=path.join(root,'pages','large.html'),raw='<!doctype html><h1>大型HTML</h1><img src="../assets/pixel.svg"><script>window.ready=true;</script><!--'+'x'.repeat(9*1024*1024)+'-->';
      await fs.writeFile(big,raw);await fs.writeFile(path.join(root,'assets','pixel.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
      const disk=await service.open(1,{path:big,root,disk:true});const response=await service.handle(request(disk.url)),body=await response.text();
      assert.equal(response.status,200);assert(/^<!doctype html>/i.test(body));assert(body.includes('window.ready=true'));assert(body.includes('__myideKey'));assert.equal(await fs.readFile(big,'utf8'),raw);
      assert.equal((await service.handle(request(new URL('../assets/pixel.svg',disk.url).href))).status,200);service.close(1,disk.id);
    });
    await test('磁盘预览正确解码UTF16 HTML，不能将普通文件伪装成HTML入口',async()=>{
      const utf=path.join(root,'pages','utf16.htm');await fs.writeFile(utf,Buffer.concat([Buffer.from([255,254]),Buffer.from('<!doctype html><h1>中文页面</h1>','utf16le')]));
      const disk=await service.open(1,{path:utf,root,disk:true});assert((await (await service.handle(request(disk.url))).text()).includes('中文页面'));
      await assert.rejects(service.open(1,{path:path.join(root,'assets','site.css'),disk:true}));service.close(1,disk.id);
    });
    await test('编码路径与未保存内容原样预览',async()=>{lease=await service.open(1,{path:file,root,content:'<!doctype html><h1>未保存版本</h1>'});const result=await service.handle(request(lease.url));assert.equal(result.status,200);assert((await result.text()).includes('未保存版本'));assert.equal(new URL(lease.url).hash,'');assert.equal(await fs.readFile(file,'utf8'),'磁盘版本');});
    await test('相对CSS与模块脚本按HTML所在目录加载且MIME正确',async()=>{const css=await service.handle(request(new URL('../assets/site.css',lease.url).href));assert.equal(css.status,200);assert.match(css.headers.get('Content-Type'),/^text\/css/);assert.equal(await css.text(),'body{color:red}');const module=await service.handle(request(new URL('../assets/module.mjs',lease.url).href));assert.match(module.headers.get('Content-Type'),/^text\/javascript/);});
    await test('编码遍历、反斜杠和盘符不能越界',async()=>{for(const suffix of ['/%2e%2e%2fprivate.txt','/%5c..%5cprivate.txt','/C%3a/private.txt']){const result=await service.handle(request('myide-preview://'+lease.id+suffix));assert([403,404].includes(result.status));}});
    await test('符号链接不能逃出项目',async()=>{await fs.symlink(temp,path.join(root,'outside'),'junction');assert.equal((await service.handle(request('myide-preview://'+lease.id+'/outside/private.txt'))).status,403);});
    await test('独立源与所有者隔离，释放后无法继续读取',async()=>{const second=await service.open(2,{path:file,root,content:'第二次预览'});assert.notEqual(new URL(second.url).hostname,new URL(lease.url).hostname);service.close(2,lease.id);assert.equal((await service.handle(request(lease.url))).status,200);service.close(1,lease.id);assert.equal((await service.handle(request(lease.url))).status,404);service.clear(2);assert.equal((await service.handle(request(second.url))).status,404);});
    await test('禁止写方法和无效HTML入口',async()=>{assert.equal((await service.handle({url:lease.url,method:'POST'})).status,405);await assert.rejects(service.open(1,{path:file,content:42}));await assert.rejects(service.open(1,{path:path.join(root,'assets','site.css'),content:'a'}));});
    await test('Codex 可视化可从会话工程的 artifacts 预览，并限制在单个 HTML 文件内',async()=>{
      const artifacts=path.join(root,'artifacts'), demo=path.join(artifacts,'voice session.html');
      const standardRoot=path.join(temp,'visualizations');
      const otherRoot=path.join(temp,'other-project'), otherArtifacts=path.join(otherRoot,'artifacts');
      await fs.mkdir(artifacts);await fs.mkdir(otherArtifacts,{recursive:true});
      await fs.writeFile(demo,'<!doctype html><button>查看详情</button><script>window.ready=true;</script>');
      const outside=path.join(otherArtifacts,'other.html');
      await fs.writeFile(outside,'<p>另一项目的演示</p>');
      const access=target=>service.open(1,{path:target,disk:true,visualization:true,root:otherRoot},standardRoot,async()=>root);
      const widget=await access(demo);
      const response=await service.handle(request(widget.url));
      assert.equal(response.status,200);
      assert.match(response.headers.get('Content-Security-Policy'),/sandbox allow-scripts/);
      assert.match(await response.text(),/查看详情/);
      await assert.rejects(access(file),/可视化文件路径无效/);
      await assert.rejects(access(outside),/可视化文件路径无效/);
      await fs.writeFile(path.join(artifacts,'sibling.html'),'<p>相邻文件</p>');
      assert.equal((await service.handle(request(new URL('sibling.html',widget.url).href))).status,403);
      const link=path.join(artifacts,'redirected');
      await fs.symlink(otherArtifacts,link,'junction');
      await assert.rejects(access(path.join(link,'other.html')),/可视化文件路径无效/);
      service.close(1,widget.id);
    });
    await test('Codex 可视化支持会话工程 outputs 下的演示，并拒绝其他工程和重定向目录',async()=>{
      const outputs=path.join(root,'outputs'), demo=path.join(outputs,'statistics-demo','index.html');
      await fs.mkdir(path.dirname(demo),{recursive:true});
      await fs.writeFile(demo,'<button id="snapshot">统计快照</button><script>window.ready=true;</script>');
      const access=(target, workspace)=>service.open(1,{path:target,disk:true,visualization:true},null,()=>workspace);
      const widget=await access(demo,root);
      const response=await service.handle(request(widget.url));
      assert.equal(response.status,200);
      assert.match(await response.text(),/统计快照/);
      assert.match(response.headers.get('Content-Security-Policy'),/default-src 'none'/);
      await assert.rejects(access(demo,temp),/可视化文件路径无效/);
      await assert.rejects(access(demo,''),/可视化文件路径无效/);
      const outside=path.join(temp,'other-project');
      await fs.symlink(outputs,path.join(outside,'outputs'),'junction');
      await assert.rejects(access(path.join(outside,'outputs','statistics-demo','index.html'),outside),/可视化文件路径无效/);
      service.close(1,widget.id);
    });
    console.log('HTML预览：'+passed+' 通过 / 0 失败');
  }finally{if(path.dirname(temp)!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-html-test-'))throw Error('清理越界');await fs.rm(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});

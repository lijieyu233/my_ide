const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const {build, pages, base, linkFor} = require('../scripts/build-docs');
const root = path.resolve(__dirname, '..');
const result = build();
let checks = 0, sourceLinks = 0, siteLinks = 0;
const pass = name => { checks++; console.log('PASS '+name); };
const sourceFiles = [...pages.map(p=>p[0]), 'docs/discoverability.md', 'SECURITY.md'];
for (const source of sourceFiles) {
  const text = fs.readFileSync(path.join(root, source), 'utf8');
  assert(!text.includes('\uFFFD'), 'invalid UTF8 '+source);
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1];
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) continue;
    const target = path.resolve(root, path.dirname(source), decodeURIComponent(href.split('#')[0]));
    assert(fs.existsSync(target), source+' -> '+href);
    sourceLinks++;
  }
}
pass('用户文档、许可与发布入口的本地链接均存在（'+sourceLinks+'）');
assert.equal(linkFor('docs/features.md','ai-guide.md#setup'),'ai-guide.html#setup');
assert.equal(linkFor('README.md','docs/开发文档-171-AI操作接口模块清单.md'),'https://github.com/lijieyu233/my_ide/blob/dev/docs/'+encodeURIComponent('开发文档-171-AI操作接口模块清单.md'));
assert.equal(linkFor('README.md','https://example.org/file.md'),'https://example.org/file.md');
pass('站内相对链接、中文源码链接与外部地址区分正确');
const titles = new Set(), descriptions = new Set();
for (const [,file] of pages) {
  const dom = new JSDOM(fs.readFileSync(path.join(result.out,file),'utf8'));
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('h1').length,1,file+' h1');
  const title = doc.title, description = doc.querySelector('meta[name="description"]').content;
  assert(title && !titles.has(title),file+' unique title');titles.add(title);
  assert(description && !descriptions.has(description),file+' unique description');descriptions.add(description);
  assert.equal(doc.querySelector('link[rel="canonical"]').href,base+file);
  assert(doc.querySelector('a[aria-current="page"]') || !['index.html','features.html'].includes(file));
  for (const el of doc.querySelectorAll('a[href],img[src],link[rel="stylesheet"]')) {
    const href = el.getAttribute(el.tagName==='IMG'?'src':'href');
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) continue;
    const [target,fragment] = href.split('#');
    const resolved = path.join(result.out, decodeURIComponent(target));
    assert(fs.existsSync(resolved),file+' -> '+href);
    if(fragment && target.endsWith('.html')){
      const targetDom=new JSDOM(fs.readFileSync(resolved,'utf8'));
      assert(targetDom.window.document.getElementById(fragment),file+' missing fragment '+href);
      targetDom.window.close();
    }
    siteLinks++;
  }
  for(const script of doc.querySelectorAll('script')){
    assert.equal(script.type,'application/ld+json','无追踪或隐藏提示脚本');
    assert.equal(JSON.parse(script.textContent).name,'MyIDE');
  }
  for(const table of doc.querySelectorAll('table')){
    const columns=table.querySelectorAll('thead th').length;
    for(const row of table.querySelectorAll('tbody tr'))assert.equal(row.children.length,columns,file+' table');
  }
  dom.window.close();
}
pass('13页服务端HTML、唯一标题/描述、canonical、导航、锚点与资源有效（'+siteLinks+'）');
const home = new JSDOM(fs.readFileSync(path.join(result.out,'index.html'),'utf8'));
assert(home.window.document.querySelector('link[hreflang="en"]'));
assert(home.window.document.querySelector('main').textContent.includes('SSH/SFTP'));
assert(home.window.document.querySelector('main').textContent.includes('数据库'));
assert(![...home.window.document.querySelectorAll('h2,h3')].some(h=>/分屏|双视图/.test(h.textContent)));
home.window.close();
pass('首页保留核心工具与双语入口，分屏归入编辑细节');
const sitemap = fs.readFileSync(path.join(result.out,'sitemap.xml'),'utf8');
assert.equal((sitemap.match(/<url>/g)||[]).length,pages.length);
assert(fs.readFileSync(path.join(result.out,'robots.txt'),'utf8').includes(base+'sitemap.xml'));
assert(!fs.existsSync(path.join(result.out,'开发文档-171-AI操作接口模块清单.html')));
assert(!fs.existsSync(path.join(result.out,'AGENTS.html')));
assert.throws(()=>build(root),/输出目录/);
pass('sitemap覆盖公开页，历史资料不复制，错误输出目录拒绝');
const tools = require('../renderer/ai-workbench-tools');
const api = fs.readFileSync(path.join(root,'docs/ai-api.md'),'utf8');
for(const block of api.matchAll(/~~~json\s*([\s\S]*?)~~~/g)){
  const call=JSON.parse(block[1]);tools.validateCall(call);
}
pass('AI示例通过真实工具schema校验');
console.log('文档站：'+checks+' 组通过 / 0 失败');

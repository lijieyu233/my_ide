// 只发布明确列出的用户指南；历史开发记录和工作区产物不进入公开站点。
const fs = require('fs');
const path = require('path');
const { Marked } = require('marked');
const root = path.resolve(__dirname, '..');
const base = 'https://lijieyu233.github.io/my_ide/';
const repo = 'https://github.com/lijieyu233/my_ide';
const pages = [
  ['README.md', 'index.html', 'MyIDE — AI 驱动的本地工作台', 'AI 助手连接本地文档、代码、网页、Git、SSH 和数据库工具的 Windows 工作台。', 'zh-CN'],
  ['README.en.md', 'en.html', 'MyIDE — AI-powered local workspace', 'An open-source Windows workspace connecting AI with project documents, code, web research, Git, SSH and database tools.', 'en'],
  ['docs/README.md', 'docs.html', 'MyIDE 用户文档', '按工作流和模块查阅 MyIDE 用户指南、AI 配置与开发资料。'],
  ['docs/getting-started.md', 'getting-started.html', '下载与开始使用 MyIDE', 'Windows 便携版、源码运行、首次使用与常见问题。'],
  ['docs/workflows.md', 'workflows.html', 'MyIDE 典型工作流', '整理项目资料、修改代码、排查服务和连续研究的实际步骤。'],
  ['docs/features.md', 'features.html', 'MyIDE 功能与边界', 'AI 协作、本地文档、Git、启动面板、SSH/SFTP、数据库和阅读工具的实际范围。'],
  ['docs/ai-guide.md', 'ai-guide.html', 'MyIDE AI 使用指南', '配置普通助手或 DSH、引用上下文、检查授权和执行结果。'],
  ['docs/ai-api.md', 'ai-api.html', 'MyIDE AI 工具接口', '应用内工作台工具分类、状态快照、参数示例和接口边界。'],
  ['docs/architecture.md', 'architecture.html', 'MyIDE 架构与扩展', 'Electron 主进程、渲染层、IPC 和 AI 工具的模块地图。'],
  ['docs/development.md', 'development.html', 'MyIDE 开发与发布', '分支职责、验证和公开版本发布流程。'],
  ['CHANGELOG.md', 'changelog.html', 'MyIDE 版本记录', '公开预发布版本的主要能力、运行条件、已知问题与验证范围。'],
  ['docs/release-preview.md', 'release-preview.html', 'MyIDE 预发布验收记录', 'Windows x64 便携包的构建、实际验证与下载信息。'],
  ['CONTRIBUTING.md', 'contributing.html', '参与 MyIDE', '报告问题、提交补丁和验证改动的方法。'],
];
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mapped = new Map(pages.map(p => [p[0], p[1]]));
function linkFor(source, href) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return href;
  const split = href.indexOf('#');
  const target = split < 0 ? href : href.slice(0, split);
  const fragment = split < 0 ? '' : href.slice(split);
  const file = path.posix.normalize(path.posix.join(path.posix.dirname(source), decodeURIComponent(target)));
  if (mapped.has(file)) return mapped.get(file) + fragment;
  if (file.startsWith('docs/images/')) return 'images/' + file.slice('docs/images/'.length) + fragment;
  return repo + '/blob/dev/' + file.split('/').map(encodeURIComponent).join('/') + fragment;
}
function build(out = path.join(root, 'build/docs-site')) {
  out = path.resolve(out);
  // 输出目录固定在仓库build下，避免错误参数把清理扩散到源码或用户目录。
  if (path.dirname(out) !== path.join(root, 'build') || path.basename(out) !== 'docs-site') throw Error('文档输出目录必须为 build/docs-site');
  fs.mkdirSync(out, {recursive: true});
  const nav = [['index.html','项目介绍'],['getting-started.html','下载与启动'],['workflows.html','典型工作流'],['ai-guide.html','AI 使用'],['features.html','完整能力'],['ai-api.html','AI 工具接口'],['architecture.html','架构与扩展'],['changelog.html','版本记录']];
  for (const [source, file, title, description, language = 'zh-CN'] of pages) {
    const parser = new Marked({gfm: true, walkTokens(token) { if (token.type === 'link') token.href = linkFor(source, token.href); if (token.type === 'image') token.href = linkFor(source, token.href); }});
    const content = parser.parse(fs.readFileSync(path.join(root, source), 'utf8'));
    const canonical = base + file;
    const schema = {'@context':'https://schema.org','@type':'SoftwareApplication',name:'MyIDE',applicationCategory:'DeveloperApplication',operatingSystem:'Windows',url:base,license:repo+'/blob/dev/LICENSE',description:pages[0][3]};
    const alternates = file === 'index.html' || file === 'en.html' ? '<link rel="alternate" hreflang="zh-CN" href="'+base+'index.html"><link rel="alternate" hreflang="en" href="'+base+'en.html">' : '';
    const json = file === 'index.html' || file === 'en.html' ? '<script type="application/ld+json">'+JSON.stringify(schema).replace(/</g,'\\u003c')+'</script>' : '';
    fs.writeFileSync(path.join(out, file), '<!doctype html>\n<html lang="'+language+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escape(title)+'</title><meta name="description" content="'+escape(description)+'"><link rel="canonical" href="'+canonical+'">'+alternates+'<meta property="og:type" content="website"><meta property="og:title" content="'+escape(title)+'"><meta property="og:description" content="'+escape(description)+'"><meta property="og:url" content="'+canonical+'"><meta property="og:image" content="'+base+'images/workspace.png"><link rel="stylesheet" href="style.css">'+json+'</head><body><a class="skip" href="#content">跳到正文 / Skip to content</a><header><a class="brand" href="index.html">MyIDE<span>文档与开发 · AI 工作台</span></a><nav aria-label="快捷入口"><a href="getting-started.html">开始使用</a><a href="en.html" lang="en">English</a><a href="'+repo+'">GitHub ↗</a></nav></header><div class="layout"><aside><nav aria-label="文档导航">'+nav.map(([url,label])=>'<a href="'+url+'"'+(url===file?' aria-current="page"':'')+'>'+label+'</a>').join('')+'<a href="'+repo+'/releases">下载版本 ↗</a></nav></aside><main id="content"><article>'+content+'</article><footer><a href="'+repo+'/blob/dev/'+source+'">编辑本页</a> · <a href="'+repo+'/issues">反馈问题</a> · <a href="'+repo+'/blob/dev/LICENSE">MIT License</a></footer></main></div></body></html>\n');
  }
  fs.mkdirSync(path.join(out, 'images'), {recursive: true});
  for (const image of ['workspace.png', 'editor-split.png']) fs.copyFileSync(path.join(root, 'docs/images', image), path.join(out, 'images', image));
  fs.copyFileSync(path.join(root, 'docs/site.css'), path.join(out, 'style.css'));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  fs.writeFileSync(path.join(out, 'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: '+base+'sitemap.xml\n');
  fs.writeFileSync(path.join(out, 'sitemap.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+pages.map(p=>'<url><loc>'+base+p[1]+'</loc></url>').join('')+'</urlset>\n');
  return {out, pages: pages.length};
}
module.exports = {build, pages, base, linkFor};
if (require.main === module) console.log(JSON.stringify(build()));

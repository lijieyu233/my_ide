// 每次预览使用独立源：HTML 不继承 IDE 的 CSP，也不能读取宿主的 preload API。
const fs = require('fs/promises');
const path = require('path');
const {randomBytes} = require('crypto');
const TextFormat=require('../files/text-format');
const KEY_BRIDGE='<script>document.addEventListener("keydown",function(e){parent.postMessage({__myideKey:1,key:e.key,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey,metaKey:e.metaKey},"*");});</script>';
const WIDGET_STATE='<script>window.openai={widgetState:null,setWidgetState(state){this.widgetState=state}};</script>';
const WIDGET_LIMIT=2*1024*1024;
const SCHEME = 'myide-preview';
const MIME = {html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',json:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',ico:'image/x-icon',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',mp4:'video/mp4',webm:'video/webm',wasm:'application/wasm',txt:'text/plain'};
const inside = (root,file) => {const relative=path.relative(root,file);return !path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};
async function visualizationAllowed(file, visualizationRoot, getProjectRoot) {
  const globalRoot = visualizationRoot && await fs.realpath(visualizationRoot).catch(() => '');
  if (globalRoot && inside(globalRoot, file)) return true;

  // Only the active Codex conversation can supply a workspace, never the preview request.
  const workspace = await getProjectRoot?.();
  if (!workspace || !path.isAbsolute(workspace)) return false;
  return inside(await fs.realpath(workspace), file);
}
function createService() {
  const entries=new Map();
  async function open(owner,request,visualizationRoot,getProjectRoot) {
    if(!request||typeof request.path!=='string'||!path.isAbsolute(request.path)||(request.disk!==true&&typeof request.content!=='string')||! /\.html?$/i.test(request.path))throw Error('HTML 预览参数无效');
    const file=await fs.realpath(request.path),visualization=request.visualization===true;
    if(visualization&&(request.disk!==true||! /\.html?$/i.test(file)||!await visualizationAllowed(file,visualizationRoot,getProjectRoot)))throw Error('可视化文件路径无效');
    const requestedRoot=!visualization&&typeof request.root==='string'&&path.isAbsolute(request.root)?await fs.realpath(request.root):path.dirname(file);
    const root=inside(requestedRoot,file)?requestedRoot:path.dirname(file),id=randomBytes(16).toString('hex');
    if(request.disk===true){
      const stat=await fs.stat(file);
      if(!stat.isFile())throw Error('HTML 入口不是文件');
      if(visualization&&stat.size>WIDGET_LIMIT)throw Error('可视化文件过大');
    }
    entries.set(id,{owner,root,file,visualization,content:request.disk===true?null:request.content});
    return {id,url:SCHEME+'://'+id+'/'+path.relative(root,file).split(path.sep).map(encodeURIComponent).join('/')};
  }
  function close(owner,id){if(entries.get(id)?.owner===owner)entries.delete(id);}
  function clear(owner){for(const [id,entry]of entries)if(entry.owner===owner)entries.delete(id);}
  function isVisualization(owner,source) {
    if(!source?.startsWith(SCHEME+'://'))return false;
    const entry=entries.get(new URL(source).hostname);
    return entry?.owner===owner&&entry.visualization;
  }
  async function handle(request) {
    const fail=status=>new Response('',{status});
    try{
      if(!['GET','HEAD'].includes(request.method))return fail(405);
      const url=new URL(request.url),entry=entries.get(url.hostname);
      if(!entry)return fail(404);
      const relative=decodeURIComponent(url.pathname).slice(1);
      if(relative.includes('\0')||relative.includes('\\')||relative.split('/').some(part=>part==='..'||part.includes(':')))return fail(403);
      const file=await fs.realpath(path.resolve(entry.root,relative));
      // 同时核对 realpath，目录内的符号链接不能把预览的可读范围扩到项目之外。
      if(!inside(entry.root,file))return fail(403);
      // Codex 可视化是独立的 HTML 片段，内联资源齐全，无须暴露磁盘上的相邻文件。
      if(entry.visualization&&file!==entry.file)return fail(403);
      let content=file===entry.file?entry.content:await fs.readFile(file);
      // 内嵌图片HTML不应先经IPC复制到编辑器再传回。只读预览从磁盘读取，仍沿用隔离源与相对资源边界。
      if(file===entry.file&&entry.content===null){
        if(entry.visualization&&(await fs.stat(file)).size>WIDGET_LIMIT)return fail(413);
        const decoded=TextFormat.decodeText(await fs.readFile(file));if(decoded.binary)return fail(415);
        content=decoded.content.replace(/^\uFEFF/,'').replace(/^\s*< ?!DOCTYPE/i,'<!DOCTYPE');
        if(entry.visualization){
          const doctype=/^<!DOCTYPE[^>]*>/i.exec(content)?.[0]||'';
          content=(doctype||'<!doctype html>')+WIDGET_STATE+content.slice(doctype.length);
        }else content+=KEY_BRIDGE;
      }
      const type=MIME[path.extname(file).slice(1).toLowerCase()]||'application/octet-stream';
      const headers={'Content-Type':type+(/^(text\/|application\/json)/.test(type)?'; charset=utf-8':''),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
      if(entry.visualization)headers['Content-Security-Policy']="sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";
      return new Response(request.method==='HEAD'?null:content,{headers});
    }catch{return fail(404);}
  }
  return {open,close,clear,handle,isVisualization};
}
module.exports={SCHEME,createService};

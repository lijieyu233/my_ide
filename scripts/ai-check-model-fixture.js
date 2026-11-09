// Shared offline model fixture: route the latest user intent, not keywords quoted in file context or older chat.
function textOf(content){
  if(typeof content==='string')return content;
  return Array.isArray(content)?content.filter(part=>part?.type==='text').map(part=>String(part.text||'')).join('\n'):'';
}
function reply(messages){
  const list=Array.isArray(messages)?messages:[],last=list.at(-1)||{};
  if(last.role==='tool'||last.role==='user'&&textOf(last.content).trimStart().startsWith('<tool_results>'))return {ok:true,text:'好了，改完了。',toolCalls:[]};
  const user=list.findLast(message=>message?.role==='user');
  // Renderer appends the explicit, single-line fixture instruction after the quoted files.
  // Searching the whole content would let an old example inside a reference select the wrong tool.
  const intent=textOf(user?.content).trim().split(/\r?\n/).at(-1)||'';
  if(intent==='危险命令')return {ok:true,text:'',toolCalls:[{id:'d1',name:'run_command',args:{command:'rm -rf node_modules'}}]};
  if(intent==='给我一段代码')return {ok:true,text:'给你一个例子：\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n\n需要的话我可以插到光标处。',toolCalls:[]};
  if(intent.startsWith('第一次改'))return {ok:true,text:'',toolCalls:[{id:'w1',name:'write_file',args:{path:'_ui_perm.md',content:'第一版内容\n第二行\n'}}]};
  if(intent.startsWith('第二次改'))return {ok:true,text:'',toolCalls:[{id:'w2',name:'write_file',args:{path:'_ui_perm.md',content:'第二版内容\n第二行\n'}}]};
  return {ok:true,text:'',toolCalls:[{id:'c1',name:'replace_edit',args:{path:'_ui_outline.md',search:'## 二级 B',replace:'## 二级 B（备注）'}}]};
}
function sse(messages){
  const result=reply(messages),hasCalls=result.toolCalls.length>0;
  const delta=hasCalls?{tool_calls:result.toolCalls.map((call,index)=>({index,id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))}:{content:result.text};
  return 'data: '+JSON.stringify({choices:[{delta,finish_reason:hasCalls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n';
}
module.exports={reply,sse};

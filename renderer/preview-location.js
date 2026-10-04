// 映射来自同一次marked解析和原字符范围；不可见语法不靠同词全局查找猜位置。
const PreviewLocation = (() => {
  const roots=new WeakMap(),nodes=new WeakMap();
  const append=(target,values)=>{for(const value of values)target.push(value);};
  const fromOf=span=>typeof span==='number'?span:span[0],toOf=span=>typeof span==='number'?span+1:span[1];
  function start(original){
    const text=original.replace(/\r\n?/g,'\n'),map=[];for(let i=0;i<original.length;i++){const from=i;if(original[i]==='\r'&&original[i+1]==='\n'){i++;map.push([from,i+1]);}else map.push(from);}return {original,text,map};
  }
  function replace(record,re,fn){
    let cursor=0,text='',map=[];record.text.replace(re,(...args)=>{
      const offset=args.at(-2),raw=args[0],replacement=typeof fn==='function'?fn(...args):fn,next=typeof replacement==='string'?replacement:replacement.text;
      text+=record.text.slice(cursor,offset)+next;append(map,record.map.slice(cursor,offset));
      let prefix=0,suffix=0;while(prefix<raw.length&&prefix<next.length&&raw[prefix]===next[prefix])prefix++;
      while(suffix<raw.length-prefix&&suffix<next.length-prefix&&raw.at(-suffix-1)===next.at(-suffix-1))suffix++;
      append(map,replacement.map||[...record.map.slice(offset,offset+prefix),...Array(next.length-prefix-suffix).fill(null),...record.map.slice(offset+raw.length-suffix,offset+raw.length)]);cursor=offset+raw.length;return raw;
    });text+=record.text.slice(cursor);append(map,record.map.slice(cursor));record.text=text;record.map=map;return text;
  }
  function filterLines(record,kept){
    const lines=record.text.split('\n'),starts=[];let p=0;for(const line of lines){starts.push(p);p+=line.length+1;}
    const map=[];let text='',count=0;for(const i of kept){if(count++){text+='\n';map.push(record.map[starts[i]-1]||null);}text+=lines[i];append(map,record.map.slice(starts[i],starts[i]+lines[i].length));}record.text=text;record.map=map;
  }
  function wiki(record,raw,target,alias,offset,next){
    const label=(alias||target).trim(),start=(alias?raw.indexOf('|')+1:raw.startsWith('!')?3:2)+(alias||target).length-(alias||target).trimStart().length;
    const at=next.indexOf('[')+1,map=Array(next.length).fill(null);if(next.slice(at,at+label.length)===label)for(let i=0;i<label.length;i++)map[at+i]=record.map[offset+start+i];return {text:next,map};
  }
  const segment=(text,map,value,from=0)=>{const at=text.indexOf(value,from);return at<0?null:{text:value,map:map.slice(at,at+value.length),at};};
  function decoded(text,map){
    let value='',out=[];for(let i=0;i<text.length;){const entity=/^&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i.exec(text.slice(i));
      if(entity){const ta=document.createElement('textarea');ta.innerHTML=entity[0];const result=ta.value;if(result!==entity[0]){value+=result;const a=map[i],b=map[i+entity[0].length-1];out.push(...Array(result.length).fill(a!=null&&b!=null?[fromOf(a),toOf(b)]:null));i+=entity[0].length;continue;}}
      if(text[i]==='\\'&&/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(text[i+1]||'')){const a=map[i],b=map[i+1];value+=text[i+1];out.push(a!=null&&b!=null?[fromOf(a),toOf(b)]:null);i+=2;continue;}
      value+=text[i];out.push(map[i++]??null);
    }return {text:value,map:out};
  }
  function parse(record){
    const marked=window.marked,tokens=marked.lexer(record.text,{...marked.defaults,breaks:true,gfm:true}),metadata=new WeakMap();
    function inline(tokens,text,map){let cursor=0;for(const token of tokens||[]){const part=segment(text,map,token.raw||'',cursor);if(!part)continue;cursor=part.at+part.text.length;
      if(token.type==='text'||token.type==='escape'){const result=decoded(part.text,part.map);if(result.text===decoded(token.text,Array(token.text.length).fill(null)).text)metadata.set(token,result);}
      else if(token.type==='codespan'){const match=/^(`+)([\s\S]*?)\1$/.exec(part.text);if(match){let body=match[2],at=match[1].length;body=body.replace(/\n/g,' ');if(/^ .+ $/s.test(body)&&/\S/.test(body)){body=body.slice(1,-1);at++;}if(body===token.text)metadata.set(token,{text:body,map:part.map.slice(at,at+body.length)});}}
      else if(token.tokens){let at=-1;if(['strong','em','del','mdHighlight'].includes(token.type))at=(token.raw.length-token.text?.length)/2;
        if(token.type==='mdHighlight')at=2;
        if(token.type==='link')at=token.raw[0]==='['?1:token.raw[0]==='<'?1:0;
        const inner=typeof token.text==='string'?token.text:token.type==='mdHighlight'?token.raw.slice(2,-2):'';
        if(Number.isInteger(at)&&at>=0&&part.text.slice(at,at+inner.length)===inner)inline(token.tokens,inner,part.map.slice(at,at+inner.length));
      }
    }}
    function blocks(list,text,map){let cursor=0;for(const token of list||[]){const part=segment(text,map,token.raw||'',cursor)||(token.type==='text'&&token.raw.replace(/\n+/g,'\n')===token.text.replace(/\n+/g,'\n')?segment(text,map,token.text,cursor):null);if(!part)continue;cursor=part.at+part.text.length;
      if(['paragraph','heading','text'].includes(token.type)){let at=0;if(token.type==='heading'){const prefix=/^ {0,3}#{1,6}[ \t]+/.exec(part.text);at=prefix?prefix[0].length:0;}
        if(part.text.slice(at,at+token.text.length)===token.text)inline(token.tokens,token.text,part.map.slice(at,at+token.text.length));
      }else if(token.type==='blockquote'||token.type==='list'){
        const items=token.type==='list'?token.items:[token];let offset=0;for(const item of items){const raw=segment(part.text,part.map,item.raw||token.raw,offset);if(!raw)continue;offset=raw.at+raw.text.length;
          const lines=raw.text.split('\n');let body='',bodyMap=[],position=0;for(let i=0;i<lines.length;i++){let line=lines[i],drop=0;
            if(token.type==='blockquote')drop=(/^ {0,3}>[ \t]?/.exec(line)||[''])[0].length;
            else if(i===0)drop=(/^\s*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(line)||[''])[0].length;
            else{const expected=(item.text||'').split('\n')[i];if(expected!=null&&line.endsWith(expected))drop=line.length-expected.length;}
            if(i){body+='\n';bodyMap.push(raw.map[position-1]||null);}body+=line.slice(drop);append(bodyMap,raw.map.slice(position+drop,position+line.length));position+=line.length+1;
          }if(body.replace(/\n+$/,'')===String(item.text||token.text||'').replace(/\n+$/,''))blocks(item.tokens,body,bodyMap);
        }
      }else if(token.type==='table'){
        const lines=part.text.split('\n');let pos=0;for(let row=0;row<lines.length;row++){const cells=row===0?token.header:row>1?token.rows[row-2]:null;if(cells){
          const slots=[];let value='',values=[];const flush=()=>{const left=value.length-value.trimStart().length,right=value.trimEnd().length;slots.push({text:value.trim(),map:values.slice(left,right)});value='';values=[];};
          for(let i=0;i<lines[row].length;i++){const char=lines[row][i],span=part.map[pos+i];if(char==='|'){let backslashes=0;for(let j=i-1;j>=0&&lines[row][j]==='\\';j--)backslashes++;if(backslashes%2===0){flush();continue;}const begin=values.pop();value=value.slice(0,-1)+'|';values.push(begin!=null&&span!=null?[fromOf(begin),toOf(span)]:null);}else{value+=char;values.push(span);}}flush();
          if(slots[0]?.text==='')slots.shift();if(slots.at(-1)?.text==='')slots.pop();
          if(slots.length===cells.length)for(let i=0;i<cells.length;i++)if(slots[i].text===cells[i].text)inline(cells[i].tokens,slots[i].text,slots[i].map);
        }pos+=lines[row].length+1;}
      }else if(token.type==='code'){
        const lines=part.text.split('\n');let pos=0,result='',out=[],count=0;const fenced=token.codeBlockStyle!=='indented';const last=lines.at(-1)===''?lines.length-2:lines.length-1;for(let i=0;i<lines.length;i++){const line=lines[i];if(fenced&&(i===0||i===last&&/^\s*(?:`{3,}|~{3,})/.test(line)||i>last)){pos+=line.length+1;continue;}
          const drop=fenced?0:(/^ {4}|^\t/.exec(line)||[''])[0].length;if(count++){result+='\n';out.push(part.map[pos-1]||null);}result+=line.slice(drop);append(out,part.map.slice(pos+drop,pos+line.length));pos+=line.length+1;
        }if(result.replace(/\n+$/,'')===token.text.replace(/\n+$/,''))metadata.set(token,{text:token.text+'\n',map:out.slice(0,token.text.length).concat([null])});
      }
    }}blocks(tokens,record.text,record.map);
    const records=new Map(),nonce='pl-'+Math.random().toString(36).slice(2)+'-',renderer=new marked.Renderer(marked.defaults);let number=0;
    const wrap=(token,html,code=false)=>{const item=metadata.get(token);if(!item)return html;const id=nonce+number++;records.set(id,item);return code?html.replace('<code','<code data-preview-map="'+id+'"'):'<span data-preview-map="'+id+'">'+html+'</span>';};
    const baseText=renderer.text,baseSpan=renderer.codespan,baseCode=renderer.code;
    renderer.text=function(token){return wrap(token,baseText.call(this,token));};renderer.codespan=function(token){return wrap(token,baseSpan.call(this,token));};renderer.code=function(token){return wrap(token,baseCode.call(this,token),true);};
    return {html:marked.parser(tokens,{...marked.defaults,renderer,breaks:true,gfm:true}),records,original:record.original};
  }
  function bind(root,parsed){
    roots.set(root,{original:parsed.original,highlight:null});for(const [id,record]of parsed.records){const found=root.querySelectorAll('[data-preview-map="'+id+'"]');if(found.length!==1)continue;const element=found[0];element.removeAttribute('data-preview-map');
      if(element.textContent!==record.text)continue;const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node,at=0;while((node=walker.nextNode())){nodes.set(node,{root,map:record.map.slice(at,at+node.length)});at+=node.length;}
    }
  }
  function locate(root,from,to){
    const state=roots.get(root);if(!state||!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<=from||to>state.original.length)return null;
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),parts=[];let node;while((node=walker.nextNode())){const known=nodes.get(node);if(known?.root!==root)continue;let visible=true;for(let el=node.parentElement;el&&el!==root;el=el.parentElement){const style=getComputedStyle(el);if(el.hidden||style.display==='none'||style.visibility==='hidden'){visible=false;break;}}if(!visible)continue;for(let i=0;i<known.map.length;i++){const range=known.map[i];if(range!=null&&fromOf(range)>=from&&toOf(range)<=to)parts.push({node,index:i,from:fromOf(range),to:toOf(range)});}}
    if(!parts.length||parts[0].from!==from||parts.at(-1).to!==to)return null;let end=from,previous=null;for(const part of parts){if(part.from!==end&&!(previous&&part.from===previous.from&&part.to===previous.to))return null;end=Math.max(end,part.to);previous=part;}
    const range=document.createRange();range.setStart(parts[0].node,parts[0].index);range.setEnd(parts.at(-1).node,parts.at(-1).index+1);return range;
  }
  function highlight(root,from,to){const range=locate(root,from,to);if(!range)return false;const state=roots.get(root);state.highlight={from,to};
    if(window.CSS?.highlights&&window.Highlight){CSS.highlights.set('myide-search-hit',new Highlight(range));}else{const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}
    const scroller=root,rect=range.getBoundingClientRect?.(),outer=scroller.getBoundingClientRect();if(rect&&rect.height)scroller.scrollTop+=rect.top-outer.top-scroller.clientHeight/3;else range.startContainer.parentElement?.scrollIntoView?.({block:'center'});return true;
  }
  function capture(root){const state=roots.get(root);if(!state)return null;const outer=root.getBoundingClientRect(),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
    while((node=walker.nextNode())){const known=nodes.get(node);if(known?.root!==root)continue;const first=known.map.find(span=>span!=null);if(first==null)continue;const range=document.createRange();range.selectNodeContents(node);const rect=range.getBoundingClientRect?.();if(rect&&rect.bottom>=outer.top)return {offset:fromOf(first),delta:rect.top-outer.top,highlight:state.highlight};}return {offset:0,delta:0,highlight:state.highlight};
  }
  function restore(root,anchor){if(!roots.has(root)||!anchor)return false;if(anchor.highlight)highlight(root,anchor.highlight.from,anchor.highlight.to);
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())){const known=nodes.get(node),i=known?.root===root?known.map.findIndex(span=>span!=null&&fromOf(span)>=anchor.offset):-1;if(i<0)continue;const range=document.createRange();range.selectNodeContents(node);const rect=range.getBoundingClientRect?.();if(rect)root.scrollTop+=rect.top-root.getBoundingClientRect().top-anchor.delta;return true;}return false;
  }
  function clear(){window.CSS?.highlights?.delete('myide-search-hit');}
  return {start,replace,filterLines,wiki,parse,bind,locate,highlight,capture,restore,clear};
})();window.PreviewLocation=PreviewLocation;

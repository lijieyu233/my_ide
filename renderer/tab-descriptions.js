// 同名归属与实际省略共用一份描述；缩短后的路径不能再次变成同一个可见名字。
const TabDescriptions=(()=>{
  const key=value=>DocumentPaths.key(value),segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}):null;
  const chars=value=>segmenter?[...segmenter.segment(value)].map(part=>part.segment):Array.from(value);
  function describe(tabs,root){
    const entries=tabs.map(tab=>{const path=DocumentPaths.normalize(tab.path),parts=path.split('/').filter(Boolean);parts.pop();
      return {tab,id:tab.id,name:tab.name,path,parent:parts,pathHint:'',relative:DocumentPaths.contains(root,path)?path.slice(DocumentPaths.normalize(root).length+1):path,
        status:[tab.id===window.Viewer?.activeTab?.id?'当前文件':'',tab.pinned?'已固定':'',tab.mode==null?'加载中':tab.error||tab.mode==='error'?'读取失败':'',tab.dirty?'未保存':'',tab.saveError?'保存失败':''].filter(Boolean).join('，')};});
    for(const entry of entries){const peers=entries.filter(other=>key(other.name)===key(entry.name));if(peers.length<2)continue;
      for(let depth=1;depth<=entry.parent.length;depth++){const hint=entry.parent.slice(-depth).join('/');entry.pathHint=hint;
        if(peers.every(other=>other===entry||key(other.parent.slice(-depth).join('/'))!==key(hint)))break;}
    }
    return entries;
  }
  function shorten(value,width,measure,around=null){
    const units=chars(value);if(measure(value)<=width)return value;
    for(let length=units.length-1;length>=1;length--){let start=around==null?0:Math.max(0,Math.min(around-Math.floor(length/2),units.length-length));
      const text=around==null?units.slice(0,Math.ceil(length/2)).join('')+'…'+units.slice(-Math.floor(length/2)||units.length).join('')
        :(start?'…':'')+units.slice(start,start+length).join('')+(start+length<units.length?'…':'');
      if(measure(text)<=width)return text;
    }return '…';
  }
  function compact(values,width,measure){
    const result=values.map(value=>shorten(value,width,measure));
    // 通常中段省略已足够；冲突时把窗口移到这组原文第一个不同的字，而不是追加内部文档id。
    for(let pass=0;pass<values.length+1;pass++){
      const groups=new Map();result.forEach((text,i)=>{const k=key(text);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(i);});let changed=false;
      for(const indices of groups.values()){if(indices.length<2||indices.every(i=>key(values[i])===key(values[indices[0]])))continue;
        const originals=indices.map(i=>chars(values[i]));let at=0;while(originals.every(parts=>parts[at]!=null&&key(parts[at])===key(originals[0][at])))at++;
        for(const i of indices){const next=shorten(values[i],width,measure,at);changed ||= next!==result[i];result[i]=next;}
      }if(!changed)break;
    }
    // 极窄尺寸/复杂字符窗口仍冲突时，显示目录顺序号；完整路径始终能通过键盘查看。
    const seen=new Map();result.forEach((text,i)=>{if(!seen.has(key(text)))seen.set(key(text),[]);seen.get(key(text)).push(i);});
    for(const indices of seen.values())if(indices.length>1&&!indices.every(i=>key(values[i])===key(values[indices[0]])))indices.sort((a,b)=>key(values[a]).localeCompare(key(values[b]))).forEach((i,rank)=>{const suffix=' ['+(rank+1)+']';result[i]=shorten(values[i],Math.max(0,width-measure(suffix)),measure)+suffix;});
    return result;
  }
  return {describe,compact};
})();
window.TabDescriptions=TabDescriptions;

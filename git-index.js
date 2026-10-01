const crypto=require('crypto');
const fail=(code,message)=>Object.assign(Error(message),{code});
function parseIndex(buf){
 if(!Buffer.isBuffer(buf)||buf.length<32||buf.length>64*1024*1024||buf.toString('ascii',0,4)!=='DIRC')throw fail('INDEX_INVALID','索引头或大小不可用');
 const end=buf.length-20;if(!crypto.createHash('sha1').update(buf.subarray(0,end)).digest().equals(buf.subarray(end)))throw fail('INDEX_INVALID','索引校验不一致');
 const version=buf.readUInt32BE(4);if(![2,3].includes(version))throw fail('INDEX_UNSUPPORTED','纯JS状态不支持index v'+version);
 const rows=[];let at=12;const count=buf.readUInt32BE(8);
 if(count>1000000)throw fail('INDEX_LIMIT','索引条目超过预算');
 for(let i=0;i<count;i++){
  const start=at;if(at+62>end)throw fail('INDEX_INVALID','索引条目截断');const flags=buf.readUInt16BE(at+60),extended=!!(flags&0x4000);
  if(extended&&version!==3)throw fail('INDEX_UNSUPPORTED','v2扩展标志不可用');const nameAt=at+62+(extended?2:0),nul=buf.indexOf(0,nameAt);
  if(nul<nameAt||nul>=end)throw fail('INDEX_INVALID','索引路径未完整终止');const bytes=buf.subarray(nameAt,nul),file=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(!file||file.startsWith('/')||file.split('/').some(p=>p==='..'||p==='.'||!p)||((flags&0xfff)<0xfff&&(flags&0xfff)!==bytes.length))throw fail('INDEX_INVALID','索引路径或长度无效');
  const mode=buf.readUInt32BE(start+24),extendedFlags=extended?buf.readUInt16BE(start+62):0;
  rows.push({file,start,flags,extendedFlags,stage:(flags>>12)&3,mode,oid:buf.toString('hex',start+40,start+60),size:buf.readUInt32BE(start+36),mtimeMs:buf.readUInt32BE(start+8)*1000+Math.floor(buf.readUInt32BE(start+12)/1e6),ctimeSec:buf.readUInt32BE(start)});
  at=start+Math.ceil((nul-start+1)/8)*8;if(at>end)throw fail('INDEX_INVALID','索引对齐越界');
 }
 while(at<end){if(at+8>end)throw fail('INDEX_INVALID','索引扩展截断');const name=buf.toString('ascii',at,at+4),len=buf.readUInt32BE(at+4);if(/[a-z]/.test(name[0]))throw fail('INDEX_UNSUPPORTED','索引必要扩展尚不支持：'+name);at+=8+len;if(at>end)throw fail('INDEX_INVALID','索引扩展越界');}
 return rows;
}
// 只在独立索引中失效缓存；稀疏路径的缺席具有业务含义，不能清 skip-worktree 后虚构删除。
function invalidateStats(bytes){const out=Buffer.from(bytes),rows=parseIndex(out);for(const r of rows){if(r.extendedFlags&0x4000)throw fail('INDEX_UNSUPPORTED','稀疏索引请使用普通刷新；完整扫描尚不支持skip-worktree');out.fill(0,r.start,r.start+24);out.fill(0,r.start+28,r.start+40);out.writeUInt16BE(r.flags&~0x8000,r.start+60);if(r.flags&0x4000)out.writeUInt16BE(r.extendedFlags&~0x20,r.start+62);}crypto.createHash('sha1').update(out.subarray(0,-20)).digest().copy(out,out.length-20);return out;}
module.exports={parseIndex,invalidateStats};

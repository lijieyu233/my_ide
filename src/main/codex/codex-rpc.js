const {EventEmitter}=require('events');

// Codex app-server uses newline-delimited JSON, not LSP Content-Length framing.
// It may omit jsonrpc; diagnostics and arbitrary server error bodies never reach UI.
class Rpc extends EventEmitter {
  constructor(child,{maxLineBytes=4*1024*1024,maxPending=256}={}){
    super();this.child=child;this.maxLineBytes=maxLineBytes;this.maxPending=maxPending;
    this.pending=new Map();this.sequence=0;this.fragments=[];this.bufferedBytes=0;this.closed=false;
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>this.read(chunk));
    child.stdin.on('error',()=>this.close(Error('Codex 标准输入已关闭')));
    child.on('error',()=>this.close(Error('Codex 进程启动或通信失败')));
    child.on('exit',()=>this.close(Error('Codex app-server 已退出')));
    child.stdout.on('end',()=>this.close(Error('Codex 标准输出已关闭')));
    // stderr can contain configuration, account identifiers, or tokens. Do not store it.
    child.stderr?.on('data',()=>{});
  }
  read(chunk){
    if(this.closed)return;chunk=String(chunk);let offset=0;
    // Scan only new bytes. Rescanning/byteLength-ing a growing 4 MiB frame on
    // every 1 KiB fragment turns stream handling quadratic and freezes the UI.
    while(offset<chunk.length){
      const newline=chunk.indexOf('\n',offset),end=newline<0?chunk.length:newline,fragment=chunk.slice(offset,end);
      this.bufferedBytes+=Buffer.byteLength(fragment);
      if(this.bufferedBytes>this.maxLineBytes)return this.close(Error('Codex 协议消息过大'));
      if(fragment)this.fragments.push(fragment);
      if(newline<0){if(this.fragments.length>65536)this.fragments=[this.fragments.join('')];break;}
      const line=this.fragments.join('').trim();this.fragments=[];this.bufferedBytes=0;offset=newline+1;
      if(!line)continue;
      let message;try{message=JSON.parse(line);}catch{return this.close(Error('Codex 返回了无效协议数据'));}
      if(!message||typeof message!=='object'||Array.isArray(message)||(message.jsonrpc!==undefined&&message.jsonrpc!=='2.0'))return this.close(Error('Codex 协议版本不兼容'));
      if(typeof message.method==='string'){
        this.emit(message.id!==undefined&&message.id!==null?'request':'notification',message);
      }else{
        const pending=this.pending.get(message.id);if(!pending)continue;
        this.pending.delete(message.id);clearTimeout(pending.timer);
        if(message.error){const error=Error('Codex 请求失败：'+pending.method);error.code=Number.isInteger(message.error.code)?message.error.code:undefined;error.rpcResponseReceived=true;pending.reject(error);}
        else if(Object.hasOwn(message,'result'))pending.resolve(message.result);
        else pending.reject(Error('Codex 响应缺少 result'));
      }
      if(this.closed)return;
    }
  }
  write(message){
    if(this.closed||this.child.stdin.destroyed)throw Error('Codex 通信已关闭');
    const line=JSON.stringify(message)+'\n';if(Buffer.byteLength(line)>this.maxLineBytes)throw Error('Codex 请求过大');
    this.child.stdin.write(line,error=>{if(error)this.close(Error('Codex 标准输入写入失败'));});
  }
  request(method,params={},timeout=45000){
    if(this.closed)return Promise.reject(Error('Codex 通信已关闭'));
    if(this.pending.size>=this.maxPending)return Promise.reject(Error('Codex 待处理请求过多'));
    return new Promise((resolve,reject)=>{
      const id=++this.sequence,timer=timeout>0?setTimeout(()=>{this.pending.delete(id);reject(Error('Codex 请求超时：'+method));},timeout):null;
      this.pending.set(id,{resolve,reject,timer,method});
      try{this.write({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  notify(method,params){this.write({method,...(params===undefined?{}:{params})});}
  reply(id,result){this.write({id,result});}
  reject(id,code=-32601){this.write({id,error:{code,message:'Unsupported or inactive MyIDE request'}});}
  close(error=Error('Codex 通信已关闭')){
    if(this.closed)return;this.closed=true;this.fragments=[];this.bufferedBytes=0;
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();this.emit('closed',error);
  }
}
module.exports={Rpc};

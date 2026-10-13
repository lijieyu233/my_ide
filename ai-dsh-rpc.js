const {EventEmitter}=require('events');
// ACP 的 stdout 只允许逐行 JSON-RPC；诊断必须走 stderr，不能把日志误当模型回复。
class Rpc extends EventEmitter {
  constructor(child){
    super();this.child=child;this.pending=new Map();this.sequence=0;this.buffer='';this.closed=false;
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>this.read(chunk));
    child.stdin.on('error',error=>this.close(error));
    child.on('error',error=>this.close(error));child.on('exit',()=>this.close(Error('DSH 进程已退出')));
  }
  read(chunk){
    if(this.closed)return;this.buffer+=chunk;
    if(Buffer.byteLength(this.buffer)>4*1024*1024){this.close(Error('DSH 协议消息超过大小限制'));return;}
    let newline;while((newline=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,newline).trim();this.buffer=this.buffer.slice(newline+1);if(!line)continue;
      let message;try{message=JSON.parse(line);}catch{this.close(Error('DSH 返回了无效的 ACP 协议数据'));return;}
      if(message.jsonrpc!=='2.0'){this.close(Error('DSH 返回了不兼容的 ACP 协议'));return;}
      if(message.method){if(message.id!=null)this.emit('request',message);else this.emit('notification',message);}
      else{const pending=this.pending.get(message.id);if(!pending)continue;this.pending.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(Error(message.error.message||'DSH 请求失败')):pending.resolve(message.result);}
    }
  }
  write(message){if(this.closed||this.child.stdin.destroyed)throw Error('DSH 通信已关闭');this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n',error=>{if(error)this.close(error);});}
  request(method,params,timeout=45000){return new Promise((resolve,reject)=>{const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('DSH 请求超时：'+method));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.write({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});}
  notify(method,params){this.write({method,params});}
  reply(id,result){this.write({id,result});}
  close(error=Error('DSH 通信已关闭')){if(this.closed)return;this.closed=true;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();this.emit('closed',error);}
}
module.exports={Rpc};

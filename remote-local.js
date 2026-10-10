// Electron可能被绿盾视为不受信进程；让受信Node读取本地元数据和上传字节，不能凭exe看到的大小判断文件。
const { execFile, spawn } = require('child_process');
const program = `const fs=require('fs'),path=require('path');const [op,p]=process.argv.slice(1);const view=(p,name)=>{const s=fs.lstatSync(p);return{name,path:p,directory:s.isDirectory(),link:s.isSymbolicLink(),size:s.size,mtime:s.mtimeMs}};try{if(op==='read'){if(fs.statSync(p).size>1024*1024)throw Error('私钥文件超过1MiB');console.log(JSON.stringify(fs.readFileSync(p).toString('base64')))}else if(op==='stream'){const r=fs.createReadStream(p);r.on('error',e=>{console.error(e.message);process.exitCode=1});r.pipe(process.stdout)}else if(op==='stat'||op==='statMaybe'){console.log(JSON.stringify(view(p,path.basename(p))))}else{const names=fs.readdirSync(p);if(names.length>10000)throw Error('目录超过10000项，请选择更小的目录');console.log(JSON.stringify({path:fs.realpathSync(p),entries:names.map(n=>view(path.join(p,n),n))}))}}catch(e){if(op==='statMaybe'&&e.code==='ENOENT')console.log('null');else{console.error(e.message);process.exitCode=1}}`;
function request(op, target) {
  return new Promise((resolve, reject) => execFile('node', ['-e', program, op, target], { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(Error('受信Node读取失败：' + (stderr.trim() || error.message)));
    try { resolve(JSON.parse(stdout)); } catch { reject(Error('本地目录返回格式无效')); }
  }));
}
function stream(target) {
  const child = spawn('node', ['-e', program, 'stream', target], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000); });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(error || '本地读取进程失败')));
  });
  done.catch(() => {});
  return { readable: child.stdout, done, cancel: () => child.kill() };
}
module.exports = { read: async target => Buffer.from(await request('read', target), 'base64'), list: target => request('list', target), stat: target => request('stat', target), statMaybe: target => request('statMaybe', target), stream };

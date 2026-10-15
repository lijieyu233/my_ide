const fs=require('fs'),path=require('path');
function repositoryKey(dir){let p=path.resolve(dir);for(;;){if(fs.existsSync(path.join(p,'.git')))break;const parent=path.dirname(p);if(parent===p)break;p=parent;}try{p=fs.realpathSync(p);}catch{}return process.platform==='win32'?p.toLowerCase():p;}
function createQueue(){const tails=new Map();return (dir,fn)=>{const key=repositoryKey(dir),pending=(tails.get(key)||Promise.resolve()).catch(()=>{}).then(fn),tail=pending.catch(()=>{});tails.set(key,tail);tail.finally(()=>{if(tails.get(key)===tail)tails.delete(key);});return pending;};}
module.exports={createQueue,repositoryKey};

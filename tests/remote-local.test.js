const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { spawn } = require('child_process'), { once } = require('events');
const { createClient } = require('../remote-local');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-remote-local-')), clients = [], children = [];
const directory = path.join(root, '中文目录'), metrics = path.join(root, 'metrics.json'), preload = path.join(root, 'instrument.cjs');
fs.mkdirSync(directory); for (let n = 0; n < 240; n++) fs.writeFileSync(path.join(directory, '文件-' + n + '.txt'), '中文内容');
fs.mkdirSync(path.join(directory, '子目录'));
fs.writeFileSync(preload, `const fs=require('fs'),path=require('path');const original=fs.promises.lstat;let active=0,max=0;fs.promises.lstat=async function(p){active++;max=Math.max(max,active);try{await new Promise(r=>setTimeout(r,path.basename(p)==='慢文件'?500:8));if(path.basename(p)==='消失.txt')throw Object.assign(Error('已移走'),{code:'ENOENT'});if(path.basename(p)==='错误.txt')throw Object.assign(Error('拒绝访问'),{code:'EACCES'});return await original.call(this,p)}finally{active--;fs.writeFileSync(${JSON.stringify(metrics)},JSON.stringify({max,active}))}};`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer; try { await Promise.race([once(child, 'exit'), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('读取进程未退出')), 3000); })]); } finally { clearTimeout(timer); }
}
function client(options = {}) {
  const c = createClient({ ...options, spawnNode: (command, args, settings) => {
    const child = spawn(command, ['--require', preload, ...args], settings); children.push(child); return child;
  } }); clients.push(c); return c;
}
let passed = 0;
const check = (name, condition) => { assert(condition, name); passed++; console.log('ok ' + name); };
(async () => { try {
  const c = client(), start = children.length, result = await c.list(directory);
  check('中文目录返回完整元数据且保留路径和文件夹类型', result.path === fs.realpathSync(directory) && result.entries.length === 241 && result.entries.find(e => e.name === '子目录').directory && result.entries.find(e => e.name === '文件-0.txt').size === Buffer.byteLength('中文内容'));
  const metric = JSON.parse(fs.readFileSync(metrics)); check('文件属性读取有界并行且已全部结算', metric.max > 1 && metric.max <= 16 && metric.active === 0);
  const file = path.join(directory, '文件-0.txt'); fs.writeFileSync(file, '已修改');
  const values = await Promise.all([c.stat(file), c.list(directory), c.read(file), c.statMaybe(path.join(root, '不存在'))]);
  check('连续及同时请求复用一个受信进程', children.length === start + 1);
  check('并发请求按编号返回且刷新不使用旧属性', values[0].size === Buffer.byteLength('已修改') && values[1].entries.find(e => e.name === '文件-0.txt').size === values[0].size && values[2].equals(Buffer.from('已修改')) && values[3] === null);
  fs.writeFileSync(path.join(directory, '新增.txt'), 'new'); fs.unlinkSync(path.join(directory, '文件-1.txt'));
  const refreshed = await c.list(directory); check('刷新立即反映本地文件新增和删除', refreshed.entries.some(e => e.name === '新增.txt') && !refreshed.entries.some(e => e.name === '文件-1.txt'));
  fs.writeFileSync(path.join(directory, '消失.txt'), 'gone');
  check('列目录过程中移走单个文件不会拖垮整个目录', !(await c.list(directory)).entries.some(e => e.name === '消失.txt'));
  fs.writeFileSync(path.join(directory, '错误.txt'), 'denied'); await assert.rejects(c.list(directory), /拒绝访问/); fs.unlinkSync(path.join(directory, '错误.txt'));
  check('读取失败结算全部在途属性且同一进程仍可使用', JSON.parse(fs.readFileSync(metrics)).active === 0 && (await c.stat(file)).size === values[0].size);
  const largeKey = path.join(root, 'large-key'); fs.writeFileSync(largeKey, Buffer.alloc(1024 * 1024 + 1)); await assert.rejects(c.read(largeKey), /1MiB/);
  check('私钥读取保留大小限制', true);
  const slow = path.join(root, '慢文件'); fs.writeFileSync(slow, 'slow');
  const crashing = c.stat(slow); const rejected = assert.rejects(crashing, /读取.*(退出|断开)/); await sleep(30); children.at(-1).kill(); await rejected;
  const count = children.length; check('进程异常退出结算请求且下次访问自动恢复', (await c.stat(file)).size === values[0].size && children.length === count + 1);
  const timed = client({ timeoutMs: 200 }); await assert.rejects(timed.stat(slow), /超时/); timed.dispose();
  check('超时终止读取进程并返回错误', true);
  const shortIdle = client({ idleMs: 50 }); await shortIdle.stat(file); const oldWorker = children.at(-1); await exited(oldWorker);
  const idleCount = children.length; await shortIdle.stat(file); check('空闲后释放进程且再次操作可重新启动', children.length === idleCount + 1);
  shortIdle.dispose(); await assert.rejects(shortIdle.stat(file), /关闭/); check('关闭读取服务后拒绝继续操作', true);
  // 本地列表预算不能因进程复用或并行扫描而绕过。
  const big = path.join(root, '大目录'); fs.mkdirSync(big); for (let n = 0; n < 10001; n++) fs.writeFileSync(path.join(big, String(n)), '');
  await assert.rejects(c.list(big), /10000/); check('超过10000项保留目录预算', true);
  console.log('本地目录性能：' + passed + ' 通过 / 0 失败');
} finally {
  for (const c of clients) c.dispose();
  await Promise.all(children.map(exited));
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('myide-remote-local-')) throw Error('清理越界');
  fs.rmSync(root, { recursive: true, force: true });
} })().catch(e => { console.error(e); process.exitCode = 1; });

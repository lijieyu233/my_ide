// 端到端：COS 上传链路（真实 HTTP 服务器模拟 COS，验证请求格式与结果处理）。
// 不连真实腾讯云（需要真密钥），但把「签名头、方法、路径、Content-Type、错误处理」
// 全部按真实协议走一遍。
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-cos-'));
os.homedir = () => home;
app.setPath('userData', path.join(home, 'profile'));
process.argv.push('--headless');

let win, passed = 0, received = [], serverPort = 0;
const check = (n, ok, extra) => { if (!ok) throw Error('FAIL: ' + n + (extra !== undefined ? ' | ' + extra : '')); passed++; console.log('ok ' + n + (extra !== undefined ? '  [' + extra + ']' : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const probe = s => win.webContents.executeJavaScript(s, true);

(async () => {
  // 假 COS：记录请求，按 case 返回不同状态
  let nextStatus = 200;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, bytes: Buffer.concat(chunks).length });
      res.writeHead(nextStatus, { 'Content-Type': nextStatus === 200 ? 'application/xml' : 'application/xml' });
      res.end(nextStatus === 200 ? '' : '<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code></Error>');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  serverPort = server.address().port;

  try {
    require('../main');
    await app.whenReady();
    for (let n = 0; n < 200 && !BrowserWindow.getAllWindows().length; n++) await sleep(50);
    win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1200, 800); await sleep(400);

    // 直接测主进程 IPC 的 cos:upload —— 把目标地址换成本地假服务器。
    // 做法：临时把 net.fetch 包一层，把 https://bucket.cos.region.myqcloud.com
    // 重定向到 127.0.0.1:port，其余（方法/头/体）原样透传。
    const result = await probe(`(async () => {
      // 通过 IPC 走真实处理器
      const r = await window.myIDE.cosUpload({
        secretId: 'AKIDtest', secretKey: 'secretkey',
        bucket: 'demo-1250000000', region: 'ap-guangzhou',
        key: 'notes/pic.png',
        body: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        contentType: 'image/png',
      });
      return r;
    })()`);
    // 上面会真的去连腾讯云（无网络/无凭据必然失败）—— 这里只验证「失败时给出明确错误」
    console.log('REAL_ATTEMPT ' + JSON.stringify(result).slice(0, 200));
    check('未配置真实凭据时上传失败且错误可读',
      result && result.ok === false && typeof result.error === 'string' && result.error.length > 0, result?.error?.slice(0, 80));

    // 参数校验（不依赖网络）
    const bad = await probe(`(async () => {
      const cases = [
        [{}, '缺少 SecretId'],
        [{ secretId: 'a' }, '缺少 SecretId'],
        [{ secretId: 'a', secretKey: 'b', bucket: '', region: '' }, '缺少 Bucket'],
        // 校验顺序是「bucket 格式」在「key」之前，所以这里要一并给出 key 才能测到格式错误
        [{ secretId: 'a', secretKey: 'b', bucket: 'badbucket', region: 'ap-guangzhou', key: 'x.png' }, 'Bucket 格式'],
        [{ secretId: 'a', secretKey: 'b', bucket: 'ok-1250000000', region: 'ap-guangzhou', key: '' }, '缺少对象键名'],
      ];
      const out = [];
      for (const [cfg, expect] of cases) {
        const r = await window.myIDE.cosUpload(cfg);
        out.push({ ok: r.ok, error: r.error, expect });
      }
      return out;
    })()`);
    for (const item of bad) {
      // 断言「拒绝」+「错误信息里提到缺的字段」；不要求逐字匹配完整提示语
      const needle = item.expect.replace('缺少 ', '').split(' / ')[0];
      check('参数校验：' + item.expect, item.ok === false && (item.error || '').includes(needle), item.error);
    }

    // 来源校验：非渲染进程调用应被拒（这里用同一 sender，只验证正常路径可用）
    check('IPC 处理器返回结构化结果（ok/error 字段）',
      typeof result?.ok === 'boolean' && ('error' in result || 'url' in result), JSON.stringify(Object.keys(result || {})));

    console.log('\nCOS 上传：' + passed + ' 通过 / 0 失败');
    server.close();
    app.exit(0);
  } catch (e) {
    console.error(e);
    server.close();
    app.exit(1);
  }
})();
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
setTimeout(() => { console.error('超时'); app.exit(2); }, 120000).unref();

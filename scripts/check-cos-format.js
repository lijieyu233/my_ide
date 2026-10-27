// COS 上传请求格式验证：本地 HTTP 服务器充当「假 COS」，抓真实请求逐项核对。
//
// 为什么值得测：签名算错会得到 403 SignatureDoesNotMatch，而 COS 不会说
// 「哪个参数不对」。只有把请求抓下来核对（方法/路径/签名头/Content-Type/体积）
// 才能确定格式是对的。
//
// 必须在 Electron 里跑：cos-upload 用 net.fetch，纯 Node 下没有这个对象；
// 之前用 globalThis.fetch 兜底注入，请求会挂住（Node fetch 与 net.fetch 语义不同）。
const { app } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs'), os = require('os');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-cosfmt-'));
os.homedir = () => home;
app.setPath('userData', path.join(home, 'profile'));
process.argv.push('--headless');

let passed = 0;
const check = (name, ok, extra) => { if (!ok) throw Error('FAIL: ' + name + (extra !== undefined ? ' | ' + extra : '')); passed++; console.log('ok ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); };

(async () => {
  try {
    await app.whenReady();
    const { register } = require('../src/main/clipboard/cos-upload');

    const seen = [];
    let nextStatus = 200;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, size: Buffer.concat(chunks).length });
        res.writeHead(nextStatus, { 'Content-Type': 'application/xml' });
        res.end(nextStatus === 200 ? '' : '<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>bad</Message></Error>');
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    // 注入一个把 host 换成 127.0.0.1 的 fetch，其余（方法/头/体）原样透传。
    // 用 net.fetch —— 与生产同一条链路，只是目标地址换了。
    const { net } = require('electron');
    const fetchToLocal = (url, init) => net.fetch(String(url).replace(/^https:\/\/[^/]+/, 'http://127.0.0.1:' + port), init);

    const handlers = new Map();
    // getWindow 返回一个「sender 匹配」的桩：生产里是真实窗口，
    // 处理器会校验 event.sender === getWindow().webContents。
    const fakeSender = {};
    register({
      ipcMain: { handle: (n, f) => handlers.set(n, f) },
      getWindow: () => ({ webContents: fakeSender }),
      fetch: fetchToLocal,
    });
    const upload = handlers.get('cos:upload');
    check('注册了 cos:upload 处理器', typeof upload === 'function');

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const evt = { sender: fakeSender };

    // 来源校验本身也要验一次：sender 不匹配必须拒绝
    const denied = await upload({ sender: {} }, { secretId: 'a', secretKey: 'b', bucket: 'c-1', region: 'r', key: 'k', body: 'AA==' });
    check('来源不匹配时拒绝上传', denied.ok === false && /来源无效/.test(denied.error || ''), denied.error);

    // ① 成功路径
    const ok = await upload(evt, {
      secretId: 'AKIDtest', secretKey: 'secretkey',
      bucket: 'demo-1250000000', region: 'ap-guangzhou',
      key: 'notes/pic one.png', body: png.toString('base64'), contentType: 'image/png',
    });
    check('上传成功返回 ok 与 url', ok.ok === true && /\/notes\/pic%20one\.png$/.test(ok.url || ''), ok.url || ok.error);
    check('只发出 1 个请求', seen.length === 1, seen.length);
    const req = seen[0];
    check('方法是 PUT', req.method === 'PUT', req.method);
    check('路径按段编码且保留分隔符', req.url === '/notes/pic%20one.png', req.url);
    check('带 Authorization 且含 40 位签名',
      /^q-sign-algorithm=sha1&q-ak=AKIDtest&/.test(req.headers.authorization || '') && /q-signature=[0-9a-f]{40}/.test(req.headers.authorization || ''));
    check('Content-Type 透传', req.headers['content-type'] === 'image/png', req.headers['content-type']);
    check('服务端收到的字节数正确', req.size === png.length, req.size + ' vs ' + png.length);

    // ② 错误路径
    nextStatus = 403; seen.length = 0;
    const fail = await upload(evt, {
      secretId: 'AKIDtest', secretKey: 'wrong',
      bucket: 'demo-1250000000', region: 'ap-guangzhou',
      key: 'a.png', body: png.toString('base64'), contentType: 'image/png',
    });
    check('403 时返回 ok:false', fail.ok === false);
    check('错误信息含状态码 403', /403/.test(fail.error || ''), fail.error?.slice(0, 50));
    check('错误信息含 COS 错误码', /SignatureDoesNotMatch/.test(fail.error || ''), fail.error?.slice(0, 90));

    // ③ 中文对象名
    nextStatus = 200; seen.length = 0;
    const cn = await upload(evt, {
      secretId: 'AKIDtest', secretKey: 'k',
      bucket: 'demo-1250000000', region: 'ap-guangzhou',
      key: '图片/我的 图.png', body: png.toString('base64'), contentType: 'image/png',
    });
    check('中文对象名上传成功', cn.ok === true, cn.error);
    check('中文路径正确编码',
      seen[0].url === '/%E5%9B%BE%E7%89%87/%E6%88%91%E7%9A%84%20%E5%9B%BE.png', seen[0].url);

    server.close();
    console.log('\nCOS 请求格式：' + passed + ' 通过 / 0 失败');
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
})();
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
setTimeout(() => { console.error('超时'); app.exit(2); }, 90000).unref();

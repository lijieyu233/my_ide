/**
 * 腾讯云 COS 上传（PUT Object）。
 *
 * 为什么放在主进程：签名要用 SecretKey 算 HMAC-SHA1，密钥绝不能进渲染进程
 * （页面上下文一旦有密钥，任何 XSS 都能捞走）。渲染层只传「要传哪段字节」，
 * 密钥在这里读取并只用于本次签名。
 *
 * 签名算法（COS 官方「签名算法 v5」简化版，用于 PUT Object）：
 *   KeyTime        = start;end
 *   SignKey        = HMAC-SHA1(SecretKey, KeyTime)          → hex
 *   HttpString     = put\n/<key>\n\n<host>\n                 （小写方法 + 小写路径）
 *   StringToSign   = sha1\n<KeyTime>\n<sha1(HttpString)>\n
 *   Signature      = HMAC-SHA1(SignKey, StringToSign)        → hex
 *   Authorization  = q-sign-algorithm=sha1&q-ak=<SecretId>&q-sign-time=<KeyTime>
 *                    &q-key-time=<KeyTime>&q-header-list=host&q-url-param-list=&q-signature=<Signature>
 *
 * 路径要做 URL 编码并用小写（COS 要求），但对象名本身保留原样传给 URL。
 */
const { createHmac, createHash } = require('crypto');
const { net } = require('electron');

const sha1hex = value => createHash('sha1').update(value, 'utf8').digest('hex');
const hmacHex = (key, value) => createHmac('sha1', key).update(value, 'utf8').digest('hex');

/** COS 要求的路径编码：逐段 encodeURIComponent，保留 '/'。 */
function encodePath(key) {
  return String(key).split('/').map(seg => encodeURIComponent(seg)).join('/');
}

function authorization({ secretId, secretKey, method, key, host, expiresIn = 600 }) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = now + ';' + (now + expiresIn);
  const signKey = hmacHex(secretKey, keyTime);
  // HttpString: 小写方法 \n 小写路径 \n 查询串 \n 小写 host \n
  const httpString = [method.toLowerCase(), '/' + encodePath(key).toLowerCase(), '', host.toLowerCase(), ''].join('\n');
  const stringToSign = ['sha1', keyTime, sha1hex(httpString), ''].join('\n');
  const signature = hmacHex(signKey, stringToSign);
  return 'q-sign-algorithm=sha1'
    + '&q-ak=' + secretId
    + '&q-sign-time=' + keyTime
    + '&q-key-time=' + keyTime
    + '&q-header-list=host'
    + '&q-url-param-list='
    + '&q-signature=' + signature;
}

function register({ ipcMain, getWindow, fetch: injectedFetch }) {
  // fetch 可注入：自检用本地 HTTP 服务器验证「请求格式是否正确」，
  // 不必连真实腾讯云（也没法在 CI 里放真密钥）。生产路径永远是 net.fetch。
  const doFetch = injectedFetch || net.fetch.bind(net);
  ipcMain.handle('cos:upload', async (event, options) => {
    if (getWindow()?.webContents !== event.sender) return { ok: false, error: '上传来源无效' };
    try {
      const opts = options || {};
      const secretId = String(opts.secretId || '').trim();
      const secretKey = String(opts.secretKey || '').trim();
      const bucket = String(opts.bucket || '').trim();     // 形如 my-bucket-1250000000
      const region = String(opts.region || '').trim();     // 形如 ap-guangzhou
      const key = String(opts.key || '').trim();
      if (!secretId || !secretKey) return { ok: false, error: '缺少 SecretId / SecretKey' };
      if (!bucket || !region) return { ok: false, error: '缺少 Bucket 或 Region' };
      if (!key) return { ok: false, error: '缺少对象键名' };
      if (!/^[a-z0-9-]+-\d+$/.test(bucket)) return { ok: false, error: 'Bucket 格式应为 name-appid（如 my-bucket-1250000000）' };
      const body = Buffer.from(String(opts.body || ''), 'base64');
      if (!body.length) return { ok: false, error: '没有图片数据' };
      // 单张上限与粘贴侧一致，避免绕过渲染层限制
      if (body.length > 10 * 1024 * 1024) return { ok: false, error: '图片超过 10MB' };

      const host = bucket + '.cos.' + region + '.myqcloud.com';
      const url = 'https://' + host + '/' + encodePath(key);
      const authorization_ = authorization({ secretId, secretKey, method: 'put', key, host });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      let response;
      try {
        response = await doFetch(url, {
          method: 'PUT',
          signal: controller.signal,
          headers: {
            // ⚠ Host 与 Content-Length 都是 Chromium 的「受限头」，
            // net.fetch 里手写它们会直接抛 net::ERR_INVALID_ARGUMENT。
            // 实测三个头逐一试：Host ✗、Content-Length ✗、Authorization ✓。
            // 前两者由 URL 与 body 自动决定，不需要也不应该手写。
            Authorization: authorization_,
            'Content-Type': String(opts.contentType || 'application/octet-stream'),
          },
          body,
        });
      } finally { clearTimeout(timer); }

      if (!response.ok) {
        // COS 的错误体是 XML，取前 300 字符便于排查（常见：签名不匹配 / 无权限 / bucket 不存在）
        let detail = '';
        try { detail = (await response.text()).slice(0, 300); } catch {}
        return { ok: false, error: 'COS 返回 ' + response.status + ' ' + response.statusText + (detail ? '：' + detail : '') };
      }
      return { ok: true, url, key, bytes: body.length };
    } catch (error) {
      const message = String((error && error.message) || error);
      return { ok: false, error: message.includes('abort') ? '上传超时（30s）' : message };
    }
  });
  return {};
}

module.exports = { register, authorization, encodePath };

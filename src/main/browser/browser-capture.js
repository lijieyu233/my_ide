const fs = require('fs'), path = require('path'), { randomUUID, createHash } = require('crypto');
const fail = (code, message) => Object.assign(Error(message), { code });
async function capture(wc, region, { directory, verify, timeoutMs = 5000 }) {
  let timer;
  const bounded = task => Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('BROWSER_TIMEOUT', '截图超时，未保存截图')), timeoutMs); })]).finally(() => clearTimeout(timer));
  verify();
  const viewport = await bounded(wc.executeJavaScriptInIsolatedWorld(999, [{ code: '({width:innerWidth,height:innerHeight})' }]));
  verify();
  const rect = Object.keys(region).length ? region : { x: 0, y: 0, width: viewport.width, height: viewport.height };
  if (rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.x + rect.width > viewport.width || rect.y + rect.height > viewport.height || rect.width * rect.height > 16 * 1024 * 1024)
    throw fail('INVALID_TOOL_ARGS', '截图区域必须位于当前网页视口内，最多1600万像素');
  const shot = await bounded(wc.capturePage(rect, { stayHidden: true, stayAwake: true }));
  verify();
  if (shot.isEmpty()) throw fail('BROWSER_CAPTURE_EMPTY', '网页尚无可截取画面，请等待页面显示');
  const bytes = shot.toPNG();
  if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw fail('BROWSER_CAPTURE_LIMIT', '截图超过16MiB限制');
  // 只创建随机命名的新文件，不接受网页或模型提供的路径，也不覆盖旧文件。
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'browser-' + randomUUID() + '.png');
  verify(); fs.writeFileSync(file, bytes, { flag: 'wx' });
  return { ok: true, committed: true, path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...shot.getSize(), region: rect, note: '已保存网页截图；未截取IDE或桌面。' };
}
module.exports = { capture };

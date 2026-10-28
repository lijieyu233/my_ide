/**
 * 远程图片下载（供 Markdown 导出内嵌用）。
 *
 * 为什么必须放在主进程：
 *   渲染进程的 CSP 是 `default-src 'self'`（renderer/index.html 第 5 行），没有声明
 *   connect-src，所以渲染层对任意 https 图片做 fetch 一律 "Failed to fetch"。
 *   img-src 虽然放行了 https（预览能显示图），但 **<img> 能渲染 ≠ fetch 能读到字节**，
 *   要把图片转成 base64 内嵌只能由主进程去取。2026-10-28 实测确认。
 *
 * 安全约束（这是能读任意 URL 的通道，必须收窄）：
 *   · 只允许 http/https，拒绝 file://、内网地址以外的协议
 *   · 只允许图片 Content-Type，避免被当成任意文件下载器
 *   · 大小上限 20MiB，超时 20s
 *   · 只返回 base64，不落盘
 */
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 20000;

/** 明显的内网/本机地址：导出内嵌不需要访问它们，直接拒绝以免变成 SSRF 跳板。 */
function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // IPv4 私网 / 环回 / 链路本地
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // IPv6 环回 / 唯一本地 / 链路本地
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  return false;
}

function register({ ipcMain, getWindow, fetch: injectedFetch }) {
  const doFetch = injectedFetch || (typeof require === 'function' ? require('electron').net.fetch.bind(require('electron').net) : fetch);

  ipcMain.handle('image:fetch-base64', async (event, options) => {
    if (getWindow()?.webContents !== event.sender) return { ok: false, error: '请求来源无效' };
    const url = String(options?.url || '').trim();
    if (!url) return { ok: false, error: '缺少图片地址' };

    let parsed;
    try { parsed = new URL(url); } catch { return { ok: false, error: '图片地址无效' }; }
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: '只支持 http / https 图片' };
    if (isPrivateHost(parsed.hostname)) return { ok: false, error: '拒绝访问内网或本机地址' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      let response;
      try {
        response = await doFetch(url, { signal: controller.signal, referrerPolicy: 'no-referrer' });
      } finally { clearTimeout(timer); }

      if (!response.ok) return { ok: false, error: 'HTTP ' + response.status };
      const type = String(response.headers.get('content-type') || '').toLowerCase();
      if (type && !type.startsWith('image/')) return { ok: false, error: '不是图片类型：' + type };
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > MAX_BYTES) return { ok: false, error: '图片超过 20MB' };

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_BYTES) return { ok: false, error: '图片超过 20MB' };
      if (!buffer.length) return { ok: false, error: '图片内容为空' };

      // 没有 content-type 时按常见图片魔数兜底判断
      if (!type) {
        const head = buffer.subarray(0, 4).toString('hex');
        const isImage = head.startsWith('89504e47') || head.startsWith('ffd8ff') || head.startsWith('47494638') || head.startsWith('52494646');
        if (!isImage) return { ok: false, error: '内容不是可识别的图片' };
      }
      return { ok: true, base64: buffer.toString('base64'), type: type || 'image/png', bytes: buffer.length };
    } catch (error) {
      const message = String((error && error.message) || error);
      return { ok: false, error: /abort/i.test(message) ? '下载超时（20s）' : message };
    }
  });
  return {};
}

module.exports = { register, isPrivateHost, MAX_BYTES };

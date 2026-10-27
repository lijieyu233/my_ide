/**
 * 远程文件虚拟路径路由。
 *
 * 目标：让「右键 → 编辑远程文件」直接把文件当作文档打开，标签页显示
 * `/app/frp/frps.toml` 这样的真实远程路径，读写直连 SFTP —— 中间不落本地盘。
 *
 * 做法：把远程文件表达成 `remote://<sessionId>/<绝对路径>`，然后在 fs:* IPC
 * 这一层拦截该前缀，转发给 remote-service。这样 viewer 的读盘、版本校验、
 * 保存链路一行都不用改（它们只认 path 字符串），也就保住了 saveQueues 串行、
 * diskVersion 复核、原子写入这些既有保障。
 *
 * 安全边界：只有已连接的会话能读；路径必须是绝对路径；大小仍受 8MiB 上限约束。
 */

const SCHEME = 'remote://';

/** 把远程路径编成虚拟路径（sessionId 用 encodeURIComponent，路径原样保留可读性）。 */
function remotePathOf(sessionId, remotePath) {
  return SCHEME + encodeURIComponent(sessionId) + remotePath;
}

/** 解析虚拟路径；不是远程路径返回 null。 */
function parseRemotePath(value) {
  if (typeof value !== 'string' || !value.startsWith(SCHEME)) return null;
  const rest = value.slice(SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  let sessionId;
  try { sessionId = decodeURIComponent(rest.slice(0, slash)); } catch { return null; }
  const remotePath = rest.slice(slash);
  if (!remotePath.startsWith('/') || /[\0\r\n]/.test(remotePath)) return null;
  // 根目录 `/` 不是文件，不能被当成文档打开（remote://s/ 这种要判为非法）。
  if (remotePath === '/') return null;
  return { sessionId, remotePath };
}

/** 版本号：远程文件用 mtime+size 组成稳定指纹，供 fs:writeFile 的 expectedVersion 复核。 */
const versionOf = stat => `remote:${stat.mtime}:${stat.size}`;

/**
 * 安装路由。传进来的 service 是 remote-service 实例。
 * 返回 { readFile, fileVersion, writeFile } 三个与 main.js 现有处理器同签名的函数，
 * 非远程路径一律返回 null 表示「不归我管」，由调用方走原来的本地实现。
 */
function installRemoteFs(service) {
  async function fatalPath(target) {
    const parsed = parseRemotePath(target);
    if (!parsed) return null;
    return parsed;
  }

  return {
    /** 读文本。返回 {text, encoding, version} 或 {error, errorCode}，与 fs:readFile 一致。 */
    async readFile(target, encoding, decode) {
      const parsed = await fatalPath(target);
      if (!parsed) return null;
      try {
        const file = await service.readTextFile(parsed.sessionId, parsed.remotePath, 8 * 1024 * 1024);
        if (file.absent) return { error: '文件不存在', errorCode: 'ENOENT', version: null };
        if (file.tooLarge) return { tooLarge: true, size: file.size, version: versionOf(file) };
        const decoded = decode(file.buffer, encoding);
        return { ...decoded, version: versionOf(file) };
      } catch (error) {
        return { error: String(error.message || error), errorCode: error.code || 'READ_FAILED' };
      }
    },
    /** 版本查询，与 fs:fileVersion 一致。 */
    async fileVersion(target) {
      const parsed = await fatalPath(target);
      if (!parsed) return null;
      try {
        const stat = await service.statTextFile(parsed.sessionId, parsed.remotePath);
        if (!stat) return { absent: true };
        return { version: versionOf(stat), absent: false };
      } catch (error) {
        return { error: String(error.message || error), errorCode: error.code || 'READ_FAILED' };
      }
    },
    /** 写回。条件校验与本地一致：expectedVersion 不匹配就拒绝。 */
    async writeFile(target, content, format, condition, encode) {
      const parsed = await fatalPath(target);
      if (!parsed) return null;
      try {
        const stat = await service.statTextFile(parsed.sessionId, parsed.remotePath);
        const current = stat ? versionOf(stat) : null;
        const expected = condition && condition.expectedVersion;
        if (expected && current && expected !== current) {
          return { error: '远程文件已被他人修改，请重新打开后再保存', errorCode: 'STALE_VERSION' };
        }
        // ⚠ format 可能是空值：TextFormat.encodeText 内部会读 format.encoding，
        // 传 null 会抛 "Cannot read properties of null (reading 'encoding')"。
        // 编辑器没指定编码时按 UTF-8 无 BOM 处理（与本地默认一致）。
        const effective = format && typeof format === 'object'
          ? format
          : { encoding: typeof format === 'string' ? format : 'utf8', bom: false };
        const buffer = encode(content, effective);
        const written = await service.writeTextFile(parsed.sessionId, parsed.remotePath, buffer);
        return { textFormat: effective, version: versionOf(written) };
      } catch (error) {
        return { error: String(error.message || error), errorCode: error.code || 'WRITE_FAILED' };
      }
    },
  };
}

module.exports = { SCHEME, remotePathOf, parseRemotePath, installRemoteFs, versionOf };

// md-paste-image.js —— 粘贴图片的落盘 / 上传策略（统一入口，供 md 编辑器调用）
//
// 支持四种去处：
//   'project'  项目根目录（默认；不存在则回落到笔记同目录）
//   'assets'   笔记同目录的 assets/（不存在自动创建）
//   'custom'   用户指定的固定目录（同步盘/云盘挂载点等）
//   'cos'      腾讯云对象存储，直传后 MD 里插 https 链接
//
// 为什么默认改成「项目根目录」：用户明确要求。按笔记同目录的 assets/ 时，
// 一个项目里几十篇笔记就会有几十个 assets 目录，图片分散难找；统一放项目根
// 下一处更容易备份与整体迁移。
window.MdPasteImage = (() => {
  const KEY = 'myide-paste-image-dir';
  // 单张图片上限：10MiB。再大光是 base64 转换就会让界面卡顿。
  const MAX_BYTES = 10 * 1024 * 1024;
  const MODES = ['project', 'assets', 'custom', 'cos'];

  const readSetting = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && MODES.includes(raw.mode)) {
        return {
          mode: raw.mode,
          dir: typeof raw.dir === 'string' ? raw.dir : '',
          cos: raw.cos && typeof raw.cos === 'object'
            ? { secretId: raw.cos.secretId || '', secretKey: raw.cos.secretKey || '',
                bucket: raw.cos.bucket || '', region: raw.cos.region || '',
                prefix: raw.cos.prefix || '', publicBase: raw.cos.publicBase || '' }
            : { secretId: '', secretKey: '', bucket: '', region: '', prefix: '', publicBase: '' },
        };
      }
    } catch {}
    return { mode: 'project', dir: '', cos: { secretId: '', secretKey: '', bucket: '', region: '', prefix: '', publicBase: '' } };
  };
  const writeSetting = value => {
    try { localStorage.setItem(KEY, JSON.stringify(value)); return true; } catch { return false; }
  };

  /**
   * 内容短哈希：6 位十六进制，用于「同一秒粘两张」时防撞名。
   *
   * ⚠ 早先版本采样步长固定 13 字节 —— 实测两张不同的 4×4 PNG（字节数极少、
   * 差异落在步长之外）算出了同一个哈希，防撞名等于没做。现在全字节 + 长度混入。
   */
  function shortHash(bytes) {
    let h = 2166136261;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
    h ^= bytes.length; h = Math.imul(h, 16777619);
    return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
  }

  /**
   * 笔记名 → 文件名片段。保留中日韩字符（「我的笔记-…png」比「_-…png」有用），
   * 只替换 Windows/Unix 都禁止的字符与空白。
   */
  function slugOf(mdPath) {
    const name = String(mdPath || '').split(/[\\/]/).pop().replace(/\.(md|markdown)$/i, '');
    const safe = name.replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    return (safe || 'note').slice(0, 40) || 'note';
  }

  const pad = n => String(n).padStart(2, '0');
  function stamp(date = new Date()) {
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate())
      + '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  }

  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' };
  const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };

  function toBase64(bytes) {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(binary);
  }

  /** 项目根目录：App.root；没有项目时返回空串。 */
  function projectRoot() {
    try { return String(window.App?.root || window.MI?.activeRoot || ''); } catch { return ''; }
  }

  /**
   * 保存一张粘贴的图片，返回插入 Markdown 的引用。
   * 成功 { ref, absPath?, url? }；失败 { error }。
   */
  async function save(file, mdPath) {
    if (!file) return { error: '没有图片数据' };
    if (file.size > MAX_BYTES) {
      return { error: '图片 ' + (file.size / 1048576).toFixed(1) + 'MB，超过 ' + (MAX_BYTES / 1048576) + 'MB 上限；请压缩后再粘贴' };
    }
    const setting = readSetting();
    const mdDir = String(mdPath || '').replace(/[\\/][^\\/]+$/, '');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = EXT[file.type] || 'png';
    const name = slugOf(mdPath) + '-' + stamp() + '-' + shortHash(bytes) + '.' + ext;

    // ① COS：直传对象存储，MD 里插公网 URL
    if (setting.mode === 'cos') {
      const cos = setting.cos || {};
      if (!cos.secretId || !cos.secretKey || !cos.bucket || !cos.region) {
        return { error: 'COS 未配置完整（设置 → 编辑器 → 粘贴图片：需要 SecretId / SecretKey / Bucket / Region）' };
      }
      const key = (cos.prefix ? cos.prefix.replace(/^\/+|\/+$/g, '') + '/' : '') + name;
      const result = await window.myIDE.cosUpload?.({
        ...cos,
        key,
        body: toBase64(bytes),
        contentType: MIME[ext] || 'application/octet-stream',
      });
      if (!result?.ok) return { error: result?.error || '上传 COS 失败' };
      // 自定义域名优先；否则用官方默认域名
      const base = (cos.publicBase || ('https://' + cos.bucket + '.cos.' + cos.region + '.myqcloud.com')).replace(/\/+$/, '');
      return { ref: base + '/' + key, url: base + '/' + key };
    }

    if (!mdDir) return { error: '这个笔记还没有保存到磁盘，无法确定图片位置' };

    // ② 本地三种模式
    let targetDir, refPrefix;
    if (setting.mode === 'custom' && setting.dir) {
      targetDir = setting.dir;
      refPrefix = null;            // 自定义目录用 file:/// 绝对 URL
    } else if (setting.mode === 'assets') {
      targetDir = mdDir + '\\assets';
      refPrefix = 'assets/';
      try { await window.myIDE.fs.mkdir?.(targetDir); } catch {} // 交给 writeBinary 兜底
    } else if (setting.mode === 'project') {
      const root = projectRoot();
      // 项目根下的 assets/ —— 一处存放，便于整体备份/迁移。
      // 没有项目根（单文件打开）时回落到笔记同目录。
      targetDir = root ? root + '\\assets' : mdDir;
      refPrefix = root
        ? (String(mdPath).startsWith(root) ? 'assets/' : null)
        : '';
      if (refPrefix === null) {
        // 笔记不在项目内：绝对路径引用，避免相对路径算错
        targetDir = mdDir + '\\assets';
        refPrefix = 'assets/';
      }
    } else {
      targetDir = mdDir;
      refPrefix = '';
    }

    const target = targetDir.replace(/[/\\]+$/, '') + '\\' + name;
    const written = await window.myIDE.fs.writeBinary(target, toBase64(bytes));
    if (!written || (!written.ok && written.error)) {
      return { error: (written && written.error) || '写入失败' };
    }
    if (refPrefix === null) return { ref: 'file:///' + target.replace(/\\/g, '/'), absPath: target };
    return { ref: refPrefix + name, absPath: target };
  }

  return { save, readSetting, writeSetting, MAX_BYTES, KEY, MODES };
})();

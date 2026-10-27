// md-paste-image.js —— 粘贴图片的落盘策略（统一入口，供 md 编辑器调用）
//
// 当前实现在 viewer.js 里是一段内联代码，有几个实测出来的问题：
//  · assets/ 不存在时不创建，图片全堆在笔记同目录；
//  · 文件名只到秒，同一秒粘两张会撞名（实测两次生成的名字完全相同，后一张覆盖前一张）；
//  · 文件名是「粘贴图片-中文」，跨平台分享/GitHub 上容易出问题；
//  · 没有大小上限，20MB 图会整块进内存（base64 还要再放大 33%）。
//
// 本模块把策略集中起来，并支持「可配置存储位置」：
//   setting = 'assets'    → 笔记同目录下的 assets/（不存在则自动创建，默认）
//   setting = 'same'      → 笔记同目录
//   setting = 'custom'    → 用户指定的固定目录（比如某个同步盘/云盘路径）
// 自定义目录下的图片用绝对路径引用（file:/// 或相对路径都不稳），
// 需要用户自己保证那个目录可访问。
window.MdPasteImage = (() => {
  const KEY = 'myide-paste-image-dir';
  // 单张图片上限：10MiB。超过就拒绝 —— 再大光是 base64 转换就会让界面卡顿。
  const MAX_BYTES = 10 * 1024 * 1024;

  const readSetting = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && (raw.mode === 'assets' || raw.mode === 'same' || raw.mode === 'custom')) {
        return { mode: raw.mode, dir: typeof raw.dir === 'string' ? raw.dir : '' };
      }
    } catch {}
    return { mode: 'assets', dir: '' };
  };
  const writeSetting = value => {
    try { localStorage.setItem(KEY, JSON.stringify(value)); return true; } catch { return false; }
  };

  /**
   * 内容短哈希：6 位十六进制。
   *
   * ⚠ 早先版本采样步长固定 13 字节 —— 实测两张不同的 4×4 PNG（字节数极少、
   * 差异落在步长之外）算出了**同一个哈希**，防撞名直接失效。现在改成
   * 「全字节参与 + 长度混入」，短文件也能区分开。
   */
  function shortHash(bytes) {
    let h = 2166136261;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
    // 把长度也混进去，避免「内容不同但同长度前缀相同」这类碰撞
    h ^= bytes.length; h = Math.imul(h, 16777619);
    return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
  }

  /**
   * 笔记名 → 文件名片段。
   *
   * 保留中日韩等非 ASCII 字母（它们在现代文件系统与 git 里都没问题，而且
   * 「我的笔记-…png」比「_-…png」有用得多 —— 后者是早先无差别 ASCII 化的结果，
   * 中文名全变成下划线，根本看不出图来自哪篇笔记）。
   * 只把 Windows/Unix 都禁止的字符和空白替换掉。
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

  /**
   * 保存一张粘贴的图片，返回插入到 Markdown 里的引用路径。
   * mdPath：笔记的绝对路径（用来推导目录与命名）。
   * 失败返回 { error }，由调用方提示。
   */
  async function save(file, mdPath) {
    if (!file) return { error: '没有图片数据' };
    if (file.size > MAX_BYTES) {
      return { error: '图片 ' + (file.size / 1048576).toFixed(1) + 'MB，超过 ' + (MAX_BYTES / 1048576) + 'MB 上限；请压缩后再粘贴' };
    }
    const setting = readSetting();
    const mdDir = String(mdPath || '').replace(/[\\/][^\\/]+$/, '');
    if (!mdDir) return { error: '这个笔记还没有保存到磁盘，无法确定图片位置' };

    const buf = new Uint8Array(await file.arrayBuffer());
    const ext = EXT[file.type] || 'png';
    const name = slugOf(mdPath) + '-' + stamp() + '-' + shortHash(buf) + '.' + ext;

    let targetDir, refPrefix;
    if (setting.mode === 'custom' && setting.dir) {
      targetDir = setting.dir;
      // 自定义目录：用 file:/// 绝对 URL 引用，避免相对路径在别的笔记里失效
      refPrefix = null;
    } else if (setting.mode === 'same') {
      targetDir = mdDir;
      refPrefix = '';
    } else {
      // assets/：不存在就创建（旧实现只「发现有就用」，没有就堆在笔记旁边）
      targetDir = mdDir + '\\assets';
      refPrefix = 'assets/';
      try {
        await window.myIDE.fs.mkdir?.(targetDir);
      } catch {
        // mkdir 不存在或不支持时，交给 writeBinary（它会 mkdir -p 父目录）
      }
    }

    // base64 转换：分块拼接，避免超长字符串一次性展开导致栈问题
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    const target = targetDir.replace(/[/\\]+$/, '') + '\\' + name;
    const written = await window.myIDE.fs.writeBinary(target, btoa(binary));
    if (!written || (!written.ok && written.error)) {
      return { error: (written && written.error) || '写入失败' };
    }

    if (refPrefix === null) {
      // 自定义目录：转成 file:/// 绝对 URL（Windows 路径要换成正斜杠）
      return { ref: 'file:///' + target.replace(/\\/g, '/'), absPath: target };
    }
    return { ref: refPrefix + name, absPath: target };
  }

  return { save, readSetting, writeSetting, MAX_BYTES, KEY };
})();

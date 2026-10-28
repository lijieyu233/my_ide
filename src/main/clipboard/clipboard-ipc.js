/**
 * 剪贴板监听 + IPC 注册。
 *
 * 采集方式：轮询（Electron 没有跨平台的「剪贴板变化」事件）。
 * 实测开销（本机）：readText 单次 0.049ms、availableFormats 0.002ms、
 * readImage 0.140ms；1.2 秒轮询 10 秒的进程 CPU 是 16ms（0.147% 单核）。
 * 所以「轮询会吃 CPU」这个担心在实测面前不成立。
 *
 * 两级检测：先 availableFormats（几乎免费）判断有没有新类型，
 * 再按需 readText / readImage —— 避免每秒都去读一遍图片数据。
 *
 * 开关语义（用户明确要求）：
 *   - 可手动开启/关闭监听，状态存进 settings.watch，重启后沿用；
 *   - 只有 MyIDE 进程活着才监听（关闭应用 = 进程退出 = 监听自然停止），
 *     不做后台常驻服务、不写自启动项。
 */
const { createClipboardStore } = require('./clipboard-store');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const POLL_MS = 1200;

function register({ app, ipcMain, clipboard, getWindow }) {
  const store = createClipboardStore({
    dir: require('path').join(app.getPath('userData'), 'clipboard'),
    emit: event => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('clipboard-history:event', event);
    },
  });

  // ── 监听循环 ──────────────────────────────────────────────────────────
  let timer = null;
  let lastText = null;
  let lastImageSig = null;
  let paused = false;      // 运行时暂停（不写盘，只是停止采集）
  let polling = false;

  function imageSignature(image) {
    if (!image || image.isEmpty()) return null;
    // 抽稀采样位图做指纹：判「是不是同一张图」足够，且比 toPNG 便宜得多。
    const size = image.getSize();
    const bitmap = image.toBitmap();
    let h = 2166136261;
    for (let i = 0; i < bitmap.length; i += 97) { h ^= bitmap[i]; h = Math.imul(h, 16777619); }
    return size.width + 'x' + size.height + ':' + (h >>> 0) + ':' + bitmap.length;
  }

  async function tick() {
    if (polling || paused) return;
    polling = true;
    try {
      const formats = clipboard.availableFormats();
      const hasImage = formats.some(f => /^image\//.test(f));
      const hasText = formats.some(f => /^text\//.test(f));

      // 图片与文字各自独立判断、独立入库。
      //
      // 以前的写法是 `if (hasImage) {...} else if (hasText) {...}` —— 同一次复制里
      // 既有图片又有文字时（浏览器右键「复制图片」经常同时给 image + text/html、
      // 截图工具也会附一段说明文字），文字那条会被整个丢掉。用户明确要求拆开存。
      //
      // 现在两条路互不影响：图片变了就存图片，文字变了就存文字。
      // 只有「图片没变、文字只是跟着图片一起被重设」这种噪音才要防 ——
      // 所以文字仍然用 lastText 判重，不会因为图片的重新写入而重复入库。
      if (hasImage) {
        const image = clipboard.readImage();
        const sig = imageSignature(image);
        if (sig && sig !== lastImageSig) {
          lastImageSig = sig;
          await store.addImage(image.toPNG());
        }
      }
      if (hasText) {
        const text = clipboard.readText();
        if (text && text !== lastText) {
          lastText = text;
          await store.addText(text);
        }
      }
      // 剪贴板里只剩一种类型时，把另一种的「上次值」清掉，
      // 否则隔了很久再复制同一张图/同一段文字会被误判成「没变化」。
      if (!hasImage) lastImageSig = null;
      if (!hasText) lastText = null;
    } catch {
      // 剪贴板被别的程序短暂占住会失败：跳过这一轮，不打扰用户。
    } finally {
      polling = false;
    }
  }

  function startWatch() {
    if (timer) return;
    timer = setInterval(() => { void tick(); }, POLL_MS);
    timer.unref?.();
  }
  function stopWatch() { if (timer) { clearInterval(timer); timer = null; } }

  void store.ready().then(() => {
    // 启动时只记录「当前剪贴板基准」，不把用户在开 IDE 之前复制的东西收进来
    // （那可能是半小时前复制的一段密码，不该被无声归档）。
    try {
      lastText = clipboard.readText() || null;
      lastImageSig = imageSignature(clipboard.readImage());
    } catch {}
    // 沿用上次的开关状态。
    if (store.currentSettings().watch !== false) startWatch();
  });

  // ── IPC ───────────────────────────────────────────────────────────────
  const ops = {
    list: (query) => store.list(query),
    addText: text => store.addText(text),
    addImageBase64: base64 => store.addImage(Buffer.from(String(base64 || ''), 'base64')),
    readImage: id => store.readImage(id),
    /**
     * 把选中的历史条目导出成真实文件，返回路径列表（2026-10-28）。
     *
     * 用途：Windows 剪贴板一次只能放一张位图，但可以放**一批文件**（CF_HDROP）。
     * 所以「一次复制多张图 / 图文混排」的正解是把它们落成文件再走 copyFiles。
     *   · 图片：直接用它自己那份 images/<id>.png（不复制字节，零开销）
     *   · 文字：写成 .txt（内容原样，UTF-8）
     * 全部落在 userData 下的 clip-export/ 里，按需覆盖，不污染历史目录。
     */
    exportAsFiles: async ids => {
      const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
      if (!list.length) return { files: [] };
      const dir = path.join(app.getPath('userData'), 'clip-export');
      await fsp.mkdir(dir, { recursive: true });
      const files = [];
      for (const id of list) {
        const entry = (await store.list()).entries.find(e => e.id === id);
        if (!entry) continue;
        if (entry.kind === 'image') {
          const abs = path.join(store.root, entry.file);
          if (fs.existsSync(abs)) files.push(abs);
        } else {
          // 文件名取首行的可读前缀，避免全是 text-1.txt 这种没法分辨的名字
          const firstLine = String(entry.text || '').split('\n').find(l => l.trim()) || 'clipboard';
          const safe = firstLine.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 40).replace(/[.\s]+$/, '') || 'clipboard';
          const target = path.join(dir, safe + '-' + id.slice(0, 6) + '.txt');
          await fsp.writeFile(target, String(entry.text || ''), 'utf8');
          files.push(target);
        }
      }
      return { files, dir };
    },
    /**
     * 把历史里的图片写回系统剪贴板（2026-10-28）。
     *
     * 之前渲染层调用 clip.copyImageBase64 —— 这个 API 根本不存在，
     * `?.()` 直接返回 undefined，代码再兜底「重新入库」并显示“已复制到剪贴板”，
     * 实际什么都没复制。这里补上真实实现：主进程 clipboard.writeImage。
     */
    copyImage: async id => {
      const data = await store.readImage(id);
      if (!data?.base64) return { ok: false, error: '读不到这张图片' };
      try {
        const { nativeImage } = require('electron');
        const image = nativeImage.createFromBuffer(Buffer.from(data.base64, 'base64'));
        if (image.isEmpty()) return { ok: false, error: '图片内容无法解码' };
        clipboard.writeImage(image);
        // 回读确认：写完后系统剪贴板里应当有一张同尺寸的图
        const readBack = clipboard.readImage();
        if (readBack.isEmpty()) return { ok: false, error: '写入后剪贴板仍为空' };
        const size = readBack.getSize();
        return { ok: true, bytes: Buffer.from(data.base64, 'base64').length, width: size.width, height: size.height };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
    update: (id, patch) => store.update(id, patch),
    remove: ids => store.remove(ids),
    cleanup: opts => store.cleanup(opts),
    // 设置：watch 走这里，同时真正启停轮询（不只是记个布尔值）
    settings: async patch => {
      const result = await store.setSettings(patch);
      if (typeof patch?.watch === 'boolean') {
        if (patch.watch) { paused = false; startWatch(); } else stopWatch();
      }
      return result;
    },
    pause: value => { paused = !!value; return { paused }; },
    state: async () => ({
      paused,
      watching: !!timer,
      settings: store.currentSettings(),
      ...(await store.list()),
    }),
  };
  for (const [name, fn] of Object.entries(ops)) {
    ipcMain.handle('clipboard-history:' + name, async (event, ...args) => {
      if (getWindow()?.webContents !== event.sender) return { ok: false, error: '剪贴板历史操作来源无效' };
      try { return { ok: true, data: await fn(...args) }; }
      catch (error) { return { ok: false, error: String(error.message || error) }; }
    });
  }

  app.on('will-quit', () => stopWatch());
  return { store, stopWatch, startWatch };
}

module.exports = { register };

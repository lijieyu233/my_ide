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
      if (hasImage) {
        const image = clipboard.readImage();
        const sig = imageSignature(image);
        if (sig && sig !== lastImageSig) {
          lastImageSig = sig;
          // 截图工具常常同时放图片和文本：以图片为准，文本只更新基准值。
          await store.addImage(image.toPNG());
          lastText = clipboard.readText() || lastText;
        }
      } else if (hasText) {
        const text = clipboard.readText();
        if (text && text !== lastText) {
          lastText = text;
          lastImageSig = null;
          await store.addText(text);
        }
      }
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

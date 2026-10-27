// 端到端：剪贴板历史完整链路（真实主进程 + 真实剪贴板 + 真实 UI）。
// 覆盖：自动采集文字/图片、去重、列表渲染、编辑保存、固定、删除、按天数/大小清理、监听开关。
const { app, BrowserWindow, clipboard, nativeImage } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const zlib = require('zlib');

// 生成一张真正有效的 PNG。
// 教训：直接用网上抄来的 base64 常量可能是一张无效图（nativeImage.isEmpty() 为 true、
// 尺寸 0×0），writeImage 会静默失败、availableFormats 里也就没有 image/*，
// 于是「图片采集没生效」这个假象会误导排查。这里现场编码一张 8×8 纯色 PNG。
function makePng(width = 8, height = 8) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = 200; raw[o + 1] = 60; raw[o + 2] = 60;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.concat([t, data]);
    let c = ~0;
    for (const b of crcBuf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    const crc = Buffer.alloc(4); crc.writeUInt32BE((~c) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-clip-e2e-'));
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'a.md'), '# a\n');
os.homedir = () => home;
app.setPath('userData', path.join(home, 'profile'));
process.argv.push('--headless');

let win, passed = 0;
const check = (name, ok, extra) => {
  if (!ok) throw Error('FAIL: ' + name + (extra !== undefined ? ' | ' + extra : ''));
  passed++; console.log('ok ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const probe = s => win.webContents.executeJavaScript(s, true);
const wait = async (s, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await probe(s)) return true; await sleep(60); }
  throw Error('wait timeout: ' + s);
};

(async () => {
  try {
    require('../main');
    await app.whenReady();
    for (let n = 0; n < 200 && !BrowserWindow.getAllWindows().length; n++) await sleep(50);
    win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1400, 900); await sleep(500); win.setContentSize(1400, 900);
    await wait('!!window.App&&!!window.ClipboardPanel&&!!window.myIDE?.clipboardHistory');
    await probe(`Theme.set('crimson');App.openProject(${JSON.stringify(project.split(path.sep).join('/'))})`);
    await wait(`App.root===${JSON.stringify(project.split(path.sep).join('/'))}`);

    // ① 用「真实鼠标点击工具条按钮」打开面板 —— 这是唯一能发现
    //    「按钮没接 onClick」的验证方式。之前用 App.showTool 直接调 API，
    //    跳过了 tool-strip.js 的 actions 映射与 shortcuts 注册，于是按钮点不动
    //    而测试全绿。
    const btnPos = await probe(`(() => {
      const b = document.getElementById('tool-clipboard');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    check('工具条按钮存在', !!btnPos);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: btnPos.x, y: btnPos.y });
    await sleep(80);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: btnPos.x, y: btnPos.y, button: 'left', clickCount: 1 });
    await sleep(60);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: btnPos.x, y: btnPos.y, button: 'left', clickCount: 1 });
    await sleep(800);
    const afterClick = await probe(`(() => ({
      tool: App.getTool(),
      hidden: document.getElementById('clipboard-main').classList.contains('hidden'),
    }))()`);
    check('真实点击工具条按钮能打开面板', afterClick.tool === 'clipboard' && afterClick.hidden === false,
      JSON.stringify(afterClick));

    // ② 自动采集文字：写系统剪贴板，等轮询（1.2s）
    const marker = 'E2E 剪贴板文本 ' + Date.now();
    clipboard.writeText(marker);
    await sleep(2200);
    const afterText = await probe(`(async()=>{const r=await window.myIDE.clipboardHistory.list('');return {n:r.data.entries.length, first:r.data.entries[0]?.text}})()`);
    check('自动采集到文字（1.2s 轮询后）', afterText.n >= 1 && afterText.first === marker, JSON.stringify(afterText.first?.slice(0, 40)));

    // ③ 去重：同一内容再写一次，条数不增加，但时间前移
    const countBefore = afterText.n;
    clipboard.writeText('另一条 ' + Date.now());
    await sleep(2000);
    clipboard.writeText(marker);   // 回到第一条内容
    await sleep(2000);
    const afterDup = await probe(`(async()=>{const r=await window.myIDE.clipboardHistory.list('');return {n:r.data.entries.length, first:r.data.entries[0]?.text}})()`);
    check('重复内容不新增条目（只前移）', afterDup.n === countBefore + 1, 'before=' + countBefore + ' after=' + afterDup.n);
    check('重复内容被提到最前', afterDup.first === marker);

    // ④ 自动采集图片
    const png = makePng(8, 8);
    const image = nativeImage.createFromBuffer(png);
    check('测试用 PNG 有效（尺寸非零）', !image.isEmpty(), JSON.stringify(image.getSize()));
    clipboard.writeImage(image);
    await sleep(2200);
    const afterImg = await probe(`(async()=>{const r=await window.myIDE.clipboardHistory.list('');const im=r.data.entries.find(e=>e.kind==='image');return {hasImage:!!im, bytes:im?.bytes, stats:r.data.stats}})()`);
    check('自动采集到图片', afterImg.hasImage === true, JSON.stringify(afterImg.stats));

    // ④b 同一次复制里既有图片又有文字：两条都要单独入库。
    // 以前 `if (hasImage) {...} else if (hasText) {...}` 会把文字整条丢掉。
    const bothText = '同时复制的说明文字 ' + Date.now();
    clipboard.clear();
    clipboard.writeImage(nativeImage.createFromBuffer(makePng(10, 10)));
    // Electron 的 writeImage 只写图片；要模拟「图片 + 文字」同时存在，
    // 需要在图片之后追加文本格式（真实来源：浏览器右键复制图片会同时给两种格式）。
    clipboard.write({ text: bothText, image: nativeImage.createFromBuffer(makePng(10, 10)) });
    await sleep(2400);
    const both = await probe(`(async () => {
      const r = await window.myIDE.clipboardHistory.list('');
      const texts = r.data.entries.filter(e => e.kind === 'text').map(e => e.text);
      return {
        total: r.data.stats.total, texts: r.data.stats.texts, images: r.data.stats.images,
        hasText: texts.some(t => t === ${JSON.stringify(bothText)}),
      };
    })()`);
    check('同时含图片与文字时，文字也入库了', both.hasText === true, JSON.stringify(both));
    check('同时含图片与文字时，图片也入库了', both.images >= 1, JSON.stringify(both));

    // ⑤ UI 列表渲染
    const uiRows = await probe(`document.querySelectorAll('#clip-list .clip-row').length`);
    check('列表渲染出条目', uiRows >= 2, 'rows=' + uiRows);

    // ⑥ 编辑保存（只改正文 —— 备注输入框已按用户要求移除）
    const edited = await probe(`(async()=>{
      const r = await window.myIDE.clipboardHistory.list('');
      const text = r.data.entries.find(e=>e.kind==='text' && e.text === ${JSON.stringify(marker)});
      if (!text) return { error: 'target not found' };
      const up = await window.myIDE.clipboardHistory.update(text.id, { text: ${JSON.stringify(marker)} + '（已改）' });
      return { ok: up.ok, text: up.data?.text };
    })()`);
    check('编辑能改正文', edited.ok === true && String(edited.text || '').includes('（已改）'), edited.error);

    // ⑦ 搜索（仍可按正文搜；备注字段保留在数据里但界面不再提供编辑）
    const searched = await probe(`(async()=>{const r=await window.myIDE.clipboardHistory.list('（已改）');return r.data.entries.length})()`);
    check('能按正文搜索', searched >= 1, 'hits=' + searched);

    // ⑦b UI 上不应再有备注输入框，且操作按钮在顶部 meta 行里
    const uiDetail = await probe(`(() => {
      const detail = document.getElementById('clip-detail');
      const meta = detail?.querySelector('.clip-detail-meta');
      return {
        hasNoteInput: !!detail?.querySelector('#clip-note, .clip-note'),
        hasFoot: !!detail?.querySelector('.clip-detail-foot'),
        buttonsInMeta: meta ? [...meta.querySelectorAll('[data-clip-act]')].map(b => b.dataset.clipAct) : [],
        buttonsBelowText: !!detail?.querySelector('.clip-text + .clip-detail-foot'),
      };
    })()`);
    check('界面上已没有备注输入框', uiDetail.hasNoteInput === false);
    check('操作按钮在顶部 meta 行里', uiDetail.buttonsInMeta.length >= 3, uiDetail.buttonsInMeta.join(','));
    check('不再有底部按钮条', uiDetail.hasFoot === false && uiDetail.buttonsBelowText === false);

    // ⑧ 固定
    const pinned = await probe(`(async()=>{
      const r = await window.myIDE.clipboardHistory.list('');
      const e = r.data.entries[0];
      const up = await window.myIDE.clipboardHistory.update(e.id, { pinned: true });
      return { ok: up.ok, pinned: up.data?.pinned };
    })()`);
    check('能固定条目', pinned.ok === true && pinned.pinned === true);

    // ⑨ 删除
    const removed = await probe(`(async()=>{
      const r = await window.myIDE.clipboardHistory.list('');
      const e = r.data.entries[0];
      const del = await window.myIDE.clipboardHistory.remove([e.id]);
      const after = await window.myIDE.clipboardHistory.list('');
      return { ok: del.ok, removed: del.data?.removed, left: after.data.entries.length };
    })()`);
    check('能删除条目', removed.ok === true && removed.removed === 1, JSON.stringify(removed));

    // ⑨b 删除不能弹确认框。
    // 之前用的是浏览器原生 confirm()，Electron 里会弹出一个标题为 my-ide 的
    // 系统对话框，风格与界面完全不搭（用户截图反馈的就是它）。
    // 这里通过「覆写 window.confirm 记录是否被调用」来判断，而不是看界面上有没有框。
    const noConfirm = await probe(`(async () => {
      let called = 0;
      const original = window.confirm;
      window.confirm = () => { called++; return true; };
      try {
        const r = await window.myIDE.clipboardHistory.list('');
        const target = r.data.entries[0];
        // 走真实 UI 路径：选中它再点删除按钮
        document.querySelector('[data-clip-id="' + target.id + '"]')?.click();
        await new Promise(r2 => setTimeout(r2, 200));
        document.querySelector('#clip-detail [data-clip-act="delete"]')?.click();
        await new Promise(r2 => setTimeout(r2, 500));
        const left = (await window.myIDE.clipboardHistory.list('')).data.stats.total;
        return { called, left };
      } finally { window.confirm = original; }
    })()`);
    check('点删除不弹确认框', noConfirm.called === 0, 'confirm 被调用 ' + noConfirm.called + ' 次');

    // ⑩ 按天数清理：把 maxAgeDays 设 0.0001（约 8.6 秒）→ 立即清掉全部
    await probe(`(async()=>{ await window.myIDE.clipboardHistory.addText('将被清理的一条'); })()`);
    await sleep(200);
    const aging = await probe(`(async()=>{
      const before = (await window.myIDE.clipboardHistory.list('')).data.stats.total;
      await new Promise(r=>setTimeout(r,9000));
      const set = await window.myIDE.clipboardHistory.settings({ maxAgeDays: 0.0001, maxBytes: 512*1024*1024 });
      const after = (await window.myIDE.clipboardHistory.list('')).data;
      return { before, cleaned: set.data?.cleaned?.removed, afterTotal: after.stats.total, afterImages: after.stats.images };
    })()`);
    check('按天数清理真的删了条目', aging.cleaned > 0 && aging.afterTotal < aging.before, JSON.stringify(aging));

    // ⑪ 监听开关：关掉后不再采集
    const watchOff = await probe(`(async()=>{
      const r = await window.myIDE.clipboardHistory.settings({ watch: false });
      return { watch: r.data?.settings?.watch, watching: (await window.myIDE.clipboardHistory.state()).data.watching };
    })()`);
    check('能关闭监听', watchOff.watch === false && watchOff.watching === false, JSON.stringify(watchOff));
    clipboard.writeText('关闭监听后不该入库 ' + Date.now());
    await sleep(2400);
    const afterOff = await probe(`(async()=>({n:(await window.myIDE.clipboardHistory.list('')).data.stats.total}))()`);
    check('关闭监听后不再采集', afterOff.n === 0, 'total=' + afterOff.n);

    // ⑫ 重新开启
    const watchOn = await probe(`(async()=>{
      const r = await window.myIDE.clipboardHistory.settings({ watch: true });
      return { watch: r.data?.settings?.watch, watching: (await window.myIDE.clipboardHistory.state()).data.watching };
    })()`);
    check('能重新开启监听', watchOn.watch === true && watchOn.watching === true, JSON.stringify(watchOn));
    clipboard.writeText('重新开启后应入库 ' + Date.now());
    await sleep(2400);
    const afterOn = await probe(`(async()=>({n:(await window.myIDE.clipboardHistory.list('')).data.stats.total}))()`);
    check('重新开启后恢复采集', afterOn.n >= 1, 'total=' + afterOn.n);

    console.log('\n剪贴板历史端到端：' + passed + ' 通过 / 0 失败');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
})();
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
setTimeout(() => { console.error('超时'); app.exit(2); }, 180000).unref();

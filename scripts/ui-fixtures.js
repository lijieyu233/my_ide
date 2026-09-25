// scripts/ui-fixtures.js —— UI 自检用的测试素材（图片 / mermaid 文档 / 项目栏压力数据）
// 只被 main.js 的 --check-ui 模式使用；自检结束后由调用方清理。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- 手写 PNG 编码器（零依赖，同 make-icon.js 的做法） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngEncode(w, h, rgba) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 大尺寸测试图：渐变底 + 网格 + 红色外框 —— 缩放/平移是否生效肉眼可判
function makePng(w, h) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const edge = x < 6 || y < 6 || x >= w - 6 || y >= h - 6;
      const grid = x % 100 < 2 || y % 100 < 2;
      if (edge) { px[i] = 220; px[i + 1] = 60; px[i + 2] = 60; px[i + 3] = 255; continue; }
      if (grid) { px[i] = 245; px[i + 1] = 245; px[i + 2] = 245; px[i + 3] = 255; continue; }
      px[i] = Math.round(30 + (x / w) * 190);       // R：左暗右亮
      px[i + 1] = Math.round(90 + (y / h) * 120);   // G：上暗下亮
      px[i + 2] = Math.round(200 - (x / w) * 150);  // B
      px[i + 3] = 255;
    }
  }
  return pngEncode(w, h, px);
}

const MMD_DOC = [
  '# Mermaid 全屏验证', '',
  '普通段落：图的右上角应出现「⛶」按钮，点击后全屏查看。', '',
  '```mermaid',
  'flowchart LR',
  '  A[开始] --> B{判断}',
  '  B -->|是| C[处理]',
  '  B -->|否| D[结束]',
  '```', '',
  '```mermaid',
  'sequenceDiagram',
  '  用户->>IDE: 打开 md',
  '  IDE->>渲染器: mermaid.render',
  '  渲染器-->>用户: SVG',
  '```', '',
].join('\n');

// 大纲（PyCharm Structure 风格）验证文档：层级清晰，便于断言箭头/缩进/复制范围
const OUTLINE_DOC = [
  '# 一级标题', '',
  '一级正文。', '',
  '## 二级 A', '',
  '二级 A 正文。', '',
  '### 三级 A1', '',
  '三级 A1 正文。', '',
  '## 二级 B', '',
  '二级 B 正文。', '',
].join('\n');

// 换行验证文档：正文列被限到 820px 后，这些长行必须在列内折行而不是溢出
//   · LONG_PARA：一整个长段落（中文折行）
//   · 表格源码：live 预览里表格不是 widget，就是一行超长的 | a | b | 源码
//   · 长路径 / 长 URL：中途没有空格，靠 overflow-wrap 断
const WRAP_DOC = [
  '# 换行验证', '',
  '## 1. 长段落', '',
  '这段文字故意写得很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长，用来验证正文列在 820px 处会正常折行。', '',
  '## 2. 长路径（无空格，靠 overflow-wrap 断）', '',
  'D:\\document\\code\\ditto-takinghead-benchmark\\feature\\worker\\generation\\timeline\\source_timeline_rolling_playback_controller.ts', '',
  '## 3. 表格源码（live 预览里就是一行超长文本）', '',
  '| 模块 / 入口 | 当前实际行次 | 本次必须处理的边界与改造要点 | 备注 |',
  '| --- | --- | --- | --- |',
  '| app.py:create_app | 应用级创建 Timeline / WorkerEngineProxy / DialogueManager | 按运行会话拆分子媒体与调度 | 阶段一 |',
  '', '## 4. 长代码行（围栏里不折行是正常的，这里只保证它不出列）', '',
  '```python',
  'result = engine.dispatch(session_id=session.id, timeline=source_timeline, rolling=True, cover=cover, extra={"a": 1, "b": 2})',
  '```', '',
  '## 5. 引用块里的长行', '',
  '> 代码基线：D:\\document\\code\\ditto-takinghead-benchmark，本次复核 HEAD 为 0945727，同时参考工作区已有修订与未提交改动。', '',
].join('\n');

// 写入图片与 md 素材
function writeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const png = path.join(dir, '_ui_big.png');
  const md = path.join(dir, '_ui_mmd.md');
  fs.writeFileSync(png, makePng(1200, 800));
  fs.writeFileSync(md, MMD_DOC, 'utf8');
  fs.writeFileSync(path.join(dir, '_ui_outline.md'), OUTLINE_DOC, 'utf8');
  fs.writeFileSync(path.join(dir, '_ui_wrap.md'), WRAP_DOC, 'utf8');
  // 项目规则文件（AI 助手会把它注入系统提示）
  try { fs.mkdirSync(path.join(dir, '.myide'), { recursive: true }); } catch {}
  // 沙箱/杀软可能短暂持锁：演示用的规则文件，写失败不致命（内容已在）—— 别让它崩掉整个自检
  try { fs.writeFileSync(path.join(dir, '.myide', 'ai-rules.md'), '文档统一用「~」而不是波浪线；术语一律用「变更列表」。\n', 'utf8'); }
  catch (e) { console.error('[fixture] ai-rules.md 写入跳过:', e.code || e.message); }
  return { png, md };
}

// M3 夹具：一个**真实的独立小仓库**，用来端到端验 hunk 级暂存。
// ⚠ 不能用 demo 项目做这件事 —— demo 的仓库根就是 my_ide 本体，在那里暂存 hunk 等于改使用者的 index。
//   这里建的仓库在 demo/_ui_hunkrepo（被 .gitignore 排除），每次跑自检重建一次，结束进回收站。
async function writeHunkFixture(baseDir) {
  const G = require('../git-service');
  const rp = path.join(baseDir, '_ui_hunkrepo');
  if (fs.existsSync(rp)) {
    // ⚠ 不能用 fs.rmSync（本机 safe-delete 会接管批量/递归删除）→ 挪到同盘回收站
    const trash = path.join(baseDir, '..', '.ui-check-trash');
    try {
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(rp, path.join(trash, '_ui_hunkrepo_' + Date.now()));
    } catch {}
  }
  fs.mkdirSync(rp, { recursive: true });
  await G.initRepo(rp);
  const base = Array.from({ length: 20 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n';
  fs.writeFileSync(path.join(rp, 'h.txt'), base);
  await G.commit(rp, { message: 'base', files: ['h.txt'] });
  // 两处改动隔得够远 → 必然切成两个 hunk（供「只暂存其中一块」验证）
  fs.writeFileSync(path.join(rp, 'h.txt'), base.replace('line 2\n', 'line 2 CHANGED\n').replace('line 18\n', 'line 18 CHANGED\n'));
  return rp;
}

// M4 夹具：一个**必然冲突**的小仓库（base → feat 改同一行 → main 也改同一行）。
// 与 hunk 夹具同一套规矩：独立仓库、被 .gitignore 覆盖、跑完进回收站。
async function writeConflictFixture(baseDir) {
  const G = require('../git-service');
  const rp = path.join(baseDir, '_ui_confrepo');
  if (fs.existsSync(rp)) {
    const trash = path.join(baseDir, '..', '.ui-check-trash');
    try {
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(rp, path.join(trash, '_ui_confrepo_' + Date.now()));
    } catch {}
  }
  fs.mkdirSync(rp, { recursive: true });
  await G.initRepo(rp);
  await G.setUserConfig(rp, { name: 'ui-check', email: 'ui-check@example.com' });
  const base = 'line1\nline2\nline3\n';
  fs.writeFileSync(path.join(rp, 'c.txt'), base);
  await G.commit(rp, { message: 'base', files: ['c.txt'] });
  await G.createBranch(rp, 'feat');
  fs.writeFileSync(path.join(rp, 'c.txt'), 'line1\nfeat\nline3\n');
  await G.commit(rp, { message: 'feat: 改同一行', files: ['c.txt'] });
  await G.checkout(rp, 'main');
  fs.writeFileSync(path.join(rp, 'c.txt'), 'line1\nmain\nline3\n');
  await G.commit(rp, { message: 'main: 也改这一行', files: ['c.txt'] });
  return rp;
}

// 项目栏压力：13 个真实小目录（只入项目列表，不逐个打开扫盘），用于复现「按钮挤压/覆盖/截断」
function seedProjects(baseDir) {
  const list = [baseDir];
  for (let i = 1; i <= 13; i++) {
    const d = path.join(baseDir, '_ui_proj' + String(i).padStart(2, '0'));
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'README.md'), '# 项目 ' + i + '\n', 'utf8');
    } catch {}
    list.push(d);
  }
  return list;
}

function cleanFixtures(dir) {
  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };
  rm(path.join(dir, '_ui_big.png'));
  rm(path.join(dir, '_ui_mmd.md'));
  rm(path.join(dir, '_ui_outline.md'));
  rm(path.join(dir, '_ui_wrap.md'));
  rm(path.join(dir, '_ui_drop.md'));   // 拖拽步骤建的
  rm(path.join(dir, '_ui_perm.md'));   // 授权记忆步骤建的
  for (let i = 1; i <= 13; i++) rm(path.join(dir, '_ui_proj' + String(i).padStart(2, '0')));
  // M3/M4 夹具仓库（真实 git 仓库，含 .git）：rmSync 在本机会被 safe-delete 接管 → 挪到同盘回收站
  for (const name of ['_ui_hunkrepo', '_ui_confrepo']) {
    const rp = path.join(dir, name);
    if (fs.existsSync(rp)) {
      const trash = path.join(dir, '..', '.ui-check-trash');
      try {
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(rp, path.join(trash, name + '_' + Date.now()));
      } catch {}
    }
  }
}
module.exports = { makePng, writeFixtures, seedProjects, writeHunkFixture, writeConflictFixture, cleanFixtures, MMD_DOC, OUTLINE_DOC, WRAP_DOC };

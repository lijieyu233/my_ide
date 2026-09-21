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

// 写入图片与 md 素材
function writeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const png = path.join(dir, '_ui_big.png');
  const md = path.join(dir, '_ui_mmd.md');
  fs.writeFileSync(png, makePng(1200, 800));
  fs.writeFileSync(md, MMD_DOC, 'utf8');
  fs.writeFileSync(path.join(dir, '_ui_outline.md'), OUTLINE_DOC, 'utf8');
  return { png, md };
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
  rm(path.join(dir, '_ui_drop.md'));   // 拖拽步骤建的
  rm(path.join(dir, '_ui_perm.md'));   // 授权记忆步骤建的
  for (let i = 1; i <= 13; i++) rm(path.join(dir, '_ui_proj' + String(i).padStart(2, '0')));
}

module.exports = { makePng, writeFixtures, seedProjects, cleanFixtures, MMD_DOC, OUTLINE_DOC };

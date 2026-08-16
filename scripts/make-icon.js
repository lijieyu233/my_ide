// scripts/make-icon.js —— 程序化生成应用图标（手写 PNG 编码器，零图像库）
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 256, H = 256;
const px = Buffer.alloc(W * H * 4);

// ---------- CRC32 ----------
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

// ---------- PNG 编码 ----------
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
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘制 ----------
const R = 46; // 圆角半径
function inRoundRect(x, y) {
  const x0 = R, x1 = W - R, y0 = R, y1 = H - R;
  if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
  const cx = x < x0 ? x0 : x > x1 ? x1 : x;
  const cy = y < y0 ? y0 : y > y1 ? y1 : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
}
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
// 点阵 M 字模
const M_BITMAP = ['10001', '11011', '11011', '10101', '10101', '10001', '10001'];

function draw() {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!inRoundRect(x, y)) { px[i + 3] = 0; continue; }
      const t = y / H;
      px[i] = lerp(0x2f, 0x1e, t);       // R 渐变 #2f6fae → #1e3f66
      px[i + 1] = lerp(0x6f, 0x3f, t);
      px[i + 2] = lerp(0xae, 0x66, t);
      px[i + 3] = 255;
      // 绿色提交条（底部）
      if (y >= H - 42 && y <= H - 24 && x >= 42 && x <= W - 42) {
        px[i] = 0x3f; px[i + 1] = 0xb9; px[i + 2] = 0x50; // #3fb950
      }
    }
  }
  // M 字模（白色，加粗：绘制两次偏移）
  const scale = 22;
  const ox = Math.floor((W - 5 * scale) / 2);
  const oy = Math.floor((H - 7 * scale) / 2) - 14;
  const putPixel = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255;
  };
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (M_BITMAP[row][col] !== '1') continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          putPixel(ox + col * scale + dx, oy + row * scale + dy);
        }
      }
    }
  }
  // 加粗：向右下偏移 2px 再画一次
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (M_BITMAP[row][col] !== '1') continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          putPixel(ox + col * scale + dx + 2, oy + row * scale + dy + 2);
        }
      }
    }
  }
}

draw();
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, pngEncode(W, H, px));

// 校验
const buf = fs.readFileSync(out);
const sig = [0x89, 0x50, 0x4e, 0x47].every((b, i) => buf[i] === b);
const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
console.log('icon.png', buf.length, 'bytes,', w + 'x' + h, 'signature:', sig ? 'OK' : 'FAIL');
if (!sig || w !== 256) process.exit(1);
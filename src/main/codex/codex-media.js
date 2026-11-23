const fs = require('node:fs/promises');
const path = require('node:path');
const { nativeImage } = require('electron');

const maxImageBytes = 12 * 1024 * 1024;
const maxPreviewChars = 240000;
const maxHistoryChars = 1200000;
const inlineImage = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
const localRaster = /\.(?:png|jpe?g|webp|gif)$/i;

function format(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return '';
}

async function readRaster(file) {
  if (typeof file !== 'string') return;
  if (process.platform === 'win32' && file.startsWith('\\\\?\\') && /^[a-z]:\\/i.test(file.slice(4))) file = file.slice(4);
  if (!path.isAbsolute(file) || !localRaster.test(file) || /^\\\\/.test(file)) return;
  try {
    const real = await fs.realpath(file);
    if (/^\\\\/.test(real)) return;
    const stat = await fs.stat(real);
    const { size } = stat;
    if (!size || size > maxImageBytes || !stat.isFile()) return;
    const handle = await fs.open(real, 'r');
    try {
      const bytes = Buffer.alloc(size);
      const { bytesRead } = await handle.read(bytes, 0, size, 0);
      if (bytesRead === size) return bytes;
    } finally { await handle.close(); }
  } catch {}
}

async function preview({ url, file, encoded }) {
  if (typeof url === 'string' && url.length <= maxImageBytes * 1.4) encoded = inlineImage.exec(url)?.[1];
  let bytes;
  if (typeof encoded === 'string' && encoded.length <= maxImageBytes * 1.4 && /^[A-Za-z0-9+/=]+$/.test(encoded)) {
    bytes = Buffer.from(encoded, 'base64');
  }
  bytes ||= await readRaster(file);
  if (!bytes?.length || bytes.length > maxImageBytes) return;
  const mime = format(bytes);
  if (!mime) return;
  if (bytes.length * 4 / 3 < maxPreviewChars) return 'data:image/' + mime + ';base64,' + bytes.toString('base64');
  try {
    const bitmap = nativeImage?.createFromBuffer(bytes);
    if (!bitmap || bitmap.isEmpty()) return;
    const { width, height } = bitmap.getSize();
    const size = width >= height ? { width: Math.min(width, 540) } : { height: Math.min(height, 540) };
    const data = bitmap.resize(size).toJPEG(78).toString('base64');
    if (data.length < maxPreviewChars) return 'data:image/jpeg;base64,' + data;
  } catch {}
}

function imageCandidates(item) {
  switch (item.type) {
    case 'userMessage':
      return (item.content || []).flatMap(block => block.type === 'image' ? [{ url: block.url }]
        : block.type === 'localImage' ? [{ file: block.path }] : []);
    case 'imageView':
      return [{ file: item.path }];
    case 'imageGeneration':
      return [{ file: item.savedPath, encoded: item.result }];
    case 'mcpToolCall':
      return (item.result?.content || []).filter(block => block?.type === 'image').map(block => ({ encoded: block.data }));
    case 'dynamicToolCall':
      return (item.contentItems || []).filter(block => block?.type === 'inputImage').map(block => ({ url: block.imageUrl }));
    default:
      return [];
  }
}

function createMediaReader() {
  let remaining = maxHistoryChars, attempts = 0;
  return async item => {
    const images = [];
    for (const source of imageCandidates(item).slice(0, 8)) {
      if (remaining <= 32 || attempts++ >= 16) break;
      const data = await preview(source);
      if (!data || data.length > remaining) continue;
      remaining -= data.length;
      images.push(data);
    }
    return images;
  };
}

function isMediaItem(item) {
  return ['imageView', 'imageGeneration', 'mcpToolCall', 'dynamicToolCall'].includes(item?.type);
}

function mediaLabel(item, count) {
  if (item.type === 'imageGeneration') return '生成的图片';
  if (item.type === 'imageView') return '查看了 ' + count + ' 张图片';
  return '工具图片';
}

module.exports = { createMediaReader, isMediaItem, mediaLabel };

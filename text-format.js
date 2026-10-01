// 编码不是“成功写盘”的附带选项：有损转换会让原文件在用户没察觉时变成问号。
const iconv = require('iconv-lite');
function error(code, message) { return Object.assign(new Error(message), { code }); }
const supported = new Set(['utf8', 'utf16le', 'utf16be', 'gbk']);
const normalize = (value) => String(value).toLowerCase().replace(/[-_]/g, '');
function detectEncoding(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) return { encoding: 'utf8', bom: true, detection: 'bom' };
  if (bytes.subarray(0, 2).equals(Buffer.from([255, 254]))) return { encoding: 'utf16le', bom: true, detection: 'bom' };
  if (bytes.subarray(0, 2).equals(Buffer.from([254, 255]))) return { encoding: 'utf16be', bom: true, detection: 'bom' };
  let even = 0, odd = 0;
  for (let i = 0; i + 1 < Math.min(bytes.length, 2048); i += 2) { if (!bytes[i]) even++; if (!bytes[i + 1]) odd++; }
  if (bytes.length >= 8 && (even >= 2 && !odd || odd >= 2 && !even)) return { encoding: even ? 'utf16be' : 'utf16le', bom: false, detection: 'heuristic' };
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return { encoding: 'utf8', bom: false, detection: 'validated' }; }
  catch { return { encoding: 'gbk', bom: false, detection: 'fallback' }; }
}
function eolOf(content) {
  const list = content.match(/\r\n|\r|\n/g) || [];
  const kinds = new Set(list);
  return kinds.size > 1 ? 'MIXED' : list[0] === '\r\n' ? 'CRLF' : list[0] === '\r' ? 'CR' : list.length ? 'LF' : null;
}
function validUnicode(content) {
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const low = content.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function decodeText(bytes, override) {
  let format = detectEncoding(bytes);
  if (override) {
    const encoding = normalize(override);
    if (!supported.has(encoding)) throw error('UNSUPPORTED_ENCODING', '不支持的文件编码：' + override);
    format = { encoding, bom: !!(format && format.bom && format.encoding === encoding), detection: 'selected' };
  }
  if (!format) return { binary: true, size: bytes.length };
  const payload = format.bom ? bytes.subarray(format.encoding === 'utf8' ? 3 : 2) : bytes;
  let content;
  if (format.encoding.startsWith('utf16')) {
    if (payload.length % 2) throw error('INVALID_ENCODING', 'UTF-16字节数为奇数，请重新选择文件编码');
    const le = format.encoding === 'utf16be' ? Buffer.from(payload).swap16() : payload;
    content = le.toString('utf16le');
  } else if (format.encoding === 'utf8') {
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload); }
    catch { throw error('INVALID_ENCODING', '文件不是有效UTF-8，请重新选择文件编码'); }
  } else {
    content = iconv.decode(payload, 'gbk');
    if (content.includes('\ufffd')) throw error('INVALID_ENCODING', '文件无法完整解码为GBK，请重新选择文件编码');
    format.canonical = iconv.encode(content, 'gbk').equals(payload);
  }
  if (!validUnicode(content)) throw error('INVALID_ENCODING', '文件包含无效Unicode代理项，请重新选择文件编码');
  format.eol = eolOf(content);
  return { content, encoding: format.encoding, textFormat: format };
}
function encodeText(content, input = { encoding: 'utf8', bom: false }) {
  if (typeof content !== 'string') throw error('INVALID_CONTENT', '文本写入内容必须是字符串');
  const format = typeof input === 'string' ? { encoding: normalize(input), bom: normalize(input).startsWith('utf16') } : { ...input, encoding: normalize(input.encoding || 'utf8') };
  if (!supported.has(format.encoding)) throw error('UNSUPPORTED_ENCODING', '不支持的文件编码：' + format.encoding);
  if (!validUnicode(content)) throw error('ENCODING_LOSS', '正文包含孤立Unicode代理项，拒绝有损保存');
  if (format.encoding === 'gbk') {
    if (format.bom) throw error('INVALID_FORMAT', 'GBK不支持BOM');
    if (format.canonical === false) throw error('ENCODING_LOSS', '原GBK字节存在非规范映射，请明确选择UTF-8保存');
    const bytes = iconv.encode(content, 'gbk');
    if (iconv.decode(bytes, 'gbk') !== content) throw error('ENCODING_LOSS', 'GBK无法无损保存这些字符，请选择UTF-8保存；原文件未修改');
    return bytes;
  }
  let bytes = Buffer.from(content, format.encoding === 'utf8' ? 'utf8' : 'utf16le');
  if (format.encoding === 'utf16be') bytes.swap16();
  if (format.bom) bytes = Buffer.concat([Buffer.from(format.encoding === 'utf8' ? [239, 187, 191] : format.encoding === 'utf16le' ? [255, 254] : [254, 255]), bytes]);
  return bytes;
}
module.exports = { detectEncoding, decodeText, encodeText, eolOf };

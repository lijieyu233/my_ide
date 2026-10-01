const fs = require('fs'), path = require('path');
const fail = (code, message, win32Code) => Object.assign(Error(message), { code, win32Code });
let native;
function getNative() {
  if (!native) {
    const dll = require('koffi').load('kernel32.dll');
    native = {
      open: dll.func('__stdcall', 'CreateFileW', 'void *', ['str16','uint32','uint32','void *','uint32','uint32','void *']),
      close: dll.func('__stdcall', 'CloseHandle', 'int', ['void *']),
      dispose: dll.func('__stdcall', 'SetFileInformationByHandle', 'int', ['void *','int','void *','uint32']),
      firstStream: dll.func('__stdcall', 'FindFirstStreamW', 'void *', ['str16','int','void *','uint32']),
      nextStream: dll.func('__stdcall', 'FindNextStreamW', 'int', ['void *','void *']),
      closeSearch: dll.func('__stdcall', 'FindClose', 'int', ['void *']),
      lastError: dll.func('__stdcall', 'GetLastError', 'uint32', []),
    };
  }
  return native;
}
const valid = h => h && h !== -1n && h !== 0xffffffffffffffffn;
function winError(api, message) {
  const code = api.lastError();
  return fail([32,33].includes(code) ? 'EBUSY' : code === 5 ? 'EACCES' : code === 145 ? 'STALE_OPERATION' : 'REMOVE_FAILED', message+'（'+code+'）', code);
}
function noExtraStreams(api, name) {
  // 主数据流为空不代表ADS为空；额外数据流没有本次新建来源，一律保留。
  const data = Buffer.alloc(600);
  const search = api.firstStream(path.toNamespacedPath(name), 0, data, 0);
  if (!valid(search)) {
    if (api.lastError() === 38) return;
    throw winError(api, '无法核对文件数据流，未撤销');
  }
  try {
    do {
      const stream = data.toString('utf16le', 8).split('\0')[0];
      if (stream !== '::$DATA') throw fail('STALE_OPERATION', '新建项已有额外数据流，未删除');
    } while (api.nextStream(search, data));
    if (api.lastError() !== 38) throw winError(api, '文件数据流检查失败，未撤销');
  } finally { api.closeSearch(search); }
}
function removeEmpty(name, verify, api = getNative(), io = fs) {
  // DELETE句柄不共享写/删除：保护默认流和路径身份；Windows仍允许新增ADS，需另核对。
  const handle = api.open(path.toNamespacedPath(name), 0x80010000, 1, null, 3, 0x02200000, null);
  if (!valid(handle)) throw winError(api, '新建项被占用或无权撤销');
  let committed = false;
  try {
    verify();
    verify();
    noExtraStreams(api, name);
    if (!api.dispose(handle, 4, Buffer.from([1]), 1)) throw winError(api, '新建项已变化或无法删除，未撤销');
    committed = true;
  } finally {
    if (!api.close(handle)) throw Object.assign(winError(api, '撤销句柄关闭失败，请核对磁盘'), { committed });
  }
  // 其他兼容的读取句柄可能使删除暂挂；此时不谎报完成，不降级rm。
  try { io.lstatSync(name); }
  catch (e) { if (e.code === 'ENOENT') return { ok: true }; throw Object.assign(e, { committed }); }
  throw Object.assign(fail('REMOVE_PENDING', '删除已提交但仍有读取句柄，请关闭占用后重试'), { committed: true });
}
module.exports = { removeEmpty };

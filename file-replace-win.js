// rename会丢原DACL和ADS；ReplaceFileW合并这些元数据，且必须提供backup才能保全1176/1177失败。
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
let native;
function getNative() {
  if (!native) {
    const dll = require('koffi').load('kernel32.dll');
    const security = require('koffi').load('advapi32.dll');
    native = {
      replace: dll.func('__stdcall', 'ReplaceFileW', 'int', ['str16', 'str16', 'str16', 'uint32', 'void *', 'void *']),
      lastError: dll.func('__stdcall', 'GetLastError', 'uint32', []),
      getAttributes: dll.func('__stdcall', 'GetFileAttributesW', 'uint32', ['str16']),
      setAttributes: dll.func('__stdcall', 'SetFileAttributesW', 'int', ['str16', 'uint32']),
      move: dll.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint32']),
      free: dll.func('__stdcall', 'LocalFree', 'void *', ['void *']),
      getSecurity: security.func('uint32_t __stdcall GetNamedSecurityInfoW(str16 name, uint32_t object, uint32_t info, void *owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)'),
      getControl: security.func('int __stdcall GetSecurityDescriptorControl(void *descriptor, _Out_ uint16_t *control, _Out_ uint32_t *revision)'),
      setSecurity: security.func('__stdcall', 'SetNamedSecurityInfoW', 'uint32', ['str16', 'uint32', 'uint32', 'void *', 'void *', 'void *', 'void *']),
    };
  }
  return native;
}

function createFile(source, target) {
  const api = getNative();
  // 不带REPLACE_EXISTING，既有目标必失败；FAT/exFAT没有硬链接，不能用linkSync创建发行版文件。
  if (!api.move(path.toNamespacedPath(source), path.toNamespacedPath(target), 0)) {
    const code = api.lastError();
    throw Object.assign(Error('Windows文件创建失败（' + code + '）'), { code: [80, 183].includes(code) ? 'EEXIST' : code === 5 ? 'EACCES' : 'CREATE_FAILED', win32Code: code });
  }
  return { temporaryMoved: true };
}

function prepareTemporary(source, target) {
  const api = getNative(), dacl = [null], descriptor = [null], control = [0], revision = [0];
  try {
    const code = api.getSecurity(path.toNamespacedPath(target), 1, 4, null, null, dacl, null, descriptor);
    if (code) throw Object.assign(Error('无法读取原文件权限（' + code + '），未写入临时正文'), { code: 'EACCES', win32Code: code });
    if (!api.getControl(descriptor[0], control, revision)) throw Object.assign(Error('无法读取原文件权限继承状态'), { code: 'EACCES' });
    // 临时文件继承目录权限可能比原文件宽；必须在写入正文前复制DACL及继承标记。
    const flags = (4 | ((control[0] & 0x1000) ? 0x80000000 : 0x20000000)) >>> 0;
    const result = api.setSecurity(path.toNamespacedPath(source), 1, flags, null, null, dacl[0], null);
    if (result) throw Object.assign(Error('无法保全临时文件权限（' + result + '），未写入临时正文'), { code: 'EACCES', win32Code: result });
  } finally { if (descriptor[0]) api.free(descriptor[0]); }
}

function createReplacer(api, io = fs) {
  return (source, target) => {
    const backup = path.join(path.dirname(target), '.myide-recover-' + randomUUID() + '.tmp');
    const windowsPath = (name) => path.toNamespacedPath(name);
    const bridge = api || getNative();
    if (bridge.getAttributes) {
      const attributes = bridge.getAttributes(windowsPath(target));
      // ReplaceFile只保证文档列出的元数据；隐藏/系统/索引等普通属性从原文件显式保留。
      const ordinary = (attributes & (1 | 2 | 4 | 32 | 256 | 4096 | 8192)) || 128;
      if (attributes === 0xffffffff || !bridge.setAttributes(windowsPath(source), ordinary)) {
        const code = bridge.lastError();
        throw Object.assign(Error('无法保全Windows文件属性（' + code + '）'), { code: 'EACCES', win32Code: code });
      }
    }
    // flags=0：不能为了“保存成功”而忽略ACL或元数据合并失败。
    if (!bridge.replace(windowsPath(target), windowsPath(source), windowsPath(backup), 0, null, null)) {
      const win32Code = bridge.lastError();
      const recoveryPath = io.existsSync(backup) ? backup : null;
      const preserveTemporary = win32Code === 1176 || win32Code === 1177;
      throw Object.assign(Error('Windows文件替换失败（' + win32Code + '），修改仍未保存'
        + (recoveryPath ? '；原文件恢复副本：' + recoveryPath : '')), {
        code: win32Code === 5 ? 'EACCES' : [32, 33].includes(win32Code) ? 'EBUSY' : 'REPLACE_FAILED',
        win32Code, recoveryPath, preserveTemporary, pendingPath: preserveTemporary ? source : null,
      });
    }
    try { io.unlinkSync(backup); }
    catch (e) {
      if (e.code !== 'ENOENT') return { recoveryPath: backup, cleanupError: String(e.message || e), committed: true };
    }
    return {};
  };
}
module.exports = { createReplacer, createFile, prepareTemporary, replaceFile: createReplacer() };

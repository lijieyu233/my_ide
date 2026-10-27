// remote:// 虚拟路径路由的单元测试（不连服务器：只验解析、编码、边界拒绝）。
const assert = require('assert/strict');
const { remotePathOf, parseRemotePath } = require('../src/main/remote/remote-fs');
let passed = 0;
const check = (name, ok) => { assert(ok, name); passed++; console.log('ok ' + name); };

check('编码：会话 id 与远程路径拼成 remote:// 形式',
  remotePathOf('abc-123', '/app/frp/frps.toml') === 'remote://abc-123/app/frp/frps.toml');
check('会话 id 含特殊字符会被转义（否则解析时切不开）',
  remotePathOf('a/b:c', '/x') === 'remote://a%2Fb%3Ac/x');
check('解析：往返一致', (() => {
  const v = remotePathOf('sid-1', '/var/log/syslog');
  const parsed = parseRemotePath(v);
  return parsed && parsed.sessionId === 'sid-1' && parsed.remotePath === '/var/log/syslog';
})());
check('解析：远程路径里的中文与空格原样保留',
  (() => { const p = parseRemotePath(remotePathOf('s', '/目录/有 空格.txt'));
    return p && p.remotePath === '/目录/有 空格.txt'; })());

// 边界：非远程路径一律返回 null，交给本地实现
for (const value of ['C:\\Users\\a.txt', '/home/u/a.txt', 'remote:', 'remote://', 'remote://s', 'remote://s/', '']) {
  check('非远程路径返回 null：' + JSON.stringify(value), parseRemotePath(value) === null);
}
// remote://sid/x 解析出的是 remotePath='/x'（斜杠既是分隔符也是远程绝对路径的开头），
// 所以「相对路径」在这里不存在 —— 能构造出的非法情形只有根目录本身与含控制字符的。
check('根目录不能当文件打开', parseRemotePath('remote://sid/') === null);
check('拒绝含换行的路径（防注入）', parseRemotePath('remote://sid/a\nb') === null);
check('拒绝含 NUL 的路径', parseRemotePath('remote://sid/a\0b') === null);
check('非字符串返回 null', parseRemotePath(null) === null && parseRemotePath(42) === null);

// 未连接会话时读写都要给出明确错误码，不能静默成功
const { createService } = require('../src/main/remote/remote-service');
const fs = require('fs'), path = require('path'), os = require('os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-rfs-test-'));
const service = createService({ file: path.join(root, 'c.json'), crypto: { isEncryptionAvailable: () => false }, verifyHost: () => true, emit: () => {} });
(async () => {
  for (const [label, fn] of [
    ['readTextFile', () => service.readTextFile('nope', '/a.txt')],
    ['statTextFile', () => service.statTextFile('nope', '/a.txt')],
    ['writeTextFile', () => service.writeTextFile('nope', '/a.txt', Buffer.from('x'))],
  ]) {
    await assert.rejects(fn, error => error.code === 'DISCONNECTED', label + ' 应报 DISCONNECTED');
    check('未连接会话时 ' + label + ' 明确拒绝（DISCONNECTED）', true);
  }
  service.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('远程虚拟路径：' + passed + ' 通过 / 0 失败');
})().catch(error => { console.error(error); process.exitCode = 1; });

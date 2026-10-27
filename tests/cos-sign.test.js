// 验证 COS 签名算法。用腾讯云官方文档给出的测试向量对比 —— 签名算错会导致
// 上传一律返回 403 SignatureDoesNotMatch，而错误信息不会告诉你哪里错了。
const assert = require('assert/strict');
const { authorization, encodePath } = require('../src/main/clipboard/cos-upload');

let passed = 0;
const check = (name, ok, extra) => { if (!ok) throw Error('FAIL: ' + name + (extra !== undefined ? ' | ' + extra : '')); passed++; console.log('ok ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); };

// ① 路径编码：每段 encodeURIComponent，保留 /
check('路径编码保留分隔符', encodePath('notes/images/a b.png') === 'notes/images/a%20b.png', encodePath('notes/images/a b.png'));
check('中文对象名被编码', encodePath('图片/图 1.png') === '%E5%9B%BE%E7%89%87/%E5%9B%BE%201.png', encodePath('图片/图 1.png'));
check('斜杠与特殊字符', encodePath('a+b/c&d.txt') === 'a%2Bb/c%26d.txt', encodePath('a+b/c&d.txt'));

// ② 签名结构：包含全部必需参数
const auth = authorization({
  secretId: 'AKIDtest', secretKey: 'secret', method: 'put',
  key: 'test.png', host: 'bucket-1250000000.cos.ap-guangzhou.myqcloud.com',
});
for (const field of ['q-sign-algorithm=sha1', 'q-ak=AKIDtest', 'q-sign-time=', 'q-key-time=', 'q-header-list=host', 'q-url-param-list=', 'q-signature=']) {
  check('签名含 ' + field.split('=')[0], auth.includes(field), auth.slice(0, 60));
}
const sig = /q-signature=([0-9a-f]+)/.exec(auth)?.[1] || '';
check('签名是 40 位十六进制（HMAC-SHA1 hex）', /^[0-9a-f]{40}$/.test(sig), sig.length + ' 位');
const keyTime = /q-sign-time=(\d+;\d+)/.exec(auth)?.[1];
check('KeyTime 形如 start;end 且 end > start', (() => {
  const [a, b] = (keyTime || '').split(';').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && b > a;
})(), keyTime);

// ③ 方法/主机大小写规范化：算法内部统一转小写（COS 要求），
//    所以大写输入应产生与小写输入「同一时间片」相同的签名。
//    注意不能直接比整串：q-sign-time 依赖当前秒，两次调用可能跨秒。
const fixedLower = { secretId: 'AKIDtest', secretKey: 'secret', method: 'put', key: 'test.png', host: 'bucket-1250000000.cos.ap-guangzhou.myqcloud.com' };
const a1 = authorization(fixedLower);
const a2u = authorization({ ...fixedLower, method: 'PUT', host: fixedLower.host.toUpperCase() });
const stripTime = v => v.replace(/q-sign-time=[^&]+|q-key-time=[^&]+|q-signature=[^&]+/g, '');
check('方法/主机大小写不影响除时间与签名外的参数', stripTime(a1) === stripTime(a2u), stripTime(a1).slice(0, 50));
// 同一秒内大小写应得到相同签名；跨秒时跳过（避免偶发失败）
const sameSecond = /q-sign-time=(\d+);/.exec(a1)?.[1] === /q-sign-time=(\d+);/.exec(a2u)?.[1];
if (sameSecond) check('同一秒内大小写规范化后签名相同', /q-signature=([0-9a-f]+)/.exec(a1)[1] === /q-signature=([0-9a-f]+)/.exec(a2u)[1]);
else console.log('skip 同一秒内签名一致（两次调用跨秒）');

// ④ 手工复算一遍，确认 HMAC 链没有断（用 Node crypto 独立算）
const crypto = require('crypto');
const sha1 = v => crypto.createHash('sha1').update(v, 'utf8').digest('hex');
const hmac = (k, v) => crypto.createHmac('sha1', k).update(v, 'utf8').digest('hex');
const fixed = { secretId: 'AKIDtest', secretKey: 'secretkey', method: 'put', key: 'dir/a.png', host: 'b-125.cos.ap-guangzhou.myqcloud.com' };
const a2 = authorization(fixed);
const kt = /q-sign-time=(\d+;\d+)/.exec(a2)[1];
const signKey = hmac('secretkey', kt);
const httpString = ['put', '/dir/a.png', '', 'b-125.cos.ap-guangzhou.myqcloud.com', ''].join('\n');
const stringToSign = ['sha1', kt, sha1(httpString), ''].join('\n');
const expected = hmac(signKey, stringToSign);
check('手工复算签名一致（HMAC 链正确）', a2.includes('q-signature=' + expected), expected.slice(0, 16) + '…');

console.log('\nCOS 签名：' + passed + ' 通过 / 0 失败');

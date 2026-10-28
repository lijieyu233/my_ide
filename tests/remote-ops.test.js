// 注入防护自检：参数白名单 + 引号转义
const Ops = require('../src/main/remote/remote-ops.js');

const cases = [
  // [动作, 参数, 期望]
  ['docker.restart', { name: 'x`id`' }, 'block'],
  ['docker.restart', { name: 'x$(id)' }, 'block'],
  ['docker.restart', { name: "x'; id" }, 'block'],
  ['docker.restart', { name: 'x; rm -rf /' }, 'block'],
  ['docker.restart', { name: 'a b' }, 'block'],
  ['docker.restart', { name: '' }, 'block'],
  ['systemd.restart', { unit: 'x.service; reboot' }, 'block'],
  ['systemd.restart', { unit: 'notaservice' }, 'block'],
  ['proc.kill', { pid: '1' }, 'block'],
  ['proc.kill', { pid: '0' }, 'block'],
  ['proc.kill', { pid: 'abc' }, 'block'],
  ['proc.kill', { pid: '12; id' }, 'block'],
  ['disk.usage', { path: '/tmp && rm -rf /' }, 'block'],
  ['disk.usage', { path: 'relative/path' }, 'block'],
  ['disk.usage', { path: '/tmp\nrm -rf /' }, 'block'],
  ['disk.vacuumJournal', { size: '1G; reboot' }, 'block'],
  ['disk.vacuumJournal', { size: '200' }, 'block'],
  ['nope.action', {}, 'block'],
  // 合法输入必须通过
  ['docker.restart', { name: 'smart-gallery-api' }, 'ok'],
  ['docker.restart', { name: 'a_b.c-d' }, 'ok'],
  ['systemd.restart', { unit: 'mcsm-web.service' }, 'ok'],
  ['proc.kill', { pid: '65411' }, 'ok'],
  ['disk.usage', { path: '/home/ubuntu' }, 'ok'],
  ['disk.vacuumJournal', { size: '200M' }, 'ok'],
  ['docker.logs', { name: 'gitea', tail: 200 }, 'ok'],
  ['proc.detail', { pid: '923' }, 'ok'],
];

let pass = 0, fail = 0;
for (const [action, args, expect] of cases) {
  let blocked = false, command = '', code = '';
  try { command = Ops.plan(action, args).command; }
  catch (e) { blocked = true; code = e.code; }
  const got = blocked ? 'block' : 'ok';
  if (got === expect) { pass++; console.log('ok  ' + action + ' ' + JSON.stringify(args) + ' → ' + (blocked ? '拒绝(' + code + ')' : '通过')); }
  else { fail++; console.log('FAIL ' + action + ' ' + JSON.stringify(args) + ' 期望 ' + expect + ' 实际 ' + got + ' ' + code + (command ? ' → ' + command : '')); }
}

// 命令行必须不含裸控制字符（换行/CR/NUL）
const allCommands = Object.keys(Ops.ACTIONS);
for (const action of allCommands) {
  try {
    const plan = Ops.plan(action, { name: 'x', unit: 'x.service', pid: '9', path: '/tmp', size: '200M', tail: 100 });
    if (/[\0\r\n]/.test(plan.command)) { fail++; console.log('FAIL 动作 ' + action + ' 的命令含控制字符'); }
  } catch { /* 缺参数的动作跳过 */ }
}

console.log('\n注入防护：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

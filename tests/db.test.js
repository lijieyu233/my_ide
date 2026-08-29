// tests/db.test.js —— db-service（数据库工具）无头测试：SQLite 全链路
// 运行：node tests/db.test.js
const path = require('path');
const fs = require('fs');
const Module = require('module');
// mock electron（db-service 顶层解构 ipcMain，不调用 registerIpc 即可）
const orig = Module._load;
Module._load = function (req, ...a) {
  if (req === 'electron') return { ipcMain: { handle() {} } };
  return orig.call(this, req, ...a);
};

const os = require('os');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

(async () => {
  // 用 sql.js 造一个测试库
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const dbFile = path.join(os.tmpdir(), 'myide-test-' + Date.now() + '.db');
  const db = new SQL.Database();
  db.run('CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT)');
  db.run("INSERT INTO notes (title, content) VALUES ('a', '内容1'), ('b', '内容2'), ('c', '内容3'), ('d', '内容4'), ('e', '内容5')");
  fs.writeFileSync(dbFile, Buffer.from(db.export()));
  db.close();

  // fake electron 注入 → registerIpc 把 handler 捕获到 handlers
  const handlers = {};
  const fakeIpc = { handle: (k, fn) => { handlers[k] = fn; } };
  Module._load = function (req, ...a) {
    if (req === 'electron') return { ipcMain: fakeIpc };
    return orig.call(this, req, ...a);
  };
  require('../db-service').registerIpc();
  console.log('registered:', Object.keys(handlers).length);

  const invoke = (k, ...args) => handlers[k](null, ...args);

  // 1) 连接
  let r = await invoke('db:connect', { type: 'sqlite', file: dbFile });
  ok(r.ok, '连接 SQLite：' + JSON.stringify(r.error || r.data.id));
  const id = r.data.id;

  // 2) 表列表
  r = await invoke('db:tables', id);
  ok(r.ok && r.data.some((t) => t.name === 'notes'), '表列表含 notes');

  // 3) 列
  r = await invoke('db:columns', id, 'notes');
  ok(r.ok && r.data.length === 3 && r.data[0].pk, '列信息 + 主键识别');

  // 4) 分页（page size 2）
  r = await invoke('db:select', id, 'notes', 1, 2);
  ok(r.ok && r.data.rows.length === 2 && r.data.total === 5 && r.data.pk[0] === 'id', '分页第1页 2行/共5行');

  // 5) 翻页
  r = await invoke('db:select', id, 'notes', 3, 2);
  ok(r.ok && r.data.rows.length === 1, '第3页剩1行');

  // 6) 改单元格
  r = await invoke('db:updateCell', id, 'notes', ['id'], [1], 'title', '改名了');
  ok(r.ok, '更新单元格');
  r = await invoke('db:query', id, 'SELECT title FROM notes WHERE id = 1');
  ok(r.ok && r.data.rows[0].title === '改名了', '更新已生效（含写回文件）');

  // 7) 插入
  r = await invoke('db:insertRow', id, 'notes', ['title', 'content'], ['新行', 'new']);
  ok(r.ok && r.data.insertId > 0, '插入行 insertId=' + (r.data && r.data.insertId));

  // 8) 删除
  r = await invoke('db:select', id, 'notes', 1, 50);
  const totalNow = r.data.total;
  r = await invoke('db:deleteRows', id, 'notes', ['id'], [[6]]);
  ok(r.ok, '删除行');
  r = await invoke('db:select', id, 'notes', 1, 50);
  ok(r.data.total === totalNow - 1, '删除后总数 -1');

  // 9) SQL 标签页式查询（SELECT / 写语句）
  r = await invoke('db:query', id, 'SELECT COUNT(*) AS c FROM notes');
  ok(r.ok && r.data.ok === 'select' && r.data.rows[0].c === totalNow - 1, '任意 SELECT 查询');
  r = await invoke('db:query', id, "UPDATE notes SET content = '批量' WHERE id IN (2,3)");
  ok(r.ok && r.data.ok === 'write' && r.data.affected === 2, '写语句 affected=2 且回写文件');

  // 10) 无主键表（rowid 路径）
  await invoke('db:query', id, 'CREATE TABLE nopk (a TEXT)');
  await invoke('db:query', id, "INSERT INTO nopk (a) VALUES ('x'), ('y')");
  r = await invoke('db:select', id, 'nopk', 1, 10);
  ok(r.ok && r.data.pk[0] === '__rid' && r.data.rows.length === 2, '无主键表用 rowid 定位');
  r = await invoke('db:updateCell', id, 'nopk', ['__rid'], [r.data.rows[0].__rid], 'a', 'z');
  ok(r.ok, '无主键表单元格更新（rowid WHERE）');

  // 11) 标识符转义（表名带空格/引号）
  await invoke('db:query', id, 'CREATE TABLE "my table" (v TEXT)');
  r = await invoke('db:select', id, 'my table', 1, 10);
  ok(r.ok, '表名带空格可查询');

  // 12) 断开
  r = await invoke('db:close', id);
  ok(r.ok, '断开连接');

  try { fs.unlinkSync(dbFile); } catch {}
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });

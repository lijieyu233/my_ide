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

  // 12) 表结构（DDL）
  r = await invoke('db:ddl', id, 'notes');
  ok(r.ok && /CREATE TABLE/i.test(r.data.ddl) && r.data.ddl.includes('notes'), 'DDL：CREATE 语句');
  r = await invoke('db:ddl', id, '不存在的表');
  ok(r.ok && r.data.ddl === '', 'DDL：不存在的表返回空');

  // 13) CSV 导出（含逗号/引号/换行转义 + BOM）
  const csvFile = dbFile + '.csv';
  await invoke('db:query', id, "INSERT INTO notes (title, content) VALUES ('逗号,引号\"换行', 'v')");
  r = await invoke('db:exportCsv', id, 'notes', csvFile);
  const raw = fs.readFileSync(csvFile, 'utf8');
  ok(r.ok && r.data.rows >= 6, 'CSV 导出行数');
  ok(raw.charCodeAt(0) === 0xfeff, 'CSV 带 BOM（Excel 直开不乱码）');
  ok(raw.includes('"逗号,引号""换行"'), 'CSV 引号/逗号正确转义（RFC 4180）');
  ok(raw.includes('title,content'), 'CSV 首行是表头');

  // 14) CSV 导入（追加 + 事务回滚）
  const csvIn = dbFile + '-in.csv';
  fs.writeFileSync(csvIn, 'title,content\r\n导入A,a1\r\n导入B,"b,2"\r\n', 'utf8');
  const before = (await invoke('db:select', id, 'notes', 1, 50)).data.total;
  r = await invoke('db:importCsv', id, 'notes', csvIn);
  ok(r.ok && r.data.inserted === 2, 'CSV 导入 2 行');
  let after = (await invoke('db:select', id, 'notes', 1, 50)).data.total;
  ok(after === before + 2, '导入后总数 +2');
  r = await invoke('db:query', id, "SELECT content FROM notes WHERE title = '导入B'");
  ok(r.ok && r.data.rows[0].content === 'b,2', '导入的引号包裹字段解析正确');
  // 列不匹配 → 整体回滚（行数不变）
  const csvBad = dbFile + '-bad.csv';
  fs.writeFileSync(csvBad, 'title,不存在的列\nx,y\n', 'utf8');
  r = await invoke('db:importCsv', id, 'notes', csvBad);
  ok(!r.ok, '导入列不匹配报错');
  after = (await invoke('db:select', id, 'notes', 1, 50)).data.total;
  ok(after === before + 2, '失败导入不残留数据（事务回滚）');

  // 14b) EXPLAIN 执行计划（仅 SELECT；非 SELECT 报错）
  r = await invoke('db:explain', id, 'SELECT * FROM notes WHERE id = 1');
  ok(r.ok && r.data.ok === 'select' && r.data.rows.length > 0, 'EXPLAIN：SELECT 返回计划行');
  ok(r.data.columns.length > 0, 'EXPLAIN：返回列定义');
  r = await invoke('db:explain', id, 'DELETE FROM notes');
  ok(!r.ok, 'EXPLAIN：非 SELECT 语句报错');

  // 14c) JSON / SQL 格式导出
  const jsonFile = dbFile + '.json';
  r = await invoke('db:exportCsv', id, 'notes', jsonFile, 'json');
  ok(r.ok, 'JSON 导出成功');
  const jdata = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  ok(Array.isArray(jdata) && jdata.length === r.data.rows && jdata.length > 0, 'JSON 导出为合法数组且行数一致');
  ok(typeof jdata[0].title === 'string', 'JSON 行含列字段');
  const sqlFile = dbFile + '-ins.sql';
  await invoke('db:query', id, "INSERT INTO notes (title, content) VALUES ('带''单引号', 'x')");
  r = await invoke('db:exportCsv', id, 'notes', sqlFile, 'sql');
  const stext = fs.readFileSync(sqlFile, 'utf8');
  ok(r.ok && /INSERT INTO "notes"/.test(stext), 'SQL 导出含 INSERT 语句');
  ok(stext.includes("'导入A'"), 'SQL 字符串值正确加引号');
  ok(stext.includes("'带''单引号'"), 'SQL 单引号转义（翻倍）');
  // 空表导出 JSON = []
  await invoke('db:query', id, 'CREATE TABLE empty_t (a TEXT)');
  const emptyJson = dbFile + '-empty.json';
  r = await invoke('db:exportCsv', id, 'empty_t', emptyJson, 'json');
  ok(JSON.parse(fs.readFileSync(emptyJson, 'utf8')).length === 0, '空表 JSON 导出为 []');

  // 15) 断开
  r = await invoke('db:close', id);
  ok(r.ok, '断开连接');

  try { fs.unlinkSync(dbFile); } catch {}
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });

// db-service.js —— 数据库工具服务（主进程）：MySQL(mysql2) + SQLite(sql.js)
// 设计要点：
//   - 连接会话保存在 Map（id -> 句柄），渲染层只持 id，密码不落渲染层
//   - SQLite 用 sql.js（WASM 纯 JS，免原生编译/打包问题）：写操作后 export 回写文件
//   - 标识符一律引号包裹（MySQL `x` / SQLite "x"），值一律参数化 —— 防 SQL 注入
//   - 无显式主键的 SQLite 表用 rowid 定位行（SELECT 时带出 __rid）

const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');

let mysql = null; // 懒加载（无 mysql 依赖的环境不至于启动崩溃）
try { mysql = require('mysql2/promise'); } catch { mysql = null; }

let initSqlJs = null;
try { initSqlJs = require('sql.js'); } catch { initSqlJs = null; }

const conns = new Map(); // id -> { type, config, mysql: conn, sqlite: SQL.Database, file }
let nextId = 1;
let SQL = null; // sql.js WASM 实例（全局单例，加载一次）

async function getSQL() {
  if (!SQL) {
    if (!initSqlJs) throw new Error('sql.js 未安装（npm install sql.js）');
    SQL = await initSqlJs();
  }
  return SQL;
}

// ---------- 标识符转义 ----------
function qid(type, name) {
  const n = String(name).replace(/"/g, '""');
  return type === 'mysql' ? '`' + String(name).replace(/`/g, '``') + '`' : '"' + n + '"';
}

function typeOf(id) {
  const c = conns.get(id);
  if (!c) throw new Error('连接不存在或已断开');
  return c;
}

// ---------- 连接 / 断开 ----------
async function connect(cfg) {
  const id = 'db' + (nextId++);
  if (cfg.type === 'mysql') {
    if (!mysql) throw new Error('mysql2 未安装（npm install mysql2）');
    const conn = await mysql.createConnection({
      host: cfg.host || '127.0.0.1',
      port: Number(cfg.port) || 3306,
      user: cfg.user || 'root',
      password: cfg.password || '',
      database: cfg.database || undefined,
      multipleStatements: false,
      connectTimeout: 8000,
      dateStrings: true, // 日期以字符串返回（表格直显，避免 ISO 时区偏移）
    });
    conns.set(id, { type: 'mysql', config: cfg, mysql: conn });
    return { id, serverInfo: conn.serverVersion || '' };
  }
  if (cfg.type === 'sqlite') {
    const file = cfg.file || '';
    if (!file || !fs.existsSync(file)) throw new Error('SQLite 文件不存在：' + file);
    const SQLC = await getSQL();
    const db = new SQLC.Database(fs.readFileSync(file));
    conns.set(id, { type: 'sqlite', config: cfg, sqlite: db, file });
    return { id, serverInfo: 'SQLite' };
  }
  throw new Error('不支持的数据库类型：' + cfg.type);
}

async function close(id) {
  const c = conns.get(id);
  if (!c) return;
  try { if (c.mysql) await c.mysql.end(); } catch {}
  try { if (c.sqlite) c.sqlite.close(); } catch {}
  conns.delete(id);
}

// ---------- 表 / 列 ----------
async function tables(id) {
  const c = typeOf(id);
  if (c.type === 'mysql') {
    const [rows] = await c.mysql.query(
      'SELECT TABLE_NAME AS name, TABLE_ROWS AS approx FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY name',
      [c.config.database]
    );
    return rows.map((r) => ({ name: r.name, approx: Number(r.approx) || null }));
  }
  const res = c.sqlite.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return (res[0] ? res[0].values : []).map((v) => ({ name: v[0] }));
}

async function columns(id, table) {
  const c = typeOf(id);
  if (c.type === 'mysql') {
    const [rows] = await c.mysql.query(
      'SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLUMN_KEY AS ck, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [c.config.database, table]
    );
    return rows.map((r) => ({ name: r.name, type: r.type, pk: r.ck === 'PRI', extra: r.extra || '' }));
  }
  const res = c.sqlite.exec('PRAGMA table_info(' + qid('sqlite', table) + ')');
  const out = [];
  if (res[0]) {
    const { columns: cols, values } = res[0];
    const iName = cols.indexOf('name'), iType = cols.indexOf('type'), iPk = cols.indexOf('pk');
    for (const v of values) out.push({ name: v[iName], type: v[iType] || '', pk: Number(v[iPk]) > 0 });
  }
  return out;
}

// ---------- 查询（SELECT / 任意 SQL） ----------
// rows 里 BLOB 转 <buffer: N字节> 占位（表格不可编辑 BLOB，v1 范围外）
function normalizeVal(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return '<BLOB:' + v.length + '>';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
function packResult(cols, values) {
  const rows = values.map((r) => {
    const o = {};
    cols.forEach((c, i) => { o[c] = normalizeVal(r[i]); });
    return o;
  });
  return { columns: cols, rows };
}

async function query(id, sql, params) {
  const c = typeOf(id);
  if (c.type === 'mysql') {
    const [result] = await c.mysql.query(sql, params || []);
    if (Array.isArray(result)) {
      const cols = result.length ? Object.keys(result[0]) : [];
      return { ...packResult(cols, result.map((r) => Object.values(r))), ok: 'select' };
    }
    return { ok: 'write', affected: result.affectedRows, insertId: result.insertId };
  }
  // SQLite：先执行；写库（无返回集）则 export 回写文件。
  // 注意：getRowsModified 必须在 export() 之前取（export 内部会清零计数器）
  let res;
  try {
    res = c.sqlite.exec(sql, params || []);
  } catch (e) {
    throw new Error(String(e.message || e));
  }
  const stmts = String(sql).trim().toUpperCase();
  const noResult = !res.length;
  if (noResult && /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)/.test(stmts)) {
    const affected = c.sqlite.getRowsModified();
    let insertId;
    if (/^INSERT/.test(stmts)) {
      try {
        const rid = c.sqlite.exec('SELECT last_insert_rowid() AS __i');
        insertId = rid[0] ? rid[0].values[0][0] : undefined;
      } catch {}
    }
    fs.writeFileSync(c.file, Buffer.from(c.sqlite.export()));
    return { ok: 'write', affected, insertId };
  }
  if (!res.length) return { columns: [], rows: [], ok: 'select' };
  return { ...packResult(res[0].columns, res[0].values), ok: 'select' };
}

// ---------- 分页读表 ----------
// 无显式主键的 SQLite 表额外带出 rowid（__rid），供编辑/删除定位行
async function selectTable(id, table, page, size) {
  const c = typeOf(id);
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(500, Math.max(1, Number(size) || 50));
  let cols = await columns(id, table);
  const pkCols = cols.filter((x) => x.pk).map((x) => x.name);
  const useRowid = c.type === 'sqlite' && !pkCols.length;

  let sql, params;
  if (c.type === 'mysql') {
    sql = 'SELECT * FROM ' + qid('mysql', table) + ' LIMIT ? OFFSET ?';
    params = [s, (p - 1) * s];
  } else {
    sql = 'SELECT ' + (useRowid ? 'rowid AS __rid, ' : '') + '* FROM ' + qid('sqlite', table) + ' LIMIT ? OFFSET ?';
    params = [s, (p - 1) * s];
  }
  const r = await query(id, sql, params);

  let total = 0;
  const cnt = await query(id, 'SELECT COUNT(*) AS c FROM ' + qid(c.type, table));
  if (cnt.rows && cnt.rows.length) total = Number(cnt.rows[0].c);
  return { ...r, total, page: p, size: s, pk: useRowid ? ['__rid'] : pkCols };
}

// ---------- 行级写操作（表格内增删改） ----------
async function updateCell(id, table, pk, pkVals, col, val) {
  const c = typeOf(id);
  const where = pk.map((k, i) => qid(c.type, k) + ' = ?').join(' AND ');
  const sql = 'UPDATE ' + qid(c.type, table) + ' SET ' + qid(c.type, col) + ' = ? WHERE ' + where;
  return query(id, sql, [val, ...pkVals]);
}

async function deleteRows(id, table, pk, pkRows) {
  const c = typeOf(id);
  for (const vals of pkRows) {
    const where = pk.map((k, i) => qid(c.type, k) + ' = ?').join(' AND ');
    await query(id, 'DELETE FROM ' + qid(c.type, table) + ' WHERE ' + where, vals);
  }
  return { ok: true, affected: pkRows.length };
}

async function insertRow(id, table, cols, vals) {
  const c = typeOf(id);
  const ph = cols.map(() => '?').join(', ');
  const sql = 'INSERT INTO ' + qid(c.type, table) + ' (' + cols.map((x) => qid(c.type, x)).join(', ') + ') VALUES (' + ph + ')';
  return query(id, sql, vals);
}

// ---------- IPC 注册 ----------
function registerIpc() {
  const wrap = (fn) => (_e, ...args) => Promise.resolve()
    .then(() => fn(...args))
    .then((v) => ({ ok: true, data: v }))
    .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));

  ipcMain.handle('db:connect', wrap(connect)); // cfg 经主进程，密码不落渲染层
  ipcMain.handle('db:close', wrap(close));
  ipcMain.handle('db:tables', wrap(tables));
  ipcMain.handle('db:columns', wrap(columns));
  ipcMain.handle('db:select', wrap(selectTable));
  ipcMain.handle('db:query', wrap(query));
  ipcMain.handle('db:updateCell', wrap(updateCell));
  ipcMain.handle('db:deleteRows', wrap(deleteRows));
  ipcMain.handle('db:insertRow', wrap(insertRow));
}

module.exports = { registerIpc };

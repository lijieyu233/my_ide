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

// ---------- ER 图数据（全库 schema：表 + 列 + 外键关系） ----------
// SQLite: PRAGMA foreign_key_list；MySQL: information_schema.KEY_COLUMN_USAGE（REFERENCED 不为空即 FK）
async function erSchema(id) {
  const c = typeOf(id);
  const tbs = await tables(id);
  const colsOf = {};
  for (const t of tbs) colsOf[t.name] = await columns(id, t.name);
  const rels = [];
  if (c.type === 'mysql') {
    const [rows] = await c.mysql.query(
      'SELECT TABLE_NAME AS t, COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rcol FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL',
      [c.config.database]
    );
    for (const r of rows) rels.push({ from: r.t, fromCol: r.col, to: r.rt, toCol: r.rcol });
  } else {
    for (const t of tbs) {
      const res = c.sqlite.exec('PRAGMA foreign_key_list(' + qid('sqlite', t.name) + ')');
      if (!res[0]) continue;
      const { columns: h, values } = res[0];
      const iTable = h.indexOf('table'), iFrom = h.indexOf('from'), iTo = h.indexOf('to');
      for (const v of values) rels.push({ from: t.name, fromCol: v[iFrom], to: v[iTable], toCol: v[iTo] });
    }
  }
  // 只保留两端都在表清单里的关系（视图/已删表残引用过滤）
  const names = new Set(tbs.map((t) => t.name));
  return {
    tables: tbs.map((t) => ({ name: t.name, columns: colsOf[t.name] || [] })),
    relations: rels.filter((r) => names.has(r.from) && names.has(r.to)),
  };
}

// ---------- EXPLAIN 执行计划（SELECT 语句前面加 EXPLAIN；SQLite 用 QUERY PLAN 形式） ----------
async function explain(id, sql) {
  const c = typeOf(id);
  const s = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!s) throw new Error('SQL 为空');
  if (!/^SELECT\b/i.test(s)) throw new Error('EXPLAIN 仅支持 SELECT 语句');
  const plan = c.type === 'mysql' ? 'EXPLAIN ' + s : 'EXPLAIN QUERY PLAN ' + s;
  const r = await query(id, plan, []);
  return r; // { columns, rows, ok: 'select' }
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

// ---------- 表结构（DDL / 索引） ----------
async function tableDdl(id, table) {
  const c = typeOf(id);
  if (c.type === 'mysql') {
    const [rows] = await c.mysql.query('SHOW CREATE TABLE ' + qid('mysql', table));
    return { ddl: (rows[0] && rows[0]['Create Table']) || '' };
  }
  const res = c.sqlite.exec('SELECT sql FROM sqlite_master WHERE type IN (\'table\',\'view\') AND name = ' + qid('sqlite', table));
  return { ddl: res[0] ? String(res[0].values[0][0] || '') : '' };
}

// ---------- CSV 导入 / 导出 ----------
// CSV 行编码：含逗号/引号/换行时整体加引号，内部引号翻倍（RFC 4180）
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// SQL INSERT 值字面量：字符串加引号（内部单引号翻倍）、NULL 原样、数字/其他原样
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// 通用导出：format = 'csv' | 'json' | 'sql'（分页流式读全表，上限 20 万行）
async function exportCsv(id, table, filePath, format) {
  const c = typeOf(id);
  const fmt = String(format || 'csv').toLowerCase();
  if (!['csv', 'json', 'sql'].includes(fmt)) throw new Error('不支持的导出格式：' + fmt);
  if (!filePath) throw new Error('未指定导出路径');
  const PAGE = 500;
  const out = [];
  let page = 1;
  let cols = null;
  let total = 0;
  const colQ = () => cols.map((x) => qid(c.type, x)).join(', ');
  for (;;) {
    const r = await query(id, 'SELECT * FROM ' + qid(c.type, table) + ' LIMIT ? OFFSET ?', [PAGE, (page - 1) * PAGE]);
    if (!cols) {
      cols = r.columns || [];
      if (fmt === 'csv') out.push('\ufeff' + cols.map(csvCell).join(',')); // BOM：Excel 直开不乱码
      if (fmt === 'json') out.push('[\n');
      if (fmt === 'sql') out.push('-- 表 ' + table + ' 的数据（' + colQ() + '）\n');
    }
    for (const row of r.rows) {
      if (fmt === 'csv') out.push(cols.map((k) => csvCell(row[k])).join(','));
      else if (fmt === 'json') out.push(JSON.stringify(row) + ',\n');
      else out.push('INSERT INTO ' + qid(c.type, table) + ' (' + colQ() + ') VALUES (' + cols.map((k) => sqlLiteral(row[k])).join(', ') + ');\n');
    }
    total += r.rows.length;
    if (r.rows.length < PAGE) break;
    page++;
    if (total >= 200000) break; // 安全上限
  }
  let text;
  if (fmt === 'csv') text = out.join('\r\n');
  else if (fmt === 'json') {
    if (!total) text = '[]';
    else text = out.join('').replace(/,\n$/, '\n') + ']';
  } else text = out.join('');
  fs.writeFileSync(filePath, text, 'utf8');
  return { rows: total, file: filePath };
}

// CSV 解析（状态机：双引号包裹 + 引号翻倍转义），返回 string[][]
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

async function importCsv(id, table, filePath) {
  const c = typeOf(id);
  if (!filePath || !fs.existsSync(filePath)) throw new Error('CSV 文件不存在：' + filePath);
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); // 去 BOM
  if (!rows.length) throw new Error('CSV 内容为空');
  const cols = rows[0].map((x) => x.trim());
  if (!cols.length || cols.some((x) => !x)) throw new Error('首行（表头）必须是目标表的列名');
  // 校验列存在于目标表
  const valid = new Set((await columns(id, table)).map((x) => x.name));
  for (const cn of cols) {
    if (!valid.has(cn)) throw new Error('表中不存在列：' + cn + '（首行必须是表头）');
  }
  // SQLite 用事务包裹（失败整体回滚）；MySQL 循环逐行（参数化）
  if (c.type === 'sqlite') {
    try { c.sqlite.exec('BEGIN'); } catch {}
    try {
      const ph = cols.map(() => '?').join(', ');
      const sql = 'INSERT INTO ' + qid('sqlite', table) + ' (' + cols.map((x) => qid('sqlite', x)).join(', ') + ') VALUES (' + ph + ')';
      for (let i = 1; i < rows.length; i++) {
        const vals = cols.map((_, j) => (rows[i][j] === '' ? null : rows[i][j]));
        c.sqlite.exec(sql, vals);
      }
      c.sqlite.exec('COMMIT');
      fs.writeFileSync(c.file, Buffer.from(c.sqlite.export()));
      return { inserted: rows.length - 1 };
    } catch (e) {
      try { c.sqlite.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }
  // MySQL：多值批量 INSERT（100 行/批，参数化），千行级导入快一个数量级
  const BATCH = 100;
  const oneRow = '(' + cols.map(() => '?').join(', ') + ')';
  const head = 'INSERT INTO ' + qid('mysql', table) + ' (' + cols.map((x) => qid('mysql', x)).join(', ') + ') VALUES ';
  const dataRows = rows.slice(1).map((r) => cols.map((_, j) => (r[j] === '' ? null : r[j])));
  for (let i = 0; i < dataRows.length; i += BATCH) {
    const chunk = dataRows.slice(i, i + BATCH);
    await c.mysql.query(head + Array(chunk.length).fill(oneRow).join(', '), [].concat(...chunk));
  }
  return { inserted: dataRows.length };
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
  ipcMain.handle('db:ddl', wrap(tableDdl));
  ipcMain.handle('db:er', wrap(erSchema));
  ipcMain.handle('db:explain', wrap(explain));
  ipcMain.handle('db:exportCsv', wrap(exportCsv));
  ipcMain.handle('db:importCsv', wrap(importCsv));
}

module.exports = { registerIpc };

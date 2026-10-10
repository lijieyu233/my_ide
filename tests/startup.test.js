const fs = require('fs'), vm = require('vm'), assert = require('assert/strict');
const { JSDOM } = require('jsdom');
let passed = 0;
const check = (name, value) => { assert(value, name); passed++; console.log('ok ' + name); };
(async () => {
  const dom = new JSDOM('<!doctype html><head></head><body></body>', { runScripts: 'outside-only' });
  try {
    dom.window.eval(fs.readFileSync('renderer/vendor-loader.js', 'utf8'));
    const { VendorLoader } = dom.window;
    check('启动不加载未使用的预览库', dom.window.document.scripts.length === 0);
    const first = VendorLoader.load('xlsx'), second = VendorLoader.load('xlsx');
    check('并发打开同类文件只加载一次', first === second && dom.window.document.scripts.length === 1);
    dom.window.XLSX = { read() {} }; dom.window.document.scripts[0].onload(); await first;
    check('加载后复用已初始化的预览库', await VendorLoader.load('xlsx') === dom.window.XLSX && dom.window.document.scripts.length === 1);
    const failed = VendorLoader.load('docx'); const rejected = assert.rejects(failed, /加载失败/); dom.window.document.scripts[1].onerror(); await rejected;
    const retry = VendorLoader.load('docx'); dom.window.docxPreview = {}; dom.window.document.scripts[1].onload(); await retry;
    check('库加载失败可重试并清理旧脚本', dom.window.document.scripts.length === 2);
    const invalid = VendorLoader.load('pptx'); const missing = assert.rejects(invalid, /初始化失败/); dom.window.document.scripts[2].onload(); await missing;
    await assert.rejects(VendorLoader.load('../other.js'), /未知/); await assert.rejects(VendorLoader.load('__proto__'), /未知/); check('初始化失败及白名单外脚本明确拒绝', true);
    const channels = new Map(), imports = [];
    const fakeRequire = name => {
      if (name === 'electron') return { ipcMain: { handle: (ch, fn) => channels.set(ch, fn) } };
      if (name === 'fs' || name === 'path') return require(name);
      imports.push(name);
      if (name === 'mysql2/promise') return { createConnection: async () => ({ end: async () => {} }) };
      if (name === 'pg') return { Client: class { async connect() {} async query() { return { rows: [{ version: 'PostgreSQL 16' }] }; } async end() {} } };
      if (name === 'sql.js') return async () => ({ Database: class { close() {} } });
      throw Error('unexpected import');
    };
    const context = { require: fakeRequire, module: { exports: {} }, console, Buffer };
    vm.runInNewContext(fs.readFileSync('db-service.js', 'utf8'), context); context.module.exports.registerIpc();
    check('主进程注册数据库功能时不加载驱动', imports.length === 0 && channels.has('db:connect'));
    const connect = cfg => channels.get('db:connect')({}, cfg);
    const mysql = await connect({ type: 'mysql' }); const mysql2 = await connect({ type: 'mysql' });
    check('MySQL首次连接才加载且复用驱动', mysql.ok && mysql2.ok && imports.join() === 'mysql2/promise');
    const postgres = await connect({ type: 'postgres' });
    check('PostgreSQL首次连接才加载对应驱动', postgres.ok && imports.join() === 'mysql2/promise,pg');
    const sqlite = await connect({ type: 'sqlite', file: __filename });
    check('SQLite首次连接才加载对应驱动', sqlite.ok && imports.join() === 'mysql2/promise,pg,sql.js');
    for (const result of [mysql, mysql2, postgres, sqlite]) await channels.get('db:close')({}, result.data.id);
    console.log('启动按需加载：' + passed + ' 通过 / 0 失败');
  } finally { dom.window.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

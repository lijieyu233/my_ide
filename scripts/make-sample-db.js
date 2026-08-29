// 生成 SQLite 测试库：sample.db（含用户/订单/产品三类典型表，覆盖主键/外键/NULL/中文等场景）
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    age INTEGER,
    city TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL,
    stock INTEGER DEFAULT 0,
    category TEXT
  )`);

  db.run(`CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    product_id INTEGER REFERENCES products(id),
    quantity INTEGER NOT NULL DEFAULT 1,
    total_price REAL,
    status TEXT DEFAULT 'pending',
    note TEXT,
    order_date TEXT DEFAULT (datetime('now'))
  )`);

  const users = [
    ['张三', 'zhangsan@example.com', 28, '北京'],
    ['李四', 'lisi@example.com', 35, '上海'],
    ['王五', 'wangwu@example.com', null, '广州'],        // age NULL → 测试 NULL 显示
    ['赵六', 'zhaoliu@example.com', 42, '深圳'],
    ['Alice', 'alice@example.com', 31, 'New York'],
    ['Bob', null, 25, 'London'],                          // email NULL → 测试 UNIQUE+NULL
  ];
  const insU = db.prepare('INSERT INTO users (name, email, age, city) VALUES (?, ?, ?, ?)');
  for (const u of users) { insU.run(u); }
  insU.free();

  const products = [
    ['机械键盘', 399.00, 120, '电脑外设'],
    ['无线鼠标', 129.50, 300, '电脑外设'],
    ['显示器 27寸', 1599.00, 45, '显示器'],
    ['USB-C 数据线', 19.90, 1000, '配件'],
    ['降噪耳机', 899.00, 0, '音频'],                     // stock 0 → 测试 0 值显示
    ['显示器支架', 259.00, null, '配件'],                 // stock NULL → 测试默认值+NULL
  ];
  const insP = db.prepare('INSERT INTO products (name, price, stock, category) VALUES (?, ?, ?, ?)');
  for (const p of products) { insP.run(p); }
  insP.free();

  const orders = [
    [1, 1, 1, 399.00, 'completed', '发货及时'],
    [1, 4, 5, 99.50, 'completed', null],
    [2, 2, 1, 129.50, 'pending', '催发货'],
    [2, 3, 1, 1599.00, 'shipped', '顺丰'],
    [3, 5, 2, 1798.00, 'cancelled', '用户取消'],
    [4, 1, 2, 798.00, 'pending', null],
    [5, 6, 1, 259.00, 'completed', ''],
    [6, 4, 10, 199.00, 'pending', '团购'],
  ];
  const insO = db.prepare('INSERT INTO orders (user_id, product_id, quantity, total_price, status, note) VALUES (?, ?, ?, ?, ?, ?)');
  for (const o of orders) { insO.run(o); }
  insO.free();

  const out = path.join('d:', 'document', 'code', 'my_project', 'my_ide', 'sample.db');
  fs.writeFileSync(out, Buffer.from(db.export()));
  console.log('已生成: ' + out);

  // 校验
  const db2 = new SQL.Database(fs.readFileSync(out));
  for (const t of ['users', 'products', 'orders']) {
    const r = db2.exec('SELECT COUNT(*) FROM ' + t);
    console.log('  ' + t + ': ' + r[0].values[0][0] + ' 行');
  }
  db.close(); db2.close();
})();

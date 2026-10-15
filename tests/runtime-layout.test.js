// 目录重组容易漏掉动态Worker和独立preload；核对真实文件与模块解析，不执行业务服务。
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = [];
function collect(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = directory + '/' + entry.name;
    if (entry.isDirectory()) collect(file);
    else if (/\.(js|cjs)$/.test(entry.name)) files.push(file);
  }
}
collect('src/main');
assert.deepEqual(fs.readdirSync(root).filter(file => /\.(js|cjs)$/.test(file)).sort(), ['main.js', 'preload.js']);
assert.equal(pkg.main, 'main.js');
assert(pkg.build.files.includes('src/main/**'));
for (const file of pkg.build.files.filter(file => !file.includes('*'))) assert(fs.existsSync(path.join(root, file)), '打包清单失效：' + file);
let imports = 0;
for (const file of ['main.js', 'preload.js', ...files]) {
  const absolute = path.join(root, file), localRequire = createRequire(absolute);
  for (const match of fs.readFileSync(absolute, 'utf8').matchAll(/\brequire\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
    assert(localRequire.resolve(match[1]).startsWith(root + path.sep), file + ' 本地依赖越界'); imports++;
  }
}
for (const file of ['src/main/git/git-worker.js', 'src/main/files/path-worker.js', 'src/main/ai/ai-approval-preload.js', 'src/main/dsh/dsh-native-plugin.cjs']) assert(files.includes(file));
const approval = fs.readFileSync(path.join(root, 'src/main/ai/ai-approval-ui.js'), 'utf8');
assert.equal(path.resolve(root, 'src/main/ai', '../../../renderer/ai-approval.html'), path.join(root, 'renderer/ai-approval.html'));
assert(approval.includes("path.join(__dirname, '../../../renderer', 'ai-approval.html')"));
console.log('后台目录：' + files.length + ' 个模块 / ' + imports + ' 处本地依赖、入口与打包路径通过');

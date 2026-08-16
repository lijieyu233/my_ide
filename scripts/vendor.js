// scripts/vendor.js —— 把浏览器用不到的库打包/拷贝到 renderer/vendor/
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(vendor, { recursive: true });

async function main() {
  // 1. highlight.js → IIFE（window.hljs）；write:false 由本进程写文件
  const res = await esbuild.build({
    entryPoints: [path.join(root, 'node_modules', 'highlight.js', 'lib', 'index.js')],
    bundle: true,
    format: 'iife',
    globalName: 'hljs',
    minify: true,
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  fs.writeFileSync(path.join(vendor, 'highlight.min.js'), res.outputFiles[0].text);

  // 2. marked UMD
  fs.copyFileSync(
    path.join(root, 'node_modules', 'marked', 'lib', 'marked.umd.js'),
    path.join(vendor, 'marked.min.js')
  );

  // 3. highlight.js 深色主题
  fs.copyFileSync(
    path.join(root, 'node_modules', 'highlight.js', 'styles', 'atom-one-dark.css'),
    path.join(vendor, 'atom-one-dark.min.css')
  );

  for (const f of fs.readdirSync(vendor)) {
    console.log('vendor:', f, fs.statSync(path.join(vendor, f)).size, 'bytes');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
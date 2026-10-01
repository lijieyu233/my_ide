// 检查实际归档而不是files配置；历史上开发测试全绿，但缺git-native的包无法启动。
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const runtimeFiles = ['main.js', 'file-write.js', 'file-replace-win.js', 'preload.js', 'git-worker.js', 'git-service.js', 'git-native.js',
  'git-ops.js', 'db-service.js', 'ai-service.js', 'launch-ops.js', 'launch-service.js'];
const resources = ['package.json', 'build/icon.png', 'renderer/index.html',
  'renderer/vendor/cm6-bundle.min.js', 'renderer/vendor/docx-preview.min.js',
  'renderer/vendor/xlsx.min.js', 'renderer/vendor/pptx-preview.min.js',
  'node_modules/sql.js/dist/sql-wasm.wasm'];
// 这些入口只在源码自检模式调用，不能为了让静态扫描通过而把开发脚本打入发行包。
const developmentImports = new Set(['scripts/check-ui-steps.js', 'scripts/ui-fixtures.js']);

function checkPackage(archive, arch = process.arch) {
  if (!fs.existsSync(archive)) throw Error('打包校验失败：找不到 ' + archive);
  const entries = asar.listPackage(archive).map((name) => name.replace(/\\/g, '/').replace(/^\//, ''));
  const present = new Set(entries);
  const checked = new Set(), errors = [];
  const hasFile = (name) => {
    if (!present.has(name)) return false;
    try {
      const stat = asar.statFile(archive, name.split('/').join(path.sep));
      return !stat.files && (!stat.unpacked || fs.existsSync(path.join(archive + '.unpacked', ...name.split('/'))));
    } catch { return false; }
  };
  const requireFile = (name) => {
    if (checked.has(name)) return hasFile(name);
    checked.add(name);
    if (!hasFile(name)) { errors.push('缺少运行时文件：' + name); return false; }
    return true;
  };
  const read = (name) => asar.extractFile(archive, name.split('/').join(path.sep)).toString('utf8');
  for (const file of [...runtimeFiles, ...resources]) requireFile(file);
  // Windows替换接口依赖真实的N-API载荷；仅有koffi的JS入口仍会在第一次保存时失败。
  if (hasFile('package.json') && JSON.parse(read('package.json')).dependencies?.koffi) {
    const base = 'node_modules/@koromix/koffi-win32-' + arch;
    requireFile(base + '/package.json'); requireFile(base + '/index.js'); requireFile(base + '/win32_' + arch + '/koffi.node');
  }

  const queue = runtimeFiles.slice(), visited = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file) || !requireFile(file)) continue;
    visited.add(file);
    for (const match of read(file).matchAll(/\brequire\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (base.startsWith('../')) { errors.push('本地依赖越过包根：' + file); continue; }
      const candidates = path.posix.extname(base) ? [base] : [base + '.js', base + '.json', base + '/index.js'];
      if (candidates.some((name) => developmentImports.has(name))) continue;
      const resolved = candidates.find(hasFile) || candidates[0];
      if (requireFile(resolved) && resolved.endsWith('.js')) queue.push(resolved);
    }
  }

  // HTML/CSS静态资源会随页面变化；显式资源另覆盖动态Worker/WASM/vendor加载。
  const staticQueue = ['renderer/index.html'], staticSeen = new Set();
  while (staticQueue.length) {
    const file = staticQueue.shift();
    if (staticSeen.has(file) || !requireFile(file)) continue;
    staticSeen.add(file);
    const source = read(file);
    const refs = file.endsWith('.html') ? [...source.matchAll(/\b(?:src|href)\s*=\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
      : [...source.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(ref)) continue;
      const name = path.posix.normalize(path.posix.join(path.posix.dirname(file), ref.split(/[?#]/)[0]));
      if (name.startsWith('../')) { errors.push('静态资源越过包根：' + file); continue; }
      if (requireFile(name) && name.endsWith('.css')) staticQueue.push(name);
    }
  }

  if (hasFile('package.json')) {
    const pkg = JSON.parse(read('package.json'));
    for (const name of Object.keys(pkg.dependencies || {})) {
      const manifest = 'node_modules/' + name + '/package.json';
      if (!requireFile(manifest)) continue;
      const dependency = JSON.parse(read(manifest));
      const exportTarget = (value) => {
        if (typeof value === 'string') return value;
        if (!value || typeof value !== 'object') return null;
        for (const key of ['require', 'node', 'default', 'import']) {
          const target = exportTarget(value[key]);
          if (target) return target;
        }
        return null;
      };
      const exported = exportTarget(dependency.exports && (dependency.exports['.'] || dependency.exports));
      const base = path.posix.normalize('node_modules/' + name + '/' + (dependency.main || exported || 'index.js'));
      const entry = [base, base + '.js', base + '/index.js'].find(hasFile) || base;
      requireFile(entry);
    }
  }
  if (!entries.some((name) => /^plugins\/[^/]+\.js$/.test(name) && hasFile(name))) errors.push('缺少内置插件');
  for (const name of entries) {
    if (/^(?:docs|tests|scripts|demo|dist|kiosk_patches|\.ui-check-trash|\.git|\.idea|\.codex|\.workbuddy|\.trae)(?:\/|$)/.test(name)
      || /^(?:\.env(?:\..*)?|sample\.db|settings\.json|launch(?:-state)?\.json|.*\.log)$/.test(name)
      || /^node_modules\/(?:electron|electron-builder|esbuild|jsdom)(?:\/|$)/.test(name)) {
      errors.push('禁止打入发行包：' + name);
    }
  }
  if (errors.length) throw Error('打包校验失败：\n' + [...new Set(errors)].join('\n'));
  return { archive, checked: checked.size, entries: entries.length };
}

async function afterPack(context) {
  const archive = path.join(context.appOutDir, 'resources', 'app.asar');
  const arch = ['ia32', 'x64', 'armv7l', 'arm64'][context.arch] || process.arch;
  const result = checkPackage(archive, arch);
  console.log('[package-check] ' + result.checked + ' 个运行时文件/资源通过，归档条目 ' + result.entries);
}
module.exports = afterPack;
module.exports.checkPackage = checkPackage;
module.exports.runtimeFiles = runtimeFiles;
module.exports.resources = resources;
if (require.main === module) {
  try {
    if (!process.argv[2]) throw Error('用法：node scripts/check-package.js <app.asar>');
    console.log(JSON.stringify(checkPackage(path.resolve(process.argv[2]))));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

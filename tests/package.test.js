// 小型真实asar夹具只证明门槛拒绝遗漏；完整产品的加载由打包运行时走查验证。
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const asar = require('@electron/asar');
const { checkPackage } = require('../scripts/check-package');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-package-test-'));
const source = path.join(temp, 'source');
let passed = 0;
function put(name, content = '') {
  const file = path.join(source, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
async function pack(label) {
  const archive = path.join(temp, label + '.asar');
  await asar.createPackage(source, archive);
  return archive;
}
async function test(name, fn) {
  await fn(); passed++; console.log('  ok ' + name);
}

(async () => {
  try {
    // 来自实际生产入口的文件与HTML；不从package.json.build.files构造“必需文件”。
    const production = ['main.js', 'app-instance.js', 'ai-launch-tools.js', 'ai-ssh-tools.js', 'file-write.js', 'file-replace-win.js', 'text-format.js', 'path-move.js', 'path-jobs.js', 'path-worker.js', 'path-create.js', 'file-create-win.js', 'copy-journal.js', 'file-copy-win.js', 'preload.js', 'git-worker.js', 'git-service.js', 'git-status.js','git-index.js','git-hunks.js','git-queue.js','git-native.js',
      'git-ops.js', 'db-service.js', 'ai-service.js', 'launch-ops.js', 'launch-service.js', 'launch-exit.js', 'launch-readiness.js'];
    production.push('search-service.js', 'task-recovery.js', 'ai-runs.js', 'quick-launch-service.js', 'quick-launch-app.js', 'ai-tool-contract.js', 'ai-tool-execution.js', 'ai-path-lease-win.js');
    production.push('ai-tool-authority.js', 'ai-permission-store.js', 'ai-permission-bridge.js', 'ai-approval-ui.js', 'ai-approval-preload.js');
    production.push("remote-service.js", "remote-ipc.js", "remote-local.js");
    for (const file of production) put(file, fs.readFileSync(path.join(root, file)));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    put('package.json', JSON.stringify({ main: 'main.js', dependencies: pkg.dependencies }));
    put('build/icon.png');
    const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
    put('renderer/index.html', html);
    for (const file of ['renderer/ai-approval.html','renderer/ai-approval.css','renderer/ai-approval.js']) put(file,fs.readFileSync(path.join(root,file)));
    for (const match of html.matchAll(/\b(?:src|href)=['"]([^'"]+)['"]/g)) {
      if (!/^[a-z]+:/.test(match[1])) put('renderer/' + match[1]);
    }
    // 按需预览库不再出现在 HTML 的静态 script 中，发行包仍必须包含真实资源。
    for (const name of ['mermaid', 'docx-preview', 'xlsx', 'pptx-preview']) put('renderer/vendor/' + name + '.min.js', fs.readFileSync(path.join(root, 'renderer/vendor/' + name + '.min.js')));
    put('plugins/example.js', 'api.registerRenderer(["test"], () => "");');
    for (const name of Object.keys(pkg.dependencies)) {
      put('node_modules/' + name + '/package.json', '{"main":"index.js"}');
      put('node_modules/' + name + '/index.js');
    }
    const nativeBase = 'node_modules/@koromix/koffi-win32-x64/';
    put(nativeBase + 'package.json', '{"main":"index.js"}');
    put(nativeBase + 'index.js'); put(nativeBase + 'win32_x64/koffi.node');
    put('node_modules/sql.js/dist/sql-wasm.wasm');
    const positive = await pack('complete');
    await test('完整生产资源夹具通过', () => assert(checkPackage(positive).checked > 40));
    await test('原生依赖架构不符被拒绝', () => assert.throws(() => checkPackage(positive, 'arm64'), /koffi-win32-arm64/));
    await test('asar.unpacked原生载荷丢失被拒绝', async () => {
      const archive = path.join(temp, 'unpacked.asar');
      await asar.createPackageWithOptions(source, archive, { unpack: '**/*.node' });
      assert(checkPackage(archive).checked > 40);
      fs.unlinkSync(path.join(archive + '.unpacked', nativeBase, 'win32_x64/koffi.node'));
      assert.throws(() => checkPackage(archive), /koffi\.node/);
    });

    // 实际删除归档输入文件，确保遗漏不是仅在配置清单里查名字。
    const required = [...production, 'build/icon.png', 'renderer/index.html', 'renderer/ai-approval.html', 'renderer/ai-approval.css', 'renderer/ai-approval.js',
      'renderer/vendor/cm6-bundle.min.js', 'renderer/vendor/mermaid.min.js', 'renderer/vendor/docx-preview.min.js',
      'renderer/vendor/xlsx.min.js', 'renderer/vendor/pptx-preview.min.js',
      'node_modules/sql.js/dist/sql-wasm.wasm', 'renderer/app.js', 'renderer/session.js', 'renderer/session.css', 'renderer/preview-location.js', 'renderer/preview-location.css', nativeBase + 'index.js', nativeBase + 'win32_x64/koffi.node'];
    for (let i = 0; i < required.length; i++) {
      const file = required[i], bytes = fs.readFileSync(path.join(source, file));
      fs.unlinkSync(path.join(source, file));
      const archive = await pack('missing-' + i);
      await test('删除必需资源被拒绝：' + file, () => assert.throws(() => checkPackage(archive), (e) => e.message.includes(file)));
      put(file, bytes);
    }
    put('git-native.js', fs.readFileSync(path.join(root, 'git-native.js'), 'utf8') + '\nrequire("./future-service");');
    await test('新增传递本地依赖自动成为门槛', async () => {
      const archive = await pack('future');
      assert.throws(() => checkPackage(archive), /future-service\.js/);
    });
    put('git-native.js', fs.readFileSync(path.join(root, 'git-native.js')));
    put('renderer/styles.css', '.icon { background: url("missing-icon.png"); }');
    await test('CSS引用的本地资源遗漏被拒绝', async () => {
      const archive = await pack('css');
      assert.throws(() => checkPackage(archive), /missing-icon/);
    });
    put('renderer/styles.css');
    for (const [i, file] of ['docs/private.md', 'tests/fixture.js', '.ui-check-trash/secret.txt',
      '.env', 'sample.db', 'launch.json', 'node_modules/electron/package.json', 'node_modules/jsdom/package.json'].entries()) {
      put(file, 'fixture-marker');
      const archive = await pack('forbidden-' + i);
      await test('私人/开发产物被拒绝：' + file, () => assert.throws(() => checkPackage(archive), /禁止打入发行包/));
      fs.unlinkSync(path.join(source, file));
      // 归档包含目录本身；删去本次夹具的空父目录，避免污染后续用例。
      let dir = path.dirname(path.join(source, file));
      while (dir !== source && fs.readdirSync(dir).length === 0) { fs.rmdirSync(dir); dir = path.dirname(dir); }
    }
    fs.unlinkSync(path.join(source, 'node_modules/mysql2/index.js'));
    await test('生产npm入口遗漏被拒绝', async () => {
      const archive = await pack('npm-entry');
      assert.throws(() => checkPackage(archive), /node_modules\/mysql2\/index.js/);
    });
    put('node_modules/mysql2/index.js');
    await test('npm的相对目录main与条件exports入口可校验', async () => {
      put('node_modules/mysql2/package.json', '{"main":"./lib"}');
      put('node_modules/mysql2/lib/index.js');
      put('node_modules/docx-preview/package.json', '{"exports":{".":{"require":"./dist/preview.js","import":"./dist/preview.mjs"}}}');
      put('node_modules/docx-preview/dist/preview.js');
      const archive = await pack('npm-exports');
      assert(checkPackage(archive).checked > 40);
      fs.unlinkSync(path.join(source, 'node_modules/docx-preview/dist/preview.js'));
      const missing = await pack('npm-exports-missing');
      assert.throws(() => checkPackage(missing), /docx-preview\/dist\/preview.js/);
      put('node_modules/mysql2/package.json', '{"main":"index.js"}');
      put('node_modules/docx-preview/package.json', '{"main":"index.js"}');
    });
    fs.unlinkSync(path.join(source, 'plugins/example.js'));
    await test('全部内置插件遗漏被拒绝', async () => {
      const archive = await pack('plugins');
      assert.throws(() => checkPackage(archive), /缺少内置插件/);
    });
    put('plugins/example.js');
    const appOutDir = path.join(temp, 'packaged');
    fs.mkdirSync(path.join(appOutDir, 'resources'), { recursive: true });
    fs.copyFileSync(positive, path.join(appOutDir, 'resources/app.asar'));
    await test('配置中的afterPack检查实际归档', async () => {
      const hook = require(path.resolve(root, pkg.build.afterPack));
      await hook({ appOutDir });
      fs.unlinkSync(path.join(appOutDir, 'resources/app.asar'));
      await assert.rejects(() => hook({ appOutDir }), /找不到/);
    });
  } finally {
    const resolved = path.resolve(temp);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('myide-package-test-')) throw Error('Unsafe cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  console.log('结果: ' + passed + ' 通过, 0 失败');
})().catch((e) => { console.error(e); process.exitCode = 1; });

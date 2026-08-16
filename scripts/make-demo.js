// scripts/make-demo.js —— 生成 demo/ 演示项目（含 git 历史 + 未提交修改）
const git = require('isomorphic-git');
const fs = require('fs');
const path = require('path');

const demo = path.join(__dirname, '..', 'demo');
fs.rmSync(demo, { recursive: true, force: true });
fs.mkdirSync(demo, { recursive: true });
fs.mkdirSync(path.join(demo, 'src'));

const w = (rel, content) => fs.writeFileSync(path.join(demo, rel), content);

(async () => {
  await git.init({ fs, dir: demo, defaultBranch: 'main' });
  await git.setConfig({ fs, dir: demo, path: 'user.name', value: 'My IDE Demo' });
  await git.setConfig({ fs, dir: demo, path: 'user.email', value: 'demo@myide.local' });
  const author = { name: 'My IDE Demo', email: 'demo@myide.local' };

  // ---- 第 1 次提交 ----
  w('README.md', `# My IDE 演示项目

这是一个用来体验 **My IDE** 功能的演示目录，本身是一个真实的 Git 仓库。

## 你可以试试

- 单击左侧文件 → 打开并**自动复制完整路径**到剪贴板
- 本文件是 Markdown，右侧会渲染预览，\`Ctrl+Shift+C\` 复制路径
- 打开 \`index.html\` 看 HTML 渲染，\`data.csv\` 看 CSV 表格插件
- 点右上角 Git 徽标（或 \`Ctrl+2\`）查看日志与本地修改
- 按 \`Ctrl+K\` 打开提交面板，勾选文件、写信息、提交
- 点击某条提交历史 → 查看该提交的**修改前后对比**（左右分栏）

## 快捷键速查

| 快捷键 | 功能 |
| --- | --- |
| \`Ctrl+K\` | 打开提交面板 |
| \`Ctrl+Shift+C\` | 复制当前文件完整路径 |
| \`Ctrl+O\` | 打开文件夹 |
| \`Ctrl+S\` | 保存 |
| \`Ctrl+W\` | 关闭标签 |
| \`Ctrl+Tab\` | 切换标签 |
| \`Ctrl+1\` / \`Ctrl+2\` | 项目 / Git 面板 |
| \`Ctrl+R\` | 刷新 |
`);
  w('index.html', `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>My IDE 演示页</title>
<style>
  body { font-family: sans-serif; margin: 40px; }
  h1 { color: #2e6b9e; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 12px 0; }
  button { padding: 8px 16px; background: #2e6b9e; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
</style></head>
<body>
  <h1>👋 这是 HTML 预览</h1>
  <div class="card">My IDE 用沙箱 iframe 渲染 HTML 文件，脚本可以运行。</div>
  <button onclick="document.getElementById('out').textContent = '点击于 ' + new Date().toLocaleTimeString()">点我试试</button>
  <p id="out"></p>
</body>
</html>`);
  w('src/app.js', `// 示例代码文件
function greet(name) {
  return 'Hello, ' + name + '!';
}

const list = [1, 2, 3, 4, 5];
const doubled = list.map((n) => n * 2);
console.log(doubled);

module.exports = { greet };
`);
  w('notes.txt', '个人笔记：\n- 周末研究 Electron 插件机制\n- 下周把 diff 视图改成可折叠 hunk\n- 别忘了给编辑器加主题切换\n');
  await git.add({ fs, dir: demo, filepath: '.' });
  await git.commit({ fs, dir: demo, message: '初始版本：界面骨架与演示文件', author });
  console.log('commit 1 ok');

  // ---- 第 2 次提交 ----
  w('README.md', `# My IDE 演示项目

这是一个用来体验 **My IDE** 功能的演示目录，本身是一个真实的 Git 仓库。

## 你可以试试

- 单击左侧文件 → 打开并**自动复制完整路径**到剪贴板
- 本文件是 Markdown，右侧会渲染预览，\`Ctrl+Shift+C\` 复制路径
- 打开 \`index.html\` 看 HTML 渲染，\`data.csv\` 看 CSV 表格插件
- 点右上角 Git 徽标（或 \`Ctrl+2\`）查看日志与本地修改
- 按 \`Ctrl+K\` 打开提交面板，勾选文件、写信息、提交
- 点击某条提交历史 → 查看该提交的**修改前后对比**（左右分栏）

## 快捷键速查

| 快捷键 | 功能 |
| --- | --- |
| \`Ctrl+K\` | 打开提交面板 |
| \`Ctrl+Shift+C\` | 复制当前文件完整路径 |
| \`Ctrl+O\` | 打开文件夹 |
| \`Ctrl+S\` | 保存 |
| \`Ctrl+W\` | 关闭标签 |
| \`Ctrl+Tab\` | 切换标签 |
| \`Ctrl+1\` / \`Ctrl+2\` | 项目 / Git 面板 |
| \`Ctrl+R\` | 刷新 |

## 插件机制

` + '```js\n// plugins/csv.js 就是示例插件：\napi.registerRenderer([\'csv\', \'tsv\'], ({ content, name }) => {\n  // 返回一个表格 DOM\n});\n```' + `

把 JS 文件放进 \`plugins/\` 目录即可注册新格式的渲染器，详见项目里的 \`plugins/README.md\`。
`);
  w('data.csv', `月份,收入,支出,结余
1月,12000,8600,3400
2月,13500,9100,4400
3月,12800,8800,4000
4月,14200,9500,4700
`);
  await git.add({ fs, dir: demo, filepath: '.' });
  await git.commit({ fs, dir: demo, message: '添加 CSV 表格与插件文档', author });
  console.log('commit 2 ok');

  // ---- 未提交的修改（让工作区变脏，方便体验 diff/提交）----
  w('notes.txt', '个人笔记：\n- 周末研究 Electron 插件机制 ✅\n- 下周把 diff 视图改成可折叠 hunk\n- 别忘了给编辑器加主题切换\n- 新增：研究右键菜单粘贴路径\n');
  w('src/app.js', `// 示例代码文件（已修改：加了新函数）
function greet(name) {
  return 'Hello, ' + name + '!';
}

function add(a, b) {
  return a + b;
}

const list = [1, 2, 3, 4, 5];
const doubled = list.map((n) => n * 2);
console.log(doubled);
console.log('3 + 4 =', add(3, 4));

module.exports = { greet, add };
`);
  w('todo.txt', '待办：\n- [x] 文件树与路径复制\n- [x] Markdown / HTML 渲染\n- [ ] 可折叠 diff hunk\n- [ ] 主题切换\n');
  console.log('dirty files written');

  console.log('demo 目录就绪:', demo);
})();
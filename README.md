# My IDE —— 私人定制轻量编辑器

> 📐 **开发大纲（必读）：** [开发大纲.md](./开发大纲.md) —— 项目愿景、性能基线、功能边界、扩展机制，所有改动的最高依据。

一个 PyCharm 风格的极简编辑器（Electron + 原生 JS，零构建），专为个人使用设计。**核心目标：PyCharm 的核心体验，PyCharm 十分之一的内存。**

## 功能

- 📁 **PyCharm 式工具窗口**：左侧按钮条切换「项目 / 大纲 / Git」（Ctrl+1/2/3），同一侧同时只显示一个，再按一次收起
- 📁 **左侧文件树 / 右侧内容区**：懒加载目录树，多标签页打开文件
- ☰ **Markdown 大纲**：查看 md 时左侧显示标题层级（Ctrl+2），点击跳转
- 📋 **单击文件 = 打开 + 自动复制完整路径到剪贴板**（核心功能，右键菜单也有「复制完整路径」）
- 📝 **渲染器插件机制**：内置 Markdown（含代码高亮）、HTML 沙箱预览；`plugins/` 目录放一个 JS 文件即可扩展任意格式（如 CSV 表格）
- 🖊 **文本/代码文件可直接编辑保存**（Ctrl+S），md/html 可在预览 ⇄ 源码间切换
- 🔀 **Git（纯 JS 实现，无需安装 git）**：
  - 提交历史日志（点开某条提交 → 查看该提交修改了哪些文件 → 逐个看前后对比）
  - `Ctrl+K` 打开提交面板：勾选文件、写提交信息、提交 / amend
  - 本地修改列表，点击任意文件 → **左右分栏前后对比**（红色删除 / 绿色新增）

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+K` | 打开提交面板 |
| `Ctrl+Shift+C` | 复制当前文件完整路径 |
| `Ctrl+O` | 打开文件夹 |
| `Ctrl+S` | 保存 |
| `Ctrl+W` | 关闭标签 |
| `Ctrl+Tab` | 切换标签 |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | 项目 / 大纲 / Git 工具窗口 |
| `Ctrl+R` | 刷新 |
| `Esc` | 关闭弹窗 |

## 启动

**方式一（推荐）：双击项目根目录下的 `MyIDE.bat`** —— 自动检查依赖，首次运行自动安装，出错时窗口会停留并显示报错信息。

**方式二（命令行）：**

```bash
npm install     # 首次
npm start       # 启动应用
```

首次打开后点「📂 打开文件夹」选择项目目录（会记住上次打开的目录）。
想立刻体验 Git 功能？`npm run demo` 生成带提交历史的 `demo/` 演示项目，然后打开它。

## 目录结构

```
main.js               Electron 主进程（窗口 + IPC：文件系统 / Git / 剪贴板 / 插件）
preload.js            contextBridge 安全桥（window.myIDE）
git-service.js        Git 封装（isomorphic-git）+ 自研 Myers 行级 diff
renderer/             渲染进程（原生 JS，无构建）
  plugin-loader.js    渲染器注册 API + 内置 md/html/json 渲染
  tree.js / viewer.js / git-panel.js / shortcuts.js / app.js
  vendor/             打包好的第三方库（marked、highlight.js）
plugins/              用户插件目录（csv.js 是示例，见 plugins/README.md）
tests/                自动化测试：git 逻辑 + 渲染层（jsdom）
scripts/              make-demo.js（演示项目）、vendor.js（重新打包 vendor）
```

## 开发插件

```js
// plugins/xxx.js —— 为 .pdf / .docx 等任何格式添加渲染
api.registerRenderer(['pdf', 'docx'], ({ path, name, ext, content }) => {
  const div = document.createElement('div');
  div.textContent = '自定义渲染 ' + name;
  return div; // 返回 HTMLElement 直接展示，返回字符串则作为源码
});
```

详见 `plugins/README.md`。

## 测试

```bash
npm test    # git 逻辑测试 + 渲染层 DOM 测试（jsdom）
```
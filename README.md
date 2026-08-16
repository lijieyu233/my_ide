# My IDE —— 私人定制轻量编辑器

> 📐 **开发大纲（必读）：** [开发大纲.md](./开发大纲.md) —— 项目愿景、性能基线、功能边界、扩展机制，所有改动的最高依据。
> 🗺 **路线图：** [ROADMAP.md](./ROADMAP.md) —— 功能清单与完成记录（当前全部完成）。

一个 PyCharm 风格的极简编辑器（Electron + 原生 JS，零构建），专为个人使用设计。**核心目标：PyCharm 的核心体验，PyCharm 十分之一的内存。**

## ✨ 功能全景（v0.3.0）

**浏览与编辑**
- 文件树：懒加载、展开状态记忆、**虚拟滚动**（大目录不卡）、**打开文件自动定位高亮**、**Git 状态着色**（新增绿/修改蓝/删除红）、**一键收起/展开全部目录**、**目录区宽度可拖拽调整**（持久化）
- 多标签：中键关闭、右键关闭其他/全部、**拖拽排序**、会话记忆（每个项目独立）
- 编辑器：**行号**、查找/替换（Ctrl+F / Ctrl+H）、**括号配对自动补全**、**字号缩放（Ctrl+=/-）**、**GBK/UTF-16 编码自动识别与回写**（状态栏显示编码与换行符）
- 新建文件/文件夹（右键菜单）、重命名、删除、**文件复制粘贴（与资源管理器互通）**
- 快速打开（Ctrl+P）无输入时显示**最近打开的文件**
- **单击文件只打开，不再自动复制路径**（复制请用 Ctrl+Shift+C 或悬停「复制路径」）

**渲染（插件机制，可扩展任意格式）**
- Markdown（代码高亮、**编辑态实时分屏预览**）、HTML（沙箱预览）、CSV 表格、**图片、PDF**（内置查看器，图片纯色背景无格子）
- `plugins/` 目录放一个 JS 文件即可注册新格式（见 [plugins/README.md](./plugins/README.md)）

**Git（纯 JS 实现，无需安装 git，PyCharm 式 Version Control）**
- **分页签：本地修改 / 提交历史**（提交历史独立一个选项，可切换）
- 日志：**分支图、分支视图下拉（当前/指定/所有分支）、过滤、HEAD 徽标、分页加载更多**
- 本地修改**按目录分组折叠**、**放弃修改（revert，恢复到 HEAD / 删除未跟踪）**；状态栏**点击分支切换、点击路径复制**
- 提交：Ctrl+K 面板（**只显示文件名**，勾选文件/amend）、修改前后**左右分栏对比**（hunk 折叠 + 上下导航 + **旧版/新版内容一键复制**）
- 分支管理：**切换分支 + 新建分支（New Branch）**、提交作者配置（设置页）、Git 面板**手动刷新按钮**
- 状态刷新 500ms 防抖 + **打开项目延迟 800ms 扫描**（大仓库不卡，扫描中显示「⏳ 扫描中…」）

**多项目**：顶部项目栏打开/切换多个项目，每个项目独立标签记忆

**其他**：主题切换（深/浅）、内容搜索（Ctrl+Shift+F）、快速打开（Ctrl+P）、状态栏（分支/行号/编码）、设置页（快捷键自定义 + Git 配置）、帮助页（F1）

## ⌨️ 快捷键（可在设置中自定义）

| 快捷键 | 功能 |
| --- | --- |
| Ctrl+P | 快速打开文件 |
| Ctrl+Shift+F | 搜索内容 |
| Ctrl+F / Ctrl+H | 查找 / 替换 |
| Ctrl+K | 提交更改 |
| Ctrl+Shift+C | 复制当前文件路径 |
| Ctrl+C / Ctrl+V | 文件树中复制/粘贴文件 |
| Ctrl+O | 打开文件夹 |
| Ctrl+S | 保存 |
| Ctrl+W | 关闭标签 |
| Ctrl+Tab | 切换标签 |
| Ctrl+1/2/3 | 项目 / 大纲 / Git 工具窗口 |
| Ctrl+Alt+S | 设置 |
| Ctrl+Shift+T | 切换主题 |
| Ctrl+R | 刷新 |
| F1 | 帮助与快捷键速查 |
| 鼠标中键 | 关闭标签 |

## 🚀 启动

**方式一（推荐）：双击项目根目录下的 MyIDE.bat**（自动检查依赖，首次自动安装）。

**方式二（命令行）：**

```bash
npm install     # 首次
npm start       # 启动应用
```

**方式三（打包版，无需 Node 环境）：** 双击 `dist/MyIDE-0.3.0.exe`（便携版单文件，拷贝即用）。重新打包：`npm run build`。

首次打开后点「📂 打开文件夹」选择项目目录；想体验 Git 功能可 `npm run demo` 生成演示项目。

## 📁 目录结构

```
main.js               Electron 主进程（窗口 + IPC：文件系统 / Git / 剪贴板 / 编码 / 插件）
preload.js            contextBridge 安全桥（window.myIDE）
git-service.js        Git 封装（isomorphic-git）+ 自研 Myers 行级 diff
renderer/             渲染进程（原生 JS，无构建）
  plugin-loader.js    渲染器注册 API + 内置 md/html/csv/图片/PDF 渲染
  tree.js / viewer.js / outline.js / git-panel.js / quickopen.js /
  search.js / settings.js / help.js / session.js / shortcuts.js / theme.js / app.js
plugins/              用户插件目录（csv.js 是示例，见 plugins/README.md）
docs/                 开发文档（42 份，每项功能一文档）
scripts/              bench（性能基准）/ make-demo / git-commit / vendor
tests/                自动化测试：git 逻辑 + 渲染层（jsdom）
```

## 🧪 测试与基准

```bash
npm test       # 96 项：语法检查 + git 逻辑 + 渲染层 DOM 测试
npm run bench  # 性能基准（5000 文件 git 扫描 < 1s 实测达成）
```

## 📄 文档索引

- [开发大纲.md](./开发大纲.md) —— 愿景 / 性能基线 / 功能边界（宪法）
- [ROADMAP.md](./ROADMAP.md) —— 功能清单与完成记录
- [docs/](./docs/) —— 27 份开发文档（每项功能：需求/设计/测试/验收）
- [plugins/README.md](./plugins/README.md) —— 插件开发指南
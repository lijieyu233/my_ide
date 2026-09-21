# 开发文档 051 —— 面板对齐 PyCharm（项目窗口顶部 + 提交窗口）

> 状态：已完成 · 体验打磨

## 一、需求

用户给出现状截图（项目面板顶部工具条、提交面板）+ PyCharm 提交窗口作为参照，要求照 PyCharm 的观感改这两处。

问题归纳：

1. **项目面板顶部**：搜索框带 emoji 放大镜 + 常驻描边，聚焦时「描边色 + 焦点外框」叠成双圈；右侧 4 个按钮**每个都带边框**，一排下来像表单
2. **提交面板**：标题栏 6 个按钮全是 emoji 图标 + 描边；操作行两个按钮也带边框；**每一行文件都重复整句状态文案** `已删除（已暂存）`，把列表刷成一片文字

## 二、设计（对齐 PyCharm）

### 1. 项目面板顶部（`#tree-head`）

| 项 | 旧 | 新 |
|---|---|---|
| 搜索框 | emoji 放大镜写进 placeholder + 常驻 1px 描边 + 聚焦外框 | 放大镜改为**内嵌 SVG**（绝对定位在框内左侧）；静态透明边框，hover 才出边线，focus 描主色；`:focus-within` 时图标转主色 |
| 图标按钮 | `.vt-btn` 带边框，4 个排成表单 | 作用域内改**无边框 + hover 浮底色**（PyCharm 工具窗口按钮）：`#tree-head .vt-btn { border:none; background:transparent }` |
| 图标 | `↕ ⊟ ⊞` 字符 + `👁` emoji | 全部内联 SVG（排序 ⇅ / 收起框− / 展开框+） |
| 三态视角 | 带边框的彩色框 | 保留**文字**（常规/仅隐藏/全部，可读性优先）+ 淡色底 `color-mix(accent 14%)` |

注：`#tree-hide-mode` 的文字与 `hm-normal/hm-hidden/hm-all` 类由 `tree.js` 维护（会整体重写 className），因此这里**只做样式升级、改 HTML 结构**，不动 tree.js 的状态机。

### 2. 提交窗口（`#panel-git` + `git-panel.js`）

| 项 | 旧 | 新 |
|---|---|---|
| 标题栏按钮 | `⬇ 拉取 ⬆ 推送 🗄 🔗 🔄 🕘`（emoji + 描边） | 拉取/推送 = SVG + 文字；搁置/远程/刷新/历史 = SVG 图标；**全部无边框 + hover 浮底色**；两组之间插 `.tb-sep` 分隔 |
| 操作行 | `↺ 回滚选中` `↔ 显示差异`（`.tb-btn` 描边） | 去 `.tb-btn` 改 `.gbtn`：无边框 + SVG 图标 + hover 底色 |
| **状态展示** | 每行 `<span class="badge">已删除（已暂存）</span>` 整句重复 | **单字母方块**：`A` 新增 / `M` 修改 / `D` 删除 / `?` 未跟踪；完整文案进 `title`（tooltip），行 `title` 也带上 |
| 暂存与否 | 无法区分 | **未暂存 = 描边，已暂存 = 实底**（`currentColor` 实底 + 面板底色文字，VS Code / PyCharm 惯例） |
| 文件行颜色 | 目录与文件同色系、状态语义靠文字 | 文件名保持中性色，**状态语义只由徽章承载** —— 这是列表能"扫"得动的前提 |

## 三、结构

```
renderer/index.html      #tree-head 搜索框包一层 + 3 个图标换 SVG；#panel-git 标题栏 6 个按钮换 SVG
renderer/styles.css      tree-head 搜索框/按钮重写；提交面板标题栏与操作行按钮去边框；徽章改单字母方块 + staged 实底
renderer/git-panel.js    fileRow 徽章改单字母 + tooltip；操作行两个按钮换 SVG
renderer/styles.css      :focus-visible 排除 input/textarea/select（否则与 focus:border-color 叠成双圈）
scripts/check-ui-steps.js  新增 treeHead / commitPanel 两组页内步骤
main.js                  --check-ui 增加两步 + 截图（check-ui-1a-treehead.png / 1c-commit-panel.png）
```

## 四、测试

### jsdom（`npm test` → 217 项全绿）
既有断言全部兼容：`.git-sec-title` 仍需含 `变更 (2)`；`#cd-push` / `#cd-shelve` / `#cd-remote` 仍可按 id 点到；
`#tree-sort` / `#tree-hide-mode` 的类与文字协议不变。**因此本轮只改样式与徽章渲染，不动列表结构**。

### 真实 Chromium（`electron . --check-ui` → **91 项全绿 + 13 张截图**）
新增两组断言：

| 组 | 覆盖 |
|---|---|
| 项目面板顶部 | 内嵌 SVG 放大镜、placeholder 无 emoji、搜索框静态无描边、4 个按钮 borderTopStyle 全为 none、3 个图标是 SVG、三态按钮保留文字 |
| 提交面板 | 列表渲染、**徽章全为单字母**（`/^[AMD?U]$/`）、**行内无「已暂存」长文案**、长文案在 tooltip、已暂存/未暂存底色可区分、标题栏与操作行按钮无边框且带 SVG |

截图：`check-ui-1a-treehead.png`（项目面板顶部）、`check-ui-1c-commit-panel.png`（提交面板）。

## 五、验收

- [x] `npm test` 217 项全绿
- [x] `electron . --check-ui` 91 项全绿，截图肉眼复核：两处按钮去边框、图标全 SVG、提交列表单字母徽章
- [x] 搜索框不再有「双圈焦点」
- [x] 零新依赖

# 开发文档 046 —— Obsidian 式 Markdown 编辑

> 目标：把 MyIDE 的 Markdown 编辑体验做到与 Obsidian Live Preview 同级。
> 本文档为调研 + 方案设计，是后续开发的唯一依据。

---

## 1. 背景

- 用户反馈（todo.md）：「markdown 的编辑功能也没有变，整个一点变化都没有」「这次重点在 markdown 这块，改了好多次一点变化都没有，体验太差了」「希望对 md 的编辑能和 obsidian 一样」。
- 当前已实现的「实时预览」（viewer.js `renderMarkdownLive`）是**块交换方案**：按空行切块，非编辑块渲染 HTML，点击块后整块替换为 textarea。
- 该方案与 Obsidian 的体验差距是结构性的，不是细节问题（见 §3）。

## 2. 调研结论

### 2.1 Obsidian Live Preview 的工作原理

官方文档（obsidian.md/help/edit-and-read）与社区实现（CodeMirror Options 插件、@fedoup/markdown-editor）证实：

1. **单一编辑器实例**：整个笔记就是一个 CodeMirror 6 `EditorView`，文档模型**始终是纯 Markdown 文本**（`**bold**` 就是字符）。
2. **decoration 装饰层**：一个 ViewPlugin 遍历语法树（lezer-markdown），对**光标不在的行**发两类装饰：
   - `Decoration.mark`：给内容加样式（标题字号、加粗、行内代码背景）
   - `Decoration.replace`：隐藏语法标记（`**`、`[]()`、围栏行 ```` ``` ````）
3. **光标行始终显示原始源码**。点击 → CM 内建把坐标转为文档偏移 → 光标移动 → 装饰同帧重建 → 该行"展开"为源码。移开光标，渲染态恢复。
4. **没有组件交换、没有缓冲区**：源码/渲染切换是一次 decoration 更新，因此无闪烁、无焦点丢失、无滚动跳动。
5. `Ctrl+E` 在 Live Preview / Source mode / Reading view 间切换；Source mode 就是关掉 decoration 的同一个编辑器。

关键引用（@fedoup/markdown-editor README）："That single conditional is what makes the experience feel like Obsidian's Live Preview: the line the cursor lives on is always shown as raw source; every other line is shown as if it were rendered. … No component swap, no race."（唯一条件——光标行显源码、其余行显渲染——正是 Obsidian 体验的核心；无组件交换、无竞态。）

### 2.2 Obsidian 编辑体验特性全景

| 类别 | 特性 |
|------|------|
| 核心混合渲染 | 光标行源码 / 其余行渲染；标题、加粗、斜体、`==高亮==`、`~~删除线~~`、行内代码、链接（只显示 label）、图片（渲染为 `<img>`）内联渲染 |
| 块级渲染 | 代码块围栏行光标不在时整行隐藏；表格、引用、Callout（`> [!note]`）、数学公式、Mermaid 实时渲染 |
| 交互组件 | 任务列表复选框渲染态直接点击切换；链接/图片渲染态可点击 |
| 编辑智能 | 回车自动延续列表/引用；Tab/Shift+Tab 调整列表层级；自动补全标记对 |
| 快捷键 | Ctrl+B/I 加粗斜体、Ctrl+K 链接、Ctrl+E 模式切换；选中文字浮动格式工具条 |
| 链接体系 | `[[wiki 链接]]` 输入补全（文件名/标题模糊匹配）、`![[嵌入]]` |
| 剪贴板/拖拽 | 粘贴图片自动落盘并插入引用；拖文件进编辑器插入链接；粘贴 URL 到选中文字自动变链接 |
| 图片体验（1.13 新） | 图片键盘可选中、Backspace 删除、`+`/`-` 缩放、全屏查看 |
| 底层能力 | 跨块选区、撤销/重做、IME 输入法、增量渲染（只算可视区） |

## 3. 现状与差距分析

当前 `renderMarkdownLive`（块交换方案）的**结构性缺陷**——正是用户感知"体验太差、改了没变化"的根源：

| # | 差距 | 现状 | Obsidian |
|---|------|------|----------|
| 1 | **光标定位** | 点击块后光标落在块首（未换算点击位置） | 光标精确落在点击的字符处 |
| 2 | **视觉稳定性** | 整块 div ↔ textarea 交换，样式/高度突变闪烁 | decoration 更新，无跳变 |
| 3 | **跨块选区** | 不可能（每块独立 textarea） | 鼠标拖选跨块 |
| 4 | **撤销/重做** | 无（各块 textarea 独立，块切换历史丢失） | Ctrl+Z 全文档连续历史 |
| 5 | **IME** | 未做保护 | CM6 内建 |
| 6 | **性能** | 每次提交 `renderAll` 清空重建全部块 DOM | 只重算可视区，增量更新 |
| 7 | **焦点时序** | blur + setTimeout(80ms) hack | 无需 |

结论：**继续在块交换方案上修补无法达到 Obsidian 水平**，需要更换技术路线。

## 4. 技术方案选型

| 方案 | 思路 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| A. 块编辑器增强 | 现有方案补光标定位、undo 栈等 | 零新依赖 | 光标换算/选区/undo/闪烁全是硬骨头，上限低 | ✗ |
| **B. CodeMirror 6（推荐）** | 与 Obsidian 同款引擎：CM6 + lezer-markdown + 自研 decoration 插件 | 交互保真度上限最高；光标定位/选区/undo/IME/增量渲染全部内建；source 模式顺手获得（关掉 decoration 即可） | 新增依赖 ~300KB min（gzip ~90KB）；学习曲线 | ✓ |
| C. 覆盖层混合 | 单 textarea + 绝对定位渲染层覆盖非活动块 | 无依赖 | 滚动/选区/换行对齐实现极复杂（Typora 级难度） | ✗ |

选 **B**，理由：
1. 「和 Obsidian 一样」的唯一正解路径——Obsidian 本身就是 CM6；
2. 项目 `devDependencies` 已有 `esbuild ^0.28.2`，CM6 可一条命令 vendor 化为单文件 IIFE，与现有 `renderer/vendor/`（marked/hljs）模式一致；
3. 体积增量可控（gzip 后与 marked+hljs 同量级），符合「轻量」定位；
4. 现有四模式架构不动：`live`/`source` 由 CM6 承载（同一个编辑器，切换=开关 decoration），`split`/`preview` 继续走 marked 渲染管线。

## 5. 功能清单与实现设计

### P0 —— 光标驱动混合渲染（定义"像 Obsidian"的核心）

| # | 功能 | 实现 |
|---|------|------|
| 0.1 | CM6 基础接入 | 依赖：`@codemirror/state view language commands lang-markdown search autocomplete` + `@lezer/common @lezer/markdown`。esbuild 打包为 `renderer/vendor/cm6-bundle.min.js`（IIFE，暴露全局 `window.CM6`），scripts/vendor.js 追加下载/构建脚本 |
| 0.2 | 单编辑器实例 | viewer.js 新建 `renderer/md-editor.js`：`CM6.editor({ doc, onChange, onCursor })` 返回 EditorView。`live` 与 `source` 模式共用该实例 |
| 0.3 | Live Preview decoration 插件 | ViewPlugin + `buildViewPlugin`：解析 lezer 语法树，遍历可视区（`view.visibleRanges`）内节点，产出装饰集。规则：光标所在行（`state.selection` 覆盖的行范围）不装饰 |
| 0.4 | 行内标记隐藏 | `Decoration.replace` 隐藏：`**` `*` `==` `~~` `` ` `` 及链接的 `[](url)` 部分（label 用 mark 加链接样式）；`![alt](src)` 整体替换为 img widget（沿用 plugin-loader.js 的相对路径→file:/// 解析） |
| 0.5 | 块级渲染 | 标题：mark 加 `.cm-h1..h6` 类；围栏代码块：首尾围栏行整行 replace 隐藏，代码体 mark 加背景；引用标记 `>` 弱化；表格分隔线行隐藏 |
| 0.6 | 光标即编辑 | CM6 内建（点击坐标→doc pos），删掉现有 mousedown/preventDefault/焦点 hack |
| 0.7 | Ctrl+E 模式切换 | live ↔ source 循环（对齐 Obsidian），快捷键注册进 shortcuts.js |

### P1 —— 编辑智能

| # | 功能 | 实现 |
|---|------|------|
| 1.1 | 任务复选框点击 | `- [ ]` / `- [x]` 用 replace widget 渲染 `<input type=checkbox>`；点击 checkbox → `view.dispatch` 替换源码字符，光标行内仍可编辑文本 |
| 1.2 | 列表续行 | keymap `Enter`：光标行匹配 `^(\s*)([-*+] |\d+\. |> )` 时新行自动补前缀；列表空项回车取消前缀退出列表 |
| 1.3 | 列表缩进 | keymap `Tab`/`Shift+Tab`：行首增删 2 空格（列表上下文），非列表 Tab 移焦点 |
| 1.4 | 格式快捷键 | Ctrl+B/I/K + 自定 Ctrl+H：对选区包装/解包 `**` `*` `==` `[]()`；有选区且已被包装则解开（toggle 语义） |
| 1.5 | 标记对自动补全 | 现 viewer.js `handlePairing` 逻辑移植为 CM6 `inputHandler`：输入 `**`、`==`、`[[` 时补另一半并把光标放中间 |
| 1.6 | wiki 链接补全 | 输入 `[[` 或 `![[` 触发 CM6 autocompletion：数据源=项目内 .md 文件（复用 Tree/quickopen 缓存）模糊匹配；`#` 后补当前文件标题（Outline 数据） |
| 1.7 | 选中浮动工具条 | selection 变化时在选区上方浮出 B / I / == / `code` / 链接 按钮（纯 DOM，调 1.4 的包装函数） |

### P2 —— 语法渲染增强（marked 管线 + CM6 widget 双端）

| # | 功能 | 实现 |
|---|------|------|
| 2.1 | `==高亮==` `~~删除线~~` | marked 扩展（plugin-loader.js 预处理替换为 `<mark>`/`<del>`）+ CM6 mark 同步 |
| 2.2 | Callout | `> [!note]` 首行解析为类型图标标题栏（marked 后处理 + CM6 块 widget） |
| 2.3 | 数学公式 | KaTeX vendor 化（可选，按需加载）；`$..$`/`$$..$$` widget 渲染 |
| 2.4 | 嵌入 `![[note]]` | 文件级 widget：读取目标 md 渲染为内嵌只读卡片（深度限 1 层防递归） |
| 2.5 | 粘贴图片 | 渲染进程 clipboard API 读图片 blob → 新 IPC `fs:saveAsset(root, name, buf)` 写入 `<root>/assets/` → 插入 `![](assets/xxx.png)` |
| 2.6 | 拖拽插入 | drop 事件：来自文件树的拖拽（读 `text/myide-path`）插入 `[[name]]` 或图片 `![](path)`；外部文件同走 2.5 落盘 |

### P3 —— 周边体验（按需）

| # | 功能 | 实现 |
|---|------|------|
| 3.1 | 图片键盘操作 | 图片 widget 可 focus（tabindex），Backspace 删除、`+`/`-` 改尺寸写回 `![h|300]` 语法 |
| 3.2 | 大纲联动 | onCursor 回调 → 行号 → 最近标题 → Outline 高亮 |
| 3.3 | 查找替换适配 | 现有 openFind 面向 textarea；改用 CM6 `@codemirror/search` 或自研面板+高亮 decoration |
| 3.4 | 行号/状态栏 | onCursor 更新行/列（替换现 reportPos） |

## 6. 架构与模块设计

```
renderer/
├── vendor/cm6-bundle.min.js     # 新增：esbuild 打包的 CM6 全家桶（全局 CM6）
├── md-editor.js                 # 新增：CM6 封装（创建/销毁/getValue/setValue/focus）
│                                #   + live-preview.ts 等价的 decoration 插件（js 实现）
├── md-live-preview.js           # 新增：decoration 构建器（mark/replace/widget 规则表）
│                                #   + widget 工厂：img / checkbox / callout / embed
├── md-completion.js             # 新增：wiki 链接与标题补全源
├── md-commands.js               # 新增：格式快捷键、列表续行/缩进、标记对补全
└── viewer.js                    # 改造：mode=live/source → MdEditor 实例（每 tab 一个，
                                 #   切 tab 时 detach/attach，或 tab 记忆 view 状态）
```

数据流（不变的部分）：
- `tab.content` 仍是唯一真源；CM6 `onChange` → `tab.content` + dirty + 3s 自动保存（复用现有 scheduleAutosave）
- 主题：CM6 主题用 CSS 变量（`var(--accent)` 等），四主题自动适配
- `split`/`preview` 模式与 md-editor 解耦，继续走 plugin-loader.js 的 marked 管线（预览渲染一致性由 2.1/2.2 双端保证）

预加载/主进程新增（仅 P2.5/2.6 需要）：
- `fs:saveAsset(path, name, ArrayBuffer) → {ok, path}`（preload.js + main.js）

## 7. 实施里程碑

| 阶段 | 内容 | 验收 |
|------|------|------|
| M1 引擎接入 | 0.1 + 0.2：CM6 vendor 化；`source` 模式改用 CM6（替换 textarea）；undo/选区/IME/查找替换/自动保存全通 | 现有 dom.test.js 全绿 + 新增 CM6 基础用例 |
| M2 Live Preview | 0.3–0.7：decoration 插件上线，`live` 模式替换块编辑器 | 点哪光标在哪；光标行源码/其余渲染；无闪烁 |
| M3 编辑智能 | 1.1–1.7 | 复选框点击、列表续行、Ctrl+B/K、`[[` 补全 |
| M4 语法增强 | 2.1/2.2/2.5/2.6（2.3/2.4 可选） | ==高亮==、callout、贴图落盘 |
| M5 周边 | 3.x 按需 | 大纲联动、查找替换适配 |

每阶段：`npm test`（新增对应 dom 用例）+ `electron . --check`（check-page.js 增补断言）+ git 提交。

## 8. 测试与验收标准

**量化验收（"像 Obsidian"的判定线）**：
1. 点击任意渲染文本，光标出现在点击的字符处（CM 内建，验收时抽查 5 处：标题/加粗内/链接 label/列表项/代码块）
2. 光标所在块显示 Markdown 标记，移开后 ≤1 帧内恢复渲染态，无高度跳动
3. 鼠标从块 A 拖选到块 C 可产生跨块选区，Ctrl+B 可整体加粗
4. Ctrl+Z/Y 跨块连续撤销重做
5. 中文 IME 在任意位置输入正常（无 decoration 抢焦点）
6. 2000 行文档滚动/输入无可感知卡顿（decoration 仅算 visibleRanges）
7. 任务复选框渲染态点击即切换并落盘
8. `[[` 弹出补全，Enter 选中生成 `[[文件名]]`
9. Ctrl+E 在 live/source 间切换，内容/光标/滚动不丢
10. 既有回归：四主题、分屏、预览、自动保存、会话记忆、大纲、查找替换全绿

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| CM6 学习曲线（decoration API 复杂） | M1 先只做 source 模式接入熟悉 API；M2 参照 @fedoup/markdown-editor（9KB 源码，MIT）的实现骨架 |
| decoration 与 IME 冲突 | 只对非光标行应用 replace；光标行永远原始文本（与 Obsidian 同策略） |
| vendor 体积 | esbuild min + gzip 后 ~90KB，与 marked+hljs 同量级；构建脚本锁定版本 |
| 现有功能回归（查找替换/配对补全/行号状态栏） | M1 一次性适配并补测试，不留给后续阶段 |
| 每 tab 一个 EditorView 内存 | 大文档场景 view 惰性创建：非活动 tab 只存 doc（string），激活时重建（CM6 `EditorState.create` 恢复，成本极低） |

## 10. 参考资料

- Obsidian 官方：Views and editing mode（obsidian.md/help/edit-and-read）
- Obsidian Changelog 1.13（图片键盘交互等新特性）
- CodeMirror 6：Hide markdown syntax（discuss.codemirror.net/t/hide-markdown-syntax/7602）
- @fedoup/markdown-editor（npm，MIT，CM6 Live Preview 最小实现，M2 参考骨架）
- nothingislost/obsidian-codemirror-options（CM5 时代 token 隐藏策略，规则参考）
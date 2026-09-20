# 开发文档-052 · 提交工具窗口对齐 PyCharm

> 参照物：PyCharm 中文版「提交」工具窗口截图（工具栏 8 个图标按钮 / `更改 N 个文件` 与目录节点**都带复选框** /
> 文件行 `M↓` / `未进行版本管理的文件` / `☐ 修正(M) 上次提交 ⌄` + 🕘 / `提交消息` 占位 / `提交 (I)` 与 `提交并推送(P)...`）。

## 一、先修 3 个真 bug（不是「缺功能」，是「行为错」）

### 1. 取消勾选对「已暂存」文件无效 —— 勾选形同虚设

`git-service.commit()` 老实现是「add 勾选项 → 提交整个 index」。只 add 不 unstage，
于是**已在 index 里、被用户取消勾选的文件照样进了提交**，而且提交后工作区变干净
（暂存内容被这次提交"吃掉"）。

复现（修前）：

```
status: a.txt=*modified        # a.txt 在别处被 git add 过
commit({files:['b.txt']})      # 用户在面板里只勾 b.txt
HEAD a.txt = "A2 staged"       # ❌ 未被勾选的 a.txt 也被提交了
```

修法（`git-service.commit`）：提交前把「未勾选但 index 与 HEAD 不一致」的路径 `resetIndex` 掉，
让**勾选集合成为唯一权威**（= PyCharm 语义：取消勾选 = unstage）。
`resetIndex` 只动 index 不动工作区 → 未勾选的改动仍留在工作区，提交后显示为未暂存。

```js
const sel = new Set(files.map(posix));
for (const row of await git.statusMatrix({ fs, dir: root })) {
  const [, h, , s] = row;
  if (!sel.has(posix(row[0])) && s > 0 && s !== h) await git.resetIndex({ fs, dir: root, filepath });
}
```

顺带：`git.add` 加 `force: true` —— 勾选被 `.gitignore` 忽略的文件时也能暂存（PyCharm 同行为）。

### 2. `Ctrl+Alt+K` 是假的

`#cm-ok-push` 的 tooltip 一直写着 `Ctrl+Alt+K`，但 `shortcuts.js` 里**没有这个绑定**。
PyCharm 的「提交并推送」是 `Ctrl+Shift+K`，也没有。现在注册 `commit-push`：
`['ctrl+shift+k', 'alt+p', 'ctrl+alt+k']`（后两个是兼容/助记键）。

### 3. `Ctrl+K` 只打开面板，不聚焦提交消息框

把一个动作拆成两个，与 PyCharm 一致：

| 动作 | 键位 | 行为 |
|---|---|---|
| `commit` | `Ctrl+K` / `Alt+I` | 打开提交窗口 **并聚焦提交消息框** |
| `commit-tool-window` | `Alt+0` / `Ctrl+3` / `Ctrl+4` | 只打开提交工具窗口（不抢焦点） |

## 二、交互补齐（PyCharm 提交窗口的可见件）

| 项 | 实现 |
|---|---|
| **节点级三态复选框** | 「更改」/「未进行版本管理的文件」/「忽略的文件」分节标题行、以及每个目录行都有复选框；全选/半选（`indeterminate`）/空三态；文件行勾选反向刷新所有上级节点 |
| **展开全部 / 收起全部** | 工具行图标按钮；同时作用于分节、目录与忽略节点。目录新增全局开关 `dirAllCollapsed`（未被单独点过的目录也跟随）——老写法只改已存在的 `dirCollapsed[key]`，导致「收起全部」对没点过的目录无效 |
| **分组方式（按目录 ↔ 平铺）** | 工具行最后一个按钮；平铺时一行一个文件，父目录弱化显示在文件名前（`文件名` 前的灰色 `src/components/`） |
| **提交消息历史（🕘）** | 底部 amend 行右侧；点开列出最近 20 条（`myide-commit-msgs`，全局）；点条目填充输入框；另有「清空历史」 |
| **提交消息草稿持久化** | `myide-commit-draft:<项目根>`，输入防抖 500ms 落盘；切项目时若输入框还是上个项目的草稿则自动换成新项目的；提交成功后清空 |
| **amend 自动回填** | 勾选 `修正上次提交 (Amend)` → 拉最后一次提交消息填进输入框（原内容存 `amendBackup`）；取消勾选还原 |
| **「提交并推送」下拉（▾）** | `提交并推送` / `提交并推送到 <remote>`（多于一个远程时）/ `提交并强制推送（--force，红色二次确认）`。`pushRemote` 新增 `{ remote, force }` |
| **内嵌 diff 预览（👁）** | 侧栏只有 ~280px，左右分栏的 diff 表格读不了 → 用**紧凑 unified 视图**（hunk 行 + `+`/`-` 前缀 + 行级底色）；再次点击关闭；文件行点击在「面板内预览」↔「主编辑区大图」间切换 |
| **「忽略的文件」节点** | 默认收起，**展开才遍历工作区**（懒加载，大仓库不做无谓扫描）；命中规则的目录整棵跳过（`node_modules` 不拖死遍历）；列出了 `node_modules/`、`.idea` 等 |
| **右键菜单** | 新增「🕘 显示历史」「🚫 添加到 .gitignore」「✅ 不再忽略」；忽略的行只有「不再忽略」+ 打开/复制，没有「回滚」（回滚=删除，语义不对）与「搁置」 |
| **文案对齐** | `变更 (N)` → **`更改 N 个文件`**；`未版本控制的文件` → **`未进行版本管理的文件`**；`amend` → **`修正上次提交 (Amend)`**；placeholder `提交信息…` → **`提交消息`** |
| **工具行图标化** | 旧的「☑ 全选 · 回滚选中 · 显示差异」文字按钮 → **8 个纯图标按钮**（SVG，文字进 tooltip）：`刷新 ｜回滚 ｜差异 ｜提交 ｜预览 ‖ 展开全部 ｜收起全部 ｜分组方式`；未勾选时前三个自动禁用 |

`#git-check-all`（全选单选框）已删除 —— 节点三态复选框完全覆盖它，且粒度更细。

## 三、实现要点 / 踩坑

1. **`resetIndex` 的判定式**：`statusMatrix` 每行 `[filepath, head, workdir, stage]`，值 = oid 在
   `[undefined, headOid, workdirOid, stageOid]` 的下标。「index 与 HEAD 不一致」= `s > 0 && s !== h`。
   用它筛出「有暂存内容」的路径，避免对没有 index 条目的路径调用 `resetIndex`（会抛）。
2. **测试里缓存 DOM 引用 = 假失败**：`render()` 会重建整棵列表，之前抓到的
   `secTitles[0].nextElementSibling` 会 `isConnected === false`，对它断言全是错的。
   自检/单测里改成**每步现查**（`secCbOf(0)` 这种取函数）。
3. **「可见行数」比逐层查 `display` 可靠**：最外层 `.git-group-body` 自身不设 `display`
   （它靠父级 `.git-sec-body` 隐藏），逐层断言必然漏判 → 改成沿祖先链找 `display:none`。
4. **`fill()` 早返回会导致重渲染后列表空白**：忽略节点已加载过时 `fill()` 若直接 `return`，
   重渲染出来的新 body 就是空的（看起来像「没数据」）→ 改成「已加载就直接 `draw()`」。
5. **新 IPC 要兜底**：`window.myIDE.git.listIgnored` 在旧 preload 下是 `undefined`，**同步抛 TypeError**，
   `.catch()` 接不住（还没返回 Promise）→ 统一走 `gitSafe(fn, ...args)` 包一层 try/catch。
6. **`rm` / `fs.rmSync` 在本环境都走 safe-delete 垫片**：删不存在的文件或批量删除会 `FAIL_CLOSED`，
   于是"清理"看似跑了其实没删，接着就会读到**上一轮的旧报告**（本轮就踩了：报告显示 91 项，
   实际新步骤的截图已经在生成）。清理自检产物请用 `mv` 挪到临时目录，或只删确定存在的单个文件。

## 四、验证

- `npm test`：**45（git-service）+ 221（dom）= 266 项全绿**
  - 新增 git 层用例：勾选集合唯一权威（含「未勾选但已暂存」）、`.gitignore` 增删（落盘/忽略生效/幂等/未命中）、`pushRemote` 指定远程
  - 新增 dom 用例 4 组：工具行图标化 + 节点三态 + 展开收起 + 平铺 + 内嵌预览、右键 gitignore/历史、忽略节点懒加载、草稿 + 历史下拉 + amend 回填
- 真实 Chromium 自检：`electron . --check-ui` → **114 项全绿 / 0 失败**，新增步骤 `commitPanelParity`
  产出 `check-ui-1d-commit-parity.png`（实测细节：工具行 8 图标、3 个分节共 29 个文件、7 个目录行、
  收起全部后可见行 0、平铺 26 个父目录列、忽略节点 26 项、预览 `+5 / -0` · hunk=1、
  历史下拉 4 条、amend 回填真实上次消息、推送下拉 2 项）

## 五、尚未做（重型功能，另行分批）

- **Changelist 变更列表**（新建/移入其他列表/激活列表）
- **hunk 级暂存 / 取消暂存**（需要自建 blob + `updateIndex`，isomorphic-git 无 `add -p`）
- **合并冲突节点 + 解决**（应用本身还没有 merge 能力，先做节点会是无根之木）
- **提交前检查**：reformat / optimize imports / analyze 需要引入格式化器与静态分析器；
  可先做「提交消息非空校验」「TODO 扫描」
- **Sign-off / 作者覆盖**（`commit()` 已预留 `author` 参数）

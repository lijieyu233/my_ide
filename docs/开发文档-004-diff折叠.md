# 开发文档 004 —— Diff 视图可折叠 Hunk

> 状态：已完成 · 对应 ROADMAP P0-4

## 一、需求

大文件 diff 可能有几十个 hunk、上千行，滚动找关键改动费劲。
目标：点击 hunk 分隔行（`@@ -x,y +x,y @@`）折叠/展开该 hunk；**超过 30 行的 hunk 默认折叠**。

## 二、设计

- 每个 hunk 的分隔行变成折叠开关（cursor: pointer，hover 高亮）
- 折叠时显示「（点击展开 N 行）」，展开时为空
- 状态仅本次会话内有效（不持久化——个人工具够用，避免状态污染）
- 实现位置：`git-panel.js renderDiffView`，纯 DOM 操作

## 三、测试计划

1. 渲染 diff 后点击分隔行 → 该 hunk 行隐藏
2. 再点击 → 恢复显示
3. 超 30 行的 hunk 默认折叠

## 四、验收

- [x] npm test 全绿
- [x] 无新依赖
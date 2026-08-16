# 开发文档 037 —— 字号缩放 + Diff Hunk 快捷键

> 状态：已完成 · 体验打磨

## 一、需求

- 编辑字号固定 13px——不同屏幕/视力需要调节：Ctrl+= / Ctrl+- 缩放并持久化
- diff hunk 导航只有按钮——补 Alt+↓ / Alt+↑ 快捷键

## 二、实现

- 字号：CSS 变量 `--editor-font-size`（默认 13px，gutter 同步），Ctrl+= 加 1 / Ctrl+- 减 1（范围 9-24），localStorage 持久化
- hunk 导航：注册 alt+arrowdown/up 快捷键 → 触发现有导航按钮

## 三、验收

- [x] npm test 全绿
- [x] 无新依赖
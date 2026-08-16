# 开发文档 031 —— Diff 内容复制 + 图标写入验证

> 状态：已完成 · 体验打磨 + 构建验证

## 一、需求

- diff 对比时需取某版本完整内容（粘贴到别处/恢复）
- 构建产物图标是否生效需验证手段

## 二、实现

- diff 头部「📋 旧版 / 📋 新版」按钮：复制 r.oldText / r.newText（整页 diff 视图）
- 图标验证方法：`System.Drawing.Icon.ExtractAssociatedIcon` 提取 exe 图标哈希，
  与默认 Electron 对比——哈希不同即自定义图标已写入（实测 ✅）

## 三、验收

- [x] npm test 全绿
- [x] 无新依赖
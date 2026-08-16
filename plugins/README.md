# 插件开发指南

My IDE 的插件机制非常简单：**一个 JS 文件 = 一个插件**。
把 `.js` 文件放进 `plugins/` 目录，重启应用即可生效（后续版本会支持热加载）。

## 渲染器插件

```js
// plugins/xxx.js —— 例如给 .pdf / .docx / .drawio 等格式加渲染
api.registerRenderer(['pdf', 'docx'], ({ path, name, ext, content }) => {
  // 返回一个 HTMLElement 或字符串（字符串会被当作源码内容展示）
  const div = document.createElement('div');
  div.textContent = '这是 ' + name + ' 的自定义渲染';
  return div;
});
```

### 参数说明
- `exts`：要处理的扩展名数组，如 `['md', 'markdown']`，大小写不敏感
- 回调参数：
  - `path`：文件完整路径
  - `name`：文件名
  - `ext`：扩展名（小写）
  - `content`：文件文本内容（二进制文件不会进插件）
- 返回值：
  - `HTMLElement` → 直接展示
  - `字符串` → 作为源码内容进入编辑器（可用于 JSON 美化等）

多个插件注册同一扩展名时，**后加载的优先**（文件按名称排序加载）。

## 内置 API

插件回调里可以直接用这些全局工具：

| API | 说明 |
| --- | --- |
| `MI.registerRenderer(exts, fn)` | 注册渲染器 |
| `MI.toast(msg, type)` | 右下角提示（type: ok / err） |
| `MI.copyText(text)` | 复制文本到剪贴板 |
| `window.myIDE.fs.readFile(path)` | 读取任意文件内容 |
| `window.myIDE.fs.readDir(path, showHidden)` | 列目录 |
| `window.myIDE.clip.copy(text)` | 复制到剪贴板 |

## 示例

`plugins/csv.js` 是一个完整示例：把 `.csv` / `.tsv` 渲染成表格。

## 常见场景
- **图片/PDF 预览**：可以用 `new Image()` + `path` 拼 `file:///` URL，或自定义 iframe
- **UML / drawio**：用 `content` 内容 + 第三方 JS 库渲染成 SVG
- **日志着色**：把 `.log` 按行正则着色，返回 DOM

## 注意
- 插件运行在渲染进程，可以访问 DOM，但不能直接读写文件系统（需走 `window.myIDE.fs.*`）
- 插件报错不会影响主程序，错误会显示为 toast 并在 DevTools 控制台输出
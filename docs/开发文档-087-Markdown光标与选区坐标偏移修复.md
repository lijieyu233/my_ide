# 087：Markdown 光标与选区坐标偏移修复

## 复现与根因

用户截图中选区左边界比正文向右偏约 10px，实时预览中光标也发生相同偏移。

在隐藏 Electron 窗口中加载生产 `styles.css`、CM6 与 `md-editor.js`，将真实
`.cm-cursor` / `.cm-selectionBackground` 矩形与 `view.coordsAtPos()` 的文本坐标比较：

- `scrollbar-gutter: stable both-edges` 在 scroller 左右各预留 10px。
- CM6 `RectangleMarker` 用 scroller 的外边界作为坐标基准；绝对定位的图层原点却在左 gutter 内侧。
- 结果：文本位置不变，光标与选区整层向右移动 10px；只检查颜色、行盒或选区存在性不能发现它。
- 空行仅将 `line-height` 压缩为 `0.85`，字体仍是正文大小。17px 字号下空行高约 14px，
  浏览器返回的光标矩形却高 22px，侵入上下相邻段落。

## 修复

1. scroller 改为 `scrollbar-gutter: stable`，左 padding 从 34px 改成 44px，
   用普通 padding 补齐全局滚动条的 10px 宽度。正文列宽、居中位置保持原值，图层原点与坐标基准重合。
2. 空行改为 `font-size: 0.5em; line-height: 1.7`，维持原来的半行间距，光标随字体缩小后落在空行内部。
3. Live Preview 一致性自检比较扣除滚动条补偿后的基础间距，并检查 scroller 左侧没有 gutter。

## 验证

新增 `npm run check:md-geometry`：临时 userData、隐藏窗口，覆盖 900/560px 宽度、13/17px 字号、
live/source 两模式、滚动与非滚动、标题、折行正文、围栏代码、列表、表格和引用。
逐项检查光标矩形、坐标反查、空行光标边界、单行/跨行选区两端与中段边界。
隐藏窗口仅在测试 CSS 中显示真实光标图层，不改变 CM6 的坐标算法，不需要模拟窗口焦点。

- 修复前：108 通过 / 165 失败。
- 修复后：273 通过 / 0 失败。
- `npm test`：语法检查通过，Git 61 通过 / 0 失败，DOM 279 通过 / 0 失败。
- 真实应用 `--check-live --headless`：167 通过 / 0 失败 / 6 跳过；跳过项由新增坐标测试覆盖。

测试生成 `md-geometry-check-report.txt` 与 `check-md-geometry.png`，取证后清理，不提交产物。

## 全量 UI 对照与验证限制

`--check-ui --headless` 本次结果为 449 通过 / 19 失败，3 项因 headless 跳过。
使用 `git show HEAD:renderer/styles.css` 与 `HEAD:renderer/md-editor.js` 提取修改前版本，
通过独立 Electron 的 file protocol 仅替换这两个运行资源，生产工作区保持修复后的内容。
修改前对照为 444 通过 / 23 失败，3 项跳过；17 个失败断言名称重合。
本次另外两个字号断言起始面板字号为 16px，三次增加受 `app.js` 的 18px 上限截断，
再减三次回到 15px，导致比例与还原断言失败；对照起始 15px 时两项通过。
这些全量 UI 失败没有作为本次光标修复的通过项隐藏，面板/Git/字号等问题仍需另行处理。

改动的 JS/CSS/JSON 已逐项执行本机 `OcularDecrypt.exe`，退出码均为 0，并经过真实 Electron 加载检查。
规范中的 `python -m feature.tsd_guard verify` 无法执行：本机未找到 `feature` 模块，
指定的 Desktop/source_recovered 目录也不存在。本次没有打包或交付新的 EXE，不能声称该最终闸门通过。

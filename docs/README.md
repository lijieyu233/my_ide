# MyIDE 文档 / Documentation

MyIDE is an AI-assisted Markdown and code workspace for Windows. This index links to user-facing guides and the implementation records behind them.

[项目首页](../README.md) · [English overview](../README.en.md) · [问题反馈](https://github.com/lijieyu233/my_ide/issues)

## 从这里开始 / Start here

| 文档 | 内容 |
| --- | --- |
| [快速开始 / Getting started](getting-started.md) | 源码安装、首次打开项目、AI 配置入口与常见问题 |
| [功能与限制 / Features and limitations](features.md) | Markdown、分屏、JSON、Git、浏览器、翻译与阅读器 |
| [AI 工作台接口 / AI workbench tools](ai-api.md) | 工具分类、状态快照、调用示例和接口边界 |
| [开发与发布 / Development and publishing](development.md) | 测试、分支职责、发布条件和截图 |

## 按任务阅读 / Task guides

- **同一文档分屏编辑 / Edit one document in two panes**：[分屏行为与验证](编辑区左右与上下分屏.md)。
- **调整 Markdown 图片 / Work with Markdown images**：[复制图片和拖动尺寸](Markdown图片复制与缩放.md)。
- **浏览大型 JSON / Navigate JSON structure**：[JSON 大纲与分级折叠](JSON大纲与分级折叠.md)。
- **阅读小说与漫画 / Read books and comics**：[格式与限制](小说与漫画阅读器.md)、[书架与最近阅读](书架与最近阅读.md)。
- **保存网页标签组 / Save browser tab groups**：[浏览器标签与标签组实现](AI多标签与标签组操作接口.md)。
- **扩展渲染格式 / Add a format renderer**：[插件开发指南](../plugins/README.md)。

## 接口与开发依据 / Interface references and development records

- [AI 操作接口模块清单](开发文档-171-AI操作接口模块清单.md)：按模块区分已接入与待实现能力。
- [AI 工作台接口实施](开发文档-173-AI工作台操作接口实施.md)：工具执行链路、权限和各批验证。
- [AI 浏览器剩余接口补全](AI浏览器剩余接口补全.md)：网页选区、截图、交互、iframe 等记录。
- [后台源码模块目录整理](开发文档-172-后台源码模块目录整理.md)：后台职责与打包引用。
- [改进进度总览](改进进度总览.md)、[路线图](../ROADMAP.md)、[开发大纲](../开发大纲.md)。
- [GitHub 可发现性维护](discoverability.md)：公开说明、分支和元数据维护检查表。

编号开发文档保留历史需求、设计和验收背景。用户操作优先从本页的指南进入；功能状态以源码和对应验收范围为准。

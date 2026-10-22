# MyIDE 用户文档 / Documentation

MyIDE 是把 AI 助手、本地文档与开发工具连接起来的 Windows 工作台。先了解工作流，再按模块查操作；实现和测试记录放在后面。

[项目介绍](../README.md) · [English overview](../README.en.md) · [下载与启动](getting-started.md)

## 开始工作 / Start working

| 要完成的工作 | 阅读入口 |
| --- | --- |
| 安装应用并打开第一个项目 | [下载、源码运行与首次使用](getting-started.md) |
| 让 AI 结合项目资料协助工作 | [AI 配置、上下文与执行流程](ai-guide.md) |
| 整理文档、查资料、修改并验证结果 | [典型工作流](workflows.md) |
| 评估各模块是否满足需要 | [完整功能与边界](features.md) |

## 核心能力 / Core capabilities

- **AI 与工作台协作**：配置模型或 DSH、引用项目资料、读取状态、操作模块并核对结果。见 [AI 使用指南](ai-guide.md)、[工具接口](ai-api.md)。
- **本地文档与项目管理**：多项目会话、搜索、Markdown/代码/JSON 编辑、多格式预览。见[文档与编辑能力](features.md#documents)。
- **开发与运行工具**：Git、启动面板、远程终端/SFTP、数据库、任务。见[开发工具能力](features.md#development-tools)。
- **资料获取与阅读**：内置浏览器、选区翻译、标签组、书架。见[浏览与阅读](features.md#research)。

## 操作细节 / Detailed operations

这些是模块内的具体操作，可在需要时查阅：

| 所属模块 | 操作说明 |
| --- | --- |
| 文档编辑 | [左右/上下分屏](编辑区左右与上下分屏.md)、[图片复制与尺寸调整](Markdown图片复制与缩放.md) |
| 结构导航 | [JSON 大纲与分级折叠](JSON大纲与分级折叠.md) |
| 网页资料 | [浏览器标签与标签组](AI多标签与标签组操作接口.md) |
| 阅读器 | [支持格式与限制](小说与漫画阅读器.md)、[书架与最近阅读](书架与最近阅读.md) |

## 开发者入口 / For developers

[架构与扩展](architecture.md) · [贡献指南](../CONTRIBUTING.md) · [开发与发布](development.md) · [版本记录](../CHANGELOG.md)

实现依据：[AI 接口模块清单](开发文档-171-AI操作接口模块清单.md)、[AI 接口实施](开发文档-173-AI工作台操作接口实施.md)、[后台目录结构](开发文档-172-后台源码模块目录整理.md)。

历史需求：[改进进度](改进进度总览.md)、[路线图](../ROADMAP.md)、[原始开发大纲](../开发大纲.md)。这些记录可能保留早期版本范围；当前能力以用户指南、源码与版本验收为准。

[公开内容维护与交付状态](discoverability.md)

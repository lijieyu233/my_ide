# MyIDE 架构与扩展 / Architecture

MyIDE 是 Electron 桌面应用：主进程提供操作系统与服务能力，渲染层提供界面和编辑体验，preload 暴露受控 IPC。文件保留在用户目录，工作台围绕项目与会话组织状态。

## 模块地图

| 层 | 主要职责 | 入口 |
| --- | --- | --- |
| 应用与 IPC | 窗口、生命周期、受控系统调用 | [main.js](../main.js)、[preload.js](../preload.js)、[src/main](../src/main) |
| 文档工作台 | 文件树、标签、CM6、Markdown、预览、大纲与会话 | [renderer](../renderer) |
| AI 执行 | 模型服务、DSH、权限、任务归属、工作台工具适配 | [主进程 AI](../src/main/ai)、[DSH](../src/main/dsh)、[工具 schema](../renderer/ai-workbench-tools.js) |
| 开发服务 | Git、程序启动、远程、数据库、搜索、任务 | [后台模块目录](开发文档-172-后台源码模块目录整理.md) |
| 扩展渲染 | 按文件后缀注册格式渲染 | [plugins](../plugins/README.md) |

## 一次 AI 工作台操作

1. 助手读取实际状态，取得项目、会话、文件或控件等标识。
2. 工具校验参数、归属、权限和必要的状态快照。
3. 界面动作进入渲染适配；系统操作经已有 IPC 和后台服务执行。
4. 返回成功、失败、取消、待授权等实际结果；再读取状态核对。

标准助手和 DSH 使用现有工具链。不要把任意脚本执行或直接改磁盘当成编辑器缓冲区操作的替代；未保存内容、磁盘版本和后台任务归属必须继续受到保护。

## 扩展方式

增加格式预览先参考[渲染器插件 API](../plugins/README.md)。增加 AI 工具需同时补 schema、权限与归属校验、实际执行和测试；只声明名称不算接入。具体约束见[模块清单](开发文档-171-AI操作接口模块清单.md)和[实施记录](开发文档-173-AI工作台操作接口实施.md)。

源码协作见 [CONTRIBUTING](../CONTRIBUTING.md) 与 [AGENTS](../AGENTS.md)，发布验收见[开发与发布](development.md)。

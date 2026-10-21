# MyIDE AI 工作台接口 / AI workbench tools

MyIDE exposes application tools to its in-app AI assistant for inspecting and operating the workspace. These are not currently a standalone HTTP API or MCP server. Consult the module checklist for actual integration status.

## 工具分类 / Tool families

| 模块 / Module | 工具或入口 / Tools |
| --- | --- |
| 界面 / UI | workbench_state, ui_state, ui_selection, ui_dialogs, ui_dialog_action |
| 项目 / Projects | project_control |
| 编辑器 / Editor | editor_state, editor_control |
| Markdown 与大纲 / Markdown and outline | markdown_state, markdown_control, outline_change；JSON 大纲工具见模块清单 |
| 翻译 / Translation | translation_state, translation_start, translation_job, translation_config |
| 启动 / Launch | launch_open, launch_list, launch_start, launch_stop, launch_logs；批量与配置见清单 |
| Git 与任务 / Git and tasks | git_state, git_control, tasks_state, tasks_control |
| 数据库 / Database | database_state, database_config, database_connect, database_query, database_job |
| 设置 / Settings | settings_state, settings_control |
| 阅读器 / Reader | reader_state, reader_library, reader_read, reader_control, reader_library_control |
| 网页、远程与会话 / Browser, remote, sessions | 见[完整模块清单](开发文档-171-AI操作接口模块清单.md)与实际 schema |

## 状态 → 操作 → 核对 / Read, act, verify

1. 读取模块真实状态，取得稳定目标标识和 snapshot。
2. 按 schema 携带快照提交操作，写入和执行继续经过原权限检查。
3. 输入、焦点/文档/项目变化、取消或审批失效可能令操作被拒绝；重新读状态，不复用过期授权。
4. 核对实际结果。异步任务 accepted 不等于 completed，外部程序请求受理不等于运行成功。

### 示例：拆分当前文档 / Split the current document

以下是模型工具调用的**参数示意**，不是 HTTP 请求。snapshot 必须替换为实际返回值，还需要应用宿主的会话与授权上下文。

~~~json
{"name":"editor_state","args":{}}
~~~

~~~json
{"name":"editor_control","args":{"operation":"split_horizontal","snapshot":"<snapshot returned by editor_state>"}}
~~~

首次拆分复制同文档视图，两组共享正文、独立切换文件；layout.panes 可以包含相同路径。已有两组时此操作调整方向。

~~~json
{"name":"editor_control","args":{"operation":"focus_group","group":0,"snapshot":"<fresh editor_state snapshot>"}}
~~~

布局和焦点变化后重新读取状态。layout 包含 orientation、活动组 active、各组 path 与 tabs。完整行为见[编辑区分屏](编辑区左右与上下分屏.md)。

## 边界 / Boundaries

- 标准助手与 DSH 复用既有执行链路，DSH 环境和连接需独立配置。
- AI 不能通过通用审批按钮批准自己，不能用旧项目快照操作新项目。
- 最后一份未保存文档关闭、文件覆盖、远程执行和数据库写入仍受原保护；关闭共享文档的一栏只移除该组引用。
- 配置读取应脱敏；不要在示例、日志或 Issues 中放入 API Key、密码、真实私有内容。
- 远程数据库写入取消可能出现提交状态未知，应核对而非自动重试。

## 源码与验收 / Source and verification

- [模块清单](开发文档-171-AI操作接口模块清单.md)：逐项状态与未完成范围。
- [接口实施](开发文档-173-AI工作台操作接口实施.md)：执行链路与分批验证。
- [工作台 schema](../renderer/ai-workbench-tools.js)、[编辑器工具](../renderer/ai-workbench-editor.js)、[主进程适配](../src/main/ai/ai-workbench-tools.js)。
- [AI 浏览器扩展记录](AI浏览器剩余接口补全.md)。

[文档导航](README.md) · [快速开始](getting-started.md)

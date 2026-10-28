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
| 设置 / Settings | settings_keys, settings_values, settings_write（统一键注册表，见下节） |
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

## 统一设置接口 / Unified settings registry

设置不再为每个功能单独开口子：功能通过 `SettingKeys.register()` 声明自己的配置键，AI 只认 key/value。**新增带配置的功能只需 register 一次，工具清单不变。**

| 工具 | 用途 |
| --- | --- |
| `settings_keys` | 列出所有可配置键（可按 module 过滤），含类型、枚举、范围、是否秘密 |
| `settings_values` | 按 keys 读取；`secret` 键只回 `configured` 布尔，永不回明文 |
| `settings_write` | 按 values 批量写入；`open` 打开设置页，`restore` 撤销上次变更 |

~~~json
{"name":"settings_keys","args":{"module":"editor"}}
~~~

~~~json
{"name":"settings_write","args":{"operation":"write","values":{"pasteImage.mode":"cos","pasteImage.cos.bucket":"my-bucket-1250000000","pasteImage.cos.region":"ap-guangzhou"},"snapshot":"<settings_keys snapshot>"}}
~~~

约定：

- 写入前**整体校验**（枚举/正则/范围），坏值一个都不落盘；逐组写入时任一组失败即回滚本次改动。
- 结果以**回读真实值**为准（栏宽会被窗口可用空间夹回），`changed:false` 表示值没变。
- 读取不带 snapshot、不要求审批；写入需要 snapshot 与审批，并经 AI 运行队列串行执行。
- 当前已注册：外观（主题/字号）、布局（栏宽/可见性）、快捷键、粘贴图片与腾讯云 COS 图床（含 SecretId/SecretKey，均按秘密处理）。

**新增功能时**：在 `renderer/ai-workbench-settings.js` 追加一次 `SettingKeys.register({module, group, keys, read, write})` 即可，`renderer/ai-settings-registry.js` 负责校验、脱敏与回滚。

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

# Antigravity 原生连接与验收

## 开始使用

1. 打开本地工程，在右侧 AI 助手的接入方式下拉选择「Antigravity」，在当前会话直接发送。DSH 和 Codex 使用同一个下拉。
2. MyIDE 使用本机 Antigravity CLI 的已有登录态。「设置 → AI 助手」可核对安装和指定官方 `agy` 路径。首次发送后，按原生回执显示可用模型和思考强度。
3. 同一个对话可以发送正文、附件和图片、排队、停止、回答问题及处理原生工具授权。收到终态之前会话保持正在停止。
4. 切换模式、项目或编辑区保留各自的历史与草稿。重新连接不会重发输入。若提交状态待核对，回到原会话加载原生历史，然后可明确放弃那条待确认输入。队列仍暂停，按需继续。

Antigravity 会话、草稿与待发按原工程和会话身份加载。

## Windows 与原生会话

- 已实测官方 Antigravity CLI 1.5.18。Windows CLI 会把 ACP 帮助写到标准错误流，并可能在会话目录里将盘符路径写成 `/C:/…`。MyIDE 识别帮助签名并按实际目录核验会话归属。
- 启动原生 CLI 时按系统对 Google 服务的代理解析结果建立子进程网络环境。显式的 HTTPS 代理优先。切换设置不更改系统代理、浏览器会话、普通助手、Codex 或 DSH。
- Windows 11 23H2 上终端沙箱状态为不可用。原生工具遵循 Antigravity CLI 的权限配置，CLI 发出的授权请求在 MyIDE 原会话中确认。 [官方终端沙箱说明](https://antigravity.google/docs/sandbox/?tab=cli)
- 检测到本机桌面应用时可用「打开 Antigravity」。官方 CLI 对桌面应用提供导入副本。同 ID 的实测中，一个 ACP 进程等待审批时，第二个进程仍可恢复并完成新轮次，因此跨应用交接和外部会话写入保持关闭。 [官方 CLI 会话恢复](https://antigravity.google/docs/cli/commands/resume/)

- 勾选「项目树（MCP）」并保存后，已通过能力协商和版本验证的会话可单次批准 `myide_project_tree`，只返回当前项目根目录的文件与子目录名。MCP 使用官方独立会话 worker 和临时回环服务。审批、请求身份和目录三者一致时执行，停止、结束或重连均撤销访问。开关默认关闭，设置按下一轮生效。
- v1.5.18 可在生成中接受补充，等审批时会拒绝，原轮次结束后同一请求会开启新一轮。实机仅协商 ACP v1，能限定活动轮次的两个候选方法均返回 `-32601`。MyIDE 提供排队并保留待插入的草稿。 [官方 CLI 变更记录](https://antigravity.google/docs/changelog/?tab=cli#v150)
- 归档和重命名保存在 MyIDE。原生分叉和归档命令没有通过 ACP 宣告。当前会话收到原生 `/goal` 宣告时，可在输入框选中该命令并填写目标。

## 验证命令

```powershell
npm run test:antigravity
npm run check:ai-antigravity -- --stress
npm run test:package
npm run check:ai-antigravity-live
npm run check:ai-antigravity-live -- --confirm-live-model
npm run check:ai-antigravity -- --confirm-live-model
npm run check:ai-antigravity -- --confirm-live-mcp
```

前两项使用隔离配置和合成 ACP 进程，无模型调用。CLI 自检默认只握手及查询临时目录，须显式增加 `--confirm-live-model` 才发送真实请求。后三项真实检查使用当前官方认证和临时项目，分别覆盖同原生 ID 加载及续聊、真实 MyIDE 页面与主进程、项目树单次审批，不上传业务项目数据。命令行独立诊断沿用调用进程的网络环境。

## 2026-11-26 实机验收

- 官方 CLI 返回 ACP v1，报告支持目录、加载、恢复及图片。发送真实最小文本，退出子进程后用同一原生 ID 加载完整回复，随后再次重启并恢复原会话，模型准确返回上一轮的标记。中文路径下的原生会话已验证模型和思考强度修改、回执及恢复原值。
- 使用隐藏的真实 MyIDE 窗口、独立 `userData` 和系统代理，通过生产 preload、IPC 和真实 `agy` 收到预期回复。普通 Electron 验收另覆盖正式审批窗口、单次批准、停止、模型选项刷新及模式切换。
- 在受控临时目录验证真实文件写入审批。拒绝后目标文件不存在，允许一次后文件内容与预期匹配。原生工具等待审批时停止，原轮次返回 `cancelled`，写到项目外的临时标记在停止前后均不存在。真实 PNG 附图能被正确识别，纯 PNG 消息收到非空助手回复和 `end_turn`。
- 隐藏窗口 512 个中文正文及思考增量的代表性压力样本中，本轮最终片段到布局约 67 ms，最大心跳间隔约 29 ms。两项均低于 250 ms 门槛。
- 真实 CLI 在隐藏 MyIDE 中经一次授权读取临时项目树，模型返回随机生成的文件名。桥接回归覆盖参数注入、授权缺失、其他会话、停止和重连后的旧请求。
- 官方会话宣告 `/goal`，原生文本目标返回完成标记及 `end_turn`。同一 ID 的双 ACP 写入冲突已实测，对端等待审批时第二客户端仍会执行。

## 现有模式回归

- 普通助手切换、Codex 原生连接主链和 Antigravity 专项通过。Codex 全量 UI 检查一次跑过 101 项后卡在多选恢复归档，基线全量 UI 检查在聊天跳转刻度断言停止。
- 总测试和 AI 测试复现了基线浏览器测试夹具错误。DOM 测试的上下文和编辑器旧用例在基线和接入分支均失败。旧 DSH 的原生停止和大历史压测在两分支均出现超时。
- 语法检查通过，打包资源校验 136 项通过。

## 交付范围

Antigravity 通过日常 MyIDE 的原有 AI 助手下拉使用。发行包仍待构建与绿盾验收。

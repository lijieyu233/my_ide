# Antigravity 原生连接与验收

## 开始使用

1. 在「设置 → AI 助手」勾选「启用 Antigravity 试用」。默认查找系统现有的官方 `agy`，也可以选择绝对路径。检查安装只核对版本和 ACP，连接不构造新会话。
2. 用「打开试用目录」进入独立工作区。右侧 AI 助手的模式改为 Antigravity。首次发送后，按原生回执显示可用模型和思考强度。用户在官方客户端完成认证。
3. 现有项目的会话可连接和浏览。试用目录内可发送正文、附件和图片，运行中可排队。可停止、回答普通问题、打开可信窗口确认单次原生权限。收到终态之前会话仍标记为正在停止。
4. 切换模式、项目或编辑区保留各自的历史与草稿。重新连接不会重发输入。若提交状态待核对，回到原会话加载原生历史，然后可明确放弃那条待确认输入。队列仍暂停，按需继续。

读到旧版配置时，普通助手、DSH 和 Codex 仍使用各自的入口和设置。关闭试用开关后，Antigravity 历史、草稿与待发保存在独立数据目录。

## Windows 与原生会话

- 已实测官方 Antigravity CLI 1.5.18。Windows CLI 会把 ACP 帮助写到标准错误流，并可能在会话目录里将盘符路径写成 `/C:/…`。MyIDE 识别帮助签名并按实际目录核验会话归属。
- 启动原生 CLI 时按系统对 Google 服务的代理解析结果建立子进程网络环境。显式的 HTTPS 代理优先。切换设置不更改系统代理、浏览器会话、普通助手、Codex 或 DSH。
- 当前 Windows 11 23H2 无可用的 Antigravity 终端沙箱。真实 ACP 试用验证了工作区内文件修改的拒绝与单次允许。其它工程只读，等待工作区外文件、终端、网络及全局工具策略通过验证。 [官方终端沙箱说明](https://antigravity.google/docs/sandbox/?tab=cli)
- 官方 CLI 支持从 Antigravity App 导入会话副本。当前 MyIDE 的同 ID 续聊验证覆盖独立 ACP 进程，桌面端的写入仲裁和任务交接单独验证。 [官方 CLI 会话恢复](https://antigravity.google/docs/cli/commands/resume/)

## 验证命令

```powershell
npm run test:antigravity
npm run check:ai-antigravity -- --stress
npm run test:package
npm run check:ai-antigravity-live
npm run check:ai-antigravity-live -- --confirm-live-model
npm run check:ai-antigravity -- --confirm-live-model
```

前两项使用隔离配置和合成 ACP 进程，无模型调用。CLI 自检默认只握手及查询临时目录，须显式增加 `--confirm-live-model` 才发送真实请求。后两项真实检查使用当前官方认证和临时项目，分别覆盖同原生 ID 加载及续聊、真实 MyIDE 页面与主进程，不上传业务项目数据。命令行独立诊断沿用调用进程的网络环境。

2026-11-26 的实机验证已完成：

- 官方 CLI 返回 ACP v1，报告支持目录、加载、恢复及图片。发送真实最小文本，退出子进程后用同一原生 ID 加载完整回复，随后再次重启并恢复原会话，模型准确返回上一轮的标记。
- 使用隐藏的真实 MyIDE 窗口、独立 `userData` 和系统代理，通过生产 preload、IPC 和真实 `agy` 收到预期回复。普通 Electron 验收另覆盖正式审批窗口、单次批准、停止、模型选项刷新及模式切换。
- 在受控临时目录验证真实文件写入审批。拒绝后目标文件不存在，允许一次后文件内容与预期匹配。真实 PNG 附图能被正确识别，纯 PNG 消息收到非空助手回复和 `end_turn`。
- 隐藏窗口 512 个中文正文及思考增量的代表性压力样本中，最终片段到布局约 63 ms，最大心跳间隔约 34.4 ms。基线上的旧 DSH 大历史压力测试在原分支也会超时，单独留下回归记录。

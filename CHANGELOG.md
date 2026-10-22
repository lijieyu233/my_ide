# MyIDE 版本记录 / Release notes

## 0.8.5-preview.1 — Windows 工作台预发布（2026-10-22）

首个公开测试通道，基于现有 0.8.5 开发源码。该版本用于收集实际环境反馈，不标作稳定版。

### 主要能力

- 普通助手与本机 DeepSeek Harness 接入，项目资料引用，以及覆盖主要模块的应用内 AI 工具。
- 多项目文档与代码工作台：Markdown 实时预览、多格式查看、搜索与结构导航。
- Git、程序启动与日志、SSH/SFTP、数据库和任务模块。
- 内置浏览器、翻译、保存的标签组，以及 TXT/基础 EPUB/CBZ 书架。
- MIT 许可、中英文项目说明、用户指南和公开文档入口。

### 使用条件

Windows x64 是本次目标。便携包不是安装器，源码运行和本地构建步骤见[入门指南](docs/getting-started.md)。AI、翻译、远程和数据库功能需要自行配置服务。

### 已知问题与验证

完整 npm test 尚未通过：2026-10-21 本地全量测试在 Git 集成部分为 59 通过 / 3 失败：worker 临时目录 EPERM、blame 行归属和 rebase 冲突预期。后续模块未执行。单项通过不能代表全套通过。当前应用也不提供完整 IDE 调试器/语言服务或独立公共 HTTP/MCP 服务。

最终构建与验收结果、实际下载附件及校验信息以 [GitHub Release](https://github.com/lijieyu233/my_ide/releases)和[发布记录](docs/release-preview.md)为准。

# MyIDE 快速开始 / Getting started

Run the current development version on Windows with Git, Node.js 24, and npm. AI configuration is optional for local editing. See [English overview](../README.en.md).

## 从源码运行

准备 Git、Node.js 24 与 npm：

~~~powershell
git clone --branch dev https://github.com/lijieyu233/my_ide.git
cd my_ide
npm ci
npm start
~~~

当前以 Windows 为主要验证平台。安装依赖需要下载 Electron；仓库包含渲染器运行资源，正常启动无需先运行 Web 前端构建命令。

也可双击根目录 MyIDE.bat。脚本会在缺少 Electron 时安装依赖，并使用脚本指定的下载镜像；需要自主管理来源时使用上面的命令行方式。

## 第一次使用

1. 打开本地项目目录或按 Ctrl+O。项目是目录，单个文档不需要单独变成项目。
2. 从文件树打开文档，Ctrl+P 快速打开，Ctrl+Shift+F 搜索项目内容。
3. Markdown 可在标签栏切换实时预览、源码、预览或源码对照。
4. 点“向右拆分”或“向下拆分”，两栏先显示同一文档；点击目标组后打开另一文件，两组独立切换。
5. Ctrl+S 保存，Git 从提交面板与历史面板进入。

状态栏提供文件编码入口。重新解码需先处理未保存内容；磁盘版本冲突时应用保留输入并提供比较、另存副本等入口。

## 配置 AI 与翻译

在设置的 AI 助手分类中配置模型服务，再在面板选择可用模式和模型。标准助手与 DSH 的配置、运行要求不同；DSH 需要配套运行环境。翻译使用独立厂商、模型和目标语言配置，切换厂商保留各自 Key。

先试只读请求，例如“解释当前选区”或“查看当前 Git 差异”。修改或执行按现有权限设置处理。远程服务会接收相关内容；密钥请在本机设置中配置，不要放进示例项目或问题截图。

[AI 接口指南](ai-api.md)说明工具范围；已有工具不表示外部可以直接连接公共 API。

## 安装包与构建

已发布安装包查看 [GitHub Releases](https://github.com/lijieyu233/my_ide/releases)。当前没有正式 Latest Release，不能将本机 dist/ 路径当作公开下载地址。

~~~powershell
npm run build
~~~

目标为 Windows portable，输出到 dist/。发布前仍需执行[产物检查和发布验收](development.md)，并确认分发条件和许可证。

## 常见问题 / FAQ

**没有配置 AI 能用吗？ / Does editing require AI?**

可以。本地编辑和项目浏览不要求配置模型；AI、翻译等需要相应服务配置和网络。

**源码 ZIP 为什么没有 EXE？ / Where is the executable?**

源码需要安装依赖运行或本地构建。只有 Release 中实际上传的二进制附件才是公开安装包。

**某些 Git 功能不可用？ / Why are some Git actions unavailable?**

检查系统 Git 和面板能力检测；远端认证、网络、冲突和未保存文档也可能阻止操作，应查看实际错误。

**Electron 启动成了 Node 或窗口没出现？**

确认环境没有设置 ELECTRON_RUN_AS_NODE=1。PowerShell 可清除当前会话变量后重试：

~~~powershell
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm start
~~~

**如何报告问题？ / How do I report a problem?**

到 [Issues](https://github.com/lijieyu233/my_ide/issues) 提供系统、版本/提交号、最小复现、预期与实际结果及脱敏日志。开发版可能与历史截图不同。

[文档导航](README.md)

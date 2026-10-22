# GitHub 可发现性维护

目标是让读者、搜索引擎和检索型 AI 准确识别 MyIDE 用途，找到功能证据与运行方法。索引、排名和 AI 引用不由项目控制，不保证本轮修改立即带来结果。

## 本轮交付检查表（2026-10-22）

- [x] 中英文 README 以 AI 协作、本地项目资料和开发工具的完整工作流介绍产品。
- [x] 首页提供隔离项目实机截图、源码启动、开发版状态、功能范围和问题入口。
- [x] 增加文档导航、快速开始、功能说明、AI 工具指南与发布流程。
- [x] 删除首页旧 v0.3.0 功能标题与未经本轮复核的固定内存倍数宣传。
- [x] 区分应用内 AI 工具与公共 HTTP/MCP 服务。
- [x] 更新 About、Topics、主页和默认展示分支，并回读确认。
- [x] 验证新增文档链接、工具示例及图片在默认分支可访问。
- [x] 维护者确定 MIT 许可，LICENSE、npm 元数据与发行包保留声明。
- [ ] Windows x64 预发布包：实际产物验收后上传，明确已知问题，不伪装稳定版。
- [x] 新增 AI 配置、工作流、架构、贡献、安全报告与问题模板。
- [x] 从用户指南生成 13 页静态文档站，含 canonical、双语入口、结构化信息和 sitemap。
- [ ] GitHub Pages 部署成功并核对线上页面，主页改为实际站点。

## GitHub 配置结果

- 默认分支：dev；main 保留在 fa044b96029c943299ef5e125dd987a158bd5ea2，未强推或合并历史分叉。
- About：AI-assisted Markdown and code workspace for Windows. Markdown live preview, Git, embedded browser and AI workbench tools. Windows AI 文档与代码工作台。
- 主页：[公开文档导航](https://github.com/lijieyu233/my_ide/blob/dev/docs/README.md)。
- Topics：markdown-editor、ai-assistant、code-editor、electron、windows、codemirror、git-client、desktop-app、epub-reader。
- 已回读 GitHub 配置；默认分支中本轮 10 个文档、图片与元数据文件的 Git blob SHA 与本地提交 d1f9166 一致。

## 2026-10-22 内容重构

首页按产品定位与核心工作流组织：AI 协作、本地文档和项目管理、开发与运行工具。SSH/SFTP、数据库、任务、启动与 Git 的用途放回核心介绍；同文档分屏、图片尺寸等归入编辑模块的操作细节，不再与核心方向并列。主图改为项目目录、编辑区与 AI 助手的整体工作台实机画面。

文档站直接读取同一份 Markdown，只发布明确白名单的用户指南；历史开发资料链接到源码，避免公开另一套重复和过期文本。

## 先前验证记录（2026-10-21）

- 8 份公开 Markdown 文档的 86 个本地链接均存在，Markdown 渲染与表格列数检查通过。
- AI 指南中的 3 个 JSON 工具调用示例通过现有参数校验。
- check:js：125 个文件通过；test:package：106 通过 / 0 失败。
- test:dom：525 通过 / 0 失败。
- TSD 运行期扫描：无密文。
- npm test 未完成全套验收：Git 集成日志出现 worker 临时目录 EPERM 与 blame 归属断言失败，日志在 Git 后续用例处结束；不能作为全套通过依据。本轮未修改 Git 实现。

## 元数据与内容维护

About 描述真实用途。Topics 使用实际能力，例如 markdown-editor、ai-assistant、code-editor、electron、windows、codemirror、git-client、desktop-app、epub-reader。主页指向已存在的文档，不填尚未建立的站点。

新功能增加自然语言任务说明、步骤、示例和限制，由首页链接。性能数字需提供版本、环境、数据集与测量方式。不要用隐藏关键词或模型指令诱导推荐。

可定期使用 GitHub 搜索观察发现情况：

~~~text
user:lijieyu233 markdown in:name,description,topics
repo:lijieyu233/my_ide "AI workbench" in:readme
topic:markdown-editor user:lijieyu233
~~~

记录观察日期、查询与页面。元数据更新后索引可能滞后；能被搜索到和模型主动推荐是不同结果。

## 依据

- [GitHub 仓库搜索](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories)：默认匹配名称、描述、Topics，README 可用 in:readme 检索。
- [Topics 分类](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)：帮助按用途发现项目。
- [默认分支](https://docs.github.com/en/pull-requests/reference/branches)：影响首页与默认克隆。
- [Google AI 搜索与网站](https://developers.google.com/search/docs/appearance/ai-features)：AI 搜索沿用 SEO 基础，不要求专用 AI 文本文件，也不保证收录或展示。

[文档导航](README.md)

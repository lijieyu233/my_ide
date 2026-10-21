# GitHub 可发现性维护

目标是让读者、搜索引擎和检索型 AI 准确识别 MyIDE 用途，找到功能证据与运行方法。索引、排名和 AI 引用不由项目控制，不保证本轮修改立即带来结果。

## 本轮交付检查表（2026-10-21）

- [x] 中英文 README 使用统一定位：AI-assisted Markdown and code workspace for Windows。
- [x] 首页提供隔离项目实机截图、源码启动、开发版状态、功能范围和问题入口。
- [x] 增加文档导航、快速开始、功能说明、AI 工具指南与发布流程。
- [x] 删除首页旧 v0.3.0 功能标题与未经本轮复核的固定内存倍数宣传。
- [x] 区分应用内 AI 工具与公共 HTTP/MCP 服务。
- [ ] 更新 About、Topics、主页和默认展示分支，并回读确认。
- [ ] 验证新增文档链接、工具示例及图片在默认分支可访问。
- [ ] 正式许可证：等待维护者确定，不自行授予许可。
- [ ] 正式发行版：产物验收后再发布，不上传未经验证的旧安装包。

## 本轮验证记录

- 8 份公开 Markdown 文档的 86 个本地链接均存在，Markdown 渲染与表格列数检查通过。
- AI 指南中的 3 个 JSON 工具调用示例通过现有参数校验。
- check:js：125 个文件通过；test:package：106 通过 / 0 失败。
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

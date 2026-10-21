# MyIDE 开发与发布 / Development and publishing

This page describes the development channel and a repeatable publication checklist. It does not label an unverified development build as a stable release.

## 分支职责 / Branch roles

- dev：日常开发分支，也是本轮设置的 GitHub 默认展示分支。源码指南明确指定它，首页与当前开发保持一致。
- main：保留历史状态及其独有提交，不通过强推覆盖。本轮不自动合并全部历史修改。
- 正式 Release：从明确验收提交打标签，发布实际验证过的 Windows 产物；版本号相同不代表每个开发提交都已发布。

默认展示分支不是稳定性认证。未来建立稳定发布分支后可在验收后调整，需同步 README、入门命令和首页链接。

## 开发与检查

~~~powershell
npm ci
npm start
npm run check:js
npm run test:dom
npm test
~~~

npm test 串行运行多个模块，失败会阻止后续项，应区分单项通过、未执行和全套通过。目前仍有 Git 和通用 UI 的未通过记录，见相关专项文档。

分屏专项：

~~~powershell
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run check:editor-panes
~~~

真实窗口检查默认隐藏并隔离测试项目，不占用户桌面或真实会话。Markdown 与通用 UI 检查按 [AGENTS.md](../AGENTS.md) 执行。

## 公开版本发布清单 / Release checklist

- [ ] 选择提交、版本和变更记录，标明已知问题。
- [ ] 确认许可证与分发条件，不因仓库公开替维护者自行选择许可证。
- [ ] 完成适用测试并保存结果，不把失败描述为通过。
- [ ] npm run build 后核对 Windows portable 产物。
- [ ] 对实际产物执行 check:package、check:packaged 等验收，验证首次启动与关键功能。
- [ ] 为验收提交打标签并创建 Release，上传实际安装包与校验信息。
- [ ] 更新中英文说明、截图、下载链接与 About。

本清单不表示本轮已打包、上传安装包或授予开源许可。

## 文档与截图更新

用户入口是 [README](../README.md)、[English README](../README.en.md) 和[文档导航](README.md)。新能力应写清操作、场景、限制并链接验证记录。

[双视图演示截图](images/editor-split.png)来自隐藏真实应用中的隔离演示项目，本轮使用虚构 README、JSON 和笔记生成；它展示真实布局而非设计稿。check:editor-panes 可生成同类双视图验证截图，需检查后再替换文档资源。不要使用包含真实私有内容、密钥或服务器认证信息的截图。

[可发现性维护](discoverability.md) · [文档导航](README.md)

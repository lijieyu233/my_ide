# Windows 预发布验收记录

版本：0.8.5-preview.1；验收日期：2026-10-22；目标：Windows x64。已公开发布为 prerelease，标签对应提交 72df138；远端附件大小与 SHA256 已回读核对。

## 下载与使用

[预发布版本及附件](https://github.com/lijieyu233/my_ide/releases/tag/v0.8.5-preview.1)。下载 MyIDE-0.8.5-preview.1-win-x64.zip，完整解压，再运行目录中的 MyIDE.exe。不要单独移动 EXE 或在压缩包内运行。无需安装 Node.js；Git 与项目运行时按需安装。

附件为本轮构建后的真实应用，未上传启动验收失败的单文件 NSIS 便携 EXE。ZIP 为 187737493 字节，附 SHA256SUMS.txt。

~~~text
527c4fd24fce2225b065d18ebc46e012e851b68d83ee76bc5a137b30c2d360a9  MyIDE-0.8.5-preview.1-win-x64.zip
~~~

## 验证结果

| 检查 | 结果与实际范围 |
| --- | --- |
| 归档依赖与静态资源 | check:package：191 个运行资源通过，归档 13103 条；包内版本、MIT 许可已核对 |
| 最终 ZIP | CRC 完整性通过，重新解压后启动真正打包的 MyIDE.exe；不是用开发 Electron 代替 |
| 产物真实交互 | check-packaged --no-git：37 项通过，涵盖 CM6 保存、版本冲突、原生路径操作、持久恢复、Git JS 回落与故障保护、SQLite、启动面板、Office 资源和 XLSX 预览 |
| 系统 Git 路径 | 部分状态与文件操作通过，完整专项未通过；不列作完整验收 |
| 渲染层 | test:dom：525 通过 / 0 失败 |
| 语法与文档 | check:js：125 个文件通过；test:docs：6 组通过，覆盖源码链接、站点资源/锚点/元数据、内容范围和工具示例 |
| 透明加密残留 | 提取实际 app.asar 后执行 feature.tsd_guard verify：无密文；不是仅用受信读取判断文件头 |
| npm test | 未通过：Git 集成为 59 通过 / 3 失败，后续串行模块未执行 |

产物测试使用隐藏窗口、独立 profile/home 与虚构数据，不操作用户真实项目。AI、翻译、SSH 和数据库外部服务未在本次产物验收中逐家验证。

## 已知问题

- 全量 Git 测试存在 worker 临时目录 EPERM、blame 行归属和 rebase 冲突预期失败。系统 Git 专项尚未完整通过，操作重要仓库前先核对备份和差异。
- 单文件 NSIS 便携启动器在本机以退出码 2 结束，未通过启动验收，因此只发布通过真实交互检查的解压运行 ZIP。
- 应用未进行发布者签名，Windows 可能提示未知发布者。核对来源与 SHA256，不需要关闭系统安全功能。
- 这是预发布测试版本，不标作稳定版，也不把专项通过描述为所有能力均通过。

## 构建依据

主源码来自 dev；使用 Electron 33.4.11、electron-builder 26.15.3。本机 Electron 下载超时后使用已有官方 Electron 分发目录，PNG 图标转换内存失败后改用已有同源 ICO。生成应用目录后以 ZIP 分发；保留 Electron 与依赖附带的许可文件。

~~~powershell
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node node_modules/electron-builder/cli.js --win portable --config.electronDist=node_modules/electron/dist --config.directories.output=dist/preview --config.win.icon=build/icon.ico
node scripts/check-package.js dist/preview/win-unpacked/resources/app.asar
node scripts/check-packaged.js <解压目录>/MyIDE.exe --no-git --fixture-base .ui-check-trash
~~~

项目代码采用 [MIT](../LICENSE)，第三方依赖和随包资源保留各自许可。

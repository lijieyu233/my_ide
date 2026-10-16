# AI 浏览器剩余接口补全

2026-10-16，对照开发文档171继续补全。只有接入模型工具、权限、主进程和实际页面操作并验证的条目才勾选。

## 第一批：选区、截图与浏览器显示

- browser_selection：活动网页实际选区，最多20000字符，排除密码和隐藏字段；不自动读取未选择的输入框内容。
- browser_capture：当前网页视口或x/y/width/height指定区域，区域使用CSS像素且必须全部提供；最多1600万像素、16MiB PNG。在独立产物目录创建随机命名的新文件，返回路径、尺寸、字节数与SHA256，不接受覆盖目标，不截取IDE或桌面。需要本次确认。
- browser_color_scheme：dark/light/system明确赋值；通过原生网页专用显示服务应用并保存，不改变IDE主题。应用与保存失败分别报告。
- browser_fullscreen：enabled明确赋值，复用原生浏览器全屏服务，状态接口报告实际全屏状态。
- browser_open_external：将实际活动网页地址交给系统默认浏览器，需要本次确认，不传Cookie、不接受含凭据地址，不把交接成功当成外部页面加载成功。

测试：新补全接口4组、原浏览器18组、多标签8组通过；真实模型/权限/IPC检查11组通过（含真实离屏网页视口/区域截图PNG验证）。网页实际选区和显示控制使用真实生产窗口；截图使用隔离profile的离屏网页，不占用用户桌面。

截图只代表当前视口；页面未形成可截取表面或超时会明确失败，不用IDE截图假冒网页截图。

## 第二批：iframe 与开放 Shadow DOM

- browser_frames 返回实际框架ID和地址，最多100个；本地及含凭据框架隐藏地址并标为不支持。
- browser_frame_read 按框架ID读取正文与元素并按快照续读；点击、填写复用 browser_click / browser_fill，批准面板显示框架地址。主页面与子框架快照不能混用。
- 每次执行核对框架实际URL与嵌入层可见性；独立JS world持有元素账本，网页不能伪造账本，模型不能传脚本或选择器。display:none、visibility:hidden、hidden/inert/aria-hidden祖先不读取。
- 主页面及子框架的正文扫描覆盖开放Shadow根，控件沿原快照执行，仍排除密码、隐藏与可编辑内容；节点替换拒绝旧操作。关闭Shadow根未开放，无法访问的隔离框架返回失败，不当作空正文成功。

验证：框架与影子树3组、原网页18组、标签8组与显示接口4组通过；真实生产窗口同源/跨源框架读取、填写、点击、隐藏框架拒绝和Shadow控件操作通过，真实检查累计12组。

## 第三批：网页弹窗、文件上传与下载

- browser_dialogs / browser_dialog：主进程监听实际原生弹窗事件，按真实ID确认或取消。确认时已经关闭/更换的弹窗拒绝旧操作。alert、confirm、beforeunload支持；Electron原生prompt输入框不支持，状态接口明确返回不支持，HTML对话框仍通过正文、点击、填写操作。
- browser_upload：按网页元素快照和项目内相对路径选择普通文件，最多16MiB。逐次确认展示目标网页、相对路径、大小、SHA256；确认期间文件或目标变化拒绝。
- 上传文件由受信进程读取明文字节并创建浏览器File，不通过磁盘临时副本，避免绿盾再次加密，也不把源绝对路径交给网页。项目外链接、目录、密文、超预算文件均拒绝；支持主页面、可见iframe和开放Shadow控件。
- 返回selected只表示文件已选择；网页change事件可能立即自动上传，不自动点击提交。网站上传进度、服务器接收和业务成功由browser_read读取网页实际状态核对，不能伪造统一百分比。真实验证页会把选中文件发送到回环HTTP服务，再读取“服务器收到”及真实正文确认。
- browser_download：复用实际浏览器登录态，按用户明确URL发起，始终单次确认；随机独立目录保留原文件名，不接受覆盖路径，不打开下载文件。
- browser_downloads：按原项目隔离任务，返回waiting/progressing/paused/interrupted/verifying/completed/cancelled/failed以及已收到/总字节；只有completed才返回本机路径和SHA256，先核对落盘大小再计算摘要。最多128MiB、同时8个在途任务、等待开始15秒、传输5分钟；失败保留原因，不自动重发。
- browser_download_control：仅按已观察的真实任务ID暂停、恢复、取消；未开始或已结束明确拒绝，服务器不支持恢复时不假报成功。任务受理后独立运行，切换页面不混入其他项目，需取消时明确操作该任务。

原生prompt和关闭Shadow根属于运行时明确边界，不能因“已实现浏览器自动化”便宣称任意网页均支持。

协议依据：[Electron DownloadItem](https://www.electronjs.org/docs/latest/api/download-item)、[Chrome DevTools Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/)、[File](https://developer.mozilla.org/en-US/docs/Web/API/File/File)与[DataTransfer](https://developer.mozilla.org/en-US/docs/Web/API/DataTransfer/DataTransfer)。

## 本次最终验证

- 模型工具定义、契约与执行共用：浏览器接口从23个增加到36个，普通助手与DSH使用同一套定义和授权链路。
- `check:js`：117个运行文件通过；脚本单独 `node --check` 通过。
- `test:ai` 全套通过；原浏览器18组、标签8组、显示/截图4组、框架3组；弹窗与传输在最终离页拦截/迟到下载补充后7组通过。
- `test:dom`：525通过 / 0失败。
- 隐藏生产窗口与真实IPC检查：15组通过，覆盖alert/confirm/离页确认与取消、同源/跨源框架、Shadow控件、实际HTTP下载和PNG截图；上传测试由真实网页向本地HTTP服务发送选中的文件，核对服务器回显，并验证审批期间换文件会拒绝。已检查上传确认视图截图。
- `npm test` 后台运行，在未修改的Git测试失败：worker调度清理EPERM、cherry-pick脏文件、提交事务索引内容（59通过 / 3失败）；不能宣称全量测试全绿。
- 标准 `--check-ui`：454通过 / 11失败 / 3隐藏窗口跳过。失败项涉及Git差异/历史/分块、Git引用、Markdown标题明度和Mermaid背景；已检查本批独立上传确认截图，未混改这些模块。
- 绿盾最终使用实际 `feature.tsd_guard verify` 扫描renderer、src与主进程等运行文件：无密文。

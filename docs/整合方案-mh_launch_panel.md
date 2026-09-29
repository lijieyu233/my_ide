# 整合方案：把 mh_launch_panel 并入 my_ide

> 目标：把「终端启动面板」（`D:\document\code\tools\mh_launch_panel`）的能力做成 my_ide 的**一个原生工具面板**，
> 不再单独开一个 Electron 窗口。风格、主题、快捷键、配置位置全部与 my_ide 一致。
> 本文只做方案，**未改动任何代码**。

## 一、结论先行

**推荐方案 A：原生工具面板（`launch`）** —— 主进程加一个进程管理服务，渲染层加一个侧栏面板，
配置放 `~/.myide/launch.json`，首次启动可一键导入现有的 `panel-config.json`。

备选方案（若你只想省事）：**C 独立窗口** —— my_ide 里加个入口直接 `spawn` 起 mh_launch_panel，
改动量约 20 行，但两个窗口、两套主题样式、进程也不归 my_ide 管。我不推荐，除非只要"能打开"。

## 二、两边现状对比

| | mh_launch_panel（现状） | my_ide（承接方） |
|---|---|---|
| 形态 | 独立 Electron 应用（main.cjs + panel.html/js/css） | Electron 三层：`renderer/*` → `preload.js` → `main.js` → service |
| 文件规模 | 约 5 个文件 / 45KB（main 13.9K、panel.js 20K、css 10.5K） | 26+ 渲染模块，已有 7 个工具面板 |
| 面板体系 | 单页面（header + 卡片列表 + footer） | `#sidebar` 内 `panel-*`（project/outline/git/tasks/db/browser/log），`ALL_TOOLS` 注册 |
| IPC | `preload.cjs` 手写 10 个通道（config/entry/port/url/origin） | `preload.js` 已暴露 125 个 invoke，分组规范；git 侧有独立的 `git-ops.js` 通道清单 |
| 进程能力 | `spawn cmd /c`、`taskkill /T /F`、日志 Map 缓冲、端口探测 | 只有一次性 spawn（`run:code`、新 cmd 窗口），**没有持久进程管理/日志/停止** |
| 配置 | `panel-config.json`（与代码同目录） | 项目级走 `<项目>/.myide/*.json`，应用级走 `~/.myide/*.json` |
| 特有资产 | `phone_usb_bridge.py`（adb reverse + caddy 让手机走 USB 访问内网） | 无；但有成熟的面板/浮层/主题变量体系 |

**一句话**：mh_launch_panel 的**业务逻辑**（进程管理）正是 my_ide 缺的那一块，而 my_ide 缺的只是把它
接进自己的面板与 IPC 体系；两边没有架构冲突，属于纯增量。

## 三、目标与边界

**做**：
- 条目（终端/脚本）的启动、停止、重启、日志、端口状态、打开 URL
- 全部启动 / 全部停止；按分类分组折叠
- 条目的增删改（含"打开页面 / 后端地址 / 环境变量注入"）
- 后端地址（apiOrigin）管理 —— 复用 mh 的 `MH_API_ORIGIN` / `MH_API` 注入逻辑
- USB 隧道条目（kind=usb-tunnel）→ 调 `phone_usb_bridge.py`
- 关闭 my_ide 时按策略停止子进程

**不做**（本期）：
- 不把 mh 的 UI 原样搬过来（它的 `panel.css` 硬编码配色，与 my_ide 主题体系不兼容）—— 面板按 my_ide 风格重写
- 不改动 mh_launch_panel 原项目（保留可独立运行，作为回退）
- 不做远程/多机管理（当前都是本机）

## 四、架构设计

```
renderer/launch-panel.js   （侧栏面板：卡片列表 / 分组 / 状态轮询 / 日志入口）
        │  window.myIDE.launch.*
preload.js                 （新增 launch 分组：10~12 个 invoke）
        │
main.js                    （按 launch-ops.js 清单逐个注册 ipcMain.handle）
        │
launch-service.js          （★ 新增：进程表 / spawn / taskkill / 日志环形缓冲 / 端口探测 / 隧道 / 配置读写）
launch-ops.js              （★ 新增：通道清单 —— 照 git-ops.js 的模式，避免漏注册）
```

配置：`~/.myide/launch.json`
- 与 `git-native.json` 同级（应用级、不随项目走）—— 因为这些终端路径**是机器相关的**
- 首启时若文件不存在 → 提示"是否导入 mh_launch_panel 的 panel-config.json"（路径可填）

### 数据模型（与 panel-config.json 一一对应，字段原样保留）

| 字段 | 含义 | 备注 |
|---|---|---|
| `id` | 唯一标识 | 进程表 key |
| `name` / `category` | 名称 / 分组 | 分组用于折叠 |
| `cwd` | 工作目录 | 脚本型可空 |
| `command` | 启动命令 | `npm run dev` / `docker desktop stop && ...` |
| `port` | 端口（0 = 脚本型，按进程存活显示） | 决定状态判定方式 |
| `apiOrigin` | 后端地址 → 注入 `MH_API_ORIGIN`/`MH_API` | 空 = 用全局 `apiOrigins[0]` |
| `openUrl` | 启动后打开的页面 | 走 my_ide 已有的 browser/URL 打开能力 |
| `kind` | `""` \| `usb-tunnel` 等特殊类型 | 特殊类型走专用 start/stop 分支 |

## 五、分阶段任务

| 阶段 | 内容 | 产出 / 验收 |
|---|---|---|
| **P1 骨架** | `launch-ops.js` + `main.js` 注册 + `preload.js` 暴露 + `panel-launch` 容器 + `ALL_TOOLS` 加入 `launch` + `launch-service.js` 只做配置读写 | 面板能打开、能按分组渲染现有条目（先只读） |
| **P2 进程** | start / stop / restart / alive（端口探测 + 进程存活）/ 日志环形缓冲 / getLogs | 单条启动停止可用；状态 1.5s 轮询；日志可取 |
| **P3 UI** | 卡片（启动/停止/日志/打开/编辑/删除）、全部启停、分组折叠、toast、添加/编辑对话框 | 功能与 mh 面板等价；样式走 my_ide 主题变量 |
| **P4 高级** | apiOrigin 增删改、`MH_API_*` 注入、usb-tunnel（调 python 桥）、配置导入、退出清理策略 | 隧道条目可用；关 my_ide 不留孤儿进程 |
| **P5 收尾** | 快捷键、自检断言（照 `scripts/check-md-editor.js` 的样子写 `check:launch`）、文档 | `npm run check:launch` 全绿 |

## 六、文件清单

**新增**：
- `launch-service.js`（主进程服务：进程表 + 日志 + 端口 + 隧道 + 配置）
- `launch-ops.js`（通道清单）
- `renderer/launch-panel.js`（面板逻辑）
- `scripts/check-launch.js`（自检）

**修改**：
- `main.js`：注册 launch 通道、退出时 `cleanupLaunch()`
- `preload.js`：新增 `launch` 分组
- `renderer/index.html`：新增 `<div id="panel-launch" class="hidden">`（放 `#sidebar` 内，与 git/tasks 同级）
- `renderer/app.js`：`ALL_TOOLS` 增加 `'launch'`（按 SIDE_TOOLS 或独立区，见决策点 2）
- `renderer/styles.css`：面板样式（走 CSS 变量，含暗/亮/pink/crimson 四主题）
- `package.json`：加 `check:launch`

## 七、关键实现要点（踩过的坑，先写下来）

1. **通道清单必须导出全**：`launch-service.js` 里新增的函数**漏了导出不会报错**，只在该通道第一次被调用时抛
   `xxx is not a function`（`git-native.runRetry` 就这么藏了很久）。自查：
   `node -e "console.log(Object.keys(require('./launch-service')))"`。
2. **进程组必须整树杀**：Windows 上 `npm run dev` 会派生子进程 → 停止要用
   `taskkill /T /F /PID`（mh 已这么做，照抄），否则留孤儿占端口。
3. **日志要环形缓冲**：长跑的 dev server 输出无限增长 → 每条目上限（建议 800 行）+ 尾部截断。
4. **退出清理 + cleanup 策略**：my_ide 退出时默认停所有子进程（与 mh 行为一致），但要给一个
   "保留后台运行"的开关（detached 启动），否则调试时很烦。
5. **样式一律走 CSS 变量**：`--bg-panel` / `--text` / `--accent` …，不能硬编码（mh 的 `panel.css` 就是硬编码，不能直接复用）。
6. **绿盾**：写 `launch.json` / 新源码文件用 Python/Node 明文写；改 `styles.css` 用 Python（路径曾因加密导致整界面崩）。
7. **USB 隧道**：`phone_usb_bridge.py` 依赖 `桌面\adb.exe` / `caddy.exe` / `Caddyfile.usb` 绝对路径 → 并进来后这些路径要**可配置**（写进 launch.json 的该条目里），不要写死在代码里。
8. **端口探测**：复用 Node `net` 建连（mh 的 `checkPort` 逻辑可直接搬）。

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| 面板挤（侧栏 340px 放卡片 + 日志） | 日志走主区只读视图或浮层（现有 diff 视图/浮层机制可复用），卡片只放状态与动作 |
| 误杀进程（taskkill /T /F） | 停止前确认 + 状态显示真实 PID；退出清理按条目勾选的"后台保留"跳过 |
| 命令注入面板（任意 command） | 本地面板不做权限闸（与 mh 一致），但配置里标记来源；后续若要接 AI 调用则必须过权限四闸 |
| Python 桥依赖外部环境（adb/caddy） | 路径可配置 + 缺失时给出明确提示（不是静默失败） |
| 与 my_ide 既有 spawn 能力重复 | 统一：新增的持久进程走 `launch-service`，一次性命令仍走 `run:code`，不合并 |

## 九、需要你拍板（3 个）

1. **面板位置**：侧栏（与 git/tasks 并列，可拖宽到 480）还是主区（宽，像 diff 视图那样）？
   → 我倾向**侧栏**（随时看状态）+ 日志走主区浮层。
2. **后台保留**：关 my_ide 时，默认"全部停止"还是"保留后台继续跑"？
   → 我倾向**默认停止**（与 mh 现行为一致），条目上给"后台保留"勾选。
3. **配置归属**：放 `~/.myide/launch.json`（机器级、不进 git）还是 `<项目>/.myide/launch.json`（随项目）？
   → 我倾向**机器级**（路径都是本机绝对路径），并提供导入/导出。

## 十、验证方式（照 md 自检的规格）

新增 `scripts/check-launch.js` + `npm run check:launch`，真实窗口断言：
配置加载与渲染 · 启动/停止/状态翻转 · 日志可取且非空 · 端口探测 · 全部启停 · 添加/删除条目 ·
退出不残留孤儿进程（启动后关闭再扫端口）。**首版目标 10 项全绿**。

（参考：本轮 md 编辑器自检 `npm run check:md` 已做到 15 项全过，同一套套路直接复用。）

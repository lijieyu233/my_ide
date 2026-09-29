# AGENTS.md —— my_ide 协作约定

> 给所有在这个仓库里干活的 AI 代理（DSH / IDE 内置 AI 面板）看的。人写的规则在前，事实在后。

## 一、每次改动都要提交并推送（硬性）

改完必须 `git commit` **并且** `git push`，**不推 = 没做完**。别攒着等下次。

- 分支 `dev`，远端 `origin` = https://github.com/lijieyu233/my_ide.git，upstream 已设好，直接 `git push` 即可。
- commit message 沿用现有历史风格：`type(scope): 中文描述`。
  - type：`feat` / `fix` / `perf` / `chore` / `docs`
  - scope：模块名，如 `browser` / `launch` / `git` / `db` / `ai` / `tasks` / `md`
  - 例：`fix(browser): 术语统一为「收藏」—— 删掉「书签」小标题行`
- 一个逻辑改动一个 commit，**不要把无关的脏文件顺手混进来**；工作区里别人的未完成改动先问，别替他决定。
- 推完核对一眼：`git ls-remote --heads origin dev` 应与本地 `HEAD` 一致。

## 二、每次改完的收尾动作（用户点名要求，别省）

1. **测试丢后台跑**：`npm test` 要几十秒，前台白等。用后台任务跑，先干别的（写提交信息 / 收拾现场），
   跑完再核对结果；`npm run test:dom` 基线是 **269 通过 / 0 失败**，数字不对就是真出事了。
2. **改完重启 MyIDE**：用户是开着 app 看效果的，代码改完不重启他看不到。做法：
   - 找主进程：`Get-CimInstance Win32_Process -Filter "Name LIKE '%electron%'"`，
     取 `CommandLine` 里带 `my_ide` 的**那个不带 `--type=` 的进程**（PID 每次不同）。
   - ⚠ 别误杀：DSH 自己也是 Electron（`D:\programfie\deepseek\resources\app.asar`），
     机器上还有别的 Electron 应用；只杀掉命令行里含本仓库路径的那个主进程。
   - 重启参数照原样：`node_modules\electron\dist\electron.exe --disable-gpu --no-sandbox <仓库绝对路径>`，
     用 `Start-Process` 拉起（别用会随 shell 一起退出的前台方式）。
3. **临时脚本 / 截图用完就删**：验证用的脚本别留在工作区，否则会被「每次改动都要提交」的规矩带进版本库。
   - 仓库根的检查产物（`check-ui-*.png`、`*-check-report.txt`、`*.log`、`.ui-check-*`）全是 gitignore 的，
     可以随手清；根目录**只剩 20 来个文件**才是正常状态。
   - `.ui-check-trash/` 是 main.js / `scripts/ui-fixtures.js` 主动往里挪产物的同盘暂存区，**目录本身别删**
     （代码里有 `mkdirSync` 兜底，但它是"清产物"设计的落点）。里面的东西可以清，
     **但被 docs 引用的取证脚本要留**：先 `git grep -h -o -E '\.ui-check-trash/[A-Za-z0-9_.-]+' -- .`
     查出引用（注意文档里常省略前缀，同段出现的兄弟文件名也要一起看），再删其余。
     实测这个目录能攒到 5682 个文件 / 180 MB。

## 三、这台机器上的坑（Electron / 编码）

- **别用 PowerShell 的 `Set-Content` / `-replace` 改带中文的源码**：这台机器上 PS 的编码链路会把 UTF-8
  写成坏字节 —— 实测一次 `Get-Content -Raw` → `.Replace()` → `Set-Content` 就把 `renderer/browser.js`
  写坏了 179 个字符（解码后全是 U+FFFD），还混进了 CRLF。**改文件用编辑工具或 Node/Python 脚本**，
  改完 `git diff` 复核；真写坏了别硬修，直接 `git checkout -- <file>` 重来。
- **先清 `ELECTRON_RUN_AS_NODE`**：DSH harness 会把它设成 `1`，此时 `electron.exe` 退化成纯 Node ——
  症状是 `require('electron')` 返回一个路径字符串、`app.setPath(...)` 报
  `Cannot read properties of undefined (reading 'setPath')`。
  `npm test` 不受影响；但凡 `npm run check:launch` / `check:md` / `--check-ui` / 自己写的 electron 脚本，
  都要先在同一个 shell 里 `Remove-Item env:ELECTRON_RUN_AS_NODE`。
- 自己写一次性验证脚本时先 `app.setPath('userData', <临时目录>)`：别把用户真实的
  `%APPDATA%\my-ide`（收藏 / 会话 / 主题）写脏。脚本可以丢在 `.ui-check-trash/`（已 gitignore），
  但收盘前清掉。

## 四、这台机器上推送的坑（改完推不上去时先看这里）

1. **代理只覆盖 HTTPS**：`http.https://github.com/.proxy = http://127.0.0.1:10808`。
   SSH 那条路走不通（`~/.ssh/config` 里配的 `ssh.github.com:443` 实测 connection refused），别浪费时间试。
2. **GitHub 凭据来自 gh CLI**：`~/.gitconfig` 里
   `credential.https://github.com.helper = !D:/software/gh-cli/bin/gh.exe auth git-credential`。
3. **用户名不一致会让凭据被静默丢弃**：全局 `credential.username = lijieyu`，而 gh 登录账号是 `lijieyu233`。
   git 的 `credential_match` 发现对不上就丢掉 gh 返回的 token，回退去弹终端密码框 —— 无 TTY 环境下直接
   `fatal: could not read Password`（报错只提用户名，看不出真正原因）。
   本仓库 `.git/config` 里有 `credential.https://github.com.username = lijieyu233` 兜底。
   **这行不进版本库**，换机器/换账号要重设；排查手法：`git -c credential.helper= -c "credential.helper=!<gh路径> auth git-credential" credential fill`。
4. GCM（Git Credential Manager）也在 helper 列表里但没有存 github 凭据，它只会弹一个开不了 `/dev/tty` 的框。

## 五、测试

| 命令 | 内容 |
|---|---|
| `npm test` | `check:js`（语法）+ `test:git` + `test:dom` |
| `npm run check:js` | 纯语法检查，27 个文件，秒级 |
| `npm run test:dom` | jsdom 全套交互断言（当前基线 **269 通过 / 0 失败**） |
| `npm run check:md` / `npm run check:launch` | 真 Electron 窗口里的脚本化走查 |
| `node_modules\electron\dist\electron.exe . --check-ui` | UI 细节自检：真实窗口 + 真实 IPC + 每阶段截图 `check-ui-*.png`，步骤在 `scripts/check-ui-steps.js` |
| `node_modules\electron\dist\electron.exe . --check-live` | Live Preview 自检：打开 `preview-test.md` 逐项断言 + `check-live.png` + `check-live-out.txt`，含 live↔preview **一致性**断言组（脚本 `scripts/check-live-page.js`）。当前基线 **101 通过 / 0 失败 / 6 跳过** |

**所有自检默认 headless（`show:false` + `skipTaskbar`）** —— 一跑就在用户桌面上弹窗抢焦点是绝对禁忌
（用户原话：「你把桌面占据了我怎么用」）。要肉眼看着它跑才加 `-show` 后缀（`--check-ui-show` / `--check-live-show`）；
自己写的一次性取证脚本记得带 `--headless`。headless 的两个坑见
`docs/开发文档-083-Markdown实时预览与预览对齐.md` §4：隐藏窗口会被系统按工作区压矮（自检里显式
`setContentSize` 复位），且拿不到 DOM 焦点（CM6 不绘制选区层/光标层 → 这类断言记 SKIP，别记 FAIL）。

改了渲染层至少跑 `check:js` + `test:dom`；改 UI 细节再跑 `--check-ui` 并**看截图**，别只看断言。

**Markdown 排版铁律**（详见文档 083）：live 的 `liveTheme` 里**只准写 em**（绝对值只留给 1px 级细节），
字号/间距/列宽/内边距必须与 `.md-view` 同源；改了任一边，`--check-live` 的一致性断言组会拦住你。

## 六、UI 文案约定

- **一个功能只能有一个名字**。历史教训：内置浏览器侧栏同时出现了「收藏 / 书签 / 收藏夹」三个词
  （`renderer/index.html` 里已注释说明）。新加文案前先 grep 一遍现有叫法，不一致就统一，别叠加。
- **图标分两套，别用错**：列表 / 工具条 / 面板标题上的图标一律内联 SVG（`<svg class="ic" viewBox="0 0 16 16">`，
  1.4px 线性描边，见 `styles.css` 的 `svg.ic`）。理由和文件树当初 emoji→SVG 的迁移一样：emoji 的字号与
  基线不受控，混在一排线性图标里又大又花。**右键菜单文案**倒是惯例带 emoji 前缀（`✨ 新建文件`/`📋 复制文件`），
  别去"顺手统一"。
- 注释写**为什么**（尤其是"实测结论 / 踩过的坑"），不写"做了什么"—— 照现有 `browser.js` / `launch-service.js`
  里那种带原因和实测数据的注释风格来。

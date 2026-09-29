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

## 二、这台机器上推送的坑（改完推不上去时先看这里）

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

## 三、测试

| 命令 | 内容 |
|---|---|
| `npm test` | `check:js`（语法）+ `test:git` + `test:dom` |
| `npm run check:js` | 纯语法检查，27 个文件，秒级 |
| `npm run test:dom` | jsdom 全套交互断言（当前基线 **267 通过 / 0 失败**） |
| `npm run check:md` / `npm run check:launch` | 真 Electron 窗口里的脚本化走查 |
| `node_modules\electron\dist\electron.exe . --check-ui` | UI 细节自检：真实窗口 + 真实 IPC + 每阶段截图 `check-ui-*.png`，步骤在 `scripts/check-ui-steps.js` |

改了渲染层至少跑 `check:js` + `test:dom`；改 UI 细节再跑 `--check-ui` 并**看截图**，别只看断言。

## 四、UI 文案约定

- **一个功能只能有一个名字**。历史教训：内置浏览器侧栏同时出现了「收藏 / 书签 / 收藏夹」三个词
  （`renderer/index.html` 里已注释说明）。新加文案前先 grep 一遍现有叫法，不一致就统一，别叠加。
- 注释写**为什么**（尤其是"实测结论 / 踩过的坑"），不写"做了什么"—— 照现有 `browser.js` / `launch-service.js`
  里那种带原因和实测数据的注释风格来。

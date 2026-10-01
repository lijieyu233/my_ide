// git-ops.js —— Git IPC 的**唯一清单**（M2 的「IPC Registry」）
//
// 为什么要有这份表：以前新增一个 Git 能力要手抄四处 ——
//   ① `git-service.js` 导出  ② `main.js` 的 `ipcMain.handle('git:xxx')`
//   ③ `preload.js` 的 `window.myIDE.git.xxx`  ④ `tests/dom.test.js` 的 mock
// 38 个通道已经够呛，70 个就是灾难。现在 ①② 由这张表生成（main.js 按表注册），
// ③④ 仍是显式写的 —— ⚠ 因为 BrowserWindow 是 `sandbox: true`，**preload 不能 require 本地模块**，
// 没法自动生成；但自检会拿这张表和 `window.myIDE.git` 的实际键做**漂移检查**
// （`gitBackend` 步骤：少加一处会在 `--check-ui` 里直接报出来，而不是等用户点不动按钮）。
//
// ⚠ 安全约定：**没有 `git.exec(任意字符串)` 这种口子**。上层只能调用这里列出的明确能力，
//   原生后端内部虽然 spawn 任意必要命令，但入口是白名单操作（如将来的 `branch.merge` / `stash.create`）。
//
// 字段：
//   ch    —— IPC 通道名（渲染层 `window.myIDE.git.<ch>`）
//   op    —— git-service.js 里的函数名（经 git worker 执行）
//   native—— 走原生后端 git-native.js 的函数名（不经过 worker）
//   ⚠ 两个字段**同时出现** = 原生优先、没装本机 git 时回落 `op`（目前只有 checkout —— 因为
//     isomorphic-git 不认 core.autocrlf，会把 CRLF 工作区误判成"有本地改动"）
module.exports = [
  { ch: 'init', op: 'initRepo' },
  { ch: 'status', op: 'status' },
  { ch: 'log', op: 'log' },
  { ch: 'logGraph', op: 'logGraph' },
  { ch: 'commit', writes: true, op: 'commit' },
  { ch: 'diffWorkdir', op: 'diffWorkdir' },
  // M3：双区差异（index↔工作区 / HEAD↔index）+ hunk 级暂存
  { ch: 'diffUnstaged', op: 'diffUnstaged' },
  { ch: 'diffStaged', op: 'diffStaged' },
  { ch: 'stageHunk', writes: true, op: 'stageHunk' },
  { ch: 'unstageHunk', writes: true, op: 'unstageHunk' },
  { ch: 'revertHunk', writes: true, op: 'revertHunk' },
  { ch: 'diffCommit', op: 'diffCommit' },
  { ch: 'compareRefs', op: 'compareRefs' },
  { ch: 'diffRefs', op: 'diffRefs' },
  { ch: 'commitFiles', op: 'commitFiles' },
  { ch: 'branches', op: 'branches' },
  // ⚠ 双实现通道：**原生优先**，没装本机 git 时回落 `op`（唯一同时写两个字段的通道）。
  //   为什么 checkout 必须优先原生：isomorphic-git 不实现 core.autocrlf 归一化 → autocrlf 仓库里
  //   工作区的 CRLF 文件被算成"已修改" → 切分支抛 CheckoutConflictError 报一堆没动过的文件
  //   （2026-09-28 实测，本仓 dev↔main 必挂）。原生归一化后比对，只在真有改动时拒绝。
  { ch: 'checkout', writes: true, op: 'checkout', native: 'checkout' },
  { ch: 'createBranch', writes: true, op: 'createBranch' },
  // M4：分支工作流 —— merge / rebase / 操作状态机 / 冲突解决。
  // 全部走**原生后端**（isomorphic-git 没有 merge/rebase），无本机 git 时由 caps 隐藏入口。
  { ch: 'opState', native: 'opState' },
  { ch: 'merge', writes: true, native: 'merge' },
  { ch: 'rebase', writes: true, native: 'rebase' },
  { ch: 'conflicts', native: 'conflicts' },
  { ch: 'conflictSides', native: 'conflictSides' },
  { ch: 'resolveFile', writes: true, native: 'resolveFile' },
  { ch: 'continueOp', writes: true, native: 'continueOp' },
  { ch: 'skipOp', writes: true, native: 'skipOp' },
  { ch: 'abortOp', writes: true, native: 'abortOp' },
  // M4-C：分支操作（isomorphic-git 的 branch 只能从 HEAD 建、不能删/改名 → 走原生）
  { ch: 'branchCreate', writes: true, native: 'branchCreate' },
  { ch: 'branchRename', writes: true, native: 'branchRename' },
  { ch: 'branchDelete', writes: true, native: 'branchDelete' },
  // M4 收尾：可编辑合并结果 / 安全强推 / upstream
  { ch: 'resolveCustom', writes: true, native: 'resolveCustom' },
  { ch: 'readWorktreeText', native: 'readWorktreeText' },
  { ch: 'pushForceWithLease', native: 'pushForceWithLease' },
  { ch: 'setUpstream', native: 'setUpstream' },
  { ch: 'unsetUpstream', native: 'unsetUpstream' },
  // M5：提交前检查（同一套执行器跑用户命令与 pre-commit 钩子）+ TODO 扫描
  { ch: 'precommitRun', native: 'precommitRun' },
  { ch: 'scanTodo', native: 'scanTodo' },
  { ch: 'discard', writes: true, op: 'discard' },
  { ch: 'discardFiles', writes: true, op: 'discardFiles' },
  { ch: 'getUserConfig', op: 'getUserConfig' },
  { ch: 'setUserConfig', op: 'setUserConfig' },
  { ch: 'listRemotes', op: 'listRemotes' },
  { ch: 'addRemote', op: 'addRemote' },
  { ch: 'removeRemote', op: 'removeRemote' },
  { ch: 'fetch', op: 'fetchRemote' },
  { ch: 'pull', writes: true, op: 'pullRemote' },
  { ch: 'push', op: 'pushRemote' },
  { ch: 'listPushCommits', op: 'listPushCommits' },
  { ch: 'shelveCreate', writes: true, op: 'shelveCreate' },
  { ch: 'shelveList', op: 'shelveList' },
  { ch: 'shelveApply', writes: true, op: 'shelveApply' },
  { ch: 'shelveDelete', op: 'shelveDelete' },
  { ch: 'aheadBehind', op: 'aheadBehind' },
  { ch: 'listTags', op: 'listTags' },
  { ch: 'createTag', op: 'createTag' },
  { ch: 'revert', writes: true, op: 'revertCommit' },
  { ch: 'cherryPick', writes: true, op: 'cherryPick' },
  { ch: 'logFile', op: 'logFile' },
  { ch: 'blame', op: 'blame' },
  { ch: 'addToGitignore', op: 'addToGitignore' },
  { ch: 'removeFromGitignore', op: 'removeFromGitignore' },
  { ch: 'listIgnored', op: 'listIgnored' },
  // 原生后端：能力探测 / 可执行文件路径（只读两项 + 一项落盘到 ~/.myide/git-native.json）
  { ch: 'backendInfo', native: 'info' },
  { ch: 'testGitExe', native: 'testExe' },
  { ch: 'setGitExe', native: 'setExe' },
];

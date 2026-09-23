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
//   native—— 走原生后端 git-native.js 的函数名（不经过 worker；目前只有探测类只读操作）
module.exports = [
  { ch: 'init', op: 'initRepo' },
  { ch: 'status', op: 'status' },
  { ch: 'log', op: 'log' },
  { ch: 'logGraph', op: 'logGraph' },
  { ch: 'commit', op: 'commit' },
  { ch: 'diffWorkdir', op: 'diffWorkdir' },
  // M3：双区差异（index↔工作区 / HEAD↔index）+ hunk 级暂存
  { ch: 'diffUnstaged', op: 'diffUnstaged' },
  { ch: 'diffStaged', op: 'diffStaged' },
  { ch: 'stageHunk', op: 'stageHunk' },
  { ch: 'unstageHunk', op: 'unstageHunk' },
  { ch: 'revertHunk', op: 'revertHunk' },
  { ch: 'diffCommit', op: 'diffCommit' },
  { ch: 'compareRefs', op: 'compareRefs' },
  { ch: 'diffRefs', op: 'diffRefs' },
  { ch: 'commitFiles', op: 'commitFiles' },
  { ch: 'branches', op: 'branches' },
  { ch: 'checkout', op: 'checkout' },
  { ch: 'createBranch', op: 'createBranch' },
  { ch: 'discard', op: 'discard' },
  { ch: 'discardFiles', op: 'discardFiles' },
  { ch: 'getUserConfig', op: 'getUserConfig' },
  { ch: 'setUserConfig', op: 'setUserConfig' },
  { ch: 'listRemotes', op: 'listRemotes' },
  { ch: 'addRemote', op: 'addRemote' },
  { ch: 'removeRemote', op: 'removeRemote' },
  { ch: 'fetch', op: 'fetchRemote' },
  { ch: 'pull', op: 'pullRemote' },
  { ch: 'push', op: 'pushRemote' },
  { ch: 'listPushCommits', op: 'listPushCommits' },
  { ch: 'shelveCreate', op: 'shelveCreate' },
  { ch: 'shelveList', op: 'shelveList' },
  { ch: 'shelveApply', op: 'shelveApply' },
  { ch: 'shelveDelete', op: 'shelveDelete' },
  { ch: 'aheadBehind', op: 'aheadBehind' },
  { ch: 'listTags', op: 'listTags' },
  { ch: 'createTag', op: 'createTag' },
  { ch: 'revert', op: 'revertCommit' },
  { ch: 'cherryPick', op: 'cherryPick' },
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

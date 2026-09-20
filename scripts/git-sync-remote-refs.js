#!/usr/bin/env node
// scripts/git-sync-remote-refs.js —— 修本机「git 写不进 .git/refs/remotes/**」的问题
//
// 背景（本机绿盾 TSD 环境实测，2026-09-20）：
//   git.exe 执行 `git update-ref refs/remotes/origin/<branch>` / `git fetch` 时 **rc=0 但引用文件不落地**
//   （`.git/refs/remotes/origin/` 里什么都没有，`git rev-parse origin/main` 只能回退到 packed-refs 的旧值）。
//   后果：`git status` 永远骗人（明明推成功了却显示 "ahead N"），`git fetch` 也修不好。
//   对照实验：
//     · git 自己写 refs/heads/*  → 正常落地 ✅
//     · git 自己写 refs/remotes/* → 不落地 ❌（rc 仍为 0）
//     · Python/Node 写 refs/remotes/* → 落地，且 git 能正确读到 ✅
//   所以：用受信进程（Node，本脚本）按 `git ls-remote` 的真实结果补写松散引用。
//
// 用法：
//   node scripts/git-sync-remote-refs.js            # 默认同步 origin，所有分支
//   node scripts/git-sync-remote-refs.js upstream   # 指定远程名
//   node scripts/git-sync-remote-refs.js --check    # 只比对不写入
//
// 注意：**任何一次 git fetch 之后都要重跑**（fetch 会把松散引用再抹掉）。

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const remote = args.find((a) => !a.startsWith('-')) || 'origin';

function git(list) {
  return execFileSync('git', list, { encoding: 'utf8' }).trim();
}

function main() {
  let gitDir;
  try {
    gitDir = path.resolve(git(['rev-parse', '--git-dir']));
  } catch {
    console.error('这里不是 Git 仓库（git rev-parse --git-dir 失败）');
    process.exit(2);
  }

  // ls-remote 走网络（本机代理已在 git config 里配好，可用）
  let out = '';
  try {
    out = git(['ls-remote', '--heads', remote]);
  } catch (e) {
    console.error(`git ls-remote ${remote} 失败：${String((e && e.message) || e).slice(0, 300)}`);
    console.error('（若是私有仓库需要凭据，可先给 git 配 gh 作为凭据助手）');
    process.exit(3);
  }

  const refs = out.split('\n').filter(Boolean).map((l) => {
    const [sha, ref] = l.split(/\s+/);
    return { sha, branch: String(ref).replace('refs/heads/', '') };
  });
  if (!refs.length) {
    console.error(`远程 ${remote} 没有任何分支`);
    process.exit(4);
  }

  const dir = path.join(gitDir, 'refs', 'remotes', remote);
  const results = [];
  for (const r of refs) {
    const file = path.join(dir, r.branch);
    const want = r.sha + '\n';
    let cur = null;
    try { cur = fs.readFileSync(file, 'utf8'); } catch {}
    const same = cur === want;
    if (!same && !checkOnly) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, want, 'ascii');
    }
    results.push({ branch: r.branch, sha: r.sha.slice(0, 12), action: same ? '已是最新' : (checkOnly ? '需要更新' : '已写入') });
  }

  console.log(`远程 ${remote} → ${path.join('.git', 'refs', 'remotes', remote)}`);
  for (const r of results) console.log(`  ${r.action.padEnd(6)} ${r.branch.padEnd(20)} ${r.sha}`);
  if (checkOnly) {
    const need = results.filter((r) => r.action === '需要更新');
    if (need.length) process.exitCode = 1;
    return;
  }
  // 复查：让 git 自己读一遍，确认真的生效（不是"我写成功了"就算完）
  console.log('--- 复查（git 自己读） ---');
  for (const r of refs) {
    let got = '(读不到)';
    try { got = git(['rev-parse', `refs/remotes/${remote}/${r.branch}`]); } catch {}
    const ok = got === r.sha;
    console.log(`  ${ok ? '✅' : '❌'} ${remote}/${r.branch} = ${String(got).slice(0, 12)}`);
    if (!ok) process.exitCode = 1;
  }
  try { console.log('  git status:', git(['status', '-sb']).split('\n')[0]); } catch {}
}

main();

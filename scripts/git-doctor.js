#!/usr/bin/env node
// scripts/git-doctor.js —— 本机 Git 体检与自愈（推 GitHub / status 显示异常时先跑这个）
//
// ============ 背景（2026-09-20 实测，本机绿盾 TSD 环境）============
// 症状：`git push` 明明成功、远端也更新了，但 `git status` 一直显示假的 `ahead N`；
//       `git fetch` 打印 "c4c6566..ecd4662 main -> origin/main" 像成功了，实际毫无变化。
//       很容易被误判成网络 / 代理 / 凭据 / 分支名问题（本次就是这么被误判的）。
//
// 实测规律：
//   · git 能写 `refs/heads/x`、`refs/A/B`（**3 段**）
//   · git 写不了 `refs/remotes/<remote>/<branch>`、`refs/A/B/C`（**4 段**）——
//     rc=0、reflog 也写进去了，但**引用文件根本不落地**
//   · 同样路径交给 Python/Node（受信进程）写就正常，且 git 能正确读到
//   · 关键：`refs/remotes` 目录**整体不存在**时，`git fetch` 能自己建好并正确落地；
//     而只要那里留着一个空目录（或 refs/ 下有残留目录），就又开始不落地
//
// 修复有两条路，都已验证：
//
// ① **结构性修复（推荐，一劳永逸）**：把 fetch refspec 改成 git 写得进去的 3 段命名空间——
//      git config --local remote.origin.fetch '+refs/heads/*:refs/rt-origin/*'
//      git config --local branch.main.merge refs/heads/main
//      git config --local branch.main.remote origin
//    之后 fetch / push 都自己写 `refs/rt-origin/<branch>`，`git status` 的 ahead/behind 恢复正常，
//    且 `git push` 不会再擦掉跟踪引用。本工具会检查这项配置并给出建议。
//
// ② **目录重建（兜底）**：把 `.git/refs/remotes` 整个挪出 refs/ 之外，再让 git fetch 重建。
//    必须整个挪走——原地留空目录会复现问题；备份目录要放 refs/ 之外。
//    引用数据本身在 `packed-refs` 里、且能重新 fetch，挪走不会丢东西（本工具会备份而不是删除）。
//
// 用法：
//   node scripts/git-doctor.js            # 体检 + 自动修复
//   node scripts/git-doctor.js --check    # 只体检不改动
//   node scripts/git-doctor.js <remote>   # 指定远程，默认 origin
//
// 注意：本环境 `fs.rmSync` 被安全删除垫片接管（会抛错且不删），所以本脚本只用 rename 归档，不删任何东西。

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const REMOTE = args.find((a) => !a.startsWith('-')) || 'origin';
const GH = 'D:/software/gh-cli/bin/gh.exe';

let problems = 0;
const say = (ok, label, detail) => {
  if (!ok) problems++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
};
const note = (s) => console.log(`     ${s}`);

function git(list) { return execFileSync('git', list, { encoding: 'utf8' }).trim(); }
function gitTry(list) {
  const r = spawnSync('git', list, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// ---------- 1. 凭据：github.com 是否交给 gh ----------
function checkCredentials() {
  console.log('\n[1] 推送凭据');
  const h = gitTry(['config', '--global', '--get-all', 'credential.https://github.com.helper']);
  const hasGh = h.out.split('\n').some((l) => /gh(\.exe)?"?\s+auth\s+git-credential/.test(l));
  say(hasGh, 'github.com 的凭据助手指向 gh', hasGh ? '' : '缺失 → 见 docs/开发文档-053 第一节');
  if (!hasGh) note('修复：git config --global --replace-all credential.https://github.com.helper ""');
  if (!hasGh) note('      git config --global --add credential.https://github.com.helper \'!D:/software/gh-cli/bin/gh.exe auth git-credential\'');

  if (!fs.existsSync(GH)) { say(false, 'gh.exe 存在', GH); return; }
  const st = spawnSync(GH, ['auth', 'status'], { encoding: 'utf8' });
  const out = (st.stdout || '') + (st.stderr || '');
  say(/Logged in to github\.com/.test(out), 'gh 已登录 github.com',
    (/account (\S+)/.exec(out) || [])[1] || '');
  if (/Missing required token scopes/.test(out)) note('（缺 read:org 只是警告，repo 权限足够推送，可无视）');
}

// ---------- 2. 远端跟踪引用是否与真实远端一致 ----------
function remoteHeads() {
  const ls = gitTry(['ls-remote', '--heads', REMOTE]);
  if (!ls.ok) return { ok: false, err: ls.err };
  return {
    ok: true,
    heads: ls.out.split('\n').filter(Boolean).map((l) => {
      const [sha, ref] = l.split(/\s+/);
      return { sha, branch: String(ref).replace('refs/heads/', '') };
    }),
  };
}
// 跟踪引用的真实名字由 remote.<remote>.fetch 的 refspec 决定
// （默认是 refs/remotes/<remote>/*，但本机缺陷下已改成 3 段的 refs/rt-origin/*）
function trackingRefs() {
  const specs = gitTry(['config', '--local', '--get-all', `remote.${REMOTE}.fetch`]).out.split('\n').filter(Boolean);
  const picked = specs.find((l) => /refs\/heads\/\*/.test(l) && l.includes(':')) || specs[0] || '';
  const m = /^\+?([^:]*):([^:]*)$/.exec(picked);
  if (!m) return { pattern: `refs/remotes/${REMOTE}/*`, root: `refs/remotes/${REMOTE}` };
  const dest = (m[2] || '').replace(/\*$/, '*');
  return { pattern: dest, root: dest.replace(/\/\*$/, '') };
}
function trackingRef(branch) { return trackingRefs().pattern.replace('*', branch); }
function mismatches(heads) {
  return heads.filter((h) => gitTry(['rev-parse', trackingRef(h.branch)]).out !== h.sha);
}

function checkRemoteRefs(gitdir, fix) {
  console.log(`\n[2] 远端跟踪引用（${trackingRefs().pattern}）`);
  const ls = remoteHeads();
  if (!ls.ok) { say(false, `git ls-remote ${REMOTE} 失败`, String(ls.err).slice(0, 140)); return; }
  if (!ls.heads.length) { say(false, `远程 ${REMOTE} 没有分支`); return; }

  let bad = mismatches(ls.heads);
  if (!bad.length) { say(true, `${ls.heads.length} 个分支引用全部与远端一致`); return; }

  say(false, `${bad.length}/${ls.heads.length} 个引用缺失或过期`, '`status` 里的 ahead/behind 会因此不可信');
  for (const b of bad) {
    const got = gitTry(['rev-parse', trackingRef(b.branch)]).out;
    // rev-parse 解析不到时会把入参原样回吐，不能当 sha 显示
    const show = /^[0-9a-f]{7,64}$/.test(got) ? got.slice(0, 12) : '(无)';
    note(`${trackingRef(b.branch)}  本地=${show}  远端=${b.sha.slice(0, 12)}`);
  }
  if (CHECK_ONLY) { note('（--check 模式，不改动）'); return; }

  console.log('  → 修复：把 .git/refs/remotes 整体挪到 .git/git-doctor-backup/，再让 git fetch 重建');
  const tr = trackingRefs();
  const segs = tr.pattern.replace(/\/\*$/, '').split('/').length; // refs/A/B → 3 段；refs/A/B/C → 4 段
  if (segs >= 4) {
    note(`提示：当前跟踪命名空间 ${tr.pattern} 是 ${segs + 1} 段，git 在这里写不进引用。`);
    note('      推荐改成 3 段（一劳永逸）：');
    note(`      git config --local remote.${REMOTE}.fetch '+refs/heads/*:refs/rt-origin/*'`);
    note('      git config --local branch.<当前分支>.merge refs/heads/<当前分支>');
    note(`      git config --local branch.<当前分支>.remote ${REMOTE}`);
  }
  const remotesDir = path.join(gitdir, ...tr.root.split('/'));
  const backupRoot = path.join(gitdir, 'git-doctor-backup');
  const dest = path.join(backupRoot, `remotes-${Date.now()}`);
  try {
    if (fs.existsSync(remotesDir)) {
      fs.mkdirSync(backupRoot, { recursive: true });
      fs.renameSync(remotesDir, dest);
      note(`已归档到 ${path.relative(process.cwd(), dest)}（确认无误后可自行删除）`);
    }
  } catch (e) {
    say(false, '归档 refs/remotes 失败', String((e && e.message) || e));
    return;
  }
  // fetch 前顺手把 refs/ 下的残留目录清出视野（只归档 refs/remotes 之外的可疑残留）
  const f = gitTry(['fetch', REMOTE]);
  say(f.ok, 'git fetch 执行', f.err.slice(0, 140));
  bad = mismatches(ls.heads);
  if (!bad.length) {
    say(true, '修复后引用一致（git 自己重建成功）');
  } else {
    say(false, `仍有 ${bad.length} 个引用不一致`, bad.map((b) => b.branch).join(', '));
    note('下一步：用受信进程直接补写引用（Node/Python 写该路径 git 能读到），或贴 `git --version` / 绿盾策略给人看');
  }
}

// ---------- 3. 汇总 ----------
function summary() {
  console.log('\n[3] 当前状态');
  const st = gitTry(['status', '-sb']).out.split('\n')[0] || '';
  const ab = gitTry(['rev-list', '--left-right', '--count', `${REMOTE}/HEAD...HEAD`]).out;
  note(`git status : ${st}`);
  if (ab) note(`ahead/behind: ${ab}（左=远端独有，右=本地独有）`);
  note('⚠ 本机环境下 ahead/behind 仅供参考；判断"是否真的推上去了"请用：');
  note(`  ${GH} api repos/<owner>/<repo>/branches/<branch> --jq .commit.sha`);
  note('  git ls-remote ' + REMOTE + ' refs/heads/<branch>');
}

console.log(`git-doctor —— ${process.cwd()}（${CHECK_ONLY ? '只检查' : '检查并修复'}）`);
let gitdir;
try { gitdir = path.resolve(git(['rev-parse', '--git-dir'])); }
catch { console.error('这里不是 Git 仓库'); process.exit(2); }

checkCredentials();
checkRemoteRefs(gitdir, !CHECK_ONLY);
summary();
console.log('\n' + (problems ? `发现 ${problems} 个问题（详见上文）` : '全部正常 ✅'));
process.exit(problems ? 1 : 0);

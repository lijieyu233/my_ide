// git-panel.js —— Git 提交（PyCharm 式左侧工具窗口：Ctrl+K / Alt+0 / Ctrl+3 / Ctrl+4）
// 布局：侧栏上半变更文件树 · 下半提交信息；选中文件 diff 显示在右侧主编辑区；日志窗口见 git-log.js
const GitPanel = (() => {
  let root = null;
  let state = null; // {isRepo, branch, changed, unborn}
  const checked = new Set(); // 勾选的待提交文件（跨刷新保留）
  let knownFiles = new Set(); // 上次刷新见过的文件（新出现的默认勾选）
  let commitMsg = ''; // 刷新时保留未发出的提交信息
  // M4：进行中的 Git 操作与冲突清单（无本机 git 时后端返回 NORMAL / 空列表 → 天然隐藏）
  let op = null;            // { state, target, onto, step, total }
  let conflictFiles = [];   // [{ file, resolved }]

  // 面板 DOM（index.html 静态结构，init 时绑定事件）
  let filesEl = null; // #cd-files 上半文件区

  // ---------- 刷新 ----------
  async function refresh() {
    if (!root) return;
    const st = await window.myIDE.git.status(root);
    state = { ...(st.isRepo ? st : { isRepo: false, error: st.error }) };
    // M4：进行中的 Git 操作 + 冲突清单（并行取；失败/不支持就当没有 —— 软依赖，不阻塞主流程）
    const [opR, cfR] = await Promise.all([gitSafe('opState', root), gitSafe('conflicts', root)]);
    op = opR && opR.state ? opR : null;
    conflictFiles = cfR && Array.isArray(cfR.files) ? cfR.files : [];
    syncChecked();
    render();
    updateAheadBehind();
    App.updateStatusbar({ branch: state.branch, changed: state.changed ? state.changed.length : 0, noRepo: !state.isRepo });
    // 文件树 Git 状态着色（PyCharm 式）
    const statusMap = {};
    if (state.isRepo && state.changed) {
      const sep = (root || '').includes('\\') ? '\\' : '/';
      for (const c of state.changed) statusMap[root + sep + c.file] = c.status;
    }
    if (window.Tree) Tree.setGitStatus(statusMap);
  }

  // 勾选集合与最新状态同步：消失的移除，新出现的默认勾选
  // （「忽略的文件」不参与自动勾选/移除 —— 它们是用户显式展开、显式勾的）
  // ⚠ 「已在暂存区」的文件同样不参与自动勾选：它们在自己的只读分节里，
  //    M1 不改动它们的暂存状态（用户终端 git add 过的东西不该被 IDE 顺手提交/清掉）。
  function syncChecked() {
    if (!state || !state.changed) return;
    const cur = new Set(state.changed.map((c) => c.file));
    for (const f of [...checked]) if ((!cur.has(f) || isInIndexOnly(f)) && !ignoredAll.has(f)) checked.delete(f);
    for (const f of cur) if (!knownFiles.has(f) && !isInIndexOnly(f)) checked.add(f);
    knownFiles = cur;
  }
  const isInIndexOnly = (f) => {
    const c = state && state.changed ? state.changed.find((x) => x.file === f) : null;
    return !!(c && c.inIndexOnly);
  };

  // ---------- 变更列表（Changelist）：命名分组 + 活动列表 + 随项目持久化 ----------
  // 存储：<项目根>/.myide/changelists.json（与 tasks.json 同思路：随项目走、可进 git）；
  // 写失败 / 只读盘 → 降级 localStorage（数据不能丢）。文件归属只记「非 Default 列表」，
  // 不在任何列表里 = 属于 Default —— 工作区永远是事实来源，列表只存归属覆盖。
  const CL_LSKEY = (p) => 'myide-changelists:' + p;
  const CL_FILE = (p) => (p ? String(p).replace(/[\\/]+$/, '') + '/.myide/changelists.json' : null);
  let cls = { active: 'default', lists: [] };   // lists: [{id, name, files:[posix 相对路径]}]
  const clPath = (f) => String(f == null ? '' : f).replace(/\\/g, '/');
  function clNormalize(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const lists = Array.isArray(o.lists) ? o.lists
      .filter((l) => l && l.id && l.id !== 'default' && l.name)
      .map((l) => ({ id: String(l.id), name: String(l.name), files: Array.isArray(l.files) ? l.files.map(clPath) : [] })) : [];
    const active = o.active && (o.active === 'default' || lists.some((l) => l.id === o.active)) ? o.active : 'default';
    return { active, lists };
  }
  async function loadCls() {
    const f = CL_FILE(root);
    if (!f) { cls = { active: 'default', lists: [] }; return; }
    let raw = null;
    try { const r = await window.myIDE.fs.readFile(f); if (r && r.content != null) raw = JSON.parse(r.content); } catch {}
    if (!raw) { try { raw = JSON.parse(localStorage.getItem(CL_LSKEY(root)) || 'null'); } catch {} }
    cls = clNormalize(raw);
    render();
  }
  function saveCls() {
    // 锁定写入目标：排队期间用户可能已经切项目（tasks.js 踩过这个串档坑）
    const snapRoot = root, f = CL_FILE(root), data = JSON.stringify(cls, null, 2);
    try { localStorage.setItem(CL_LSKEY(snapRoot), data); } catch {}
    if (!f) return;
    (async () => {
      try {
        const dir = f.slice(0, f.lastIndexOf('/'));
        await window.myIDE.fs.mkdir(dir);
        await window.myIDE.fs.writeFile(f, data);
      } catch {}
    })();
  }
  const clNameOf = (id) => (id === 'default' ? 'Default' : ((cls.lists.find((l) => l.id === id) || {}).name || id));
  function clListOf(file) {
    const p = clPath(file);
    for (const l of cls.lists) if (l.files.indexOf(p) >= 0) return l.id;
    return 'default';
  }
  function clMoveTo(file, lid) {
    const p = clPath(file);
    for (const l of cls.lists) l.files = l.files.filter((x) => x !== p);
    const t = cls.lists.find((l) => l.id === lid);
    if (t && t.files.indexOf(p) < 0) t.files.push(p);
    saveCls();
    render();
    MI.toast(t ? '已移入「' + t.name + '」' : '已移回 Default', 'ok');
  }
  function clNew(name) {
    const id = 'cl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    cls.lists.push({ id, name: String(name).trim(), files: [] });
    saveCls();
    return id;
  }
  function clSetActive(lid) {
    cls.active = lid;
    saveCls();
    render();
    MI.toast('活动变更列表：' + clNameOf(lid), 'ok');
  }

  // ---------- 远程凭证（localStorage myide-git-auth-map：按主机 {host:{username,password}}，多主机互不覆盖）----------
  function getGitAuthMap() {
    try {
      const m = JSON.parse(localStorage.getItem('myide-git-auth-map') || 'null');
      if (m && typeof m === 'object') return m;
    } catch {}
    try { // 旧版全局单份凭证迁移 → 兜底键 '*'（对任何主机生效，优先级低于按 host 保存的）
      const old = JSON.parse(localStorage.getItem('myide-git-auth') || 'null');
      if (old && old.username) {
        const m = { '*': { username: old.username, password: old.password || '' } };
        localStorage.setItem('myide-git-auth-map', JSON.stringify(m));
        localStorage.removeItem('myide-git-auth');
        return m;
      }
    } catch {}
    return {};
  }
  function saveGitAuthMap(host, cred) {
    try {
      const m = getGitAuthMap();
      if (cred && cred.username) m[host] = cred; else delete m[host];
      localStorage.setItem('myide-git-auth-map', JSON.stringify(m));
    } catch {}
  }
  // 远程 URL → 主机（含端口），用于按主机读写凭证；解析失败返回 null
  function hostOfUrl(url) {
    try { return new URL(url).host; } catch { return null; }
  }

  // ---------- 远程管理弹窗（remote 列表 + 新增 + 认证凭证）----------
  // 远程地址拆解 + 打码：界面上只显示 host / path（凭证不该明文铺在列表里），
  // 但 tooltip 要给出完整地址（打码后）——不然用户没法核对到底配的是哪个仓库。
  function splitRemote(u) {
    const full = String(u || '');
    let rest = full, scheme = '';
    const m = rest.match(/^([a-zA-Z+]+):\/\//);
    if (m) { scheme = m[1] + '://'; rest = rest.slice(m[0].length); }
    const at = rest.lastIndexOf('@');
    let cred = '';
    if (at >= 0 && rest.slice(0, at).indexOf('/') === -1) { cred = rest.slice(0, at); rest = rest.slice(at + 1); }
    const slash = rest.indexOf('/');
    const host = slash >= 0 ? rest.slice(0, slash) : rest;
    const path = slash >= 0 ? rest.slice(slash + 1) : '';
    return { scheme, cred, host, path, hasCred: !!cred };
  }
  function maskRemote(u) {
    const p = splitRemote(u);
    return p.scheme + (p.cred ? p.cred.split(':')[0] + ':***@' : '') + p.host + (p.path ? '/' + p.path : '');
  }

  // 远程仓库 / 认证（重做过一版：原来 origin 与 URL 挤在一行、URL 里明文带密码、
  // 区块之间只有一条像"进度条"的横线 —— 用户反馈「这个怎么用 ui也不好看」）
  async function openRemoteDialog() {
    if (!root) { MI.toast('请先打开一个文件夹', 'err'); return; }
    const r = await window.myIDE.git.listRemotes(root);
    if (r.error) { MI.toast(r.error, 'err'); return; }
    const box = document.createElement('div');
    box.id = 'br-box';
    Modal.show(box);
    const authMap = getGitAuthMap();
    // 主远程（优先 origin）的 host：凭证区默认编辑该主机的凭证
    const primary = (r.remotes || []).find((x) => x.name === 'origin') || (r.remotes || [])[0] || null;
    const primaryHost = primary ? hostOfUrl(primary.url) : null;
    const firstHost = primaryHost || Object.keys(authMap).find((h) => h !== '*') || '';
    const savedHosts = Object.keys(authMap).filter((h) => h !== '*');
    const firstCred = authMap[firstHost] || {};
    box.innerHTML = `
      <div class="m-head">远程仓库 <span class="x" id="rm-x">✕</span></div>
      <div class="m-body">
        <div class="rm-cap">远程地址 —— <b>推送 / 拉取</b>的目标仓库（<b>origin</b> 是默认那个）。
          想换个地址就删掉再加一条。</div>
        <div id="rm-list"></div>
        <div class="br-new rm-add-row">
          <input id="rm-name" type="text" value="origin" spellcheck="false" title="远程名（习惯上就叫 origin）">
          <input id="rm-url" type="text" spellcheck="false" placeholder="粘贴地址：https://github.com/用户/仓库.git 或本机路径">
          <button class="tb-btn" id="rm-add">＋ 添加</button>
        </div>
        <div class="rm-sec">
          <div class="rm-cap">推送 / 拉取认证 —— <b>按主机分开保存</b>，多台 Git 服务器互不覆盖。
            命令行里已经记住的凭证会自动复用，所以这里留空通常也能拉取；只有遇到反复要密码时才需要填。</div>
          <div class="br-new">
            <input id="rm-host" type="text" spellcheck="false" value="${esc(firstHost)}"
              placeholder="主机（域名:端口，如 gitlab.example.com:8080）" title="凭证按这个键保存：只填域名和端口，不要带 https:// 和路径">
          </div>
          <div class="br-new">
            <input id="rm-user" type="text" spellcheck="false" placeholder="用户名" value="${esc(firstCred.username || '')}">
            <input id="rm-pass" type="password" spellcheck="false" placeholder="密码 / 访问令牌（GitHub 要用 PAT，不能填登录密码）" value="${esc(firstCred.password || '')}">
          </div>
          <div class="rm-auth-foot">
            <button class="tb-btn" id="rm-save-auth">保存该主机认证</button>
            <span id="rm-auth-note" class="rm-note"></span>
          </div>
        </div>
      </div>`;
    const showAuthNote = (h) => {
      const note = document.getElementById('rm-auth-note');
      if (!note) return;
      const n = savedHosts.length;
      note.textContent = h
        ? (savedHosts.includes(h) ? '这台主机已保存过凭证（保存会覆盖）' : '这台主机还没有凭证')
        : (n ? '本机已保存 ' + n + ' 台主机的凭证' : '本机还没有保存过任何凭证');
    };
    // 切换主机时预填该主机已存凭证
    document.getElementById('rm-host').oninput = () => {
      const h = document.getElementById('rm-host').value.trim();
      const c = authMap[h] || {};
      document.getElementById('rm-user').value = c.username || '';
      document.getElementById('rm-pass').value = c.password || '';
      showAuthNote(h);
    };
    showAuthNote(firstHost);
    document.getElementById('rm-x').onclick = () => Modal.hide();
    const list = document.getElementById('rm-list');
    const renderList = async () => {
      const rr = await window.myIDE.git.listRemotes(root);
      list.innerHTML = '';
      if (!rr.remotes || !rr.remotes.length) {
        const d = document.createElement('div');
        d.className = 'rm-empty';
        d.textContent = '还没有配远程仓库 —— 把地址粘到下面那行、点「＋ 添加」就行（常见的 GitHub 地址长得像 https://github.com/你自己/仓库.git）。';
        list.appendChild(d);
        return;
      }
      for (const rm of rr.remotes) {
        const sp = splitRemote(rm.url);
        const row = document.createElement('div');
        row.className = 'rm-item';
        row.innerHTML = '<div class="rm-item-head">'
          + '<span class="rm-name"></span>'
          + '<span class="rm-acts">'
          + '<span class="rm-cred" title="这个地址里带了用户名/密码（这里已打码显示）">带凭证</span>'
          + '<span class="rm-del">删除</span>'
          + '</span></div>'
          + '<div class="rm-item-url"><span class="rm-host"></span><span class="rm-path"></span></div>';
        row.querySelector('.rm-name').textContent = rm.name;
        if (!sp.hasCred) row.querySelector('.rm-cred').remove();
        const hostEl = row.querySelector('.rm-host');
        hostEl.textContent = sp.host || (sp.path ? '' : '(空地址)');
        const pathEl = row.querySelector('.rm-path');
        pathEl.textContent = sp.path ? ' / ' + sp.path : '';
        row.title = '完整地址（凭证已打码）：' + maskRemote(rm.url);
        row.querySelector('.rm-del').onclick = async () => {
          const yes = await Modal.confirm('删除远程', '确定删除远程「' + rm.name + '」吗？（只删本机这份配置，不影响远端仓库）');
          if (!yes) return;
          const dr = await window.myIDE.git.removeRemote(root, rm.name);
          if (dr.ok) { MI.toast('已删除 ' + rm.name, 'ok'); renderList(); refresh(); }
          else MI.toast('删除失败: ' + dr.error, 'err');
        };
        list.appendChild(row);
        // 远程分支（本地跟踪 refs，无网络）：名称 + 短 oid，HEAD 标默认分支
        const brs = rm.branches || [];
        const brBox = document.createElement('div');
        brBox.className = 'rm-branches';
        if (!brs.length) {
          brBox.innerHTML = '<div class="rm-br-empty">本机还没有它的分支信息（拉取一次后就有了）</div>';
        } else {
          for (const b of brs) {
            const el = document.createElement('div');
            el.className = 'rm-br' + (b.head ? ' rm-br-head' : '');
            el.title = b.oid || '';
            el.innerHTML = `<span class="rm-br-dot">${b.head ? '●' : '○'}</span><span class="rm-br-name">${esc(b.name)}</span><span class="rm-br-oid">${esc(b.oid || '')}</span>`;
            brBox.appendChild(el);
          }
        }
        list.appendChild(brBox);
      }
    };
    renderList();
    document.getElementById('rm-add').onclick = async () => {
      const name = document.getElementById('rm-name').value.trim();
      const url = document.getElementById('rm-url').value.trim();
      if (!url) { MI.toast('请先粘贴远程地址', 'err'); return; }
      const ar = await window.myIDE.git.addRemote(root, { name, url });
      if (ar.ok) { MI.toast('已添加远程 ' + name, 'ok'); document.getElementById('rm-url').value = ''; renderList(); refresh(); }
      else MI.toast('添加失败: ' + ar.error, 'err');
    };
    document.getElementById('rm-save-auth').onclick = () => {
      const host = document.getElementById('rm-host').value.trim();
      if (!host) { MI.toast('请填写主机（域名:端口）', 'err'); return; }
      const username = document.getElementById('rm-user').value.trim();
      const password = document.getElementById('rm-pass').value;
      if (!username) { MI.toast('请填写用户名', 'err'); return; }
      saveGitAuthMap(host, { username, password });
      if (!savedHosts.includes(host)) savedHosts.push(host);
      showAuthNote(host);
      MI.toast('已保存 ' + host + ' 的认证', 'ok');
    };
  }

  // ---------- 拉取 / 推送 ----------
  let syncing = false;
  // 拉取策略（M4 收尾）：默认快进保持一键直达；分叉时的两种策略收进下拉，
  // 不给"悄悄合并改历史"的默认行为 —— 用户点了什么就该发生什么。
  const PULL_STRATEGIES = [
    { key: 'ff', label: '拉取（快进，默认）', title: '只在可以快进时更新本地分支；已分叉会提示' },
    { key: 'ff-only', label: '仅快进（分叉时报错）', title: 'git merge --ff-only FETCH_HEAD：任何分叉都拒绝' },
    { key: 'merge', label: '拉取并合并（分叉时建合并提交）', title: 'fetch + merge：保留两条历史，出冲突进解决流程' },
    { key: 'rebase', label: '拉取并变基（把本地提交重放上去）', title: 'fetch + rebase：历史线性，出冲突进解决流程' },
  ];
  async function doPull(strategy) {
    if (!root || syncing) return;
    syncing = true;
    MI.toast('拉取中…');
    const r = await window.myIDE.git.pull(root, { auth: getGitAuthMap(), strategy });
    syncing = false;
    if (!r.ok) { MI.toast('拉取失败: ' + r.error, 'err'); await refresh(); return; }
    await refresh();
    if (window.GitLog && GitLog.isOpen()) GitLog.refresh();
    if (r.conflict) MI.toast('⚠ 拉取（' + (r.strategy || '') + '）出现冲突，请在上方「解决冲突」里处理', 'err');
    else MI.toast('✅ 已拉取' + (r.strategy && r.strategy !== 'ff' ? '（' + r.strategy + '）' : '') + (r.urlFixed ? '（远程 URL 已自动补 .git）' : ''), 'ok');
  }
  function openPullMenu(anchor) {
    openFloatMenu(anchor, PULL_STRATEGIES.map((s) => ({ label: s.label, title: s.title, run: () => doPull(s.key) })));
  }
  async function doPush(silent, opts) {
    if (!root || syncing) return false;
    if (!silent) {
      // Push 预览（PyCharm 式）：推送前列出待推送提交，确认后才真正推送
      return openPushPreview();
    }
    syncing = true;
    let r;
    if (opts && opts.lease) {
      // M4 收尾：安全强推 —— --force-with-lease 以「本地记录的远程跟踪引用」为租约，
      // 上次 fetch 之后远程又被别人推过 → 推送被拒绝。裸 --force 会悄悄覆盖别人的提交。
      r = await window.myIDE.git.pushForceWithLease(root, (opts && opts.remote) || 'origin', state.branch);
      if (r && r.ok) r = { ok: true, remote: (opts && opts.remote) || 'origin', lease: true };
    } else {
      r = await window.myIDE.git.push(root, {
        auth: getGitAuthMap(),
        remote: opts && opts.remote,
        force: !!(opts && opts.force),
      });
    }
    syncing = false;
    if (r.ok) {
      MI.toast('✅ 已' + (r.lease ? '安全强推（--force-with-lease）到 ' : r.force ? '强制推送到 ' : '推送到 ')
        + (r.remote || '远程') + (r.urlFixed ? '（远程 URL 已自动补 .git）' : ''), 'ok');
      refresh();
      return true;
    }
    MI.toast('推送失败: ' + r.error, 'err');
    return false;
  }

  // ---------- Push 预览弹窗（待推送提交清单 → 确认推送） ----------
  async function openPushPreview() {
    if (!root) { MI.toast('请先打开一个文件夹', 'err'); return false; }
    if (syncing) return false;
    const p = await window.myIDE.git.listPushCommits(root);
    if (!p.ok) { MI.toast(p.error || '当前无可推送的提交', 'err'); return false; }
    const box = document.createElement('div');
    box.id = 'pp-box';
    Modal.show(box);
    box.innerHTML = `
      <div class="m-head">推送预览
        <span class="x" id="pp-x">✕</span>
      </div>
      <div class="m-body">
        <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:8px">
          将推送 <b style="color:var(--text-bright)">${p.count}</b> 个提交到 <b style="color:var(--text-bright)">${esc(p.remote || 'origin')}/${esc(p.branch)}</b>${p.first ? '（首次推送该分支）' : ''}
        </div>
        <div id="pp-list" style="max-height:320px;overflow:auto;border:1px solid var(--border-mid);border-radius:4px;padding:4px 0"></div>
      </div>
      <div class="m-foot">
        <button class="tb-btn" id="pp-cancel">取消</button>
        <button class="tb-btn primary" id="pp-ok">⬆ 推送（${p.count} 个提交）</button>
      </div>`;
    const list = box.querySelector('#pp-list');
    for (const c of p.commits) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:3px 10px;font-size:12px';
      row.innerHTML = `<span style="color:var(--accent,#61afef);font-family:monospace">${c.short}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.message)}</span>
        <span style="color:var(--text-dim);white-space:nowrap">${esc(c.author)} · ${fmtDate(c.timestamp)}</span>`;
      list.appendChild(row);
    }
    box.querySelector('#pp-x').onclick = () => Modal.hide();
    box.querySelector('#pp-cancel').onclick = () => Modal.hide();
    box.querySelector('#pp-ok').onclick = async () => {
      Modal.hide();
      syncing = true;
      MI.toast('推送中…');
      const r = await window.myIDE.git.push(root, { auth: getGitAuthMap() });
      syncing = false;
      if (r.ok) { MI.toast('✅ 已推送 ' + p.count + ' 个提交到 ' + (r.remote || p.remote || 'origin') + '/' + p.branch + (r.urlFixed ? '（远程 URL 已自动补 .git）' : ''), 'ok'); refresh(); if (window.GitLog && GitLog.isOpen()) GitLog.refresh(); }
      else MI.toast('推送失败: ' + r.error, 'err');
    };
    return true;
  }

  // ahead/behind 显示（标题栏 dirty 区域）+ 状态栏
  // 带节流的静默 fetch（60s 一次）：反映远程真实状态；失败回退本地 refs
  let lastFetchAt = 0;
  async function updateAheadBehind(forceFetch) {
    if (!root) return;
    const now = Date.now();
    const doFetch = forceFetch === true || now - lastFetchAt > 60000;
    if (doFetch) lastFetchAt = now;
    const r = await window.myIDE.git.aheadBehind(root, doFetch ? { fetch: true, auth: getGitAuthMap() } : {})
      .catch(() => null);
    if (!r || !r.branch) return;
    const el = document.getElementById('cd-dirty');
    if (!el) return;
    const ab = [];
    if (r.ahead) ab.push('↑' + r.ahead);
    if (r.behind) ab.push('↓' + r.behind);
    const changedN = state && state.changed ? state.changed.length : 0;
    el.textContent = [ab.join(' '), changedN ? changedN + ' 处修改' : ''].filter(Boolean).join(' · ');
    el.dataset.ahead = r.ahead == null ? '' : String(r.ahead);
    el.dataset.behind = r.behind == null ? '' : String(r.behind);
    // 远程信息提示（准确显示当前操作的远程仓库与数据来源）
    if (r.remote) {
      const mark = r.fetched ? '已同步远程' : '基于本地缓存（60 秒内不重复联网）';
      el.title = (r.remoteUrl || r.remote) + '\n' + mark;
    } else {
      el.title = '未配置远程仓库';
    }
    el.dataset.remote = r.remote || '';
  }

  function openCommit() {
    if (!root) { MI.toast('请先打开一个文件夹', 'err'); return; }
    if (!state || !state.isRepo) {
      Modal.confirm('初始化仓库', '当前目录不是 Git 仓库，要初始化吗？').then(async (yes) => {
        if (!yes) return;
        const r = await window.myIDE.git.init(root);
        if (r.ok) { MI.toast('已初始化', 'ok'); refresh(); }
        else MI.toast('失败: ' + r.error, 'err');
      });
      return;
    }
    App.showTool('git');
    render();
  }

  // 兼容旧调用：收起面板（再点工具条按钮同效）
  function closeDialog() {
    if (App.getTool() === 'git') App.switchTool('git');
  }

  // ---------- 渲染（面板内容） ----------
  function render() {
    if (!filesEl) return;
    filesEl.innerHTML = '';
    if (!state || !state.isRepo) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      d.innerHTML = '当前目录不是 Git 仓库<br><button class="tb-btn gbtn" id="git-init-btn">初始化仓库</button>';
      filesEl.appendChild(d);
      const b = document.getElementById('git-init-btn');
      if (b) b.onclick = async () => {
        const r = await window.myIDE.git.init(root);
        if (r.ok) { MI.toast('已初始化 Git 仓库', 'ok'); refresh(); }
        else MI.toast('初始化失败: ' + r.error, 'err');
      };
      return;
    }
    // 标题栏分支信息（修改数/ahead-behind 由 updateAheadBehind 统一渲染）
    const br = document.getElementById('cd-branch');
    if (br) {
      // 分支名前缀用 SVG（不再用 '⎇' 字符，见 IC.branch 说明）；名字部分单独一个 span 负责省略号
      br.innerHTML = IC.branch + '<span class="cd-br-nm"></span>';
      const nm = br.querySelector('.cd-br-nm');
      if (nm) nm.textContent = state.branch;
      br.title = '当前分支 ' + state.branch + ' —— 点击切换分支 / 检出标签';
    }

    // M4：「操作进行中」条（有 merge/rebase/cherry-pick/revert 未完成时才出现）——放在最上面，
    // 它是当前最该处理的事，比工具行更优先
    const opBar = buildOpBar();
    if (opBar) filesEl.appendChild(opBar);

    // 工具行（PyCharm 提交窗口 Changes 工具栏）：纯图标按钮 + 文字进 tooltip
    filesEl.appendChild(buildToolbar());
    updateAuthorBtn();   // 工具行刚重建 → 作者按钮的"已覆盖"态要重新贴一次

    const list = document.createElement('div');
    list.id = 'commit-list';
    filesEl.appendChild(list);
    if (!state.changed.length) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      // 文案朴素、靠上：原来的「没有更改 ✨」占着 30px 上下留白还居中，看起来像页面坏了
      d.textContent = state.branch === '(无提交)' ? '还没有任何提交 —— 勾选文件、写下提交信息，提交第一个吧' : '没有未提交的更改';
      list.appendChild(d);
    } else {
      for (const sec of fileSections()) list.appendChild(renderSection(sec));
    }
    list.appendChild(renderIgnoredSection()); // PyCharm「忽略的文件」节点：默认收起，展开才遍历
    updateCheckUI();
    gitSelIdx = -1; // 重新渲染后重置键盘导航选中
  }

  // ---------- 「忽略的文件」节点（PyCharm）：默认收起，展开时才遍历工作区 ----------
  function renderIgnoredSection() {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'git-sec-title';
    const caret = document.createElement('span');
    caret.className = 'caret';
    const collapsed = secCollapsed.ignored !== false; // 默认收起
    caret.textContent = collapsed ? '▸' : '▾';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const label = document.createElement('span');
    label.className = 'sec-name';
    label.textContent = '忽略的文件';
    const hint = document.createElement('span');
    hint.className = 'sec-hint';
    head.appendChild(caret);
    head.appendChild(cb);
    head.appendChild(label);
    head.appendChild(hint);
    head.title = '被 .gitignore 忽略、且未跟踪的文件（勾选可强制加入提交；右键「不再忽略」）';

    const body = document.createElement('div');
    body.className = 'git-sec-body';
    wrap.appendChild(head);
    wrap.appendChild(body);

    const syncHint = () => {
      if (!ignoredFiles) { hint.textContent = '点击展开'; return; }
      const n = ignoredFiles.length;
      hint.textContent = (ignoredTruncated ? n + '+ 个' : n + ' 个文件');
    };
    const draw = () => {
      body.innerHTML = '';
      checkNodes = checkNodes.filter((n) => n.input !== cb);
      syncHint();
      const items = (ignoredFiles || []).map((f) => ({
        file: f.file,
        status: f.dir ? 'ignoredDir' : 'ignored',
        label: f.dir ? '已被 .gitignore 忽略的目录' : '已被 .gitignore 忽略（未跟踪）',
      }));
      if (!items.length) {
        const d = document.createElement('div');
        d.className = 'git-empty';
        d.textContent = ignoredFiles ? '没有被忽略的文件' : '点标题展开即加载';
        body.appendChild(d);
      } else if (groupByDir) {
        body.appendChild(renderDirTree(buildDirTree(items), 1, 'ignored'));
      } else {
        body.appendChild(buildFlatList(items));
      }
      const files = items.map((c) => c.file);
      registerCheckNode(cb, files);
      cb.disabled = !files.length;
      cb.onchange = () => setCheckedFiles(files, cb.checked);
    };
    const fill = async () => {
      // 已加载过 → 重渲染后要把行画回来（早返回会让 body 空着，看起来像「没数据」）
      if (ignoredFiles) { draw(); return; }
      if (ignoredLoading) return;
      ignoredLoading = true;
      hint.textContent = '加载中…';
      const r = await gitSafe('listIgnored', root);
      ignoredLoading = false;
      ignoredFiles = (r && r.files) || [];
      ignoredTruncated = !!(r && r.truncated);
      ignoredAll = new Set(ignoredFiles.map((f) => f.file));
      draw();
      updateCheckUI();
    };
    const toggle = () => {
      const now = body.style.display === 'none';
      body.style.display = now ? '' : 'none';
      caret.textContent = now ? '▾' : '▸';
      secCollapsed.ignored = !now;
      saveSecCollapse(secCollapsed);
      if (now) fill();
    };
    head.onclick = (e) => { if (e.target === cb) return; toggle(); };
    cb.onclick = (e) => e.stopPropagation();
    if (collapsed) body.style.display = 'none';
    else fill();
    syncHint();
    return wrap;
  }

  // 新 API 兜底：旧 preload 没有这些方法时会同步抛 TypeError，不能让它打到事件处理器外面
  async function gitSafe(fn, ...args) {
    try { return await window.myIDE.git[fn](...args); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // .gitignore 改动后让「忽略的文件」失效，下次展开重新遍历
  function invalidateIgnored() {
    ignoredFiles = null;
    ignoredTruncated = false;
    ignoredAll = new Set();
    ignoredLoading = false;
  }

  // ---------- M4：进行中的 Git 操作（merge / rebase / cherry-pick / revert）----------
  // 状态机：NORMAL → MERGING / REBASING / CHERRY_PICKING / REVERTING → 解决完继续 → NORMAL
  const OP_TEXT = {
    MERGING: (o) => '正在合并 ' + (o.target || '选定分支'),
    REBASING: (o) => '正在变基：把 ' + (o.target || '当前分支') + ' 重放到 ' + (o.onto || '目标')
      + (o.step && o.total ? '（第 ' + o.step + '/' + o.total + ' 步）' : ''),
    CHERRY_PICKING: (o) => '正在摘取 ' + (o.target || '某个提交'),
    REVERTING: (o) => '正在还原 ' + (o.target || '某个提交'),
  };
  const curOp = () => (op && op.state && op.state !== 'NORMAL' ? op : null);
  const unresolved = () => conflictFiles.filter((f) => !f.resolved);

  // 面板顶部的「操作进行中」条：说清在做什么、还剩几个冲突、下一步能按什么
  function buildOpBar() {
    const o = curOp();
    if (!o) return null;
    const bar = document.createElement('div');
    bar.className = 'git-op-bar';
    const head = document.createElement('div');
    head.className = 'git-op-head';
    head.innerHTML = '<span class="op-warn">⚠</span><span class="op-text"></span>';
    head.querySelector('.op-text').textContent = (OP_TEXT[o.state] || (() => 'Git 操作进行中'))(o);
    bar.appendChild(head);

    const todo = unresolved();
    const meta = document.createElement('div');
    meta.className = 'git-op-meta';
    meta.textContent = todo.length
      ? todo.length + ' 个冲突待解决' + (conflictFiles.length > todo.length ? '（已解决 ' + (conflictFiles.length - todo.length) + '）' : '')
      : '冲突已全部解决，可以继续';
    bar.appendChild(meta);

    const acts = document.createElement('div');
    acts.className = 'git-op-acts';
    const mk = (label, title, fn, cls) => {
      const b = document.createElement('button');
      b.className = 'vt-btn git-op-btn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.title = title;
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      acts.appendChild(b);
      return b;
    };
    if (todo.length) mk('解决冲突', '打开冲突解决窗口（三方对比 + 选一侧）', openConflictDialog, 'primary');
    const cont = mk('继续', '完成这一步（merge --continue / rebase --continue …）', doContinue, 'primary');
    if (todo.length) { cont.disabled = true; cont.title = '还有未解决的冲突'; }
    // 跳过只有 rebase / cherry-pick 有意义（merge、revert 无处可跳）→ 不显示比点了报"不支持"好
    if (o.state === 'REBASING' || o.state === 'CHERRY_PICKING') {
      mk('跳过', '放弃这一步的改动，继续下一步（rebase --skip / cherry-pick --skip）', doSkip);
    }
    mk('终止', '放弃整个操作，回到开始之前（--abort）', doAbort, 'danger');
    bar.appendChild(acts);
    return bar;
  }

  async function doContinue() {
    const r = await gitSafe('continueOp', root);
    if (!r || !r.ok) { MI.toast((r && r.error) || '继续失败', 'err'); return; }
    MI.toast('已继续并完成该操作', 'ok');
    await refresh();
  }
  async function doSkip() {
    const r = await gitSafe('skipOp', root);
    if (!r || !r.ok) { MI.toast((r && r.error) || '跳过失败', 'err'); return; }
    MI.toast('已跳过这一步', 'ok');
    await refresh();
  }
  async function doAbort() {
    const yes = await Modal.confirm('终止该操作', '会放弃这次操作的所有改动，回到开始之前的状态。确定吗？');
    if (!yes) return;
    const r = await gitSafe('abortOp', root);
    if (!r || !r.ok) { MI.toast((r && r.error) || '终止失败', 'err'); return; }
    MI.toast('已终止，回到操作之前的状态', 'ok');
    await refresh();
  }

  async function reloadConflicts() {
    const r = await gitSafe('conflicts', root);
    conflictFiles = (r && Array.isArray(r.files)) ? r.files : [];
  }

  // ---------- 冲突解决窗口：左文件列表 + 右三方对比（base / ours / theirs）----------
  async function openConflictDialog(preselect) {
    const list = conflictFiles.slice();
    if (!list.length) { MI.toast('当前没有冲突文件', 'ok'); return; }
    let cur = preselect && list.some((f) => f.file === preselect) ? preselect : list[0].file;

    const box = document.createElement('div');
    box.id = 'cf-box';
    box.innerHTML = `
      <div class="m-head">解决冲突<span class="x" id="cfl-x">✕</span></div>
      <div class="m-body cf-body">
        <div class="cf-left">
          <div class="cf-sec-title">冲突文件</div>
          <div id="cf-files"></div>
        </div>
        <div class="cf-right">
          <div class="cf-file-head" id="cf-file-head"></div>
          <div id="cf-sides"><div class="cf-loading">加载中…</div></div>
          <div id="cf-result-wrap"></div>
        </div>
      </div>
      <div class="m-foot">
        <span id="cf-hint" class="dim"></span>
        <span class="grow"></span>
        <button class="tb-btn" id="cf-refresh">重新加载</button>
        <button class="tb-btn m-ok" id="cf-continue">继续</button>
      </div>`;
    Modal.show(box);
    box.querySelector('#cfl-x').onclick = () => Modal.hide();
    box.querySelector('#cf-refresh').onclick = () => load();
    box.querySelector('#cf-continue').onclick = async () => { Modal.hide(); await doContinue(); };

    const drawList = () => {
      const el = box.querySelector('#cf-files');
      el.innerHTML = '';
      for (const f of list) {
        const row = document.createElement('div');
        row.className = 'cf-file' + (f.file === cur ? ' sel' : '') + (f.resolved ? ' done' : '');
        row.innerHTML = `<span class="cf-mark">${f.resolved ? '✓' : '⚠'}</span><span class="cf-nm"></span>`;
        row.querySelector('.cf-nm').textContent = f.file;
        row.title = f.file;
        row.onclick = () => { cur = f.file; drawList(); load(); };
        el.appendChild(row);
      }
      box.querySelector('#cf-hint').textContent =
        list.filter((f) => !f.resolved).length + ' 个待解决 / 共 ' + list.length;
    };

    const load = async () => {
      box.querySelector('#cf-file-head').textContent = cur;
      const sides = await gitSafe('conflictSides', root, cur);
      const el = box.querySelector('#cf-sides');
      if (!sides || !sides.ok) { el.innerHTML = '<div class="cf-loading">读取三方内容失败</div>'; return; }
      // ⚠ rebase 时 git 的 ours/theirs 含义是**反的**（ours = 新基底，theirs = 正在重放的提交）。
      //   文案必须跟着状态变，一律写"你的修改"会把用户坑掉。
      const o = curOp() || { state: 'MERGING' };
      const isRb = o.state === 'REBASING';
      const oursLabel = isRb ? '新基底（' + (o.target || '目标') + ' 侧）' : '当前分支（HEAD）';
      const theirsLabel = isRb ? '正在重放的提交（你的改动）' : '传入的改动（被合并进来）';
      el.innerHTML = `
        <div class="cf-side">
          <div class="cf-side-head">共同祖先（base）</div>
          <pre class="cf-pre"></pre>
        </div>
        <div class="cf-side">
          <div class="cf-side-head">${esc(oursLabel)}<button class="cf-pick" data-side="ours">用这一份</button></div>
          <pre class="cf-pre"></pre>
        </div>
        <div class="cf-side">
          <div class="cf-side-head">${esc(theirsLabel)}<button class="cf-pick" data-side="theirs">用这一份</button></div>
          <pre class="cf-pre"></pre>
        </div>`;
      const pres = el.querySelectorAll('.cf-pre');
      pres[0].textContent = sides.base == null ? '（无共同祖先）' : sides.base;
      pres[1].textContent = sides.ours == null ? '（无此版本）' : sides.ours;
      pres[2].textContent = sides.theirs == null ? '（无此版本）' : sides.theirs;
      el.querySelectorAll('.cf-pick').forEach((b) => {
        b.onclick = async () => {
          const r = await gitSafe('resolveFile', root, cur, b.dataset.side);
          if (!r || !r.ok) { MI.toast((r && r.error) || '应用失败', 'err'); return; }
          MI.toast('已用「' + (b.dataset.side === 'ours' ? oursLabel : theirsLabel) + '」解决 ' + cur, 'ok');
          await afterResolve();
        };
      });

      // ---- 可编辑的合并结果（M4 收尾）：起始 = 工作区里带冲突标记的版本，手工拼完写回 ----
      const rp = await gitSafe('readWorktreeText', root, cur);
      const el2 = box.querySelector('#cf-result-wrap');
      el2.innerHTML = `
        <div class="cf-side-head">
          <span>合并结果（可编辑）</span>
          <button class="cf-fill" data-side="base">填入共同祖先</button>
          <button class="cf-fill" data-side="ours">填入${esc(oursLabel)}</button>
          <button class="cf-fill" data-side="theirs">填入${esc(theirsLabel)}</button>
          <button class="cf-save" id="cf-save" title="把这份内容写进文件并标记为已解决">💾 保存并标记为已解决</button>
        </div>
        <textarea class="cf-textarea" id="cf-result" spellcheck="false"></textarea>`;
      const ta = el2.querySelector('#cf-result');
      // 工作区版本（带 <<<<<<< ======= >>>>>>> 标记）是手工合并最自然的起点 —— 用户在原地改标记就行
      ta.value = rp && rp.ok && rp.text != null ? rp.text
        : sides.ours == null ? '' : '<<<<<<< ' + oursLabel + '\n' + sides.ours + '=======\n' + sides.theirs + '>>>>>>> ' + theirsLabel;
      if (rp && !rp.ok) ta.value = '（读取工作区版本失败：' + (rp.error || '') + '，可从右侧填入某一侧后手工编辑）\n' + ta.value;
      el2.querySelectorAll('.cf-fill').forEach((b) => {
        b.onclick = () => {
          const v = b.dataset.side === 'base' ? sides.base : b.dataset.side === 'ours' ? sides.ours : sides.theirs;
          if (v == null) { MI.toast('这一侧没有内容', 'err'); return; }
          ta.value = v;
        };
      });
      el2.querySelector('#cf-save').onclick = async () => {
        const r = await gitSafe('resolveCustom', root, cur, ta.value);
        if (!r || !r.ok) { MI.toast((r && r.error) || '保存失败', 'err'); return; }
        MI.toast('已把手工合并的结果写回 ' + cur, 'ok');
        await afterResolve();
      };
    };

    // 解决完一个文件后：重拉清单 → 关窗 → 刷新面板 → 重开窗口（展示新状态）
    const afterResolve = async () => {
      await reloadConflicts();
      Modal.hide();
      await refresh();
      openConflictDialog(cur);
      // ⚠ 再补一次"落定刷新"：`git add` 刚写完的那一瞬，紧接着的 `git diff --diff-filter=U`
      //   偶发仍看到未合并条目（本机 index 落盘有延迟）→ 操作条会停在"还有冲突、继续禁用"，
      //   而后面没有任何东西再刷它，用户就卡在那儿了。延迟再刷一次让状态自愈。
      const settleRoot = root;
      setTimeout(() => { if (root === settleRoot) refresh(); }, 1500);
    };

    drawList();
    load();
  }

  // ---------- M5：提交前检查（Before Commit）+ Sign-off / 作者覆盖 ----------
  // 配置按项目存 <项目根>/.myide/precommit.json（与变更列表同思路：随项目走；写失败降级 localStorage）。
  // **不做 Reformat / Optimize imports / Analyze** —— 那需要把四个语言的 lint/format 工具链全接进来，
  // 是另一个量级的工程；这里只做真实有效的三项 + 与 Git 钩子共用同一套执行器。
  const PC_LSKEY = (p) => 'myide-precommit:' + p;
  const PC_FILE = (p) => (p ? String(p).replace(/[\\/]+$/, '') + '/.myide/precommit.json' : null);
  const PC_DEFAULT = {
    enabled: true, runHooks: true, checkTodo: true,
    todoKinds: ['TODO', 'FIXME', 'XXX', 'HACK'],
    messageRegex: '', maxSubject: 72, commands: [],
  };
  function pcNormalize(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: o.enabled !== false,
      runHooks: o.runHooks !== false,
      checkTodo: o.checkTodo !== false,
      todoKinds: (Array.isArray(o.todoKinds) && o.todoKinds.length ? o.todoKinds : PC_DEFAULT.todoKinds).map(String),
      messageRegex: typeof o.messageRegex === 'string' ? o.messageRegex : '',
      maxSubject: Number(o.maxSubject) > 0 ? Number(o.maxSubject) : 0,   // 0 = 不限制
      commands: (Array.isArray(o.commands) ? o.commands : [])
        .filter((c) => c && String(c.cmd || '').trim())
        .map((c) => ({ name: String(c.name || '').trim() || String(c.cmd).trim(), cmd: String(c.cmd).trim() })),
    };
  }
  let preCfg = pcNormalize(null);
  async function loadPreCfg() {
    const f = PC_FILE(root);
    if (!f) { preCfg = pcNormalize(null); return; }
    let raw = null;
    try { const r = await window.myIDE.fs.readFile(f); if (r && r.content != null) raw = JSON.parse(r.content); } catch {}
    if (!raw) { try { raw = JSON.parse(localStorage.getItem(PC_LSKEY(root)) || 'null'); } catch {} }
    preCfg = pcNormalize(raw);
  }
  function savePreCfg() {
    const snapRoot = root, f = PC_FILE(root), data = JSON.stringify(preCfg, null, 2);
    try { localStorage.setItem(PC_LSKEY(snapRoot), data); } catch {}
    if (!f) return;
    (async () => {
      try {
        const dir = f.slice(0, f.lastIndexOf('/'));
        await window.myIDE.fs.mkdir(dir);
        await window.myIDE.fs.writeFile(f, data);
      } catch {}
    })();
  }

  // 作者覆盖：只对「这一次提交」生效，**不写回 git config**（PyCharm 的 Author 下拉同语义）
  let authorOverride = null;   // { name, email }
  async function openAuthorDialog() {
    const cur = await gitSafe('getUserConfig', root);
    const u = (cur && cur.config) || (cur && cur.user) || cur || {};
    const name0 = (authorOverride && authorOverride.name) || u.name || '';
    const mail0 = (authorOverride && authorOverride.email) || u.email || '';
    const box = document.createElement('div');
    box.id = 'au-box';
    box.innerHTML = `
      <div class="m-head">本次提交的作者<span class="x" id="au-x">✕</span></div>
      <div class="m-body">
        <div class="pc-hint">只影响这一次提交，<b>不会改写</b>仓库的 git config。</div>
        <label class="m-label">姓名<input id="au-name" type="text" value=""></label>
        <label class="m-label">邮箱<input id="au-email" type="text" value=""></label>
        <div id="au-cur" class="pc-hint"></div>
      </div>
      <div class="m-foot">
        <button class="tb-btn" id="au-reset">恢复默认</button>
        <span class="grow"></span>
        <button class="tb-btn m-cancel" id="au-no">取消</button>
        <button class="tb-btn m-ok" id="au-yes">确定</button>
      </div>`;
    Modal.show(box);
    box.querySelector('#au-name').value = name0;
    box.querySelector('#au-email').value = mail0;
    box.querySelector('#au-cur').textContent = '仓库默认：' + (u.name || '(未配置)') + ' <' + (u.email || '') + '>';
    box.querySelector('#au-x').onclick = () => Modal.hide();
    box.querySelector('#au-no').onclick = () => Modal.hide();
    box.querySelector('#au-reset').onclick = () => {
      authorOverride = null;
      Modal.hide();
      updateAuthorBtn();
      MI.toast('已恢复默认作者', 'ok');
    };
    box.querySelector('#au-yes').onclick = () => {
      const n = box.querySelector('#au-name').value.trim();
      const e2 = box.querySelector('#au-email').value.trim();
      if (!n || !e2) { MI.toast('姓名与邮箱都要填', 'err'); return; }
      if (n === u.name && e2 === u.email) authorOverride = null;   // 与默认一致就不必覆盖
      else authorOverride = { name: n, email: e2 };
      Modal.hide();
      updateAuthorBtn();
      MI.toast(authorOverride ? ('本次提交作者：' + n + ' <' + e2 + '>') : '已恢复默认作者', 'ok');
    };
  }
  function updateAuthorBtn() {
    // 「本次作者」不再有独立图标（收进 ⋯ 菜单）—— 覆盖生效时让 ⋯ 亮起来 + 在 tooltip 里写明，
    // 否则用户会忘记自己还挂着一个临时作者。
    const b = document.getElementById('commit-more');
    if (!b) return;
    b.classList.toggle('active', !!authorOverride);
    b.title = authorOverride
      ? '更多提交选项 —— 本次提交作者：' + authorOverride.name + ' <' + authorOverride.email + '>（点开可改 / 恢复默认）'
      : '更多提交选项：本次提交的作者 / 提交前检查';
  }

  // 显示选项菜单（PyCharm「Show Options Menu」）：分组方式 + 忽略的文件。
  // 用户是拿 PyCharm 的截图点名的这两项（Group By / Show）。
  function openViewOptionsMenu(anchorEl) {
    const hasIgnored = !!document.querySelector('#cd-files .git-sec-title');
    openFloatMenu(anchorEl, [
      { header: true, label: '分组方式' },
      { label: (groupByDir ? '✓ ' : '\u3000') + '按目录（Directory）',
        title: 'Ctrl+Alt+P —— 目录行 + 缩进的文件行', run: () => { if (!groupByDir) GitPanel.toggleGroupByDir(); } },
      { label: (groupByDir ? '\u3000' : '✓ ') + '平铺（Flat）',
        title: '所有文件同一层，用路径前缀表示位置', run: () => { if (groupByDir) GitPanel.toggleGroupByDir(); } },
      { header: true, label: '显示' },
      { label: '忽略的文件',
        title: hasIgnored ? '跳到并展开「忽略的文件」节点（在列表末尾）' : '当前没有「忽略的文件」节点',
        run: () => {
          const head = [...document.querySelectorAll('#cd-files .git-sec-title')]
            .find((h) => /忽略的文件/.test(h.textContent));
          if (head) { head.scrollIntoView({ block: 'nearest' }); head.click(); }
          else MI.toast('当前没有被忽略的文件', 'ok');
        } },
    ]);
  }

  // 提交相关的一次性设置（原来在工具行占两个图标位 —— 一次性的东西不该抢高频按钮的位置）
  function openCommitMoreMenu(anchorEl) {
    openFloatMenu(anchorEl, [
      { header: true, label: '提交选项' },
      {
        label: '本次提交的作者…',
        title: authorOverride
          ? '当前：' + authorOverride.name + ' <' + authorOverride.email + '>（只影响这一次）'
          : '只影响这一次提交，不写回仓库的 git config',
        run: () => openAuthorDialog(),
      },
      {
        label: '提交前检查…',
        title: '自定义命令 / Git 钩子 / TODO 扫描 / 提交消息校验 —— 点「提交」时才跑',
        run: () => openPrecheckDialog(),
      },
    ]);
  }

  // 提交前配置弹窗（勾选项 + 命令列表）
  async function openPrecheckDialog() {
    await loadPreCfg();
    const box = document.createElement('div');
    box.id = 'pc-box';
    const row = (id, label, title) => '<label class="m-check pc-row" title="' + esc(title) + '"><input type="checkbox" id="' + id + '"><span>' + esc(label) + '</span></label>';
    box.innerHTML = `
      <div class="m-head">提交前检查<span class="x" id="pc-x">✕</span></div>
      <div class="m-body">
        <div class="pc-cap">点「<b>提交</b>」时自动按下面的顺序跑一遍。
          只有<b>不通过</b>的项会拦一下（弹结果面板，还能选「仍然提交」）；TODO 这类只是提示，不会打断。
          配置跟着项目走，存在 <code>.myide/precommit.json</code>。</div>
        ${row('pc-enabled', '提交前执行检查', '总开关：关掉后点提交什么都不跑（适合临时绕过）')}
        ${row('pc-hooks', '运行 Git 钩子 pre-commit', '交给 git 自己跑（git hook run pre-commit）。仓库里没有这个钩子时记为「跳过」，不算失败')}
        ${row('pc-todo', '扫描 TODO / FIXME（只提示，不阻断）', '只扫这次要提交的文件，列出「文件:行号」；跳过二进制与超大文件')}
        <label class="m-label">标记关键字（逗号分隔）<input id="pc-kinds" type="text" spellcheck="false"></label>
        <div class="pc-two">
          <label class="m-label">提交消息必须匹配（正则，可空）<input id="pc-regex" type="text" spellcheck="false" placeholder="如 ^(feat|fix|docs)(\\(.+\\))?: "></label>
          <label class="m-label">主题长度上限<input id="pc-max" type="number" min="0" max="200" step="1" style="width:90px"></label>
        </div>
        <div class="pc-cmds-head">自定义命令（在项目根目录执行，按顺序跑，前一条失败就停）
          <span class="grow"></span>
          <button class="tb-btn" id="pc-demo">插入示例</button>
          <button class="tb-btn" id="pc-add">＋ 添加</button>
        </div>
        <div id="pc-cmds" class="pc-cmds"></div>
        <div class="pc-hint">只做「命令 + 钩子 + TODO + 消息校验」；Reformat / 优化 import / 静态分析<b>不做</b>（需要接入完整工具链）。</div>
      </div>
      <div class="m-foot">
        <span class="grow"></span>
        <button class="tb-btn m-cancel" id="pc-no">取消</button>
        <button class="tb-btn m-ok" id="pc-yes">保存</button>
      </div>`;
    Modal.show(box);
    const q = (x) => box.querySelector(x);
    q('#pc-enabled').checked = preCfg.enabled;
    q('#pc-hooks').checked = preCfg.runHooks;
    q('#pc-todo').checked = preCfg.checkTodo;
    q('#pc-kinds').value = preCfg.todoKinds.join(', ');
    q('#pc-regex').value = preCfg.messageRegex;
    q('#pc-max').value = String(preCfg.maxSubject);
    const cmdsEl = q('#pc-cmds');
    const drawCmds = (list) => {
      cmdsEl.innerHTML = '';
      if (!list.length) {
        const d = document.createElement('div');
        d.className = 'pc-empty';
        d.textContent = '还没有命令 —— 点右上「＋ 添加」写一条（例如 npm run lint），或者点「插入示例」看个样子';
        cmdsEl.appendChild(d);
        return;
      }
      list.forEach((c, i) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'pc-cmd';
        rowEl.innerHTML = '<input class="pc-nm" placeholder="名称" spellcheck="false">'
          + '<input class="pc-sh" placeholder="命令（在项目根目录执行）" spellcheck="false">'
          + '<button class="vt-btn pc-del" title="删除这条">✕</button>';
        rowEl.querySelector('.pc-nm').value = c.name || '';
        rowEl.querySelector('.pc-sh').value = c.cmd || '';
        rowEl.querySelector('.pc-del').onclick = () => {
          const cur = readCmds();
          cur.splice(i, 1);
          drawCmds(cur);
        };
        cmdsEl.appendChild(rowEl);
      });
    };
    const readCmds = () => [...cmdsEl.querySelectorAll('.pc-cmd')].map((r) => ({
      name: r.querySelector('.pc-nm').value.trim(),
      cmd: r.querySelector('.pc-sh').value.trim(),
    })).filter((c) => c.cmd);
    drawCmds(preCfg.commands);
    q('#pc-demo').onclick = () => {
      // 「插入示例」：填两条最常见的（前端 / Python），用户改成自己的即可 —— 空列表配一句"例如 npm run lint"
      // 对不熟的人等于没说（用户反馈："这个又是怎么用的"）
      const cur = readCmds();
      if (!cur.some((c) => c.cmd === 'npm run lint')) cur.push({ name: 'lint', cmd: 'npm run lint' });
      if (!cur.some((c) => c.cmd === 'npm test --silent')) cur.push({ name: 'test', cmd: 'npm test --silent' });
      drawCmds(cur);
      MI.toast('已插入示例命令，改成你自己的再保存', 'ok');
    };
    q('#pc-add').onclick = () => {
      const cur = readCmds();
      cur.push({ name: '', cmd: '' });
      drawCmds(cur);
      const rows = cmdsEl.querySelectorAll('.pc-cmd');
      const last = rows[rows.length - 1];
      if (last) last.querySelector('.pc-sh').focus();
    };
    q('#pc-x').onclick = () => Modal.hide();
    q('#pc-no').onclick = () => Modal.hide();
    q('#pc-yes').onclick = () => {
      preCfg = pcNormalize({
        enabled: q('#pc-enabled').checked,
        runHooks: q('#pc-hooks').checked,
        checkTodo: q('#pc-todo').checked,
        todoKinds: q('#pc-kinds').value.split(',').map((x) => x.trim()).filter(Boolean),
        messageRegex: q('#pc-regex').value,   // ⚠ 不 trim：正则里的尾空格可能是规则的一部分
        maxSubject: Number(q('#pc-max').value) || 0,
        commands: readCmds(),
      });
      savePreCfg();
      Modal.hide();
      MI.toast('提交前检查已保存' + (preCfg.commands.length ? '（' + preCfg.commands.length + ' 条命令）' : ''), 'ok');
    };
  }

  // 跑检查：返回 { problems（阻断，需"仍然提交"才过）, warnings（只提示） }
  async function runPreChecks(files, message) {
    const cfg = preCfg;
    const problems = [], warnings = [];
    const subject = String(message).split('\n')[0];
    if (cfg.maxSubject > 0 && subject.length > cfg.maxSubject) {
      problems.push({ name: '提交消息长度', ok: false, out: '主题 ' + subject.length + ' 字，超过上限 ' + cfg.maxSubject });
    }
    if (cfg.messageRegex) {
      let re = null;
      try { re = new RegExp(cfg.messageRegex); } catch (e) {
        warnings.push({ name: '消息正则无效', ok: false, out: String((e && e.message) || e) + '\n（这条规则被跳过，改好再存一次）' });
      }
      if (re && !re.test(subject)) {
        problems.push({ name: '提交消息格式', ok: false, out: '主题不匹配 /' + cfg.messageRegex + '/\n主题：' + subject });
      }
    }
    if (cfg.checkTodo) {
      const r = await gitSafe('scanTodo', root, files, cfg.todoKinds);
      if (r && r.ok) {
        const hits = r.hits || [];
        warnings.push({
          name: 'TODO 扫描', ok: true,
          out: hits.length
            ? hits.length + ' 处命中（只提示，不阻断）：\n' + hits.slice(0, 40).map((h) => h.file + ':' + h.line + '  ' + h.text).join('\n') + (hits.length > 40 ? '\n…' : '')
            : '没有 ' + cfg.todoKinds.join(' / ') + ' 命中',
        });
      } else if (r && r.error) warnings.push({ name: 'TODO 扫描', ok: false, out: r.error });
    }
    if (cfg.runHooks || cfg.commands.length) {
      const r = await gitSafe('precommitRun', root, { runHooks: cfg.runHooks, commands: cfg.commands });
      if (r && Array.isArray(r.results)) {
        for (const s of r.results) {
          const item = { name: s.name, ok: !!s.ok, skipped: !!s.skipped, out: s.out || '' };
          if (s.ok) warnings.push(item); else problems.push(item);
        }
      } else if (r && r.error) {
        problems.push({ name: '提交前命令', ok: false, out: r.error });
      }
    }
    return { problems, warnings };
  }

  // 结果面板：有阻断项时给「仍然提交」（PyCharm 也允许带警告提交）
  function showPreCheckResult(r) {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.id = 'pcr-box';
      const item = (s) => '<div class="pcr-item ' + (s.ok ? 'ok' : 'bad') + '">'
        + '<div class="pcr-head"><span class="pcr-mark">' + (s.skipped ? '·' : s.ok ? '✓' : '✗') + '</span>'
        + '<span class="pcr-nm"></span></div>'
        + '<pre class="pcr-out"></pre></div>';
      box.innerHTML = `
        <div class="m-head">提交前检查<span class="x" id="pcr-x">✕</span></div>
        <div class="m-body">
          <div id="pcr-sum" class="pcr-sum"></div>
          <div id="pcr-list"></div>
        </div>
        <div class="m-foot">
          <span class="grow"></span>
          <button class="tb-btn m-cancel" id="pcr-no">取消提交</button>
          <button class="tb-btn m-ok" id="pcr-yes">仍然提交</button>
        </div>`;
      Modal.show(box);
      const list = box.querySelector('#pcr-list');
      const all = [...(r.problems || []), ...(r.warnings || [])];
      for (const s of all) {
        const d = document.createElement('div');
        d.innerHTML = item(s);
        d.querySelector('.pcr-nm').textContent = s.name;
        d.querySelector('.pcr-out').textContent = s.out || '';
        list.appendChild(d);
      }
      const bad = (r.problems || []).length;
      box.querySelector('#pcr-sum').textContent = bad
        ? bad + ' 项没通过 —— 可以修完再来，也可以「仍然提交」'
        : '全部通过' + ((r.warnings || []).length ? '（' + r.warnings.length + ' 条提示）' : '');
      const done = (v) => {
        Modal.hide();
        document.removeEventListener('keydown', onKey);
        resolve(v);
      };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      document.addEventListener('keydown', onKey);
      box.querySelector('#pcr-x').onclick = () => done(false);
      box.querySelector('#pcr-no').onclick = () => done(false);
      box.querySelector('#pcr-yes').onclick = () => done(true);
    });
  }

  // Sign-off：追加到消息末尾（已有就不重复），用 getGitAuthMap 之外的 git config（与作者覆盖一致）
  async function appendSignoff(text) {
    // 用与本次提交相同的作者信息（PyCharm 的签名跟作者走）
    let name = '', email = '';
    if (authorOverride) { name = authorOverride.name; email = authorOverride.email; }
    else {
      const u = await gitSafe('getUserConfig', root);
      const cfg = (u && (u.config || u.user)) || u || {};
      name = cfg.name || ''; email = cfg.email || '';
    }
    if (!name || !email) return text;
    const line = 'Signed-off-by: ' + name + ' <' + email + '>';
    if (text.split('\n').some((l) => l.trim() === line)) return text;   // 重复勾选不加第二遍
    return text.replace(/\s+$/, '') + '\n\n' + line;
  }

  // ---------- 工具行（图标按钮：刷新 / 回滚 / 差异 / 提交 / 预览 ｜ 展开全部 / 收起全部 / 分组方式）----------
  function buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'git-cp-bar';
    const mk = (svg, title, fn, id) => {
      const b = document.createElement('button');
      b.className = 'vt-btn';
      b.innerHTML = svg;
      b.title = title;
      if (id) b.id = id;   // 从标题行挪过来的按钮保留原 id（dom 测试 / 快捷键按 id 找）
      b.onclick = fn;
      bar.appendChild(b);
      return b;
    };
    // ⚠ 这里**故意没有「提交」**：底部 footer 就是「提交 (I) / 提交并推送 (P)」，
    //   两个入口做同一件事只会让人犹豫按哪个（用户指出过"这个提交按钮多余了 下面就有"）。
    // ⚠ 也**没有「内嵌预览」**：340px 侧栏里 unified diff 每行都要折行、读不出结构，
    //   用户判定"一点用没有"；差异统一在编辑区看（点文件行 / 「差异」按钮）。
    mk(IC.refresh, '刷新 Git 状态 (Ctrl+R)', () => refresh());
    const roll = mk(IC.rollback, '回滚勾选的文件（放弃全部修改；未版本控制的文件会被删除）', () => rollbackChecked());
    const dif = mk(IC.diff, '显示勾选文件的差异（在编辑区打开）', () => diffChecked());
    const sep = document.createElement('span');
    sep.className = 'tb-sep';
    sep.setAttribute('aria-hidden', 'true');
    bar.appendChild(sep);
    mk(IC.expandAll, '展开全部（目录与分节）', () => setAllCollapsed(false));
    mk(IC.collapseAll, '收起全部（目录与分节）', () => setAllCollapsed(true));
    // ⚠ 这里**故意没有独立的「分组方式」按钮**：它和下面 ⋯ 显示选项菜单里的「分组方式」是同一个功能
    //   （PyCharm 的工具栏也没有这个按钮 —— 分组方式在 Show Options Menu 里，外加 Ctrl+Alt+P）。
    //   用户原话："按钮外观乱搞 重复功能未删除"。
    // 仓库级操作（搁置 / 远程 / 日志）—— 原在标题行右侧挤着，见 IC 里那段说明。
    // ⚠ 追加在**最后**：dom 测试与自检步骤按索引取工具行按钮（[4]=预览 [6][7]=展开/分组），
    //   插在中间会把这些索引全打乱。
    const sep2 = document.createElement('span');
    sep2.className = 'tb-sep';
    sep2.setAttribute('aria-hidden', 'true');
    bar.appendChild(sep2);
    mk(IC.shelve, '搁置更改（Shelve）：暂存未提交改动并可恢复', () => openShelveDialog(), 'cd-shelve');
    mk(IC.remote, '远程仓库管理（remote / 认证）', () => openRemoteDialog(), 'cd-remote');
    mk(IC.log, '提交历史（Alt+9 / Ctrl+5）', () => App.showTool('log'), 'cd-log');
    // M5 的「提交前检查 / 本次作者」都搬进了提交消息框那行的「⋯ 更多」菜单（见 openCommitMoreMenu）：
    // 一次性的设置不该和刷新/回滚这些高频操作抢位置。
    // 显示选项（PyCharm 提交窗口工具栏的 ⋯ Show Options Menu）：分组方式 / 忽略的文件。
    // ⚠ 追加在**最后**：自检按索引取前面的按钮（展开 [3] / 收起 [4] / 分组 [5]）。
    mk(IC.viewOpts, '显示选项：分组方式 / 忽略的文件', (e) => openViewOptionsMenu(e.currentTarget), 'cd-view-opts');
    barBtns = { roll, dif };
    return bar;
  }

  // ---------- 分节（更改 / 未进行版本管理的文件）：标题行三态复选框 + 展开收起 ----------
  function renderSection(sec) {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'git-sec-title' + (sec.readonly ? ' ro' : '');
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = secCollapsed[sec.key] ? '▸' : '▾';
    const label = document.createElement('span');
    label.className = 'sec-name';
    label.textContent = sec.title + ' ' + sec.items.length + ' 个文件';
    head.appendChild(caret);
    // 只读分节（「已暂存」）：没有复选框 —— 里面的内容是 index 里已有的，M1 不替用户增删
    if (sec.readonly) {
      const ro = document.createElement('span');
      ro.className = 'sec-ro';
      ro.textContent = '只读';
      ro.title = sec.roTip || '这些内容已经在 Git 暂存区（index）里。提交本次勾选时它们原样保留，不会被 unstage。';
      head.appendChild(ro);
    } else {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.title = '勾选 / 取消「' + sec.title + '」下的全部文件';
      head.appendChild(cb);
      const files = sec.items.map((c) => c.file);
      registerCheckNode(cb, files);
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = () => setCheckedFiles(files, cb.checked);
      head.dataset.cb = '1';
    }
    head.appendChild(label);
    if (sec.note) {
      const nt = document.createElement('span');
      nt.className = 'sec-note';
      nt.textContent = sec.note;
      head.appendChild(nt);
    }
    head.title = sec.readonly ? label.title : '点击标题收起 / 展开此节';
    // 非活动变更列表的分节头：右键 = 设为活动列表 / 整节移回 Default
    if (sec.cl) {
      head.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menu = document.getElementById('ctx-menu');
        menu.innerHTML = '';
        const mk = (label, fn, danger) => {
          const d = document.createElement('div');
          d.className = 'ctx-item' + (danger ? ' danger' : '');
          d.textContent = label;
          d.onclick = () => { menu.classList.add('hidden'); fn(); };
          menu.appendChild(d);
        };
        mk('✓ 设为活动列表', () => clSetActive(sec.cl));
        mk('↩ 全部移回 Default', () => {
          const t = cls.lists.find((l) => l.id === sec.cl);
          if (t) { const ps = sec.items.map((c) => clPath(c.file)); t.files = t.files.filter((x) => ps.indexOf(x) < 0); }
          saveCls();
          render();
          MI.toast('已移回 Default', 'ok');
        });
        menu.classList.remove('hidden');
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
        menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
      };
    }

    const body = document.createElement('div');
    body.className = 'git-sec-body';

    const toggle = () => {
      const now = body.style.display === 'none';
      body.style.display = now ? '' : 'none';
      caret.textContent = now ? '▾' : '▸';
      secCollapsed[sec.key] = !now;
      saveSecCollapse(secCollapsed);
    };
    head.onclick = (e) => { if (e.target.type === 'checkbox') return; toggle(); };
    if (secCollapsed[sec.key]) body.style.display = 'none';
    body.appendChild(groupByDir
      ? renderDirTree(buildDirTree(sec.items), 1, sec.key, !!sec.readonly)
      : buildFlatList(sec.items, !!sec.readonly));
    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  }

  // 平铺视图（PyCharm「Group by Directory」关掉后）：一行一个文件，父目录弱化显示在文件名前
  function buildFlatList(items, ro = false) {
    const box = document.createElement('div');
    box.className = 'git-group-body';
    for (const c of items.slice().sort((a, b) => a.file.localeCompare(b.file))) box.appendChild(fileRow(c, 0, true, ro));
    return box;
  }

  // 三态节点：把节点与其下全部文件关联（文件勾选变化时反向刷新节点状态）
  function registerCheckNode(input, files) { checkNodes.push({ input, files }); }

  // 勾选一组文件（节点复选框用）：同步文件行复选框 + 全部节点三态
  function setCheckedFiles(files, on) {
    const set = new Set(files);
    for (const f of files) { if (on) checked.add(f); else checked.delete(f); }
    if (filesEl) {
      for (const el of filesEl.querySelectorAll('.cf-check')) {
        if (set.has(el.dataset.file)) el.checked = on;
      }
    }
    updateCheckUI();
  }

  // 展开 / 收起全部（目录行、分节、忽略节点一起，PyCharm「Expand / Collapse All」）
  // 走状态 + 重渲染而不是直接改 DOM：忽略节点展开时还要触发懒加载
  function setAllCollapsed(collapsed) {
    if (!filesEl) return;
    for (const k of ['changes', 'untracked', 'ignored']) secCollapsed[k] = collapsed;
    saveSecCollapse(secCollapsed);
    dirAllCollapsed = collapsed;
    for (const k of Object.keys(dirCollapsed)) delete dirCollapsed[k]; // 清掉逐个覆盖，统一跟随全局
    saveUiPrefs();
    render();
  }

  // 变更文件分节：更改（= 活动变更列表）/ 其它变更列表（只读）/ 未跟踪 / 已暂存（只读）
  // M1 的语义：*可勾选的只有「活动列表里的文件」*；「已暂存」与「其它列表」都只展示。
  function fileSections() {
    const changes = [], untracked = [], staged = [], other = new Map();
    for (const c of state.changed) {
      if (c.inIndexOnly) { staged.push(c); continue; }   // 整份已在 index → 只读展示，本次提交不带它
      const lid = clListOf(c.file);
      if (lid !== cls.active) {
        if (!other.has(lid)) other.set(lid, []);
        other.get(lid).push(c);
        continue;
      }
      if (c.status === 'added') untracked.push(c);
      else changes.push(c);
    }
    const out = [];
    out.push({ key: 'changes', title: '更改', items: changes,
      note: cls.active !== 'default' ? '列表：' + clNameOf(cls.active) : '' });
    for (const [lid, items] of other) {
      out.push({ key: 'cl:' + lid, title: clNameOf(lid), items, readonly: true, cl: lid, note: '非活动列表',
        roTip: '这个变更列表不是活动列表，本次提交不包含它 —— 右键本节可「设为活动列表」' });
    }
    out.push({ key: 'untracked', title: '未进行版本管理的文件', items: untracked });
    out.push({ key: 'staged', title: '已暂存（外部）', items: staged, readonly: true, note: '保持不动' });
    return out.filter((s) => s.items.length);
  }

  // 大节（变更 / 未版本控制的文件）收起状态：用户偏好，全局持久化
  const GIT_SEC_KEY = 'myide-git-sec-collapse';
  function loadSecCollapse() {
    try { return JSON.parse(localStorage.getItem(GIT_SEC_KEY) || '{}'); } catch { return {}; }
  }
  function saveSecCollapse(map) {
    try { localStorage.setItem(GIT_SEC_KEY, JSON.stringify(map)); } catch {}
  }
  const secCollapsed = loadSecCollapse();

  // ---------- 视图偏好：分组方式（按目录 / 平铺）· 内嵌预览开关 · 目录展开状态 ----------
  const GIT_UI_KEY = 'myide-git-ui';
  function loadUiPrefs() {
    try { return JSON.parse(localStorage.getItem(GIT_UI_KEY) || '{}') || {}; } catch { return {}; }
  }
  const uiPrefs = loadUiPrefs();
  let groupByDir = uiPrefs.groupByDir !== false;  // 默认按目录（PyCharm 默认视图）
  const dirCollapsed = uiPrefs.dirCollapsed || {}; // '节key/depth/name' → 用户显式覆盖
  let dirAllCollapsed = !!uiPrefs.dirAllCollapsed;  // 「收起全部」的兜底（未被单独点过的目录跟随它）
  function saveUiPrefs() {
    try {
      localStorage.setItem(GIT_UI_KEY, JSON.stringify({ groupByDir, dirCollapsed, dirAllCollapsed, signoff }));
    } catch {}
  }
  // M5：Sign-off（DCO）—— 与视图偏好同一个键，但它影响提交内容，所以单独取名
  let signoff = !!uiPrefs.signoff;

  // ---------- 提交消息历史（全局，PyCharm「Recent Messages」语义）+ 草稿（按项目）----------
  const MSG_HIST_KEY = 'myide-commit-msgs';
  function loadMsgHistory() {
    try {
      const a = JSON.parse(localStorage.getItem(MSG_HIST_KEY) || '[]');
      return Array.isArray(a) ? a : [];
    } catch { return []; }
  }
  function pushMsgHistory(text) {
    const list = [text, ...loadMsgHistory().filter((m) => m !== text)].slice(0, 20);
    try { localStorage.setItem(MSG_HIST_KEY, JSON.stringify(list)); } catch {}
  }
  const draftKeyOf = (dir) => 'myide-commit-draft:' + (dir || '');
  function loadDraftFor(dir) { try { return localStorage.getItem(draftKeyOf(dir)) || ''; } catch { return ''; } }
  function saveDraftFor(dir, v) {
    try { if (v) localStorage.setItem(draftKeyOf(dir), v); else localStorage.removeItem(draftKeyOf(dir)); } catch {}
  }
  function loadDraft() { return loadDraftFor(root); }
  function saveDraft(v) { saveDraftFor(root, v); }
  let draftTimer = null; // 输入防抖，避免每敲一个字写一次 localStorage
  function scheduleDraftSave(v) {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { draftTimer = null; saveDraft(v); }, 500);
  }
  let amendBackup = null;  // 勾 amend 之前的草稿（取消勾选要还回去）
  let lastDraft = '';      // 当前草稿镜像（切项目时判断能否安全覆盖输入框）

  // 节点三态复选框注册表：[{input, files[]}]（分节标题行 / 目录行）
  let checkNodes = [];
  let barBtns = null;      // 工具行按钮引用（勾选变化时联动禁用态）
  let ignoredFiles = null; // 「忽略的文件」节点数据（null = 还没加载过）
  let ignoredTruncated = false; // 遍历是否被上限截断
  let ignoredAll = new Set(); // 忽略文件路径集合（勾选集合的成员判定要用）
  let ignoredLoading = false;

  // 工具行图标（统一 16px 内联 SVG，与工具条/标题栏同一套观感）
  const IC = {
    refresh: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 3.2v3.2H9.8"/></svg>',
    // 回滚（放弃修改）：**箭头折回一条竖线**。原来和"刷新"是两个镜像的圆弧箭头，
    //   在一行里根本分不清谁是谁（截图里那两个圈就是这个毛病）。
    rollback: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 3.4v9.2"/><path d="M12.6 8H6.4M9.4 4.8 6.2 8l3.2 3.2"/></svg>',
    diff: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 8h10.8M9.6 5l3 3-3 3M6.4 5l-3 3 3 3"/></svg>',
    commit: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.6v6.4M5.2 6.2 8 9l2.8-2.8M3 12.4h10"/></svg>',
    eye: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.4 8s2.2-3.4 5.6-3.4S13.6 8 13.6 8s-2.2 3.4-5.6 3.4S2.4 8 2.4 8Z"/><circle cx="8" cy="8" r="1.5"/></svg>',
    // 展开 / 收起：**双箭头**朝外 / 朝内（VS Code、IntelliJ 的通用写法）。
    // ⚠ 原来用 + / − —— 那个形状在工具行里读起来是"新建 / 删除"或"放大 / 缩小"，
    //   完全不像"缩进层级展开"（用户直接问"+ - 怎么能代表缩进展开"）。
    // ⚠ 每根 chevron 只占 2.6px 高、中间留 3.6px 空 —— 第一版画得太高（3.4px）且上下相接，
    //   16px 下两根会连成一个菱形/叉（截图里就是那样）。平缓之后才是"往外 / 往里"的双箭头。
    expandAll: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 6.2 8 3.6l2.8 2.6"/><path d="M5.2 9.8 8 12.4l2.8-2.6"/></svg>',
    collapseAll: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 3.6 8 6.2l2.8-2.6"/><path d="M5.2 12.4 8 9.8l2.8 2.6"/></svg>',
    // 这三个原来在标题行右侧。标题行 340px 放不下（标题 + 分支 + ahead/behind + 修改数 + 拉取/推送
    // 已经 310px 左右），多一个就整行换行 → 标题行比标签栏高一截、底线对不齐。
    // 移到工具行：它们本来就是"仓库级操作"，和刷新/回滚/差异同层。
    shelve: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.6" y="3.4" width="10.8" height="3" rx="1"/><path d="M3.6 6.4v5.6a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V6.4M6.6 9h2.8"/></svg>',
    remote: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 9.6a2.6 2.6 0 0 0 3.9.3l1.9-1.9a2.6 2.6 0 0 0-3.7-3.7l-1.1 1.1"/><path d="M9.6 6.4a2.6 2.6 0 0 0-3.9-.3L3.8 8a2.6 2.6 0 0 0 3.7 3.7l1.1-1.1"/></svg>',
    log: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.4"/></svg>',
    // 分支图标：与状态栏 (#sb-branch) 用同一枚 SVG。⚠ 别用字符 '⎇' ——
    // Windows 默认字体没有这个字形，会 fallback 成 '⌥' 之类完全不相干的符号（状态栏踩过）。
    branch: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.6" cy="4" r="1.6"/><circle cx="4.6" cy="12" r="1.6"/><circle cx="11.4" cy="7.4" r="1.6"/><path d="M4.6 5.6v4.8M6.2 5.2h3.4a1.8 1.8 0 0 1 1.8 1.8v.4"/></svg>',
    // 显示选项（工具行末尾的 Show Options Menu）：**眼睛 + 右下角小箭头**。
    //   ⚠ 原来是三个点 —— 三点在工具栏里的通用含义是"更多操作"，而 PyCharm 这里根本不是三点，
    //     是"眼睛 + 下拉箭头"（眼睛 = 显示什么，小箭头 = 这是个菜单）。
    //     用户拿 PyCharm 截图问"咱们还是三个点？"，就是这一处。
    //   ⚠ 眼睛要整体偏左上，把右下角让给箭头；两者不能重叠（16px 下会糊成一团）。
    viewOpts: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.4 6.6s2.2-3.3 5.5-3.3S12.4 6.6 12.4 6.6s-2.2 3.3-5.5 3.3S1.4 6.6 1.4 6.6Z"/><circle cx="6.9" cy="6.6" r="1.5"/><path d="M11.5 11.3l1.6 1.8 1.6-1.8"/></svg>',
    // M5：提交前检查 = 对勾（用在「⋯ 更多」菜单里的图标位）
    check: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 8.6l3.4 3.4 7.4-8"/></svg>',
    user: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.6" r="2.6"/><path d="M3.2 13.4c0-2.6 2.1-4.2 4.8-4.2s4.8 1.6 4.8 4.2"/></svg>',
  };

  // 文件路径 → 目录树（PyCharm 提交窗口式嵌套）
  function buildDirTree(items) {
    const root = { dirs: new Map(), files: [] };
    for (const c of items) {
      const segs = c.file.split(/[\\/]/);
      let node = root;
      for (let i = 0; i < segs.length - 1; i++) {
        if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], { dirs: new Map(), files: [] });
        node = node.dirs.get(segs[i]);
      }
      node.files.push(c);
    }
    return root;
  }

  // 递归渲染目录树：目录行（三态复选框 + 名称 + 计数）+ 文件行，按深度缩进
  function renderDirTree(node, depth, secKey, ro = false) {
    const box = document.createElement('div');
    box.className = 'git-group-body';
    const names = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const child = node.dirs.get(name);
      const count = treeCount(child);
      const pathKey = secKey + '/' + depth + '/' + name;
      const gTitle = document.createElement('div');
      gTitle.className = 'git-group';
      gTitle.style.paddingLeft = (8 + depth * 14) + 'px';
      const caret = document.createElement('span');
      caret.className = 'caret';
      const nm = document.createElement('span');
      nm.className = 'g-name';
      nm.textContent = name;
      const ct = document.createElement('span');
      ct.className = 'g-count';
      ct.textContent = count + ' 个文件';
      gTitle.appendChild(caret);
      // 只读分节的目录行同样不给复选框
      let cb = null;
      if (ro) {
        const lk = document.createElement('span');
        lk.className = 'cf-lock';
        lk.textContent = '·';
        gTitle.appendChild(lk);
      } else {
        cb = document.createElement('input');
        cb.type = 'checkbox';
        gTitle.appendChild(cb);
      }
      // 空占位：对齐文件行的徽章列，让"同层目录名 / 文件名"从同一个 x 起
      const bsp = document.createElement('span');
      bsp.className = 'badge-spacer';
      bsp.setAttribute('aria-hidden', 'true');
      gTitle.appendChild(bsp);
      gTitle.appendChild(nm);
      gTitle.appendChild(ct);
      gTitle.title = '点击收起 / 展开 ' + name;

      const gBody = renderDirTree(child, depth + 1, secKey, ro);
      const files = collectFiles(child);
      if (cb) {
        registerCheckNode(cb, files);
        cb.title = '勾选 / 取消 ' + name + ' 下的全部文件（' + files.length + '）';
        cb.onclick = (e) => e.stopPropagation();
        cb.onchange = () => setCheckedFiles(files, cb.checked);
      }

      const collapsed = dirCollapsed[pathKey] !== undefined ? !!dirCollapsed[pathKey] : dirAllCollapsed;
      caret.textContent = collapsed ? '▸' : '▾';
      if (collapsed) gBody.style.display = 'none';
      gTitle.onclick = (e) => {
        if (cb && e.target === cb) return;
        const col = gBody.style.display === 'none';
        gBody.style.display = col ? '' : 'none';
        caret.textContent = col ? '▾' : '▸';
        dirCollapsed[pathKey] = !col;
        saveUiPrefs();
      };
      box.appendChild(gTitle);
      box.appendChild(gBody);
    }
    for (const c of node.files.sort((a, b) => a.file.localeCompare(b.file))) {
      box.appendChild(fileRow(c, depth, false, ro));
    }
    return box;
  }

  // 目录子树里的全部文件（节点复选框作用范围）
  function collectFiles(node) {
    const out = node.files.map((c) => c.file);
    for (const d of node.dirs.values()) out.push(...collectFiles(d));
    return out;
  }

  function treeCount(node) {
    let n = node.files.length;
    for (const d of node.dirs.values()) n += treeCount(d);
    return n;
  }

  // 单个变更文件行：勾选框 + 状态徽章 + （平铺视图下）父目录 + 文件名 + 悬停回滚
  // ro=true（只读分节，如「已暂存」）：不给勾选框、不给回滚按钮 —— 只展示、不动作
  // 平铺视图里的路径前缀：首段 + … + 末段（`项目/…/数字人/`）。
  // 完整路径在 340px 面板里会把文件名挤到屏幕外，而中间那几层对"这是哪个文件"没帮助
  //（IDEA 的 breadcrumb、VS Code 的路径显示都是这么压的）。
  function shortDir(parent) {
    if (!parent) return '';
    const segs = String(parent).split(/[\\/]+/).filter(Boolean);
    if (!segs.length) return '';
    if (segs.length === 1) return segs[0] + '/';
    return segs[0] + '/…/' + segs[segs.length - 1] + '/';
  }

  // 平铺视图是否保留「父目录列」：只看**整份变更列表**里有没有带目录的文件
  //（顶层文件也要留这一列，否则它的名字会比别人靠左一整列）
  function flatNeedsDirCol() {
    const all = (state && state.changed) || [];
    return all.some((x) => /[\\/]/.test(x.file));
  }

  // ⚠ 缩进的铁律：**只有 depth 决定左边距**（目录行与文件行用同一个公式），
  //   列结构靠固定宽度的占位元素对齐：
  //     目录行 = [缩进][caret 10][gap][复选框 13][gap][空占位 22][gap][名字]…
  //     文件行 = [缩进][空占位 10][gap][复选框 13][gap][徽章 22][gap][名字]
  //   这样"同层的目录名与文件名对齐、子级正好比父级多一级"。
  //   以前文件行少一个 caret 占位、又没有徽章占位，结果**子文件的复选框和父目录的复选框在同一列**，
  //   层级完全看不出来（用户截图："文件和文件夹缩进一样"）。
  function fileRow(c, depth = 0, flat = false, ro = false) {
    const f = document.createElement('div');
    f.className = 'git-file' + (ro ? ' ro' : '');
    f.dataset.file = c.file;
    f.style.paddingLeft = (8 + depth * 14) + 'px';
    const parts = c.file.split(/[\\/]/);
    const base = parts.pop();
    const parent = parts.join('/');
    const isUntracked = c.status === 'added';
    const isIgnoredRow = c.status === 'ignored' || c.status === 'ignoredDir';
    // 徽章只显示单字母（PyCharm 式）：完整状态文案进 tooltip —— 每行重复「已删除（已暂存）」会把列表刷成一片文字
    const LETTER = { added: 'A', '*added': 'A', modified: 'M', '*modified': 'M', deleted: 'D', '*deleted': 'D', absent: '?' };
    const letter = isIgnoredRow ? '?' : (isUntracked ? '?' : (LETTER[c.status] || 'M'));
    const isStaged = !isIgnoredRow && c.status.charAt(0) === '*';
    const shown = isIgnoredRow && c.status === 'ignoredDir' ? base + '/' : base;
    // caret 占位：平铺视图也要（否则同一层级的目录名与文件名差一个 caret 列宽，看着就是没对齐）
    // ⚠⚠ 平铺视图 = **名字在前、路径在后**（第六版定论：照 PyCharm 抄，用户给过截图）。
    //   行结构： [缩进][勾选][徽章] **名字（固定宽，超出末尾省略）** 路径（灰色，吃剩余宽度，末尾省略）
    //   v1 路径在前、宽度自适应       → 文件名参差（"换个视角更离谱"）
    //   v2 路径在前、固定 72px        → 名字齐了，路径被截成 `项目/心理健...`（"缩进还是错的"）
    //   v3 名字在前、但名字列自适应    → **路径起点随名字长短漂移**（实测 120~161px）
    //   v4/v5 路径在前、固定 46%（右对齐 → 左对齐）→ 还是不对：顺序反了，名字被挤到右边
    //   🔴 根因：v3 的错不在"名字在前"，在**名字列宽度自适应**。PyCharm 的名字列是**固定宽**的，
    //      所以两列的起点都固定：名字对齐、路径也对齐（各自末尾省略）。
    const showDir = flat && flatNeedsDirCol();
    // ⚠ 只有平铺行用固定宽名字列（.flat）—— 树形行的名字要吃满剩余宽度，不能被截成 46%
    if (flat) f.classList.add('flat');
    f.innerHTML = '<span class="caret-spacer" aria-hidden="true"></span>' +
      (ro ? '<span class="cf-lock" title="已在 Git 暂存区：只展示，不做增删">·</span>'
                      : `<input type="checkbox" class="cf-check" data-file="${esc(c.file)}"${checked.has(c.file) ? ' checked' : ''}>`) +
      `<span class="badge ${c.status}${isStaged ? ' staged' : ''}" title="${esc(c.label)}">${letter}</span>` +
      `<span class="nm" title="${esc(c.file)}">${esc(shown)}</span>` +
      (showDir ? `<span class="dir" title="${esc(parent)}">${parent ? esc(shortDir(parent)) : ''}</span>` : '') +
      (isIgnoredRow || ro ? '' : `<span class="git-revert" title="${isUntracked ? '删除该文件' : '放弃该文件的修改'}">↺</span>`);
    f.title = ro
      ? c.label + ' · 已在 Git 暂存区（index）：本次提交不会带走它，也不会把它 unstage'
      : c.label + ' · 点击在编辑区查看差异' +
        ' · 双击' + (c.status === 'deleted' || c.status === '*deleted' ? '查看被删内容' : '打开文件') + ' · 右键更多操作';
    // 右键菜单（PyCharm 提交窗口式：差异 / 回滚 / 打开 / 复制路径）
    f.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = document.getElementById('ctx-menu');
      menu.innerHTML = '';
      const mk = (label, fn, danger) => {
        const d = document.createElement('div');
        d.className = 'ctx-item' + (danger ? ' danger' : '');
        d.textContent = label;
        d.onclick = () => { menu.classList.add('hidden'); fn(); };
        menu.appendChild(d);
      };
      mk('🔍 查看差异', () => {
        if (filesEl) filesEl.querySelectorAll('.git-file.sel').forEach((x) => x.classList.remove('sel'));
        f.classList.add('sel');
        showFileDiff(c);
      });
      if (c.status !== 'deleted' && c.status !== '*deleted') mk('📂 打开文件', () => {
        cancelDiff();
        if (root) Viewer.openFile(root + (root.includes('\\') ? '\\' : '/') + c.file);
      });
      mk('📋 复制完整路径', () => {
        if (root) { MI.copyText(root + (root.includes('\\') ? '\\' : '/') + c.file); MI.toast('已复制路径', 'ok'); }
      });
      mk('🕘 显示历史', () => { if (window.GitLog && GitLog.showFileHistory) GitLog.showFileHistory(root + (root.includes('\\') ? '\\' : '/') + c.file); });
      if (!isIgnoredRow && !ro) mk('📁 移入变更列表…（当前：' + clNameOf(clListOf(c.file)) + '）', () => openChangelistDialog(c.file));
      if (isIgnoredRow) {
        mk('✅ 不再忽略（从 .gitignore 移除）', async () => {
          const r = await gitSafe('removeFromGitignore', root, c.file);
          if (r.ok) { MI.toast('已从 .gitignore 移除 ' + c.file, 'ok'); invalidateIgnored(); refresh(); }
          else MI.toast('移除失败: ' + r.error, 'err');
        });
      } else if (!ro) {
        mk('🚫 添加到 .gitignore', async () => {
          const r = await gitSafe('addToGitignore', root, c.file);
          if (r.ok) { MI.toast(r.skipped ? '已在 .gitignore 中' : '已添加 ' + r.pattern + ' 到 .gitignore', 'ok'); invalidateIgnored(); refresh(); }
          else MI.toast('添加失败: ' + r.error, 'err');
        });
      }
      // ⚠ 只读分节（已暂存 / 非活动列表）不提供会改动 index 或工作区的操作：
      //    M1 不替用户处理暂存区，回滚/搁置/忽略放在这里会和 index 状态打架。
      if (!isIgnoredRow && !ro) mk('🗄 搁置此更改（Shelve）', () => openShelveDialog(c.file));
      if (!isIgnoredRow && !ro) mk(isUntracked ? '🗑 删除文件' : '↺ 回滚（放弃修改）', async () => {
        const tip = isUntracked ? `确定删除未版本控制文件「${c.file}」吗？` : `确定放弃「${c.file}」的所有修改吗？此操作不可恢复。`;
        const yes = await Modal.confirm(isUntracked ? '删除文件' : '放弃修改', tip);
        if (!yes) return;
        const r = await window.myIDE.git.discard(root, c.file);
        if (r.ok) { MI.toast(isUntracked ? '已删除 ' + c.file : '已放弃 ' + c.file + ' 的修改', 'ok'); refresh(); }
        else MI.toast('操作失败: ' + r.error, 'err');
      }, true);
      menu.classList.remove('hidden');
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
      menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
    };
    f.onclick = (e) => {
      if (e.target.type === 'checkbox' || e.target.closest('.git-revert')) return;
      // 选中态 + diff：统一在编辑区打开（PyCharm 默认行为）
      if (filesEl) filesEl.querySelectorAll('.git-file.sel').forEach((x) => x.classList.remove('sel'));
      f.classList.add('sel');
      showFileDiff(c);
    };
    f.ondblclick = (e) => {
      if (e.target.type === 'checkbox' || e.target.closest('.git-revert')) return;
      // 已删除文件磁盘上已不存在，编辑器打不开 → 双击直接看 diff（PyCharm 行为：显示被删内容）
      if (c.status === 'deleted' || c.status === '*deleted') {
        showFileDiff(c);
        return;
      }
      cancelDiff(); // 取消在途 diff，防止晚到的渲染覆盖刚打开的文件
      if (root) Viewer.openFile(root + (root.includes('\\') ? '\\' : '/') + c.file);
    };
    const cbEl = f.querySelector('.cf-check');   // 只读行没有勾选框
    if (cbEl) cbEl.onchange = (e) => {
      if (e.target.checked) checked.add(c.file);
      else checked.delete(c.file);
      updateCheckUI();
    };
    const revBtn = f.querySelector('.git-revert'); // 忽略的行没有回滚按钮
    if (revBtn) revBtn.onclick = async (e) => {
      e.stopPropagation();
      const tip = isUntracked ? `确定删除未版本控制文件「${c.file}」吗？` : `确定放弃「${c.file}」的所有修改吗？此操作不可恢复。`;
      const yes = await Modal.confirm(isUntracked ? '删除文件' : '放弃修改', tip);
      if (!yes) return;
      const r = await window.myIDE.git.discard(root, c.file);
      if (r.ok) { MI.toast(isUntracked ? '已删除 ' + c.file : '已放弃 ' + c.file + ' 的修改', 'ok'); refresh(); }
      else MI.toast('操作失败: ' + r.error, 'err');
    };
    return f;
  }

  // ---------- 提交 ----------
  async function doCommit(pushAfter, pushOpts, opts) {
    if (!root || !state || !state.isRepo) return;
    const files = [...checked];
    if (!files.length) { MI.toast('请至少勾选一个文件', 'err'); return; }
    const msgEl = document.getElementById('commit-msg');
    const text = (msgEl ? msgEl.value : '').trim();
    if (!text) { MI.toast('请填写提交消息', 'err'); focusMessage(); return; }
    const amendEl = document.getElementById('commit-amend');
    const amend = !!(amendEl && amendEl.checked);
    // M5：提交前检查。**有阻断项才打断**（弹结果面板）；只有提示时不拦，避免每次提交都点一次弹窗
    if (!(opts && opts.skipChecks) && preCfg.enabled) {
      const pre = await runPreChecks(files, text);
      if (pre.problems.length) {
        const go = await showPreCheckResult(pre);
        if (!go) { MI.toast('已取消提交（提交前检查没过）', 'err'); return; }
      }
    }
    // Sign-off 在这里追加、**不写进输入框**（PyCharm 同语义：避免重复追加、也不污染草稿/历史）
    const finalMsg = signoff ? await appendSignoff(text) : text;
    const btn = document.getElementById('cm-ok');
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    const r = await window.myIDE.git.commit(root, {
      message: finalMsg, files, amend, author: authorOverride || undefined,
    });
    if (btn) { btn.disabled = !checked.size; btn.textContent = '提交 (I)'; }
    if (r.ok) {
      pushMsgHistory(text);            // 提交消息进历史（🕘 下拉）
      commitMsg = '';
      lastDraft = '';
      amendBackup = null;
      saveDraft('');                   // 草稿随提交一起清掉
      checked.clear();
      if (msgEl) msgEl.value = '';
      if (amendEl) amendEl.checked = false;
      MI.toast('✅ 已提交 ' + r.oid.slice(0, 7) + '：' + text, 'ok');
      await refresh();
      if (window.GitLog && GitLog.isOpen()) GitLog.refresh();
      if (pushAfter) await doPush(true, pushOpts); // 提交并推送：提交成功后直接推，不再二次确认
    } else {
      MI.toast('提交失败: ' + r.error, 'err');
    }
  }

  // Ctrl+K 打开提交窗口后聚焦提交消息框
  function focusMessage() {
    const el = document.getElementById('commit-msg');
    if (!el) return;
    el.focus();
    try { el.selectionStart = el.selectionEnd = el.value.length; } catch {}
  }

  // 节点三态 / 提交按钮 / 计数联动（旧的「全选」单选框已被节点三态复选框取代）
  function updateCheckUI() {
    // 总数含「忽略的文件」（它们也能勾选 → 强制加入提交）
    const total = (state && state.changed ? state.changed.length : 0) + ignoredAll.size;
    for (const n of checkNodes) {
      const on = n.files.reduce((k, f) => k + (checked.has(f) ? 1 : 0), 0);
      n.input.checked = on > 0 && on === n.files.length;
      n.input.indeterminate = on > 0 && on < n.files.length;
    }
    const has = checked.size > 0;
    const btn = document.getElementById('cm-ok');
    if (btn) btn.disabled = !has;
    const btnp = document.getElementById('cm-ok-push');
    if (btnp) btnp.disabled = !has;
    const btnm = document.getElementById('cm-ok-push-menu');
    if (btnm) btnm.disabled = !has;
    if (barBtns) {
      // ⚠ 工具行里已经没有「提交」了（与底部 footer 重复，已删）——别再引用 barBtns.com
      barBtns.roll.disabled = !has;
      barBtns.dif.disabled = !has;
    }
    const count = document.getElementById('commit-count');
    if (count) {
      const staged = state && state.changed
        ? state.changed.filter((c) => c.status.charAt(0) === '*' && checked.has(c.file)).length : 0;
      count.textContent = has ? `${checked.size}/${total} 个文件` + (staged ? ` · ${staged} 个已暂存` : '') : '';
      count.title = '勾选的文件数 / 全部变更文件数' + (staged ? '（其中已在暂存区的数量）' : '');
    }
  }

  // ---------- 回滚选中 ----------
  async function rollbackChecked() {
    if (!checked.size) { MI.toast('没有勾选的文件', 'err'); return; }
    const files = [...checked].filter((f) => !ignoredAll.has(f)); // 忽略的文件不参与回滚（回滚=删除）
    if (!files.length) { MI.toast('勾选的只有被忽略的文件，它们不参与回滚', 'err'); return; }
    const untracked = files.filter((f) => {
      const c = state.changed.find((x) => x.file === f);
      return c && c.status === 'added';
    });
    const shown = files.slice(0, 10).join('\n') + (files.length > 10 ? `\n… 共 ${files.length} 个` : '');
    const tip = untracked.length ? `\n（其中 ${untracked.length} 个未版本控制文件将被删除）` : '';
    const yes = await Modal.confirm('回滚选中', `确定放弃以下 ${files.length} 个文件的修改吗？此操作不可恢复。\n\n${shown}${tip}`);
    if (!yes) return;
    const r = await window.myIDE.git.discardFiles(root, files);
    if (r.failed.length) MI.toast(`${r.ok} 个已回滚，${r.failed.length} 个失败：${r.failed[0].error}`, 'err');
    else MI.toast(`已回滚 ${r.ok} 个文件`, 'ok');
    refresh();
  }

  // ---------- 显示选中差异（编辑区堆叠多文件） ----------
  async function diffChecked() {
    if (!checked.size) { MI.toast('没有勾选的文件', 'err'); return; }
    const files = [...checked].filter((f) => !ignoredAll.has(f)); // 忽略的文件没有 HEAD 版本可比
    if (!files.length) { MI.toast('勾选的只有被忽略的文件', 'err'); return; }
    const results = [];
    for (const f of files) {
      const c = state && state.changed ? state.changed.find((x) => x.file === f) : null;
      // M3：按双区取差异（「已暂存」的文件看暂存区那一侧，其余看未暂存那一侧）
      const r = c && c.inIndexOnly
        ? await window.myIDE.git.diffStaged(root, f)
        : await window.myIDE.git.diffUnstaged(root, f);
      if (r && !r.error && !r.unchanged) results.push(r);
    }
    if (!results.length) { MI.toast('勾选的文件没有可显示的差异', 'err'); return; }
    renderDiffView(results, `选中 ${results.length} 个文件 · 未暂存 / 已暂存`,
      { sideOf: (f) => diffSideOf(state && state.changed ? state.changed.find((x) => x.file === f) : null), onHunk: hunkAction });
  }

  // ---------- 搁置（Shelve）弹窗：上=搁置当前更改（名称+文件勾选），下=已搁置列表（恢复/删除） ----------
  async function openShelveDialog(preselect) {
    if (!root) { MI.toast('请先打开一个文件夹', 'err'); return; }
    // 需要当前改动列表（搁置区）
    const st = await window.myIDE.git.status(root);
    const changed = (st && st.changed) || [];
    const listR = await window.myIDE.git.shelveList(root);
    const shelves = (listR && listR.shelves) || [];

    const box = document.createElement('div');
    box.id = 'sv-box';
    Modal.show(box);
    box.innerHTML = `
      <div class="m-head">搁置更改（Shelve）<span class="x" id="sv-x">✕</span></div>
      <div class="m-body">
        ${changed.length ? `
        <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:6px">搁置当前更改（保存工作区改动并回滚文件，之后可恢复）</div>
        <div class="br-new" style="margin-bottom:6px">
          <input id="sv-name" type="text" placeholder="搁置名称（可选）" spellcheck="false" style="flex:1">
          <button class="tb-btn primary" id="sv-create">🗄 搁置所选</button>
        </div>
        <div id="sv-files" style="max-height:160px;overflow:auto;border:1px solid var(--border-mid);border-radius:4px;padding:4px 0;margin-bottom:12px"></div>` : `
        <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:12px">当前没有未提交的更改可搁置</div>`}
        <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:6px">已搁置的更改（${shelves.length}）</div>
        <div id="sv-list" style="max-height:220px;overflow:auto">${shelves.length ? '' : '<div style="font-size:12px;color:var(--text-dim);padding:8px 2px">暂无搁置记录</div>'}</div>
      </div>`;
    box.querySelector('#sv-x').onclick = () => Modal.hide();

    // 搁置区：文件复选框（默认全选；preselect 则只选该文件）
    if (changed.length) {
      const filesEl = box.querySelector('#sv-files');
      for (const c of changed) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:3px 10px;font-size:12px;cursor:pointer';
        const checked = preselect ? c.file === preselect : true;
        row.innerHTML = `<input type="checkbox" data-file="${esc(c.file)}" ${checked ? 'checked' : ''}>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.file)}</span>
          <span style="color:var(--text-dim)">${esc(c.label || c.status)}</span>`;
        filesEl.appendChild(row);
      }
      box.querySelector('#sv-create').onclick = async () => {
        const files = [...filesEl.querySelectorAll('input:checked')].map((x) => x.dataset.file);
        if (!files.length) { MI.toast('请至少勾选一个文件', 'err'); return; }
        const name = box.querySelector('#sv-name').value.trim();
        const r = await window.myIDE.git.shelveCreate(root, { name, files });
        if (r.ok) {
          MI.toast('✅ 已搁置 ' + r.files + ' 个文件（工作区已回滚）', 'ok');
          Modal.hide();
          refresh();
        } else MI.toast('搁置失败: ' + r.error, 'err');
      };
    }

    // 已搁置列表：恢复 / 删除 / 展开文件
    const listEl = box.querySelector('#sv-list');
    for (const s of shelves) {
      const row = document.createElement('div');
      row.style.cssText = 'border:1px solid var(--border-mid);border-radius:4px;padding:6px 10px;margin-bottom:6px';
      row.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center">
          <span class="sv-toggle" style="cursor:pointer;color:var(--text-dim)">▸</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.name)}"><b>${esc(s.name)}</b></span>
          <span style="color:var(--text-dim);font-size:11px;white-space:nowrap">${s.branch ? esc(s.branch) + ' · ' : ''}${fmtDate(s.createdAt)} · ${s.files.length} 个文件</span>
          <button class="tb-btn" title="恢复到工作区">⬇ 恢复</button>
          <button class="tb-btn" title="删除该搁置" style="color:var(--danger,#e06c75)">🗑</button>
        </div>
        <div class="sv-files" style="display:none;padding:4px 10px 2px 22px"></div>`;
      const filesEl2 = row.querySelector('.sv-files');
      for (const f of s.files) {
        const d = document.createElement('div');
        d.style.cssText = 'font-size:11.5px;color:var(--text-dim);padding:1px 0';
        d.textContent = f.path + '（' + (f.status === 'deleted' ? '已删除' : f.status === 'added' ? '新增' : '修改') + '）';
        filesEl2.appendChild(d);
      }
      row.querySelector('.sv-toggle').onclick = (e) => {
        const open = filesEl2.style.display !== 'none';
        filesEl2.style.display = open ? 'none' : 'block';
        e.target.textContent = open ? '▸' : '▾';
      };
      const [applyBtn, delBtn] = row.querySelectorAll('button');
      applyBtn.onclick = async () => {
        let r = await window.myIDE.git.shelveApply(root, s.id);
        if (r.conflict) {
          // 目标文件有未提交改动 → 询问强制覆盖
          const yes = await Modal.confirm('恢复搁置', r.error + '\n\n强制覆盖这些文件并继续恢复吗？');
          if (!yes) return;
          r = await window.myIDE.git.shelveApply(root, s.id, { force: true });
        }
        if (r.ok) { MI.toast('✅ 已恢复 ' + r.files + ' 个文件到工作区', 'ok'); Modal.hide(); refresh(); }
        else MI.toast('恢复失败: ' + r.error, 'err');
      };
      delBtn.onclick = async () => {
        const yes = await Modal.confirm('删除搁置', `确定删除搁置「${s.name}」吗？其中的改动将无法恢复。`);
        if (!yes) return;
        const r = await window.myIDE.git.shelveDelete(root, s.id);
        if (r.ok) { MI.toast('已删除搁置', 'ok'); row.remove(); }
        else MI.toast('删除失败: ' + r.error, 'err');
      };
      listEl.appendChild(row);
    }
  }

  // ---------- 「移入变更列表」弹窗（M1：命名分组 + 活动列表）----------
  function openChangelistDialog(file) {
    if (!root) return;
    const cur = clListOf(file);
    const box = document.createElement('div');
    box.id = 'cl-box';
    Modal.show(box);
    const all = [{ id: 'default', name: 'Default' }].concat(cls.lists.map((l) => ({ id: l.id, name: l.name })));
    box.innerHTML = `
      <div class="m-head">移入变更列表 <span class="x" id="cl-x">✕</span></div>
      <div class="m-body">
        <div class="cl-file" title="${esc(file)}">${esc(file)}</div>
        <div class="cl-cur">当前：<b>${esc(clNameOf(cur))}</b> · 活动列表：<b>${esc(clNameOf(cls.active))}</b></div>
        <div id="cl-list"></div>
        <div class="br-new" style="margin-top:10px">
          <input id="cl-new-input" type="text" placeholder="新建变更列表名…" spellcheck="false">
          <button class="tb-btn" id="cl-new-btn">＋ 新建并移入</button>
        </div>
        <div class="cl-tip">活动列表里的文件才会出现在「更改」里、可勾选提交；其它列表只展示、不参与本次提交。<br>
          列表归属存在项目里的 <code>.myide/changelists.json</code>（不进 Git 历史）。</div>
      </div>`;
    box.querySelector('#cl-x').onclick = () => Modal.hide();
    const listBox = box.querySelector('#cl-list');
    for (const l of all) {
      const row = document.createElement('div');
      row.className = 'cl-item' + (l.id === cur ? ' cur' : '') + (l.id === cls.active ? ' active' : '');
      row.innerHTML = `<span class="cl-nm">${esc(l.name)}</span>` +
        (l.id === cls.active ? '<span class="cl-badge">活动</span>' : '') +
        (l.id === cur ? '<span class="cl-badge cur-badge">当前</span>' : '') +
        `<button class="tb-btn cl-set" title="把「${esc(l.name)}」设为活动列表">设为活动</button>` +
        `<button class="tb-btn cl-move" title="把此文件移入「${esc(l.name)}」">移入</button>`;
      row.querySelector('.cl-move').onclick = () => { Modal.hide(); clMoveTo(file, l.id); };
      row.querySelector('.cl-set').onclick = () => { clSetActive(l.id); Modal.hide(); };
      listBox.appendChild(row);
    }
    const ni = box.querySelector('#cl-new-input');
    box.querySelector('#cl-new-btn').onclick = () => {
      const name = ni.value.trim();
      if (!name) { MI.toast('请输入列表名', 'err'); return; }
      const id = clNew(name);
      Modal.hide();
      clMoveTo(file, id);
    };
    ni.addEventListener('keydown', (e) => { if (e.key === 'Enter') box.querySelector('#cl-new-btn').click(); });
    setTimeout(() => { try { ni.focus(); } catch {} }, 0);
  }

  // ---------- 分支切换弹窗 ----------
  async function openBranchDialog() {
    if (!root) return;
    const r = await window.myIDE.git.branches(root);
    if (r.error) { MI.toast(r.error, 'err'); return; }
    // merge / rebase / 删除 / 改名 都要本机 git（isomorphic 没有）→ 没有就少给几项，而不是点了报错
    const bi = await gitSafe('backendInfo', false);
    const canOps = !!(bi && bi.caps && bi.caps.merge && bi.caps.rebase);
    const afterSwitch = () => { if (window.GitLog && GitLog.isOpen()) GitLog.refresh(); };
    const box = document.createElement('div');
    box.id = 'br-box';
    Modal.show(box);
    box.innerHTML = `
      <div class="m-head">🔀 分支与标签 <span class="x" id="br-x">✕</span></div>
      <div class="m-body">
        <div class="br-new">
          <input id="br-new-input" type="text" placeholder="新建分支名…" spellcheck="false">
          <button class="tb-btn" id="br-new-btn">＋ 新建</button>
        </div>
        <div id="br-list" style="max-height:240px;overflow:auto"></div>
        <div id="br-remotes" style="border-top:1px solid var(--border-mid);margin-top:8px;padding-top:8px;max-height:180px;overflow:auto"></div>
        <div id="br-tags" style="border-top:1px solid var(--border-mid);margin-top:8px;padding-top:8px;max-height:180px;overflow:auto"></div>
      </div>`;
    document.getElementById('br-x').onclick = () => Modal.hide();
    const newInput = document.getElementById('br-new-input');
    const newBtn = document.getElementById('br-new-btn');
    newBtn.onclick = async () => {
      const name = newInput.value.trim();
      if (!name) { MI.toast('请输入分支名', 'err'); return; }
      const cr = await window.myIDE.git.createBranch(root, name);
      if (cr.ok) {
        Modal.hide();
        MI.toast('✅ 已创建并切换到分支 ' + name, 'ok');
        refresh();
        afterSwitch();
      } else {
        MI.toast('创建失败: ' + cr.error, 'err');
      }
    };
    newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') newBtn.click(); });
    const list = document.getElementById('br-list');
    // 标签区（点击 checkout 到该标签，detached HEAD）
    const tagsBox = document.getElementById('br-tags');
    const tr = await window.myIDE.git.listTags(root);
    if (tagsBox) {
      tagsBox.innerHTML = '';
      const tHead = document.createElement('div');
      tHead.style.cssText = 'font-size:12px;color:var(--text-dim);margin-bottom:4px';
      tHead.textContent = '标签' + (tr.tags && tr.tags.length ? ' (' + tr.tags.length + ')' : '');
      tagsBox.appendChild(tHead);
      if (!tr.tags || !tr.tags.length) {
        const d = document.createElement('div');
        d.className = 'git-empty';
        d.textContent = '暂无标签';
        tagsBox.appendChild(d);
      } else {
        for (const t of tr.tags.slice(0, 50)) {
          const row = document.createElement('div');
          row.className = 'br-item';
          row.innerHTML = `<span style="color:var(--accent)">🏷</span><span class="rm-name">${esc(t.name)}</span>` +
            `<span class="rm-url" title="${esc(t.message || '')}">${esc(t.message || '')}</span><span class="gl-date" style="margin-left:auto">${fmtDate(t.timestamp)}</span>`;
          row.title = '点击检出（detached）：' + t.name;
          row.onclick = async () => {
            const cr = await window.myIDE.git.checkout(root, t.name);
            if (cr.ok) {
              Modal.hide();
              MI.toast('✅ 已检出到标签 ' + t.name + '（detached HEAD）', 'ok');
              refresh();
              afterSwitch();
            } else {
              MI.toast('检出失败: ' + cr.error, 'err');
            }
          };
          tagsBox.appendChild(row);
        }
      }
    }
    // 远程分支（M4 收尾）：本地分支列表下面单独一节 —— PyCharm Branches 的 Remote 分区。
    // 没接本机 git（caps）时这些操作做不了 → 整节不给，而不是给了点不动。
    const remoteBox = document.getElementById('br-remotes');
    if (remoteBox) {
      remoteBox.innerHTML = '';
      const rHead = document.createElement('div');
      rHead.style.cssText = 'font-size:12px;color:var(--text-dim);margin-bottom:4px';
      rHead.textContent = '远程分支' + (r.remotes && r.remotes.length ? ' (' + r.remotes.length + ')' : '');
      remoteBox.appendChild(rHead);
      if (r.upstream) {
        const up = document.createElement('div');
        up.className = 'br-item br-up';
        up.innerHTML = '<span class="br-cur"></span><span class="rm-name"></span>';
        up.querySelector('.rm-name').textContent = '当前分支跟踪 ' + r.upstream;
        up.title = 'pull / push 的默认去向';
        const un = document.createElement('span');
        un.className = 'br-more'; un.textContent = '解除'; un.style.opacity = '1';
        un.title = '解除当前分支的 upstream 跟踪';
        un.onclick = async (e) => {
          e.stopPropagation();
          const cr = await gitSafe('unsetUpstream', root);
          if (!cr || !cr.ok) { MI.toast((cr && cr.error) || '解除失败', 'err'); return; }
          MI.toast('已解除 upstream 跟踪', 'ok'); Modal.hide(); refresh();
        };
        up.appendChild(un);
        remoteBox.appendChild(up);
      }
      if (!canOps) {
        const d = document.createElement('div');
        d.className = 'git-empty';
        d.textContent = r.remotes && r.remotes.length ? '远程分支操作需要本机 git（设置 → Git → 原生 Git 后端）' : '暂无远程分支';
        remoteBox.appendChild(d);
      } else {
        for (const rb of (r.remotes || []).slice(0, 30)) {
          const row = document.createElement('div');
          row.className = 'br-item';
          row.innerHTML = '<span class="br-cur" style="color:var(--text-dim)">⇱</span><span class="rm-name"></span><span class="br-more" title="更多操作">⋯</span>';
          row.querySelector('.rm-name').textContent = rb;
          row.title = rb + '（点击 ⋯ 看操作；检出会新建同名本地分支）';
          row.querySelector('.br-more').onclick = (e) => {
            e.stopPropagation();
            const short = rb.includes('/') ? rb.slice(rb.indexOf('/') + 1) : rb;
            openFloatMenu(e.currentTarget, [
              { label: '检出为本地分支…', title: '以 ' + rb + ' 为起点新建并切换到 ' + short, run: async () => {
                  const name = await Modal.prompt('检出远程分支', '本地分支名', short);
                  if (!name) return;
                  const cr = await gitSafe('branchCreate', root, name, rb, true);
                  if (!cr || !cr.ok) { MI.toast((cr && cr.error) || '检出失败', 'err'); return; }
                  Modal.hide(); MI.toast('✅ 已检出 ' + name + '（跟踪 ' + rb + '）', 'ok'); refresh(); afterSwitch();
                } },
              { label: '合并「' + rb + '」到当前分支', title: 'git merge ' + rb + '（出冲突进解决流程）', run: async () => {
                  Modal.hide();
                  const mr = await gitSafe('merge', root, rb);
                  if (!mr || !mr.ok) { MI.toast((mr && mr.error) || '合并失败', 'err'); await refresh(); return; }
                  await refresh();
                  if (mr.conflict) MI.toast('⚠ 合并出现冲突，请在上方「解决冲突」里处理', 'err');
                  else MI.toast('✅ 已合并 ' + rb, 'ok');
                } },
              { label: '把当前分支变基到「' + rb + '」', title: 'git rebase ' + rb + '（出冲突进解决流程）', run: async () => {
                  Modal.hide();
                  const rr = await gitSafe('rebase', root, rb);
                  if (!rr || !rr.ok) { MI.toast((rr && rr.error) || '变基失败', 'err'); await refresh(); return; }
                  await refresh();
                  if (rr.conflict) MI.toast('⚠ 变基出现冲突，请在上方「解决冲突」里处理', 'err');
                  else MI.toast('✅ 已变基到 ' + rb, 'ok');
                } },
              { label: '设为当前分支的 upstream', title: 'pull / push 的默认去向改为 ' + rb, run: async () => {
                  const cr = await gitSafe('setUpstream', root, rb);
                  if (!cr || !cr.ok) { MI.toast((cr && cr.error) || '设置失败', 'err'); return; }
                  MI.toast('✅ 当前分支已跟踪 ' + rb, 'ok'); Modal.hide(); refresh();
                } },
            ]);
          };
          remoteBox.appendChild(row);
        }
      }
    }
    if (!r.branches.length) {
      list.innerHTML = '<div class="git-empty">暂无分支</div>';
      return;
    }
    for (const b of r.branches) {
      const row = document.createElement('div');
      row.className = 'br-item' + (b === r.current ? ' current' : '');
      row.innerHTML = `<span class="br-cur">${b === r.current ? '✓' : ''}</span><span class="rm-name">${esc(b)}</span><span class="br-more" title="更多分支操作">⋯</span>`;
      row.title = b === r.current ? '当前分支' : '点击切换到 ' + b;
      row.onclick = async (e) => {
        if (e.target.closest('.br-more')) return;  // ⋯ 自己有菜单
        if (b === r.current) return;
        const cr = await window.myIDE.git.checkout(root, b);
        if (cr.ok) {
          Modal.hide();
          MI.toast('✅ 已切换到分支 ' + b, 'ok');
          refresh();
          afterSwitch();
        } else {
          MI.toast('切换失败: ' + cr.error, 'err');
        }
      };
      // M4-C：分支操作菜单（PyCharm Branches 的那套：从它新建 / 合并进来 / 变基上去 / 改名 / 删除）
      const isCur = b === r.current;
      row.querySelector('.br-more').onclick = (e) => {
        e.stopPropagation();
        const items = [];
        if (!isCur) items.push({ label: '检出 ' + b, run: () => row.click() });
        items.push({ label: '从「' + b + '」新建分支…', title: '以 ' + b + ' 为起点建新分支（不必先切过去）', run: async () => {
          const name = await Modal.prompt('从「' + b + '」新建分支', '新分支名', '');
          if (!name) return;
          const cr = await gitSafe('branchCreate', root, name, b, true);
          if (!cr || !cr.ok) { MI.toast((cr && cr.error) || '创建失败', 'err'); return; }
          Modal.hide(); MI.toast('✅ 已从 ' + b + ' 创建并切换到 ' + name, 'ok'); refresh(); afterSwitch();
        } });
        if (!isCur && canOps) {
          items.push({ label: '合并「' + b + '」到当前分支', title: 'git merge ' + b + '（产生冲突会进入解决流程）', run: async () => {
            Modal.hide();
            const mr = await gitSafe('merge', root, b);
            if (!mr || !mr.ok) { MI.toast((mr && mr.error) || '合并失败', 'err'); await refresh(); return; }
            await refresh();
            if (mr.conflict) MI.toast('⚠ 合并出现冲突，请在上方「解决冲突」里处理', 'err');
            else MI.toast('✅ 已合并 ' + b, 'ok');
          } });
          items.push({ label: '把当前分支变基到「' + b + '」', title: 'git rebase ' + b + '（产生冲突会进入解决流程）', run: async () => {
            Modal.hide();
            const rr = await gitSafe('rebase', root, b);
            if (!rr || !rr.ok) { MI.toast((rr && rr.error) || '变基失败', 'err'); await refresh(); return; }
            await refresh();
            if (rr.conflict) MI.toast('⚠ 变基出现冲突，请在上方「解决冲突」里处理', 'err');
            else MI.toast('✅ 已变基到 ' + b, 'ok');
          } });
        }
        if (canOps) items.push({ label: '重命名为…', run: async () => {
          const nn = await Modal.prompt('重命名分支', '新分支名', b);
          if (!nn || nn === b) return;
          const cr = await gitSafe('branchRename', root, b, nn);
          if (!cr || !cr.ok) { MI.toast((cr && cr.error) || '重命名失败', 'err'); return; }
          MI.toast('✅ 已重命名 ' + b + ' → ' + nn, 'ok');
          Modal.hide(); refresh(); afterSwitch();
        } });
        if (!isCur) items.push({ label: '删除「' + b + '」', danger: true, run: async () => {
          const yes = await Modal.confirm('删除分支', '确定删除分支「' + b + '」吗？\n未合并的提交会被 git 拒绝（更安全）；确认强删会丢弃它们。');
          if (!yes) return;
          let cr = await gitSafe('branchDelete', root, b, false);
          if (!cr || !cr.ok) {
            // -d 被拒（有未合并提交）→ 问一次是否强删，不悄悄替用户做决定
            const force = await Modal.confirm('分支有未合并的提交', (cr && cr.error || '删除被拒绝') + '\n\n强删（-D）会永久丢弃这些提交。确定吗？');
            if (!force) return;
            cr = await gitSafe('branchDelete', root, b, true);
          }
          if (!cr || !cr.ok) { MI.toast((cr && cr.error) || '删除失败', 'err'); return; }
          MI.toast('已删除分支 ' + b, 'ok');
          Modal.hide(); refresh();
        } });
        openFloatMenu(e.currentTarget, items);
      };
      list.appendChild(row);
    }
  }

  // ---------- Diff：主编辑区渲染（PyCharm 式，不挤侧栏） ----------
  // 令牌法：双击打开文件 / 新 diff 请求使在途请求失效（晚到的渲染不再覆盖新视图）
  let diffSeq = 0;
  function cancelDiff() { diffSeq++; }
  // ---------- M3：双区差异 ----------
  // 「更改」里的文件看 **index → 工作区**（还没进暂存区的那部分）；「已暂存」里的看 **HEAD → index**
  // （已经进暂存区、下次提交会带走的那部分）。文件同时有暂存与未暂存改动时两边各自成立。
  // 双区差异才有意义的东西：hunk 级暂存按钮（`act`）。
  const diffSideOf = (c) => (c && c.inIndexOnly ? 'staged' : 'unstaged');
  const SIDE_LABEL = { unstaged: '未暂存（工作区 vs 暂存区）', staged: '已暂存（暂存区 vs HEAD）' };

  async function hunkAction(file, kind, idx) {
    if (!root) return;
    if (kind === 'revert') {
      const yes = await Modal.confirm('回退这一块', '会把工作区的这一处改动丢弃（其它块不受影响）。不可恢复，确定吗？');
      if (!yes) return;
    }
    const api = window.myIDE.git;
    const r = kind === 'stage' ? await api.stageHunk(root, file, idx)
      : kind === 'unstage' ? await api.unstageHunk(root, file, idx)
        : await api.revertHunk(root, file, idx);
    if (!r || !r.ok) { MI.toast((r && r.error) || '操作失败', 'err'); return; }
    MI.toast(kind === 'stage' ? '已暂存这一块' : kind === 'unstage' ? '已取消暂存这一块' : '已回退这一块', 'ok');
    await refresh();                                   // 列表状态变了（可能进出「已暂存」）
    const c = state && state.changed ? state.changed.find((x) => x.file === file) : null;
    if (c) await showFileDiff(c);                      // 重新打开：那块已从当前视图消失
  }

  async function showFileDiff(c) {
    if (!root) return;
    const seq = ++diffSeq;
    const both = !c.inIndexOnly && String(c.status || '').charAt(0) === '*';  // 同一个文件既有暂存又有未暂存
    let r;
    if (c.inIndexOnly) r = await window.myIDE.git.diffStaged(root, c.file);
    else if (both) {
      // 双区并排：先「已暂存（HEAD→index）」再「未暂存（index→工作区）」，
      // 两块各挂各的按钮（暂存 / 取消暂存 / 回退），这就是 PyCharm 那套「一个文件里挑着提交」的入口
      const a = await window.myIDE.git.diffStaged(root, c.file);
      const b = await window.myIDE.git.diffUnstaged(root, c.file);
      r = [a, b].filter((x) => x && !x.error && !x.unchanged && x.hunks && x.hunks.length);
      if (!r.length) r = b;
    } else r = await window.myIDE.git.diffUnstaged(root, c.file);
    if (seq !== diffSeq) return;
    if (Array.isArray(r)) {
      renderDiffView(r, '已暂存 + 未暂存（同一个文件挑着提交）', { sideOf: () => 'both', onHunk: hunkAction });
      return;
    }
    if (r.error) { MI.toast(r.error, 'err'); return; }
    if (r.unchanged) { MI.toast('文件无差异', 'ok'); return; }
    const side = r.side || diffSideOf(c);
    renderDiffView(r, SIDE_LABEL[side], { side, sideOf: () => side, onHunk: hunkAction });
  }

  // diff hunk 导航：滚动到相邻 @@ 分隔行（循环）
  let hunkNavIdx = 0;
  function makeHunkNav() {
    const wrap = document.createElement('span');
    wrap.className = 'df-nav';
    const prev = document.createElement('button');
    prev.className = 'vt-btn';
    prev.textContent = '⤒';
    prev.title = '上一个 hunk';
    const next = document.createElement('button');
    next.className = 'vt-btn';
    next.textContent = '⤓';
    next.title = '下一个 hunk';
    const label = document.createElement('span');
    label.className = 'df-nav-label';
    const refresh = () => {
      const gaps = [...document.querySelectorAll('.diff-hunk-gap')];
      if (!gaps.length) { label.textContent = ''; return; }
      label.textContent = (hunkNavIdx % gaps.length + gaps.length) % gaps.length + 1 + '/' + gaps.length;
    };
    const go = (dir) => {
      const gaps = [...document.querySelectorAll('.diff-hunk-gap')];
      if (!gaps.length) return;
      hunkNavIdx += dir;
      const i = ((hunkNavIdx % gaps.length) + gaps.length) % gaps.length;
      try { gaps[i].scrollIntoView({ block: 'center' }); } catch {}
      gaps.forEach((x, j) => x.classList.toggle('nav-target', j === i));
      refresh();
    };
    prev.onclick = () => go(-1);
    next.onclick = () => go(1);
    wrap.appendChild(prev);
    wrap.appendChild(next);
    wrap.appendChild(label);
    setTimeout(refresh, 0); // 等 diff 表格渲染完成后再统计 hunk
    return wrap;
  }

  // 构建 diff 表格（hunk 折叠逻辑），供提交窗口 / 日志窗口共用
  // act（M3）：可选。给了就在每个 hunk 头挂上该模式下允许的操作按钮。
  //   side='unstaged'（index→工作区）→「暂存此块」「回退此块」
  //   side='staged'  （HEAD→index）  →「取消暂存此块」
  //   其他来源（提交详情 / 分支对比）不传 act → 纯只读。
  // opts.hideTitle：调用方（renderDiffView）**只有一个文件**时已经在顶部显示过路径 + 侧别，
  //   表格再画一次就是同一行文字出现两遍（用户截图指出过）。多文件堆叠时每块仍然需要自己的标题。
  function buildDiffTable(r, act, opts) {
    const fileBox = document.createElement('div');
    fileBox.className = 'diff-file';
    if (!(opts && opts.hideTitle)) {
      const title = document.createElement('div');
      title.className = 'diff-file-title';
      // 同一个文件「已暂存 + 未暂存」两块并排时标题会重名 → 带上侧的标记，否则两块看不出谁是谁
      const sideTag = r.side === 'staged' ? '<span class="side-tag staged">已暂存</span>'
        : r.side === 'unstaged' ? '<span class="side-tag">未暂存</span>' : '';
      title.innerHTML = `<span class="b">${esc(r.file)}</span>${sideTag}`;
      fileBox.appendChild(title);
    }
    if (r.binary) {
      const msg = document.createElement('div');
      msg.className = 'diff-msg';
      msg.textContent = '🧱 二进制文件，不支持文本对比（git diff 同款行为）';
      fileBox.appendChild(msg);
      return fileBox;
    }
    if (r.tooLarge) {
      const msg = document.createElement('div');
      msg.className = 'diff-msg';
      msg.textContent = '📦 文件过大（' + (r.size / 1048576).toFixed(1) + ' MB），超出 20MB 对比限制';
      fileBox.appendChild(msg);
      return fileBox;
    }
    if (!r.hunks || !r.hunks.length) {
      const msg = document.createElement('div');
      msg.className = 'diff-msg';
      msg.textContent = '无内容差异';
      fileBox.appendChild(msg);
      return fileBox;
    }
    const table = document.createElement('table');
    table.className = 'diff-table';
    // table-layout:fixed 的列宽只看第一行/colgroup；首行是 colspan=4 的 hunk 行，
    // 不加 colgroup 会四列均分 → 行号列撑成 1/4 窗口宽（大片空白根因）
    const cg = document.createElement('colgroup');
    cg.innerHTML = '<col class="c-old"><col class="c-ln"><col class="c-num"><col class="c-new">';
    table.appendChild(cg);
    r.hunks.forEach((h, hIdx) => {
      const sep = document.createElement('tr');
      sep.className = 'diff-hunk-gap';
      sep.innerHTML = `<td colspan="4">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@<span class="hint"></span></td>`;
      if (act && act.onHunk) {
        // 多文件视图里每个文件的侧可能不同（有的已暂存、有的没有）→ 先用结果自带的 side，
        // 没有再按文件解析（同一个文件「已暂存 + 未暂存」两块并排时，只能靠 r.side 区分）
        const side = r.side || (act.sideOf ? act.sideOf(r.file) : act.side);
        const td = sep.querySelector('td');
        const box = document.createElement('span');
        box.className = 'hunk-actions';
        const mk = (label, kind, title, danger) => {
          const b = document.createElement('button');
          b.className = 'vt-btn hunk-act' + (danger ? ' danger' : '');
          b.textContent = label;
          b.title = title;
          b.onclick = (e) => { e.stopPropagation(); act.onHunk(r.file, kind, hIdx); };
          box.appendChild(b);
        };
        if (side === 'unstaged') {
          mk('＋ 暂存此块', 'stage', '只把这一块加进暂存区（git add -p 的那一步）');
          mk('↺ 回退此块', 'revert', '只把工作区的这一块改回暂存区的样子（丢弃这处修改）', true);
        } else if (side === 'staged') {
          mk('－ 取消暂存此块', 'unstage', '把这一块从暂存区撤出来，改动仍留在工作区');
        }
        td.appendChild(box);
      }
      table.appendChild(sep);
      const rows = [];
      for (const row of h.rows) {
        const tr = document.createElement('tr');
        // PyCharm 式左右分栏，行号列居中：[旧内容|旧行号 ‖ 新行号|新内容]
        // 空白侧只留底色（empty），不上红绿：add 行左半、del 行右半不是变更内容
        const oldCls = row.type === 'add' ? 'empty' : row.type;
        const newCls = row.type === 'del' ? 'empty' : row.type;
        tr.innerHTML = `<td class="old ${oldCls}">${esc(row.aText)}</td>` +
          `<td class="ln">${row.aNum || ''}</td><td class="num">${row.bNum || ''}</td>` +
          `<td class="new ${newCls}">${esc(row.bText)}</td>`;
        rows.push(tr);
      }
      rows.forEach((tr) => table.appendChild(tr));
      // 折叠开关：超过 30 行默认折叠
      const setOpen = (open) => {
        sep.dataset.open = open ? '1' : '';
        sep.querySelector('.hint').textContent = open ? '' : '（点击展开 ' + rows.length + ' 行）';
        rows.forEach((tr) => { tr.style.display = open ? '' : 'none'; });
      };
      sep.onclick = () => setOpen(!sep.dataset.open);
      setOpen(rows.length <= 30);
    });
    fileBox.appendChild(table);
    return fileBox;
  }

  // 整页 diff 视图（编辑区）：单个结果或数组（多文件堆叠）
  function renderDiffView(rs, label, act) {
    // 浏览器/依赖图占主区会盖住编辑区：diff 显示前先让位（log 底部停靠不挡，不动）
    if (window.App) {
      const tool = App.getTool();
      if (tool === 'browser' || (tool === 'tasks' && window.Tasks && Tasks.view === 'dag')) App.backToEditor();
    }
    const list = Array.isArray(rs) ? rs : [rs];
    const view = document.getElementById('viewer');
    const empty = document.getElementById('empty-state');
    empty.classList.remove('visible');
    view.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'diff-wrap';

    const adds = list.reduce((n, r) => n + countAdd(r.hunks), 0);
    const dels = list.reduce((n, r) => n + countDel(r.hunks), 0);
    const head = document.createElement('div');
    head.className = 'diff-head';
    head.innerHTML = `<span class="df-path">${esc(list.length === 1 ? list[0].file : list.length + ' 个文件')}</span>` +
      `<span class="df-meta">${esc(label || '')} · +${adds} / -${dels}</span>`;
    head.appendChild(makeHunkNav());
    // 关闭对比视图：回到编辑器（PyCharm 式 ✕，不再用「返回」）
    const close = document.createElement('button');
    close.className = 'vt-btn';
    close.textContent = '✕';
    close.title = '关闭对比视图 (Esc)';
    close.onclick = closeDiffView;
    head.appendChild(close);
    wrap.appendChild(head);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'diff-body';
    // 只有一个文件时顶部已经写了路径 + 侧别 → 表格里不再重复一遍
    for (const r of list) bodyEl.appendChild(buildDiffTable(r, act, { hideTitle: list.length === 1 }));
    wrap.appendChild(bodyEl);
    view.appendChild(wrap);
    // Esc 关闭
    document.addEventListener('keydown', escCloseDiff);
  }
  function escCloseDiff(e) {
    if (e.key !== 'Escape') return;
    const ae = document.activeElement;
    if (ae && (/^(TEXTAREA|INPUT)$/.test(ae.tagName) || ae.isContentEditable)) return;
    if (Modal.stack.length) return; // 有弹窗时让位
    closeDiffView();
  }
  function closeDiffView() {
    document.removeEventListener('keydown', escCloseDiff);
    const view = document.getElementById('viewer');
    if (!view || !view.querySelector('.diff-wrap')) return;
    const t = Viewer.activeTab;
    if (t) { Viewer.activate(Viewer.openTabs.indexOf(t)); }
    else { view.innerHTML = ''; document.getElementById('empty-state').classList.add('visible'); }
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function countAdd(hunks) {
    return (hunks || []).reduce((n, h) => n + h.rows.filter((r) => r.type === 'add').length, 0);
  }
  function countDel(hunks) {
    return (hunks || []).reduce((n, h) => n + h.rows.filter((r) => r.type === 'del').length, 0);
  }

  // ---------- 键盘导航（↑↓ 选择 + Enter 差异预览） ----------
  let gitSelIdx = -1;
  const navRows = () => filesEl ? [...filesEl.querySelectorAll('.git-file')]
    .filter((r) => {
      // 跳过折叠分组里的行（组容器 display:none，行自身不变）
      let n = r.parentElement;
      while (n && n !== filesEl) {
        if (n.style && n.style.display === 'none') return false;
        n = n.parentElement;
      }
      return true;
    }) : [];
  function setGitSel(i) {
    const items = navRows();
    if (!items.length) return;
    gitSelIdx = Math.max(0, Math.min(i, items.length - 1));
    items.forEach((r, k) => r.classList.toggle('key-nav-sel', k === gitSelIdx));
    try { items[gitSelIdx].scrollIntoView({ block: 'nearest' }); } catch {}
  }
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (!['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) return;
    if (!isOpen()) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (t && t.closest && t.closest('.cm-editor')) return;
    const items = navRows();
    if (!items.length) return;
    e.preventDefault();
    if (e.key === 'ArrowDown') { setGitSel(gitSelIdx < 0 ? 0 : gitSelIdx + 1); return; }
    if (e.key === 'ArrowUp') { setGitSel(gitSelIdx < 0 ? items.length - 1 : gitSelIdx - 1); return; }
    if (e.key === 'Enter' && gitSelIdx >= 0) {
      const row = items[gitSelIdx];
      row.click();
    }
  });

  // ---------- 浮动小菜单（提交消息历史 / 提交并推送 选项）----------
  function closeFloatMenu() {
    const m = document.getElementById('git-float-menu');
    if (m) m.remove();
    document.removeEventListener('mousedown', onFloatMenuOutside, true);
  }
  function onFloatMenuOutside(e) {
    const m = document.getElementById('git-float-menu');
    if (m && !m.contains(e.target)) closeFloatMenu();
  }
  function openFloatMenu(anchor, items) {
    closeFloatMenu();
    const menu = document.createElement('div');
    menu.id = 'git-float-menu';
    menu.className = 'git-float-menu';
    for (const it of items) {
      const d = document.createElement('div');
      d.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.header ? ' ctx-title' : '');
      d.textContent = it.label;
      d.title = it.title || it.label;
      if (!it.header) d.onclick = () => { closeFloatMenu(); it.run(); };
      menu.appendChild(d);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(6, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.min(r.bottom + 2, window.innerHeight - h - 8) + 'px';
    setTimeout(() => document.addEventListener('mousedown', onFloatMenuOutside, true), 0);
  }

  // 提交消息历史（🕘）：最近用过的提交消息，点击填充（全局，与 PyCharm 的 Recent Messages 一致）
  function openHistoryMenu(anchor) {
    const list = loadMsgHistory();
    if (!list.length) { MI.toast('还没有历史提交消息', 'err'); return; }
    const msgEl = document.getElementById('commit-msg');
    const items = [{ label: '最近提交消息', header: true }];
    for (const m of list.slice(0, 12)) {
      items.push({
        label: (m.split('\n')[0] || '(空)').slice(0, 60),
        run: () => {
          if (!msgEl) return;
          amendBackup = null;
          msgEl.value = m;
          commitMsg = m;
          lastDraft = m;
          saveDraft(m);
          focusMessage();
        },
      });
    }
    items.push({ label: '清空历史', danger: true, run: () => {
      try { localStorage.removeItem(MSG_HIST_KEY); } catch {}
      MI.toast('已清空提交消息历史', 'ok');
    } });
    openFloatMenu(anchor, items);
  }

  // 「提交并推送」下拉：其他远程 / 强制推送
  async function openPushMenu(anchor) {
    const items = [{ label: '提交并推送', run: () => doCommit(true) }];
    let remotes = [];
    try { const r = await window.myIDE.git.listRemotes(root); remotes = (r && r.remotes) || []; } catch {}
    if (remotes.length > 1) {
      items.push({ label: '提交并推送到…', header: true });
      for (const rm of remotes) items.push({ label: rm.name, run: () => doCommit(true, { remote: rm.name }) });
    }
    items.push({
      label: '提交并安全强推（--force-with-lease）',
      title: '以本地记录的远程分支为租约：上次拉取后远程又被别人推过 → 推送被拒绝（比裸 --force 安全）',
      danger: true,
      run: async () => {
        const yes = await Modal.confirm('安全强推（--force-with-lease）',
          '会覆盖远程分支上你本地已知的提交。若别人在你上次拉取之后推过新内容，推送会被拒绝（不会丢别人的工作）。\n\n确定继续吗？');
        if (yes) doCommit(true, { lease: true });
      },
    });
    openFloatMenu(anchor, items);
  }

  // ---------- 修正上次提交（amend）：勾选时自动回填上次的提交消息 ----------
  async function onAmendToggle() {
    const el = document.getElementById('commit-amend');
    const msgEl = document.getElementById('commit-msg');
    if (!el || !msgEl) return;
    const hist = document.getElementById('commit-history');
    if (el.checked) {
      if (amendBackup === null) amendBackup = msgEl.value;
      const r = await window.myIDE.git.log(root, 1).catch(() => null);
      const last = r && r.commits && r.commits[0] ? r.commits[0].fullMessage : '';
      if (last) {
        msgEl.value = last;
        commitMsg = last;
        lastDraft = last;
        if (hist) hist.classList.add('active');
        MI.toast('已回填上次提交的消息（amend）', 'ok');
      } else {
        MI.toast('没有可修正的提交', 'err');
        el.checked = false;
      }
    } else if (amendBackup !== null) {
      msgEl.value = amendBackup;
      commitMsg = amendBackup;
      lastDraft = amendBackup;
      amendBackup = null;
      if (hist) hist.classList.remove('active');
    }
  }

  // ---------- 初始化（静态面板事件绑定） ----------
  function init() {
    filesEl = document.getElementById('cd-files');
    if (!filesEl) return;
    loadPreCfg();   // M5：提交前检查配置（按项目，懒加载一次；切项目时重载）
    const msg = document.getElementById('commit-msg');
    if (msg) {
      // 草稿优先（按项目持久化）——此前 commitMsg 只在内存里，刷新一次就丢
      const draft = loadDraft();
      msg.value = draft || commitMsg;
      commitMsg = msg.value;
      lastDraft = msg.value;
      msg.addEventListener('input', () => {
        commitMsg = msg.value;
        lastDraft = msg.value;
        scheduleDraftSave(msg.value);
      });
      msg.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doCommit(false); }
      });
    }
    const ok = document.getElementById('cm-ok');
    if (ok) ok.onclick = () => doCommit(false);
    const okp = document.getElementById('cm-ok-push');
    if (okp) okp.onclick = () => doCommit(true);
    const okm = document.getElementById('cm-ok-push-menu');
    if (okm) okm.onclick = () => openPushMenu(okm);
    const amd = document.getElementById('commit-amend');
    if (amd) amd.onchange = onAmendToggle;
    const hst = document.getElementById('commit-history');
    if (hst) hst.onclick = () => openHistoryMenu(hst);
    // 「⋯ 更多」：本次作者 / 提交前检查（原来在工具行占了两个图标位）
    const cm = document.getElementById('commit-more');
    if (cm) cm.onclick = () => openCommitMoreMenu(cm);
    // M5：Sign-off 勾选（持久化）+ 提交前检查 / 作者入口
    const so = document.getElementById('commit-signoff');
    if (so) {
      so.checked = signoff;
      so.onchange = () => { signoff = !!so.checked; saveUiPrefs(); };
    }
    // ⚠ 「提交前 / 作者」两个按钮现在由 buildToolbar 每次重建时创建并绑定（见那里的说明），
    //   这里不能再按 id 绑一次 —— render() 之后拿到的是新节点，绑旧节点等于没绑。
    const pull = document.getElementById('cd-pull');
    if (pull) pull.onclick = (e) => openPullMenu(e.currentTarget);
    const push = document.getElementById('cd-push');
    if (push) push.onclick = () => doPush();
    // 搁置 / 远程 / 日志 已在 buildToolbar 里创建并直接绑好 handler（它们随 render 重建，
    // 不能在这里按 id 绑一次 —— 重建后就是新节点了）
    const br = document.getElementById('cd-branch');
    if (br) br.onclick = () => openBranchDialog();
  }
  init();

  // 提交工具窗口是否可见（App 处于 git 态；测试环境无 App 时回退查 DOM）
  function isOpen() {
    if (window.App && App.getTool) return App.getTool() === 'git';
    const p = document.getElementById('panel-git');
    return !!p && !p.classList.contains('hidden');
  }

  return {
    refresh, openCommit, closeDialog, isOpen, openBranchDialog, openRemoteDialog, cancelDiff,
    buildDiffTable, makeHunkNav, renderDiffView, closeDiffView, esc, fmtDate, countAdd, countDel,
    doPull, doPush, updateAheadBehind,
    doCommit, focusMessage, setAllCollapsed, openCommitMoreMenu, openViewOptionsMenu, closeFloatMenu,
    get rootDir() { return root; },
    set rootDir(v) {
      if (v !== root) {
        // 切项目：输入框里若还是上一个项目的草稿（用户没改过），换成新项目的草稿
        const msgEl = document.getElementById('commit-msg');
        if (msgEl && msgEl.value === lastDraft) {
          const d = loadDraftFor(v);
          msgEl.value = d;
          commitMsg = d;
          lastDraft = d;
        }
        amendBackup = null;
        // M5：提交前检查配置随项目；作者覆盖是"这一次"的临时状态 → 切项目即失效
        loadPreCfg();
        authorOverride = null;
        updateAuthorBtn();
        const amd = document.getElementById('commit-amend');
        if (amd) amd.checked = false;
        const hist = document.getElementById('commit-history');
        if (hist) hist.classList.remove('active');
      }
      root = v;
      // ⚠ 「忽略的文件」是**整个会话缓存**的（ignoredFiles/ignoredAll），不随 root 走：
      //   切项目不清会让新项目显示上一个项目的忽略清单（自检截图抓到过：新仓库里列出 48 个忽略文件）。
      invalidateIgnored();
      loadCls();   // 变更列表随项目：切项目要换成该项目自己的列表（异步，读完自己 render）
    },
    // 变更列表（M1）：给测试/自检用的读写口
    openChangelistDialog, clMoveTo, clSetActive, clNameOf, clListOf,
    // M4：进行中的 Git 操作与冲突解决（给测试/自检用的读写口）
    openConflictDialog, doContinue, doSkip, doAbort, buildOpBar, closeFloatMenu,
    // M5：提交前检查 / Sign-off / 作者覆盖（给测试与自检用的读写口）
    openPrecheckDialog, openAuthorDialog, runPreChecks, showPreCheckResult, appendSignoff,
    // 分组方式切换（按目录 ↔ 平铺）：给测试与自检一个稳定入口，不用去猜工具行的索引
    toggleGroupByDir() { groupByDir = !groupByDir; saveUiPrefs(); render(); },
    get groupByDir() { return groupByDir; },
    get preCfg() { return Object.assign({}, preCfg, { commands: preCfg.commands.slice() }); },
    set preCfg(v) { preCfg = pcNormalize(v); },
    get signoff() { return signoff; },
    set signoff(v) { signoff = !!v; saveUiPrefs(); const el = document.getElementById('commit-signoff'); if (el) el.checked = signoff; },
    get authorOverride() { return authorOverride ? Object.assign({}, authorOverride) : null; },
    set authorOverride(v) { authorOverride = v || null; updateAuthorBtn(); },
    loadPreCfg,
    get op() { return op ? Object.assign({}, op) : null; },
    set op(v) { op = v; render(); },
    get conflicts() { return conflictFiles.slice(); },
    set conflicts(v) { conflictFiles = Array.isArray(v) ? v : []; render(); },
    get changelists() { return JSON.parse(JSON.stringify(cls)); },
    set changelists(v) { cls = clNormalize(v); saveCls(); render(); },
    get activeChangelist() { return cls.active; },
    reloadChangelists: () => loadCls(),
  };
})();
window.GitPanel = GitPanel;

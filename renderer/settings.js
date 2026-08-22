// settings.js —— 设置页面（PyCharm Settings 风格：左分类 + 右内容）
const Settings = (() => {
  let listening = null; // 正在修改的动作 id
  let keysFilter = '';  // 快捷键过滤词

  function open() {
    const box = document.createElement('div');
    box.id = 'set-box';
    box.innerHTML = `
      <div class="m-head">⚙️ 设置 <span class="x" id="set-x">✕</span></div>
      <div class="set-body">
        <div class="set-side">
          <div class="set-cat active" data-cat="keys">⌨️ 快捷键</div>
          <div class="set-cat" data-cat="font">🔤 外观</div>
          <div class="set-cat" data-cat="git">🔀 Git</div>
          <div class="set-cat" data-cat="theme">🎨 主题</div>
        </div>
        <div class="set-main" id="set-main">
          <div class="set-toolbar">
            <span class="set-title" id="set-title">快捷键（点击按键可修改）</span>
            <span class="spacer"></span>
            <button class="tb-btn" id="set-reset-all">恢复全部默认</button>
          </div>
          <div id="set-list"></div>
          <div class="set-hint" id="set-hint">点击动作右侧的按键 → 按下新组合键完成修改 · Esc 取消</div>
        </div>
      </div>`;
    Modal.show(box);
    document.getElementById('set-x').onclick = () => Modal.hide();
    document.getElementById('set-reset-all').onclick = () => {
      Shortcuts.resetAll();
      renderList();
      MI.toast('已恢复全部默认快捷键', 'ok');
    };
    // 分类切换
    $all('.set-cat[data-cat]').forEach((cat) => {
      cat.onclick = () => {
        $all('.set-cat').forEach((x) => x.classList.remove('active'));
        cat.classList.add('active');
        if (cat.dataset.cat === 'keys') renderKeys();
        else if (cat.dataset.cat === 'font') renderFont();
        else if (cat.dataset.cat === 'git') renderGit();
        else if (cat.dataset.cat === 'theme') renderTheme();
      };
    });
    renderKeys();
  }

  function $all(sel) { return [...document.querySelectorAll(sel)]; }

  // ---------- 快捷键视图 ----------
  function renderKeys() {
    document.getElementById('set-title').textContent = '快捷键（点击按键可修改）';
    document.getElementById('set-hint').textContent = '点击动作右侧的按键 → 按下新组合键完成修改 · Esc 取消';
    document.getElementById('set-reset-all').classList.remove('hidden');
    const list = document.getElementById('set-list');
    if (!document.getElementById('set-keys-filter')) {
      const filter = document.createElement('input');
      filter.id = 'set-keys-filter';
      filter.type = 'text';
      filter.placeholder = '🔍 过滤动作…';
      filter.value = keysFilter;
      filter.addEventListener('input', () => { keysFilter = filter.value; renderList(); });
      list.parentElement.insertBefore(filter, list);
    }
    renderList();
  }

  // ---------- 外观视图（字体大小） ----------
  function renderFont() {
    const f = document.getElementById('set-keys-filter');
    if (f) f.remove(); // 快捷键过滤框不属于本视图
    document.getElementById('set-title').textContent = '外观（字体大小 · 背景图 · 玩偶）';
    document.getElementById('set-hint').textContent = '字号只调整文档编辑区；背景支持本地图片或内置渐变，透明度可调';
    document.getElementById('set-reset-all').classList.add('hidden');
    const list = document.getElementById('set-list');
    let size = 13;
    try { size = parseInt(localStorage.getItem('myide-editor-font') || '13', 10) || 13; } catch {}
    const bg = window.Bg ? Bg.get() : { path: '', opacity: 0.15 };
    const bgOp = Math.round(bg.opacity * 100);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const GRAD_NAMES = { dusk: '暮色', ocean: '深海', forest: '墨绿', ember: '暖霞', galaxy: '星空', blossom: '粉黛' };
    list.innerHTML = `
      <div class="set-form">
        <label class="m-label">字体大小：<span id="font-size-val">${size}</span> px</label>
        <input id="font-size-range" type="range" min="10" max="20" step="1" value="${size}" style="width:100%">
        <div style="display:flex;justify-content:space-between;color:var(--text-dim);font-size:11px;margin-top:2px">
          <span>10px 小</span><span>13px 默认</span><span>20px 大</span>
        </div>
        <div style="margin-top:14px">
          <button class="tb-btn m-ok" id="font-reset">恢复默认 (13px)</button>
        </div>
      </div>
      <div class="set-form" style="border-top:1px solid var(--border);margin-top:10px">
        <label class="m-label">背景图片</label>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:10px">
          <button class="tb-btn m-ok" id="bg-pick">🖼 选择图片…</button>
          <button class="tb-btn" id="bg-clear">清除</button>
        </div>
        <div class="set-hint-path" style="color:var(--text-dim);font-size:11px;margin-bottom:4px">${bg.path && bg.path.indexOf('grad:') !== 0 ? esc(bg.path) : (bg.path ? '内置渐变：' + (GRAD_NAMES[bg.path.slice(5)] || bg.path.slice(5)) : '未设置背景图')}</div>
        <label class="m-label" style="margin-top:4px">内置渐变背景（无需选择图片）</label>
        <div class="grad-opts">
          <button class="grad-opt ${bg.path === 'grad:dusk' ? 'sel' : ''}" data-grad="dusk" title="暮色">暮色</button>
          <button class="grad-opt ${bg.path === 'grad:ocean' ? 'sel' : ''}" data-grad="ocean" title="深海">深海</button>
          <button class="grad-opt ${bg.path === 'grad:forest' ? 'sel' : ''}" data-grad="forest" title="墨绿">墨绿</button>
          <button class="grad-opt ${bg.path === 'grad:ember' ? 'sel' : ''}" data-grad="ember" title="暖霞">暖霞</button>
          <button class="grad-opt ${bg.path === 'grad:galaxy' ? 'sel' : ''}" data-grad="galaxy" title="星空">星空</button>
          <button class="grad-opt ${bg.path === 'grad:blossom' ? 'sel' : ''}" data-grad="blossom" title="粉黛">粉黛</button>
        </div>
        <label class="m-label" style="margin-top:12px">背景透明度：<span id="bg-op-val">${bgOp}</span>%</label>
        <input id="bg-op-range" type="range" min="5" max="50" step="1" value="${bgOp}" style="width:100%" ${bg.path ? '' : 'disabled'}>
        <label class="m-label" style="margin-top:12px">显示方式</label>
        <div class="bg-fit-opts">
          <button class="bg-fit-opt ${bg.fit === 'cover' ? 'sel' : ''}" data-fit="cover" ${bg.path ? '' : 'disabled'} title="缩放至铺满窗口（可能裁切）">铺满</button>
          <button class="bg-fit-opt ${bg.fit === 'contain' ? 'sel' : ''}" data-fit="contain" ${bg.path ? '' : 'disabled'} title="完整显示图片（可能留边）">完整</button>
          <button class="bg-fit-opt ${bg.fit === 'tile' ? 'sel' : ''}" data-fit="tile" ${bg.path ? '' : 'disabled'} title="按原图大小平铺">平铺</button>
        </div>
        <label class="m-label" style="margin-top:12px">显示位置（铺满裁切时可见）</label>
        <select id="bg-pos-sel" style="width:100%;background:var(--bg-input);color:var(--text);border:1px solid var(--btn-border);border-radius:4px;padding:4px 6px" ${bg.path ? '' : 'disabled'}>
          <option value="center" ${bg.pos === 'center' ? 'selected' : ''}>居中</option>
          <option value="top" ${bg.pos === 'top' ? 'selected' : ''}>顶部居中</option>
          <option value="bottom" ${bg.pos === 'bottom' ? 'selected' : ''}>底部居中</option>
          <option value="left" ${bg.pos === 'left' ? 'selected' : ''}>左侧居中</option>
          <option value="right" ${bg.pos === 'right' ? 'selected' : ''}>右侧居中</option>
          <option value="top left" ${bg.pos === 'top left' ? 'selected' : ''}>左上</option>
          <option value="top right" ${bg.pos === 'top right' ? 'selected' : ''}>右上</option>
          <option value="bottom left" ${bg.pos === 'bottom left' ? 'selected' : ''}>左下</option>
          <option value="bottom right" ${bg.pos === 'bottom right' ? 'selected' : ''}>右下</option>
        </select>
      </div>
      <div class="set-form" style="border-top:1px solid var(--border);margin-top:10px">
        <label class="m-label">桌面玩偶</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="pet-enable" ${window.Pet && Pet.isOn() ? 'checked' : ''} style="accent-color:var(--accent)">
          <label for="pet-enable" style="cursor:pointer">显示右下角玩偶（点击玩偶可切换形象）</label>
        </div>
      </div>`;
    const range = document.getElementById('font-size-range');
    range.addEventListener('input', () => {
      const v = parseInt(range.value, 10);
      document.getElementById('font-size-val').textContent = v;
      if (window.Viewer) Viewer.applyFontSize(v);
    });
    document.getElementById('font-reset').onclick = () => {
      range.value = 13;
      document.getElementById('font-size-val').textContent = 13;
      if (window.Viewer) Viewer.applyFontSize(13);
      MI.toast('已恢复默认字号', 'ok');
    };
    // 背景图
    const opRange = document.getElementById('bg-op-range');
    const refreshPath = () => {
      const cur = window.Bg ? Bg.get() : { path: '' };
      const hint = document.querySelector('.set-hint-path');
      if (hint) {
        if (!cur.path) hint.textContent = '未设置背景图';
        else if (cur.path.indexOf('grad:') === 0) hint.textContent = '内置渐变：' + (GRAD_NAMES[cur.path.slice(5)] || cur.path.slice(5));
        else hint.textContent = cur.path;
      }
      opRange.disabled = !cur.path;
      const posSel = document.getElementById('bg-pos-sel');
      if (posSel) posSel.disabled = !cur.path;
      $all('.bg-fit-opt').forEach((b) => { b.disabled = !cur.path; });
    };
    document.getElementById('bg-pick').onclick = async () => {
      const p = await window.myIDE.fs.pickImage();
      if (p) {
        Bg.set(p);
        $all('.grad-opt').forEach((x) => x.classList.remove('sel'));
        refreshPath();
        MI.toast('已设置背景图', 'ok');
      }
    };
    document.getElementById('bg-clear').onclick = () => {
      Bg.set('');
      opRange.value = 15;
      document.getElementById('bg-op-val').textContent = 15;
      refreshPath();
      $all('.grad-opt').forEach((x) => x.classList.remove('sel'));
      MI.toast('已清除背景图', 'ok');
    };
    // 内置渐变背景
    $all('.grad-opt').forEach((b) => {
      b.onclick = () => {
        Bg.set('grad:' + b.dataset.grad);
        $all('.grad-opt').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
        refreshPath();
        MI.toast('已应用渐变背景：' + GRAD_NAMES[b.dataset.grad], 'ok');
      };
    });
    opRange.addEventListener('input', () => {
      const v = parseInt(opRange.value, 10);
      document.getElementById('bg-op-val').textContent = v;
      if (window.Bg) Bg.setOpacity(v / 100);
    });
    // 显示方式：铺满 / 完整 / 平铺
    $all('.bg-fit-opt').forEach((b) => {
      b.onclick = () => {
        if (b.disabled) return;
        Bg.setFit(b.dataset.fit);
        $all('.bg-fit-opt').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
      };
    });
    // 显示位置
    const posSel = document.getElementById('bg-pos-sel');
    if (posSel) {
      posSel.addEventListener('change', () => {
        if (!posSel.disabled) Bg.setPos(posSel.value);
      });
    }
    // 桌面玩偶开关
    const petCb = document.getElementById('pet-enable');
    if (petCb && window.Pet) {
      petCb.addEventListener('change', () => { Pet.setPetOn(petCb.checked); });
    }
  }

  // ---------- 主题视图 ----------
  function renderTheme() {
    const f = document.getElementById('set-keys-filter');
    if (f) f.remove(); // 快捷键过滤框不属于本视图
    document.getElementById('set-title').textContent = '主题';
    document.getElementById('set-hint').textContent = '选择或自定义界面配色，即时生效并保存';
    document.getElementById('set-reset-all').classList.add('hidden');
    const list = document.getElementById('set-list');
    const cur = Theme.current();
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // 用户自定义主题卡片（可应用 / 可删除）
    const userThemes = Theme.getUserThemes ? Theme.getUserThemes() : [];
    const utBtns = userThemes.map((ut) => `
      <button class="theme-opt ut ${cur === 'user:' + ut.id ? 'sel' : ''}" data-ut="${esc(ut.id)}" title="点击应用 · × 删除">🎨 ${esc(ut.name)}<span class="ut-del" title="删除该主题">×</span></button>`).join('');
    // 动态自定义：在当前主题上逐项调整核心颜色（按分组渲染）
    const custom = Theme.getCustom ? Theme.getCustom() : { accent: Theme.getAccent ? Theme.getAccent() : '' };
    const fields = Theme.getFields ? Theme.getFields() : { accent: { label: '强调色', group: '' } };
    const FALLBACKS = {
      accent: '#4f9cd6', green: '#6aab73', red: '#d16969',
      bg: '#1e1e1e', bgPanel: '#191919', bgHover: '#2a2a2a', bgSelected: '#2d4f6b', bgInput: '#232323', panelStrong: '#202020',
      text: '#b8b8b8', textBright: '#e4e4e4', textDim: '#808080', editorText: '#c8c8c8', codeText: '#e8c98a',
      border: '#101010', borderMid: '#3a3a3a', btnBorder: '#333333',
    };
    const groups = [];
    for (const k in fields) {
      const g = fields[k].group || '其他';
      if (!groups.some((x) => x.name === g)) groups.push({ name: g, keys: [] });
      groups.find((x) => x.name === g).keys.push(k);
    }
    const colorRows = groups.map((g) => `
      <div class="ct-group">
        <div class="ct-group-title">${g.name}</div>
        ${g.keys.map((k) => `
        <div class="custom-theme-row" data-field="${k}">
          <span class="custom-theme-label">${fields[k].label}</span>
          <span class="custom-theme-ctrl">
            <input class="ct-color" type="color" value="${custom[k] || FALLBACKS[k] || '#888888'}" title="调整${fields[k].label}">
            <button class="tb-btn ct-reset" title="此项恢复主题默认">×</button>
          </span>
        </div>`).join('')}
      </div>`).join('');
    list.innerHTML = `
      <div class="set-form">
        <div class="theme-options">
          <button class="theme-opt ${cur === 'dark' ? 'sel' : ''}" data-th="dark">🌙 深色</button>
          <button class="theme-opt ${cur === 'light' ? 'sel' : ''}" data-th="light">☀️ 浅色</button>
          <button class="theme-opt ${cur === 'pink' ? 'sel' : ''}" data-th="pink">🌸 粉红</button>
          <button class="theme-opt ${cur === 'crimson' ? 'sel' : ''}" data-th="crimson">🌹 深红</button>
        </div>
        ${userThemes.length ? `<div class="theme-options user-themes">${utBtns}</div>` : ''}
      </div>
      <div class="set-form" style="border-top:1px solid var(--border);margin-top:10px">
        <label class="m-label">动态自定义（当前主题上直接调色，改哪项哪项生效）</label>
        ${colorRows}
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="tb-btn m-ok" id="ut-save">💾 保存为自定义主题</button>
          <button class="tb-btn" id="custom-theme-reset-all">全部恢复主题默认</button>
        </div>
        <div style="color:var(--text-dim);font-size:11px;margin-top:6px">调色立即生效并保存；「保存为自定义主题」后可在上方卡片中应用或删除</div>
      </div>`;
    // 内置主题：点击应用并重绘（用户主题卡片高亮同步）
    $all('.theme-opt:not(.ut)').forEach((b) => {
      b.onclick = () => {
        Theme.set(b.dataset.th);
        renderTheme();
        MI.toast('已切换为' + Theme.name(b.dataset.th) + '主题', 'ok');
      };
    });
    // 用户主题：点击应用 / × 删除
    $all('.theme-opt.ut').forEach((b) => {
      b.onclick = () => {
        Theme.set('user:' + b.dataset.ut);
        renderTheme();
        MI.toast('已切换为「' + Theme.name('user:' + b.dataset.ut) + '」主题', 'ok');
      };
      const del = b.querySelector('.ut-del');
      del.onclick = async (e) => {
        e.stopPropagation();
        const nm = Theme.name('user:' + b.dataset.ut);
        const yes = await Modal.confirm('删除主题', '确定删除自定义主题「' + nm + '」吗？');
        if (!yes) return;
        Theme.removeUserTheme(b.dataset.ut);
        renderTheme();
        MI.toast('已删除「' + nm + '」', 'ok');
      };
    });
    // 保存为自定义主题（快照当前 base + 配色）
    const saveBtn = document.getElementById('ut-save');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const nm = await Modal.prompt('保存为自定义主题', '主题名称：', '我的主题');
        if (!nm || !nm.trim()) return;
        const id = Theme.addUserTheme(nm.trim());
        Theme.set('user:' + id);
        renderTheme();
        MI.toast('已保存自定义主题「' + nm.trim() + '」', 'ok');
      };
    }
    // 逐项调色：input 即时生效；× 恢复该项预设
    $all('.custom-theme-row').forEach((row) => {
      const key = row.dataset.field;
      const input = row.querySelector('.ct-color');
      const reset = row.querySelector('.ct-reset');
      input.addEventListener('input', () => Theme.pick(key, input.value));
      reset.onclick = () => {
        Theme.pick(key, '');
        input.value = FALLBACKS[key] || '#888888';
        MI.toast(fields[key].label + ' 已恢复主题默认', 'ok');
      };
    });
    const resetAll = document.getElementById('custom-theme-reset-all');
    if (resetAll) {
      resetAll.onclick = () => {
        Theme.clearCustom();
        // 表单回填预设默认色
        $all('.custom-theme-row').forEach((row) => {
          const k = row.dataset.field;
          row.querySelector('.ct-color').value = FALLBACKS[k] || '#888888';
        });
        MI.toast('已恢复主题默认配色', 'ok');
      };
    }
  }

  // ---------- Git 视图 ----------
  async function renderGit() {
    const f = document.getElementById('set-keys-filter');
    if (f) f.remove(); // 快捷键过滤框不属于本视图
    document.getElementById('set-title').textContent = 'Git 配置（提交作者信息）';
    document.getElementById('set-hint').textContent = '保存后写入当前仓库 .git/config，下次提交生效';
    document.getElementById('set-reset-all').classList.add('hidden');
    const list = document.getElementById('set-list');
    list.innerHTML = '<div class="git-empty">加载中…</div>';
    const cfg = await window.myIDE.git.getUserConfig(App.root);
    if (!cfg.isRepo) {
      list.innerHTML = '<div class="git-empty">当前项目不是 Git 仓库</div>';
      return;
    }
    list.innerHTML = `
      <div class="set-form">
        <label class="m-label">用户名</label>
        <input id="git-cfg-name" type="text" placeholder="如：zhangsan" value="${esc(cfg.name)}">
        <label class="m-label">邮箱</label>
        <input id="git-cfg-email" type="text" placeholder="如：zhangsan@example.com" value="${esc(cfg.email)}">
        <div style="margin-top:14px">
          <button class="tb-btn m-ok" id="git-cfg-save">保存</button>
        </div>
      </div>`;
    document.getElementById('git-cfg-save').onclick = async () => {
      const name = document.getElementById('git-cfg-name').value.trim();
      const email = document.getElementById('git-cfg-email').value.trim();
      if (!name || !email) { MI.toast('用户名和邮箱不能为空', 'err'); return; }
      const r = await window.myIDE.git.setUserConfig(App.root, { name, email });
      if (r.ok) MI.toast('✅ Git 配置已保存，下次提交生效', 'ok');
      else MI.toast('保存失败: ' + r.error, 'err');
    };
  }

  function renderList() {
    const list = document.getElementById('set-list');
    if (!list) return;
    list.innerHTML = '';
    const q = keysFilter.trim().toLowerCase();
    for (const b of Shortcuts.bindings()) {
      if (q && !(b.desc + ' ' + b.id + ' ' + b.combos.join(' ')).toLowerCase().includes(q)) continue;
      const row = document.createElement('div');
      row.className = 'set-row';
      const info = document.createElement('div');
      info.className = 'set-info';
      info.innerHTML = `<div class="set-name">${esc(b.id === 'settings' ? '⚙️ 设置' : b.id)}</div><div class="set-desc">${esc(b.desc)}</div>`;
      const comboBtn = document.createElement('button');
      comboBtn.className = 'set-combo' + (listening === b.id ? ' listening' : '');
      comboBtn.textContent = listening === b.id ? '按下新组合键…' : b.combos.join(' / ').replace(/\+/g, ' + ');
      comboBtn.onclick = () => startListen(b.id, comboBtn);
      const resetBtn = document.createElement('button');
      resetBtn.className = 'set-reset' + (b.custom ? '' : ' hidden');
      resetBtn.textContent = '恢复默认';
      resetBtn.onclick = () => { Shortcuts.reset(b.id); renderList(); };
      row.appendChild(info);
      row.appendChild(resetBtn);
      row.appendChild(comboBtn);
      list.appendChild(row);
    }
  }

  function startListen(id, btn) {
    listening = id;
    renderList();
    Shortcuts.captureNext((combo) => {
      listening = null;
      if (!combo) { renderList(); return; } // Esc 取消
      if (combo === 'escape') { renderList(); return; }
      const conflict = Shortcuts.setBinding(id, combo);
      renderList();
      if (conflict) MI.toast('⚠️ 与「' + conflict + '」冲突，已覆盖', 'err');
      else MI.toast('✅ 已设置为 ' + combo.replace(/\+/g, ' + '), 'ok');
    });
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  return { open };
})();
window.Settings = Settings;
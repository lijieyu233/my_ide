// 自动会话与手动标签组分开存储；坏记录不覆盖，避免一次恢复失败抹掉用户的网页清单。
//
// 标签组采用 Edge 的「活标签组」模型：组是挂在已打开标签上的归属关系，
// 不是另存一份网页快照。具体表现为 tab.groupId 指向 groups 里的某一项，
// 组本身只保存 { id, name, color, folded } —— 没有 tabs 数组。
// 这样「组里的标签」和标签栏里看到的是同一批对象，不会出现两套对不上的副本。
(function (host) {
  const SESSION = 'myide-browser-session:', GROUPS = 'myide-browser-tab-groups';
  const id = () => 'bt-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
  const scopeKey = root => root ? String(root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '@global';
  const validURL = url => typeof url === 'string' && (!url || /^(https?:|file:)/i.test(url));
  const copy = value => JSON.parse(JSON.stringify(value));
  // Edge 的组色板（8 色）。用固定枚举而不是自由取色，菜单里就一排圆点，
  // 也不会有「用户把组设成和背景同色」这类问题。
  const GROUP_COLORS = ['blue', 'cyan', 'purple', 'pink', 'green', 'yellow', 'orange', 'grey'];
  const isColor = value => GROUP_COLORS.includes(value);
  function create(storage) {
    let scope = '@global', state, blocked = false, error = '';
    const freshTab = (url = '', title = '', groupId = null) => ({ id: id(), url, title: title || (url ? url : '新标签页'), groupId: groupId || null });
    const fail = message => { error = message; return { ok: false, error }; };
    const save = () => {
      if (blocked) return fail('原标签记录无法读取，已保留原记录，本次标签尚未保存');
      try { storage.setItem(SESSION + scope, JSON.stringify(state)); error = ''; return { ok: true }; }
      catch { return fail('浏览器标签保存失败，请重试后再切换项目'); }
    };
    // groupId 允许 null / undefined（未分组）；指向不存在的组由「读取时清洗」处理，
    // 而不是判定整份记录损坏 —— 否则删组后一个残留 id 就能让所有标签打不开。
    const validateTab = tab => tab && typeof tab.id === 'string' && /^[\w-]{1,100}$/.test(tab.id) && validURL(tab.url) && typeof tab.title === 'string'
      && (tab.groupId === undefined || tab.groupId === null || typeof tab.groupId === 'string');
    const load = root => {
      scope = scopeKey(root); blocked = false; error = '';
      state = { version: 1, tabs: [freshTab()], active: null, closed: [] }; state.active = state.tabs[0].id;
      try {
        const raw = storage.getItem(SESSION + scope);
        if (!raw) return { ok: true };
        const parsed = JSON.parse(raw);
        if (parsed.version !== 1 || !Array.isArray(parsed.tabs) || !parsed.tabs.length || !parsed.tabs.every(validateTab) || !Array.isArray(parsed.closed) || !parsed.closed.every(validateTab) || new Set(parsed.tabs.map(t => t.id)).size !== parsed.tabs.length || !parsed.tabs.some(t => t.id === parsed.active)) throw Error('invalid');
        state = parsed;
        return { ok: true };
      } catch { blocked = true; return fail('浏览器标签记录无法读取，原记录已保留'); }
    };
    const active = () => state.tabs.find(t => t.id === state.active);
    // 组列表：只认 { id, name, color, folded }。旧的「快照组」带 tabs 数组，
    // 会被下面 cleanGroups 识别为待迁移数据（见 migrateLegacyGroups）。
    let cachedGroups = null;
    const groups = () => {
      if (cachedGroups) return cachedGroups;
      try {
        const raw = storage.getItem(GROUPS), data = raw ? JSON.parse(raw) : { version: 1, groups: [] };
        if (data.version !== 1 || !Array.isArray(data.groups)) throw Error('invalid');
        cachedGroups = data.groups.filter(g => g && typeof g.id === 'string' && typeof g.name === 'string');
        return cachedGroups;
      } catch { throw Error('标签组无法读取，原记录已保留'); }
    };
    const writeGroups = list => {
      try { storage.setItem(GROUPS, JSON.stringify({ version: 1, groups: list })); cachedGroups = null; return { ok: true }; }
      catch { return fail('标签组保存失败，请重试'); }
    };
    // 旧快照组判定：带非空 tabs 数组即为旧格式。
    const legacyGroups = () => {
      try {
        const raw = storage.getItem(GROUPS); if (!raw) return [];
        const data = JSON.parse(raw);
        if (data.version !== 1 || !Array.isArray(data.groups)) return [];
        return data.groups.filter(g => g && Array.isArray(g.tabs) && g.tabs.length);
      } catch { return []; }
    };
    // 清洗：丢掉无主的组（组里一个标签都没了）与指向不存在组的 groupId。
    const cleanGroups = () => {
      const list = groups(), alive = new Set(state.tabs.map(t => t.groupId).filter(Boolean));
      const kept = list.filter(g => alive.has(g.id) && !Array.isArray(g.tabs));
      for (const tab of state.tabs) if (tab.groupId && !kept.some(g => g.id === tab.groupId)) tab.groupId = null;
      if (kept.length !== list.length) writeGroups(kept);
      return kept;
    };
    load(null);
    return {
      load, save, groups: cleanGroups, GROUP_COLORS,
      get scope() { return scope; }, get error() { return error; },
      get state() { return copy(state); }, get active() { return copy(active()); },
      add(url = '', title = '', select = true, groupId = null) {
        if (!validURL(url)) throw Error('不支持的网页地址');
        const tab = freshTab(url, title, groupId); state.tabs.push(tab); if (select) state.active = tab.id; save(); return copy(tab);
      },
      activate(tabId) { if (!state.tabs.some(t => t.id === tabId)) return false; state.active = tabId; save(); return true; },
      update(tabId, patch) {
        const tab = state.tabs.find(t => t.id === tabId); if (!tab) return false;
        if (patch.url !== undefined && validURL(patch.url)) tab.url = patch.url;
        if (typeof patch.title === 'string') tab.title = patch.title;
        save(); return true;
      },
      close(ids) {
        const remove = new Set(ids), index = state.tabs.findIndex(t => t.id === state.active);
        state.tabs.forEach((tab, i) => { if (remove.has(tab.id)) state.closed.push({ ...tab, index: i }); }); state.closed = state.closed.slice(-30);
        state.tabs = state.tabs.filter(t => !remove.has(t.id));
        if (!state.tabs.length) state.tabs.push(freshTab());
        if (!state.tabs.some(t => t.id === state.active)) state.active = state.tabs[Math.min(index, state.tabs.length - 1)].id;
        save(); cleanGroups(); return copy(active());
      },
      reopen() {
        const previous = state.closed.pop(); if (!previous) return null;
        // 重新打开的标签不恢复分组：组可能已经不在了，硬塞回去会造出孤儿引用。
        const tab = freshTab(previous.url, previous.title); state.tabs.splice(Math.min(previous.index ?? state.tabs.length, state.tabs.length), 0, tab); state.active = tab.id; save(); return copy(tab);
      },
      reorder(from, to) {
        const a = state.tabs.findIndex(t => t.id === from), b = state.tabs.findIndex(t => t.id === to);
        if (a < 0 || b < 0 || a === b) return false; const [tab] = state.tabs.splice(a, 1); state.tabs.splice(b, 0, tab); save(); return true;
      },

      // ---------- 活标签组（Edge 模型） ----------
      /** 新建组并把给定标签收进去。返回新组。 */
      createGroup(tabIds, name = '新组', color = 'blue') {
        const targets = state.tabs.filter(t => tabIds.includes(t.id));
        if (!targets.length) return fail('先选中要分组的标签');
        const list = groups();
        const group = { id: id(), name: String(name).trim().slice(0, 60) || '新组', color: isColor(color) ? color : 'blue', folded: false };
        list.push(group);
        for (const tab of targets) tab.groupId = group.id;
        const written = writeGroups(list); if (!written.ok) return written;
        save(); return { ok: true, group: copy(group) };
      },
      /** 把标签并入已有组（标签会被移动到该组的连续区段里）。 */
      addToGroup(groupId, tabIds) {
        const list = groups(), group = list.find(g => g.id === groupId);
        if (!group) return fail('该标签组已不存在');
        const targets = state.tabs.filter(t => tabIds.includes(t.id));
        if (!targets.length) return fail('先选中要加入的标签');
        for (const tab of targets) tab.groupId = groupId;
        save(); return { ok: true, group: copy(group) };
      },
      /** 从组中移出（不关闭标签）。 */
      removeFromGroup(tabIds) {
        const targets = state.tabs.filter(t => tabIds.includes(t.id) && t.groupId);
        if (!targets.length) return fail('这些标签不在任何组里');
        for (const tab of targets) tab.groupId = null;
        save(); cleanGroups(); return { ok: true };
      },
      renameGroup(groupId, name) {
        const list = groups(), group = list.find(g => g.id === groupId);
        if (!group) return fail('该标签组已不存在');
        const next = String(name || '').trim().slice(0, 60);
        if (!next) return fail('请填写组名');
        group.name = next; return writeGroups(list);
      },
      setGroupColor(groupId, color) {
        if (!isColor(color)) return fail('不支持的颜色');
        const list = groups(), group = list.find(g => g.id === groupId);
        if (!group) return fail('该标签组已不存在');
        group.color = color; return writeGroups(list);
      },
      /** 折叠/展开：只影响标签栏里画不画，绝不关闭标签。 */
      setGroupFolded(groupId, folded) {
        const list = groups(), group = list.find(g => g.id === groupId);
        if (!group) return fail('该标签组已不存在');
        group.folded = !!folded; return writeGroups(list);
      },
      /** 取消组合：标签各自留在原处，只是不再属于任何组。 */
      ungroup(groupId) {
        const list = groups(); if (!list.some(g => g.id === groupId)) return fail('该标签组已不存在');
        for (const tab of state.tabs) if (tab.groupId === groupId) tab.groupId = null;
        save(); return writeGroups(list.filter(g => g.id !== groupId));
      },
      /** 关闭组内所有标签（组随之消失，由 cleanGroups 收尾）。 */
      closeGroupTabs(groupId) {
        const ids = state.tabs.filter(t => t.groupId === groupId).map(t => t.id);
        if (!ids.length) return fail('组内没有标签');
        return { ok: true, closed: ids };
      },
      /** 把旧快照组迁移成活标签组：打开其中的网页并归入同名组。 */
      migrateLegacyGroups() {
        const legacy = legacyGroups(); if (!legacy.length) return { ok: true, migrated: 0 };
        // 先剔除旧格式条目：groups() 原样带回带 tabs 的对象，直接 append 会把
        // 快照字段一起写回去（迁移完还留着 tabs 数组，等于没迁干净）。
        const list = groups().filter(g => !Array.isArray(g.tabs));
        let migrated = 0;
        for (const old of legacy) {
          const group = { id: id(), name: String(old.name || '新组').slice(0, 60), color: isColor(old.color) ? old.color : 'blue', folded: false };
          const created = [];
          for (const item of old.tabs) {
            if (!item || !validURL(item.url) || !item.url) continue;
            const tab = freshTab(item.url, item.title || item.url, group.id);
            state.tabs.push(tab); created.push(tab);
          }
          if (!created.length) continue;
          list.push(group); migrated++;
        }
        const written = writeGroups(list); if (!written.ok) return written;
        if (migrated) save();
        return { ok: true, migrated };
      },
    };
  }
  const api = { create, scopeKey, validURL, GROUP_COLORS };
  if (typeof module !== 'undefined') module.exports = api; else host.BrowserTabs = api;
})(typeof window === 'undefined' ? globalThis : window);

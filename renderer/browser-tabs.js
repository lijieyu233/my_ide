// 自动会话与手动标签组分开存储；坏记录不覆盖，避免一次恢复失败抹掉用户的网页清单。
(function (host) {
  const SESSION = 'myide-browser-session:', GROUPS = 'myide-browser-tab-groups';
  const id = () => 'bt-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
  const scopeKey = root => root ? String(root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '@global';
  const validURL = url => typeof url === 'string' && (!url || /^(https?:|file:)/i.test(url));
  const copy = value => JSON.parse(JSON.stringify(value));
  function create(storage) {
    let scope = '@global', state, blocked = false, error = '';
    const freshTab = (url = '', title = '') => ({ id: id(), url, title: title || (url ? url : '新标签页') });
    const fail = message => { error = message; return { ok: false, error }; };
    const save = () => {
      if (blocked) return fail('原标签记录无法读取，已保留原记录，本次标签尚未保存');
      try { storage.setItem(SESSION + scope, JSON.stringify(state)); error = ''; return { ok: true }; }
      catch { return fail('浏览器标签保存失败，请重试后再切换项目'); }
    };
    const validateTab = tab => tab && typeof tab.id === 'string' && /^[\w-]{1,100}$/.test(tab.id) && validURL(tab.url) && typeof tab.title === 'string';
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
    const groups = () => {
      try {
        const raw = storage.getItem(GROUPS), data = raw ? JSON.parse(raw) : { version: 1, groups: [] };
        if (data.version !== 1 || !Array.isArray(data.groups) || !data.groups.every(g => g && typeof g.id === 'string' && typeof g.name === 'string' && Array.isArray(g.tabs) && g.tabs.every(t => t && validURL(t.url) && t.url && typeof t.title === 'string'))) throw Error('invalid');
        return data.groups;
      } catch { throw Error('标签组无法读取，原记录已保留'); }
    };
    const writeGroups = list => { try { storage.setItem(GROUPS, JSON.stringify({ version: 1, groups: list })); return { ok: true }; } catch { return fail('标签组保存失败，请重试'); } };
    load(null);
    return {
      load, save, groups,
      get scope() { return scope; }, get error() { return error; },
      get state() { return copy(state); }, get active() { return copy(active()); },
      add(url = '', title = '', select = true) {
        if (!validURL(url)) throw Error('不支持的网页地址');
        const tab = freshTab(url, title); state.tabs.push(tab); if (select) state.active = tab.id; save(); return copy(tab);
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
        save(); return copy(active());
      },
      reopen() {
        const previous = state.closed.pop(); if (!previous) return null;
        const tab = freshTab(previous.url, previous.title); state.tabs.splice(Math.min(previous.index ?? state.tabs.length, state.tabs.length), 0, tab); state.active = tab.id; save(); return copy(tab);
      },
      reorder(from, to) {
        const a = state.tabs.findIndex(t => t.id === from), b = state.tabs.findIndex(t => t.id === to);
        if (a < 0 || b < 0 || a === b) return false; const [tab] = state.tabs.splice(a, 1); state.tabs.splice(b, 0, tab); save(); return true;
      },
      saveGroup(name, snapshot = state.tabs) {
        const tabs = snapshot.filter(t => t.url).map(({ url, title }) => ({ url, title }));
        if (!tabs.length) return fail('先打开网页再保存标签组');
        const list = groups(), group = { id: id(), name: String(name).trim().slice(0, 60), tabs, savedAt: Date.now() };
        if (!group.name) return fail('请填写标签组名称'); list.unshift(group); return writeGroups(list);
      },
      changeGroup(groupId, name) { const list = groups(), group = list.find(g => g.id === groupId); if (!group) return fail('标签组已不存在'); if (name == null) return writeGroups(list.filter(g => g.id !== groupId)); group.name = String(name).trim().slice(0, 60); if (!group.name) return fail('请填写名称'); return writeGroups(list); },
      openGroup(groupId) {
        const group = groups().find(g => g.id === groupId); if (!group) return null;
        let first = null;
        for (const item of group.tabs) {
          const key = url => { try { return new URL(url).href; } catch { return url; } };
          let tab = state.tabs.find(t => key(t.url) === key(item.url));
          if (!tab) { tab = freshTab(item.url, item.title); state.tabs.push(tab); }
          first ||= tab;
        }
        if (first) state.active = first.id; save(); return first ? copy(first) : null;
      },
    };
  }
  const api = { create, scopeKey, validURL };
  if (typeof module !== 'undefined') module.exports = api; else host.BrowserTabs = api;
})(typeof window === 'undefined' ? globalThis : window);

// ai-settings-registry.js —— 统一的设置键注册表（AI 配置读写总入口）
//
// 为什么要有这一层（2026-10-27 用户要求）：
//   旧做法是「一个功能一套专用工具参数」——主题字号栏宽塞进 settings_control 的
//   顶层字段，翻译 Key 塞进 translation_config，粘贴图片的 COS 六项干脆没有工具入口。
//   每加一个带配置的功能，就要改一次工具 schema；AI 想配一个本来没接口的功能
//   （比如图床）只能干看着。用户原话：「能不能设置统一的设置操作接口，这样添加新
//   功能也能用 AI 配置」。
//
// 这一层把方向反过来：**功能声明自己有哪些键**，接口固定只认 key/value。
//   功能方：SettingKeys.register({module, group, keys, read, write})
//   AI 方：settings_keys 列出键；settings_values 按 key 批量读写
//   以后新增功能只需 register 一次，工具清单不再变化。
//
// 五个必须守住的约束：
//   ① 秘密只进不出：secret 键读取只回 configured 布尔，永不回明文（对齐
//      translation_state 既有口径，那条用例在 check-ai-workbench.js 里断言过）。
//   ② 功能层参数单独暴露：功能对象常带有 AI 不该看见的旁路信息（快捷键 read 会
//      把整个动作表带出来）。所以 read 返回 { values, params }：values 是可见值，
//      params 是喂给 write 的参数对象，两者形状不同、各走各路。
//   ③ 写入必须落回功能自己的 write，不能直接改 localStorage——否则功能的副作用
//      （切换粘贴模式重建 UI、快捷键重排生效映射）会漏掉。
//   ④ 批量写失败即整体回滚：逐项记录 before，任一失败就按倒序还原，不留半截配置。
//   ⑤ 写后回读核对：write 返回成功不代表生效（resizeColumn 会把宽度夹到可用空间），
//      结果一律以回读到的真实值为准，并标 changed 说明本次到底改没改动。
window.SettingKeys = (() => {
  const groups = new Map();   // module -> { module, group, keys, read, write }
  const fail = (code, message) => { throw Object.assign(Error(message), { code }); };

  function register(spec) {
    const module = String(spec?.module || '').trim();
    if (!module) fail('INVALID_SETTING_SPEC', '注册设置组必须给出 module');
    if (!spec.keys || typeof spec.keys !== 'object') fail('INVALID_SETTING_SPEC', module + ' 没有声明 keys');
    if (typeof spec.read !== 'function' || typeof spec.write !== 'function') fail('INVALID_SETTING_SPEC', module + ' 必须提供 read/write');
    if (groups.has(module)) fail('DUPLICATE_SETTING_GROUP', '重复注册设置组 ' + module);
    const keys = {};
    for (const [rawKey, def] of Object.entries(spec.keys)) {
      const key = String(rawKey);
      if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/i.test(key)) fail('INVALID_SETTING_SPEC', '设置键名不合法：' + key);
      if (!def || typeof def !== 'object') fail('INVALID_SETTING_SPEC', key + ' 缺少定义');
      const type = def.type || 'string';
      if (!['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(type)) fail('INVALID_SETTING_SPEC', key + ' 类型不支持：' + type);
      if (def.pattern) { try { new RegExp(def.pattern); } catch { fail('INVALID_SETTING_SPEC', key + ' 正则无效'); } }
      keys[key] = {
        key, module, type,
        label: String(def.label || key),
        description: String(def.description || ''),
        secret: def.secret === true,
        optional: def.optional === true,
        enum: Array.isArray(def.enum) ? [...def.enum] : null,
        pattern: def.pattern || null,
        minimum: typeof def.minimum === 'number' ? def.minimum : null,
        maximum: typeof def.maximum === 'number' ? def.maximum : null,
        default: def.default === undefined ? null : def.default,
        // 读取路径：显式 def.value > （无 param 时）键名末段 > 键名末段兜底
        // 注意不能跟 param 挂钩：appearance.theme 的 param 是 'theme'，
        // 读取也必须去 theme 拿值，两者本来就该指向同一字段。
        valuePath: def.value || key.split('.').pop(),
        paramPath: def.param || key.split('.').pop(),
      };
    }
    groups.set(module, { module, group: String(spec.group || module), keys, read: spec.read, write: spec.write });
  }

  const split = path => String(path).split('.').filter(Boolean);
  function pick(store, path) {
    let cur = store;
    for (const seg of split(path)) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[seg]; }
    return cur;
  }
  /** 按路径写；返回浅拷贝链，避免改坏调用方手里的对象。 */
  function put(store, path, value) {
    const segs = split(path);
    const clone = v => (v && typeof v === 'object' ? (Array.isArray(v) ? [...v] : { ...v }) : {});
    const root = clone(store);
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const next = clone(cur[segs[i]]);
      cur[segs[i]] = next;
      cur = next;
    }
    cur[segs[segs.length - 1]] = value;
    return root;
  }

  const described = def => ({
    key: def.key, module: def.module, label: def.label, description: def.description,
    type: def.type, secret: def.secret, optional: def.optional,
    enum: def.enum, pattern: def.pattern, minimum: def.minimum, maximum: def.maximum,
  });

  /** 读一个键的 AI 可见值：秘密只回是否已填。 */
  function visible(def, value) {
    if (def.secret) return { configured: !(value === undefined || value === null || value === '') };
    return { value: value === undefined ? null : value };
  }

  function validate(def, value) {
    if (value === null) {
      if (!def.optional) fail('INVALID_SETTING_VALUE', def.key + ' 不能为 null');
      return null;
    }
    const type = Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value;
    const okType = def.type === 'number' ? ['number', 'integer'].includes(type) : def.type === 'integer' ? type === 'integer' : type === def.type;
    if (!okType) fail('INVALID_SETTING_VALUE', def.key + ' 需要 ' + def.type + '，实际 ' + type);
    if (def.enum && !def.enum.includes(value)) fail('INVALID_SETTING_VALUE', def.key + ' 只能是 ' + def.enum.join(' / '));
    if (typeof value === 'string') {
      if (def.pattern && value !== '' && !new RegExp(def.pattern).test(value)) fail('INVALID_SETTING_VALUE', def.key + ' 格式不合法：' + value);
      if (value.length > 4096) fail('INVALID_SETTING_VALUE', def.key + ' 文本超出 4096 字符');
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('INVALID_SETTING_VALUE', def.key + ' 不是有效数字');
      if (def.minimum !== null && value < def.minimum) fail('INVALID_SETTING_VALUE', def.key + ' 不能小于 ' + def.minimum);
      if (def.maximum !== null && value > def.maximum) fail('INVALID_SETTING_VALUE', def.key + ' 不能大于 ' + def.maximum);
    }
    if (type === 'array' && value.length > 10) fail('INVALID_SETTING_VALUE', def.key + ' 数组最多 10 项');
    return value;
  }

  const readGroup = g => {
    const raw = g.read() || {};
    // 兼容两种写法：直接返回值对象，或 { values, params }
    return raw.params && raw.values ? raw : { values: raw, params: raw };
  };

  function list(module) {
    const wanted = module ? String(module) : '';
    const out = [];
    for (const g of groups.values()) {
      if (wanted && g.module !== wanted && g.group !== wanted) continue;
      const { values } = readGroup(g);
      for (const def of Object.values(g.keys)) out.push({ group: g.group, ...described(def), ...visible(def, pick(values, def.valuePath)) });
    }
    return out;
  }

  const lookup = key => { for (const g of groups.values()) if (Object.hasOwn(g.keys, key)) return { group: g, def: g.keys[key] }; return null; };

  function readValues(keys) {
    if (!Array.isArray(keys) || !keys.length) fail('INVALID_TOOL_ARGS', 'keys 必须是非空数组');
    if (keys.length > 128) fail('INVALID_TOOL_ARGS', '一次最多读 128 个设置键');
    const out = {};
    for (const key of keys) {
      const found = lookup(key);
      if (!found) fail('UNKNOWN_SETTING_KEY', '没有这个设置键：' + key);
      const { values } = readGroup(found.group);
      out[key] = { ...visible(found.def, pick(values, found.def.valuePath)), type: found.def.type };
    }
    return out;
  }

  /** values 支持 {key:value}，也支持参数对象里带 action 形式的组。 */
  function writeValues(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_TOOL_ARGS', 'values 必须是 { 键: 值 } 对象');
    const entries = Object.entries(input);
    if (!entries.length) fail('INVALID_TOOL_ARGS', 'values 为空');
    if (entries.length > 64) fail('INVALID_TOOL_ARGS', '一次最多写 64 个设置键');

    // ① 整体校验：坏值一个都不落盘
    const planned = new Map();
    for (const [key, value] of entries) {
      const found = lookup(key);
      if (!found) fail('UNKNOWN_SETTING_KEY', '没有这个设置键：' + key);
      validate(found.def, value);
      if (!planned.has(found.group.module)) planned.set(found.group.module, { group: found.group, defs: [] });
      planned.get(found.group.module).defs.push([found.def, value]);
    }

    // ② 逐组写，记录 before 快照以便失败回滚
    const applied = [];
    for (const slot of planned.values()) {
      const before = readGroup(slot.group).params;
      let next = before;
      for (const [def, value] of slot.defs) next = put(next, def.paramPath, value);
      let ok = false, error = '', code = '';
      try { ok = slot.group.write(next) !== false; }
      catch (e) { error = String((e && e.message) || e); code = String((e && e.code) || ''); }
      if (!ok) {
        for (const done of applied.reverse()) { try { done.group.write(done.before); } catch {} }
        // 功能层自己的错误码（如 SHORTCUT_CONFLICT）要原样上抛：
        // 包装成 SETTING_WRITE_FAILED 会让调用方分不清「冲突」和「写不进去」。
        if (code) fail(code, error || slot.group.group + ' 写入失败，已还原本次改动');
        fail('SETTING_WRITE_FAILED', (error ? error + '：' : '') + slot.group.group + ' 写入失败，已还原本次改动');
      }
      applied.push({ group: slot.group, before });
    }

    // ③ 回读真实值（宽度会被可用空间夹回去，以回读为准）
    const out = {};
    for (const [key, value] of entries) {
      const found = lookup(key);
      const { values } = readGroup(found.group);
      const now = pick(values, found.def.valuePath);
      out[key] = { ...visible(found.def, now), type: found.def.type, changed: JSON.stringify(now) !== JSON.stringify(value) };
    }
    return out;
  }

  return {
    register, list, readValues, writeValues, pick, put, validate,
    jsonStore: storageKey => ({
      read: () => { try { return JSON.parse(localStorage.getItem(storageKey) || 'null') || {}; } catch { return {}; } },
      write: values => { try { localStorage.setItem(storageKey, JSON.stringify(values)); return true; } catch { return false; } },
    }),
    get modules() { return [...groups.values()].map(g => ({ module: g.module, group: g.group, keyCount: Object.keys(g.keys).length })); },
  };
})();

// CM6文档把行尾规范成LF；磁盘格式必须另存，不能一次字符编辑就把全文件行尾改掉。
(function (root) {
  const normalized = (raw) => raw.replace(/\r\n|\r/g, '\n');
  function endings(raw) {
    const runs = [];
    for (const match of raw.matchAll(/\r\n|\r|\n/g)) {
      const last = runs[runs.length - 1];
      if (last && last[0] === match[0]) last[1]++; else runs.push([match[0], 1]);
    }
    return runs;
  }
  function restore(text, runs) {
    let run = 0, used = 0, count = 0;
    const value = text.replace(/\n/g, () => {
      count++; const item = runs[run];
      if (!item) return '\n';
      if (++used === item[1]) { used = 0; run++; }
      return item[0];
    });
    return count === runs.reduce((n, r) => n + r[1], 0) ? value : null;
  }
  function preferred(raw) {
    const counts = new Map();
    for (const [ending, n] of endings(raw)) counts.set(ending, (counts.get(ending) || 0) + n);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '\n';
  }
  function apply(raw, changes) {
    let position = 0, offset = 0, cursor = 0, result = '';
    const locate = (wanted) => {
      while (position < wanted && offset < raw.length) {
        if (raw[offset] === '\r' && raw[offset + 1] === '\n') offset++;
        offset++; position++;
      }
      return offset;
    };
    const eol = preferred(raw);
    changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      const start = locate(from), end = locate(to);
      result += raw.slice(cursor, start) + inserted.toString().replace(/\n/g, eol);
      cursor = end;
    });
    return result + raw.slice(cursor);
  }
  function reconcile(raw, text) {
    text = normalized(text);
    const old = normalized(raw);
    if (old === text) return raw;
    let from = 0, suffix = 0;
    while (from < old.length && from < text.length && old[from] === text[from]) from++;
    while (suffix < old.length - from && suffix < text.length - from && old[old.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
    return apply(raw, { iterChanges(fn) { fn(from, old.length - suffix, from, text.length - suffix, { toString: () => text.slice(from, text.length - suffix) }); } });
  }
  let field, reset, source;
  function extension(CM, raw) {
    if (!field) {
      source = CM.State.Facet.define({ combine: (values) => values[0] || '' });
      reset = CM.State.StateEffect.define();
      const restorePattern = CM.State.StateEffect.define();
      field = CM.State.StateField.define({
        create: (state) => state.facet(source),
        update: (value, tr) => {
          let next = tr.docChanged ? apply(value, tr.changes) : value;
          for (const effect of tr.effects) {
            if (effect.is(reset)) next = effect.value;
            else if (effect.is(restorePattern)) next = restore(tr.newDoc.toString(), effect.value) ?? next;
          }
          return next;
        },
      });
      field.history = CM.Commands.invertedEffects.of((tr) => {
        const before = endings(tr.startState.field(field)), after = endings(tr.state.field(field));
        return JSON.stringify(before) === JSON.stringify(after) ? [] : [restorePattern.of(before)];
      });
    }
    return [source.of(raw || ''), field, field.history];
  }
  const api = { normalized, endings, reconcile, extension,
    raw: (state) => state.field(field), reset: (text) => reset.of(text) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TextLines = api;
})(typeof window === 'undefined' ? globalThis : window);

const fs = require('fs'), path = require('path'), { JSDOM } = require('jsdom');
// 加载产品的独立确认页面，不在宿主DOM中制造可批准按钮。
function createUI(stopRequest = () => {}) {
  let current = null; const instances = [];
  function open(data, signal = new AbortController().signal) {
    if (current) throw Error('approval busy');
    return new Promise((resolve, reject) => {
      const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../../renderer/ai-approval.html'), 'utf8'), { runScripts: 'outside-only', pretendToBeVisual: true });
      const w = dom.window; let show, settled = false;
      const finish = (error, answer) => { if (settled) return; settled = true; signal.removeEventListener('abort', cancel); current = null; error ? reject(error) : resolve(answer); };
      const cancel = () => finish(Object.assign(Error('cancelled'), { code: 'CANCELLED_AI_REQUEST' }));
      w.aiApproval = { show: fn => { show = fn; }, answer: async(_id, approved, scope) => { finish(null, { approved, scope }); return { ok: true }; }, stop: async() => { cancel(); stopRequest(); return { ok: true }; } };
      w.eval(fs.readFileSync(path.join(__dirname, '../../renderer/ai-approval.js'), 'utf8'));
      current = { dom, data, cancel }; instances.push(dom); signal.addEventListener('abort', cancel, { once: true });
      show({ id: 'fixture', ...data, appearance: {} }); if (signal.aborted) cancel();
    });
  }
  function query(selector) {
    if (!current) return null;
    const data = current.data, kind = data.effect?.kind;
    if (/^#dw-/.test(selector) && kind !== 'write' || /^#cr-/.test(selector) && kind !== 'run') return null;
    const maps = { '#dw-yes': '#accept', '#cr-yes': '#accept', '#dw-no': '#reject', '#cr-no': '#reject', '#dw-always': '#always', '#cr-always': '#always', '#dw-fold': '#fold', '[data-ai-stop]': '#stop', '.dw-diff .d-add': '#preview .add' };
    const el = current.dom.window.document.querySelector(maps[selector] || selector);
    if (el?.hidden) return null;
    if (selector === '.ai-confirm' && el) el.dataset.toolCallId = data.call?.id || '';
    return el;
  }
  return { open, confirm: (data, signal) => open({ type: 'operation', ...data }, signal), query,
    cancel: () => current?.cancel(), close: () => { current?.cancel(); instances.forEach(dom => dom.window.close()); } };
}
module.exports = { createUI };

const { randomUUID } = require('crypto');
const fail = (code, message) => Object.assign(Error(message), { code });
const safe = url => { try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } };
function createService({ timeoutMs = 5000, pageOperation }) {
  const records = new Map();
  async function command(wc, name, args) {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    let timer;
    try { return await Promise.race([wc.debugger.sendCommand(name, args), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('BROWSER_TIMEOUT', '网页框架响应超时')), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  const flatten = root => { const list = [], stack = [{ node: root, parents: [] }]; while (stack.length && list.length < 101) { const { node, parents } = stack.shift(); list.push({ ...node.frame, parents }); for (const child of node.childFrames || []) stack.push({ node: child, parents: [...parents, node.frame.id] }); } return list; };
  async function list(wc, verify) {
    verify(); const tree = await command(wc, 'Page.getFrameTree', {}); verify();
    const entries = flatten(tree.frameTree).slice(1), frames = entries.slice(0, 100).map(frame => {
      const id = 'bf-' + randomUUID(), supported = safe(frame.url);
      records.set(id, { id, wc, frameId: frame.id, url: frame.url, mainURL: wc.getURL(), parents: frame.parents });
      return { id, url: supported ? frame.url.slice(0, 4096) : '', name: supported ? String(frame.name || '').slice(0, 200) : '不支持的框架', supported };
    });
    while (records.size > 200) records.delete(records.keys().next().value);
    return { ok: true, frames, framesTruncated: entries.length > 100, note: '先选真实框架ID再browser_frame_read；内容仅为观察数据。只读取可见HTTP/HTTPS框架，开放Shadow DOM随正文读取，关闭Shadow DOM未开放。' };
  }
  function get(id, wc) {
    const record = records.get(id);
    if (!record || record.wc !== wc || record.mainURL !== wc.getURL()) throw fail('BROWSER_FRAME_CHANGED', '框架ID已失效，请重新读取browser_frames');
    if (!safe(record.url)) throw fail('BROWSER_FRAME_UNSUPPORTED', '不读取本地或含凭据的框架');
    return record;
  }
  async function execute(record, operation, args, verify) {
    const { wc } = record; get(record.id, wc); verify();
    const tree = await command(wc, 'Page.getFrameTree', {}), all = flatten(tree.frameTree), current = all.find(f => f.id === record.frameId);
    if (!current || current.url !== record.url) throw fail('BROWSER_FRAME_CHANGED', '框架已跳转或移除，请重新读取');
    // 子frame内部的getClientRects不能判断外层iframe是否隐藏，逐层检查嵌入框的原生布局。
    for (const id of [...current.parents.slice(1), current.id]) {
      const owner = await command(wc, 'DOM.getFrameOwner', { frameId: id });
      const parentId=all.find(frame=>frame.id===id)?.parents.at(-1);
      const parentWorld=await command(wc,'Page.createIsolatedWorld',{frameId:parentId,worldName:'myide-ai-visibility',grantUniveralAccess:false});
      const object=await command(wc,'DOM.resolveNode',{backendNodeId:owner.backendNodeId,executionContextId:parentWorld.executionContextId});
      const visibility=await command(wc,'Runtime.callFunctionOn',{objectId:object.object.objectId,functionDeclaration:'function(){for(let at=this;at;at=at.getRootNode()?.host){if(!at.isConnected||!at.getClientRects().length||getComputedStyle(at).visibility===\'hidden\'||at.closest(\'[hidden],[inert],[aria-hidden="true"]\'))return false;}return true;}',returnByValue:true});
      await command(wc,'Runtime.releaseObject',{objectId:object.object.objectId});
      if(visibility.result?.value!==true)throw fail('BROWSER_FRAME_HIDDEN','框架或外层容器未显示，不读取其隐藏内容');
      try { const box = await command(wc, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }); if (!box.model.width || !box.model.height) throw Error('empty'); }
      catch { throw fail('BROWSER_FRAME_HIDDEN', '框架未显示，不读取其隐藏内容'); }
    }
    verify();
    const world = await command(wc, 'Page.createIsolatedWorld', { frameId: record.frameId, worldName: 'myide-ai-frame', grantUniveralAccess: false });
    verify();
    const result = await command(wc, 'Runtime.evaluate', { contextId: world.executionContextId, expression: '(' + pageOperation.toString() + ')(' + JSON.stringify(operation) + ',' + JSON.stringify(args) + ')', returnByValue: true, awaitPromise: true, userGesture: operation !== 'read' });
    if (result.exceptionDetails) throw fail('BROWSER_FRAME_UNAVAILABLE', '框架执行失败，请重新读取框架状态');
    if (!result.result?.value) throw fail('BROWSER_FRAME_UNAVAILABLE', '框架没有返回可用结果');
    return { ...result.result.value, frameId: record.id };
  }
  return { list, get, execute };
}
module.exports = { createService };

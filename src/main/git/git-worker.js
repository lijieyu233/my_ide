// git-worker.js —— Git 操作 worker（主进程不阻塞）
const { parentPort } = require('worker_threads');
const G = require('./git-service');

parentPort.on('message', async (msg) => {
  const { id, op, args } = msg;
  try {
    const result = await G[op](...(args || []));
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e) });
  }
});
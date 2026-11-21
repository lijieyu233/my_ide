const path = require('node:path');

const nativeId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const accountThreads = {
  currentAccountOnly: true,
  sourceKinds: ['cli', 'vscode', 'appServer'],
  sortKey: 'updated_at',
};
const maxThreadPages = 10;
const maxHistoryPages = 6;
const maxMessages = 120;
const maxHistoryChars = 600000;

function isProjectThread(thread) {
  return typeof thread?.id === 'string' && nativeId.test(thread.id) &&
    typeof thread.cwd === 'string' && path.isAbsolute(thread.cwd) &&
    !thread.ephemeral && !thread.parentThreadId;
}

function threadSummary(thread) {
  const title = [thread.name, thread.preview].find(text => typeof text === 'string' && text.trim());
  return {
    threadId: thread.id,
    rootDir: path.normalize(thread.cwd),
    title: title?.replace(/\s+/g, ' ').trim().slice(0, 120) || '未命名会话',
    ts: (thread.updatedAt || thread.createdAt || 0) * 1000,
  };
}

async function pages(request, method, params, limit, cap, onPage) {
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < cap; page++) {
    const result = await request(method, { ...params, limit, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) throw Error('Codex 返回的会话分页格式不兼容');
    if (onPage(result.data) === false) return;
    cursor = result.nextCursor;
    if (!cursor) return;
    if (typeof cursor !== 'string' || cursors.has(cursor)) throw Error('Codex 会话分页游标无效');
    cursors.add(cursor);
  }
}

async function listProjectThreads(request) {
  const threads = new Map();
  await pages(request, 'thread/list', accountThreads, 100, maxThreadPages, data => {
    for (const thread of data) {
      if (isProjectThread(thread) && !threads.has(thread.id)) {
        threads.set(thread.id, threadSummary(thread));
      }
    }
  });
  return [...threads.values()];
}

async function readProjectThread(request, threadId) {
  if (typeof threadId !== 'string' || !nativeId.test(threadId)) throw Error('Codex 会话身份无效');
  const listed = await request('thread/list', { ...accountThreads, includedThreadIds: [threadId], limit: 1 });
  if (!listed?.data?.some(thread => thread.id === threadId && isProjectThread(thread))) {
    throw Error('当前 Codex 账号的目录中找不到此会话');
  }
  const { thread } = await request('thread/read', { threadId, includeTurns: false });
  if (!isProjectThread(thread) || thread.id !== threadId) throw Error('Codex 会话身份不匹配');
  return thread;
}

function assertIdle(thread, latestTurn) {
  if (thread.status?.type === 'active' || latestTurn?.status === 'inProgress') {
    throw Error('此 Codex 会话仍在运行，请等当前轮次结束');
  }
}

async function assertThreadIdle(request, thread) {
  assertIdle(thread);
  if (thread.historyMode === 'paginated') {
    const result = await request('thread/turns/list', { threadId: thread.id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    if (!Array.isArray(result?.data)) throw Error('无法核对 Codex 会话的最新轮次');
    assertIdle(thread, result.data[0]);
  } else {
    const result = await request('thread/read', { threadId: thread.id, includeTurns: true });
    if (result.thread?.id !== thread.id || !Array.isArray(result.thread.turns)) throw Error('无法核对 Codex 会话的最新轮次');
    assertIdle(result.thread, result.thread.turns.at(-1));
  }
}

async function readMessages(request, thread) {
  let chars = 0;
  const messages = [];
  const append = item => {
    const role = item?.type === 'userMessage' ? 'user' : item?.type === 'agentMessage' ? 'assistant' : '';
    if (!role) return true;
    const text = role === 'assistant' ? item.text :
      (item.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (typeof text !== 'string' || !text.trim()) return true;
    const content = text.slice(0, Math.min(120000, maxHistoryChars - chars));
    messages.push({ role, content });
    chars += content.length;
    return messages.length < maxMessages && chars < maxHistoryChars;
  };
  if (thread.historyMode === 'paginated') {
    await pages(request, 'thread/items/list', { threadId: thread.id, sortDirection: 'desc' }, 60, maxHistoryPages,
      data => data.every(entry => append(entry.item)));
  } else {
    const result = await request('thread/read', { threadId: thread.id, includeTurns: true });
    if (result.thread?.id !== thread.id || !Array.isArray(result.thread.turns)) throw Error('Codex 会话历史格式不兼容');
    for (const turn of result.thread.turns.toReversed()) {
      if (!(turn.items || []).toReversed().every(append)) break;
    }
  }
  return messages.reverse();
}

module.exports = { isProjectThread, listProjectThreads, readProjectThread, threadSummary, readMessages, assertThreadIdle, assertIdle };

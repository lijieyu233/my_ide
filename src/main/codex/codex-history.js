const path = require('node:path');
const { createMediaReader, isMediaItem, mediaLabel } = require('./codex-media');

const nativeId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const accountThreads = {
  currentAccountOnly: true,
  useStateDbOnly: true,
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
  let title = [thread.name, thread.preview].find(text => typeof text === 'string' && text.trim());
  if (title?.startsWith('# Files mentioned by the user:') && title.includes('## My request:')) {
    title = title.slice(title.indexOf('## My request:') + '## My request:'.length).trim() || thread.cwd;
  }
  return {
    threadId: thread.id,
    projectId: typeof thread.projectId === 'string' ? thread.projectId : null,
    rootDir: path.normalize(thread.cwd),
    title: title?.replace(/\s+/g, ' ').trim().slice(0, 120) || '未命名会话',
    ts: (thread.recencyAt ?? thread.updatedAt ?? thread.createdAt ?? 0) * 1000,
  };
}

async function pages(request, method, params, limit, cap, onPage) {
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < cap; page++) {
    const result = await request(method, { ...params, limit, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) throw Error('Codex 返回的会话分页格式不兼容');
    if (await onPage(result.data) === false) return;
    cursor = result.nextCursor;
    if (!cursor) return;
    if (typeof cursor !== 'string' || cursors.has(cursor)) throw Error('Codex 会话分页游标无效');
    cursors.add(cursor);
  }
}

async function listProjects(request) {
  const projects = new Map();
  try {
    await pages(request, 'project/list', { sortKey: 'position' }, 100, maxThreadPages, data => {
      for (const project of data) {
        if (typeof project?.id !== 'string' || !project.id || typeof project.name !== 'string' || projects.has(project.id)) continue;
        const roots = (Array.isArray(project.roots) ? project.roots : [])
          .map(root => root?.path).filter(root => typeof root === 'string' && path.isAbsolute(root))
          .map(root => path.normalize(root));
        projects.set(project.id, { id: project.id, title: project.name, roots });
      }
    });
  } catch (error) {
    // Older app-servers can still show recent threads without a project registry.
    if (error.code !== -32601) throw error;
  }
  return [...projects.values()];
}

async function listProjectThreads(request, archived = false) {
  const threads = new Map();
  await pages(request, 'thread/list', { ...accountThreads, archived }, 100, maxThreadPages, data => {
    for (const thread of data) {
      if (isProjectThread(thread) && !threads.has(thread.id)) {
        threads.set(thread.id, { ...threadSummary(thread), archived, rolloutPath: thread.path, running: !archived && thread.status?.type === 'active' });
      }
    }
  });
  return [...threads.values()];
}

async function findProjectThread(request, threadId, archived = false) {
  if (typeof threadId !== 'string' || !nativeId.test(threadId)) throw Error('Codex 会话身份无效');
  const listed = await request('thread/list', { ...accountThreads, includedThreadIds: [threadId], limit: 1, archived });
  return listed?.data?.find(thread => thread.id === threadId && isProjectThread(thread));
}

async function readProjectThread(request, threadId, archived = false) {
  if (!await findProjectThread(request, threadId, archived)) {
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

function activityTitle(summary) {
  const text = Array.isArray(summary) ? summary.find(part => typeof part === 'string' && part.trim()) : summary;
  if (typeof text !== 'string') return '';
  const line = text.trim().split(/\r?\n/, 1)[0];
  return (line.match(/^\s*\*\*(.+?)\*\*/)?.[1] || line.replace(/^(?:#+|[-*])\s+/, '')).trim().slice(0, 120);
}

async function readMessages(request, thread, redact) {
  let chars = 0, commands = 0, deferredReads = 0, activity = '', latestTurn, inLatestTurn = true;
  const messages = [], readMedia = createMediaReader();
  const append = async (item, turnId) => {
    if (!item) return true;
    latestTurn ??= turnId;
    if (inLatestTurn && turnId === latestTurn) {
      if (item.type === 'userMessage') inLatestTurn = false;
      else if (!activity && item.type === 'reasoning') activity = redact(activityTitle(item.summary));
      else if (!activity && item.type === 'commandExecution' && item.status === 'inProgress') activity = '正在执行命令';
    }
    if (item.type === 'reasoning') return true;
    const imgs = await readMedia(item);
    if (imgs.length && item.type !== 'userMessage') {
      const _codexMedia = mediaLabel(item, imgs.length);
      messages.push({ role: 'assistant', content: '', _imgs: imgs, _codexMedia, _codexMediaId: item.id });
      return messages.length < maxMessages;
    }
    if (item?.type === 'commandExecution' && typeof item.id === 'string' && typeof item.command === 'string') {
      if (commands >= 32) return true;
      const command = redact(item.command).slice(0, 1600);
      const status = item.status === 'inProgress' ? 'in_progress' : item.status === 'completed' ? 'completed' : 'failed';
      messages.push({ role: 'assistant', content: '', _codexCommand: JSON.stringify([item.id, status, command]),
        _dshTimeline: [{ kind: 'tool', call: { id: item.id, name: 'commandExecution', args: { command } }, status }] });
      commands++;
      return messages.length < maxMessages;
    }
    const role = item?.type === 'userMessage' ? 'user' : item?.type === 'agentMessage' ? 'assistant' : '';
    if (!role) return true;
    const text = role === 'assistant' ? item.text :
      (item.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (typeof text !== 'string' || !text.trim() && !imgs.length) return true;
    const content = text.slice(0, Math.min(120000, maxHistoryChars - chars));
    messages.push({ role, content, ...(imgs.length ? { _imgs: imgs } : {}) });
    chars += content.length;
    return messages.length < maxMessages && chars < maxHistoryChars;
  };
  if (thread.historyMode === 'paginated') {
    await pages(request, 'thread/items/list', { threadId: thread.id, sortDirection: 'desc' }, 60, maxHistoryPages,
      async data => {
        for (const entry of data) {
          let item = entry.item;
          if (entry.outputDeferred && isMediaItem(item) && deferredReads++ < 6) {
            try {
              const result = await request('thread/items/read', { threadId: thread.id, turnId: entry.turnId, itemIds: [item.id] });
              item = result.data.find(value => value.item?.id === item.id)?.item || item;
            } catch {}
          }
          if (!await append(item, entry.turnId)) return false;
        }
      });
  } else {
    const result = await request('thread/read', { threadId: thread.id, includeTurns: true });
    if (result.thread?.id !== thread.id || !Array.isArray(result.thread.turns)) throw Error('Codex 会话历史格式不兼容');
    turns: for (const turn of result.thread.turns.toReversed()) {
      for (const item of (turn.items || []).toReversed()) {
        if (!await append(item, turn.id)) break turns;
      }
    }
  }
  return { messages: messages.reverse(), activity };
}

module.exports = { isProjectThread, listProjects, listProjectThreads, findProjectThread, readProjectThread, threadSummary, readMessages, activityTitle, assertThreadIdle, assertIdle };

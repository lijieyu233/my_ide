'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const { Agent, WebSocket } = require('undici');

const endpoint = new URL(process.env.MYIDE_CODEX_BRIDGE_URL);
if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.username || endpoint.password) {
  throw Error('Codex shared connection must use a loopback address');
}
const token = fs.readFileSync(process.env.MYIDE_CODEX_BRIDGE_TOKEN, 'utf8').trim();
const dispatcher = new Agent();
const socket = new WebSocket(endpoint, { dispatcher, headers: { Authorization: 'Bearer ' + token } });
const connectionTimeout = setTimeout(() => fail('Codex shared host did not respond'), 8000);
let input;
let connectionClosed = false;
const desktop = process.env.MYIDE_CODEX_BRIDGE_CLIENT === 'desktop';
const activeTurns = new Map();
const historyReads = new Map();
let liveRevision = 0;
const pendingEfforts = new Map();
const relayedUpdates = new Set();

function desktopInput(line) {
  const message = JSON.parse(line);
  const { threadId, effort } = message.params || {};
  if (typeof threadId !== 'string' || message.id == null) return;
  if (['thread/read', 'thread/resume', 'thread/turns/list'].includes(message.method)) {
    historyReads.set(message.id, { threadId, liveRevision });
  }
  if (message.method !== 'thread/settings/update') return;
  const turnId = activeTurns.get(threadId);
  if (turnId && typeof effort === 'string') pendingEfforts.set(message.id, { threadId, turnId, effort });
}

function desktopOutput(line) {
  const message = JSON.parse(line);
  if (relayedUpdates.delete(message.id)) return false;
  const { threadId, turn } = message.params || {};
  if (message.method === 'turn/started' && threadId && turn?.id) {
    liveRevision++;
    activeTurns.set(threadId, turn.id);
  }
  if (message.method === 'turn/completed' && threadId) {
    liveRevision++;
    if (activeTurns.get(threadId) === turn?.id) activeTurns.delete(threadId);
  }
  const read = historyReads.get(message.id);
  if (read) {
    historyReads.delete(message.id);
    const turns = message.result?.thread?.turns || message.result?.data;
    if (read.liveRevision === liveRevision && Array.isArray(turns) && !activeTurns.has(read.threadId)) {
      const current = turns.find(item => item.status === 'inProgress');
      if (current?.id) activeTurns.set(read.threadId, current.id);
    }
  }

  // Desktop persists the selected effort for later turns. If it was changed
  // while watching an active turn, apply it to that same turn as well.
  const selected = pendingEfforts.get(message.id);
  if (selected) {
    pendingEfforts.delete(message.id);
    if (!message.error && activeTurns.get(selected.threadId) === selected.turnId) {
      const id = 'myide-live-effort-' + randomUUID();
      relayedUpdates.add(id);
      socket.send(JSON.stringify({ id, method: 'turn/settings/update', params: selected }));
    }
  }
  return true;
}

function finish(code) {
  if (connectionClosed) return;
  connectionClosed = true;
  clearTimeout(connectionTimeout);
  input?.close();
  process.stdin.destroy();
  void dispatcher.destroy();
  process.exitCode = code;
}

function fail(message) {
  process.stderr.write(message + '\n');
  socket.close();
  finish(1);
}

socket.addEventListener('open', () => {
  clearTimeout(connectionTimeout);
  input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (socket.readyState !== WebSocket.OPEN || !line.trim()) return;
    try { if (desktop) desktopInput(line); }
    catch { return fail('Codex Desktop sent an invalid frame'); }
    socket.send(line);
  });
  input.once('close', () => socket.close());
}, { once: true });
socket.addEventListener('message', event => {
  if (typeof event.data !== 'string') return fail('Codex shared host sent an invalid frame');
  try { if (!desktop || desktopOutput(event.data)) process.stdout.write(event.data + '\n'); }
  catch { fail('Codex shared host sent an invalid frame'); }
});
socket.addEventListener('error', () => fail('Codex shared connection failed'), { once: true });
socket.addEventListener('close', event => finish(event.code === 1000 ? process.exitCode || 0 : 1), { once: true });

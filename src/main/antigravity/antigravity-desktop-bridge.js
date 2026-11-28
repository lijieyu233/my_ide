'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { defaultGeminiDir, listProjects, normalizeLocalPath } = require('./antigravity-desktop-reader');

const PLUGIN_ID = 'myide-desktop-bridge';
const SIDECAR_NAME = 'launcher';
const SIDECAR_KEY = PLUGIN_ID + '/' + SIDECAR_NAME;
const REMOTE_CONTROL_URL = 'https://antigravity.google.com';

function bridgePaths(geminiDir = defaultGeminiDir()) {
  const configDir = path.join(geminiDir, 'config');
  const pluginDir = path.join(configDir, 'plugins', PLUGIN_ID);
  const sidecarDir = path.join(pluginDir, 'sidecars', SIDECAR_NAME);
  const dataRoot = path.join(geminiDir, 'antigravity', 'sidecar_data', PLUGIN_ID);
  const sidecarDataDir = path.join(geminiDir, 'antigravity', 'sidecar_data', PLUGIN_ID, SIDECAR_NAME, 'data');
  return {
    geminiDir,
    configFile: path.join(configDir, 'config.json'),
    configBackup: path.join(configDir, 'config.json.myide-backup'),
    pluginDir,
    sidecarDir,
    dataRoot,
    eventsFile: path.join(dataRoot, 'live-events.jsonl'),
    sidecarDataDir,
    requestsDir: path.join(sidecarDataDir, 'requests'),
    responsesDir: path.join(sidecarDataDir, 'responses'),
    heartbeatFile: path.join(sidecarDataDir, 'heartbeat.json'),
  };
}

function buildHookObserverScript(eventsFile) {
  return `'use strict';
// MyIDE read-only desktop lifecycle observer hook.
// Records non-sensitive lifecycle events (no prompts, no tokens, no raw args)
// and always outputs {} so Antigravity native permissions are never altered.
const fs = require('node:fs');
const path = require('node:path');

const EVENTS_FILE = ${JSON.stringify(eventsFile)};
const MAX_BYTES = 512 * 1024;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < 256 * 1024) raw += chunk;
});
process.stdin.on('end', () => {
  try {
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const record = {
      ts: Date.now(),
      event: String(payload.hookEventName || ''),
      conversationId: String(payload.conversationId || ''),
      workspacePaths: Array.isArray(payload.workspacePaths) ? payload.workspacePaths.filter(v => typeof v === 'string').slice(0, 8) : [],
      modelName: String(payload.modelName || ''),
      toolName: String(payload.toolCall?.name || ''),
      stepIdx: Number.isFinite(payload.stepIdx) ? payload.stepIdx : null,
      hasError: Boolean(payload.error),
    };
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    try {
      const stat = fs.statSync(EVENTS_FILE);
      if (stat.size > MAX_BYTES) {
        const tail = fs.readFileSync(EVENTS_FILE, 'utf8').split(/\\r?\\n/).filter(Boolean).slice(-200).join('\\n') + '\\n';
        fs.writeFileSync(EVENTS_FILE, tail, 'utf8');
      }
    } catch {}
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(record) + '\\n', 'utf8');
  } catch {}
  process.stdout.write('{}\\n');
});
`;
}

function buildSidecarLauncherScript(fallbackDataDir) {
  return `'use strict';
// MyIDE official Antigravity Sidecar launcher.
// Polls local request queue and creates new desktop conversations via official
// ConversationService (when injected) or agentapi new-conversation.
// Never logs or persists CSRF tokens or credentials.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || ${JSON.stringify(fallbackDataDir)};
const REQ_DIR = path.join(DATA_DIR, 'requests');
const RES_DIR = path.join(DATA_DIR, 'responses');
const HEARTBEAT = path.join(DATA_DIR, 'heartbeat.json');
const inFlight = new Set();

async function ensureDirs() {
  await fsp.mkdir(REQ_DIR, { recursive: true });
  await fsp.mkdir(RES_DIR, { recursive: true });
}

async function writeAtomic(file, obj) {
  const tmp = file + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(obj), 'utf8');
  await fsp.rename(tmp, file);
}

async function writeHeartbeat() {
  try {
    await ensureDirs();
    await writeAtomic(HEARTBEAT, {
      pid: process.pid,
      updatedAt: Date.now(),
      hasLsApi: Boolean(process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN),
      hasAgentApi: true,
    });
  } catch {}
}

async function createViaLsApi(req) {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const token = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !token) return null;
  const body = {
    ...(req.projectId ? { projectId: String(req.projectId) } : {}),
    ...(req.title ? { title: String(req.title).slice(0, 120) } : {}),
    ...(req.model ? { model: String(req.model) } : {}),
    prompt: [{ text: String(req.prompt) }],
  };
  const res = await fetch('http://' + addr + '/product.v1.ConversationService/CreateConversation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-antigravity-csrf-token': token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('CreateConversation HTTP ' + res.status);
  const data = await res.json();
  const id = data?.conversation?.id || data?.id || '';
  return { ok: true, via: 'conversation_service', conversationId: id };
}

function createViaAgentApi(req) {
  return new Promise((resolve, reject) => {
    const args = ['new-conversation'];
    if (req.title) args.push('--title=' + String(req.title).slice(0, 120));
    if (req.model) args.push('--model=' + String(req.model));
    args.push('--', String(req.prompt));
    const bin = process.platform === 'win32' ? 'agentapi.bat' : 'agentapi';
    execFile(bin, args, { windowsHide: true, timeout: 15000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message || 'agentapi failed').slice(0, 300)));
      let conversationId = '';
      try {
        const parsed = JSON.parse(String(stdout || '{}'));
        conversationId = parsed?.response?.newConversation?.conversationId
          || parsed?.conversation?.id
          || parsed?.conversationId
          || parsed?.id
          || '';
      } catch {}
      resolve({ ok: true, via: 'agentapi', conversationId });
    });
  });
}

async function processRequest(filename) {
  if (inFlight.has(filename)) return;
  inFlight.add(filename);
  const reqPath = path.join(REQ_DIR, filename);
  let req;
  try {
    req = JSON.parse(await fsp.readFile(reqPath, 'utf8'));
  } catch {
    inFlight.delete(filename);
    return;
  }
  const id = String(req?.id || filename.replace(/\\.json$/, ''));
  const resPath = path.join(RES_DIR, id + '.json');
  try {
    if (typeof req?.prompt !== 'string' || !req.prompt.trim() || req.prompt.length > 32000) {
      throw new Error('无效的新建会话内容');
    }
    let result = null;
    try { result = await createViaLsApi(req); } catch {}
    if (!result) result = await createViaAgentApi(req);
    await writeAtomic(resPath, { id, ...result, finishedAt: Date.now() });
  } catch (error) {
    await writeAtomic(resPath, { id, ok: false, error: String(error?.message || '新建桌面会话失败').slice(0, 300), finishedAt: Date.now() });
  } finally {
    try { await fsp.unlink(reqPath); } catch {}
    inFlight.delete(filename);
  }
}

async function poll() {
  try {
    await ensureDirs();
    const entries = await fsp.readdir(REQ_DIR);
    for (const name of entries) {
      if (name.endsWith('.json')) void processRequest(name);
    }
  } catch {}
}

void writeHeartbeat();
void poll();
setInterval(() => { void writeHeartbeat(); }, 5000);
setInterval(() => { void poll(); }, 400);
`;
}

async function readJsonSafe(file, fallback = {}) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeAtomicJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.myide-tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
}

async function install({ geminiDir = defaultGeminiDir(), nodePath = process.execPath } = {}) {
  const paths = bridgePaths(geminiDir);
  await fsp.mkdir(paths.sidecarDir, { recursive: true });
  await fsp.mkdir(paths.requestsDir, { recursive: true });
  await fsp.mkdir(paths.responsesDir, { recursive: true });

  const nodeBin = /electron(\.exe)?$/i.test(path.basename(nodePath || '')) ? 'node' : (nodePath || 'node');

  await writeAtomicJson(path.join(paths.pluginDir, 'plugin.json'), {
    name: PLUGIN_ID,
    description: 'MyIDE desktop live status observer (Hooks) & new-conversation launcher (Sidecar)',
  });

  await fsp.writeFile(
    path.join(paths.pluginDir, 'hook-observer.js'),
    buildHookObserverScript(paths.eventsFile),
    'utf8'
  );

  const hookEntry = [{ type: 'command', command: nodeBin + ' ./hook-observer.js', timeout: 5 }];
  // Never register PreToolUse: a pure observer must not sit on the tool-approval critical path.
  await writeAtomicJson(path.join(paths.pluginDir, 'hooks.json'), {
    'myide-desktop-observer': {
      enabled: true,
      SessionStart: hookEntry,
      PostToolUse: [{ matcher: '*', hooks: hookEntry }],
      Stop: hookEntry,
    },
  });

  await fsp.writeFile(
    path.join(paths.sidecarDir, 'launcher.js'),
    buildSidecarLauncherScript(paths.sidecarDataDir),
    'utf8'
  );

  await writeAtomicJson(path.join(paths.sidecarDir, 'sidecar.json'), {
    display_name: 'MyIDE Desktop Bridge',
    description: 'Allows MyIDE to trigger new Antigravity Desktop conversations via official agentapi.',
    command: nodeBin,
    args: ['launcher.js'],
    restart_policy: 'on-failure',
  });

  // Back up config.json once and merge only our plugin + sidecar flags.
  let config = {};
  try {
    const raw = await fsp.readFile(paths.configFile, 'utf8');
    config = JSON.parse(raw);
    try { await fsp.copyFile(paths.configFile, paths.configBackup, fs.constants.COPYFILE_EXCL); } catch {}
  } catch (error) {
    if (error.code !== 'ENOENT') throw Object.assign(new Error('Antigravity config.json 解析失败，已中止写入'), { code: 'AGY_CONFIG_CORRUPT' });
  }

  config.plugins = { ...(config.plugins || {}), [PLUGIN_ID]: { enabled: true } };
  config.sidecars = { ...(config.sidecars || {}), [SIDECAR_KEY]: { ...(config.sidecars?.[SIDECAR_KEY] || {}), enabled: true } };
  await writeAtomicJson(paths.configFile, config);

  return {
    ok: true,
    installed: true,
    pluginDir: paths.pluginDir,
    note: '已安装 MyIDE 桌面联动插件（Hooks 实时监听 + Sidecar 新建会话）。如 Antigravity 桌面端正在运行，重启一次桌面端即可加载 Sidecar。',
    status: await status({ geminiDir }),
  };
}

async function uninstall({ geminiDir = defaultGeminiDir() } = {}) {
  const paths = bridgePaths(geminiDir);
  await fsp.rm(paths.pluginDir, { recursive: true, force: true });
  try {
    const config = await readJsonSafe(paths.configFile, null);
    if (config && typeof config === 'object') {
      if (config.plugins) delete config.plugins[PLUGIN_ID];
      if (config.sidecars) delete config.sidecars[SIDECAR_KEY];
      await writeAtomicJson(paths.configFile, config);
    }
  } catch {}
  return { ok: true, installed: false, status: await status({ geminiDir }) };
}

async function readLiveEvents({ geminiDir = defaultGeminiDir(), limit = 40 } = {}) {
  const paths = bridgePaths(geminiDir);
  try {
    const text = await fsp.readFile(paths.eventsFile, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-Math.max(1, Math.min(200, limit)));
    const events = [];
    for (const line of tail) {
      try { events.push(JSON.parse(line)); } catch {}
    }
    return events;
  } catch {
    return [];
  }
}

async function status({ geminiDir = defaultGeminiDir() } = {}) {
  const paths = bridgePaths(geminiDir);
  const pluginManifest = path.join(paths.pluginDir, 'plugin.json');
  const installed = fs.existsSync(pluginManifest);
  let pluginEnabled = false;
  let sidecarEnabled = false;
  try {
    const cfg = await readJsonSafe(paths.configFile, {});
    pluginEnabled = cfg?.plugins?.[PLUGIN_ID]?.enabled === true;
    sidecarEnabled = cfg?.sidecars?.[SIDECAR_KEY]?.enabled === true;
  } catch {}

  let heartbeat = null;
  let sidecarAlive = false;
  try {
    heartbeat = await readJsonSafe(paths.heartbeatFile, null);
    if (heartbeat && Number.isFinite(heartbeat.updatedAt) && Date.now() - heartbeat.updatedAt < 15000) {
      sidecarAlive = true;
    }
  } catch {}

  const events = await readLiveEvents({ geminiDir, limit: 20 });
  return {
    ok: true,
    installed,
    pluginEnabled,
    sidecarEnabled,
    sidecarAlive,
    heartbeat,
    remoteControlUrl: REMOTE_CONTROL_URL,
    latestEvent: events.at(-1) || null,
    recentEvents: events,
  };
}

async function createDesktopConversation({ geminiDir = defaultGeminiDir(), workspaceRoot = '', projectId = '', prompt = '', title = '', model = '', timeoutMs = 15000 } = {}) {
  const text = String(prompt || '').trim();
  if (!text) return { ok: false, errorCode: 'INVALID_PROMPT', error: '请输入要发送给 Antigravity 桌面端的首条消息' };
  if (text.length > 32000) return { ok: false, errorCode: 'PROMPT_TOO_LONG', error: '消息内容过长' };

  const current = await status({ geminiDir });
  if (!current.installed || !current.sidecarEnabled) {
    return { ok: false, errorCode: 'BRIDGE_NOT_INSTALLED', error: '请先安装并启用 MyIDE 桌面联动插件（Sidecar）' };
  }
  if (!current.sidecarAlive) {
    return { ok: false, errorCode: 'SIDECAR_NOT_RUNNING', error: '桌面联动 Sidecar 尚未运行，请打开或重启一次 Antigravity 桌面端后再试' };
  }

  let resolvedProjectId = String(projectId || '').trim();
  if (!resolvedProjectId && workspaceRoot) {
    const normRoot = normalizeLocalPath(workspaceRoot);
    const projects = await listProjects({ geminiDir });
    const match = projects.find(p => p.normRoots.includes(normRoot));
    if (match) resolvedProjectId = match.id;
  }

  const paths = bridgePaths(geminiDir);
  await fsp.mkdir(paths.requestsDir, { recursive: true });
  await fsp.mkdir(paths.responsesDir, { recursive: true });

  const id = 'req-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex');
  const reqFile = path.join(paths.requestsDir, id + '.json');
  const resFile = path.join(paths.responsesDir, id + '.json');

  await writeAtomicJson(reqFile, {
    id,
    projectId: resolvedProjectId,
    prompt: text,
    title: String(title || '').trim().slice(0, 120),
    model: String(model || '').trim(),
    createdAt: Date.now(),
  });

  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    try {
      const receipt = JSON.parse(await fsp.readFile(resFile, 'utf8'));
      try { await fsp.unlink(resFile); } catch {}
      if (receipt?.ok) {
        return { ok: true, conversationId: receipt.conversationId || '', via: receipt.via || 'sidecar', projectId: resolvedProjectId };
      }
      return { ok: false, errorCode: 'DESKTOP_CREATE_FAILED', error: receipt?.error || '桌面端新建会话失败' };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await new Promise(r => setTimeout(r, 150));
        continue;
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }

  try { await fsp.unlink(reqFile); } catch {}
  return { ok: false, errorCode: 'DESKTOP_CREATE_TIMEOUT', error: '等待桌面端新建会话回执超时，请在 Antigravity 桌面端核对是否已创建' };
}

function createEventTailer({ geminiDir = defaultGeminiDir(), onEvent, pollMs = 1500 } = {}) {
  const paths = bridgePaths(geminiDir);
  let lastOffset = 0;
  let initialized = false;
  let timer = null;

  async function poll() {
    try {
      const st = await fsp.stat(paths.eventsFile);
      if (!initialized) {
        lastOffset = st.size;
        initialized = true;
        return;
      }
      if (st.size < lastOffset) lastOffset = 0;
      if (st.size === lastOffset) return;
      const len = Math.min(st.size - lastOffset, 128 * 1024);
      const fh = await fsp.open(paths.eventsFile, 'r');
      try {
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, lastOffset);
        lastOffset += len;
        const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            onEvent?.({ type: 'hook', event });
          } catch {}
        }
      } finally {
        await fh.close();
      }
    } catch {
      initialized = true;
    }
  }

  function start() {
    if (timer) return;
    void poll();
    timer = setInterval(() => { void poll(); }, Math.max(500, pollMs));
    timer.unref?.();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop };
}

module.exports = {
  PLUGIN_ID,
  SIDECAR_KEY,
  REMOTE_CONTROL_URL,
  bridgePaths,
  install,
  uninstall,
  status,
  readLiveEvents,
  createDesktopConversation,
  createEventTailer,
};

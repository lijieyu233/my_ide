'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

let sqlPromise = null;
async function loadSqlJs() {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const initSqlJs = require('sql.js');
      return initSqlJs();
    })().catch(error => {
      sqlPromise = null;
      throw error;
    });
  }
  return sqlPromise;
}

function defaultGeminiDir() {
  return path.join(os.homedir(), '.gemini');
}

function normalizeLocalPath(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let text = value.trim();
  if (/^file:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      text = decodeURIComponent(parsed.pathname || '');
      if (/^\/[a-z]:\//i.test(text)) text = text.slice(1);
    } catch {
      return '';
    }
  } else if (/^\/[a-z]:\//i.test(text)) {
    text = text.slice(1);
    try { text = decodeURIComponent(text); } catch {}
  }
  const normalized = path.normalize(text).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function displayLocalPath(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let text = value.trim();
  if (/^file:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      text = decodeURIComponent(parsed.pathname || '');
      if (/^\/[a-z]:\//i.test(text)) text = text.slice(1);
    } catch {
      return text;
    }
  }
  return path.normalize(text).replace(/^\\\\\?\\/, '');
}

function safeConversationId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  if (!id || id.length > 128 || !/^[a-zA-Z0-9._-]+$/.test(id) || id === '.' || id === '..') return '';
  return id;
}

function safeArtifactName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  if (!name || name.length > 200 || /[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..' || !name.toLowerCase().endsWith('.md')) return '';
  return name;
}

function stripUserPromptWrappers(raw) {
  if (typeof raw !== 'string') return '';
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  if (match) return match[1].trim();
  return raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
    .trim();
}

function clipText(value, limit = 4000) {
  const text = String(value == null ? '' : value);
  return text.length > limit ? text.slice(0, limit) + '…（已截断）' : text;
}

function parseAnnotationPbtxt(text) {
  const out = {};
  if (typeof text !== 'string' || !text) return out;
  const titleMatch = /title\s*:\s*"((?:\\.|[^"\\])*)"/.exec(text);
  if (titleMatch) {
    try { out.title = JSON.parse('"' + titleMatch[1] + '"'); }
    catch { out.title = titleMatch[1]; }
  }
  const archivedMatch = /archived\s*:\s*(true|false)/.exec(text);
  if (archivedMatch) out.archived = archivedMatch[1] === 'true';
  const pinnedMatch = /pinned\s*:\s*(true|false)/.exec(text);
  if (pinnedMatch) out.pinned = pinnedMatch[1] === 'true';
  const presetMatch = /permission_preset\s*:\s*([A-Z0-9_]+)/.exec(text);
  if (presetMatch) out.permissionPreset = presetMatch[1];
  const secMatch = /last_user_view_time\s*:\s*\{\s*seconds\s*:\s*(\d+)/.exec(text);
  if (secMatch) out.lastViewMs = Number(secMatch[1]) * 1000;
  return out;
}

function extractProjectRoots(projectJson) {
  const uris = [];
  const resources = projectJson?.projectResources?.resources;
  if (Array.isArray(resources)) {
    for (const res of resources) {
      for (const candidate of [
        res?.gitFolder?.folderUri,
        res?.localFolder?.folderUri,
        res?.folder?.folderUri,
        res?.folderUri,
        res?.workspaceUri,
      ]) {
        if (typeof candidate === 'string' && candidate.trim()) uris.push(candidate.trim());
      }
    }
  }
  if (typeof projectJson?.folderUri === 'string') uris.push(projectJson.folderUri);
  return [...new Set(uris)];
}

async function listProjects({ geminiDir = defaultGeminiDir() } = {}) {
  const dir = path.join(geminiDir, 'config', 'projects');
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(dir, entry.name), 'utf8'));
      const id = String(raw?.id || entry.name.slice(0, -5));
      const uris = extractProjectRoots(raw);
      const roots = uris.map(displayLocalPath).filter(Boolean);
      const normRoots = uris.map(normalizeLocalPath).filter(Boolean);
      projects.push({
        id,
        name: String(raw?.name || roots[0] && path.basename(roots[0]) || id),
        uris,
        roots,
        normRoots,
        isSidecar: !!raw?.sidecar,
      });
    } catch {}
  }
  return projects;
}

function parseWorkspaceUrisField(value) {
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string');
  if (typeof value !== 'string' || !value.trim()) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter(v => typeof v === 'string');
    } catch {}
  }
  return trimmed.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
}

function parseTimeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function buildFtsQuery(query) {
  const tokens = String(query || '')
    .trim()
    .split(/\s+/)
    .map(token => token.replace(/["'()*^:]/g, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!tokens.length) return '';
  return tokens.map(token => '"' + token + '"').join(' AND ');
}

async function querySummariesDb(dbPath, { query = '' } = {}) {
  let buffer;
  try { buffer = await fsp.readFile(dbPath); }
  catch { return { rows: [], ftsIds: null, dbAvailable: false }; }
  if (!buffer.length) return { rows: [], ftsIds: null, dbAvailable: false };

  let SQL;
  try { SQL = await loadSqlJs(); }
  catch { return { rows: [], ftsIds: null, dbAvailable: false }; }

  let db;
  try {
    db = new SQL.Database(new Uint8Array(buffer));
    const rows = [];
    const stmt = db.prepare(
      'SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, source, project_id, agent_name, parent_conversation_id, not_fully_idle, last_user_input_time FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 500'
    );
    try {
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }

    let ftsIds = null;
    const trimmed = String(query || '').trim();
    if (trimmed) {
      ftsIds = new Set();
      // sql.js does not bundle the FTS5 virtual table module, so query FTS5's
      // backing content table directly (c0=conversation_id, c10=title, c13=user_body, c14=agent_body).
      try {
        const pattern = '%' + trimmed + '%';
        const ftsStmt = db.prepare(
          'SELECT DISTINCT c0 AS conversation_id FROM conversations_fts_content WHERE c10 LIKE ? OR c13 LIKE ? OR c14 LIKE ? LIMIT 200'
        );
        try {
          ftsStmt.bind([pattern, pattern, pattern]);
          while (ftsStmt.step()) {
            const row = ftsStmt.getAsObject();
            if (row.conversation_id) ftsIds.add(String(row.conversation_id));
          }
        } finally {
          ftsStmt.free();
        }
      } catch {
        // Fallback for test fixtures that created an FTS5 table without external content columns.
        const ftsQuery = buildFtsQuery(trimmed);
        if (ftsQuery) {
          try {
            const ftsStmt = db.prepare('SELECT DISTINCT conversation_id FROM conversations_fts WHERE conversations_fts MATCH ? LIMIT 200');
            try {
              ftsStmt.bind([ftsQuery]);
              while (ftsStmt.step()) {
                const row = ftsStmt.getAsObject();
                if (row.conversation_id) ftsIds.add(String(row.conversation_id));
              }
            } finally {
              ftsStmt.free();
            }
          } catch {
            ftsIds = null;
          }
        }
      }
    }
    return { rows, ftsIds, dbAvailable: true };
  } catch {
    return { rows: [], ftsIds: null, dbAvailable: false };
  } finally {
    try { db?.close(); } catch {}
  }
}

async function readFtsFallbackEntries(dbPath, conversationId) {
  let buffer;
  try { buffer = await fsp.readFile(dbPath); }
  catch { return []; }
  if (!buffer.length) return [];
  let SQL;
  try { SQL = await loadSqlJs(); }
  catch { return []; }
  let db;
  try {
    db = new SQL.Database(new Uint8Array(buffer));
    const entries = [];
    const stmt = db.prepare('SELECT c13 AS user_body, c14 AS agent_body FROM conversations_fts_content WHERE c0 = ? ORDER BY id ASC LIMIT 200');
    try {
      stmt.bind([conversationId]);
      let stepIndex = 0;
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const user = stripUserPromptWrappers(String(row.user_body || '')).trim();
        const agent = String(row.agent_body || '').trim();
        if (user) entries.push({ kind: 'message', role: 'user', stepIndex: stepIndex++, createdAt: 0, text: clipText(user, 16000) });
        if (agent) entries.push({ kind: 'message', role: 'assistant', stepIndex: stepIndex++, createdAt: 0, text: clipText(agent, 24000) });
      }
    } finally {
      stmt.free();
    }
    return entries;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

const ACTIVE_RECENCY_MS = 5 * 60 * 1000;

async function inspectTranscriptHead(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return null;
    const fh = await fsp.open(filePath, 'r');
    try {
      const len = Math.min(stat.size, 32 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      let firstUser = '';
      let model = '';
      let firstTime = 0;
      for (const line of lines.slice(0, 20)) {
        try {
          const item = JSON.parse(line);
          if (!firstTime && item.created_at) firstTime = parseTimeMs(item.created_at);
          if (!model && item.model) model = String(item.model);
          if (!firstUser && item.type === 'USER_INPUT' && typeof item.content === 'string') {
            firstUser = stripUserPromptWrappers(item.content).split(/\r?\n/).find(l => l.trim()) || '';
          }
        } catch {}
      }
      // Check tail for live running state if recently modified.
      let running = false;
      if (Date.now() - stat.mtimeMs < ACTIVE_RECENCY_MS) {
        let tailText = text;
        if (stat.size > len) {
          const tailLen = Math.min(stat.size, 16 * 1024);
          const tailBuf = Buffer.alloc(tailLen);
          await fh.read(tailBuf, 0, tailLen, stat.size - tailLen);
          const rawTail = tailBuf.toString('utf8');
          const nl = rawTail.indexOf('\n');
          tailText = nl >= 0 ? rawTail.slice(nl + 1) : rawTail;
        }
        const tailParsed = parseTranscriptLines(tailText, { maxSteps: 20, mtimeMs: stat.mtimeMs });
        running = tailParsed.running;
      }
      return { size: stat.size, mtimeMs: stat.mtimeMs, firstUser: clipText(firstUser, 120), model, firstTime, running };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function listConversations({ geminiDir = defaultGeminiDir(), workspaceRoot = '', scope = 'project', query = '', includeChildren = false, includeCli = false, limit = 80 } = {}) {
  const appDataDir = path.join(geminiDir, 'antigravity');
  const projects = await listProjects({ geminiDir });
  const projectById = new Map(projects.map(p => [p.id, p]));
  const normWorkspace = normalizeLocalPath(workspaceRoot);
  const matchedProjectIds = normWorkspace
    ? projects.filter(p => p.normRoots.includes(normWorkspace)).map(p => p.id)
    : [];

  const dbPath = path.join(appDataDir, 'conversation_summaries.db');
  const { rows, ftsIds, dbAvailable } = await querySummariesDb(dbPath, { query });

  const byId = new Map();
  for (const row of rows) {
    const id = safeConversationId(String(row.conversation_id || ''));
    if (!id) continue;
    const rowSource = String(row.source || '');
    if (!includeCli && rowSource === 'CORTEX_TRAJECTORY_SOURCE_CLI') continue;
    const parentId = String(row.parent_conversation_id || '');
    const uris = parseWorkspaceUrisField(row.workspace_uris);
    const projectId = String(row.project_id || '');
    const project = projectById.get(projectId);
    const roots = [...new Set([...uris.map(displayLocalPath), ...(project?.roots || [])].filter(Boolean))];
    const normRoots = [...new Set([...uris.map(normalizeLocalPath), ...(project?.normRoots || [])].filter(Boolean))];
    byId.set(id, {
      id,
      title: String(row.title || '').trim(),
      preview: clipText(stripUserPromptWrappers(String(row.preview || '')), 180),
      stepCount: Number(row.step_count) || 0,
      updatedAt: parseTimeMs(row.last_modified_time) || parseTimeMs(row.last_user_input_time) || 0,
      status: String(row.status || ''),
      running: Boolean(row.not_fully_idle),
      projectId,
      projectName: project?.name || (roots[0] ? path.basename(roots[0]) : ''),
      roots,
      normRoots,
      parentId,
      hasTranscript: false,
      source: rowSource || 'desktop',
    });
  }

  // Merge filesystem brain/ directories so newly active WAL conversations always appear.
  const brainDir = path.join(appDataDir, 'brain');
  let brainEntries = [];
  try { brainEntries = await fsp.readdir(brainDir, { withFileTypes: true }); }
  catch {}

  const annDir = path.join(appDataDir, 'annotations');
  for (const entry of brainEntries) {
    if (!entry.isDirectory()) continue;
    const id = safeConversationId(entry.name);
    if (!id) continue;
    const tPath = path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
    const head = await inspectTranscriptHead(tPath);
    if (!head) continue;

    let ann = {};
    try {
      const pbtxt = await fsp.readFile(path.join(annDir, id + '.pbtxt'), 'utf8');
      ann = parseAnnotationPbtxt(pbtxt);
    } catch {}

    const existing = byId.get(id);
    if (existing) {
      existing.hasTranscript = true;
      existing.transcriptSize = head.size;
      if (head.mtimeMs > existing.updatedAt) existing.updatedAt = head.mtimeMs;
      if (head.running) existing.running = true;
      else if (Date.now() - head.mtimeMs < ACTIVE_RECENCY_MS) existing.running = false;
      if (!existing.title && ann.title) existing.title = ann.title;
      if (!existing.title && head.firstUser) existing.title = head.firstUser;
      if (!existing.preview && head.firstUser) existing.preview = head.firstUser;
      if (head.model) existing.model = head.model;
      if (ann.archived != null) existing.archived = ann.archived;
      if (ann.pinned != null) existing.pinned = ann.pinned;
    } else {
      byId.set(id, {
        id,
        title: ann.title || head.firstUser || id.slice(0, 8),
        preview: head.firstUser || '',
        stepCount: 0,
        updatedAt: head.mtimeMs || ann.lastViewMs || head.firstTime || 0,
        status: '',
        running: !!head.running,
        projectId: '',
        projectName: '',
        roots: [],
        normRoots: [],
        parentId: '',
        hasTranscript: true,
        transcriptSize: head.size,
        model: head.model || '',
        archived: !!ann.archived,
        pinned: !!ann.pinned,
        source: 'brain',
      });
    }
  }

  const normalizedQuery = String(query || '').trim().toLowerCase();
  const allItems = [...byId.values()].filter(item => {
    if (!includeChildren && item.parentId) return false;
    return true;
  });

  const projectMatched = item => {
    if (!normWorkspace) return true;
    if (item.projectId && matchedProjectIds.includes(item.projectId)) return true;
    if (item.normRoots.includes(normWorkspace)) return true;
    return false;
  };

  let filtered = scope === 'project' && normWorkspace ? allItems.filter(projectMatched) : allItems;
  if (normalizedQuery) {
    filtered = filtered.filter(item => {
      if (ftsIds && ftsIds.has(item.id)) return true;
      return item.title.toLowerCase().includes(normalizedQuery)
        || item.preview.toLowerCase().includes(normalizedQuery)
        || item.projectName.toLowerCase().includes(normalizedQuery)
        || item.id.toLowerCase().includes(normalizedQuery);
    });
  }

  filtered.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.updatedAt || 0) - (a.updatedAt || 0));

  const items = filtered.slice(0, Math.max(1, Math.min(200, Number(limit) || 80))).map(item => ({
    id: item.id,
    title: item.title || item.preview || item.id.slice(0, 8),
    preview: item.preview,
    stepCount: item.stepCount,
    updatedAt: item.updatedAt,
    status: item.status,
    running: item.running,
    projectId: item.projectId,
    projectName: item.projectName,
    roots: item.roots,
    hasTranscript: item.hasTranscript,
    model: item.model || '',
    archived: !!item.archived,
    pinned: !!item.pinned,
    inCurrentProject: projectMatched(item),
  }));

  return {
    ok: true,
    dbAvailable,
    scope: scope === 'all' ? 'all' : 'project',
    workspaceRoot: workspaceRoot ? displayLocalPath(workspaceRoot) : '',
    matchedProjectIds,
    totalCount: allItems.length,
    projectCount: normWorkspace ? allItems.filter(projectMatched).length : allItems.length,
    projects: projects.filter(p => !p.isSidecar && p.id !== 'default-cli-project').map(p => ({ id: p.id, name: p.name, roots: p.roots })),
    items,
  };
}

function cleanToolArgs(args) {
  if (!args || typeof args !== 'object') return args;
  if (Array.isArray(args)) return args.map(cleanToolArgs);
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try { out[k] = JSON.parse(trimmed); continue; } catch {}
      }
    }
    out[k] = v;
  }
  return out;
}

function parseTranscriptLines(text, { maxSteps = 400, mtimeMs = 0 } = {}) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  const totalLines = lines.length;
  const sliced = totalLines > maxSteps ? lines.slice(totalLines - maxSteps) : lines;
  const entries = [];
  const pendingTools = [];
  let model = '';
  let lastStepType = '';
  let lastStepStatus = '';
  let lastHasToolCalls = false;
  let turnStartedAt = 0;

  for (const rawLine of sliced) {
    let step;
    try { step = JSON.parse(rawLine); }
    catch { continue; }
    if (step.model) model = String(step.model);
    const stepIndex = Number.isFinite(step.step_index) ? step.step_index : entries.length;
    const createdAt = parseTimeMs(step.created_at);
    const type = String(step.type || '');
    const source = String(step.source || '');

    if (source === 'SYSTEM' || type === 'SYSTEM_MESSAGE') continue;

    lastStepType = type;
    lastStepStatus = String(step.status || '');
    lastHasToolCalls = Array.isArray(step.tool_calls) && step.tool_calls.length > 0;

    if (type === 'USER_INPUT' || source === 'USER_EXPLICIT') {
      pendingTools.length = 0;
      if (createdAt) turnStartedAt = createdAt;
      const content = stripUserPromptWrappers(typeof step.content === 'string' ? step.content : '');
      if (content) {
        entries.push({ kind: 'message', role: 'user', stepIndex, createdAt, text: clipText(content, 16000) });
      }
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      pendingTools.length = 0;
      const assistantText = typeof step.content === 'string' ? step.content.trim()
        : typeof step.response === 'string' ? step.response.trim()
          : typeof step.text === 'string' ? step.text.trim() : '';
      if (assistantText) {
        entries.push({
          kind: 'message',
          role: 'assistant',
          stepIndex,
          createdAt,
          model: step.model || model || '',
          text: clipText(assistantText, 24000),
        });
      }
      if (Array.isArray(step.tool_calls) && step.tool_calls.length) {
        for (const tc of step.tool_calls) {
          const cleaned = tc?.args ? cleanToolArgs(tc.args) : undefined;
          const toolEntry = {
            kind: 'tool',
            stepIndex,
            createdAt,
            name: String(tc?.name || 'tool'),
            status: String(step.status || ''),
            args: cleaned ? clipText(typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned), 1200) : '',
            output: '',
          };
          entries.push(toolEntry);
          pendingTools.push(toolEntry);
        }
      }
      continue;
    }

    // Antigravity writes tool execution results as type: "GENERIC" (with source: "MODEL")
    // immediately following the PLANNER_RESPONSE that emitted tool_calls.
    // Attach them inside the corresponding collapsed tool card instead of rendering as assistant text.
    if (type === 'GENERIC' || /TOOL|COMMAND|FILE|SEARCH|BROWSER/i.test(type)) {
      const output = typeof step.output === 'string' ? step.output
        : typeof step.content === 'string' ? step.content
          : typeof step.result === 'string' ? step.result : '';
      const target = pendingTools.shift();
      if (target) {
        if (output) target.output = clipText(output, 2000);
        if (step.status) target.status = String(step.status);
        if (/Encountered error|Command exited with code [1-9]/i.test(output)) target.status = 'ERROR';
      } else if (type !== 'GENERIC') {
        entries.push({
          kind: 'tool',
          stepIndex,
          createdAt,
          name: String(step.tool_name || type),
          status: String(step.status || ''),
          output: output ? clipText(output, 2000) : '',
        });
      }
    }
  }

  const inProgress = pendingTools.length > 0
    || lastStepType === 'USER_INPUT'
    || lastStepType === 'GENERIC'
    || (lastStepType === 'PLANNER_RESPONSE' && lastHasToolCalls)
    || /RUNNING|PENDING|IN_PROGRESS/i.test(lastStepStatus);
  const recent = !mtimeMs || Date.now() - mtimeMs < ACTIVE_RECENCY_MS;
  const running = Boolean(inProgress && recent);

  if (running && pendingTools.length) {
    for (const pending of pendingTools) pending.status = 'RUNNING';
  }

  const activityLabel = !running ? ''
    : pendingTools.length ? '桌面端正在执行 ' + pendingTools.at(-1).name
      : lastStepType === 'GENERIC' ? '桌面端正在分析工具结果'
        : '桌面端正在思考';

  return {
    entries,
    model,
    totalSteps: totalLines,
    truncated: totalLines > maxSteps,
    running,
    activityLabel,
    turnStartedAt,
  };
}

async function listArtifacts(brainConvDir) {
  let dirEntries = [];
  try { dirEntries = await fsp.readdir(brainConvDir, { withFileTypes: true }); }
  catch { return []; }
  const artifacts = [];
  for (const entry of dirEntries) {
    if (!entry.isFile() || !safeArtifactName(entry.name)) continue;
    try {
      const stat = await fsp.stat(path.join(brainConvDir, entry.name));
      artifacts.push({ name: entry.name, size: stat.size, updatedAt: stat.mtimeMs });
    } catch {}
  }
  artifacts.sort((a, b) => b.updatedAt - a.updatedAt);
  return artifacts;
}

async function readConversation({ geminiDir = defaultGeminiDir(), conversationId, maxSteps = 400 } = {}) {
  const id = safeConversationId(conversationId);
  if (!id) return { ok: false, errorCode: 'INVALID_CONVERSATION_ID', error: '桌面会话标识无效' };

  const appDataDir = path.join(geminiDir, 'antigravity');
  const cliDataDir = path.join(geminiDir, 'antigravity-cli');
  let brainConvDir = path.join(appDataDir, 'brain', id);
  let transcriptPath = path.join(brainConvDir, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) {
    const cliCandidate = path.join(cliDataDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(cliCandidate)) {
      brainConvDir = path.join(cliDataDir, 'brain', id);
      transcriptPath = cliCandidate;
    }
  }

  let ann = {};
  try {
    ann = parseAnnotationPbtxt(await fsp.readFile(path.join(appDataDir, 'annotations', id + '.pbtxt'), 'utf8'));
  } catch {}

  let stat = null;
  let content = '';
  try {
    stat = await fsp.stat(transcriptPath);
    if (stat.size > 12 * 1024 * 1024) {
      const fh = await fsp.open(transcriptPath, 'r');
      try {
        const tailSize = 4 * 1024 * 1024;
        const buf = Buffer.alloc(tailSize);
        await fh.read(buf, 0, tailSize, stat.size - tailSize);
        const raw = buf.toString('utf8');
        const firstNl = raw.indexOf('\n');
        content = firstNl >= 0 ? raw.slice(firstNl + 1) : raw;
      } finally {
        await fh.close();
      }
    } else {
      content = await fsp.readFile(transcriptPath, 'utf8');
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      const ftsEntries = await readFtsFallbackEntries(path.join(appDataDir, 'conversation_summaries.db'), id);
      return {
        ok: true,
        conversationId: id,
        title: ann.title || id.slice(0, 8),
        hasTranscript: ftsEntries.length > 0,
        entries: ftsEntries,
        artifacts: await listArtifacts(brainConvDir),
        updatedAt: ann.lastViewMs || 0,
        readOnly: true,
      };
    }
    return { ok: false, errorCode: 'READ_TRANSCRIPT_FAILED', error: '无法读取桌面会话记录' };
  }

  const parsed = parseTranscriptLines(content, { maxSteps, mtimeMs: stat ? stat.mtimeMs : 0 });
  const artifacts = await listArtifacts(brainConvDir);
  const firstUser = parsed.entries.find(e => e.kind === 'message' && e.role === 'user')?.text || '';

  return {
    ok: true,
    conversationId: id,
    title: ann.title || clipText(firstUser.split(/\r?\n/)[0] || '', 120) || id.slice(0, 8),
    hasTranscript: true,
    readOnly: true,
    model: parsed.model,
    running: parsed.running,
    activityLabel: parsed.activityLabel,
    turnStartedAt: parsed.turnStartedAt,
    totalSteps: parsed.totalSteps,
    truncated: parsed.truncated,
    updatedAt: stat ? stat.mtimeMs : 0,
    size: stat ? stat.size : 0,
    entries: parsed.entries,
    artifacts,
  };
}

async function readArtifact({ geminiDir = defaultGeminiDir(), conversationId, filename } = {}) {
  const id = safeConversationId(conversationId);
  const name = safeArtifactName(filename);
  if (!id || !name) return { ok: false, errorCode: 'INVALID_ARTIFACT', error: '产物文件名无效' };
  const target = path.join(geminiDir, 'antigravity', 'brain', id, name);
  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return { ok: false, errorCode: 'ARTIFACT_NOT_FOUND', error: '产物不存在' };
    const text = await fsp.readFile(target, 'utf8');
    return { ok: true, conversationId: id, filename: name, content: clipText(text, 128000), updatedAt: stat.mtimeMs };
  } catch {
    return { ok: false, errorCode: 'ARTIFACT_NOT_FOUND', error: '无法读取产物文件' };
  }
}

function createWatcher({ geminiDir = defaultGeminiDir(), onUpdate, pollMs = 700 } = {}) {
  let activeId = '';
  let watcher = null;
  let timer = null;
  let debounce = null;
  let lastSig = '';

  function stop() {
    activeId = '';
    lastSig = '';
    if (debounce) { clearTimeout(debounce); debounce = null; }
    if (timer) { clearInterval(timer); timer = null; }
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  }

  async function check(id) {
    if (!id || id !== activeId) return;
    const tPath = path.join(geminiDir, 'antigravity', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    let sig = '';
    try {
      const st = await fsp.stat(tPath);
      sig = st.size + ':' + st.mtimeMs;
    } catch {
      sig = 'missing';
    }
    if (sig === lastSig) return;
    lastSig = sig;
    const data = await readConversation({ geminiDir, conversationId: id });
    if (id === activeId && data?.ok) {
      try { onUpdate?.({ type: 'transcript', conversationId: id, data }); } catch {}
    }
  }

  function watch(conversationId) {
    const id = safeConversationId(conversationId);
    stop();
    if (!id) return { ok: true, watching: '' };
    activeId = id;
    const logsDir = path.join(geminiDir, 'antigravity', 'brain', id, '.system_generated', 'logs');
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; void check(id); }, 250);
      debounce.unref?.();
    };
    try {
      if (fs.existsSync(logsDir)) {
        watcher = fs.watch(logsDir, { persistent: false }, () => schedule());
        watcher.on('error', () => {});
      }
    } catch {}
    timer = setInterval(() => { void check(id); }, Math.max(500, pollMs));
    timer.unref?.();
    void check(id);
    return { ok: true, watching: id };
  }

  return { watch, stop, current: () => activeId };
}

module.exports = {
  defaultGeminiDir,
  normalizeLocalPath,
  displayLocalPath,
  safeConversationId,
  safeArtifactName,
  stripUserPromptWrappers,
  parseAnnotationPbtxt,
  parseTranscriptLines,
  listProjects,
  listConversations,
  readConversation,
  readArtifact,
  createWatcher,
};

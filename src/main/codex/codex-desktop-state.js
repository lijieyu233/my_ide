const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);

const stateLimit = 8 * 1024 * 1024;
const scanLimit = 16 * 1024 * 1024;
const scanChunk = 256 * 1024;
const activeWindowMs = 5 * 60 * 1000;
const ownerWindowMs = 24 * 60 * 60 * 1000;
const nativeId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const lifecycle = [
  { code: Buffer.from('"type":"event_msg","payload":{"type":"task_started"'), running: true },
  { code: Buffer.from('"type":"event_msg","payload":{"type":"task_complete"'), running: false },
  { code: Buffer.from('"type":"event_msg","payload":{"type":"turn_aborted"'), running: false },
];
const overlapSize = Math.max(...lifecycle.map(({ code }) => code.length)) - 1;

const pendingDeletionsKey = 'app-server-pending-project-deletions-by-host';
const projectAliasesKey = 'app-server-project-id-by-legacy-project-id-by-host';
const sidebarOrderKey = 'unified-sidebar-project-order-v1';
const sidebarPreferencesKey = 'flat-project-sidebar-preferences-v1';
const projectThreadOrderKey = 'sidebar-project-thread-orders';
const expandedProjectPrefix = 'sidebar-project-expanded-v1-codex:';
const sidebarProjectPrefix = 'codex:project:';
const desktopKeys = ['local-projects', projectAliasesKey, pendingDeletionsKey,
  'thread-project-assignments', 'thread-project-membership-host-ids', 'projectless-thread-ids', 'project-order', projectThreadOrderKey];
const ownerScope = "'electron-owner-atoms:' || coalesce((SELECT CASE WHEN json_valid(value) THEN json_extract(value, '$') END " +
  "FROM settings WHERE scope = 'global' AND key = 'electron-renderer-content-owner'), 'signed-out')";
const stateQuery = "SELECT key, value FROM settings WHERE (scope = 'global' AND key IN (" +
  desktopKeys.map(key => "'" + key + "'").join(', ') + ")) OR (scope = (" + ownerScope +
  ") AND (key IN ('" + sidebarOrderKey + "', '" + sidebarPreferencesKey + "') OR key LIKE '" + expandedProjectPrefix + "%'))";
let sqlite;
const desktopSnapshots = new Map();

async function sqliteRevision(file) {
  const stats = await Promise.all(['', '-wal', '-journal'].map(suffix =>
    fs.stat(file + suffix).catch(error => {
      if (error.code !== 'ENOENT' || !suffix) throw error;
      return null;
    })));
  return {
    stamp: stats.map(stat => stat && [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')).join('/'),
    size: stats[0].size,
    journal: stats.slice(1).some(stat => stat?.size > 0),
  };
}

async function readSqliteState(file) {
  const { stamp, size, journal } = await sqliteRevision(file);
  const previous = desktopSnapshots.get(file);
  if (previous?.stamp === stamp) return previous.state;

  let entries;
  if (journal) {
    // A live journal must be read by SQLite itself so the result includes only committed changes.
    const { stdout } = await runFile('sqlite3', ['-readonly', '-batch', '-json', file, stateQuery],
      { encoding: 'utf8', timeout: 1500, windowsHide: true, maxBuffer: stateLimit });
    entries = JSON.parse(stdout.trim() || '[]').map(row => [row.key, row.value]);
  } else {
    if (size > stateLimit) return previous?.state || null;
    const SQL = await (sqlite ||= require('sql.js')());
    const bytes = await fs.readFile(file);
    if (stamp !== (await sqliteRevision(file)).stamp) {
      return previous?.state || null;
    }
    const db = new SQL.Database(bytes);
    try { entries = db.exec(stateQuery)[0]?.values || []; }
    finally { db.close(); }
  }
  const state = Object.fromEntries(entries.map(([key, value]) => [key, JSON.parse(value)]));
  desktopSnapshots.set(file, { stamp, state });
  return state;
}

async function readDesktopState(home) {
  const database = path.join(home, '.codex-global-state.sqlite');
  const current = await readSqliteState(database).catch(error =>
    error.code === 'ENOENT' ? null : desktopSnapshots.get(database)?.state);
  if (current) return current;
  const file = path.join(home, '.codex-global-state.json');
  try {
    if ((await fs.stat(file)).size > stateLimit) return {};
    return JSON.parse(await fs.readFile(file, 'utf8')) || {};
  } catch { return {}; }
}

function pendingProjectIds(state) {
  const ids = new Set();
  for (const [host, pending] of Object.entries(state[pendingDeletionsKey] || {})) {
    if (!host.startsWith('local:')) continue;
    for (const record of Object.values(pending || {})) {
      if (typeof record?.projectId === 'string') ids.add(record.projectId);
    }
  }
  return ids;
}

function registeredProjectIds(state) {
  const { ['local-projects']: projects = {}, ['app-server-project-id-by-legacy-project-id-by-host']: hosts = {} } = state;
  const ids = new Set(Object.keys(projects || {}));
  for (const [host, aliases] of Object.entries(hosts || {})) {
    if (!host.startsWith('local:')) continue;
    for (const [id, nativeId] of Object.entries(aliases || {})) {
      if (Object.hasOwn(projects || {}, id) && typeof nativeId === 'string') ids.add(nativeId);
    }
  }
  return ids;
}

function projectAliases(projects, state) {
  const projectIds = new Set(projects.map(project => project.id));
  const aliases = new Map();
  for (const map of Object.values(state['app-server-project-id-by-legacy-project-id-by-host'] || {})) {
    for (const [desktopId, nativeId] of Object.entries(map || {})) {
      if (projectIds.has(nativeId)) aliases.set(desktopId, nativeId);
    }
  }
  return aliases;
}

function sidebarProjects(projects, state) {
  const aliases = projectAliases(projects, state);
  const order = Array.isArray(state[sidebarOrderKey])
    ? state[sidebarOrderKey].filter(key => typeof key === 'string' && key.startsWith(sidebarProjectPrefix)).map(key => key.slice(sidebarProjectPrefix.length)) : [];
  const fallback = Array.isArray(state['project-order']) ? state['project-order'] : [];
  const byId = new Map(projects.map(project => [project.id, project]));
  const positions = new Set([...order, ...fallback, ...byId.keys()].map(id => aliases.get(id) || id));
  const manual = state[sidebarPreferencesKey]?.projectSortMode === 'manual';
  const sorted = [...positions].map(id => byId.get(id)).filter(Boolean);
  const threadOrders = manual ? state[projectThreadOrderKey] || {} : {};
  const byProject = new Map(Object.entries(threadOrders).map(([key, order]) => {
    const id = key.startsWith(sidebarProjectPrefix) ? key.slice(sidebarProjectPrefix.length) : key;
    return [aliases.get(id) || id, order?.threadIds];
  }));
  const expanded = new Map();
  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith(expandedProjectPrefix) || typeof value !== 'boolean') continue;
    const id = key.slice(expandedProjectPrefix.length);
    expanded.set(aliases.get(id) || id, value);
  }
  return sorted.map(project => {
    const order = byProject.get(project.id);
    const open = expanded.get(project.id);
    return { ...project, ...(typeof open === 'boolean' ? { expanded: open } : {}),
      ...(Array.isArray(order) ? { sessionIds: order.filter(id => typeof id === 'string') } : {}) };
  });
}

function projectAssignments(projects, state) {
  const projectIds = new Set(projects.map(project => project.id));
  const aliases = projectAliases(projects, state);
  const projectsByThread = new Map();
  for (const [id, assignment] of Object.entries(state['thread-project-assignments'] || {})) {
    if (assignment?.projectKind !== 'local' || state['thread-project-membership-host-ids']?.[id] !== 'local') continue;
    const projectId = aliases.get(assignment.projectId) || assignment.projectId;
    if (projectIds.has(projectId)) projectsByThread.set(id, projectId);
  }
  return projectsByThread;
}

function isSessionLog(home, file, id) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !path.basename(file).endsWith('-' + id + '.jsonl')) return false;
  return path.relative(home, file).split(path.sep)[0] === 'sessions';
}

async function scanLifecycle(file, size, floor) {
  let suffix = Buffer.alloc(0);
  for (let end = size; end > floor;) {
    const start = Math.max(floor, end - scanChunk);
    const buffer = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const bytes = Buffer.concat([buffer.subarray(0, bytesRead), suffix]);
    let latest = -1, running;
    for (const marker of lifecycle) {
      const at = bytes.lastIndexOf(marker.code);
      if (at > latest) { latest = at; running = marker.running; }
    }
    if (latest >= 0) return running;
    suffix = bytes.subarray(0, overlapSize);
    end = start;
  }
  return undefined;
}

// Desktop can buffer an active turn's rollout while it continues writing engine diagnostics.
async function hasLiveOwner(home, threadId, modifiedAt) {
  if (!nativeId.test(threadId)) return false;
  try {
    const file = path.join(home, 'logs_2.sqlite');
    await fs.access(file);
    const since = Math.floor((modifiedAt - 120000) / 1000);
    // Read only the process identity from the latest engine activity. The log body is never queried.
    const query = "SELECT process_uuid FROM logs WHERE thread_id='" + threadId + "' AND ts >= " + since +
      " AND target IN ('codex_core::stream_events_utils','codex_core::session::turn')" +
      ' ORDER BY ts DESC, ts_nanos DESC, id DESC LIMIT 1';
    const { stdout } = await runFile('sqlite3', ['-readonly', '-batch', '-noheader', file, query], {
      encoding: 'utf8', timeout: 1500, windowsHide: true, maxBuffer: 4096,
    });
    const owner = /^pid:([1-9]\d*):/.exec(stdout.trim());
    if (!owner) return false;
    process.kill(Number(owner[1]), 0);
    return true;
  } catch { return false; }
}

function createDesktopStatusReader({ liveOwner = hasLiveOwner } = {}) {
  const cache = new Map();

  async function observe(home, { threadId, rolloutPath, running: hostRunning }) {
    const unavailable = { running: hostRunning === true };
    if (typeof rolloutPath !== 'string' || !path.isAbsolute(rolloutPath)) return unavailable;
    try {
      // Windows may report a volume-qualified path for the same indexed rollout.
      const [actualRoot, actualFile] = await Promise.all([fs.realpath(home), fs.realpath(rolloutPath)]);
      if (!isSessionLog(actualRoot, actualFile, threadId)) return unavailable;
      const stat = await fs.stat(actualFile);
      if (!stat.isFile()) return unavailable;
      const revision = stat.mtimeMs + ':' + stat.size;
      const age = Date.now() - stat.mtimeMs;
      if (hostRunning || age > ownerWindowMs) return { ...unavailable, revision };
      const previous = cache.get(actualFile);
      let marker = previous?.running;
      if (previous?.revision !== revision) {
        const oldest = Math.max(0, stat.size - scanLimit);
        const incremental = previous && previous.size > oldest && previous.size < stat.size;
        // Recheck the boundary so a marker split across two writes is still detected.
        const floor = incremental ? Math.max(0, previous.size - overlapSize) : oldest;
        const file = await fs.open(actualFile, 'r');
        try { marker = (await scanLifecycle(file, stat.size, floor)) ?? (incremental ? marker : undefined); }
        finally { await file.close(); }
        if (cache.size >= 1000 && !cache.has(actualFile)) cache.delete(cache.keys().next().value);
        cache.set(actualFile, { size: stat.size, revision, running: marker });
      }
      const running = marker === true && (age <= activeWindowMs || await liveOwner(actualRoot, threadId, stat.mtimeMs));
      return { running, revision };
    } catch { return unavailable; }
  }

  return observe;
}

module.exports = { readDesktopState, pendingProjectIds, registeredProjectIds, projectAliases, projectAssignments, sidebarProjects, createDesktopStatusReader };

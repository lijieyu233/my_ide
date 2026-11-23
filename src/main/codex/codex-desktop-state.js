const fs = require('node:fs/promises');
const path = require('node:path');

const stateLimit = 8 * 1024 * 1024;
const scanLimit = 16 * 1024 * 1024;
const scanChunk = 256 * 1024;
const activeWindowMs = 5 * 60 * 1000;
const lifecycle = [
  { code: Buffer.from('"type":"event_msg","payload":{"type":"task_started"'), running: true },
  { code: Buffer.from('"type":"event_msg","payload":{"type":"task_complete"'), running: false },
  { code: Buffer.from('"type":"event_msg","payload":{"type":"turn_aborted"'), running: false },
];
const overlapSize = Math.max(...lifecycle.map(({ code }) => code.length)) - 1;

async function readDesktopState(home) {
  const file = path.join(home, '.codex-global-state.json');
  try {
    if ((await fs.stat(file)).size > stateLimit) return {};
    return JSON.parse(await fs.readFile(file, 'utf8')) || {};
  } catch { return {}; }
}

function projectAssignments(projects, state) {
  const projectIds = new Set(projects.map(project => project.id));
  const aliases = new Map();
  for (const map of Object.values(state['app-server-project-id-by-legacy-project-id-by-host'] || {})) {
    for (const [desktopId, nativeId] of Object.entries(map || {})) {
      if (projectIds.has(nativeId)) aliases.set(desktopId, nativeId);
    }
  }
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

function createDesktopStatusReader() {
  const cache = new Map();

  async function running(home, { threadId, rolloutPath, running: hostRunning }) {
    if (hostRunning) return true;
    if (typeof rolloutPath !== 'string' || !path.isAbsolute(rolloutPath)) return false;
    try {
      // Windows may report a volume-qualified path for the same indexed rollout.
      const [actualRoot, actualFile] = await Promise.all([fs.realpath(home), fs.realpath(rolloutPath)]);
      if (!isSessionLog(actualRoot, actualFile, threadId)) return false;
      const stat = await fs.stat(actualFile);
      if (!stat.isFile() || Date.now() - stat.mtimeMs > activeWindowMs) {
        cache.delete(rolloutPath);
        return false;
      }
      const previous = cache.get(rolloutPath);
      if (previous?.size === stat.size && previous.mtimeMs === stat.mtimeMs) return previous.running === true;
      const oldest = Math.max(0, stat.size - scanLimit);
      const incremental = previous && previous.size > oldest && previous.size < stat.size;
      // Recheck the boundary so a marker split across two writes is still detected.
      const floor = incremental ? Math.max(0, previous.size - overlapSize) : oldest;
      const file = await fs.open(actualFile, 'r');
      try {
        const running = (await scanLifecycle(file, stat.size, floor)) ?? (incremental ? previous.running : undefined);
        if (cache.size >= 1000 && !cache.has(rolloutPath)) cache.delete(cache.keys().next().value);
        cache.set(rolloutPath, { size: stat.size, mtimeMs: stat.mtimeMs, running });
        return running === true;
      } finally { await file.close(); }
    } catch { return false; }
  }

  return running;
}

module.exports = { readDesktopState, projectAssignments, createDesktopStatusReader };

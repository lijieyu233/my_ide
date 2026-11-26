const path = require('node:path');
const { lstat, mkdir, realpath, stat } = require('node:fs/promises');
const { sandboxStatus } = require('./agy-runtime');

const ENGINE = 'antigravity';
const MAX_PATH = 4096;

function reject(code, message) {
  return Object.assign(new Error(message), { code });
}

function identifier(value, message) {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
    throw reject('INVALID_ANTIGRAVITY_TARGET', message);
  }
  return value;
}

async function workspaceDirectory(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_PATH || !path.isAbsolute(value)
      || value.startsWith('\\\\') || value.startsWith('//')) {
    throw reject('INVALID_ANTIGRAVITY_WORKSPACE', '请选择本地项目目录');
  }
  try {
    const root = await realpath(value);
    if (!(await stat(root)).isDirectory()) throw new Error();
    return root;
  } catch {
    throw reject('INVALID_ANTIGRAVITY_WORKSPACE', '项目目录不存在或无法访问');
  }
}

function sameDirectory(left, right) {
  return path.relative(left, right) === '';
}

async function pilotDirectory(requested, create = false) {
  const parent = path.dirname(requested);
  if (create) await mkdir(parent, { recursive: true });
  const expected = path.join(await workspaceDirectory(parent), path.basename(requested));
  if (create) await mkdir(expected, { recursive: true });
  const info = await lstat(expected);
  const actual = await workspaceDirectory(expected);
  if (info.isSymbolicLink() || !sameDirectory(expected, actual)) {
    throw reject('INVALID_ANTIGRAVITY_WORKSPACE', '试用目录不能重定向到其他路径');
  }
  return actual;
}

function failure(error) {
  // Unrecognized errors may originate in the CLI, filesystem, or transport.
  if (typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
      && (error.code.includes('ANTIGRAVITY') || error.code.startsWith('ACP_') || error.code.startsWith('AGY_') || error.code.startsWith('INVALID_AI_'))) {
    return { ok: false, errorCode: error.code, error: String(error.message).slice(0, 500) };
  }
  return { ok: false, errorCode: 'ANTIGRAVITY_FAILED', error: 'Antigravity 操作未完成，请检查连接与会话状态' };
}

function runtimeState(result) {
  const sandbox = result.sandbox || sandboxStatus();
  return {
    ...result,
    sandbox: {
      ...sandbox,
      state: sandbox.status,
      label: sandbox.available === false ? '终端沙箱不可用' : '终端沙箱待验证',
    },
    permission: { label: 'Antigravity 原生权限由 CLI 管理' },
  };
}

function createIpc({ ipcMain, service, sender, readView, assertRun, openApproval, pilotRoot }) {
  const activeReviews = new Set();

  async function currentTarget(event, cfg, requested = {}, requireSession = true, allowOtherMode = false) {
    sender(event);
    if (cfg?.engine !== ENGINE || cfg.antigravityEnabled !== true) {
      throw reject('ANTIGRAVITY_DISABLED', '请先在 AI 助手设置中启用 Antigravity');
    }
    const view = await readView(event);
    if (!view?.page || !allowOtherMode && view.engine !== ENGINE) {
      throw reject('INVALID_ANTIGRAVITY_TARGET', 'Antigravity 会话视图已变化');
    }
    if (!view.page.projectContext || view.page.id !== 'project') {
      throw reject('INVALID_ANTIGRAVITY_WORKSPACE', 'Antigravity 需要在本地项目中使用');
    }
    if (requested.sessionId !== undefined && requested.sessionId !== view.sessionId
        || requested.rootId !== undefined && requested.rootId !== view.rootId
        || requested.projectId !== undefined && requested.projectId !== view.projectId
        || requested.page && requested.page.id !== view.page.id) {
      throw reject('INVALID_ANTIGRAVITY_TARGET', 'Antigravity 会话视图已变化');
    }
    const root = await workspaceDirectory(view.rootId);
    const projectId = identifier(view.projectId || root, '项目标识无效');
    return {
      engine: ENGINE,
      rootId: view.rootId,
      workspaceRoot: root,
      projectId,
      page: { id: view.page.id, projectContext: true, projectId },
      sessionId: identifier(view.sessionId || (!requireSession ? 'antigravity-catalog' : ''), '会话标识无效'),
    };
  }

  function register(name, fn) {
    ipcMain.handle('ai:antigravity-' + name, async (event, ...args) => {
      try {
        sender(event);
        return await fn(event, ...args);
      } catch (error) {
        return failure(error);
      }
    });
  }

  register('status', async (_event, cfg) => ({
    ...runtimeState(await service.status(cfg?.antigravityPath)),
    enabled: cfg?.antigravityEnabled === true,
  }));
  register('pilot', async (_event, cfg) => {
    if (cfg?.antigravityEnabled !== true) throw reject('ANTIGRAVITY_DISABLED', '请先启用 Antigravity 试用');
    return { ok: true, rootDir: await pilotDirectory(pilotRoot(), true) };
  });
  register('connect', async (event, cfg, target) => {
    const context = await currentTarget(event, cfg, target, false, true);
    if (target?.reconnect === true) await service.disconnect(cfg, context);
    return runtimeState(await service.connect(cfg, context));
  });
  register('options', async (event, cfg, sessionId, apply) => {
    const context = await currentTarget(event, cfg, { sessionId }, false);
    if (apply && typeof apply === 'object') return runtimeState(await service.setConfig(cfg, context, apply));
    return runtimeState(await service.inspect(cfg, context));
  });
  register('sessions', async (event, cfg, target, cursor) => service.listHistory(
    cfg, await currentTarget(event, cfg, target, false), { cursor }
  ));
  register('history', async (event, cfg, target) => {
    const context = await currentTarget(event, cfg, target);
    const nativeSessionId = target?.nativeSessionId;
    return service.openHistory(cfg, {
      ...context,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId: identifier(nativeSessionId, '原生会话标识无效') }),
    });
  });
  register('queue', async (event, cfg, target) => service.changeInput(
    cfg, await currentTarget(event, cfg, target), { kind: 'list' }
  ));
  register('input', async (event, cfg, target, action) => {
    const context = await currentTarget(event, cfg, target);
    if (!action || !['queue', 'enqueue', 'edit', 'remove', 'pause', 'resume', 'steer', 'reconcile'].includes(action.kind)) {
      throw reject('INVALID_ANTIGRAVITY_INPUT', '待发操作无效');
    }
    return service.changeInput(cfg, context, action.kind === 'queue' ? { ...action, kind: 'enqueue' } : action);
  });
  register('review', async (event, context, id) => {
    const { owner, scope } = assertRun(event, context);
    // The renderer may show a request and call this endpoint, but can never choose an ACP option.
    const view = await readView(event);
    if (view?.engine !== ENGINE || view.sessionId !== scope.sessionId || view.rootId !== scope.rootId
        || (view.projectId || scope.workspaceRoot) !== scope.projectId) {
      throw reject('INVALID_ANTIGRAVITY_TARGET', '请回到请求所属的 Antigravity 会话');
    }
    const request = service.permissionRequest(scope, id);
    if (request?.ok !== true) throw reject('ANTIGRAVITY_REVIEW_EXPIRED', '此 Antigravity 请求已失效');
    const key = JSON.stringify([owner, scope.requestId, id]);
    if (activeReviews.has(key)) throw reject('ANTIGRAVITY_REVIEW_BUSY', '此请求正在确认');
    activeReviews.add(key);
    try {
      const accept = request.choices.find(choice => choice.kind === 'allow_once');
      const decline = request.choices.find(choice => choice.kind === 'reject_once');
      const title = request.toolCall?.title || '工具操作';
      const details = [];
      const raw = request.toolCall?.rawInput;
      for (const field of ['command', 'cmd', 'script', 'patch', 'diff', 'content', 'path', 'file_path', 'filePath', 'url']) {
        if (typeof raw?.[field] === 'string') details.push(field + '\n' + raw[field]);
      }
      for (const part of request.toolCall?.content || []) {
        if (part.type === 'diff' && typeof part.path === 'string') {
          details.push(part.path + '\n− ' + (part.oldText || '') + '\n+ ' + (part.newText || ''));
        }
      }
      const canAllow = Boolean(accept && request.canAllow && details.length && details.join('').length <= 128000);
      const answer = await openApproval(owner, scope, { title, details: canAllow ? details : [], canAllow, signal: request.signal });
      assertRun(event, context);
      const latest = await readView(event);
      if (latest?.engine !== ENGINE || latest.sessionId !== scope.sessionId || latest.rootId !== scope.rootId
          || (latest.projectId || scope.workspaceRoot) !== scope.projectId) {
        throw reject('INVALID_ANTIGRAVITY_TARGET', '会话已变化，请回到请求所属的 Antigravity 会话');
      }
      if (service.permissionRequest(scope, id)?.ok !== true) throw reject('ANTIGRAVITY_REVIEW_EXPIRED', '此 Antigravity 请求已失效');
      return service.permissionResult(scope, id, answer.approved && canAllow ? accept.optionId : decline?.optionId ?? null);
    } finally {
      activeReviews.delete(key);
    }
  });
  register('question-result', async (event, context, id, answers) => {
    const { scope } = assertRun(event, context);
    const view = await readView(event);
    if (view?.engine !== ENGINE || view.sessionId !== scope.sessionId || view.rootId !== scope.rootId
        || (view.projectId || scope.workspaceRoot) !== scope.projectId) {
      throw reject('INVALID_ANTIGRAVITY_TARGET', '请回到提问所属的 Antigravity 会话');
    }
    return service.questionResult(scope, id, answers);
  });

  return { currentTarget };
}

module.exports = { ENGINE, createIpc, failure, pilotDirectory, sameDirectory, workspaceDirectory };

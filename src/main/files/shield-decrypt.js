const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 只继承旧脚本的固定位置；发现可执行文件不代表其签名或来源已经验证。
const CANDIDATES = Object.freeze([
  'D:/programfile/Code工作流-完整版/_internal/tools/OcularDecrypt.exe',
  'C:/Users/Administrator/Desktop/Code-工作流(分发版)/_internal/tools/OcularDecrypt.exe',
]);
const failure = (code, message, effectUnknown = false, changedPaths = []) =>
  ({ ok: false, code, message, effectUnknown, changedPaths });
const invalid = (code, message) => Object.assign(new Error(message), { code });
const stamp = s => [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs, s.birthtimeMs].join(':');
const identity = s => [s.dev, s.ino, s.mode, s.birthtimeMs].join(':');

function createService(options = {}) {
  const io = options.fs ? (options.fs.promises || options.fs) : fs.promises;
  const launch = options.spawn || spawn;
  const platform = options.platform || process.platform;
  const candidates = options.candidates || CANDIDATES;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120000;
  const active = new Set(), children = new Set();
  const graceMs = Number.isFinite(options.timeoutGraceMs) && options.timeoutGraceMs > 0 ? options.timeoutGraceMs : 5000;
  let disposed = false;
  const status = target => {
    try {
      if (typeof options.onStatus === 'function') options.onStatus({ path: target, phase: 'timeout-unconfirmed', message: '绿盾处理超时，已请求停止；结果尚未确认，当前文件保持锁定' });
    } catch (_) { /* UI 监听异常不能释放还在执行的文件锁。 */ }
  };
  const key = p => platform === 'win32' ? p.toLowerCase() : p;
  const inside = (root, target) => key(target).startsWith(key(root + path.sep));

  function absolute(input) {
    if (typeof input !== 'string' || !input.trim() || !path.isAbsolute(input) ||
        /^[\\/]{2}/.test(input) || /[\x00-\x1f<>"|?*]/.test(input)) {
      throw invalid('INVALID_PATH', '仅支持本机绝对路径');
    }
    // Win32 设备、ADS、末尾点/空格存在别名语义，不能把它们交给外部工具解释。
    const tail = input.replace(/^[a-z]:/i, '');
    if (tail.includes(':') || tail.split(/[\\/]/).some(part =>
      /[. ]$/.test(part) && part !== '.' && part !== '..' ||
      /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
      throw invalid('INVALID_PATH', '不支持设备路径、数据流或路径别名');
    }
    if (tail.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) {
      throw invalid('INVALID_PATH', '不能处理 .git 路径');
    }
    return path.resolve(input);
  }

  async function inspect(input, wantFile) {
    const resolved = absolute(input);
    const ancestors = [];
    let current = path.parse(resolved).root;
    const pieces = resolved.slice(current.length).split(path.sep).filter(Boolean);
    for (const piece of pieces) {
      current = path.join(current, piece);
      const stat = await io.lstat(current);
      if (stat.isSymbolicLink()) throw invalid('LINK_PATH', '不能处理链接或链接祖先');
      if (current !== resolved && !stat.isDirectory()) throw invalid('INVALID_PATH', '路径祖先不是目录');
      ancestors.push([key(current), identity(stat)]);
    }
    const stat = await io.lstat(resolved);
    if (stat.isSymbolicLink() || wantFile && stat.nlink > 1) throw invalid('LINK_PATH', '不能处理链接文件');
    if (wantFile ? !stat.isFile() : !stat.isDirectory()) throw invalid('NOT_FILE', '目标必须是项目内的单个普通文件');
    const real = path.resolve(await io.realpath(resolved));
    if (key(real) !== key(resolved)) throw invalid('LINK_PATH', '请使用真实路径，不支持目录别名');
    return { path: real, stamp: stamp(stat), ancestors: JSON.stringify(ancestors) };
  }

  async function source(project, target) {
    const root = absolute(project), selected = absolute(target);
    if (root === path.parse(root).root || !inside(root, selected)) {
      throw invalid('OUTSIDE_PROJECT', '目标必须是项目内的单个文件，不能处理项目根或外部路径');
    }
    const base = await inspect(root, false), file = await inspect(selected, true);
    if (!inside(base.path, file.path)) throw invalid('OUTSIDE_PROJECT', '目标不在真实项目目录内');
    return { root: base, file };
  }

  async function findTool() {
    for (const candidate of candidates) {
      try { return await inspect(candidate, true); } catch (_) { /* 候选缺席或不安全时不降级到 PATH/shell。 */ }
    }
    return null;
  }

  function run(tool, target) {
    return new Promise(resolve => {
      let child, executed = false, timedOut = false, startError = false, timer, graceTimer;
      const changed = () => executed ? [target] : [];
      try {
        // ignore 直接排空输出，不收集可能包含用户正文的 stdout/stderr。
        child = launch(tool, [target], { shell: false, windowsHide: true, stdio: 'ignore' });
      } catch (_) {
        resolve(failure('SPAWN_FAILED', '绿盾工具启动失败，未执行处理'));
        return;
      }
      children.add(child);
      executed = Boolean(child.pid);
      child.once('spawn', () => { executed = true; });
      child.on('error', () => {
        startError = true;
        // Node 启动失败也会发 close；已启动时 error 可能是 kill 失败，不能据此释放范围锁。
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(graceTimer);
        children.delete(child);
        if (timedOut) resolve(failure('TIMEOUT', '绿盾工具处理超时，结果未确认，请以绿盾客户端状态为准', executed, changed()));
        else if (startError) resolve(failure('SPAWN_FAILED', executed ? '绿盾工具运行异常，文件可能已改变' : '绿盾工具启动失败，未执行处理', executed, changed()));
        else if (code === 0 && !signal && executed) resolve({ ok: true, completed: true, verified: false, changedPaths: [target], message: '绿盾工具已完成，请以绿盾客户端状态为准' });
        else resolve(failure(signal ? 'SIGNAL' : 'EXIT_FAILED', '绿盾工具未正常完成，结果未确认，请以绿盾客户端状态为准', executed, changed()));
      });
      timer = setTimeout(() => {
        timedOut = true;
        status(target);
        graceTimer = setTimeout(() => status(target), graceMs);
        try { child.kill(); } catch (_) { /* kill 不保证停止写盘；必须等 close 才能释放父 PathJobs lease。 */ }
        // 即使 kill 返回 false 也不能提前 resolve。调用方应显示仍在等待，禁止重复操作。
      }, timeoutMs);
    });
  }

  async function decrypt(project, target, confirmCallback) {
    if (disposed) return failure('DISPOSED', '绿盾服务已停止，未执行处理');
    if (platform !== 'win32') return failure('UNSUPPORTED_PLATFORM', '绿盾解密仅支持 Windows 本机文件');
    let lock, ownsLock = false;
    try {
      const before = await source(project, target);
      lock = key(before.file.path);
      if (active.has(lock)) return failure('BUSY', '该文件正在等待确认或处理，请勿重复操作');
      active.add(lock);
      ownsLock = true;
      const tool = await findTool();
      if (!tool) return failure('TOOL_NOT_FOUND', '找不到可用的本机 OcularDecrypt.exe，未执行处理');
      if (typeof confirmCallback !== 'function' || await confirmCallback({ path: before.file.path, tool: tool.path }) !== true) {
        return failure('CANCELLED', '已取消绿盾解密，未执行处理');
      }
      const after = await source(project, target), currentTool = await inspect(tool.path, true);
      if (before.file.path !== after.file.path || before.file.stamp !== after.file.stamp ||
          before.file.ancestors !== after.file.ancestors || before.root.path !== after.root.path ||
          before.root.ancestors !== after.root.ancestors || tool.stamp !== currentTool.stamp ||
          tool.ancestors !== currentTool.ancestors) {
        return failure('STALE_OPERATION', '确认期间文件、路径或工具版本已变化，请重新确认');
      }
      if (disposed) return failure('DISPOSED', '绿盾服务已停止，未执行处理');
      return await run(currentTool.path, after.file.path);
    } catch (error) {
      return failure(error && error.code || 'INVALID_SOURCE', '无法安全处理该文件，未执行解密');
    } finally {
      if (ownsLock) active.delete(lock);
    }
  }
  // beforeQuit 只请求终止本服务创建的直接 child，绝不等待卡住的 close 或查杀桌面进程。
  function dispose() {
    disposed = true;
    for (const child of children) { try { child.kill(); } catch (_) {} }
  }
  return { decrypt, dispose };
}

module.exports = { createService, CANDIDATES };

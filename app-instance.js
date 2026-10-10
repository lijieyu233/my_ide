// Chromium profile不能供两个主进程同时写；重复启动只交给已有窗口处理。
function claim({ app, getWindow, openProject, argv = process.argv }) {
  const index = argv.indexOf('--open');
  const requested = index >= 0 && argv[index + 1] ? argv[index + 1] : null;
  // Windows上的second-instance命令行会重排switch和值，目录必须由additionalData传递。
  if (!app.requestSingleInstanceLock({ openProject: requested })) { app.exit(0); return false; }
  app.on('second-instance', (_event, _args, _cwd, data) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
    }
    if (typeof data?.openProject === 'string' && data.openProject) openProject(data.openProject);
  });
  return true;
}
module.exports = { claim };

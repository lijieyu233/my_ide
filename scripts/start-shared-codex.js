'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['--disable-gpu', '--no-sandbox', root], {
  cwd: root, env, detached: true, stdio: 'ignore', windowsHide: true,
});
child.once('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
child.unref();

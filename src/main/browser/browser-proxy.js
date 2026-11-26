const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../files/file-write');

const PARTITION = 'persist:myide-browser';
const DEFAULT = Object.freeze({ mode: 'system', server: '', bypass: '' });

function normalizeServer(value) {
  const input = String(value ?? '').trim();
  const match = /^(?:(https?|socks[45]):\/\/)?([a-z0-9.-]+|\[[0-9a-f:.]+\]):(\d{1,5})$/i.exec(input);
  const invalid = '请输入代理主机和端口，例如 http://127.0.0.1:10808';
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) throw Error(invalid);
  const host = URL.parse('http://' + match[2])?.hostname;
  if (!host) throw Error(invalid);
  return (match[1] || 'http').toLowerCase() + '://' + host + ':' + Number(match[3]);
}

function normalizeBypass(value) {
  const input = String(value ?? '').trim();
  if (input.length > 4096) throw Error('直连域名列表过长');
  const entries = input ? input.split(/[\s,;，；]+/).filter(Boolean) : [];
  const domains = entries.map(entry => {
    const wildcard = entry.startsWith('*.');
    const host = wildcard ? entry.slice(2) : entry;
    if (!/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i.test(host) || !URL.parse('http://' + host)?.hostname) {
      throw Error('直连域名请填写域名或 IP，例如 mh.slradio.cn 或 *.example.com');
    }
    return entry.toLowerCase();
  });
  return [...new Set(domains)].join('\n');
}

function normalize(input, prior = DEFAULT) {
  if (!['system', 'direct', 'custom'].includes(input?.mode)) throw Error('请选择有效的代理模式');
  if (input.mode !== 'custom') return { ...prior, mode: input.mode };
  return { mode: 'custom', server: normalizeServer(input.server), bypass: normalizeBypass(input.bypass) };
}

function nativeConfig(config) {
  if (config.mode === 'custom') {
    return { mode: 'fixed_servers', proxyRules: config.server, proxyBypassRules: config.bypass.replace(/\n/g, ';') };
  }
  return { mode: config.mode };
}

function createService({ configFile, getSession }) {
  let config = DEFAULT;
  let warning = '';
  let queue = Promise.resolve();

  async function init() {
    const file = configFile();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const prior = saved?.server ? normalize({ ...saved, mode: 'custom' }) : DEFAULT;
      const next = normalize(saved, prior);
      await getSession().setProxy(nativeConfig(next));
      config = next;
    } catch (error) {
      if (error.code !== 'ENOENT') warning = '读取浏览器代理设置失败：' + error.message;
    }
  }

  function read() {
    return { config: { ...config }, warning };
  }

  function save(input) {
    const task = queue.then(async () => {
      const next = normalize(input, config);
      if (!warning && JSON.stringify(next) === JSON.stringify(config)) return read();
      const browserSession = getSession();
      const file = configFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        await browserSession.setProxy(nativeConfig(next));
        // 已经池化的连接可能还在用旧代理，清理后下一次导航才能按新规则连接。
        await browserSession.closeAllConnections();
        atomicWrite(file, Buffer.from(JSON.stringify(next)));
      } catch (error) {
        try {
          await browserSession.setProxy(nativeConfig(config));
          await browserSession.closeAllConnections();
        } catch (restore) {
          throw Error('保存失败，恢复原代理也失败：' + restore.message);
        }
        throw Error('保存浏览器代理失败：' + error.message);
      }
      config = next;
      warning = '';
      return read();
    });
    queue = task.catch(() => {});
    return task;
  }
  return { init, read, save };
}

module.exports = { PARTITION, createService };

// 概览页的「解析 + 渲染」单独测：真实采集要连服务器，但解析规则和卡片骨架
// 可以用固定样本验证。这里不起 Electron，只用 jsdom 加载 remote-panel.js。
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { JSDOM } = require('jsdom');
const rendererDir = path.join(__dirname, '..', 'renderer');
const dom = new JSDOM(`<!doctype html><html><body>
  <div id="panel-remote"></div>
  <div id="remote-main"><div id="remote-overview"></div></div>
  <div id="remote-files" class="hidden"></div>
  <div id="remote-terminal-area" class="hidden"></div>
</body></html>`, { url: 'https://t.test', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
let passed = 0;
const check = (name, ok) => { assert(ok, name); passed++; console.log('ok ' + name); };

// remote-panel.js 依赖一批全局（MI / Modal / esc / window.myIDE …），只测渲染的话给最小桩。
w.eval('var MI={toast(){},log(){},perf:(n,f)=>f()};var Modal={stack:[],prompt:async()=>null,confirm:async()=>false,hide(){},show(){}};'
  + 'function esc(s){return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;"}[c]));}'
  + 'window.myIDE={remote:{snapshot:async()=>({ok:true,data:{sessions:[],jobs:[]}}),load:async()=>({ok:true,data:{profiles:[]}}),onEvent:()=>()=>{}}};'
  + 'window.Viewer={openFile:async()=>{}};');
w.eval(fs.readFileSync(path.join(rendererDir, 'remote-panel.js'), 'utf8'));

const panel = w.RemotePanel;
check('RemotePanel 暴露 renderOverview 供自检调用', typeof panel.renderOverview === 'function');

// ① 空数据：应显示空态，不抛错
panel.renderOverview(null);
const host = w.document.getElementById('remote-overview');
check('空数据渲染成空态提示', /连接服务器后查看概览/.test(host.textContent));

// ② 完整样本：七张卡片、三条进度条、阈值配色
const sample = {
  os: { name: 'Ubuntu 22.04.3 LTS', id: 'ubuntu', version: '22.04' },
  kernel: { release: '6.8.0-45', arch: 'x86_64', hostname: 'prod-01', serverTime: 1700000000 },
  cpu: { cores: 4, load: [0.42, 0.31, 0.22], usage: { idle: 150, total: 300 } },
  memory: { total: 8 * 1024 ** 3, used: 3.2 * 1024 ** 3, available: 4.8 * 1024 ** 3, swapTotal: 2 * 1024 ** 3, swapUsed: 0.1 * 1024 ** 3 },
  uptime: 86400 * 3 + 3600 * 5,
  disks: [{ fs: '/dev/sda1', mount: '/', total: 100 * 1024 ** 3, used: 52 * 1024 ** 3, percent: 52 }],
  listen: [{ proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd' }],
  services: [{ unit: 'ssh.service', active: 'active', sub: 'running', description: 'OpenBSD Secure Shell server' }],
  docker: [{ name: 'web', image: 'nginx:1.25', status: 'Up 3 days' }],
  du: [{ bytes: 1024 ** 3, path: '/home/u/projects' }],
  dockerSupported: true,
};
panel.renderOverview(sample);
const cards = [...host.querySelectorAll('.remote-ov-card>header')].map(e => e.textContent.trim());
check('七张卡片都画出来', host.querySelectorAll('.remote-ov-card').length === 7);
check('卡片标题分别是资源/系统/分区/服务/Docker/端口/占用',
  cards.length === 7 && cards[0] === '资源监控' && /系统信息/.test(cards[1]) && /磁盘分区/.test(cards[2])
  && /服务/.test(cards[3]) && /Docker/.test(cards[4]) && /监听端口/.test(cards[5]) && /主目录占用/.test(cards[6]));
check('三条进度条（CPU/内存/磁盘）都有宽度',
  [...host.querySelectorAll('.remote-ov-bar>i')].map(e => e.style.width).join(',') === '50%,40%,52%');
check('CPU 由 /proc/stat 算出 50% 使用率', /50%/.test(host.querySelector('.remote-ov-meter').textContent));
check('内存显示 3.2/8 GB 与交换分区',
  /3\.2 GB/.test(host.textContent) && /交换/.test(host.textContent));
check('运行时长格式化为「3 天 5 小时」', /3 天 5 小时/.test(host.textContent));
check('系统信息含发行版/内核/架构/主机名',
  /Ubuntu 22\.04\.3 LTS/.test(host.textContent) && /6\.8\.0-45/.test(host.textContent)
  && /x86_64/.test(host.textContent) && /prod-01/.test(host.textContent));
check('监听端口显示端口号与进程名', /22/.test(host.querySelectorAll('.remote-ov-card')[5].textContent));

// ③ 阈值配色：95% 应该是 critical
panel.renderOverview({ ...sample, memory: { ...sample.memory, used: 7.8 * 1024 ** 3 } });
const levels = [...host.querySelectorAll('.remote-ov-meter')].map(e => e.dataset.level);
check('内存 97% 触发 critical 配色', levels.includes('critical'));

// ④ 没装 Docker：不画 Docker 卡片（而不是留空卡片）
panel.renderOverview({ ...sample, docker: [], dockerSupported: false });
check('没有容器时不画 Docker 卡片', !/Docker 容器/.test(host.textContent));

// ⑤ 关键：缺字段不崩
panel.renderOverview({ os: {}, kernel: {}, cpu: {}, memory: {}, disks: [], listen: [], services: [], docker: [], du: [] });
check('字段大量缺失时仍能渲染（服务端采集失败也不炸界面）', host.querySelectorAll('.remote-ov-card').length >= 2);

console.log('远程概览：' + passed + ' 通过 / 0 失败');

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
  listen: [{ proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd', pid: 1234 }],
  services: [{ unit: 'ssh.service', active: 'active', sub: 'running', description: 'OpenBSD Secure Shell server' }],
  docker: [{ name: 'web', image: 'nginx:1.25', status: 'Up 3 days' }],
  du: [{ bytes: 1024 ** 3, path: '/home/u/projects' }],
  dockerSupported: true,
};
panel.renderOverview(sample);
const cards = [...host.querySelectorAll('.remote-ov-card>header')].map(e => e.textContent.trim());
// 布局在 2026-10-28 改成「两列容器」：左列 = 资源监控 + 服务器对象（运维台），右列 = 其余卡片。
// 原来的断言绑在单层栅格 + span-2 上，已随布局一起更新。
// 2026-10-28：右侧列的卡片（系统/磁盘/端口/服务/目录）全部并入「服务器对象」的分类，
// 页面只剩两张卡：资源监控 + 服务器对象。相应断言随之更新。
check('只画两张卡：资源监控 + 服务器对象',
  host.querySelectorAll('.remote-ov-card').length === 2);
check('单列布局（不再有右侧列）',
  !!host.querySelector('.remote-ov-grid.single') && !host.querySelector('.remote-ov-col.side'));
check('服务器对象卡内含七个分类',
  ['Docker', '服务', '进程', '端口', '磁盘', '目录', '系统']
    .every(name => new RegExp(name).test(host.querySelector('.remote-ops-segs')?.textContent || '')));
check('三格摘要条（CPU/内存/磁盘）都有宽度',
  [...host.querySelectorAll('.remote-ov-mini-bar>i')].map(e => e.style.width).join(',') === '50%,40%,52%');
check('CPU 由 /proc/stat 算出 50% 使用率', /50%/.test(host.querySelector('.remote-ov-mini').textContent));
check('内存显示 3.2 GB 与总量',
  /3\.2 GB/.test(host.textContent) && /8 GB/.test(host.textContent));
check('运行时长格式化为「3 天 5 小时」', /3 天 5 小时/.test(host.textContent));
// 「系统」分类里才有发行版/内核/架构/主机名（默认显示的是服务分类）
panel.renderOverview(sample, 'sys');
check('系统分类含发行版/内核/架构/主机名',
  /Ubuntu 22\.04\.3 LTS/.test(host.textContent) && /6\.8\.0-45/.test(host.textContent)
  && /x86_64/.test(host.textContent) && /prod-01/.test(host.textContent));
panel.renderOverview(sample);
panel.renderOverview(sample, 'port');
check('端口分类显示端口号与进程名',
  /22/.test(host.querySelector('.remote-ops-list')?.textContent || '')
  && /sshd/.test(host.querySelector('.remote-ops-list')?.textContent || ''));
panel.renderOverview(sample);

// ③ 阈值配色：95% 应该是 critical
panel.renderOverview({ ...sample, memory: { ...sample.memory, used: 7.8 * 1024 ** 3 } });
const levels = [...host.querySelectorAll('.remote-ov-mini')].map(e => e.dataset.level);
check('内存 97% 触发 critical 配色', levels.includes('critical'));

// ④ 没装 Docker：不画 Docker 卡片（而不是留空卡片）
panel.renderOverview({ ...sample, docker: [], dockerSupported: false });
check('没有容器时不画 Docker 卡片', !/Docker 容器/.test(host.textContent));

// ⑫ 布局：资源监控占大头（跨两行），右侧一列堆其余卡片。
check('资源监控在运维台上方', /资源监控/.test(host.querySelector('.remote-ov-grid.single')?.textContent || ''));
check('三格摘要条都在', host.querySelectorAll('.remote-ov-mini').length === 3);
const cssNow = fs.readFileSync(path.join(rendererDir, 'remote.css'), 'utf8');
check('网格是两列（1.15fr / .85fr）', /1\.15fr/.test(cssNow) && /[.\d]85fr/.test(cssNow));

// ⑬ 交互：每一行都带得动后续操作所需的数据属性。
// 前置：前面几条测试会用「无 Docker」「空字段」等变体重渲染同一个 host，
// 所以这里必须先用完整样本再渲染一次，否则读到的是残局（Docker 行就没了）。
panel.renderOverview(sample);
// 表格化后数据分散到各单元格：用表头 + 单元格文本一起判断
check('磁盘分类含分区行与表头', (() => {
  panel.renderOverview(sample, 'disk');
  const list = host.querySelector('.remote-ops-list')?.textContent || '';
  const heads = host.querySelector('.remote-ops-thead')?.textContent || '';
  const ok = list.includes('/') && /已用/.test(heads) && /占用/.test(heads);
  panel.renderOverview(sample); return ok;
})());
check('Docker 对象有运维按钮（日志/重启等）',
  host.querySelectorAll('[data-ops-run^="docker."]').length >= 1);
check('端口分类行带 PID 列', (() => {
  panel.renderOverview(sample, 'port');
  const heads = host.querySelector('.remote-ops-thead')?.textContent || '';
  const list = host.querySelector('.remote-ops-list')?.textContent || '';
  // PID 现在是独立一列（表头有 PID，行里是裸数字）
  const ok = /PID/.test(heads) && list.includes('22') && list.includes('sshd');
  panel.renderOverview(sample); return ok;
})());
panel.renderOverview(sample, 'svc');
const svcActions = [...host.querySelectorAll('.remote-ops-act')]
  .map(b => b.dataset.opsRun).filter(Boolean);
check('服务分类带操作按钮与「更多」',
  svcActions.includes('systemd.restart') && svcActions.includes('systemd.status')
  && host.querySelectorAll('[data-ops-more]').length >= 1);
panel.renderOverview(sample);
// 2026-10-28：原来的「可点行」用 data-ov-* + is-clickable 标记，
// 现在改为运维台的真实按钮，点击目标明确、可键盘聚焦，比整行可点更清楚。
check('运维台按钮可聚焦（键盘可达）',
  !!host.querySelector('button.remote-ops-act')) ;

// ⑭ 网速：两次采样做差
check('资源卡显示入站/出站速率', /入站/.test(host.textContent) && /出站/.test(host.textContent));


// ⑤ 关键：缺字段不崩
panel.renderOverview({ os: {}, kernel: {}, cpu: {}, memory: {}, disks: [], listen: [], services: [], docker: [], du: [] });
check('字段大量缺失时仍能渲染（服务端采集失败也不炸界面）', host.querySelectorAll('.remote-ov-card').length >= 2);

// ⑥ 回归：viewer 写回远程后调用的刷新入口必须真实存在。
// 之前写的是 RemotePanel.refreshActive（不存在），可选链把错误吞了，刷新从未发生。
check('RemotePanel 导出 refresh（viewer 写回后靠它刷新，之前调了个不存在的名字）',
  typeof panel.refresh === 'function');
check('RemotePanel 导出 loadOverview', typeof panel.loadOverview === 'function');

// ⑦ 回归：概览轮询在断开/隐藏时必须停 —— syncVisible(false) 不可抛错
panel.syncVisible(false);
check('syncVisible(false) 不抛错（会顺带停掉概览轮询）', true);
panel.syncVisible(true);

// ⑧ 回归：#remote-notice 不能只在 .error 时可见。
// 原来 `#remote-notice{display:none}` + `.error{display:block}`，导致所有成功
// 提示（如「已打开 xx；保存后会自动传回服务器」）永远不显示 —— 用户点「编辑
// 远程文件」看不到任何反馈，以为功能没生效。
const css = fs.readFileSync(path.join(rendererDir, 'remote.css'), 'utf8');
const noticeRule = (css.match(/#remote-notice\s*\{[^}]*\}/) || [''])[0];
check('#remote-notice 默认可见（不是 display:none）', /display:\s*block/.test(noticeRule) || !/display:\s*none/.test(noticeRule));
check('#remote-notice 空内容时收起（:empty）', /#remote-notice:empty/.test(css));

// ⑨ 回归：打开文件时必须让远程面板让位。
// #remote-main 是 position:absolute;inset:0;z-index:40，不让位就整块盖住编辑器 ——
// 用户点「编辑远程文件」后只看得到远程面板，以为编辑没弹出（就是用户截图的现象）。
const viewerSrc = fs.readFileSync(path.join(rendererDir, 'viewer.js'), 'utf8');
const callSites = (viewerSrc.match(/App\.backToEditor\(\)/g) || []).length;
check('viewer 里有多处「打开文件先让工具让位」的调用点', callSites >= 3);
check('让位名单包含 remote（单条件多选一写法）', /'bookshelf',\s*'remote'/.test(viewerSrc));
check('让位名单包含 remote（|| 串联写法）', /tool === 'bookshelf' \|\| tool === 'remote'/.test(viewerSrc));
check('让位后仍能通过工具栏切回远程面板（backToEditor 只改 activeTool）',
  /activeTool === 'remote'/.test(fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8')));

// ⑩ 回归：远程文件编辑必须是独立弹框（用户明确要求：不要跳标签页）。
const panelSrc = fs.readFileSync(path.join(rendererDir, 'remote-panel.js'), 'utf8');
check('存在 openRemoteEditor 弹框入口', /async function openRemoteEditor/.test(panelSrc));
check('editEntry 对远程文件走弹框，不再 Viewer.openFile 跳标签页',
  /await openRemoteEditor\(entry\)/.test(panelSrc));
check('弹框用 Modal.show（独立浮层，不占主编辑区）', /Modal\.show\(box\)/.test(panelSrc));
check('远程编辑不再依赖 remote:// 虚拟路径跳转',
  !/Viewer\.openFile\(virtual\)/.test(panelSrc));
// CSS：必须用 .modal-panel.re-box 双类，否则被 .modal-panel 的 560px 压回去
const cssSrc = fs.readFileSync(path.join(rendererDir, 'remote.css'), 'utf8');
check('弹框尺寸用双类选择器覆盖 .modal-panel', /\.modal-panel\.re-box\s*\{/.test(cssSrc));
const boxRule = (cssSrc.match(/\.modal-panel\.re-box\s*\{[^}]*\}/) || [''])[0];
check('弹框宽度不再是 560px', /width:\s*min\(72vw,\s*1040px\)/.test(boxRule));
check('弹框高度用视口比例', /height:\s*min\(76vh,\s*760px\)/.test(boxRule));

// ⑪ 回归：CodeEditor.create 的 canEdit 必须是函数，不是布尔值。
// code-editor.js 里写的是 `opts.canEdit && !opts.canEdit()`；传 true 会抛
// "opts.canEdit is not a function"，弹框打开即报错（实测就是这个错误）。
check('弹框把 canEdit 传成函数（不是 true）', /canEdit:\s*\(\)\s*=>\s*true/.test(panelSrc));
check('弹框没有把 canEdit 传成布尔值', !/canEdit:\s*true/.test(panelSrc));
check('onSave 走 saveOnce（避免与 keydown 重复写入）', /onSave:\s*\(\)\s*=>\s*\{\s*void saveOnce\(\)/.test(panelSrc));
check('保存按钮也走 saveOnce', /action === 'save'\) void saveOnce\(\)/.test(panelSrc));
check('CodeMirror 不可用时有 textarea 兜底', /re-textarea/.test(panelSrc));

// ⑫ 顶部告警带（2026-10-29 P1-2，方案 241 §3.5）
// 只在有异常时出现；每项可点，点了切到对应分类并自动勾「只看异常」。
const badSample = {
  ...sample,
  docker: [
    { name: 'web', image: 'nginx:1.25', status: 'Up 3 days' },
    { name: 'cron', image: 'busybox', status: 'Exited (1) 2 hours ago' },
    { name: 'db', image: 'postgres:16', status: 'Up 1 day', health: 'unhealthy' },
  ],
  services: [
    { unit: 'ssh.service', active: 'active', sub: 'running', description: 'ssh' },
    { unit: 'bad.service', active: 'failed', sub: 'failed', description: 'broken' },
  ],
  disks: [{ fs: '/dev/sda1', mount: '/', total: 100 * 1024 ** 3, used: 95 * 1024 ** 3, percent: 95 }],
};

// 无异常时：槽位在但内容为空（CSS :empty 让整条不占高度）
panel.renderOverview(sample);
const quietBand = host.querySelector('#remote-ov-alert');
check('无异常时告警带不显示任何项',
  !!quietBand && quietBand.textContent.trim() === '' && quietBand.querySelectorAll('[data-alert-cat]').length === 0);

panel.renderOverview(badSample);
const band = host.querySelector('#remote-ov-alert');
check('有异常时出现告警带', !!band && /⚠/.test(band.textContent || ''));
// 异常容器：cron 非 0 退出 + db 不健康 = 2 个（web 正常不计）
check('告警带统计 2 个容器异常', /2 个容器异常/.test(band.textContent));
check('告警带统计 1 个服务失败', /1 个服务失败/.test(band.textContent));
check('磁盘达到 90% 时进入告警带', /95%/.test(band.textContent) && /剩余/.test(band.textContent));
check('每条告警可点（带 data-alert-cat）',
  band.querySelectorAll('[data-alert-cat]').length === 3);

// 点「容器异常」→ 切到 Docker 分类 + 自动勾上只看异常
const bandDocker = [...band.querySelectorAll('[data-alert-cat]')].find(b => b.dataset.alertCat === 'docker');
bandDocker.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
check('点告警项切到 Docker 分类',
  /Docker/.test(host.querySelector('.remote-ops-segs .active')?.textContent || ''));
check('点告警项自动勾上「只看异常」',
  host.querySelector('[data-ops-onlybad]')?.checked === true);
check('只看异常后列表只剩 2 条异常容器',
  host.querySelectorAll('#remote-ops-list .remote-ops-row').length === 2);

// 告警带与列表的「异常」判据必须一致，否则会出现「说 2 个、点进去是空」
check('告警带计数与筛选出的行数一致（2 = 2）',
  /2 个容器异常/.test(host.querySelector('#remote-ov-alert').textContent)
  && host.querySelectorAll('#remote-ops-list .remote-ops-row').length === 2);

// ⑬ 分组折叠（2026-10-29 P1-2，方案 241 §4.3）
const svcSample = {
  ...sample,
  docker: [],
  services: [
    { unit: 'a.service', active: 'active', sub: 'running', description: 'A' },
    { unit: 'b.service', active: 'active', sub: 'running', description: 'B' },
    { unit: 'c.service', active: 'inactive', sub: 'dead', description: 'C' },
    { unit: 'd.service', active: 'failed', sub: 'failed', description: 'D' },
  ],
};
// 先把「服务」分类的只看异常关掉（上一步点告警时改的是 docker 的，这里保险起见重置）
panel.renderOverview(svcSample, 'svc');
const groupHeads = [...host.querySelectorAll('.remote-ops-group')];
const groupText = groupHeads.map(g => g.textContent.replace(/\s+/g, ''));
check('服务按状态分成三组（失败 / 运行中 / 已停止）', groupHeads.length === 3, );
check('组名含失败、运行中、已停止',
  groupText.some(t => /失败/.test(t)) && groupText.some(t => /运行中/.test(t)) && groupText.some(t => /已停止/.test(t)));
check('异常组排在最前（问题一眼可见）', /失败/.test(groupText[0]));
check('组头带成员计数', groupText.some(t => /运行中2/.test(t)));
check('分组不影响行总数（4 条都在）',
  host.querySelectorAll('#remote-ops-list .remote-ops-row').length === 4);

// 收起「运行中」组：行少 2 条，组头仍在（还能再展开）
const runningHead = groupHeads.find(g => /运行中/.test(g.textContent));
const runningKey = runningHead.dataset.opsGroup;
runningHead.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
check('收起一组后该组的行消失',
  host.querySelectorAll('#remote-ops-list .remote-ops-row').length === 2);
check('收起后组头依然在（可再展开）',
  host.querySelectorAll('.remote-ops-group').length === 3);
const collapsedHead = host.querySelector('[data-ops-group="' + runningKey + '"]');
check('收起的组头标记为 is-collapsed', collapsedHead.classList.contains('is-collapsed'));
check('收起的组头 aria-expanded=false', collapsedHead.getAttribute('aria-expanded') === 'false');

// 再点一次展开
collapsedHead.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
check('再点组头能展开回来',
  host.querySelectorAll('#remote-ops-list .remote-ops-row').length === 4);

// 折叠状态按分类隔离：切到 Docker 不受影响，且 Docker 本身不分组
panel.renderOverview(badSample, 'docker');
check('Docker 分类不分组（没有组头）',
  host.querySelectorAll('.remote-ops-group').length === 0);

// 进程分类：内核线程默认收起（否则真实进程会被淹没）
const procSample = {
  ...sample,
  docker: [],
  services: [],
  procs: [
    { pid: 1, comm: 'systemd', cpu: 0.1, mem: 0.2, args: '/sbin/init' },
    { pid: 2, comm: 'kthreadd', cpu: 0, mem: 0, args: '[kthreadd]', kernelThread: true },
    { pid: 3, comm: 'kworker/0:0', cpu: 0, mem: 0, args: '[kworker/0:0]', kernelThread: true },
    { pid: 42, comm: 'node', cpu: 88, mem: 9, args: 'node server.js' },
  ],
};
panel.renderOverview(procSample, 'proc');
const procGroups = [...host.querySelectorAll('.remote-ops-group')].map(g => g.textContent.replace(/\s+/g, ''));
check('进程按状态分组（高占用 / 运行中 / 内核线程）', procGroups.length === 3);
check('内核线程组默认收起',
  host.querySelector('[data-ops-group="proc:内核线程"]')?.classList.contains('is-collapsed') === true);
check('默认收起后只渲染非内核线程的 2 条',
  host.querySelectorAll('#remote-ops-list .remote-ops-row').length === 2);

// ⑭ 分组 + 增量刷新必须共存（2026-10-29）
// 风险点：折叠的组不渲染行，若增量补丁拿「全量行」对比就会永远不相等，
// 等于每次都全量重建 —— 「刷新不打断」直接失效。这里用「节点实例是否被保留」
// 来证明走的是补丁路径，同时验证收起组的计数仍会更新。
panel.renderOverview(svcSample, 'svc');
const runningHead2 = [...host.querySelectorAll('.remote-ops-group')].find(g => /运行中/.test(g.textContent));
runningHead2.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));   // 收起运行中组
const beforeNode = host.querySelector('#remote-ops-list .remote-ops-row');
beforeNode.__marker = 'keep-me';

// 收起组里少了一个服务：可见行没变（都被收着），只有计数该变
const svcSlim = {
  ...svcSample,
  services: [
    { unit: 'a.service', active: 'active', sub: 'running', description: 'A' },
    { unit: 'c.service', active: 'inactive', sub: 'dead', description: 'C' },
    { unit: 'd.service', active: 'failed', sub: 'failed', description: 'D' },
  ],
};
panel.renderOverview(svcSlim, 'svc');
check('分组下结构未变时走增量补丁（节点实例被保留）',
  host.querySelector('#remote-ops-list .remote-ops-row')?.__marker === 'keep-me');
check('收起组的计数跟着更新（运行中 2 → 1）',
  /运行中1/.test([...host.querySelectorAll('.remote-ops-group')]
    .find(g => /运行中/.test(g.textContent))?.textContent.replace(/\s+/g, '') || ''));

// ⑮ 表格横向滚动 + CPU 口径（2026-10-29，用户截图圈出的两处）
// ① 表头与列表必须在同一个横向滚动容器里：列宽固定且 flex-shrink: 0，
//    窗口窄时原来各列直接重叠（「内存端口」「运行时长 命令行」糊成一片）。
panel.renderOverview(procSample, 'proc');
const scroll = host.querySelector('.remote-ops-scroll');
check('表头与列表在同一个横向滚动容器内',
  !!scroll && !!scroll.querySelector('.remote-ops-thead') && !!scroll.querySelector('#remote-ops-list'));

// ② ps 的 %CPU 按核心累计，可超 100%。数值照实显示，但 title 要说明「≈几核」，
//    否则 199.0% 会被当成算错。
panel.renderOverview({
  ...procSample,
  cpu: { cores: 4, load: [1, 1, 1], usage: { idle: 100, total: 400 } },
  procs: [
    { pid: 3036595, comm: 'WebContent', cpu: 199, mem: 7, rss: 261, etime: '4-07:09', args: '(无命令行)', kernelThread: false },
  ],
}, 'proc');
const cpuCell = [...host.querySelectorAll('#remote-ops-list .remote-ops-td')]
  .find(el => el.textContent === '199.0%');
check('CPU 超过 100% 时数值照实显示', !!cpuCell);
check('CPU 超 100% 的 title 说明「按核心累计」',
  /≈\s*2\.0\s*核/.test(cpuCell?.title || '') && /共 4 核/.test(cpuCell?.title || ''),
  cpuCell?.title);

// ⑯ 「内存」列在三个分类里必须含义一致（2026-10-29 用户指出）
// 原来 Docker/服务显示 34.8 MB，进程却显示 7.0% —— 同一个列名两种含义。
// 现在统一为绝对大小；进程的百分比移到独立的「占比」列。
const headerOf = () => [...host.querySelectorAll('.remote-ops-th')].map(e => e.textContent.replace(/\s+/g, ''));

panel.renderOverview(badSample, 'docker');
const dockerHead = headerOf();
check('Docker 表头有「内存」列', dockerHead.some(t => t.startsWith('内存')), dockerHead.join('|'));

panel.renderOverview({ ...badSample, services: badSample.services }, 'svc');
const svcHead = headerOf();
check('服务表头有「内存」列', svcHead.some(t => t.startsWith('内存')), svcHead.join('|'));

// 进程样本必须带 rss（常驻字节）与 mem（百分比），否则「内存」列显示 —，
// 就验证不到「这一列是大小而不是百分比」这件事。
panel.renderOverview({
  ...procSample,
  procs: [{ pid: 42, comm: 'node', cpu: 88, mem: 9, rss: 1024 * 1024, etime: '3:12:40', args: 'node server.js' }],
}, 'proc');
const procHead = headerOf();
check('进程表头同时有「内存」与「占比」两列',
  procHead.some(t => t.startsWith('内存')) && procHead.some(t => t.startsWith('占比')), procHead.join('|'));

// 进程「内存」列显示的是大小（含单位），不是百分比
const procRow = host.querySelector('#remote-ops-list .remote-ops-row');
const procCells = [...procRow.querySelectorAll('.remote-ops-td')].map(e => e.textContent.trim());
check('进程「内存」列显示大小（带单位）',
  procCells.some(t => /^\d+(\.\d+)?\s*(B|KB|MB|GB)$/.test(t)), procCells.join('|'));
check('进程「占比」列显示百分比',
  procCells.some(t => /^\d+(\.\d+)?%$/.test(t)), procCells.join('|'));

// ⑰ 进程运行时长要中文化（ps 的 `4-11:00:23` → 「4 天 11 小时」）
// 表头里 Docker/服务/进程都是中文时长，只有进程原来照搬 ps 的机器格式。
panel.renderOverview({
  ...procSample,
  // 换个 pid：同键行会走「增量补丁」复用旧 DOM（结构没变），拿到的仍是上一段样本的文本，
  // 这里要验证的是新数据渲染结果，所以让行键变化触发重建。
  procs: [{ pid: 999001, comm: 'java', cpu: 1, mem: 5, rss: 1024 * 1024, etime: '116-2:00:00', args: 'java -jar x' }],
}, 'proc');
const etimeRow = host.querySelector('#remote-ops-list .remote-ops-row');
// 按表头里「运行时长」的下标取单元格，别用「含天/小时」模糊查找 ——
// 那样会命中别的列（比如内存 1 GB 里的单位）而误判。
const etimeIdx = headerOf().indexOf('运行时长');
const etimeCells = [...etimeRow.querySelectorAll('.remote-ops-td')];
check('进程时长已中文化（116 天 2 小时）',
  /116 天 2 小时/.test(etimeCells[etimeIdx]?.textContent || ''),
  'idx=' + etimeIdx + ' text=' + (etimeCells[etimeIdx]?.textContent || ''));

// 内核线程没有命令行时不再显示「（无命令行）」占位
panel.renderOverview({
  ...procSample,
  procs: [{ pid: 7, comm: 'ksoftirqd/0', cpu: 199, mem: 7, rss: 264 * 1024, etime: '4-11:00:23', args: '', kernelThread: true }],
}, 'proc');
const ktRow = host.querySelector('#remote-ops-list .remote-ops-row');
check('内核线程的命令行列留空（不显示占位符）',
  !/（无命令行）/.test(ktRow?.textContent || ''), ktRow?.textContent.slice(0, 80));

console.log('远程概览：' + passed + ' 通过 / 0 失败');

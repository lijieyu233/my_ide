/**
 * 远程运维动作白名单（Docker / systemd / 进程 / 磁盘）。
 *
 * 为什么单独一个模块：这是**唯一**能把用户点击变成远程命令的地方，安全边界的核心。
 * 它必须小到能一眼审完 —— 任何「任意命令执行」的口子都不能从这里漏出去。
 *
 * 三条铁律：
 *   1. 不接受自由文本命令。调用方只能传 动作名 + 参数，命令在这里拼。
 *   2. 参数全部走白名单正则，拒绝 shell 元字符；拼接时再做单引号转义。
 *   3. 动作名必须是 ACTIONS 里的键，未知动作直接抛错。
 *
 * 成功判定只看退出码，不看输出文本（文本太容易被环境/语言影响）。
 */
const MAX_OUTPUT = 512 * 1024;
const DEFAULT_TIMEOUT = 20000;
const LOG_TIMEOUT = 30000;

/** 单引号转义：'a b' → 'a b'；嵌入的单引号变 '\'' */
const q = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

/** 容器名 / 镜像标签：docker 允许的字符集，显式拒绝空格与元字符。 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
/** systemd unit：必须以 .service 结尾，字母数字加常见分隔符。 */
const UNIT_RE = /^[a-zA-Z0-9@:_.\\-]+\.service$/;
/** PID：纯数字，且不接受 1（init/systemd 本体，杀掉会失去控制）。 */
const PID_RE = /^[1-9][0-9]{0,9}$/;
/** 绝对路径：不含换行与 NUL，不接受 shell 元字符。 */
const PATH_RE = /^\/[^\0\r\n;&|$`<>]*$/;
/** 尺寸参数（journal vacuum）：如 200M / 1G */
const SIZE_RE = /^[0-9]{1,6}[KMG]$/;

function need(value, re, label) {
  const text = String(value ?? '').trim();
  if (!text) throw Object.assign(Error('缺少' + label), { code: 'INVALID_ARGS' });
  if (!re.test(text)) throw Object.assign(Error(label + '不合法：' + text), { code: 'INVALID_ARGS' });
  return text;
}

function needPid(value) {
  const text = need(value, PID_RE, 'PID');
  if (text === '1') throw Object.assign(Error('不允许操作 PID 1（系统初始化进程）'), { code: 'INVALID_ARGS' });
  return text;
}

function needSize(value) {
  return need(value, SIZE_RE, '容量');
}

/**
 * 动作表。
 *   read    只读，界面不弹确认
 *   danger  破坏性，界面用红色按钮
 *   build   由校验后的参数拼出命令
 *   verify  写操作后用来回读状态的命令（结果交给界面展示，不做自动判断）
 */
const ACTIONS = {
  // ── Docker ────────────────────────────────────────────────────────────
  'docker.logs': {
    read: true, timeout: LOG_TIMEOUT,
    build: a => 'docker logs --tail ' + clampTail(a.tail) + ' ' + q(need(a.name, NAME_RE, '容器名')) + ' 2>&1',
  },
  'docker.inspect': {
    read: true,
    build: a => 'docker inspect ' + q(need(a.name, NAME_RE, '容器名')) + ' 2>&1 | head -c 20000',
  },
  'docker.start': {
    build: a => 'docker start ' + q(need(a.name, NAME_RE, '容器名')),
    verify: a => 'docker ps -a --filter name=^' + q(need(a.name, NAME_RE, '容器名')) + '$ --format "{{.State}}"',
  },
  'docker.stop': {
    build: a => 'docker stop ' + q(need(a.name, NAME_RE, '容器名')),
    verify: a => 'docker ps -a --filter name=^' + q(need(a.name, NAME_RE, '容器名')) + '$ --format "{{.State}}"',
  },
  'docker.restart': {
    build: a => 'docker restart ' + q(need(a.name, NAME_RE, '容器名')),
    verify: a => 'docker ps --filter name=^' + q(need(a.name, NAME_RE, '容器名')) + '$ --format "{{.State}} {{.Status}}"',
  },
  'docker.pause': {
    build: a => 'docker pause ' + q(need(a.name, NAME_RE, '容器名')),
  },
  'docker.unpause': {
    build: a => 'docker unpause ' + q(need(a.name, NAME_RE, '容器名')),
  },
  'docker.remove': {
    danger: true,
    // 只删已停止的容器：加 -f 会把运行中的也删掉，风险太大，这里显式不用。
    build: a => 'docker rm ' + q(need(a.name, NAME_RE, '容器名')),
  },
  'docker.pruneImages': {
    danger: true,
    // 先报可回收量，再清理 —— 让用户知道删了什么
    build: () => 'docker image prune -f 2>&1',
  },
  'docker.df': {
    read: true,
    build: () => 'docker system df 2>&1',
  },

  // ── systemd ───────────────────────────────────────────────────────────
  'systemd.status': {
    read: true,
    build: a => 'systemctl status ' + q(need(a.unit, UNIT_RE, '服务名')) + ' --no-pager -l 2>&1 | head -c 20000',
  },
  'systemd.logs': {
    read: true, timeout: LOG_TIMEOUT,
    build: a => 'journalctl -u ' + q(need(a.unit, UNIT_RE, '服务名'))
      + ' -n ' + clampTail(a.tail) + ' --no-pager 2>&1',
  },
  'systemd.start': {
    build: a => 'systemctl start ' + q(need(a.unit, UNIT_RE, '服务名')),
    verify: a => 'systemctl is-active ' + q(need(a.unit, UNIT_RE, '服务名')),
  },
  'systemd.stop': {
    build: a => 'systemctl stop ' + q(need(a.unit, UNIT_RE, '服务名')),
    verify: a => 'systemctl is-active ' + q(need(a.unit, UNIT_RE, '服务名')),
  },
  'systemd.restart': {
    build: a => 'systemctl restart ' + q(need(a.unit, UNIT_RE, '服务名')),
    verify: a => 'systemctl is-active ' + q(need(a.unit, UNIT_RE, '服务名')),
  },
  'systemd.reload': {
    build: a => 'systemctl reload ' + q(need(a.unit, UNIT_RE, '服务名')),
    verify: a => 'systemctl is-active ' + q(need(a.unit, UNIT_RE, '服务名')),
  },
  'systemd.isEnabled': {
    read: true,
    build: a => 'systemctl is-enabled ' + q(need(a.unit, UNIT_RE, '服务名')) + ' 2>&1',
  },

  // ── 进程 ──────────────────────────────────────────────────────────────
  'proc.list': {
    read: true,
    build: () => 'ps -eo pid,ppid,pcpu,pmem,rss,etime,comm --sort=-pcpu 2>&1 | head -n 60',
  },
  'proc.detail': {
    read: true,
    build: a => 'cat /proc/' + needPid(a.pid) + '/status 2>&1 | head -n 40; echo "---CMDLINE---"; '
      + 'tr "\\0" " " < /proc/' + needPid(a.pid) + '/cmdline 2>/dev/null; echo; '
      + 'echo "---CGROUP---"; cat /proc/' + needPid(a.pid) + '/cgroup 2>/dev/null',
  },
  'proc.kill': {
    danger: true,
    // 只发 TERM，不发 KILL：给进程清理的机会，也避免误杀关键服务时直接硬死。
    build: a => 'kill -TERM ' + needPid(a.pid),
  },

  // ── 磁盘 ──────────────────────────────────────────────────────────────
  'disk.usage': {
    read: true, timeout: LOG_TIMEOUT,
    build: a => 'du -xhd1 ' + q(need(a.path, PATH_RE, '路径')) + ' 2>/dev/null | sort -hr | head -n 30',
  },
  // 单个目录/文件的总大小（2026-10-29 文件页「显示大小」按需计算）。
  // 与 disk.usage 的区别：那个列子项（-d1），这个只要一个总数（-s、-b 输出字节）。
  // 用 -b 而不是 -h：前端统一按字节格式化，免得再解析 "1.2G" 这种人类可读单位。
  'disk.size': {
    read: true, timeout: LOG_TIMEOUT,
    build: a => 'du -sxb ' + q(need(a.path, PATH_RE, '路径')) + ' 2>/dev/null | cut -f1',
  },
  'disk.bigFiles': {
    read: true, timeout: LOG_TIMEOUT,
    build: a => 'find ' + q(need(a.path, PATH_RE, '路径'))
      + ' -xdev -type f -size +100M -printf "%s\\t%p\\n" 2>/dev/null | sort -nr | head -n 30',
  },
  'disk.aptCache': {
    read: true,
    build: () => 'du -sh /var/cache/apt 2>/dev/null | cut -f1',
  },
  'disk.journalSize': {
    read: true,
    build: () => 'journalctl --disk-usage 2>&1',
  },
  'disk.cleanApt': {
    danger: true,
    build: () => 'apt-get clean 2>&1',
  },
  'disk.vacuumJournal': {
    danger: true,
    build: a => 'journalctl --vacuum-size=' + needSize(a.size) + ' 2>&1',
  },
};

/** 日志行数：限 1..2000，默认 200。防止一次拉回几十万行。 */
function clampTail(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 200;
  return Math.min(2000, Math.max(1, Math.floor(n)));
}

/** 校验动作与参数，返回拼好的命令。未知动作 / 非法参数都抛错。 */
function plan(action, args) {
  const spec = ACTIONS[action];
  if (!spec) throw Object.assign(Error('不支持的操作：' + action), { code: 'UNKNOWN_ACTION' });
  const command = spec.build(args || {});
  if (/[\0\r\n]/.test(command)) throw Object.assign(Error('命令包含非法控制字符'), { code: 'INVALID_ARGS' });
  return {
    command,
    verify: spec.verify ? spec.verify(args || {}) : null,
    timeout: spec.timeout || DEFAULT_TIMEOUT,
    read: !!spec.read,
    danger: !!spec.danger,
  };
}

/** 判断动作是否只读（界面据此决定要不要弹确认）。 */
function isRead(action) {
  const spec = ACTIONS[action];
  if (!spec) return false;
  return !!spec.read;
}

module.exports = { ACTIONS, plan, isRead, MAX_OUTPUT, DEFAULT_TIMEOUT, LOG_TIMEOUT, clampTail };

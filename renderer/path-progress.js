// path-progress.js —— 长任务进度浮层（删除 / 复制 / 恢复 / 回收站）
//
// 为什么需要（开发文档-243）：删一个 4078 项、109 MB 的目录，主进程要先整份备份原字节
// （为了能恢复），再逐项真删；实测 12 分钟。这段时间界面没有任何反馈，用户以为「删不掉」，
// 又点了一次删除 → 第二次被路径锁挡回来，提示写成「删除未完成」—— 看着就像彻底失败。
//
// 设计取舍：
//   · 只做反馈，不做控制。不给「取消」按钮：中断删除会让一半文件没了、一半还在，
//     比等十几秒糟得多；真要取消有 Ctrl+Z 和「恢复文件操作」兜底。
//   · pointer-events:none，永不拦截点击，也不抢焦点。
//   · 没有总数时（还在统计/扫描）走不确定态动画，不假装知道百分比。
const PathProgress = (() => {
  const PHASES = {
    scanning: '统计项目',
    backup: '备份原字节',
    delete: '删除',
    trash: '移到回收站',
    copy: '复制',
    restore: '恢复',
    // 重命名/移动走快速路径时也会遍历目录做 stat 清单（大目录秒级以上）。
    // 复用 scanning 的文案会显示成「统计项目」，与用户看到的「改个名字」对不上，所以单列。
    moving: '核对目录项',
  };
  let box, labelEl, countEl, barEl, hintEl;
  let hideTimer = null;
  let startedAt = 0;
  let last = null;

  // 取 document：**优先当前 window**，且不能缓存。
  // 实测踩到两轮：① 不判空会在 jsdom 里拿到 undefined（宿主全局被换掉）；
  // ② 干脆缓存加载时那份，页面重建后又指向旧 document（getElementById 返回 null，
  //    之后进度条再也不出现）。所以按「当前 window → 裸 document → 宿主」的顺序现取，
  // 并让 ensure() 用 isConnected 校验缓存节点，换过 document 就重新查找。
  const HOST = (typeof globalThis !== 'undefined' && globalThis) || null;
  const doc = () => {
    try { if (typeof window !== 'undefined' && window && window.document) return window.document; } catch {}
    try { if (typeof document !== 'undefined' && document) return document; } catch {}
    try { if (HOST && HOST.document) return HOST.document; } catch {}
    return null;
  };

  function ensure() {
    // ⚠ 必须校验 isConnected：节点缓存后如果 DOM 被整体重建（换主题、重载视图、用例重置页面），
    // 旧引用就脱离文档了 —— 此时继续写它，界面上什么都不变，看起来像「进度没反应」。
    if (box && box.isConnected !== false) return true;
    const d = doc();
    // 找不到当前 document 时保留已有缓存：宁可写旧节点，也不要因为取不到全局就静默不显示。
    if (!d) return !!(box && labelEl && countEl && barEl && hintEl);
    const next = d.getElementById('sb-progress');
    if (!next) return !!(box && labelEl && countEl && barEl && hintEl);
    box = next;
    labelEl = d.getElementById('sb-progress-label');
    countEl = d.getElementById('sb-progress-count');
    barEl = d.getElementById('sb-progress-bar');
    hintEl = d.getElementById('sb-progress-hint');
    return !!(labelEl && countEl && barEl && hintEl);
  }

  function ratio(done, total) {
    if (!Number.isFinite(total) || total <= 0) return null;
    return Math.max(0, Math.min(1, done / total));
  }

  function paint(info) {
    if (!ensure()) return;
    const phaseText = PHASES[info.phase] || '';
    // 「复制」阶段的 label 已经是动作名，别拼成「复制复制」
    const action = info.label && info.label !== phaseText ? info.label : '';
    labelEl.textContent = action ? action + ' · ' + (phaseText || '进行中') : (phaseText || '处理中');
    const hasTotal = Number.isFinite(info.total) && info.total > 0;
    countEl.textContent = hasTotal ? info.done + ' / ' + info.total : info.done > 0 ? String(info.done) + ' 项' : '';
    const r = ratio(info.done, info.total);
    box.classList.toggle('indeterminate', r == null);
    if (r != null) barEl.style.width = (r * 100).toFixed(1) + '%';
    // 提示只在真正开始处理时说清楚「为什么这么慢」，避免每帧重排
    hintEl.textContent = info.phase === 'backup' ? '先把原字节备份进恢复目录，之后可用「恢复文件操作」找回'
      : info.phase === 'scanning' ? '正在统计项数与体积，大目录需要几秒'
      : info.phase === 'moving' ? '正在核对目录项，文件多时需要几秒'
      : '';
  }

  function show(info) {
    if (!info || !info.phase) return;
    if (!startedAt) startedAt = Date.now();
    last = info;
    clearTimeout(hideTimer);
    paint(info);
    if (box) box.classList.remove('hidden');
  }

  function hide(delay) {
    clearTimeout(hideTimer);
    if (!ensure()) return;
    hideTimer = setTimeout(() => {
      box.classList.add('hidden');
      barEl.style.width = '0';
      startedAt = 0; last = null;
    }, delay == null ? 0 : delay);
  }

  let subscribed = false;
  function attach() {
    if (subscribed) return;
    const api = window.myIDE?.fs;
    if (!api?.onPathProgress) return;
    subscribed = true;
    api.onPathProgress(show);
    // 一次操作结束（成功、失败、取消）都要收起来：见 track()。
  }

  /** 包住一次文件操作：结束后收起进度条。失败也要收，否则浮层会永久挂在那儿。 */
  async function track(task) {
    try {
      return await task();
    } finally {
      hide();
    }
  }

  // 挂载时机：main.js 里 preload 早就注入了 myIDE.fs，脚本一加载就能订阅，
  // 不必等 App.init —— 否则任何绕过 App 初始化的路径（测试、插件早调用）都收不到进度。
  attach();

  // 用户主动按 Ctrl+Z / 走「恢复文件操作」时，主进程同样会发进度，无需特殊处理。
  return { attach, show, hide, track, __phases: PHASES };
})();
if (typeof window !== 'undefined') window.PathProgress = PathProgress;

// pet.js —— 右下角玩宠（小橘猫）：MI.toast 的消息由它播报
// 机制：包装 MI.toast —— 消息照常进入 #toast-wrap（气泡出现在猫头顶），猫跳一下表示"我在说"
const Pet = (() => {
  let el = null;
  let hooked = false;

  const CAT_SVG = [
    '<svg viewBox="0 0 64 64" aria-hidden="true">',
    '<path d="M14 26 L10 8 L28 16 Z" fill="#f5b971"/>',
    '<path d="M50 26 L54 8 L36 16 Z" fill="#f5b971"/>',
    '<path d="M16 24 L13 12 L25 17 Z" fill="#e8967a"/>',
    '<path d="M48 24 L51 12 L39 17 Z" fill="#e8967a"/>',
    '<circle cx="32" cy="36" r="22" fill="#f5b971"/>',
    '<ellipse cx="24" cy="34" rx="3" ry="4" fill="#3a3a3a"/>',
    '<ellipse cx="40" cy="34" rx="3" ry="4" fill="#3a3a3a"/>',
    '<circle cx="25.2" cy="32.4" r="1" fill="#fff"/>',
    '<circle cx="41.2" cy="32.4" r="1" fill="#fff"/>',
    '<path d="M30 41 L34 41 L32 44 Z" fill="#e8967a"/>',
    '<path d="M32 44 Q28 48 25 45" stroke="#3a3a3a" fill="none" stroke-width="1.5" stroke-linecap="round"/>',
    '<path d="M32 44 Q36 48 39 45" stroke="#3a3a3a" fill="none" stroke-width="1.5" stroke-linecap="round"/>',
    '<path d="M12 38 L20 39 M12 44 L20 43" stroke="#c9955c" stroke-width="1.2" stroke-linecap="round"/>',
    '<path d="M52 38 L44 39 M52 44 L44 43" stroke="#c9955c" stroke-width="1.2" stroke-linecap="round"/>',
    '</svg>',
  ].join('');

  const IDLE_LINES = [
    '喵~ 代码写得不错喵',
    '喵呜 ~ 记得勤保存（Ctrl+S）',
    '喵！喝口水休息一下吧',
    '喵 ~ 改错了就 Ctrl+Z 回来',
    '喵呜 ~ 今天也要元气满满',
  ];

  function ensure() {
    if (el && el.isConnected) return el;
    el = document.createElement('div');
    el.id = 'pet';
    el.title = '点我一下？';
    el.innerHTML = CAT_SVG;
    document.body.appendChild(el);
    el.addEventListener('click', () => {
      MI.toast(IDLE_LINES[Math.floor(Math.random() * IDLE_LINES.length)], 'ok');
    });
    return el;
  }

  // 说话动作：跳一下（550ms），结束后回到呼吸动画
  function speak() {
    const p = ensure();
    p.classList.remove('speaking');
    void p.offsetWidth; // 重启动画
    p.classList.add('speaking');
    clearTimeout(speak._t);
    speak._t = setTimeout(() => p.classList.remove('speaking'), 600);
  }

  function hook() {
    if (hooked) return;
    if (typeof MI === 'undefined' || !MI.toast) return;
    hooked = true;
    ensure();
    const orig = MI.toast;
    MI.toast = function (msg, type) {
      const r = orig.call(MI, msg, type);
      try { speak(); } catch {}
      return r;
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook);
  else hook();

  return { speak, hook };
})();
window.Pet = Pet;

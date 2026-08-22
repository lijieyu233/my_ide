// pet.js —— 右下角桌面玩偶：MI.toast 的消息由它播报
// 机制：包装 MI.toast —— 消息照常进入 #toast-wrap（气泡出现在玩偶头顶），玩偶跳一下表示"我在说"
// 点击玩偶：弹出菜单（切换玩偶 / 退出玩偶）
const Pet = (() => {
  let el = null;
  let hooked = false;

  // ---------- 玩偶图鉴（SVG 内联，零资源依赖）----------
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

  const DOG_SVG = [
    '<svg viewBox="0 0 64 64" aria-hidden="true">',
    '<path d="M14 30 Q8 20 12 14 Q20 18 22 26 Z" fill="#c9a06c"/>',
    '<path d="M50 30 Q56 20 52 14 Q44 18 42 26 Z" fill="#c9a06c"/>',
    '<circle cx="32" cy="36" r="21" fill="#dcb27c"/>',
    '<ellipse cx="24" cy="34" rx="2.6" ry="3.6" fill="#3a3a3a"/>',
    '<ellipse cx="40" cy="34" rx="2.6" ry="3.6" fill="#3a3a3a"/>',
    '<circle cx="25" cy="32.6" r="1" fill="#fff"/>',
    '<circle cx="41" cy="32.6" r="1" fill="#fff"/>',
    '<ellipse cx="32" cy="43" rx="4" ry="3" fill="#3a3a3a"/>',
    '<path d="M32 46 Q28 50 24 48 M32 46 Q36 50 40 48" stroke="#3a3a3a" fill="none" stroke-width="1.4" stroke-linecap="round"/>',
    '<path d="M20 40 Q24 44 28 42" stroke="#b08c5a" stroke-width="1.2" fill="none" stroke-linecap="round"/>',
    '</svg>',
  ].join('');

  const RABBIT_SVG = [
    '<svg viewBox="0 0 64 64" aria-hidden="true">',
    '<ellipse cx="24" cy="18" rx="5" ry="13" fill="#e8e4dd"/>',
    '<ellipse cx="40" cy="18" rx="5" ry="13" fill="#e8e4dd"/>',
    '<ellipse cx="24" cy="19" rx="2.4" ry="9" fill="#f0b8c0"/>',
    '<ellipse cx="40" cy="19" rx="2.4" ry="9" fill="#f0b8c0"/>',
    '<circle cx="32" cy="38" r="19" fill="#f0ece5"/>',
    '<ellipse cx="25" cy="36" rx="2.6" ry="3.4" fill="#3a3a3a"/>',
    '<ellipse cx="39" cy="36" rx="2.6" ry="3.4" fill="#3a3a3a"/>',
    '<circle cx="26" cy="34.8" r="1" fill="#fff"/>',
    '<circle cx="40" cy="34.8" r="1" fill="#fff"/>',
    '<path d="M30 43 L34 43 L32 46 Z" fill="#e8967a"/>',
    '<path d="M32 46 Q28 50 26 47 M32 46 Q36 50 38 47" stroke="#3a3a3a" fill="none" stroke-width="1.4" stroke-linecap="round"/>',
    '</svg>',
  ].join('');

  const DUCK_SVG = [
    '<svg viewBox="0 0 64 64" aria-hidden="true">',
    '<circle cx="32" cy="40" r="17" fill="#f5d76e"/>',
    '<circle cx="26" cy="26" r="11" fill="#f7dd83"/>',
    '<ellipse cx="22.5" cy="25" rx="2" ry="3" fill="#3a3a3a"/>',
    '<path d="M15 27 L4 29 L15 32 Z" fill="#f0a030"/>',
    '<path d="M37 30 Q50 26 48 38 Q44 44 37 41 Z" fill="#f7dd83"/>',
    '<circle cx="38" cy="36" r="1.6" fill="#3a3a3a"/>',
    '</svg>',
  ].join('');

  const PETS = [
    { key: 'cat', name: '橘猫', svg: CAT_SVG, line: '喵~' },
    { key: 'dog', name: '柴犬', svg: DOG_SVG, line: '汪！' },
    { key: 'rabbit', name: '兔子', svg: RABBIT_SVG, line: '蹦蹦跳跳~' },
    { key: 'duck', name: '鸭子', svg: DUCK_SVG, line: '嘎嘎！' },
  ];
  const petKey = () => {
    try { return localStorage.getItem('myide-pet') || 'cat'; } catch { return 'cat'; }
  };
  const petOn = () => {
    try { return localStorage.getItem('myide-pet-on') !== '0'; } catch { return true; }
  };
  const curPet = () => PETS.find((p) => p.key === petKey()) || PETS[0];

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
    el.title = '点击切换玩偶 / 退出';
    el.innerHTML = curPet().svg;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { e.stopPropagation(); showPetMenu(e.clientX, e.clientY); });
    return el;
  }

  // 点击玩偶 → 菜单：切换玩偶 + 退出
  function showPetMenu(x, y) {
    const menu = document.getElementById('ctx-menu');
    if (!menu) return;
    menu.innerHTML = '';
    const mk = (label, fn, danger) => {
      const d = document.createElement('div');
      d.className = 'ctx-item' + (danger ? ' danger' : '');
      d.textContent = label;
      d.onclick = () => { menu.classList.add('hidden'); fn(); };
      menu.appendChild(d);
    };
    const cur = petKey();
    PETS.forEach((p) => {
      mk((p.key === cur ? '● ' : '') + p.name, () => setPet(p.key));
    });
    mk('✕ 退出玩偶', () => setPetOn(false), true);
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x - mw, window.innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y - mh - 8, window.innerHeight - mh - 8)) + 'px';
  }

  function setPet(key) {
    try { localStorage.setItem('myide-pet', key); } catch {}
    if (el) el.innerHTML = (PETS.find((p) => p.key === key) || PETS[0]).svg;
    MI.toast(curPet().line + ' 上线啦', 'ok');
  }
  function setPetOn(on) {
    try { localStorage.setItem('myide-pet-on', on ? '1' : '0'); } catch {}
    if (on) { const p = ensure(); p.style.display = ''; }
    else if (el) el.style.display = 'none';
    if (on) MI.toast(curPet().line + ' 回来了', 'ok');
    else MI.toast('玩偶已退出（设置 → 外观可重新开启）', 'ok');
  }
  function isOn() { return petOn(); }

  // 说话动作：跳一下（550ms），结束后回到呼吸动画
  function speak() {
    if (!petOn()) return;
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
    if (petOn()) ensure();
    const orig = MI.toast;
    MI.toast = function (msg, type) {
      const r = orig.call(MI, msg, type);
      try { speak(); } catch {}
      return r;
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook);
  else hook();

  return { speak, hook, setPet, setPetOn, isOn, PETS };
})();
window.Pet = Pet;

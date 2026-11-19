window.DrawioCanvasMenu = (() => {
  function create(focus) {
    const menu = document.createElement('div');
    menu.className = 'diagram-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '图文画布操作');
    menu.hidden = true;
    document.body.append(menu);

    function close(restore = false) {
      if (menu.hidden) return;
      menu.hidden = true;
      if (restore) focus();
    }
    const buttons = () => [...menu.querySelectorAll('button:not(:disabled)')];
    const outside = event => { if (!menu.contains(event.target)) close(); };
    menu.oncontextmenu = event => event.preventDefault();
    menu.onkeydown = event => {
      const available = buttons();
      const index = available.indexOf(document.activeElement);
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 :
          (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length;
        available[next]?.focus();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', outside);

    function open(x, y, groups) {
      menu.replaceChildren();
      for (const actions of groups.filter(group => group.length)) {
        const section = document.createElement('div');
        section.setAttribute('role', 'group');
        for (const { label, shortcut, run, danger, disabled } of actions) {
          const button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('role', 'menuitem');
          button.textContent = label;
          button.disabled = !!disabled;
          if (danger) button.classList.add('danger');
          if (shortcut) {
            const key = document.createElement('kbd');
            key.textContent = shortcut;
            button.append(key);
          }
          button.onclick = () => {
            close(true);
            Promise.resolve().then(run).catch(error => MI.toast(error.message || String(error), 'err'));
          };
          section.append(button);
        }
        menu.append(section);
      }
      menu.hidden = false;
      menu.scrollTop = 0;
      menu.style.left = '0px';
      menu.style.top = '0px';
      const { width, height } = menu.getBoundingClientRect();
      menu.style.left = Math.max(6, Math.min(x, innerWidth - width - 6)) + 'px';
      menu.style.top = Math.max(6, Math.min(y, innerHeight - height - 6)) + 'px';
      buttons()[0]?.focus({ preventScroll: true });
    }
    return { open, close, dispose() {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', outside);
      menu.remove();
    } };
  }

  function form(title, fields, { preview, validate, ready } = {}) {
    return new Promise(resolve => {
      const box = document.createElement('form');
      box.className = 'diagram-options';
      box.dataset.selfEsc = '1';
      const heading = document.createElement('div');
      heading.className = 'm-head';
      heading.textContent = title;
      const body = document.createElement('div');
      body.className = 'm-body';
      if (preview) body.append(preview);
      const controls = new Map();
      for (const [name, label, type, value, attrs] of fields) {
        const row = document.createElement('label');
        row.className = 'diagram-option';
        row.textContent = label;
        const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
        if (type !== 'textarea') input.type = type;
        input.value = value ?? '';
        for (const [attr, attrValue] of Object.entries(attrs || {})) input.setAttribute(attr, attrValue);
        row.append(input);
        body.append(row);
        controls.set(name, input);
      }
      const footer = document.createElement('div');
      footer.className = 'm-foot';
      const cancel = document.createElement('button'), ok = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'tb-btn m-cancel';
      cancel.textContent = '取消';
      ok.className = 'tb-btn m-ok';
      ok.textContent = '应用';
      footer.append(cancel, ok);
      box.append(heading, body, footer);
      let result = null;
      box.onModalHide = () => resolve(result);
      cancel.onclick = () => Modal.hide();
      box.onsubmit = event => {
        event.preventDefault();
        const values = Object.fromEntries([...controls].map(([name, input]) => [name, input.value]));
        const error = validate?.(values);
        if (error) { MI.toast(error, 'err'); return; }
        result = values;
        Modal.hide();
      };
      box.onkeydown = event => {
        if (event.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          Modal.hide();
        } else if (event.key === 'Enter' && (event.target.tagName === 'INPUT' || event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          event.stopPropagation();
          box.requestSubmit();
        }
      };
      Modal.show(box);
      ready?.(controls);
      controls.values().next().value?.focus();
    });
  }
  return { create, form };
})();

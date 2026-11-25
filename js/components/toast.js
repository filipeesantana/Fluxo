import { h, icon } from '../utils/dom.js';

export function toast(message, { action, tone = 'default', timeout = 3600 } = {}) {
  const host = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${tone}` },
    tone === 'error' ? icon('alert', 'icon-sm') : tone === 'success' ? icon('check', 'icon-sm') : null,
    h('span', { class: 'grow' }, message),
    action ? h('button', { class: 'link-btn', type: 'button', onclick: () => { action.fn(); dismiss(); } }, action.label) : null,
  );
  host.append(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  const t = setTimeout(dismiss, action ? Math.max(timeout, 6000) : timeout);
  function dismiss() {
    clearTimeout(t);
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), 200);
  }
  while (host.children.length > 3) host.firstElementChild.remove();
  return dismiss;
}

export function toastError(err) {
  console.error(err);
  const msg = err?.name === 'QuotaExceededError' ? 'Sem espaço de armazenamento no navegador.' : (err?.message || 'Algo deu errado.');
  toast(msg, { tone: 'error', timeout: 6000 });
}

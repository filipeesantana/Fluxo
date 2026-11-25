import { readPref, writePref } from './state.js';

const media = window.matchMedia('(prefers-color-scheme: dark)');

export function currentThemePref() {
  const v = readPref('theme', 'system');
  return ['light', 'dark', 'system'].includes(v) ? v : 'system';
}

function resolve(pref) {
  return pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
}

export function applyTheme(pref = currentThemePref()) {
  writePref('theme', pref);
  const root = document.documentElement;
  root.classList.add('theme-switching');
  root.dataset.theme = resolve(pref);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', root.dataset.theme === 'dark' ? '#111214' : '#f6f6f7'));
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
}

export function initTheme() {
  applyTheme(currentThemePref());
  media.addEventListener('change', () => { if (currentThemePref() === 'system') applyTheme('system'); });
  window.addEventListener('storage', (ev) => { if (ev.key === 'gf.theme') applyTheme(currentThemePref()); });
}

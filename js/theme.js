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
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', root.dataset.theme === 'dark' ? '#0e0f11' : '#f2f2f4'));
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  document.dispatchEvent(new CustomEvent('gf:theme'));
}

export function currentMotionPref() {
  return readPref('motion', 'system') === 'reduced' ? 'reduced' : 'system';
}

export function applyMotion(pref) {
  writePref('motion', pref);
  if (pref === 'reduced') document.documentElement.dataset.motion = 'reduced';
  else delete document.documentElement.dataset.motion;
}

export function initTheme() {
  applyTheme(currentThemePref());
  media.addEventListener('change', () => { if (currentThemePref() === 'system') applyTheme('system'); });
  window.addEventListener('storage', (ev) => { if (ev.key === 'gf.theme') applyTheme(currentThemePref()); });
}

// Executado antes da primeira pintura: aplica tema, movimento, densidade e
// estado do menu salvos, evitando "piscar" ao carregar. Arquivo próprio (sem
// script inline) para permitir uma Content Security Policy sem 'unsafe-inline'.
(function () {
  var root = document.documentElement;
  var get = function (k) { try { return localStorage.getItem('gf.' + k); } catch (e) { return null; } };
  var t = get('theme') || 'system';
  var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  if (get('motion') === 'reduced') root.dataset.motion = 'reduced';
  var d = get('density');
  root.dataset.density = d === 'compact' || d === 'comfortable' ? d : 'default';
  if (get('sidebar') === 'collapsed') root.classList.add('sidebar-collapsed');
})();

// Runs in <head> (blocking) so the theme is applied before first paint.
(function () {
  var t = null;
  try { t = localStorage.getItem('theme'); } catch (e) { /* storage unavailable */ }
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = t;
})();

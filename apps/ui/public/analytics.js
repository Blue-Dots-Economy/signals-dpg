/*
 * Config-driven Google Analytics (gtag.js) loader, referenced from index.html
 * and index.tourist.html right after /config.js. Loads gtag.js only when the
 * runtime config (window.__DPG_UI_CONFIG__) sets VITE_ANALYTICS_GA_ID; no
 * measurement id is committed, and without one this script is a no-op.
 * Dependency-free so a cookie-consent gate can later set
 * gtag('consent', 'default', ...) before the config call.
 */
(function () {
  var cfg = window.__DPG_UI_CONFIG__ || {};
  var id = cfg.VITE_ANALYTICS_GA_ID;
  if (!id) return;

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', id);
})();

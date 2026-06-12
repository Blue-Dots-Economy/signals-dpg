/*
 * Config-driven Google Analytics (gtag.js) loader.
 *
 * Served as a static asset and referenced from index.html / index.tourist.html
 * immediately after /config.js. It loads gtag.js ONLY when the deployment's
 * runtime config (window.__DPG_UI_CONFIG__, written by the Helm chart at deploy
 * time) provides a VITE_ANALYTICS_GA_ID. No GA measurement ID is committed to
 * this repo — each deployment opts in purely via its own config.js. On every
 * deployment that does not set the id, this script is a no-op.
 *
 * Kept dependency-free and isolated on purpose: a future cookie-consent gate can
 * be layered in by setting gtag('consent', 'default', ...) before the config
 * call, without touching the rest of the app. See bluedots-automation#12.
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

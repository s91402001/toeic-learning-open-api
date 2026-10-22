// Bootstrap: reveal the app shell, then load the versioned stylesheet and entry module.
// Kept in an external file so the page can run under a strict Content-Security-Policy
// without allowing inline scripts.

(function bootstrapAppAssets() {
  document.documentElement.classList.add('app-booting');
  var cssReady = false;
  var appReady = false;
  var revealed = false;
  var revealTimer = null;

  function revealApp() {
    if (revealed) return;
    revealed = true;
    if (revealTimer) clearTimeout(revealTimer);
    document.documentElement.classList.remove('app-booting');
    var loadingEl = document.getElementById('bootLoading');
    if (loadingEl) loadingEl.remove();
  }

  function checkReady() {
    if (cssReady && appReady) {
      revealApp();
    }
  }

  window.addEventListener('toeic-app-ready', function () {
    appReady = true;
    checkReady();
  }, { once: true });

  revealTimer = setTimeout(revealApp, 5000);

  function mountAssets(version) {
    var suffix = version ? ("?v=" + encodeURIComponent(version)) : "";
    var style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = "./assets/css/styles.css" + suffix;
    style.onload = function () {
      cssReady = true;
      checkReady();
    };
    style.onerror = function () {
      cssReady = true;
      checkReady();
    };
    document.head.appendChild(style);

    var entry = document.createElement('script');
    entry.type = 'module';
    entry.src = "./assets/js/main.js" + suffix;
    entry.onerror = revealApp;
    document.head.appendChild(entry);
  }

  fetch("./version.json?t=" + Date.now())
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      window.__TOEIC_VERSION_INFO__ = data || null;
      mountAssets(data && data.version ? data.version : "");
    })
    .catch(function () {
      window.__TOEIC_VERSION_INFO__ = null;
      mountAssets("");
    });
})();

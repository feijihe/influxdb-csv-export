// Content script (isolated world).
//
// InfluxDB's Data Explorer renders its "CSV" export button only when
// navigator.serviceWorker is available -- and Chrome restricts that API to
// secure contexts. A plain-HTTP origin such as http://192.168.1.50:8086 is
// NOT a secure context, so the built-in button never renders.
//
// This script adds an equivalent button that does not need a service worker.
(function () {
  'use strict';

  var BUTTON_ID = 'influx-csv-export-ext';
  var DEFAULT_TITLE = 'Download query results as a .CSV file (added by extension)';
  var lastQuery = null;

  // Never touch a page that is not InfluxDB: this script is injected broadly,
  // so bail out before doing anything on unrelated sites.
  function isInfluxDB() {
    try {
      var meta = document.querySelector('meta[name="description"]');
      if (meta && /InfluxDB/i.test(meta.getAttribute('content') || '')) return true;
      return /InfluxDB/i.test(document.title || '');
    } catch (e) {
      return false;
    }
  }

  if (!isInfluxDB()) return;

  // Marker so tests / manual checks can confirm the script was injected.
  try {
    document.documentElement.setAttribute('data-influx-csv-ext', '1');
  } catch (e) { /* ignore */ }

  // ---- 1. main-world sniffer -------------------------------------------------
  // Remembers the exact /api/v2/query request the InfluxDB UI just made.
  // This is the same trick InfluxDB's own service worker uses.
  try {
    var s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject.js');
    s.onload = function () { s.remove(); };
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* ignore */ }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || !ev.data.__influxCsvExport) return;
    lastQuery = { url: ev.data.url, body: ev.data.body, at: Date.now() };
  });

  // ---- 2. the export itself --------------------------------------------------
  function saveBlob(text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'query.csv';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 5000);
  }

  // Only ever rewrite the label node. Assigning to btn.textContent would wipe
  // out the icon markup that ensureButton() builds.
  function setLabel(btn, text) {
    var label = btn.querySelector('.cf-button--label');
    if (label) label.textContent = text;
    else btn.textContent = text;
  }

  function exportCsv(btn) {
    if (!lastQuery) {
      setLabel(btn, 'CSV: run a query first');
      setTimeout(function () { setLabel(btn, 'CSV'); }, 2500);
      return;
    }

    var url = lastQuery.url.indexOf('http') === 0
      ? lastQuery.url
      : location.origin + lastQuery.url;

    btn.disabled = true;
    setLabel(btn, 'CSV \u2026');

    // Same-origin request: the session cookie is sent automatically, so an
    // HttpOnly cookie is not a problem.
    fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/csv' },
      body: lastQuery.body
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      saveBlob(text);
      setLabel(btn, 'CSV \u2713');
      setTimeout(function () {
        setLabel(btn, 'CSV');
        btn.disabled = false;
      }, 2000);
    }).catch(function (err) {
      setLabel(btn, 'CSV failed');
      btn.title = String(err);
      setTimeout(function () {
        setLabel(btn, 'CSV');
        btn.title = DEFAULT_TITLE;
        btn.disabled = false;
      }, 3000);
    });
  }

  // ---- 3. put the button where InfluxDB's would be ---------------------------
  function ensureButton() {
    if (document.getElementById(BUTTON_ID)) return;

    // If the built-in button exists we are in a secure context and there is
    // nothing to fix -- leave the page alone.
    if (document.querySelector('[data-testid="csv-download-button"]')) return;

    var bar =
      document.querySelector('[data-testid="time-machine--bottom"] [data-testid="flex-box"]') ||
      document.querySelector('[data-testid="time-machine--bottom"]');
    if (!bar) return;

    const autoRefreshBtn = document.querySelector('.autorefresh-dropdown');
    var btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.innerHTML = '<span><span data-testid="icon" class="cf-icon Download_New cf-button-icon"></span><span class="cf-button--label">CSV</span></span>';
    btn.title = DEFAULT_TITLE;
    btn.setAttribute('data-testid', 'csv-download-button-ext');
    btn.className = 'cf-button cf-button-sm cf-button-default';
    btn.style.cssText = 'margin-left:8px;cursor:pointer;';
    btn.addEventListener('click', function () { exportCsv(btn); });
    bar.insertBefore(btn, autoRefreshBtn);
  }

  var mo = new MutationObserver(function () { ensureButton(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(ensureButton, 1500);
  ensureButton();
})();

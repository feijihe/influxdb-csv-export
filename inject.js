// Runs in the PAGE's main world. Its only job is to remember the exact
// /api/v2/query request the InfluxDB UI just made, and hand it to the
// content script. This mirrors what InfluxDB's own service worker does,
// without needing a service worker (which plain-HTTP origins cannot have).
(function () {
  if (window.__influxCsvExportHooked) return;
  window.__influxCsvExportHooked = true;

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = (typeof input === 'string') ? input : (input && input.url);
      if (url && String(url).indexOf('/api/v2/query') !== -1) {
        var body = null;
        if (init && typeof init.body === 'string') {
          body = init.body;
        } else if (typeof input !== 'string' && input && typeof input.clone === 'function') {
          // Request object: read the body asynchronously and forward it.
          input.clone().text().then(function (t) {
            if (t) {
              window.postMessage({ __influxCsvExport: true, url: String(url), body: t }, '*');
            }
          }).catch(function () {});
          return origFetch.apply(this, arguments);
        }
        if (body) {
          window.postMessage({ __influxCsvExport: true, url: String(url), body: body }, '*');
        }
      }
    } catch (e) { /* never break the page */ }
    return origFetch.apply(this, arguments);
  };

  // Some InfluxDB builds issue the query through XHR instead.
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__influxUrl = u;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (b) {
    try {
      if (this.__influxUrl && String(this.__influxUrl).indexOf('/api/v2/query') !== -1 && typeof b === 'string') {
        window.postMessage({ __influxCsvExport: true, url: String(this.__influxUrl), body: b }, '*');
      }
    } catch (e) { /* ignore */ }
    return origSend.apply(this, arguments);
  };
})();

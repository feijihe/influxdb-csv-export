// Runs in the PAGE's main world. Its only job is to remember the exact
// /api/v2/query request the InfluxDB UI just made, and hand it to the
// content script. This mirrors what InfluxDB's own service worker does,
// without needing a service worker (which plain-HTTP origins cannot have).
//
// Deliberately left in sloppy mode (no 'use strict'): the fetch wrapper
// forwards its own `this` to the original fetch, and strict mode would
// change that binding for unbound `fetch(...)` calls made by the page.
(() => {
  if (window.__influxCsvExportHooked) return;
  window.__influxCsvExportHooked = true;

  const QUERY_PATH = '/api/v2/query';
  const forward = (url, body) =>
    window.postMessage({ __influxCsvExport: true, url: String(url), body }, '*');

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const [input, init] = args;
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (url && String(url).includes(QUERY_PATH)) {
        const body = init && init.body;
        if (typeof body === 'string' && body) {
          forward(url, body);
        } else if (typeof input !== 'string' && input && typeof input.clone === 'function') {
          // Request object: read the body asynchronously and forward it.
          input.clone().text()
            .then((text) => { if (text) forward(url, text); })
            .catch(() => {});
        }
      }
    } catch (e) { /* never break the page */ }
    return origFetch.apply(this, args);
  };

  // Some InfluxDB builds issue the query through XHR instead.
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (...args) {
    const [, url] = args;
    this.__influxUrl = url;
    return origOpen.apply(this, args);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const [body] = args;
    try {
      if (this.__influxUrl && String(this.__influxUrl).includes(QUERY_PATH) && typeof body === 'string') {
        forward(this.__influxUrl, body);
      }
    } catch (e) { /* ignore */ }
    return origSend.apply(this, args);
  };
})();

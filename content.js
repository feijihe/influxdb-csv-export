// Content script (isolated world).
//
// InfluxDB's Data Explorer renders its "CSV" export button only when
// navigator.serviceWorker is available -- and Chrome restricts that API to
// secure contexts. A plain-HTTP origin such as http://192.168.1.50:8086 is
// NOT a secure context, so the built-in button never renders.
//
// This script adds an equivalent button that does not need a service worker.
(() => {
  'use strict';

  const BUTTON_ID = 'influx-csv-export-ext';
  const DEFAULT_TITLE = 'Download query results as a .CSV file (added by extension)';
  const LABEL = 'CSV';

  let lastQuery = null;

  // Never touch a page that is not InfluxDB: this script is injected broadly,
  // so bail out before doing anything on unrelated sites.
  const isInfluxDB = () => {
    try {
      const meta = document.querySelector('meta[name="description"]');
      if (meta && /InfluxDB/i.test(meta.getAttribute('content') || '')) return true;
      return /InfluxDB/i.test(document.title || '');
    } catch (e) {
      return false;
    }
  };

  if (!isInfluxDB()) return;

  // Marker so tests / manual checks can confirm the script was injected.
  try {
    document.documentElement.setAttribute('data-influx-csv-ext', '1');
  } catch (e) { /* ignore */ }

  // ---- 1. main-world sniffer -------------------------------------------------
  // Remembers the exact /api/v2/query request the InfluxDB UI just made.
  // This is the same trick InfluxDB's own service worker uses.
  try {
    const tag = document.createElement('script');
    tag.src = chrome.runtime.getURL('inject.js');
    tag.onload = () => tag.remove();
    (document.head || document.documentElement).appendChild(tag);
  } catch (e) { /* ignore */ }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || !event.data.__influxCsvExport) return;
    const { url, body } = event.data;
    lastQuery = { url, body, at: Date.now() };
  });

  // ---- 2. the export itself --------------------------------------------------
  const saveBlob = (text) => {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = 'query.csv';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      URL.revokeObjectURL(anchor.href);
      anchor.remove();
    }, 5000);
  };

  // Only ever rewrite the label node. Assigning to btn.textContent would wipe
  // out the icon markup that ensureButton() builds.
  const setLabel = (btn, text) => {
    const label = btn.querySelector('.cf-button--label');
    if (label) label.textContent = text;
    else btn.textContent = text;
  };

  const resetButton = (btn, delay) => {
    setTimeout(() => {
      setLabel(btn, LABEL);
      btn.title = DEFAULT_TITLE;
      btn.disabled = false;
    }, delay);
  };

  const exportCsv = (btn) => {
    if (!lastQuery) {
      setLabel(btn, `${LABEL}: run a query first`);
      setTimeout(() => setLabel(btn, LABEL), 2500);
      return;
    }

    const { url: captured, body } = lastQuery;
    const url = captured.startsWith('http') ? captured : location.origin + captured;

    btn.disabled = true;
    setLabel(btn, `${LABEL} \u2026`);

    // Same-origin request: the session cookie is sent automatically, so an
    // HttpOnly cookie is not a problem.
    fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/csv' },
      body,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => {
        saveBlob(text);
        setLabel(btn, `${LABEL} \u2713`);
        resetButton(btn, 2000);
      })
      .catch((err) => {
        setLabel(btn, `${LABEL} failed`);
        btn.title = String(err);
        resetButton(btn, 3000);
      });
  };

  // ---- 3. put the button where InfluxDB's would be ---------------------------
  const ensureButton = () => {
    if (document.getElementById(BUTTON_ID)) return;

    // If the built-in button exists we are in a secure context and there is
    // nothing to fix -- leave the page alone.
    if (document.querySelector('[data-testid="csv-download-button"]')) return;

    const bar =
      document.querySelector('[data-testid="time-machine--bottom"] [data-testid="flex-box"]') ||
      document.querySelector('[data-testid="time-machine--bottom"]');
    if (!bar) return;

    const autoRefreshBtn = document.querySelector('.autorefresh-dropdown');
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.innerHTML =
      '<span><span data-testid="icon" class="cf-icon Download_New cf-button-icon"></span>' +
      `<span class="cf-button--label">${LABEL}</span></span>`;
    btn.title = DEFAULT_TITLE;
    btn.setAttribute('data-testid', 'csv-download-button-ext');
    btn.className = 'cf-button cf-button-sm cf-button-default';
    btn.style.cssText = 'margin-left:8px;cursor:pointer;';
    btn.addEventListener('click', () => exportCsv(btn));
    bar.insertBefore(btn, autoRefreshBtn);
  };

  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(ensureButton, 1500);
  ensureButton();
})();

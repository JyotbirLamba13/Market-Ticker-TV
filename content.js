/**
 * content.js — Market Ticker
 *
 * WHY YAHOO FINANCE INSTEAD OF TRADINGVIEW IFRAMES:
 *   TradingView's embed scripts work by loading a JS file that then
 *   creates a sub-iframe pointing to tradingview.com. Inside a blob iframe
 *   created by a Chrome MV3 content script, that sub-iframe chain is
 *   blocked — TradingView validates the parent origin and Chrome extension
 *   blob:// URLs are rejected. After multiple approaches, direct price
 *   fetching is the only reliable method.
 *
 *   Yahoo Finance v8 chart API: no auth, no crumb, returns real-time
 *   delayed quotes for NSE/BSE symbols. Requires host_permissions in manifest.
 *   Prices refresh every 30 seconds.
 *
 * DRAG FIX:
 *   Shadow host IS the position:fixed element. Dragging updates
 *   host.style.left / host.style.top directly. No pointer-events:none anywhere.
 *
 * DESIGN REFERENCE: Kotak Neo widget (compact price + change + % per symbol).
 */

(function () {
  'use strict';

  if (document.getElementById('mticker-host')) return;

  // ── Storage keys ──────────────────────────────────────────────────────────
  const SK = {
    STATE:  'widgetState',
    X:      'widgetX',
    Y:      'widgetY',
    THEME:  'widgetTheme',
    LIST:   'watchlist',
    PINNED: 'pinnedSymbols',
    PANELS: 'panelToggles',
    HIDDEN: 'widgetHidden',
  };

  const DEFAULTS = {
    state:     'full',
    x:         20,
    y:         80,
    theme:     'dark',
    watchlist: ['NSE:NIFTY', 'BSE:SENSEX', 'NSE:RELIANCE', 'NSE:HDFCBANK', 'NSE:TCS'],
    pinned:    ['NSE:NIFTY', 'BSE:SENSEX'],
    panels:    { indices: true, watchlist: true, sparkline: true },
  };

  let cfg = { ...DEFAULTS, panels: { ...DEFAULTS.panels } };

  // DOM references
  let host = null;      // position:fixed element — shadow host
  let shadow = null;    // shadow root
  let sparkPop = null;  // sparkline popover — lives in main doc, not shadow

  // Drag
  let isDragging = false, drag = {};

  // Data
  let prices = {};      // { 'NSE:NIFTY': { price, change, changePct } }
  let refreshTimer = null;

  // Sparkline
  let sparkBlob = null, activeSym = null;

  const $  = id  => shadow?.getElementById(id);
  const $$ = sel => shadow ? Array.from(shadow.querySelectorAll(sel)) : [];

  // ══════════════════════════════════════════════════════════════════════════
  //  SYMBOL MAPPING  TradingView → Yahoo Finance
  // ══════════════════════════════════════════════════════════════════════════

  const YF_OVERRIDE = {
    'NSE:NIFTY':          '^NSEI',
    'BSE:SENSEX':         '^BSESN',
    'NSE:BANKNIFTY':      '^NSEBANK',
    'NSE:CNXIT':          '^CNXIT',
    'NSE:NIFTYMIDCAP100': '^NSMIDCP',
    'BSE:SENSEX30':       '^BSESN',
  };

  function toYF(tvSym) {
    if (YF_OVERRIDE[tvSym]) return YF_OVERRIDE[tvSym];
    const [exch, sym] = tvSym.split(':');
    if (!sym) return tvSym;
    if (exch === 'NSE') return sym + '.NS';
    if (exch === 'BSE') return sym + '.BO';
    return sym;
  }

  function shortLabel(tvSym) {
    return (tvSym.split(':')[1] || tvSym);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  BOOTSTRAP
  // ══════════════════════════════════════════════════════════════════════════

  chrome.storage.local.get(
    [SK.STATE, SK.X, SK.Y, SK.THEME, SK.LIST, SK.PINNED, SK.PANELS, SK.HIDDEN],
    res => {
      cfg.state     = res[SK.STATE]                      || DEFAULTS.state;
      cfg.x         = typeof res[SK.X] === 'number' ? res[SK.X]  : DEFAULTS.x;
      cfg.y         = typeof res[SK.Y] === 'number' ? res[SK.Y]  : DEFAULTS.y;
      cfg.theme     = res[SK.THEME]                      || DEFAULTS.theme;
      cfg.watchlist = res[SK.LIST]                       || DEFAULTS.watchlist;
      cfg.pinned    = res[SK.PINNED]                     || DEFAULTS.pinned;
      cfg.panels    = res[SK.PANELS]                     || DEFAULTS.panels;
      init();
      if (res[SK.HIDDEN]) hide();
    }
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !shadow) return;
    if (changes[SK.HIDDEN]) { changes[SK.HIDDEN].newValue ? hide() : show(); return; }
    let rerender = false;
    if (changes[SK.STATE])  { cfg.state     = changes[SK.STATE].newValue;  applyState(); }
    if (changes[SK.THEME])  { cfg.theme     = changes[SK.THEME].newValue;  rerender = true; }
    if (changes[SK.LIST])   { cfg.watchlist = changes[SK.LIST].newValue;   scheduleFetch(); rerender = true; }
    if (changes[SK.PINNED]) { cfg.pinned    = changes[SK.PINNED].newValue; rerender = true; }
    if (changes[SK.PANELS]) { cfg.panels    = changes[SK.PANELS].newValue; rerender = true; }
    if (rerender) render();
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════════════════════

  function init() {
    // Shadow HOST = the position:fixed element.
    // This fixes drag (no pointer-events:none) and click interactions.
    host = document.createElement('div');
    host.id = 'mticker-host';
    host.style.cssText =
      'all:unset;' +
      'position:fixed!important;' +
      'z-index:2147483647!important;' +
      `left:${clampX(cfg.x)}px;` +
      `top:${clampY(cfg.y)}px;`;
    document.body.appendChild(host);

    shadow = host.attachShadow({ mode: 'open' });

    const sty = document.createElement('style');
    sty.textContent = CSS;
    shadow.appendChild(sty);

    const root = document.createElement('div');
    root.id = 'mt-root';
    shadow.appendChild(root);

    // Sparkline popover: in main document so position:fixed is viewport-correct
    sparkPop = document.createElement('div');
    sparkPop.id = 'mticker-spark-pop';
    sparkPop.style.cssText =
      'all:unset;position:fixed!important;z-index:2147483646!important;' +
      'border-radius:10px;overflow:hidden;display:none;' +
      'box-shadow:0 16px 48px rgba(0,0,0,0.5);';
    document.body.appendChild(sparkPop);

    setupDrag();

    // Close sparkline on outside click
    document.addEventListener('click', e => {
      if (!activeSym) return;
      const path = e.composedPath?.() || [e.target];
      if (!path.some(n => n === host || n === sparkPop)) closeSpark();
    });

    // Initial render (loading state), then fetch
    render();
    fetchAndRender();
    refreshTimer = setInterval(fetchAndRender, 30000);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PRICE FETCH  (Yahoo Finance v8 chart API — no auth required)
  // ══════════════════════════════════════════════════════════════════════════

  function allSymbols() {
    return [...new Set([...(cfg.pinned || []), ...(cfg.watchlist || [])])];
  }

  async function fetchPrice(tvSym) {
    const yfSym = toYF(tvSym);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=1d&range=1d&includePrePost=false`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const meta = j?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('no meta');
    const price = meta.regularMarketPrice ?? meta.previousClose;
    const prev  = meta.regularMarketPreviousClose ?? meta.chartPreviousClose ?? price;
    const change    = price - prev;
    const changePct = prev ? (change / prev) * 100 : 0;
    return { price, change, changePct };
  }

  async function fetchAndRender() {
    const syms = allSymbols();
    if (!syms.length) return;

    // Fetch all in parallel; failed symbols keep previous data or show –
    const results = await Promise.allSettled(syms.map(s => fetchPrice(s)));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') prices[syms[i]] = r.value;
      // on rejection, keep stale data if available
    });

    render();
  }

  function scheduleFetch() {
    clearInterval(refreshTimer);
    fetchAndRender();
    refreshTimer = setInterval(fetchAndRender, 30000);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  RENDER
  // ══════════════════════════════════════════════════════════════════════════

  function render() {
    const root = $('mt-root');
    if (!root) return;

    root.setAttribute('data-state', cfg.state);
    root.setAttribute('data-theme', cfg.theme);

    const all   = allSymbols();
    const pinned = cfg.pinned?.length ? cfg.pinned : all.slice(0, 4);

    root.innerHTML = `
<div id="mt-icon" title="Expand">${svgChart(20)}</div>
<div id="mt-panel">
  <div id="mt-header">
    <span class="mt-logo">${svgChart(12)} MARKET TICKER</span>
    <span class="mt-ts" id="mt-ts">${timestamp()}</span>
    <div class="mt-ctrls">
      <button class="mt-btn" id="mt-min"  title="Minimise">${svgMinus()}</button>
      <button class="mt-btn" id="mt-close" title="Hide">${svgX()}</button>
    </div>
  </div>
  <div id="mt-full">${renderRows(all)}</div>
  <div id="mt-mini">${renderMini(pinned)}</div>
</div>`;

    // Wire controls (innerHTML wipe removes old listeners)
    $('mt-icon')?.addEventListener('click',  () => { if (cfg.state === 'icon') setState('mini'); });
    $('mt-min')?.addEventListener('click',   () => setState(cfg.state === 'full' ? 'mini' : 'icon'));
    $('mt-close')?.addEventListener('click', () => { chrome.storage.local.set({ [SK.HIDDEN]: true }); hide(); });
    $('mt-header')?.addEventListener('click', e => {
      if (e.target.closest('.mt-btn')) return;
      if (cfg.state === 'mini') setState('full');
    });

    // Row clicks → sparkline
    $$('.p-row, .mn-item').forEach(el => {
      el.addEventListener('click', () => {
        if (cfg.panels?.sparkline !== false) openSpark(el.dataset.sym, el.getBoundingClientRect());
      });
    });

    // Timestamp auto-update
    setInterval(() => { const t = $('mt-ts'); if (t) t.textContent = timestamp(); }, 60000);

    // Update sparkline pop theme
    if (sparkPop) {
      const dk = cfg.theme === 'dark';
      sparkPop.style.background = dk ? '#0d1117' : '#fff';
      sparkPop.style.border     = dk ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.1)';
    }
  }

  function renderRows(syms) {
    if (!syms.length)
      return '<div class="mt-empty">No symbols — add via the extension popup ↗</div>';

    return syms.map(s => {
      const d = prices[s];
      if (!d) return `<div class="p-row skeleton" data-sym="${s}">
        <span class="p-sym">${shortLabel(s)}</span>
        <span class="p-price p-loading">loading…</span>
        <span class="p-pct sub">–</span>
      </div>`;

      const pos   = d.change >= 0;
      const cls   = pos ? 'pos' : 'neg';
      const arrow = pos ? '▲' : '▼';
      const pct   = Math.abs(d.changePct).toFixed(2);
      const abs   = (pos ? '+' : '−') + fmtNum(Math.abs(d.change));

      return `<div class="p-row" data-sym="${s}">
        <span class="p-sym">${shortLabel(s)}</span>
        <span class="p-price">${fmtPrice(d.price)}</span>
        <div class="p-right">
          <span class="p-abs ${cls}">${abs}</span>
          <span class="p-pct ${cls}">${arrow}${pct}%</span>
        </div>
      </div>`;
    }).join('');
  }

  function renderMini(syms) {
    return syms.map(s => {
      const d   = prices[s];
      const lbl = shortLabel(s);
      if (!d) return `<div class="mn-item" data-sym="${s}">
        <span class="mn-sym">${lbl}</span>
        <span class="mn-price sub">…</span>
      </div>`;
      const pos   = d.change >= 0;
      const cls   = pos ? 'pos' : 'neg';
      const arrow = pos ? '▲' : '▼';
      const pct   = Math.abs(d.changePct).toFixed(2);
      return `<div class="mn-item" data-sym="${s}">
        <span class="mn-sym">${lbl}</span>
        <span class="mn-price">${fmtPrice(d.price)}</span>
        <span class="mn-pct ${cls}">${arrow}${pct}%</span>
      </div>`;
    }).join('');
  }

  // ── Formatting ────────────────────────────────────────────────────────────

  function fmtPrice(n) {
    if (n == null) return '–';
    return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  }

  function fmtNum(n) {
    if (n == null) return '–';
    // For small numbers (stock prices < 10000) show 2dp; for large (indices) show 2dp
    return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  }

  function timestamp() {
    return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  STATE
  // ══════════════════════════════════════════════════════════════════════════

  function applyState() {
    const root = $('mt-root');
    if (root) { root.setAttribute('data-state', cfg.state); root.setAttribute('data-theme', cfg.theme); }
  }

  function setState(s) {
    cfg.state = s;
    chrome.storage.local.set({ [SK.STATE]: s });
    applyState();
  }

  function hide() {
    if (host) { host.style.opacity = '0'; host.style.pointerEvents = 'none'; }
    if (sparkPop) sparkPop.style.display = 'none';
  }
  function show() {
    if (host) { host.style.opacity = ''; host.style.pointerEvents = ''; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  DRAG
  // ══════════════════════════════════════════════════════════════════════════

  function setupDrag() {
    // Note: setupDrag is called once at init. The header element is re-created
    // on each render(), so we delegate via the shadow root instead.
    shadow.addEventListener('mousedown', e => {
      const header = e.target.closest('#mt-header');
      if (!header || e.target.closest('.mt-btn')) return;
      isDragging  = true;
      drag.startX = e.clientX;
      drag.startY = e.clientY;
      drag.origX  = parseFloat(host.style.left) || cfg.x;
      drag.origY  = parseFloat(host.style.top)  || cfg.y;
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!isDragging) return;
      host.style.left = clampX(drag.origX + (e.clientX - drag.startX)) + 'px';
      host.style.top  = clampY(drag.origY + (e.clientY - drag.startY)) + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      chrome.storage.local.set({
        [SK.X]: parseFloat(host.style.left) || 0,
        [SK.Y]: parseFloat(host.style.top)  || 0,
      });
    });
  }

  function clampX(x) { return Math.max(0, Math.min(x, window.innerWidth  - (host?.offsetWidth  || 340))); }
  function clampY(y) { return Math.max(0, Math.min(y, window.innerHeight - 36)); }

  // ══════════════════════════════════════════════════════════════════════════
  //  SPARKLINE  (TradingView mini chart — blob iframe, best-effort)
  // ══════════════════════════════════════════════════════════════════════════

  function openSpark(sym, rect) {
    if (!sparkPop) return;
    activeSym = sym;
    if (sparkBlob) URL.revokeObjectURL(sparkBlob);

    const dk  = cfg.theme === 'dark';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:${dk ? '#0d1117' : '#fff'};overflow:hidden}.tradingview-widget-container{width:100%;height:100%}.tradingview-widget-container__widget{width:100%;height:100%}</style>
</head><body>
<div class="tradingview-widget-container">
  <div class="tradingview-widget-container__widget"></div>
  <script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js" async>
  ${JSON.stringify({ symbol: sym, width: 280, height: 160, locale: 'en', dateRange: '1D', colorTheme: cfg.theme, isTransparent: false, autosize: false, largeChartUrl: '' })}
  <\/script>
</div>
</body></html>`;

    sparkBlob = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    sparkPop.innerHTML = `<iframe src="${sparkBlob}" width="280" height="160" frameborder="0" scrolling="no" style="display:block;border:none;"></iframe>`;
    sparkPop.style.background = dk ? '#0d1117' : '#fff';
    sparkPop.style.border     = dk ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.1)';

    let left = rect.left, top = rect.bottom + 6;
    if (left + 284 > window.innerWidth  - 8) left = window.innerWidth  - 292;
    if (top  + 164 > window.innerHeight - 8) top  = rect.top - 170;
    sparkPop.style.left    = Math.max(4, left) + 'px';
    sparkPop.style.top     = Math.max(4, top)  + 'px';
    sparkPop.style.display = 'block';
  }

  function closeSpark() {
    activeSym = null;
    if (sparkPop) sparkPop.style.display = 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CSS — scoped inside shadow root
  // ══════════════════════════════════════════════════════════════════════════

  const CSS = `
:host { display: block; }

#mt-root {
  width: 340px;
  font-family: 'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace;
  font-size: 11px;
  line-height: 1.4;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.15);
}

/* ── Themes ── */
#mt-root[data-theme="dark"] {
  --bg:      #0d1117;
  --hdr:     #161b22;
  --bdr:     rgba(255,255,255,0.08);
  --bdr2:    rgba(255,255,255,0.04);
  --text:    #e6edf3;
  --sub:     #7d8590;
  --pos:     #3fb950;
  --neg:     #f85149;
  --hover:   rgba(255,255,255,0.04);
  --pill:    rgba(255,255,255,0.07);
  --sk:      rgba(255,255,255,0.06);
}
#mt-root[data-theme="light"] {
  --bg:      #ffffff;
  --hdr:     #f6f8fa;
  --bdr:     rgba(0,0,0,0.09);
  --bdr2:    rgba(0,0,0,0.04);
  --text:    #1f2328;
  --sub:     #656d76;
  --pos:     #1a7f37;
  --neg:     #cf222e;
  --hover:   rgba(0,0,0,0.03);
  --pill:    rgba(0,0,0,0.06);
  --sk:      rgba(0,0,0,0.06);
}

/* ── Icon state ── */
#mt-icon {
  display: none;
  align-items: center; justify-content: center;
  width: 42px; height: 42px; border-radius: 50%;
  background: var(--hdr); border: 1px solid var(--bdr);
  color: var(--text); cursor: pointer;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  transition: transform 0.15s ease;
}
#mt-icon:hover { transform: scale(1.08); }
#mt-root[data-state="icon"] #mt-icon  { display: flex; }
#mt-root[data-state="icon"] #mt-panel { display: none;  }

/* ── Panel shell ── */
#mt-panel {
  background: var(--bg);
  border: 1px solid var(--bdr);
  border-radius: 12px;
  overflow: hidden;
}

/* ── Header ── */
#mt-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  min-height: 34px;
  background: var(--hdr);
  border-bottom: 1px solid var(--bdr);
  cursor: grab;
  color: var(--text);
}
#mt-header:active { cursor: grabbing; }

.mt-logo {
  display: flex; align-items: center; gap: 6px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
  opacity: 0.85; white-space: nowrap; flex-shrink: 0;
}
.mt-ts {
  font-size: 9px; color: var(--sub); margin-left: auto;
  opacity: 0.7; white-space: nowrap; flex-shrink: 0;
  font-weight: 500;
}
.mt-ctrls { display: flex; gap: 2px; flex-shrink: 0; }
.mt-btn {
  all: unset;
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 5px;
  cursor: pointer; color: var(--sub);
  transition: color 0.12s, background 0.12s;
}
.mt-btn:hover { color: var(--text); background: var(--pill); }

/* ── Full state: price rows ── */
#mt-full { display: none; }
#mt-root[data-state="full"] #mt-full { display: block; }
#mt-root[data-state="full"] #mt-mini { display: none;  }

.p-row {
  display: flex;
  align-items: center;
  padding: 7px 10px;
  gap: 8px;
  border-bottom: 1px solid var(--bdr2);
  cursor: pointer;
  transition: background 0.12s;
  color: var(--text);
}
.p-row:last-child { border-bottom: none; }
.p-row:hover { background: var(--hover); }

.p-sym {
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.04em;
  min-width: 82px; flex-shrink: 0;
}
.p-price {
  font-size: 12px; font-weight: 600;
  flex: 1; text-align: right;
  letter-spacing: 0.02em; font-variant-numeric: tabular-nums;
}
.p-right {
  display: flex; flex-direction: column;
  align-items: flex-end; min-width: 72px; gap: 1px;
}
.p-abs  { font-size: 9px; opacity: 0.75; font-variant-numeric: tabular-nums; }
.p-pct  { font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }

.p-loading { color: var(--sub); font-size: 10px; font-weight: 400; }
.skeleton .p-price { color: var(--sub); }

.pos { color: var(--pos); }
.neg { color: var(--neg); }
.sub { color: var(--sub); }

.mt-empty {
  padding: 16px 12px; text-align: center;
  color: var(--sub); font-size: 10px; opacity: 0.7;
}

/* ── Mini state ── */
#mt-mini { display: none; }
#mt-root[data-state="mini"] #mt-mini { display: flex; }
#mt-root[data-state="mini"] #mt-full { display: none; }
#mt-root[data-state="mini"] #mt-header {
  border-bottom: none;
  cursor: pointer;
}

#mt-mini {
  overflow-x: auto;
  padding: 5px 8px 7px;
  gap: 2px;
  background: var(--bg);
  scrollbar-width: none;
}
#mt-mini::-webkit-scrollbar { display: none; }

.mn-item {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  padding: 5px 9px; border-radius: 8px;
  cursor: pointer; flex-shrink: 0; gap: 2px;
  transition: background 0.12s;
  min-width: 64px;
}
.mn-item:hover { background: var(--hover); }
.mn-sym   { font-size: 9px; font-weight: 700; letter-spacing: 0.05em; color: var(--sub); }
.mn-price { font-size: 12px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.mn-pct   { font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums; }
`;

  // ── SVG icons ──────────────────────────────────────────────────────────────

  function svgChart(s) {
    return `<svg width="${s}" height="${s}" viewBox="0 0 20 20" fill="none" style="display:block;flex-shrink:0">
<rect x="1.5" y="1.5" width="17" height="17" rx="2.5" stroke="currentColor" stroke-width="1.4"/>
<polyline points="3,14.5 6.5,9.5 9.5,12.5 13.5,7 17,10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;
  }
  function svgMinus() {
    return `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><line x1="2" y1="5.5" x2="9" y2="5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  }
  function svgX() {
    return `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><line x1="2" y1="2" x2="9" y2="9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="9" y1="2" x2="2" y2="9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  }

})();

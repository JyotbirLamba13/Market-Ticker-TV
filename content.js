/**
 * content.js — Market Ticker TradingView Overlay
 *
 * KEY FIXES VS PREVIOUS VERSION:
 *
 * 1. DRAG BROKEN: Shadow host had `pointer-events:none` — this blocks ALL
 *    pointer events from reaching shadow DOM children, regardless of
 *    `pointer-events:auto` on those children. The shadow host IS now the
 *    positioned element (position:fixed; left/top updated on drag).
 *    No more 0×0 sentinel trick.
 *
 * 2. RATES NOT SHOWING: In mini state, the ticker-tape iframe was in #mt-body
 *    which was `display:none`. Mini state only showed symbol pills (no prices).
 *    Now: ticker tape iframe is shown in BOTH full AND mini states.
 *
 * 3. SPARKLINE POP: Lives in the main document (not shadow DOM) so
 *    `position:fixed` is correctly relative to the viewport.
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

  // host = the actual positioned element (position:fixed)
  // shadow = shadow root attached to host
  let host = null, shadow = null;
  let sparkPop = null; // in main document so position:fixed works simply

  let isDragging = false, drag = {};
  let blobUrls = [], sparkBlob = null, activeSym = null;

  const $ = id => shadow && shadow.getElementById(id);

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
    let rebuild = false;
    if (changes[SK.HIDDEN]) { changes[SK.HIDDEN].newValue ? hide() : show(); return; }
    if (changes[SK.STATE])  { cfg.state     = changes[SK.STATE].newValue;  applyState(); }
    if (changes[SK.THEME])  { cfg.theme     = changes[SK.THEME].newValue;  rebuild = true; }
    if (changes[SK.LIST])   { cfg.watchlist = changes[SK.LIST].newValue;   rebuild = true; }
    if (changes[SK.PINNED]) { cfg.pinned    = changes[SK.PINNED].newValue; rebuild = true; }
    if (changes[SK.PANELS]) { cfg.panels    = changes[SK.PANELS].newValue; rebuild = true; }
    if (rebuild) rebuildFrames();
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════════════════════

  function init() {
    // ── Shadow host = positioned element ─────────────────────────────────
    // By making the HOST the fixed element, pointer events reach shadow
    // children naturally. No `pointer-events:none` anywhere on the host.
    host = document.createElement('div');
    host.id = 'mticker-host';
    host.style.cssText =
      'all:unset;' +
      'position:fixed!important;' +
      'z-index:2147483647!important;' +
      `left:${clampX(cfg.x)}px;` +
      `top:${clampY(cfg.y)}px;`;
    document.body.appendChild(host);

    // ── Shadow root ───────────────────────────────────────────────────────
    shadow = host.attachShadow({ mode: 'open' });
    const sty = document.createElement('style');
    sty.textContent = CSS;
    shadow.appendChild(sty);

    const root = document.createElement('div');
    root.id = 'mt-root';
    root.innerHTML = widgetHTML();
    shadow.appendChild(root);

    // ── Sparkline popover — in MAIN document ─────────────────────────────
    // Keeping it outside shadow DOM ensures position:fixed is viewport-relative.
    sparkPop = document.createElement('div');
    sparkPop.id = 'mticker-spark-pop';
    sparkPop.style.cssText =
      'all:unset;' +
      'position:fixed!important;z-index:2147483646!important;' +
      'border-radius:10px;overflow:hidden;display:none;' +
      'box-shadow:0 16px 48px rgba(0,0,0,0.5);';
    document.body.appendChild(sparkPop);

    applyState();
    rebuildFrames();
    setupDrag();
    setupControls();

    // Close sparkline on outside click
    document.addEventListener('click', e => {
      if (!activeSym) return;
      const path = e.composedPath ? e.composedPath() : [e.target];
      if (!path.some(el => el === host || el === sparkPop)) closeSpark();
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TEMPLATE
  // ══════════════════════════════════════════════════════════════════════════

  function widgetHTML() {
    return `
<div id="mt-icon" title="Expand widget">${icChart(20)}</div>
<div id="mt-panel">
  <div id="mt-header">
    <span class="mt-logo">${icChart(12)} MARKET TICKER</span>
    <div class="mt-ctrls">
      <button class="mt-btn" id="mt-min"  title="Minimise">${icMinus()}</button>
      <button class="mt-btn" id="mt-close" title="Hide">${icX()}</button>
    </div>
  </div>
  <!-- FULL state: all symbols -->
  <div id="mt-tape-full" class="mt-tape"></div>
  <!-- MINI state: pinned symbols only (compact, no header content needed) -->
  <div id="mt-tape-mini" class="mt-tape"></div>
</div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  BLOB IFRAME HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Blob iframes have NO CSP (no HTTP response headers on a blob:// URL).
   * TradingView scripts load freely from s3.tradingview.com regardless
   * of the host page's Content-Security-Policy.
   */
  function makeDoc(body) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:transparent;overflow:hidden}.tradingview-widget-container{width:100%;height:100%}.tradingview-widget-container__widget{width:100%;height:100%}</style>
</head><body>${body}</body></html>`;
  }

  function tickerDoc(symbols, theme) {
    const syms = symbols.map(s => ({ proName: s, title: s.split(':')[1] || s }));
    return makeDoc(
      `<div class="tradingview-widget-container">
  <div class="tradingview-widget-container__widget"></div>
  <script type="text/javascript"
    src="https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js" async>
  ${JSON.stringify({
        symbols: syms,
        showSymbolLogo: false,
        colorTheme: theme,
        isTransparent: true,
        displayMode: 'compact',
        locale: 'en',
      })}
  <\/script></div>`
    );
  }

  function chartDoc(symbol, theme) {
    return makeDoc(
      `<div class="tradingview-widget-container">
  <div class="tradingview-widget-container__widget"></div>
  <script type="text/javascript"
    src="https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js" async>
  ${JSON.stringify({
        symbol,
        width: 280,
        height: 160,
        locale: 'en',
        dateRange: '1D',
        colorTheme: theme,
        isTransparent: false,
        autosize: false,
        largeChartUrl: '',
      })}
  <\/script></div>`
    );
  }

  function mkFrame(html, heightPx) {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    blobUrls.push(url);
    const f = document.createElement('iframe');
    f.src = url;
    f.setAttribute('scrolling', 'no');
    f.setAttribute('frameborder', '0');
    f.style.cssText = `width:100%;height:${heightPx}px;border:none;display:block;`;
    return f;
  }

  function purge() { blobUrls.forEach(u => URL.revokeObjectURL(u)); blobUrls = []; }

  // ══════════════════════════════════════════════════════════════════════════
  //  REBUILD FRAMES
  // ══════════════════════════════════════════════════════════════════════════

  function rebuildFrames() {
    purge();

    const root = $('mt-root');
    if (root) root.setAttribute('data-theme', cfg.theme);

    const tapeFull = $('mt-tape-full');
    const tapeMini = $('mt-tape-mini');
    if (!tapeFull || !tapeMini) return;

    // Full: all symbols (pinned first, then rest of watchlist, deduped)
    const allSyms = [...new Set([...(cfg.pinned || []), ...(cfg.watchlist || [])])];
    // Mini: pinned only (or first 4 from watchlist if no pins)
    const miniSyms = cfg.pinned?.length ? cfg.pinned : allSyms.slice(0, 4);

    tapeFull.innerHTML = '';
    tapeMini.innerHTML = '';

    if (allSyms.length) {
      tapeFull.appendChild(mkFrame(tickerDoc(allSyms, cfg.theme), 54));
    }
    if (miniSyms.length) {
      tapeMini.appendChild(mkFrame(tickerDoc(miniSyms, cfg.theme), 46));
    }

    // Update sparkline popover style for theme
    if (sparkPop) {
      const dark = cfg.theme === 'dark';
      sparkPop.style.background = dark ? '#0d1117' : '#ffffff';
      sparkPop.style.border     = dark
        ? '1px solid rgba(255,255,255,0.10)'
        : '1px solid rgba(0,0,0,0.10)';
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  STATE
  // ══════════════════════════════════════════════════════════════════════════

  function applyState() {
    const root = $('mt-root');
    if (!root) return;
    root.setAttribute('data-state', cfg.state);
    root.setAttribute('data-theme', cfg.theme);
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
  //  DRAG — updates host.style.left / host.style.top
  // ══════════════════════════════════════════════════════════════════════════

  function setupDrag() {
    const header = $('mt-header');
    if (!header) return;

    header.addEventListener('mousedown', e => {
      if (e.target.closest('.mt-btn')) return; // don't drag when clicking buttons
      isDragging  = true;
      drag.startX = e.clientX;
      drag.startY = e.clientY;
      drag.origX  = parseFloat(host.style.left) || cfg.x;
      drag.origY  = parseFloat(host.style.top)  || cfg.y;
      e.preventDefault();
    });

    // Listen on document so drag continues even if mouse leaves header
    document.addEventListener('mousemove', e => {
      if (!isDragging) return;
      host.style.left = clampX(drag.origX + (e.clientX - drag.startX)) + 'px';
      host.style.top  = clampY(drag.origY + (e.clientY - drag.startY)) + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      // Persist final position
      chrome.storage.local.set({
        [SK.X]: parseFloat(host.style.left) || 0,
        [SK.Y]: parseFloat(host.style.top)  || 0,
      });
    });
  }

  function clampX(x) {
    return Math.max(0, Math.min(x, window.innerWidth - (host?.offsetWidth || 340)));
  }
  function clampY(y) {
    return Math.max(0, Math.min(y, window.innerHeight - 36));
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONTROLS
  // ══════════════════════════════════════════════════════════════════════════

  function setupControls() {
    // Icon → mini
    $('mt-icon')?.addEventListener('click', () => {
      if (cfg.state === 'icon') setState('mini');
    });

    // Minimise: full → mini → icon
    $('mt-min')?.addEventListener('click', () => {
      setState(cfg.state === 'full' ? 'mini' : 'icon');
    });

    // Close = hide
    $('mt-close')?.addEventListener('click', () => {
      chrome.storage.local.set({ [SK.HIDDEN]: true });
      hide();
    });

    // Click header in mini → expand to full
    // (tape is an iframe, clicks there go to TV; header is always clickable)
    $('mt-header')?.addEventListener('click', e => {
      if (e.target.closest('.mt-btn')) return;
      if (cfg.state === 'mini') setState('full');
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SPARKLINE — triggered externally (e.g., popup can trigger it)
  //  The ticker tape widget handles its own clicks internally (TV iframe).
  //  Sparkline can be opened via extension messages if needed.
  // ══════════════════════════════════════════════════════════════════════════

  function openSpark(sym, rect) {
    if (!cfg.panels?.sparkline || !sparkPop) return;
    activeSym = sym;
    if (sparkBlob) { URL.revokeObjectURL(sparkBlob); }
    const dark = cfg.theme === 'dark';
    sparkBlob = URL.createObjectURL(new Blob([chartDoc(sym, cfg.theme)], { type: 'text/html' }));
    sparkPop.innerHTML = `<iframe src="${sparkBlob}" width="280" height="160" frameborder="0" scrolling="no"></iframe>`;
    sparkPop.style.background = dark ? '#0d1117' : '#ffffff';
    sparkPop.style.border     = dark ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.1)';
    let left = rect.left, top = rect.bottom + 6;
    if (left + 284 > window.innerWidth - 8)  left = window.innerWidth - 292;
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
  //  CSS — injected into shadow root
  //  CSS variables are scoped to shadow DOM. No bleed from host page.
  //  No `all:initial` needed — shadow DOM provides isolation.
  // ══════════════════════════════════════════════════════════════════════════

  const CSS = `
:host {
  display: block;
}

/* ── Root ── */
#mt-root {
  width: 340px;
  font-family: 'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace;
  font-size: 11px;
  line-height: 1.4;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.2);
}

/* ── Dark theme ── */
#mt-root[data-theme="dark"] {
  --bg:    #0d1117;
  --hdr:   #161b22;
  --bdr:   rgba(255,255,255,0.08);
  --text:  #e6edf3;
  --sub:   #7d8590;
  --pill:  rgba(255,255,255,0.07);
  --piho:  rgba(255,255,255,0.12);
}

/* ── Light theme ── */
#mt-root[data-theme="light"] {
  --bg:    #ffffff;
  --hdr:   #f6f8fa;
  --bdr:   rgba(0,0,0,0.09);
  --text:  #1f2328;
  --sub:   #656d76;
  --pill:  rgba(0,0,0,0.06);
  --piho:  rgba(0,0,0,0.11);
}

/* ── Icon state button ── */
#mt-icon {
  display: none;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--hdr);
  border: 1px solid var(--bdr);
  color: var(--text);
  cursor: pointer;
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
  justify-content: space-between;
  padding: 7px 10px;
  min-height: 34px;
  background: var(--hdr);
  border-bottom: 1px solid var(--bdr);
  cursor: grab;
  color: var(--text);
  transition: background 0.15s;
}
#mt-header:active { cursor: grabbing; }

.mt-logo {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  opacity: 0.85;
  white-space: nowrap;
}

.mt-ctrls {
  display: flex;
  align-items: center;
  gap: 2px;
}

.mt-btn {
  all: unset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  cursor: pointer;
  color: var(--sub);
  transition: color 0.12s, background 0.12s;
}
.mt-btn:hover { color: var(--text); background: var(--pill); }

/* ── Ticker tape containers ── */
.mt-tape {
  overflow: hidden;
  background: var(--bg);
}
.mt-tape iframe {
  width: 100%;
  border: none;
  display: block;
}

/* ── State visibility ── */

/* FULL: show full tape, hide mini tape */
#mt-root[data-state="full"] #mt-tape-full { display: block; }
#mt-root[data-state="full"] #mt-tape-mini { display: none;  }

/* MINI: show mini tape, hide full tape. Header border removed (tape is directly below). */
#mt-root[data-state="mini"] #mt-tape-full { display: none;  }
#mt-root[data-state="mini"] #mt-tape-mini { display: block; }
#mt-root[data-state="mini"] #mt-header    { border-bottom: none; cursor: pointer; }
`;

  // ── SVG icons ──────────────────────────────────────────────────────────────
  function icChart(s) {
    return `<svg width="${s}" height="${s}" viewBox="0 0 20 20" fill="none" style="display:block;flex-shrink:0">
<rect x="1.5" y="1.5" width="17" height="17" rx="2.5" stroke="currentColor" stroke-width="1.4"/>
<polyline points="3,14.5 6.5,9.5 9.5,12.5 13.5,7 17,10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;
  }
  function icMinus() {
    return `<svg width="11" height="11" viewBox="0 0 11 11" fill="none">
<line x1="2" y1="5.5" x2="9" y2="5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;
  }
  function icX() {
    return `<svg width="11" height="11" viewBox="0 0 11 11" fill="none">
<line x1="2" y1="2" x2="9" y2="9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
<line x1="9" y1="2" x2="2" y2="9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;
  }

})();

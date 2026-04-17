'use strict';

const SK = {
  THEME:  'widgetTheme',
  LIST:   'watchlist',
  PINNED: 'pinnedSymbols',
  PANELS: 'panelToggles',
  HIDDEN: 'widgetHidden',
};

const DEFAULTS = {
  theme:     'dark',
  watchlist: ['NSE:NIFTY', 'BSE:SENSEX', 'NSE:RELIANCE', 'NSE:HDFCBANK', 'NSE:TCS'],
  pinned:    ['NSE:NIFTY', 'BSE:SENSEX'],
  panels:    { indices: true, watchlist: true, sparkline: true },
};

// ── Curated NSE/BSE symbol catalog ───────────────────────────────────────────
// Only TradingView-valid symbols. Users pick from here — no free text.
const CATALOG = {
  'Indices':  ['NSE:NIFTY', 'BSE:SENSEX', 'NSE:BANKNIFTY', 'NSE:CNXIT', 'NSE:NIFTYMIDCAP100'],
  'Banking':  ['NSE:HDFCBANK', 'NSE:ICICIBANK', 'NSE:KOTAKBANK', 'NSE:SBIN', 'NSE:AXISBANK', 'NSE:INDUSINDBK', 'NSE:BANDHANBNK', 'NSE:FEDERALBNK'],
  'IT':       ['NSE:TCS', 'NSE:INFY', 'NSE:WIPRO', 'NSE:HCLTECH', 'NSE:TECHM', 'NSE:LTIM', 'NSE:MPHASIS', 'NSE:PERSISTENT'],
  'Energy':   ['NSE:RELIANCE', 'NSE:ONGC', 'NSE:BPCL', 'NSE:IOC', 'NSE:HINDPETRO', 'NSE:GAIL', 'NSE:ADANIGREEN'],
  'Finance':  ['NSE:BAJFINANCE', 'NSE:BAJAJFINSV', 'NSE:SBILIFE', 'NSE:HDFCLIFE', 'NSE:ICICIGI', 'NSE:MUTHOOTFIN'],
  'Auto':     ['NSE:MARUTI', 'NSE:TATAMOTORS', 'NSE:M_M', 'NSE:BAJAJ-AUTO', 'NSE:HEROMOTOCO', 'NSE:EICHERMOT', 'NSE:TVSMOTOR'],
  'Consumer': ['NSE:HINDUNILVR', 'NSE:ITC', 'NSE:NESTLEIND', 'NSE:BRITANNIA', 'NSE:DABUR', 'NSE:MARICO', 'NSE:COLPAL'],
  'Metals':   ['NSE:TATASTEEL', 'NSE:JSWSTEEL', 'NSE:HINDALCO', 'NSE:VEDL', 'NSE:COALINDIA', 'NSE:SAIL', 'NSE:NMDC'],
  'Infra':    ['NSE:LT', 'NSE:ULTRACEMCO', 'NSE:ADANIPORTS', 'NSE:POWERGRID', 'NSE:NTPC', 'NSE:TATAPOWER'],
  'Pharma':   ['NSE:SUNPHARMA', 'NSE:DRREDDY', 'NSE:CIPLA', 'NSE:DIVISLAB', 'NSE:APOLLOHOSP', 'NSE:BIOCON'],
  'Retail':   ['NSE:DMART', 'NSE:TRENT', 'NSE:NYKAA', 'NSE:ZOMATO', 'NSE:PAYTM', 'NSE:IRCTC'],
};

// Short display label from a full symbol string
function label(sym) { return sym.split(':')[1] || sym; }

// ── State ─────────────────────────────────────────────────────────────────────
let st = {
  theme:     DEFAULTS.theme,
  watchlist: [],
  pinned:    [],
  panels:    { ...DEFAULTS.panels },
  hidden:    false,
};

let activeSector = Object.keys(CATALOG)[0];
let searchQuery  = '';

// ── Load ──────────────────────────────────────────────────────────────────────
chrome.storage.local.get(
  [SK.THEME, SK.LIST, SK.PINNED, SK.PANELS, SK.HIDDEN],
  res => {
    st.theme     = res[SK.THEME]  || DEFAULTS.theme;
    st.watchlist = res[SK.LIST]   || DEFAULTS.watchlist;
    st.pinned    = res[SK.PINNED] || DEFAULTS.pinned;
    st.panels    = res[SK.PANELS] || DEFAULTS.panels;
    st.hidden    = !!res[SK.HIDDEN];
    render();
  }
);

// ── Render all ────────────────────────────────────────────────────────────────
function render() {
  renderTheme();
  renderToggles();
  renderActiveList();
  renderSectorTabs();
  renderSymGrid();
  renderVisibilityBtn();
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function renderTheme() {
  document.querySelectorAll('.theme-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.theme === st.theme)
  );
}
document.querySelectorAll('.theme-btn').forEach(b => {
  b.addEventListener('click', () => {
    st.theme = b.dataset.theme;
    chrome.storage.local.set({ [SK.THEME]: st.theme });
    renderTheme();
  });
});

// ── Visibility ────────────────────────────────────────────────────────────────
function renderVisibilityBtn() {
  const btn = document.getElementById('btn-visibility');
  if (!btn) return;
  btn.textContent = st.hidden ? '▶ Show Widget' : '✕ Hide Widget';
  btn.classList.toggle('is-showing', st.hidden);
}
document.getElementById('btn-visibility')?.addEventListener('click', () => {
  st.hidden = !st.hidden;
  chrome.storage.local.set({ [SK.HIDDEN]: st.hidden });
  renderVisibilityBtn();
});

// ── Panel toggles ─────────────────────────────────────────────────────────────
function renderToggles() {
  const set = (id, val) => { const e = document.getElementById(id); if (e) e.checked = !!val; };
  set('tog-indices',  st.panels.indices  !== false);
  set('tog-watchlist',st.panels.watchlist!== false);
  set('tog-sparkline',st.panels.sparkline!== false);
}
['indices', 'watchlist', 'sparkline'].forEach(k => {
  document.getElementById(`tog-${k}`)?.addEventListener('change', e => {
    st.panels = { ...st.panels, [k]: e.target.checked };
    chrome.storage.local.set({ [SK.PANELS]: st.panels });
  });
});

// ── Active watchlist ─────────────────────────────────────────────────────────
function renderActiveList() {
  const el = document.getElementById('active-list');
  const ct = document.getElementById('watchlist-count');
  if (!el) return;
  if (ct) ct.textContent = `${st.watchlist.length} symbol${st.watchlist.length !== 1 ? 's' : ''}`;

  if (!st.watchlist.length) {
    el.innerHTML = '<div class="empty-msg">No symbols yet — pick from the browser below ↓</div>';
    return;
  }

  el.innerHTML = st.watchlist.map(s => {
    const isPinned = st.pinned.includes(s);
    return `<div class="active-item${isPinned ? ' is-pinned' : ''}">
      <span class="ai-sym">${label(s)}</span>
      <div class="ai-actions">
        <button class="ai-pin${isPinned ? ' pinned' : ''}" data-sym="${s}" title="${isPinned ? 'Unpin' : 'Pin (shown in mini/icon state)'}">${isPinned ? '📌' : '○'}</button>
        <button class="ai-del" data-sym="${s}" title="Remove">×</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.ai-pin').forEach(b => b.addEventListener('click', () => togglePin(b.dataset.sym)));
  el.querySelectorAll('.ai-del').forEach(b => b.addEventListener('click', () => removeSymbol(b.dataset.sym)));
}

function togglePin(sym) {
  if (st.pinned.includes(sym)) {
    st.pinned = st.pinned.filter(s => s !== sym);
  } else {
    if (st.pinned.length >= 4) st.pinned = st.pinned.slice(1); // evict oldest
    st.pinned = [...st.pinned, sym];
  }
  chrome.storage.local.set({ [SK.PINNED]: st.pinned });
  renderActiveList();
}

function removeSymbol(sym) {
  st.watchlist = st.watchlist.filter(s => s !== sym);
  st.pinned    = st.pinned.filter(s => s !== sym);
  chrome.storage.local.set({ [SK.LIST]: st.watchlist, [SK.PINNED]: st.pinned });
  renderActiveList();
  renderSymGrid(); // refresh add buttons
}

// ── Sector tabs ───────────────────────────────────────────────────────────────
function renderSectorTabs() {
  const el = document.getElementById('sector-tabs');
  if (!el) return;
  el.innerHTML = Object.keys(CATALOG).map(s =>
    `<button class="sector-tab${s === activeSector ? ' active' : ''}" data-sector="${s}">${s}</button>`
  ).join('');
  el.querySelectorAll('.sector-tab').forEach(b => {
    b.addEventListener('click', () => {
      activeSector = b.dataset.sector;
      renderSectorTabs();
      renderSymGrid();
    });
  });
}

// ── Symbol grid ───────────────────────────────────────────────────────────────
function renderSymGrid() {
  const el = document.getElementById('sym-grid');
  if (!el) return;

  // Which symbols to show: search overrides sector
  let symbols;
  if (searchQuery) {
    symbols = Object.values(CATALOG).flat().filter(s =>
      s.toLowerCase().includes(searchQuery) || label(s).toLowerCase().includes(searchQuery)
    );
    // dedupe
    symbols = [...new Set(symbols)];
  } else {
    symbols = CATALOG[activeSector] || [];
  }

  if (!symbols.length) {
    el.innerHTML = '<div class="empty-msg">No matches</div>';
    return;
  }

  el.innerHTML = symbols.map(s => {
    const inList = st.watchlist.includes(s);
    return `<button class="sym-chip${inList ? ' in-list' : ''}" data-sym="${s}" title="${s}">
      <span>${label(s)}</span>
      <span class="chip-icon">${inList ? '✓' : '+'}</span>
    </button>`;
  }).join('');

  el.querySelectorAll('.sym-chip').forEach(b => {
    b.addEventListener('click', () => {
      const sym = b.dataset.sym;
      if (st.watchlist.includes(sym)) {
        removeSymbol(sym);
      } else {
        addSymbol(sym);
      }
    });
  });
}

function addSymbol(sym) {
  if (st.watchlist.includes(sym)) return;
  st.watchlist = [...st.watchlist, sym];
  chrome.storage.local.set({ [SK.LIST]: st.watchlist });
  renderActiveList();
  renderSymGrid();
}

// ── Search filter ─────────────────────────────────────────────────────────────
document.getElementById('sym-search')?.addEventListener('input', e => {
  searchQuery = e.target.value.trim().toLowerCase();
  // When searching, deactivate sector filter visually
  renderSectorTabs();
  renderSymGrid();
});

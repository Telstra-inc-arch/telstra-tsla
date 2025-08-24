/* app.js — Telstra Inc (LIVE FX + Geo detect + CMS + robust fallbacks)
   - Uses exchangerate.host for live FX (no API key required)
     Docs: https://exchangerate.host/ (used in code)
   - Uses ipapi.co for IP geolocation (https://ipapi.co/json/)
   - Caches FX in localStorage with expiry
   - Keeps offline fallback/static rates
   - Updates all .price elements, finance & lease calc
*/

(() => {
  const $ = (sel, r = document) => r.querySelector(sel);
  const $$ = (sel, r = document) => Array.from((r || document).querySelectorAll(sel));

  /* -------------------------
     Static fallback FX (in case API fails)
  ------------------------- */
  const STATIC_FX = {
    USD: 1,
    EUR: 0.92,
    GBP: 0.78,
    AUD: 1.48,
    NGN: 1560,
    INR: 83.2,
    CAD: 1.34,
    JPY: 156
  };

  const CURRENCY_FMT = {
    USD: { style: 'currency', currency: 'USD', minimumFractionDigits: 0 },
    EUR: { style: 'currency', currency: 'EUR', minimumFractionDigits: 0 },
    GBP: { style: 'currency', currency: 'GBP', minimumFractionDigits: 0 },
    AUD: { style: 'currency', currency: 'AUD', minimumFractionDigits: 0 },
    NGN: { style: 'currency', currency: 'NGN', minimumFractionDigits: 0 },
    INR: { style: 'currency', currency: 'INR', minimumFractionDigits: 0 },
    CAD: { style: 'currency', currency: 'CAD', minimumFractionDigits: 0 },
    JPY: { style: 'currency', currency: 'JPY', minimumFractionDigits: 0 }
  };

  // Storage keys + TTLs
  const FX_CACHE_KEY = 'telstra_fx_cache_v1';
  const FX_CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

  /* -------------------------
     Utility: store + load FX cache
  ------------------------- */
  function saveFxCache(rates) {
    const payload = { ts: Date.now(), rates };
    try { localStorage.setItem(FX_CACHE_KEY, JSON.stringify(payload)); } catch (e) { /* ignore */ }
  }

  function loadFxCache() {
    try {
      const raw = localStorage.getItem(FX_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed.ts || !parsed.rates) return null;
      if (Date.now() - parsed.ts > FX_CACHE_TTL_MS) return null;
      return parsed.rates;
    } catch (e) { return null; }
  }

  /* -------------------------
     Fetch live FX from exchangerate.host
     Endpoint used: https://api.exchangerate.host/latest?base=USD&symbols=EUR,GBP,AUD,NGN,INR,CAD,JPY
     (Docs: https://exchangerate.host/documentation) 2
  ------------------------- */
  async function fetchLiveFx() {
    const symbols = ['EUR','GBP','AUD','NGN','INR','CAD','JPY'].join(',');
    const endpoint = `https://api.exchangerate.host/latest?base=USD&symbols=${symbols}`;
    try {
      const resp = await fetch(endpoint, { cache: 'no-cache' });
      if (!resp.ok) throw new Error('FX fetch failed');
      const json = await resp.json();
      if (!json || !json.rates) throw new Error('Malformed FX response');
      const rates = { USD: 1, ...json.rates };
      saveFxCache(rates);
      return rates;
    } catch (err) {
      console.warn('Live FX fetch failed, falling back to cache/static rates', err);
      return null;
    }
  }

  /* -------------------------
     Geo detect with ipapi.co
     Endpoint: https://ipapi.co/json/  (no key, free tier; see docs). 3
  ------------------------- */
  async function detectRegion() {
    try {
      const resp = await fetch('https://ipapi.co/json/', { cache: 'no-cache' });
      if (!resp.ok) throw new Error('Geo lookup failed');
      const j = await resp.json();
      // j has country, country_code, currency, etc.
      return j; // caller will use j.currency or j.country
    } catch (err) {
      console.warn('Geo detect failed, defaulting to US', err);
      return null;
    }
  }

  /* -------------------------
     Currency selection + UI
  ------------------------- */
  const currencySwitch = $('#currencySwitch');
  let FX = loadFxCache() || STATIC_FX; // start from cache or static

  // Async refresh FX in the background (immediate, but non-blocking)
  (async () => {
    const live = await fetchLiveFx();
    if (live) FX = live;
  })();

  // Determine default currency: localStorage -> IP geo -> browser -> USD
  async function determineDefaultCurrency() {
    const stored = localStorage.getItem('currency');
    if (stored) return stored;
    // try IP geolocation
    const geo = await detectRegion();
    if (geo && geo.currency) {
      // ipapi returns currency code like "USD","EUR"
      return geo.currency.toUpperCase();
    }
    // browser locale
    const lang = navigator.language || navigator.languages?.[0] || '';
    if (lang.includes('-US') || lang.startsWith('en-US')) return 'USD';
    // fallback
    return 'USD';
  }

  // Format numbers to currency
  function currencyFormat(amount, code) {
    const fmt = CURRENCY_FMT[code] || CURRENCY_FMT.USD;
    // for very small values (per-watt) allow 2 decimals by caller
    return new Intl.NumberFormat(undefined, fmt).format(amount);
  }

  // Update all .price elements
  function updatePrices(cur) {
    // ensure we have FX map keys
    const fxRate = (FX && FX[cur]) ? FX[cur] : (STATIC_FX[cur] || 1);
    $$('.price').forEach(el => {
      // read price in USD from data attribute; allow decimals for unit rates
      const raw = el.getAttribute('data-price-usd');
      // some elements may use dataset names like data-price-usd="2.2"
      let usd = raw !== null ? Number(raw) : NaN;
      if (Number.isNaN(usd)) {
        // fallback: try parse displayed numeric
        usd = Number((el.textContent || '').replace(/[^0-9.]/g, '')) || 0;
      }
      const billing = el.dataset.billing || '';
      const unit = el.dataset.unit || '';
      let val = usd * fxRate;
      // formatting rules
      if (unit === 'per-watt') {
        el.textContent = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, minimumFractionDigits: 2 }).format(val);
      } else if (unit === 'per-sqft') {
        el.textContent = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, minimumFractionDigits: 0 }).format(val);
      } else {
        // show no decimals for large numbers, decimals for small amounts
        const small = usd < 100 && !billing;
        el.textContent = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, minimumFractionDigits: small ? 2 : 0 }).format(val) + (billing ? ` ${billing}` : '');
      }
    });
  }

  // Set currency state in UI & localStorage
  async function setCurrency(code) {
    const cur = (code && code in (FX || STATIC_FX)) ? code : 'USD';
    localStorage.setItem('currency', cur);
    $$('.currency-switch button').forEach(b => {
      const isActive = b.dataset.cur === cur;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', String(isActive));
    });
    updatePrices(cur);
    updateCalcResults();
  }

  // Hooks
  currencySwitch?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cur]');
    if (!btn) return;
    setCurrency(btn.dataset.cur);
  });

  /* -------------------------
     Finance & Lease Calculator (currency-aware)
  ------------------------- */
  const calcVehicle = $('#calc-vehicle');
  const calcMsrp = $('#calc-msrp');
  const calcDown = $('#calc-down');
  const calcTrade = $('#calc-trade');
  const calcTerm = $('#calc-term');
  const calcAPR = $('#calc-apr');

  const leaseResidual = $('#lease-res');
  const leaseMF = $('#lease-mf');
  const leaseTerm = $('#lease-term');
  const leaseDriveoff = $('#lease-driveoff');

  const btnCalc = $('#calc-run');
  const btnReset = $('#calc-reset');

  const resLoan = $('#res-loan');
  const resFin = $('#res-fin');
  const resTotal = $('#res-total');
  const resLease = $('#res-lease');
  const resDriveoff = $('#res-driveoff');
  const resResidual = $('#res-residual');

  calcVehicle?.addEventListener('change', () => {
    const v = Number(calcVehicle.value || calcVehicle.selectedOptions[0].value);
    calcMsrp.value = v;
  });

  // Finance math (USD internal)
  function calcFinanceUSD() {
    const msrp = Number(calcMsrp.value || calcVehicle.value || 0);
    const down = Number(calcDown.value || 0);
    const trade = Number(calcTrade.value || 0);
    const term = Math.max(1, Number(calcTerm.value || 1));
    const apr = Math.max(0, Number(calcAPR.value || 0)) / 100;
    const principal = Math.max(0, msrp - down - trade);
    const monthlyRate = apr / 12;
    const monthlyPayment = monthlyRate === 0
      ? principal / term
      : (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -term));
    const totalCost = monthlyPayment * term + down + trade;
    return { principal, monthlyPayment, totalCost };
  }

  function calcLeaseUSD() {
    const msrp = Number(calcMsrp.value || calcVehicle.value || 0);
    const residualPct = Math.min(100, Math.max(0, Number(leaseResidual.value || 0)));
    const mf = Number(leaseMF.value || 0);
    const term = Math.max(1, Number(leaseTerm.value || 1));
    const residualUSD = msrp * (residualPct / 100);
    const capCostUSD = msrp; // demo: no incentives
    const depreciation = (capCostUSD - residualUSD) / term;
    const rentCharge = (capCostUSD + residualUSD) * mf;
    const monthly = depreciation + rentCharge;
    const dueAtSigning = Number(leaseDriveoff.value || 0) + monthly; // simplified
    return { residualUSD, monthly, dueAtSigning };
  }

  function updateCalcResults() {
    const fin = calcFinanceUSD();
    const lease = calcLeaseUSD();
    const cur = localStorage.getItem('currency') || 'USD';
    const fx = FX[cur] || STATIC_FX[cur] || 1;
    // show formatted values converted to cur
    resLoan.textContent = currencyFormat(fin.principal * fx, cur);
    resFin.textContent = currencyFormat(fin.monthlyPayment * fx, cur);
    resTotal.textContent = currencyFormat(fin.totalCost * fx, cur);
    resLease.textContent = currencyFormat(lease.monthly * fx, cur);
    resDriveoff.textContent = currencyFormat(lease.dueAtSigning * fx, cur);
    resResidual.textContent = currencyFormat(lease.residualUSD * fx, cur);
  }

  btnCalc?.addEventListener('click', updateCalcResults);

  btnReset?.addEventListener('click', () => {
    calcVehicle.value = calcVehicle.querySelector('option').value;
    calcMsrp.value = calcVehicle.value;
    calcDown.value = 5000;
    calcTrade.value = 0;
    calcTerm.value = 72;
    calcAPR.value = 4.5;
    leaseResidual.value = 58;
    leaseMF.value = 0.0025;
    leaseTerm.value = 36;
    leaseDriveoff.value = 1500;
    updateCalcResults();
  });

  /* -------------------------
     Trip planner demo
  ------------------------- */
  $('#tripForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const start = $('#trip-start').value.trim();
    const end = $('#trip-end').value.trim();
    const range = Number($('#trip-vehicle').selectedOptions[0].dataset.range || 250);
    if (!start || !end) return $('#tripResult').textContent = 'Enter both start and destination.';
    const distance = 380;
    const stops = Math.max(0, Math.ceil(distance / range) - 1);
    $('#tripResult').textContent = `Estimated distance: ~${distance} miles. Recommended supercharging stops: ${stops}.`;
  });

  /* -------------------------
     Forms
  ------------------------- */
  $('#contactForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#c-name').value.trim();
    const email = $('#c-email').value.trim();
    const topic = $('#c-topic').value;
    const msg = $('#c-msg').value.trim();
    const status = $('#contactForm .form-status');
    if (name.length < 2) return status.textContent = 'Please enter your name.';
    if (!/\S+@\S+\.\S+/.test(email)) return status.textContent = 'Please use a valid email.';
    if (!topic) return status.textContent = 'Select a topic.';
    if (msg.length < 20) return status.textContent = 'Please provide more detail.';
    status.textContent = 'Sending…';
    setTimeout(() => status.textContent = 'Thanks! We’ll respond within two business days.', 900);
    e.target.reset();
  });

  $('#newsletter')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = $('#news-email').value.trim();
    const err = $('#newsletter .error'); const status = $('#newsletter .form-status');
    if (!/\S+@\S+\.\S+/.test(email)) { err.textContent = 'That email looks off.'; return; }
    err.textContent = ''; status.textContent = 'Subscribed. No spam.';
    e.target.reset();
  });

  // footer year
  $('#year').textContent = new Date().getFullYear();

  /* -------------------------
     Initialize: detect region, set currency, update prices
  ------------------------- */
  (async () => {
    // 1) try cached FX first (already loaded above)
    const cached = loadFxCache();
    if (cached) FX = cached;

    // 2) attempt live FX fetch (async)
    const live = await fetchLiveFx();
    if (live) FX = live;

    // 3) determine default currency (IP -> browser -> USD)
    const cur = await determineDefaultCurrency();
    await setCurrency(cur);

    // final: ensure UI prices show current currency
    updatePrices(cur);
    updateCalcResults();
  })();

  /* -------------------------
     HEADLESS CMS STUB (Contentful / Strapi examples)
     - These are *examples* showing how to fetch content to render product lists,
       inventory, blog posts. Replace with real API keys & endpoints.
  ------------------------- */

  // Contentful example (fetch published entries)
  async function fetchContentfulEntries(spaceId, accessToken, contentType) {
    if (!spaceId || !accessToken) return null;
    const url = `https://cdn.contentful.com/spaces/${spaceId}/entries?access_token=${accessToken}&content_type=${contentType}&limit=50`;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('Contentful fetch failed');
      const json = await r.json();
      return json;
    } catch (err) {
      console.warn('Contentful fetch failed', err);
      return null;
    }
  }

  // Strapi example (public collection)
  async function fetchStrapiCollection(baseUrl, collection) {
    if (!baseUrl || !collection) return null;
    try {
      const r = await fetch(`${baseUrl}/api/${collection}?populate=*`);
      if (!r.ok) throw new Error('Strapi fetch failed');
      return await r.json();
    } catch (err) {
      console.warn('Strapi fetch failed', err);
      return null;
    }
  }

  // Example usage (uncomment and provide keys/URLs in production):
  // fetchContentfulEntries('YOUR_SPACE_ID', 'YOUR_CDA_TOKEN', 'vehicle')
  //   .then(data => console.log('vehicles from CMS', data));

  // fetchStrapiCollection('https://cms.example.com', 'vehicles')
  //   .then(data => console.log('vehicles from Strapi', data));

  /* -------------------------
     Small helper: public API availability check
  ------------------------- */
  async function isEndpointReachable(url) {
    try {
      const r = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
      return r.ok;
    } catch {
      return false;
    }
  }

  // Expose some internals on window for debugging (dev only)
  if (typeof window !== 'undefined') {
    window.TelstraInc = {
      getFX: () => FX,
      refreshFX: async () => { const l = await fetchLiveFx(); if (l) { FX = l; setCurrency(localStorage.getItem('currency') || 'USD'); } return FX; },
      detectRegion
    };
  }

})();

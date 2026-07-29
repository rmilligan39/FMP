const https = require('https');
const { Pool } = require('pg');

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */
const FMP_KEY       = process.env.FMP_API_KEY       || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

/* ═══════════════════════════════════════════════════════════════════════════
   FMP HTTP HELPER
   ═══════════════════════════════════════════════════════════════════════════ */
function fmpGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://financialmodelingprep.com${path}${sep}apikey=${FMP_KEY}`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TFG-Research/4.0' } }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        // Handle HTTP errors — resolve with empty array/object so Promise.all doesn't abort
        if (res.statusCode >= 400) {
          console.error(`[FMP] HTTP ${res.statusCode} on ${path}: ${body.slice(0,150)}`);
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(body);
          // FMP sometimes returns {"Error Message":"..."} on valid 200 responses
          if (parsed && parsed['Error Message']) {
            console.error(`[FMP] API error on ${path}: ${parsed['Error Message']}`);
            resolve([]);
            return;
          }
          resolve(parsed);
        }
        catch (e) { reject(new Error(`FMP parse error on ${path}: ${body.slice(0,200)}`)); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   ANTHROPIC HTTP HELPER
   ═══════════════════════════════════════════════════════════════════════════ */
function anthropicPost(payload) {
  return new Promise((resolve, reject) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { reject(new Error(`Anthropic parse error: ${body.slice(0,300)}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   FETCH ALL DATA FROM FMP
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Resolve a raw user query (ticker OR company name) to a confirmed FMP ticker symbol.
 * Never guesses on ambiguous or fuzzy-matched input — returns candidates for the caller
 * to surface instead.
 *
 * RESOLVED only ever comes from an exact, literal ticker match (the fast path below).
 * Any result reached via name search — even a single candidate — comes back as
 * NEEDS_SELECTION, because a name search's relevance ranking is not something this app
 * verifies or controls, and "only one result" does not mean "the right result" (see the
 * Ford Motor Co. / Forward Industries incident this was written in response to).
 *
 * Returns one of:
 *   { status: 'RESOLVED',        ticker }
 *   { status: 'NEEDS_SELECTION', candidates: [{ symbol, name, exchange, currency }, ...] }
 *   { status: 'NOT_FOUND' }
 *
 * NOTE: the /stable/search-name path below has not been verified against a live FMP
 * response from this environment — confirm the endpoint name and response field names
 * (symbol/name/exchangeShortName/currency) against a real call before relying on this
 * in production, the same way /stable/quote vs /stable/batch-quote-short was verified.
 * The Ford incident is itself evidence this endpoint's result quality needs a closer look —
 * a search for "Ford" that doesn't surface Ford Motor Company at all is worth investigating
 * directly (try /stable/search-name?query=Ford&apikey=... and see what actually comes back).
 */
async function resolveTickerSymbol(rawQuery) {
  const raw = rawQuery.trim();
  const asTicker = raw.toUpperCase();

  // Run the literal-ticker lookup, its live quote, and the name search together.
  // The quote check is the fix for a regression the previous version introduced: it used
  // to require the fast-path symbol to also show up in a company-NAME search, but a ticker
  // string like "F" or "AAPL" isn't a company name and won't reliably appear there — that
  // broke resubmission of an already-confirmed, correct ticker after picking it from the
  // picker (every pick just produced another picker). A live quote is a direct, meaningful
  // check for "is this genuinely a real, currently-traded security" instead.
  const [directArr, quoteArr, searchResults] = await Promise.all([
    fmpGet(`/stable/profile?symbol=${encodeURIComponent(asTicker)}`),
    fmpGet(`/stable/batch-quote-short?symbols=${encodeURIComponent(asTicker)}`),
    fmpGet(`/stable/search-name?query=${encodeURIComponent(raw)}&limit=8`),
  ]);

  const direct = (Array.isArray(directArr) ? directArr[0] : directArr) || {};
  const directSymbol = (direct.symbol || '').toUpperCase();

  // Log the raw fast-path response whenever it's non-empty, so a bad match can be inspected
  // directly in Vercel's function logs (Deployments -> function -> Logs) instead of guessed at.
  if (directSymbol) {
    console.log(`[TFG Research] profile("${asTicker}") -> ${JSON.stringify(direct).slice(0, 500)}`);
  }

  const quote = (Array.isArray(quoteArr) ? quoteArr[0] : quoteArr) || {};
  const hasLiveQuote = typeof quote.price === 'number' && quote.price > 0;

  const candidates = (Array.isArray(searchResults) ? searchResults : []).map(c => ({
    symbol: c.symbol,
    name: c.name,
    exchange: c.exchangeShortName || c.exchange || '',
    currency: c.currency || '',
  })).filter(c => c.symbol);

  // Gate 1: returned symbol must exactly match what was typed (rules out a silent redirect
  //         or fuzzy-match to a completely different, unrelated symbol).
  // Gate 2: profile must not be explicitly flagged inactive/delisted. NOTE: unverified from
  //         this environment whether FMP's /stable/profile actually populates
  //         isActivelyTrading — check the logged payload above to confirm.
  // Gate 3: a live quote must exist for this exact symbol via the same batch-quote-short
  //         endpoint the app already relies on for real-time pricing. A stale/historical
  //         ticker alias (the Ford/Forward Industries theory) resolving to a company's
  //         current profile data should still have no live, currently-traded price under
  //         the OLD symbol — this is the load-bearing check now, not gate 2.
  const exactSymbolMatch = directSymbol && directSymbol === asTicker;
  const notFlaggedInactive = direct.isActivelyTrading !== false;

  if (exactSymbolMatch && notFlaggedInactive && hasLiveQuote) {
    return { status: 'RESOLVED', ticker: direct.symbol };
  }

  if (exactSymbolMatch) {
    console.log(`[TFG Research] Fast-path match for "${asTicker}" REJECTED (inactive=${!notFlaggedInactive}, hasLiveQuote=${hasLiveQuote}) — routing through name-search confirmation instead`);
  }

  if (candidates.length === 0) {
    return { status: 'NOT_FOUND' };
  }

  // Always let the user confirm — even a single search result isn't guaranteed correct.
  // Real-world case: searching "Ford" returned exactly one candidate, "Forward Industries"
  // (FWDI) — not Ford Motor Company — and the app silently generated a report for the
  // wrong company with no warning. A name search's relevance ranking isn't verified or
  // trustworthy enough to treat "only one result" as "the right result." Multiple
  // candidates AND single candidates both route through the picker; only a fully-verified,
  // literal, live ticker match (the fast path above) skips confirmation.
  return { status: 'NEEDS_SELECTION', candidates };
}

async function fetchFMPData(ticker) {
  const T = ticker.toUpperCase();

  // Parallel fetch all endpoints — using /stable/ query-param format (not legacy /api/v3/ path format)
  const [profileArr, quoteArr, incomeArr, balanceArr, cashFlowArr, keyMetricsArr,
         ratiosArr, estimatesArr, priceHistory, dividendArr, spyProfile] = await Promise.all([
    fmpGet(`/stable/profile?symbol=${T}`),
    fmpGet(`/stable/batch-quote-short?symbols=${T}`),
    fmpGet(`/stable/income-statement?symbol=${T}&limit=7`),
    fmpGet(`/stable/balance-sheet-statement?symbol=${T}&limit=7`),
    fmpGet(`/stable/cash-flow-statement?symbol=${T}&limit=7`),
    fmpGet(`/stable/key-metrics?symbol=${T}&limit=7`),
    fmpGet(`/stable/ratios?symbol=${T}&limit=7`),
    fmpGet(`/stable/analyst-estimates?symbol=${T}&limit=3`),
    fmpGet(`/stable/historical-price-eod/full?symbol=${T}`),
    fmpGet(`/stable/historical-price-eod/dividend?symbol=${T}`),
    fmpGet(`/stable/profile?symbol=SPY`),
  ]);

  const profile = (Array.isArray(profileArr) ? profileArr[0] : profileArr) || {};

  if (!profile.companyName && !profile.symbol) {
    return null; // ticker not found
  }

  // Overlay real-time quote data onto profile (quote has live price, mktCap, volume)
  const quote = (Array.isArray(quoteArr) ? quoteArr[0] : quoteArr) || {};
  if (quote.price) {
    profile.price = quote.price;
    console.log(`[TFG Research] Live quote price for ${T}: $${quote.price}`);
  }
  if (quote.marketCap) profile.mktCap = quote.marketCap;
  if (quote.pe) profile.pe = quote.pe;
  if (quote.eps) profile.eps = quote.eps;

  const income    = Array.isArray(incomeArr)    ? incomeArr    : [];
  const balance   = Array.isArray(balanceArr)   ? balanceArr   : [];
  const cashFlow  = Array.isArray(cashFlowArr)  ? cashFlowArr  : [];
  const keyMetr   = Array.isArray(keyMetricsArr)? keyMetricsArr: [];
  const ratios    = Array.isArray(ratiosArr)    ? ratiosArr    : [];
  const estimates = Array.isArray(estimatesArr) ? estimatesArr : [];
  // /stable/ may return flat array OR {historical:[...]} wrapper — handle both
  const priceHist = Array.isArray(priceHistory) ? priceHistory
    : (priceHistory && priceHistory.historical ? priceHistory.historical : []);
  const divHist = Array.isArray(dividendArr) ? dividendArr
    : (dividendArr && dividendArr.historical ? dividendArr.historical : []);

  return { profile, income, balance, cashFlow, keyMetr, ratios, estimates, priceHist, divHist, ticker: T };
}

/* ═══════════════════════════════════════════════════════════════════════════
   NORMALIZE FMP DATA → METRICS BLOCK FOR PROMPT
   ═══════════════════════════════════════════════════════════════════════════ */
function computeMetrics(data) {
  const { profile, income, balance, cashFlow, keyMetr, ratios, estimates, priceHist, divHist, ticker } = data;

  // Sort financials by date ascending (oldest first)
  const sortByDate = arr => [...arr].sort((a, b) => new Date(a.date) - new Date(b.date));
  const inc  = sortByDate(income).slice(-6);   // last 6 years
  const bal  = sortByDate(balance).slice(-6);
  const cf   = sortByDate(cashFlow).slice(-6);
  const km   = sortByDate(keyMetr).slice(-6);
  const rat  = sortByDate(ratios).slice(-6);

  const fmt  = (v, dec=2) => v != null && isFinite(v) ? Number(v).toFixed(dec) : '—';
  const fmtM = (v) => v != null && isFinite(v) ? (v / 1e6).toFixed(1) : '—'; // already in raw units from FMP
  const fmtPct = (v) => v != null && isFinite(v) ? (v * 100).toFixed(1) : '—';

  // Build year-by-year rows
  const years = inc.map(i => {
    const fy = i.calendarYear || new Date(i.date).getFullYear().toString();
    return fy.length === 4 ? `'${fy.slice(2)}` : fy;
  });

  // Match balance and cashflow by year
  const getByYear = (arr, yr) => arr.find(x => {
    const y = x.calendarYear || new Date(x.date).getFullYear().toString();
    return y === yr || `'${y.slice(2)}` === yr;
  });

  const rows = {};
  const metrics = [
    'Revenues per Share', 'Earnings per Share', 'Book Value per Share',
    'Shares/Units Outstanding (M)', 'Avg Ann\'l P/E Ratio', 'Relative P/E Ratio',
    'Avg Ann\'l Dist. Yield', 'Revenues ($mill)', 'EBITDA ($mill)', 'EBITDA Growth Rate (%)',
    'Enterprise Value/EBITDA (x)', 'EBITDA PEG', 'EBITDA Margin (%)',
    'Operating Margin (%)', 'Net Profit ($mill)', 'Net Profit Margin (%)',
    'Cash Flow ($mill)', 'Capital Expenditures ($mill)', 'Free Cash Flow ($mill)',
    'Working Cap\'l ($mill)', 'Long-Term Debt ($mill)',
    'Partners\'/Shareholders\' Capital ($mill)', 'Return on Total Cap\'l (%)',
    'Return on Equity (%)', 'Dist. Decl\'d per Share', 'All Dist. to Net Profit (%)'
  ];

  metrics.forEach(m => { rows[m] = []; });

  const fullYears = inc.map(i => i.calendarYear || new Date(i.date).getFullYear().toString());

  let prevEbitda = null; // tracks prior-year EBITDA for the YoY growth-rate calc below
  for (let idx = 0; idx < inc.length; idx++) {
    const i = inc[idx];
    const fy = fullYears[idx];
    // Match balance sheet and cash flow by fiscal year, not by positional index
    const b = bal.find(x => (x.calendarYear || new Date(x.date).getFullYear().toString()) === fy) || {};
    const c = cf.find(x => (x.calendarYear || new Date(x.date).getFullYear().toString()) === fy) || {};
    const k = km[idx]  || {};
    const r = rat[idx]  || {};

    const shares = (i.weightedAverageShsOut || profile.mktCap / profile.price) || null;
    const sharesM = shares ? shares / 1e6 : null;
    const revenue = i.revenue || 0;
    const netIncome = i.netIncome || 0;
    const ebitda = i.ebitda || (i.operatingIncome + i.depreciationAndAmortization) || 0;
    const opIncome = i.operatingIncome || 0;
    const capex = Math.abs(c.capitalExpenditure || 0);
    const ocf = c.operatingCashFlow || 0;
    const fcf = ocf - capex;
    const totalEquity = b.totalStockholdersEquity || 0;
    const ltDebt = b.longTermDebt || 0;
    const currentAssets = b.totalCurrentAssets || 0;
    const currentLiab = b.totalCurrentLiabilities || 0;
    const workingCap = currentAssets - currentLiab;
    const bvps = shares ? totalEquity / shares : null;
    const eps = i.eps || (shares ? netIncome / shares : null);
    const revPerShare = shares ? revenue / shares : null;

    // Dividends for this year
    const yearDivs = divHist.filter(d => new Date(d.date).getFullYear().toString() === fy);
    const annualDiv = yearDivs.reduce((s, d) => s + (d.dividend || d.adjDividend || d.amount || d.dividendAmount || 0), 0);

    // Annual high/low price for P/E
    const yearPrices = (data.priceHist || []).filter(p => {
      const py = new Date(p.date).getFullYear().toString();
      return py === fy;
    });
    const avgPrice = yearPrices.length > 0
      ? yearPrices.reduce((s, p) => s + p.close, 0) / yearPrices.length
      : profile.price || null;
    const annPE = eps && eps > 0 && avgPrice ? avgPrice / eps : null;
    const divYield = avgPrice && annualDiv ? annualDiv / avgPrice : null;

    // Return metrics
    const totalCap = totalEquity + ltDebt;
    const roic = totalCap > 0 ? (opIncome * (1 - 0.25)) / totalCap : null; // rough after-tax
    const roe = totalEquity > 0 ? netIncome / totalEquity : null;
    const payoutRatio = netIncome > 0 && annualDiv && shares ? (annualDiv * shares) / netIncome : null;

    // EBITDA Growth Rate (YoY %) — blank in the oldest column, no prior-year comp exists
    const ebitdaGrowthPct = (prevEbitda != null && prevEbitda !== 0)
      ? ((ebitda - prevEbitda) / Math.abs(prevEbitda)) * 100
      : null;

    // Enterprise Value/EBITDA (x) — Value Line-style avg-annual multiple for that year:
    // (avg annual price × shares = avg market cap) + LT debt − cash, over that year's EBITDA
    const cashYr = b.cashAndCashEquivalents || b.cashAndShortTermInvestments || 0;
    const yearEV = (avgPrice && shares) ? (avgPrice * shares) + ltDebt - cashYr : null;
    const yearEvEbitda = (yearEV != null && ebitda > 0) ? yearEV / ebitda : null;

    // EBITDA PEG (TFG proprietary): EV/EBITDA (x) ÷ EBITDA Growth Rate (as a plain number, e.g. 26.5)
    // N/M when growth is zero or negative — the ratio isn't meaningful in that case
    const ebitdaPeg = (yearEvEbitda != null && ebitdaGrowthPct != null)
      ? (ebitdaGrowthPct > 0 ? yearEvEbitda / ebitdaGrowthPct : 'N/M')
      : null;

    rows['Revenues per Share'].push(fmt(revPerShare ? revPerShare : null));
    rows['Earnings per Share'].push(fmt(eps));
    rows['Book Value per Share'].push(fmt(bvps));
    rows['Shares/Units Outstanding (M)'].push(fmt(sharesM, 1));
    rows['Avg Ann\'l P/E Ratio'].push(fmt(annPE, 1));
    rows['Relative P/E Ratio'].push('—'); // needs S&P P/E, computed below
    rows['Avg Ann\'l Dist. Yield'].push(divYield != null ? fmtPct(divYield) : '—');
    rows['Revenues ($mill)'].push(fmt(revenue / 1e6, 1));
    rows['EBITDA ($mill)'].push(fmt(ebitda / 1e6, 1));
    rows['EBITDA Growth Rate (%)'].push(ebitdaGrowthPct != null ? fmt(ebitdaGrowthPct, 1) : '—');
    rows['Enterprise Value/EBITDA (x)'].push(yearEvEbitda != null ? fmt(yearEvEbitda, 1) : '—');
    rows['EBITDA PEG'].push(ebitdaPeg === 'N/M' ? 'N/M' : (ebitdaPeg != null ? fmt(ebitdaPeg, 2) : '—'));
    rows['EBITDA Margin (%)'].push(revenue > 0 ? fmt(ebitda / revenue * 100, 1) : '—');
    rows['Operating Margin (%)'].push(revenue > 0 ? fmt(opIncome / revenue * 100, 1) : '—');
    rows['Net Profit ($mill)'].push(fmt(netIncome / 1e6, 1));
    rows['Net Profit Margin (%)'].push(revenue > 0 ? fmt(netIncome / revenue * 100, 1) : '—');
    rows['Cash Flow ($mill)'].push(fmt(ocf / 1e6, 1));
    rows['Capital Expenditures ($mill)'].push(fmt(capex / 1e6, 1));
    rows['Free Cash Flow ($mill)'].push(fmt(fcf / 1e6, 1));
    rows['Working Cap\'l ($mill)'].push(fmt(workingCap / 1e6, 1));
    rows['Long-Term Debt ($mill)'].push(fmt(ltDebt / 1e6, 1));
    rows['Partners\'/Shareholders\' Capital ($mill)'].push(fmt(totalEquity / 1e6, 1));
    rows['Return on Total Cap\'l (%)'].push(roic != null ? fmt(roic * 100, 1) : '—');
    rows['Return on Equity (%)'].push(roe != null ? fmt(roe * 100, 1) : '—');
    rows['Dist. Decl\'d per Share'].push(annualDiv > 0 ? fmt(annualDiv) : '—');
    rows['All Dist. to Net Profit (%)'].push(payoutRatio != null ? fmt(payoutRatio * 100, 1) : '—');

    prevEbitda = ebitda;
  }

  // Price highs/lows per year — use actual high/low fields from EOD data
  const priceRanges = {};
  fullYears.forEach(fy => {
    const yp = (data.priceHist || []).filter(p => new Date(p.date).getFullYear().toString() === fy);
    if (yp.length > 0) {
      priceRanges[fy] = {
        high: Math.max(...yp.map(p => p.high || p.close)),
        low:  Math.min(...yp.map(p => p.low || p.close)),
      };
    }
  });

  // Also compute current year price range (may not have a fiscal year entry yet)
  const currentYear = new Date().getFullYear().toString();
  if (!priceRanges[currentYear]) {
    const cyp = (data.priceHist || []).filter(p => new Date(p.date).getFullYear().toString() === currentYear);
    if (cyp.length > 0) {
      priceRanges[currentYear] = {
        high: Math.max(...cyp.map(p => p.high || p.close)),
        low:  Math.min(...cyp.map(p => p.low || p.close)),
      };
    }
  }

  // Analyst estimates for forward years
  const sortedEst = [...estimates].sort((a, b) => new Date(a.date) - new Date(b.date));

  // Header-level metrics
  const trailingPE = profile.price && inc.length > 0 ? (() => {
    const lastEps = inc[inc.length - 1].eps;
    return lastEps && lastEps > 0 ? (profile.price / lastEps).toFixed(1) : 'N/M';
  })() : '—';

  const forwardPE = sortedEst.length > 0 && sortedEst[0].estimatedEpsAvg && sortedEst[0].estimatedEpsAvg > 0
    ? (profile.price / sortedEst[0].estimatedEpsAvg).toFixed(1) : '—';

  const divYieldCurrent = profile.lastDiv && profile.price
    ? ((profile.lastDiv * 4 / profile.price) * 100).toFixed(2) + '%'
    : '0.00%';

  const marketCap = profile.mktCap
    ? (profile.mktCap >= 1e12 ? `$${(profile.mktCap / 1e12).toFixed(2)}T`
       : profile.mktCap >= 1e9 ? `$${(profile.mktCap / 1e9).toFixed(1)}B`
       : `$${(profile.mktCap / 1e6).toFixed(0)}M`)
    : '—';

  // EV/EBITDA — use sorted balance sheet for most recent year
  const latestBal = bal.length > 0 ? bal[bal.length - 1] : {};
  const ev = (profile.mktCap || 0) +
    (latestBal.longTermDebt || 0) - (latestBal.cashAndCashEquivalents || latestBal.cashAndShortTermInvestments || 0);
  const ttmEbitda = inc.length > 0 ? inc[inc.length - 1].ebitda : null;
  const evEbitdaTTM = ttmEbitda && ttmEbitda > 0 ? (ev / ttmEbitda).toFixed(1) : '—';

  // Forward EV/EBITDA from estimates
  const evEbitdaFwd1 = sortedEst.length > 0 && sortedEst[0].estimatedEbitdaAvg && sortedEst[0].estimatedEbitdaAvg > 0
    ? (ev / sortedEst[0].estimatedEbitdaAvg).toFixed(1) : '—';
  const evEbitdaFwd2 = sortedEst.length > 1 && sortedEst[1].estimatedEbitdaAvg && sortedEst[1].estimatedEbitdaAvg > 0
    ? (ev / sortedEst[1].estimatedEbitdaAvg).toFixed(1) : '—';

  // PEG ratio
  const epsGrowth = inc.length >= 2 ? (() => {
    const last = inc[inc.length - 1].eps;
    const prev = inc[inc.length - 2].eps;
    if (last && prev && prev > 0) return ((last - prev) / Math.abs(prev)) * 100;
    return null;
  })() : null;
  const pegRatio = epsGrowth && epsGrowth > 2 && forwardPE !== '—'
    ? (parseFloat(forwardPE) / epsGrowth).toFixed(2) : 'N/M';

  return {
    ticker,
    companyName: profile.companyName || ticker,
    exchange: profile.exchangeShortName || profile.exchange || '',
    sector: profile.sector || '',
    industry: profile.industry || '',
    description: profile.description || '',
    ceo: profile.ceo || '',
    website: profile.website || '',
    price: profile.price ? `$${profile.price.toFixed(2)}` : '—',
    trailingPE,
    forwardPE,
    divYield: divYieldCurrent,
    marketCap,
    beta: profile.beta ? profile.beta.toFixed(2) : '—',
    evEbitdaTTM,
    evEbitdaFwd1,
    evEbitdaFwd2,
    pegRatio,
    years,
    fullYears,
    rows,
    priceRanges,
    estimates: sortedEst,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   BUILD PROMPT WITH INJECTED DATA
   ═══════════════════════════════════════════════════════════════════════════ */
function buildPrompt(query, metrics) {
  // Format the financial table data
  let tableData = '';
  if (metrics) {
    tableData = `\n\n══════ PRE-FETCHED FINANCIAL DATA (from Financial Modeling Prep) ══════\n`;
    tableData += `Data retrieved: ${new Date().toISOString().slice(0, 10)}\n`;
    tableData += `Most recent fiscal year in data: ${metrics.fullYears[metrics.fullYears.length - 1] || 'unknown'}\n`;
    tableData += `Company: ${metrics.companyName} (${metrics.ticker})\n`;
    tableData += `Exchange: ${metrics.exchange} | Sector: ${metrics.sector} | Industry: ${metrics.industry}\n`;
    tableData += `Price: ${metrics.price} | Trailing P/E: ${metrics.trailingPE} | Forward P/E: ${metrics.forwardPE}\n`;
    tableData += `Dividend Yield: ${metrics.divYield} | Market Cap: ${metrics.marketCap} | Beta: ${metrics.beta}\n`;
    tableData += `EV/EBITDA (TTM): ${metrics.evEbitdaTTM} | EV/EBITDA +1 Yr (E): ${metrics.evEbitdaFwd1} | EV/EBITDA +2 Yr (E): ${metrics.evEbitdaFwd2} | PEG: ${metrics.pegRatio}\n`;

    if (metrics.description) {
      tableData += `\nBusiness Description: ${metrics.description.slice(0, 600)}...\n`;
    }

    // Price ranges
    tableData += `\nAnnual Price Ranges:\n`;
    metrics.fullYears.forEach(fy => {
      const pr = metrics.priceRanges[fy];
      if (pr) tableData += `  ${fy}: H $${pr.high.toFixed(2)} / L $${pr.low.toFixed(2)}\n`;
    });
    // Include current year if not already in fullYears
    const cy = new Date().getFullYear().toString();
    if (!metrics.fullYears.includes(cy) && metrics.priceRanges[cy]) {
      const pr = metrics.priceRanges[cy];
      tableData += `  ${cy} YTD: H $${pr.high.toFixed(2)} / L $${pr.low.toFixed(2)}\n`;
    }

    // Financial table
    tableData += `\nFinancial Table (columns: ${metrics.years.join(' | ')}):\n`;
    Object.entries(metrics.rows).forEach(([metric, values]) => {
      tableData += `  ${metric}: ${values.join(' | ')}\n`;
    });

    // Analyst estimates
    if (metrics.estimates.length > 0) {
      tableData += `\nAnalyst Consensus Estimates:\n`;
      metrics.estimates.forEach(e => {
        const fy = e.date ? new Date(e.date).getFullYear() : '?';
        tableData += `  FY${fy}(E): Rev $${e.estimatedRevenueAvg ? (e.estimatedRevenueAvg/1e6).toFixed(0)+'M' : '—'} | EPS $${e.estimatedEpsAvg ? e.estimatedEpsAvg.toFixed(2) : '—'} | EBITDA $${e.estimatedEbitdaAvg ? (e.estimatedEbitdaAvg/1e6).toFixed(0)+'M' : '—'}\n`;
      });
    }

    tableData += `\n══════ END PRE-FETCHED DATA ══════\n`;
    tableData += `USE THIS DATA to populate all tables, charts, and metrics in the report. Fill in estimate (E) columns using the analyst consensus data above. Where data gaps exist, use your training knowledge to fill reasonable estimates and flag with (E). For the "Good for What?!?" section, provide opinionated analysis.\n`;
  }

  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const todayISO = today.toISOString().slice(0, 10);

  const promptBody = `You are a senior equity analyst at The Fedeli Group. Produce a complete, self-contained HTML equity research report for: "${query}".

IMPORTANT: Today's date is ${todayStr} (${todayISO}). Use this as the report date. All "as of" dates, analyst signature dates, and data freshness references must reflect this date. Do NOT use any other date.

CRITICAL OUTPUT RULE: Return ONLY valid HTML. Your entire response must begin with <!DOCTYPE html> and end with </html>. Do not output markdown code fences, backticks, or any text outside the HTML document.

The HTML document must contain:
- All CSS in an embedded <style> block
- Chart.js loaded from https://cdn.jsdelivr.net/npm/chart.js (script tag in <head>)
- All JavaScript in a <script> block just before </body>
- No other external dependencies
- Title: "TFG Family Investment Research — [COMPANY NAME]"

Flag all forward estimates with (E).
Always write "EV/EBITDA" in full. Never abbreviate as EV/DE or any shorthand.
${tableData}

════════════════════════════════════
SECTION 1 — HEADER TABLE
════════════════════════════════════
Single HTML table, class "header-table", two rows.

Row 1 (dark navy #1a1a2e bg, white text):
Company & Ticker | Recent Price | Trailing P/E | Forward P/E | Dividend Yield | Market Cap | Beta | Timeliness (1–5) | Safety (1–5) | Financial Strength

Row 2 (white bg #ffffff):
Four cells spanning full width. Label in plain text, value in bold below:
EV/EBITDA (TTM) | EV/EBITDA +1 Yr (E) | EV/EBITDA +2 Yr (E) | PEG Ratio

════════════════════════════════════
SECTION 2 — MAIN DATA BLOCK
════════════════════════════════════
Flex container class "data-block" with two children:

LEFT — Company Snapshot (class "company-snapshot", width 280px):
6-8 sentences: business, segments, scale, competitive position, key risks, valuation vs history.
Close with HQ, CEO, ticker, website.

RIGHT — stacked: Price Range Bar → Chart → Financial Table

1. Annual Price Range Bar (class "price-range-bar"):
   Single-row HTML table. Dark navy bg, white text, 13px. Columns match financial table years.
   Each cell: [YEAR] / H: $XX.XX / L: $XX.XX

2. Dual-Axis Chart (class "chart-container", 220px height):
   Chart.js canvas. Same year labels as financial table.
   - EPS bars (left Y, navy #1a1a2e, estimate years lighter #7f8fa6)
   - Relative P/E line (right Y, red #c0392b, 2px, estimate years dashed)
   Legend visible. No gridlines on right axis.

3. Financial Table (class "financial-table"):
   Columns: 5 most recent fiscal years + current FY (E) + next FY (E) + 3-5yr range (E)
   Rows in exact order:
   Revenues per Share | Earnings per Share | Book Value per Share | Shares/Units Outstanding (M) |
   Avg Ann'l P/E Ratio | Relative P/E Ratio | Avg Ann'l Dist. Yield | Revenues ($mill) |
   EBITDA ($mill) | EBITDA Growth Rate (%) | Enterprise Value/EBITDA (x) | EBITDA PEG |
   EBITDA Margin (%) | Operating Margin (%) | Net Profit ($mill) |
   Net Profit Margin (%) | Cash Flow ($mill) | Capital Expenditures ($mill) | Free Cash Flow ($mill) |
   Working Cap'l ($mill) | Long-Term Debt ($mill) | Partners'/Shareholders' Capital ($mill) |
   Return on Total Cap'l (%) | Return on Equity (%) | Dist. Decl'd per Share | All Dist. to Net Profit (%)

   Use — for unavailable data.

   EBITDA Growth Rate (%) = YoY % change in EBITDA. "—" in the oldest column (no prior-year comp).
   Enterprise Value/EBITDA (x) = Enterprise Value ÷ EBITDA for that column. Historical columns are
     pre-computed for you above. For the current FY(E) and next FY(E) columns, reuse the EV/EBITDA
     +1 Yr (E) and +2 Yr (E) figures already given above (same EV, same methodology). For the 3-5yr
     range column, apply the same formula to your own extrapolated EBITDA and flag with (E).
   EBITDA PEG (TFG proprietary metric) = Enterprise Value/EBITDA (x) ÷ EBITDA Growth Rate (%), using
     the growth rate as a plain number (e.g. 26.5, not 0.265). Display as N/M whenever the growth rate
     is zero or negative — the ratio is not meaningful in that case. This is NOT the same as the header
     row's "PEG Ratio" (Forward P/E ÷ EPS growth) — keep the two distinct.

════════════════════════════════════
SECTION 3 — HISTORICAL VALUATION CHARTS
════════════════════════════════════
Three side-by-side Chart.js panels in a CSS grid (1fr 1fr 1fr).
Header bar: "Historical Absolute & Relative Valuation — Forward P/E | Price / FCF | Forward EV/EBITDA vs. S&P 500"
Source line: "Source: FMP, Company Filings, TFG Research | As of ${todayStr}"

Each panel:
- Title: "Historical [Metric] Relative to the S&P 500"
- Left axis: absolute multiple, Right axis: relative to S&P 500 (%)
- Stock line (navy #1a1a2e), Avg line (dashed blue #2563eb), ±1σ band (gray shading)
- Relative line (solid blue, right axis), Avg relative (dashed blue, right axis)
- Corner annotation with current value, historical avg, relative %, avg relative %
- HTML legend swatches (not Chart.js legend)

Panels: Forward P/E | P/FCF | Forward EV/EBITDA
Use monthly labels spanning 3-5 years.

Use this shared buildValChart function:
function buildValChart(canvasId, stockData, relData, avgAbs, stdAbs, avgRel, leftMax, leftMin, rightMax, rightMin) {
  const flat = n => stockData.map(() => n);
  new Chart(document.getElementById(canvasId), {
    data: { labels: valLabels, datasets: [
      { type:'line', label:'_hi', data: flat(+(avgAbs+stdAbs).toFixed(1)), borderWidth:0, pointRadius:0, fill:false, yAxisID:'yL' },
      { type:'line', label:'_lo', data: flat(+(avgAbs-stdAbs).toFixed(1)), borderWidth:0, pointRadius:0, fill:'-1', backgroundColor:'rgba(0,0,0,0.07)', yAxisID:'yL' },
      { type:'line', label:ticker, data:stockData, borderColor:'#1a1a2e', borderWidth:1.8, pointRadius:0, tension:0.35, fill:false, yAxisID:'yL' },
      { type:'line', label:'Avg', data:flat(avgAbs), borderColor:'#2563eb', borderWidth:1.4, borderDash:[5,4], pointRadius:0, fill:false, yAxisID:'yL' },
      { type:'line', label:'+1σ', data:flat(+(avgAbs+stdAbs).toFixed(1)), borderColor:'#666', borderWidth:1.1, borderDash:[4,3], pointRadius:0, fill:false, yAxisID:'yL' },
      { type:'line', label:'-1σ', data:flat(+(avgAbs-stdAbs).toFixed(1)), borderColor:'#666', borderWidth:1.1, borderDash:[4,3], pointRadius:0, fill:false, yAxisID:'yL' },
      { type:'line', label:'Rel %', data:relData, borderColor:'#2563eb', borderWidth:1.8, pointRadius:0, tension:0.35, fill:false, yAxisID:'yR' },
      { type:'line', label:'Avg Rel', data:flat(avgRel), borderColor:'#2563eb', borderWidth:1.2, borderDash:[5,4], pointRadius:0, fill:false, yAxisID:'yR' },
    ]},
    options: {
      responsive:true, maintainAspectRatio:false, animation:false,
      interaction:{ mode:'index', intersect:false },
      plugins:{
        legend:{ display:false },
        tooltip:{
          filter: item => !item.dataset.label.startsWith('_'),
          callbacks:{ label: ctx => { const v=ctx.parsed.y; if(v==null) return null; return ctx.dataset.label+': '+v.toFixed(1)+(ctx.dataset.yAxisID==='yR'?'%':'x'); } },
          backgroundColor:'rgba(26,26,46,0.9)', titleColor:'#fff', bodyColor:'#ccc', padding:7, titleFont:{size:10}, bodyFont:{size:10}
        }
      },
      scales:{
        x:{ ticks:{ font:{size:8.5}, color:'#666', maxTicksLimit:12, maxRotation:45, minRotation:30 }, grid:{ color:'#eee' } },
        yL:{ position:'left', max:leftMax, min:leftMin, ticks:{ font:{size:9}, color:'#333', callback: v=>v+'x' }, grid:{ color:'#e8e8e8' } },
        yR:{ position:'right', max:rightMax, min:rightMin, ticks:{ font:{size:9}, color:'#2563eb', callback: v=>v+'%' }, grid:{ drawOnChartArea:false } }
      }
    }
  });
}

════════════════════════════════════
SECTION 4 — ANALYST NARRATIVE
════════════════════════════════════
<div class="narrative"> Three paragraphs, no headers, no bullets:
P1 Recent Results: recurring vs one-time, margins, FCF quality, balance sheet flags.
P2 Outlook: 2-3 value drivers next 12-24 months, one specific upside catalyst, one specific downside risk.
P3 Rating (BUY/HOLD/SELL), 12-month price target, exact multiple e.g. "22x FY26E EPS of $4.85", single condition that changes the rating.
<p class="analyst-sig">TFG Family Investment Research | Report Date: ${todayStr} | Next Expected Earnings: [look up next earnings date]</p>

════════════════════════════════════
SECTION 5 — GOOD FOR WHAT?!?
════════════════════════════════════
Full-width <div> style="background:#1a1a2e;color:white;padding:24px 28px;margin-top:40px"
<h3 style="color:#AD9551;font-family:Georgia,serif;font-size:18px;font-weight:700;margin-bottom:12px">GOOD FOR WHAT?!?</h3>
3-4 opinionated plain-language sentences: who this stock IS and IS NOT right for. No hedging.

Use the pre-fetched FMP data above to populate all tables and charts with REAL numbers. Anchor all estimates to the data provided. For metrics not in the data, use your training knowledge and flag clearly.

════════════════════════════════════
CSS STYLING (embed in <style>)
════════════════════════════════════
body { font-family: Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #111; max-width: 1200px; margin: 40px auto; padding: 0 24px; }
.header-table { width: 100%; font-size: 15px; border-collapse: collapse; margin-bottom: 32px; }
.header-table th { background-color: #1a1a2e; color: white; padding: 10px 12px; text-align: left; }
.header-table td { padding: 10px 12px; border: 1px solid #ccc; }
.data-block { display: flex; gap: 32px; margin-bottom: 40px; }
.company-snapshot { flex: 0 0 280px; font-size: 16px; line-height: 1.7; }
.company-snapshot h2 { font-size: 18px; margin-bottom: 10px; }
.financial-table { flex: 1; width: 100%; border-collapse: collapse; font-size: 15px; }
.financial-table th { background-color: #1a1a2e; color: white; padding: 8px 10px; text-align: right; white-space: nowrap; }
.financial-table th:first-child { text-align: left; }
.financial-table td { padding: 7px 10px; border-bottom: 1px solid #e0e0e0; text-align: right; white-space: nowrap; }
.financial-table td:first-child { text-align: left; font-weight: 500; }
.financial-table tr:nth-child(even) { background-color: #f7f7f7; }
.price-range-bar { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 0; }
.price-range-bar th { background-color: #1a1a2e; color: white; padding: 6px 8px; text-align: center; }
.price-range-bar td { padding: 6px 8px; text-align: center; border: 1px solid #ccc; line-height: 1.4; white-space: nowrap; }
.chart-container { width: 100%; height: 220px; margin-bottom: 0; }
.narrative { font-size: 17px; line-height: 1.85; max-width: 960px; border-top: 2px solid #1a1a2e; padding-top: 24px; }
.narrative p { margin-bottom: 20px; }
.analyst-sig { font-size: 15px; color: #555; margin-top: 24px; font-style: italic; }
.valuation-section { margin-bottom: 40px; }
.valuation-section-header { background: #e8eaf0; border: 1px solid #c8ccda; border-bottom: none; padding: 10px 14px 8px; }
.valuation-section-header h2 { font-size: 14px; font-weight: 700; color: #1a1a2e; letter-spacing: 0.01em; margin-bottom: 2px; }
.valuation-section-header .date-range { font-size: 11px; color: #666; font-style: italic; }
.val-charts-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0; border: 1px solid #c8ccda; }
.val-chart-panel { background: white; border-right: 1px solid #d0d5e0; overflow: hidden; }
.val-chart-panel:last-child { border-right: none; }
.val-chart-panel-header { background: #f2f3f7; padding: 8px 12px 6px; border-bottom: 1px solid #d0d5e0; }
.val-chart-panel-header h3 { font-size: 12px; font-weight: 700; color: #1a1a2e; margin-bottom: 1px; }
.val-chart-panel-header .val-date { font-size: 10px; color: #777; font-style: italic; }
.val-chart-area { padding: 8px 10px 4px; position: relative; height: 240px; }
.val-annotation { position: absolute; font-size: 10.5px; line-height: 1.45; color: #1a1a2e; pointer-events: none; background: rgba(255,255,255,0.82); padding: 3px 5px; }
.val-annotation .v-metric { font-weight: 700; }
.val-annotation .v-rel { color: #2563eb; font-weight: 600; }
.val-chart-legend { display: flex; gap: 10px; padding: 5px 10px 8px; font-size: 10px; color: #444; border-top: 1px solid #eee; flex-wrap: wrap; }
.val-legend-item { display: flex; align-items: center; gap: 4px; }
.val-legend-swatch { width: 18px; height: 2.5px; border-radius: 2px; flex-shrink: 0; }
.valuation-note { font-size: 10.5px; color: #888; padding: 7px 0 0; font-style: italic; }`;

  return promptBody;
}

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */
function generateReportId(ticker) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ticker}-${date}-${rand}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   VERCEL HANDLER
   ═══════════════════════════════════════════════════════════════════════════ */
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { query } = req.body || {};
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'Missing "query" in request body.' });
    }

    if (!ANTHROPIC_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured.' });
    }
    if (!FMP_KEY) {
      return res.status(500).json({ error: 'FMP_API_KEY not configured.' });
    }

    const rawQuery = query.trim();
    console.log(`[TFG Research] Resolving: "${rawQuery}"`);

    const resolution = await resolveTickerSymbol(rawQuery);

    if (resolution.status === 'NOT_FOUND') {
      console.log(`[TFG Research] No match found for: "${rawQuery}"`);
      return res.status(404).json({
        error: `No company or ticker matching "${rawQuery}" was found on Financial Modeling Prep. Check the spelling, or try the exact ticker symbol.`,
        reason: 'NOT_FOUND',
      });
    }

    if (resolution.status === 'NEEDS_SELECTION') {
      console.log(`[TFG Research] "${rawQuery}" is ambiguous — ${resolution.candidates.length} candidates`);
      // Not an error — a normal branch of the interaction. 200 so frontend fetch() doesn't
      // treat this as a failure; the presence of needsSelection is what the frontend checks.
      return res.status(200).json({
        needsSelection: true,
        query: rawQuery,
        candidates: resolution.candidates,
      });
    }

    // resolution.status === 'RESOLVED'
    const ticker = resolution.ticker;
    console.log(`[TFG Research] Resolved "${rawQuery}" -> ${ticker}`);

    // Fetch and compute metrics
    let metrics = null;
    try {
      const raw = await fetchFMPData(ticker);
      if (raw) {
        metrics = computeMetrics(raw);
        console.log(`[TFG Research] FMP data loaded for ${metrics.companyName} (${metrics.ticker})`);
      } else {
        console.log(`[TFG Research] FMP data fetch failed for resolved ticker: ${ticker}`);
      }
    } catch (fmpErr) {
      console.error(`[TFG Research] FMP fetch error: ${fmpErr.message}`);
    }

    // GUARDRAIL: never let Claude write a "grounded" institutional report with no actual
    // data behind it. A resolved ticker can still fail here (FMP outage, auth issue, a
    // valid-but-thinly-covered symbol) — in every case, stop instead of silently falling
    // back to Claude's training memory for prices/financials.
    if (!metrics) {
      return res.status(502).json({
        error: `"${ticker}" resolved, but financial data could not be retrieved from FMP. Please try again in a moment.`,
        reason: 'DATA_FETCH_FAILED',
        ticker,
      });
    }

    // Build prompt and call Anthropic
    const prompt = buildPrompt(query, metrics);
    console.log(`[TFG Research] Calling Anthropic (prompt length: ${prompt.length} chars)`);

    const { status, data } = await anthropicPost({
      model: 'claude-sonnet-4-6',
      max_tokens: 32000,
      messages: [{ role: 'user', content: prompt }],
    });

    if (status !== 200) {
      const msg = data?.error?.message || `Anthropic returned HTTP ${status}`;
      console.error(`[TFG Research] Anthropic error: ${msg}`);
      return res.status(status).json({ error: msg });
    }

    let html = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    if (!html) {
      return res.status(500).json({ error: 'Anthropic returned an empty response.' });
    }

    console.log(`[TFG Research] Report generated (${html.length} chars)`);

    // Save to database
    const reportId = generateReportId(ticker);
    const companyName = metrics?.companyName || ticker;

    if (process.env.DATABASE_URL) {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      });
      try {
        await pool.query(
          `INSERT INTO reports (id, ticker, company_name, html, source)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET html = $4, company_name = $3, created_at = NOW()`,
          [reportId, ticker, companyName, html, 'fmp']
        );
        console.log(`[TFG Research] Report saved: ${reportId}`);
      } catch (dbErr) {
        // Log but don't fail the request — report still works, just not shareable
        console.error(`[TFG Research] DB save error: ${dbErr.message}`);
      } finally {
        await pool.end();
      }
    } else {
      console.log('[TFG Research] No DATABASE_URL — skipping save.');
    }

    return res.status(200).json({
      html,
      reportId,
      ticker: metrics?.ticker || ticker,
      companyName,
      source: 'fmp',
    });

  } catch (err) {
    console.error(`[TFG Research] Function error: ${err.message}`);
    return res.status(500).json({ error: 'Function error: ' + err.message });
  }
};

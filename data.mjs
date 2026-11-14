// Yahoo Finance data loaders. Indian stocks: use .NS suffix (e.g. RELIANCE.NS). Benchmark ^NSEI.
export async function getBars(symbol, base = 'https://query1.finance.yahoo.com') {
  const r = await fetch(`${base}/v8/finance/chart/${encodeURIComponent(symbol)}?range=3y&interval=1d`);
  const j = await r.json(); const res = j.chart?.result?.[0];
  if (!res) throw new Error(`No data for ${symbol}`);
  const q = res.indicators.quote[0];
  return res.timestamp.map((t, i) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }))
    .filter(x => x.c != null && x.o != null);
}
// Fundamentals from Yahoo's public fundamentals-timeseries endpoint (no login needed).
// Returns {pe, peg, epsGrowth, revGrowth, roe} (growth/ROE as fractions), or null.
const FT = 'trailingDilutedEPS,annualDilutedEPS,annualTotalRevenue,annualNetIncome,annualStockholdersEquity';
export async function getFundamentals(symbol, price, base = 'https://query1.finance.yahoo.com') {
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await fetch(`${base}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?type=${FT}&period1=${now - 4 * 365 * 86400}&period2=${now}`);
    const res = (await r.json()).timeseries?.result || [], S = {};
    for (const x of res) { const t = x.meta?.type?.[0]; S[t] = (x[t] || []).filter(Boolean).map(v => ({ d: v.asOfDate, v: v.reportedValue?.raw })).filter(v => v.v != null).sort((a, b) => a.d < b.d ? -1 : 1); }
    const L = (k, back = 0) => S[k]?.[S[k].length - 1 - back]?.v ?? null;
    // TTM EPS now vs ~1 year earlier (closest date ≥ 300 days before the latest)
    const tt = S.trailingDilutedEPS || [], eps = tt.length ? tt[tt.length - 1] : null;
    const prev = eps && [...tt].reverse().find(x => (new Date(eps.d) - new Date(x.d)) / 864e5 >= 300);
    let epsGrowth = eps && prev && prev.v > 0 ? eps.v / prev.v - 1 : null;
    if (epsGrowth == null && L('annualDilutedEPS', 1) > 0) epsGrowth = L('annualDilutedEPS') / L('annualDilutedEPS', 1) - 1;
    const e = eps?.v ?? L('annualDilutedEPS');
    const pe = price && e != null ? (e > 0 ? price / e : -1) : null;          // -1 = loss-making
    const peg = pe > 0 && epsGrowth > 0 ? pe / (epsGrowth * 100) : null;
    const revGrowth = L('annualTotalRevenue', 1) > 0 ? L('annualTotalRevenue') / L('annualTotalRevenue', 1) - 1 : null;
    const eq = [L('annualStockholdersEquity'), L('annualStockholdersEquity', 1)].filter(x => x > 0);
    const roe = L('annualNetIncome') != null && eq.length ? L('annualNetIncome') / (eq.reduce((a, b) => a + b) / eq.length) : null;
    if ([pe, epsGrowth, revGrowth, roe].every(x => x == null)) return null;
    return { pe, peg, epsGrowth, revGrowth, roe };
  } catch { return null; }
}

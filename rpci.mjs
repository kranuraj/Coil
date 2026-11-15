// RPCI screener core logic — pure functions, runs in Node and the browser.
// Reconstructed from the public RPCI 11-point checklist. Thresholds are in CONFIG.
export const CONFIG = {
  pe: { max: 40, pegMax: 2, pegAbove: 25 },   // PEG test only applies when P/E > pegAbove
  earnings: { minEpsGrowth: 0.15, minRevGrowth: 0.10, minRoe: 0.12, epsAlone: null },   // epsAlone: if set, EPS growth >= this passes on its own
  momentum: { rsiMin: 55, rsiMax: 100 },   // calibrated: no RSI ceiling
  contraction: { atrRatioMax: 0.75, rangePctMax: 0.12, lookback: 10, weekly: false, wRatioMax: 0.8 },  // weekly: also pass when the last 3 weekly ranges average <= wRatioMax x the prior 10
  tf: { frames: 'DWM' },   // 'DWM' = daily, weekly and monthly must align; 'DW' = daily and weekly
  outperf: { periods: [63, 126] },              // ~3M and ~6M trading days
  instCandle: { lookback: 50, bodyMult: 3, volMode: 'mult', volHighOf: 50, volMult: 3.5, minCount: 1 },  // volMode 'high' = highest volume of volHighOf sessions; 'mult' = >= volMult x 50-session average
  dow: { w: 3, pass: 'up' },   // pass 'up' = Uptrend only; 'notdown' = Uptrend or Sideways
  stExt: { emaLen: 21, atrMult: 3 },   // extended = more than 3 ATR above EMA21
  ltExt: { maxPctAbove200: 0.40 },
};

// Strategy profiles tracked side by side (see track.mjs / weekly.mjs). CONFIG above = the profile in use (v2).
export const PROFILES = {
  v1: { label: 'v1 · original', pe: { max: 40 }, earnings: { epsAlone: null }, stExt: { atrMult: 3 }, momentum: { rsiMax: 80 }, tf: { frames: 'DWM' }, instCandle: { bodyMult: 5, volMode: 'high', volHighOf: 50, lookback: 50 }, dow: { w: 2, pass: 'up' } },
  v2: { label: 'v2 · calibrated (in use)', pe: { max: 40 }, earnings: { epsAlone: null }, stExt: { atrMult: 3 }, momentum: { rsiMax: 100 }, tf: { frames: 'DWM' }, instCandle: { bodyMult: 3, volMode: 'mult', volMult: 3.5, lookback: 50 }, dow: { w: 3, pass: 'up' } },
  v3: { label: 'v3 · check-matched (challenger)', pe: { max: 60 }, earnings: { epsAlone: 0.15 }, stExt: { atrMult: 3.5 }, momentum: { rsiMax: 100 }, tf: { frames: 'DWM' }, instCandle: { bodyMult: 3, volMode: 'mult', volMult: 3.5, lookback: 50 }, dow: { w: 3, pass: 'up' } },
};
export function useProfile(name) { const p = PROFILES[name]; if (!p) throw new Error('unknown profile ' + name);
  for (const [k, v] of Object.entries(p)) if (k !== 'label') Object.assign(CONFIG[k], v); return p; }

// ---------- helpers ----------
const last = a => a[a.length - 1];
export function sma(v, n) { const o = new Array(v.length); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; o[i] = i < n - 1 ? NaN : s / n; } return o; }
export function ema(v, n) { const k = 2 / (n + 1); const o = []; v.forEach((x, i) => o.push(i === 0 ? x : x * k + o[i - 1] * (1 - k))); return o; }
export function rsi(c, n = 14) {
  let g = 0, l = 0; const o = Array(c.length).fill(NaN);
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; if (i === n) o[i] = 100 - 100 / (1 + g / (l || 1e-9)); }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); }
  }
  return o;
}
export function atr(b, n = 14) {
  const tr = b.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)));
  return ema(tr, 2 * n - 1); // Wilder smoothing ≈ EMA(2n-1)
}
// Resample daily bars ({t,o,h,l,c,v}, t = ms) to weekly / monthly
export function resample(b, unit) {
  const key = t => { const d = new Date(t); if (unit === 'M') return d.getUTCFullYear() * 12 + d.getUTCMonth();
    const day = (d.getUTCDay() + 6) % 7; return Math.floor((t - day * 864e5) / 864e5); };
  const out = [];
  for (const x of b) { const k = key(x.t), p = last(out);
    if (p && p.k === k) { p.h = Math.max(p.h, x.h); p.l = Math.min(p.l, x.l); p.c = x.c; p.v += x.v; p.t = x.t; }
    else out.push({ k, ...x }); }
  return out;
}
function pivots(b, w = 2) { const H = [], L = [];
  for (let i = w; i < b.length - w; i++) { const s = b.slice(i - w, i + w + 1);
    if (b[i].h === Math.max(...s.map(x => x.h))) H.push(b[i].h);
    if (b[i].l === Math.min(...s.map(x => x.l))) L.push(b[i].l); }
  return { H, L };
}
const ret = (c, n) => c.length > n ? c[c.length - 1] / c[c.length - 1 - n] - 1 : NaN;

// ---------- the 11 checks ----------
export function valuation(f) {
  if (f?.pe == null) return { result: 'N/A', pass: null };
  if (f.pe <= 0) return { result: 'Loss-making', pass: false, detail: 'negative trailing EPS' };
  const ok = f.pe <= CONFIG.pe.max && (f.pe <= CONFIG.pe.pegAbove || f.peg == null || f.peg <= CONFIG.pe.pegMax);
  return { result: ok ? (f.pe < 20 ? 'Undervalued' : 'Fairly valued') : 'Overvalued', pass: ok, detail: `P/E ${f.pe.toFixed(1)}${f.peg != null ? `, PEG ${f.peg.toFixed(2)}` : ''}` };
}
export function earningsPower(f) {
  if (!f || (f.epsGrowth == null && f.revGrowth == null)) return { result: 'N/A', pass: null };
  const E = CONFIG.earnings; let s = 0, n = 0;
  for (const [v, m] of [[f.epsGrowth, E.minEpsGrowth], [f.revGrowth, E.minRevGrowth], [f.roe, E.minRoe]]) if (v != null) { n++; if (v >= m) s++; }
  const pass = s >= Math.ceil(n * 2 / 3) || (E.epsAlone != null && f.epsGrowth != null && f.epsGrowth >= E.epsAlone);
  return { result: pass ? 'Strong' : s ? 'Moderate' : 'Weak', pass, detail: [['EPS', f.epsGrowth], ['Rev', f.revGrowth], ['ROE', f.roe]].filter(x => x[1] != null).map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`).join(', ') };
}
export function momentum(b) {
  const c = b.map(x => x.c), r = last(rsi(c)), e21 = last(ema(c, 21)), e50 = last(ema(c, 50)), p = last(c);
  const strong = r >= CONFIG.momentum.rsiMin && r <= CONFIG.momentum.rsiMax && p > e21 && e21 > e50;
  const weak = r < 45 || p < e50;
  return { result: strong ? 'Strong momentum' : weak ? 'Weak momentum' : 'Neutral', pass: strong, detail: `RSI ${r.toFixed(1)}` };
}
export function priceContraction(b) {
  const C = CONFIG.contraction, a = atr(b, 14), aNow = sma(a, 10), aBase = sma(a, 50);
  const ratio = last(aNow) / last(aBase), w = b.slice(-C.lookback);
  const hi = Math.max(...w.map(x => x.h)), lo = Math.min(...w.map(x => x.l)), range = (hi - lo) / hi;
  let wr = NaN; if (C.weekly) { const wk = resample(b, 'W'), rg = wk.map(x => (x.h - x.l) / x.h), n = rg.length;
    if (n >= 14) wr = (rg.slice(n - 3).reduce((t, x) => t + x, 0) / 3) / (rg.slice(n - 13, n - 3).reduce((t, x) => t + x, 0) / 10); }
  const pass = ratio <= C.atrRatioMax || range <= C.rangePctMax || (C.weekly && wr <= C.wRatioMax);
  return { result: pass ? 'YES' : 'NO', pass, detail: `ATR10/ATR50 ${ratio.toFixed(2)}, ${C.lookback}d range ${(range * 100).toFixed(1)}%${C.weekly && isFinite(wr) ? `, weekly range ratio ${wr.toFixed(2)}` : ''}` };
}
export function timeframeAlignment(b) {
  const up = bars => { const c = bars.map(x => x.c); return last(c) > last(ema(c, 10)) && last(ema(c, 10)) > last(ema(c, 20)); };
  const d = up(b), w = up(resample(b, 'W')), m = up(resample(b, 'M'));
  const pass = CONFIG.tf.frames === 'DW' ? d && w : d && w && m;
  return { result: pass ? 'YES' : 'NO', pass, detail: `D ${d ? '↑' : '↓'} W ${w ? '↑' : '↓'} M ${m ? '↑' : '↓'}` };
}
export function outperformance(b, bench) {
  if (!bench?.length) return { result: 'N/A', pass: null };
  const c = b.map(x => x.c), k = bench.map(x => x.c);
  const rs = CONFIG.outperf.periods.map(n => ret(c, n) - ret(k, n));
  const pass = rs.every(x => x > 0);
  return { result: pass ? 'YES' : 'NO', pass, detail: rs.map((x, i) => `${CONFIG.outperf.periods[i]}d ${(x * 100).toFixed(1)}%`).join(', ') + ' vs index' };
}
export function institutionalCandles(b) {
  const I = CONFIG.instCandle, body = b.map(x => Math.abs(x.c - x.o)), ab = sma(body, 20), av = sma(b.map(x => x.v), 50);
  let n = 0;
  for (let i = b.length - I.lookback; i < b.length; i++) if (i > 0) {
    const x = b[i], rng = x.h - x.l || 1e-9;
    const volHigh = I.volMode === 'mult' ? x.v >= I.volMult * av[i - 1] : x.v > Math.max(...b.slice(Math.max(0, i - I.volHighOf), i).map(y => y.v));
    if (x.c > x.o && body[i] >= I.bodyMult * ab[i - 1] && volHigh && (x.c - x.l) / rng >= 0.7) n++;
  }
  return { result: String(n), pass: n >= I.minCount, detail: `up candles with body ≥${I.bodyMult}× average on ${I.volMode === 'mult' ? `≥${I.volMult}× average volume` : `the highest volume of ${I.volHighOf} sessions`}, last ${I.lookback} sessions` };
}
export function shortTermExtension(b) {
  const S = CONFIG.stExt, c = b.map(x => x.c), e = last(ema(c, S.emaLen)), a = last(atr(b)), p = last(c);
  const ext = p - e > S.atrMult * a;
  return { result: ext ? 'YES' : 'NO', pass: !ext, detail: `${(((p / e) - 1) * 100).toFixed(1)}% / ${((p - e) / a).toFixed(1)} ATR above EMA${S.emaLen}` };
}
export function longTermExtension(b) {
  const c = b.map(x => x.c), s = last(sma(c, 200)), p = last(c);
  if (isNaN(s)) return { result: 'N/A', pass: null };
  const ext = p > s * (1 + CONFIG.ltExt.maxPctAbove200);
  return { result: ext ? 'YES' : 'NO', pass: !ext, detail: `${(((p / s) - 1) * 100).toFixed(1)}% above SMA200` };
}
// Weinstein stage analysis on the 30-week SMA
export function stageAnalysis(b) {
  const w = resample(b, 'W'), c = w.map(x => x.c), m = sma(c, 30);
  if (w.length < 35) return { result: 'N/A', pass: null };
  const p = last(c), ma = last(m), slope = (ma - m[m.length - 5]) / m[m.length - 5];
  let s;
  if (p > ma && slope > 0.005) s = 'Stage 2 - Uptrend';
  else if (p < ma && slope < -0.005) s = 'Stage 4 - Downtrend';
  else s = c.slice(-52).some(x => x > ma * 1.1) && slope >= 0 ? 'Stage 3 - Topping' : 'Stage 1 - Basing';
  return { result: s, pass: s.startsWith('Stage 2'), detail: `30W SMA slope ${(slope * 100).toFixed(1)}%/4w` };
}
// Dow theory on weekly swings: higher highs AND higher lows
export function dowTheoryWeekly(b) {
  const { H, L } = pivots(resample(b, 'W').slice(-60), CONFIG.dow.w);
  if (H.length < 2 || L.length < 2) return { result: 'N/A', pass: null };
  const p = last(b).c, hh = last(H) > H[H.length - 2], hl = last(L) > L[L.length - 2];
  // A close beyond the last confirmed swing point sets the new trend before the next pivot forms
  const r = p > last(H) && p > last(L) ? 'Uptrend' : p < last(L) ? 'Downtrend' : hh && hl ? 'Uptrend' : !hh && !hl ? 'Downtrend' : 'Sideways';
  return { result: r, pass: CONFIG.dow.pass === 'notdown' ? r !== 'Downtrend' : r === 'Uptrend' };
}

export function runRPCI(bars, bench, fundamentals) {
  const rows = [
    ['Valuation', valuation(fundamentals)],
    ['Earnings Power', earningsPower(fundamentals)],
    ['Momentum', momentum(bars)],
    ['Price Contraction', priceContraction(bars)],
    ['Timeframe Alignment', timeframeAlignment(bars)],
    ['Outperformance', outperformance(bars, bench)],
    ['Institutional Candles', institutionalCandles(bars)],
    ['Short-term Extension', shortTermExtension(bars)],
    ['Long-term Extension', longTermExtension(bars)],
    ['Stage Analysis', stageAnalysis(bars)],
    ['Dow Theory (W)', dowTheoryWeekly(bars)],
  ].map(([name, r]) => ({ name, ...r }));
  const score = rows.filter(r => r.pass).length, total = rows.filter(r => r.pass !== null).length;
  const pct = total ? score / total : 0;
  // creator's bands on the 11-point scale: 9+ strongly favourable, 7-8 favourable, else wait (scaled when checks are N/A)
  const s11 = total ? score / total * 11 : 0;
  const conditions = s11 >= 8.5 ? 'Strongly favourable' : s11 >= 6.5 ? 'Favourable' : 'Wait on';
  return { rows, score, total, conditions };
}

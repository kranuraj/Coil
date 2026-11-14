#!/usr/bin/env node
// RPCI evaluation layer.
//   node rpci/evaluate.mjs <barsCacheDir>
// Inputs: cached daily bars (scan-all.mjs with RPCI_CACHE), rpci/history/*.json snapshots, rpci/results.json, rpci/sectors.json.
// Outputs: rpci/analytics.json, rpci/portfolio.json, and per-stock probability/sector fields added to results.json.
//
// Evidence, all measured as return vs Nifty 50 ("excess") over 5/20/60 sessions; "hit" = excess > 0:
//  - Backtest: 9 technical checks + raw indicator values on a common date grid (every 5 sessions, ~2 years).
//  - Market regime (Nifty trend), sector strength (industry median 3-month excess), threshold sweeps
//    (tuned on the older 70% of dates, validated on the newer 30%).
//  - Logistic model on all factors, validated walk-forward; its decile hit rates become each stock's probability.
//  - Paper portfolio: every 20 sessions buy the top 10 liquid stocks by the model (retrained only on data known
//    at that date), 2-ATR stop, 0.2% costs. Compared with RPCI-score picks and the Nifty.
//  - Live log: daily snapshots (all 11 checks, point-in-time) scored as they mature.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import * as R from './rpci.mjs';

const CACHE = process.argv[2];
if (!CACHE) { console.error('usage: node rpci/evaluate.mjs <barsCacheDir>'); process.exit(1); }
const HERE = new URL('./', import.meta.url);
const H = [5, 20, 60], STEP = 5, LOOKBACK = 500, WINDOW = 420, CAP = 1, MIN_VAL = 5e6, LIQ = 1e8;
const CHECKS = ['Valuation', 'Earnings Power', 'Momentum', 'Price Contraction', 'Timeframe Alignment', 'Outperformance',
  'Institutional Candles', 'Short-term Extension', 'Long-term Extension', 'Stage Analysis', 'Dow Theory (W)'];
const TECH = [2, 3, 4, 5, 6, 7, 8, 9, 10];
const load = f => JSON.parse(readFileSync(f, 'utf8'));
const toBars = a => a.map(b => Array.isArray(b) ? { t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] } : b);
const dkey = t => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);
const clip = (x, a, b) => Math.max(a, Math.min(b, x));
const last = a => a[a.length - 1];
const t0 = Date.now(), log = m => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const bench = toBars(load(`${CACHE}/^NSEI.json`));
const bIdx = new Map(bench.map((b, i) => [dkey(b.t), i]));
const SECT = existsSync(new URL('./sectors.json', HERE)) ? load(new URL('./sectors.json', HERE)) : {};
const stocks = readdirSync(CACHE).filter(f => f.endsWith('.json') && f !== '^NSEI.json').map(f => {
  const bars = toBars(load(`${CACHE}/${f}`)); return { sym: f.slice(0, -5), bars, at: new Map(bars.map((b, i) => [dkey(b.t), i])) };
});
log(`loaded ${stocks.length} stocks`);

function fwd(bars, i, h) {
  if (i + h >= bars.length) return null;
  const b0 = bIdx.get(dkey(bars[i].t)), b1 = bIdx.get(dkey(bars[i + h].t));
  if (b0 == null || b1 == null) return null;
  return clip(bars[i + h].c / bars[i].c - bench[b1].c / bench[b0].c, -CAP, CAP);
}
const ret = (c, n) => c.length > n ? last(c) / c[c.length - 1 - n] - 1 : NaN;
function regimeAt(bi) {
  const c = bench.slice(Math.max(0, bi - 260), bi + 1).map(b => b.c), s200 = last(R.sma(c, 200)), s50 = R.sma(c, 50);
  const up = last(s50) > s50[s50.length - 21];
  return last(c) > s200 && up ? 'bull' : last(c) < s200 && !up ? 'bear' : 'neutral';
}

// ---------- 1. Backtest on a common date grid ----------
const nB = bench.length, gridIdx = [];
for (let bi = nB - 1; bi >= Math.max(260, nB - LOOKBACK); bi -= STEP) gridIdx.unshift(bi);   // always includes the latest date
const samples = [], today = [];
for (const [g, bi] of gridIdx.entries()) {
  const d = dkey(bench[bi].t), isToday = bi === nB - 1, reg = regimeAt(bi), bwin = bench.slice(Math.max(0, bi - WINDOW), bi + 1), bc = bwin.map(b => b.c);
  const day = [];
  for (const s of stocks) {
    const i = s.at.get(d); if (i == null || i < 250) continue;
    const bars = s.bars, x = bars[i], val = x.c * x.v;
    if (!isToday && val < MIN_VAL) continue;
    const win = bars.slice(Math.max(0, i - WINDOW), i + 1), c = win.map(b => b.c);
    const flags = [R.momentum(win), R.priceContraction(win), R.timeframeAlignment(win), R.outperformance(win, bwin), R.institutionalCandles(win),
      R.shortTermExtension(win), R.longTermExtension(win), R.stageAnalysis(win), R.dowTheoryWeekly(win)];
    const a = R.atr(win, 14), atr = last(a), e21 = last(R.ema(c, 21)), s200 = last(R.sma(c, 200)), w10 = win.slice(-10);
    const hi = Math.max(...w10.map(b => b.h)), lo = Math.min(...w10.map(b => b.l));
    const f = { rsi: last(R.rsi(c)), atrR: last(R.sma(a, 10)) / last(R.sma(a, 50)), range10: (hi - lo) / hi, extA: (x.c - e21) / atr, ext200: x.c / s200 - 1,
      rs63: ret(c, 63) - ret(bc, 63), rs126: ret(c, 126) - ret(bc, 126), inst: +flags[4].result };
    { const n = win.length, hh = Math.max(...win.slice(n - 21, n - 1).map(b => b.h)), av = win.slice(n - 51, n - 1).reduce((t, b) => t + b.v, 0) / 50;
      f.bo = x.c > hh && av && x.v / av >= 1.5 ? 1 : 0; }
    day.push({ d, g, sym: s.sym, i, p: '--' + flags.map(r => r.pass === null ? '-' : r.pass ? '1' : '0').join(''), f, reg, val, atr, c: x.c, e: isToday ? [null, null, null] : H.map(h => fwd(bars, i, h)) });
  }
  // sector strength = industry median 3-month excess return on this date; strong = positive and in the top 40% of sectors
  const bySec = {};
  for (const r of day) { const sc = SECT[r.sym]; if (sc && isFinite(r.f.rs63)) (bySec[sc] ??= []).push(r.f.rs63); }
  const secRS = Object.fromEntries(Object.entries(bySec).filter(([, v]) => v.length >= 3).map(([k, v]) => { v.sort((a, b) => a - b); return [k, v[v.length >> 1]]; }));
  const ranked = Object.entries(secRS).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  for (const r of day) { const sc = SECT[r.sym]; r.sec = sc || null; r.secRS = sc && secRS[sc] != null ? secRS[sc] : null;
    r.secPass = r.secRS == null ? null : r.secRS > 0 && ranked.indexOf(sc) < Math.ceil(ranked.length * 0.4) ? 1 : 0; }
  if (isToday) today.push(...day); else samples.push(...day);
}
const dates = [...new Set(samples.map(x => x.d))].sort(), split = dates[Math.floor(dates.length * 0.7)];
log(`backtest: ${samples.length.toLocaleString()} stock-days on ${dates.length} dates; ${today.length} stocks today; split ${split}`);

// ---------- aggregation helpers ----------
function stat(list, hi) {
  const v = list.map(x => x.e[hi]).filter(x => x != null);
  if (!v.length) return { n: 0 };
  v.sort((a, b) => a - b);
  return { n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length * 100).toFixed(2), med: +(v[v.length >> 1] * 100).toFixed(2), hit: +(v.filter(x => x > 0).length / v.length * 100).toFixed(1) };
}
const allH = list => H.map((_, hi) => stat(list, hi));
const edgeOf = (P, F, hi = 1) => { const a = stat(P, hi), b = stat(F, hi); return a.n && b.n ? +(a.hit - b.hit).toFixed(1) : null; };
function analyse(S, idx) {
  const base = allH(S);
  const criteria = idx.map(k => {
    const P = S.filter(x => x.p[k] === '1'), F = S.filter(x => x.p[k] === '0'), pass = allH(P), fail = allH(F);
    return { k, name: CHECKS[k], pass, fail, edge: H.map((_, hi) => pass[hi].n && fail[hi].n ? +(pass[hi].hit - fail[hi].hit).toFixed(1) : null),
      excess: H.map((_, hi) => pass[hi].n && fail[hi].n ? +(pass[hi].mean - fail[hi].mean).toFixed(2) : null) };
  }).sort((a, b) => (b.edge[1] ?? -99) - (a.edge[1] ?? -99));
  return { base, criteria };
}
const bt = analyse(samples, TECH);
const tscore = p => TECH.filter(k => p[k] === '1').length;
const buckets = Array.from({ length: 10 }, (_, s) => ({ score: s, ...Object.fromEntries(H.map((h, hi) => ['h' + h, stat(samples.filter(x => tscore(x.p) === s), hi)])) }));
function combos(size, minN) {
  const out = [], rec = (start, pick) => {
    if (pick.length === size) { const L = samples.filter(x => pick.every(k => x.p[k] === '1')), s = stat(L, 1);
      if (s.n >= minN) out.push({ checks: pick.map(k => CHECKS[k]), h5: stat(L, 0), h20: s, h60: stat(L, 2) }); return; }
    for (let i = start; i < TECH.length; i++) rec(i + 1, [...pick, TECH[i]]);
  };
  rec(0, []); return out.sort((a, b) => b.h20.hit - a.h20.hit || b.h20.mean - a.h20.mean).slice(0, 12);
}
const qOf = d => d.slice(0, 4) + '-Q' + (Math.floor((+d.slice(5, 7) - 1) / 3) + 1);
const quarters = [...new Set(samples.map(x => qOf(x.d)))].sort();
const stability = TECH.map(k => ({ name: CHECKS[k], q: quarters.map(q => {
  const S = samples.filter(x => qOf(x.d) === q), P = stat(S.filter(x => x.p[k] === '1'), 1), F = stat(S.filter(x => x.p[k] === '0'), 1);
  return P.n > 50 && F.n > 50 ? +(P.hit - F.hit).toFixed(1) : null; }) }));
log('criteria, buckets, combos done');

// ---------- 2. Market regime ----------
const REGS = ['bull', 'neutral', 'bear'];
const regime = { current: today[0]?.reg || regimeAt(nB - 1),
  share: Object.fromEntries(REGS.map(r => [r, +(dates.filter(d => samples.find(x => x.d === d)?.reg === r).length / dates.length * 100).toFixed(0)])),
  base: Object.fromEntries(REGS.map(r => [r, allH(samples.filter(x => x.reg === r))])),
  criteria: TECH.map(k => ({ name: CHECKS[k], edge: Object.fromEntries(REGS.map(r => { const S = samples.filter(x => x.reg === r);
    return [r, S.length > 2000 ? edgeOf(S.filter(x => x.p[k] === '1'), S.filter(x => x.p[k] === '0')) : null]; })) })) };

// ---------- 3. Sector strength factor ----------
const withSec = samples.filter(x => x.secPass != null);
const sector = { name: 'Sector strength', coverage: +(withSec.length / samples.length * 100).toFixed(0),
  pass: allH(withSec.filter(x => x.secPass === 1)), fail: allH(withSec.filter(x => x.secPass === 0)),
  edge: H.map((_, hi) => edgeOf(withSec.filter(x => x.secPass === 1), withSec.filter(x => x.secPass === 0), hi)),
  byRegime: Object.fromEntries(REGS.map(r => { const S = withSec.filter(x => x.reg === r); return [r, S.length > 2000 ? edgeOf(S.filter(x => x.secPass === 1), S.filter(x => x.secPass === 0)) : null]; })),
  today: Object.entries(today.reduce((m, r) => (r.sec && r.secRS != null && (m[r.sec] = r.secRS), m), {})).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ sector: k, rs63: +(v * 100).toFixed(1) })) };

// ---------- 3b. Triggers: breakout today, and fresh setups (score jumped vs 4 grid steps / ~20 sessions earlier) ----------
const byKey = new Map(samples.map(x => [x.sym + '|' + x.g, x]));
for (const x of samples) { const old = byKey.get(x.sym + '|' + (x.g - 4)); x.fresh = old ? (tscore(x.p) >= 7 && tscore(old.p) <= 5 ? 1 : 0) : null; }
const strongS = samples.filter(x => tscore(x.p) >= 7);
const trigger = (name, desc, P, F) => ({ name, desc, pass: allH(P), fail: allH(F), edge: H.map((_, hi) => edgeOf(P, F, hi)) });
const triggers = [
  trigger('Breakout today', 'Close above the 20-session high on 1.5x+ volume, all stocks', samples.filter(x => x.f.bo === 1), samples.filter(x => x.f.bo === 0)),
  trigger('Breakout + strong score', 'Breakout among stocks passing 7+ of 9 technical checks', strongS.filter(x => x.f.bo === 1), strongS.filter(x => x.f.bo === 0)),
  trigger('Fresh setup', 'Score jumped to 7+ from 5 or less within ~20 sessions, vs stocks that were already strong', strongS.filter(x => x.fresh === 1), strongS.filter(x => x.fresh === 0)),
];
log(`triggers: ${triggers.map(t => `${t.name} ${t.edge[1]}pp (n ${t.pass[1].n})`).join(' · ')}`);

// ---------- 4. Threshold tuning (train on older 70% of dates, validate on newer 30%) ----------
const train = samples.filter(x => x.d < split), test = samples.filter(x => x.d >= split);
const SWEEPS = [
  { check: 'Price Contraction', label: '10-day range', f: 'range10', grid: [.04, .06, .08, .1, .12, .15, .2, .3], cur: ['le', .12], fmt: v => `${(v * 100).toFixed(0)}%` },
  { check: 'Price Contraction', label: 'ATR10 / ATR50', f: 'atrR', grid: [.5, .6, .7, .75, .8, .9, 1, 1.2], cur: ['le', .75], fmt: v => v.toFixed(2) },
  { check: 'Short-term Extension', label: 'ATRs above EMA21', f: 'extA', grid: [0, 1, 2, 3, 4, 5], cur: ['le', 3], fmt: v => v.toFixed(0) },
  { check: 'Long-term Extension', label: 'above SMA200', f: 'ext200', grid: [0, .1, .2, .3, .4, .6, .8], cur: ['le', .4], fmt: v => `${(v * 100).toFixed(0)}%` },
  { check: 'Momentum', label: 'RSI(14)', f: 'rsi', grid: [40, 45, 50, 55, 60, 65, 70], cur: ['ge', 55], fmt: v => v.toFixed(0) },
  { check: 'Outperformance', label: '3-month excess vs Nifty', f: 'rs63', grid: [-.1, -.05, 0, .05, .1, .2], cur: ['ge', 0], fmt: v => `${(v * 100).toFixed(0)}%` },
  { check: 'Institutional Candles', label: 'count in 50 sessions', f: 'inst', grid: [1, 2], cur: ['ge', 1], fmt: v => v.toFixed(0) },
];
const tuning = SWEEPS.map(sw => {
  const ev = (S, op, t) => { const ok = x => isFinite(x.f[sw.f]) && (op === 'le' ? x.f[sw.f] <= t : x.f[sw.f] >= t);
    const P = S.filter(ok), F = S.filter(x => isFinite(x.f[sw.f]) && !ok(x)); return { e: edgeOf(P, F), share: +(P.length / S.length * 100).toFixed(0) }; };
  const rows = [];
  for (const op of ['le', 'ge']) for (const t of sw.grid) { const tr = ev(train, op, t); if (tr.e == null || tr.share < 3 || tr.share > 97) continue; rows.push({ op, t, rule: `${op === 'le' ? '≤' : '≥'} ${sw.fmt(t)}`, train: tr.e, test: ev(test, op, t).e, share: tr.share }); }
  rows.sort((a, b) => b.train - a.train);
  const cur = ev(train, ...sw.cur), curT = ev(test, ...sw.cur), best = rows[0];
  return { check: sw.check, label: sw.label, current: { rule: `${sw.cur[0] === 'le' ? '≤' : '≥'} ${sw.fmt(sw.cur[1])}`, train: cur.e, test: curT.e },
    best: best && { rule: best.rule, train: best.train, test: best.test, share: best.share }, holds: best ? best.test > (curT.e ?? -99) && best.test > 0 : false, top: rows.slice(0, 5) };
});
log('regime, sector, tuning done');

// ---------- 5. Logistic model ----------
const FEATS = [...TECH.map(k => ['RPCI · ' + CHECKS[k], x => x.p[k] === '1' ? 1 : 0]),
  ['Sector strong', x => x.secPass === 1 ? 1 : 0], ['Sector 3M excess', x => clip(x.secRS ?? 0, -.3, .3)],
  ['Regime bull', x => x.reg === 'bull' ? 1 : 0], ['Regime bear', x => x.reg === 'bear' ? 1 : 0],
  ['RSI', x => x.f.rsi / 100], ['ATRs above EMA21', x => clip(x.f.extA, -4, 8)], ['% above SMA200', x => clip(x.f.ext200, -.6, 1.5)],
  ['3M excess', x => clip(x.f.rs63, -.6, 1)], ['6M excess', x => clip(x.f.rs126, -.8, 1.5)], ['ATR10/ATR50', x => clip(x.f.atrR, 0, 3)],
  ['10-day range', x => clip(x.f.range10, 0, .5)], ['Liquidity (log value)', x => Math.log10(x.val + 1) / 3]];
const vecF = (x, F) => F.map(([, fn]) => { const v = fn(x); return isFinite(v) ? v : 0; });
function fit(S, iters = 250, F = FEATS, lr = 0.5, l2 = 1e-3) {
  const vec = x => vecF(x, F), X = S.map(vec), y = S.map(x => x.e[1] > 0 ? 1 : 0), m = F.length, n = X.length;
  const mu = Array(m).fill(0), sd = Array(m).fill(0);
  for (const r of X) r.forEach((v, j) => mu[j] += v / n);
  for (const r of X) r.forEach((v, j) => sd[j] += (v - mu[j]) ** 2 / n);
  sd.forEach((v, j) => sd[j] = Math.sqrt(v) || 1);
  const Z = X.map(r => r.map((v, j) => (v - mu[j]) / sd[j])), w = Array(m).fill(0); let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(m).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) { let z = b; const r = Z[i]; for (let j = 0; j < m; j++) z += w[j] * r[j];
      const e = 1 / (1 + Math.exp(-z)) - y[i]; gb += e; for (let j = 0; j < m; j++) gw[j] += e * r[j]; }
    b -= lr * gb / n; for (let j = 0; j < m; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  return { w, b, mu, sd, score: x => { const v = vec(x); let z = b; for (let j = 0; j < m; j++) z += w[j] * (v[j] - mu[j]) / sd[j]; return z; } };
}
function auc(S, sc) {
  const L = S.map(x => [sc(x), x.e[1] > 0]).sort((a, b) => a[0] - b[0]); let rank = 0, pos = 0, sumR = 0;
  for (const [, y] of L) { rank++; if (y) { pos++; sumR += rank; } }
  const neg = L.length - pos; return +((sumR - pos * (pos + 1) / 2) / (pos * neg)).toFixed(3);
}
function deciles(S, sc) {
  const L = S.map(x => ({ s: sc(x), e: x.e[1] })).sort((a, b) => a.s - b.s);
  return Array.from({ length: 10 }, (_, k) => { const B = L.slice(Math.floor(k * L.length / 10), Math.floor((k + 1) * L.length / 10));
    return { lo: B[0].s, hi: last(B).s, n: B.length, hit: +(B.filter(x => x.e > 0).length / B.length * 100).toFixed(1), mean: +(B.reduce((a, x) => a + x.e, 0) / B.length * 100).toFixed(2) }; });
}
const m20 = S => S.filter(x => x.e[1] != null);
// Candidate scorers, validated walk-forward (train before the split, test after). The best one on unseen dates is used.
const gapDate = dates[Math.max(0, dates.indexOf(split) - 4)], trainM = m20(samples.filter(x => x.d < gapDate)), testM = m20(test);
const rpciScore = x => tscore(x.p) + clip(x.f.rs63 || 0, -1, 1) * 1e-3;
const RPCI_F = FEATS.slice(0, 9).concat(FEATS.filter(f => f[0].startsWith('Regime')));
const CANDS = [
  { id: 'rpci', name: 'RPCI score (technical passes)', make: () => rpciScore },
  { id: 'rpciW', name: 'Weighted RPCI checks', make: S => fit(S, 200, RPCI_F).score },
  { id: 'all', name: 'All factors (checks + indicators + sector + regime)', make: S => fit(S, 200).score },
];
const cands = CANDS.map(c => { const sc = c.make(trainM), dec = deciles(testM, sc); return { id: c.id, name: c.name, auc: auc(testM, sc), top: last(dec), calib: dec }; });
const best = [...cands].sort((a, b) => b.top.hit - a.top.hit || b.auc - a.auc)[0], chosen = CANDS.find(c => c.id === best.id);
const model = { trainedTo: gapDate, testFrom: split, testSamples: testM.length, base: stat(testM, 1), candidates: cands.map(({ calib, ...c }) => c), chosen: best.id, chosenName: best.name, calib: best.calib };
const finalScore = chosen.make(m20(samples)), finalCal = best.calib;   // calibrated on unseen dates only
if (best.id !== 'rpci') model.weights = (() => { const M = fit(m20(samples), 200, best.id === 'rpciW' ? RPCI_F : FEATS), F = best.id === 'rpciW' ? RPCI_F : FEATS;
  return F.map((f, j) => ({ name: f[0], w: +M.w[j].toFixed(3) })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)); })();
const probOf = (z, cal) => { const k = cal.findIndex(c => z <= c.hi), b = cal[k < 0 ? 9 : k]; return { p: b.hit, x: b.mean, decile: (k < 0 ? 9 : k) + 1 }; };
log(`model candidates: ${cands.map(c => `${c.id} top ${c.top.hit}% auc ${c.auc}`).join(' · ')} → using ${best.id}`);

// ---------- 6. Paper portfolio (walk-forward) ----------
const N = 10, HOLD = 20, STOP = 2, COST = 0.002, STEPS = HOLD / STEP;
const symBars = new Map(stocks.map(s => [s.sym, s.bars]));
function trade(r) {
  const bars = symBars.get(r.sym), i = r.i, stop = r.c - STOP * r.atr;
  if (i + HOLD >= bars.length) return null;
  for (let k = i + 1; k <= i + HOLD; k++) if (bars[k].l <= stop) return { r: Math.min(stop, bars[k].o) / r.c - 1 - COST, stopped: true, exit: dkey(bars[k].t) };
  return { r: bars[i + HOLD].c / r.c - 1 - COST, stopped: false, exit: dkey(bars[i + HOLD].t) };
}
const rebal = dates.filter((_, k) => k >= Math.floor(dates.length * 0.35) && (k - Math.floor(dates.length * 0.35)) % STEPS === 0);
const strategies = { model: [], modelRegime: [], rpci: [] }, periods = [];
for (const d of rebal) {
  const k = dates.indexOf(d), known = m20(samples.filter(x => dates.indexOf(x.d) <= k - STEPS));
  const msc = chosen.make(known), cand = samples.filter(x => x.d === d && x.val >= LIQ);
  if (!cand.length) continue;
  const reg = cand[0].reg, bi = bIdx.get(d);
  if (bi + HOLD >= nB) break;
  const nifty = bench[bi + HOLD].c / bench[bi].c - 1;
  const pick = sc => [...cand].sort((a, b) => sc(b) - sc(a)).slice(0, N).map(r => ({ sym: r.sym, ...trade(r) })).filter(t => t.r != null);
  const pm = pick(msc), pr = pick(rpciScore), avg = L => L.length ? L.reduce((a, t) => a + t.r, 0) / L.length : 0;
  periods.push({ d, reg, nifty: +nifty.toFixed(4), model: +avg(pm).toFixed(4), modelRegime: reg === 'bear' ? 0 : +avg(pm).toFixed(4), rpci: +avg(pr).toFixed(4),
    picks: pm.map(t => [t.sym, +(t.r * 100).toFixed(1), t.stopped ? 1 : 0]) });
  strategies.model.push(...pm); strategies.rpci.push(...pr); if (reg !== 'bear') strategies.modelRegime.push(...pm);
}
function curve(key) {
  let eq = 1, peak = 1, dd = 0; const pts = [{ d: periods[0]?.d, v: 1 }];
  for (const p of periods) { eq *= 1 + p[key]; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); pts.push({ d: p.d, v: +eq.toFixed(4) }); }
  const yrs = periods.length * HOLD / 250;
  return { total: +((eq - 1) * 100).toFixed(1), cagr: yrs ? +((eq ** (1 / yrs) - 1) * 100).toFixed(1) : null, maxDD: +(dd * 100).toFixed(1), pts };
}
const tradesStat = L => ({ n: L.length, win: L.length ? +(L.filter(t => t.r > 0).length / L.length * 100).toFixed(1) : null,
  avg: L.length ? +(L.reduce((a, t) => a + t.r, 0) / L.length * 100).toFixed(2) : null, stopped: L.length ? +(L.filter(t => t.stopped).length / L.length * 100).toFixed(0) : null });
const curReg = regime.current;
const capital = 1e6, riskPct = 0.01, maxPos = 0.1;
const picksToday = today.filter(r => r.val >= LIQ).map(r => ({ r, z: finalScore(r) })).sort((a, b) => b.z - a.z).slice(0, N).map(({ r, z }) => {
  const stop = r.c - STOP * r.atr, qty = Math.max(0, Math.min(Math.floor(capital * riskPct / (r.c - stop)), Math.floor(capital * maxPos / r.c)));
  return { sym: r.sym, sector: r.sec, price: +r.c.toFixed(2), stop: +stop.toFixed(2), stopPct: +((stop / r.c - 1) * 100).toFixed(1), qty, amount: Math.round(qty * r.c), risk: Math.round(qty * (r.c - stop)), ...probOf(z, finalCal) };
});
const portfolio = { asOf: dkey(bench[nB - 1].t), rules: { n: N, hold: HOLD, stopATR: STOP, cost: COST, minValueCr: LIQ / 1e7, capital, riskPct, maxPos },
  regime: curReg, action: curReg === 'bear' ? 'Stay in cash: Nifty is in a downtrend (regime filter).' : 'Buy the list below, equal risk per position.',
  curves: { model: curve('model'), modelRegime: curve('modelRegime'), rpci: curve('rpci'), nifty: curve('nifty') },
  trades: { model: tradesStat(strategies.model), modelRegime: tradesStat(strategies.modelRegime), rpci: tradesStat(strategies.rpci) },
  periods: [...periods].reverse(), picks: picksToday };
log(`portfolio: ${periods.length} periods · model ${portfolio.curves.model.total}% · +regime ${portfolio.curves.modelRegime.total}% · RPCI ${portfolio.curves.rpci.total}% · Nifty ${portfolio.curves.nifty.total}%`);

// ---------- 7. Live log ----------
const HIST = new URL('./history/', HERE), live = [];
const snaps = existsSync(HIST) ? readdirSync(HIST).filter(f => f.endsWith('.json')).sort() : [];
for (const f of snaps) {
  const s = load(new URL(f, HIST));
  for (const [sym, score, total, p] of s.s) {
    const bars = symBars.get(sym); if (!bars) continue;
    const i = stocks.find(x => x.sym === sym).at.get(s.d); if (i == null) continue;
    live.push({ d: s.d, sym, p, score, total, top: (s.top || []).includes(sym), e: H.map(h => fwd(bars, i, h)) });
  }
}
const liveA = live.length ? analyse(live, [...Array(11).keys()]) : null;
const review = snaps.map(f => { const s = load(new URL(f, HIST)), L = live.filter(x => x.d === s.d);
  return { d: s.d, n: L.length, top: L.filter(x => x.top).length, all: allH(L), topH: allH(L.filter(x => x.top)), sf: allH(L.filter(x => x.total && x.score / x.total >= .85)) }; }).reverse();

// ---------- annotate results.json and today's snapshot ----------
const RES = new URL('./results.json', HERE), res = load(RES), tmap = new Map(today.map(r => [r.sym, r]));
for (const r of res.results) {
  const t = tmap.get(r.symbol); delete r.prob; delete r.decile; delete r.raw; delete r.exp20;
  if (!t) continue;
  const z = finalScore(t), q = probOf(z, finalCal);
  Object.assign(r, { prob: q.p, exp20: q.x, decile: q.decile, raw: +z.toFixed(4), sector: t.sec, secRS: t.secRS == null ? null : +(t.secRS * 100).toFixed(1), secPass: t.secPass });
}
res.regime = curReg;
writeFileSync(RES, JSON.stringify(res));
const snapF = new URL(`${portfolio.asOf}.json`, HIST);
if (existsSync(snapF)) { const s = load(snapF); s.top = res.results.filter(r => r.decile >= 10 && r.value >= 10).map(r => r.symbol); s.regime = curReg; writeFileSync(snapF, JSON.stringify(s)); }

writeFileSync(new URL('./portfolio.json', HERE), JSON.stringify(portfolio));
writeFileSync(new URL('./analytics.json', HERE), JSON.stringify({ asOf: res.asOf, horizons: H, checks: CHECKS,
  method: { step: STEP, lookbackSessions: LOOKBACK, cap: CAP, minTradedValue: '₹50 lakh', split },
  backtest: { samples: samples.length, from: dates[0], to: last(dates), ...bt, buckets, pairs: combos(2, 2000), triples: combos(3, 1000), quarters, stability, calib: model.calib },
  regime, sector, tuning, model, triggers,
  live: { snapshots: snaps.length, samples: live.length, matured: H.map((_, hi) => live.filter(x => x.e[hi] != null).length), analysis: liveA, review } }));
log(`done · regime ${curReg} · top decile today ${res.results.filter(r => r.decile >= 10).length}`);

#!/usr/bin/env node
// Daily read: day-over-day changes, breadth history, market regime (MA stack), sector rotation, base breakouts.
//   node daily.mjs <barsCacheDir>       (run after scan-all.mjs, before or after evaluate.mjs)
// Rebuilds every stock's score for the last HIST sessions from cached prices (fundamental checks held at today's values),
// so changes are available without waiting for daily snapshots. Writes daily.json and adds fields to results.json:
//   prev (score last session), base {len, hi, pct} for today's base breakouts.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as R from './rpci.mjs';

const CACHE = process.argv[2];
if (!CACHE) { console.error('usage: node daily.mjs <barsCacheDir>'); process.exit(1); }
const HERE = new URL('./', import.meta.url), HIST = 21, ROT = 30, WINDOW = 420;
const BASE = { band: 0.30, minLen: 20 };   // consolidation: longest run within a 30% high-low band, >= 20 sessions
const load = f => JSON.parse(readFileSync(f, 'utf8'));
const toBars = a => a.map(b => Array.isArray(b) ? { t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] } : b);
const dkey = t => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);
const last = a => a[a.length - 1];

const bench = toBars(load(`${CACHE}/^NSEI.json`)), bIdx = new Map(bench.map((b, i) => [dkey(b.t), i]));
const RES = new URL('./results.json', HERE), res = load(RES);
const SECT = existsSync(new URL('./sectors.json', HERE)) ? load(new URL('./sectors.json', HERE)) : {};
const nB = bench.length, dates = bench.slice(nB - HIST).map(b => dkey(b.t));

const techFns = [R.momentum, R.priceContraction, R.timeframeAlignment, null, R.institutionalCandles, R.shortTermExtension, R.longTermExtension, R.stageAnalysis, R.dowTheoryWeekly];
function techScore(win, bwin) { let n = 0, stage2 = false;
  techFns.forEach((fn, j) => { const r = fn ? fn(win) : R.outperformance(win, bwin); if (r.pass) n++; if (j === 7) stage2 = !!r.pass; }); return { n, stage2 }; }
function baseBreakout(b, i) {   // base = longest run ending at i-1 inside a BASE.band high-low band; breakout = close[i] above its high, close[i-1] not
  let hi = -1, lo = Infinity, L = 0;
  for (let k = i - 1; k >= 0; k--) { hi = Math.max(hi, b[k].h); lo = Math.min(lo, b[k].l); if ((hi - lo) / hi > BASE.band) break; L++; }
  if (L < BASE.minLen) return null;
  const H = Math.max(...b.slice(i - L, i).map(x => x.h));
  return b[i].c > H && b[i - 1].c <= H ? { len: L, hi: +H.toFixed(2), pct: +((b[i].c / H - 1) * 100).toFixed(1) } : null;
}

const series = dates.map(() => ({ n9: 0, sum: 0, cnt: 0 })), bySec = {}, t0 = Date.now();
let done = 0;
for (const r of res.results) {
  delete r.prev; delete r.base;
  if (r.stale || !existsSync(`${CACHE}/${r.symbol}.json`)) continue;
  const bars = toBars(load(`${CACHE}/${r.symbol}.json`)), at = new Map(bars.map((b, i) => [dkey(b.t), i]));
  const fund = r.rows.slice(0, 2).filter(x => x[1] === 1).length, fundN = r.rows.slice(0, 2).filter(x => x[1] !== null).length;
  const sc = [];
  dates.forEach((d, k) => {
    const i = at.get(d), bi = bIdx.get(d); if (i == null || i < 250) { sc.push(null); return; }
    const t = techScore(bars.slice(Math.max(0, i - WINDOW), i + 1), bench.slice(Math.max(0, bi - WINDOW), bi + 1));
    const s = t.n + fund; sc.push(s);
    if (fundN === 2) { series[k].cnt++; series[k].sum += s; if (s >= 9) series[k].n9++; }
  });
  if (sc.at(-2) != null) r.prev = sc.at(-2);
  // sector rotation: Stage 2 now vs ROT sessions ago
  const sec = SECT[r.symbol], n = bars.length;
  if (sec && n > 250 + ROT) {
    const old = R.stageAnalysis(bars.slice(Math.max(0, n - 1 - ROT - WINDOW), n - ROT)).pass;
    (bySec[sec] ??= { n: 0, now: 0, then: 0 }); bySec[sec].n++; if (r.rows[9][1] === 1) bySec[sec].now++; if (old) bySec[sec].then++;
  }
  if (r.rows[9][1] === 1 && n > BASE.minLen + 2) { const bb = baseBreakout(bars, n - 1); if (bb) r.base = bb; }
  if (++done % 500 === 0) console.error(`${done} stocks · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// regime from the Nifty 50 moving-average stack
const nc = bench.map(b => b.c), ma = n => last(R.sma(nc, n)), px = last(nc);
const lv = [['Nifty', px], ['200', ma(200)], ['50', ma(50)], ['20', ma(20)]].sort((a, b) => b[1] - a[1]);
const regime = px > ma(20) && px > ma(50) && px > ma(200) ? 'Uptrend' : px < ma(20) && px < ma(50) && px < ma(200) ? 'Downtrend' : 'Sideways';   // creator's rule: Nifty above all three averages = uptrend

const full = res.results.filter(r => r.prev != null && r.total === 11), cur9 = r => r.score >= 9;
const up = full.filter(r => r.score > r.prev), down = full.filter(r => r.score < r.prev);
const n9 = res.results.filter(r => r.total === 11 && cur9(r)).length, s9 = series.map(x => x.n9);
const rot = Object.entries(bySec).filter(([, v]) => v.n >= 10).map(([k, v]) => ({ sector: k, n: v.n, share: Math.round(v.now / v.n * 100), chg: +((v.now - v.then) / v.n * 100).toFixed(1) }))
  .sort((a, b) => b.chg - a.chg);
const daily = { date: last(dates), regime: { label: regime, stack: lv.map(x => x[0]).join(' > '), close: +px.toFixed(2), ma20: +ma(20).toFixed(2), ma50: +ma(50).toFixed(2), ma200: +ma(200).toFixed(2) },
  n9, n9Prev: s9.at(-2), mean: +(full.reduce((t, r) => t + r.score, 0) / (full.length || 1)).toFixed(2),
  meanPrev: +(full.reduce((t, r) => t + r.prev, 0) / (full.length || 1)).toFixed(2),
  up: up.length, down: down.length, same: full.length - up.length - down.length,
  new9: full.filter(r => cur9(r) && r.prev < 9).length, lost9: full.filter(r => !cur9(r) && r.prev >= 9).length,
  history: dates.map((d, k) => ({ d, n9: series[k].n9, mean: series[k].cnt ? +(series[k].sum / series[k].cnt).toFixed(2) : null })),
  sectors: { rising: rot.filter(x => x.chg > 0), falling: rot.filter(x => x.chg < 0).reverse() },
  bases: res.results.filter(r => r.base).length };
res.regime2 = regime;
writeFileSync(RES, JSON.stringify(res));
writeFileSync(new URL('./daily.json', HERE), JSON.stringify(daily));
console.error(`daily: ${daily.date} · ${n9} at 9+ (prev ${daily.n9Prev}) · up ${daily.up} / down ${daily.down} · new9 ${daily.new9} lost9 ${daily.lost9} · bases ${daily.bases} · ${regime} (${daily.regime.stack}) · ${((Date.now() - t0) / 1000).toFixed(0)}s`);

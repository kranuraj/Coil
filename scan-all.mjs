#!/usr/bin/env node
// Scan every NSE equity. Usage: node scan-all.mjs EQUITY_L.csv out.json [concurrency]
// EQUITY_L.csv: https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const CACHE = process.env.RPCI_CACHE;   // optional: directory to save daily bars for evaluate.mjs
if (CACHE) mkdirSync(CACHE, { recursive: true });
import { runRPCI, atr as ATR } from './rpci.mjs';
import { readdirSync, existsSync } from 'node:fs';
import { getBars, getFundamentals } from './data.mjs';
const [csv, outFile = 'results.json', conc = 12] = process.argv.slice(2);
const list = readFileSync(csv, 'utf8').trim().split('\n').slice(1).map(l => l.split(','))
  .filter(c => ['EQ', 'BE', 'BZ'].includes(c[2]?.trim())).map(c => ({ symbol: c[0].trim(), name: c[1].trim(), series: c[2].trim() }));
const HIST = new URL('./history/', import.meta.url), PREV = new Map();
if (existsSync(HIST)) { const fs = readdirSync(HIST).filter(x => x.endsWith('.json')).sort(); const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const lastF = fs.filter(x => x.slice(0, 10) < today).pop(); if (lastF) for (const [sym, score] of JSON.parse(readFileSync(new URL(lastF, HIST))).s) PREV.set(sym, score); }
const bench = await getBars('^NSEI');
if (CACHE) writeFileSync(`${CACHE}/^NSEI.json`, JSON.stringify(bench));
const results = []; let i = 0, done = 0, failed = 0;
async function worker() {
  while (i < list.length) {
    const s = list[i++];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const bars = await getBars(s.symbol + '.NS');
        if (bars.length < 60) throw new Error('short history');
        if (CACHE) writeFileSync(`${CACHE}/${s.symbol}.json`, JSON.stringify(bars.map(b => [b.t, +b.o.toFixed(2), +b.h.toFixed(2), +b.l.toFixed(2), +b.c.toFixed(2), b.v])));
        const r = runRPCI(bars, bench, await getFundamentals(s.symbol + '.NS', bars[bars.length - 1].c));
        const lastBar = bars[bars.length - 1], prev = bars[bars.length - 2];
        // breakout trigger: close above the prior 20-session high on >= 1.5x the 50-session average volume
        const n = bars.length, hh20 = Math.max(...bars.slice(n - 21, n - 1).map(b => b.h)), av50 = bars.slice(n - 51, n - 1).reduce((t, b) => t + b.v, 0) / 50;
        const vr = av50 ? lastBar.v / av50 : 0, bo = lastBar.c > hh20 && vr >= 1.5 ? 1 : 0, atr14 = ATR(bars, 14).at(-1);
        results.push({ ...s, price: +lastBar.c.toFixed(2), chg: +((lastBar.c / prev.c - 1) * 100).toFixed(2),
          volume: lastBar.v, value: Math.round(lastBar.c * lastBar.v / 1e5) / 100,  // ₹ crore traded
          score: r.score, total: r.total, conditions: r.conditions,
          atr: +atr14.toFixed(2), bo, vr: +vr.toFixed(2), prev: PREV.get(s.symbol) ?? null,
          rows: r.rows.map(x => [x.result, x.pass === null ? null : x.pass ? 1 : 0, x.detail || '']) });
        break;
      } catch (e) { if (attempt === 2 || /No data|short/.test(e.message)) { failed++; break; } await new Promise(r => setTimeout(r, 1000)); }
    }
    if (++done % 200 === 0) console.error(`${done}/${list.length} (failed ${failed})`);
  }
}
await Promise.all(Array.from({ length: +conc }, worker));
results.sort((a, b) => b.score / (b.total || 1) - a.score / (a.total || 1) || b.value - a.value);
writeFileSync(outFile, JSON.stringify({ asOf: new Date().toISOString(), benchmark: '^NSEI', scanned: list.length, failed,
  checks: ['Valuation', 'Earnings Power', 'Momentum', 'Price Contraction', 'Timeframe Alignment', 'Outperformance', 'Institutional Candles', 'Short-term Extension', 'Long-term Extension', 'Stage Analysis', 'Dow Theory (W)'], results }));
console.error(`done: ${results.length} scored, ${failed} failed`);
// Daily snapshot for the evaluation layer: history/YYYY-MM-DD.json (pass pattern per stock, point-in-time incl. fundamentals)
const day = new Date(bench[bench.length - 1].t + 5.5 * 3600e3).toISOString().slice(0, 10);
mkdirSync(new URL('./history/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./history/${day}.json`, import.meta.url), JSON.stringify({ d: day, s: results.map(r =>
  [r.symbol, r.score, r.total, r.rows.map(x => x[1] === null ? '-' : x[1]).join(''), r.price, r.value]) }));
console.error(`snapshot history/${day}.json`);

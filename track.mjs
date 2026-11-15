#!/usr/bin/env node
// Live forward tracking of both strategy profiles.
//   node track.mjs <barsCacheDir>        (daily, after scan-all.mjs and daily.mjs)
// For each profile: today's top 10 liquid stocks (>= Rs 10 Cr traded) by RPCI score (ties: 3-month excess return),
// plus today's base breakouts. Saved to history/strategies/<date>.json with entry prices; weekly.mjs scores them later.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import * as R from './rpci.mjs';

const CACHE = process.argv[2];
if (!CACHE) { console.error('usage: node track.mjs <barsCacheDir>'); process.exit(1); }
const HERE = new URL('./', import.meta.url), N = 10, LIQ = 10, WINDOW = 420;
const load = f => JSON.parse(readFileSync(f, 'utf8'));
const toBars = a => a.map(b => Array.isArray(b) ? { t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] } : b);
const dkey = t => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);
const bench = toBars(load(`${CACHE}/^NSEI.json`)), date = dkey(bench.at(-1).t), bwin = bench.slice(-WINDOW);
const res = load(new URL('./results.json', HERE)).results.filter(r => !r.stale && r.value >= LIQ && existsSync(`${CACHE}/${r.symbol}.json`));
const bars = new Map(res.map(r => [r.symbol, toBars(load(`${CACHE}/${r.symbol}.json`)).slice(-WINDOW)]));

const out = { date, nifty: bench.at(-1).c, profiles: {} };
for (const name of Object.keys(R.PROFILES)) {
  R.useProfile(name);
  const scored = res.map(r => { const b = bars.get(r.symbol), rows = R.runRPCI(b, bwin, null).rows;
    const fund = r.fu ? [R.valuation(r.fu), R.earningsPower(r.fu)].filter(x => x.pass).length : r.rows.slice(0, 2).filter(x => x[1] === 1).length, rs = R.outperformance(b, bwin);
    return { s: r.symbol, score: rows.slice(2).filter(x => x.pass).length + fund, rs: parseFloat((rs.detail || '').match(/63d (-?[\d.]+)/)?.[1] || 0), p: r.price }; });
  scored.sort((a, b) => b.score - a.score || b.rs - a.rs);
  out.profiles[name] = { label: R.PROFILES[name].label, n9: scored.filter(x => x.score >= 9).length,
    top: scored.slice(0, N).map(x => [x.s, x.p, x.score]) };
}
R.useProfile('v2');
out.profiles.v2.bases = load(new URL('./results.json', HERE)).results.filter(r => r.base && r.value >= LIQ).map(r => [r.symbol, r.price, r.score]);
const dir = new URL('./history/strategies/', HERE); mkdirSync(dir, { recursive: true });
writeFileSync(new URL(`${date}.json`, dir), JSON.stringify(out));
console.error(`track ${date}: ` + Object.entries(out.profiles).map(([k, v]) => `${k} top ${v.top.map(x => x[0]).join(',')}`).join(' | '));

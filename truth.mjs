#!/usr/bin/env node
// Agreement of each strategy profile with the creator's published results (creator-truth.json).
//   node truth.mjs <barsCacheDir>   -> prints a table and writes truth.json (used by weekly.mjs when present)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as R from './rpci.mjs';
const CACHE = process.argv[2], HERE = new URL('./', import.meta.url);
const T = JSON.parse(readFileSync(new URL('./creator-truth.json', HERE), 'utf8')), res = JSON.parse(readFileSync(new URL('./results.json', HERE), 'utf8')).results;
const C = ['VAL', 'ERN', 'MOM', 'CON', 'TFA', 'OPF', 'INS', 'STX', 'LTX', 'STG', 'DOW'];
const toBars = a => a.map(b => Array.isArray(b) ? { t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] } : b);
const bench = toBars(JSON.parse(readFileSync(`${CACHE}/^NSEI.json`, 'utf8'))).slice(-420), m = new Map(res.map(r => [r.symbol, r]));
const bars = s => existsSync(`${CACHE}/${s}.json`) ? toBars(JSON.parse(readFileSync(`${CACHE}/${s}.json`, 'utf8'))).slice(-420) : null;
const out = {};
for (const p of Object.keys(R.PROFILES)) { R.useProfile(p); let ok = 0, n = 0, gap = 0, gn = 0; const miss = [];
  for (const [s, fails] of Object.entries(T.stocks)) { const b = bars(s), r = m.get(s); if (!b || !r) continue;
    const rows = R.runRPCI(b, bench, r.fu || null).rows; rows.forEach((x, i) => { if (x.pass === null) return; n++; const f = !x.pass; if (f === fails.includes(C[i])) ok++; else miss.push(s + ':' + C[i]); }); }
  for (const [s, sc] of Object.entries(T.scores)) { const b = bars(s), r = m.get(s); if (!b || !r) continue; const v = R.runRPCI(b, bench, r.fu || null).score; gap += Math.abs(v - sc); gn++; }
  out[p] = { checks: `${ok}/${n}`, scoreGap: +(gap / (gn || 1)).toFixed(2), stocks: gn, misses: miss };
  console.log(p.padEnd(3), 'checks', out[p].checks, '| avg score gap', out[p].scoreGap, 'on', gn, 'stocks | misses:', miss.join(' ') || 'none'); }
R.useProfile('v2'); writeFileSync(new URL('./truth.json', HERE), JSON.stringify(out));

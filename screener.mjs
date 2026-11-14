#!/usr/bin/env node
// Usage: node screener.mjs RELIANCE.NS TCS.NS ...   [--bench ^NSEI] [--min 8] [--file symbols.txt]
import { readFileSync } from 'node:fs';
import { runRPCI } from './rpci.mjs';
import { getBars, getFundamentals } from './data.mjs';
const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : null; };
const bench = opt('--bench') || '^NSEI', min = +(opt('--min') || 0), file = opt('--file'), json = a.includes('--json') && a.splice(a.indexOf('--json'), 1);
const syms = file ? readFileSync(file, 'utf8').split(/\s+/).filter(Boolean) : a;
if (!syms.length) { console.log('usage: node screener.mjs SYMBOL... [--bench ^NSEI] [--min 8] [--file list.txt] [--json]'); process.exit(1); }
const benchBars = await getBars(bench);
const out = [];
let b;
for (const s of syms) {
  try { const r = runRPCI(b = await getBars(s), benchBars, await getFundamentals(s, b[b.length - 1].c)); out.push({ symbol: s, ...r }); }
  catch (e) { console.error(`${s}: ${e.message}`); }
}
out.sort((x, y) => y.score - x.score);
if (json) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
for (const r of out.filter(r => r.score >= min)) {
  console.log(`\n${r.symbol}  ${r.score}/${r.total}  ${r.conditions}`);
  for (const x of r.rows) console.log(`  ${x.name.padEnd(22)} ${String(x.result).padEnd(20)} ${x.pass === null ? 'N/A ' : x.pass ? 'PASS' : 'FAIL'}  ${x.detail || ''}`);
}

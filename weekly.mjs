#!/usr/bin/env node
// Weekly strategy comparison report (v1 original vs v2 calibrated).
//   node weekly.mjs <barsCacheDir>
// Needs: analytics-v1.json / analytics-v2.json and portfolio-v1.json / portfolio-v2.json (RPCI_PROFILE=v1|v2 node evaluate.mjs),
// and the live picks in history/strategies/. Writes reports/weekly-<date>.md and prints it.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';

const CACHE = process.argv[2];
if (!CACHE) { console.error('usage: node weekly.mjs <barsCacheDir>'); process.exit(1); }
const HERE = new URL('./', import.meta.url);
const load = f => JSON.parse(readFileSync(f, 'utf8'));
const toBars = a => a.map(b => Array.isArray(b) ? { t: b[0], c: b[4] } : b);
const dkey = t => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);
const bench = toBars(load(`${CACHE}/^NSEI.json`)), bIdx = new Map(bench.map((b, i) => [dkey(b.t), i])), today = dkey(bench.at(-1).t);
const cache = new Map(); const barsOf = s => { if (!cache.has(s)) cache.set(s, existsSync(`${CACHE}/${s}.json`) ? toBars(load(`${CACHE}/${s}.json`)) : null); return cache.get(s); };
const pct = x => x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';

// ---- live forward record ----
const dir = new URL('./history/strategies/', HERE);
const days = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => load(new URL(f, dir))) : [];
function fwd(sym, d, h) { const b = barsOf(sym); if (!b) return null; const i = b.findIndex(x => dkey(x.t) === d), bi = bIdx.get(d);
  if (i < 0 || bi == null || i + h >= b.length || bi + h >= bench.length) return null; return b[i + h].c / b[i].c - bench[bi + h].c / bench[bi].c; }
const live = {};
const VS = ['v1', 'v2', 'v3'];
for (const key of [...VS, 'v2bases']) for (const h of [5, 20]) {
  const ex = []; let lists = 0;
  for (const d of days) { const p = key === 'v2bases' ? d.profiles.v2?.bases : d.profiles[key]?.top; if (!p?.length) continue;
    const r = p.map(x => fwd(x[0], d.date, h)).filter(x => x != null); if (r.length) { lists++; ex.push(r.reduce((a, b) => a + b, 0) / r.length); } }
  live[key + '_' + h] = { lists, mean: ex.length ? ex.reduce((a, b) => a + b, 0) / ex.length : null, hit: ex.length ? ex.filter(x => x > 0).length / ex.length : null };
}
// ---- backtest comparison ----
const A = v => existsSync(new URL(`./analytics-${v}.json`, HERE)) ? load(new URL(`./analytics-${v}.json`, HERE)) : null;
const P = v => existsSync(new URL(`./portfolio-${v}.json`, HERE)) ? load(new URL(`./portfolio-${v}.json`, HERE)) : null;
const TR = existsSync(new URL('./truth.json', HERE)) ? load(new URL('./truth.json', HERE)) : {};
const AS = VS.map(A), PS = VS.map(P), LB = { v1: 'v1 original', v2: 'v2 calibrated (in use)', v3: 'v3 check-matched' };
const top = a => a?.model?.candidates?.find(c => c.id === 'rpci')?.top;
const trig = (a, n) => a?.triggers?.find(t => t.name === n)?.edge?.[1];
const rows = [
  ['Top 10% beat Nifty (20d, unseen dates)', a => top(a) ? top(a).hit + '%' : '—'],
  ['Top 10% avg excess (20d)', a => top(a) ? (top(a).mean >= 0 ? '+' : '') + top(a).mean + '%' : '—'],
  ['Base breakout + strong score edge', a => trig(a, 'Base breakout + strong score') != null ? trig(a, 'Base breakout + strong score') + ' pp' : '—'],
  ['Breakout + strong score edge', a => trig(a, 'Breakout + strong score') != null ? trig(a, 'Breakout + strong score') + ' pp' : '—'],
];
const pf = p => p ? `${p.curves.model.total >= 0 ? '+' : ''}${p.curves.model.total}% (max DD ${p.curves.model.maxDD}%, win ${p.trades.model.win}%)` : '—';
const lv = (k, h) => { const x = live[k + '_' + h]; return x.mean == null ? `— (${x.lists} lists matured)` : `${pct(x.mean)} avg excess · ${Math.round(x.hit * 100)}% of lists beat Nifty · ${x.lists} lists`; };
// verdict: live record once >= 10 matured 5-day lists, else backtest portfolio
const minLists = Math.min(...VS.map(v => live[v + '_5'].lists));
let verdict;
if (minLists >= 10) { const b = [...VS].sort((x, y) => live[y + '_5'].mean - live[x + '_5'].mean)[0]; verdict = `${LB[b]} leads on live picks (5-session excess)`; }
else if (PS.every(Boolean)) { const i = PS.map(p => p.curves.model.total).reduce((bi, v, k, a) => v > a[bi] ? k : bi, 0); verdict = `${LB[VS[i]]} leads on the 2-year backtest; live record still building (${minLists} of 10 daily lists matured)`; }
else verdict = 'not enough data yet';
const md = `# Coil weekly strategy report · ${today}

**Verdict:** ${verdict}. Neither profile is switched automatically.

## Live forward record (picks saved each trading day)
| | ${VS.map(v => LB[v]).join(' | ')} | v2 base breakouts |
|---|${VS.map(() => '---|').join('')}---|
| 5 sessions later | ${VS.map(v => lv(v, 5)).join(' | ')} | ${lv('v2bases', 5)} |
| 20 sessions later | ${VS.map(v => lv(v, 20)).join(' | ')} | ${lv('v2bases', 20)} |

Days tracked: ${days.length} (${days[0]?.date || '—'} → ${days.at(-1)?.date || '—'}). Liquid stocks (₹10 Cr+ traded) at 9+ today: ${VS.map(v => v + ' ' + (days.at(-1)?.profiles[v]?.n9 ?? '—')).join(', ')}.

## 2-year backtest
| | ${VS.map(v => LB[v]).join(' | ')} |
|---|${VS.map(() => '---|').join('')}
${rows.map(([n, f]) => `| ${n} | ${AS.map(f).join(' | ')} |`).join('\n')}
| Paper portfolio (top 10 every 20 sessions) | ${PS.map(pf).join(' | ')} |
| Matches creator's per-check results | ${VS.map(v => TR[v]?.checks || '—').join(' | ')} |
| Avg gap to creator's scores | ${VS.map(v => TR[v]?.scoreGap ?? '—').join(' | ')} |

## Today's picks
${VS.map(v => `- **${LB[v]}:** ${days.at(-1)?.profiles[v]?.top.map(x => x[0]).join(', ') || '—'}`).join('\n')}
- **v2 base breakouts:** ${days.at(-1)?.profiles.v2?.bases?.map(x => x[0]).join(', ') || '—'}
`;
const cmp = { asOf: today, verdict, days: days.length, profiles: VS.map((v, k) => { const p = PS[k], t = top(AS[k]);
  return { id: v, label: LB[v], inUse: v === 'v2', portfolio: p ? { total: p.curves.model.total, maxDD: p.curves.model.maxDD, win: p.trades.model.win, pts: p.curves.model.pts } : null,
    top10: t ? { hit: t.hit, mean: t.mean } : null, baseEdge: trig(AS[k], 'Base breakout + strong score') ?? null,
    truth: TR[v] || null, live5: live[v + '_5'], live20: live[v + '_20'], n9: days.at(-1)?.profiles[v]?.n9 ?? null, picks: days.at(-1)?.profiles[v]?.top.map(x => x[0]) || [] }; }),
  nifty: PS.find(Boolean)?.curves.nifty || null, bases: { live5: live.v2bases_5, live20: live.v2bases_20, picks: days.at(-1)?.profiles.v2?.bases?.map(x => x[0]) || [] } };
writeFileSync(new URL('./compare.json', HERE), JSON.stringify(cmp));
const rd = new URL('./reports/', HERE); mkdirSync(rd, { recursive: true });
writeFileSync(new URL(`weekly-${today}.md`, rd), md);
console.log(md);

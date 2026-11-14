// Offline sanity test on synthetic data: an uptrend that ends with a tight base.
import { runRPCI } from './rpci.mjs';
const bars = []; let p = 100;
for (let i = 0; i < 700; i++) {
  const t = Date.UTC(2024, 0, 1) + i * 864e5; if ([0, 6].includes(new Date(t).getUTCDay())) continue;
  const tight = i > 670, drift = tight ? 0.0005 : 0.0015, vol = tight ? 0.004 : 0.015;
  const o = p; p = p * (1 + drift + vol * Math.sin(i * 1.7)); const big = i === 660;
  if (big) p = o * 1.06;
  bars.push({ t, o, h: Math.max(o, p) * 1.003, l: Math.min(o, p) * 0.997, c: p, v: big ? 5e6 : 1e6 });
}
const bench = bars.map(b => ({ ...b, c: 100 + (b.c - 100) * 0.3 }));
const r = runRPCI(bars, bench, { pe: 55, peg: 2.5, epsGrowth: 0.3, revGrowth: 0.2, roe: 0.2 });
console.table(r.rows.map(({ name, result, pass, detail }) => ({ name, result, pass, detail })));
console.log(r.score, '/', r.total, r.conditions);

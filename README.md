# Coil: RPCI stock screener (unofficial reconstruction)

Rebuilds the 11-point RPCI checklist (Rohan Das / rpci.stratlab.in) as an independent screener.
The original rules are not public; each check uses the standard technique its name points to. All thresholds are in `CONFIG` in `rpci.mjs`.

| Check | Logic | PASS when |
|---|---|---|
| Valuation | P/E on trailing EPS, PEG on TTM EPS growth | 0 < P/E ≤ 40, and PEG ≤ 2 when P/E > 25 |
| Earnings Power | TTM EPS growth ≥15%, annual revenue growth ≥10%, ROE ≥12% (reported financials) | ≥ 2/3 met |
| Momentum | RSI(14), EMA21/50 | RSI 55–80, price > EMA21 > EMA50 |
| Price Contraction | ATR10/ATR50, 10-day range | ATR ratio ≤ 0.75 or range ≤ 12% |
| Timeframe Alignment | Close > EMA10 > EMA20 | true on daily, weekly and monthly |
| Outperformance | 3M and 6M return vs benchmark (^NSEI) | beats on both |
| Institutional Candles | Up candle, body ≥5× 20d avg body, highest volume of prior 50 sessions, close in top 30% | ≥ 1 in last 50 sessions |
| Short-term Extension | Distance from EMA21 in ATR(14) | NOT > 3 ATR |
| Long-term Extension | Distance from SMA200 | NOT > 40% |
| Stage Analysis | Weinstein, 30-week SMA and its slope | Stage 2 |
| Dow Theory (W) | Weekly swing pivots | Close above last swing high, or higher high + higher low |

Conditions: ≥85% Strongly favourable, ≥70% Favourable, ≥50% Neutral, else Unfavourable. Checks without data are N/A and left out of the total.

## Use
```
node screener.mjs RELIANCE.NS TCS.NS --min 8      # CLI (Node 18+)
node screener.mjs --file nifty500.txt --json
node serve.mjs                                    # local preview at http://localhost:5174
node test.mjs                                     # offline test, synthetic data
```
Data comes from Yahoo Finance (NSE: `.NS`, BSE: `.BO`). Not investment advice.

## All-NSE scan and results list
```
curl -A "Mozilla/5.0" -o EQUITY_L.csv https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv
node scan-all.mjs EQUITY_L.csv results.json 12     # ~40s for ~2,600 stocks
```
`index.html` shows `results.json` in a Linear-style list: grouped by conditions or stage, filters, sort, side peek, ⌘K palette, j/k keys, dark and light themes, CSV export.
Deployed on Vercel with `api/yf.js` as the Yahoo proxy.

Calibrated against a published RPCI result (ACUTAAS, 13 Nov 2026: 10/11, matches on all 11 rows).

## Evaluation layer (which criteria work)
```
RPCI_CACHE=/tmp/bars node scan-all.mjs EQUITY_L.csv results.json   # also writes history/<date>.json
node evaluate.mjs /tmp/bars                                               # writes rpci/analytics.json, adds prob to results.json
```
- **Backtest:** the 9 technical checks replayed every 5 sessions over ~2 years for all NSE stocks (≥ ₹50 lakh traded), scored on 5/20/60-session return vs Nifty 50.
- **Live log:** every daily snapshot (all 11 checks, point-in-time incl. fundamentals) is scored as it matures. This is the only fair test of Valuation and Earnings Power.
- **Probability:** naive-Bayes weighting of each check's 20-day hit rate, shrunk for correlation, calibrated by decile. Shown as "Prob" in the list and on `insights.html`.
- **Regime, sector, tuning:** edges split by Nifty regime; industry strength from `sectors.json` (NSE Total Market + Microcap lists); threshold sweeps tuned on the older 70% of dates and checked on the newer 30%.
- **Method selection:** RPCI score, weighted checks and an all-factor logistic model are compared on unseen dates; the best one ranks stocks and drives `portfolio.json`.
- **Paper portfolio:** top 10 liquid stocks every 20 sessions, 2×ATR stop, 0.2% costs, walk-forward. Shown in the app under Paper portfolio.
- **Triggers:** "Breakout today" (close above the 20-session high on 1.5x volume) and "fresh setup" are backtested on the same grid. Breakout + 7/9 technical passes tested best (+2.5 pp at 20 days); fresh setups did not help (-1.1 pp). The app's Breakouts chip uses breakout + 70%+ score.
- **Watchlist and position size:** stored on the device. Stop = price − 2×ATR(14); quantity = capital × risk ÷ (2×ATR), capped at 10% of capital.

## Calibration to the creator's published scores (13 Nov 2026)
Tuned against 22 stock scores and market totals shown on the creator's dashboard (90 at 9+, mean 4.75):
Momentum has no RSI ceiling; Institutional Candles = up candle ≥3× average body on ≥3.5× 50-day volume within 50 sessions;
Dow Theory uses 3-week swing pivots. Result: 103 at 9+, mean 4.79; 17 of 23 known stocks within 1 point.
Conditions follow his bands: Strongly favourable 9+, Favourable 7–8, Wait on below 7.

## Daily read (`daily.mjs`)
`node daily.mjs <barsCacheDir>` after the scan: rebuilds 21 sessions of scores from cached prices to give New 9+ / Lost 9+,
up/down counts and breadth history; Nifty regime from its 20/50/200-day averages (above all three = Uptrend);
sector Stage 2 share now vs 30 sessions ago; base breakouts (Stage 2 close above a 20+ session base inside a 30% band).
Base breakout tested at +6.1 pp over 20 days, the strongest single trigger so far.

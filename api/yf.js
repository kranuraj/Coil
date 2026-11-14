// Vercel function: proxies Yahoo Finance so the browser avoids CORS. /yf1/* and /yf2/* are rewritten here.
export default async function handler(req, res) {
  const u = new URL(req.url, 'http://x'), host = u.searchParams.get('h') === '2' ? 'query2' : 'query1', p = u.searchParams.get('p') || '';
  u.searchParams.delete('h'); u.searchParams.delete('p');
  if (!/^(v8\/finance|ws\/fundamentals-timeseries)\//.test(p)) return res.status(400).send('bad path');
  const r = await fetch(`https://${host}.finance.yahoo.com/${p}?${u.searchParams}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 's-maxage=900');
  res.status(r.status).send(await r.text());
}

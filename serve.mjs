// node rpci/serve.mjs  → http://localhost:5174  (static files + Yahoo proxy to avoid CORS)
import http from 'node:http'; import { readFile } from 'node:fs/promises'; import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url)), up = { '/yf1': 'https://query1.finance.yahoo.com', '/yf2': 'https://query2.finance.yahoo.com' };
http.createServer(async (req, res) => {
  const p = Object.keys(up).find(k => req.url.startsWith(k + '/'));
  if (p) { try { const r = await fetch(up[p] + req.url.slice(p.length), { headers: { 'User-Agent': 'Mozilla/5.0' } });
      res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(await r.text()); } catch (e) { res.writeHead(502); return res.end(e.message); } }
  const f = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0];
  if (f.includes('..')) { res.writeHead(400); return res.end(); }
  try { res.writeHead(200, { 'content-type': f.endsWith('.mjs') ? 'text/javascript' : 'text/html' }); res.end(await readFile(join(dir, f))); }
  catch { res.writeHead(404); res.end(); }
}).listen(5174, () => console.log('RPCI screener on http://localhost:5174'));

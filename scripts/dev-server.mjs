// Local server that mimics the Vercel deployment closely enough for development and tests:
// clean URLs, 404.html with status 404, redirects and headers from vercel.json, and /api/*
// edge handlers (Request -> Response). Set FIXTURE_RPC=1 to serve recorded RPC fixtures
// instead of calling X1 Mainnet.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4173);
const vercel = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

if (process.env.FIXTURE_RPC) {
  const { installFixtureFetch } = await import('../tests/helpers/fixture-fetch.mjs');
  installFixtureFetch();
}

function headersFor(path) {
  const out = {};
  for (const rule of vercel.headers || []) {
    const re = new RegExp(`^${rule.source.replace(/\(\.\*\)/g, '(.*)')}$`);
    if (re.test(path)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

async function file(p) { try { const s = await stat(p); return s.isFile() ? p : null; } catch { return null; } }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);
  for (const r of vercel.redirects || []) {
    if (r.source === path) { res.writeHead(r.permanent ? 308 : 307, { Location: r.destination }); return res.end(); }
  }
  if (path.length > 1 && path.endsWith('/')) { res.writeHead(308, { Location: path.slice(0, -1) + url.search }); return res.end(); }
  // Vercel injects /_vercel/* scripts in production; stub them locally.
  if (path.startsWith('/_vercel/')) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(''); }
  if (path.startsWith('/api/') && !path.slice(5).startsWith('_')) {
    const mod = await file(join(ROOT, `${path}.js`));
    if (!mod) { res.writeHead(404); return res.end('Not found'); }
    const { default: handler } = await import(`file://${mod}`);
    const chunks = []; for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const response = await handler(request);
    res.writeHead(response.status, { ...headersFor(path), ...Object.fromEntries(response.headers) });
    return res.end(Buffer.from(await response.arrayBuffer()));
  }
  if (path.endsWith('.html') && path !== '/404.html') { res.writeHead(308, { Location: path.replace(/\.html$/, '').replace(/^\/index$/, '/') }); return res.end(); }
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
  const candidates = safe === '/' ? ['index.html'] : [safe, `${safe}.html`];
  let found = null;
  for (const c of candidates) { if (!c.includes('/.') && !c.startsWith('/node_modules') && !c.startsWith('/tests') && !c.startsWith('/scripts') && !c.startsWith('/docs')) { found = await file(join(ROOT, c)); if (found) break; } }
  const status = found ? 200 : 404;
  const target = found || join(ROOT, '404.html');
  res.writeHead(status, { 'Content-Type': TYPES[extname(target)] || 'application/octet-stream', ...headersFor(path) });
  res.end(req.method === 'HEAD' ? undefined : await readFile(target));
});
server.listen(PORT, () => console.log(`X1 Leader Slot Checker dev server on http://localhost:${PORT}${process.env.FIXTURE_RPC ? ' (fixture RPC)' : ''}`));

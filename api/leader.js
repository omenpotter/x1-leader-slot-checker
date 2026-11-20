// GET /api/leader?key=<identity or vote pubkey>
// Aggregated, read-only leader schedule report for one validator on X1 Mainnet.
// Responses are cached briefly at the CDN (keyed by URL) so repeated lookups of the same
// validator share one set of upstream RPC calls.
import { leaderReport, json } from './_x1.js';
import { normalizeKeyInput } from '../assets/js/core.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
  const url = new URL(req.url);
  const key = normalizeKeyInput(url.searchParams.get('key'));
  try {
    const { status, body } = await leaderReport(key);
    const cache = status === 200
      ? 'public, max-age=0, s-maxage=15, stale-while-revalidate=30'
      : 'public, max-age=0, s-maxage=300';
    return json(body, status, { 'Cache-Control': cache, 'X-Robots-Tag': 'noindex' });
  } catch (e) {
    const status = e.status === 429 ? 429 : e.status === 504 ? 504 : 502;
    return json({ error: 'upstream_error', message: e.message || 'X1 RPC unavailable' }, status, {
      'X-Robots-Tag': 'noindex',
      ...(e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {}),
    });
  }
}

// GET /api/clock — current X1 Mainnet slot, epoch, RPC health and recent slot timing.
// Cached for 2 seconds at the CDN so every open tab shares a single upstream call.
import { networkClock, json } from './_x1.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
  try {
    const body = await networkClock();
    return json(body, 200, { 'Cache-Control': 'public, max-age=0, s-maxage=2, stale-while-revalidate=4', 'X-Robots-Tag': 'noindex' });
  } catch (e) {
    const status = e.status === 429 ? 429 : e.status === 504 ? 504 : 502;
    return json({ error: 'upstream_error', message: e.message || 'X1 RPC unavailable' }, status, { 'X-Robots-Tag': 'noindex' });
  }
}

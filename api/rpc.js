// Read-only JSON-RPC proxy to X1 Mainnet (kept for backwards compatibility).
// Hardened: method allowlist, batch and body limits, identity-filtered leader schedules,
// upstream timeout and bounded retries. Same-origin only: no wildcard CORS, so other sites
// cannot spend this deployment's shared upstream rate limit.
import { validateProxyRequest, upstream, json } from './_x1.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
  }
  const text = await req.text();
  const v = validateProxyRequest(text);
  if (!v.ok) {
    return json({ jsonrpc: '2.0', id: null, error: { code: v.status === 403 ? -32601 : -32600, message: v.error } }, v.status);
  }
  try {
    const payload = v.isBatch ? v.calls : v.calls[0];
    const data = await upstream(payload, { timeoutMs: 8000, retries: 1 });
    return json(data, 200);
  } catch (e) {
    const status = e.status === 429 ? 429 : e.status === 504 ? 504 : 502;
    const headers = e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {};
    return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: e.message || 'Upstream error' } }, status, headers);
  }
}

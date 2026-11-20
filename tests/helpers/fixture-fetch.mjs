// Replace global fetch for the X1 RPC host with responses built from recorded fixtures
// (tests/fixtures, recorded from X1 Mainnet). Lets the UI and API run deterministically offline.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const fx = (name) => JSON.parse(readFileSync(join(FX, name), 'utf8'));

export const IDENTITY = '9oCgTnLY7akSYPaLmTh6TdcXZ49raaBDMdVePXcwNCGB';
export const VOTE = '7ZPky9oA5bDzCwpuBk9BshFX3BXNXzN9DjpnRcphNGtn';

/** Answer one JSON-RPC call from fixtures. `overrides` maps method -> result|Error|function. */
export function answer(call, overrides = {}) {
  const base = fx('base-batch.json');
  const o = overrides[call.method];
  if (o instanceof Error) return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: o.message } };
  if (typeof o === 'function') return { jsonrpc: '2.0', id: call.id, ...o(call) };
  if (o !== undefined) return { jsonrpc: '2.0', id: call.id, result: o };
  const p = call.params || [];
  const r = (result) => ({ jsonrpc: '2.0', id: call.id, result });
  switch (call.method) {
    case 'getEpochInfo': return r(base[0].result);
    case 'getEpochSchedule': return r(base[1].result);
    case 'getRecentPerformanceSamples': return r(base[2].result);
    case 'getSlot': return r(base[3].result);
    case 'getHealth': return r('ok');
    case 'getVersion': return r({ 'solana-core': '4.0.4', 'feature-set': 3075748243 });
    case 'getVoteAccounts': return p[0]?.votePubkey ? fx(p[0].votePubkey === VOTE ? 'vote-by-vote.json' : 'vote-by-identity-miss.json') && { ...fx(p[0].votePubkey === VOTE ? 'vote-by-vote.json' : 'vote-by-identity-miss.json'), id: call.id } : { ...fx('vote-accounts-all.json'), id: call.id };
    case 'getLeaderSchedule': {
      const id = p[1]?.identity;
      if (!id || id.length < 32) return { ...fx('schedule-invalid.json'), id: call.id };
      if (id !== IDENTITY) return r({});
      if (p[0] === null || p[0] === undefined) return { ...fx('schedule-current.json'), id: call.id };
      const next = base[1].result.firstNormalSlot + (base[0].result.epoch + 1 - base[1].result.firstNormalEpoch) * base[1].result.slotsPerEpoch;
      if (p[0] >= next && p[0] < next + base[1].result.slotsPerEpoch) return { ...fx('schedule-next.json'), id: call.id };
      return r(null);
    }
    case 'getBlockProduction': return p[0]?.identity === IDENTITY ? { ...fx('block-production.json'), id: call.id } : r({ context: { slot: base[3].result }, value: { byIdentity: {}, range: { firstSlot: 94438112, lastSlot: base[3].result } } });
    case 'getProgramAccounts': return p[1]?.filters?.[0]?.memcmp?.bytes === IDENTITY ? { ...fx('validator-info.json'), id: call.id } : r([]);
    default: return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'Method not found' } };
  }
}

/** Install a fetch shim; returns a restore function. `opts.status` forces an HTTP status. */
export function installFixtureFetch(opts = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://rpc.mainnet.x1.xyz')) return real(input, init);
    opts.calls?.push(JSON.parse(init.body));
    if (opts.delayMs) await new Promise((r, j) => { const t = setTimeout(r, opts.delayMs); init.signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });
    const status = typeof opts.status === 'function' ? opts.status() : opts.status;
    if (status && status !== 200) return new Response('{"error":"x"}', { status, headers: { 'retry-after': '1' } });
    const body = JSON.parse(init.body);
    const out = Array.isArray(body) ? body.map((c) => answer(c, opts.overrides)) : answer(body, opts.overrides);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return () => { globalThis.fetch = real; };
}

// Shared server-side helpers for the X1 Leader Slot Checker edge functions.
// Files in /api starting with "_" are not exposed as routes by Vercel.
//
// Read-only by design: only the JSON-RPC methods in READ_METHODS can reach the upstream node,
// and none of them can sign, send or simulate transactions.

import {
  isValidPubkey, firstSlotInEpoch, slotsInEpoch, isEpochSchedule, estimateSlotTime,
} from '../assets/js/core.js';

export const UPSTREAM = 'https://rpc.mainnet.x1.xyz';
const CONFIG_PROGRAM = 'Config1111111111111111111111111111111111111';
const VALIDATOR_INFO_KEY = 'Va1idator1nfo111111111111111111111111111111';

/**
 * Methods the public /api/rpc proxy will forward. Everything else is rejected with -32601.
 * Deliberately excludes sendTransaction, simulateTransaction, requestAirdrop and
 * getProgramAccounts (unbounded, heavy).
 */
export const READ_METHODS = new Set([
  'getSlot', 'getEpochInfo', 'getEpochSchedule', 'getLeaderSchedule', 'getRecentPerformanceSamples',
  'getBlockProduction', 'getHealth', 'getVersion', 'getBlockHeight', 'getSlotLeaders',
]);

export const MAX_BATCH = 4;
export const MAX_BODY_BYTES = 4096;

/** JSON response helper with conservative defaults. */
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

/**
 * Validate a JSON-RPC request (single or batch) destined for the public proxy.
 * Returns { ok:true, calls } or { ok:false, status, error }.
 */
export function validateProxyRequest(text) {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, status: 400, error: 'Empty body' };
  if (text.length > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'Request too large' };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, status: 400, error: 'Invalid JSON' }; }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0 || calls.length > MAX_BATCH) return { ok: false, status: 400, error: `Batch must contain 1-${MAX_BATCH} calls` };
  for (const c of calls) {
    if (!c || typeof c !== 'object' || c.jsonrpc !== '2.0' || typeof c.method !== 'string') {
      return { ok: false, status: 400, error: 'Malformed JSON-RPC call' };
    }
    if (!READ_METHODS.has(c.method)) return { ok: false, status: 403, error: `Method not allowed: ${c.method.slice(0, 40)}` };
    if (c.params !== undefined && !Array.isArray(c.params)) return { ok: false, status: 400, error: 'params must be an array' };
    if (c.method === 'getLeaderSchedule') {
      // The unfiltered schedule is ~1.4 MB on X1 Mainnet; require an identity filter.
      const cfg = c.params?.[1];
      if (!cfg || !isValidPubkey(cfg.identity)) return { ok: false, status: 400, error: 'getLeaderSchedule requires a valid identity filter' };
    }
    if (c.method === 'getSlotLeaders') {
      const limit = c.params?.[1];
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return { ok: false, status: 400, error: 'getSlotLeaders limit must be 1-100' };
    }
  }
  return { ok: true, calls, isBatch: Array.isArray(parsed) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST a JSON-RPC payload upstream with a timeout and bounded retries.
 * Retries only on network errors, 429 and 5xx; honours Retry-After up to `maxWaitMs`.
 * @param {object|object[]} payload
 * @param {{timeoutMs?:number, retries?:number, maxWaitMs?:number, fetchImpl?:typeof fetch}} [opts]
 */
export async function upstream(payload, opts = {}) {
  const { timeoutMs = 8000, retries = 1, maxWaitMs = 2000, fetchImpl = fetch } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(UPSTREAM, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        lastErr = Object.assign(new Error(res.status === 429 ? 'X1 RPC rate limit reached' : `X1 RPC HTTP ${res.status}`), { status: res.status, retryAfter: ra || undefined });
        if (attempt < retries) { await sleep(Math.min(maxWaitMs, (ra || 0.4) * 1000)); continue; }
        throw lastErr;
      }
      if (!res.ok) throw Object.assign(new Error(`X1 RPC HTTP ${res.status}`), { status: res.status });
      return await res.json();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? Object.assign(new Error('X1 RPC timed out'), { status: 504 }) : e;
      if (attempt >= retries || (lastErr.status && lastErr.status < 500 && lastErr.status !== 429)) throw lastErr;
      await sleep(300);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Run a batch and return results by id, preserving per-call errors. */
export async function batch(calls, opts) {
  const payload = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params ?? [] }));
  const res = await upstream(payload, opts);
  if (!Array.isArray(res)) throw Object.assign(new Error('Unexpected X1 RPC batch response'), { status: 502 });
  const byId = new Map(res.map((r) => [r.id, r]));
  return payload.map((p) => {
    const r = byId.get(p.id);
    if (!r) return { error: { message: 'missing response' } };
    return r.error ? { error: r.error } : { result: r.result };
  });
}

/** Extract a self-published validator name/website from a Config program validatorInfo account. */
export function parseValidatorInfo(accounts, identity) {
  if (!Array.isArray(accounts)) return null;
  for (const a of accounts) {
    const parsed = a?.account?.data?.parsed;
    if (parsed?.type !== 'validatorInfo') continue;
    const keys = parsed.info?.keys;
    if (!Array.isArray(keys) || keys[0]?.pubkey !== VALIDATOR_INFO_KEY || keys[1]?.pubkey !== identity || keys[1]?.signer !== true) continue;
    const cfg = parsed.info?.configData ?? {};
    const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max) : undefined);
    const website = clean(cfg.website, 200);
    return {
      name: clean(cfg.name, 80) || null,
      website: website && /^https?:\/\/[^\s<>"']+$/i.test(website) ? website : null,
      details: clean(cfg.details, 280) || null,
      infoAccount: a.pubkey,
    };
  }
  return null;
}

/** Locate a vote account by vote pubkey or node (identity) pubkey in getVoteAccounts output. */
export function findVoteAccount(voteAccounts, key) {
  if (!voteAccounts) return null;
  for (const [list, delinquent] of [[voteAccounts.current, false], [voteAccounts.delinquent, true]]) {
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      if (v.votePubkey === key || v.nodePubkey === key) {
        return {
          votePubkey: v.votePubkey,
          nodePubkey: v.nodePubkey,
          activatedStake: v.activatedStake,
          commission: v.commission,
          lastVote: v.lastVote,
          rootSlot: v.rootSlot,
          epochVoteAccount: v.epochVoteAccount,
          delinquent,
          matchedBy: v.votePubkey === key ? 'vote' : 'identity',
        };
      }
    }
  }
  return null;
}

/**
 * Build the full leader report for an identity or vote account key.
 * Two upstream round trips: (1) chain state + vote accounts, (2) per-identity data.
 * @param {string} key
 * @param {{now?:()=>number, rpc?:typeof batch}} [deps]
 */
export async function leaderReport(key, deps = {}) {
  const now = deps.now ?? Date.now;
  const rpc = deps.rpc ?? batch;
  if (!isValidPubkey(key)) {
    return { status: 400, body: { error: 'invalid_pubkey', message: 'Enter a base58 X1 public key (32 bytes).' } };
  }

  const [ei, es, ps, va] = await rpc([
    { method: 'getEpochInfo' },
    { method: 'getEpochSchedule' },
    { method: 'getRecentPerformanceSamples', params: [15] },
    { method: 'getVoteAccounts' },
  ]);
  const observedAt = now();
  if (ei.error || !ei.result) throw Object.assign(new Error('getEpochInfo failed'), { status: 502 });
  if (es.error || !isEpochSchedule(es.result)) throw Object.assign(new Error('getEpochSchedule failed'), { status: 502 });
  const epochInfo = ei.result;
  const schedule = es.result;

  const vote = va.error ? null : findVoteAccount(va.result, key);
  const identity = vote?.matchedBy === 'vote' ? vote.nodePubkey : key;

  const epoch = epochInfo.epoch;
  const curStart = firstSlotInEpoch(epoch, schedule);
  const nextStart = firstSlotInEpoch(epoch + 1, schedule);

  const [cur, nxt, bp, info] = await rpc([
    { method: 'getLeaderSchedule', params: [null, { identity }] },
    { method: 'getLeaderSchedule', params: [nextStart, { identity }] },
    { method: 'getBlockProduction', params: [{ identity }] },
    {
      method: 'getProgramAccounts',
      params: [CONFIG_PROGRAM, { encoding: 'jsonParsed', filters: [{ memcmp: { offset: 34, bytes: identity } }] }],
    },
  ]);
  if (cur.error) throw Object.assign(new Error(`getLeaderSchedule failed: ${String(cur.error.message).slice(0, 80)}`), { status: 502 });

  const relCurrent = cur.result?.[identity] ?? [];
  // A null result for the next epoch means the schedule is not yet computable on this node.
  const nextAvailable = !nxt.error && nxt.result !== null && nxt.result !== undefined;
  const relNext = nextAvailable ? (nxt.result[identity] ?? []) : null;
  const production = bp.error ? null : bp.result?.value;

  return {
    status: 200,
    body: {
      input: key,
      identity,
      inputType: vote?.matchedBy === 'vote' ? 'vote' : 'identity',
      network: 'X1 Mainnet',
      source: UPSTREAM,
      observedAt: new Date(observedAt).toISOString(),
      anchor: { slot: epochInfo.absoluteSlot, at: observedAt },
      epochInfo,
      epochSchedule: schedule,
      slotTime: estimateSlotTime(ps.error ? [] : ps.result),
      current: { epoch, firstSlot: curStart, slotsInEpoch: slotsInEpoch(epoch, schedule), relativeSlots: relCurrent },
      next: { epoch: epoch + 1, firstSlot: nextStart, slotsInEpoch: slotsInEpoch(epoch + 1, schedule), available: nextAvailable, relativeSlots: relNext },
      production: production ? {
        range: production.range,
        leaderSlots: production.byIdentity?.[identity]?.[0] ?? 0,
        blocksProduced: production.byIdentity?.[identity]?.[1] ?? 0,
      } : null,
      voteAccount: vote,
      validatorInfo: info.error ? null : parseValidatorInfo(info.result, identity),
    },
  };
}

/** Lightweight network clock used by the live status strip and countdown recalibration. */
export async function networkClock(deps = {}) {
  const now = deps.now ?? Date.now;
  const rpc = deps.rpc ?? batch;
  const [ei, health, ps] = await rpc([
    { method: 'getEpochInfo' },
    { method: 'getHealth' },
    { method: 'getRecentPerformanceSamples', params: [15] },
  ]);
  const at = now();
  if (ei.error || !ei.result) throw Object.assign(new Error('getEpochInfo failed'), { status: 502 });
  return {
    network: 'X1 Mainnet',
    observedAt: new Date(at).toISOString(),
    anchor: { slot: ei.result.absoluteSlot, at },
    epochInfo: ei.result,
    health: health.error ? { ok: false, message: String(health.error.message ?? 'unhealthy').slice(0, 120) } : { ok: health.result === 'ok' },
    slotTime: estimateSlotTime(ps.error ? [] : ps.result),
  };
}

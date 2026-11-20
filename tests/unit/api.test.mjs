import test from 'node:test';
import assert from 'node:assert/strict';
import { installFixtureFetch, IDENTITY, VOTE } from '../helpers/fixture-fetch.mjs';
import { validateProxyRequest, leaderReport, networkClock, parseValidatorInfo, findVoteAccount, upstream } from '../../api/_x1.js';
import leaderHandler from '../../api/leader.js';
import clockHandler from '../../api/clock.js';
import rpcHandler from '../../api/rpc.js';

const call = (method, params) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

test('proxy allowlist rejects write/heavy methods and unfiltered schedules', () => {
  assert.equal(validateProxyRequest(call('getSlot')).ok, true);
  for (const m of ['sendTransaction', 'simulateTransaction', 'requestAirdrop', 'getProgramAccounts']) {
    const v = validateProxyRequest(call(m, []));
    assert.equal(v.ok, false); assert.equal(v.status, 403);
  }
  assert.equal(validateProxyRequest(call('getLeaderSchedule', [])).status, 400);
  assert.equal(validateProxyRequest(call('getLeaderSchedule', [null, { identity: 'bad' }])).status, 400);
  assert.equal(validateProxyRequest(call('getLeaderSchedule', [null, { identity: IDENTITY }])).ok, true);
  assert.equal(validateProxyRequest(JSON.stringify(Array(5).fill({ jsonrpc: '2.0', id: 1, method: 'getSlot' }))).status, 400);
  assert.equal(validateProxyRequest('x'.repeat(5000)).status, 413);
  assert.equal(validateProxyRequest('{bad').status, 400);
  assert.equal(validateProxyRequest(call('getSlot', { a: 1 })).status, 400);
});

test('leader report resolves a vote account to its identity (recorded data)', async (t) => {
  const restore = installFixtureFetch(); t.after(restore);
  const { status, body } = await leaderReport(VOTE, { now: () => 1_000_000 });
  assert.equal(status, 200);
  assert.equal(body.identity, IDENTITY);
  assert.equal(body.inputType, 'vote');
  assert.equal(body.current.relativeSlots.length, 236);
  assert.equal(body.next.available, true);
  assert.equal(body.next.relativeSlots.length, 248);
  assert.equal(body.production.leaderSlots, 176);
  assert.equal(body.validatorInfo.name, '248X1SIL');
  assert.equal(body.voteAccount.delinquent, false);
  assert.equal(body.anchor.at, 1_000_000);
  assert.equal(body.current.firstSlot, 94438112);
});

test('leader report by identity, and for an identity with no slots', async (t) => {
  const restore = installFixtureFetch(); t.after(restore);
  const a = await leaderReport(IDENTITY);
  assert.equal(a.body.inputType, 'identity');
  assert.equal(a.body.voteAccount.votePubkey, VOTE);
  const b = await leaderReport('11111111111111111111111111111111');
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.current.relativeSlots, []);
  assert.equal(b.body.voteAccount, null);
  assert.equal(b.body.validatorInfo, null);
});

test('next epoch schedule not yet available (RPC returns null)', async (t) => {
  const restore = installFixtureFetch({ overrides: { getLeaderSchedule: (c) => (c.params[0] === null ? { result: { [IDENTITY]: [1, 2, 3, 4] } } : { result: null }) } });
  t.after(restore);
  const { body } = await leaderReport(IDENTITY);
  assert.equal(body.next.available, false);
  assert.equal(body.next.relativeSlots, null);
});

test('invalid keys never reach the RPC', async (t) => {
  const calls = []; const restore = installFixtureFetch({ calls }); t.after(restore);
  const r = await leaderReport('not-a-key');
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test('missing performance samples fall back to nominal timing, flagged', async (t) => {
  const restore = installFixtureFetch({ overrides: { getRecentPerformanceSamples: new Error('unavailable') } }); t.after(restore);
  const { body } = await leaderReport(IDENTITY);
  assert.equal(body.slotTime.source, 'nominal-fallback');
});

test('one failed sub-request does not break the report', async (t) => {
  const restore = installFixtureFetch({ overrides: { getBlockProduction: new Error('x'), getProgramAccounts: new Error('y'), getVoteAccounts: new Error('z') } });
  t.after(restore);
  const { status, body } = await leaderReport(IDENTITY);
  assert.equal(status, 200);
  assert.equal(body.production, null);
  assert.equal(body.validatorInfo, null);
  assert.equal(body.voteAccount, null);
  assert.equal(body.current.relativeSlots.length, 236);
});

test('rate limit (429) is retried once then surfaced with Retry-After', async (t) => {
  const calls = []; const restore = installFixtureFetch({ status: 429, calls }); t.after(restore);
  const res = await leaderHandler(new Request(`https://x/api/leader?key=${IDENTITY}`));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '1');
  assert.equal(calls.length, 2);
});

test('transient 5xx recovers on retry', async (t) => {
  let n = 0; const restore = installFixtureFetch({ status: () => (n++ === 0 ? 503 : 200) }); t.after(restore);
  const res = await clockHandler(new Request('https://x/api/clock'));
  assert.equal(res.status, 200);
});

test('network outage / timeout returns 504 without hanging', async (t) => {
  const restore = installFixtureFetch({ delayMs: 500 }); t.after(restore);
  await assert.rejects(upstream({ jsonrpc: '2.0', id: 1, method: 'getSlot' }, { timeoutMs: 50, retries: 0 }), /timed out/);
});

test('handlers set cache headers and reject bad methods', async (t) => {
  const restore = installFixtureFetch(); t.after(restore);
  const ok = await leaderHandler(new Request(`https://x/api/leader?key=${VOTE}`));
  assert.match(ok.headers.get('cache-control'), /s-maxage=15/);
  assert.equal(ok.headers.get('x-robots-tag'), 'noindex');
  const bad = await leaderHandler(new Request('https://x/api/leader?key=%3Cscript%3E'));
  assert.equal(bad.status, 400);
  assert.equal((await leaderHandler(new Request('https://x/api/leader', { method: 'POST' }))).status, 405);
  const clock = await clockHandler(new Request('https://x/api/clock'));
  assert.match(clock.headers.get('cache-control'), /s-maxage=2/);
  const body = await clock.json();
  assert.equal(body.health.ok, true);
});

test('rpc proxy: forwards allowed calls, blocks others, no wildcard CORS', async (t) => {
  const restore = installFixtureFetch(); t.after(restore);
  const ok = await rpcHandler(new Request('https://x/api/rpc', { method: 'POST', body: call('getSlot') }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), null);
  const blocked = await rpcHandler(new Request('https://x/api/rpc', { method: 'POST', body: call('sendTransaction', ['x']) }));
  assert.equal(blocked.status, 403);
  assert.equal((await rpcHandler(new Request('https://x/api/rpc'))).status, 405);
});

test('validator info parsing rejects spoofed or unsafe data', () => {
  const acct = (keys, cfg) => [{ pubkey: 'P', account: { data: { parsed: { type: 'validatorInfo', info: { keys, configData: cfg } } } } }];
  const keys = [{ pubkey: 'Va1idator1nfo111111111111111111111111111111', signer: false }, { pubkey: IDENTITY, signer: true }];
  assert.equal(parseValidatorInfo(acct(keys, { name: 'A\u0000B', website: 'javascript:alert(1)' }), IDENTITY).website, null);
  assert.equal(parseValidatorInfo(acct(keys, { name: 'A\u0000B' }), IDENTITY).name, 'AB');
  assert.equal(parseValidatorInfo(acct([keys[0], { pubkey: IDENTITY, signer: false }], { name: 'x' }), IDENTITY), null, 'unsigned');
  assert.equal(parseValidatorInfo(acct(keys, { name: 'x' }), VOTE), null, 'different identity');
});

test('findVoteAccount marks delinquent validators', () => {
  const v = findVoteAccount({ current: [], delinquent: [{ votePubkey: 'V', nodePubkey: 'N' }] }, 'N');
  assert.equal(v.delinquent, true);
  assert.equal(v.matchedBy, 'identity');
});

test('network clock reports degraded health', async (t) => {
  const restore = installFixtureFetch({ overrides: { getHealth: new Error('Node is behind by 120 slots') } }); t.after(restore);
  const body = await networkClock();
  assert.equal(body.health.ok, false);
  assert.match(body.health.message, /behind/);
});

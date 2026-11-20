// Live validation against X1 Mainnet. Read-only. Run: npm run test:live [key ...]
// For each validator: builds the report through api/_x1.js, then independently re-derives the
// schedule with direct RPC calls and compares; also runs the pre-upgrade algorithm on the same inputs.
import { leaderReport, UPSTREAM } from '../api/_x1.js';
import * as c from '../assets/js/core.js';

const rpc = async (method, params = []) => {
  const r = await fetch(UPSTREAM, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
};

let keys = process.argv.slice(2);
if (!keys.length) {
  const va = await rpc('getVoteAccounts');
  const cur = [...va.current].sort((a, b) => b.activatedStake - a.activatedStake);
  keys = [cur[0].votePubkey, cur[Math.floor(cur.length / 2)].nodePubkey, cur[cur.length - 1].nodePubkey, va.delinquent[0]?.nodePubkey].filter(Boolean);
}
let failures = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

for (const key of keys) {
  console.log(`\n${key}`);
  const { status, body: r } = await leaderReport(key);
  check(status === 200, `report status ${status}`);
  const id = r.identity;
  const [ei, es, raw] = await Promise.all([rpc('getEpochInfo'), rpc('getEpochSchedule'), rpc('getLeaderSchedule', [null, { identity: id }])]);
  const rel = raw[id] ?? [];
  check(ei.epoch === r.current.epoch || ei.epoch === r.current.epoch + 1, `epoch ${r.current.epoch} (direct ${ei.epoch})`);
  check(r.current.firstSlot === ei.absoluteSlot - ei.slotIndex || ei.epoch !== r.current.epoch, `epoch start ${r.current.firstSlot} == absoluteSlot - slotIndex`);
  check(JSON.stringify(rel) === JSON.stringify(r.current.relativeSlots) || ei.epoch !== r.current.epoch, `relative slots identical (${rel.length})`);
  const { slots, dropped } = c.toAbsoluteSlots(r.current.relativeSlots, r.current.firstSlot, r.current.slotsInEpoch);
  check(dropped === 0, `no malformed/duplicate slots (dropped ${dropped})`);
  const windows = c.groupConsecutive(slots);
  check(windows.every((w) => w.count % c.CONSECUTIVE_LEADER_SLOTS === 0), `${windows.length} windows, all multiples of 4`);
  // Old algorithm on identical inputs
  const slotNow = ei.absoluteSlot;
  const oldUpcoming = rel.map((x) => (ei.absoluteSlot - ei.slotIndex) + x).filter((a) => a > slotNow).sort((a, b) => a - b);
  const newUpcoming = c.splitByCurrent(slots, slotNow + 1).upcoming;
  check(ei.epoch !== r.current.epoch || JSON.stringify(oldUpcoming) === JSON.stringify(newUpcoming), `old vs new upcoming identical (${newUpcoming.length})`);
  check(r.slotTime.source === 'performance-samples', `slot time ${r.slotTime.msPerSlot.toFixed(1)} ms (${r.slotTime.minMs.toFixed(1)}-${r.slotTime.maxMs.toFixed(1)}), ${r.slotTime.samples} samples`);
  check(r.next.available === false || Array.isArray(r.next.relativeSlots), `next epoch ${r.next.available ? `${r.next.relativeSlots.length} slots` : 'not yet available'}`);
  if (r.production) check(r.production.blocksProduced <= r.production.leaderSlots, `production ${r.production.blocksProduced}/${r.production.leaderSlots}`);
  console.log(`  info  type=${r.inputType} name=${JSON.stringify(r.validatorInfo?.name ?? null)} delinquent=${r.voteAccount?.delinquent ?? 'n/a'}`);
}
console.log(`\n${failures ? `${failures} FAILED` : 'ALL LIVE CHECKS PASSED'} — ${new Date().toISOString()}`);
process.exit(failures ? 1 : 0);

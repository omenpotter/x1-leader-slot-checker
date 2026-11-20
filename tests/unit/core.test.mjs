import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../assets/js/core.js';
import { fx, IDENTITY } from '../helpers/fixture-fetch.mjs';

const base = fx('base-batch.json');
const EI = base[0].result; const SCHED = base[1].result; const SAMPLES = base[2].result;
const REL = fx('schedule-current.json').result[IDENTITY];
const REL_NEXT = fx('schedule-next.json').result[IDENTITY];

test('pubkey validation: valid, invalid characters, wrong length', () => {
  assert.equal(c.isValidPubkey(IDENTITY), true);
  assert.equal(c.isValidPubkey('11111111111111111111111111111111'), true);
  assert.equal(c.isValidPubkey('notakey'), false);
  assert.equal(c.isValidPubkey('0OIl' + '1'.repeat(40)), false);
  assert.equal(c.isValidPubkey(IDENTITY + 'A'), false);
  assert.equal(c.isValidPubkey('z'.repeat(44)), false, '44 chars that decode to >32 bytes');
  assert.equal(c.isValidPubkey(null), false);
  assert.equal(c.isValidPubkey('<script>alert(1)</script>'), false);
});

test('normalizeKeyInput strips whitespace, quotes and zero-width chars', () => {
  assert.equal(c.normalizeKeyInput(`  "${IDENTITY}"​\n`), IDENTITY);
});

test('epoch math matches X1 Mainnet RPC (warmup schedule)', () => {
  assert.equal(SCHED.slotsPerEpoch, 216000);
  const start = c.firstSlotInEpoch(EI.epoch, SCHED);
  assert.equal(start, EI.absoluteSlot - EI.slotIndex);
  assert.equal(start, fx('block-production.json').result.value.range.firstSlot);
  assert.deepEqual(c.epochForSlot(EI.absoluteSlot, SCHED), { epoch: EI.epoch, slotIndex: EI.slotIndex });
  assert.equal(c.firstSlotInEpoch(13, SCHED), 262112);
  assert.deepEqual(c.epochForSlot(262111, SCHED), { epoch: 12, slotIndex: 131071 });
  assert.equal(c.slotsInEpoch(12, SCHED), 131072);
  assert.deepEqual(c.epochForSlot(0, SCHED), { epoch: 0, slotIndex: 0 });
});

test('epoch boundaries: last slot of epoch and first of next', () => {
  const next = c.firstSlotInEpoch(EI.epoch + 1, SCHED);
  assert.deepEqual(c.epochForSlot(next - 1, SCHED), { epoch: EI.epoch, slotIndex: 215999 });
  assert.deepEqual(c.epochForSlot(next, SCHED), { epoch: EI.epoch + 1, slotIndex: 0 });
  // Warmup boundary for every early epoch
  for (let e = 0; e <= 13; e++) {
    const s = c.firstSlotInEpoch(e, SCHED);
    assert.equal(c.epochForSlot(s, SCHED).epoch, e);
    if (s > 0) assert.equal(c.epochForSlot(s - 1, SCHED).epoch, e - 1);
  }
});

test('recorded schedule converts to sorted unique absolute slots in 4-slot windows', () => {
  const start = c.firstSlotInEpoch(EI.epoch, SCHED);
  const { slots, dropped } = c.toAbsoluteSlots(REL, start, 216000);
  assert.equal(dropped, 0);
  assert.equal(slots.length, 236);
  assert.ok(slots.every((s, i) => i === 0 || s > slots[i - 1]));
  const w = c.groupConsecutive(slots);
  assert.equal(w.length, 59);
  assert.ok(w.every((x) => x.count === c.CONSECUTIVE_LEADER_SLOTS));
  assert.equal(REL_NEXT.length, 248);
});

test('duplicate, out-of-order and malformed slot data is cleaned and counted', () => {
  const { slots, dropped } = c.toAbsoluteSlots([5, 3, 3, -1, 1.5, 'x', 216000, 4], 100, 216000);
  assert.deepEqual(slots, [103, 104, 105]);
  assert.equal(dropped, 5);
  assert.deepEqual(c.toAbsoluteSlots(null, 0, 10), { slots: [], dropped: 0 });
});

test('empty schedule yields no windows', () => {
  assert.deepEqual(c.groupConsecutive([]), []);
  assert.deepEqual(c.splitByCurrent([], 10), { past: [], upcoming: [] });
});

test('very large schedule (an entire epoch) is handled quickly', () => {
  const rel = Array.from({ length: 216000 }, (_, i) => 215999 - i);
  const t0 = performance.now();
  const { slots } = c.toAbsoluteSlots(rel, 1000, 216000);
  const w = c.groupConsecutive(slots);
  const b = c.bucketEpoch(slots, 1000, 216000, 144, 50000);
  assert.equal(w.length, 1);
  assert.equal(b.reduce((a, x) => a + x.count, 0), 216000);
  assert.ok(performance.now() - t0 < 1000);
});

test('splitByCurrent treats the current slot as upcoming (in progress)', () => {
  assert.deepEqual(c.splitByCurrent([1, 2, 3, 4], 3), { past: [1, 2], upcoming: [3, 4] });
});

test('slot time estimate from recorded performance samples', () => {
  const est = c.estimateSlotTime(SAMPLES);
  assert.equal(est.source, 'performance-samples');
  assert.ok(est.msPerSlot > 300 && est.msPerSlot < 420, `got ${est.msPerSlot}`);
  assert.ok(est.minMs <= est.msPerSlot && est.msPerSlot <= est.maxMs);
  // X1 is not running at the nominal 400 ms the old fallback assumed.
  assert.notEqual(Math.round(est.msPerSlot), 400);
});

test('slot time estimate ignores zero samples and falls back to nominal', () => {
  assert.equal(c.estimateSlotTime([]).source, 'nominal-fallback');
  assert.equal(c.estimateSlotTime(null).msPerSlot, 400);
  const est = c.estimateSlotTime([{ numSlots: 0, samplePeriodSecs: 60 }, { numSlots: 150, samplePeriodSecs: 60 }]);
  assert.equal(est.samples, 1);
  assert.equal(est.msPerSlot, 400);
});

test('ETA band widens with distance and is ordered earliest <= at <= latest', () => {
  const est = { msPerSlot: 365, minMs: 360, maxMs: 380 };
  const a = { slot: 1000, at: 0 };
  const near = c.estimateSlotEta(1010, a, est); const far = c.estimateSlotEta(101000, a, est);
  assert.ok(near.earliest <= near.at && near.at <= near.latest);
  assert.ok(far.latest - far.earliest > near.latest - near.earliest);
  assert.equal(c.estimateSlotEta(900, a, est).slotsAway, 0, 'past slots clamp to zero');
});

test('projectSlot advances the anchor by elapsed time', () => {
  assert.equal(c.projectSlot({ slot: 100, at: 0 }, 3650, 365), 110);
  assert.equal(c.projectSlot({ slot: 100, at: 1000 }, 0, 365), 100, 'clock behind anchor does not go backwards');
});

test('formatting helpers', () => {
  assert.equal(c.formatDuration(0), '0s');
  assert.equal(c.formatDuration(65_000), '1m 05s');
  assert.equal(c.formatDuration(3_723_000), '1h 02m 03s');
  assert.equal(c.formatDuration(90_061_000), '1d 01h 01m');
  assert.deepEqual(c.countdownParts(3_723_000), { h: 1, m: 2, s: 3 });
  assert.equal(c.skipRate([176, 176]), 0);
  assert.equal(c.skipRate([100, 90]), 0.1);
  assert.equal(c.skipRate([0, 0]), null);
});

test('CSV export is RFC 4180 and neutralises formula injection', () => {
  const csv = c.toCSV([{ a: '=1+1', b: 'x,"y"', c: 3 }]);
  assert.equal(csv, 'a,b,c\r\n\'=1+1,"x,""y""",3\r\n');
  const rows = c.scheduleRows([{ start: 10, end: 13, count: 4 }, { start: 1, end: 4, count: 4 }], { slot: 5, at: 0 }, { msPerSlot: 400, minMs: 400, maxMs: 400 }, 7);
  assert.equal(rows[0].status, 'upcoming');
  assert.equal(rows[0].estimated_start_utc, new Date(2000).toISOString());
  assert.equal(rows[1].status, 'past');
  assert.equal(rows[1].estimated_start_utc, '');
});

// ── Old vs new algorithm on identical inputs ──────────────────────────────
// Faithful port of the pre-upgrade index.html logic (main @ 58df1f3).
function legacy({ epochInfo, schedule, pubkey, slot1, t1, slot2, t2 }) {
  const epochStart = epochInfo.absoluteSlot - epochInfo.slotIndex;
  const rel = schedule[pubkey];
  if (!rel || rel.length === 0) return { noSlots: true };
  const msPerSlot = slot2 - slot1 > 0 ? Math.round((t2 - t1) / (slot2 - slot1)) : 400;
  const upcoming = rel.map((r) => epochStart + r).filter((a) => a > slot2).sort((a, b) => a - b);
  if (!upcoming.length) return { allPassed: true, msPerSlot };
  const diff = upcoming[0] - slot2;
  return { nextSlot: upcoming[0], upcoming, msPerSlot, secs: Math.round((diff * msPerSlot) / 1000) };
}

test('old vs new: identical next slot and upcoming list on recorded X1 data', () => {
  const schedule = { [IDENTITY]: REL };
  const slot1 = EI.absoluteSlot; const t1 = 0;
  const slot2 = slot1 + 8; const t2 = 3000; // 3 s measurement window from the old UI
  const old = legacy({ epochInfo: EI, schedule, pubkey: IDENTITY, slot1, t1, slot2, t2 });
  const start = c.firstSlotInEpoch(EI.epoch, SCHED);
  const { slots } = c.toAbsoluteSlots(REL, start, 216000);
  const { upcoming } = c.splitByCurrent(slots, slot2 + 1); // old used strict ">"
  assert.equal(upcoming[0], old.nextSlot);
  assert.deepEqual(upcoming, old.upcoming);
});

test('old vs new: timing differs because old measured 8 slots in 3 s and rounded', () => {
  const old = legacy({ epochInfo: EI, schedule: { [IDENTITY]: REL }, pubkey: IDENTITY, slot1: 100, t1: 0, slot2: 108, t2: 3000 });
  assert.equal(old.msPerSlot, 375, 'quantised by the short window');
  const noProgress = legacy({ epochInfo: EI, schedule: { [IDENTITY]: REL }, pubkey: IDENTITY, slot1: 100, t1: 0, slot2: 100, t2: 3000 });
  assert.equal(noProgress.msPerSlot, 400, 'old fell back to Solana nominal 400 ms');
  const est = c.estimateSlotTime(SAMPLES);
  assert.ok(Math.abs(est.msPerSlot - 400) > 10, 'new estimate reflects measured X1 slot time');
});

test('old vs new: a slot equal to the current slot was silently dropped by the old code', () => {
  const sched = { [IDENTITY]: [EI.slotIndex + 8] };
  const old = legacy({ epochInfo: EI, schedule: sched, pubkey: IDENTITY, slot1: EI.absoluteSlot, t1: 0, slot2: EI.absoluteSlot + 8, t2: 3000 });
  assert.equal(old.allPassed, true);
  const { upcoming } = c.splitByCurrent([EI.absoluteSlot + 8], EI.absoluteSlot + 8);
  assert.equal(upcoming.length, 1);
});

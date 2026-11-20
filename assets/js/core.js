// X1 Leader Slot Checker — pure scheduling logic.
//
// Shared by the browser UI (assets/js/app.js), the edge API (api/_x1.js) and the test suite.
// No DOM, no network, no globals: every function is deterministic for its inputs so it can be
// tested against recorded X1 Mainnet RPC responses (tests/fixtures).

/** Base58 alphabet used by Solana-compatible (SVM) public keys. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58].map((c, i) => [c, i]));

/** Leaders are assigned in runs of this many consecutive slots (Agave NUM_CONSECUTIVE_LEADER_SLOTS). */
export const CONSECUTIVE_LEADER_SLOTS = 4;

/** Solana-compatible minimum epoch length used during warmup (MINIMUM_SLOTS_PER_EPOCH). */
export const MINIMUM_SLOTS_PER_EPOCH = 32;

/**
 * Fallback slot duration when no performance samples are available. This is the nominal
 * protocol target documented for X1 (docs.x1.xyz: "slots, each fixed at 400 milliseconds").
 * Observed X1 Mainnet slots have been faster than this, so the UI labels it a fallback.
 */
export const NOMINAL_MS_PER_SLOT = 400;

/**
 * Decode a base58 string to bytes. Returns null on any invalid character.
 * @param {string} s
 * @returns {Uint8Array|null}
 */
export function base58Decode(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const le = []; // little-endian magnitude, no leading zero bytes
  for (const ch of s) {
    const v = B58_MAP.get(ch);
    if (v === undefined) return null;
    let carry = v;
    for (let i = 0; i < le.length; i++) {
      carry += le[i] * 58;
      le[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { le.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + le.length);
  for (let i = 0; i < le.length; i++) out[zeros + i] = le[le.length - 1 - i];
  return out;
}

/**
 * True when `s` is a syntactically valid 32-byte SVM public key in base58.
 * This checks encoding only; it does not prove the key is a validator.
 * @param {unknown} s
 */
export function isValidPubkey(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 32 || s.length > 44) return false;
  const b = base58Decode(s);
  return b !== null && b.length === 32;
}

/** Trim whitespace and common paste artefacts (quotes, zero-width characters). */
export function normalizeKeyInput(s) {
  return String(s ?? '').replace(/[\s​-‍﻿"'`]/g, '');
}

function trailingZeros(n) {
  let c = 0;
  while (n > 1 && n % 2 === 0) { n /= 2; c++; }
  return c;
}
function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }

/**
 * Validate the shape of a getEpochSchedule result.
 * @param {any} s
 */
export function isEpochSchedule(s) {
  return !!s && Number.isSafeInteger(s.slotsPerEpoch) && s.slotsPerEpoch > 0
    && Number.isSafeInteger(s.firstNormalEpoch) && Number.isSafeInteger(s.firstNormalSlot)
    && typeof s.warmup === 'boolean';
}

/**
 * First absolute slot of `epoch`, following the Solana-compatible EpochSchedule rules
 * (including warmup epochs). X1 Mainnet: warmup=true, firstNormalEpoch=13,
 * firstNormalSlot=262112, slotsPerEpoch=216000.
 * @param {number} epoch
 * @param {{slotsPerEpoch:number, firstNormalEpoch:number, firstNormalSlot:number, warmup:boolean}} sched
 */
export function firstSlotInEpoch(epoch, sched) {
  if (!isEpochSchedule(sched)) throw new TypeError('invalid epoch schedule');
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError('invalid epoch');
  if (sched.warmup && epoch <= sched.firstNormalEpoch) {
    return (2 ** epoch - 1) * MINIMUM_SLOTS_PER_EPOCH;
  }
  return (epoch - sched.firstNormalEpoch) * sched.slotsPerEpoch + sched.firstNormalSlot;
}

/** Number of slots in `epoch` (warmup-aware). */
export function slotsInEpoch(epoch, sched) {
  if (sched.warmup && epoch < sched.firstNormalEpoch) return 2 ** (epoch + trailingZeros(MINIMUM_SLOTS_PER_EPOCH));
  return sched.slotsPerEpoch;
}

/**
 * Epoch containing an absolute slot (warmup-aware).
 * @returns {{epoch:number, slotIndex:number}}
 */
export function epochForSlot(slot, sched) {
  if (!isEpochSchedule(sched)) throw new TypeError('invalid epoch schedule');
  if (sched.warmup && slot < sched.firstNormalSlot) {
    const epoch = trailingZeros(nextPow2(slot + MINIMUM_SLOTS_PER_EPOCH + 1)) - trailingZeros(MINIMUM_SLOTS_PER_EPOCH) - 1;
    const len = 2 ** (epoch + trailingZeros(MINIMUM_SLOTS_PER_EPOCH));
    return { epoch, slotIndex: slot - (len - MINIMUM_SLOTS_PER_EPOCH) };
  }
  const normal = slot - sched.firstNormalSlot;
  return {
    epoch: sched.firstNormalEpoch + Math.floor(normal / sched.slotsPerEpoch),
    slotIndex: normal % sched.slotsPerEpoch,
  };
}

/**
 * Convert the epoch-relative slot indices returned by getLeaderSchedule into a sorted,
 * de-duplicated list of absolute slots. Invalid entries (negative, non-integer, or outside
 * the epoch) are dropped and counted so the UI can report malformed upstream data.
 * @param {unknown} relative
 * @param {number} epochStart
 * @param {number} epochLength
 * @returns {{slots:number[], dropped:number}}
 */
export function toAbsoluteSlots(relative, epochStart, epochLength) {
  if (!Array.isArray(relative)) return { slots: [], dropped: 0 };
  const seen = new Set();
  let dropped = 0;
  for (const r of relative) {
    if (!Number.isSafeInteger(r) || r < 0 || r >= epochLength) { dropped++; continue; }
    seen.add(epochStart + r);
  }
  dropped += relative.length - dropped - seen.size; // duplicates
  return { slots: [...seen].sort((a, b) => a - b), dropped };
}

/**
 * Group sorted absolute slots into consecutive runs ("leader windows").
 * @param {number[]} slots sorted ascending, unique
 * @returns {{start:number, end:number, count:number}[]}
 */
export function groupConsecutive(slots) {
  const out = [];
  for (const s of slots) {
    const last = out[out.length - 1];
    if (last && s === last.end + 1) { last.end = s; last.count++; }
    else out.push({ start: s, end: s, count: 1 });
  }
  return out;
}

/**
 * Split a validator's slots relative to the current slot. A slot equal to the current
 * slot is treated as "in progress" and counted as upcoming so the countdown reaches zero
 * rather than skipping it.
 */
export function splitByCurrent(slots, currentSlot) {
  let i = 0;
  while (i < slots.length && slots[i] < currentSlot) i++;
  return { past: slots.slice(0, i), upcoming: slots.slice(i) };
}

/**
 * Estimate milliseconds per slot from getRecentPerformanceSamples.
 * Uses the aggregate (total time / total slots) across valid samples, and reports the
 * fastest and slowest individual sample as an uncertainty band. Samples with zero slots or
 * zero duration are ignored. Falls back to the nominal 400 ms when nothing is usable.
 * @param {unknown} samples
 * @returns {{msPerSlot:number, minMs:number, maxMs:number, samples:number, windowSecs:number, source:'performance-samples'|'nominal-fallback'}}
 */
export function estimateSlotTime(samples) {
  const valid = Array.isArray(samples)
    ? samples.filter((s) => s && Number.isFinite(s.numSlots) && s.numSlots > 0
      && Number.isFinite(s.samplePeriodSecs) && s.samplePeriodSecs > 0)
    : [];
  if (valid.length === 0) {
    return { msPerSlot: NOMINAL_MS_PER_SLOT, minMs: NOMINAL_MS_PER_SLOT, maxMs: NOMINAL_MS_PER_SLOT, samples: 0, windowSecs: 0, source: 'nominal-fallback' };
  }
  let slots = 0; let secs = 0; let minMs = Infinity; let maxMs = 0;
  for (const s of valid) {
    slots += s.numSlots; secs += s.samplePeriodSecs;
    const ms = (s.samplePeriodSecs * 1000) / s.numSlots;
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }
  return {
    msPerSlot: (secs * 1000) / slots,
    minMs, maxMs, samples: valid.length, windowSecs: secs, source: 'performance-samples',
  };
}

/**
 * Estimate when `targetSlot` begins, given an observed (slot, timestamp) anchor.
 * Returns the central estimate plus an earliest/latest band derived from the fastest and
 * slowest recently observed slot durations. This is an ESTIMATE: actual production depends
 * on network conditions, skipped slots and forks.
 * @param {number} targetSlot
 * @param {{slot:number, at:number}} anchor  `at` is epoch milliseconds when `slot` was observed
 * @param {{msPerSlot:number, minMs:number, maxMs:number}} est
 */
export function estimateSlotEta(targetSlot, anchor, est) {
  const delta = Math.max(0, targetSlot - anchor.slot);
  return {
    slotsAway: delta,
    at: anchor.at + delta * est.msPerSlot,
    earliest: anchor.at + delta * est.minMs,
    latest: anchor.at + delta * est.maxMs,
  };
}

/**
 * Advance an anchor by wall-clock time to get the estimated current slot between polls.
 */
export function projectSlot(anchor, now, msPerSlot) {
  if (!(msPerSlot > 0)) return anchor.slot;
  return anchor.slot + Math.max(0, Math.floor((now - anchor.at) / msPerSlot));
}

/**
 * Bucket an epoch into `bins` equal ranges and count a validator's slots per bin, for the
 * timeline visualisation. Each bin records whether it lies before/contains/after `current`.
 */
export function bucketEpoch(slots, epochStart, epochLength, bins, currentSlot) {
  const size = epochLength / bins;
  const out = Array.from({ length: bins }, (_, i) => {
    const from = epochStart + Math.floor(i * size);
    const to = epochStart + Math.floor((i + 1) * size) - 1;
    return { from, to, count: 0, phase: currentSlot > to ? 'past' : currentSlot < from ? 'future' : 'current' };
  });
  for (const s of slots) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((s - epochStart) / size)));
    out[i].count++;
  }
  return out;
}

/**
 * Format a millisecond duration as "1d 02h 03m", "2h 03m 04s", "3m 04s" or "4s".
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  let s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const p = (n) => String(n).padStart(2, '0');
  if (d) return `${d}d ${p(h)}h ${p(m)}m`;
  if (h) return `${h}h ${p(m)}m ${p(s)}s`;
  if (m) return `${m}m ${p(s)}s`;
  return `${s}s`;
}

/** Split a duration into countdown parts. */
export function countdownParts(ms) {
  let s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return { h, m, s };
}

/** Format an integer with thin grouping (locale independent for tests). */
export function fmtInt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
}

/** Lamports → XNT (9 decimals, Solana-compatible). */
export function lamportsToXnt(l) {
  return Number.isFinite(l) ? l / 1e9 : NaN;
}

/** Skip rate from getBlockProduction [leaderSlots, blocksProduced]. Null when no slots elapsed. */
export function skipRate(pair) {
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const [leader, produced] = pair;
  if (!Number.isSafeInteger(leader) || !Number.isSafeInteger(produced) || leader <= 0) return null;
  return Math.max(0, (leader - produced) / leader);
}

/**
 * Build export rows for the schedule. Times are estimates and labelled as such.
 * @param {{start:number,end:number,count:number}[]} windows
 * @param {{slot:number, at:number}} anchor
 * @param {{msPerSlot:number,minMs:number,maxMs:number}} est
 * @param {number} epoch
 */
export function scheduleRows(windows, anchor, est, epoch) {
  return windows.map((w) => {
    const eta = estimateSlotEta(w.start, anchor, est);
    const done = w.end < anchor.slot;
    return {
      epoch,
      first_slot: w.start,
      last_slot: w.end,
      slot_count: w.count,
      status: done ? 'past' : w.start <= anchor.slot ? 'in-progress' : 'upcoming',
      estimated_start_utc: done ? '' : new Date(eta.at).toISOString(),
      estimate_earliest_utc: done ? '' : new Date(eta.earliest).toISOString(),
      estimate_latest_utc: done ? '' : new Date(eta.latest).toISOString(),
    };
  });
}

function csvCell(v) {
  const s = String(v ?? '');
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Serialise rows to RFC 4180 CSV. */
export function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

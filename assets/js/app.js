// X1 Leader Slot Checker — browser UI.
// All DOM writes use textContent / createElement; no untrusted string is ever parsed as HTML.
import {
  isValidPubkey, normalizeKeyInput, toAbsoluteSlots, groupConsecutive, splitByCurrent,
  estimateSlotEta, projectSlot, bucketEpoch, formatDuration, countdownParts, fmtInt,
  lamportsToXnt, skipRate, scheduleRows, toCSV,
} from './core.js';

const $ = (id) => document.getElementById(id);
const CLOCK_MS = 20_000;          // live slot recalibration
const REPORT_MS = 5 * 60_000;     // full schedule refresh
const STALE_MS = 75_000;          // network data considered stale after this
const PAGE_SIZE = 25;
const NOTIFY_LEAD_MS = 60_000;
const X1SPACE = 'https://x1space.xyz';

const state = {
  clock: null,          // last /api/clock body
  clockOkAt: 0,
  report: null,         // last /api/leader body
  key: '',
  view: { epoch: 'current', filter: 'upcoming', tz: 'local', page: 0 },
  reqId: 0,
  ctrl: null,
  tick: null,
  notify: { on: false, timer: null, firedFor: null },
};

/* ── small utilities ─────────────────────────────────── */
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const setText = (id, v) => { const n = $(id); if (n) n.textContent = v; };
const short = (k) => (k && k.length > 14 ? `${k.slice(0, 6)}…${k.slice(-6)}` : k || '—');

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2200);
}
async function copyText(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch { toast('Copy failed — select and copy manually'); }
}
function store(key, value) { try { if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null'); localStorage.setItem(key, JSON.stringify(value)); } catch { return null; } return null; }

function fmtTime(ms, tz) {
  const d = new Date(ms);
  const opts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  return tz === 'utc' ? `${d.toLocaleString('en-GB', { ...opts, timeZone: 'UTC' })} UTC` : d.toLocaleString(undefined, opts);
}

async function getJSON(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const err = new Error(body?.message || (res.status === 429 ? 'X1 RPC rate limit reached — try again shortly.' : `Request failed (HTTP ${res.status})`));
    err.status = res.status; err.code = body?.error;
    throw err;
  }
  return body;
}

/* ── status line ─────────────────────────────────────── */
function setStatus(tone, text, retry) {
  const s = $('status');
  s.replaceChildren();
  s.dataset.tone = tone;
  if (tone === 'busy') s.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
  s.append(el('span', { text }));
  if (retry) {
    const b = el('button', { class: 'btn btn-ghost retry', type: 'button', text: 'Retry' });
    b.addEventListener('click', retry);
    s.append(b);
  }
  s.hidden = false;
}

/* ── network strip ───────────────────────────────────── */
function currentAnchor() {
  // Prefer whichever observation is most recent.
  const a = state.report?.anchor; const b = state.clock?.anchor;
  if (a && b) return a.at >= b.at ? a : b;
  return a || b || null;
}
function currentEst() {
  return state.clock?.slotTime || state.report?.slotTime || null;
}

function renderNetwork() {
  const c = state.clock;
  const h = $('net-health');
  const stale = state.clockOkAt && Date.now() - state.clockOkAt > STALE_MS;
  if (!c) return;
  h.dataset.state = stale ? 'stale' : c.health?.ok ? 'ok' : 'down';
  setText('net-health-text', stale ? 'Stale data' : c.health?.ok ? 'RPC healthy' : 'RPC degraded');
  const est = c.slotTime;
  const now = Date.now();
  const slot = projectSlot(c.anchor, now, est.msPerSlot);
  const ei = c.epochInfo;
  const idx = Math.min(ei.slotsInEpoch, ei.slotIndex + (slot - c.anchor.slot));
  const pct = (idx / ei.slotsInEpoch) * 100;
  setText('net-epoch', fmtInt(ei.epoch));
  setText('net-slot', fmtInt(slot));
  setText('net-slotms', `${Math.round(est.msPerSlot)} ms`);
  setText('net-epoch-eta', formatDuration((ei.slotsInEpoch - idx) * est.msPerSlot));
  $('net-bar-fill').style.width = `${pct.toFixed(2)}%`;
  $('net-bar').setAttribute('aria-valuenow', pct.toFixed(1));
  setText('net-progress', `Epoch ${pct.toFixed(1)}% · ${fmtInt(ei.slotsInEpoch - idx)} slots left`);
  const age = Math.max(0, Math.round((now - c.anchor.at) / 1000));
  setText('net-updated', `Updated ${age}s ago`);
}

async function refreshClock() {
  if (document.visibilityState === 'hidden') return;
  try {
    const body = await getJSON('/api/clock');
    const prevEpoch = state.clock?.epochInfo?.epoch;
    state.clock = body; state.clockOkAt = Date.now();
    renderNetwork();
    // Epoch rolled over while a report is open: the schedule must be re-fetched.
    if (state.report && prevEpoch !== undefined && body.epochInfo.epoch !== prevEpoch) loadReport(state.key, { quiet: true });
    if (state.report) { renderTable(); renderTimeline(); scheduleNotification(); }
  } catch {
    const h = $('net-health');
    h.dataset.state = state.clock ? 'stale' : 'down';
    setText('net-health-text', state.clock ? 'Reconnecting…' : 'RPC unreachable');
  }
}

/* ── report loading ──────────────────────────────────── */
function showFieldError(msg) {
  const e = $('pubkey-error');
  e.textContent = msg; e.hidden = !msg;
  $('pubkey').setAttribute('aria-invalid', msg ? 'true' : 'false');
}

function syncUrl(key) {
  const url = new URL(location.href);
  if (key) url.searchParams.set('validator', key); else url.searchParams.delete('validator');
  history.replaceState(null, '', url);
  // Validator-specific URLs are shareable but must not be indexed as separate pages.
  const robots = document.querySelector('meta[name="robots"]');
  if (robots) robots.content = key ? 'noindex, follow' : 'index, follow, max-image-preview:large';
}

async function loadReport(key, { quiet = false } = {}) {
  state.ctrl?.abort();
  const ctrl = new AbortController();
  state.ctrl = ctrl;
  const id = ++state.reqId;
  const btn = $('check-btn');
  if (!quiet) { btn.disabled = true; setStatus('busy', 'Reading leader schedule from X1 Mainnet…'); }
  try {
    const body = await getJSON(`/api/leader?key=${encodeURIComponent(key)}`, ctrl.signal);
    if (id !== state.reqId) return; // superseded by a newer lookup
    state.report = body; state.key = key;
    if (!quiet) state.view = { ...state.view, epoch: 'current', page: 0 };
    rememberRecent(key, body.validatorInfo?.name);
    renderReport();
    const n = body.current.relativeSlots.length;
    setStatus(n ? 'ok' : 'warn', n
      ? `Live · ${fmtInt(n)} leader slots this epoch · observed ${new Date(body.observedAt).toLocaleTimeString()}`
      : 'No leader slots scheduled for this identity in the current epoch.');
  } catch (e) {
    if (e.name === 'AbortError' || id !== state.reqId) return;
    if (e.code === 'invalid_pubkey') { showFieldError(e.message); $('status').hidden = true; }
    else setStatus('error', e.message || 'Could not reach X1 RPC.', () => loadReport(key));
  } finally {
    if (id === state.reqId) btn.disabled = false;
  }
}

/* ── rendering ───────────────────────────────────────── */
function epochModel(which) {
  const r = state.report;
  const e = which === 'next' ? r.next : r.current;
  if (which === 'next' && !e.available) return { ...e, slots: [], windows: [], unavailable: true };
  const { slots, dropped } = toAbsoluteSlots(e.relativeSlots, e.firstSlot, e.slotsInEpoch);
  return { ...e, slots, dropped, windows: groupConsecutive(slots) };
}

function renderValidator() {
  const r = state.report;
  const v = r.voteAccount; const info = r.validatorInfo;
  setText('v-name', info?.name || 'Unnamed validator');
  const tags = $('v-tags'); tags.replaceChildren();
  if (v) tags.append(el('span', { class: `tag ${v.delinquent ? 'bad' : 'ok'}`, text: v.delinquent ? 'Delinquent' : 'Active · voting' }));
  else tags.append(el('span', { class: 'tag neutral', text: 'No vote account found' }));
  tags.append(el('span', { class: 'tag neutral', text: r.inputType === 'vote' ? 'Resolved from vote account' : 'Identity key' }));
  setText('v-identity', r.identity);
  setText('v-vote', v?.votePubkey || '—');
  setText('v-stake', v ? `${fmtInt(lamportsToXnt(v.activatedStake))} XNT` : '—');
  setText('v-commission', v ? `${v.commission}%` : '—');
  const note = $('v-note'); note.replaceChildren();
  if (info?.name) note.append('Name is self-published on-chain (validator info) and not verified. ');
  if (info?.website) note.append(el('a', { href: info.website, target: '_blank', rel: 'noopener nofollow ugc', text: 'Website ↗' }), ' ');
  if (v) note.append(el('a', { href: `${X1SPACE}/ValidatorDetail?id=${encodeURIComponent(v.votePubkey)}`, target: '_blank', rel: 'noopener', text: 'View on X1 Space ↗' }));
  else note.append(el('a', { href: `${X1SPACE}/AddressLookup?address=${encodeURIComponent(r.identity)}`, target: '_blank', rel: 'noopener', text: 'Look up address on X1 Space ↗' }));
  document.querySelectorAll('.copy').forEach((b) => { b.hidden = $(b.dataset.copy).textContent === '—'; });
}

function renderEpochAndProduction() {
  const r = state.report; const est = currentEst(); const anchor = currentAnchor();
  const cur = epochModel('current');
  const slotNow = projectSlot(anchor, Date.now(), est.msPerSlot);
  const idx = Math.min(cur.slotsInEpoch, slotNow - cur.firstSlot);
  setText('e-epoch', fmtInt(cur.epoch));
  setText('e-pct', `${((idx / cur.slotsInEpoch) * 100).toFixed(1)}%`);
  setText('e-left', fmtInt(cur.slotsInEpoch - idx));
  setText('e-eta', formatDuration((cur.slotsInEpoch - idx) * est.msPerSlot));
  const { upcoming } = splitByCurrent(cur.slots, slotNow);
  setText('p-total', fmtInt(cur.slots.length));
  setText('p-remaining', fmtInt(upcoming.length));
  const p = r.production;
  if (p && p.leaderSlots > 0) {
    const sr = skipRate([p.leaderSlots, p.blocksProduced]);
    $('p-produced').replaceChildren(fmtInt(p.blocksProduced), el('small', { text: ` / ${fmtInt(p.leaderSlots)}` }));
    setText('p-skip', sr === null ? '—' : `${(sr * 100).toFixed(1)}%`);
  } else {
    setText('p-produced', p ? '0' : '—');
    setText('p-skip', '—');
  }
}

function renderNext() {
  const est = currentEst(); const anchor = currentAnchor();
  const cur = epochModel('current'); const nxt = epochModel('next');
  const slotNow = projectSlot(anchor, Date.now(), est.msPerSlot);
  const upcomingCur = splitByCurrent(cur.slots, slotNow).upcoming;
  const nextSlot = upcomingCur[0] ?? splitByCurrent(nxt.slots, slotNow).upcoming[0];
  const hasNext = nextSlot !== undefined;
  $('n-body').hidden = !hasNext; $('n-empty').hidden = hasNext;
  if (!hasNext) {
    setText('n-empty-title', cur.slots.length ? 'All leader slots this epoch have elapsed' : 'No leader slots this epoch');
    setText('n-empty-text', nxt.unavailable
      ? 'The next epoch\'s schedule is not available from the RPC node yet. Check again after the epoch boundary.'
      : cur.slots.length || nxt.slots.length ? 'No upcoming slots in the next epoch either.'
        : 'This identity has no leader slots in the current or next epoch. Validators with little or no activated stake are rarely scheduled; confirm the key is the node identity or its vote account.');
    return null;
  }
  const win = [...cur.windows, ...nxt.windows].find((w) => nextSlot >= w.start && nextSlot <= w.end);
  const eta = estimateSlotEta(nextSlot, anchor, est);
  setText('n-slot', fmtInt(nextSlot));
  setText('n-window', win ? `${win.count} slot${win.count > 1 ? 's' : ''}` : '—');
  setText('n-local', fmtTime(eta.at, 'local'));
  setText('n-utc', fmtTime(eta.at, 'utc'));
  const spread = Math.max(eta.at - eta.earliest, eta.latest - eta.at);
  setText('n-range', `± ${formatDuration(spread || 1000)}`);
  const inNext = nextSlot >= nxt.firstSlot;
  setText('n-note', `${inNext ? 'Next epoch. ' : ''}Estimated from ${est.source === 'performance-samples'
    ? `${est.samples} recent performance samples (avg ${Math.round(est.msPerSlot)} ms/slot, range ${Math.round(est.minMs)}–${Math.round(est.maxMs)} ms)`
    : 'the nominal 400 ms slot time (no recent samples available)'}. Actual timing can differ.`);
  return { nextSlot, eta };
}

function tick() {
  if (!state.report) return;
  const est = currentEst(); const anchor = currentAnchor();
  const res = renderNext();
  if (res) {
    const remaining = Math.max(0, res.eta.at - Date.now());
    const slotNow = projectSlot(anchor, Date.now(), est.msPerSlot);
    const { h, m, s } = countdownParts(remaining);
    setText('cd-h', String(h).padStart(2, '0'));
    setText('cd-m', String(m).padStart(2, '0'));
    setText('cd-s', String(s).padStart(2, '0'));
    setText('n-away', fmtInt(Math.max(0, res.nextSlot - slotNow)));
    $('countdown').classList.toggle('live', remaining < 60_000);
    setText('cd-text', `Approximately ${formatDuration(remaining)} until slot ${fmtInt(res.nextSlot)}`);
  }
  renderEpochAndProduction();
  renderNetwork();
}

function renderTimeline() {
  const est = currentEst(); const anchor = currentAnchor();
  const m = epochModel(state.view.epoch);
  const box = $('timeline'); box.replaceChildren();
  setText('t-epoch', `Epoch ${fmtInt(m.epoch)}`);
  if (m.unavailable) { box.append(el('p', { class: 'note', text: 'The next epoch\'s leader schedule is not yet available from X1 RPC.' })); return; }
  const slotNow = projectSlot(anchor, Date.now(), est.msPerSlot);
  const bins = window.matchMedia('(max-width: 640px)').matches ? 72 : 144;
  const buckets = bucketEpoch(m.slots, m.firstSlot, m.slotsInEpoch, bins, slotNow);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const W = 1000; const H = 96; const top = 6; const base = 70; const bw = W / bins;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'timeline'); svg.setAttribute('role', 'img');
  const upcomingCount = m.slots.filter((s) => s >= slotNow).length;
  svg.setAttribute('aria-label', `Epoch ${m.epoch} timeline: ${m.slots.length} leader slots in ${m.windows.length} windows, ${upcomingCount} upcoming. The table below lists every window.`);
  buckets.forEach((b, i) => {
    const r = document.createElementNS(NS, 'rect');
    const hgt = b.count ? 10 + ((base - top - 10) * b.count) / max : 4;
    r.setAttribute('x', (i * bw + 0.6).toFixed(2)); r.setAttribute('width', Math.max(0.8, bw - 1.2).toFixed(2));
    r.setAttribute('y', (base - hgt).toFixed(2)); r.setAttribute('height', hgt.toFixed(2)); r.setAttribute('rx', '1.5');
    r.setAttribute('class', `bin ${b.count ? 'has' : ''} ${b.phase}`);
    const t = document.createElementNS(NS, 'title');
    t.textContent = `Slots ${fmtInt(b.from)}–${fmtInt(b.to)}: ${b.count} leader slot${b.count === 1 ? '' : 's'}`;
    r.append(t); svg.append(r);
  });
  if (slotNow >= m.firstSlot && slotNow < m.firstSlot + m.slotsInEpoch) {
    const x = ((slotNow - m.firstSlot) / m.slotsInEpoch) * W;
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('x1', x); l.setAttribute('x2', x); l.setAttribute('y1', 0); l.setAttribute('y2', base + 2); l.setAttribute('class', 'now');
    svg.append(l);
  }
  [[0, 'start'], [0.5, 'middle'], [1, 'end']].forEach(([f, anchorPos]) => {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', f * W); t.setAttribute('y', 90); t.setAttribute('text-anchor', anchorPos); t.setAttribute('class', 'axis');
    t.textContent = fmtInt(m.firstSlot + Math.round(f * (m.slotsInEpoch - 1)));
    svg.append(t);
  });
  box.append(svg);
}

function renderTable() {
  const est = currentEst(); const anchor = currentAnchor();
  const { epoch, filter, tz } = state.view;
  const m = epochModel(epoch);
  const body = $('s-body'); body.replaceChildren();
  document.querySelectorAll('[data-epoch]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.epoch === epoch));
    if (b.dataset.epoch === 'next') b.disabled = !state.report.next.available;
  });
  document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
  document.querySelectorAll('[data-tz]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tz === tz)));
  const slotNow = projectSlot(anchor, Date.now(), est.msPerSlot);
  const all = m.windows.map((w, i) => ({ ...w, n: i + 1, status: w.end < slotNow ? 'past' : w.start <= slotNow ? 'prog' : 'up' }));
  const rows = all.filter((w) => filter === 'all' || (filter === 'past' ? w.status === 'past' : w.status !== 'past'));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.view.page = Math.min(state.view.page, pages - 1);
  const pageRows = rows.slice(state.view.page * PAGE_SIZE, (state.view.page + 1) * PAGE_SIZE);
  setText('s-caption', m.unavailable
    ? `Epoch ${fmtInt(m.epoch)} schedule not yet available.`
    : `Epoch ${fmtInt(m.epoch)}: ${fmtInt(m.slots.length)} leader slots in ${fmtInt(m.windows.length)} windows. Showing ${rows.length} ${filter === 'all' ? '' : filter === 'past' ? 'elapsed ' : 'upcoming '}windows. Times are estimates (${tz === 'utc' ? 'UTC' : 'your local time'}).`);
  if (!pageRows.length) {
    body.append(el('tr', {}, el('td', { colspan: 7, class: 'empty', text: m.unavailable ? 'Not yet available.' : filter === 'past' ? 'No elapsed leader windows yet.' : 'No upcoming leader windows.' })));
  }
  const firstUp = all.find((w) => w.status !== 'past');
  for (const w of pageRows) {
    const eta = estimateSlotEta(w.start, anchor, est);
    const statusPill = el('span', { class: `pill ${w.status}`, text: w.status === 'past' ? 'Elapsed' : w.status === 'prog' ? 'Now' : 'Upcoming' });
    const slots = w.count > 1 ? `${fmtInt(w.start)} – ${fmtInt(w.end)}` : fmtInt(w.start);
    const link = w.status === 'past'
      ? el('a', { href: `${X1SPACE}/BlockDetail?slot=${w.start}`, target: '_blank', rel: 'noopener', 'aria-label': `View slot ${w.start} on X1 Space`, text: 'Block ↗' })
      : '';
    body.append(el('tr', { class: w === firstUp ? 'is-next' : w.status === 'past' ? 'is-past' : '' },
      el('td', { text: w.n }), el('td', { text: slots }), el('td', { text: w.count }), el('td', {}, statusPill),
      el('td', { text: w.status === 'past' ? '—' : fmtTime(eta.at, tz) }),
      el('td', { text: w.status === 'past' ? '—' : formatDuration(eta.at - Date.now()) }),
      el('td', {}, link)));
  }
  const pager = $('pager'); pager.replaceChildren();
  if (pages > 1) {
    const prev = el('button', { class: 'btn btn-ghost', type: 'button', text: '← Prev', disabled: state.view.page === 0 });
    const next = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Next →', disabled: state.view.page >= pages - 1 });
    prev.addEventListener('click', () => { state.view.page--; renderTable(); });
    next.addEventListener('click', () => { state.view.page++; renderTable(); });
    pager.append(prev, el('span', { text: `Page ${state.view.page + 1} of ${pages}` }), next);
  }
}

function renderReport() {
  $('results').hidden = false;
  renderValidator();
  renderTimeline();
  renderTable();
  tick();
  clearInterval(state.tick);
  state.tick = setInterval(tick, 1000);
  scheduleNotification();
}

/* ── export / share / notify ─────────────────────────── */
function exportRows() {
  const m = epochModel(state.view.epoch);
  return scheduleRows(m.windows, currentAnchor(), currentEst(), m.epoch);
}
function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function fileBase() { return `x1-leader-schedule-${state.report.identity.slice(0, 8)}-epoch-${epochModel(state.view.epoch).epoch}`; }

function scheduleNotification() {
  clearTimeout(state.notify.timer);
  if (!state.notify.on || !state.report || !('Notification' in window) || Notification.permission !== 'granted') return;
  const est = currentEst(); const anchor = currentAnchor();
  const cur = epochModel('current'); const nxt = epochModel('next');
  const slotNow = projectSlot(anchor, Date.now(), est.msPerSlot);
  const next = splitByCurrent([...cur.slots, ...nxt.slots], slotNow + 1).upcoming[0];
  if (next === undefined || state.notify.firedFor === next) return;
  const delay = estimateSlotEta(next, anchor, est).at - Date.now() - NOTIFY_LEAD_MS;
  if (delay > 2 ** 31 - 1) return;
  state.notify.timer = setTimeout(() => {
    state.notify.firedFor = next;
    try { new Notification('X1 leader slot in about a minute', { body: `Slot ${fmtInt(next)} for ${state.report.validatorInfo?.name || short(state.report.identity)} (estimate)`, tag: `x1-leader-${next}` }); } catch { /* ignore */ }
  }, Math.max(0, delay));
}

async function toggleNotify() {
  const b = $('notify-btn');
  if (!('Notification' in window)) { toast('Notifications are not supported in this browser'); return; }
  if (state.notify.on) { state.notify.on = false; clearTimeout(state.notify.timer); b.setAttribute('aria-pressed', 'false'); toast('Notifications off'); return; }
  const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (p !== 'granted') { toast('Notification permission was not granted'); return; }
  state.notify.on = true; b.setAttribute('aria-pressed', 'true');
  toast('You\'ll be notified ~1 minute before the next slot while this tab is open');
  scheduleNotification();
}

/* ── recent lookups ──────────────────────────────────── */
function rememberRecent(key, name) {
  const list = (store('x1lsc.recent') || []).filter((r) => r && r.key !== key);
  list.unshift({ key, name: name || null });
  store('x1lsc.recent', list.slice(0, 5));
  renderRecent();
}
function renderRecent() {
  const list = (store('x1lsc.recent') || []).filter((r) => r && isValidPubkey(r.key));
  const box = $('recent'); box.replaceChildren();
  if (!list.length) { box.hidden = true; return; }
  box.append(el('span', { text: 'Recent:' }));
  for (const r of list) {
    const c = el('button', { class: 'chip', type: 'button', title: r.key, text: r.name ? `${String(r.name).slice(0, 24)} · ${r.key.slice(0, 4)}…` : short(r.key) });
    c.addEventListener('click', () => { $('pubkey').value = r.key; submit(); });
    box.append(c);
  }
  box.hidden = false;
}

/* ── wiring ──────────────────────────────────────────── */
function submit(ev) {
  ev?.preventDefault();
  const key = normalizeKeyInput($('pubkey').value);
  $('pubkey').value = key;
  if (!key) { showFieldError('Enter a validator identity or vote account.'); $('pubkey').focus(); return; }
  if (!isValidPubkey(key)) { showFieldError('That is not a valid X1 public key. Keys are 32–44 base58 characters (no 0, O, I or l).'); $('pubkey').focus(); return; }
  showFieldError('');
  syncUrl(key);
  loadReport(key);
}

function initNav() {
  const toggle = document.querySelector('.nav-toggle'); const nav = $('site-nav');
  toggle.addEventListener('click', () => {
    const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); } });
  const btn = document.querySelector('.menu-btn'); const list = $('launch-menu');
  const close = () => { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', () => { const open = list.hidden; list.hidden = !open; btn.setAttribute('aria-expanded', String(open)); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!list.hidden) { close(); btn.focus(); } if (nav.classList.contains('open')) { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); } } });
}

function init() {
  initNav();
  $('lookup-form').addEventListener('submit', submit);
  $('pubkey').addEventListener('input', () => { if (!$('pubkey-error').hidden) showFieldError(''); });
  document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', () => copyText($(b.dataset.copy).textContent)));
  document.querySelectorAll('[data-epoch]').forEach((b) => b.addEventListener('click', () => { state.view.epoch = b.dataset.epoch; state.view.page = 0; renderTimeline(); renderTable(); }));
  document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { state.view.filter = b.dataset.filter; state.view.page = 0; renderTable(); }));
  document.querySelectorAll('[data-tz]').forEach((b) => b.addEventListener('click', () => { state.view.tz = b.dataset.tz; renderTable(); }));
  $('share-btn').addEventListener('click', () => { const u = new URL(location.origin + location.pathname); u.searchParams.set('validator', state.key); copyText(u.toString(), 'Share link copied'); });
  $('csv-btn').addEventListener('click', () => download(`${fileBase()}.csv`, 'text/csv;charset=utf-8', toCSV(exportRows())));
  $('json-btn').addEventListener('click', () => {
    const r = state.report; const m = epochModel(state.view.epoch);
    download(`${fileBase()}.json`, 'application/json', JSON.stringify({
      network: r.network, source: r.source, exportedAt: new Date().toISOString(), observedAt: r.observedAt,
      identity: r.identity, voteAccount: r.voteAccount?.votePubkey ?? null, epoch: m.epoch, firstSlot: m.firstSlot,
      slotsInEpoch: m.slotsInEpoch, slotTimeEstimate: currentEst(), note: 'Estimated times are projections, not guarantees.',
      windows: exportRows(),
    }, null, 2));
  });
  $('notify-btn').addEventListener('click', toggleNotify);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshClock(); if (state.report && Date.now() - state.report.anchor.at > REPORT_MS) loadReport(state.key, { quiet: true }); } });
  renderRecent();

  refreshClock();
  setInterval(refreshClock, CLOCK_MS);
  setInterval(() => { if (state.report && document.visibilityState === 'visible') loadReport(state.key, { quiet: true }); }, REPORT_MS);

  const initial = normalizeKeyInput(new URLSearchParams(location.search).get('validator'));
  if (initial) { $('pubkey').value = initial; submit(); }
}

init();

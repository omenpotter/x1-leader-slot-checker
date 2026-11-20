# Leader Slot Checker — Upgrade Report

Branch `claude/bold-ritchie-g1l48h`. No framework added; still static HTML + Vercel edge functions.

## New architecture

| File | Role |
|---|---|
| `assets/js/core.js` | Pure, tested scheduling logic shared by browser, API and tests (base58 validation, warmup-aware epoch math, slot conversion, window grouping, slot-time estimation, ETA bands, CSV). |
| `api/_x1.js` | Server helpers: method allowlist, upstream timeout + bounded retry honouring `Retry-After`, aggregated report, validator-info parsing. `_` prefix = not a route. |
| `api/leader.js` | `GET /api/leader?key=` → full report in **2 upstream round trips**. CDN-cached `s-maxage=15, swr=30`. |
| `api/clock.js` | `GET /api/clock` → slot, epoch, health, slot time. CDN-cached `s-maxage=2`. |
| `api/rpc.js` | Kept for compatibility; hardened (allowlist of 10 read methods, ≤4 calls/batch, ≤4 KB, filtered `getLeaderSchedule` required, same-origin only). |
| `assets/js/app.js` | UI. All DOM writes via `textContent`/`createElement`. |
| `index.html`, `guide.html`, `404.html` | Redesign, educational content, JSON-LD. |

## Algorithm changes and justification

| Change | Old | New | Why |
|---|---|---|---|
| Schedule fetch | Unfiltered (~1.4 MB) | `getLeaderSchedule(null,{identity})` (~1.6 KB) | Same data for the identity; ~99.9% smaller; verified identical on live data. |
| Epoch start | `absoluteSlot − slotIndex` | `firstSlotInEpoch(epoch, getEpochSchedule)` (warmup-aware) | Needed for the *next* epoch; equals old value for current epoch (tested). |
| Slot time | 3 s two-point sample, 400 ms fallback | Aggregate of up to 15 × 60 s `getRecentPerformanceSamples`; min/max sample band; 400 ms fallback labelled | Measured: new estimate error +162 ms @100 slots, +445 ms @300 slots (inside band); 400 ms assumption error −3.2 s / −9.8 s. Removes the 3 s wait. |
| Current-slot edge | `> slot` (drops in-progress slot) | `>= slot` | Countdown reaches the slot instead of skipping it. |
| Recalibration | None | Anchor refreshed from `/api/clock` every 20 s (paused when tab hidden); report every 5 min; immediate refetch on epoch rollover | Prevents drift and stale schedules. |
| Next epoch | Not supported | Fetched with a slot in epoch+1; `null` → "not yet available" | X1 publishes one epoch ahead (`leaderScheduleSlotOffset=216000`). |
| Input | Identity only | Identity **or vote account** (resolved via `getVoteAccounts`) | Operators often know their vote account. |
| Race conditions | None | `AbortController` + request id; superseded responses ignored | Rapid re-submits can't render stale data. |

## Features added (all from real RPC data)

- Validator panel: self-published name/website (labelled unverified), identity, vote account, stake (XNT), commission, active/delinquent, X1 Space deep link.
- Next leader slot: countdown, slot, slots away, window size, local + UTC ETA, ± range, methodology note.
- Epoch panel: progress, slots left, estimated end.
- Production: scheduled, remaining, produced / elapsed leader slots, skip rate (`getBlockProduction`).
- SVG epoch timeline (72/144 bins, "now" marker, `<title>` per bin, `role=img` summary; table is the text alternative).
- Leader-window table: current/next epoch, upcoming/elapsed/all filter, local/UTC, pagination (25), elapsed rows link to `x1space.xyz/BlockDetail?slot=`.
- CSV (formula-injection safe) and JSON export; copy share link (`/?validator=`, noindex); optional browser notification ~60 s before next slot (permission-gated, tab must be open); recent lookups (localStorage, try/catch).
- Network strip: live epoch, slot, slot time, epoch end ETA, RPC health with stale detection.

## Not implemented (and why)

- **Validator comparison / historical epoch comparison**: X1 RPC does not serve past-epoch leader schedules (`getLeaderSchedule` returns `null` outside the current/next epoch) and `getBlockProduction` history requires per-slot ranges; no reliable source without an indexer.
- **Server-push notifications**: would need accounts/storage; out of scope for a read-only tool.

## Design

"Validator Command Center": midnight/graphite surfaces, teal-cyan signal colour with controlled blue, Inter + JetBrains Mono (self-hosted, latin subset), tabular numerics, 12-column dashboard, mobile menu, reduced-motion support, WCAG-contrast muted text. Original logo/favicons, nav links (X, Telegram, Launch my Validator → Manual/One-liner, Manage Validator, Explorer) and footer tagline preserved. Screenshots: `docs/screenshots/before`, `docs/screenshots/after`.

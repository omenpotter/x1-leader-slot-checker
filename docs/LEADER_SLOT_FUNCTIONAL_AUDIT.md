# Leader Slot Checker — Functional Audit (pre-upgrade baseline)

Audited: `main` @ `58df1f3` (identical to live https://x1-leader-slot-checker.vercel.app — byte diff of served HTML vs repo `index.html` = no differences, 2026-11-20).

## Inventory

| Component | Implementation | Finding |
|---|---|---|
| Frontend | Single `index.html` (977 lines), inline CSS + ES5 script | Works; no build step. Google Fonts render-blocking. |
| API | `api/rpc.js` edge function proxying any JSON-RPC body to `https://rpc.mainnet.x1.xyz` | **Open proxy**: any method (incl. `sendTransaction`), any batch size, `Access-Control-Allow-Origin: *`. Errors returned with raw `e.message`. Upstream status always rewritten to 200. No timeout. |
| Analytics | `/_vercel/insights/script.js` with a `window.si` queue stub | Queue name is the Speed-Insights one (`si`), not Analytics (`va`); harmless but wrong. |
| Config | `vercel.json`: `cleanUrls`, `trailingSlash:false` | No security headers, no cache rules. |
| SEO | Title + description only | No canonical, OG/Twitter, robots.txt, sitemap, JSON-LD, or explanatory content. Live `/robots.txt` and `/sitemap.xml` return 404. |

## How the old checker worked

1. **Input**: identity pubkey only. Validation = non-empty string (`alert()` otherwise). Vote accounts silently returned "no slots".
2. **Round trip 1** (batch): `getSlot`, `getEpochInfo`, `getLeaderSchedule` **without an identity filter** — downloads the full epoch schedule (**~1.4 MB, 297 leaders, 216,000 slots** on 2026-11-20) on every click.
3. `epochStart = absoluteSlot − slotIndex` (correct).
4. **Sleeps 3 s**, then `getSlot` again; `msPerSlot = round(Δt / Δslot)` — ~8 slots, quantised (e.g. 375 ms), falls back to **400 ms** if no progress.
5. Upcoming = `epochStart + rel` filtered with `> slot2` (a slot *equal* to the current slot is dropped).
6. Countdown anchored at `t2`; never recalibrated; never refreshed; no epoch rollover handling.

## Accuracy questions answered

| Question | Answer |
|---|---|
| Identity validation | None beyond non-empty. Invalid keys reached RPC (`-32602 WrongSize`). |
| Current epoch/slot retrieval | Correct (`getEpochInfo`). |
| Leader schedule retrieval | Correct data, but unfiltered (1.4 MB) every time. |
| Upcoming slot calculation | Correct set, except the in-progress slot edge case. Verified identical to the new algorithm on live data for 4 validators (see RPC validation). |
| Epoch boundaries | Not handled: no next-epoch schedule; after the last slot the UI said "rotates approximately every 2 days" — **wrong for X1** (216,000-slot epochs ≈ 22 h). |
| X1 vs Solana assumptions | 400 ms fallback and "2 days per epoch" are Solana assumptions. Measured X1 average was ~365–366 ms. |
| Timestamps | Estimated, unlabeled, no uncertainty. |
| Caching | `no-store`; every user = full upstream calls. Through Vercel's shared egress, this consumes the per-IP public RPC limit (300 req/5 s, 150k/h). |
| Staleness | Countdown never re-synced; long-open tabs drift. |
| Errors | `setStatus()` injected `e.message` via `innerHTML` — **XSS sink** for upstream error text. |
| Large schedules | Pills capped at 20 (+N more); full schedule always downloaded. |

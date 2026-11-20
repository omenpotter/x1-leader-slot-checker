# Leader Slot Checker — Test Results (2026-11-20)

| Suite | Command | Result |
|---|---|---|
| Unit (core + API, recorded X1 fixtures) | `npm test` | **33 / 33 pass** |
| Browser E2E (Playwright/Chromium, fixture RPC) | `npm run test:e2e` | **16 / 16 pass** |
| Live X1 Mainnet cross-validation | `npm run test:live` | **All checks pass** (4 validators) |
| Timing accuracy (live) | ad-hoc script, results in RPC validation | within predicted band |
| Lighthouse (local server, no compression) | see below | |

## Coverage map

| Requirement | Test(s) |
|---|---|
| Leader slot calculation | `recorded schedule converts…`, live cross-check |
| Epoch boundaries (incl. warmup) | `epoch boundaries…`, `epoch math matches X1 Mainnet RPC` |
| Invalid validator addresses | `pubkey validation…`, `invalid keys never reach the RPC`, E2E `invalid input…` |
| Vote-account resolution | `leader report resolves a vote account…`, E2E lookup by vote account |
| RPC failures and recovery | `transient 5xx recovers`, `one failed sub-request…`, E2E `API failure shows error with retry` |
| Rate limits | `rate limit (429) is retried once then surfaced with Retry-After` |
| Delayed responses / outage | `network outage / timeout returns 504` |
| Stale data | network strip stale state (manual), recalibration logic; `projectSlot` tests |
| Incorrect slot-time assumptions | `slot time estimate…`, `old vs new: timing differs…` |
| Empty / missing schedules | `empty schedule…`, `next epoch schedule not yet available`, E2E empty state |
| Very large schedules | `very large schedule (an entire epoch)` (216,000 slots < 1 s), live 12,404-slot validator |
| Duplicate / out-of-order data | `duplicate, out-of-order and malformed slot data…` |
| Old vs new on identical inputs | three `old vs new` tests + live comparison |
| SEO metadata, canonical, JSON-LD | E2E `home: SEO metadata…`, `guide page…` |
| Sitemap, robots, status codes, redirects, CSP | E2E `status codes, redirects, robots and sitemap` |
| Server-visible content (no JS) | E2E `server-visible content exists without JavaScript` |
| Keyboard navigation | E2E `keyboard: skip link, mobile menu…` |
| Responsive breakpoints | E2E overflow at 320/375/768/1024/1440 |
| Reduced motion | E2E `reduced motion disables animation` |
| Security (proxy allowlist, CORS, XSS-safe validator info, CSV injection) | `proxy allowlist…`, `rpc proxy…`, `validator info parsing…`, `CSV export…` |

## Lighthouse

| Page | Before (live) mobile | After (local) mobile | Before desktop | After desktop |
|---|---|---|---|---|
| `/` Performance | 83 | 95 | 98 | 100 |
| `/` Accessibility | 92 | 100 | 92 | 100 |
| `/` Best practices | 100 | 100 | 100 | 100 |
| `/` SEO | 100 | 100 | 100 | 100 |
| `/` LCP | 4.6 s | 2.8 s | 1.1 s | 0.6 s |
| `/guide` | — | 96 / 100 / 100 / 100 | — | — |

"After" was measured on the local dev server, which does not compress responses; Vercel serves Brotli/gzip, so production should be equal or better. Must be re-measured after deployment (owner action).

## Environment limitations

- Vercel production/preview was not deployed (not authorised). Edge functions were executed locally under Node 22 with the same `Request → Response` interface.
- Browser notifications were not exercised in headless Chromium (permission UI).

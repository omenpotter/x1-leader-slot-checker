# X1 Leader Slot Checker

Read-only web tool showing an X1 Mainnet validator's leader schedule: next leader slot with an estimated time and uncertainty range, every leader window in the current and next epoch, and blocks produced versus slots scheduled. Static HTML + Vercel edge functions; no wallet, no build step.

Production: https://x1-leader-slot-checker.vercel.app

## Develop

```bash
npm run dev                       # http://localhost:4173, live X1 RPC
FIXTURE_RPC=1 npm run dev         # recorded RPC fixtures, fully offline
npm test                          # unit tests (recorded X1 fixtures)
npm run test:e2e                  # Playwright browser tests
npm run test:live                 # cross-check against live X1 Mainnet
```

## Layout

- `assets/js/core.js` — pure scheduling logic (shared by UI, API and tests)
- `api/leader.js`, `api/clock.js` — cached, aggregated read-only endpoints; `api/rpc.js` — hardened allowlisted proxy; `api/_x1.js` — shared server helpers
- `index.html`, `guide.html`, `404.html` — pages; `robots.txt`, `sitemap.xml`, `llms.txt`
- `docs/LEADER_SLOT_*.md` — audit, upgrade report, RPC validation, test results, rollback plan

Built by ARKBS Labs. Independent; not affiliated with the X1 core team.

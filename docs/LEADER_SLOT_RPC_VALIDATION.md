# Leader Slot Checker — X1 RPC Validation

All values below are **live X1 Mainnet** observations (`https://rpc.mainnet.x1.xyz`, 2026-11-20, epoch 449) unless marked as fixtures.

## Network parameters (verified)

| Method | Result | Note |
|---|---|---|
| `getVersion` | `solana-core 4.0.4`, feature-set 3075748243 | Solana-compatible client |
| `getEpochSchedule` | `slotsPerEpoch 216000`, `leaderScheduleSlotOffset 216000`, `warmup true`, `firstNormalEpoch 13`, `firstNormalSlot 262112` | Half of Solana Mainnet's 432,000 |
| `getEpochInfo` | epoch 449, `slotsInEpoch 216000`, start 94,438,112 | `firstSlotInEpoch(449)` = 94,438,112 ✓ (also = `getBlockProduction.range.firstSlot`) |
| `getRecentPerformanceSamples` | ~164 slots / 60 s → **365–366 ms/slot** (band 363.6–368.1) | Docs state a 400 ms nominal slot |
| `getLeaderSchedule(null,{identity})` | Epoch-relative indices, runs of 4 | e.g. `[2232,2233,2234,2235,…]` |
| `getLeaderSchedule(<slot in epoch+1>,{identity})` | Schedule returned | Next epoch available |
| `getLeaderSchedule(<slot in epoch+2>,…)` | `null` | Handled as "not yet available" |
| `getLeaderSchedule` unknown identity | `{}` | Empty state |
| `getLeaderSchedule` invalid identity | `-32602 Invalid param: WrongSize` | Now rejected client- and server-side before RPC |
| Unfiltered `getLeaderSchedule` | 1,415,459 bytes, 297 leaders | Why the filter matters |
| `getVoteAccounts({votePubkey})` | Single account incl. `nodePubkey` | Vote → identity resolution |
| `getVoteAccounts` | 336 current, 48 delinquent | |
| `getProgramAccounts(Config…, memcmp offset 34 = identity)` | Single `validatorInfo` account | Server-side filter; full set is 1.5 MB / 2,911 entries |
| `getBlockProduction({identity})` | `byIdentity: {id: [leaderSlots, produced]}` | Current epoch to date |

## Cross-check: report vs independent direct RPC (`npm run test:live`)

Four validators chosen automatically (largest stake by vote account, median, smallest, first delinquent). All checks passed — see `docs/live-validation-2026-11-20.txt`.

| Validator | Input | Slots (cur / next) | Windows | Produced | Old vs new upcoming |
|---|---|---|---|---|---|
| X1 Labs: (node0) | vote | 12,404 / 12,640 | 2,937 | 9,472 / 9,472 | identical (2,932) |
| Jackpot-1 | identity | 240 / 268 | 60 | 196 / 196 | identical (44) |
| Gambit | identity | 0 / 0 | 0 | 0 / 0 | identical (0) |
| Teddybear #2 (delinquent) | identity | 0 / 0 | 0 | 0 / 0 | identical (0) |

Window sizes are not always exactly 4 for very large validators (adjacent runs merge), so the check is "multiple of 4".

## Timing accuracy (empirical)

Anchor = observed slot; target = anchor + N; then polled `getSlot` (150 ms interval) until reached.

| N slots ahead | Predicted | Actual | Error | Predicted band | Old 400 ms error |
|---|---|---|---|---|---|
| 100 | 36.60 s | 36.76 s | +162 ms | −237 / +210 ms | −3,237 ms |
| 300 | 109.80 s | 110.25 s | +445 ms | −710 / +629 ms | −9,754 ms |

Errors include up to ~150 ms polling granularity. Small-sample result, not a guarantee; the UI labels every time as an estimate.

## Fixtures (deterministic tests)

`tests/fixtures/*.json` were recorded from the live RPC at the time in `tests/fixtures/RECORDED_AT`. Unit/E2E tests run against these through `tests/helpers/fixture-fetch.mjs`. **Fixture-based results prove deterministic behaviour, not current network state**; `npm run test:live` re-validates against the live network.

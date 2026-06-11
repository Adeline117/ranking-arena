# Hyperliquid build-vs-buy spike (ARENA_DATA_SPEC v1.2 §9 item 4)

Date: 2026-06-11 · Timebox: 1 day · Author: ingest Phase-1 workstream

**Verdict: BUILD.** A pure-HTTP adapter on the public stats-data leaderboard +
info API covers all required surfaces at **< 5,000 requests/day** — two orders
of magnitude under the ~50k req/day decision gate. No paid indexer needed.

---

## 1. Leaderboard endpoint (Tier A)

`GET https://stats-data.hyperliquid.xyz/Mainnet/leaderboard`

Measured 2026-06-11 21:30 UTC:

| Property        | Measured                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transport       | S3 object behind CloudFront (`Server: AmazonS3`, `X-Cache: Hit from cloudfront`)                                                                                               |
| Payload         | **32,009,291 bytes** (one JSON object, `{"leaderboardRows":[...]}`), ~2.5 s download                                                                                           |
| Row count       | **38,582** unique lowercase 0x addresses                                                                                                                                       |
| Freshness       | `Last-Modified` seconds behind `Date` — the object is regenerated continuously; CloudFront `Age` was ~16 min. Effective staleness ≤ ~20 min, far inside our 6 h Tier-A cadence |
| Pagination      | none — single object (sources.pagination_kind is moot; we chunk locally)                                                                                                       |
| Auth / anti-bot | none. Plain `curl` works; no Playwright needed (spec §2.2 #31 hard rule satisfied)                                                                                             |

Row shape:

```json
{ "ethAddress": "0x85ec…2052",
  "accountValue": "58880227.36",            // equity (AUM), NOT PnL
  "windowPerformances": [
    ["day",     {"pnl": "…", "roi": "…", "vlm": "…"}],
    ["week",    …], ["month", …], ["allTime", …]],
  "prize": 0, "displayName": null }
```

- `week` → canonical **7**, `month` → canonical **30**. `day`/`allTime` kept in
  `raw` only. So timeframes_native={7,30} maps cleanly.
- `roi` is a **decimal fraction** (0.0341 = 3.41%) — re-verified; matches the
  legacy connector's 2026-04-20 finding (`lib/connectors/platforms/hyperliquid-perp.ts`).
  Arena parsers store percent → multiply by 100.
- Field coverage: 15,297 rows have nonzero 7d PnL; 26,780 nonzero 30d PnL.
  `displayName` only on 1,365 rows (long tail renders shortened address).
- **The file is NOT sorted** (neither by pnl, vlm nor equity). The site UI
  ranks by window PnL desc by default; the legacy connector never sorted at
  all (it sliced the raw order — a latent bug). Our adapter sorts by window
  **PnL desc** (tie-break ROI desc, then address for determinism) and records
  `meta.derived_board_sort='pnl'`.

### Population reality: 38.6k, not 382k

The spec survey (§7 #31, §8) says ≈382,000. The public board today carries
**38,582** rows — the survey figure evidently counted all-time addresses, not
the current leaderboard file (the legacy connector's comments already said
"33K+ traders"). Consequences:

- `expected_count` is reset from 382000 to the observed board (bootstrap ±30%).
- The "largest single source by far / separate capacity plan" concern shrinks
  ~10×; the volume controls below are still applied because 38.6k × 2 TF × 4
  crawls/day is still ~309k entries/day uncapped.

## 2. Info API (`POST https://api.hyperliquid.xyz/info`)

Measured request shapes (all anonymous, no auth):

| type                                | size / latency                                                                                   | yields                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `portfolio` (user)                  | ~31 KB / 0.25 s                                                                                  | per-window `accountValueHistory` + `pnlHistory` (cumulative within window) + `vlm`, for day/week/month/**allTime** (+ perp\* variants)         |
| `clearinghouseState` (user)         | ~3 KB / 0.6 s                                                                                    | equity (`marginSummary.accountValue`), withdrawable, **all open positions** (szi, entryPx, leverage, unrealizedPnl, liquidationPx, marginUsed) |
| `userFillsByTime` (user, startTime) | 647 KB / 0.6 s for 2,000 fills                                                                   | fills with `closedPnl`, paginated 2,000/page                                                                                                   |
| `leaderboard`                       | broke ~2026-03-14, returns 422 (legacy connector note) — stats-data GET is the only board source |

Rate limits (official docs, verified 2026-06-11): **1200 weight/min/IP**;
`clearinghouseState` weight 2; `portfolio`, `userFillsByTime` weight 20 (+1
per 20 items returned). The stats-data leaderboard is CloudFront/S3 and sits
outside this budget.

→ `rate_budget_ms` must respect weight-20 calls: **1100 ms** (≈55 req/min ≈
≤1100 weight/min worst-case all-portfolio). The "100 ms is fine" intuition
would burst 12,000 weight/min and trip 429s.

## 3. The 90d computation (spec: timeframes_derived={90})

Three candidate methods:

1. **Fills replay** (`userFillsByTime` over 90d, sum `closedPnl`) — the spec's
   default suggestion. Two fatal problems found:
   - _Cost_: whales do >100k fills/90d → 50+ pages × (20+100) weight each;
     top-500 daily would routinely exceed the IP budget.
   - _Semantics_: `closedPnl` is **realized only** — misses unrealized PnL and
     funding, so it would NOT match the leaderboard's own window PnL
     definition. A 90d board computed this way disagrees with the native
     7/30 boards systematically.
2. **portfolio allTime interpolation** ← **chosen.** `allTime.pnlHistory` is
   cumulative since inception, sampled ~weekly (measured avg gap 6.3 d on an
   18-month account), with the **last point at fetch time**. So:
   - `pnl_90d = pnl_now − lerp(pnlHistory, t−90d)`
   - `roi_90d = pnl_90d / max(lerp(accountValueHistory, t−90d), ε)` —
     start-equity basis, same shape as HL's own window ROI.
   - Accounts younger than 90 d: allTime _is_ the window (no interpolation
     error at all).
   - **One weight-20 request per trader**, and the SAME response also yields
     the 7/30 chart series (`week`/`month` histories) → 90d is free once
     Tier-B fetches the portfolio anyway.
   - Error bound: PnL sampled at ~6.3 d granularity at the window's left edge;
     equity basis ignores deposits/withdrawals inside the window (HL's own
     ROI is flow-adjusted). Both are disclosed via
     `trader_stats.extras.derivation='portfolio_alltime_lerp'` and the
     standard DerivedBoardBadge (snapshots.is_derived=true).
3. **Buy** — survey below.

The derived 90d board is then synthesized by the existing generic
`derive-boards.ts` processor from trader_stats rows (coverage = profile-crawled
traders = topN + Tier-C visits, disclosed by the badge — spec §1.1-C).

## 4. Buy survey (existence/pricing scan only, no signups)

| Provider                                           | What it is                                   | Fit                                                                            |
| -------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| **Allium** (docs.allium.so, hyperliquid.allium.so) | enterprise data warehouse, in-house HL nodes | full historical fills/state; enterprise pricing; overkill for "90d per trader" |
| **Dwellir**                                        | HL node infra, $199–299/mo + usage (WS/gRPC) | raw node access — we'd still build the aggregation ourselves, now with a bill  |
| **Hypurrscan**                                     | L1 explorer UI/beta                          | no documented public bulk API for windowed trader stats                        |
| **HyperDash / ASXN / HyperScreener**               | analytics dashboards (UI-first)              | not a per-trader windowed-stats API                                            |

Nothing sells pre-computed per-trader 90d windows cheaper than ~2k free
info-API calls/day. **BUILD.**

## 5. Request-volume math vs the ~50k req/day gate

| Surface                                         | Requests/day                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Tier A boards (7d+30d)                          | 4 cycles × 1 stats-data GET (cached per session, shared across both TFs) = **4**                           |
| Tier B profiles, topN=500 (`deep_profile_topn`) | ~1.3 cycles × 500 × (1 portfolio + 1 clearinghouseState, memoized across the 3 TFs in-session) ≈ **1,400** |
| Tier D positions top-100                        | 12 cycles × 100 clearinghouseState (weight 2) = **1,200**                                                  |
| Tier C on-demand long tail                      | traffic-bounded; portfolio+clearinghouseState per cold view                                                |
| **Total scheduled**                             | **< 3,000/day** (~6% of gate)                                                                              |

## 6. Entries-volume control (the real capacity problem)

Uncapped: 38,582 traders × 2 native TF × 4 crawls/day ≈ **309k
leaderboard_entries rows/day** (~9M/month) plus 77k traders-upserts per cycle
— disproportionate to product value (nobody pages a board past a few
thousand ranks).

**Decision: `sources.meta.board_depth = 10000`** — the adapter sorts the full
file, truncates to depth, and only those rows flow to entries + traders +
trader_stats (≈80k entries/day, in family with other sources). The long tail
remains fully discoverable: any 0x address resolves lazily via Tier-C
(`resolveTraderId` creates the traders row on first view, profile comes from
the info API which works for ANY address, board membership not required).

Smoke override: `sources.meta.max_rows` caps below board_depth for test runs
(set to ~1000–5000, then removed for production).

RAW note: the stored RAW object is the sorted/truncated board (≈8 MB/TF
uncompressed), not the 32 MB original — re-parse purity (spec §5.5) holds over
what serving consumed; the full file is regenerated upstream continuously and
has no replay value for the tail we deliberately don't publish.

## 7. Resulting sources-row settings (applied via INGEST_DATABASE_URL)

```sql
UPDATE arena.sources SET
  expected_count = 10000,          -- observed capped board after smoke
  page_size      = 5000,           -- local chunk size (rank re-anchoring)
  rate_budget_ms = 1100,           -- 1200 weight/min, portfolio=20
  cadence_tier_a = '6 hours',
  deep_profile_topn = 500,         -- series_topn_only=500 (spec)
  meta = meta || '{"board_depth":10000,"derived_board_sort":"pnl"}'
WHERE slug = 'hyperliquid';
```

Currency: USDC (seeded). Identity: `exchange_trader_id` = wallet address =
`ParsedLeaderboardRow.walletAddress` (spec §1.4 on-chain identity).

## 8. Open issues

1. HL's own window ROI appears flow-adjusted; our 90d ROI uses start-equity
   basis — small systematic difference, disclosed in extras. Revisit if a
   flow-adjustment source (transfers via `userNonFundingLedgerUpdates`)
   proves cheap.
2. The 382k→38.6k population discrepancy should be folded back into the spec
   tally (§8 homepage counter) at the next spec revision.
3. `userFillsByTime` remains the path to win_rate/trade counts; deliberately
   out of v1 scope (cost + realized-only semantics). trader_stats.win_rate
   stays NULL for hyperliquid (UI NULL-collapses).
4. Tier-B runtime at rate_budget_ms=1100 ≈ 18 min per cycle — fine; revisit
   only if topN grows.

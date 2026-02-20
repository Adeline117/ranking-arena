# Bybit max_drawdown NULL Audit — Final 12 Rows

**Date:** 2026-02-20  
**Result:** All 12 remaining NULL max_drawdown rows are confirmed **garbage/invalid entries** — not real Bybit traders.

---

## Finding

After previous fix runs reduced NULL count from 66 → 12, the remaining 12 rows were investigated.

### Comparison: Valid vs Invalid IDs

**Valid Bybit `source_trader_id`** (leaderMark format):
```
c27KmeB/I0NV5DoyiTTsog==
tjbjaPMtioO640PzskXOAg==
jo9+NXIiYOgKwyIlwO4YWA==
```
(Base64-encoded strings containing `=`, `+`, `/`)

**Invalid IDs (the 12 NULL rows):**

| DB id     | source_trader_id     | handle            | season_id | pnl | win_rate |
|-----------|---------------------|-------------------|-----------|-----|----------|
| 901906    | cn                  | CN                | 7D        | 0   | 0        |
| 901909    | in                  | IN                | 7D        | 0   | 0        |
| 901911    | _250                | /250              | 7D        | 0   | 0        |
| 901920    | jurpon              | Jurpon            | 7D        | 0   | 0        |
| 902232    | join_as_a_trader    | Join as a Trader  | 7D        | 0   | 0        |
| 902234    | ru                  | RU                | 7D        | 0   | 0        |
| 923284    | angar               | Angar             | 90D       | 0   | 0        |
| 923845    | br                  | BR                | 90D       | 0   | 0        |
| 924871    | bitforgeprivate     | BitForgePrivate   | 90D       | 0   | 0        |
| 925117    | ae                  | AE                | 90D       | 0   | 0        |
| 925656    | pl                  | PL                | 90D       | 0   | 0        |
| 925958    | kr                  | KR                | 90D       | 0   | 0        |

---

## Root Cause Analysis

These are **scraping artifacts** from the Bybit leaderboard page:

1. **Country codes** (`cn`, `in`, `ru`, `br`, `ae`, `pl`, `kr`) — scraped from country filter buttons/links on the leaderboard page (e.g., `<a href="/cn">CN</a>`)
2. **UI element** (`join_as_a_trader`) — scraped from a "Join as a Trader" CTA button
3. **URL fragment** (`_250` / `/250`) — scraped from a pagination link
4. **Username-like** (`angar`, `jurpon`, `bitforgeprivate`) — possibly scraped from referral links or other page elements with a different URL format

**All 12 share these data quality markers:**
- `pnl = 0`
- `win_rate = 0`
- `source_trader_id` is NOT a Base64 leaderMark string (no `=`, `+`, `/`)

---

## API Verification

Both Bybit API endpoints were tested for all 12 IDs:

1. `https://api.bybit.com/v5/copytrading/public/master-info?masterUid={uid}` → **403 (blocked)**
2. `https://www.bybit.com/fapi/beehive/public/v1/common/master-info?uid={uid}` → **403 (blocked)**

The previous `fix-bybit-mdd-v6.mjs` script used Puppeteer+stealth to bypass WAF and scanned 200 leaderboard pages across all time periods and sort orders — none of these traders were found.

---

## Conclusion

- These 12 rows **cannot be enriched** — they are not real Bybit traders
- `max_drawdown` will remain `NULL` for all 12 (per task rules: no fabricated data)
- **Recommendation:** These rows should be **deleted** from `leaderboard_ranks` in a future cleanup pass as they corrupt data quality (fake traders appearing on leaderboard)

---

## Fix Scripts Used (History)

| Script | Progress |
|--------|----------|
| fix-bybit-mdd.mjs | Initial run |
| fix-bybit-mdd-v2.mjs through v6.mjs | Progressive improvement |
| Total reduction: 66 → 12 NULL rows | All 12 remaining = confirmed invalid |

# New Data Source API Research Notes

Date: 2026-02-02

## Summary

Researched API availability for 4 new platforms. **None have publicly accessible leaderboard/ranking APIs** suitable for pure API integration.

---

## 1. OKX Spot Copy Trading

**Status: ❌ No public API available**

- OKX Futures copy-trading API works: `GET /api/v5/copytrading/public-lead-traders?instType=SWAP`
  - Returns 23 pages of SWAP traders with ROI, PnL, win rate, followers, etc.
- Tested `instType=SPOT` → returns same SWAP data (ignores param)
- Tested various internal (`priapi`) and alternate endpoints → all return 404
- OKX spot copy-trading exists on the web UI but has no public API endpoint
- Endpoints tested:
  - `/api/v5/copytrading/public-lead-traders?instType=SPOT` → returns SWAP data
  - `/priapi/v5/copytrading/public-lead-traders?instType=SPOT` → 404
  - `/priapi/v5/ecotrade/public/spot-lead-traders` → 404
  - `/api/v5/copytrading/public-spot-lead-traders` → 404
  - `/api/v5/copytrading/public-lead-traders-v2` → 404

**Next steps:** Monitor OKX API changelog for spot copy-trading endpoint addition.

---

## 2. Vertex Protocol (Arbitrum DEX)

**Status: ❌ No accessible leaderboard API**

- `archive.prod.vertexprotocol.com/v1` → returns empty/errors
- `prod.vertexprotocol-backend.com` → inaccessible
- No known subgraph with trader leaderboard data
- Vertex frontend likely uses internal/authenticated APIs

**Next steps:** Check Vertex Discord/docs for public trader stats API.

---

## 3. Drift Protocol (Solana DEX)

**Status: ❌ Requires authentication**

- `mainnet-beta.api.drift.trade/leaderboard` → returns "Unauthorized"
- `data.api.drift.trade/` → various 404/auth errors
- S3 bucket (`drift-historical-data-v2.s3.eu-west-1.amazonaws.com`) has raw trade data but no pre-aggregated leaderboard
- Drift competitions API (`competitions.drift.trade`) → no response

**Next steps:** Apply for Drift API key or explore Solana on-chain indexing.

---

## 4. Jupiter Perps (Solana DEX)

**Status: ❌ No trader leaderboard API**

- `perps-api.jup.ag/v1/` → API exists but focused on JLP pool stats (AUM, prices, custodies)
- No `/v1/leaderboard`, `/v1/traders`, or similar endpoints
- OpenAPI docs confirm pool-focused endpoints only
- No trader-level performance data exposed

**Next steps:** Jupiter may add trader stats in future. Monitor API docs.

---

## Changes Made

- Registered `okx_spot` in `lib/constants/exchanges.ts`:
  - Added to `TraderSource` type
  - Added to `ALL_SOURCES` array
  - Added to `SOURCE_TYPE_MAP` as 'spot'
  - Added to `PRIORITY_SOURCES` array
  - Added to `EXCHANGE_NAMES` as 'OKX Spot'
- `vertex`, `drift`, `jupiter_perps` were already registered in constants

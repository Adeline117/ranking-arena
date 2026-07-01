# Portfolio Sync + Referral Rewards — 2026-06-30

Changelog for this round + the runtime/ops actions still needed to fully activate
the features. Everything below is **shipped to prod** (migrations applied, code
deployed) unless explicitly marked as an **ops action** or **runtime validation**.

## Portfolio exchange sync

Turned the `/api/portfolio/sync` stub into a working sync and un-hardcoded the
equity curve.

- **`lib/portfolio/exchange-sync.ts`** — decrypts the user's stored API keys
  (`decryptApiKey`, AES-256-GCM; in-scope only, never logged/returned), calls
  CCXT `fetchPositions` + `fetchBalance` (**read-only**), maps to `user_positions`
  rows. Curated `SYNC_SUPPORTED` allowlist; exchange error bodies never surfaced.
- **`/api/portfolio/sync`** — `nodejs` runtime, `maxDuration=30`, ownership-scoped;
  **upsert then prune stale** (`updated_at < syncedAt`) so a failed write can't
  blank the portfolio; appends a `user_portfolio_snapshots` row.
- **`/api/portfolio/snapshots`** (GET) + daily cron **`aggregate-portfolio-snapshots`**
  (00:15 UTC) — one net-worth series per user; equity curve renders once data exists.
- **Passphrase support** — migration `20260630184041` added
  `user_portfolios.api_passphrase_encrypted`; `AddExchangeModal` shows a conditional
  passphrase field; POST encrypts it + validates `exchange` against an allowlist.
- Security-reviewed (no CRITICAL/HIGH); 2 MED fixed (CCXT timeout 8s; non-transactional
  wipe window → upsert+prune).

### Supported exchanges (`SYNC_SUPPORTED`)

| Status                 | Exchanges                                               |
| ---------------------- | ------------------------------------------------------- |
| ✅ direct (key/secret) | bybit, mexc, gateio, bitmart, phemex, hyperliquid, htx  |
| ✅ passphrase          | bitget, kucoin, coinex, blofin (okx too, but geo-gated) |
| ⚙️ geo-gated (proxy)   | binance, okx — only when the proxy env is set (below)   |
| ❌ not supported       | dydx (v4 = wallet-signature auth, not key/secret)       |

### binance/okx geo-proxy (env-gated, **OFF by default**)

`makeProxyFetch` tunnels CCXT through the SG VPS proxy
(`scripts/vps-deploy/arena-proxy.mjs`, X-Proxy-Key auth, forwards signed headers;
the API secret never leaves — CCXT signs locally). **Safe-by-default**: without the
env below, binance/okx return `geo_unavailable` ("coming soon") — zero regression.

## Referral rewards (double-sided) + layered anti-farming

- **Attribution-only apply** — `/api/referral/apply` sets `referred_by` (compare-and-swap)
  and records a `referral_attributions` row; it grants **nothing** synchronously.
- **Deferred qualification cron `qualify-referrals`** (every 6h) grants rewards only
  after the referred account crosses an activity bar:
  `onboarding_completed AND (linked a trader OR account age ≥ 24h)`.
- **Four anti-farm layers**: (1) per-device friend-trial cap, (2) advocate threshold
  counts DISTINCT device fingerprints (hashed IP+UA, no raw PII), (3) deferred
  activity qualification, (4) log-only velocity flag for burst signups.
- **Exactly-once advocate grant** via `referral_rewards` UNIQUE marker.
- Security-reviewed; HIGH (friend-grant TOCTOU → atomic CAS) + MEDIUM (server-side
  code allowlist) fixed.
- Migrations: `20260630…referral_rewards_idempotency`, `…referral_attributions_antifarm`,
  `…referral_deferred_qualification` (all applied to prod, schema-green).

Constants live in `lib/constants/referral.ts` (threshold, reward days, device cap,
qualify age, velocity window) — single source of truth, cost-sensitive.

## Bug fixed via live QA

- **ProPromoBanner** rendered the raw key `proPromoBanner` on every page: it uses
  `useLanguage()` but is mounted in the ROOT layout (no `LanguageProvider`). Fixed to
  resolve copy via the static `lib/i18n` dictionary with English defaults. Caught only
  by browser verification against prod — tsc + code review missed it.

---

## Ops actions still needed (not code — decisions/config)

1. **Enable binance/okx sync** (optional): set on Vercel
   - `PORTFOLIO_SYNC_PROXY_URL` = the SG VPS proxy base (e.g. `http://45.76.152.169:3456`)
   - `PORTFOLIO_SYNC_PROXY_KEY` = the proxy `X-Proxy-Key` (`PROXY_KEY` on the VPS)
     Verify the VPS proxy (`arena-proxy.mjs` on `:3456`) is running + reachable from Vercel
     first. Routing signed read-only traffic through the SG VPS is the trade-off.

2. **Turn off the Pro-free promo** when ready: `PRO_FREE_PROMO = false` in
   `lib/types/premium.ts` (one flag; disables the unlock + the banner together).
   The four referral anti-farm layers are in place, so rewards are protected once the
   promo ends. Re-confirm the device+activity gates suffice for your risk tolerance.

## Runtime validation still needed (needs real credentials/data — can't be done from code)

1. **End-to-end sync** for a real user with **read-only** exchange API keys — confirm
   CCXT `fetchPositions`/`fetchBalance` mapping is correct per exchange, especially the
   newer/passphrase ones (htx, blofin, bitget, kucoin, coinex). Unvalidated exchanges
   degrade gracefully to `exchange_error` (no crash), but correctness needs a live run.
2. **Referral qualification** — needs real signups crossing the activity bar to confirm
   the cron grants friend + advocate rewards as intended.

(As of ship time: 0 connected portfolios and 0 referral rows in prod — greenfield.)

# Arena Data Architecture (March 2026)

## Data Flow

```
Exchange APIs → Connector Framework (lib/connectors/platforms/)
  → ConnectorDbAdapter (normalize + Zod validate + batch write)
  → Supabase (trader_sources, trader_profiles_v2, trader_snapshots, trader_snapshots_v2)
  → Arena Score calculation (lib/utils/arena-score.ts)
  → Leaderboard computation (compute-leaderboard cron → leaderboard_ranks table)
  → Redis cache (Upstash, hot=5min / warm=15min / cold=1h TTL)
  → Frontend (Next.js RSC + React Query)
```

## Connector Framework

| Component | Location |
|-----------|----------|
| Base class | `lib/connectors/base.ts` (BaseConnector) |
| 24 active connectors | `lib/connectors/platforms/*.ts` |
| DB write adapter | `lib/connectors/connector-db-adapter.ts` |
| Registry | `lib/connectors/registry.ts` (ConnectorRegistry) |
| Runner | `lib/connectors/connector-runner.ts` |
| Types | `lib/types/leaderboard.ts` + `lib/connectors/types.ts` |

### Connector Interface
```typescript
interface PlatformConnector {
  discoverLeaderboard(window, limit?, offset?): Promise<DiscoverResult>
  fetchTraderProfile(traderKey): Promise<ProfileResult | null>
  fetchTraderSnapshot(traderKey, window): Promise<SnapshotResult | null>
  fetchTimeseries(traderKey): Promise<TimeseriesResult>
  normalize(raw): Record<string, unknown>
}
```

### Built-in Features
- 30s timeout per request
- 3× exponential backoff retry (2s base)
- 429 rate limit handling (Retry-After header)
- Circuit breaker (5 failures → open 60s → half-open)
- VPS proxy fallback for geo-blocked exchanges
- CloudFlare/WAF detection

## Cron Schedule (vercel.json)

| Group | Schedule | Platforms |
|-------|----------|-----------|
| A | Every 3h | binance_futures, binance_spot |
| A2 | Every 3h | bitget_futures, okx_futures |
| B | Every 4h | hyperliquid, gmx, jupiter_perps |
| C | Every 4h | okx_web3, aevo, xt |
| D1 | Every 6h | gains, htx_futures |
| D2 | Every 6h | dydx |
| E | Every 6h | coinex, binance_web3, bitfinex |
| F | Every 6h | mexc, bingx |
| G1 | Every 6h | drift, bitunix |
| G2 | Every 6h | web3_bot, toobit |
| H | Every 6h | gateio, btcc |
| I | Every 6h | etoro |

Other crons: enrichment (4h), leaderboard (30min), composite (2h), daily digest (UTC 00:00).

## Arena Score

```
ReturnScore(0-60) = 60 × tanh(tanhCoeff × I)^roiExponent
  I = (365/days) × ln(1 + ROI/100), ROI capped at 10000%
PnlScore(0-40)    = 40 × tanh(coeff × ln(1 + PnL/base))
Total             = (ReturnScore + PnlScore) × confidenceMultiplier × trustWeight
Overall           = 90D × 0.70 + 30D × 0.25 + 7D × 0.05
```

## Monitoring

- **Telegram alerts**: 24h Redis dedup, CRITICAL sent immediately, WARNING in daily digest
- **Daily digest**: UTC 00:00, pipeline health + enrichment rate + snapshot counts
- **Recovery notifications**: sent when platform returns to normal
- **Pipeline logger**: `pipeline_logs` table, 30-day retention

## Dead Platforms (16)

bybit, bybit_spot, kucoin, weex, perpetual_protocol, lbank, phemex (Mac Mini only),
bitget_spot, mux, synthetix, paradex, kwenta, blofin, okx_spot, bitmart, whitebit, btse

## Deprecated Code

| Directory | Contents |
|-----------|----------|
| `lib/cron/fetchers/_deprecated/` | 39 old Inline Fetcher scripts |
| `lib/connectors/_deprecated/` | 17 old BaseConnectorLegacy implementations |

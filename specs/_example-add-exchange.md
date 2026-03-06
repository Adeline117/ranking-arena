# Add XXX Exchange Connector

## Context
We need to add XXX exchange's trader ranking data to Arena's leaderboard.

## Requirements
Connect to XXX exchange's public API to fetch top traders with their performance metrics.

## Acceptance Criteria
- [ ] Connector file at `lib/connectors/xxx.ts` implementing fetchLeaderboard and fetchTraderDetails
- [ ] Trader data includes: username, PnL, ROI, win_rate (at minimum)
- [ ] Data flows through the unified ingestion layer (batch-fetch-traders)
- [ ] Add to appropriate batch group in `lib/cron/fetchers/` and `vercel.json`
- [ ] Cron job runs at appropriate interval (group assignment based on data volume)
- [ ] Rate limiting and error handling follow existing patterns (see hyperliquid.ts as reference)
- [ ] After 3 consecutive failures, alert is triggered
- [ ] Leaderboard page shows traders from this exchange
- [ ] Build passes (`npm run build`)
- [ ] Existing tests pass (`npm test`)
- [ ] Type-check passes (`npm run type-check`)

## Constraints
- Use existing connector patterns (check `lib/connectors/hyperliquid.ts` as reference)
- Must handle geo-blocking gracefully (return empty array, don't throw)
- Rate limit to max 5 requests/second to the exchange API

## Out of Scope
- Historical data backfill (separate task)
- Exchange-specific enrichment features

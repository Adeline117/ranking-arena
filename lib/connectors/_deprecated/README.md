# Deprecated Legacy Connectors

These are the old `BaseConnectorLegacy` implementations, superseded by
`BaseConnector` subclasses in `lib/connectors/platforms/` (March 2026).

## What's Here

- 11 legacy platform connectors (binance-futures, bybit, okx, etc.)
- 4 enrichment-only connectors (binance-web3, bingx-spot, bitget, htx)
- Supporting files (capabilities, circuit-breaker)

## Still Referenced By

- `lib/connectors/registry.ts` — legacy `getConnector()` used by `run-worker` job queue
- `app/api/cron/unified-connector/route.ts` — `HyperliquidConnector` native path

## New System

Use `lib/connectors/platforms/` for new connector implementations.
These extend `BaseConnector` from `lib/connectors/base.ts`.

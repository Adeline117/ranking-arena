# Deprecated Inline Fetchers

These files were the original data collection scripts, replaced by the Connector framework in March 2026.

Kept for reference and emergency rollback. Do not import from this directory in new code.

## Architecture Change

- **Old**: `getInlineFetcher(platform)` → standalone async function per platform → direct Supabase writes
- **New**: `ConnectorRegistry.get(platform, marketType)` → `BaseConnector` subclass → `ConnectorDbAdapter` → `upsertTraders()`

## Connector Framework Location

- Base class: `lib/connectors/base.ts`
- Platform implementations: `lib/connectors/platforms/`
- DB adapter: `lib/connectors/connector-db-adapter.ts`
- Registry: `lib/connectors/registry.ts`

## Emergency Rollback

To rollback a specific platform to Inline Fetcher:
1. Move the platform file back to parent directory (`lib/cron/fetchers/`)
2. Remove the platform from `SOURCE_TO_CONNECTOR` in `batch-fetch-traders/route.ts`
3. The fallback logic in `runPlatform()` will automatically use `getInlineFetcher()`

## Files

- 36 platform fetcher files (one per exchange)
- `config-driven-fetcher.ts` — generic config-based fetcher framework
- `exchange-configs.ts` — exchange-specific configurations for config-driven fetcher
- `scraper-config.ts` — VPS scraper endpoint configurations

# Deprecated Scripts

The following scripts are deprecated and should not be used. Use the recommended alternatives instead.

## Fetch Scripts

| Deprecated | Recommended | Notes |
|------------|-------------|-------|
| `fetch/fetch_binance_trader_details.mjs` | `fetch/fetch_details_fast.mjs` | Unified script with better performance |
| `fetch/fetch_all_binance_details.mjs` | `fetch/fetch_details_fast.mjs` | Use `--force` flag for full fetch |
| `fetch/fetch_position_history.mjs` | `fetch/fetch_position_history_v2.mjs` | Newer version with batch support |
| `fetch/fetch_position_history_batch.mjs` | `fetch/fetch_position_history_v2.mjs` | Consolidated into v2 |

## Import Scripts

| Deprecated | Recommended | Notes |
|------------|-------------|-------|
| `import/import_bitget_futures.mjs` | `import/import_bitget_futures_v2.mjs` | v2 has parallel fetching, 3-5x faster |
| `import/import_bitget_spot.mjs` | `import/import_bitget_spot_v2.mjs` | v2 has parallel fetching |

## Shared Utilities

All import scripts should use the shared library at `lib/shared.mjs` for:
- Supabase client initialization
- Arena Score calculation
- Common utility functions (sleep, randomDelay, etc.)

Example usage:
```javascript
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  randomDelay,
  getTargetPeriods,
  getConcurrency,
} from '../lib/shared.mjs'
```

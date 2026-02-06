# Deprecated Scripts

The following scripts have been deprecated and removed. This document records what was replaced and why.

## Removed Fetch Scripts

| Removed | Replaced By | Notes |
|---------|-------------|-------|
| `fetch/fetch_binance_trader_details.mjs` | `fetch/fetch_details_fast.mjs` | Unified script with better performance |
| `fetch/fetch_all_binance_details.mjs` | `fetch/fetch_details_fast.mjs` | Use `--force` flag for full fetch |
| `fetch/fetch_position_history.mjs` | `fetch/fetch_position_history_v2.mjs` | Newer version with batch support |
| `fetch/fetch_position_history_batch.mjs` | `fetch/fetch_position_history_v2.mjs` | Consolidated into v2 |

## Removed Import Scripts

| Removed | Replaced By | Notes |
|---------|-------------|-------|
| `import/import_bitget_futures.mjs` | `import/import_bitget_futures_v2.mjs` | v2 has parallel fetching, 3-5x faster |
| `import/import_bitget_spot.mjs` | `import/import_bitget_spot_v2.mjs` | v2 has parallel fetching |

## Archived Debug Scripts

The following debug/temporary scripts have been moved to `import/archive/debug/`:
- `_analyze_data.mjs`, `_check_data.mjs`, `_debug_*.mjs`, `_test_*.mjs`, `_tmp_*.js`

These were one-time debugging scripts and are preserved for reference.

## Archived Avatar Fix Scripts

The following one-time avatar fix scripts have been moved to `archive/avatar-fixes/`:
- `fix-avatar-data.mjs` - One-time data fix
- `fix-blockie-avatars.mjs` - Replaced blockie placeholders
- `fix-htx-avatars.mjs` - HTX-specific avatar fix
- `replace-dicebear-avatars.mjs` - Replaced dicebear avatars
- `refetch-real-avatars.mjs` - Re-fetched real avatars
- `debug-xt-avatar.mjs` - XT debugging script

Active avatar scripts remain in the main directory:
- `fetch-missing-avatars.mjs` - Fetch avatars for traders missing them
- `fetch-platform-avatars.mjs` - Platform-specific avatar fetching
- `scrape-avatars-playwright.mjs` - Playwright-based avatar scraping

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

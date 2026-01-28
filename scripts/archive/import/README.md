# Archived Import Scripts

This directory contains deprecated versions of import scripts that have been superseded by enhanced versions.

## Archive Date
2026-01-28

## Archived Scripts

### dYdX Platform
- **import_dydx.mjs** (12K) - Original Puppeteer-based scraper
  - Used browser automation to scrape rankings page
  - Replaced by: `import_dydx_enhanced.mjs`

- **import_dydx_v4.mjs** (9.9K) - API-based version
  - Used chain API and indexer API
  - Replaced by: `import_dydx_enhanced.mjs`

**Reason for archiving**: The enhanced version consolidates both approaches and adds:
- Win rate calculation from closed positions
- Max drawdown calculation from historical P&L
- Better error handling and retry logic

### GMX Platform
- **import_gmx.mjs** (9.6K) - Original Subsquid scraper
  - Basic account stats scraping
  - Replaced by: `import_gmx_enhanced.mjs`

**Reason for archiving**: The enhanced version adds:
- Win rate from trade actions
- Max drawdown calculation from historical data
- Better concurrency control and rate limiting

### HTX Platform
- **import_htx.mjs** (22K) - Puppeteer + API interception scraper
  - Complex browser automation approach
  - Replaced by: `import_htx_enhanced.mjs`

**Reason for archiving**: The enhanced version:
- Uses direct API calls (simpler, faster)
- Calculates max drawdown from profit list
- Better performance and reliability

### Hyperliquid Platform
- **import_hyperliquid.mjs** (4.5K) - Basic scraper
  - Simple API scraping
  - Replaced by: `import_hyperliquid_enhanced.mjs`

**Reason for archiving**: The enhanced version adds:
- Win rate calculation
- Max drawdown calculation
- Enhanced data validation

## Migration Guide

If you need to reference the old scripts, they are preserved here. However, all active imports should use the `*_enhanced.mjs` versions.

### Updated References
The following files have been updated to use enhanced versions:
- `scripts/import/batch_import.mjs`
- `scripts/test-all-sources.mjs`

### README and Documentation
The following documentation files still reference old scripts and should be updated:
- `README.md` (lines 48, 49, 518, 522-524, 805-806, 1275, 1279-1281)
- `.claude/settings.local.json` (lines 111, 133)

## Restoration

If you need to restore any of these scripts, simply move them back from `scripts/archive/import/` to `scripts/import/`. However, it is recommended to use the enhanced versions instead.

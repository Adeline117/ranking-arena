# Enhanced Data Status Report

## Summary of Improvements Made

### DeFi Platforms (Enhanced Scripts Created)

| Platform | Win Rate | Max Drawdown | Status |
|----------|----------|--------------|--------|
| **Hyperliquid** | 57% ✓ | 40% ✓ | Enhanced via `userFillsByTime` + `portfolio` API |
| **GMX** | 99% ✓ | 21% ⚠ | Enhanced via `positionChanges` (case-sensitive fix applied) |
| **HTX Futures** | 99% ✓ | 35% ⚠ | Enhanced by calculating MDD from `profitList` |
| **dYdX** | 1% ⚠ | 4% ⚠ | Geoblocked - Indexer API returns `GEOBLOCKED` for address queries |

### Enhanced Scripts Created

1. **`import_hyperliquid_enhanced.mjs`**
   - Win Rate: via `userFillsByTime` API (counts winning vs losing trades)
   - Max Drawdown: via `portfolio` API (calculates from `pnlHistory` + `accountValueHistory`)

2. **`import_gmx_enhanced.mjs`**
   - Win Rate: from `accountStats.wins/losses`
   - Max Drawdown: via `positionChanges` with `basePnlUsd` (case-sensitive address query)

3. **`import_dydx_enhanced.mjs`**
   - Win Rate: via `/perpetualPositions?status=CLOSED`
   - Max Drawdown: via `/historical-pnl`
   - **Issue**: dYdX Indexer API is geoblocked for individual address endpoints

4. **`import_htx_enhanced.mjs`**
   - Win Rate: from API response
   - Max Drawdown: calculated from `profitList` (daily cumulative returns)

## Platforms with API Limitations

### CEX Platforms (Require Browser Automation)

| Platform | Issue |
|----------|-------|
| **KuCoin** | API returns 404, requires Puppeteer scraping |
| **MEXC** | API returns HTML, requires Puppeteer scraping |
| **OKX Futures** | API not public, requires authentication |
| **Binance Spot** | WR not provided in API, only MDD available |

### DeFi Platforms (Data Not Available)

| Platform | Issue |
|----------|-------|
| **OKX Web3** | DeFi aggregator - no win_rate/MDD APIs available |
| **Binance Web3** | DeFi aggregator - no win_rate/MDD APIs available |

## Current Coverage (30D)

| Metric | Coverage |
|--------|----------|
| **Win Rate** | 56% (560/1000 records) |
| **Max Drawdown** | 28% (277/1000 records) |

## Recommendations

### High Priority Fixes

1. **Run enhanced Hyperliquid/GMX/HTX scripts regularly** - These now provide better data coverage

2. **Fix dYdX geoblocking** - Options:
   - Use a proxy service
   - Deploy scraper to a non-blocked region
   - Skip dYdX or use limited chain data

3. **KuCoin/MEXC/OKX Futures** - Need to:
   - Restore Puppeteer-based scraping
   - Check if browser automation captures WR/MDD
   - May require visual parsing from UI

### Low Priority / API Limitations

- **Binance Spot**: API doesn't expose win_rate (only MDD)
- **OKX Web3, Binance Web3**: DeFi aggregators typically don't track individual trade stats

## Usage

```bash
# Run enhanced scripts
node scripts/import/import_hyperliquid_enhanced.mjs 30D
node scripts/import/import_gmx_enhanced.mjs 30D
node scripts/import/import_htx_enhanced.mjs 30D
node scripts/import/import_dydx_enhanced.mjs 30D  # May fail due to geoblocking

# Check status
node scripts/import/check_all_platforms.mjs
```

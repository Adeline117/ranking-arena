# Enrichment Pipeline Data Gaps Audit

Date: 2026-03-06
Audited by: Claude Code Agent

---

## 1. Database Schema: trader_snapshots Columns

The `trader_snapshots` table (created in `00001_initial_schema.sql`, extended across 8+ migrations) has these columns:

### Core (from initial schema)
| Column | Type | Source |
|--------|------|--------|
| source | text | All |
| source_trader_id | text | All |
| season_id | text | Window: 7D/30D/90D |
| rank | integer | Some |
| roi | decimal(12,4) | All |
| pnl | decimal(18,2) | Most |
| followers | integer | CEX only |
| win_rate | decimal(5,2) | Most CEX |
| max_drawdown | decimal(5,2) | Some |
| trades_count | integer | Some |
| captured_at | timestamptz | All |

### Extended (from migrations 00009, 00032, 00038, 00040, 00044, 00045, 00076, 20260214, 20260220)
| Column | Type | Populated By |
|--------|------|-------------|
| arena_score | numeric(6,2) | Computed server-side |
| sharpe_ratio | decimal(10,4) | Binance, Bitget (from API); derived for others |
| aum | decimal(20,2) | Binance, Bybit, OKX, Bitget |
| sortino_ratio | decimal(10,4) | Almost never populated by connectors |
| calmar_ratio | decimal(10,4) | Almost never populated by connectors |
| profit_factor | decimal(10,4) | Never populated by connectors |
| recovery_factor | decimal(10,4) | Never populated by connectors |
| max_consecutive_wins | integer | Never populated by connectors |
| max_consecutive_losses | integer | Never populated by connectors |
| avg_holding_hours | decimal(10,2) | Binance, Bybit, Bitget (from detail API) |
| volatility_pct | decimal(8,4) | Derived from equity curve only |
| downside_volatility_pct | decimal(8,4) | Derived from equity curve only |
| beta_btc | decimal(8,4) | Never populated |
| beta_eth | decimal(8,4) | Never populated |
| alpha | decimal(10,4) | Never populated |
| trading_style | text | Derived (when classification runs) |
| asset_preference | text[] | Never populated by connectors |
| style_confidence | decimal(5,2) | Derived |
| pnl_score | decimal(6,2) | Computed |
| alpha_score | decimal(6,2) | Computed |
| consistency_score | decimal(6,2) | Computed |
| risk_adjusted_score_v3 | decimal(6,2) | Computed |
| arena_score_v3 | decimal(6,2) | Computed |
| profitability_score | decimal(6,2) | Computed |
| risk_control_score | decimal(6,2) | Computed |
| execution_score | decimal(6,2) | Computed |
| profit_loss_ratio | decimal(10,4) | Bybit only |
| snapshot_date | date | Recent snapshots only |
| metrics_quality | text | Some |
| metrics_data_points | integer | Some |
| is_authorized | boolean | Authorized traders only |

## 2. trader_sources Schema

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| source | text | Exchange name |
| source_trader_id | text | Exchange-specific ID |
| handle | text | Display name / nickname |
| profile_url | text | Link to exchange profile page |
| avatar_url | text | Added in migration 00031 |

**Commonly empty fields:**
- `avatar_url`: NULL for all DEX traders (Hyperliquid, GMX, dYdX) - no avatar concept on-chain
- `handle`: NULL or truncated address for DEX traders
- `profile_url`: Always populated

## 3. Connector Field Coverage Matrix

### 3.1 Leaderboard Discovery (discoverLeaderboard)

Fields populated during discovery phase:

| Exchange | display_name | avatar_url | profile_url |
|----------|:----------:|:----------:|:-----------:|
| binance_futures | Yes | Yes | Yes |
| binance_spot | Yes | Yes | Yes |
| bybit | Yes | Yes | Yes |
| bitget_futures | Yes | Yes | Yes |
| bitget_spot | Yes | Yes | Yes |
| okx | Yes | Yes | Yes |
| mexc | Yes | Yes | Yes |
| coinex | Yes | Yes | Yes |
| kucoin | Yes | Yes | Yes |
| hyperliquid | Truncated addr | NULL | Yes |
| gmx | Wallet addr | NULL | Yes |
| dydx | Address | NULL | Yes |

### 3.2 Snapshot Metrics (fetchTraderSnapshot)

| Field | binance_futures | binance_spot | bybit | bitget_futures | bitget_spot | okx | mexc | coinex | kucoin | hyperliquid | gmx | dydx |
|-------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| roi | Y | Y | Y | Y | Y | Y | Y | Y | Y | Derived* | Y | Y |
| pnl | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| win_rate | Y | Y | Y | Y | Y | Y | Y | Y | Y | Derived* | NULL | NULL |
| max_drawdown | Y | Y | Y | Y | Y | Y | Y | Y | Y | Derived* | Y | Y |
| trades_count | Y | NULL | Y | Y | Y | NULL | Y | Y | Y | Y | Y | Y |
| copier_count | Y | Y | Y | Y | Y | Y | Y | Y | Y | NULL | NULL | NULL |
| sharpe_ratio | Y | NULL | Y | Y | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL |
| sortino_ratio | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL |
| volatility_pct | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL |
| avg_holding_hours | Y | NULL | Y | Y | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL |
| profit_factor | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL |
| aum | Y | NULL | Y | Y | NULL | Y | NULL | NULL | Y | NULL | NULL | NULL |

**Legend:** Y = populated, NULL = always null, Derived* = calculated from fill data (not native)

**Hyperliquid ROI note:** The connector sets `roi: 0` in `fetchUserPnl` because initial equity is unknown. ROI comes from the leaderboard discovery endpoint instead.

### 3.3 Config-Driven Fetchers (exchange-configs.ts)

These newer exchanges use config-driven fetchers:

| Exchange | roi | pnl | win_rate | max_drawdown | followers | avatar | handle |
|----------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| toobit | Y | Y | Y | Y | Y | Y | Y |
| btse | Y | Y | Y | Y | Y | Y | Y |
| cryptocom | Y | Y | Y | Y | Y | Y | Y |

### 3.4 Enrichment Connectors (base-connector-enrichment.ts subclasses)

These are used for secondary enrichment of existing traders:

| Connector | Fields Provided | Missing Fields |
|-----------|----------------|----------------|
| BitgetFuturesConnector | win_rate, max_drawdown, roi, pnl, trades_count, followers | sharpe_ratio, sortino, avg_holding_hours |
| BinanceWeb3Connector | win_rate, roi, pnl, trades_count, handle, avatar | max_drawdown (always NULL), followers, sharpe |
| BingXSpotConnector | win_rate, max_drawdown, trades_count, handle | roi (NULL), pnl (NULL), followers |
| HTXFuturesConnector | win_rate, max_drawdown, roi, pnl, avatar | trades_count (NULL), followers, sharpe |

## 4. Time Window Support

| Exchange | 7D | 30D | 90D | Notes |
|----------|:-:|:-:|:-:|-------|
| binance_futures | Y | Y | Y | WEEKLY/MONTHLY/QUARTERLY |
| binance_spot | Y | Y | Y | Same as futures |
| binance_web3 | Y | Y | Y | Via period param |
| bybit | Y | Y | Y | 7/30/90 |
| bitget_futures | Y | Y | Y | sortType: 1/2/0 |
| bitget_spot | Y | Y | Y | Same sort scheme |
| okx | Y | Y | Y | 7D/30D/90D |
| mexc | Y | Y | Y | periodType: 1/2/3 |
| coinex | Y | Y | Y | Maps defined but capabilities say 90D NOT native |
| kucoin | Y | Y | Y | 7/30/90 |
| hyperliquid | Y | Y | Y | week/month/allTime (allTime != 90d) |
| gmx | Y | Y | Y | Per capabilities matrix |
| dydx | Y | Y | Y | Per capabilities matrix |
| htx | Y | Y | Y | Per capabilities, but fetcher uses single ranking endpoint |
| bitmart | Y | Y | NULL | 90D NOT natively provided |
| phemex | Y | Y | Y | All windows |
| weex | Y | Y | NULL | 90D NOT natively provided |
| toobit | Y | Y | Y | Config-driven |
| btse | Y | Y | Y | Config-driven |
| cryptocom | Y | Y | Y | Config-driven |

## 5. Enrichment Pipeline Coverage

### 5.1 Equity Curve (trader_equity_curve table)

| Exchange | Has Enrichment | Source |
|----------|:-:|---------|
| binance_futures | Y | fetchBinanceEquityCurve (lead-portfolio/query-performance) |
| bybit | Y | fetchBybitEquityCurve (leader-chart) |
| okx | Y | fetchOkxEquityCurve (weekly-pnl, cumulative) |
| bitget | Y | fetchBitgetEquityCurve (profitList) |
| htx | Y | fetchHtxEquityCurve (derived from profitList in ranking) |
| binance_spot | NULL | No public performance curve API |
| mexc | NULL | No enrichment function |
| coinex | NULL | No enrichment function |
| kucoin | NULL | No enrichment function |
| hyperliquid | NULL | Could be derived from fills but not implemented |
| gmx | NULL | No enrichment function |
| dydx | NULL | No enrichment function |

### 5.2 Position History (trader_position_history table)

| Exchange | Has Enrichment | Source |
|----------|:-:|---------|
| binance_futures | Y | fetchBinancePositionHistory |
| bybit | Y | fetchBybitPositionHistory |
| okx | Y | fetchOkxCurrentPositions (open only) + fetchOkxPositionHistory |
| bitget | Y | fetchBitgetPositionHistory |
| hyperliquid | Y | fetchHyperliquidPositionHistory (from fills) |
| gmx | Y | fetchGmxPositionHistory (from GraphQL) |
| htx | NULL | No position history API |
| binance_spot | NULL | Not implemented |
| mexc | NULL | Not implemented |
| coinex | NULL | Not implemented |
| kucoin | NULL | Not implemented |
| dydx | NULL | Not implemented |

### 5.3 Stats Detail (trader_stats_detail table)

| Exchange | Has fetchStatsDetail | Fields Available |
|----------|:-:|---------|
| binance_futures | Y | totalTrades, profitableTradesPct, avgHoldingTimeHours, avgProfit, avgLoss, sharpeRatio, maxDrawdown, copiersCount, copiersPnl, aum |
| bybit | Y | Similar to Binance |
| okx | Y | Limited: mostly from ranking data |
| bitget | Y | From detail API |
| htx | Y | Very limited: winRate, maxDrawdown, copiers, aum only |
| All others | NULL | No stats detail enrichment |

## 6. Profile Data Coverage

### 6.1 trader_sources + Profile Fields

| Exchange | avatar_url | bio | followers | copiers | aum | active_since |
|----------|:-:|:-:|:-:|:-:|:-:|:-:|
| binance_futures | Y | Y | Y | Y | Y | Y (createTime) |
| binance_spot | Y | Y | Y | Y | NULL | NULL |
| bybit | Y | Y | Y | Y | Y | Y (createTime) |
| bitget_futures | Y | Y | Y | Y | Y | NULL |
| bitget_spot | Y | NULL | Y | Y | NULL | NULL |
| okx | Y | NULL | NULL | Y | Y | NULL |
| mexc | Y | NULL | NULL | Y | NULL | NULL |
| coinex | Y | NULL | NULL | Y | NULL | NULL |
| kucoin | Y | NULL | NULL | Y | Y | NULL |
| hyperliquid | NULL | NULL | NULL | NULL | Y (accountValue) | NULL |
| gmx | NULL | NULL | NULL | NULL | NULL | NULL |
| dydx | NULL | NULL | NULL | NULL | NULL | NULL |
| htx | Y (imgUrl) | NULL | NULL | NULL | NULL | NULL |
| binance_web3 | Y (addressLogo) | NULL | NULL | NULL | NULL | NULL |

## 7. Critical Data Gaps Summary

### 7.1 Fields the UI Expects but Connectors Don't Provide

The `RankedTrader` type and trader detail page expect:

1. **sortino_ratio** - DB column exists, NO connector populates it. Only derived via `enrichment-metrics.ts` from equity curve (requires equity curve data first).

2. **calmar_ratio** - DB column exists, NO connector populates it. Same derivation dependency.

3. **profit_factor** - DB column exists, NO connector populates it.

4. **beta_btc / beta_eth / alpha** - DB columns exist, NEVER populated. Requires market data correlation computation that doesn't exist yet.

5. **volatility_pct / downside_volatility_pct** - Only derivable when equity curve exists. Missing for all exchanges without equity curve enrichment.

6. **max_consecutive_wins / max_consecutive_losses** - DB columns exist, never populated.

7. **recovery_factor** - DB column exists, never populated.

### 7.2 Per-Exchange Structural Gaps

| Exchange | Critical Missing Fields |
|----------|----------------------|
| **binance_spot** | trades_count, sharpe_ratio, avg_holding_hours, aum, equity_curve, position_history |
| **okx** | trades_count, sharpe_ratio, avg_holding_hours, bio, timeseries (empty) |
| **mexc** | max_drawdown (unreliable per capabilities), aum, sharpe_ratio, avg_holding_hours, equity_curve, position_history, stats_detail |
| **coinex** | 90D data unreliable, sharpe_ratio, avg_holding_hours, aum, equity_curve, position_history, stats_detail |
| **kucoin** | sharpe_ratio, avg_holding_hours, equity_curve, position_history, stats_detail, timeseries |
| **hyperliquid** | ROI (always 0 from snapshot, only from leaderboard), avatar, bio, followers, sharpe, equity_curve enrichment, avg_holding_hours |
| **gmx** | win_rate (N/A by design), followers (N/A), avatar, bio, equity_curve, stats_detail |
| **dydx** | followers (N/A), avatar, bio, equity_curve, position_history, stats_detail |
| **htx** | trades_count, position_history, stats_detail (very limited) |
| **binance_web3** | max_drawdown (always NULL), followers, sharpe, equity_curve, position_history |
| **bingx_spot** | roi (NULL from search), pnl (NULL), requires browser headers (fragile) |
| **bitmart** | 90D missing, win_rate, max_drawdown (per capabilities) |
| **weex** | 90D missing, win_rate, max_drawdown (per capabilities) |

### 7.3 Always-NULL Fields Across All Exchanges

These snapshot columns are NEVER populated by any connector:
- `sortino_ratio` (could be derived from equity curve)
- `calmar_ratio` (could be derived from equity curve + max_drawdown)
- `profit_factor` (requires gross profit/loss data)
- `recovery_factor` (requires net profit + max drawdown)
- `max_consecutive_wins` / `max_consecutive_losses` (requires position-level data)
- `beta_btc` / `beta_eth` / `alpha` (requires market correlation computation)
- `downside_volatility_pct` (could be derived from equity curve)
- `asset_preference` (requires position analysis)

### 7.4 Timeseries Support

| Exchange | equity_curve | daily_pnl | drawdown | position_count |
|----------|:-:|:-:|:-:|:-:|
| binance_futures | Y | Y | NULL | NULL |
| bybit | Y | NULL | NULL | NULL |
| bitget_futures | Y | NULL | NULL | NULL |
| hyperliquid | NULL | Y (from fills) | NULL | NULL |
| All others | NULL | NULL | NULL | NULL |

## 8. Recommendations (Priority Order)

### P0 - Fix Broken Data

1. **Hyperliquid ROI = 0 in snapshots**: The `fetchUserPnl` method returns `roi: 0` because it can't calculate ROI without initial equity. The leaderboard provides ROI but it's not carried through to enrichment. Fix: use leaderboard ROI as the source of truth.

2. **BingX ROI/PnL always NULL**: The search API doesn't return these. Need a dedicated detail endpoint or alternative data source.

### P1 - High-Value Gaps

3. **Equity curve for MEXC, CoinEx, KuCoin**: These 3 exchanges have no equity curve enrichment, so volatility/sharpe/sortino can never be derived.

4. **OKX trades_count**: The OKX connector doesn't parse trades_count from the API even though OKX likely provides it. Check API response for available fields.

5. **Binance Spot trades_count**: Set to NULL but Binance API may provide this in the detail response.

### P2 - Derived Metrics

6. **Implement sortino_ratio/calmar_ratio derivation**: For all exchanges with equity curve data, compute these during the `batch-enrich` cron job using `enrichment-metrics.ts`.

7. **Implement profit_factor**: Requires aggregating winning vs losing trades from position_history. Only possible for exchanges with position history enrichment.

### P3 - Nice-to-Have

8. **DEX profile enrichment**: ENS/Lens resolution for Hyperliquid/GMX wallet addresses to get display names and avatars.

9. **Market correlation (beta/alpha)**: Requires BTC/ETH price timeseries + trader equity curves. Infrastructure exists in types but computation never built.

10. **Asset preference classification**: Position history data exists for major exchanges but is never analyzed to fill `asset_preference` column.

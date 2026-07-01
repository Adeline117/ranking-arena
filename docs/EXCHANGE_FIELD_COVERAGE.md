# Exchange Field Coverage Ledger

> **Machine-generated** from production `arena.trader_stats` by `scripts/ingest-field-coverage-ledger.mts`. Do NOT hand-edit. Generated: 2026-07-01T02:10:29Z.

Fill % = share of a source×timeframe's rows where the field is non-NULL. A typed column or extras key at a low/zero rate is either not exposed by that exchange or a promotion gap. A key that regresses to 0 is a silent field loss — see `scripts/openclaw/field-coverage-canary.mjs`.

**35 serving sources.**

## binance_futures

Timeframes: 7, 30, 90 · rows: 14637 / 13109 / 12334

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 6%    | 6.7%  | 7.1%  |
| mdd               | 14.1% | 15.7% | 16.8% |
| win_rate          | 100%  | 100%  | 100%  |
| win_positions     | 14.1% | 15.8% | 16.8% |
| total_positions   | 14.1% | 13.6% | 16.8% |
| copier_pnl        | 14.1% | 15.8% | 16.8% |
| copier_count      | 12.2% | 13.6% | 14.5% |
| aum               | 71.5% | 79.8% | 83.6% |
| profit_share_rate | 12.2% | 13.6% | 14.5% |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d   | 90d   |
| ------------------------- | ----- | ----- | ----- |
| badge_name                | 1.3%  | 1.5%  | 1.6%  |
| copier_count_max          | 12.2% | 13.6% | 14.5% |
| copier_count_total        | 12.2% | 13.6% | 14.5% |
| favorite_count            | 12.2% | 13.6% | 14.5% |
| futures_type              | 12.2% | 13.6% | 14.5% |
| last_trade_time           | 12.2% | 13.6% | 14.5% |
| lead_start_time           | 12.2% | 13.6% | 14.5% |
| margin_balance            | 12.2% | 13.6% | 14.5% |
| min_copy_fixed_amount_usd | 12.2% | 13.6% | 14.5% |
| min_copy_fixed_ratio_usd  | 12.2% | 13.6% | 14.5% |

## binance_spot

Timeframes: 7, 30, 90 · rows: 2698 / 2651 / 2645

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 48%   | 48.8% | 48.9% |
| mdd               | 61%   | 62.1% | 62.2% |
| win_rate          | 61%   | 62.1% | 62.2% |
| copier_pnl        | 61%   | 62.1% | 62.2% |
| copier_count      | 59.5% | 60.5% | 60.6% |
| aum               | 95.4% | 97.1% | 97.4% |
| profit_share_rate | 59.5% | 60.5% | 60.6% |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d   | 90d   |
| ------------------------- | ----- | ----- | ----- |
| badge_name                | 0.3%  | 0.3%  | 0.3%  |
| copier_count_max          | 59.5% | 60.5% | 60.6% |
| copier_count_total        | 59.5% | 60.5% | 60.6% |
| days_trading              | 59.5% | 60.5% | 60.6% |
| favorite_count            | 59.5% | 60.5% | 60.6% |
| last_trade_time           | 53%   | 54%   | 54.1% |
| lead_start_time           | 59.5% | 60.5% | 60.6% |
| margin_balance            | 59.5% | 60.5% | 60.6% |
| min_copy_fixed_amount_usd | 59.5% | 60.5% | 60.6% |
| min_copy_fixed_ratio_usd  | 59.5% | 60.5% | 60.6% |
| win_days                  | 61%   | 62.1% | 62.2% |

## binance_web3_bsc

Timeframes: 7, 30, 90 · rows: 1784 / 1816 / 1567

**Typed columns** (fill % per timeframe)

| column   | 7d    | 30d   | 90d   |
| -------- | ----- | ----- | ----- |
| roi      | 100%  | 100%  | 100%  |
| pnl      | 100%  | 100%  | 100%  |
| win_rate | 100%  | 100%  | 100%  |
| aum      | 86.6% | 87.1% | 91.1% |
| volume   | 88.3% | 89.8% | 92.7% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d    | 30d   | 90d   |
| ------------------- | ----- | ----- | ----- |
| avg_buy             | 87.9% | 89.8% | 92.6% |
| buy_txns            | 85.9% | 88.5% | 90.4% |
| buy_volume          | 85.9% | 88.5% | 90.4% |
| last_trade_time     | 88.3% | 89.8% | 92.7% |
| sell_txns           | 85.9% | 88.5% | 90.4% |
| sell_volume         | 85.9% | 88.5% | 90.4% |
| total_traded_tokens | 88.3% | 89.8% | 92.7% |
| total_txns          | 88.3% | 89.8% | 92.7% |

## bingx_futures

Timeframes: 7, 30, 90 · rows: 4150 / 4112 / 4111

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 100%  | 100%  | 100%  |
| pnl             | 100%  | 100%  | 100%  |
| sharpe          | 87.5% | 87.9% | 89.2% |
| mdd             | 92.5% | 92.6% | 92.7% |
| win_rate        | 100%  | 100%  | 100%  |
| win_positions   | 92.2% | 92%   | 91.9% |
| total_positions | 92.2% | 92%   | 91.9% |
| copier_count    | 92.5% | 92.6% | 92.7% |
| aum             | 92.5% | 92.6% | 92.7% |

**Extras keys** (fill % per timeframe)

| extras key      | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| avg_loss        | 92.5% | 92.6% | 92.7% |
| avg_profit      | 92.5% | 92.6% | 92.7% |
| last_trade_time | 92.5% | 92.6% | 92.7% |
| risk_rating     | 53.7% | 53.9% | 54%   |
| trades_per_week | 92.5% | 92.6% | 92.7% |
| trading_days    | 92.5% | 92.6% | 92.7% |

## bitfinex

Timeframes: 7, 30 · rows: 413 / 370

**Typed columns** (fill % per timeframe)

| column | 7d    | 30d   |
| ------ | ----- | ----- |
| pnl    | 100%  | 100%  |
| volume | 34.9% | 47.6% |

## bitget_bots_futures

Timeframes: 0, 7, 30, 90 · rows: 374 / 372 / 450 / 372

**Typed columns** (fill % per timeframe)

| column       | 0d   | 7d   | 30d   | 90d  |
| ------------ | ---- | ---- | ----- | ---- |
| roi          | 100% | 100% | 100%  | 100% |
| pnl          | 100% | 100% | 100%  | 100% |
| mdd          | 0%   | 0%   | 49.3% | 0%   |
| copier_pnl   | 100% | 0%   | 0%    | 0%   |
| copier_count | 100% | 0%   | 0%    | 0%   |
| aum          | 100% | 0%   | 0%    | 0%   |

**Extras keys** (fill % per timeframe)

| extras key        | 0d    | 7d   | 30d   | 90d  |
| ----------------- | ----- | ---- | ----- | ---- |
| bot_strategy_id   | 100%  | 100% | 82.7% | 100% |
| created_at_origin | 100%  | 0%   | 0%    | 0%   |
| investment_amount | 100%  | 100% | 82.7% | 100% |
| leverage          | 97.6% | 100% | 82.7% | 100% |
| owner_name        | 100%  | 100% | 82.7% | 100% |
| runtime_days      | 100%  | 0%   | 0%    | 0%   |
| symbol            | 100%  | 100% | 82.7% | 100% |

## bitget_bots_spot

Timeframes: 0, 7, 30, 90 · rows: 387 / 376 / 509 / 376

**Typed columns** (fill % per timeframe)

| column       | 0d   | 7d   | 30d   | 90d  |
| ------------ | ---- | ---- | ----- | ---- |
| roi          | 100% | 100% | 100%  | 100% |
| pnl          | 100% | 100% | 100%  | 100% |
| mdd          | 0%   | 0%   | 11.4% | 0%   |
| copier_pnl   | 100% | 0%   | 0%    | 0%   |
| copier_count | 100% | 0%   | 0%    | 0%   |
| aum          | 100% | 0%   | 0%    | 0%   |

**Extras keys** (fill % per timeframe)

| extras key        | 0d    | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- | ----- |
| bot_strategy_id   | 100%  | 100%  | 73.9% | 100%  |
| created_at_origin | 100%  | 0%    | 0%    | 0%    |
| investment_amount | 100%  | 100%  | 73.9% | 100%  |
| leverage          | 52.5% | 55.3% | 40.9% | 55.3% |
| owner_name        | 100%  | 100%  | 73.9% | 100%  |
| runtime_days      | 100%  | 0%    | 0%    | 0%    |
| symbol            | 100%  | 100%  | 73.9% | 100%  |

## bitget_cfd

Timeframes: 7, 30, 90 · rows: 579 / 566 / 559

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 10.7% | 11%   | 11.3% |
| mdd                  | 10.7% | 10.4% | 10.4% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 6.4%  | 6.5%  | 6.8%  |
| total_positions      | 6.4%  | 6.5%  | 6.8%  |
| copier_pnl           | 10.7% | 11%   | 11.3% |
| copier_count         | 6.4%  | 6.5%  | 6.8%  |
| aum                  | 10.7% | 11%   | 11.3% |
| profit_share_rate    | 10.7% | 11%   | 11.3% |
| holding_duration_avg | 6.4%  | 6.5%  | 6.8%  |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d  | 90d   |
| ------------------------- | ----- | ---- | ----- |
| copier_count_current      | 6.4%  | 6.5% | 6.8%  |
| copier_count_max          | 6.4%  | 6.5% | 6.8%  |
| largest_loss              | 6.4%  | 6.5% | 6.8%  |
| largest_profit            | 6.4%  | 6.5% | 6.8%  |
| longest_holding_time_secs | 5.5%  | 5.7% | 5.7%  |
| loss_trades               | 9.2%  | 9.4% | 9.5%  |
| settled_in_days           | 6.4%  | 6.5% | 6.8%  |
| trade_frequency           | 10.7% | 11%  | 11.3% |

## bitget_futures

Timeframes: 7, 30, 90 · rows: 4397 / 3973 / 3487

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 34.5% | 33.6% | 27.4% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 36.1% | 39.9% | 45.5% |
| total_positions      | 36.1% | 39.9% | 45.5% |
| copier_pnl           | 36.3% | 40.2% | 45.8% |
| copier_count         | 36.1% | 39.9% | 45.5% |
| aum                  | 36%   | 39.9% | 45.4% |
| profit_share_rate    | 36.1% | 39.9% | 45.5% |
| holding_duration_avg | 27.7% | 30.7% | 35%   |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d   | 90d   |
| ------------------------- | ----- | ----- | ----- |
| bitget_trader_type        | 8.6%  | 9.5%  | 10.8% |
| copier_count_current      | 36.1% | 39.9% | 45.5% |
| copier_count_max          | 36.1% | 39.9% | 45.5% |
| copier_pnl_30d            | 6.5%  | 7.2%  | 8.2%  |
| largest_loss              | 27.7% | 30.7% | 35%   |
| largest_profit            | 27.7% | 30.7% | 35%   |
| last_order_time           | 8.3%  | 9.2%  | 10.5% |
| longest_holding_time_secs | 22.2% | 24.6% | 28.1% |
| loss_trades               | 22.2% | 24.6% | 28.1% |
| settled_in_days           | 27.7% | 30.7% | 35%   |
| total_equity              | 5%    | 5.6%  | 6.3%  |
| trade_frequency           | 27.7% | 30.7% | 35%   |
| trading_days              | 8.3%  | 9.2%  | 10.5% |

## bitget_spot

Timeframes: 7, 30, 90 · rows: 5556 / 5556 / 5556

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| roi                  | 100% | 100% | 100% |
| pnl                  | 6.5% | 6.5% | 6.5% |
| mdd                  | 6.5% | 6.3% | 6.2% |
| win_rate             | 100% | 100% | 100% |
| win_positions        | 6.1% | 6.1% | 6.1% |
| total_positions      | 6.1% | 6.1% | 6.1% |
| copier_pnl           | 6.5% | 6.5% | 6.5% |
| copier_count         | 6.1% | 6.1% | 6.1% |
| aum                  | 6.5% | 6.5% | 6.5% |
| profit_share_rate    | 6.5% | 6.5% | 6.5% |
| holding_duration_avg | 6.1% | 6.1% | 6.1% |

**Extras keys** (fill % per timeframe)

| extras key                | 7d   | 30d  | 90d  |
| ------------------------- | ---- | ---- | ---- |
| copier_count_current      | 6.1% | 6.1% | 6.1% |
| copier_count_max          | 6.1% | 6.1% | 6.1% |
| largest_loss              | 6.1% | 6.1% | 6.1% |
| largest_profit            | 6.1% | 6.1% | 6.1% |
| longest_holding_time_secs | 6.1% | 6.1% | 6.1% |
| loss_trades               | 6.4% | 6.4% | 6.4% |
| settled_in_days           | 6.1% | 6.1% | 6.1% |
| trade_frequency           | 6.5% | 6.5% | 6.5% |

## bitmart_futures

Timeframes: 7, 30, 90 · rows: 152 / 147 / 139

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 86.8% | 86.4% | 85.6% |
| pnl                  | 86.8% | 86.4% | 85.6% |
| mdd                  | 80.9% | 83.7% | 85.6% |
| win_rate             | 86.8% | 86.4% | 85.6% |
| copier_pnl           | 78.3% | 81%   | 85.6% |
| copier_count         | 91.4% | 94.6% | 100%  |
| aum                  | 80.9% | 83.7% | 85.6% |
| profit_share_rate    | 85.5% | 88.4% | 93.5% |
| holding_duration_avg | 78.3% | 81%   | 85.6% |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   | 90d   |
| ----------------------- | ----- | ----- | ----- |
| bio                     | 38.8% | 40.1% | 42.4% |
| last_traded_at          | 71.1% | 73.5% | 77.7% |
| leverage_limit          | 3.3%  | 3.4%  | 3.6%  |
| master_since            | 85.5% | 88.4% | 93.5% |
| min_copy_amount         | 85.5% | 88.4% | 93.5% |
| nav                     | 78.3% | 81%   | 85.6% |
| profit_loss_ratio       | 78.3% | 81%   | 85.6% |
| realized_profit_sharing | 78.3% | 81%   | 85.6% |
| run_time_seconds        | 91.4% | 94.6% | 100%  |
| start_at                | 78.3% | 81%   | 85.6% |
| top_volume_share        | 78.3% | 81%   | 85.6% |
| total_equity            | 78.3% | 81%   | 85.6% |
| trades_per_day          | 78.3% | 81%   | 85.6% |
| unrealized_pnl          | 78.3% | 81%   | 85.6% |

## bitunix_futures

Timeframes: 7, 30, 90 · rows: 4482 / 4484 / 4482

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 99.9% | 99.9% | 99.9% |
| pnl               | 99.9% | 99.9% | 99.9% |
| mdd               | 94.4% | 94.4% | 94.4% |
| win_rate          | 18%   | 23.9% | 30.3% |
| win_positions     | 19.6% | 19.6% | 19.6% |
| total_positions   | 19.6% | 19.6% | 19.6% |
| copier_pnl        | 19.6% | 19.6% | 19.6% |
| copier_count      | 19.6% | 19.6% | 19.6% |
| aum               | 94.4% | 94.4% | 94.4% |
| profit_share_rate | 19.6% | 19.6% | 19.6% |

**Extras keys** (fill % per timeframe)

| extras key            | 7d    | 30d   | 90d   |
| --------------------- | ----- | ----- | ----- |
| bio                   | 12.3% | 12.3% | 12.2% |
| copier_limit          | 19.6% | 19.6% | 19.6% |
| lead_margin_balance   | 19.6% | 19.6% | 19.6% |
| loss_count            | 19.6% | 19.6% | 19.6% |
| min_invest            | 18.6% | 18.6% | 18.6% |
| private_mode          | 19.6% | 19.6% | 19.6% |
| total_copiers_history | 19.6% | 19.6% | 19.6% |
| trade_amount          | 19.6% | 19.6% | 19.6% |
| trade_days            | 19.6% | 19.6% | 19.6% |

## blofin_futures

Timeframes: 7, 30, 90 · rows: 1708 / 1708 / 1708

**Typed columns** (fill % per timeframe)

| column       | 7d    | 30d   | 90d   |
| ------------ | ----- | ----- | ----- |
| roi          | 100%  | 100%  | 100%  |
| pnl          | 100%  | 100%  | 100%  |
| sharpe       | 100%  | 100%  | 100%  |
| mdd          | 99.9% | 99.9% | 99.4% |
| copier_count | 100%  | 100%  | 100%  |
| aum          | 100%  | 100%  | 100%  |

## blofin_spot

Timeframes: 7, 30, 90 · rows: 71 / 90 / 96

**Typed columns** (fill % per timeframe)

| column       | 7d   | 30d  | 90d  |
| ------------ | ---- | ---- | ---- |
| roi          | 100% | 100% | 100% |
| pnl          | 100% | 100% | 100% |
| sharpe       | 100% | 100% | 100% |
| mdd          | 100% | 100% | 100% |
| copier_count | 100% | 100% | 100% |
| aum          | 100% | 100% | 100% |

## btcc_futures

Timeframes: 7, 30, 90 · rows: 433 / 1830 / 433

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 93.8% | 92.9% | 91.7% |
| win_rate             | 58%   | 99.5% | 73.4% |
| win_positions        | 100%  | 23.6% | 100%  |
| total_positions      | 100%  | 23.6% | 100%  |
| copier_count         | 99.3% | 23.4% | 99.3% |
| aum                  | 100%  | 97.6% | 100%  |
| profit_share_rate    | 99.3% | 23.4% | 99.3% |
| holding_duration_avg | 100%  | 23.6% | 100%  |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   | 90d   |
| ----------------------- | ----- | ----- | ----- |
| bio                     | 94.2% | 22.2% | 94.2% |
| copier_limit            | 99.3% | 23.4% | 99.3% |
| cumulative_net_profit   | 100%  | 23.6% | 100%  |
| profit_loss_ratio_pct   | 100%  | 23.6% | 100%  |
| register_days           | 99.3% | 23.4% | 99.3% |
| supported_symbols_count | 99.3% | 23.4% | 99.3% |
| total_copiers_history   | 99.3% | 23.4% | 99.3% |
| total_roi               | 1.6%  | 0.4%  | 1.6%  |
| total_win_amount        | 100%  | 23.6% | 100%  |
| trader_level            | 99.3% | 23.4% | 99.3% |

## bybit_copytrade

Timeframes: 7, 30, 90 · rows: 9483 / 9483 / 9444

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d   |
| -------------------- | ---- | ---- | ----- |
| roi                  | 100% | 100% | 100%  |
| pnl                  | 9%   | 9%   | 9.1%  |
| sharpe               | 9%   | 9%   | 9.1%  |
| mdd                  | 89%  | 89%  | 89.4% |
| win_rate             | 100% | 100% | 100%  |
| win_positions        | 9%   | 9%   | 9.1%  |
| total_positions      | 9%   | 9%   | 9.1%  |
| copier_pnl           | 9%   | 9%   | 9.1%  |
| copier_count         | 9%   | 9%   | 9.1%  |
| aum                  | 9%   | 9%   | 9.1%  |
| profit_share_rate    | 9%   | 9%   | 9.1%  |
| holding_duration_avg | 9%   | 9%   | 9.1%  |

**Extras keys** (fill % per timeframe)

| extras key           | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| avg_pnl_per_trade    | 9%   | 9%   | 9.1% |
| bio                  | 4.5% | 4.5% | 4.5% |
| cum_follower_count   | 9%   | 9%   | 9.1% |
| last_traded_at       | 9%   | 9%   | 9.1% |
| leader_user_id       | 9%   | 9%   | 9.1% |
| loss_trades          | 8.4% | 8.4% | 8.4% |
| max_follower_count   | 9%   | 9%   | 9.1% |
| profit_to_loss_ratio | 9%   | 9%   | 9.1% |
| roe_volatility       | 9%   | 9%   | 9.1% |
| sortino              | 9%   | 9%   | 9.1% |
| stability_score      | 9%   | 9%   | 9.1% |
| trading_days         | 9%   | 9%   | 9.1% |
| wallet_balance       | 8.4% | 8.4% | 8.4% |
| weekly_trades        | 9%   | 9%   | 9.1% |

## bybit_mt5

Timeframes: 7, 30, 90 · rows: 30147 / 30132 / 30135

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| roi                  | 100% | 100% | 100% |
| pnl                  | 100% | 100% | 100% |
| sharpe               | 100% | 100% | 100% |
| mdd                  | 100% | 100% | 100% |
| win_rate             | 100% | 100% | 100% |
| win_positions        | 3.4% | 3.5% | 3.5% |
| total_positions      | 3.4% | 3.5% | 3.5% |
| copier_pnl           | 3.4% | 3.5% | 3.5% |
| copier_count         | 3.4% | 3.5% | 3.5% |
| aum                  | 3.4% | 3.4% | 3.4% |
| profit_share_rate    | 3.4% | 3.5% | 3.5% |
| holding_duration_avg | 3.4% | 3.5% | 3.5% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| avg_pnl_per_trade    | 3.4% | 3.5% | 3.5% |
| copier_count_max     | 3.3% | 3.3% | 3.3% |
| loss_trades          | 3.3% | 3.3% | 3.3% |
| margin_level         | 3.3% | 3.3% | 3.3% |
| profit_to_loss_ratio | 3.4% | 3.5% | 3.5% |
| provider_user_id     | 3.4% | 3.5% | 3.5% |
| roe_volatility       | 3.4% | 3.5% | 3.5% |
| sortino              | 3.4% | 3.5% | 3.5% |
| total_assets         | 3.4% | 3.5% | 3.5% |
| trading_days         | 3.4% | 3.5% | 3.5% |
| weekly_trades        | 3.4% | 3.5% | 3.5% |

## coinex_futures

Timeframes: 7, 30, 90 · rows: 205 / 205 / 205

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| mdd               | 98.5% | 98.5% | 98.5% |
| win_rate          | 100%  | 100%  | 100%  |
| win_positions     | 99%   | 99%   | 99%   |
| total_positions   | 99%   | 99%   | 99%   |
| copier_pnl        | 99%   | 99%   | 99%   |
| copier_count      | 99%   | 99%   | 99%   |
| aum               | 99%   | 99%   | 99%   |
| profit_share_rate | 99%   | 99%   | 99%   |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| copier_count_history | 99%   | 99%   | 99%   |
| equity               | 99%   | 99%   | 99%   |
| favorite_count       | 99%   | 99%   | 99%   |
| introduction         | 33.7% | 33.7% | 33.7% |
| last_trade_time      | 69.8% | 69.8% | 69.8% |
| margin_amount        | 99%   | 99%   | 99%   |
| max_copier_slots     | 99%   | 99%   | 99%   |
| max_copy_amount      | 99%   | 99%   | 99%   |
| min_copy_amount      | 99%   | 99%   | 99%   |
| profit_share_amount  | 99%   | 99%   | 99%   |
| total_profit_amount  | 99%   | 99%   | 99%   |
| trade_days           | 99%   | 99%   | 99%   |

## gate_cfd

Timeframes: 7, 30, 90 · rows: 3308 / 3303 / 3296

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 38.3% | 38.3% | 38.4% |
| mdd               | 39.5% | 39.5% | 39.6% |
| win_rate          | 100%  | 100%  | 100%  |
| win_positions     | 38.3% | 38.3% | 38.4% |
| total_positions   | 38.3% | 38.3% | 38.4% |
| copier_pnl        | 38.3% | 38.3% | 38.4% |
| copier_count      | 38.3% | 38.3% | 38.4% |
| aum               | 39.5% | 39.5% | 39.6% |
| profit_share_rate | 38.3% | 38.3% | 38.4% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| last_trade_at        | 30%   | 30.1% | 30.2% |
| leading_days         | 38.3% | 38.3% | 38.4% |
| net_asset_value      | 38.3% | 38.3% | 38.4% |
| pl_ratio             | 18.4% | 24.1% | 26.7% |
| settled_share_profit | 38.3% | 38.3% | 38.4% |
| trade_frequency      | 0.3%  | 0.3%  | 0.3%  |
| trading_frequency    | 38.3% | 38.3% | 38.4% |
| unrealized_pnl       | 0.3%  | 0.3%  | 0.3%  |

## gate_futures

Timeframes: 7, 30, 90 · rows: 3377 / 2508 / 2347

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 46.4% | 62.5% | 66.8% |
| mdd               | 58.6% | 71%   | 74.9% |
| win_rate          | 97.5% | 97.9% | 99.1% |
| win_positions     | 46.4% | 62.5% | 66.8% |
| total_positions   | 46.4% | 62.5% | 66.8% |
| copier_pnl        | 46.4% | 62.5% | 66.8% |
| copier_count      | 46.4% | 62.5% | 66.8% |
| aum               | 58.8% | 73.2% | 76.8% |
| volume            | 46.4% | 62.5% | 66.8% |
| profit_share_rate | 46.4% | 62.5% | 66.8% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d    | 30d   | 90d   |
| ------------------- | ----- | ----- | ----- |
| average_loss        | 46.4% | 62.5% | 66.8% |
| average_profit      | 46.4% | 62.5% | 66.8% |
| copier_count_total  | 46.4% | 62.5% | 66.8% |
| last_liquidation_at | 22.3% | 30.1% | 32.2% |
| last_trade_at       | 46.4% | 62.5% | 66.8% |
| lead_size           | 46.4% | 62.5% | 66.8% |
| leading_days        | 46.4% | 62.5% | 66.8% |
| pl_ratio            | 46.4% | 62.5% | 66.8% |
| roi_net_value       | 46.4% | 62.5% | 66.8% |
| trading_frequency   | 46.4% | 62.5% | 66.8% |

## gmx

Timeframes: 7, 30, 90 · rows: 162 / 159 / 162

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 85.2% | 91.8% | 100%  |
| pnl             | 100%  | 100%  | 100%  |
| win_rate        | 51.2% | 69.8% | 87%   |
| win_positions   | 82.7% | 91.2% | 97.5% |
| total_positions | 82.7% | 91.2% | 97.5% |
| aum             | 82.7% | 91.2% | 97.5% |
| volume          | 82.7% | 91.2% | 97.5% |

**Extras keys** (fill % per timeframe)

| extras key       | 7d    | 30d   | 90d   |
| ---------------- | ----- | ----- | ----- |
| aum_basis        | 97.5% | 99.4% | 97.5% |
| closed_count     | 82.7% | 91.2% | 97.5% |
| pnl_basis        | 97.5% | 99.4% | 97.5% |
| realized_pnl_usd | 82.7% | 91.2% | 97.5% |
| window_from      | 97.5% | 99.4% | 97.5% |

## gtrade

Timeframes: 7, 30, 90 · rows: 135 / 115 / 113

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| pnl             | 78.5% | 91.3% | 100%  |
| win_rate        | 78.5% | 91.3% | 100%  |
| win_positions   | 61.5% | 89.6% | 99.1% |
| total_positions | 61.5% | 89.6% | 99.1% |

**Extras keys** (fill % per timeframe)

| extras key        | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| lifetime_trades   | 83.7% | 98.3% | 99.1% |
| lifetime_volume   | 83.7% | 98.3% | 99.1% |
| lifetime_win_rate | 83.7% | 98.3% | 99.1% |
| pnl_basis         | 83.7% | 98.3% | 99.1% |
| thirty_day_volume | 83.7% | 98.3% | 99.1% |
| trades_truncated  | 83.7% | 98.3% | 99.1% |

## htx_futures

Timeframes: 7, 30, 90 · rows: 3 / 3 / 623

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d   |
| -------------------- | ---- | ---- | ----- |
| roi                  | 100% | 100% | 100%  |
| pnl                  | 100% | 100% | 100%  |
| mdd                  | 100% | 100% | 65.2% |
| win_rate             | 100% | 100% | 100%  |
| win_positions        | 100% | 100% | 64.7% |
| total_positions      | 100% | 100% | 64.7% |
| copier_pnl           | 100% | 100% | 64.7% |
| copier_count         | 100% | 100% | 64.7% |
| aum                  | 100% | 100% | 96.1% |
| profit_share_rate    | 100% | 100% | 64.7% |
| holding_duration_avg | 100% | 100% | 64.7% |

**Extras keys** (fill % per timeframe)

| extras key               | 7d   | 30d  | 90d   |
| ------------------------ | ---- | ---- | ----- |
| avg_loss                 | 100% | 100% | 64.7% |
| avg_profit               | 100% | 100% | 64.7% |
| copier_count_history     | 100% | 100% | 64.7% |
| introduction             | 100% | 100% | 43.8% |
| last_trade_time          | 100% | 100% | 64.7% |
| lead_since               | 100% | 100% | 64.7% |
| max_copier_slots         | 100% | 100% | 64.7% |
| profit_loss_ratio        | 100% | 100% | 64.7% |
| stats_scope              | 100% | 100% | 64.7% |
| trade_frequency_per_week | 100% | 100% | 64.7% |

## htx_spot

Timeframes: 90 · rows: 620

**Typed columns** (fill % per timeframe)

| column               | 90d   |
| -------------------- | ----- |
| roi                  | 100%  |
| pnl                  | 100%  |
| mdd                  | 100%  |
| win_rate             | 100%  |
| win_positions        | 61.6% |
| total_positions      | 61.6% |
| copier_pnl           | 61.6% |
| copier_count         | 61.6% |
| aum                  | 100%  |
| profit_share_rate    | 61.6% |
| holding_duration_avg | 61.6% |

**Extras keys** (fill % per timeframe)

| extras key               | 90d   |
| ------------------------ | ----- |
| avg_loss                 | 61.6% |
| avg_profit               | 61.6% |
| copier_count_history     | 61.6% |
| introduction             | 24.7% |
| last_trade_time          | 3.2%  |
| lead_since               | 61.6% |
| max_copier_slots         | 61.6% |
| profit_loss_ratio        | 61.6% |
| stats_scope              | 61.6% |
| trade_frequency_per_week | 61.6% |

## hyperliquid

Timeframes: 7, 30, 90 · rows: 26171 / 19876 / 1773

**Typed columns** (fill % per timeframe)

| column | 7d    | 30d   | 90d   |
| ------ | ----- | ----- | ----- |
| roi    | 100%  | 99.7% | 77.4% |
| pnl    | 100%  | 100%  | 100%  |
| sharpe | 0%    | 0%    | 0.1%  |
| mdd    | 0%    | 0%    | 0.1%  |
| aum    | 42.9% | 58.9% | 100%  |
| volume | 6.8%  | 8.9%  | 0%    |

**Extras keys** (fill % per timeframe)

| extras key      | 7d   | 30d  | 90d  |
| --------------- | ---- | ---- | ---- |
| derivation      | 0%   | 0%   | 100% |
| risk_derivation | 0%   | 0%   | 0.1% |
| risk_samples    | 0%   | 0%   | 0.1% |
| roi_basis       | 6.8% | 8.9% | 100% |
| sortino         | 0%   | 0%   | 0.1% |

## kucoin_futures

Timeframes: 30, 90 · rows: 1524 / 1

**Typed columns** (fill % per timeframe)

| column            | 30d   | 90d  |
| ----------------- | ----- | ---- |
| roi               | 100%  | 100% |
| pnl               | 100%  | 100% |
| copier_pnl        | 45.4% | 100% |
| copier_count      | 45.4% | 100% |
| aum               | 75.9% | 100% |
| profit_share_rate | 45.4% | 100% |

**Extras keys** (fill % per timeframe)

| extras key        | 30d   | 90d  |
| ----------------- | ----- | ---- |
| exchange_uid      | 45.4% | 100% |
| follower_count    | 45.4% | 100% |
| introduction      | 44.1% | 100% |
| lead_days         | 45.4% | 100% |
| lead_principal    | 45.4% | 100% |
| max_copier_slots  | 45.4% | 100% |
| total_return_rate | 45.4% | 100% |
| tradepilot        | 0.3%  | 0%   |
| venue             | 45.4% | 100% |

## lbank_futures

Timeframes: 7, 30 · rows: 300 / 300

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   |
| --------------- | ----- | ----- |
| roi             | 100%  | 100%  |
| pnl             | 100%  | 100%  |
| mdd             | 89.3% | 89.3% |
| win_rate        | 100%  | 100%  |
| total_positions | 85.7% | 85.7% |
| copier_pnl      | 85.7% | 85.7% |
| copier_count    | 85.7% | 85.7% |
| aum             | 89.3% | 89.3% |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   |
| ----------------------- | ----- | ----- |
| closed_positions        | 85.7% | 85.7% |
| current_followers       | 85.7% | 85.7% |
| introduction            | 31%   | 31%   |
| max_copier_slots        | 85.7% | 85.7% |
| open_positions          | 85.7% | 85.7% |
| profitable_copier_count | 85.7% | 85.7% |
| trader_level            | 85.7% | 85.7% |

## mexc_futures

Timeframes: 7, 30, 90 · rows: 15119 / 1187 / 1187

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d   | 90d   |
| -------------------- | ---- | ----- | ----- |
| roi                  | 100% | 100%  | 100%  |
| pnl                  | 100% | 100%  | 100%  |
| mdd                  | 63%  | 99.9% | 99.9% |
| win_rate             | 100% | 100%  | 100%  |
| win_positions        | 7.9% | 100%  | 100%  |
| total_positions      | 7.9% | 100%  | 100%  |
| copier_pnl           | 7.9% | 100%  | 100%  |
| copier_count         | 7.9% | 100%  | 100%  |
| aum                  | 63%  | 100%  | 100%  |
| profit_share_rate    | 7.9% | 100%  | 100%  |
| holding_duration_avg | 7.2% | 99.6% | 99.7% |

**Extras keys** (fill % per timeframe)

| extras key               | 7d   | 30d   | 90d   |
| ------------------------ | ---- | ----- | ----- |
| ability_rating           | 7.9% | 100%  | 100%  |
| avg_order_amount         | 7.9% | 100%  | 100%  |
| copier_count_history     | 7.9% | 100%  | 100%  |
| interested_count         | 7.9% | 100%  | 100%  |
| last_trade_time          | 7.9% | 100%  | 100%  |
| max_hold_time_hours      | 7.2% | 99.6% | 99.7% |
| profit_and_loss_ratio    | 7.8% | 100%  | 100%  |
| settled_days             | 7.9% | 100%  | 100%  |
| total_equity             | 7.6% | 96.5% | 96.5% |
| total_pnl                | 7.9% | 100%  | 100%  |
| total_roi                | 7.9% | 100%  | 100%  |
| total_win_rate           | 7.9% | 100%  | 100%  |
| trade_frequency_per_week | 7.9% | 100%  | 100%  |
| trader_type              | 0%   | 0.1%  | 0.1%  |

## okx_futures

Timeframes: 7, 30, 90 · rows: 346 / 346 / 359

**Typed columns** (fill % per timeframe)

| column     | 7d   | 30d  | 90d   |
| ---------- | ---- | ---- | ----- |
| roi        | 100% | 100% | 100%  |
| pnl        | 100% | 100% | 100%  |
| win_rate   | 100% | 100% | 100%  |
| copier_pnl | 100% | 100% | 96.4% |
| aum        | 0%   | 0%   | 64.6% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d   | 30d  | 90d   |
| ------------------- | ---- | ---- | ----- |
| avg_subpos_notional | 100% | 100% | 96.4% |
| invest_amt          | 100% | 100% | 96.4% |
| loss_days           | 100% | 100% | 96.4% |
| profit_days         | 100% | 100% | 96.4% |

## okx_spot

Timeframes: 7, 30, 90 · rows: 244 / 244 / 249

**Typed columns** (fill % per timeframe)

| column     | 7d   | 30d  | 90d   |
| ---------- | ---- | ---- | ----- |
| roi        | 100% | 100% | 100%  |
| pnl        | 100% | 100% | 100%  |
| win_rate   | 100% | 100% | 100%  |
| copier_pnl | 100% | 100% | 98%   |
| aum        | 0%   | 0%   | 74.3% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d   | 30d  | 90d |
| ------------------- | ---- | ---- | --- |
| avg_subpos_notional | 100% | 100% | 98% |
| invest_amt          | 100% | 100% | 98% |
| loss_days           | 100% | 100% | 98% |
| profit_days         | 100% | 100% | 98% |

## okx_web3_solana

Timeframes: 7, 30, 90 · rows: 18775 / 20399 / 21545

**Typed columns** (fill % per timeframe)

| column   | 7d   | 30d  | 90d  |
| -------- | ---- | ---- | ---- |
| roi      | 100% | 100% | 100% |
| pnl      | 100% | 100% | 100% |
| win_rate | 100% | 100% | 100% |
| volume   | 8.1% | 7.5% | 7.1% |

**Extras keys** (fill % per timeframe)

| extras key            | 7d   | 30d  | 90d  |
| --------------------- | ---- | ---- | ---- |
| avg_cost_buy          | 8.1% | 7.5% | 7.1% |
| favorite_mcap_type    | 8.1% | 7.5% | 7.1% |
| native_balance_amount | 8.1% | 7.5% | 7.1% |
| native_balance_usd    | 8.1% | 7.5% | 7.1% |
| top_tokens_total_pnl  | 8.1% | 7.5% | 7.1% |
| txs_buy               | 8.1% | 7.5% | 7.1% |
| txs_sell              | 8.1% | 7.5% | 7.1% |
| unrealized_pnl        | 8.1% | 7.5% | 7.1% |
| unrealized_pnl_roi    | 8.1% | 7.5% | 7.1% |
| volume_buy            | 8.1% | 7.5% | 7.1% |
| volume_sell           | 8.1% | 7.5% | 7.1% |

## phemex_futures

Timeframes: 30, 90 · rows: 456 / 455

**Typed columns** (fill % per timeframe)

| column            | 30d   | 90d   |
| ----------------- | ----- | ----- |
| roi               | 100%  | 100%  |
| pnl               | 100%  | 100%  |
| mdd               | 91%   | 91.2% |
| win_rate          | 100%  | 100%  |
| win_positions     | 88.8% | 89%   |
| total_positions   | 88.8% | 89%   |
| copier_pnl        | 88.8% | 89%   |
| copier_count      | 88.8% | 89%   |
| aum               | 91%   | 91.2% |
| volume            | 88.8% | 89%   |
| profit_share_rate | 88.8% | 89%   |

**Extras keys** (fill % per timeframe)

| extras key                  | 30d   | 90d  |
| --------------------------- | ----- | ---- |
| ai_trader                   | 3.1%  | 3.1% |
| copier_total_realized_pnl   | 88.8% | 89%  |
| follower_count              | 88.8% | 89%  |
| max_copier_slots            | 88.8% | 89%  |
| position_hold_time_total_ns | 88.8% | 89%  |
| star_trader                 | 88.8% | 89%  |
| total_balance               | 88.8% | 89%  |
| total_pnl                   | 88.8% | 89%  |
| total_roi                   | 88.8% | 89%  |
| total_trade_volume          | 88.8% | 89%  |

## toobit_futures

Timeframes: 7, 30, 90 · rows: 1608 / 1608 / 1608

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 99.9% | 99.6% | 99.3% |
| mdd               | 40.5% | 40.5% | 40.5% |
| win_rate          | 100%  | 100%  | 100%  |
| copier_count      | 40.5% | 40.5% | 40.5% |
| aum               | 100%  | 99.6% | 100%  |
| profit_share_rate | 35.9% | 35.9% | 35.9% |

**Extras keys** (fill % per timeframe)

| extras key                       | 7d    | 30d   | 90d   |
| -------------------------------- | ----- | ----- | ----- |
| bio                              | 21.2% | 21.2% | 21.2% |
| copier_limit                     | 40.5% | 40.5% | 40.5% |
| is_full                          | 40.5% | 40.5% | 40.5% |
| last_week_win_rate               | 40.5% | 40.5% | 40.5% |
| lead_days                        | 40.5% | 40.5% | 40.5% |
| leaderMaximumDrawdownProportion  | 40.5% | 40.5% | 40.5% |
| leaderProfitOrderRatioProportion | 40.5% | 40.5% | 40.5% |
| leaderProfitRatioProportion      | 40.5% | 40.5% | 40.5% |
| start_lead_time                  | 40.5% | 40.5% | 40.5% |
| total_copiers_history            | 40.5% | 40.5% | 40.5% |
| trade_count_lifetime             | 40.5% | 40.5% | 40.5% |

## xt_futures

Timeframes: 7, 30, 90 · rows: 1891 / 1891 / 1891

**Typed columns** (fill % per timeframe)

| column       | 7d    | 30d   | 90d   |
| ------------ | ----- | ----- | ----- |
| roi          | 100%  | 100%  | 100%  |
| pnl          | 100%  | 100%  | 100%  |
| mdd          | 99.3% | 99.3% | 99.3% |
| win_rate     | 100%  | 100%  | 100%  |
| copier_count | 24.8% | 24.8% | 24.8% |
| aum          | 15.3% | 15.3% | 15.3% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| intro                | 6.1%  | 6.1%  | 6.1%  |
| leading_days         | 24.8% | 24.8% | 24.8% |
| level_name           | 24.8% | 24.8% | 24.8% |
| platform_profit_rate | 24.8% | 24.8% | 24.8% |

## xt_spot

Timeframes: 7, 30, 90 · rows: 55 / 17 / 30

**Typed columns** (fill % per timeframe)

| column   | 7d    | 30d   | 90d  |
| -------- | ----- | ----- | ---- |
| roi      | 100%  | 100%  | 100% |
| pnl      | 100%  | 100%  | 100% |
| mdd      | 16.4% | 41.2% | 60%  |
| win_rate | 100%  | 94.1% | 100% |

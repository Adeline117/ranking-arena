# Exchange Field Coverage Ledger

> **Machine-generated** from production `arena.trader_stats` by `scripts/ingest-field-coverage-ledger.mts`. Do NOT hand-edit. Generated: 2026-07-01T23:59:58Z.

Fill % = share of a source×timeframe's rows where the field is non-NULL. A typed column or extras key at a low/zero rate is either not exposed by that exchange or a promotion gap. A key that regresses to 0 is a silent field loss — see `scripts/openclaw/field-coverage-canary.mjs`.

**34 serving sources.**

## binance_futures

Timeframes: 7, 30, 90 · rows: 14927 / 13396 / 12341

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 6.1%  | 6.8%  | 7.4%  |
| mdd               | 14.3% | 16%   | 17.3% |
| win_rate          | 100%  | 100%  | 100%  |
| win_positions     | 14.3% | 16%   | 17.4% |
| total_positions   | 14.3% | 13.8% | 17.4% |
| copier_pnl        | 14.3% | 16%   | 17.4% |
| copier_count      | 12.4% | 13.8% | 15%   |
| aum               | 72.1% | 80.2% | 83.6% |
| profit_share_rate | 12.4% | 13.8% | 15%   |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d   | 90d  |
| ------------------------- | ----- | ----- | ---- |
| badge_name                | 1.4%  | 1.6%  | 1.7% |
| copier_count_max          | 12.4% | 13.8% | 15%  |
| copier_count_total        | 12.4% | 13.8% | 15%  |
| favorite_count            | 12.4% | 13.8% | 15%  |
| futures_type              | 12.4% | 13.8% | 15%  |
| last_trade_time           | 12.4% | 13.8% | 15%  |
| lead_start_time           | 12.4% | 13.8% | 15%  |
| margin_balance            | 12.4% | 13.8% | 15%  |
| min_copy_fixed_amount_usd | 12.4% | 13.8% | 15%  |
| min_copy_fixed_ratio_usd  | 12.4% | 13.8% | 15%  |

## binance_spot

Timeframes: 7, 30, 90 · rows: 2706 / 2660 / 2654

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 48.9% | 49.7% | 49.8% |
| mdd               | 61.9% | 63%   | 63.1% |
| win_rate          | 61.9% | 63%   | 63.1% |
| copier_pnl        | 61.9% | 63%   | 63.1% |
| copier_count      | 60.3% | 61.4% | 61.5% |
| aum               | 95.5% | 97.1% | 97.4% |
| profit_share_rate | 60.3% | 61.4% | 61.5% |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d   | 90d   |
| ------------------------- | ----- | ----- | ----- |
| badge_name                | 0.3%  | 0.3%  | 0.3%  |
| copier_count_max          | 60.3% | 61.4% | 61.5% |
| copier_count_total        | 60.3% | 61.4% | 61.5% |
| days_trading              | 60.3% | 61.4% | 61.5% |
| favorite_count            | 60.3% | 61.4% | 61.5% |
| last_trade_time           | 54%   | 54.9% | 55%   |
| lead_start_time           | 60.3% | 61.4% | 61.5% |
| margin_balance            | 60.3% | 61.4% | 61.5% |
| min_copy_fixed_amount_usd | 60.3% | 61.4% | 61.5% |
| min_copy_fixed_ratio_usd  | 60.3% | 61.4% | 61.5% |
| win_days                  | 61.9% | 63%   | 63.1% |

## binance_web3_bsc

Timeframes: 7, 30, 90 · rows: 1791 / 1833 / 1567

**Typed columns** (fill % per timeframe)

| column   | 7d    | 30d   | 90d   |
| -------- | ----- | ----- | ----- |
| roi      | 100%  | 100%  | 100%  |
| pnl      | 100%  | 100%  | 100%  |
| win_rate | 100%  | 100%  | 100%  |
| aum      | 86.3% | 86.3% | 91.1% |
| volume   | 88.3% | 89.9% | 92.7% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d    | 30d   | 90d   |
| ------------------- | ----- | ----- | ----- |
| avg_buy             | 88%   | 89.9% | 92.6% |
| buy_txns            | 85.9% | 88.7% | 90.4% |
| buy_volume          | 85.9% | 88.7% | 90.4% |
| last_trade_time     | 88.3% | 89.9% | 92.7% |
| sell_txns           | 85.9% | 88.7% | 90.4% |
| sell_volume         | 85.9% | 88.7% | 90.4% |
| total_traded_tokens | 88.3% | 89.9% | 92.7% |
| total_txns          | 88.3% | 89.9% | 92.7% |

## bingx_futures

Timeframes: 7, 30, 90 · rows: 4297 / 4264 / 4246

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 100%  | 100%  | 100%  |
| pnl             | 100%  | 100%  | 100%  |
| sharpe          | 89%   | 89.4% | 89.6% |
| mdd             | 93%   | 93.1% | 93.1% |
| win_rate        | 100%  | 100%  | 100%  |
| win_positions   | 92.6% | 92.4% | 92.3% |
| total_positions | 92.6% | 92.4% | 92.3% |
| copier_count    | 93%   | 93.1% | 93.1% |
| aum             | 93%   | 93.1% | 93.1% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| avg_hold_time_hours  | 56.1% | 56.4% | 55.8% |
| avg_loss             | 92.9% | 93.1% | 93.1% |
| avg_profit           | 92.9% | 93.1% | 93.1% |
| copier_count_history | 56.2% | 56.4% | 55.8% |
| copier_earnings      | 56.2% | 56.4% | 55.8% |
| copier_growth_30d    | 56.2% | 56.4% | 55.8% |
| following_amount     | 8.1%  | 8.1%  | 8.1%  |
| last_trade_time      | 92.9% | 93.1% | 93.1% |
| lifetime_trades      | 56.6% | 57%   | 56.3% |
| loss_trades          | 56.2% | 56.4% | 55.8% |
| max_copier_slots     | 56.2% | 56.4% | 55.8% |
| pnl_ratio            | 54.9% | 55.3% | 54.5% |
| principal            | 35.8% | 35.9% | 35.4% |
| risk_rating          | 59.5% | 59.8% | 59.3% |
| total_earnings       | 56.2% | 56.4% | 55.8% |
| trader_tenure_days   | 56.2% | 56.4% | 55.8% |
| trades_per_week      | 92.9% | 93.1% | 93.1% |
| trading_days         | 92.9% | 93.1% | 93.1% |

## bitfinex

Timeframes: 7, 30 · rows: 413 / 373

**Typed columns** (fill % per timeframe)

| column | 7d    | 30d   |
| ------ | ----- | ----- |
| pnl    | 100%  | 100%  |
| volume | 34.9% | 47.2% |

## bitget_bots_futures

Timeframes: 0, 7, 30, 90 · rows: 385 / 383 / 457 / 383

**Typed columns** (fill % per timeframe)

| column       | 0d   | 7d   | 30d   | 90d  |
| ------------ | ---- | ---- | ----- | ---- |
| roi          | 100% | 100% | 100%  | 100% |
| pnl          | 100% | 100% | 100%  | 100% |
| mdd          | 0%   | 0%   | 51.4% | 0%   |
| copier_pnl   | 100% | 0%   | 0%    | 0%   |
| copier_count | 100% | 0%   | 0%    | 0%   |
| aum          | 100% | 0%   | 0%    | 0%   |

**Extras keys** (fill % per timeframe)

| extras key        | 0d    | 7d   | 30d   | 90d  |
| ----------------- | ----- | ---- | ----- | ---- |
| bot_strategy_id   | 100%  | 100% | 83.8% | 100% |
| created_at_origin | 100%  | 0%   | 0%    | 0%   |
| investment_amount | 100%  | 100% | 83.8% | 100% |
| leverage          | 97.7% | 100% | 83.8% | 100% |
| owner_name        | 100%  | 100% | 83.8% | 100% |
| runtime_days      | 100%  | 0%   | 0%    | 0%   |
| symbol            | 100%  | 100% | 83.8% | 100% |

## bitget_bots_spot

Timeframes: 0, 7, 30, 90 · rows: 389 / 378 / 524 / 378

**Typed columns** (fill % per timeframe)

| column       | 0d   | 7d   | 30d   | 90d  |
| ------------ | ---- | ---- | ----- | ---- |
| roi          | 100% | 100% | 100%  | 100% |
| pnl          | 100% | 100% | 100%  | 100% |
| mdd          | 0%   | 0%   | 34.2% | 0%   |
| copier_pnl   | 100% | 0%   | 0%    | 0%   |
| copier_count | 100% | 0%   | 0%    | 0%   |
| aum          | 100% | 0%   | 0%    | 0%   |

**Extras keys** (fill % per timeframe)

| extras key        | 0d    | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- | ----- |
| bot_strategy_id   | 100%  | 100%  | 72.1% | 100%  |
| created_at_origin | 100%  | 0%    | 0%    | 0%    |
| investment_amount | 100%  | 100%  | 72.1% | 100%  |
| leverage          | 52.4% | 55.3% | 39.9% | 55.3% |
| owner_name        | 100%  | 100%  | 72.1% | 100%  |
| runtime_days      | 100%  | 0%    | 0%    | 0%    |
| symbol            | 100%  | 100%  | 72.1% | 100%  |

## bitget_cfd

Timeframes: 7, 30, 90 · rows: 592 / 573 / 566

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 10.6% | 11%   | 11.3% |
| mdd                  | 10.6% | 10.5% | 10.4% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 6.4%  | 6.6%  | 6.9%  |
| total_positions      | 6.4%  | 6.6%  | 6.9%  |
| copier_pnl           | 10.6% | 11%   | 11.3% |
| copier_count         | 6.4%  | 6.6%  | 6.9%  |
| aum                  | 10.6% | 11%   | 11.3% |
| profit_share_rate    | 10.6% | 11%   | 11.3% |
| holding_duration_avg | 6.4%  | 6.6%  | 6.9%  |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d  | 90d   |
| ------------------------- | ----- | ---- | ----- |
| copier_count_current      | 6.4%  | 6.6% | 6.9%  |
| copier_count_max          | 6.4%  | 6.6% | 6.9%  |
| largest_loss              | 6.4%  | 6.6% | 6.9%  |
| largest_profit            | 6.4%  | 6.6% | 6.9%  |
| long_short_ratio          | 0.2%  | 0.3% | 1.1%  |
| longest_holding_time_secs | 5.6%  | 5.8% | 5.8%  |
| loss_trades               | 9.1%  | 9.4% | 9.5%  |
| settled_in_days           | 6.4%  | 6.6% | 6.9%  |
| total_equity              | 0.8%  | 0.9% | 0.9%  |
| trade_frequency           | 10.6% | 11%  | 11.3% |

## bitget_futures

Timeframes: 7, 30, 90 · rows: 4462 / 4039 / 3539

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 34.6% | 33.8% | 27.9% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 36.4% | 40.2% | 45.8% |
| total_positions      | 36.4% | 40.2% | 45.8% |
| copier_pnl           | 36.6% | 40.5% | 46.2% |
| copier_count         | 36.4% | 40.2% | 45.8% |
| aum                  | 36.4% | 40.2% | 45.8% |
| profit_share_rate    | 36.4% | 40.2% | 45.8% |
| holding_duration_avg | 27.8% | 30.7% | 35%   |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d   | 90d   |
| ------------------------- | ----- | ----- | ----- |
| bitget_trader_type        | 8.9%  | 9.8%  | 11.2% |
| copier_count_current      | 36.4% | 40.2% | 45.8% |
| copier_count_max          | 36.4% | 40.2% | 45.8% |
| copier_pnl_30d            | 6.9%  | 7.6%  | 8.6%  |
| largest_loss              | 27.8% | 30.7% | 35%   |
| largest_profit            | 27.8% | 30.7% | 35%   |
| last_order_time           | 8.6%  | 9.5%  | 10.8% |
| long_short_ratio          | 1.4%  | 2.2%  | 2.7%  |
| longest_holding_time_secs | 22.5% | 24.9% | 28.3% |
| loss_trades               | 22.5% | 24.9% | 28.3% |
| settled_in_days           | 27.8% | 30.7% | 35%   |
| total_equity              | 6.1%  | 6.8%  | 7.7%  |
| trade_frequency           | 27.8% | 30.7% | 35%   |
| trading_days              | 8.6%  | 9.5%  | 10.8% |

## bitget_spot

Timeframes: 7, 30, 90 · rows: 5557 / 5557 / 5558

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
| long_short_ratio          | 0%   | 0.1% | 0.1% |
| longest_holding_time_secs | 6.1% | 6.1% | 6.1% |
| loss_trades               | 6.4% | 6.4% | 6.4% |
| settled_in_days           | 6.1% | 6.1% | 6.1% |
| total_equity              | 0.3% | 0.3% | 0.3% |
| trade_frequency           | 6.5% | 6.5% | 6.5% |

## bitmart_futures

Timeframes: 7, 30, 90 · rows: 154 / 149 / 142

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 86.4% | 85.9% | 85.2% |
| pnl                  | 86.4% | 85.9% | 85.2% |
| mdd                  | 80.5% | 83.2% | 85.2% |
| win_rate             | 86.4% | 85.9% | 85.2% |
| copier_pnl           | 78.6% | 81.2% | 85.2% |
| copier_count         | 94.2% | 97.3% | 100%  |
| aum                  | 80.5% | 83.2% | 85.2% |
| profit_share_rate    | 85.7% | 88.6% | 93%   |
| holding_duration_avg | 78.6% | 81.2% | 85.2% |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   | 90d   |
| ----------------------- | ----- | ----- | ----- |
| bio                     | 39.6% | 40.9% | 43%   |
| last_traded_at          | 71.4% | 73.8% | 77.5% |
| leverage_limit          | 3.2%  | 3.4%  | 3.5%  |
| master_since            | 85.7% | 88.6% | 93%   |
| min_copy_amount         | 85.7% | 88.6% | 93%   |
| nav                     | 80.5% | 83.2% | 85.2% |
| pnl_ratio               | 51.3% | 53%   | 0%    |
| profit_loss_ratio       | 78.6% | 81.2% | 85.2% |
| realized_profit_sharing | 78.6% | 81.2% | 85.2% |
| run_time_seconds        | 92.2% | 95.3% | 100%  |
| start_at                | 78.6% | 81.2% | 85.2% |
| top_volume_share        | 78.6% | 81.2% | 85.2% |
| total_equity            | 78.6% | 81.2% | 85.2% |
| trades_per_day          | 78.6% | 81.2% | 85.2% |
| unrealized_pnl          | 78.6% | 81.2% | 85.2% |

## bitunix_futures

Timeframes: 7, 30, 90 · rows: 4486 / 4487 / 4485

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 99.9% | 99.9% | 99.9% |
| pnl               | 99.9% | 99.9% | 99.9% |
| mdd               | 94.4% | 94.4% | 94.4% |
| win_rate          | 18.1% | 24%   | 30.4% |
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

Timeframes: 7, 30, 90 · rows: 1709 / 1709 / 1709

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

Timeframes: 7, 30, 90 · rows: 443 / 1833 / 443

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 93.7% | 94.2% | 91.4% |
| win_rate             | 58.5% | 99.9% | 74%   |
| win_positions        | 100%  | 24.1% | 100%  |
| total_positions      | 100%  | 24.1% | 100%  |
| copier_count         | 99.3% | 23.9% | 99.3% |
| aum                  | 100%  | 98.8% | 100%  |
| profit_share_rate    | 99.3% | 23.9% | 99.3% |
| holding_duration_avg | 100%  | 24.1% | 100%  |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   | 90d   |
| ----------------------- | ----- | ----- | ----- |
| bio                     | 94.4% | 22.7% | 94.4% |
| copier_limit            | 99.3% | 23.9% | 99.3% |
| cumulative_net_profit   | 100%  | 24.1% | 100%  |
| profit_loss_ratio_pct   | 100%  | 24.1% | 100%  |
| register_days           | 99.3% | 23.9% | 99.3% |
| supported_symbols_count | 99.3% | 23.9% | 99.3% |
| total_copiers_history   | 99.3% | 23.9% | 99.3% |
| total_roi               | 84.2% | 20.4% | 84.4% |
| total_win_amount        | 100%  | 24.1% | 100%  |
| trader_level            | 99.3% | 23.9% | 99.3% |

## bybit_copytrade

Timeframes: 7, 30, 90 · rows: 9511 / 9511 / 9472

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 9.1%  | 9.1%  | 9.2%  |
| sharpe               | 9.1%  | 9.1%  | 9.2%  |
| mdd                  | 89.1% | 89.1% | 89.5% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 9.1%  | 9.1%  | 9.2%  |
| total_positions      | 9.1%  | 9.1%  | 9.2%  |
| copier_pnl           | 9.1%  | 9.1%  | 9.2%  |
| copier_count         | 9.1%  | 9.1%  | 9.2%  |
| aum                  | 9.1%  | 9.1%  | 9.2%  |
| profit_share_rate    | 9.1%  | 9.1%  | 9.2%  |
| holding_duration_avg | 9.1%  | 9.1%  | 9.2%  |

**Extras keys** (fill % per timeframe)

| extras key           | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| avg_pnl_per_trade    | 9.1% | 9.1% | 9.2% |
| bio                  | 4.5% | 4.5% | 4.5% |
| cum_follower_count   | 9.1% | 9.1% | 9.2% |
| last_traded_at       | 9.1% | 9.1% | 9.2% |
| leader_user_id       | 9.1% | 9.1% | 9.2% |
| lifetime_trades      | 4.8% | 4.8% | 4.9% |
| loss_trades          | 8.5% | 8.5% | 8.6% |
| max_follower_count   | 9.1% | 9.1% | 9.2% |
| profit_to_loss_ratio | 9.1% | 9.1% | 9.2% |
| roe_volatility       | 9.1% | 9.1% | 9.2% |
| sortino              | 9.1% | 9.1% | 9.2% |
| stability_score      | 9.1% | 9.1% | 9.2% |
| total_pnl            | 4.8% | 4.8% | 4.9% |
| total_roi            | 4.8% | 4.8% | 4.9% |
| trading_days         | 9.1% | 9.1% | 9.2% |
| wallet_balance       | 8.5% | 8.5% | 8.6% |
| weekly_trades        | 9.1% | 9.1% | 9.2% |

## bybit_mt5

Timeframes: 7, 30, 90 · rows: 30158 / 30161 / 30163

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| roi                  | 100% | 100% | 100% |
| pnl                  | 100% | 100% | 100% |
| sharpe               | 100% | 100% | 100% |
| mdd                  | 100% | 100% | 100% |
| win_rate             | 100% | 100% | 100% |
| win_positions        | 3.7% | 3.7% | 3.7% |
| total_positions      | 3.7% | 3.7% | 3.7% |
| copier_pnl           | 3.7% | 3.7% | 3.7% |
| copier_count         | 3.7% | 3.7% | 3.7% |
| aum                  | 3.7% | 3.7% | 3.7% |
| profit_share_rate    | 3.7% | 3.7% | 3.7% |
| holding_duration_avg | 3.7% | 3.7% | 3.7% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| avg_pnl_per_trade    | 3.7% | 3.7% | 3.7% |
| copier_count_max     | 3.5% | 3.5% | 3.5% |
| loss_trades          | 3.5% | 3.5% | 3.5% |
| margin_level         | 3.5% | 3.5% | 3.5% |
| profit_to_loss_ratio | 3.7% | 3.7% | 3.7% |
| provider_user_id     | 3.7% | 3.7% | 3.7% |
| roe_volatility       | 3.7% | 3.7% | 3.7% |
| sortino              | 3.7% | 3.7% | 3.7% |
| total_assets         | 3.7% | 3.7% | 3.7% |
| trading_days         | 3.7% | 3.7% | 3.7% |
| weekly_trades        | 3.7% | 3.7% | 3.7% |

## gate_cfd

Timeframes: 7, 30, 90 · rows: 3356 / 3352 / 3345

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 39.5% | 39.6% | 39.7% |
| mdd               | 41.2% | 41.3% | 41.3% |
| win_rate          | 100%  | 100%  | 100%  |
| win_positions     | 39.5% | 39.6% | 39.7% |
| total_positions   | 39.5% | 39.6% | 39.7% |
| copier_pnl        | 39.5% | 39.6% | 39.7% |
| copier_count      | 39.5% | 39.6% | 39.7% |
| aum               | 41.2% | 41.3% | 41.3% |
| profit_share_rate | 39.5% | 39.6% | 39.7% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| last_trade_at        | 31.5% | 31.5% | 31.6% |
| leading_days         | 39.5% | 39.6% | 39.7% |
| net_asset_value      | 39.5% | 39.6% | 39.7% |
| pl_ratio             | 19.7% | 25.5% | 28.1% |
| settled_share_profit | 39.5% | 39.6% | 39.7% |
| trade_frequency      | 11%   | 11%   | 11.1% |
| trading_frequency    | 39.5% | 39.6% | 39.7% |
| unrealized_pnl       | 11%   | 11%   | 11.1% |

## gate_futures

Timeframes: 7, 30, 90 · rows: 3431 / 2566 / 2404

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 46.6% | 62.4% | 66.6% |
| mdd               | 61.7% | 72.6% | 76.3% |
| win_rate          | 96.9% | 97.7% | 99%   |
| win_positions     | 46.6% | 62.4% | 66.6% |
| total_positions   | 46.6% | 62.4% | 66.6% |
| copier_pnl        | 46.6% | 62.4% | 66.6% |
| copier_count      | 46.6% | 62.4% | 66.6% |
| aum               | 61.9% | 74.7% | 78.3% |
| volume            | 46.6% | 62.4% | 66.6% |
| profit_share_rate | 46.6% | 62.4% | 66.6% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| average_loss         | 46.6% | 62.4% | 66.6% |
| average_profit       | 46.6% | 62.4% | 66.6% |
| copier_count_current | 8.3%  | 11.1% | 11.9% |
| copier_count_total   | 46.6% | 62.4% | 66.6% |
| copier_growth        | 8.3%  | 11.1% | 11.9% |
| last_liquidation_at  | 22.5% | 30.1% | 32.2% |
| last_trade_at        | 46.6% | 62.4% | 66.6% |
| lead_size            | 46.6% | 62.4% | 66.6% |
| leading_days         | 46.6% | 62.4% | 66.6% |
| pl_ratio             | 46.6% | 62.4% | 66.6% |
| roi_net_value        | 46.6% | 62.4% | 66.6% |
| trade_frequency      | 8.3%  | 11.1% | 11.9% |
| trading_frequency    | 46.6% | 62.4% | 66.6% |

## gmx

Timeframes: 7, 30, 90 · rows: 163 / 161 / 163

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 85.9% | 91.3% | 100%  |
| pnl             | 100%  | 100%  | 100%  |
| sharpe          | 56.4% | 61.5% | 63.8% |
| mdd             | 57.1% | 61.5% | 65%   |
| win_rate        | 51.5% | 68.9% | 87.1% |
| win_positions   | 83.4% | 90.1% | 97.5% |
| total_positions | 83.4% | 90.1% | 97.5% |
| aum             | 83.4% | 90.7% | 97.5% |
| volume          | 83.4% | 90.1% | 97.5% |

**Extras keys** (fill % per timeframe)

| extras key       | 7d    | 30d   | 90d   |
| ---------------- | ----- | ----- | ----- |
| aum_basis        | 97.5% | 98.8% | 97.5% |
| closed_count     | 83.4% | 90.1% | 97.5% |
| pnl_basis        | 97.5% | 98.8% | 97.5% |
| realized_pnl_usd | 83.4% | 90.1% | 97.5% |
| risk_derivation  | 57.1% | 61.5% | 65%   |
| risk_samples     | 57.1% | 61.5% | 65%   |
| sortino          | 57.1% | 61.5% | 63.8% |
| window_from      | 97.5% | 98.8% | 97.5% |

## gtrade

Timeframes: 7, 30, 90 · rows: 138 / 117 / 116

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d  |
| --------------- | ----- | ----- | ---- |
| pnl             | 80.4% | 91.5% | 100% |
| sharpe          | 0.7%  | 13.7% | 25%  |
| win_rate        | 80.4% | 91.5% | 100% |
| win_positions   | 62.3% | 90.6% | 100% |
| total_positions | 62.3% | 90.6% | 100% |

**Extras keys** (fill % per timeframe)

| extras key        | 7d    | 30d   | 90d  |
| ----------------- | ----- | ----- | ---- |
| lifetime_trades   | 84.1% | 99.1% | 100% |
| lifetime_volume   | 84.1% | 99.1% | 100% |
| lifetime_win_rate | 84.1% | 99.1% | 100% |
| pnl_basis         | 84.1% | 99.1% | 100% |
| risk_derivation   | 0.7%  | 13.7% | 25%  |
| risk_samples      | 0.7%  | 13.7% | 25%  |
| sortino           | 0.7%  | 13.7% | 25%  |
| thirty_day_volume | 84.1% | 99.1% | 100% |
| trades_truncated  | 84.1% | 99.1% | 100% |

## htx_futures

Timeframes: 7, 30, 90 · rows: 3 / 3 / 625

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d   |
| -------------------- | ---- | ---- | ----- |
| roi                  | 100% | 100% | 100%  |
| pnl                  | 100% | 100% | 100%  |
| mdd                  | 100% | 100% | 65.1% |
| win_rate             | 100% | 100% | 100%  |
| win_positions        | 100% | 100% | 65.1% |
| total_positions      | 100% | 100% | 65.1% |
| copier_pnl           | 100% | 100% | 65.1% |
| copier_count         | 100% | 100% | 65.1% |
| aum                  | 100% | 100% | 96.2% |
| profit_share_rate    | 100% | 100% | 65.1% |
| holding_duration_avg | 100% | 100% | 65.1% |

**Extras keys** (fill % per timeframe)

| extras key               | 7d   | 30d  | 90d   |
| ------------------------ | ---- | ---- | ----- |
| avg_loss                 | 100% | 100% | 65.1% |
| avg_profit               | 100% | 100% | 65.1% |
| copier_count_history     | 100% | 100% | 65.1% |
| introduction             | 100% | 100% | 44%   |
| last_trade_time          | 100% | 100% | 65.1% |
| lead_since               | 100% | 100% | 65.1% |
| max_copier_slots         | 100% | 100% | 65.1% |
| profit_loss_ratio        | 100% | 100% | 65.1% |
| stats_scope              | 100% | 100% | 65.1% |
| trade_frequency_per_week | 100% | 100% | 65.1% |

## htx_spot

Timeframes: 90 · rows: 624

**Typed columns** (fill % per timeframe)

| column               | 90d   |
| -------------------- | ----- |
| roi                  | 100%  |
| pnl                  | 100%  |
| mdd                  | 100%  |
| win_rate             | 100%  |
| win_positions        | 61.7% |
| total_positions      | 61.7% |
| copier_pnl           | 61.7% |
| copier_count         | 61.7% |
| aum                  | 100%  |
| profit_share_rate    | 61.7% |
| holding_duration_avg | 61.7% |

**Extras keys** (fill % per timeframe)

| extras key               | 90d   |
| ------------------------ | ----- |
| avg_loss                 | 61.7% |
| avg_profit               | 61.7% |
| copier_count_history     | 61.7% |
| introduction             | 24.8% |
| last_trade_time          | 3.2%  |
| lead_since               | 61.7% |
| max_copier_slots         | 61.7% |
| profit_loss_ratio        | 61.7% |
| stats_scope              | 61.7% |
| trade_frequency_per_week | 61.7% |

## hyperliquid

Timeframes: 7, 30, 90 · rows: 26247 / 19996 / 1784

**Typed columns** (fill % per timeframe)

| column | 7d    | 30d   | 90d   |
| ------ | ----- | ----- | ----- |
| roi    | 100%  | 99.7% | 77.7% |
| pnl    | 100%  | 100%  | 100%  |
| sharpe | 3.6%  | 4.9%  | 54.5% |
| mdd    | 3.7%  | 4.9%  | 54.7% |
| aum    | 45.2% | 60.1% | 100%  |
| volume | 6.8%  | 8.9%  | 0%    |

**Extras keys** (fill % per timeframe)

| extras key      | 7d   | 30d  | 90d   |
| --------------- | ---- | ---- | ----- |
| derivation      | 0%   | 0%   | 100%  |
| risk_derivation | 3.7% | 4.9% | 54.7% |
| risk_samples    | 3.7% | 4.9% | 54.7% |
| roi_basis       | 6.8% | 8.9% | 100%  |
| sortino         | 3.7% | 4.9% | 54.5% |

## kucoin_futures

Timeframes: 30, 90 · rows: 1537 / 1

**Typed columns** (fill % per timeframe)

| column            | 30d   | 90d  |
| ----------------- | ----- | ---- |
| roi               | 100%  | 100% |
| pnl               | 100%  | 100% |
| copier_pnl        | 48.2% | 100% |
| copier_count      | 72.9% | 100% |
| aum               | 76.4% | 100% |
| profit_share_rate | 48.2% | 100% |

**Extras keys** (fill % per timeframe)

| extras key          | 30d   | 90d  |
| ------------------- | ----- | ---- |
| copier_total_profit | 54%   | 0%   |
| exchange_uid        | 48.2% | 100% |
| follower_count      | 48.2% | 100% |
| introduction        | 46.9% | 100% |
| lead_days           | 48.2% | 100% |
| lead_principal      | 72.9% | 100% |
| leading_days        | 54%   | 0%   |
| max_copier_slots    | 72.9% | 100% |
| min_copy_amount     | 54%   | 0%   |
| total_pnl           | 54%   | 0%   |
| total_return_rate   | 48.2% | 100% |
| total_roi           | 54%   | 0%   |
| trade_frequency     | 20%   | 0%   |
| tradepilot          | 0.3%  | 0%   |
| trading_frequency   | 20%   | 0%   |
| venue               | 48.2% | 100% |

## lbank_futures

Timeframes: 7, 30 · rows: 319 / 316

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   |
| ----------------- | ----- | ----- |
| roi               | 100%  | 100%  |
| pnl               | 100%  | 100%  |
| mdd               | 90%   | 89.9% |
| win_rate          | 100%  | 100%  |
| total_positions   | 83.1% | 83.9% |
| copier_pnl        | 83.1% | 83.9% |
| copier_count      | 83.1% | 83.9% |
| aum               | 90%   | 89.9% |
| profit_share_rate | 22.9% | 23.1% |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   |
| ----------------------- | ----- | ----- |
| closed_positions        | 83.1% | 83.9% |
| copier_count_history    | 10.7% | 10.8% |
| current_followers       | 83.1% | 83.9% |
| introduction            | 29.5% | 29.7% |
| leading_days            | 10.7% | 10.8% |
| lifetime_trades         | 22.9% | 23.1% |
| max_copier_slots        | 83.1% | 83.9% |
| open_positions          | 83.1% | 83.9% |
| profitable_copier_count | 83.1% | 83.9% |
| trader_level            | 83.1% | 83.9% |

## mexc_futures

Timeframes: 7, 30, 90 · rows: 15134 / 1234 / 1234

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d   | 90d   |
| -------------------- | ---- | ----- | ----- |
| roi                  | 100% | 100%  | 100%  |
| pnl                  | 100% | 100%  | 100%  |
| mdd                  | 63%  | 99.9% | 99.9% |
| win_rate             | 100% | 100%  | 100%  |
| win_positions        | 8.2% | 100%  | 100%  |
| total_positions      | 8.2% | 100%  | 100%  |
| copier_pnl           | 8.2% | 100%  | 100%  |
| copier_count         | 8.2% | 100%  | 100%  |
| aum                  | 63%  | 100%  | 100%  |
| profit_share_rate    | 8.2% | 100%  | 100%  |
| holding_duration_avg | 7.4% | 99.7% | 99.8% |

**Extras keys** (fill % per timeframe)

| extras key               | 7d   | 30d   | 90d   |
| ------------------------ | ---- | ----- | ----- |
| ability_rating           | 8.2% | 100%  | 100%  |
| avg_order_amount         | 8.2% | 100%  | 100%  |
| copier_count_history     | 8.2% | 100%  | 100%  |
| interested_count         | 8.2% | 100%  | 100%  |
| last_trade_time          | 8.2% | 100%  | 100%  |
| loss_trades              | 3.6% | 43.7% | 43.7% |
| max_hold_time_hours      | 7.4% | 99.7% | 99.8% |
| profit_and_loss_ratio    | 7.3% | 98.5% | 99.3% |
| settled_days             | 8.2% | 100%  | 100%  |
| total_equity             | 7.9% | 96.6% | 96.6% |
| total_pnl                | 8.2% | 100%  | 100%  |
| total_roi                | 8.2% | 100%  | 100%  |
| total_win_rate           | 8.2% | 100%  | 100%  |
| trade_frequency_per_week | 8.2% | 100%  | 100%  |
| trader_type              | 0%   | 0.1%  | 0.1%  |

## okx_futures

Timeframes: 7, 30, 90 · rows: 348 / 348 / 364

**Typed columns** (fill % per timeframe)

| column     | 7d    | 30d   | 90d   |
| ---------- | ----- | ----- | ----- |
| roi        | 99.7% | 99.7% | 100%  |
| pnl        | 99.7% | 99.7% | 100%  |
| win_rate   | 100%  | 100%  | 100%  |
| copier_pnl | 100%  | 100%  | 95.6% |
| aum        | 0%    | 0%    | 71.7% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d   | 30d  | 90d   |
| ------------------- | ---- | ---- | ----- |
| avg_subpos_notional | 100% | 100% | 95.6% |
| invest_amt          | 100% | 100% | 95.6% |
| loss_days           | 100% | 100% | 95.6% |
| profit_days         | 100% | 100% | 95.6% |

## okx_spot

Timeframes: 7, 30, 90 · rows: 244 / 244 / 249

**Typed columns** (fill % per timeframe)

| column     | 7d   | 30d  | 90d   |
| ---------- | ---- | ---- | ----- |
| roi        | 100% | 100% | 100%  |
| pnl        | 100% | 100% | 100%  |
| win_rate   | 100% | 100% | 100%  |
| copier_pnl | 100% | 100% | 98%   |
| aum        | 0%   | 0%   | 76.7% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d   | 30d  | 90d |
| ------------------- | ---- | ---- | --- |
| avg_subpos_notional | 100% | 100% | 98% |
| invest_amt          | 100% | 100% | 98% |
| loss_days           | 100% | 100% | 98% |
| profit_days         | 100% | 100% | 98% |

## okx_web3_solana

Timeframes: 7, 30, 90 · rows: 18884 / 20503 / 21589

**Typed columns** (fill % per timeframe)

| column   | 7d   | 30d  | 90d  |
| -------- | ---- | ---- | ---- |
| roi      | 100% | 100% | 100% |
| pnl      | 100% | 100% | 100% |
| win_rate | 100% | 100% | 100% |
| volume   | 8.5% | 7.8% | 7.4% |

**Extras keys** (fill % per timeframe)

| extras key            | 7d   | 30d  | 90d  |
| --------------------- | ---- | ---- | ---- |
| avg_cost_buy          | 8.5% | 7.8% | 7.4% |
| favorite_mcap_type    | 8.5% | 7.8% | 7.4% |
| native_balance_amount | 8.5% | 7.8% | 7.4% |
| native_balance_usd    | 8.5% | 7.8% | 7.4% |
| top_tokens_total_pnl  | 8.5% | 7.8% | 7.4% |
| txs_buy               | 8.5% | 7.8% | 7.4% |
| txs_sell              | 8.5% | 7.8% | 7.4% |
| unrealized_pnl        | 8.5% | 7.8% | 7.4% |
| unrealized_pnl_roi    | 8.5% | 7.8% | 7.4% |
| volume_buy            | 8.5% | 7.8% | 7.4% |
| volume_sell           | 8.5% | 7.8% | 7.4% |

## phemex_futures

Timeframes: 30, 90 · rows: 463 / 462

**Typed columns** (fill % per timeframe)

| column            | 30d   | 90d   |
| ----------------- | ----- | ----- |
| roi               | 100%  | 100%  |
| pnl               | 100%  | 100%  |
| mdd               | 92%   | 92.2% |
| win_rate          | 100%  | 100%  |
| win_positions     | 89.4% | 89.6% |
| total_positions   | 89.4% | 89.6% |
| copier_pnl        | 89.4% | 89.6% |
| copier_count      | 91.6% | 91.8% |
| aum               | 92%   | 92.2% |
| volume            | 89.4% | 89.6% |
| profit_share_rate | 89.4% | 89.6% |

**Extras keys** (fill % per timeframe)

| extras key                  | 30d   | 90d   |
| --------------------------- | ----- | ----- |
| ai_trader                   | 3%    | 3%    |
| copier_total_realized_pnl   | 89.4% | 89.6% |
| follower_count              | 89.4% | 89.6% |
| lifetime_trades             | 66.7% | 66.9% |
| lifetime_win_rate           | 66.7% | 66.9% |
| max_copier_slots            | 89.4% | 89.6% |
| min_copy_amount             | 74.9% | 75.1% |
| position_hold_time_total_ns | 89.4% | 89.6% |
| profit_share_rate           | 73.4% | 73.6% |
| star_trader                 | 89.4% | 89.6% |
| total_balance               | 91.6% | 91.8% |
| total_pnl                   | 89.4% | 89.6% |
| total_roi                   | 89.4% | 89.6% |
| total_trade_volume          | 89.4% | 89.6% |

## toobit_futures

Timeframes: 7, 30, 90 · rows: 1609 / 1609 / 1609

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 98.2% | 99.2% | 87.1% |
| mdd               | 40.6% | 40.6% | 40.6% |
| win_rate          | 100%  | 100%  | 100%  |
| copier_count      | 99.7% | 99.6% | 98.5% |
| aum               | 100%  | 100%  | 100%  |
| profit_share_rate | 36%   | 36%   | 36%   |

**Extras keys** (fill % per timeframe)

| extras key                       | 7d    | 30d   | 90d   |
| -------------------------------- | ----- | ----- | ----- |
| bio                              | 21.4% | 21.4% | 21.4% |
| copier_count_history             | 96.5% | 98.6% | 81.7% |
| copier_limit                     | 40.6% | 40.6% | 40.6% |
| copier_total_profit              | 96.5% | 98.6% | 81.7% |
| is_full                          | 40.6% | 40.6% | 40.6% |
| last_week_win_rate               | 40.6% | 40.6% | 40.6% |
| lead_days                        | 40.6% | 40.6% | 40.6% |
| leaderMaximumDrawdownProportion  | 40.6% | 40.6% | 40.6% |
| leaderProfitOrderRatioProportion | 40.6% | 40.6% | 40.6% |
| leaderProfitRatioProportion      | 40.6% | 40.6% | 40.6% |
| max_copier_slots                 | 96.5% | 98.6% | 81.7% |
| profit_share_rate                | 96.5% | 98.6% | 81.7% |
| start_lead_time                  | 40.6% | 40.6% | 40.6% |
| total_copiers_history            | 40.6% | 40.6% | 40.6% |
| total_pnl                        | 24.1% | 24.1% | 24.1% |
| total_roi                        | 24.1% | 24.1% | 24.1% |
| trade_count_lifetime             | 99.7% | 99.6% | 98.5% |

## xt_futures

Timeframes: 7, 30, 90 · rows: 1893 / 1893 / 1893

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 99.3% | 99.3% | 99.3% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 19.3% | 19.3% | 19.4% |
| total_positions      | 19.3% | 19.3% | 19.4% |
| copier_pnl           | 19.3% | 19.3% | 19.4% |
| copier_count         | 99.4% | 99.4% | 99.4% |
| aum                  | 99.3% | 99.3% | 99.3% |
| holding_duration_avg | 2.6%  | 5.1%  | 6.6%  |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| avg_loss             | 19.3% | 19.3% | 19.4% |
| avg_profit           | 19.3% | 19.3% | 19.4% |
| copier_count_history | 19.7% | 19.7% | 19.7% |
| copier_growth        | 99.3% | 99.3% | 99.3% |
| copier_total_profit  | 99.3% | 99.3% | 99.3% |
| follower_margin      | 99.3% | 99.3% | 99.3% |
| intro                | 6.1%  | 6.1%  | 6.1%  |
| leading_days         | 24.8% | 24.8% | 24.8% |
| level_name           | 24.8% | 24.8% | 24.8% |
| loss_trades          | 19.3% | 19.3% | 19.4% |
| max_copier_slots     | 19.7% | 19.7% | 19.7% |
| platform_profit_rate | 24.8% | 24.8% | 24.8% |
| total_pnl            | 19.3% | 19.3% | 19.4% |
| trade_frequency      | 19.3% | 19.3% | 19.4% |
| trading_days         | 99.3% | 99.3% | 99.3% |

## xt_spot

Timeframes: 7, 30, 90 · rows: 55 / 17 / 30

**Typed columns** (fill % per timeframe)

| column       | 7d    | 30d   | 90d  |
| ------------ | ----- | ----- | ---- |
| roi          | 100%  | 100%  | 100% |
| pnl          | 100%  | 100%  | 100% |
| mdd          | 18.2% | 41.2% | 60%  |
| win_rate     | 100%  | 94.1% | 100% |
| copier_count | 14.5% | 0%    | 0%   |

**Extras keys** (fill % per timeframe)

| extras key      | 7d    | 30d | 90d |
| --------------- | ----- | --- | --- |
| follower_margin | 14.5% | 0%  | 0%  |
| trading_days    | 14.5% | 0%  | 0%  |

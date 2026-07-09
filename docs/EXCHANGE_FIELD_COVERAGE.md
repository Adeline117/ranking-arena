# Exchange Field Coverage Ledger

> **Machine-generated** from production `arena.trader_stats` by `scripts/ingest-field-coverage-ledger.mts`. Do NOT hand-edit. Generated: (run date not stamped).

Fill % = share of a source×timeframe's rows where the field is non-NULL. A typed column or extras key at a low/zero rate is either not exposed by that exchange or a promotion gap. A key that regresses to 0 is a silent field loss — see `scripts/openclaw/field-coverage-canary.mjs`.

**34 serving sources.**

## binance_futures

Timeframes: 7, 30, 90 · rows: 16540 / 14880 / 13777

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 2.2%  | 2.4%  | 2.6%  |
| mdd               | 14%   | 15.6% | 16.9% |
| win_rate          | 100%  | 100%  | 100%  |
| win_positions     | 14%   | 15.6% | 16.9% |
| total_positions   | 14%   | 13.4% | 16.9% |
| copier_pnl        | 70.9% | 77.9% | 80.4% |
| copier_count      | 12%   | 13.4% | 14.5% |
| aum               | 74.5% | 81.9% | 85%   |
| profit_share_rate | 12%   | 13.4% | 14.5% |

**Extras keys** (fill % per timeframe)

| extras key                | 7d   | 30d   | 90d   |
| ------------------------- | ---- | ----- | ----- |
| badge_name                | 1.3% | 1.5%  | 1.6%  |
| copier_count_max          | 12%  | 13.4% | 14.5% |
| copier_count_total        | 12%  | 13.4% | 14.5% |
| favorite_count            | 12%  | 13.4% | 14.5% |
| futures_type              | 12%  | 13.4% | 14.5% |
| last_trade_time           | 12%  | 13.4% | 14.5% |
| lead_start_time           | 12%  | 13.4% | 14.5% |
| margin_balance            | 12%  | 13.4% | 14.5% |
| min_copy_fixed_amount_usd | 12%  | 13.4% | 14.5% |
| min_copy_fixed_ratio_usd  | 12%  | 13.4% | 14.5% |

## binance_spot

Timeframes: 7, 30, 90 · rows: 2785 / 2742 / 2733

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 24.3% | 24.7% | 24.8% |
| mdd               | 63.7% | 64.7% | 64.9% |
| win_rate          | 63.7% | 64.7% | 64.9% |
| copier_pnl        | 63.7% | 64.7% | 64.9% |
| copier_count      | 62.1% | 63%   | 63.3% |
| aum               | 95.6% | 97.3% | 97.5% |
| profit_share_rate | 62.1% | 63%   | 63.3% |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d   | 90d   |
| ------------------------- | ----- | ----- | ----- |
| badge_name                | 0.3%  | 0.3%  | 0.3%  |
| copier_count_max          | 62.1% | 63%   | 63.3% |
| copier_count_total        | 62.1% | 63%   | 63.3% |
| days_trading              | 62.1% | 63%   | 63.3% |
| favorite_count            | 62.1% | 63%   | 63.3% |
| last_trade_time           | 55.9% | 56.8% | 57%   |
| lead_start_time           | 62.1% | 63%   | 63.3% |
| margin_balance            | 62.1% | 63%   | 63.3% |
| min_copy_fixed_amount_usd | 62.1% | 63%   | 63.3% |
| min_copy_fixed_ratio_usd  | 62.1% | 63%   | 63.3% |
| win_days                  | 63.7% | 64.7% | 64.9% |

## binance_web3_bsc

Timeframes: 7, 30, 90 · rows: 2331 / 2454 / 1961

**Typed columns** (fill % per timeframe)

| column   | 7d    | 30d   | 90d   |
| -------- | ----- | ----- | ----- |
| roi      | 100%  | 100%  | 100%  |
| pnl      | 100%  | 100%  | 100%  |
| win_rate | 100%  | 100%  | 100%  |
| aum      | 66.3% | 64.5% | 72.8% |
| volume   | 91.7% | 92.9% | 94.6% |

**Extras keys** (fill % per timeframe)

| extras key               | 7d    | 30d   | 90d   |
| ------------------------ | ----- | ----- | ----- |
| avg_buy                  | 91.4% | 92.9% | 94.5% |
| buy_txns                 | 89.9% | 92.1% | 92.9% |
| buy_volume               | 89.9% | 92.1% | 92.9% |
| last_trade_time          | 91.7% | 92.9% | 94.6% |
| onchain_buy_volume       | 0%    | 0%    | 97.1% |
| onchain_derivation       | 0%    | 0%    | 97.1% |
| onchain_enriched_at      | 0%    | 0%    | 97.1% |
| onchain_realized_partial | 0%    | 0%    | 1.7%  |
| onchain_realized_pnl     | 0%    | 0%    | 97.1% |
| onchain_sell_volume      | 0%    | 0%    | 97.1% |
| onchain_tokens_traded    | 0%    | 0%    | 97.1% |
| onchain_total_pnl        | 0%    | 0%    | 97.1% |
| onchain_txs_buy          | 0%    | 0%    | 97.1% |
| onchain_txs_sell         | 0%    | 0%    | 97.1% |
| onchain_unrealized_pnl   | 0%    | 0%    | 97.1% |
| onchain_win_rate         | 0%    | 0%    | 43.4% |
| sell_txns                | 89.9% | 92.1% | 92.9% |
| sell_volume              | 89.9% | 92.1% | 92.9% |
| total_traded_tokens      | 91.7% | 92.9% | 94.6% |
| total_txns               | 91.7% | 92.9% | 94.6% |

## bingx_futures

Timeframes: 7, 30, 90 · rows: 7649 / 7603 / 7591

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 100%  | 100%  | 100%  |
| pnl             | 100%  | 100%  | 100%  |
| sharpe          | 92.2% | 92.6% | 92.6% |
| mdd             | 96.2% | 96.2% | 96.2% |
| win_rate        | 100%  | 100%  | 100%  |
| win_positions   | 96%   | 95.9% | 95.8% |
| total_positions | 96%   | 95.9% | 95.8% |
| copier_pnl      | 44.3% | 44.4% | 44.5% |
| copier_count    | 96.2% | 96.2% | 96.2% |
| aum             | 96.2% | 96.2% | 96.2% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| avg_hold_time_hours  | 77.4% | 77.6% | 77.6% |
| avg_loss             | 96.2% | 96.2% | 96.2% |
| avg_profit           | 96.2% | 96.2% | 96.2% |
| copier_count_history | 77.5% | 77.7% | 77.7% |
| copier_earnings      | 77.5% | 77.7% | 77.7% |
| copier_growth_30d    | 77.5% | 77.7% | 77.7% |
| following_amount     | 11.2% | 11.3% | 11.3% |
| last_trade_time      | 96.2% | 96.2% | 96.2% |
| lifetime_trades      | 77.7% | 78%   | 77.9% |
| loss_trades          | 77.5% | 77.7% | 77.7% |
| max_copier_slots     | 77.5% | 77.7% | 77.7% |
| pnl_ratio            | 75.8% | 76%   | 75.9% |
| principal            | 52.6% | 52.5% | 52.4% |
| risk_rating          | 79.1% | 79.3% | 79.2% |
| total_earnings       | 77.5% | 77.7% | 77.7% |
| trader_tenure_days   | 77.5% | 77.7% | 77.7% |
| trades_per_week      | 96.2% | 96.2% | 96.2% |
| trading_days         | 96.2% | 96.2% | 96.2% |

## bitfinex

Timeframes: 7, 30 · rows: 420 / 399

**Typed columns** (fill % per timeframe)

| column | 7d    | 30d   |
| ------ | ----- | ----- |
| pnl    | 100%  | 100%  |
| volume | 38.1% | 45.9% |

## bitget_bots_futures

Timeframes: 0, 7, 30, 90 · rows: 402 / 398 / 497 / 398

**Typed columns** (fill % per timeframe)

| column       | 0d   | 7d   | 30d   | 90d  |
| ------------ | ---- | ---- | ----- | ---- |
| roi          | 100% | 100% | 100%  | 100% |
| pnl          | 100% | 100% | 100%  | 100% |
| mdd          | 0%   | 0%   | 57.5% | 0%   |
| copier_pnl   | 100% | 0%   | 0%    | 0%   |
| copier_count | 100% | 0%   | 0%    | 0%   |
| aum          | 100% | 0%   | 0%    | 0%   |

**Extras keys** (fill % per timeframe)

| extras key        | 0d    | 7d   | 30d   | 90d  |
| ----------------- | ----- | ---- | ----- | ---- |
| bot_strategy_id   | 100%  | 100% | 80.1% | 100% |
| created_at_origin | 100%  | 0%   | 0%    | 0%   |
| investment_amount | 100%  | 100% | 80.1% | 100% |
| leverage          | 97.3% | 100% | 80.1% | 100% |
| owner_name        | 100%  | 100% | 80.1% | 100% |
| runtime_days      | 100%  | 0%   | 0%    | 0%   |
| symbol            | 100%  | 100% | 80.1% | 100% |

## bitget_bots_spot

Timeframes: 0, 7, 30, 90 · rows: 391 / 380 / 631 / 380

**Typed columns** (fill % per timeframe)

| column       | 0d   | 7d   | 30d   | 90d  |
| ------------ | ---- | ---- | ----- | ---- |
| roi          | 100% | 100% | 100%  | 100% |
| pnl          | 100% | 100% | 100%  | 100% |
| mdd          | 0%   | 0%   | 51.2% | 0%   |
| copier_pnl   | 100% | 0%   | 0%    | 0%   |
| copier_count | 100% | 0%   | 0%    | 0%   |
| aum          | 100% | 0%   | 0%    | 0%   |

**Extras keys** (fill % per timeframe)

| extras key        | 0d    | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- | ----- |
| bot_strategy_id   | 100%  | 100%  | 60.2% | 100%  |
| created_at_origin | 100%  | 0%    | 0%    | 0%    |
| investment_amount | 100%  | 100%  | 60.2% | 100%  |
| leverage          | 52.7% | 55.5% | 33.4% | 55.5% |
| owner_name        | 100%  | 100%  | 60.2% | 100%  |
| runtime_days      | 100%  | 0%    | 0%    | 0%    |
| symbol            | 100%  | 100%  | 60.2% | 100%  |

## bitget_cfd

Timeframes: 7, 30, 90 · rows: 667 / 655 / 644

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d   | 90d   |
| -------------------- | ---- | ----- | ----- |
| roi                  | 100% | 100%  | 100%  |
| pnl                  | 10%  | 10.2% | 10.6% |
| mdd                  | 10%  | 9.8%  | 9.6%  |
| win_rate             | 100% | 100%  | 100%  |
| win_positions        | 5.8% | 6%    | 6.2%  |
| total_positions      | 5.8% | 6%    | 6.2%  |
| copier_pnl           | 10%  | 10.2% | 10.6% |
| copier_count         | 5.8% | 6%    | 6.2%  |
| aum                  | 10%  | 10.2% | 10.6% |
| profit_share_rate    | 10%  | 10.2% | 10.6% |
| holding_duration_avg | 5.8% | 6%    | 6.2%  |

**Extras keys** (fill % per timeframe)

| extras key                | 7d   | 30d   | 90d   |
| ------------------------- | ---- | ----- | ----- |
| copier_count_current      | 5.8% | 6%    | 6.2%  |
| copier_count_max          | 5.8% | 6%    | 6.2%  |
| largest_loss              | 5.8% | 6%    | 6.2%  |
| largest_profit            | 5.8% | 6%    | 6.2%  |
| long_short_ratio          | 0.1% | 0.3%  | 1.1%  |
| longest_holding_time_secs | 5.1% | 5.2%  | 5.3%  |
| loss_trades               | 8.7% | 8.9%  | 9%    |
| settled_in_days           | 5.8% | 6%    | 6.2%  |
| total_equity              | 1%   | 1.1%  | 1.1%  |
| trade_frequency           | 10%  | 10.2% | 10.6% |

## bitget_futures

Timeframes: 7, 30, 90 · rows: 5231 / 4940 / 4235

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 46.9% | 45.7% | 42.6% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 48.5% | 51.4% | 59.9% |
| total_positions      | 48.5% | 51.4% | 59.9% |
| copier_pnl           | 48.7% | 51.6% | 60.2% |
| copier_count         | 48.5% | 51.4% | 59.9% |
| aum                  | 48.5% | 51.4% | 59.9% |
| profit_share_rate    | 48.5% | 51.4% | 59.9% |
| holding_duration_avg | 36.3% | 38.4% | 44.8% |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d   | 90d   |
| ------------------------- | ----- | ----- | ----- |
| bitget_trader_type        | 12.5% | 13.2% | 15.4% |
| copier_count_current      | 48.5% | 51.4% | 59.9% |
| copier_count_max          | 48.5% | 51.4% | 59.9% |
| copier_pnl_30d            | 11%   | 11.6% | 13.6% |
| largest_loss              | 36.3% | 38.4% | 44.8% |
| largest_profit            | 36.3% | 38.4% | 44.8% |
| last_order_time           | 10.6% | 11.3% | 13.1% |
| long_short_ratio          | 7.6%  | 11.4% | 15.2% |
| longest_holding_time_secs | 32.7% | 34.7% | 40.4% |
| loss_trades               | 32.7% | 34.7% | 40.4% |
| settled_in_days           | 36.3% | 38.4% | 44.8% |
| total_equity              | 14.6% | 15.4% | 18%   |
| trade_frequency           | 36.3% | 38.4% | 44.8% |
| trading_days              | 12.2% | 12.9% | 15.1% |

## bitget_spot

Timeframes: 7, 30, 90 · rows: 5566 / 5566 / 5565

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 32.4% | 32.3% | 32.4% |
| mdd                  | 32.3% | 32.1% | 31.6% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 31.7% | 31.7% | 31.7% |
| total_positions      | 31.7% | 31.7% | 31.7% |
| copier_pnl           | 32.4% | 32.3% | 32.4% |
| copier_count         | 31.7% | 31.7% | 31.7% |
| aum                  | 32.4% | 32.3% | 32.4% |
| profit_share_rate    | 32.4% | 32.3% | 32.4% |
| holding_duration_avg | 31.7% | 31.7% | 31.7% |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d   | 90d   |
| ------------------------- | ----- | ----- | ----- |
| copier_count_current      | 31.7% | 31.7% | 31.7% |
| copier_count_max          | 31.7% | 31.7% | 31.7% |
| largest_loss              | 31.7% | 31.7% | 31.7% |
| largest_profit            | 31.7% | 31.7% | 31.7% |
| long_short_ratio          | 1.2%  | 1.8%  | 3.4%  |
| longest_holding_time_secs | 31.7% | 31.7% | 31.7% |
| loss_trades               | 32.3% | 32.3% | 32.3% |
| settled_in_days           | 31.7% | 31.7% | 31.7% |
| total_equity              | 18.1% | 18.1% | 18.1% |
| trade_frequency           | 32.4% | 32.3% | 32.4% |

## bitmart_futures

Timeframes: 7, 30, 90 · rows: 191 / 186 / 144

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 88.5% | 88.2% | 84.7% |
| pnl                  | 88.5% | 88.2% | 84.7% |
| mdd                  | 83.8% | 86%   | 84.7% |
| win_rate             | 88.5% | 88.2% | 84.7% |
| copier_pnl           | 63.9% | 65.6% | 84.7% |
| copier_count         | 88.5% | 90.9% | 100%  |
| aum                  | 83.8% | 86%   | 84.7% |
| profit_share_rate    | 69.6% | 71.5% | 92.4% |
| holding_duration_avg | 63.9% | 65.6% | 84.7% |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   | 90d   |
| ----------------------- | ----- | ----- | ----- |
| bio                     | 31.9% | 32.8% | 42.4% |
| last_traded_at          | 58.1% | 59.7% | 77.1% |
| leverage_limit          | 2.6%  | 2.7%  | 3.5%  |
| master_since            | 69.6% | 71.5% | 92.4% |
| min_copy_amount         | 69.6% | 71.5% | 92.4% |
| nav                     | 77%   | 79%   | 84.7% |
| pnl_ratio               | 55.5% | 57%   | 0%    |
| profit_loss_ratio       | 63.9% | 65.6% | 84.7% |
| realized_profit_sharing | 63.9% | 65.6% | 84.7% |
| run_time_seconds        | 75.4% | 77.4% | 100%  |
| start_at                | 63.9% | 65.6% | 84.7% |
| top_volume_share        | 63.9% | 65.6% | 84.7% |
| total_equity            | 63.9% | 65.6% | 84.7% |
| trades_per_day          | 63.9% | 65.6% | 84.7% |
| unrealized_pnl          | 63.9% | 65.6% | 84.7% |

## bitunix_futures

Timeframes: 7, 30, 90 · rows: 4684 / 4686 / 4684

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 99.9% | 99.9% | 99.9% |
| pnl               | 99.9% | 99.9% | 99.9% |
| mdd               | 94.7% | 94.6% | 94.6% |
| win_rate          | 19.9% | 25.1% | 31.7% |
| win_positions     | 39.4% | 39.4% | 39.4% |
| total_positions   | 39.4% | 39.4% | 39.4% |
| copier_pnl        | 39.4% | 39.4% | 39.4% |
| copier_count      | 39.4% | 39.4% | 39.4% |
| aum               | 94.7% | 94.6% | 94.6% |
| profit_share_rate | 39.4% | 39.4% | 39.4% |

**Extras keys** (fill % per timeframe)

| extras key            | 7d    | 30d   | 90d   |
| --------------------- | ----- | ----- | ----- |
| bio                   | 23.2% | 23.2% | 23.2% |
| copier_limit          | 39.5% | 39.4% | 39.4% |
| lead_margin_balance   | 39.5% | 39.4% | 39.4% |
| loss_count            | 39.5% | 39.4% | 39.4% |
| min_invest            | 34.6% | 34.5% | 34.5% |
| private_mode          | 39.5% | 39.4% | 39.4% |
| sortino               | 0%    | 49.1% | 45.7% |
| total_copiers_history | 39.5% | 39.4% | 39.4% |
| trade_amount          | 39.5% | 39.4% | 39.4% |
| trade_days            | 39.5% | 39.4% | 39.4% |

## blofin_futures

Timeframes: 7, 30, 90 · rows: 1729 / 1729 / 1729

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 100%  | 100%  | 100%  |
| pnl             | 100%  | 100%  | 100%  |
| sharpe          | 100%  | 100%  | 99.9% |
| mdd             | 99.9% | 99.9% | 99.4% |
| win_rate        | 98%   | 98.1% | 98.1% |
| win_positions   | 98%   | 98.1% | 98.1% |
| total_positions | 98%   | 98.1% | 98.1% |
| copier_count    | 91.5% | 91.7% | 91.7% |
| aum             | 91.5% | 91.7% | 91.7% |
| volume          | 98%   | 98.1% | 98.1% |

**Extras keys** (fill % per timeframe)

| extras key     | 7d    | 30d   | 90d   |
| -------------- | ----- | ----- | ----- |
| annualized_roi | 98%   | 98.1% | 98.1% |
| calmar         | 97.7% | 93.9% | 87.9% |
| copier_pnl     | 98%   | 98.1% | 98.1% |
| down_risk      | 97.7% | 93.9% | 87.9% |
| sortino        | 97.7% | 93.9% | 87.9% |
| volatility     | 97.7% | 93.9% | 87.9% |

## blofin_spot

Timeframes: 7, 30, 90 · rows: 99 / 99 / 99

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 82.8% | 96%   | 100%  |
| pnl             | 82.8% | 96%   | 100%  |
| sharpe          | 82.8% | 94.9% | 100%  |
| mdd             | 82.8% | 96%   | 100%  |
| win_rate        | 34.3% | 34.3% | 34.3% |
| win_positions   | 100%  | 100%  | 100%  |
| total_positions | 100%  | 100%  | 100%  |
| copier_count    | 74.7% | 93.9% | 100%  |
| aum             | 74.7% | 93.9% | 100%  |
| volume          | 34.3% | 34.3% | 34.3% |

**Extras keys** (fill % per timeframe)

| extras key     | 7d    | 30d   | 90d   |
| -------------- | ----- | ----- | ----- |
| annualized_roi | 34.3% | 34.3% | 34.3% |
| calmar         | 34.3% | 31.3% | 26.3% |
| copier_pnl     | 34.3% | 34.3% | 34.3% |
| down_risk      | 34.3% | 31.3% | 26.3% |
| sortino        | 34.3% | 31.3% | 26.3% |
| volatility     | 34.3% | 31.3% | 26.3% |

## btcc_futures

Timeframes: 7, 30, 90 · rows: 819 / 1840 / 818

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 94.6% | 95.3% | 92.8% |
| win_rate             | 32.5% | 97.6% | 46.6% |
| win_positions        | 100%  | 44.5% | 100%  |
| total_positions      | 100%  | 44.5% | 100%  |
| copier_count         | 99.6% | 44.3% | 99.6% |
| aum                  | 100%  | 99.8% | 100%  |
| profit_share_rate    | 99.6% | 44.3% | 99.6% |
| holding_duration_avg | 100%  | 44.5% | 100%  |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   | 90d   |
| ----------------------- | ----- | ----- | ----- |
| bio                     | 90.6% | 40.3% | 90.7% |
| copier_limit            | 99.6% | 44.3% | 99.6% |
| cumulative_net_profit   | 100%  | 44.5% | 100%  |
| profit_loss_ratio_pct   | 100%  | 44.5% | 100%  |
| register_days           | 99.6% | 44.3% | 99.6% |
| supported_symbols_count | 99.6% | 44.3% | 99.6% |
| total_copiers_history   | 99.6% | 44.3% | 99.6% |
| total_roi               | 97.1% | 43.2% | 97.1% |
| total_win_amount        | 100%  | 44.5% | 100%  |
| trader_level            | 99.6% | 44.3% | 99.6% |

## bybit_copytrade

Timeframes: 7, 30, 90 · rows: 9763 / 9763 / 9725

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 18.2% | 18.2% | 18.3% |
| sharpe               | 43.5% | 55.5% | 80.4% |
| mdd                  | 89.5% | 89.5% | 89.9% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 18.2% | 18.2% | 18.3% |
| total_positions      | 18.2% | 18.2% | 18.3% |
| copier_pnl           | 18.2% | 18.2% | 18.3% |
| copier_count         | 88.3% | 88.3% | 88.6% |
| aum                  | 18.2% | 18.2% | 18.3% |
| profit_share_rate    | 18.2% | 18.2% | 18.3% |
| holding_duration_avg | 18.2% | 18.2% | 18.3% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| avg_pnl_per_trade    | 18.2% | 18.2% | 18.3% |
| bio                  | 9.4%  | 9.4%  | 9.4%  |
| copier_total_profit  | 87.9% | 87.9% | 88.2% |
| cum_follower_count   | 18.2% | 18.2% | 18.3% |
| last_traded_at       | 18.2% | 18.2% | 18.3% |
| leader_user_id       | 18.2% | 18.2% | 18.3% |
| lifetime_trades      | 15.5% | 15.6% | 15.6% |
| loss_trades          | 17.8% | 17.8% | 17.9% |
| max_copier_slots     | 87.9% | 87.9% | 88.2% |
| max_follower_count   | 18.2% | 18.2% | 18.3% |
| profit_to_loss_ratio | 35.9% | 52.4% | 79.5% |
| roe_volatility       | 18.2% | 18.2% | 18.3% |
| sortino              | 18.2% | 18.2% | 18.3% |
| stability_score      | 18.2% | 18.2% | 18.3% |
| total_pnl            | 15.5% | 15.6% | 15.6% |
| total_roi            | 15.5% | 15.6% | 15.6% |
| trading_days         | 18.2% | 18.2% | 18.3% |
| wallet_balance       | 17.8% | 17.8% | 17.9% |
| weekly_trades        | 18.2% | 18.2% | 18.3% |

## bybit_mt5

Timeframes: 7, 30, 90 · rows: 30367 / 30367 / 30372

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| roi                  | 100% | 100% | 100% |
| pnl                  | 100% | 100% | 100% |
| sharpe               | 100% | 100% | 100% |
| mdd                  | 100% | 100% | 100% |
| win_rate             | 100% | 100% | 100% |
| win_positions        | 5.4% | 5.4% | 5.4% |
| total_positions      | 5.4% | 5.4% | 5.4% |
| copier_pnl           | 5.4% | 5.4% | 5.4% |
| copier_count         | 5.4% | 5.4% | 5.4% |
| aum                  | 5.4% | 5.4% | 5.4% |
| profit_share_rate    | 5.4% | 5.4% | 5.4% |
| holding_duration_avg | 5.4% | 5.4% | 5.4% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| avg_pnl_per_trade    | 5.4% | 5.4% | 5.4% |
| copier_count_max     | 5.3% | 5.3% | 5.3% |
| loss_trades          | 5.3% | 5.3% | 5.3% |
| margin_level         | 5.3% | 5.3% | 5.3% |
| profit_to_loss_ratio | 5.4% | 5.4% | 5.4% |
| provider_user_id     | 5.4% | 5.4% | 5.4% |
| roe_volatility       | 5.4% | 5.4% | 5.4% |
| sortino              | 5.4% | 5.4% | 5.4% |
| total_assets         | 5.4% | 5.4% | 5.4% |
| trading_days         | 5.4% | 5.4% | 5.4% |
| weekly_trades        | 5.4% | 5.4% | 5.4% |

## gate_cfd

Timeframes: 7, 30, 90 · rows: 3661 / 3677 / 3607

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 23.9% | 24.3% | 25%   |
| mdd               | 47.9% | 48.2% | 46.9% |
| win_rate          | 100%  | 100%  | 100%  |
| win_positions     | 39.5% | 39.4% | 40.1% |
| total_positions   | 39.5% | 39.4% | 40.1% |
| copier_pnl        | 39.5% | 39.4% | 40.1% |
| copier_count      | 39.5% | 39.4% | 40.1% |
| aum               | 47.9% | 48.2% | 46.9% |
| profit_share_rate | 39.5% | 39.4% | 40.1% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| last_trade_at        | 31.5% | 31.4% | 32%   |
| leading_days         | 39.5% | 39.4% | 40.1% |
| net_asset_value      | 39.5% | 39.4% | 40.1% |
| pl_ratio             | 20.5% | 25.7% | 28.6% |
| settled_share_profit | 39.5% | 39.4% | 40.1% |
| trade_frequency      | 15.5% | 15.4% | 15.7% |
| trading_frequency    | 39.5% | 39.4% | 40.1% |
| unrealized_pnl       | 15.5% | 15.4% | 15.7% |

## gate_futures

Timeframes: 7, 30, 90 · rows: 3746 / 3196 / 2895

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 51%   | 54.1% | 47%   |
| mdd               | 78.3% | 82.3% | 84.3% |
| win_rate          | 96%   | 97.3% | 98.4% |
| win_positions     | 55.8% | 65.4% | 72.3% |
| total_positions   | 55.8% | 65.4% | 72.3% |
| copier_pnl        | 55.8% | 65.4% | 72.3% |
| copier_count      | 55.8% | 65.4% | 72.3% |
| aum               | 78.5% | 83.7% | 85.9% |
| volume            | 55.8% | 65.4% | 72.3% |
| profit_share_rate | 55.8% | 65.4% | 72.3% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| average_loss         | 55.8% | 65.4% | 72.3% |
| average_profit       | 55.8% | 65.4% | 72.3% |
| copier_count_current | 26.5% | 31.1% | 34.4% |
| copier_count_total   | 55.8% | 65.4% | 72.3% |
| copier_growth        | 26.5% | 31.1% | 34.4% |
| last_liquidation_at  | 24.4% | 28.6% | 31.6% |
| last_trade_at        | 55.8% | 65.4% | 72.3% |
| lead_size            | 55.8% | 65.4% | 72.3% |
| leading_days         | 55.8% | 65.4% | 72.3% |
| pl_ratio             | 55.8% | 65.4% | 72.3% |
| roi_net_value        | 55.8% | 65.4% | 72.3% |
| trade_frequency      | 26.5% | 31.1% | 34.4% |
| trading_frequency    | 55.8% | 65.4% | 72.3% |

## gmx

Timeframes: 7, 30, 90 · rows: 177 / 170 / 171

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 85.3% | 90.6% | 100%  |
| pnl             | 100%  | 100%  | 100%  |
| sharpe          | 57.1% | 65.3% | 70.2% |
| mdd             | 58.2% | 65.3% | 70.2% |
| win_rate        | 54.8% | 70%   | 87.1% |
| win_positions   | 77.4% | 86.5% | 95.3% |
| total_positions | 77.4% | 86.5% | 95.3% |
| aum             | 84.2% | 90%   | 97.7% |
| volume          | 77.4% | 86.5% | 95.3% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| aum_basis            | 92.1% | 95.9% | 95.3% |
| closed_count         | 77.4% | 86.5% | 95.3% |
| pnl_basis            | 92.1% | 95.9% | 95.3% |
| realized_pnl_usd     | 77.4% | 86.5% | 95.3% |
| risk_derivation      | 58.2% | 65.3% | 70.2% |
| risk_derived_samples | 10.2% | 5.9%  | 1.8%  |
| risk_samples         | 58.2% | 65.3% | 70.2% |
| risk_self_derived    | 10.2% | 5.9%  | 1.8%  |
| sortino              | 68.4% | 71.2% | 68.4% |
| window_from          | 92.1% | 95.9% | 95.3% |

## gtrade

Timeframes: 7, 30, 90 · rows: 160 / 131 / 130

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| pnl             | 83.1% | 91.6% | 100%  |
| sharpe          | 2.5%  | 17.6% | 30.8% |
| win_rate        | 83.1% | 91.6% | 100%  |
| win_positions   | 61.9% | 89.3% | 98.5% |
| total_positions | 61.9% | 89.3% | 98.5% |

**Extras keys** (fill % per timeframe)

| extras key        | 7d   | 30d   | 90d   |
| ----------------- | ---- | ----- | ----- |
| lifetime_trades   | 80%  | 97.7% | 98.5% |
| lifetime_volume   | 80%  | 97.7% | 98.5% |
| lifetime_win_rate | 80%  | 97.7% | 98.5% |
| pnl_basis         | 80%  | 97.7% | 98.5% |
| risk_derivation   | 2.5% | 17.6% | 30.8% |
| risk_samples      | 2.5% | 17.6% | 30.8% |
| sortino           | 2.5% | 17.6% | 30.8% |
| thirty_day_volume | 80%  | 97.7% | 98.5% |
| trades_truncated  | 80%  | 97.7% | 98.5% |

## htx_futures

Timeframes: 7, 30, 90 · rows: 6 / 6 / 653

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d   |
| -------------------- | ---- | ---- | ----- |
| roi                  | 100% | 100% | 100%  |
| pnl                  | 100% | 100% | 100%  |
| mdd                  | 100% | 100% | 65.5% |
| win_rate             | 100% | 100% | 100%  |
| win_positions        | 100% | 100% | 92.5% |
| total_positions      | 100% | 100% | 92.5% |
| copier_pnl           | 100% | 100% | 92.5% |
| copier_count         | 100% | 100% | 92.5% |
| aum                  | 100% | 100% | 96.6% |
| profit_share_rate    | 100% | 100% | 92.5% |
| holding_duration_avg | 100% | 100% | 92.5% |

**Extras keys** (fill % per timeframe)

| extras key               | 7d   | 30d  | 90d   |
| ------------------------ | ---- | ---- | ----- |
| avg_loss                 | 100% | 100% | 92.5% |
| avg_profit               | 100% | 100% | 92.5% |
| copier_count_history     | 100% | 100% | 92.5% |
| introduction             | 100% | 100% | 63.9% |
| last_trade_time          | 100% | 100% | 90.4% |
| lead_since               | 100% | 100% | 92%   |
| max_copier_slots         | 100% | 100% | 92%   |
| profit_loss_ratio        | 100% | 100% | 92.5% |
| stats_scope              | 100% | 100% | 92.5% |
| trade_frequency_per_week | 100% | 100% | 92.5% |

## htx_spot

Timeframes: 7, 30, 90 · rows: 1 / 1 / 643

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d   |
| -------------------- | ---- | ---- | ----- |
| roi                  | 100% | 100% | 100%  |
| pnl                  | 100% | 100% | 100%  |
| mdd                  | 100% | 100% | 100%  |
| win_rate             | 100% | 100% | 100%  |
| win_positions        | 100% | 100% | 96.7% |
| total_positions      | 100% | 100% | 96.7% |
| copier_pnl           | 100% | 100% | 96.7% |
| copier_count         | 100% | 100% | 96.7% |
| aum                  | 100% | 100% | 100%  |
| profit_share_rate    | 100% | 100% | 96.7% |
| holding_duration_avg | 100% | 100% | 96.7% |

**Extras keys** (fill % per timeframe)

| extras key               | 7d   | 30d  | 90d   |
| ------------------------ | ---- | ---- | ----- |
| avg_loss                 | 100% | 100% | 96.7% |
| avg_profit               | 100% | 100% | 96.7% |
| copier_count_history     | 100% | 100% | 96.7% |
| introduction             | 0%   | 0%   | 42.5% |
| last_trade_time          | 0%   | 0%   | 4.5%  |
| lead_since               | 100% | 100% | 96.7% |
| max_copier_slots         | 100% | 100% | 96.7% |
| profit_loss_ratio        | 100% | 100% | 96.7% |
| stats_scope              | 100% | 100% | 96.7% |
| trade_frequency_per_week | 100% | 100% | 96.7% |

## hyperliquid

Timeframes: 7, 30, 90 · rows: 28158 / 23490 / 3412

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 99.7% | 77%   |
| pnl                  | 100%  | 100%  | 100%  |
| sharpe               | 11%   | 13.3% | 91.7% |
| mdd                  | 11.1% | 13.3% | 91.7% |
| win_rate             | 0.4%  | 2%    | 37.2% |
| win_positions        | 8.7%  | 10.6% | 76.6% |
| total_positions      | 8.7%  | 10.6% | 76.6% |
| aum                  | 70.5% | 88%   | 100%  |
| volume               | 12.1% | 14.5% | 0%    |
| holding_duration_avg | 0.4%  | 2%    | 37.2% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| derivation           | 0%    | 0%    | 100%  |
| fills_derivation     | 8.7%  | 10.6% | 76.6% |
| pnl_ratio            | 0.1%  | 1.1%  | 25.4% |
| risk_derivation      | 11.1% | 13.3% | 91.7% |
| risk_derived_samples | 0%    | 0%    | 0.1%  |
| risk_samples         | 11.1% | 13.3% | 91.7% |
| risk_self_derived    | 0%    | 0%    | 0.1%  |
| roi_basis            | 12.1% | 14.5% | 100%  |
| sortino              | 11.1% | 13.3% | 91.6% |
| trades_per_week      | 0.4%  | 2%    | 37.2% |

## kucoin_futures

Timeframes: 7, 30, 90 · rows: 4 / 1640 / 5

**Typed columns** (fill % per timeframe)

| column            | 7d   | 30d   | 90d  |
| ----------------- | ---- | ----- | ---- |
| roi               | 100% | 100%  | 100% |
| pnl               | 100% | 100%  | 100% |
| copier_pnl        | 100% | 69.1% | 100% |
| copier_count      | 100% | 75.2% | 100% |
| aum               | 100% | 78.4% | 100% |
| profit_share_rate | 100% | 69.1% | 100% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d   | 30d   | 90d  |
| ------------------- | ---- | ----- | ---- |
| copier_total_profit | 0%   | 51.3% | 0%   |
| exchange_uid        | 100% | 69.1% | 100% |
| follower_count      | 100% | 69.1% | 100% |
| introduction        | 100% | 67.8% | 100% |
| lead_days           | 100% | 69.1% | 100% |
| lead_principal      | 100% | 75.2% | 100% |
| leading_days        | 0%   | 51.3% | 0%   |
| max_copier_slots    | 100% | 75.2% | 100% |
| min_copy_amount     | 0%   | 51.3% | 0%   |
| total_pnl           | 0%   | 51.3% | 0%   |
| total_return_rate   | 100% | 69.1% | 100% |
| total_roi           | 0%   | 51.3% | 0%   |
| trade_frequency     | 100% | 51%   | 80%  |
| tradepilot          | 0%   | 0.2%  | 0%   |
| trading_frequency   | 100% | 51%   | 80%  |
| venue               | 100% | 69.1% | 100% |

## lbank_futures

Timeframes: 7, 30 · rows: 385 / 385

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   |
| ----------------- | ----- | ----- |
| roi               | 100%  | 100%  |
| pnl               | 100%  | 100%  |
| mdd               | 94.3% | 94.3% |
| win_rate          | 100%  | 100%  |
| total_positions   | 76.6% | 76.6% |
| copier_pnl        | 76.6% | 76.6% |
| copier_count      | 76.6% | 76.6% |
| aum               | 94.3% | 94.3% |
| profit_share_rate | 51.4% | 51.4% |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   |
| ----------------------- | ----- | ----- |
| closed_positions        | 76.6% | 76.6% |
| copier_count_history    | 50.6% | 50.6% |
| current_followers       | 76.6% | 76.6% |
| introduction            | 26.8% | 26.8% |
| leading_days            | 50.6% | 50.6% |
| lifetime_trades         | 51.4% | 51.4% |
| max_copier_slots        | 76.6% | 76.6% |
| open_positions          | 76.6% | 76.6% |
| profitable_copier_count | 76.6% | 76.6% |
| trader_level            | 76.6% | 76.6% |

## mexc_futures

Timeframes: 7, 30, 90 · rows: 16697 / 1415 / 1415

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 77.1% | 99.9% | 99.9% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 8.5%  | 99.8% | 99.6% |
| total_positions      | 8.5%  | 100%  | 100%  |
| copier_pnl           | 8.5%  | 100%  | 100%  |
| copier_count         | 8.5%  | 100%  | 100%  |
| aum                  | 77.1% | 100%  | 100%  |
| profit_share_rate    | 8.5%  | 100%  | 100%  |
| holding_duration_avg | 7.7%  | 99.7% | 99.9% |

**Extras keys** (fill % per timeframe)

| extras key               | 7d   | 30d   | 90d   |
| ------------------------ | ---- | ----- | ----- |
| ability_rating           | 8.5% | 100%  | 100%  |
| avg_order_amount         | 8.5% | 100%  | 100%  |
| copier_count_history     | 8.5% | 100%  | 100%  |
| interested_count         | 8.5% | 100%  | 100%  |
| last_trade_time          | 8.5% | 100%  | 100%  |
| loss_trades              | 5%   | 59.4% | 59.4% |
| max_hold_time_hours      | 7.7% | 99.7% | 99.9% |
| profit_and_loss_ratio    | 7.4% | 97.8% | 99.2% |
| settled_days             | 8.5% | 100%  | 100%  |
| total_equity             | 8.2% | 96.6% | 96.6% |
| total_pnl                | 8.5% | 100%  | 100%  |
| total_roi                | 8.5% | 100%  | 100%  |
| total_win_rate           | 8.5% | 100%  | 100%  |
| trade_frequency_per_week | 8.5% | 100%  | 100%  |
| trader_type              | 0%   | 0.1%  | 0.1%  |

## okx_futures

Timeframes: 7, 30, 90 · rows: 355 / 355 / 385

**Typed columns** (fill % per timeframe)

| column       | 7d   | 30d  | 90d   |
| ------------ | ---- | ---- | ----- |
| roi          | 100% | 100% | 100%  |
| pnl          | 100% | 100% | 100%  |
| win_rate     | 100% | 100% | 100%  |
| copier_pnl   | 100% | 100% | 92.2% |
| copier_count | 0%   | 0%   | 73.8% |
| aum          | 0%   | 0%   | 76.1% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d   | 30d  | 90d   |
| ------------------- | ---- | ---- | ----- |
| avg_subpos_notional | 100% | 100% | 92.2% |
| invest_amt          | 100% | 100% | 92.2% |
| loss_days           | 100% | 100% | 92.2% |
| profit_days         | 100% | 100% | 92.2% |

## okx_spot

Timeframes: 7, 30, 90 · rows: 248 / 248 / 265

**Typed columns** (fill % per timeframe)

| column       | 7d   | 30d  | 90d   |
| ------------ | ---- | ---- | ----- |
| roi          | 100% | 100% | 100%  |
| pnl          | 100% | 100% | 100%  |
| win_rate     | 100% | 100% | 100%  |
| copier_pnl   | 100% | 100% | 93.6% |
| copier_count | 0%   | 0%   | 78.5% |
| aum          | 0%   | 0%   | 79.2% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d   | 30d  | 90d   |
| ------------------- | ---- | ---- | ----- |
| avg_subpos_notional | 100% | 100% | 93.6% |
| invest_amt          | 100% | 100% | 93.6% |
| loss_days           | 100% | 100% | 93.6% |
| profit_days         | 100% | 100% | 93.6% |

## okx_web3_solana

Timeframes: 7, 30, 90 · rows: 26497 / 28173 / 30460

**Typed columns** (fill % per timeframe)

| column   | 7d   | 30d  | 90d  |
| -------- | ---- | ---- | ---- |
| roi      | 100% | 100% | 100% |
| pnl      | 100% | 100% | 100% |
| win_rate | 100% | 100% | 100% |
| volume   | 6.3% | 5.9% | 5.5% |

**Extras keys** (fill % per timeframe)

| extras key             | 7d   | 30d  | 90d   |
| ---------------------- | ---- | ---- | ----- |
| avg_cost_buy           | 6.3% | 5.9% | 5.5%  |
| favorite_mcap_type     | 6.3% | 5.9% | 5.5%  |
| native_balance_amount  | 6.3% | 5.9% | 5.5%  |
| native_balance_usd     | 6.3% | 5.9% | 5.5%  |
| onchain_buy_volume     | 0%   | 0%   | 12.5% |
| onchain_derivation     | 0%   | 0%   | 12.5% |
| onchain_enriched_at    | 0%   | 0%   | 12.5% |
| onchain_realized_pnl   | 0%   | 0%   | 12.5% |
| onchain_sell_volume    | 0%   | 0%   | 12.5% |
| onchain_tokens_traded  | 0%   | 0%   | 12.5% |
| onchain_total_pnl      | 0%   | 0%   | 12.5% |
| onchain_txs_buy        | 0%   | 0%   | 12.5% |
| onchain_txs_sell       | 0%   | 0%   | 12.5% |
| onchain_unrealized_pnl | 0%   | 0%   | 12.5% |
| onchain_win_rate       | 0%   | 0%   | 0.3%  |
| top_tokens_total_pnl   | 6.3% | 5.9% | 5.5%  |
| txs_buy                | 6.3% | 5.9% | 5.5%  |
| txs_sell               | 6.3% | 5.9% | 5.5%  |
| unrealized_pnl         | 6.3% | 5.9% | 5.5%  |
| unrealized_pnl_roi     | 6.3% | 5.9% | 5.5%  |
| volume_buy             | 6.3% | 5.9% | 5.5%  |
| volume_sell            | 6.3% | 5.9% | 5.5%  |

## phemex_futures

Timeframes: 30, 90 · rows: 491 / 491

**Typed columns** (fill % per timeframe)

| column               | 30d   | 90d   |
| -------------------- | ----- | ----- |
| roi                  | 100%  | 100%  |
| pnl                  | 100%  | 100%  |
| mdd                  | 94.5% | 94.5% |
| win_rate             | 100%  | 100%  |
| win_positions        | 87%   | 87.6% |
| total_positions      | 87.6% | 87.6% |
| copier_pnl           | 87.6% | 87.6% |
| copier_count         | 94.3% | 94.3% |
| aum                  | 94.5% | 94.5% |
| volume               | 87.6% | 87.6% |
| profit_share_rate    | 87.6% | 87.6% |
| holding_duration_avg | 32.6% | 32.4% |

**Extras keys** (fill % per timeframe)

| extras key                  | 30d   | 90d   |
| --------------------------- | ----- | ----- |
| ai_trader                   | 2.9%  | 2.9%  |
| copier_total_realized_pnl   | 87.6% | 87.6% |
| follower_count              | 87.6% | 87.6% |
| lifetime_trades             | 71.9% | 71.9% |
| lifetime_win_rate           | 71.9% | 71.9% |
| max_copier_slots            | 87.6% | 87.6% |
| min_copy_amount             | 83.5% | 83.5% |
| position_hold_time_total_ns | 87.6% | 87.6% |
| profit_share_rate           | 76%   | 76%   |
| star_trader                 | 87.6% | 87.6% |
| total_balance               | 94.3% | 94.3% |
| total_pnl                   | 87.6% | 87.6% |
| total_roi                   | 87.6% | 87.6% |
| total_trade_volume          | 87.6% | 87.6% |

## toobit_futures

Timeframes: 7, 30, 90 · rows: 1635 / 1635 / 1636

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 91%   | 91.9% | 92.6% |
| mdd               | 62.6% | 62.5% | 62.6% |
| win_rate          | 100%  | 100%  | 100%  |
| copier_count      | 100%  | 100%  | 100%  |
| aum               | 100%  | 100%  | 100%  |
| profit_share_rate | 55.5% | 55.4% | 55.5% |

**Extras keys** (fill % per timeframe)

| extras key                       | 7d    | 30d   | 90d   |
| -------------------------------- | ----- | ----- | ----- |
| bio                              | 32.4% | 32.4% | 32.5% |
| copier_count_history             | 91%   | 91.9% | 92.5% |
| copier_limit                     | 62.6% | 62.6% | 62.7% |
| copier_total_profit              | 91%   | 91.9% | 92.5% |
| is_full                          | 62.6% | 62.6% | 62.7% |
| last_week_win_rate               | 62.6% | 62.6% | 62.7% |
| lead_days                        | 62.6% | 62.6% | 62.7% |
| leaderMaximumDrawdownProportion  | 62.6% | 62.6% | 62.7% |
| leaderProfitOrderRatioProportion | 62.6% | 62.6% | 62.7% |
| leaderProfitRatioProportion      | 62.6% | 62.6% | 62.7% |
| max_copier_slots                 | 91%   | 91.9% | 92.5% |
| profit_share_rate                | 91%   | 91.9% | 92.5% |
| start_lead_time                  | 62.6% | 62.6% | 62.7% |
| total_copiers_history            | 62.6% | 62.6% | 62.7% |
| total_pnl                        | 57.1% | 56.8% | 57.1% |
| total_roi                        | 57.1% | 56.8% | 57.1% |
| trade_count_lifetime             | 100%  | 100%  | 100%  |

## xt_futures

Timeframes: 7, 30, 90 · rows: 1899 / 1899 / 1899

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 99.3% | 99.3% | 99.2% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 72.1% | 72.1% | 72.2% |
| total_positions      | 72.1% | 72.1% | 72.2% |
| copier_pnl           | 72.1% | 72.1% | 72.2% |
| copier_count         | 99.4% | 99.4% | 99.4% |
| aum                  | 99.3% | 99.3% | 99.3% |
| holding_duration_avg | 3.7%  | 6.8%  | 9.9%  |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| avg_loss             | 72.1% | 72.1% | 72.2% |
| avg_profit           | 72.1% | 72.1% | 72.2% |
| copier_count_history | 72.2% | 72.2% | 72.3% |
| copier_growth        | 94.9% | 94.9% | 94.8% |
| copier_total_profit  | 94.9% | 94.9% | 94.8% |
| follower_margin      | 94.9% | 94.9% | 94.8% |
| intro                | 13.4% | 13.4% | 13.4% |
| leading_days         | 75.4% | 75.4% | 75.4% |
| level_name           | 75.4% | 75.4% | 75.4% |
| loss_trades          | 72.1% | 72.1% | 72.2% |
| max_copier_slots     | 72.2% | 72.2% | 72.3% |
| platform_profit_rate | 75.4% | 75.4% | 75.4% |
| sortino              | 0%    | 25%   | 21.9% |
| total_pnl            | 72.1% | 72.1% | 72.2% |
| trade_frequency      | 72.1% | 72.1% | 72.2% |
| trading_days         | 98.9% | 98.9% | 98.9% |

## xt_spot

Timeframes: 7, 30, 90 · rows: 62 / 53 / 36

**Typed columns** (fill % per timeframe)

| column       | 7d    | 30d   | 90d   |
| ------------ | ----- | ----- | ----- |
| roi          | 100%  | 100%  | 100%  |
| pnl          | 100%  | 100%  | 100%  |
| mdd          | 85.5% | 92.5% | 86.1% |
| win_rate     | 100%  | 98.1% | 100%  |
| copier_count | 85.5% | 92.5% | 83.3% |

**Extras keys** (fill % per timeframe)

| extras key      | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| follower_margin | 85.5% | 92.5% | 83.3% |
| sortino         | 0%    | 3.8%  | 0%    |
| trading_days    | 85.5% | 92.5% | 83.3% |

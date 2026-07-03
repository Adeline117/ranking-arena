# Exchange Field Coverage Ledger

> **Machine-generated** from production `arena.trader_stats` by `scripts/ingest-field-coverage-ledger.mts`. Do NOT hand-edit. Generated: (run date not stamped).

Fill % = share of a source×timeframe's rows where the field is non-NULL. A typed column or extras key at a low/zero rate is either not exposed by that exchange or a promotion gap. A key that regresses to 0 is a silent field loss — see `scripts/openclaw/field-coverage-canary.mjs`.

**34 serving sources.**

## binance_futures

Timeframes: 7, 30, 90 · rows: 15038 / 13513 / 12676

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| mdd               | 14.2% | 15.8% | 16.9% |
| win_rate          | 100%  | 100%  | 100%  |
| win_positions     | 14.2% | 15.8% | 16.9% |
| total_positions   | 14.2% | 13.7% | 16.9% |
| copier_pnl        | 14.2% | 15.8% | 16.9% |
| copier_count      | 12.3% | 13.7% | 14.6% |
| aum               | 72.3% | 80.4% | 84%   |
| profit_share_rate | 12.3% | 13.7% | 14.6% |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d   | 90d   |
| ------------------------- | ----- | ----- | ----- |
| badge_name                | 1.4%  | 1.6%  | 1.7%  |
| copier_count_max          | 12.3% | 13.7% | 14.6% |
| copier_count_total        | 12.3% | 13.7% | 14.6% |
| favorite_count            | 12.3% | 13.7% | 14.6% |
| futures_type              | 12.3% | 13.7% | 14.6% |
| last_trade_time           | 12.3% | 13.7% | 14.6% |
| lead_start_time           | 12.3% | 13.7% | 14.6% |
| margin_balance            | 12.3% | 13.7% | 14.6% |
| min_copy_fixed_amount_usd | 12.3% | 13.7% | 14.6% |
| min_copy_fixed_ratio_usd  | 12.3% | 13.7% | 14.6% |

## binance_spot

Timeframes: 7, 30, 90 · rows: 2725 / 2680 / 2676

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| mdd               | 61.5% | 62.5% | 62.6% |
| win_rate          | 61.5% | 62.5% | 62.6% |
| copier_pnl        | 61.5% | 62.5% | 62.6% |
| copier_count      | 59.9% | 60.9% | 61%   |
| aum               | 95.5% | 97.2% | 97.4% |
| profit_share_rate | 59.9% | 60.9% | 61%   |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d   | 90d   |
| ------------------------- | ----- | ----- | ----- |
| badge_name                | 0.3%  | 0.3%  | 0.3%  |
| copier_count_max          | 59.9% | 60.9% | 61%   |
| copier_count_total        | 59.9% | 60.9% | 61%   |
| days_trading              | 59.9% | 60.9% | 61%   |
| favorite_count            | 59.9% | 60.9% | 61%   |
| last_trade_time           | 53.6% | 54.5% | 54.6% |
| lead_start_time           | 59.9% | 60.9% | 61%   |
| margin_balance            | 59.9% | 60.9% | 61%   |
| min_copy_fixed_amount_usd | 59.9% | 60.9% | 61%   |
| min_copy_fixed_ratio_usd  | 59.9% | 60.9% | 61%   |
| win_days                  | 61.5% | 62.5% | 62.6% |

## binance_web3_bsc

Timeframes: 7, 30, 90 · rows: 1805 / 1855 / 1597

**Typed columns** (fill % per timeframe)

| column   | 7d    | 30d   | 90d   |
| -------- | ----- | ----- | ----- |
| roi      | 100%  | 100%  | 100%  |
| pnl      | 100%  | 100%  | 100%  |
| win_rate | 100%  | 100%  | 100%  |
| aum      | 85.6% | 85.3% | 89.4% |
| volume   | 88.5% | 90%   | 92.9% |

**Extras keys** (fill % per timeframe)

| extras key               | 7d    | 30d   | 90d   |
| ------------------------ | ----- | ----- | ----- |
| avg_buy                  | 88.2% | 90%   | 92.8% |
| buy_txns                 | 86.1% | 88.8% | 90.6% |
| buy_volume               | 86.1% | 88.8% | 90.6% |
| last_trade_time          | 88.5% | 90%   | 92.9% |
| onchain_buy_volume       | 0%    | 0%    | 100%  |
| onchain_derivation       | 0%    | 0%    | 100%  |
| onchain_enriched_at      | 0%    | 0%    | 100%  |
| onchain_realized_partial | 0%    | 0%    | 1.9%  |
| onchain_realized_pnl     | 0%    | 0%    | 100%  |
| onchain_sell_volume      | 0%    | 0%    | 100%  |
| onchain_tokens_traded    | 0%    | 0%    | 100%  |
| onchain_total_pnl        | 0%    | 0%    | 100%  |
| onchain_txs_buy          | 0%    | 0%    | 100%  |
| onchain_txs_sell         | 0%    | 0%    | 100%  |
| onchain_unrealized_pnl   | 0%    | 0%    | 100%  |
| onchain_win_rate         | 0%    | 0%    | 57.7% |
| sell_txns                | 86.1% | 88.8% | 90.6% |
| sell_volume              | 86.1% | 88.8% | 90.6% |
| total_traded_tokens      | 88.5% | 90%   | 92.9% |
| total_txns               | 88.5% | 90%   | 92.9% |

## bingx_futures

Timeframes: 7, 30, 90 · rows: 4455 / 4417 / 4402

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 100%  | 100%  | 100%  |
| pnl             | 100%  | 100%  | 100%  |
| sharpe          | 89.5% | 89.9% | 90%   |
| mdd             | 93.4% | 93.5% | 93.4% |
| win_rate        | 100%  | 100%  | 100%  |
| win_positions   | 93.1% | 92.9% | 92.8% |
| total_positions | 93.1% | 92.9% | 92.8% |
| copier_count    | 93.4% | 93.5% | 93.4% |
| aum             | 93.4% | 93.5% | 93.4% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| avg_hold_time_hours  | 61%   | 61.2% | 61.1% |
| avg_loss             | 93.4% | 93.5% | 93.4% |
| avg_profit           | 93.4% | 93.5% | 93.4% |
| copier_count_history | 61.1% | 61.4% | 61.2% |
| copier_earnings      | 61.1% | 61.4% | 61.2% |
| copier_growth_30d    | 61.1% | 61.4% | 61.2% |
| following_amount     | 9%    | 9.1%  | 9.1%  |
| last_trade_time      | 93.4% | 93.5% | 93.4% |
| lifetime_trades      | 61.4% | 61.7% | 61.4% |
| loss_trades          | 61.1% | 61.4% | 61.2% |
| max_copier_slots     | 61.1% | 61.4% | 61.2% |
| pnl_ratio            | 59.7% | 60%   | 59.7% |
| principal            | 40.2% | 40.3% | 39.9% |
| risk_rating          | 63.8% | 64.1% | 63.8% |
| total_earnings       | 61.1% | 61.4% | 61.2% |
| trader_tenure_days   | 61.1% | 61.4% | 61.2% |
| trades_per_week      | 93.4% | 93.5% | 93.4% |
| trading_days         | 93.4% | 93.5% | 93.4% |

## bitfinex

Timeframes: 7, 30 · rows: 415 / 387

**Typed columns** (fill % per timeframe)

| column | 7d    | 30d   |
| ------ | ----- | ----- |
| pnl    | 100%  | 100%  |
| volume | 35.4% | 46.3% |

## bitget_bots_futures

Timeframes: 0, 7, 30, 90 · rows: 401 / 397 / 471 / 397

**Typed columns** (fill % per timeframe)

| column       | 0d   | 7d   | 30d   | 90d  |
| ------------ | ---- | ---- | ----- | ---- |
| roi          | 100% | 100% | 100%  | 100% |
| pnl          | 100% | 100% | 100%  | 100% |
| mdd          | 0%   | 0%   | 53.5% | 0%   |
| copier_pnl   | 100% | 0%   | 0%    | 0%   |
| copier_count | 100% | 0%   | 0%    | 0%   |
| aum          | 100% | 0%   | 0%    | 0%   |

**Extras keys** (fill % per timeframe)

| extras key        | 0d    | 7d   | 30d   | 90d  |
| ----------------- | ----- | ---- | ----- | ---- |
| bot_strategy_id   | 100%  | 100% | 84.3% | 100% |
| created_at_origin | 100%  | 0%   | 0%    | 0%   |
| investment_amount | 100%  | 100% | 84.3% | 100% |
| leverage          | 97.3% | 100% | 84.3% | 100% |
| owner_name        | 100%  | 100% | 84.3% | 100% |
| runtime_days      | 100%  | 0%   | 0%    | 0%   |
| symbol            | 100%  | 100% | 84.3% | 100% |

## bitget_bots_spot

Timeframes: 0, 7, 30, 90 · rows: 389 / 378 / 553 / 378

**Typed columns** (fill % per timeframe)

| column       | 0d   | 7d   | 30d   | 90d  |
| ------------ | ---- | ---- | ----- | ---- |
| roi          | 100% | 100% | 100%  | 100% |
| pnl          | 100% | 100% | 100%  | 100% |
| mdd          | 0%   | 0%   | 40.5% | 0%   |
| copier_pnl   | 100% | 0%   | 0%    | 0%   |
| copier_count | 100% | 0%   | 0%    | 0%   |
| aum          | 100% | 0%   | 0%    | 0%   |

**Extras keys** (fill % per timeframe)

| extras key        | 0d    | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- | ----- |
| bot_strategy_id   | 100%  | 100%  | 68.4% | 100%  |
| created_at_origin | 100%  | 0%    | 0%    | 0%    |
| investment_amount | 100%  | 100%  | 68.4% | 100%  |
| leverage          | 52.4% | 55.3% | 37.8% | 55.3% |
| owner_name        | 100%  | 100%  | 68.4% | 100%  |
| runtime_days      | 100%  | 0%    | 0%    | 0%    |
| symbol            | 100%  | 100%  | 68.4% | 100%  |

## bitget_cfd

Timeframes: 7, 30, 90 · rows: 613 / 598 / 590

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 10.6% | 10.9% | 11.2% |
| mdd                  | 10.6% | 10.4% | 10.3% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 6.4%  | 6.5%  | 6.8%  |
| total_positions      | 6.4%  | 6.5%  | 6.8%  |
| copier_pnl           | 10.6% | 10.9% | 11.2% |
| copier_count         | 6.4%  | 6.5%  | 6.8%  |
| aum                  | 10.6% | 10.9% | 11.2% |
| profit_share_rate    | 10.6% | 10.9% | 11.2% |
| holding_duration_avg | 6.4%  | 6.5%  | 6.8%  |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d   | 90d   |
| ------------------------- | ----- | ----- | ----- |
| copier_count_current      | 6.4%  | 6.5%  | 6.8%  |
| copier_count_max          | 6.4%  | 6.5%  | 6.8%  |
| largest_loss              | 6.4%  | 6.5%  | 6.8%  |
| largest_profit            | 6.4%  | 6.5%  | 6.8%  |
| long_short_ratio          | 0.2%  | 0.3%  | 1.2%  |
| longest_holding_time_secs | 5.5%  | 5.7%  | 5.8%  |
| loss_trades               | 9.1%  | 9.4%  | 9.5%  |
| settled_in_days           | 6.4%  | 6.5%  | 6.8%  |
| total_equity              | 1.1%  | 1.2%  | 1.2%  |
| trade_frequency           | 10.6% | 10.9% | 11.2% |

## bitget_futures

Timeframes: 7, 30, 90 · rows: 4520 / 4121 / 3616

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 35.8% | 35.1% | 29%   |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 37.7% | 41.3% | 47%   |
| total_positions      | 37.7% | 41.3% | 47%   |
| copier_pnl           | 37.9% | 41.6% | 47.4% |
| copier_count         | 37.7% | 41.3% | 47%   |
| aum                  | 37.7% | 41.3% | 47%   |
| profit_share_rate    | 37.7% | 41.3% | 47%   |
| holding_duration_avg | 28.4% | 31.2% | 35.5% |

**Extras keys** (fill % per timeframe)

| extras key                | 7d    | 30d   | 90d   |
| ------------------------- | ----- | ----- | ----- |
| bitget_trader_type        | 9.5%  | 10.4% | 11.9% |
| copier_count_current      | 37.7% | 41.3% | 47%   |
| copier_count_max          | 37.7% | 41.3% | 47%   |
| copier_pnl_30d            | 7.6%  | 8.3%  | 9.5%  |
| largest_loss              | 28.4% | 31.2% | 35.5% |
| largest_profit            | 28.4% | 31.2% | 35.5% |
| last_order_time           | 9.2%  | 10.1% | 11.5% |
| long_short_ratio          | 3.8%  | 6%    | 7.7%  |
| longest_holding_time_secs | 23.5% | 25.8% | 29.4% |
| loss_trades               | 23.5% | 25.8% | 29.4% |
| settled_in_days           | 28.4% | 31.2% | 35.5% |
| total_equity              | 8.1%  | 8.8%  | 10.1% |
| trade_frequency           | 28.4% | 31.2% | 35.5% |
| trading_days              | 9.2%  | 10.1% | 11.5% |

## bitget_spot

Timeframes: 7, 30, 90 · rows: 5559 / 5559 / 5560

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| roi                  | 100% | 100% | 100% |
| pnl                  | 6.5% | 6.5% | 6.5% |
| mdd                  | 6.5% | 6.4% | 6.2% |
| win_rate             | 100% | 100% | 100% |
| win_positions        | 6.2% | 6.2% | 6.2% |
| total_positions      | 6.2% | 6.2% | 6.2% |
| copier_pnl           | 6.5% | 6.5% | 6.5% |
| copier_count         | 6.2% | 6.2% | 6.2% |
| aum                  | 6.5% | 6.5% | 6.5% |
| profit_share_rate    | 6.5% | 6.5% | 6.5% |
| holding_duration_avg | 6.2% | 6.2% | 6.2% |

**Extras keys** (fill % per timeframe)

| extras key                | 7d   | 30d  | 90d  |
| ------------------------- | ---- | ---- | ---- |
| copier_count_current      | 6.2% | 6.2% | 6.2% |
| copier_count_max          | 6.2% | 6.2% | 6.2% |
| largest_loss              | 6.2% | 6.2% | 6.2% |
| largest_profit            | 6.2% | 6.2% | 6.2% |
| long_short_ratio          | 0.3% | 0.5% | 0.9% |
| longest_holding_time_secs | 6.2% | 6.2% | 6.2% |
| loss_trades               | 6.5% | 6.5% | 6.5% |
| settled_in_days           | 6.2% | 6.2% | 6.2% |
| total_equity              | 2.2% | 2.2% | 2.2% |
| trade_frequency           | 6.5% | 6.5% | 6.5% |

## bitmart_futures

Timeframes: 7, 30, 90 · rows: 166 / 161 / 142

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 87.3% | 87%   | 85.2% |
| pnl                  | 87.3% | 87%   | 85.2% |
| mdd                  | 81.9% | 84.5% | 85.2% |
| win_rate             | 87.3% | 87%   | 85.2% |
| copier_pnl           | 72.9% | 75.2% | 85.2% |
| copier_count         | 87.3% | 90.1% | 100%  |
| aum                  | 81.9% | 84.5% | 85.2% |
| profit_share_rate    | 79.5% | 82%   | 93%   |
| holding_duration_avg | 72.9% | 75.2% | 85.2% |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   | 90d   |
| ----------------------- | ----- | ----- | ----- |
| bio                     | 36.7% | 37.9% | 43%   |
| last_traded_at          | 66.3% | 68.3% | 77.5% |
| leverage_limit          | 3%    | 3.1%  | 3.5%  |
| master_since            | 79.5% | 82%   | 93%   |
| min_copy_amount         | 79.5% | 82%   | 93%   |
| nav                     | 74.7% | 77%   | 85.2% |
| pnl_ratio               | 47.6% | 49.1% | 0%    |
| profit_loss_ratio       | 72.9% | 75.2% | 85.2% |
| realized_profit_sharing | 72.9% | 75.2% | 85.2% |
| run_time_seconds        | 85.5% | 88.2% | 100%  |
| start_at                | 72.9% | 75.2% | 85.2% |
| top_volume_share        | 72.9% | 75.2% | 85.2% |
| total_equity            | 72.9% | 75.2% | 85.2% |
| trades_per_day          | 72.9% | 75.2% | 85.2% |
| unrealized_pnl          | 72.9% | 75.2% | 85.2% |

## bitunix_futures

Timeframes: 7, 30, 90 · rows: 4532 / 4533 / 4531

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 99.9% | 99.9% | 99.9% |
| pnl               | 99.9% | 99.9% | 99.9% |
| mdd               | 94.5% | 94.5% | 94.5% |
| win_rate          | 17.9% | 24.1% | 30.7% |
| win_positions     | 21%   | 21%   | 20.9% |
| total_positions   | 21%   | 21%   | 20.9% |
| copier_pnl        | 21%   | 21%   | 20.9% |
| copier_count      | 21%   | 21%   | 20.9% |
| aum               | 94.5% | 94.5% | 94.5% |
| profit_share_rate | 21%   | 21%   | 20.9% |

**Extras keys** (fill % per timeframe)

| extras key            | 7d    | 30d   | 90d   |
| --------------------- | ----- | ----- | ----- |
| bio                   | 13.1% | 13.1% | 13%   |
| copier_limit          | 21%   | 21%   | 20.9% |
| lead_margin_balance   | 21%   | 21%   | 20.9% |
| loss_count            | 21%   | 21%   | 20.9% |
| min_invest            | 20%   | 20%   | 20%   |
| private_mode          | 21%   | 21%   | 20.9% |
| sortino               | 0%    | 71%   | 66.2% |
| total_copiers_history | 21%   | 21%   | 20.9% |
| trade_amount          | 21%   | 21%   | 20.9% |
| trade_days            | 21%   | 21%   | 20.9% |

## blofin_futures

Timeframes: 7, 30, 90 · rows: 1714 / 1714 / 1714

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 100%  | 100%  | 100%  |
| pnl             | 100%  | 100%  | 100%  |
| sharpe          | 100%  | 100%  | 100%  |
| mdd             | 99.9% | 99.9% | 99.4% |
| win_rate        | 0%    | 0.1%  | 0%    |
| win_positions   | 0%    | 0.1%  | 0%    |
| total_positions | 0%    | 0.1%  | 0%    |
| copier_count    | 100%  | 100%  | 100%  |
| aum             | 100%  | 100%  | 100%  |
| volume          | 0%    | 0.1%  | 0%    |

**Extras keys** (fill % per timeframe)

| extras key     | 7d  | 30d  | 90d |
| -------------- | --- | ---- | --- |
| annualized_roi | 0%  | 0.1% | 0%  |
| calmar         | 0%  | 0.1% | 0%  |
| copier_pnl     | 0%  | 0.1% | 0%  |
| down_risk      | 0%  | 0.1% | 0%  |
| sortino        | 0%  | 0.1% | 0%  |
| volatility     | 0%  | 0.1% | 0%  |

## blofin_spot

Timeframes: 7, 30, 90 · rows: 74 / 93 / 99

**Typed columns** (fill % per timeframe)

| column       | 7d   | 30d  | 90d  |
| ------------ | ---- | ---- | ---- |
| roi          | 100% | 100% | 100% |
| pnl          | 100% | 100% | 100% |
| sharpe       | 100% | 100% | 100% |
| mdd          | 100% | 100% | 100% |
| copier_count | 100% | 100% | 100% |
| aum          | 100% | 100% | 100% |

**Extras keys** (fill % per timeframe)

| extras key | 7d  | 30d   | 90d   |
| ---------- | --- | ----- | ----- |
| sortino    | 0%  | 63.4% | 65.7% |
| volatility | 0%  | 9.7%  | 11.1% |

## btcc_futures

Timeframes: 7, 30, 90 · rows: 449 / 1835 / 449

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 93.8% | 94.6% | 91.5% |
| win_rate             | 59.2% | 99.9% | 74.4% |
| win_positions        | 100%  | 24.4% | 100%  |
| total_positions      | 100%  | 24.4% | 100%  |
| copier_count         | 99.3% | 24.3% | 99.3% |
| aum                  | 100%  | 99.1% | 100%  |
| profit_share_rate    | 99.3% | 24.3% | 99.3% |
| holding_duration_avg | 100%  | 24.4% | 100%  |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   | 90d   |
| ----------------------- | ----- | ----- | ----- |
| bio                     | 94.4% | 23.1% | 94.4% |
| copier_limit            | 99.3% | 24.3% | 99.3% |
| cumulative_net_profit   | 100%  | 24.4% | 100%  |
| profit_loss_ratio_pct   | 100%  | 24.4% | 100%  |
| register_days           | 99.3% | 24.3% | 99.3% |
| supported_symbols_count | 99.3% | 24.3% | 99.3% |
| total_copiers_history   | 99.3% | 24.3% | 99.3% |
| total_roi               | 84.6% | 20.7% | 84.6% |
| total_win_amount        | 100%  | 24.4% | 100%  |
| trader_level            | 99.3% | 24.3% | 99.3% |

## bybit_copytrade

Timeframes: 7, 30, 90 · rows: 9563 / 9563 / 9525

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 9.2%  | 9.2%  | 9.3%  |
| sharpe               | 36.9% | 51.6% | 79.4% |
| mdd                  | 89.2% | 89.2% | 89.6% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 9.2%  | 9.2%  | 9.3%  |
| total_positions      | 9.2%  | 9.2%  | 9.3%  |
| copier_pnl           | 9.2%  | 9.2%  | 9.3%  |
| copier_count         | 87.9% | 87.9% | 88.3% |
| aum                  | 9.2%  | 9.2%  | 9.3%  |
| profit_share_rate    | 9.2%  | 9.2%  | 9.3%  |
| holding_duration_avg | 9.2%  | 9.2%  | 9.3%  |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| avg_pnl_per_trade    | 9.2%  | 9.2%  | 9.3%  |
| bio                  | 4.5%  | 4.5%  | 4.6%  |
| copier_total_profit  | 83.6% | 83.6% | 83.9% |
| cum_follower_count   | 9.2%  | 9.2%  | 9.3%  |
| last_traded_at       | 9.2%  | 9.2%  | 9.3%  |
| leader_user_id       | 9.2%  | 9.2%  | 9.3%  |
| lifetime_trades      | 5.4%  | 5.4%  | 5.5%  |
| loss_trades          | 8.6%  | 8.6%  | 8.7%  |
| max_copier_slots     | 83.6% | 83.6% | 83.9% |
| max_follower_count   | 9.2%  | 9.2%  | 9.3%  |
| profit_to_loss_ratio | 25.5% | 46.4% | 77.8% |
| roe_volatility       | 9.2%  | 9.2%  | 9.3%  |
| sortino              | 9.2%  | 9.2%  | 9.3%  |
| stability_score      | 9.2%  | 9.2%  | 9.3%  |
| total_pnl            | 5.4%  | 5.4%  | 5.5%  |
| total_roi            | 5.4%  | 5.4%  | 5.5%  |
| trading_days         | 9.2%  | 9.2%  | 9.3%  |
| wallet_balance       | 8.6%  | 8.6%  | 8.7%  |
| weekly_trades        | 9.2%  | 9.2%  | 9.3%  |

## bybit_mt5

Timeframes: 7, 30, 90 · rows: 30201 / 30205 / 30208

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| roi                  | 100% | 100% | 100% |
| pnl                  | 100% | 100% | 100% |
| sharpe               | 100% | 100% | 100% |
| mdd                  | 100% | 100% | 100% |
| win_rate             | 100% | 100% | 100% |
| win_positions        | 3.8% | 3.8% | 3.8% |
| total_positions      | 3.8% | 3.8% | 3.8% |
| copier_pnl           | 3.8% | 3.8% | 3.8% |
| copier_count         | 3.8% | 3.8% | 3.8% |
| aum                  | 3.8% | 3.8% | 3.8% |
| profit_share_rate    | 3.8% | 3.8% | 3.8% |
| holding_duration_avg | 3.8% | 3.8% | 3.8% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| avg_pnl_per_trade    | 3.8% | 3.8% | 3.8% |
| copier_count_max     | 3.7% | 3.7% | 3.7% |
| loss_trades          | 3.7% | 3.7% | 3.7% |
| margin_level         | 3.7% | 3.7% | 3.7% |
| profit_to_loss_ratio | 3.8% | 3.8% | 3.8% |
| provider_user_id     | 3.8% | 3.8% | 3.8% |
| roe_volatility       | 3.8% | 3.8% | 3.8% |
| sortino              | 3.8% | 3.8% | 3.8% |
| total_assets         | 3.8% | 3.8% | 3.8% |
| trading_days         | 3.8% | 3.8% | 3.8% |
| weekly_trades        | 3.8% | 3.8% | 3.8% |

## gate_cfd

Timeframes: 7, 30, 90 · rows: 3481 / 3489 / 3451

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 0.7%  | 0.7%  | 0.6%  |
| mdd               | 43.8% | 44.3% | 43.5% |
| win_rate          | 100%  | 100%  | 100%  |
| win_positions     | 39.2% | 39.2% | 39.6% |
| total_positions   | 39.2% | 39.2% | 39.6% |
| copier_pnl        | 39.2% | 39.2% | 39.6% |
| copier_count      | 39.2% | 39.2% | 39.6% |
| aum               | 43.8% | 44.3% | 43.5% |
| profit_share_rate | 39.2% | 39.2% | 39.6% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| last_trade_at        | 31.1% | 31%   | 31.3% |
| leading_days         | 39.2% | 39.2% | 39.6% |
| net_asset_value      | 39.2% | 39.2% | 39.6% |
| pl_ratio             | 19.5% | 25.2% | 27.9% |
| settled_share_profit | 39.2% | 39.2% | 39.6% |
| trade_frequency      | 12.5% | 12.4% | 12.6% |
| trading_frequency    | 39.2% | 39.2% | 39.6% |
| unrealized_pnl       | 12.5% | 12.4% | 12.6% |

## gate_futures

Timeframes: 7, 30, 90 · rows: 3513 / 2628 / 2457

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 1.7%  | 2.2%  | 2.4%  |
| mdd               | 73.6% | 75.2% | 78.6% |
| win_rate          | 98.1% | 98.1% | 99.2% |
| win_positions     | 46.2% | 61.7% | 66%   |
| total_positions   | 46.2% | 61.7% | 66%   |
| copier_pnl        | 46.2% | 61.7% | 66%   |
| copier_count      | 46.2% | 61.7% | 66%   |
| aum               | 73.8% | 77.3% | 80.5% |
| volume            | 46.2% | 61.7% | 66%   |
| profit_share_rate | 46.2% | 61.7% | 66%   |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| average_loss         | 46.2% | 61.7% | 66%   |
| average_profit       | 46.2% | 61.7% | 66%   |
| copier_count_current | 10.3% | 13.8% | 14.8% |
| copier_count_total   | 46.2% | 61.7% | 66%   |
| copier_growth        | 10.3% | 13.8% | 14.8% |
| last_liquidation_at  | 22.3% | 29.8% | 31.9% |
| last_trade_at        | 46.2% | 61.7% | 66%   |
| lead_size            | 46.2% | 61.7% | 66%   |
| leading_days         | 46.2% | 61.7% | 66%   |
| pl_ratio             | 46.2% | 61.7% | 66%   |
| roi_net_value        | 46.2% | 61.7% | 66%   |
| trade_frequency      | 10.3% | 13.8% | 14.8% |
| trading_frequency    | 46.2% | 61.7% | 66%   |

## gmx

Timeframes: 7, 30, 90 · rows: 168 / 164 / 166

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 84.5% | 91.5% | 100%  |
| pnl             | 100%  | 100%  | 100%  |
| sharpe          | 59.5% | 68.3% | 71.7% |
| mdd             | 60.7% | 68.3% | 71.7% |
| win_rate        | 48.2% | 69.5% | 87.3% |
| win_positions   | 81%   | 90.2% | 97.6% |
| total_positions | 81%   | 90.2% | 97.6% |
| aum             | 82.7% | 90.9% | 97.6% |
| volume          | 81%   | 90.2% | 97.6% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| aum_basis            | 96.4% | 98.8% | 97.6% |
| closed_count         | 81%   | 90.2% | 97.6% |
| pnl_basis            | 96.4% | 98.8% | 97.6% |
| realized_pnl_usd     | 81%   | 90.2% | 97.6% |
| risk_derivation      | 60.7% | 68.3% | 71.7% |
| risk_derived_samples | 10.7% | 4.9%  | 1.8%  |
| risk_samples         | 60.7% | 68.3% | 71.7% |
| risk_self_derived    | 10.7% | 4.9%  | 1.8%  |
| sortino              | 71.4% | 73.2% | 69.9% |
| window_from          | 96.4% | 98.8% | 97.6% |

## gtrade

Timeframes: 7, 30, 90 · rows: 142 / 125 / 124

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| pnl             | 81%   | 92%   | 100%  |
| sharpe          | 2.8%  | 18.4% | 30.6% |
| win_rate        | 81%   | 92%   | 100%  |
| win_positions   | 67.6% | 91.2% | 100%  |
| total_positions | 67.6% | 91.2% | 100%  |

**Extras keys** (fill % per timeframe)

| extras key        | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| lifetime_trades   | 87.3% | 99.2% | 100%  |
| lifetime_volume   | 87.3% | 99.2% | 100%  |
| lifetime_win_rate | 87.3% | 99.2% | 100%  |
| pnl_basis         | 87.3% | 99.2% | 100%  |
| risk_derivation   | 2.8%  | 18.4% | 30.6% |
| risk_samples      | 2.8%  | 18.4% | 30.6% |
| sortino           | 2.8%  | 18.4% | 30.6% |
| thirty_day_volume | 87.3% | 99.2% | 100%  |
| trades_truncated  | 87.3% | 99.2% | 100%  |

## htx_futures

Timeframes: 7, 30, 90 · rows: 4 / 4 / 628

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d   |
| -------------------- | ---- | ---- | ----- |
| roi                  | 100% | 100% | 100%  |
| pnl                  | 100% | 100% | 100%  |
| mdd                  | 100% | 100% | 65.3% |
| win_rate             | 100% | 100% | 100%  |
| win_positions        | 100% | 100% | 65.8% |
| total_positions      | 100% | 100% | 65.8% |
| copier_pnl           | 100% | 100% | 65.8% |
| copier_count         | 100% | 100% | 65.8% |
| aum                  | 100% | 100% | 96.2% |
| profit_share_rate    | 100% | 100% | 65.8% |
| holding_duration_avg | 100% | 100% | 65.8% |

**Extras keys** (fill % per timeframe)

| extras key               | 7d   | 30d  | 90d   |
| ------------------------ | ---- | ---- | ----- |
| avg_loss                 | 100% | 100% | 65.8% |
| avg_profit               | 100% | 100% | 65.8% |
| copier_count_history     | 100% | 100% | 65.8% |
| introduction             | 100% | 100% | 44.4% |
| last_trade_time          | 100% | 100% | 65.8% |
| lead_since               | 100% | 100% | 65.8% |
| max_copier_slots         | 100% | 100% | 65.8% |
| profit_loss_ratio        | 100% | 100% | 65.8% |
| stats_scope              | 100% | 100% | 65.8% |
| trade_frequency_per_week | 100% | 100% | 65.8% |

## htx_spot

Timeframes: 90 · rows: 626

**Typed columns** (fill % per timeframe)

| column               | 90d  |
| -------------------- | ---- |
| roi                  | 100% |
| pnl                  | 100% |
| mdd                  | 100% |
| win_rate             | 100% |
| win_positions        | 62%  |
| total_positions      | 62%  |
| copier_pnl           | 62%  |
| copier_count         | 62%  |
| aum                  | 100% |
| profit_share_rate    | 62%  |
| holding_duration_avg | 62%  |

**Extras keys** (fill % per timeframe)

| extras key               | 90d   |
| ------------------------ | ----- |
| avg_loss                 | 62%   |
| avg_profit               | 62%   |
| copier_count_history     | 62%   |
| introduction             | 25.1% |
| last_trade_time          | 3.2%  |
| lead_since               | 62%   |
| max_copier_slots         | 62%   |
| profit_loss_ratio        | 62%   |
| stats_scope              | 62%   |
| trade_frequency_per_week | 62%   |

## hyperliquid

Timeframes: 7, 30, 90 · rows: 27690 / 20919 / 1820

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 99.5% | 77.7% |
| pnl                  | 100%  | 100%  | 100%  |
| sharpe               | 4.1%  | 5.5%  | 62.9% |
| mdd                  | 4.1%  | 5.5%  | 63%   |
| win_rate             | 0.1%  | 0.6%  | 20.4% |
| win_positions        | 0.1%  | 0.6%  | 20.4% |
| total_positions      | 0.1%  | 0.6%  | 20.4% |
| aum                  | 64.8% | 63.9% | 100%  |
| volume               | 6.6%  | 8.7%  | 0%    |
| holding_duration_avg | 0.1%  | 0.6%  | 20.4% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d   | 30d  | 90d   |
| -------------------- | ---- | ---- | ----- |
| derivation           | 0%   | 0%   | 100%  |
| fills_derivation     | 0.1% | 0.6% | 20.4% |
| pnl_ratio            | 0%   | 0.3% | 11.5% |
| risk_derivation      | 4.1% | 5.5% | 63%   |
| risk_derived_samples | 0%   | 0%   | 0.1%  |
| risk_samples         | 4.1% | 5.5% | 63%   |
| risk_self_derived    | 0%   | 0%   | 0.1%  |
| roi_basis            | 6.6% | 8.7% | 100%  |
| sortino              | 4.1% | 5.5% | 62.9% |
| trades_per_week      | 0.1% | 0.6% | 20.4% |

## kucoin_futures

Timeframes: 7, 30, 90 · rows: 3 / 1549 / 4

**Typed columns** (fill % per timeframe)

| column            | 7d   | 30d   | 90d  |
| ----------------- | ---- | ----- | ---- |
| roi               | 100% | 100%  | 100% |
| pnl               | 100% | 100%  | 100% |
| copier_pnl        | 100% | 51.1% | 100% |
| copier_count      | 100% | 73.5% | 100% |
| aum               | 100% | 76.9% | 100% |
| profit_share_rate | 100% | 51.1% | 100% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d   | 30d   | 90d  |
| ------------------- | ---- | ----- | ---- |
| copier_total_profit | 0%   | 54.6% | 0%   |
| exchange_uid        | 100% | 51.1% | 100% |
| follower_count      | 100% | 51.1% | 100% |
| introduction        | 100% | 49.7% | 100% |
| lead_days           | 100% | 51.1% | 100% |
| lead_principal      | 100% | 73.5% | 100% |
| leading_days        | 0%   | 54.6% | 0%   |
| max_copier_slots    | 100% | 73.5% | 100% |
| min_copy_amount     | 0%   | 54.6% | 0%   |
| total_pnl           | 0%   | 54.6% | 0%   |
| total_return_rate   | 100% | 51.1% | 100% |
| total_roi           | 0%   | 54.6% | 0%   |
| trade_frequency     | 100% | 24.5% | 75%  |
| tradepilot          | 0%   | 0.3%  | 0%   |
| trading_frequency   | 100% | 24.5% | 75%  |
| venue               | 100% | 51.1% | 100% |

## lbank_futures

Timeframes: 7, 30 · rows: 332 / 332

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   |
| ----------------- | ----- | ----- |
| roi               | 100%  | 100%  |
| pnl               | 100%  | 100%  |
| mdd               | 91%   | 91%   |
| win_rate          | 100%  | 100%  |
| total_positions   | 88.3% | 88.3% |
| copier_pnl        | 88.3% | 88.3% |
| copier_count      | 88.3% | 88.3% |
| aum               | 91%   | 91%   |
| profit_share_rate | 58.4% | 58.4% |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   |
| ----------------------- | ----- | ----- |
| closed_positions        | 88.3% | 88.3% |
| copier_count_history    | 57.2% | 57.2% |
| current_followers       | 88.3% | 88.3% |
| introduction            | 30.7% | 30.7% |
| leading_days            | 57.2% | 57.2% |
| lifetime_trades         | 58.4% | 58.4% |
| max_copier_slots        | 88.3% | 88.3% |
| open_positions          | 88.3% | 88.3% |
| profitable_copier_count | 88.3% | 88.3% |
| trader_level            | 88.3% | 88.3% |

## mexc_futures

Timeframes: 7, 30, 90 · rows: 15551 / 1306 / 1306

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 69.2% | 99.9% | 99.9% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 8.4%  | 100%  | 100%  |
| total_positions      | 8.4%  | 100%  | 100%  |
| copier_pnl           | 8.4%  | 100%  | 100%  |
| copier_count         | 8.4%  | 100%  | 100%  |
| aum                  | 69.2% | 100%  | 100%  |
| profit_share_rate    | 8.4%  | 100%  | 100%  |
| holding_duration_avg | 7.6%  | 99.7% | 99.8% |

**Extras keys** (fill % per timeframe)

| extras key               | 7d   | 30d   | 90d   |
| ------------------------ | ---- | ----- | ----- |
| ability_rating           | 8.4% | 100%  | 100%  |
| avg_order_amount         | 8.4% | 100%  | 100%  |
| copier_count_history     | 8.4% | 100%  | 100%  |
| interested_count         | 8.4% | 100%  | 100%  |
| last_trade_time          | 8.4% | 100%  | 100%  |
| loss_trades              | 4.2% | 50.3% | 50.3% |
| max_hold_time_hours      | 7.6% | 99.7% | 99.8% |
| profit_and_loss_ratio    | 7.4% | 98%   | 99.3% |
| settled_days             | 8.4% | 100%  | 100%  |
| total_equity             | 8.1% | 96.7% | 96.7% |
| total_pnl                | 8.4% | 100%  | 100%  |
| total_roi                | 8.4% | 100%  | 100%  |
| total_win_rate           | 8.4% | 100%  | 100%  |
| trade_frequency_per_week | 8.4% | 100%  | 100%  |
| trader_type              | 0%   | 0.1%  | 0.1%  |

## okx_futures

Timeframes: 7, 30, 90 · rows: 350 / 350 / 369

**Typed columns** (fill % per timeframe)

| column     | 7d   | 30d  | 90d   |
| ---------- | ---- | ---- | ----- |
| roi        | 100% | 100% | 100%  |
| pnl        | 100% | 100% | 100%  |
| win_rate   | 100% | 100% | 100%  |
| copier_pnl | 100% | 100% | 94.9% |
| aum        | 0%   | 0%   | 75.3% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d   | 30d  | 90d   |
| ------------------- | ---- | ---- | ----- |
| avg_subpos_notional | 100% | 100% | 94.9% |
| invest_amt          | 100% | 100% | 94.9% |
| loss_days           | 100% | 100% | 94.9% |
| profit_days         | 100% | 100% | 94.9% |

## okx_spot

Timeframes: 7, 30, 90 · rows: 245 / 245 / 252

**Typed columns** (fill % per timeframe)

| column     | 7d   | 30d  | 90d   |
| ---------- | ---- | ---- | ----- |
| roi        | 100% | 100% | 100%  |
| pnl        | 100% | 100% | 100%  |
| win_rate   | 100% | 100% | 100%  |
| copier_pnl | 100% | 100% | 97.2% |
| aum        | 0%   | 0%   | 78.2% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d   | 30d  | 90d   |
| ------------------- | ---- | ---- | ----- |
| avg_subpos_notional | 100% | 100% | 97.2% |
| invest_amt          | 100% | 100% | 97.2% |
| loss_days           | 100% | 100% | 97.2% |
| profit_days         | 100% | 100% | 97.2% |

## okx_web3_solana

Timeframes: 7, 30, 90 · rows: 20176 / 21794 / 23558

**Typed columns** (fill % per timeframe)

| column   | 7d   | 30d  | 90d  |
| -------- | ---- | ---- | ---- |
| roi      | 100% | 100% | 100% |
| pnl      | 100% | 100% | 100% |
| win_rate | 100% | 100% | 100% |
| volume   | 8.2% | 7.6% | 7.1% |

**Extras keys** (fill % per timeframe)

| extras key             | 7d   | 30d  | 90d  |
| ---------------------- | ---- | ---- | ---- |
| avg_cost_buy           | 8.2% | 7.6% | 7.1% |
| favorite_mcap_type     | 8.2% | 7.6% | 7.1% |
| native_balance_amount  | 8.2% | 7.6% | 7.1% |
| native_balance_usd     | 8.2% | 7.6% | 7.1% |
| onchain_buy_volume     | 0%   | 0%   | 6.4% |
| onchain_derivation     | 0%   | 0%   | 6.4% |
| onchain_enriched_at    | 0%   | 0%   | 6.4% |
| onchain_realized_pnl   | 0%   | 0%   | 6.4% |
| onchain_sell_volume    | 0%   | 0%   | 6.4% |
| onchain_tokens_traded  | 0%   | 0%   | 6.4% |
| onchain_total_pnl      | 0%   | 0%   | 6.4% |
| onchain_txs_buy        | 0%   | 0%   | 6.4% |
| onchain_txs_sell       | 0%   | 0%   | 6.4% |
| onchain_unrealized_pnl | 0%   | 0%   | 6.4% |
| onchain_win_rate       | 0%   | 0%   | 0.2% |
| top_tokens_total_pnl   | 8.2% | 7.6% | 7.1% |
| txs_buy                | 8.2% | 7.6% | 7.1% |
| txs_sell               | 8.2% | 7.6% | 7.1% |
| unrealized_pnl         | 8.2% | 7.6% | 7.1% |
| unrealized_pnl_roi     | 8.2% | 7.6% | 7.1% |
| volume_buy             | 8.2% | 7.6% | 7.1% |
| volume_sell            | 8.2% | 7.6% | 7.1% |

## phemex_futures

Timeframes: 30, 90 · rows: 466 / 466

**Typed columns** (fill % per timeframe)

| column            | 30d   | 90d   |
| ----------------- | ----- | ----- |
| roi               | 100%  | 100%  |
| pnl               | 100%  | 100%  |
| mdd               | 92.5% | 92.5% |
| win_rate          | 100%  | 100%  |
| win_positions     | 90.1% | 90.1% |
| total_positions   | 90.1% | 90.1% |
| copier_pnl        | 90.1% | 90.1% |
| copier_count      | 92.1% | 92.1% |
| aum               | 92.5% | 92.5% |
| volume            | 90.1% | 90.1% |
| profit_share_rate | 90.1% | 90.1% |

**Extras keys** (fill % per timeframe)

| extras key                  | 30d   | 90d   |
| --------------------------- | ----- | ----- |
| ai_trader                   | 3%    | 3%    |
| copier_total_realized_pnl   | 90.1% | 90.1% |
| follower_count              | 90.1% | 90.1% |
| lifetime_trades             | 68.9% | 68.9% |
| lifetime_win_rate           | 68.9% | 68.9% |
| max_copier_slots            | 90.1% | 90.1% |
| min_copy_amount             | 77.5% | 77.5% |
| position_hold_time_total_ns | 90.1% | 90.1% |
| profit_share_rate           | 76%   | 76%   |
| star_trader                 | 90.1% | 90.1% |
| total_balance               | 92.1% | 92.1% |
| total_pnl                   | 90.1% | 90.1% |
| total_roi                   | 90.1% | 90.1% |
| total_trade_volume          | 90.1% | 90.1% |

## toobit_futures

Timeframes: 7, 30, 90 · rows: 1611 / 1611 / 1611

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 100%  | 100%  | 100%  |
| mdd               | 40.6% | 40.6% | 40.6% |
| win_rate          | 100%  | 100%  | 100%  |
| copier_count      | 99.6% | 99.5% | 99.8% |
| aum               | 100%  | 100%  | 100%  |
| profit_share_rate | 35.9% | 35.9% | 35.9% |

**Extras keys** (fill % per timeframe)

| extras key                       | 7d    | 30d   | 90d   |
| -------------------------------- | ----- | ----- | ----- |
| bio                              | 21.4% | 21.4% | 21.4% |
| copier_count_history             | 84.2% | 86.3% | 88.1% |
| copier_limit                     | 40.6% | 40.6% | 40.6% |
| copier_total_profit              | 84.2% | 86.3% | 88.1% |
| is_full                          | 40.6% | 40.6% | 40.6% |
| last_week_win_rate               | 40.6% | 40.6% | 40.6% |
| lead_days                        | 40.6% | 40.6% | 40.6% |
| leaderMaximumDrawdownProportion  | 40.6% | 40.6% | 40.6% |
| leaderProfitOrderRatioProportion | 40.6% | 40.6% | 40.6% |
| leaderProfitRatioProportion      | 40.6% | 40.6% | 40.6% |
| max_copier_slots                 | 84.2% | 86.3% | 88.1% |
| profit_share_rate                | 84.2% | 86.3% | 88.1% |
| start_lead_time                  | 40.6% | 40.6% | 40.6% |
| total_copiers_history            | 40.6% | 40.6% | 40.6% |
| total_pnl                        | 26.3% | 26.4% | 26.4% |
| total_roi                        | 26.3% | 26.4% | 26.4% |
| trade_count_lifetime             | 99.6% | 99.5% | 99.8% |

## xt_futures

Timeframes: 7, 30, 90 · rows: 1893 / 1893 / 1893

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 99.3% | 99.3% | 99.2% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 20.5% | 20.6% | 20.6% |
| total_positions      | 20.5% | 20.6% | 20.6% |
| copier_pnl           | 20.5% | 20.6% | 20.6% |
| copier_count         | 99.4% | 99.4% | 99.4% |
| aum                  | 99.3% | 99.3% | 99.3% |
| holding_duration_avg | 3.5%  | 5.9%  | 7.6%  |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| avg_loss             | 20.5% | 20.6% | 20.6% |
| avg_profit           | 20.5% | 20.6% | 20.6% |
| copier_count_history | 20.9% | 20.9% | 20.9% |
| copier_growth        | 98.6% | 98.6% | 98.6% |
| copier_total_profit  | 98.6% | 98.6% | 98.6% |
| follower_margin      | 98.6% | 98.6% | 98.6% |
| intro                | 6.2%  | 6.2%  | 6.2%  |
| leading_days         | 25.1% | 25.1% | 25.1% |
| level_name           | 25.1% | 25.1% | 25.1% |
| loss_trades          | 20.5% | 20.6% | 20.6% |
| max_copier_slots     | 20.9% | 20.9% | 20.9% |
| platform_profit_rate | 25.1% | 25.1% | 25.1% |
| sortino              | 0%    | 79.1% | 74.6% |
| total_pnl            | 20.5% | 20.6% | 20.6% |
| trade_frequency      | 20.5% | 20.6% | 20.6% |
| trading_days         | 99.3% | 99.3% | 99.3% |

## xt_spot

Timeframes: 7, 30, 90 · rows: 57 / 22 / 33

**Typed columns** (fill % per timeframe)

| column       | 7d    | 30d   | 90d   |
| ------------ | ----- | ----- | ----- |
| roi          | 100%  | 100%  | 100%  |
| pnl          | 100%  | 100%  | 100%  |
| mdd          | 68.4% | 72.7% | 75.8% |
| win_rate     | 100%  | 95.5% | 100%  |
| copier_count | 68.4% | 72.7% | 72.7% |

**Extras keys** (fill % per timeframe)

| extras key      | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| follower_margin | 68.4% | 72.7% | 72.7% |
| sortino         | 0%    | 9.1%  | 0%    |
| trading_days    | 68.4% | 72.7% | 72.7% |

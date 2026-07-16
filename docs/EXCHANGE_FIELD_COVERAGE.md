# Exchange Field Coverage Ledger

> **Machine-generated** from production `arena.trader_stats` by `scripts/ingest-field-coverage-ledger.mts`. Do NOT hand-edit.

| metadata              | value                                      |
| --------------------- | ------------------------------------------ |
| generated_at          | `2026-07-16T16:58:29.143Z`                 |
| git_sha               | `7811663eff4e237f39ff24af62ffc838f2f17319` |
| data_contract         | `arena.trader_stats.field-coverage`        |
| data_contract_version | `1`                                        |

The Git SHA identifies the clean generator revision used before this artifact was written.

Fill % = share of a source×timeframe's rows where the field is non-NULL. A typed column or extras key at a low/zero rate is either not exposed by that exchange or a promotion gap. A key that regresses to 0 is a silent field loss — see `scripts/openclaw/field-coverage-canary.mjs`.

**34 serving sources.**

## binance_futures

Timeframes: 7, 30, 90 · rows: 18660 / 17106 / 15452

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 9.5%  | 10.4% | 11.5% |
| mdd               | 25.6% | 27.9% | 30.9% |
| win_rate          | 100%  | 100%  | 100%  |
| win_positions     | 25.6% | 27.9% | 30.9% |
| total_positions   | 25.6% | 25.7% | 30.9% |
| copier_pnl        | 74.2% | 80.8% | 82.6% |
| copier_count      | 23.6% | 25.7% | 28.4% |
| aum               | 77.1% | 84%   | 86.3% |
| profit_share_rate | 23.6% | 25.7% | 28.4% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 0.3%  | 0.3%  | 0.3%  |
| badge_name                           | 2.2%  | 2.4%  | 2.6%  |
| copier_count_max                     | 23.6% | 25.7% | 28.4% |
| copier_count_total                   | 23.6% | 25.7% | 28.4% |
| favorite_count                       | 23.6% | 25.7% | 28.4% |
| futures_type                         | 23.6% | 25.7% | 28.4% |
| last_trade_time                      | 23.5% | 25.7% | 28.4% |
| lead_start_time                      | 23.6% | 25.7% | 28.4% |
| margin_balance                       | 23.6% | 25.7% | 28.4% |
| min_copy_fixed_amount_usd            | 23.6% | 25.7% | 28.4% |
| min_copy_fixed_ratio_usd             | 23.6% | 25.7% | 28.4% |

## binance_spot

Timeframes: 7, 30, 90 · rows: 2861 / 2817 / 2808

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 70.4% | 71.5% | 71.7% |
| mdd               | 93.5% | 94.9% | 95.3% |
| win_rate          | 93.5% | 94.9% | 95.3% |
| copier_pnl        | 93.5% | 94.9% | 95.3% |
| copier_count      | 91.6% | 93%   | 93.3% |
| aum               | 95.8% | 97.4% | 97.6% |
| profit_share_rate | 91.6% | 93%   | 93.3% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 1.4%  | 1.4%  | 1.4%  |
| badge_name                           | 0.3%  | 0.3%  | 0.3%  |
| copier_count_max                     | 91.6% | 93%   | 93.3% |
| copier_count_total                   | 91.6% | 93%   | 93.3% |
| days_trading                         | 91.6% | 93%   | 93.3% |
| favorite_count                       | 91.6% | 93%   | 93.3% |
| last_trade_time                      | 83.4% | 84.7% | 85%   |
| lead_start_time                      | 91.6% | 93%   | 93.3% |
| margin_balance                       | 91.6% | 93%   | 93.3% |
| min_copy_fixed_amount_usd            | 91.6% | 93%   | 93.3% |
| min_copy_fixed_ratio_usd             | 91.6% | 93%   | 93.3% |
| win_days                             | 93.5% | 94.9% | 95.3% |

## binance_web3_bsc

Timeframes: 7, 30, 90 · rows: 3087 / 2711 / 2117

**Typed columns** (fill % per timeframe)

| column   | 7d   | 30d   | 90d   |
| -------- | ---- | ----- | ----- |
| roi      | 100% | 100%  | 100%  |
| pnl      | 100% | 100%  | 100%  |
| win_rate | 100% | 100%  | 99.9% |
| aum      | 50%  | 58.4% | 67.4% |
| volume   | 94%  | 93.7% | 95.1% |

**Extras keys** (fill % per timeframe)

| extras key                    | 7d    | 30d   | 90d   |
| ----------------------------- | ----- | ----- | ----- |
| avg_buy                       | 93.7% | 93.7% | 95%   |
| buy_txns                      | 92.6% | 93%   | 93.5% |
| buy_volume                    | 92.6% | 93%   | 93.5% |
| last_trade_time               | 94%   | 93.7% | 95.1% |
| onchain_buy_volume            | 0%    | 0%    | 97.4% |
| onchain_derivation            | 0%    | 0%    | 97.4% |
| onchain_enriched_at           | 0%    | 0%    | 97.4% |
| onchain_realized_partial      | 0%    | 0%    | 2%    |
| onchain_realized_pnl          | 0%    | 0%    | 97.4% |
| onchain_sell_volume           | 0%    | 0%    | 97.4% |
| onchain_tokens_traded         | 0%    | 0%    | 97.4% |
| onchain_total_pnl             | 0%    | 0%    | 97.4% |
| onchain_txs_buy               | 0%    | 0%    | 97.4% |
| onchain_txs_sell              | 0%    | 0%    | 97.4% |
| onchain_unrealized_pnl        | 0%    | 0%    | 97.4% |
| onchain_win_rate              | 0%    | 0%    | 67.8% |
| sell_txns                     | 92.6% | 93%   | 93.5% |
| sell_volume                   | 92.6% | 93%   | 93.5% |
| token_distribution_unit       | 14.2% | 28.1% | 38.6% |
| top_earning_tokens_provenance | 14.2% | 28.1% | 38.6% |
| total_traded_tokens           | 94%   | 93.7% | 95.1% |
| total_txns                    | 94%   | 93.7% | 95.1% |

## bingx_futures

Timeframes: 7, 30, 90 · rows: 8411 / 8358 / 8346

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 100%  | 100%  | 100%  |
| pnl             | 100%  | 100%  | 100%  |
| sharpe          | 92.2% | 92.6% | 92.8% |
| mdd             | 96.5% | 96.6% | 96.6% |
| win_rate        | 100%  | 100%  | 100%  |
| win_positions   | 96.3% | 96.3% | 96.2% |
| total_positions | 96.3% | 96.3% | 96.2% |
| copier_pnl      | 49.4% | 49.6% | 49.7% |
| copier_count    | 96.5% | 96.6% | 96.6% |
| aum             | 96.5% | 96.6% | 96.6% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| avg_hold_time_hours  | 79.5% | 79.6% | 79.6% |
| avg_loss             | 96.5% | 96.6% | 96.6% |
| avg_profit           | 96.5% | 96.6% | 96.6% |
| copier_count_history | 79.6% | 79.8% | 79.8% |
| copier_earnings      | 79.6% | 79.8% | 79.8% |
| copier_growth_30d    | 79.6% | 79.8% | 79.8% |
| following_amount     | 12.2% | 12.2% | 12.2% |
| last_trade_time      | 96.5% | 96.6% | 96.6% |
| lifetime_trades      | 79.8% | 80%   | 79.9% |
| loss_trades          | 79.6% | 79.8% | 79.8% |
| max_copier_slots     | 79.6% | 79.8% | 79.8% |
| pnl_ratio            | 77.8% | 78%   | 77.9% |
| principal            | 56.1% | 56.1% | 55.9% |
| risk_rating          | 81%   | 81.2% | 81.2% |
| total_earnings       | 79.6% | 79.8% | 79.8% |
| trader_tenure_days   | 79.6% | 79.8% | 79.8% |
| trades_per_week      | 96.5% | 96.6% | 96.6% |
| trading_days         | 96.5% | 96.6% | 96.6% |

## bitfinex

Timeframes: 7, 30 · rows: 427 / 409

**Typed columns** (fill % per timeframe)

| column | 7d    | 30d   |
| ------ | ----- | ----- |
| pnl    | 100%  | 100%  |
| volume | 37.9% | 45.5% |

## bitget_bots_futures

Timeframes: 0, 7, 30, 90 · rows: 431 / 427 / 536 / 427

**Typed columns** (fill % per timeframe)

| column       | 0d   | 7d   | 30d   | 90d  |
| ------------ | ---- | ---- | ----- | ---- |
| roi          | 100% | 100% | 100%  | 100% |
| pnl          | 100% | 100% | 100%  | 100% |
| mdd          | 0%   | 0%   | 60.3% | 0%   |
| copier_pnl   | 100% | 0%   | 0%    | 0%   |
| copier_count | 100% | 0%   | 0%    | 0%   |
| aum          | 100% | 0%   | 0%    | 0%   |

**Extras keys** (fill % per timeframe)

| extras key                           | 0d    | 7d   | 30d   | 90d  |
| ------------------------------------ | ----- | ---- | ----- | ---- |
| \_arena_profile_publication_epoch_ms | 44.5% | 45%  | 35.8% | 45%  |
| bot_strategy_id                      | 100%  | 100% | 79.7% | 100% |
| created_at_origin                    | 100%  | 0%   | 0%    | 0%   |
| investment_amount                    | 100%  | 100% | 79.7% | 100% |
| leverage                             | 97.4% | 100% | 79.7% | 100% |
| owner_name                           | 100%  | 100% | 79.7% | 100% |
| runtime_days                         | 100%  | 0%   | 0%    | 0%   |
| symbol                               | 100%  | 100% | 79.7% | 100% |

## bitget_bots_spot

Timeframes: 0, 7, 30, 90 · rows: 472 / 460 / 713 / 460

**Typed columns** (fill % per timeframe)

| column       | 0d   | 7d   | 30d   | 90d  |
| ------------ | ---- | ---- | ----- | ---- |
| roi          | 100% | 100% | 100%  | 100% |
| pnl          | 100% | 100% | 100%  | 100% |
| mdd          | 0%   | 0%   | 55.8% | 0%   |
| copier_pnl   | 100% | 0%   | 0%    | 0%   |
| copier_count | 100% | 0%   | 0%    | 0%   |
| aum          | 100% | 0%   | 0%    | 0%   |

**Extras keys** (fill % per timeframe)

| extras key        | 0d    | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- | ----- |
| bot_strategy_id   | 100%  | 100%  | 64.5% | 100%  |
| created_at_origin | 100%  | 0%    | 0%    | 0%    |
| investment_amount | 100%  | 100%  | 64.5% | 100%  |
| leverage          | 56.1% | 58.7% | 37.9% | 58.7% |
| owner_name        | 100%  | 100%  | 64.5% | 100%  |
| runtime_days      | 100%  | 0%    | 0%    | 0%    |
| symbol            | 100%  | 100%  | 64.5% | 100%  |

## bitget_cfd

Timeframes: 7, 30, 90 · rows: 747 / 733 / 719

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| roi                  | 100% | 100% | 100% |
| pnl                  | 9.2% | 9.4% | 9.7% |
| mdd                  | 9.2% | 9.1% | 8.9% |
| win_rate             | 100% | 100% | 100% |
| win_positions        | 5.2% | 5.3% | 5.6% |
| total_positions      | 5.2% | 5.3% | 5.6% |
| copier_pnl           | 9.2% | 9.4% | 9.7% |
| copier_count         | 5.2% | 5.3% | 5.6% |
| aum                  | 9.2% | 9.4% | 9.7% |
| profit_share_rate    | 9.2% | 9.4% | 9.7% |
| holding_duration_avg | 5.2% | 5.3% | 5.6% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d   | 30d  | 90d  |
| ------------------------------------ | ---- | ---- | ---- |
| \_arena_profile_publication_epoch_ms | 1.2% | 1.2% | 1.3% |
| copier_count_current                 | 5.2% | 5.3% | 5.6% |
| copier_count_max                     | 5.2% | 5.3% | 5.6% |
| largest_loss                         | 5.2% | 5.3% | 5.6% |
| largest_profit                       | 5.2% | 5.3% | 5.6% |
| long_short_ratio                     | 0.1% | 0.3% | 1.1% |
| longest_holding_time_secs            | 4.6% | 4.6% | 4.7% |
| loss_trades                          | 8%   | 8.2% | 8.3% |
| settled_in_days                      | 5.2% | 5.3% | 5.6% |
| total_equity                         | 0.9% | 1%   | 1%   |
| trade_frequency                      | 9.2% | 9.4% | 9.7% |

## bitget_futures

Timeframes: 7, 30, 90 · rows: 5777 / 5581 / 5035

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 69.5% | 67.4% | 61.4% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 70.9% | 73.4% | 81.3% |
| total_positions      | 70.9% | 73.4% | 81.3% |
| copier_pnl           | 71.2% | 73.7% | 81.7% |
| copier_count         | 70.9% | 73.4% | 81.3% |
| aum                  | 70.9% | 73.4% | 81.3% |
| profit_share_rate    | 70.9% | 73.4% | 81.3% |
| holding_duration_avg | 52.9% | 54.8% | 60.7% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 1.4%  | 1.5%  | 1.6%  |
| bitget_trader_type                   | 18.3% | 18.9% | 21%   |
| copier_count_current                 | 70.9% | 73.4% | 81.3% |
| copier_count_max                     | 70.9% | 73.4% | 81.3% |
| copier_pnl_30d                       | 17%   | 17.6% | 19.5% |
| largest_loss                         | 52.9% | 54.8% | 60.7% |
| largest_profit                       | 52.9% | 54.8% | 60.7% |
| last_order_time                      | 14.1% | 14.6% | 16.1% |
| long_short_ratio                     | 12.6% | 17.6% | 24.4% |
| longest_holding_time_secs            | 50.3% | 52.1% | 57.7% |
| loss_trades                          | 50.3% | 52.1% | 57.7% |
| settled_in_days                      | 52.9% | 54.8% | 60.7% |
| total_equity                         | 27.9% | 28.9% | 32%   |
| trade_frequency                      | 52.9% | 54.8% | 60.7% |
| trading_days                         | 18%   | 18.6% | 20.6% |

## bitget_spot

Timeframes: 7, 30, 90 · rows: 5577 / 5577 / 5577

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 54%   | 54%   | 54%   |
| mdd                  | 53.9% | 53.7% | 53.2% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 53.3% | 53.3% | 53.3% |
| total_positions      | 53.3% | 53.3% | 53.3% |
| copier_pnl           | 54%   | 54%   | 54%   |
| copier_count         | 53.3% | 53.3% | 53.3% |
| aum                  | 54%   | 54%   | 54%   |
| profit_share_rate    | 54%   | 54%   | 54%   |
| holding_duration_avg | 53.3% | 53.3% | 53.3% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 1.1%  | 1.1%  | 1.1%  |
| copier_count_current                 | 53.3% | 53.3% | 53.3% |
| copier_count_max                     | 53.3% | 53.3% | 53.3% |
| largest_loss                         | 53.3% | 53.3% | 53.3% |
| largest_profit                       | 53.3% | 53.3% | 53.3% |
| long_short_ratio                     | 1.1%  | 1.8%  | 3.4%  |
| longest_holding_time_secs            | 53.3% | 53.3% | 53.3% |
| loss_trades                          | 53.9% | 53.9% | 53.9% |
| settled_in_days                      | 53.3% | 53.3% | 53.3% |
| total_equity                         | 39.6% | 39.6% | 39.6% |
| trade_frequency                      | 54%   | 54%   | 54%   |

## bitmart_futures

Timeframes: 7, 30, 90 · rows: 224 / 219 / 155

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 89.3% | 89%   | 84.5% |
| pnl                  | 89.3% | 89%   | 84.5% |
| mdd                  | 85.3% | 87.2% | 84.5% |
| win_rate             | 89.3% | 89%   | 84.5% |
| copier_pnl           | 58.5% | 59.8% | 84.5% |
| copier_count         | 90.6% | 92.7% | 100%  |
| aum                  | 85.3% | 87.2% | 84.5% |
| profit_share_rate    | 63.8% | 65.3% | 92.3% |
| holding_duration_avg | 58.5% | 59.8% | 84.5% |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   | 90d   |
| ----------------------- | ----- | ----- | ----- |
| bio                     | 29.9% | 30.6% | 43.2% |
| last_traded_at          | 53.6% | 54.8% | 77.4% |
| leverage_limit          | 3.1%  | 3.2%  | 4.5%  |
| master_since            | 63.8% | 65.3% | 92.3% |
| min_copy_amount         | 63.8% | 65.3% | 92.3% |
| nav                     | 79.9% | 81.7% | 84.5% |
| pnl_ratio               | 60.3% | 61.6% | 0%    |
| profit_loss_ratio       | 58.5% | 59.8% | 84.5% |
| realized_profit_sharing | 58.5% | 59.8% | 84.5% |
| run_time_seconds        | 69.2% | 70.8% | 100%  |
| start_at                | 58.5% | 59.8% | 84.5% |
| top_volume_share        | 58.5% | 59.8% | 84.5% |
| total_equity            | 58.5% | 59.8% | 84.5% |
| trades_per_day          | 58.5% | 59.8% | 84.5% |
| unrealized_pnl          | 58.5% | 59.8% | 84.5% |

## bitunix_futures

Timeframes: 7, 30, 90 · rows: 4848 / 4850 / 4848

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 99.8% | 99.9% | 99.8% |
| pnl               | 99.8% | 99.9% | 99.8% |
| mdd               | 94.8% | 94.8% | 94.8% |
| win_rate          | 20%   | 24.8% | 32.1% |
| win_positions     | 77.5% | 77.5% | 77.5% |
| total_positions   | 77.5% | 77.5% | 77.5% |
| copier_pnl        | 77.5% | 77.5% | 77.5% |
| copier_count      | 77.5% | 77.5% | 77.5% |
| aum               | 94.8% | 94.8% | 94.8% |
| profit_share_rate | 77.5% | 77.5% | 77.5% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 1.4%  | 1.4%  | 1.4%  |
| bio                                  | 44.9% | 44.8% | 44.8% |
| copier_limit                         | 77.5% | 77.5% | 77.5% |
| lead_margin_balance                  | 77.5% | 77.5% | 77.5% |
| loss_count                           | 77.5% | 77.5% | 77.5% |
| min_invest                           | 64.5% | 64.5% | 64.5% |
| private_mode                         | 77.5% | 77.5% | 77.5% |
| sortino                              | 0%    | 10.2% | 9.1%  |
| total_copiers_history                | 77.5% | 77.5% | 77.5% |
| trade_amount                         | 77.5% | 77.5% | 77.5% |
| trade_days                           | 77.5% | 77.5% | 77.5% |

## blofin_futures

Timeframes: 7, 30, 90 · rows: 1741 / 1741 / 1741

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 100%  | 100%  | 100%  |
| pnl             | 100%  | 100%  | 100%  |
| sharpe          | 99.9% | 99.9% | 99.9% |
| mdd             | 99.9% | 99.9% | 99.4% |
| win_rate        | 98%   | 98%   | 98%   |
| win_positions   | 98%   | 98%   | 98%   |
| total_positions | 98%   | 98%   | 98%   |
| copier_count    | 88.5% | 88.5% | 89.2% |
| aum             | 88.5% | 88.5% | 89.2% |
| volume          | 98%   | 98%   | 98%   |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 6.9%  | 6.9%  | 6.9%  |
| annualized_roi                       | 98%   | 98%   | 98%   |
| calmar                               | 97.7% | 94.1% | 87.8% |
| copier_pnl                           | 98%   | 98%   | 98%   |
| down_risk                            | 97.7% | 94.1% | 87.8% |
| sortino                              | 97.7% | 94.1% | 87.8% |
| volatility                           | 97.7% | 94.1% | 87.8% |

## blofin_spot

Timeframes: 7, 30, 90 · rows: 103 / 103 / 103

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 83.5% | 96.1% | 100%  |
| pnl             | 83.5% | 96.1% | 100%  |
| sharpe          | 83.5% | 95.1% | 100%  |
| mdd             | 83.5% | 96.1% | 100%  |
| win_rate        | 33%   | 33%   | 33%   |
| win_positions   | 96.1% | 96.1% | 96.1% |
| total_positions | 96.1% | 96.1% | 96.1% |
| copier_count    | 75.7% | 94.2% | 100%  |
| aum             | 75.7% | 94.2% | 100%  |
| volume          | 33%   | 33%   | 33%   |

**Extras keys** (fill % per timeframe)

| extras key     | 7d  | 30d   | 90d   |
| -------------- | --- | ----- | ----- |
| annualized_roi | 33% | 33%   | 33%   |
| calmar         | 33% | 30.1% | 26.2% |
| copier_pnl     | 33% | 33%   | 33%   |
| down_risk      | 33% | 30.1% | 26.2% |
| sortino        | 33% | 30.1% | 26.2% |
| volatility     | 33% | 30.1% | 26.2% |

## btcc_futures

Timeframes: 7, 30, 90 · rows: 1803 / 1846 / 1805

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 96%   | 95.5% | 94.8% |
| win_rate             | 22.7% | 95.4% | 32%   |
| win_positions        | 100%  | 97.7% | 100%  |
| total_positions      | 100%  | 97.7% | 100%  |
| copier_count         | 99.8% | 97.6% | 99.8% |
| aum                  | 100%  | 99.8% | 100%  |
| profit_share_rate    | 99.8% | 97.6% | 99.8% |
| holding_duration_avg | 100%  | 97.7% | 100%  |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 1.6%  | 1.5%  | 1.5%  |
| bio                                  | 85.5% | 83.6% | 85.5% |
| copier_limit                         | 99.8% | 97.6% | 99.8% |
| cumulative_net_profit                | 100%  | 97.7% | 100%  |
| profit_loss_ratio_pct                | 100%  | 97.7% | 100%  |
| register_days                        | 99.8% | 97.6% | 99.8% |
| supported_symbols_count              | 99.8% | 97.6% | 99.8% |
| total_copiers_history                | 99.8% | 97.6% | 99.8% |
| total_roi                            | 99.7% | 97.4% | 99.7% |
| total_win_amount                     | 100%  | 97.7% | 100%  |
| trader_level                         | 99.8% | 97.6% | 99.8% |

## bybit_copytrade

Timeframes: 7, 30, 90 · rows: 9996 / 9996 / 9959

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 42.2% | 42.2% | 42.4% |
| sharpe               | 58.2% | 65.8% | 81.4% |
| mdd                  | 89.9% | 89.9% | 90.2% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 42.2% | 42.2% | 42.4% |
| total_positions      | 42.2% | 42.2% | 42.4% |
| copier_pnl           | 42.2% | 42.2% | 42.4% |
| copier_count         | 88.7% | 88.7% | 89%   |
| aum                  | 42.2% | 42.2% | 42.4% |
| profit_share_rate    | 42.2% | 42.2% | 42.4% |
| holding_duration_avg | 42.2% | 42.2% | 42.4% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 0.7%  | 0.7%  | 0.7%  |
| avg_pnl_per_trade                    | 42.2% | 42.2% | 42.4% |
| bio                                  | 20.8% | 20.8% | 20.9% |
| copier_total_profit                  | 88.5% | 86%   | 86.4% |
| cum_follower_count                   | 42.2% | 42.2% | 42.4% |
| last_traded_at                       | 42.2% | 42.2% | 42.4% |
| leader_user_id                       | 42.2% | 42.2% | 42.4% |
| lifetime_trades                      | 40.6% | 40.6% | 40.8% |
| loss_trades                          | 42%   | 42%   | 42.2% |
| max_copier_slots                     | 88.5% | 86%   | 86.4% |
| max_follower_count                   | 42.2% | 42.2% | 42.4% |
| profit_to_loss_ratio                 | 55.1% | 64.8% | 82.2% |
| roe_volatility                       | 42.2% | 42.2% | 42.4% |
| sortino                              | 42.2% | 42.2% | 42.4% |
| stability_score                      | 42.2% | 42.2% | 42.4% |
| total_pnl                            | 40.6% | 40.6% | 40.8% |
| total_roi                            | 40.6% | 40.6% | 40.8% |
| trading_days                         | 42.2% | 42.2% | 42.4% |
| wallet_balance                       | 42%   | 42%   | 42.2% |
| weekly_trades                        | 42.2% | 42.2% | 42.4% |

## bybit_mt5

Timeframes: 7, 30, 90 · rows: 30601 / 30601 / 30601

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| sharpe               | 100%  | 100%  | 100%  |
| mdd                  | 100%  | 100%  | 100%  |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 13.4% | 13.4% | 13.4% |
| total_positions      | 13.4% | 13.4% | 13.4% |
| copier_pnl           | 13.4% | 13.4% | 13.4% |
| copier_count         | 13.4% | 13.4% | 13.4% |
| aum                  | 13.4% | 13.4% | 13.4% |
| profit_share_rate    | 13.4% | 13.4% | 13.4% |
| holding_duration_avg | 13.4% | 13.4% | 13.4% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 0.2%  | 0.2%  | 0.2%  |
| avg_pnl_per_trade                    | 13.4% | 13.4% | 13.4% |
| copier_count_max                     | 13.4% | 13.4% | 13.4% |
| loss_trades                          | 13.4% | 13.4% | 13.4% |
| margin_level                         | 13.4% | 13.4% | 13.4% |
| profit_to_loss_ratio                 | 13.4% | 13.4% | 13.4% |
| provider_user_id                     | 13.4% | 13.4% | 13.4% |
| roe_volatility                       | 13.4% | 13.4% | 13.4% |
| sortino                              | 13.4% | 13.4% | 13.4% |
| total_assets                         | 13.4% | 13.4% | 13.4% |
| trading_days                         | 13.4% | 13.4% | 13.4% |
| weekly_trades                        | 13.4% | 13.4% | 13.4% |

## gate_cfd

Timeframes: 7, 30, 90 · rows: 3848 / 3860 / 3792

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 30.4% | 30.7% | 31.5% |
| mdd               | 51.8% | 52.1% | 50.9% |
| win_rate          | 100%  | 100%  | 100%  |
| win_positions     | 40.9% | 40.8% | 41.5% |
| total_positions   | 40.9% | 40.8% | 41.5% |
| copier_pnl        | 40.9% | 40.8% | 41.5% |
| copier_count      | 40.9% | 40.8% | 41.5% |
| aum               | 51.8% | 52.1% | 50.9% |
| profit_share_rate | 40.9% | 40.8% | 41.5% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 1.2%  | 1.2%  | 1.2%  |
| last_trade_at                        | 33.3% | 33.2% | 33.8% |
| leading_days                         | 40.9% | 40.8% | 41.5% |
| net_asset_value                      | 40.9% | 40.8% | 41.5% |
| pl_ratio                             | 22%   | 27.3% | 30.4% |
| settled_share_profit                 | 40.9% | 40.8% | 41.5% |
| trade_frequency                      | 18.7% | 18.6% | 19%   |
| trading_frequency                    | 40.9% | 40.8% | 41.5% |
| unrealized_pnl                       | 18.7% | 18.6% | 19%   |

## gate_futures

Timeframes: 7, 30, 90 · rows: 4085 / 3681 / 3528

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 65.1% | 66.5% | 64.6% |
| mdd               | 82.2% | 86.4% | 88.5% |
| win_rate          | 92.7% | 95.5% | 97.8% |
| win_positions     | 74%   | 82.1% | 85.6% |
| total_positions   | 74%   | 82.1% | 85.6% |
| copier_pnl        | 74%   | 82.1% | 85.6% |
| copier_count      | 74%   | 82.1% | 85.6% |
| aum               | 82.4% | 87.8% | 90.1% |
| volume            | 74%   | 82.1% | 85.6% |
| profit_share_rate | 74%   | 82.1% | 85.6% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 1.6%  | 1.8%  | 1.9%  |
| average_loss                         | 74%   | 82.1% | 85.6% |
| average_profit                       | 74%   | 82.1% | 85.6% |
| copier_count_current                 | 52.2% | 57.9% | 60.4% |
| copier_count_total                   | 74%   | 82.1% | 85.6% |
| copier_growth                        | 52.2% | 57.9% | 60.4% |
| last_liquidation_at                  | 28.2% | 31.4% | 32.8% |
| last_trade_at                        | 74%   | 82.1% | 85.6% |
| lead_size                            | 74%   | 82.1% | 85.6% |
| leading_days                         | 74%   | 82.1% | 85.6% |
| pl_ratio                             | 74%   | 82.1% | 85.6% |
| roi_net_value                        | 74%   | 82.1% | 85.6% |
| trade_frequency                      | 52.2% | 57.9% | 60.4% |
| trading_frequency                    | 74%   | 82.1% | 85.6% |

## gmx

Timeframes: 7, 30, 90 · rows: 189 / 178 / 182

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| roi             | 81%   | 89.3% | 98.9% |
| pnl             | 100%  | 100%  | 100%  |
| sharpe          | 58.2% | 70.2% | 75.3% |
| mdd             | 58.2% | 70.8% | 75.3% |
| win_rate        | 45%   | 65.7% | 86.3% |
| win_positions   | 72.5% | 87.1% | 94.5% |
| total_positions | 72.5% | 87.1% | 94.5% |
| aum             | 80.4% | 88.8% | 96.7% |
| volume          | 72.5% | 87.1% | 94.5% |

**Extras keys** (fill % per timeframe)

| extras key           | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| aum_basis            | 92.1% | 97.8% | 95.6% |
| closed_count         | 72.5% | 87.1% | 94.5% |
| pnl_basis            | 92.1% | 97.8% | 95.6% |
| realized_pnl_usd     | 72.5% | 87.1% | 94.5% |
| risk_derivation      | 58.2% | 70.8% | 75.3% |
| risk_derived_samples | 15.3% | 7.9%  | 3.3%  |
| risk_samples         | 58.2% | 70.8% | 75.3% |
| risk_self_derived    | 15.3% | 7.9%  | 3.3%  |
| sortino              | 73.5% | 77.5% | 74.2% |
| window_from          | 92.1% | 97.8% | 95.6% |

## gtrade

Timeframes: 7, 30, 90 · rows: 177 / 145 / 143

**Typed columns** (fill % per timeframe)

| column          | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| pnl             | 89.3% | 95.9% | 100%  |
| sharpe          | 2.3%  | 25.5% | 38.5% |
| win_rate        | 80.8% | 91%   | 100%  |
| win_positions   | 70.1% | 94.5% | 100%  |
| total_positions | 70.1% | 94.5% | 100%  |

**Extras keys** (fill % per timeframe)

| extras key                       | 7d    | 30d   | 90d   |
| -------------------------------- | ----- | ----- | ----- |
| gtrade_trades_duplicate_rows     | 25.4% | 31%   | 31.5% |
| gtrade_trades_exhausted          | 25.4% | 31%   | 31.5% |
| gtrade_trades_fetch_reason       | 25.4% | 31%   | 31.5% |
| gtrade_trades_fetch_state        | 25.4% | 31%   | 31.5% |
| gtrade_trades_oldest_event       | 25.4% | 31%   | 31.5% |
| gtrade_trades_raw_pages          | 25.4% | 31%   | 31.5% |
| gtrade_trades_replay_stop_reason | 25.4% | 31%   | 31.5% |
| gtrade_trades_valid_pages        | 25.4% | 31%   | 31.5% |
| gtrade_trades_window_start       | 25.4% | 31%   | 31.5% |
| lifetime_trades                  | 80.8% | 98.6% | 100%  |
| lifetime_volume                  | 80.8% | 98.6% | 100%  |
| lifetime_win_rate                | 80.8% | 98.6% | 100%  |
| pnl_basis                        | 80.8% | 98.6% | 100%  |
| profile_window_metrics_complete  | 25.4% | 31%   | 31.5% |
| risk_derivation                  | 2.3%  | 25.5% | 38.5% |
| risk_samples                     | 2.3%  | 25.5% | 38.5% |
| sortino                          | 2.3%  | 25.5% | 38.5% |
| thirty_day_volume                | 80.8% | 98.6% | 100%  |
| trades_truncated                 | 55.4% | 67.6% | 68.5% |

## htx_futures

Timeframes: 7, 30, 90 · rows: 6 / 6 / 682

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d   |
| -------------------- | ---- | ---- | ----- |
| roi                  | 100% | 100% | 100%  |
| pnl                  | 100% | 100% | 100%  |
| mdd                  | 100% | 100% | 65.7% |
| win_rate             | 100% | 100% | 100%  |
| win_positions        | 100% | 100% | 91.5% |
| total_positions      | 100% | 100% | 91.5% |
| copier_pnl           | 100% | 100% | 91.5% |
| copier_count         | 100% | 100% | 91.5% |
| aum                  | 100% | 100% | 96.8% |
| profit_share_rate    | 100% | 100% | 91.5% |
| holding_duration_avg | 100% | 100% | 91.5% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d   | 30d  | 90d   |
| ------------------------------------ | ---- | ---- | ----- |
| \_arena_profile_publication_epoch_ms | 0%   | 0%   | 11.6% |
| avg_loss                             | 100% | 100% | 91.5% |
| avg_profit                           | 100% | 100% | 91.5% |
| copier_count_history                 | 100% | 100% | 91.5% |
| introduction                         | 100% | 100% | 62.9% |
| last_trade_time                      | 100% | 100% | 88.6% |
| lead_since                           | 100% | 100% | 91.1% |
| max_copier_slots                     | 100% | 100% | 91.1% |
| profit_loss_ratio                    | 100% | 100% | 91.5% |
| stats_scope                          | 100% | 100% | 91.5% |
| trade_frequency_per_week             | 100% | 100% | 91.5% |

## htx_spot

Timeframes: 7, 30, 90 · rows: 1 / 1 / 668

**Typed columns** (fill % per timeframe)

| column               | 7d   | 30d  | 90d  |
| -------------------- | ---- | ---- | ---- |
| roi                  | 100% | 100% | 100% |
| pnl                  | 100% | 100% | 100% |
| mdd                  | 100% | 100% | 100% |
| win_rate             | 100% | 100% | 100% |
| win_positions        | 100% | 100% | 96%  |
| total_positions      | 100% | 100% | 96%  |
| copier_pnl           | 100% | 100% | 96%  |
| copier_count         | 100% | 100% | 96%  |
| aum                  | 100% | 100% | 100% |
| profit_share_rate    | 100% | 100% | 96%  |
| holding_duration_avg | 100% | 100% | 96%  |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d   | 30d  | 90d   |
| ------------------------------------ | ---- | ---- | ----- |
| \_arena_profile_publication_epoch_ms | 0%   | 0%   | 13.8% |
| avg_loss                             | 100% | 100% | 96%   |
| avg_profit                           | 100% | 100% | 96%   |
| copier_count_history                 | 100% | 100% | 96%   |
| introduction                         | 0%   | 0%   | 42.4% |
| last_trade_time                      | 0%   | 0%   | 4.6%  |
| lead_since                           | 100% | 100% | 96%   |
| max_copier_slots                     | 100% | 100% | 96%   |
| profit_loss_ratio                    | 100% | 100% | 96%   |
| stats_scope                          | 100% | 100% | 96%   |
| trade_frequency_per_week             | 100% | 100% | 96%   |

## hyperliquid

Timeframes: 7, 30, 90 · rows: 30692 / 25952 / 8340

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 99.9% | 99.4% | 87.7% |
| pnl                  | 100%  | 100%  | 100%  |
| sharpe               | 26.3% | 31.4% | 98.1% |
| mdd                  | 26.6% | 31.6% | 98.2% |
| win_rate             | 2.5%  | 7.3%  | 49.4% |
| win_positions        | 23%   | 27.3% | 85.6% |
| total_positions      | 23%   | 27.3% | 85.6% |
| aum                  | 91.5% | 91.9% | 100%  |
| volume               | 27.2% | 32.1% | 0%    |
| holding_duration_avg | 2.5%  | 7.3%  | 49.4% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 0.8%  | 0.9%  | 2.8%  |
| derivation                           | 0%    | 0%    | 100%  |
| fills_boundary_skipped_positions     | 0.2%  | 0.2%  | 0.5%  |
| fills_covered_end_at                 | 0.1%  | 0.2%  | 0.5%  |
| fills_covered_start_at               | 0.1%  | 0.2%  | 0.5%  |
| fills_derivation                     | 23%   | 27.3% | 85.6% |
| fills_fetch_state                    | 5.9%  | 7%    | 21.8% |
| fills_fill_count                     | 0.2%  | 0.2%  | 0.7%  |
| fills_incomplete_reason              | 5.8%  | 6.9%  | 21.5% |
| fills_limit_hit                      | 0.2%  | 0.2%  | 0.7%  |
| fills_metrics_as_of                  | 0.2%  | 0.2%  | 0.3%  |
| fills_metrics_complete               | 5.9%  | 7%    | 21.8% |
| fills_page_count                     | 0.2%  | 0.2%  | 0.7%  |
| fills_request_count                  | 0.2%  | 0.2%  | 0.7%  |
| fills_requested_end_at               | 0.2%  | 0.2%  | 0.7%  |
| fills_requested_start_at             | 0.2%  | 0.2%  | 0.7%  |
| fills_schema_version                 | 0.2%  | 0.2%  | 0.7%  |
| pnl_ratio                            | 1.1%  | 4.7%  | 38.1% |
| risk_derivation                      | 26.7% | 31.6% | 98.2% |
| risk_derived_samples                 | 0.1%  | 0.1%  | 0.4%  |
| risk_samples                         | 26.7% | 31.6% | 98.2% |
| risk_self_derived                    | 0.1%  | 0.1%  | 0.4%  |
| roi_basis                            | 27.2% | 32.1% | 100%  |
| sortino                              | 26.6% | 31.4% | 97.8% |
| trades_per_week                      | 2.5%  | 7.3%  | 49.4% |

## kucoin_futures

Timeframes: 7, 30, 90 · rows: 4 / 1658 / 5

**Typed columns** (fill % per timeframe)

| column            | 7d   | 30d   | 90d  |
| ----------------- | ---- | ----- | ---- |
| roi               | 100% | 100%  | 100% |
| pnl               | 100% | 100%  | 100% |
| copier_pnl        | 100% | 70.7% | 100% |
| copier_count      | 100% | 75.8% | 100% |
| aum               | 100% | 78.8% | 100% |
| profit_share_rate | 100% | 70.7% | 100% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d   | 30d   | 90d  |
| ------------------------------------ | ---- | ----- | ---- |
| \_arena_profile_publication_epoch_ms | 0%   | 4.9%  | 0%   |
| copier_total_profit                  | 0%   | 49.2% | 0%   |
| exchange_uid                         | 100% | 70.7% | 100% |
| follower_count                       | 100% | 70.7% | 100% |
| introduction                         | 100% | 69.4% | 100% |
| lead_days                            | 100% | 70.7% | 100% |
| lead_principal                       | 100% | 75.8% | 100% |
| leading_days                         | 0%   | 49.2% | 0%   |
| max_copier_slots                     | 100% | 75.8% | 100% |
| min_copy_amount                      | 0%   | 49.2% | 0%   |
| total_pnl                            | 0%   | 49.2% | 0%   |
| total_return_rate                    | 100% | 70.7% | 100% |
| total_roi                            | 0%   | 49.2% | 0%   |
| trade_frequency                      | 100% | 53.2% | 80%  |
| tradepilot                           | 0%   | 0.2%  | 0%   |
| trading_frequency                    | 100% | 53.2% | 80%  |
| venue                                | 100% | 70.7% | 100% |

## lbank_futures

Timeframes: 7, 30 · rows: 426 / 426

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   |
| ----------------- | ----- | ----- |
| roi               | 100%  | 100%  |
| pnl               | 100%  | 100%  |
| mdd               | 95.5% | 95.5% |
| win_rate          | 100%  | 100%  |
| total_positions   | 73.7% | 73.7% |
| copier_pnl        | 73.7% | 73.7% |
| copier_count      | 73.7% | 73.7% |
| aum               | 95.5% | 95.5% |
| profit_share_rate | 52.1% | 52.1% |

**Extras keys** (fill % per timeframe)

| extras key              | 7d    | 30d   |
| ----------------------- | ----- | ----- |
| closed_positions        | 73.7% | 73.7% |
| copier_count_history    | 51.4% | 51.4% |
| current_followers       | 73.7% | 73.7% |
| introduction            | 25.8% | 25.8% |
| leading_days            | 51.4% | 51.4% |
| lifetime_trades         | 52.1% | 52.1% |
| max_copier_slots        | 73.7% | 73.7% |
| open_positions          | 73.7% | 73.7% |
| profitable_copier_count | 73.7% | 73.7% |
| trader_level            | 73.7% | 73.7% |

## mexc_futures

Timeframes: 7, 30, 90 · rows: 18357 / 2305 / 2303

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 82.6% | 100%  | 99.9% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 12.5% | 99.9% | 99.6% |
| total_positions      | 12.5% | 100%  | 100%  |
| copier_pnl           | 12.5% | 100%  | 100%  |
| copier_count         | 12.5% | 100%  | 100%  |
| aum                  | 82.6% | 100%  | 100%  |
| profit_share_rate    | 12.5% | 100%  | 100%  |
| holding_duration_avg | 11.6% | 99.4% | 99.7% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 0.2%  | 1.5%  | 1.5%  |
| ability_rating                       | 12.5% | 100%  | 100%  |
| avg_order_amount                     | 12.5% | 100%  | 100%  |
| copier_count_history                 | 12.5% | 100%  | 100%  |
| interested_count                     | 12.5% | 100%  | 100%  |
| last_trade_time                      | 12.5% | 100%  | 100%  |
| loss_trades                          | 9.6%  | 76.8% | 76.8% |
| max_hold_time_hours                  | 11.6% | 99.4% | 99.7% |
| profit_and_loss_ratio                | 10.6% | 95.7% | 97%   |
| settled_days                         | 12.5% | 100%  | 100%  |
| total_equity                         | 12.1% | 96.4% | 96.4% |
| total_pnl                            | 12.5% | 100%  | 100%  |
| total_roi                            | 12.5% | 100%  | 100%  |
| total_win_rate                       | 12.5% | 100%  | 100%  |
| trade_frequency_per_week             | 12.5% | 100%  | 100%  |
| trader_type                          | 0%    | 0%    | 0%    |

## okx_futures

Timeframes: 7, 30, 90 · rows: 364 / 364 / 408

**Typed columns** (fill % per timeframe)

| column       | 7d   | 30d  | 90d   |
| ------------ | ---- | ---- | ----- |
| roi          | 100% | 100% | 100%  |
| pnl          | 100% | 100% | 100%  |
| win_rate     | 100% | 100% | 100%  |
| copier_pnl   | 100% | 100% | 89.2% |
| copier_count | 0%   | 0%   | 76.5% |
| aum          | 0%   | 0%   | 77.9% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d   | 30d  | 90d   |
| ------------------- | ---- | ---- | ----- |
| avg_subpos_notional | 100% | 100% | 89.2% |
| invest_amt          | 100% | 100% | 89.2% |
| loss_days           | 100% | 100% | 89.2% |
| profit_days         | 100% | 100% | 89.2% |

## okx_spot

Timeframes: 7, 30, 90 · rows: 257 / 256 / 279

**Typed columns** (fill % per timeframe)

| column       | 7d   | 30d  | 90d   |
| ------------ | ---- | ---- | ----- |
| roi          | 100% | 100% | 100%  |
| pnl          | 100% | 100% | 100%  |
| win_rate     | 100% | 100% | 100%  |
| copier_pnl   | 100% | 100% | 91.8% |
| copier_count | 0%   | 0%   | 78.1% |
| aum          | 0%   | 0%   | 78.5% |

**Extras keys** (fill % per timeframe)

| extras key          | 7d   | 30d  | 90d   |
| ------------------- | ---- | ---- | ----- |
| avg_subpos_notional | 100% | 100% | 91.8% |
| invest_amt          | 100% | 100% | 91.8% |
| loss_days           | 100% | 100% | 91.8% |
| profit_days         | 100% | 100% | 91.8% |

## okx_web3_solana

Timeframes: 7, 30, 90 · rows: 32042 / 33941 / 36243

**Typed columns** (fill % per timeframe)

| column   | 7d    | 30d   | 90d   |
| -------- | ----- | ----- | ----- |
| roi      | 100%  | 100%  | 100%  |
| pnl      | 100%  | 100%  | 100%  |
| win_rate | 100%  | 100%  | 100%  |
| volume   | 23.2% | 21.9% | 20.5% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 0.4%  | 0.4%  | 0.4%  |
| avg_cost_buy                         | 23.2% | 21.9% | 20.5% |
| favorite_mcap_type                   | 23.2% | 21.9% | 20.5% |
| native_balance_amount                | 23.2% | 21.9% | 20.5% |
| native_balance_usd                   | 23.2% | 21.9% | 20.5% |
| onchain_buy_volume                   | 0%    | 0%    | 19.3% |
| onchain_derivation                   | 0%    | 0%    | 19.3% |
| onchain_enriched_at                  | 0%    | 0%    | 19.3% |
| onchain_realized_pnl                 | 0%    | 0%    | 19.3% |
| onchain_sell_volume                  | 0%    | 0%    | 19.3% |
| onchain_tokens_traded                | 0%    | 0%    | 19.3% |
| onchain_total_pnl                    | 0%    | 0%    | 19.3% |
| onchain_txs_buy                      | 0%    | 0%    | 19.3% |
| onchain_txs_sell                     | 0%    | 0%    | 19.3% |
| onchain_unrealized_pnl               | 0%    | 0%    | 19.3% |
| onchain_win_rate                     | 0%    | 0%    | 0.4%  |
| top_tokens_total_pnl                 | 23.2% | 21.9% | 20.5% |
| txs_buy                              | 23.2% | 21.9% | 20.5% |
| txs_sell                             | 23.2% | 21.9% | 20.5% |
| unrealized_pnl                       | 23.2% | 21.9% | 20.5% |
| unrealized_pnl_roi                   | 23.2% | 21.9% | 20.5% |
| volume_buy                           | 23.2% | 21.9% | 20.5% |
| volume_sell                          | 23.2% | 21.9% | 20.5% |

## phemex_futures

Timeframes: 30, 90 · rows: 506 / 506

**Typed columns** (fill % per timeframe)

| column               | 30d   | 90d   |
| -------------------- | ----- | ----- |
| roi                  | 100%  | 100%  |
| pnl                  | 100%  | 100%  |
| mdd                  | 95.7% | 95.7% |
| win_rate             | 100%  | 100%  |
| win_positions        | 88.1% | 88.5% |
| total_positions      | 88.5% | 88.5% |
| copier_pnl           | 88.5% | 88.5% |
| copier_count         | 95.5% | 95.5% |
| aum                  | 95.7% | 95.7% |
| volume               | 88.5% | 88.5% |
| profit_share_rate    | 88.5% | 88.5% |
| holding_duration_avg | 46%   | 45.8% |

**Extras keys** (fill % per timeframe)

| extras key                           | 30d   | 90d   |
| ------------------------------------ | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 3.2%  | 3.2%  |
| ai_trader                            | 2.8%  | 2.8%  |
| copier_total_realized_pnl            | 88.5% | 88.5% |
| follower_count                       | 88.5% | 88.5% |
| lifetime_trades                      | 75.1% | 75.1% |
| lifetime_win_rate                    | 75.1% | 75.1% |
| max_copier_slots                     | 88.5% | 88.5% |
| min_copy_amount                      | 86.2% | 86.2% |
| position_hold_time_total_ns          | 88.5% | 88.5% |
| profit_share_rate                    | 77.9% | 78.1% |
| star_trader                          | 88.5% | 88.5% |
| total_balance                        | 95.5% | 95.5% |
| total_pnl                            | 88.5% | 88.5% |
| total_roi                            | 88.5% | 88.5% |
| total_trade_volume                   | 88.5% | 88.5% |

## toobit_futures

Timeframes: 7, 30, 90 · rows: 1705 / 1705 / 1705

**Typed columns** (fill % per timeframe)

| column            | 7d    | 30d   | 90d   |
| ----------------- | ----- | ----- | ----- |
| roi               | 100%  | 100%  | 100%  |
| pnl               | 100%  | 100%  | 100%  |
| sharpe            | 93.5% | 94.6% | 95.3% |
| mdd               | 99.5% | 99.5% | 99.5% |
| win_rate          | 100%  | 100%  | 100%  |
| copier_count      | 100%  | 100%  | 100%  |
| aum               | 100%  | 100%  | 100%  |
| profit_share_rate | 89.3% | 89.3% | 89.3% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 6%    | 6.1%  | 6.1%  |
| bio                                  | 49.8% | 49.8% | 49.8% |
| copier_count_history                 | 93.5% | 94.6% | 95.3% |
| copier_limit                         | 99.5% | 99.5% | 99.5% |
| copier_total_profit                  | 93.5% | 94.6% | 95.3% |
| is_full                              | 99.5% | 99.5% | 99.5% |
| last_week_win_rate                   | 99.5% | 99.5% | 99.5% |
| lead_days                            | 99.5% | 99.5% | 99.5% |
| leaderMaximumDrawdownProportion      | 99.5% | 99.5% | 99.5% |
| leaderProfitOrderRatioProportion     | 99.5% | 99.5% | 99.5% |
| leaderProfitRatioProportion          | 99.5% | 99.5% | 99.5% |
| max_copier_slots                     | 93.5% | 94.6% | 95.3% |
| profit_share_rate                    | 93.5% | 94.6% | 95.3% |
| start_lead_time                      | 99.5% | 99.5% | 99.5% |
| total_copiers_history                | 99.5% | 99.5% | 99.5% |
| total_pnl                            | 99.4% | 99.4% | 99.4% |
| total_roi                            | 99.4% | 99.4% | 99.4% |
| trade_count_lifetime                 | 100%  | 100%  | 100%  |

## xt_futures

Timeframes: 7, 30, 90 · rows: 1900 / 1900 / 1900

**Typed columns** (fill % per timeframe)

| column               | 7d    | 30d   | 90d   |
| -------------------- | ----- | ----- | ----- |
| roi                  | 100%  | 100%  | 100%  |
| pnl                  | 100%  | 100%  | 100%  |
| mdd                  | 99.3% | 99.3% | 99.3% |
| win_rate             | 100%  | 100%  | 100%  |
| win_positions        | 98.5% | 98.6% | 98.6% |
| total_positions      | 98.5% | 98.6% | 98.6% |
| copier_pnl           | 98.5% | 98.6% | 98.6% |
| copier_count         | 99.4% | 99.4% | 99.4% |
| aum                  | 99.3% | 99.3% | 99.3% |
| holding_duration_avg | 5.8%  | 10.5% | 16.4% |

**Extras keys** (fill % per timeframe)

| extras key                           | 7d    | 30d   | 90d   |
| ------------------------------------ | ----- | ----- | ----- |
| \_arena_profile_publication_epoch_ms | 3.4%  | 3.4%  | 3.4%  |
| avg_loss                             | 98.5% | 98.6% | 98.6% |
| avg_profit                           | 98.5% | 98.6% | 98.6% |
| copier_count_history                 | 98.6% | 98.6% | 98.6% |
| copier_growth                        | 98.4% | 98.4% | 98.5% |
| copier_total_profit                  | 98.4% | 98.4% | 98.5% |
| follower_margin                      | 98.4% | 98.4% | 98.5% |
| intro                                | 17.3% | 17.3% | 17.3% |
| leading_days                         | 99%   | 99%   | 99%   |
| level_name                           | 99%   | 99%   | 99%   |
| loss_trades                          | 98.5% | 98.6% | 98.6% |
| max_copier_slots                     | 98.6% | 98.6% | 98.6% |
| platform_profit_rate                 | 99%   | 99%   | 99%   |
| sortino                              | 0%    | 1.8%  | 1.6%  |
| total_pnl                            | 98.5% | 98.6% | 98.6% |
| trade_frequency                      | 98.5% | 98.6% | 98.6% |
| trading_days                         | 99.3% | 99.3% | 99.3% |

## xt_spot

Timeframes: 7, 30, 90 · rows: 63 / 56 / 37

**Typed columns** (fill % per timeframe)

| column       | 7d    | 30d   | 90d   |
| ------------ | ----- | ----- | ----- |
| roi          | 100%  | 100%  | 100%  |
| pnl          | 100%  | 100%  | 100%  |
| mdd          | 85.7% | 94.6% | 89.2% |
| win_rate     | 100%  | 98.2% | 100%  |
| copier_count | 85.7% | 94.6% | 86.5% |

**Extras keys** (fill % per timeframe)

| extras key      | 7d    | 30d   | 90d   |
| --------------- | ----- | ----- | ----- |
| follower_margin | 85.7% | 94.6% | 86.5% |
| sortino         | 0%    | 3.6%  | 0%    |
| trading_days    | 85.7% | 94.6% | 86.5% |

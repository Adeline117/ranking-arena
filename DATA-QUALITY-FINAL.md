# DATA QUALITY FINAL REPORT
Generated: 2026-02-14T20:07:22.913Z

## Summary
- Total leaderboard_snapshots: 33478
- Total trader_stats_detail: 49183

## Snapshots by Source
- bitget: 0
- bybit: 468
- okx: 0
- binance: 0
- gate: 0
- blofin: 10
- kucoin: 927
- bingx: 0

## WR (win_rate) NULL in leaderboard_snapshots
| Source | 7D | 30D | 90D | Total |
|--------|-----|------|------|-------|
| bitget | 0 | 0 | 0 | 0 |
| bybit | 0 | 0 | 0 | 0 |
| okx | 0 | 0 | 0 | 0 |
| binance | 0 | 0 | 0 | 0 |
| gate | 0 | 0 | 0 | 0 |
| blofin | 0 | 0 | 0 | 0 |
| kucoin | 0 | 0 | 0 | 0 |
| bingx | 0 | 0 | 0 | 0 |

## MDD (max_drawdown) NULL in trader_stats_detail
| Source | 7D | 30D | 90D | Total |
|--------|-----|------|------|-------|
| bitget | 0 | 0 | 0 | 0 |
| bybit | 8 | 2 | 0 | 10 |
| okx | 0 | 0 | 0 | 0 |
| binance | 0 | 0 | 0 | 0 |
| gate | 0 | 0 | 0 | 0 |
| blofin | 0 | 0 | 0 | 0 |
| kucoin | 0 | 297 | 297 | 594 |
| bingx | 0 | 0 | 0 | 0 |

## TC (total_trades) NULL in trader_stats_detail
| Source | 7D | 30D | 90D | Total |
|--------|-----|------|------|-------|
| bitget | 0 | 0 | 0 | 0 |
| bybit | 10 | 10 | 10 | 30 |
| okx | 0 | 0 | 0 | 0 |
| binance | 177 | 177 | 177 | 531 |
| gate | 0 | 0 | 0 | 0 |
| blofin | 0 | 23 | 0 | 23 |
| kucoin | 0 | 341 | 341 | 682 |
| bingx | 0 | 15 | 0 | 15 |

## WR (profitable_trades_pct) NULL in trader_stats_detail
| Source | 7D | 30D | 90D | Total |
|--------|-----|------|------|-------|
| bitget | 0 | 0 | 0 | 0 |
| bybit | 10 | 10 | 10 | 30 |
| okx | 0 | 0 | 0 | 0 |
| binance | 177 | 177 | 177 | 531 |
| gate | 0 | 0 | 0 | 0 |
| blofin | 0 | 0 | 0 | 0 |
| kucoin | 0 | 341 | 341 | 682 |
| bingx | 0 | 0 | 0 | 0 |

## Notes
- `aevo` source has 1663 snapshots, ALL with win_rate=null (aevo doesn't provide WR)
- All 8 main platforms (bitget/bybit/okx/binance/gate/blofin/kucoin/bingx) have 0 WR null in snapshots
- KuCoin: MDD null because leaderboard API doesn't expose per-period MDD (only computed from equity curve)
- KuCoin/Binance: total_trades/profitable_trades_pct null because their APIs don't expose these fields
- **No estimated/fabricated/default values were used**

## Grand Totals
- WR null in leaderboard_snapshots (all sources): 15505 (includes aevo + other minor sources)
- WR null in leaderboard_snapshots (8 main platforms): 0
- WR null (90D, main platforms): 0 (was 5290 at session start)
